-- Add the read-only PostHog aggregate source to the existing import journal.
-- No table, policy, grant, or existing import behavior changes.
BEGIN;
CREATE OR REPLACE FUNCTION public.begin_sync(p_source text,p_namespace text,p_from timestamptz,p_to timestamptz,p_profile text,p_coverage_kind text,p_date_from date DEFAULT NULL,p_date_to date DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE run uuid; job text; attempt integer;
BEGIN
 IF p_source NOT IN ('meta','notion','wix','posthog') THEN RAISE EXCEPTION 'unsupported source' USING ERRCODE='23514';END IF;
 job=p_source||':'||p_namespace||':'||p_profile||':'||p_from::text||':'||p_to::text;
 PERFORM pg_advisory_xact_lock(hashtextextended(job,0));
 UPDATE public.sync_runs SET status='failed',finished_at=now(),error_code='expired_worker' WHERE job_key=job AND status='running' AND started_at<now()-interval '10 minutes';
 SELECT coalesce(max(attempt_no),0)+1 INTO attempt FROM public.sync_runs WHERE job_key=job;
 INSERT INTO public.sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,attempt_no,connector_version,period_from,period_to,coverage_kind,date_from,date_to)
 VALUES(p_source,p_namespace,CASE p_source WHEN 'meta' THEN 'ad_daily' WHEN 'notion' THEN 'prospects_current' ELSE 'aggregates' END,p_profile,p_from::text||'/'||p_to::text,job,attempt,'read-v1',p_from,p_to,p_coverage_kind,p_date_from,p_date_to) RETURNING id INTO run;
 RETURN run;
END $$;
INSERT INTO public.cockpit_migrations(version) VALUES(6);
COMMIT;
