-- CLI scaffold normalized to the existing integer migration registry (16).
-- PostHog reports are assembled off-database and published atomically here.
BEGIN;

CREATE FUNCTION public.cockpit_claim_posthog(
 p_namespace text,p_stream text,p_profile text,p_from timestamptz,p_to timestamptz,p_context jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; previous public.sync_runs; token uuid=gen_random_uuid(); stamp timestamptz=clock_timestamp(); expiry timestamptz; expected jsonb; job text; attempt integer;
BEGIN
 IF p_namespace IS NULL OR p_namespace !~ '^[0-9]{1,20}$' OR p_stream IS NULL OR p_stream NOT IN ('quiz_observations','masterclass_observations')
  OR p_profile IS NULL OR length(p_profile) NOT BETWEEN 1 AND 500 OR p_from IS NULL OR p_to IS NULL OR p_from>=p_to
  OR p_context IS NULL OR jsonb_typeof(p_context)<>'object' OR octet_length(p_context::text)>8000
  OR (SELECT count(*) FROM jsonb_object_keys(p_context))<>4
  OR NOT (p_context ?& ARRAY['origin','scope','client','expectedQueries'])
  OR jsonb_typeof(p_context->'origin') IS DISTINCT FROM 'string'
  OR p_context->>'origin' NOT IN ('https://eu.posthog.com','https://us.posthog.com','https://app.posthog.com')
  OR jsonb_typeof(p_context->'scope')<>'object' OR jsonb_typeof(p_context->'client')<>'object'
  OR jsonb_typeof(p_context->'expectedQueries')<>'array'
 THEN RAISE EXCEPTION 'invalid PostHog claim' USING ERRCODE='23514';END IF;
 expected=p_context->'expectedQueries';
 IF (p_stream='quiz_observations' AND expected NOT IN ('["overview","byEvent","byHostEvent","daily"]'::jsonb,'["overview","byEvent","byHostEvent","daily","questions"]'::jsonb))
  OR (p_stream='masterclass_observations' AND expected<>'["masterclass"]'::jsonb) THEN
  RAISE EXCEPTION 'invalid PostHog query plan' USING ERRCODE='23514';END IF;
 -- Compatible with begin_sync_stream's source/namespace/stream/profile lock.
 PERFORM pg_advisory_xact_lock(hashtextextended('posthog:'||p_namespace||':'||p_stream||':'||p_profile,0));
 stamp=clock_timestamp();
 SELECT * INTO r FROM public.sync_runs WHERE source='posthog' AND source_namespace=p_namespace AND stream_key=p_stream AND query_profile_key=p_profile AND status='running' ORDER BY started_at DESC,id DESC LIMIT 1 FOR UPDATE;
 stamp=clock_timestamp();
 IF r.id IS NOT NULL THEN
  expiry=CASE WHEN r.checkpoint->>'expiresAt' IS NOT NULL THEN (r.checkpoint->>'expiresAt')::timestamptz ELSE r.started_at+interval '10 minutes' END;
  IF expiry<=stamp THEN
   UPDATE public.sync_runs SET status='failed',finished_at=stamp,error_code='POSTHOG_QUERY_EXPIRED',lease_token=NULL,lease_until=NULL WHERE id=r.id;
   RETURN jsonb_build_object('busy',true,'runId',r.id,'reason','POSTHOG_QUERY_EXPIRED','retryAt',stamp+interval '5 minutes');
  END IF;
  IF r.period_from<>p_from OR r.period_to<>p_to OR r.checkpoint->'context' IS DISTINCT FROM p_context THEN
   RETURN jsonb_build_object('busy',true,'runId',r.id,'reason','POSTHOG_SCOPE_BUSY','retryAt',coalesce(r.lease_until,stamp));
  END IF;
  IF r.lease_until>stamp THEN RETURN jsonb_build_object('busy',true,'runId',r.id,'reason','POSTHOG_LEASE_BUSY','retryAt',r.lease_until);END IF;
 ELSE
  SELECT * INTO previous FROM public.sync_runs WHERE source='posthog' AND source_namespace=p_namespace AND stream_key=p_stream AND query_profile_key=p_profile AND status='failed' ORDER BY finished_at DESC,id DESC LIMIT 1;
  IF previous.id IS NOT NULL AND previous.finished_at>stamp-interval '5 minutes' THEN
   RETURN jsonb_build_object('busy',true,'runId',previous.id,'reason','POSTHOG_COOLDOWN','retryAt',previous.finished_at+interval '5 minutes');
  END IF;
  expiry=stamp+interval '10 minutes';
  job='posthog:'||p_namespace||':'||p_stream||':'||p_profile||':'||p_from::text||':'||p_to::text;
  SELECT coalesce(max(attempt_no),0)+1 INTO attempt FROM public.sync_runs WHERE job_key=job;
  INSERT INTO public.sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,attempt_no,connector_version,period_from,period_to,coverage_kind,date_from,date_to,checkpoint,source_as_of)
  VALUES('posthog',p_namespace,p_stream,p_profile,p_from::text||'/'||p_to::text,job,attempt,'posthog-resume-v1',p_from,p_to,'aggregate_period',(p_from AT TIME ZONE 'Europe/Paris')::date,(p_to AT TIME ZONE 'Europe/Paris')::date,
   jsonb_build_object('version',1,'context',p_context,'observedAt',stamp,'expiresAt',expiry,'queries','{}'::jsonb),stamp) RETURNING * INTO r;
 END IF;
 token=gen_random_uuid();
 UPDATE public.sync_runs SET lease_token=token,lease_until=least(stamp+interval '2 minutes',expiry),error_code=NULL WHERE id=r.id;
 RETURN jsonb_build_object('busy',false,'runId',r.id,'lease',token,'checkpoint',r.checkpoint,'observedAt',r.source_as_of,'expiresAt',expiry);
END $$;

CREATE FUNCTION public.cockpit_save_posthog_query(
 p_run uuid,p_lease uuid,p_name text,p_continuation jsonb,p_complete boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; old jsonb; item jsonb; stamp timestamptz=clock_timestamp(); origin text; project text;
BEGIN
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run AND source='posthog' AND status='running' FOR UPDATE;
 stamp=clock_timestamp();
 IF NOT FOUND OR p_lease IS NULL OR r.lease_token IS DISTINCT FROM p_lease OR r.lease_until IS NULL OR r.lease_until<=stamp
  OR r.checkpoint->>'version' IS DISTINCT FROM '1' OR (r.checkpoint->>'expiresAt')::timestamptz<=stamp THEN
  RAISE EXCEPTION 'PostHog lease lost' USING ERRCODE='55000';END IF;
 IF p_name IS NULL OR NOT (r.checkpoint->'context'->'expectedQueries' ? p_name) OR p_complete IS NULL
  OR p_continuation IS NULL OR jsonb_typeof(p_continuation) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_continuation)) NOT BETWEEN 6 AND 8
  OR EXISTS (SELECT FROM jsonb_object_keys(p_continuation) k WHERE k NOT IN ('version','id','origin','projectId','queryHash','startedAt','lookupAttempts','registered'))
  OR NOT (p_continuation ?& ARRAY['version','id','origin','projectId','queryHash','startedAt'])
  OR jsonb_typeof(p_continuation->'id') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_continuation->'queryHash') IS DISTINCT FROM 'string'
  OR p_continuation->'version' IS DISTINCT FROM '1'::jsonb OR p_continuation->>'id' !~ '^[A-Za-z0-9-]{1,100}$'
  OR p_continuation->>'queryHash' !~ '^[a-f0-9]{64}$'
  OR (p_continuation ? 'registered' AND jsonb_typeof(p_continuation->'registered') IS DISTINCT FROM 'boolean')
  OR (p_continuation ? 'lookupAttempts' AND (jsonb_typeof(p_continuation->'lookupAttempts') IS DISTINCT FROM 'number' OR p_continuation->>'lookupAttempts' !~ '^[0-3]$'))
  OR jsonb_typeof(p_continuation->'startedAt') IS DISTINCT FROM 'number' OR p_continuation->>'startedAt' !~ '^[0-9]{13}$'
 THEN RAISE EXCEPTION 'invalid PostHog continuation' USING ERRCODE='23514';END IF;
 origin=r.checkpoint->'context'->>'origin';project=r.source_namespace;
 IF p_continuation->>'origin' IS DISTINCT FROM origin OR p_continuation->>'projectId' IS DISTINCT FROM project
  OR (p_continuation->>'startedAt')::numeric > extract(epoch FROM stamp)*1000
  OR (p_continuation->>'startedAt')::numeric < extract(epoch FROM r.source_as_of)*1000-30000
 THEN RAISE EXCEPTION 'PostHog continuation context mismatch' USING ERRCODE='23514';END IF;
 old=r.checkpoint->'queries'->p_name;
 IF old IS NOT NULL THEN
  IF old->'continuation'->>'queryHash' IS DISTINCT FROM p_continuation->>'queryHash'
   OR old->'continuation'->>'startedAt' IS DISTINCT FROM p_continuation->>'startedAt'
   OR coalesce((old->'continuation'->>'lookupAttempts')::int,0)>coalesce((p_continuation->>'lookupAttempts')::int,0)
   OR (old->'continuation'->>'registered'='true' AND p_continuation->>'registered' IS DISTINCT FROM 'true')
   OR (old->>'complete')::boolean AND NOT p_complete THEN RAISE EXCEPTION 'PostHog continuation conflict' USING ERRCODE='55000';END IF;
 END IF;
 item=jsonb_build_object('continuation',p_continuation,'complete',p_complete);
 IF octet_length(jsonb_set(r.checkpoint,ARRAY['queries',p_name],item)::text)>16000 THEN RAISE EXCEPTION 'PostHog checkpoint too large' USING ERRCODE='23514';END IF;
 UPDATE public.sync_runs SET checkpoint=jsonb_set(r.checkpoint,ARRAY['queries',p_name],item),lease_until=least(stamp+interval '2 minutes',(r.checkpoint->>'expiresAt')::timestamptz) WHERE id=r.id;
 RETURN true;
END $$;

CREATE FUNCTION public.cockpit_release_posthog(p_run uuid,p_lease uuid,p_error text DEFAULT NULL)
 RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; stamp timestamptz=clock_timestamp();
BEGIN
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run AND source='posthog' AND status='running' FOR UPDATE;
 stamp=clock_timestamp();
 IF NOT FOUND OR p_lease IS NULL OR r.lease_token IS DISTINCT FROM p_lease OR r.lease_until IS NULL OR r.lease_until<=stamp THEN RAISE EXCEPTION 'PostHog lease lost' USING ERRCODE='55000';END IF;
 IF p_error IS NOT NULL AND p_error NOT IN ('POSTHOG_IMPORT_FAILED','POSTHOG_QUERY_FAILED','POSTHOG_QUERY_EXPIRED','POSTHOG_PREFLIGHT_FAILED','POSTHOG_RESULT_INVALID','POSTHOG_TRANSPORT_ERROR','POSTHOG_PROJECT_IDENTITY_MISMATCH','POSTHOG_SCHEMA_UNAVAILABLE','POSTHOG_TIME_BUDGET','POSTHOG_MASTERCLASS_IMPORT_FAILED',
  'NETWORK_ERROR','ACCESS_DENIED','ACCESS_DENIED_HTTP_401','ACCESS_DENIED_HTTP_403','UPSTREAM_HTTP_ERROR','POSTHOG_QUERY_MISSING','INVALID_POSTHOG_CONTINUATION','INVALID_POSTHOG_QUERY_ID','INVALID_POSTHOG_RESPONSE','POSTHOG_REQUEST_TIMEOUT','POSTHOG_CANCELLED','POSTHOG_DNS_ERROR','POSTHOG_CONNECTION_RESET','POSTHOG_RESULT_LIMIT','POSTHOG_SCHEMA_PAGE_LIMIT','RESPONSE_TOO_LARGE','POSTHOG_TOTALS_CHANGED','POSTHOG_DISTINCT_COUNTS_MISMATCH') THEN
  RAISE EXCEPTION 'invalid PostHog error code' USING ERRCODE='23514';END IF;
 IF (r.checkpoint->>'expiresAt')::timestamptz<=stamp THEN p_error='POSTHOG_QUERY_EXPIRED';END IF;
 UPDATE public.sync_runs SET status=CASE WHEN p_error IS NULL THEN status ELSE 'failed' END,finished_at=CASE WHEN p_error IS NULL THEN NULL ELSE stamp END,
  error_code=p_error,lease_token=NULL,lease_until=CASE WHEN p_error IS NULL THEN stamp ELSE NULL END WHERE id=r.id;
 RETURN true;
END $$;

CREATE FUNCTION public.cockpit_publish_posthog(p_run uuid,p_lease uuid,p_records jsonb,p_read integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; row jsonb; stamp timestamptz=clock_timestamp(); digest_hex text; count_rows integer; names jsonb; name text; keys text[]; metric text; value_numeric numeric;
BEGIN
 IF p_records IS NULL OR jsonb_typeof(p_records) IS DISTINCT FROM 'array' OR octet_length(p_records::text)>2000000 OR jsonb_array_length(p_records)>750 OR p_read IS NULL OR p_read<0 OR p_read>9007199254740991 THEN
  RAISE EXCEPTION 'invalid PostHog publication' USING ERRCODE='23514';END IF;
 digest_hex=encode(pg_catalog.sha256(pg_catalog.convert_to(p_records::text,'UTF8')),'hex');count_rows=jsonb_array_length(p_records);
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run AND source='posthog' FOR UPDATE;
 stamp=clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PostHog run missing' USING ERRCODE='55000';END IF;
 IF r.status IN ('complete','empty') THEN
  IF r.content_digest IS DISTINCT FROM digest_hex THEN RAISE EXCEPTION 'PostHog publication conflict' USING ERRCODE='55000';END IF;
  RETURN jsonb_build_object('status',r.status,'count',r.rows_written,'digest',digest_hex,'duplicate',true);
 END IF;
 IF r.status<>'running' OR p_lease IS NULL OR r.lease_token IS DISTINCT FROM p_lease OR r.lease_until IS NULL OR r.lease_until<=stamp
  OR r.checkpoint->>'version' IS DISTINCT FROM '1' OR (r.checkpoint->>'expiresAt')::timestamptz<=stamp THEN
  RAISE EXCEPTION 'PostHog lease lost' USING ERRCODE='55000';END IF;
 names=r.checkpoint->'context'->'expectedQueries';
 FOR name IN SELECT jsonb_array_elements_text(names) LOOP
  IF r.checkpoint->'queries'->name->>'complete' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PostHog report incomplete' USING ERRCODE='55000';END IF;
 END LOOP;
 IF count_rows<1 THEN RAISE EXCEPTION 'PostHog overview missing' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(p_records) a WHERE a->>'metric_key'=CASE WHEN r.stream_key='quiz_observations' THEN 'posthog_events' ELSE 'posthog_mc_events' END AND a->>'dimensions_key'='all' AND a->'value' IS NOT NULL AND a->'value'<>'null'::jsonb) THEN
  RAISE EXCEPTION 'PostHog overview missing' USING ERRCODE='23514';END IF;
 IF (SELECT (a->>'value')::numeric FROM jsonb_array_elements(p_records) a
     WHERE a->>'metric_key'=CASE WHEN r.stream_key='quiz_observations' THEN 'posthog_events' ELSE 'posthog_mc_events' END AND a->>'dimensions_key'='all' LIMIT 1) IS DISTINCT FROM p_read THEN
  RAISE EXCEPTION 'PostHog read count mismatch' USING ERRCODE='23514';END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_records) LOOP
  IF jsonb_typeof(row)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(row))<>17
   OR NOT (row ?& ARRAY['source','source_namespace','metric_key','period_from','period_to','dimensions_key','report_profile_key','timezone','coverage_state','value','unit','currency','currency_exponent','tax_basis','dimensions','definition_version','source_locator'])
   OR row->>'source' IS DISTINCT FROM 'posthog' OR row->>'source_namespace' IS DISTINCT FROM r.source_namespace
   OR row->>'report_profile_key' IS DISTINCT FROM r.query_profile_key
   OR row->>'period_from' IS NULL OR row->>'period_to' IS NULL
   OR (row->>'period_from')::timestamptz<>r.period_from OR (row->>'period_to')::timestamptz<>r.period_to
   OR row->>'timezone' IS DISTINCT FROM 'Europe/Paris' OR row->>'coverage_state' IS DISTINCT FROM 'complete'
   OR row->>'unit' IS DISTINCT FROM 'count' OR row->'currency'<>'null'::jsonb OR row->'currency_exponent'<>'null'::jsonb
   OR row->>'tax_basis' IS DISTINCT FROM 'unknown' OR row->>'definition_version' IS DISTINCT FROM r.query_profile_key
   OR jsonb_typeof(row->'dimensions')<>'object' OR octet_length((row->'dimensions')::text)>=4000
   OR length(row->>'dimensions_key') NOT BETWEEN 1 AND 200 OR length(row->>'source_locator') NOT BETWEEN 1 AND 300
  THEN RAISE EXCEPTION 'PostHog record context mismatch' USING ERRCODE='23514';END IF;
  metric=row->>'metric_key';
  IF (r.stream_key='quiz_observations' AND metric NOT IN ('posthog_events','posthog_visitors','posthog_sessions'))
   OR (r.stream_key='masterclass_observations' AND metric<>'posthog_mc_events') THEN RAISE EXCEPTION 'PostHog metric mismatch' USING ERRCODE='23514';END IF;
  IF row->'value'<>'null'::jsonb THEN
   IF jsonb_typeof(row->'value')<>'number' THEN RAISE EXCEPTION 'PostHog count invalid' USING ERRCODE='23514';END IF;
   value_numeric=(row->>'value')::numeric;
   IF value_numeric<0 OR value_numeric>9007199254740991 OR value_numeric<>trunc(value_numeric) THEN RAISE EXCEPTION 'PostHog count invalid' USING ERRCODE='23514';END IF;
  ELSIF metric='posthog_events' OR metric='posthog_mc_events' THEN RAISE EXCEPTION 'PostHog events missing' USING ERRCODE='23514';END IF;
  INSERT INTO public.source_aggregates(source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id,timezone,coverage_state,value,unit,currency,currency_exponent,tax_basis,dimensions,definition_version,source_locator)
  VALUES('posthog',r.source_namespace,metric,r.period_from,r.period_to,row->>'dimensions_key',r.query_profile_key,r.id,'Europe/Paris','complete',value_numeric,'count',NULL,NULL,'unknown',row->'dimensions',r.query_profile_key,row->>'source_locator');
  value_numeric=NULL;
 END LOOP;
 UPDATE public.sync_runs SET status=CASE WHEN p_read=0 THEN 'empty' ELSE 'complete' END,finished_at=stamp,pagination_complete=true,
  covered_from=period_from,covered_to=period_to,rows_read=p_read,rows_written=count_rows,rows_rejected=0,content_digest=digest_hex,
  lease_token=NULL,lease_until=NULL WHERE id=r.id;
 RETURN jsonb_build_object('status',CASE WHEN p_read=0 THEN 'empty' ELSE 'complete' END,'count',count_rows,'digest',digest_hex,'duplicate',false);
END $$;

REVOKE ALL ON FUNCTION public.cockpit_claim_posthog(text,text,text,timestamptz,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_save_posthog_query(uuid,uuid,text,jsonb,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_release_posthog(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_publish_posthog(uuid,uuid,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_claim_posthog(text,text,text,timestamptz,timestamptz,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_save_posthog_query(uuid,uuid,text,jsonb,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_release_posthog(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_publish_posthog(uuid,uuid,jsonb,integer) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(16);
COMMIT;
