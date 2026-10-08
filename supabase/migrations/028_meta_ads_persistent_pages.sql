-- Same ad_daily stream, source window, metrics and publication. Only page work
-- becomes resumable. Existing published data remains untouched until all seven
-- day partitions are complete. No new table, source POST or history rewrite.
BEGIN;
-- Fence pre-resume begin/finish/import/publish writers for an owned run. Their
-- whole transaction fails instead of expiring a checkpoint after ten minutes.
CREATE OR REPLACE FUNCTION public.cockpit_guard_meta_ads_run() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.checkpoint->>'metaAdsVersion'='1' AND current_setting('blg.meta_ads_run',true) IS DISTINCT FROM OLD.id::text THEN
  RAISE EXCEPTION 'resumable Meta run requires owner RPC' USING ERRCODE='55000';
 END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS meta_ads_run_owner ON public.sync_runs;
CREATE TRIGGER meta_ads_run_owner BEFORE UPDATE ON public.sync_runs FOR EACH ROW EXECUTE FUNCTION public.cockpit_guard_meta_ads_run();

CREATE OR REPLACE FUNCTION public.cockpit_claim_meta_ads(p_namespace text,p_profile text,p_from date,p_to date,p_resume boolean DEFAULT true) RETURNS jsonb
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; token uuid=gen_random_uuid(); parts jsonb; id_new uuid; stamp timestamptz=clock_timestamp();
BEGIN
 IF p_namespace IS NULL OR p_namespace!~'^\d{1,30}$' OR p_profile IS NULL OR p_profile!~'^v\d+\.0-ad-day-none$' OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from OR p_to-p_from>93 OR p_resume IS NULL THEN RAISE EXCEPTION 'invalid Meta scope' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('meta:'||p_namespace||':ad_daily:'||p_profile,0));
 SELECT * INTO r FROM public.sync_runs WHERE source='meta' AND source_namespace=p_namespace AND stream_key='ad_daily' AND query_profile_key=p_profile AND status='running' ORDER BY started_at DESC,id DESC LIMIT 1 FOR UPDATE;
 -- Legacy workers have no durable page checkpoint. Preserve their existing
 -- ten-minute expiry, but never expire a worker holding an active lease.
 IF r.id IS NOT NULL AND r.checkpoint->>'metaAdsVersion' IS DISTINCT FROM '1' AND r.started_at<stamp-interval '10 minutes' AND (r.lease_until IS NULL OR r.lease_until<=stamp) THEN
  UPDATE public.sync_runs SET status='failed',finished_at=stamp,error_code='expired_worker',lease_token=NULL,lease_until=NULL WHERE id=r.id;
  r.id=NULL;
 END IF;
 IF r.id IS NOT NULL AND (r.checkpoint->>'metaAdsVersion' IS DISTINCT FROM '1' OR r.lease_until>stamp OR (NOT p_resume AND (r.date_from<>p_from OR r.date_to<>p_to))) THEN RETURN jsonb_build_object('busy',true,'runId',r.id);END IF;
 IF r.id IS NULL THEN
  id_new=public.begin_sync_stream('meta',p_namespace,p_from::timestamp AT TIME ZONE 'Europe/Paris',p_to::timestamp AT TIME ZONE 'Europe/Paris',p_profile,'aggregate_period','ad_daily',p_from,p_to);
  SELECT jsonb_agg(jsonb_build_object('from',(p_from+i)::text,'to',least(p_to,p_from+i+7)::text) ORDER BY i) INTO parts FROM generate_series(0,p_to-p_from-1,7) i;
  UPDATE public.sync_runs SET checkpoint=jsonb_build_object('metaAdsVersion',1,'partitions',parts,'index',0,'cursor',null,'page',0,'totalPages',0,'done',false),connector_version='meta-read-v1' WHERE id=id_new;
  SELECT * INTO r FROM public.sync_runs WHERE id=id_new;
 END IF;
 PERFORM set_config('blg.meta_ads_run',r.id::text,true);
 UPDATE public.sync_runs SET lease_token=token,lease_until=stamp+interval '90 seconds',error_code=NULL WHERE id=r.id;
 RETURN jsonb_build_object('busy',false,'runId',r.id,'lease',token,'from',r.date_from,'to',r.date_to,'observedAt',r.source_as_of,'checkpoint',r.checkpoint,'read',r.rows_read);
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_stage_meta_ads(p_run uuid,p_lease uuid,p_index integer,p_page integer,p_before text,p_records jsonb,p_next text,p_terminal boolean,p_account jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; cp jsonb; part jsonb; receipt text; n integer; next_index integer; next_page integer;
BEGIN
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run AND source='meta' AND stream_key='ad_daily' AND status='running' AND lease_token=p_lease AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND OR r.checkpoint->>'metaAdsVersion' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'inactive Meta lease' USING ERRCODE='55000';END IF;
 cp=r.checkpoint;part=cp->'partitions'->p_index;
 IF p_account IS NULL OR jsonb_typeof(p_account)<>'object' THEN RAISE EXCEPTION 'invalid Meta account' USING ERRCODE='23514';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_account))<>3 OR p_account->>'accountId' IS DISTINCT FROM r.source_namespace OR p_account->>'currency' IS NULL OR p_account->>'currency'!~'^[A-Z]{3}$' OR NOT EXISTS(SELECT FROM pg_timezone_names WHERE name=p_account->>'timezone') OR (cp->'account' IS NOT NULL AND cp->'account' IS DISTINCT FROM p_account) THEN RAISE EXCEPTION 'Meta account changed' USING ERRCODE='23514';END IF;
 IF p_index IS NULL OR p_page IS NULL OR p_index<0 OR p_page<0 OR part IS NULL OR p_records IS NULL OR jsonb_typeof(p_records)<>'array' OR jsonb_array_length(p_records)>100 OR octet_length(p_records::text)>2000000 OR p_terminal IS NULL OR (p_terminal AND p_next IS NOT NULL) OR (NOT p_terminal AND nullif(p_next,'') IS NULL) OR length(p_next)>4096 OR length(p_before)>4096 THEN RAISE EXCEPTION 'invalid Meta page' USING ERRCODE='23514';END IF;
 receipt=encode(sha256(convert_to(jsonb_build_object('index',p_index,'page',p_page,'before',p_before,'records',p_records,'next',p_next,'terminal',p_terminal,'account',p_account)::text,'UTF8')),'hex');
 IF cp->>'lastReceipt'=receipt THEN RETURN jsonb_build_object('duplicate',true,'checkpoint',cp,'read',r.rows_read);END IF;
 IF cp->>'done'='true' OR p_index IS DISTINCT FROM (cp->>'index')::integer OR p_page IS DISTINCT FROM (cp->>'page')::integer OR p_before IS DISTINCT FROM cp->>'cursor' THEN RAISE EXCEPTION 'stale Meta page' USING ERRCODE='55000';END IF;
 -- Preserve the old20*100-row volume. Disjoint partitions can need at most
 --20+partitionCount-1 pages for that volume; every overflow fails, never trims.
 IF (cp->>'totalPages')::integer>=20+jsonb_array_length(cp->'partitions')-1 OR r.rows_read+jsonb_array_length(p_records)>2000 THEN RAISE EXCEPTION 'Meta page limit reached' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p_records) row WHERE row->>'accountId' IS DISTINCT FROM r.source_namespace OR row->>'currency' IS DISTINCT FROM p_account->>'currency' OR row->>'timezone' IS DISTINCT FROM p_account->>'timezone' OR row->>'adId' IS NULL OR row->>'adId'!~'^\d{1,30}$' OR row->>'date' IS NULL OR (row->>'date')::date<(part->>'from')::date OR (row->>'date')::date>=(part->>'to')::date)
  OR EXISTS(SELECT FROM jsonb_array_elements(p_records) row GROUP BY row->>'adId',row->>'date' HAVING count(*)>1)
  OR EXISTS(SELECT FROM jsonb_array_elements(p_records) row JOIN public.ads a ON a.source='meta' AND a.source_namespace=r.source_namespace AND a.external_id=row->>'adId' JOIN public.ad_daily d ON d.ad_id=a.id AND d.sync_run_id=p_run AND d.date=(row->>'date')::date)
 THEN RAISE EXCEPTION 'Meta duplicate or scope mismatch' USING ERRCODE='23514';END IF;
 -- Cursor loops spanning restarts are rejected too; the raw next URL is never saved.
 IF NOT p_terminal AND (p_next=p_before OR coalesce(cp->'seenCursors','[]'::jsonb) ? p_next) THEN RAISE EXCEPTION 'Meta cursor loop' USING ERRCODE='23514';END IF;
 PERFORM set_config('blg.meta_ads_run',p_run::text,true);
 n=public.import_meta_page(p_run,p_records,p_next);
 next_index=p_index+CASE WHEN p_terminal THEN 1 ELSE 0 END;next_page=CASE WHEN p_terminal THEN 0 ELSE p_page+1 END;
 cp=cp||jsonb_build_object('index',next_index,'page',next_page,'cursor',p_next,'totalPages',(cp->>'totalPages')::integer+1,'done',next_index=jsonb_array_length(cp->'partitions'),'lastReceipt',receipt,'account',p_account,
  'seenCursors',CASE WHEN p_terminal THEN '[]'::jsonb ELSE coalesce(cp->'seenCursors','[]'::jsonb)||to_jsonb(p_next) END);
 UPDATE public.sync_runs SET checkpoint=cp,rows_read=rows_read+n,lease_until=clock_timestamp()+interval '90 seconds' WHERE id=p_run;
 RETURN jsonb_build_object('duplicate',false,'checkpoint',cp,'read',r.rows_read+n);
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_release_meta_ads(p_run uuid,p_lease uuid,p_error text DEFAULT NULL) RETURNS boolean
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_error IS NOT NULL AND p_error!~'^[A-Z_]{1,60}$' THEN RAISE EXCEPTION 'invalid safe error' USING ERRCODE='23514';END IF;
 PERFORM set_config('blg.meta_ads_run',p_run::text,true);
 UPDATE public.sync_runs SET lease_token=NULL,lease_until=clock_timestamp(),status=CASE WHEN p_error IS NULL OR p_error IN ('NETWORK_ERROR','UPSTREAM_HTTP_ERROR') THEN 'running' ELSE 'failed' END,
  finished_at=CASE WHEN p_error IS NULL OR p_error IN ('NETWORK_ERROR','UPSTREAM_HTTP_ERROR') THEN NULL ELSE clock_timestamp() END,error_code=p_error
 WHERE id=p_run AND source='meta' AND stream_key='ad_daily' AND checkpoint->>'metaAdsVersion'='1' AND status='running' AND lease_token=p_lease;
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_publish_meta_ads(p_run uuid,p_lease uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; result jsonb;
BEGIN
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run AND source='meta' AND stream_key='ad_daily' FOR UPDATE;
 IF NOT FOUND OR r.checkpoint->>'metaAdsVersion' IS DISTINCT FROM '1' OR r.checkpoint->>'done' IS DISTINCT FROM 'true' OR (r.checkpoint->>'index')::integer IS DISTINCT FROM jsonb_array_length(r.checkpoint->'partitions') OR r.checkpoint->>'cursor' IS NOT NULL OR r.rows_rejected<>0 THEN RAISE EXCEPTION 'incomplete Meta scope' USING ERRCODE='55000';END IF;
 IF r.status IN ('complete','empty') THEN RETURN public.cockpit_publish_meta_daily(p_run,r.rows_read,0);END IF;
 IF r.status<>'running' OR r.lease_token IS DISTINCT FROM p_lease OR r.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'inactive Meta lease' USING ERRCODE='55000';END IF;
 PERFORM set_config('blg.meta_ads_run',p_run::text,true);
 result=public.cockpit_publish_meta_daily(p_run,r.rows_read,0);
 UPDATE public.sync_runs SET lease_token=NULL,lease_until=NULL WHERE id=p_run;RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.cockpit_guard_meta_ads_run() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_claim_meta_ads(text,text,date,date,boolean),public.cockpit_stage_meta_ads(uuid,uuid,integer,integer,text,jsonb,text,boolean,jsonb),public.cockpit_release_meta_ads(uuid,uuid,text),public.cockpit_publish_meta_ads(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_claim_meta_ads(text,text,date,date,boolean),public.cockpit_stage_meta_ads(uuid,uuid,integer,integer,text,jsonb,text,boolean,jsonb),public.cockpit_release_meta_ads(uuid,uuid,text),public.cockpit_publish_meta_ads(uuid,uuid) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(28) ON CONFLICT DO NOTHING;
COMMIT;
