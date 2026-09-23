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
-- cockpit_resume_current_state() : reprise de l'état courant après un retour arrière du code (docs/ACTUALISATION.md §7).
-- Pendant un retour arrière, l'ancien code publie par tentative (finish_sync complete) sans tenir is_current ; ses lecteurs
-- (ancien readKpiSource, v_ad_daily, v_meta_conversions_daily) lisent ces tentatives. Le rejeu de la reprise de 018 ne
-- complète que les clés sans ligne courante : il ne remplace jamais une ligne courante devenue ancienne (prouvé par
-- tests/state-rollback.integration.ts). Cette fonction, appelée à la main au redéploiement, rend courantes, pour chaque
-- jour (KPI, publicités, conversions) ou période exacte (Masterclass), exactement les lignes que lisent les anciens lecteurs,
-- et retire (is_current = false, jamais effacée) les lignes courantes d'une autre tentative. Aucune ligne ajoutée ni
-- supprimée ; rejouable (un second appel ne change rien) ; publications suspendues pendant l'appel (verrou des tables).
--
-- Rejouable : fonctions « CREATE OR REPLACE », droits réappliqués, version inscrite une fois. Aucune donnée modifiée ici.
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

CREATE OR REPLACE FUNCTION public.cockpit_resume_current_state()
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE w record; n integer;
 k_periods integer=0; k_retired integer=0; k_promoted integer=0; m_periods integer=0; m_retired integer=0; m_promoted integer=0;
 d_periods integer=0; d_retired integer=0; d_promoted integer=0; c_periods integer=0; c_retired integer=0; c_promoted integer=0;
BEGIN
 -- Aucune publication pendant la reprise : les écritures attendent la fin de la transaction, les lectures continuent.
 LOCK TABLE public.source_aggregates, public.ad_daily, public.meta_conversions_daily IN SHARE ROW EXCLUSIVE MODE;
 -- KPI, par jour : la tentative du manifeste que retient l'ancien lecteur (heure d'observation la plus récente parmi les
 -- tentatives complètes), si elle porte autant de lignes que son manifeste en annonce.
 FOR w IN
  WITH periods AS (
   SELECT DISTINCT source,source_namespace,report_profile_key,period_from,period_to FROM public.source_aggregates
   WHERE report_profile_key='kpi-funnel-sources-v1' AND metric_key='kpi_daily_manifest' AND source IN ('meta','posthog','wix')
  ), winners AS (
   SELECT p.*,(SELECT m.sync_run_id FROM public.source_aggregates m JOIN public.sync_runs r ON r.id=m.sync_run_id
    WHERE m.source=p.source AND m.source_namespace=p.source_namespace AND m.report_profile_key=p.report_profile_key
     AND m.period_from=p.period_from AND m.period_to=p.period_to AND m.metric_key='kpi_daily_manifest'
     AND r.stream_key='kpi_'||p.source||'_daily' AND r.status IN ('complete','empty') AND r.pagination_complete AND r.rows_rejected=0
     AND m.value=(SELECT count(*) FROM public.source_aggregates x WHERE x.sync_run_id=m.sync_run_id AND x.source=m.source AND x.source_namespace=m.source_namespace
      AND x.report_profile_key=m.report_profile_key AND x.period_from=m.period_from AND x.period_to=m.period_to AND x.metric_key='kpi_daily_row')
    ORDER BY (m.dimensions->>'observedAt')::timestamptz DESC NULLS LAST,r.source_as_of DESC,r.started_at DESC,r.id DESC LIMIT 1) AS run_id
   FROM periods p
  )
  SELECT * FROM winners q WHERE q.run_id IS NOT NULL AND (
   EXISTS(SELECT FROM public.source_aggregates c WHERE c.is_current AND c.sync_run_id<>q.run_id AND c.source=q.source AND c.source_namespace=q.source_namespace
    AND c.report_profile_key=q.report_profile_key AND c.period_from=q.period_from AND c.period_to=q.period_to AND c.metric_key IN ('kpi_daily_row','kpi_daily_manifest'))
   OR EXISTS(SELECT FROM public.source_aggregates s WHERE NOT s.is_current AND s.sync_run_id=q.run_id AND s.source=q.source AND s.source_namespace=q.source_namespace
    AND s.report_profile_key=q.report_profile_key AND s.period_from=q.period_from AND s.period_to=q.period_to AND s.metric_key IN ('kpi_daily_row','kpi_daily_manifest')))
 LOOP
  UPDATE public.source_aggregates c SET is_current=false WHERE c.is_current AND c.sync_run_id<>w.run_id AND c.source=w.source AND c.source_namespace=w.source_namespace
   AND c.report_profile_key=w.report_profile_key AND c.period_from=w.period_from AND c.period_to=w.period_to AND c.metric_key IN ('kpi_daily_row','kpi_daily_manifest');
  GET DIAGNOSTICS n=ROW_COUNT;k_retired=k_retired+n;
  UPDATE public.source_aggregates s SET is_current=true WHERE NOT s.is_current AND s.sync_run_id=w.run_id AND s.source=w.source AND s.source_namespace=w.source_namespace
   AND s.report_profile_key=w.report_profile_key AND s.period_from=w.period_from AND s.period_to=w.period_to AND s.metric_key IN ('kpi_daily_row','kpi_daily_manifest');
  GET DIAGNOSTICS n=ROW_COUNT;k_promoted=k_promoted+n;k_periods=k_periods+1;
 END LOOP;
 -- Masterclass, par période exacte : la dernière tentative complète de la période avec une ligne « all » (lecture exact_report).
 FOR w IN
  WITH periods AS (
   SELECT DISTINCT source_namespace,report_profile_key,period_from,period_to FROM public.source_aggregates WHERE source='posthog' AND metric_key='posthog_mc_events'
  ), winners AS (
   SELECT p.*,(SELECT r.id FROM public.sync_runs r WHERE r.source='posthog' AND r.source_namespace=p.source_namespace AND r.stream_key='masterclass_observations'
    AND r.query_profile_key=p.report_profile_key AND r.period_from=p.period_from AND r.period_to=p.period_to AND r.status IN ('complete','empty')
    AND r.pagination_complete AND r.rows_rejected=0 AND r.finished_at IS NOT NULL
    AND EXISTS(SELECT FROM public.source_aggregates a WHERE a.sync_run_id=r.id AND a.metric_key='posthog_mc_events' AND a.dimensions_key='all' AND a.value IS NOT NULL)
    ORDER BY r.source_as_of DESC,r.started_at DESC,r.id DESC LIMIT 1) AS run_id FROM periods p
  )
  SELECT * FROM winners q WHERE q.run_id IS NOT NULL AND (
   EXISTS(SELECT FROM public.source_aggregates c WHERE c.is_current AND c.sync_run_id<>q.run_id AND c.source='posthog' AND c.source_namespace=q.source_namespace
    AND c.report_profile_key=q.report_profile_key AND c.period_from=q.period_from AND c.period_to=q.period_to AND c.metric_key='posthog_mc_events')
   OR EXISTS(SELECT FROM public.source_aggregates s WHERE NOT s.is_current AND s.sync_run_id=q.run_id AND s.metric_key='posthog_mc_events'))
 LOOP
  UPDATE public.source_aggregates c SET is_current=false WHERE c.is_current AND c.sync_run_id<>w.run_id AND c.source='posthog' AND c.source_namespace=w.source_namespace
   AND c.report_profile_key=w.report_profile_key AND c.period_from=w.period_from AND c.period_to=w.period_to AND c.metric_key='posthog_mc_events';
  GET DIAGNOSTICS n=ROW_COUNT;m_retired=m_retired+n;
  UPDATE public.source_aggregates s SET is_current=true WHERE NOT s.is_current AND s.sync_run_id=w.run_id AND s.metric_key='posthog_mc_events';
  GET DIAGNOSTICS n=ROW_COUNT;m_promoted=m_promoted+n;m_periods=m_periods+1;
 END LOOP;
 -- Publicités par jour : règle de v_ad_daily (dernière tentative complète couvrant la date, pour l'espace de la publicité).
 FOR w IN
  WITH days AS (SELECT DISTINCT a.source_namespace,d.date FROM public.ad_daily d JOIN public.ads a ON a.id=d.ad_id WHERE a.source='meta'),
  winners AS (
   SELECT days.*,(SELECT s.id FROM public.sync_runs s WHERE s.source='meta' AND s.source_namespace=days.source_namespace AND s.stream_key='ad_daily'
    AND s.status IN ('complete','empty') AND s.pagination_complete AND s.rows_rejected=0 AND s.date_from<=days.date AND s.date_to>days.date
    ORDER BY s.source_as_of DESC,s.started_at DESC,s.id DESC LIMIT 1) AS run_id FROM days
  )
  SELECT * FROM winners q WHERE q.run_id IS NOT NULL AND (
   EXISTS(SELECT FROM public.ad_daily c JOIN public.ads a ON a.id=c.ad_id WHERE c.is_current AND c.sync_run_id<>q.run_id AND c.date=q.date AND a.source='meta' AND a.source_namespace=q.source_namespace)
   OR EXISTS(SELECT FROM public.ad_daily s WHERE NOT s.is_current AND s.sync_run_id=q.run_id AND s.date=q.date))
 LOOP
  UPDATE public.ad_daily c SET is_current=false FROM public.ads a
  WHERE a.id=c.ad_id AND a.source='meta' AND a.source_namespace=w.source_namespace AND c.is_current AND c.sync_run_id<>w.run_id AND c.date=w.date;
  GET DIAGNOSTICS n=ROW_COUNT;d_retired=d_retired+n;
  UPDATE public.ad_daily s SET is_current=true WHERE NOT s.is_current AND s.sync_run_id=w.run_id AND s.date=w.date;
  GET DIAGNOSTICS n=ROW_COUNT;d_promoted=d_promoted+n;d_periods=d_periods+1;
 END LOOP;
 -- Conversions : règle de v_meta_conversions_daily (profil de rapport préfixé par celui de la tentative).
 FOR w IN
  WITH keys AS (SELECT DISTINCT a.source_namespace,d.date,d.report_profile_key FROM public.meta_conversions_daily d JOIN public.ads a ON a.id=d.ad_id WHERE a.source='meta'),
  winners AS (
   SELECT keys.*,(SELECT s.id FROM public.sync_runs s WHERE s.source='meta' AND s.source_namespace=keys.source_namespace AND s.stream_key='ad_daily'
    AND s.status IN ('complete','empty') AND s.pagination_complete AND s.rows_rejected=0 AND s.date_from<=keys.date AND s.date_to>keys.date
    AND keys.report_profile_key LIKE s.query_profile_key||':%' ORDER BY s.source_as_of DESC,s.started_at DESC,s.id DESC LIMIT 1) AS run_id FROM keys
  )
  SELECT * FROM winners q WHERE q.run_id IS NOT NULL AND (
   EXISTS(SELECT FROM public.meta_conversions_daily c JOIN public.ads a ON a.id=c.ad_id WHERE c.is_current AND c.sync_run_id<>q.run_id AND c.date=q.date
    AND c.report_profile_key=q.report_profile_key AND a.source='meta' AND a.source_namespace=q.source_namespace)
   OR EXISTS(SELECT FROM public.meta_conversions_daily s WHERE NOT s.is_current AND s.sync_run_id=q.run_id AND s.date=q.date AND s.report_profile_key=q.report_profile_key))
 LOOP
  UPDATE public.meta_conversions_daily c SET is_current=false FROM public.ads a
  WHERE a.id=c.ad_id AND a.source='meta' AND a.source_namespace=w.source_namespace AND c.is_current AND c.sync_run_id<>w.run_id AND c.date=w.date AND c.report_profile_key=w.report_profile_key;
  GET DIAGNOSTICS n=ROW_COUNT;c_retired=c_retired+n;
  UPDATE public.meta_conversions_daily s SET is_current=true WHERE NOT s.is_current AND s.sync_run_id=w.run_id AND s.date=w.date AND s.report_profile_key=w.report_profile_key;
  GET DIAGNOSTICS n=ROW_COUNT;c_promoted=c_promoted+n;c_periods=c_periods+1;
 END LOOP;
 RETURN jsonb_build_object(
  'kpi',jsonb_build_object('periods',k_periods,'retired',k_retired,'promoted',k_promoted),
  'masterclass',jsonb_build_object('periods',m_periods,'retired',m_retired,'promoted',m_promoted),
  'ad_daily',jsonb_build_object('periods',d_periods,'retired',d_retired,'promoted',d_promoted),
  'meta_conversions_daily',jsonb_build_object('periods',c_periods,'retired',c_retired,'promoted',c_promoted));
END $$;

REVOKE ALL ON FUNCTION public.cockpit_cleanup_staged(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_resume_current_state() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_cleanup_staged(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_resume_current_state() TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(19) ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Retour arrière (aucune donnée concernée ; les lignes déjà supprimées étaient des lignes préparées jamais publiées ;
-- cockpit_resume_current_state n'est appelée qu'à la main et ne supprime rien) :
-- 1. redéployer d'abord un code qui n'appelle plus cockpit_cleanup_staged (sinon le tick signale seulement
--    « cleanup: schema_missing », sans échouer) ;
-- 2. puis :
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.cockpit_cleanup_staged(integer);
-- DROP FUNCTION IF EXISTS public.cockpit_resume_current_state();
-- DELETE FROM public.cockpit_migrations WHERE version = 19;
-- COMMIT;
