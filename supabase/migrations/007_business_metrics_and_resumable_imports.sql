-- CLI scaffold normalized to the repository's sequential INTEGER registry (7).
-- Additive cockpit-only changes. Source systems remain read-only.
BEGIN;
ALTER TABLE public.prospects ADD COLUMN business jsonb NOT NULL DEFAULT '{}';
ALTER TABLE public.prospects ADD CONSTRAINT prospects_business_bounded CHECK(octet_length(business::text)<16000);
ALTER TABLE public.sync_runs ADD COLUMN lease_token uuid, ADD COLUMN lease_until timestamptz, ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}';
CREATE TABLE public.notion_import_rows (
 run_id uuid NOT NULL REFERENCES public.sync_runs(id), external_id text NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(run_id,external_id), CHECK(octet_length(payload::text)<24000)
);
ALTER TABLE public.notion_import_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notion_import_rows FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.notion_import_rows TO service_role;

CREATE FUNCTION public.begin_sync_stream(p_source text,p_namespace text,p_from timestamptz,p_to timestamptz,p_profile text,p_coverage_kind text,p_stream text,p_date_from date DEFAULT NULL,p_date_to date DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE run uuid;job text;attempt integer;
BEGIN
 IF p_source NOT IN ('meta','notion','wix','posthog') OR p_stream !~ '^[a-z_]{1,60}$' THEN RAISE EXCEPTION 'unsupported source stream' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_source||':'||p_namespace||':'||p_stream||':'||p_profile,0));
 UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='expired_worker' WHERE source=p_source AND source_namespace=p_namespace AND stream_key=p_stream AND query_profile_key=p_profile AND status='running' AND started_at<now()-interval '10 minutes';
 IF EXISTS(SELECT FROM sync_runs WHERE source=p_source AND source_namespace=p_namespace AND stream_key=p_stream AND query_profile_key=p_profile AND status='running') THEN RAISE EXCEPTION 'source busy' USING ERRCODE='55P03';END IF;
 job=p_source||':'||p_namespace||':'||p_stream||':'||p_profile||':'||p_from::text||':'||p_to::text;
 SELECT coalesce(max(attempt_no),0)+1 INTO attempt FROM sync_runs WHERE job_key=job;
 INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,attempt_no,connector_version,period_from,period_to,coverage_kind,date_from,date_to)
 VALUES(p_source,p_namespace,p_stream,p_profile,p_from::text||'/'||p_to::text,job,attempt,'read-v2',p_from,p_to,p_coverage_kind,p_date_from,p_date_to) RETURNING id INTO run;
 RETURN run;
END $$;

CREATE FUNCTION public.cockpit_claim_notion(p_namespace text,p_profile text) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;token uuid=gen_random_uuid();cutoff timestamptz=clock_timestamp();boundary timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||p_namespace,0));
 SELECT * INTO r FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status='running' ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
 IF r.id IS NOT NULL AND r.lease_until>now() THEN RETURN jsonb_build_object('busy',true,'runId',r.id);END IF;
 IF r.id IS NOT NULL AND r.query_profile_key IS DISTINCT FROM p_profile THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='superseded_profile',lease_token=NULL,lease_until=NULL WHERE id=r.id;
  r.id=NULL;
 END IF;
 IF r.id IS NULL THEN
  boundary=date_trunc('year',cutoff);
  INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,period_from,period_to,coverage_kind,checkpoint)
  VALUES('notion',p_namespace,'prospects_business',p_profile,'full:'||cutoff::text,'notion-full:'||p_namespace||':'||cutoff::text,p_profile,'1970-01-01',cutoff,'source_snapshot',jsonb_build_object('intervals',jsonb_build_array(jsonb_build_object('from','1970-01-01T00:00:00Z','to',boundary,'read',0),jsonb_build_object('from',boundary,'to',cutoff,'read',0)))) RETURNING * INTO r;
 END IF;
 UPDATE sync_runs SET lease_token=token,lease_until=now()+interval '2 minutes',error_code=NULL WHERE id=r.id;
 RETURN jsonb_build_object('busy',false,'runId',r.id,'lease',token,'checkpoint',r.checkpoint,'from',r.period_from,'to',r.period_to,'rowsRead',r.rows_read);
END $$;

CREATE FUNCTION public.cockpit_stage_notion(p_run uuid,p_lease uuid,p_records jsonb,p_checkpoint jsonb,p_read integer) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;row jsonb;identity text;person uuid;
BEGIN
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND source='notion' AND stream_key='prospects_business' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'lease lost' USING ERRCODE='55000';END IF;
 IF jsonb_typeof(p_records) IS DISTINCT FROM 'array' OR jsonb_typeof(p_checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(p_checkpoint->'intervals') IS DISTINCT FROM 'array' OR p_read IS NULL OR p_read<0 THEN RAISE EXCEPTION 'invalid page shape' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(p_records)>100 OR p_read<jsonb_array_length(p_records) THEN RAISE EXCEPTION 'invalid page' USING ERRCODE='23514';END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_checkpoint->'intervals') LOOP
  IF jsonb_typeof(row) IS DISTINCT FROM 'object' OR row->>'from' IS NULL OR row->>'to' IS NULL OR jsonb_typeof(row->'read') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid interval' USING ERRCODE='23514';END IF;
  IF (row->>'from')::timestamptz >= (row->>'to')::timestamptz OR (row->>'read')::integer<0 THEN RAISE EXCEPTION 'invalid interval bounds' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR row IN SELECT value FROM jsonb_array_elements(p_records) LOOP
  IF jsonb_typeof(row) IS DISTINCT FROM 'object' OR row->>'accountId' IS DISTINCT FROM r.source_namespace OR row->>'source' IS DISTINCT FROM 'notion' OR nullif(row->>'externalId','') IS NULL OR jsonb_typeof(row->'business') IS DISTINCT FROM 'object' OR jsonb_typeof(row->'archived') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'source mismatch' USING ERRCODE='23514';END IF;
  INSERT INTO notion_import_rows(run_id,external_id,payload) VALUES(p_run,row->>'externalId',row) ON CONFLICT(run_id,external_id) DO UPDATE SET payload=excluded.payload;
 END LOOP;
 -- Identity facts are independent of a complete business snapshot, and are resolved in batches of at most 100.
 -- No lead, conversion or visible CRM mirror is created here.
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-identity-resolution',0));
 FOR identity IN SELECT DISTINCT value->'business'->>'identityKey' FROM jsonb_array_elements(p_records) WHERE value->'business'->>'identityKey' IS NOT NULL LOOP
  IF identity !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid identity hash' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT FROM person_identities WHERE source='identity' AND source_namespace='blg-email-v1' AND identity_kind='email_hmac' AND identity_key=identity AND valid_to IS NULL) THEN
   INSERT INTO people DEFAULT VALUES RETURNING id INTO person;
   INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,state,evidence) VALUES(person,'identity','blg-email-v1','email_hmac',identity,'linked','Normalized source email HMAC; descriptive Notion identity');
  END IF;
 END LOOP;
 UPDATE sync_runs SET checkpoint=p_checkpoint,rows_read=rows_read+p_read,rows_written=(SELECT count(*) FROM notion_import_rows WHERE run_id=p_run),lease_until=now()+interval '2 minutes' WHERE id=p_run;
 RETURN true;
END $$;

CREATE FUNCTION public.cockpit_release_notion(p_run uuid,p_lease uuid,p_error text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE sync_runs SET lease_until=now(),lease_token=NULL,error_code=p_error WHERE id=p_run AND status='running' AND lease_token=p_lease;
 RETURN FOUND;
END $$;

CREATE FUNCTION public.cockpit_publish_notion(p_run uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;key_namespace text;n integer;ns text;
BEGIN
 SELECT source_namespace INTO ns FROM sync_runs WHERE id=p_run;
 PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||ns,0));
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND source='notion' AND stream_key='prospects_business' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(r.checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(r.checkpoint->'intervals') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'snapshot incomplete' USING ERRCODE='55000';END IF;
 IF jsonb_array_length(r.checkpoint->'intervals') IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'snapshot incomplete' USING ERRCODE='55000';END IF;
 -- The old published mirror stays intact until this terminal transaction commits.
 SELECT count(*) INTO n FROM notion_import_rows WHERE run_id=p_run;
 IF EXISTS(SELECT FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND p.source_updated_at>(s.payload->>'sourceUpdatedAt')::timestamptz) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='STALE_SOURCE_VERSION',lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','count',0,'reason','STALE_SOURCE_VERSION');
 END IF;
 -- Resolve under the same bounded global lock as the signed backend. All identity inserts happened during staging.
 key_namespace='blg-email-v1';
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-identity-resolution',0));
 WITH inserted AS (
  INSERT INTO prospects(source,source_namespace,external_id,display_name,source_status,owner_label,responsible_ids,closer_ids,current_appointment_at,next_follow_up_at,archived,notion_url,source_updated_at,observed_at,connector_version,mapping_version,sync_run_id)
  SELECT 'notion',r.source_namespace,s.external_id,left(s.payload->>'name',249),s.payload->>'status',s.payload->'responsible'->>0,coalesce(s.payload->'responsible','[]'),coalesce(s.payload->'closer','[]'),s.payload->>'appointmentAt',s.payload->>'nextFollowUpAt',(s.payload->>'archived')::boolean,s.payload->>'notionUrl',(s.payload->>'sourceUpdatedAt')::timestamptz,(s.payload->>'observedAt')::timestamptz,s.payload->>'connectorVersion',s.payload->>'mappingVersion',p_run
  FROM notion_import_rows s WHERE s.run_id=p_run ON CONFLICT(source,source_namespace,external_id) DO NOTHING RETURNING *
 ) INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
 SELECT id,'snapshot_initial',NULL,jsonb_build_object('source_status',source_status,'owner_label',owner_label,'current_appointment_at',current_appointment_at,'next_follow_up_at',next_follow_up_at,'archived',archived),source_updated_at::text,p_run FROM inserted ON CONFLICT DO NOTHING;
 -- Capture changed fields before replacing the mirror. Equal versions are idempotent; omission/reappearance has its own observation key.
 INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
 SELECT p.id,f.key,to_jsonb(p)->f.key,updated.data->f.key,CASE WHEN f.key='archived' THEN 'snapshot:'||p_run::text ELSE s.payload->>'sourceUpdatedAt' END,p_run
 FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id
 CROSS JOIN LATERAL (SELECT jsonb_build_object('source_status',s.payload->'status','owner_label',s.payload->'responsible'->>0,'current_appointment_at',s.payload->'appointmentAt','next_follow_up_at',s.payload->'nextFollowUpAt','archived',s.payload->'archived') data) updated
 CROSS JOIN unnest(ARRAY['source_status','owner_label','current_appointment_at','next_follow_up_at','archived']) AS f(key)
 WHERE s.run_id=p_run AND to_jsonb(p)->f.key IS DISTINCT FROM updated.data->f.key ON CONFLICT DO NOTHING;
 UPDATE prospects p SET display_name=left(s.payload->>'name',249),source_status=s.payload->>'status',owner_label=s.payload->'responsible'->>0,responsible_ids=coalesce(s.payload->'responsible','[]'),closer_ids=coalesce(s.payload->'closer','[]'),current_appointment_at=s.payload->>'appointmentAt',next_follow_up_at=s.payload->>'nextFollowUpAt',
  source_updated_at=(s.payload->>'sourceUpdatedAt')::timestamptz,archived=(s.payload->>'archived')::boolean,business=s.payload->'business',person_identity_id=i.id,person_id=CASE WHEN i.state='linked' THEN i.person_id END,
  mapping_version=s.payload->>'mappingVersion',connector_version=s.payload->>'connectorVersion',observed_at=(s.payload->>'observedAt')::timestamptz,sync_run_id=p_run
 FROM notion_import_rows s LEFT JOIN person_identities i ON i.source='identity' AND i.source_namespace=key_namespace AND i.identity_kind='email_hmac' AND i.identity_key=s.payload->'business'->>'identityKey' AND i.valid_to IS NULL
 WHERE s.run_id=p_run AND p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id;
 INSERT INTO appointments(source,source_namespace,external_id,identity_basis,prospect_id,scheduled_at,scheduled_day,status,source_status,evidence_state,source_updated_at,observed_at,connector_version,sync_run_id)
 SELECT 'notion',r.source_namespace,p.external_id||':current-slot','notion_current_slot',p.id,
  CASE WHEN length(p.current_appointment_at)>10 THEN p.current_appointment_at::timestamptz END,CASE WHEN length(p.current_appointment_at)=10 THEN p.current_appointment_at::date END,
  'unknown',p.source_status,'current_slot_only',p.source_updated_at,p.observed_at,p.connector_version,p_run
 FROM prospects p WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND p.sync_run_id=p_run AND (p.current_appointment_at IS NOT NULL OR EXISTS(SELECT FROM appointments a WHERE a.source='notion' AND a.source_namespace=r.source_namespace AND a.external_id=p.external_id||':current-slot'))
 ON CONFLICT(source,source_namespace,external_id) DO UPDATE SET scheduled_at=excluded.scheduled_at,scheduled_day=excluded.scheduled_day,status='unknown',attended_at=NULL,attendance_evidence=NULL,source_status=excluded.source_status,
  schedule_version=CASE WHEN appointments.scheduled_at IS DISTINCT FROM excluded.scheduled_at OR appointments.scheduled_day IS DISTINCT FROM excluded.scheduled_day THEN appointments.schedule_version+1 ELSE appointments.schedule_version END,
  source_updated_at=excluded.source_updated_at,observed_at=excluded.observed_at,connector_version=excluded.connector_version,sync_run_id=p_run;
 INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
 SELECT p.id,'archived','false'::jsonb,'true'::jsonb,'snapshot:'||p_run::text,p_run FROM prospects p
 WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND NOT p.archived AND p.sync_run_id IS DISTINCT FROM p_run ON CONFLICT DO NOTHING;
 UPDATE prospects p SET archived=true WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND p.sync_run_id IS DISTINCT FROM p_run;
 UPDATE sync_runs SET status=CASE WHEN n=0 THEN 'empty' ELSE 'complete' END,finished_at=clock_timestamp(),pagination_complete=true,rows_written=n,covered_from=period_from,covered_to=period_to,lease_until=NULL,lease_token=NULL WHERE id=p_run;
 DELETE FROM notion_import_rows WHERE run_id=p_run;
 RETURN jsonb_build_object('status',CASE WHEN n=0 THEN 'empty' ELSE 'complete' END,'count',n);
END $$;

CREATE FUNCTION public.cockpit_business_rollup(p_namespace text,p_from date,p_to date) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH published AS (SELECT * FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status IN ('complete','empty') AND pagination_complete ORDER BY finished_at DESC LIMIT 1),
 history AS (SELECT *,business b FROM prospects WHERE source='notion' AND source_namespace=p_namespace AND business<>'{}'::jsonb),
 p AS (SELECT * FROM history WHERE NOT archived AND sync_run_id=(SELECT id FROM published)),
 leads AS (SELECT * FROM history WHERE (b->>'acquisitionDay')::date>=p_from AND (b->>'acquisitionDay')::date<p_to),
 appts AS (SELECT * FROM p WHERE (b->>'scheduledDay')::date>=p_from AND (b->>'scheduledDay')::date<p_to)
 SELECT jsonb_build_object('available',EXISTS(SELECT FROM published),'observedAt',(SELECT finished_at FROM published),'sourceRows',(SELECT count(*) FROM p),
 'leads',jsonb_build_object('rows',(SELECT count(*) FROM leads),'known',(SELECT count(DISTINCT person_id) FROM leads),'unresolved',(SELECT count(*) FROM leads WHERE person_id IS NULL),'archivedRows',(SELECT count(*) FROM leads WHERE archived),
 'creationOnly',(SELECT count(*) FROM p WHERE b->>'acquisitionDay' IS NULL AND (b->>'createdAt')::timestamptz AT TIME ZONE 'Europe/Paris'>=p_from::timestamp AND (b->>'createdAt')::timestamptz AT TIME ZONE 'Europe/Paris'<p_to::timestamp)),
 'appointments',jsonb_build_object('total',(SELECT count(*) FROM appts),'attended',(SELECT count(*) FROM appts WHERE b->>'attendance'='show_up'),'explicitFinished',(SELECT count(*) FROM appts WHERE b->>'explicitFinished'='true'),'noShow',(SELECT count(*) FROM appts WHERE b->>'attendance'='no_show'),'cancelled',(SELECT count(*) FROM appts WHERE b->>'attendance'='cancelled'),'unknown',(SELECT count(*) FROM appts WHERE b->>'attendance' IN ('unknown','scheduled')),
 'booked',(SELECT count(*) FROM p WHERE (b->>'bookedDay')::date>=p_from AND (b->>'bookedDay')::date<p_to),'closed',(SELECT count(*) FROM p WHERE source_status='Closé' AND (b->>'closedDay')::date>=p_from AND (b->>'closedDay')::date<p_to)));
$$;

DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('begin_sync_stream','cockpit_claim_notion','cockpit_stage_notion','cockpit_release_notion','cockpit_publish_notion','cockpit_business_rollup') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
INSERT INTO public.cockpit_migrations(version) VALUES(7);
COMMIT;
