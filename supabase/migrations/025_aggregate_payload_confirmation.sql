-- Migration 25: unchanged aggregate confirmations assign only the publication run.
-- Generated with `supabase migration new aggregate_payload_confirmation`, then normalized
-- to the repository INTEGER registry and 3-digit migration filename convention.
-- Scope: cockpit_apply_aggregate_state (KPI daily/windows and Masterclass only).
-- Stable IDs, exact keys, all payload comparisons, retirement/reappearance, acknowledgements
-- and readers stay unchanged. A changed observation/manifest is a changed payload.
-- This is NOT content deduplication: full staging copies, tuple/index updates, existing history
-- and normal growth remain. No durable row purge or storage gain is claimed.
-- Current and reappeared unchanged rows avoid payload assignment; only their run/currentness changes.
-- The two UPDATE paths in each branch are disjoint; both depend on the same DELETE RETURNING staging CTE.
-- Reversible: restore only cockpit_apply_aggregate_state from migration 022; no data rewrite.
BEGIN;

CREATE OR REPLACE FUNCTION public.cockpit_apply_aggregate_state(p_run uuid,p_metric_keys text[],p_exact boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; n_confirmed integer=0; n_changed integer=0; n_retired integer=0; n_inserted integer=0; n_current integer=0; n_cleaned integer=0; n_reappeared integer=0;
BEGIN
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run;
 IF NOT FOUND OR r.status<>'running' THEN RAISE EXCEPTION 'inactive run' USING ERRCODE='55000';END IF;
 IF p_metric_keys IS NULL OR cardinality(p_metric_keys)=0 OR p_exact IS NULL THEN RAISE EXCEPTION 'invalid state scope' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT FROM public.source_aggregates s WHERE s.sync_run_id=p_run AND (s.is_current OR s.metric_key<>ALL(p_metric_keys)
   OR s.source<>r.source OR s.source_namespace<>r.source_namespace OR s.report_profile_key<>r.query_profile_key
   OR s.period_from<r.period_from OR s.period_to>r.period_to OR (p_exact AND (s.period_from<>r.period_from OR s.period_to<>r.period_to)))) THEN
  RAISE EXCEPTION 'staged rows outside publication scope' USING ERRCODE='23514';END IF;
 -- 1. Objets déjà courants : la ligne préparée est supprimée, la ligne courante (même id) est confirmée ou mise à jour.
 WITH staged AS (
  DELETE FROM public.source_aggregates s USING public.source_aggregates c
  WHERE s.sync_run_id=p_run AND NOT s.is_current AND c.is_current
   AND c.source=s.source AND c.source_namespace=s.source_namespace AND c.report_profile_key=s.report_profile_key
   AND c.metric_key=s.metric_key AND c.period_from=s.period_from AND c.period_to=s.period_to AND c.dimensions_key=s.dimensions_key
  RETURNING c.id AS current_id,s.timezone,s.coverage_state,s.value,s.unit,s.currency,s.currency_exponent,s.tax_basis,s.dimensions,s.definition_version,s.source_locator,
   (c.value IS NOT DISTINCT FROM s.value AND c.dimensions=s.dimensions AND c.timezone=s.timezone AND c.coverage_state=s.coverage_state
    AND c.unit=s.unit AND c.currency IS NOT DISTINCT FROM s.currency AND c.currency_exponent IS NOT DISTINCT FROM s.currency_exponent
    AND c.tax_basis=s.tax_basis AND c.definition_version=s.definition_version AND c.source_locator=s.source_locator) AS same
 ), confirmed AS (
  -- Readers require the new run on EVERY row, even when the content is unchanged.
  -- Do not assign payload columns on this path; the staged copy is still consumed.
  UPDATE public.source_aggregates c SET sync_run_id=p_run
  FROM staged WHERE c.id=staged.current_id AND staged.same RETURNING 1
 ), changed AS (
  UPDATE public.source_aggregates c SET sync_run_id=p_run,timezone=staged.timezone,coverage_state=staged.coverage_state,value=staged.value,unit=staged.unit,
   currency=staged.currency,currency_exponent=staged.currency_exponent,tax_basis=staged.tax_basis,dimensions=staged.dimensions,
   definition_version=staged.definition_version,source_locator=staged.source_locator
  FROM staged WHERE c.id=staged.current_id AND NOT staged.same RETURNING 1
 ) SELECT (SELECT count(*) FROM confirmed),(SELECT count(*) FROM changed) INTO n_confirmed,n_changed;
 -- 1b (022). Objets réapparus : aucune ligne courante de même clé, mais une ligne non courante de même clé issue d'une
 --     tentative terminée (ligne retirée, ou version antérieure à 018) : la ligne préparée est supprimée et cette ligne (la
 --     plus récente par tentative) redevient courante avec les valeurs lues et la tentative. La mise à jour consomme la
 --     sortie de la suppression (contrainte d'unicité par tentative, même mécanique que 018 et 020).
 WITH candidates AS (
  SELECT s.id AS staged_id,
   (SELECT x.id FROM public.source_aggregates x JOIN public.sync_runs xr ON xr.id=x.sync_run_id
     WHERE NOT x.is_current AND x.sync_run_id<>p_run AND xr.status IN ('complete','empty')
      AND x.source=s.source AND x.source_namespace=s.source_namespace AND x.report_profile_key=s.report_profile_key
      AND x.metric_key=s.metric_key AND x.period_from=s.period_from AND x.period_to=s.period_to AND x.dimensions_key=s.dimensions_key
     ORDER BY xr.started_at DESC,x.id DESC LIMIT 1) AS retired_id
  FROM public.source_aggregates s WHERE s.sync_run_id=p_run AND NOT s.is_current
 ), moved AS (
  DELETE FROM public.source_aggregates s USING candidates c,public.source_aggregates x
  WHERE s.id=c.staged_id AND x.id=c.retired_id
  RETURNING c.retired_id,s.timezone,s.coverage_state,s.value,s.unit,s.currency,s.currency_exponent,s.tax_basis,s.dimensions,s.definition_version,s.source_locator,
   (x.value IS NOT DISTINCT FROM s.value AND x.dimensions=s.dimensions AND x.timezone=s.timezone AND x.coverage_state=s.coverage_state
    AND x.unit=s.unit AND x.currency IS NOT DISTINCT FROM s.currency AND x.currency_exponent IS NOT DISTINCT FROM s.currency_exponent
    AND x.tax_basis=s.tax_basis AND x.definition_version=s.definition_version AND x.source_locator=s.source_locator) AS same
 ), revived_confirmed AS (
  UPDATE public.source_aggregates x SET is_current=true,sync_run_id=p_run
  FROM moved WHERE x.id=moved.retired_id AND NOT x.is_current AND moved.same RETURNING 1
 ), revived_changed AS (
  UPDATE public.source_aggregates x SET is_current=true,sync_run_id=p_run,timezone=moved.timezone,coverage_state=moved.coverage_state,value=moved.value,unit=moved.unit,
   currency=moved.currency,currency_exponent=moved.currency_exponent,tax_basis=moved.tax_basis,dimensions=moved.dimensions,
   definition_version=moved.definition_version,source_locator=moved.source_locator
  FROM moved WHERE x.id=moved.retired_id AND NOT x.is_current AND NOT moved.same RETURNING 1
 ) SELECT (SELECT count(*) FROM revived_confirmed)+(SELECT count(*) FROM revived_changed) INTO n_reappeared;
 -- 2. Objets disparus du périmètre : retirés de l'état courant, conservés.
 UPDATE public.source_aggregates c SET is_current=false
 WHERE c.is_current AND c.sync_run_id<>p_run AND c.source=r.source AND c.source_namespace=r.source_namespace
  AND c.report_profile_key=r.query_profile_key AND c.metric_key=ANY(p_metric_keys)
  AND CASE WHEN p_exact THEN c.period_from=r.period_from AND c.period_to=r.period_to ELSE c.period_from>=r.period_from AND c.period_to<=r.period_to END;
 GET DIAGNOSTICS n_retired=ROW_COUNT;
 -- 3. Nouveaux objets : la ligne préparée devient courante.
 UPDATE public.source_aggregates s SET is_current=true WHERE s.sync_run_id=p_run AND NOT s.is_current;
 GET DIAGNOSTICS n_inserted=ROW_COUNT;
 -- 4. Nettoyage borné de la zone de préparation (018, inchangé) : lignes jamais publiées de tentatives en échec du même flux,
 --    commencées après 018 et âgées de plus de 24 h (5 000 lignes au plus par publication).
 DELETE FROM public.source_aggregates s WHERE s.id IN (
  SELECT x.id FROM public.source_aggregates x JOIN public.sync_runs f ON f.id=x.sync_run_id
  WHERE NOT x.is_current AND f.status='failed' AND f.source=r.source AND f.source_namespace=r.source_namespace
   AND f.stream_key=r.stream_key AND f.query_profile_key=r.query_profile_key AND f.started_at<clock_timestamp()-interval '24 hours' AND f.started_at>=(SELECT applied_at FROM public.cockpit_migrations WHERE version=18)
  LIMIT 5000);
 GET DIAGNOSTICS n_cleaned=ROW_COUNT;
 SELECT count(*) INTO n_current FROM public.source_aggregates c
 WHERE c.is_current AND c.source=r.source AND c.source_namespace=r.source_namespace AND c.report_profile_key=r.query_profile_key AND c.metric_key=ANY(p_metric_keys)
  AND CASE WHEN p_exact THEN c.period_from=r.period_from AND c.period_to=r.period_to ELSE c.period_from>=r.period_from AND c.period_to<=r.period_to END;
 RETURN jsonb_build_object('inserted',n_inserted,'changed',n_changed,'confirmed',n_confirmed,'retired',n_retired,'reappeared',n_reappeared,'current',n_current,'cleaned',n_cleaned);
END $$;

REVOKE ALL ON FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(25) ON CONFLICT (version) DO NOTHING;
COMMIT;
