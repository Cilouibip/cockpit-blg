-- Read-only published observations. History is retained; no source data changes.
CREATE INDEX sync_window_publications ON public.sync_runs
 (source,source_namespace,query_profile_key,source_as_of DESC,started_at DESC,id DESC)
 INCLUDE(stream_key,period_from,period_to)
 WHERE status IN ('complete','empty') AND pagination_complete AND finished_at IS NOT NULL AND rows_rejected=0;
CREATE INDEX sync_window_exact_publications ON public.sync_runs
 (source,source_namespace,query_profile_key,period_from,period_to,source_as_of DESC,started_at DESC,id DESC)
 INCLUDE(stream_key)
 WHERE status IN ('complete','empty') AND pagination_complete AND finished_at IS NOT NULL AND rows_rejected=0;

CREATE FUNCTION public.cockpit_source_window(
 p_source text,p_namespace text,p_stream text,p_profile text,p_from date,p_to date,
 p_timezone text,p_currency text,p_currency_exponent integer,p_kind text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
 v_streams text[]; v_metrics text[]; v_dimension text; v_from timestamptz; v_to timestamptz;
 v_day date; v_start timestamptz; v_end timestamptz; v_run public.sync_runs%ROWTYPE;
 v_rows jsonb; v_valid boolean; v_count integer; v_distinct integer; v_total numeric; v_summary jsonb;
 v_breakdown boolean; v_daily_count integer; v_days_valid boolean; v_sum numeric;
 v_cache jsonb:='{}'; v_checked jsonb; v_chosen uuid; v_ids uuid[]:='{}'; v_exact uuid;
 v_aggregates jsonb:='[]'; v_selections jsonb:='[]'; v_validations jsonb:='{}'; v_runs jsonb; v_attempt jsonb;
BEGIN
 IF p_source IS NULL OR p_namespace IS NULL OR length(p_namespace) NOT BETWEEN 1 AND 200
  OR p_stream IS NULL OR p_profile IS NULL OR length(p_profile) NOT BETWEEN 1 AND 500
  OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from OR p_to-p_from>3660
  OR p_timezone IS NULL OR NOT EXISTS(SELECT FROM pg_timezone_names WHERE name=p_timezone)
  OR p_kind IS NULL THEN RAISE EXCEPTION 'invalid source window' USING ERRCODE='22023'; END IF;
 IF p_kind='daily_bundle' AND p_source='meta' AND p_stream='meta_account_daily' THEN
  v_metrics:=ARRAY['meta_spend_minor','meta_impressions','meta_outbound_clicks'];v_dimension:='account';
  IF p_currency IS NULL OR p_currency!~'^[A-Z]{3}$' OR p_currency_exponent IS NULL OR p_currency_exponent NOT BETWEEN 0 AND 4 THEN RAISE EXCEPTION 'invalid currency' USING ERRCODE='22023';END IF;
 ELSIF p_kind='daily_bundle' AND p_source='wix' AND p_stream='receipt_observations' THEN
  v_metrics:=ARRAY['wix_receipts_created','wix_refunds_requested'];v_dimension:='all';
 ELSIF p_kind='exact_report' AND p_source='posthog' AND p_stream IN ('quiz_observations','masterclass_observations') THEN
  v_metrics:=CASE WHEN p_stream='quiz_observations' THEN ARRAY['posthog_events','posthog_visitors','posthog_sessions'] ELSE ARRAY['posthog_mc_events'] END;
 ELSIF p_kind='wix_report_daily' AND p_source='wix' AND p_stream='payments_analytics' THEN
  v_metrics:=ARRAY['wix_total_revenue','wix_daily_revenue'];
  IF p_currency IS NULL OR p_currency!~'^[A-Z]{3}$' OR p_currency_exponent IS NULL OR p_currency_exponent NOT BETWEEN 0 AND 4 THEN RAISE EXCEPTION 'invalid currency' USING ERRCODE='22023';END IF;
 ELSE RAISE EXCEPTION 'unsupported source window' USING ERRCODE='22023'; END IF;
 v_streams:=CASE WHEN p_stream IN ('quiz_observations','payments_analytics') THEN ARRAY[p_stream,'aggregates'] ELSE ARRAY[p_stream] END;
 v_from:=p_from::timestamp AT TIME ZONE p_timezone;v_to:=p_to::timestamp AT TIME ZONE p_timezone;
 SELECT to_jsonb(r) INTO v_attempt FROM public.sync_runs r
 WHERE r.source=p_source AND r.source_namespace=p_namespace AND r.stream_key=ANY(v_streams) AND r.query_profile_key=p_profile
  AND CASE WHEN p_kind='exact_report' THEN r.period_from=v_from AND r.period_to=v_to ELSE r.period_from<v_to AND r.period_to>v_from END
 ORDER BY r.started_at DESC,r.id DESC LIMIT 1;

 -- A deterministic candidate stream is consumed lazily, stopping at the first valid bundle.
 IF p_kind='daily_bundle' THEN
  FOR v_day IN SELECT p_from+i FROM generate_series(0,p_to-p_from-1) i LOOP
   v_start:=v_day::timestamp AT TIME ZONE p_timezone;v_end:=(v_day+1)::timestamp AT TIME ZONE p_timezone;
   FOR v_run IN SELECT r.* FROM public.sync_runs r
    WHERE r.source=p_source AND r.source_namespace=p_namespace AND r.stream_key=ANY(v_streams) AND r.query_profile_key=p_profile
     AND r.status IN ('complete','empty') AND r.pagination_complete AND r.finished_at IS NOT NULL AND r.rows_rejected=0
     AND r.period_from<=v_start AND r.period_to>=v_end
    ORDER BY r.source_as_of DESC,r.started_at DESC,r.id DESC LOOP
    SELECT count(*),count(DISTINCT a.metric_key),coalesce(jsonb_agg(to_jsonb(a)),'[]'),
     coalesce(bool_and((a.timezone=p_timezone AND a.coverage_state='complete' AND jsonb_typeof(a.dimensions)='object'
      AND a.dimensions->>'date'=v_day::text
      AND (NOT a.dimensions ? 'observedAt' OR (jsonb_typeof(a.dimensions->'observedAt')='string' AND a.dimensions->>'observedAt'~'^\d{4}-\d{2}-\d{2}T' AND pg_input_is_valid(a.dimensions->>'observedAt','timestamp with time zone')))
      AND CASE WHEN p_source='meta' THEN
       a.dimensions->>'scope'='account' AND (a.value IS NULL OR (a.value>=0 AND a.value<=9007199254740991 AND a.value=trunc(a.value)))
       AND CASE WHEN a.metric_key='meta_spend_minor' THEN a.unit='minor' AND a.currency=p_currency AND a.currency_exponent=p_currency_exponent ELSE a.unit='count' AND a.currency IS NULL AND a.currency_exponent IS NULL END
      ELSE a.unit='count' AND a.currency IS NULL AND a.currency_exponent IS NULL AND a.value IS NOT NULL AND a.value>=0 AND a.value<=9007199254740991 AND a.value=trunc(a.value)
       AND (NOT a.dimensions ? 'firstObservedDay' OR (jsonb_typeof(a.dimensions->'firstObservedDay')='string' AND a.dimensions->>'firstObservedDay'~'^\d{4}-\d{2}-\d{2}$' AND pg_input_is_valid(a.dimensions->>'firstObservedDay','date') AND a.dimensions->>'firstObservedDay'<=v_day::text))
      END) IS TRUE),false)
     INTO v_count,v_distinct,v_rows,v_valid
    FROM public.source_aggregates a WHERE a.sync_run_id=v_run.id AND a.source=p_source AND a.source_namespace=p_namespace
     AND a.report_profile_key=p_profile AND a.period_from=v_start AND a.period_to=v_end AND a.dimensions_key=v_dimension AND a.metric_key=ANY(v_metrics);
    IF v_valid AND v_count=cardinality(v_metrics) AND v_distinct=v_count THEN
     v_ids:=array_append(v_ids,v_run.id);v_aggregates:=v_aggregates||v_rows;
     v_selections:=v_selections||jsonb_build_array(jsonb_build_object('day',v_day,'runId',v_run.id));EXIT;
    END IF;
   END LOOP;
  END LOOP;
 ELSIF p_kind='exact_report' THEN
  FOR v_run IN SELECT r.* FROM public.sync_runs r
   WHERE r.source=p_source AND r.source_namespace=p_namespace AND r.stream_key=ANY(v_streams) AND r.query_profile_key=p_profile
    AND r.period_from=v_from AND r.period_to=v_to AND r.status IN ('complete','empty') AND r.pagination_complete AND r.finished_at IS NOT NULL AND r.rows_rejected=0
   ORDER BY r.source_as_of DESC,r.started_at DESC,r.id DESC LOOP
   SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'),count(*),coalesce(bool_and((a.period_from=v_from AND a.period_to=v_to
    AND a.timezone=p_timezone AND a.coverage_state='complete' AND a.unit='count' AND a.currency IS NULL AND a.currency_exponent IS NULL
    AND jsonb_typeof(a.dimensions)='object' AND (a.value IS NULL OR (a.value>=0 AND a.value<=9007199254740991 AND a.value=trunc(a.value)))) IS TRUE),false)
    INTO v_rows,v_count,v_valid FROM public.source_aggregates a WHERE a.sync_run_id=v_run.id AND a.source=p_source AND a.source_namespace=p_namespace AND a.report_profile_key=p_profile AND a.metric_key=ANY(v_metrics);
   SELECT a INTO v_summary FROM jsonb_array_elements(v_rows) a WHERE a->>'metric_key'=v_metrics[1] AND a->>'dimensions_key'='all' AND a->'value'<>'null'::jsonb;
   IF v_valid AND v_count BETWEEN 1 AND 10000 AND v_summary IS NOT NULL
    AND (v_run.status<>'empty' OR v_summary->'value'='0'::jsonb) THEN
    v_exact:=v_run.id;v_ids:=array_append(v_ids,v_run.id);v_aggregates:=v_rows;EXIT;
   END IF;
  END LOOP;
 ELSE
  -- Validate each whole Wix report once within this read. Only selected days leave the RPC.
  FOR v_day IN SELECT p_from+i FROM generate_series(-1,p_to-p_from-1) i LOOP
   v_start:=v_day::timestamp AT TIME ZONE p_timezone;v_end:=(v_day+1)::timestamp AT TIME ZONE p_timezone;
   v_chosen:=NULL;
   FOR v_run IN SELECT r.* FROM public.sync_runs r
    WHERE r.source=p_source AND r.source_namespace=p_namespace AND r.stream_key=ANY(v_streams) AND r.query_profile_key=p_profile
     AND r.status IN ('complete','empty') AND r.pagination_complete AND r.finished_at IS NOT NULL AND r.rows_rejected=0
     AND CASE WHEN v_day=p_from-1 THEN r.period_from=v_from AND r.period_to=v_to ELSE r.period_from<=v_start AND r.period_to>=v_end END
    ORDER BY r.source_as_of DESC,r.started_at DESC,r.id DESC LOOP
    v_checked:=v_cache->v_run.id::text;
    IF v_checked IS NULL THEN
     SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'),coalesce(bool_and((a.period_from=v_run.period_from AND a.period_to=v_run.period_to
      AND a.timezone=p_timezone AND a.coverage_state='complete' AND a.unit='minor' AND a.currency=p_currency AND a.currency_exponent=p_currency_exponent AND a.tax_basis='tax_inclusive'
      AND a.value IS NOT NULL AND a.value BETWEEN -9007199254740991 AND 9007199254740991 AND a.value=trunc(a.value)) IS TRUE),false)
      INTO v_rows,v_valid FROM public.source_aggregates a WHERE a.sync_run_id=v_run.id AND a.source=p_source AND a.source_namespace=p_namespace AND a.report_profile_key=p_profile AND a.metric_key=ANY(v_metrics);
     SELECT count(*),min((a->>'value')::numeric) INTO v_count,v_total FROM jsonb_array_elements(v_rows) a WHERE a->>'metric_key'='wix_total_revenue' AND a->>'dimensions_key'='all';
     SELECT count(*),count(DISTINCT a->'dimensions'->>'date'),coalesce(sum((a->>'value')::numeric),0),
      coalesce(bool_and((jsonb_typeof(a->'dimensions'->'date')='string' AND a->'dimensions'->>'date'~'^\d{4}-\d{2}-\d{2}$'
       AND CASE WHEN pg_input_is_valid(a->'dimensions'->>'date','date') THEN
        (a->'dimensions'->>'date')::date::timestamp AT TIME ZONE p_timezone>=v_run.period_from
        AND ((a->'dimensions'->>'date')::date+1)::timestamp AT TIME ZONE p_timezone<=v_run.period_to ELSE false END) IS TRUE),true)
      INTO v_daily_count,v_distinct,v_sum,v_days_valid FROM jsonb_array_elements(v_rows) a WHERE a->>'metric_key'='wix_daily_revenue';
     v_valid:=v_valid AND v_count=1 AND jsonb_array_length(v_rows)<=10000;
     v_breakdown:=v_valid AND v_days_valid AND v_daily_count=v_distinct AND v_sum=v_total;
     v_checked:=jsonb_build_object('valid',v_valid,'totalMinor',v_total,'hasBreakdown',v_breakdown,'wholeReportRowCount',jsonb_array_length(v_rows),'rows',v_rows);
     v_cache:=jsonb_set(v_cache,ARRAY[v_run.id::text],v_checked);
    END IF;
    IF coalesce((v_checked->>'valid')::boolean,false) AND (v_day=p_from-1 OR coalesce((v_checked->>'hasBreakdown')::boolean,false)) THEN
     v_chosen:=v_run.id;
     IF NOT v_run.id=ANY(v_ids) THEN
      v_ids:=array_append(v_ids,v_run.id);v_validations:=jsonb_set(v_validations,ARRAY[v_run.id::text],v_checked-'rows');
      SELECT coalesce(jsonb_agg(a),'[]') INTO v_rows FROM jsonb_array_elements(v_checked->'rows') a WHERE a->>'metric_key'='wix_total_revenue' AND a->>'dimensions_key'='all';v_aggregates:=v_aggregates||v_rows;
     END IF;
     IF v_day=p_from-1 THEN v_exact:=v_run.id;ELSE
      v_selections:=v_selections||jsonb_build_array(jsonb_build_object('day',v_day,'runId',v_run.id));
      SELECT coalesce(jsonb_agg(a),'[]') INTO v_rows FROM jsonb_array_elements(v_checked->'rows') a WHERE a->>'metric_key'='wix_daily_revenue' AND a->'dimensions'->>'date'=v_day::text;v_aggregates:=v_aggregates||v_rows;
     END IF;
     EXIT;
    END IF;
   END LOOP;
  END LOOP;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.source_as_of DESC,r.started_at DESC,r.id DESC),'[]') INTO v_runs FROM public.sync_runs r WHERE r.id=ANY(v_ids);
 RETURN jsonb_build_object('runs',v_runs,'aggregates',v_aggregates,'selections',v_selections,'validations',v_validations,'exactRunId',v_exact,'latestAttempt',v_attempt);
END $$;
REVOKE ALL ON FUNCTION public.cockpit_source_window(text,text,text,text,date,date,text,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_source_window(text,text,text,text,date,date,text,text,integer,text) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(8);
