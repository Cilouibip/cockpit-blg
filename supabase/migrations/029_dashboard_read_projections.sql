-- Read-only query plans: preserve every scope, validation and metric definition.
-- Never materialize complete sync checkpoints when only publication metadata is used.
-- Exact PostHog report rows are selected by immutable run before profile predicates,
-- avoiding a historical wide-index scan. No index, timeout or permission changes.
BEGIN;

-- Refuse missing or drifted functions before any CREATE OR REPLACE. Accepted
-- bodies are the exact effective baseline or this candidate on a retry.
DO $read_model_preflight$
DECLARE expected record;actual record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.cockpit_business_rollup(text,date,date)',ARRAY['0cb640c95691b309801208578f73dfb4','56e57ac793af375f2282f1759cda7b75']::text[],'sql',ARRAY['p_namespace','p_from','p_to']::text[]),
  ('public.cockpit_lead_entry_rollup_v2(text,text,text,date,date,jsonb)',ARRAY['27c1b64ab371b3d66dc21ca06bfed3c7','1df4c7a22380e15ea81a7ac029726caf']::text[],'plpgsql',ARRAY['p_wix_namespace','p_notion_namespace','p_client_namespace','p_from','p_to','p_scope']::text[]),
  ('public.cockpit_source_window(text,text,text,text,date,date,text,text,integer,text)',ARRAY['8b7d72b62012af1fecf758b11eb785e6','7d4f89869bfda93c917167150db0a5e2']::text[],'plpgsql',ARRAY['p_source','p_namespace','p_stream','p_profile','p_from','p_to','p_timezone','p_currency','p_currency_exponent','p_kind']::text[])
 ) AS definitions(signature,body_hashes,language,argument_names) LOOP
  SELECT md5(p.prosrc) body_hash,p.provolatile,p.prosecdef,p.proconfig,p.proargnames,
   p.proargmodes,p.pronargdefaults,p.prokind,p.prorettype,p.proisstrict,p.proparallel,p.proleakproof,
   has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
   has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
   has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,l.lanname language
   INTO actual FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure(expected.signature);
  IF NOT FOUND THEN
   RAISE EXCEPTION 'READ_MODEL_SIGNATURE_MISSING: %',expected.signature USING ERRCODE='55000';
  END IF;
  IF actual.body_hash<>ALL(expected.body_hashes)
   OR actual.provolatile IS DISTINCT FROM 's'::"char" OR actual.prosecdef
   OR actual.proisstrict OR actual.proparallel IS DISTINCT FROM 'u'::"char" OR actual.proleakproof
   OR actual.anon_execute OR actual.authenticated_execute OR NOT actual.service_execute
   OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
   OR actual.proargnames IS DISTINCT FROM expected.argument_names
   OR actual.proargmodes IS NOT NULL OR actual.pronargdefaults<>0
   OR actual.prokind IS DISTINCT FROM 'f'::"char" OR actual.prorettype<>'jsonb'::regtype
   OR actual.language IS DISTINCT FROM expected.language THEN
   RAISE EXCEPTION 'READ_MODEL_BASELINE_MISMATCH: %',expected.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
END $read_model_preflight$;

CREATE OR REPLACE FUNCTION public.cockpit_business_rollup(p_namespace text,p_from date,p_to date) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH published AS (SELECT id,query_profile_key,source_as_of,finished_at,checkpoint->>'inventoryThrough' inventory_through FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status IN ('complete','empty') AND pagination_complete ORDER BY finished_at DESC LIMIT 1),
 history AS (SELECT *,business b FROM prospects WHERE source='notion' AND source_namespace=p_namespace AND business<>'{}'::jsonb),
 p AS (SELECT * FROM history WHERE NOT archived AND EXISTS(SELECT FROM published) AND EXISTS(SELECT FROM sync_runs r WHERE r.id=history.sync_run_id AND r.status IN ('complete','empty') AND r.pagination_complete AND r.query_profile_key=(SELECT query_profile_key FROM published))),
 leads AS (SELECT * FROM history WHERE (b->>'acquisitionDay')::date>=p_from AND (b->>'acquisitionDay')::date<p_to),
 appts AS (SELECT * FROM p WHERE (b->>'scheduledDay')::date>=p_from AND (b->>'scheduledDay')::date<p_to)
 SELECT jsonb_build_object('available',EXISTS(SELECT FROM published),'observedAt',(SELECT source_as_of FROM published),'publishedAt',(SELECT finished_at FROM published),'inventoryThrough',(SELECT inventory_through FROM published),'sourceRows',(SELECT count(*) FROM p),
 'leads',jsonb_build_object('rows',(SELECT count(*) FROM leads),'known',(SELECT count(DISTINCT person_id) FROM leads),'unresolved',(SELECT count(*) FROM leads WHERE person_id IS NULL),'archivedRows',(SELECT count(*) FROM leads WHERE archived),
 'creationOnly',(SELECT count(*) FROM p WHERE b->>'acquisitionDay' IS NULL AND (b->>'createdAt')::timestamptz AT TIME ZONE 'Europe/Paris'>=p_from::timestamp AND (b->>'createdAt')::timestamptz AT TIME ZONE 'Europe/Paris'<p_to::timestamp)),
 'appointments',jsonb_build_object('total',(SELECT count(*) FROM appts),'attended',(SELECT count(*) FROM appts WHERE b->>'attendance'='show_up'),'explicitFinished',(SELECT count(*) FROM appts WHERE b->>'explicitFinished'='true'),'noShow',(SELECT count(*) FROM appts WHERE b->>'attendance'='no_show'),'cancelled',(SELECT count(*) FROM appts WHERE b->>'attendance'='cancelled'),'unknown',(SELECT count(*) FROM appts WHERE b->>'attendance' IN ('unknown','scheduled')),
 'booked',(SELECT count(*) FROM p WHERE (b->>'bookedDay')::date>=p_from AND (b->>'bookedDay')::date<p_to),'closed',(SELECT count(*) FROM p WHERE source_status='Closé' AND (b->>'closedDay')::date>=p_from AND (b->>'closedDay')::date<p_to)));
$$;

CREATE OR REPLACE FUNCTION public.cockpit_lead_entry_rollup_v2(
 p_wix_namespace text,
 p_notion_namespace text,
 p_client_namespace text,
 p_from date,
 p_to date,
 p_scope jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=public,pg_temp
AS $$
DECLARE result jsonb;
BEGIN
 IF jsonb_typeof(p_scope) IS DISTINCT FROM 'object' OR p_from IS NULL OR p_to IS NULL OR p_from>=p_to OR p_to-p_from>367 THEN
  RAISE EXCEPTION 'invalid period' USING ERRCODE='22023';
 END IF;

 WITH published AS (
  SELECT id,source,source_namespace,stream_key,query_profile_key,status,finished_at,source_as_of,started_at,covered_from,covered_to FROM sync_runs
  WHERE status IN ('complete','empty') AND pagination_complete AND rows_rejected=0
   AND stream_key LIKE 'lead_entries_%'
 ), selected_profiles AS (
  SELECT scope.key family,scope.value->>'profile' requested_profile,chosen.query_profile_key profile
  FROM jsonb_each(p_scope) scope
  CROSS JOIN LATERAL (
   SELECT r.query_profile_key FROM published r
   WHERE r.stream_key='lead_entries_'||scope.key
    AND r.source_namespace=CASE WHEN scope.key='client_history' THEN p_client_namespace ELSE p_wix_namespace END
   ORDER BY r.finished_at DESC,r.id DESC
   LIMIT 1
  ) chosen
 ), valid_runs AS (
  SELECT r.* FROM published r
  JOIN selected_profiles s ON r.stream_key='lead_entries_'||s.family AND r.query_profile_key=s.profile
 ), observations AS (
  SELECT o.* FROM lead_source_observations o
  JOIN valid_runs r ON r.id=o.run_id
  WHERE o.is_current AND o.published_at IS NOT NULL AND o.mapping_profile=r.query_profile_key
   AND p_scope->o.family->'containerIds' @> jsonb_build_array(o.source_container_id)
   AND (
    (o.source='wix' AND o.source_namespace=p_wix_namespace AND o.family IN ('forms','quiz'))
    OR (o.source='notion' AND o.source_namespace=p_client_namespace AND o.family='client_history')
   )
 ), raw_requests AS (
  SELECT * FROM observations
  WHERE family IN ('forms','quiz') AND eligible AND person_id IS NOT NULL
 ), bridge_candidates AS (
  SELECT r.person_id source_person,r.identity_key source_identity_key,p.person_id target_person
  FROM raw_requests r
  JOIN observations c ON c.family='client_history' AND c.identity_key=r.identity_key
  JOIN LATERAL jsonb_array_elements_text(
   CASE WHEN jsonb_typeof(c.properties->'prospectIds')='array' THEN c.properties->'prospectIds' ELSE '[]'::jsonb END
  ) linked(external_id) ON true
  JOIN prospects p ON p.source='notion' AND p.source_namespace=p_notion_namespace
   AND c.properties->>'prospectNamespace'=p_notion_namespace
   AND p.external_id=linked.external_id AND p.person_id IS NOT NULL
   AND p.business->'clientIds' @> jsonb_build_array(c.external_id)
 ), bridge_people AS (
  SELECT source_person,array_agg(DISTINCT target_person) target_people
  FROM bridge_candidates
  GROUP BY source_person
 ), bridge_targets AS (
  SELECT source_person,source_identity_key,array_agg(DISTINCT target_person) target_people
  FROM bridge_candidates
  GROUP BY source_person,source_identity_key
 ), bridge AS (
  SELECT b.source_person,b.source_identity_key,b.target_people[1] target_person
  FROM bridge_targets b
  JOIN bridge_people person_targets USING(source_person)
  WHERE cardinality(b.target_people)=1 AND cardinality(person_targets.target_people)=1
   AND b.target_people[1]=person_targets.target_people[1]
   AND NOT EXISTS (
    SELECT FROM prospects own
    WHERE own.source='notion' AND own.source_namespace=p_notion_namespace
     AND own.person_id=b.source_person
   )
 ), marked_observations AS (
  SELECT o.*,coalesce(b.target_person,o.person_id) canonical_person_id
  FROM observations o
  LEFT JOIN bridge b ON b.source_identity_key=o.identity_key
   AND (b.source_person=o.person_id OR o.family='client_history')
 ), notion_rows AS (
  SELECT coalesce(b.target_person,p.person_id) person_id,p.external_id,p.business
  FROM prospects p
  LEFT JOIN bridge b ON b.source_person=p.person_id
  WHERE p.source='notion' AND p.source_namespace=p_notion_namespace AND p.business<>'{}'
 ), notion AS (
  SELECT n.person_id,n.external_id,min(d.event_day) event_day
  FROM notion_rows n
  CROSS JOIN LATERAL (
   SELECT CASE
    WHEN length(v)=10 AND pg_input_is_valid(v,'date') THEN v::date
    WHEN length(v)>10 AND pg_input_is_valid(v,'timestamptz') THEN (v::timestamptz AT TIME ZONE 'Europe/Paris')::date
   END event_day
   FROM (VALUES(n.business->'dates'->>'real'),(n.business->'dates'->>'legacy'),(n.business->'dates'->>'wix'),(n.business->>'acquisitionDay')) raw(v)
  ) d
  WHERE d.event_day IS NOT NULL
  GROUP BY n.person_id,n.external_id
 ), requests AS (
  SELECT canonical_person_id person_id,occurred_day
  FROM marked_observations
  WHERE family IN ('forms','quiz') AND eligible
 ), candidates AS (
  SELECT person_id,event_day FROM notion WHERE person_id IS NOT NULL
  UNION ALL
  SELECT person_id,occurred_day FROM requests WHERE person_id IS NOT NULL
 ), earliest AS (
  SELECT person_id,min(event_day) event_day,bool_or(event_day>=p_from AND event_day<p_to) in_period
  FROM candidates
  GROUP BY person_id
 ), client_before AS (
  SELECT canonical_person_id person_id,min(occurred_day) event_day
  FROM marked_observations
  WHERE family='client_history' AND eligible AND canonical_person_id IS NOT NULL
  GROUP BY canonical_person_id
 ), first_known AS (
  SELECT e.*,c.event_day client_day FROM earliest e LEFT JOIN client_before c USING(person_id)
 ), active AS (
  SELECT person_id FROM earliest WHERE in_period
 ), period_requests AS (
  SELECT * FROM requests WHERE occurred_day>=p_from AND occurred_day<p_to
 ), latest_per_family AS (
  SELECT DISTINCT ON (source_namespace,stream_key) * FROM valid_runs
  WHERE (source_namespace=p_wix_namespace AND stream_key IN ('lead_entries_forms','lead_entries_quiz'))
   OR (source_namespace=p_client_namespace AND stream_key='lead_entries_client_history')
  ORDER BY source_namespace,stream_key,source_as_of DESC,started_at DESC,id DESC
 )
 SELECT jsonb_build_object(
  'available',EXISTS(SELECT FROM latest_per_family WHERE source='wix'),
  'observedAt',(SELECT max(finished_at) FROM latest_per_family),
  'firstKnownAcquisitions',(SELECT count(*) FROM first_known WHERE event_day>=p_from AND event_day<p_to AND (client_day IS NULL OR client_day>=event_day)),
  'peopleWithRequests',(SELECT count(*) FROM active),
  'sourceRequestPeople',(SELECT count(DISTINCT person_id) FROM period_requests),
  'requestCount',(SELECT count(*) FROM period_requests),
  'unresolvedDatedRequests',(SELECT count(*) FROM period_requests WHERE person_id IS NULL),
  'unresolvedNotionRows',(SELECT count(*) FROM notion WHERE person_id IS NULL AND event_day>=p_from AND event_day<p_to),
  'earlierClientEvidence',(SELECT count(*) FROM first_known WHERE event_day>=p_from AND event_day<p_to AND client_day<event_day),
  'knownBeforePeriod',(SELECT count(*) FROM first_known WHERE in_period AND least(event_day,client_day)<p_from),
  'excludedSourceRequests',(SELECT count(*) FROM observations WHERE family IN ('forms','quiz') AND NOT eligible AND occurred_day>=p_from AND occurred_day<p_to),
  'reciprocalClientHistoryBridges',(SELECT count(*) FROM bridge),
  'families',(SELECT coalesce(jsonb_agg(jsonb_build_object('family',replace(stream_key,'lead_entries_',''),'status',status,'from',covered_from,'to',covered_to,'observedAt',source_as_of,'counts',(SELECT counts_run.checkpoint->'counts' FROM sync_runs counts_run WHERE counts_run.id=latest_per_family.id))),'[]') FROM latest_per_family),
  'latestAttempts',(SELECT coalesce(jsonb_agg(jsonb_build_object('family',replace(a.stream_key,'lead_entries_',''),'status',a.status,'startedAt',a.started_at,'finishedAt',a.finished_at,'errorCode',a.error_code)),'[]') FROM (
   SELECT DISTINCT ON(stream_key) * FROM sync_runs
   WHERE query_profile_key=p_scope->replace(stream_key,'lead_entries_','')->>'profile'
    AND ((source_namespace=p_wix_namespace AND stream_key IN ('lead_entries_forms','lead_entries_quiz')) OR (source_namespace=p_client_namespace AND stream_key='lead_entries_client_history'))
   ORDER BY stream_key,started_at DESC,id DESC
  ) a),
  'sourceBasis','Wix + Notion',
  'definitionState','first_contact',
  'mappingPending',coalesce((SELECT jsonb_agg(jsonb_build_object('family',family,'requestedProfile',requested_profile,'publishedProfile',profile)) FROM selected_profiles WHERE requested_profile<>profile),'[]'::jsonb),
  'reason','Premières arrivées connues et personnes ayant une demande sont séparées. Les inscriptions Wix conservées ne couvrent pas tout l’historique. Une antériorité client sans date d’acquisition reste distincte.'
 ) INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_source_window(
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
   WITH publication_rows AS MATERIALIZED (
    SELECT * FROM public.source_aggregates WHERE sync_run_id=v_run.id
   )
   SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'),count(*),coalesce(bool_and((a.period_from=v_from AND a.period_to=v_to
    AND a.timezone=p_timezone AND a.coverage_state='complete' AND a.unit='count' AND a.currency IS NULL AND a.currency_exponent IS NULL
    AND jsonb_typeof(a.dimensions)='object' AND (a.value IS NULL OR (a.value>=0 AND a.value<=9007199254740991 AND a.value=trunc(a.value)))) IS TRUE),false)
    INTO v_rows,v_count,v_valid FROM publication_rows a WHERE a.sync_run_id=v_run.id AND a.source=p_source AND a.source_namespace=p_namespace AND a.report_profile_key=p_profile AND a.metric_key=ANY(v_metrics);
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

REVOKE ALL ON FUNCTION public.cockpit_business_rollup(text,date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_business_rollup(text,date,date) TO service_role;
REVOKE ALL ON FUNCTION public.cockpit_lead_entry_rollup_v2(text,text,text,date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_lead_entry_rollup_v2(text,text,text,date,date,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.cockpit_source_window(text,text,text,text,date,date,text,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_source_window(text,text,text,text,date,date,text,text,integer,text) TO service_role;

INSERT INTO public.cockpit_migrations(version) VALUES(29) ON CONFLICT (version) DO NOTHING;
COMMIT;
