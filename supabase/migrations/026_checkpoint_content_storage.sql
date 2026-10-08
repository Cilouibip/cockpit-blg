-- Local prepared migration only. Checkpoint fragments share exact immutable UTF8
-- content; every aggregate UUID, run, ordered occurrence and envelope remains.
-- No history deletion, retention rule, writer activation or physical compaction.
-- Before real conversion: install the compatible reader, verify backup coverage
-- and logical manifests, pause commerce scheduling, then use the owner-only
-- database fence. Measure headroom; this migration performs no conversion.
BEGIN;

CREATE TABLE IF NOT EXISTS public.commerce_checkpoint_part_contents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_namespace text NOT NULL,
 report_profile_key text NOT NULL,
 encoding_version text NOT NULL DEFAULT 'checkpoint-json-text-v1' CHECK(encoding_version='checkpoint-json-text-v1'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 part text NOT NULL,
 CONSTRAINT checkpoint_part_exact_hash CHECK(content_hash=encode(pg_catalog.sha256(convert_to(part,'UTF8')),'hex')),
 CHECK(octet_length('{"part":'||to_json(part)::text||'}')<=2800)
);
CREATE INDEX IF NOT EXISTS checkpoint_part_hash_candidates ON public.commerce_checkpoint_part_contents
 (source_namespace,report_profile_key,encoding_version,content_hash);
ALTER TABLE public.commerce_checkpoint_part_contents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_checkpoint_part_contents FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.commerce_checkpoint_part_contents TO service_role;

ALTER TABLE public.source_aggregates ADD COLUMN IF NOT EXISTS checkpoint_part_id uuid
 REFERENCES public.commerce_checkpoint_part_contents(id);
CREATE INDEX IF NOT EXISTS source_aggregates_checkpoint_part_ref ON public.source_aggregates(checkpoint_part_id)
 WHERE checkpoint_part_id IS NOT NULL;
-- An existing legacy row still contains part; a shared row contains only the
-- original metadata. A foreign key must never alter a non-checkpoint family.
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public.source_aggregates'::regclass AND conname='checkpoint_part_reference_scope') THEN
 ALTER TABLE public.source_aggregates ADD CONSTRAINT checkpoint_part_reference_scope CHECK(
 checkpoint_part_id IS NULL OR (source='notion' AND metric_key='notion_commerce_checkpoint'
 AND NOT dimensions ? 'part' AND dimensions ?& ARRAY['index','total','hash']));
END IF;END $$;

-- Operator-controlled fence; compatible is passive and does not activate a
-- rollout. Only the database owner may change its mode. All checkpoint writes
-- take the same shared transaction lock before checking the committed mode.
CREATE TABLE IF NOT EXISTS public.commerce_checkpoint_storage_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 mode text NOT NULL CHECK(mode IN ('compatible','compact','frozen'))
);
INSERT INTO public.commerce_checkpoint_storage_control(singleton,mode) VALUES(true,'compatible') ON CONFLICT DO NOTHING;
ALTER TABLE public.commerce_checkpoint_storage_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_checkpoint_storage_control FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.commerce_checkpoint_storage_control TO service_role;

CREATE OR REPLACE FUNCTION public.cockpit_checkpoint_storage_mode(p_mode text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE previous text;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('compatible','compact','frozen') THEN RAISE EXCEPTION 'invalid checkpoint storage mode' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(26,61008);
 IF EXISTS(SELECT FROM public.sync_runs WHERE source='notion'
  AND stream_key IN ('commerce_reader_checkpoint','commerce_declared_snapshot') AND status='running') THEN
  RAISE EXCEPTION 'commerce writers still running' USING ERRCODE='55P03';END IF;
 SELECT mode INTO previous FROM public.commerce_checkpoint_storage_control WHERE singleton;
 UPDATE public.commerce_checkpoint_storage_control SET mode=p_mode WHERE singleton;
 RETURN jsonb_build_object('previous',previous,'mode',p_mode);
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_checkpoint_write_fence()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE mode_value text; old_part text; new_part text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.metric_key NOT IN ('notion_commerce_checkpoint','notion_commerce_checkpoint_publication') THEN RETURN NEW;END IF;
 ELSIF TG_OP='DELETE' THEN
  IF OLD.metric_key NOT IN ('notion_commerce_checkpoint','notion_commerce_checkpoint_publication') THEN RETURN OLD;END IF;
 ELSE
  IF OLD.metric_key NOT IN ('notion_commerce_checkpoint','notion_commerce_checkpoint_publication')
   AND NEW.metric_key NOT IN ('notion_commerce_checkpoint','notion_commerce_checkpoint_publication') THEN RETURN NEW;END IF;
 END IF;
 PERFORM pg_advisory_xact_lock_shared(26,61008);
 SELECT mode INTO mode_value FROM public.commerce_checkpoint_storage_control WHERE singleton;
 IF mode_value='frozen' THEN
  -- A frozen rollout permits ONLY a finalized row's storage-only conversion or
  -- rollback. Its exact text and every original envelope field must be equal.
  IF TG_OP='UPDATE' AND OLD.metric_key='notion_commerce_checkpoint' AND NEW.metric_key=OLD.metric_key
   AND (OLD.checkpoint_part_id IS NULL) IS DISTINCT FROM (NEW.checkpoint_part_id IS NULL)
   AND NOT EXISTS(SELECT FROM public.sync_runs WHERE id=OLD.sync_run_id AND status='running') THEN
   old_part=CASE WHEN OLD.checkpoint_part_id IS NULL THEN OLD.dimensions->>'part' ELSE
    (SELECT part FROM public.commerce_checkpoint_part_contents WHERE id=OLD.checkpoint_part_id) END;
   new_part=CASE WHEN NEW.checkpoint_part_id IS NULL THEN NEW.dimensions->>'part' ELSE
    (SELECT part FROM public.commerce_checkpoint_part_contents WHERE id=NEW.checkpoint_part_id) END;
   IF old_part IS NOT NULL AND new_part IS NOT NULL AND convert_to(old_part,'UTF8')=convert_to(new_part,'UTF8')
    AND (to_jsonb(OLD)-'dimensions'-'checkpoint_part_id')=(to_jsonb(NEW)-'dimensions'-'checkpoint_part_id')
    AND (OLD.dimensions||jsonb_build_object('part',old_part))=(NEW.dimensions||jsonb_build_object('part',new_part)) THEN RETURN NEW;END IF;
  END IF;
  RAISE EXCEPTION 'checkpoint writes frozen' USING ERRCODE='55000';
 END IF;
 IF mode_value='compact' AND TG_OP<>'DELETE' AND NEW.metric_key='notion_commerce_checkpoint' AND NEW.checkpoint_part_id IS NULL THEN
  RAISE EXCEPTION 'legacy checkpoint writer fenced' USING ERRCODE='55000';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS checkpoint_write_fence ON public.source_aggregates;
CREATE TRIGGER checkpoint_write_fence BEFORE INSERT OR UPDATE OR DELETE ON public.source_aggregates
 FOR EACH ROW EXECUTE FUNCTION public.cockpit_checkpoint_write_fence();

CREATE OR REPLACE FUNCTION public.cockpit_checkpoint_content_immutable()
 RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'checkpoint content is immutable' USING ERRCODE='55000';END $$;
DROP TRIGGER IF EXISTS checkpoint_content_immutable ON public.commerce_checkpoint_part_contents;
CREATE TRIGGER checkpoint_content_immutable BEFORE UPDATE OR DELETE ON public.commerce_checkpoint_part_contents
 FOR EACH ROW EXECUTE FUNCTION public.cockpit_checkpoint_content_immutable();

CREATE OR REPLACE FUNCTION public.cockpit_checkpoint_content_id(p_namespace text,p_profile text,p_part text)
 RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE digest text; content_id uuid;
BEGIN
 IF p_namespace IS NULL OR p_profile IS NULL OR p_part IS NULL
 OR octet_length('{"part":'||to_json(p_part)::text||'}')>2800 THEN
  RAISE EXCEPTION 'invalid checkpoint part' USING ERRCODE='23514';END IF;
 digest=encode(pg_catalog.sha256(convert_to(p_part,'UTF8')),'hex');
 -- Digest identifies candidates only. Real byte equality is decisive, even
 -- under a hypothetical collision. Lock scope is stable across writer runs.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_namespace,p_profile,digest)::text,26));
 SELECT id INTO content_id FROM public.commerce_checkpoint_part_contents
 WHERE source_namespace=p_namespace AND report_profile_key=p_profile
 AND encoding_version='checkpoint-json-text-v1' AND content_hash=digest
 AND convert_to(part,'UTF8')=convert_to(p_part,'UTF8') ORDER BY id LIMIT 1;
 IF content_id IS NULL THEN
  INSERT INTO public.commerce_checkpoint_part_contents(source_namespace,report_profile_key,content_hash,part)
  VALUES(p_namespace,p_profile,digest,p_part) RETURNING id INTO content_id;
 END IF;
 RETURN content_id;
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_checkpoint_rows(p_run uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 1000)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_offset<0 OR p_offset>=10000 OR p_limit<1 OR p_limit>1000 THEN
  RAISE EXCEPTION 'invalid checkpoint page' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.source_aggregates a LEFT JOIN public.commerce_checkpoint_part_contents c ON c.id=a.checkpoint_part_id
  WHERE a.sync_run_id=p_run AND a.metric_key='notion_commerce_checkpoint' AND a.checkpoint_part_id IS NOT NULL
  AND (c.id IS NULL OR c.source_namespace<>a.source_namespace OR c.report_profile_key<>a.report_profile_key
   OR c.content_hash<>encode(pg_catalog.sha256(convert_to(c.part,'UTF8')),'hex'))) THEN
  RAISE EXCEPTION 'checkpoint content mismatch' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(logical ORDER BY dimensions_key),'[]'::jsonb) INTO result FROM (
  SELECT a.dimensions_key,(to_jsonb(a)-'checkpoint_part_id')||jsonb_build_object('dimensions',
   CASE WHEN a.checkpoint_part_id IS NULL THEN a.dimensions ELSE a.dimensions||jsonb_build_object('part',c.part) END) AS logical
  FROM public.source_aggregates a LEFT JOIN public.commerce_checkpoint_part_contents c ON c.id=a.checkpoint_part_id
  WHERE a.sync_run_id=p_run AND a.metric_key='notion_commerce_checkpoint'
  ORDER BY a.dimensions_key LIMIT p_limit OFFSET p_offset
 ) selected;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_stage_checkpoint_parts(p_run uuid,p_profile text,p_started_at timestamptz,p_hash text,p_total integer,p_parts jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; fragment jsonb; ix integer; content_id uuid; existing public.source_aggregates; n integer=0; actual_hash text;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(26,61008);
 IF (SELECT mode FROM public.commerce_checkpoint_storage_control WHERE singleton)='frozen' THEN
  RAISE EXCEPTION 'checkpoint writes frozen' USING ERRCODE='55000';END IF;
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run FOR UPDATE;
 IF NOT FOUND OR r.source<>'notion' OR r.stream_key<>'commerce_reader_checkpoint'
 OR r.query_profile_key IS DISTINCT FROM p_profile OR r.status NOT IN ('running','complete') THEN
  RAISE EXCEPTION 'inactive checkpoint run' USING ERRCODE='55000';END IF;
 IF p_started_at IS NULL OR p_started_at<='1970-01-01T00:00:00Z' OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
 OR p_total IS NULL OR p_total NOT BETWEEN 1 AND 10000 OR p_parts IS NULL OR jsonb_typeof(p_parts)<>'array'
 OR jsonb_array_length(p_parts) NOT BETWEEN 1 AND 100 OR octet_length(p_parts::text)>400000 THEN
  RAISE EXCEPTION 'invalid checkpoint batch' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.source_aggregates a WHERE a.sync_run_id=p_run AND a.metric_key='notion_commerce_checkpoint'
  AND (a.period_to<>p_started_at OR a.dimensions->>'hash' IS DISTINCT FROM p_hash
   OR a.dimensions->>'total' IS DISTINCT FROM p_total::text)) THEN
  RAISE EXCEPTION 'checkpoint envelope conflict' USING ERRCODE='55000';END IF;
 IF (SELECT count(DISTINCT value->>'index') FROM jsonb_array_elements(p_parts))<>jsonb_array_length(p_parts) THEN
  RAISE EXCEPTION 'duplicate checkpoint index' USING ERRCODE='23514';END IF;
 -- Consistent content-lock order even when index order differs across runs.
 FOR fragment IN SELECT value FROM jsonb_array_elements(p_parts)
  ORDER BY encode(pg_catalog.sha256(convert_to(value->>'part','UTF8')),'hex'),value->>'index' LOOP
  IF jsonb_typeof(fragment)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(fragment))<>2
   OR NOT fragment ?& ARRAY['index','part'] OR jsonb_typeof(fragment->'index')<>'number'
   OR (fragment->>'index')::numeric<>trunc((fragment->>'index')::numeric)
   OR (fragment->>'index')::numeric<0 OR (fragment->>'index')::numeric>=p_total
   OR jsonb_typeof(fragment->'part')<>'string' THEN
   RAISE EXCEPTION 'invalid checkpoint fragment' USING ERRCODE='23514';END IF;
  ix=(fragment->>'index')::integer;
  SELECT * INTO existing FROM public.source_aggregates WHERE sync_run_id=p_run AND metric_key='notion_commerce_checkpoint'
   AND dimensions_key='checkpoint:'||lpad(ix::text,6,'0');
  IF FOUND THEN
   IF existing.source_namespace<>r.source_namespace OR existing.report_profile_key<>p_profile
    OR existing.dimensions->>'index' IS DISTINCT FROM ix::text
    OR (CASE WHEN existing.checkpoint_part_id IS NULL THEN existing.dimensions->>'part'
       ELSE (SELECT part FROM public.commerce_checkpoint_part_contents WHERE id=existing.checkpoint_part_id) END)
       IS DISTINCT FROM fragment->>'part' THEN
    RAISE EXCEPTION 'checkpoint fragment conflict' USING ERRCODE='55000';END IF;
   CONTINUE; -- no update, no new content or reference tuple on replay
  END IF;
  IF r.status<>'running' THEN RAISE EXCEPTION 'checkpoint already complete' USING ERRCODE='55000';END IF;
  content_id=public.cockpit_checkpoint_content_id(r.source_namespace,p_profile,fragment->>'part');
  INSERT INTO public.source_aggregates(source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id,
   timezone,coverage_state,value,unit,currency,currency_exponent,tax_basis,dimensions,definition_version,source_locator,checkpoint_part_id)
  VALUES('notion',r.source_namespace,'notion_commerce_checkpoint','1970-01-01T00:00:00Z',p_started_at,'checkpoint:'||lpad(ix::text,6,'0'),p_profile,r.id,
   'Europe/Paris','partial',1,'count',NULL,NULL,'unknown',jsonb_build_object('index',ix,'total',p_total,'hash',p_hash),p_profile,'notion:commerce-reader-checkpoint',content_id);
  n=n+1;
 END LOOP;
 IF (SELECT count(*) FROM public.source_aggregates WHERE sync_run_id=p_run AND metric_key='notion_commerce_checkpoint')=p_total THEN
  SELECT encode(pg_catalog.sha256(convert_to(string_agg(CASE WHEN a.checkpoint_part_id IS NULL THEN a.dimensions->>'part' ELSE c.part END,'' ORDER BY a.dimensions_key),'UTF8')),'hex') INTO actual_hash
  FROM public.source_aggregates a LEFT JOIN public.commerce_checkpoint_part_contents c ON c.id=a.checkpoint_part_id
  WHERE a.sync_run_id=p_run AND a.metric_key='notion_commerce_checkpoint';
  IF actual_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'checkpoint staged hash mismatch' USING ERRCODE='23514';END IF;
 END IF;
 RETURN jsonb_build_object('inserted',n,'received',jsonb_array_length(p_parts));
END $$;

-- Bounded, explicit per-run conversion/rollback, default DRY RUN. All logical
-- rows are hashed before/after, including UUIDs and metadata. Includes newly
-- compact-written rows on rollback; never restores merely an old DB snapshot.
CREATE OR REPLACE FUNCTION public.cockpit_checkpoint_backfill(p_run uuid,p_apply boolean DEFAULT false,p_restore boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; a public.source_aggregates; logical jsonb; before_rows jsonb='[]'; after_rows jsonb='[]';
 serialized text=''; full_hash text; total integer; idx integer=0; content_id uuid; part_value text; before_hash text; after_hash text; changed integer=0;
BEGIN
 IF p_apply IS NULL OR p_restore IS NULL THEN RAISE EXCEPTION 'explicit conversion mode required' USING ERRCODE='23514';END IF;
 IF p_apply THEN
  PERFORM pg_advisory_xact_lock_shared(26,61008);
  IF (SELECT mode FROM public.commerce_checkpoint_storage_control WHERE singleton) IS DISTINCT FROM 'frozen' THEN
   RAISE EXCEPTION 'conversion requires frozen checkpoint writers' USING ERRCODE='55000';END IF;
 END IF;
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run FOR UPDATE;
 IF NOT FOUND OR r.source<>'notion' OR r.stream_key<>'commerce_reader_checkpoint' OR r.status='running' THEN
  RAISE EXCEPTION 'checkpoint run not fenced' USING ERRCODE='55000';END IF;
 FOR a IN SELECT * FROM public.source_aggregates WHERE sync_run_id=p_run AND metric_key='notion_commerce_checkpoint' ORDER BY dimensions_key LOOP
  IF idx>=10000 THEN RAISE EXCEPTION 'checkpoint conversion limit' USING ERRCODE='23514';END IF;
  part_value=CASE WHEN a.checkpoint_part_id IS NULL THEN a.dimensions->>'part' ELSE
   (SELECT part FROM public.commerce_checkpoint_part_contents WHERE id=a.checkpoint_part_id AND source_namespace=a.source_namespace AND report_profile_key=a.report_profile_key) END;
  IF idx=0 THEN total=(a.dimensions->>'total')::integer;full_hash=a.dimensions->>'hash';END IF;
  IF part_value IS NULL OR a.dimensions->>'index' IS DISTINCT FROM idx::text OR a.dimensions->>'total' IS DISTINCT FROM total::text
   OR a.dimensions->>'hash' IS DISTINCT FROM full_hash OR total NOT BETWEEN 1 AND 10000
   OR a.dimensions_key<>'checkpoint:'||lpad(idx::text,6,'0') THEN
   RAISE EXCEPTION 'checkpoint conversion integrity' USING ERRCODE='23514';END IF;
  logical=(to_jsonb(a)-'checkpoint_part_id')||jsonb_build_object('dimensions',a.dimensions||jsonb_build_object('part',part_value));
  before_rows=before_rows||jsonb_build_array(logical);serialized=serialized||part_value;idx=idx+1;
 END LOOP;
 IF idx=0 OR idx IS DISTINCT FROM total OR encode(pg_catalog.sha256(convert_to(serialized,'UTF8')),'hex') IS DISTINCT FROM full_hash THEN
  RAISE EXCEPTION 'checkpoint conversion hash/count' USING ERRCODE='23514';END IF;
 before_hash=encode(pg_catalog.sha256(convert_to(before_rows::text,'UTF8')),'hex');
 IF p_apply THEN
  FOR logical IN SELECT value FROM jsonb_array_elements(before_rows)
   ORDER BY encode(pg_catalog.sha256(convert_to(value->'dimensions'->>'part','UTF8')),'hex'),value->>'id' LOOP
   IF p_restore THEN
    UPDATE public.source_aggregates SET dimensions=logical->'dimensions',checkpoint_part_id=NULL
     WHERE id=(logical->>'id')::uuid AND checkpoint_part_id IS NOT NULL;
   ELSE
    content_id=public.cockpit_checkpoint_content_id(logical->>'source_namespace',logical->>'report_profile_key',logical->'dimensions'->>'part');
    UPDATE public.source_aggregates SET dimensions=dimensions-'part',checkpoint_part_id=content_id
     WHERE id=(logical->>'id')::uuid AND checkpoint_part_id IS NULL;
   END IF;
   GET DIAGNOSTICS idx=ROW_COUNT;changed=changed+idx;
  END LOOP;
 END IF;
 FOR idx IN 0..9 LOOP after_rows=after_rows||public.cockpit_checkpoint_rows(p_run,idx*1000,1000);END LOOP;
 after_hash=encode(pg_catalog.sha256(convert_to(after_rows::text,'UTF8')),'hex');
 IF before_hash IS DISTINCT FROM after_hash THEN RAISE EXCEPTION 'checkpoint logical equivalence failed' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('runId',p_run,'dryRun',NOT p_apply,'restore',p_restore,'parts',total,'serializedHash',full_hash,
  'logicalRowsHash',before_hash,'afterLogicalRowsHash',after_hash,'equivalent',true,'converted',changed);
END $$;

REVOKE ALL ON FUNCTION public.cockpit_checkpoint_content_immutable(),public.cockpit_checkpoint_content_id(text,text,text),
 public.cockpit_checkpoint_rows(uuid,integer,integer),public.cockpit_stage_checkpoint_parts(uuid,text,timestamptz,text,integer,jsonb),
 public.cockpit_checkpoint_backfill(uuid,boolean,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_checkpoint_storage_mode(text),public.cockpit_checkpoint_write_fence()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_checkpoint_content_id(text,text,text),public.cockpit_checkpoint_rows(uuid,integer,integer),
 public.cockpit_stage_checkpoint_parts(uuid,text,timestamptz,text,integer,jsonb),public.cockpit_checkpoint_backfill(uuid,boolean,boolean) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(26) ON CONFLICT(version) DO NOTHING;
COMMIT;
