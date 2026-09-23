-- Migration 19 · nettoyage borné de la zone de préparation, indépendant de toute publication réussie.
-- 018 ne nettoie les lignes préparées d'une tentative « failed » qu'à la publication réussie suivante du même flux :
-- des pannes répétées sans succès ne bornaient rien, les tentatives « partial » (ad_daily à 20 pages) et les observations
-- d'inscriptions jamais publiées d'une tentative en échec n'étaient jamais nettoyées.
--
-- cockpit_cleanup_staged(p_limit) supprime UNIQUEMENT des lignes jamais publiées :
--  * source_aggregates, ad_daily, meta_conversions_daily : lignes NOT is_current ;
--  * lead_source_observations : lignes published_at IS NULL AND NOT is_current ;
-- dont la tentative (sync_run_id, run_id) est terminale en échec (status 'failed' ou 'partial'), terminée depuis plus de
-- 24 heures, et commencée après l'application de la migration 18 (aucune purge héritée : les lignes écrites avant 018,
-- versions comprises, restent en place). Jamais une ligne d'une tentative complete, empty ou running ; jamais une ligne
-- courante ou publiée. Au plus p_limit lignes par table et par appel (1 à 5 000).
-- Aucune réclamation ne reprend une tentative « failed » ou « partial » (begin_sync_stream et cockpit_claim_lead_entries,
-- cockpit_claim_posthog, cockpit_claim_notion ne reprennent que des tentatives « running ») et aucun lecteur ne lit les
-- lignes d'une tentative qui n'est pas complete/empty : ces lignes ne servent plus à rien.
-- Appelée une fois par passage du tick (src/lib/sync-jobs.ts) ; un échec n'y fait pas échouer le passage.
--
-- Rejouable : fonction « CREATE OR REPLACE », droits réappliqués, version inscrite une fois. Aucune donnée modifiée ici.
BEGIN;

CREATE OR REPLACE FUNCTION public.cockpit_cleanup_staged(p_limit integer DEFAULT 5000)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE since timestamptz; horizon timestamptz=clock_timestamp()-interval '24 hours';
 n_aggregates integer=0; n_ad integer=0; n_conversions integer=0; n_leads integer=0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'invalid cleanup limit' USING ERRCODE='23514';END IF;
 SELECT applied_at INTO since FROM public.cockpit_migrations WHERE version=18;
 -- 018 non appliquée : aucune ligne n'appartient au modèle de préparation, rien n'est supprimé.
 IF since IS NOT NULL THEN
  -- Tentatives éligibles lues dans sync_runs (petite table), lignes atteintes par l'index de clé étrangère sync_run_id / run_id.
  DELETE FROM public.source_aggregates s WHERE s.id IN (
   SELECT x.id FROM public.sync_runs f JOIN public.source_aggregates x ON x.sync_run_id=f.id
   WHERE f.status IN ('failed','partial') AND f.finished_at IS NOT NULL AND f.finished_at<horizon AND f.started_at>=since AND NOT x.is_current
   LIMIT p_limit);
  GET DIAGNOSTICS n_aggregates=ROW_COUNT;
  DELETE FROM public.ad_daily d WHERE d.id IN (
   SELECT x.id FROM public.sync_runs f JOIN public.ad_daily x ON x.sync_run_id=f.id
   WHERE f.status IN ('failed','partial') AND f.finished_at IS NOT NULL AND f.finished_at<horizon AND f.started_at>=since AND NOT x.is_current
   LIMIT p_limit);
  GET DIAGNOSTICS n_ad=ROW_COUNT;
  DELETE FROM public.meta_conversions_daily d WHERE d.id IN (
   SELECT x.id FROM public.sync_runs f JOIN public.meta_conversions_daily x ON x.sync_run_id=f.id
   WHERE f.status IN ('failed','partial') AND f.finished_at IS NOT NULL AND f.finished_at<horizon AND f.started_at>=since AND NOT x.is_current
   LIMIT p_limit);
  GET DIAGNOSTICS n_conversions=ROW_COUNT;
  -- Base sans migration 009 : table absente, rien à nettoyer (l'instruction n'est préparée que si elle est atteinte).
  IF to_regclass('public.lead_source_observations') IS NOT NULL THEN
   DELETE FROM public.lead_source_observations o WHERE o.id IN (
    SELECT x.id FROM public.sync_runs f JOIN public.lead_source_observations x ON x.run_id=f.id
    WHERE f.status IN ('failed','partial') AND f.finished_at IS NOT NULL AND f.finished_at<horizon AND f.started_at>=since
     AND x.published_at IS NULL AND NOT x.is_current
    LIMIT p_limit);
   GET DIAGNOSTICS n_leads=ROW_COUNT;
  END IF;
 END IF;
 RETURN jsonb_build_object('source_aggregates',n_aggregates,'ad_daily',n_ad,'meta_conversions_daily',n_conversions,'lead_source_observations',n_leads);
END $$;

REVOKE ALL ON FUNCTION public.cockpit_cleanup_staged(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_cleanup_staged(integer) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(19) ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Retour arrière (aucune donnée concernée ; les lignes déjà supprimées étaient des lignes préparées jamais publiées) :
-- 1. redéployer d'abord un code qui n'appelle plus cockpit_cleanup_staged (sinon le tick signale seulement
--    « cleanup: schema_missing », sans échouer) ;
-- 2. puis :
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.cockpit_cleanup_staged(integer);
-- DELETE FROM public.cockpit_migrations WHERE version = 19;
-- COMMIT;
