-- Migration 20 · inscriptions : une modification met à jour la même ligne (décision Mehdi, 23 septembre ; voie (i)).
-- Règle : une création ajoute un objet ; une modification met à jour le même objet (même id) ; une absence de changement
-- ne conserve aucune nouvelle copie ; les événements métier utiles sont conservés sans copie de fiche.
--
-- 1. Table lead_source_observation_changes : trace minimale d'un changement métier d'une inscription courante (clé,
--    tentative, date, anciennes valeurs de version, d'empreintes, de mapping, d'identité et d'éligibilité, nature).
--    Jamais de copie de « properties » (aucune donnée nominative). Une ligne n'est écrite que pour un changement métier :
--    source (date source ou empreinte source), identity (personne ou état d'identité), eligibility. Une re-dérivation
--    purement technique (mapping, derived : profil de mapping, propriétés recalculées à source identique) met la ligne
--    à jour en place sans trace (les compteurs mappingChanged de sync_runs la tracent déjà).
-- 2. cockpit_publish_lead_entries (remplace 018) : contrôles MAPPING_REPLAY_INCOMPLETE et SOURCE_VERSION_CONFLICT et
--    compteurs identiques à 018 ; puis, pour chaque ligne préparée s :
--     * ligne courante c de même clé et s plus récente, ou de même date source et techniquement différente (condition
--       de 018) : s est supprimée PUIS c est mise à jour en place (contenu, run_id = tentative, mapping, published_at ;
--       recorded_at conservé = première observation), dans une seule instruction où la mise à jour consomme le résultat
--       de la suppression (même mécanique que cockpit_apply_aggregate_state, 018) : l'index unique
--       (run_id, source_namespace, family, external_id) ne voit jamais deux lignes de la tentative pour la même clé ;
--     * ligne courante c et s plus ancienne (stale) ou inchangée : s est supprimée, c intacte ;
--     * aucune ligne courante : s devient courante (published_at, is_current = true), comme en 018.
--    counts : forme de 018 + events (lignes de changement écrites). Clôture complete/empty inchangée.
--    cockpit_stage_lead_entries : inchangée (018).
-- Lecteurs inchangés : ils lisent is_current, published_at, run_id parmi les tentatives complètes et mapping_profile =
-- dernier profil publié ; une ligne mise à jour en place porte la tentative complète qui l'a publiée et son profil.
-- Rejouable : table et index « IF NOT EXISTS », fonction « CREATE OR REPLACE », version inscrite une fois.
-- Aucune suppression de ligne publiée : seules les lignes préparées de la tentative en cours de publication sont
-- supprimées (fusionnées ou périmées). Remplacées seulement si la table des observations (009) existe.
BEGIN;
DO $migration$
BEGIN
 IF to_regclass('public.lead_source_observations') IS NULL THEN RAISE NOTICE 'lead_source_observations absente : migration 20 sans effet.';RETURN;END IF;
 EXECUTE $table$
CREATE TABLE IF NOT EXISTS public.lead_source_observation_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 observation_id uuid NOT NULL REFERENCES public.lead_source_observations(id),
 source_namespace text NOT NULL, family text NOT NULL, external_id text NOT NULL,
 run_id uuid NOT NULL,
 changed_at timestamptz NOT NULL,
 previous_source_updated_at timestamptz NOT NULL,
 previous_payload_hash text NOT NULL, previous_source_payload_hash text NOT NULL,
 previous_mapping_profile text NOT NULL,
 previous_person_id uuid,
 previous_identity_state text NOT NULL,
 previous_eligible boolean NOT NULL,
 kinds text[] NOT NULL CHECK (kinds <@ ARRAY['source','identity','eligibility','mapping','derived']::text[] AND kinds && ARRAY['source','identity','eligibility']::text[])
)$table$;
 EXECUTE 'CREATE INDEX IF NOT EXISTS lead_observation_changes_key ON public.lead_source_observation_changes(source_namespace,family,external_id,changed_at)';
 -- Contrôle de clé étrangère lors d'une suppression d'observation (lignes préparées) : sonde par index, jamais un balayage.
 EXECUTE 'CREATE INDEX IF NOT EXISTS lead_observation_changes_observation ON public.lead_source_observation_changes(observation_id)';
 EXECUTE 'ALTER TABLE public.lead_source_observation_changes ENABLE ROW LEVEL SECURITY';
 EXECUTE 'REVOKE ALL ON public.lead_source_observation_changes FROM PUBLIC,anon,authenticated';
 EXECUTE 'GRANT ALL ON public.lead_source_observation_changes TO service_role';
 EXECUTE $publish$
CREATE OR REPLACE FUNCTION public.cockpit_publish_lead_entries(p_run uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;ns text;stream text;changed integer;unchanged integer;stale integer;conflicts integer;identity_changed integer;mapping_changed integer;missing_mapping integer;staged integer;skipped integer;stamp timestamptz=clock_timestamp();counts jsonb;merged integer;events integer;
BEGIN
 SELECT source_namespace,stream_key INTO ns,stream FROM sync_runs WHERE id=p_run;
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-observation:'||ns||':'||replace(stream,'lead_entries_',''),0));
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND stream_key LIKE 'lead_entries_%' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(r.checkpoint) IS DISTINCT FROM 'object' OR r.checkpoint->>'version' IS DISTINCT FROM '1' OR r.checkpoint->>'done' IS DISTINCT FROM 'true' OR r.checkpoint->>'cursor' IS NOT NULL OR (r.checkpoint->>'page')::integer IS NULL OR (r.checkpoint->>'page')::integer<1 OR r.rows_rejected<>0 THEN RAISE EXCEPTION 'incomplete observation run' USING ERRCODE='55000';END IF;
 SELECT count(*) INTO staged FROM lead_source_observations WHERE run_id=p_run;
 skipped=coalesce((r.checkpoint->>'unchangedSkipped')::integer,0);
 -- A mapping transition cannot silently hide a historical request missing from the source replay (018, inchangé).
 SELECT count(*) INTO missing_mapping FROM lead_source_observations c WHERE c.is_current AND c.source_namespace=r.source_namespace AND c.family=replace(r.stream_key,'lead_entries_','') AND c.mapping_profile<>r.query_profile_key
 AND (r.checkpoint->'containerIds' IS NULL OR r.checkpoint->'containerIds'='null'::jsonb OR r.checkpoint->'containerIds' @> jsonb_build_array(c.source_container_id))
 AND NOT EXISTS(SELECT FROM lead_source_observations s WHERE s.run_id=p_run AND s.external_id=c.external_id AND s.source_updated_at>=c.source_updated_at);
 IF missing_mapping>0 THEN
  UPDATE sync_runs SET status='failed',finished_at=stamp,error_code='MAPPING_REPLAY_INCOMPLETE',lease_until=NULL,lease_token=NULL,checkpoint=checkpoint||jsonb_build_object('unmappedHistory',missing_mapping) WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','reason','MAPPING_REPLAY_INCOMPLETE','counts',jsonb_build_object('read',r.rows_read,'observations',staged,'changed',0,'rejected',0,'unmappedHistory',missing_mapping));
 END IF;
 -- Compteurs et conflit de version : 018 à l'identique.
 SELECT count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at=s.source_updated_at AND (c.source_payload_hash<>s.source_payload_hash OR EXISTS(SELECT FROM jsonb_each(coalesce(c.properties->'sourceFields','{}'::jsonb)) f WHERE s.properties->'sourceFields' ? f.key AND s.properties->'sourceFields'->f.key IS DISTINCT FROM f.value) OR (c.mapping_profile=s.mapping_profile AND c.payload_hash<>s.payload_hash))),
 count(*) FILTER(WHERE c.id IS NOT NULL AND c.payload_hash=s.payload_hash AND c.person_id IS NOT DISTINCT FROM s.person_id AND c.identity_state=s.identity_state),
 count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at>s.source_updated_at AND (c.payload_hash<>s.payload_hash OR c.person_id IS DISTINCT FROM s.person_id OR c.identity_state<>s.identity_state)),
 count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at<=s.source_updated_at AND (c.person_id IS DISTINCT FROM s.person_id OR c.identity_state<>s.identity_state)),
 count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at<=s.source_updated_at AND c.mapping_profile<>s.mapping_profile)
 INTO conflicts,unchanged,stale,identity_changed,mapping_changed FROM lead_source_observations s LEFT JOIN lead_source_observations c ON c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id WHERE s.run_id=p_run;
 IF conflicts>0 THEN
  UPDATE sync_runs SET status='failed',finished_at=stamp,error_code='SOURCE_VERSION_CONFLICT',rows_rejected=conflicts,lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','reason','SOURCE_VERSION_CONFLICT','counts',jsonb_build_object('read',r.rows_read,'rejected',conflicts,'changed',0,'unchanged',unchanged+skipped,'stale',stale));
 END IF;
 changed=staged-unchanged-stale;
 -- 1. Objet déjà courant, observation plus récente ou re-dérivée (condition de bascule de 018) : la ligne préparée est
 --    supprimée, puis la ligne courante (même id) reçoit son contenu, la tentative et le profil. La mise à jour lit la
 --    sortie de la suppression : pour chaque clé, la ligne préparée a disparu avant que la ligne courante prenne
 --    run_id = p_run (index unique run_id, source_namespace, family, external_id). recorded_at (première observation),
 --    source, is_current : inchangés. Changement métier (source, identity, eligibility) : une ligne de trace, sans properties.
 WITH pairs AS (
  SELECT s.id AS staged_id,c.id AS current_id,c.source_namespace,c.family,c.external_id,c.source_updated_at AS previous_source_updated_at,
   c.payload_hash AS previous_payload_hash,c.source_payload_hash AS previous_source_payload_hash,c.mapping_profile AS previous_mapping_profile,
   c.person_id AS previous_person_id,c.identity_state AS previous_identity_state,c.eligible AS previous_eligible,
   array_remove(ARRAY[
    CASE WHEN c.source_updated_at<>s.source_updated_at OR c.source_payload_hash<>s.source_payload_hash THEN 'source' END,
    CASE WHEN c.person_id IS DISTINCT FROM s.person_id OR c.identity_state<>s.identity_state THEN 'identity' END,
    CASE WHEN c.eligible<>s.eligible THEN 'eligibility' END,
    CASE WHEN c.mapping_profile<>s.mapping_profile THEN 'mapping' END,
    CASE WHEN c.payload_hash<>s.payload_hash OR c.properties<>s.properties OR c.identity_key IS DISTINCT FROM s.identity_key OR c.occurred_at IS DISTINCT FROM s.occurred_at
     OR c.source_container_id<>s.source_container_id OR c.source_contact_id IS DISTINCT FROM s.source_contact_id OR c.source_status IS DISTINCT FROM s.source_status THEN 'derived' END
   ]::text[],NULL) AS kinds
  FROM lead_source_observations s JOIN lead_source_observations c ON c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id
  WHERE s.run_id=p_run AND NOT s.is_current
   AND (s.source_updated_at>c.source_updated_at OR (s.source_updated_at=c.source_updated_at AND s.source_payload_hash=c.source_payload_hash AND (s.mapping_profile<>c.mapping_profile OR s.person_id IS DISTINCT FROM c.person_id OR s.identity_state<>c.identity_state)))
 ), moved AS (
  DELETE FROM lead_source_observations s USING pairs WHERE s.id=pairs.staged_id
  RETURNING pairs.current_id,s.occurred_at,s.occurred_day,s.source_updated_at,s.source_container_id,s.source_contact_id,s.source_status,s.identity_key,s.person_id,s.identity_state,s.eligible,s.properties,s.payload_hash,s.source_payload_hash,s.mapping_profile
 ), applied AS (
  UPDATE lead_source_observations c SET run_id=p_run,occurred_at=moved.occurred_at,occurred_day=moved.occurred_day,source_updated_at=moved.source_updated_at,
   source_container_id=moved.source_container_id,source_contact_id=moved.source_contact_id,source_status=moved.source_status,identity_key=moved.identity_key,
   person_id=moved.person_id,identity_state=moved.identity_state,eligible=moved.eligible,properties=moved.properties,payload_hash=moved.payload_hash,
   source_payload_hash=moved.source_payload_hash,mapping_profile=moved.mapping_profile,published_at=stamp
  FROM moved WHERE c.id=moved.current_id AND c.is_current RETURNING c.id
 ), written AS (
  INSERT INTO lead_source_observation_changes(observation_id,source_namespace,family,external_id,run_id,changed_at,previous_source_updated_at,previous_payload_hash,
   previous_source_payload_hash,previous_mapping_profile,previous_person_id,previous_identity_state,previous_eligible,kinds)
  SELECT p.current_id,p.source_namespace,p.family,p.external_id,p_run,stamp,p.previous_source_updated_at,p.previous_payload_hash,p.previous_source_payload_hash,
   p.previous_mapping_profile,p.previous_person_id,p.previous_identity_state,p.previous_eligible,p.kinds
  FROM pairs p JOIN applied a ON a.id=p.current_id WHERE p.kinds && ARRAY['source','identity','eligibility']::text[]
  RETURNING 1
 ) SELECT (SELECT count(*) FROM applied),(SELECT count(*) FROM written) INTO merged,events;
 -- 2. Observation plus ancienne que la ligne courante (stale) ou inchangée : aucune version conservée.
 DELETE FROM lead_source_observations s USING lead_source_observations c WHERE s.run_id=p_run AND NOT s.is_current AND c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id;
 -- 3. Nouvel objet : la ligne préparée devient courante (018).
 UPDATE lead_source_observations s SET published_at=stamp,is_current=true WHERE s.run_id=p_run AND NOT s.is_current;
 counts=jsonb_build_object('read',r.rows_read,'observations',staged,'changed',changed,'unchanged',unchanged+skipped,'unchangedSkipped',skipped,'stale',stale,'identityChanged',identity_changed,'mappingChanged',mapping_changed,'rejected',0,'ignored',coalesce((r.checkpoint->>'ignored')::integer,0),'events',events);
 UPDATE sync_runs SET status=CASE WHEN staged+skipped=0 THEN 'empty' ELSE 'complete' END,finished_at=stamp,pagination_complete=true,covered_from=period_from,covered_to=period_to,checkpoint=checkpoint||jsonb_build_object('counts',counts),lease_until=NULL,lease_token=NULL WHERE id=p_run;
 RETURN jsonb_build_object('status',CASE WHEN staged+skipped=0 THEN 'empty' ELSE 'complete' END,'counts',counts);
END $$;
 $publish$;
 REVOKE ALL ON FUNCTION public.cockpit_publish_lead_entries(uuid,uuid) FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION public.cockpit_publish_lead_entries(uuid,uuid) TO service_role;
END $migration$;
INSERT INTO public.cockpit_migrations(version) VALUES(20) ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Retour arrière (aucune donnée supprimée) : redéployer d'abord le code antérieur si nécessaire (le code n'a pas changé
-- avec cette migration), puis exécuter le bloc ci-dessous (lignes entre les deux marqueurs, sans le préfixe « -- »).
-- Il réapplique le corps 018 de cockpit_publish_lead_entries. Les lignes mises à jour en place restent lisibles par
-- l'ancien code et les lecteurs : is_current, published_at, run_id d'une tentative complète, mapping_profile courant.
-- La table lead_source_observation_changes peut rester (plus alimentée) ; ses lignes restent consultables.
-- RETOUR ARRIERE 020 DEBUT
-- CREATE OR REPLACE FUNCTION public.cockpit_publish_lead_entries(p_run uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
-- DECLARE r sync_runs;ns text;stream text;changed integer;unchanged integer;stale integer;conflicts integer;identity_changed integer;mapping_changed integer;missing_mapping integer;staged integer;skipped integer;stamp timestamptz=clock_timestamp();counts jsonb;
-- BEGIN
--  SELECT source_namespace,stream_key INTO ns,stream FROM sync_runs WHERE id=p_run;
--  PERFORM pg_advisory_xact_lock(hashtextextended('lead-observation:'||ns||':'||replace(stream,'lead_entries_',''),0));
--  SELECT * INTO r FROM sync_runs WHERE id=p_run AND stream_key LIKE 'lead_entries_%' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
--  IF NOT FOUND OR jsonb_typeof(r.checkpoint) IS DISTINCT FROM 'object' OR r.checkpoint->>'version' IS DISTINCT FROM '1' OR r.checkpoint->>'done' IS DISTINCT FROM 'true' OR r.checkpoint->>'cursor' IS NOT NULL OR (r.checkpoint->>'page')::integer IS NULL OR (r.checkpoint->>'page')::integer<1 OR r.rows_rejected<>0 THEN RAISE EXCEPTION 'incomplete observation run' USING ERRCODE='55000';END IF;
--  SELECT count(*) INTO staged FROM lead_source_observations WHERE run_id=p_run;
--  skipped=coalesce((r.checkpoint->>'unchangedSkipped')::integer,0);
--  -- A mapping transition cannot silently hide a historical request missing from the source replay.
--  -- (Une observation inchangée non insérée a le mapping de la tentative : elle n'entre jamais dans ce contrôle.)
--  SELECT count(*) INTO missing_mapping FROM lead_source_observations c WHERE c.is_current AND c.source_namespace=r.source_namespace AND c.family=replace(r.stream_key,'lead_entries_','') AND c.mapping_profile<>r.query_profile_key
--  AND (r.checkpoint->'containerIds' IS NULL OR r.checkpoint->'containerIds'='null'::jsonb OR r.checkpoint->'containerIds' @> jsonb_build_array(c.source_container_id))
--  AND NOT EXISTS(SELECT FROM lead_source_observations s WHERE s.run_id=p_run AND s.external_id=c.external_id AND s.source_updated_at>=c.source_updated_at);
--  IF missing_mapping>0 THEN
--   UPDATE sync_runs SET status='failed',finished_at=stamp,error_code='MAPPING_REPLAY_INCOMPLETE',lease_until=NULL,lease_token=NULL,checkpoint=checkpoint||jsonb_build_object('unmappedHistory',missing_mapping) WHERE id=p_run;
--   RETURN jsonb_build_object('status','failed','reason','MAPPING_REPLAY_INCOMPLETE','counts',jsonb_build_object('read',r.rows_read,'observations',staged,'changed',0,'rejected',0,'unmappedHistory',missing_mapping));
--  END IF;
--  SELECT count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at=s.source_updated_at AND (c.source_payload_hash<>s.source_payload_hash OR EXISTS(SELECT FROM jsonb_each(coalesce(c.properties->'sourceFields','{}'::jsonb)) f WHERE s.properties->'sourceFields' ? f.key AND s.properties->'sourceFields'->f.key IS DISTINCT FROM f.value) OR (c.mapping_profile=s.mapping_profile AND c.payload_hash<>s.payload_hash))),
--  count(*) FILTER(WHERE c.id IS NOT NULL AND c.payload_hash=s.payload_hash AND c.person_id IS NOT DISTINCT FROM s.person_id AND c.identity_state=s.identity_state),
--  count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at>s.source_updated_at AND (c.payload_hash<>s.payload_hash OR c.person_id IS DISTINCT FROM s.person_id OR c.identity_state<>s.identity_state)),
--  count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at<=s.source_updated_at AND (c.person_id IS DISTINCT FROM s.person_id OR c.identity_state<>s.identity_state)),
--  count(*) FILTER(WHERE c.id IS NOT NULL AND c.source_updated_at<=s.source_updated_at AND c.mapping_profile<>s.mapping_profile)
--  INTO conflicts,unchanged,stale,identity_changed,mapping_changed FROM lead_source_observations s LEFT JOIN lead_source_observations c ON c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id WHERE s.run_id=p_run;
--  IF conflicts>0 THEN
--   UPDATE sync_runs SET status='failed',finished_at=stamp,error_code='SOURCE_VERSION_CONFLICT',rows_rejected=conflicts,lease_until=NULL,lease_token=NULL WHERE id=p_run;
--   RETURN jsonb_build_object('status','failed','reason','SOURCE_VERSION_CONFLICT','counts',jsonb_build_object('read',r.rows_read,'rejected',conflicts,'changed',0,'unchanged',unchanged+skipped,'stale',stale));
--  END IF;
--  changed=staged-unchanged-stale;
--  -- Keep the previous rows current until this transaction commits. Unchanged/older observations remain audit versions only.
--  UPDATE lead_source_observations c SET is_current=false FROM lead_source_observations s WHERE s.run_id=p_run AND c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id AND (s.source_updated_at>c.source_updated_at OR (s.source_updated_at=c.source_updated_at AND s.source_payload_hash=c.source_payload_hash AND (s.mapping_profile<>c.mapping_profile OR s.person_id IS DISTINCT FROM c.person_id OR s.identity_state<>c.identity_state)));
--  UPDATE lead_source_observations s SET published_at=stamp,is_current=NOT EXISTS(SELECT FROM lead_source_observations c WHERE c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id) WHERE s.run_id=p_run;
--  counts=jsonb_build_object('read',r.rows_read,'observations',staged,'changed',changed,'unchanged',unchanged+skipped,'unchangedSkipped',skipped,'stale',stale,'identityChanged',identity_changed,'mappingChanged',mapping_changed,'rejected',0,'ignored',coalesce((r.checkpoint->>'ignored')::integer,0));
--  UPDATE sync_runs SET status=CASE WHEN staged+skipped=0 THEN 'empty' ELSE 'complete' END,finished_at=stamp,pagination_complete=true,covered_from=period_from,covered_to=period_to,checkpoint=checkpoint||jsonb_build_object('counts',counts),lease_until=NULL,lease_token=NULL WHERE id=p_run;
--  RETURN jsonb_build_object('status',CASE WHEN staged+skipped=0 THEN 'empty' ELSE 'complete' END,'counts',counts);
-- END $$;
-- REVOKE ALL ON FUNCTION public.cockpit_publish_lead_entries(uuid,uuid) FROM PUBLIC,anon,authenticated;
-- GRANT EXECUTE ON FUNCTION public.cockpit_publish_lead_entries(uuid,uuid) TO service_role;
-- DELETE FROM public.cockpit_migrations WHERE version=20;
-- RETOUR ARRIERE 020 FIN
