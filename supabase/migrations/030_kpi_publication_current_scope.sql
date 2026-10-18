-- Migration 030: scope the first aggregate publication join once on each side.
-- The previous function is migration 025. Only its first matching CTE changes:
-- explicit projections + materialized staging/current scopes permit a hash join.
-- All equality comparisons, stable IDs, disjoint UPDATE paths, scope assertions,
-- reappearance, retirement, cleanup, publication acknowledgement and grants remain.
-- No new index, server setting, timeout, source definition or retention change.
-- Transactional equivalence and mutation plans must pass CI before production review.
-- Rollback: restore cockpit_apply_aggregate_state from migration 025; no data rewrite.
BEGIN;

-- Refuse missing or drifted code before changing any function. A precise replay is allowed.
DO $preflight$
DECLARE p pg_proc; body_hash text;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.cockpit_apply_aggregate_state(uuid,text[],boolean)');
 IF NOT FOUND THEN RAISE EXCEPTION 'aggregate state baseline missing' USING ERRCODE='55000';END IF;
 body_hash=encode(pg_catalog.sha256(convert_to(p.prosrc,'UTF8')),'hex');
 IF body_hash NOT IN ('0c8d2ec6cd4158a62c7329902d321905176be3586b06dabeef1eaa7a490bc50b','13effce932dde6c38ef054c8467513b95fc7c490da324359927b796e2d7c2246')
  OR p.prorettype<>'jsonb'::regtype OR p.proargnames IS DISTINCT FROM ARRAY['p_run','p_metric_keys','p_exact']::text[]
  OR p.prosecdef OR p.proisstrict OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.prokind<>'f'
  OR p.pronargdefaults<>0 OR p.proleakproof
  OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
  OR has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE') THEN
  RAISE EXCEPTION 'aggregate state baseline drift' USING ERRCODE='55000';
 END IF;
END $preflight$;

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
 WITH staged_scope AS MATERIALIZED (
  SELECT id,source,source_namespace,report_profile_key,metric_key,period_from,period_to,dimensions_key,timezone,coverage_state,value,unit,currency,currency_exponent,tax_basis,dimensions,definition_version,source_locator FROM public.source_aggregates
  WHERE sync_run_id=p_run AND NOT is_current
 ), current_scope AS MATERIALIZED (
  SELECT id,source,source_namespace,report_profile_key,metric_key,period_from,period_to,dimensions_key,timezone,coverage_state,value,unit,currency,currency_exponent,tax_basis,dimensions,definition_version,source_locator FROM public.source_aggregates c
  WHERE c.is_current AND c.source=r.source AND c.source_namespace=r.source_namespace
   AND c.report_profile_key=r.query_profile_key AND c.metric_key=ANY(p_metric_keys)
   AND CASE WHEN p_exact THEN c.period_from=r.period_from AND c.period_to=r.period_to
       ELSE c.period_from>=r.period_from AND c.period_to<=r.period_to END
 ), matches AS MATERIALIZED (
  SELECT s.id AS staged_id,c.id AS current_id,(c.value IS NOT DISTINCT FROM s.value AND c.dimensions=s.dimensions AND c.timezone=s.timezone AND c.coverage_state=s.coverage_state
    AND c.unit=s.unit AND c.currency IS NOT DISTINCT FROM s.currency AND c.currency_exponent IS NOT DISTINCT FROM s.currency_exponent
    AND c.tax_basis=s.tax_basis AND c.definition_version=s.definition_version AND c.source_locator=s.source_locator) AS same
  FROM staged_scope s JOIN current_scope c
   ON c.source=s.source AND c.source_namespace=s.source_namespace AND c.report_profile_key=s.report_profile_key
   AND c.metric_key=s.metric_key AND c.period_from=s.period_from AND c.period_to=s.period_to AND c.dimensions_key=s.dimensions_key
 ), staged AS (
  DELETE FROM public.source_aggregates s USING matches m
  WHERE s.id=m.staged_id
  RETURNING m.current_id,s.timezone,s.coverage_state,s.value,s.unit,s.currency,s.currency_exponent,s.tax_basis,s.dimensions,s.definition_version,s.source_locator,m.same ), confirmed AS (
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
INSERT INTO public.cockpit_migrations(version) VALUES(30) ON CONFLICT (version) DO NOTHING;
COMMIT;
