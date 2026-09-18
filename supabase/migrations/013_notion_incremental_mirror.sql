-- CLI scaffold normalized to the existing INTEGER migration registry (13).
-- No source mutation. Private invoker RPCs; no client-role grants.
BEGIN;
CREATE FUNCTION public.cockpit_claim_notion(p_namespace text,p_profile text,p_schema jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;previous sync_runs;token uuid=gen_random_uuid();cutoff timestamptz=date_trunc('minute',clock_timestamp());boundary timestamptz;lower_bound timestamptz;inventory_at timestamptz;full_at timestamptz;force_full boolean;inventory_intervals jsonb;mode text;proof text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||p_namespace,0));
 IF p_schema IS NOT NULL AND ((p_schema->>'digest' IS NULL OR p_schema->>'digest' !~ '^[a-f0-9]{64}$') OR jsonb_typeof(p_schema->'deltaSafe') IS DISTINCT FROM 'boolean') THEN RAISE EXCEPTION 'invalid schema proof' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status='running' ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
 IF r.id IS NOT NULL AND r.lease_until>now() THEN RETURN jsonb_build_object('busy',true,'runId',r.id);END IF;
 IF r.id IS NOT NULL AND (r.query_profile_key IS DISTINCT FROM p_profile OR (r.checkpoint ? 'schemaDigest' AND r.checkpoint->>'schemaDigest' IS DISTINCT FROM p_schema->>'digest')) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='superseded_schema',lease_token=NULL,lease_until=NULL WHERE id=r.id;
  r.id=NULL;
 END IF;
 IF r.id IS NULL THEN
  SELECT * INTO previous FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND query_profile_key=p_profile AND status IN ('complete','empty') AND pagination_complete ORDER BY finished_at DESC LIMIT 1;
  inventory_at=nullif(previous.checkpoint->>'inventoryThrough','')::timestamptz;
  full_at=nullif(previous.checkpoint->>'fullThrough','')::timestamptz;
  SELECT EXISTS(SELECT FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status='failed' AND error_code='DELTA_INVENTORY_GAP' AND started_at>=coalesce(previous.started_at,'1970-01-01'::timestamptz)) INTO force_full;
  -- Hourly edit pass; periodic complete inventory detects omissions and refreshes
  -- dependent properties. Only the inventory may infer disappearance.
  mode=CASE WHEN previous.id IS NULL OR p_schema IS NULL OR p_schema->>'deltaSafe' IS DISTINCT FROM 'true' OR previous.checkpoint->>'schemaDigest' IS DISTINCT FROM p_schema->>'digest' OR force_full OR full_at IS NULL OR cutoff-full_at>=interval '24 hours' THEN 'full' ELSE 'delta' END;
  lower_bound=CASE WHEN mode='full' THEN '1970-01-01'::timestamptz ELSE greatest('1970-01-01'::timestamptz,coalesce(nullif(previous.checkpoint->>'completedThrough','')::timestamptz,previous.period_to)-interval '2 minutes') END;
  boundary=date_trunc('year',cutoff);
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind','inventory','from',part->>'from','to',part->>'to','read',0)),'[]'::jsonb) INTO inventory_intervals FROM jsonb_array_elements(coalesce(previous.checkpoint->'partitions','[]'::jsonb)) part;
  IF jsonb_array_length(inventory_intervals)=0 THEN inventory_intervals=jsonb_build_array(jsonb_build_object('kind','inventory','from','1970-01-01T00:00:00Z','to',boundary,'read',0),jsonb_build_object('kind','inventory','from',boundary,'to',cutoff,'read',0));
  ELSIF previous.period_to<cutoff THEN inventory_intervals=inventory_intervals||jsonb_build_array(jsonb_build_object('kind','inventory','from',previous.period_to,'to',cutoff,'read',0));END IF;
  INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,period_from,period_to,coverage_kind,checkpoint)
  VALUES('notion',p_namespace,'prospects_business',p_profile,mode||':'||cutoff::text,'notion-'||mode||':'||p_namespace||':'||clock_timestamp()::text,p_profile,lower_bound,cutoff,'source_snapshot',
   jsonb_build_object('version',CASE WHEN p_schema IS NULL THEN 1 ELSE 2 END,'mode',mode,'schemaDigest',p_schema->>'digest','inventoryThrough',inventory_at,'fullThrough',full_at,'partitions','[]'::jsonb,'page',0,'intervals',CASE WHEN mode='full' THEN jsonb_build_array(jsonb_build_object('from',lower_bound,'to',boundary,'read',0),jsonb_build_object('from',boundary,'to',cutoff,'read',0)) ELSE jsonb_build_array(jsonb_build_object('kind','delta','from',lower_bound,'to',cutoff,'read',0))||inventory_intervals END)) RETURNING * INTO r;
 END IF;
 UPDATE sync_runs SET lease_token=token,lease_until=now()+interval '2 minutes',error_code=NULL WHERE id=r.id;
 RETURN jsonb_build_object('busy',false,'runId',r.id,'lease',token,'checkpoint',r.checkpoint,'from',r.period_from,'to',r.period_to,'rowsRead',r.rows_read);
END $$;
-- Existing workers remain a full-inventory fallback until the new worker is deployed.
CREATE OR REPLACE FUNCTION public.cockpit_claim_notion(p_namespace text,p_profile text) RETURNS jsonb LANGUAGE sql SET search_path=public,pg_temp AS $$
 SELECT public.cockpit_claim_notion(p_namespace,p_profile,NULL::jsonb);
$$;
CREATE OR REPLACE FUNCTION public.cockpit_stage_notion(p_run uuid,p_lease uuid,p_records jsonb,p_checkpoint jsonb,p_read integer) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;row jsonb;identity text;person uuid;receipt text;page_no integer;
BEGIN
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND source='notion' AND stream_key='prospects_business' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'lease lost' USING ERRCODE='55000';END IF;
 IF jsonb_typeof(p_records) IS DISTINCT FROM 'array' OR jsonb_typeof(p_checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(p_checkpoint->'intervals') IS DISTINCT FROM 'array' OR p_read IS NULL OR p_read<0 THEN RAISE EXCEPTION 'invalid page shape' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(p_records)>100 OR p_read<jsonb_array_length(p_records) THEN RAISE EXCEPTION 'invalid page' USING ERRCODE='23514';END IF;
 -- Page sequence and receipt make a lost RPC response replayable without double counts.
 IF r.checkpoint->>'version'='2' THEN
  page_no=(p_checkpoint->>'page')::integer;
  receipt=md5(jsonb_build_object('records',p_records,'intervals',p_checkpoint->'intervals','partitions',p_checkpoint->'partitions','read',p_read,'page',page_no)::text);
  IF page_no=(r.checkpoint->>'page')::integer AND receipt=r.checkpoint->>'receipt' THEN RETURN true;END IF;
  IF page_no IS NULL OR page_no<>(r.checkpoint->>'page')::integer+1 THEN RAISE EXCEPTION 'page replay conflict' USING ERRCODE='55000';END IF;
 END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_checkpoint->'intervals') LOOP
  IF jsonb_typeof(row) IS DISTINCT FROM 'object' OR row->>'from' IS NULL OR row->>'to' IS NULL OR jsonb_typeof(row->'read') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid interval' USING ERRCODE='23514';END IF;
  IF (row->>'from')::timestamptz >= (row->>'to')::timestamptz OR (row->>'read')::integer<0 THEN RAISE EXCEPTION 'invalid interval bounds' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR row IN SELECT value FROM jsonb_array_elements(p_records) LOOP
  IF row->>'kind'='inventory' THEN
   IF r.checkpoint->'intervals'->0->>'kind' IS DISTINCT FROM 'inventory' OR row->>'accountId' IS DISTINCT FROM r.source_namespace OR row->>'source' IS DISTINCT FROM 'notion' OR nullif(row->>'externalId','') IS NULL OR jsonb_typeof(row->'clientIds') IS DISTINCT FROM 'array' OR row->>'sourceUpdatedAt' IS NULL THEN RAISE EXCEPTION 'invalid inventory row' USING ERRCODE='23514';END IF;
   INSERT INTO notion_import_rows(run_id,external_id,payload) VALUES(p_run,row->>'externalId',jsonb_build_object('inventory',row)) ON CONFLICT(run_id,external_id) DO UPDATE SET payload=notion_import_rows.payload||excluded.payload;
   CONTINUE;
  END IF;
  IF jsonb_typeof(row) IS DISTINCT FROM 'object' OR row->>'accountId' IS DISTINCT FROM r.source_namespace OR row->>'source' IS DISTINCT FROM 'notion' OR nullif(row->>'externalId','') IS NULL OR jsonb_typeof(row->'business') IS DISTINCT FROM 'object' OR jsonb_typeof(row->'archived') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'source mismatch' USING ERRCODE='23514';END IF;
  INSERT INTO notion_import_rows(run_id,external_id,payload) VALUES(p_run,row->>'externalId',row) ON CONFLICT(run_id,external_id) DO UPDATE SET payload=excluded.payload
   WHERE (notion_import_rows.payload->>'sourceUpdatedAt')::timestamptz <= (excluded.payload->>'sourceUpdatedAt')::timestamptz;
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
 UPDATE sync_runs SET checkpoint=(r.checkpoint || jsonb_build_object('intervals',p_checkpoint->'intervals') || CASE WHEN p_checkpoint ? 'partitions' THEN jsonb_build_object('partitions',p_checkpoint->'partitions') ELSE '{}'::jsonb END || CASE WHEN r.checkpoint->'intervals'->0->>'kind'='inventory' AND jsonb_array_length(p_checkpoint->'intervals')=0 THEN jsonb_build_object('inventoryComplete',true) ELSE '{}'::jsonb END || CASE WHEN p_checkpoint ? 'page' THEN jsonb_build_object('page',p_checkpoint->'page') ELSE '{}'::jsonb END || CASE WHEN receipt IS NOT NULL THEN jsonb_build_object('receipt',receipt) ELSE '{}'::jsonb END),rows_read=rows_read+p_read,rows_written=(SELECT count(*) FROM notion_import_rows WHERE run_id=p_run),lease_until=now()+interval '2 minutes' WHERE id=p_run;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_publish_notion(p_run uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;key_namespace text;n integer;ns text;is_full boolean;changed integer;
BEGIN
 SELECT source_namespace INTO ns FROM sync_runs WHERE id=p_run;
 PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||ns,0));
 SELECT * INTO r FROM sync_runs WHERE id=p_run;
 IF r.source='notion' AND r.stream_key='prospects_business' AND r.status IN ('complete','empty') AND r.pagination_complete THEN RETURN jsonb_build_object('status',r.status,'count',r.rows_written,'duplicate',true);END IF;
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND source='notion' AND stream_key='prospects_business' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(r.checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(r.checkpoint->'intervals') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'snapshot incomplete' USING ERRCODE='55000';END IF;
 IF jsonb_array_length(r.checkpoint->'intervals') IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'snapshot incomplete' USING ERRCODE='55000';END IF;
 is_full=coalesce(r.checkpoint->>'mode','full')='full';
 IF NOT is_full AND r.checkpoint->>'inventoryComplete' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'inventory incomplete' USING ERRCODE='55000';END IF;
 IF NOT is_full AND EXISTS(SELECT FROM notion_import_rows s LEFT JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND NOT s.payload ? 'business' AND (p.id IS NULL OR p.archived OR (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz>p.source_updated_at AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<r.period_to)) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='DELTA_INVENTORY_GAP',lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','count',0,'reason','DELTA_INVENTORY_GAP');
 END IF;
 IF NOT is_full AND EXISTS(SELECT FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND s.payload ? 'inventory' AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<=coalesce((s.payload->>'sourceUpdatedAt')::timestamptz,p.source_updated_at) AND coalesce(s.payload->'business'->'attendanceGroup',p.business->'attendanceGroup') IS DISTINCT FROM (s.payload->'inventory'->'attendanceGroup')) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='DELTA_INVENTORY_GAP',lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','count',0,'reason','DELTA_INVENTORY_GAP');
 END IF;
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
  FROM notion_import_rows s WHERE s.run_id=p_run AND s.payload ? 'business' ON CONFLICT(source,source_namespace,external_id) DO NOTHING RETURNING *
 ) INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
 SELECT id,'snapshot_initial',NULL,jsonb_build_object('source_status',source_status,'owner_label',owner_label,'current_appointment_at',current_appointment_at,'next_follow_up_at',next_follow_up_at,'archived',archived),source_updated_at::text,p_run FROM inserted ON CONFLICT DO NOTHING;
 -- Capture changed fields before replacing the mirror. Equal versions are idempotent; omission/reappearance has its own observation key.
 INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
 SELECT p.id,f.key,to_jsonb(p)->f.key,updated.data->f.key,CASE WHEN f.key='archived' THEN 'snapshot:'||p_run::text ELSE s.payload->>'sourceUpdatedAt' END,p_run
 FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id
 CROSS JOIN LATERAL (SELECT jsonb_build_object('source_status',s.payload->'status','owner_label',s.payload->'responsible'->>0,'current_appointment_at',s.payload->'appointmentAt','next_follow_up_at',s.payload->'nextFollowUpAt','archived',s.payload->'archived') data) updated
 CROSS JOIN unnest(ARRAY['source_status','owner_label','current_appointment_at','next_follow_up_at','archived']) AS f(key)
 WHERE s.run_id=p_run AND s.payload ? 'business' AND to_jsonb(p)->f.key IS DISTINCT FROM updated.data->f.key ON CONFLICT DO NOTHING;
 UPDATE prospects p SET display_name=left(s.payload->>'name',249),source_status=s.payload->>'status',owner_label=s.payload->'responsible'->>0,responsible_ids=coalesce(s.payload->'responsible','[]'),closer_ids=coalesce(s.payload->'closer','[]'),current_appointment_at=s.payload->>'appointmentAt',next_follow_up_at=s.payload->>'nextFollowUpAt',
  source_updated_at=(s.payload->>'sourceUpdatedAt')::timestamptz,archived=(s.payload->>'archived')::boolean,business=s.payload->'business',person_identity_id=i.id,person_id=CASE WHEN i.state='linked' THEN i.person_id END,
  mapping_version=s.payload->>'mappingVersion',connector_version=s.payload->>'connectorVersion',observed_at=(s.payload->>'observedAt')::timestamptz,sync_run_id=p_run
 FROM notion_import_rows s LEFT JOIN person_identities i ON i.source='identity' AND i.source_namespace=key_namespace AND i.identity_kind='email_hmac' AND i.identity_key=s.payload->'business'->>'identityKey' AND i.valid_to IS NULL
 WHERE s.run_id=p_run AND s.payload ? 'business' AND p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id
 AND (p.display_name,p.source_status,p.owner_label,p.responsible_ids,p.closer_ids,p.current_appointment_at,p.next_follow_up_at,p.source_updated_at,p.archived,p.business,p.person_identity_id,p.person_id,p.mapping_version,p.connector_version)
 IS DISTINCT FROM (left(s.payload->>'name',249),s.payload->>'status',s.payload->'responsible'->>0,coalesce(s.payload->'responsible','[]'::jsonb),coalesce(s.payload->'closer','[]'::jsonb),s.payload->>'appointmentAt',s.payload->>'nextFollowUpAt',(s.payload->>'sourceUpdatedAt')::timestamptz,(s.payload->>'archived')::boolean,s.payload->'business',i.id,CASE WHEN i.state='linked' THEN i.person_id END,s.payload->>'mappingVersion',s.payload->>'connectorVersion');
 GET DIAGNOSTICS changed = ROW_COUNT;
 -- Light hourly inventory also revalidates relation membership. The reviewed
 -- attendance formula depends on Etat; unexpected drift forces a full reload.
 UPDATE prospects p SET business=jsonb_set(p.business,'{clientIds}',s.payload->'inventory'->'clientIds'),observed_at=(s.payload->'inventory'->>'observedAt')::timestamptz,sync_run_id=p_run
 FROM notion_import_rows s WHERE s.run_id=p_run AND s.payload ? 'inventory' AND NOT s.payload ? 'business' AND p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id AND p.business->'clientIds' IS DISTINCT FROM s.payload->'inventory'->'clientIds' AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<=p.source_updated_at;
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
 WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND NOT p.archived AND NOT EXISTS(SELECT FROM notion_import_rows s WHERE s.run_id=p_run AND s.external_id=p.external_id AND (is_full OR s.payload ? 'inventory')) ON CONFLICT DO NOTHING;
 UPDATE prospects p SET archived=true WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND NOT p.archived AND NOT EXISTS(SELECT FROM notion_import_rows s WHERE s.run_id=p_run AND s.external_id=p.external_id AND (is_full OR s.payload ? 'inventory'));
 SELECT count(*) INTO n FROM prospects WHERE source='notion' AND source_namespace=r.source_namespace AND NOT archived;
 UPDATE sync_runs SET checkpoint=checkpoint||jsonb_build_object('completedThrough',period_to,'inventoryThrough',period_to,'fullThrough',CASE WHEN is_full THEN period_to ELSE nullif(checkpoint->>'fullThrough','')::timestamptz END,'changed',changed),source_as_of=period_to,status=CASE WHEN n=0 THEN 'empty' ELSE 'complete' END,finished_at=clock_timestamp(),pagination_complete=true,rows_written=n,covered_from=period_from,covered_to=period_to,lease_until=NULL,lease_token=NULL WHERE id=p_run;
 DELETE FROM notion_import_rows WHERE run_id=p_run;
 RETURN jsonb_build_object('status',CASE WHEN n=0 THEN 'empty' ELSE 'complete' END,'count',n,'changed',changed,'mode',coalesce(r.checkpoint->>'mode','full'),'inventoryThrough',r.period_to);
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_business_rollup(p_namespace text,p_from date,p_to date) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH published AS (SELECT * FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status IN ('complete','empty') AND pagination_complete ORDER BY finished_at DESC LIMIT 1),
 history AS (SELECT *,business b FROM prospects WHERE source='notion' AND source_namespace=p_namespace AND business<>'{}'::jsonb),
 p AS (SELECT * FROM history WHERE NOT archived AND EXISTS(SELECT FROM published) AND EXISTS(SELECT FROM sync_runs r WHERE r.id=history.sync_run_id AND r.status IN ('complete','empty') AND r.pagination_complete AND r.query_profile_key=(SELECT query_profile_key FROM published))),
 leads AS (SELECT * FROM history WHERE (b->>'acquisitionDay')::date>=p_from AND (b->>'acquisitionDay')::date<p_to),
 appts AS (SELECT * FROM p WHERE (b->>'scheduledDay')::date>=p_from AND (b->>'scheduledDay')::date<p_to)
 SELECT jsonb_build_object('available',EXISTS(SELECT FROM published),'observedAt',(SELECT source_as_of FROM published),'publishedAt',(SELECT finished_at FROM published),'inventoryThrough',(SELECT checkpoint->>'inventoryThrough' FROM published),'sourceRows',(SELECT count(*) FROM p),
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
INSERT INTO public.cockpit_migrations(version) VALUES(13);
COMMIT;
