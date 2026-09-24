-- Migration 22 · réapparition d'un objet retiré = la même ligne redevient courante (reprise CP2, 24 septembre).
-- Constat (tests/state-days.integration.ts, migrations ≤ 021) : un objet retiré de l'état courant (fenêtre CTRU non lue à un
-- passage, campagne absente d'une lecture, publicité sans ligne un jour) puis présent à la lecture suivante était promu comme
-- un NOUVEL objet : la ligne retirée restait à côté d'une nouvelle ligne courante, une ligne de plus à chaque aller-retour.
-- Règle (Mehdi, 23 septembre) : un objet source = un enregistrement courant ; modification = mise à jour du même objet.
--
-- Remplace (CREATE OR REPLACE, signatures et réponses inchangées, un compteur « reappeared » ajouté à l'état) :
-- 1. cockpit_apply_aggregate_state (018) : après la fusion des objets déjà courants, une ligne préparée sans ligne courante de
--    même clé mais avec une ligne non courante de même clé issue d'une tentative terminée (ligne retirée, ou version
--    antérieure à 018) est supprimée, et cette ligne (la plus récente par tentative) reçoit ses valeurs, la tentative et
--    is_current = true. Les lignes préparées restantes sont de vrais nouveaux objets (promues comme en 018).
-- 2. cockpit_publish_meta_daily (018) : même règle pour ad_daily (publicité, jour, profil) et meta_conversions_daily.
-- Lecteurs inchangés (ils lisent is_current et la tentative des lignes courantes). Rien n'est supprimé ni ajouté par la
-- migration elle-même ; les doublons éventuellement créés avant elle restent en place (aucune purge).
-- Rejouable : CREATE OR REPLACE, droits réappliqués, version inscrite une fois.
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
 ), applied AS (
  UPDATE public.source_aggregates c SET sync_run_id=p_run,timezone=staged.timezone,coverage_state=staged.coverage_state,value=staged.value,unit=staged.unit,
   currency=staged.currency,currency_exponent=staged.currency_exponent,tax_basis=staged.tax_basis,dimensions=staged.dimensions,
   definition_version=staged.definition_version,source_locator=staged.source_locator
  FROM staged WHERE c.id=staged.current_id RETURNING staged.same
 ) SELECT count(*) FILTER(WHERE same),count(*) FILTER(WHERE NOT same) INTO n_confirmed,n_changed FROM applied;
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
  DELETE FROM public.source_aggregates s USING candidates c WHERE s.id=c.staged_id AND c.retired_id IS NOT NULL
  RETURNING c.retired_id,s.timezone,s.coverage_state,s.value,s.unit,s.currency,s.currency_exponent,s.tax_basis,s.dimensions,s.definition_version,s.source_locator
 ), revived AS (
  UPDATE public.source_aggregates x SET is_current=true,sync_run_id=p_run,timezone=moved.timezone,coverage_state=moved.coverage_state,value=moved.value,unit=moved.unit,
   currency=moved.currency,currency_exponent=moved.currency_exponent,tax_basis=moved.tax_basis,dimensions=moved.dimensions,
   definition_version=moved.definition_version,source_locator=moved.source_locator
  FROM moved WHERE x.id=moved.retired_id AND NOT x.is_current RETURNING 1
 ) SELECT count(*) INTO n_reappeared FROM revived;
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

CREATE OR REPLACE FUNCTION public.cockpit_publish_meta_daily(p_run uuid,p_read integer,p_rejected integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; stamp timestamptz; v_status text; staged integer;
 d_confirmed integer=0; d_changed integer=0; d_retired integer=0; d_inserted integer=0; d_current integer=0; d_reappeared integer=0;
 c_confirmed integer=0; c_changed integer=0; c_retired integer=0; c_inserted integer=0; c_current integer=0; c_reappeared integer=0; n_cleaned integer=0; n integer; state jsonb;
BEGIN
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run AND source='meta' AND stream_key='ad_daily' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'inactive run' USING ERRCODE='55000';END IF;
 IF r.status IN ('complete','empty') THEN
  RETURN jsonb_build_object('status',r.status,'duplicate',true,'rowsWritten',r.rows_written,'state',r.checkpoint->'state');
 END IF;
 IF r.status<>'running' THEN RAISE EXCEPTION 'inactive run' USING ERRCODE='55000';END IF;
 IF p_read IS NULL OR p_read<0 OR p_rejected IS DISTINCT FROM 0 OR r.date_from IS NULL OR r.date_to IS NULL THEN
  RAISE EXCEPTION 'incomplete Meta publication' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO staged FROM public.ad_daily WHERE sync_run_id=p_run AND NOT is_current;
 -- ad_daily : objets déjà courants (018).
 WITH staged_rows AS (
  DELETE FROM public.ad_daily s USING public.ad_daily c
  WHERE s.sync_run_id=p_run AND NOT s.is_current AND c.is_current AND c.ad_id=s.ad_id AND c.date=s.date AND c.base_profile_key=s.base_profile_key
  RETURNING c.id AS current_id,s.timezone,s.currency,s.currency_exponent,s.spend_minor,s.impressions,s.outbound_clicks,s.row_state,s.campaign_id,s.campaign_name,s.ad_name,
   (c.timezone=s.timezone AND c.currency=s.currency AND c.currency_exponent=s.currency_exponent AND c.spend_minor IS NOT DISTINCT FROM s.spend_minor
    AND c.impressions IS NOT DISTINCT FROM s.impressions AND c.outbound_clicks IS NOT DISTINCT FROM s.outbound_clicks AND c.row_state=s.row_state
    AND c.campaign_id IS NOT DISTINCT FROM s.campaign_id AND c.campaign_name IS NOT DISTINCT FROM s.campaign_name AND c.ad_name IS NOT DISTINCT FROM s.ad_name) AS same
 ), applied AS (
  UPDATE public.ad_daily c SET sync_run_id=p_run,timezone=staged_rows.timezone,currency=staged_rows.currency,currency_exponent=staged_rows.currency_exponent,
   spend_minor=staged_rows.spend_minor,impressions=staged_rows.impressions,outbound_clicks=staged_rows.outbound_clicks,row_state=staged_rows.row_state,
   campaign_id=staged_rows.campaign_id,campaign_name=staged_rows.campaign_name,ad_name=staged_rows.ad_name
  FROM staged_rows WHERE c.id=staged_rows.current_id RETURNING staged_rows.same
 ) SELECT count(*) FILTER(WHERE same),count(*) FILTER(WHERE NOT same) INTO d_confirmed,d_changed FROM applied;
 -- ad_daily : objets réapparus (022) : la ligne retirée (ou la version antérieure la plus récente) redevient courante.
 WITH candidates AS (
  SELECT s.id AS staged_id,
   (SELECT x.id FROM public.ad_daily x JOIN public.sync_runs xr ON xr.id=x.sync_run_id
     WHERE NOT x.is_current AND x.sync_run_id<>p_run AND xr.status IN ('complete','empty') AND x.ad_id=s.ad_id AND x.date=s.date AND x.base_profile_key=s.base_profile_key
     ORDER BY xr.started_at DESC,x.id DESC LIMIT 1) AS retired_id
  FROM public.ad_daily s WHERE s.sync_run_id=p_run AND NOT s.is_current
 ), moved AS (
  DELETE FROM public.ad_daily s USING candidates c WHERE s.id=c.staged_id AND c.retired_id IS NOT NULL
  RETURNING c.retired_id,s.timezone,s.currency,s.currency_exponent,s.spend_minor,s.impressions,s.outbound_clicks,s.row_state,s.campaign_id,s.campaign_name,s.ad_name
 ), revived AS (
  UPDATE public.ad_daily x SET is_current=true,sync_run_id=p_run,timezone=moved.timezone,currency=moved.currency,currency_exponent=moved.currency_exponent,
   spend_minor=moved.spend_minor,impressions=moved.impressions,outbound_clicks=moved.outbound_clicks,row_state=moved.row_state,
   campaign_id=moved.campaign_id,campaign_name=moved.campaign_name,ad_name=moved.ad_name
  FROM moved WHERE x.id=moved.retired_id AND NOT x.is_current RETURNING 1
 ) SELECT count(*) INTO d_reappeared FROM revived;
 UPDATE public.ad_daily c SET is_current=false FROM public.ads a
 WHERE a.id=c.ad_id AND a.source='meta' AND a.source_namespace=r.source_namespace AND c.is_current AND c.sync_run_id<>p_run AND c.date>=r.date_from AND c.date<r.date_to;
 GET DIAGNOSTICS d_retired=ROW_COUNT;
 UPDATE public.ad_daily SET is_current=true WHERE sync_run_id=p_run AND NOT is_current;
 GET DIAGNOSTICS d_inserted=ROW_COUNT;
 -- meta_conversions_daily : objets déjà courants (018).
 WITH staged_rows AS (
  DELETE FROM public.meta_conversions_daily s USING public.meta_conversions_daily c
  WHERE s.sync_run_id=p_run AND NOT s.is_current AND c.is_current AND c.ad_id=s.ad_id AND c.date=s.date AND c.report_profile_key=s.report_profile_key
   AND c.action_type=s.action_type AND c.metric_kind=s.metric_kind
  RETURNING c.id AS current_id,s.action_count,s.action_value_minor,s.currency,s.currency_exponent,s.timezone,s.report_profile,
   (c.action_count IS NOT DISTINCT FROM s.action_count AND c.action_value_minor IS NOT DISTINCT FROM s.action_value_minor AND c.currency IS NOT DISTINCT FROM s.currency
    AND c.currency_exponent IS NOT DISTINCT FROM s.currency_exponent AND c.timezone=s.timezone AND c.report_profile=s.report_profile) AS same
 ), applied AS (
  UPDATE public.meta_conversions_daily c SET sync_run_id=p_run,action_count=staged_rows.action_count,action_value_minor=staged_rows.action_value_minor,
   currency=staged_rows.currency,currency_exponent=staged_rows.currency_exponent,timezone=staged_rows.timezone,report_profile=staged_rows.report_profile
  FROM staged_rows WHERE c.id=staged_rows.current_id RETURNING staged_rows.same
 ) SELECT count(*) FILTER(WHERE same),count(*) FILTER(WHERE NOT same) INTO c_confirmed,c_changed FROM applied;
 -- meta_conversions_daily : objets réapparus (022).
 WITH candidates AS (
  SELECT s.id AS staged_id,
   (SELECT x.id FROM public.meta_conversions_daily x JOIN public.sync_runs xr ON xr.id=x.sync_run_id
     WHERE NOT x.is_current AND x.sync_run_id<>p_run AND xr.status IN ('complete','empty') AND x.ad_id=s.ad_id AND x.date=s.date AND x.report_profile_key=s.report_profile_key
      AND x.action_type=s.action_type AND x.metric_kind=s.metric_kind
     ORDER BY xr.started_at DESC,x.id DESC LIMIT 1) AS retired_id
  FROM public.meta_conversions_daily s WHERE s.sync_run_id=p_run AND NOT s.is_current
 ), moved AS (
  DELETE FROM public.meta_conversions_daily s USING candidates c WHERE s.id=c.staged_id AND c.retired_id IS NOT NULL
  RETURNING c.retired_id,s.action_count,s.action_value_minor,s.currency,s.currency_exponent,s.timezone,s.report_profile
 ), revived AS (
  UPDATE public.meta_conversions_daily x SET is_current=true,sync_run_id=p_run,action_count=moved.action_count,action_value_minor=moved.action_value_minor,
   currency=moved.currency,currency_exponent=moved.currency_exponent,timezone=moved.timezone,report_profile=moved.report_profile
  FROM moved WHERE x.id=moved.retired_id AND NOT x.is_current RETURNING 1
 ) SELECT count(*) INTO c_reappeared FROM revived;
 UPDATE public.meta_conversions_daily c SET is_current=false FROM public.ads a
 WHERE a.id=c.ad_id AND a.source='meta' AND a.source_namespace=r.source_namespace AND c.is_current AND c.sync_run_id<>p_run AND c.date>=r.date_from AND c.date<r.date_to
  AND left(c.report_profile_key,length(r.query_profile_key)+1)=r.query_profile_key||':';
 GET DIAGNOSTICS c_retired=ROW_COUNT;
 UPDATE public.meta_conversions_daily SET is_current=true WHERE sync_run_id=p_run AND NOT is_current;
 GET DIAGNOSTICS c_inserted=ROW_COUNT;
 -- Nettoyage borné (018, inchangé) : lignes jamais publiées de tentatives Meta en échec de plus de 24 h, commencées après 018.
 DELETE FROM public.meta_conversions_daily s WHERE s.id IN (SELECT x.id FROM public.meta_conversions_daily x JOIN public.sync_runs f ON f.id=x.sync_run_id
  WHERE NOT x.is_current AND f.status='failed' AND f.source='meta' AND f.stream_key='ad_daily' AND f.source_namespace=r.source_namespace AND f.started_at<clock_timestamp()-interval '24 hours' AND f.started_at>=(SELECT applied_at FROM public.cockpit_migrations WHERE version=18) LIMIT 5000);
 GET DIAGNOSTICS n=ROW_COUNT;n_cleaned=n;
 DELETE FROM public.ad_daily s WHERE s.id IN (SELECT x.id FROM public.ad_daily x JOIN public.sync_runs f ON f.id=x.sync_run_id
  WHERE NOT x.is_current AND f.status='failed' AND f.source='meta' AND f.stream_key='ad_daily' AND f.source_namespace=r.source_namespace AND f.started_at<clock_timestamp()-interval '24 hours' AND f.started_at>=(SELECT applied_at FROM public.cockpit_migrations WHERE version=18) LIMIT 5000);
 GET DIAGNOSTICS n=ROW_COUNT;n_cleaned=n_cleaned+n;
 SELECT count(*) INTO d_current FROM public.ad_daily c JOIN public.ads a ON a.id=c.ad_id
 WHERE c.is_current AND a.source='meta' AND a.source_namespace=r.source_namespace AND c.date>=r.date_from AND c.date<r.date_to;
 SELECT count(*) INTO c_current FROM public.meta_conversions_daily c JOIN public.ads a ON a.id=c.ad_id
 WHERE c.is_current AND a.source='meta' AND a.source_namespace=r.source_namespace AND c.date>=r.date_from AND c.date<r.date_to
  AND left(c.report_profile_key,length(r.query_profile_key)+1)=r.query_profile_key||':';
 state=jsonb_build_object('inserted',d_inserted,'changed',d_changed,'confirmed',d_confirmed,'retired',d_retired,'reappeared',d_reappeared,'cleaned',n_cleaned,
  'conversions',jsonb_build_object('inserted',c_inserted,'changed',c_changed,'confirmed',c_confirmed,'retired',c_retired,'reappeared',c_reappeared,'current',c_current));
 stamp=clock_timestamp();v_status=CASE WHEN staged=0 THEN 'empty' ELSE 'complete' END;
 UPDATE public.sync_runs SET status=v_status,finished_at=stamp,pagination_complete=true,covered_from=period_from,covered_to=period_to,
  rows_read=p_read,rows_rejected=0,rows_written=d_current,error_code=NULL,checkpoint=checkpoint||jsonb_build_object('state',state) WHERE id=p_run;
 RETURN jsonb_build_object('status',v_status,'duplicate',false,'rowsWritten',d_current,'state',state);
END $$;

REVOKE ALL ON FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_publish_meta_daily(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_publish_meta_daily(uuid,integer,integer) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(22) ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Retour arrière (aucune donnée concernée : les lignes redevenues courantes par 022 sont lues exactement comme des lignes
-- courantes de 018) : réappliquer les corps 018 des deux fonctions, c'est-à-dire exécuter de nouveau la partie de
-- supabase/migrations/018_current_state_by_stable_key.sql qui va de « CREATE OR REPLACE FUNCTION public.cockpit_apply_aggregate_state »
-- à la fin de « cockpit_publish_meta_daily » (les deux CREATE OR REPLACE, sans la reprise des données ni l'INSERT de version),
-- puis : DELETE FROM public.cockpit_migrations WHERE version = 22;
-- Le code (src/lib) n'a pas changé avec cette migration : aucun redéploiement nécessaire ; le compteur « reappeared »
-- disparaît simplement des états publiés ensuite.
