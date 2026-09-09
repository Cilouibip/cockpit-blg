-- CLI scaffold normalized to the repository INTEGER registry (9).
-- Business source observations only. Browser events and source systems are untouched.
BEGIN;
CREATE TABLE public.lead_source_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES public.sync_runs(id),
 source text NOT NULL CHECK(source IN ('wix','notion')), source_namespace text NOT NULL,
 family text NOT NULL CHECK(family IN ('forms','quiz','client_history')), external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 256),
 occurred_at timestamptz, occurred_day date, source_updated_at timestamptz NOT NULL,
 source_container_id text NOT NULL, source_contact_id text, source_status text,
 identity_key text CHECK(identity_key IS NULL OR identity_key ~ '^[a-f0-9]{64}$'), person_id uuid REFERENCES public.people(id),
 identity_state text NOT NULL DEFAULT 'unresolved' CHECK(identity_state IN ('linked','unresolved','conflict')),
 eligible boolean NOT NULL, properties jsonb NOT NULL CHECK(jsonb_typeof(properties)='object' AND octet_length(properties::text)<8000),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'), source_payload_hash text NOT NULL CHECK(source_payload_hash ~ '^[a-f0-9]{64}$'), mapping_profile text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 published_at timestamptz, is_current boolean NOT NULL DEFAULT false,
 UNIQUE(run_id,source_namespace,family,external_id),
 CHECK(NOT is_current OR published_at IS NOT NULL),
 CHECK((occurred_at IS NULL)=(occurred_day IS NULL)),
 CHECK(family='client_history' OR occurred_at IS NOT NULL),
 CHECK((source='notion')=(family='client_history'))
);
CREATE UNIQUE INDEX lead_observation_current_key ON public.lead_source_observations(source_namespace,family,external_id) WHERE is_current;
CREATE INDEX lead_observation_person_date ON public.lead_source_observations(person_id,occurred_day) WHERE is_current AND eligible;
CREATE INDEX lead_observation_scope_date ON public.lead_source_observations(source_namespace,family,occurred_day) WHERE is_current;
ALTER TABLE public.lead_source_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_source_observations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.lead_source_observations TO service_role;

CREATE FUNCTION public.cockpit_claim_lead_entries(p_namespace text,p_family text,p_profile text,p_from timestamptz DEFAULT NULL,p_container_ids jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;token uuid=gen_random_uuid();cutoff timestamptz=clock_timestamp();lo timestamptz;src text;previous_profile text;attempt sync_runs;
BEGIN
 IF nullif(p_namespace,'') IS NULL OR nullif(p_profile,'') IS NULL OR p_family IS NULL OR p_family NOT IN ('forms','quiz','client_history') THEN RAISE EXCEPTION 'invalid scope' USING ERRCODE='23514';END IF;
 IF p_container_ids IS NOT NULL AND (jsonb_typeof(p_container_ids)<>'array' OR EXISTS(SELECT FROM jsonb_array_elements(p_container_ids) v WHERE jsonb_typeof(v)<>'string')) THEN RAISE EXCEPTION 'invalid containers' USING ERRCODE='23514';END IF;
 src=CASE WHEN p_family='client_history' THEN 'notion' ELSE 'wix' END;
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-observation:'||p_namespace||':'||p_family,0));
 SELECT * INTO r FROM sync_runs WHERE source=src AND source_namespace=p_namespace AND stream_key='lead_entries_'||p_family AND status='running' ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
 IF r.id IS NOT NULL AND r.lease_until>now() THEN RETURN jsonb_build_object('busy',true,'runId',r.id);END IF;
 IF r.id IS NOT NULL AND r.query_profile_key IS DISTINCT FROM p_profile THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='superseded_profile',lease_token=NULL,lease_until=NULL WHERE id=r.id;r.id=NULL;
 END IF;
 IF r.id IS NULL THEN
  SELECT * INTO attempt FROM sync_runs WHERE source=src AND source_namespace=p_namespace AND stream_key='lead_entries_'||p_family AND query_profile_key=p_profile ORDER BY started_at DESC,id DESC LIMIT 1;
  IF p_from IS NULL AND attempt.error_code='MAPPING_REPLAY_INCOMPLETE' THEN RETURN jsonb_build_object('blocked',true,'busy',false,'runId',attempt.id,'reason','MAPPING_REPLAY_INCOMPLETE');END IF;
  SELECT coalesce(p_from,max(covered_to)-interval '2 days','1970-01-01'::timestamptz) INTO lo FROM sync_runs WHERE source=src AND source_namespace=p_namespace AND stream_key='lead_entries_'||p_family AND query_profile_key=p_profile AND status IN ('complete','empty') AND pagination_complete AND rows_rejected=0;
  -- A changed (or restored) mapping must re-evaluate retained history, not only the latest delta.
  SELECT query_profile_key INTO previous_profile FROM sync_runs WHERE source=src AND source_namespace=p_namespace AND stream_key='lead_entries_'||p_family AND status IN ('complete','empty') AND pagination_complete AND rows_rejected=0 ORDER BY finished_at DESC,id DESC LIMIT 1;
  IF previous_profile IS DISTINCT FROM p_profile THEN lo='1970-01-01'::timestamptz;END IF;
  IF lo>=cutoff OR lo<'1970-01-01'::timestamptz THEN RAISE EXCEPTION 'invalid bounds' USING ERRCODE='23514';END IF;
  INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,period_from,period_to,coverage_kind,checkpoint)
  VALUES(src,p_namespace,'lead_entries_'||p_family,p_profile,cutoff::text,'lead-observation:'||p_namespace||':'||p_family||':'||cutoff::text,p_profile,lo,cutoff,'source_snapshot',jsonb_build_object('version',1,'from',lo,'to',cutoff,'cursor',NULL,'page',0,'done',false,'ignored',0,'containerIds',p_container_ids)) RETURNING * INTO r;
 END IF;
 UPDATE sync_runs SET lease_token=token,lease_until=now()+interval '2 minutes',error_code=NULL WHERE id=r.id;
 RETURN jsonb_build_object('busy',false,'runId',r.id,'lease',token,'checkpoint',r.checkpoint,'rowsRead',r.rows_read);
END $$;

CREATE FUNCTION public.cockpit_stage_lead_entries(p_run uuid,p_lease uuid,p_page integer,p_records jsonb,p_next_cursor text,p_done boolean,p_read integer,p_ignored integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;x jsonb;existing lead_source_observations;person uuid;identity person_identities;candidate uuid;candidate_count integer;state text;page_hash text;family_name text;rec_count integer;
BEGIN
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND stream_key LIKE 'lead_entries_%' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'lease lost' USING ERRCODE='55000';END IF;
 IF jsonb_typeof(p_records) IS DISTINCT FROM 'array' OR p_done IS NULL OR p_page IS NULL OR p_page<0 OR p_page>1000 OR p_read IS NULL OR p_ignored IS NULL OR p_ignored<0 OR p_read<0 OR p_read>100 OR (p_done AND p_next_cursor IS NOT NULL) OR (NOT p_done AND nullif(p_next_cursor,'') IS NULL) OR length(p_next_cursor)>16000 THEN RAISE EXCEPTION 'invalid page' USING ERRCODE='23514';END IF;
 rec_count=jsonb_array_length(p_records);
 IF rec_count+p_ignored<>p_read THEN RAISE EXCEPTION 'unbalanced page' USING ERRCODE='23514';END IF;
 page_hash=md5(jsonb_build_object('rows',p_records,'next',p_next_cursor,'done',p_done,'read',p_read,'ignored',p_ignored)::text);
 IF p_page=(r.checkpoint->>'page')::integer-1 AND r.checkpoint->>'lastPageHash'=page_hash THEN RETURN jsonb_build_object('alreadyStaged',true,'read',r.rows_read);END IF;
 IF p_page IS DISTINCT FROM (r.checkpoint->>'page')::integer OR (r.checkpoint->>'done')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'stale page' USING ERRCODE='55000';END IF;
 IF (SELECT count(DISTINCT value->>'externalId') FROM jsonb_array_elements(p_records))<>rec_count THEN RAISE EXCEPTION 'duplicate source rows' USING ERRCODE='23514';END IF;
 family_name=replace(r.stream_key,'lead_entries_','');
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-identity-resolution',0));
 FOR x IN SELECT value FROM jsonb_array_elements(p_records) LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR x->>'sourceNamespace' IS DISTINCT FROM r.source_namespace OR x->>'family' IS DISTINCT FROM family_name OR x->>'source' IS DISTINCT FROM r.source OR nullif(x->>'externalId','') IS NULL OR nullif(x->>'containerId','') IS NULL OR nullif(x->>'sourceUpdatedAt','') IS NULL OR jsonb_typeof(x->'eligible') IS DISTINCT FROM 'boolean' OR jsonb_typeof(x->'properties') IS DISTINCT FROM 'object' OR x->>'payloadHash' IS NULL OR x->>'sourcePayloadHash' IS NULL THEN RAISE EXCEPTION 'invalid source observation' USING ERRCODE='23514';END IF;
  SELECT * INTO existing FROM lead_source_observations WHERE run_id=p_run AND source_namespace=r.source_namespace AND family=family_name AND external_id=x->>'externalId';
  IF existing.id IS NOT NULL THEN RAISE EXCEPTION 'duplicate source key across pages' USING ERRCODE='40001';END IF;
  person=NULL;state='unresolved';identity=NULL;candidate=NULL;candidate_count=0;
  IF x->>'identityKey' IS NOT NULL THEN
   IF x->>'identityKey' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid identity' USING ERRCODE='23514';END IF;
   SELECT * INTO identity FROM person_identities WHERE source='identity' AND source_namespace='blg-email-v1' AND identity_kind='email_hmac' AND identity_key=x->>'identityKey' AND valid_to IS NULL;
   -- Only a reciprocal explicit Client <-> Prospect relation can bridge different source emails.
   IF family_name='client_history' AND jsonb_typeof(x->'properties'->'prospectIds')='array' THEN
    SELECT count(DISTINCT p.person_id),(array_agg(DISTINCT p.person_id))[1] INTO candidate_count,candidate FROM prospects p
    WHERE p.source='notion' AND p.source_namespace=x->'properties'->>'prospectNamespace' AND p.external_id IN (SELECT jsonb_array_elements_text(x->'properties'->'prospectIds')) AND p.person_id IS NOT NULL AND p.business->'clientIds' @> jsonb_build_array(x->>'externalId');
   END IF;
   IF candidate_count>1 OR (candidate_count=1 AND identity.person_id IS NOT NULL AND candidate IS DISTINCT FROM identity.person_id) THEN state='conflict';
   ELSE
    IF identity.id IS NULL THEN
     person=candidate;
     IF person IS NULL THEN INSERT INTO people DEFAULT VALUES RETURNING id INTO person;END IF;
     INSERT INTO person_identities(person_id,source,source_namespace,identity_kind,identity_key,state,evidence) VALUES(person,'identity','blg-email-v1','email_hmac',x->>'identityKey','linked',CASE WHEN candidate IS NOT NULL THEN 'Exact client email and reciprocal source Client/Prospect relation' ELSE 'Normalized source email HMAC; observed business entry' END) RETURNING * INTO identity;
    END IF;
    IF identity.state='linked' THEN person=identity.person_id;state='linked';ELSE person=NULL;state='conflict';END IF;
   END IF;
  END IF;
  INSERT INTO lead_source_observations(run_id,source,source_namespace,family,external_id,occurred_at,occurred_day,source_updated_at,source_container_id,source_contact_id,source_status,identity_key,person_id,identity_state,eligible,properties,payload_hash,source_payload_hash,mapping_profile)
  VALUES(p_run,r.source,r.source_namespace,family_name,x->>'externalId',(x->>'occurredAt')::timestamptz,((x->>'occurredAt')::timestamptz AT TIME ZONE 'Europe/Paris')::date,(x->>'sourceUpdatedAt')::timestamptz,x->>'containerId',x->>'contactId',x->>'sourceStatus',x->>'identityKey',person,state,(x->>'eligible')::boolean,x->'properties',x->>'payloadHash',x->>'sourcePayloadHash',r.query_profile_key) ON CONFLICT(run_id,source_namespace,family,external_id) DO NOTHING;
 END LOOP;
 UPDATE sync_runs SET rows_read=rows_read+p_read,rows_written=(SELECT count(*) FROM lead_source_observations WHERE run_id=p_run),checkpoint=checkpoint||jsonb_build_object('cursor',p_next_cursor,'page',p_page+1,'done',p_done,'lastPageHash',page_hash,'ignored',coalesce((checkpoint->>'ignored')::integer,0)+p_ignored),lease_until=now()+interval '2 minutes' WHERE id=p_run;
 RETURN jsonb_build_object('alreadyStaged',false,'read',r.rows_read+p_read);
END $$;

CREATE FUNCTION public.cockpit_release_lead_entries(p_run uuid,p_lease uuid,p_error text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE sync_runs SET lease_until=now(),lease_token=NULL,error_code=p_error WHERE id=p_run AND stream_key LIKE 'lead_entries_%' AND status='running' AND lease_token=p_lease;
 RETURN FOUND;
END $$;

CREATE FUNCTION public.cockpit_publish_lead_entries(p_run uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;ns text;stream text;changed integer;unchanged integer;stale integer;conflicts integer;identity_changed integer;mapping_changed integer;missing_mapping integer;staged integer;stamp timestamptz=clock_timestamp();counts jsonb;
BEGIN
 SELECT source_namespace,stream_key INTO ns,stream FROM sync_runs WHERE id=p_run;
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-observation:'||ns||':'||replace(stream,'lead_entries_',''),0));
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND stream_key LIKE 'lead_entries_%' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(r.checkpoint) IS DISTINCT FROM 'object' OR r.checkpoint->>'version' IS DISTINCT FROM '1' OR r.checkpoint->>'done' IS DISTINCT FROM 'true' OR r.checkpoint->>'cursor' IS NOT NULL OR (r.checkpoint->>'page')::integer IS NULL OR (r.checkpoint->>'page')::integer<1 OR r.rows_rejected<>0 THEN RAISE EXCEPTION 'incomplete observation run' USING ERRCODE='55000';END IF;
 SELECT count(*) INTO staged FROM lead_source_observations WHERE run_id=p_run;
 -- A mapping transition cannot silently hide a historical request missing from the source replay.
 SELECT count(*) INTO missing_mapping FROM lead_source_observations c WHERE c.is_current AND c.source_namespace=r.source_namespace AND c.family=replace(r.stream_key,'lead_entries_','') AND c.mapping_profile<>r.query_profile_key
 AND (r.checkpoint->'containerIds' IS NULL OR r.checkpoint->'containerIds'='null'::jsonb OR r.checkpoint->'containerIds' @> jsonb_build_array(c.source_container_id))
 AND NOT EXISTS(SELECT FROM lead_source_observations s WHERE s.run_id=p_run AND s.external_id=c.external_id AND s.source_updated_at>=c.source_updated_at);
 IF missing_mapping>0 THEN
  UPDATE sync_runs SET status='failed',finished_at=stamp,error_code='MAPPING_REPLAY_INCOMPLETE',lease_until=NULL,lease_token=NULL,checkpoint=checkpoint||jsonb_build_object('unmappedHistory',missing_mapping) WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','reason','MAPPING_REPLAY_INCOMPLETE','counts',jsonb_build_object('read',r.rows_read,'observations',staged,'changed',0,'rejected',0,'unmappedHistory',missing_mapping));
 END IF;
 SELECT count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at=s.source_updated_at AND (c.source_payload_hash<>s.source_payload_hash OR EXISTS(SELECT FROM jsonb_each(coalesce(c.properties->'sourceFields','{}'::jsonb)) f WHERE s.properties->'sourceFields' ? f.key AND s.properties->'sourceFields'->f.key IS DISTINCT FROM f.value) OR (c.mapping_profile=s.mapping_profile AND c.payload_hash<>s.payload_hash))),
 count(*) FILTER(WHERE c.id IS NOT NULL AND c.payload_hash=s.payload_hash AND c.person_id IS NOT DISTINCT FROM s.person_id AND c.identity_state=s.identity_state),
 count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at>s.source_updated_at AND (c.payload_hash<>s.payload_hash OR c.person_id IS DISTINCT FROM s.person_id OR c.identity_state<>s.identity_state)),
 count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at<=s.source_updated_at AND (c.person_id IS DISTINCT FROM s.person_id OR c.identity_state<>s.identity_state)),
 count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at<=s.source_updated_at AND c.mapping_profile<>s.mapping_profile)
 INTO conflicts,unchanged,stale,identity_changed,mapping_changed FROM lead_source_observations s LEFT JOIN lead_source_observations c ON c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id WHERE s.run_id=p_run;
 IF conflicts>0 THEN
  UPDATE sync_runs SET status='failed',finished_at=stamp,error_code='SOURCE_VERSION_CONFLICT',rows_rejected=conflicts,lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','reason','SOURCE_VERSION_CONFLICT','counts',jsonb_build_object('read',r.rows_read,'rejected',conflicts,'changed',0,'unchanged',unchanged,'stale',stale));
 END IF;
 changed=staged-unchanged-stale;
 -- Keep the previous rows current until this transaction commits. Unchanged/older observations remain audit versions only.
 UPDATE lead_source_observations c SET is_current=false FROM lead_source_observations s WHERE s.run_id=p_run AND c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id AND (s.source_updated_at>c.source_updated_at OR (s.source_updated_at=c.source_updated_at AND s.source_payload_hash=c.source_payload_hash AND (s.mapping_profile<>c.mapping_profile OR s.person_id IS DISTINCT FROM c.person_id OR s.identity_state<>c.identity_state)));
 UPDATE lead_source_observations s SET published_at=stamp,is_current=NOT EXISTS(SELECT FROM lead_source_observations c WHERE c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id) WHERE s.run_id=p_run;
 counts=jsonb_build_object('read',r.rows_read,'observations',staged,'changed',changed,'unchanged',unchanged,'stale',stale,'identityChanged',identity_changed,'mappingChanged',mapping_changed,'rejected',0,'ignored',coalesce((r.checkpoint->>'ignored')::integer,0));
 UPDATE sync_runs SET status=CASE WHEN staged=0 THEN 'empty' ELSE 'complete' END,finished_at=stamp,pagination_complete=true,covered_from=period_from,covered_to=period_to,checkpoint=checkpoint||jsonb_build_object('counts',counts),lease_until=NULL,lease_token=NULL WHERE id=p_run;
 RETURN jsonb_build_object('status',CASE WHEN staged=0 THEN 'empty' ELSE 'complete' END,'counts',counts);
END $$;

CREATE FUNCTION public.cockpit_lead_entry_rollup(p_wix_namespace text,p_notion_namespace text,p_client_namespace text,p_from date,p_to date,p_scope jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF jsonb_typeof(p_scope) IS DISTINCT FROM 'object' OR p_from IS NULL OR p_to IS NULL OR p_from>=p_to OR p_to-p_from>367 THEN RAISE EXCEPTION 'invalid period' USING ERRCODE='22023';END IF;
 WITH published AS (
  SELECT * FROM sync_runs WHERE status IN ('complete','empty') AND pagination_complete AND rows_rejected=0 AND stream_key LIKE 'lead_entries_%'
 ), selected_profiles AS (
  SELECT scope.key family,scope.value->>'profile' requested_profile,chosen.query_profile_key profile FROM jsonb_each(p_scope) scope
  CROSS JOIN LATERAL (SELECT r.query_profile_key FROM published r WHERE r.stream_key='lead_entries_'||scope.key AND r.source_namespace=CASE WHEN scope.key='client_history' THEN p_client_namespace ELSE p_wix_namespace END
   ORDER BY r.finished_at DESC,r.id DESC LIMIT 1) chosen
 ), valid_runs AS (
  SELECT r.* FROM published r JOIN selected_profiles s ON r.stream_key='lead_entries_'||s.family AND r.query_profile_key=s.profile
 ), observations AS (
  SELECT o.* FROM lead_source_observations o JOIN valid_runs r ON r.id=o.run_id WHERE o.is_current AND o.published_at IS NOT NULL AND o.mapping_profile=r.query_profile_key AND p_scope->o.family->'containerIds' @> jsonb_build_array(o.source_container_id)
  AND ((o.source='wix' AND o.source_namespace=p_wix_namespace AND o.family IN ('forms','quiz')) OR (o.source='notion' AND o.source_namespace=p_client_namespace AND o.family='client_history'))
 ), notion_rows AS (
  SELECT person_id,external_id,business FROM prospects WHERE source='notion' AND source_namespace=p_notion_namespace AND business<>'{}'
 ), notion AS (
  SELECT n.person_id,n.external_id,min(d.event_day) event_day FROM notion_rows n
  CROSS JOIN LATERAL (SELECT CASE WHEN length(v)=10 AND pg_input_is_valid(v,'date') THEN v::date WHEN length(v)>10 AND pg_input_is_valid(v,'timestamptz') THEN (v::timestamptz AT TIME ZONE 'Europe/Paris')::date END event_day
   FROM (VALUES(n.business->'dates'->>'real'),(n.business->'dates'->>'legacy'),(n.business->'dates'->>'wix'),(n.business->>'acquisitionDay')) raw(v)) d
  WHERE d.event_day IS NOT NULL GROUP BY n.person_id,n.external_id
 ), requests AS (SELECT * FROM observations WHERE family IN ('forms','quiz') AND eligible),
 candidates AS (
  SELECT person_id,event_day FROM notion WHERE person_id IS NOT NULL
  UNION ALL SELECT person_id,occurred_day FROM requests WHERE person_id IS NOT NULL
 ), earliest AS (SELECT person_id,min(event_day) event_day,bool_or(event_day>=p_from AND event_day<p_to) in_period FROM candidates GROUP BY person_id),
 client_before AS (SELECT person_id,min(occurred_day) event_day FROM observations WHERE family='client_history' AND eligible AND person_id IS NOT NULL GROUP BY person_id),
 first_known AS (SELECT e.*,c.event_day client_day FROM earliest e LEFT JOIN client_before c USING(person_id)),
 active AS (SELECT person_id FROM earliest WHERE in_period),
 period_requests AS (SELECT * FROM requests WHERE occurred_day>=p_from AND occurred_day<p_to),
 latest_per_family AS (
  SELECT DISTINCT ON (source_namespace,stream_key) * FROM valid_runs WHERE (source_namespace=p_wix_namespace AND stream_key IN ('lead_entries_forms','lead_entries_quiz')) OR (source_namespace=p_client_namespace AND stream_key='lead_entries_client_history') ORDER BY source_namespace,stream_key,source_as_of DESC,started_at DESC,id DESC
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
  'families',(SELECT coalesce(jsonb_agg(jsonb_build_object('family',replace(stream_key,'lead_entries_',''),'status',status,'from',covered_from,'to',covered_to,'observedAt',source_as_of,'counts',checkpoint->'counts')),'[]') FROM latest_per_family),
  'latestAttempts',(SELECT coalesce(jsonb_agg(jsonb_build_object('family',replace(a.stream_key,'lead_entries_',''),'status',a.status,'startedAt',a.started_at,'finishedAt',a.finished_at,'errorCode',a.error_code)),'[]') FROM (
   SELECT DISTINCT ON(stream_key) * FROM sync_runs WHERE query_profile_key=p_scope->replace(stream_key,'lead_entries_','')->>'profile'
   AND ((source_namespace=p_wix_namespace AND stream_key IN ('lead_entries_forms','lead_entries_quiz')) OR (source_namespace=p_client_namespace AND stream_key='lead_entries_client_history')) ORDER BY stream_key,started_at DESC,id DESC
  ) a),
  'sourceBasis','Wix + Notion',
  'definitionState','pending_business_choice',
  'mappingPending',coalesce((SELECT jsonb_agg(jsonb_build_object('family',family,'requestedProfile',requested_profile,'publishedProfile',profile)) FROM selected_profiles WHERE requested_profile<>profile),'[]'::jsonb),
  'reason','Premières arrivées connues et personnes ayant une demande sont séparées. Les inscriptions Wix conservées ne couvrent pas tout l’historique. Une antériorité client sans date d’acquisition reste distincte.'
 ) INTO result;
 RETURN result;
END $$;

DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('cockpit_claim_lead_entries','cockpit_stage_lead_entries','cockpit_release_lead_entries','cockpit_publish_lead_entries','cockpit_lead_entry_rollup') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
INSERT INTO public.cockpit_migrations(version) VALUES(9);
COMMIT;
