-- Migration 18 · état courant par identifiant stable pour les flux du pilotage Masterclass.
-- Règle (Mehdi, 23 septembre) : un objet source inchangé ne produit aucune nouvelle ligne ; une modification met à jour
-- la même ligne ; un nouvel objet ajoute seulement cet objet ; un objet disparu de la source est retiré de l'état courant
-- (is_current = false) sans être effacé. Aucune purge de l'historique existant.
--
-- Principe « préparation puis publication atomique » :
--  * préparation : pendant une tentative, les lignes sont écrites comme aujourd'hui avec sync_run_id = tentative et
--    is_current = false (upsert KPI par lots, import_meta_page page par page, insertion dans cockpit_publish_posthog) ;
--  * publication : une fonction, une transaction, compare chaque ligne préparée à la ligne courante de même clé métier
--    (valeurs jsonb/numeric, jamais un texte sérialisé) : identique = ligne courante confirmée (sync_run_id = tentative),
--    différente = ligne courante mise à jour en place, absente = la ligne préparée devient courante ; la ligne préparée
--    fusionnée est supprimée (nettoyage de la zone de préparation) ; une ligne courante du périmètre absente de la
--    tentative est retirée (is_current = false), jamais effacée.
-- Les lecteurs SQL existants (cockpit_source_window, v_ad_daily, v_meta_conversions_daily) lisent « les lignes de la
-- dernière tentative complète couvrant la période » : les lignes courantes portent toujours cette tentative, ils restent
-- exacts sans modification.
--
-- Rejouable : colonnes et index « IF NOT EXISTS », fonctions « CREATE OR REPLACE », reprise des données idempotente,
-- version inscrite une fois. Aucune suppression de ligne publiée dans cette migration. Deux transactions : DDL et fonctions
-- (verrous brefs), puis reprise des données (sans blocage des lectures) qui inscrit la version.
BEGIN;

ALTER TABLE public.source_aggregates ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;
ALTER TABLE public.ad_daily ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;
ALTER TABLE public.meta_conversions_daily ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS source_aggregates_current_key ON public.source_aggregates
 (source,source_namespace,report_profile_key,metric_key,period_from,period_to,dimensions_key) WHERE is_current;
CREATE INDEX IF NOT EXISTS source_aggregates_current_read ON public.source_aggregates
 (source,source_namespace,report_profile_key,period_from) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS ad_daily_current_key ON public.ad_daily(ad_id,date,base_profile_key) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS meta_conversions_current_key ON public.meta_conversions_daily
 (ad_id,date,report_profile_key,action_type,metric_kind) WHERE is_current;

-- ---------------------------------------------------------------------------------------------------------------
-- source_aggregates : logique d'état commune (KPI quotidiens et rapport PostHog Masterclass).
-- p_exact = true : périmètre = période exacte de la tentative (rapport Masterclass, lu en « exact_report ») ;
-- p_exact = false : périmètre = toute période comprise dans [period_from, period_to] de la tentative (KPI par jour).
-- Appelée par les fonctions de publication, dans leur transaction, la tentative étant verrouillée (FOR UPDATE).
CREATE OR REPLACE FUNCTION public.cockpit_apply_aggregate_state(p_run uuid,p_metric_keys text[],p_exact boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; n_confirmed integer=0; n_changed integer=0; n_retired integer=0; n_inserted integer=0; n_current integer=0; n_cleaned integer=0;
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
 -- 2. Objets disparus du périmètre : retirés de l'état courant, conservés.
 UPDATE public.source_aggregates c SET is_current=false
 WHERE c.is_current AND c.sync_run_id<>p_run AND c.source=r.source AND c.source_namespace=r.source_namespace
  AND c.report_profile_key=r.query_profile_key AND c.metric_key=ANY(p_metric_keys)
  AND CASE WHEN p_exact THEN c.period_from=r.period_from AND c.period_to=r.period_to ELSE c.period_from>=r.period_from AND c.period_to<=r.period_to END;
 GET DIAGNOSTICS n_retired=ROW_COUNT;
 -- 3. Nouveaux objets : la ligne préparée devient courante.
 UPDATE public.source_aggregates s SET is_current=true WHERE s.sync_run_id=p_run AND NOT s.is_current;
 GET DIAGNOSTICS n_inserted=ROW_COUNT;
 -- 4. Nettoyage borné de la zone de préparation : lignes jamais publiées de tentatives en échec du même flux, âgées de
 --    plus de 24 h (5 000 lignes au plus par publication). Jamais une ligne d'une tentative complete/empty.
 DELETE FROM public.source_aggregates s WHERE s.id IN (
  SELECT x.id FROM public.source_aggregates x JOIN public.sync_runs f ON f.id=x.sync_run_id
  WHERE NOT x.is_current AND f.status='failed' AND f.source=r.source AND f.source_namespace=r.source_namespace
   AND f.stream_key=r.stream_key AND f.query_profile_key=r.query_profile_key AND f.started_at<clock_timestamp()-interval '24 hours' AND f.started_at>=(SELECT applied_at FROM public.cockpit_migrations WHERE version=18)
  LIMIT 5000);
 GET DIAGNOSTICS n_cleaned=ROW_COUNT;
 SELECT count(*) INTO n_current FROM public.source_aggregates c
 WHERE c.is_current AND c.source=r.source AND c.source_namespace=r.source_namespace AND c.report_profile_key=r.query_profile_key AND c.metric_key=ANY(p_metric_keys)
  AND CASE WHEN p_exact THEN c.period_from=r.period_from AND c.period_to=r.period_to ELSE c.period_from>=r.period_from AND c.period_to<=r.period_to END;
 RETURN jsonb_build_object('inserted',n_inserted,'changed',n_changed,'confirmed',n_confirmed,'retired',n_retired,'current',n_current,'cleaned',n_cleaned);
END $$;

-- Publication d'une tentative KPI (préparée par lots d'upsert) : état puis clôture, une transaction.
-- Rejeu (accusé perdu) : une tentative déjà terminée renvoie son accusé sans rien changer.
CREATE OR REPLACE FUNCTION public.cockpit_publish_aggregate_state(p_run uuid,p_metric_keys text[],p_read integer DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; state jsonb; staged integer; stamp timestamptz; v_status text;
BEGIN
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'inactive run' USING ERRCODE='55000';END IF;
 IF r.status IN ('complete','empty') THEN
  RETURN jsonb_build_object('status',r.status,'duplicate',true,'rowsWritten',r.rows_written,'state',r.checkpoint->'state');
 END IF;
 IF r.status<>'running' THEN RAISE EXCEPTION 'inactive run' USING ERRCODE='55000';END IF;
 IF r.stream_key NOT IN ('kpi_meta_daily','kpi_posthog_daily','kpi_wix_daily') OR p_read<0 THEN RAISE EXCEPTION 'unsupported state publication' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO staged FROM public.source_aggregates WHERE sync_run_id=p_run AND NOT is_current;
 state=public.cockpit_apply_aggregate_state(p_run,p_metric_keys,false);
 stamp=clock_timestamp();v_status=CASE WHEN (state->>'current')::integer=0 THEN 'empty' ELSE 'complete' END;
 UPDATE public.sync_runs SET status=v_status,finished_at=stamp,pagination_complete=true,covered_from=period_from,covered_to=period_to,
  rows_read=coalesce(p_read,staged),rows_written=(state->>'current')::integer,rows_rejected=0,error_code=NULL,
  checkpoint=checkpoint||jsonb_build_object('state',state-'current')
 WHERE id=p_run;
 RETURN jsonb_build_object('status',v_status,'duplicate',false,'rowsWritten',(state->>'current')::integer,'state',state);
END $$;

-- PostHog : même publication qu'en 016 ; pour masterclass_observations seulement, les lignes insérées sont préparées puis
-- fusionnées dans l'état courant de la période exacte. quiz_observations : comportement strictement inchangé.
CREATE OR REPLACE FUNCTION public.cockpit_publish_posthog(p_run uuid,p_lease uuid,p_records jsonb,p_read integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; row jsonb; stamp timestamptz=clock_timestamp(); digest_hex text; count_rows integer; names jsonb; name text; keys text[]; metric text; value_numeric numeric; state jsonb; written integer;
BEGIN
 IF p_records IS NULL OR jsonb_typeof(p_records) IS DISTINCT FROM 'array' OR octet_length(p_records::text)>2000000 OR jsonb_array_length(p_records)>750 OR p_read IS NULL OR p_read<0 OR p_read>9007199254740991 THEN
  RAISE EXCEPTION 'invalid PostHog publication' USING ERRCODE='23514';END IF;
 digest_hex=encode(pg_catalog.sha256(pg_catalog.convert_to(p_records::text,'UTF8')),'hex');count_rows=jsonb_array_length(p_records);
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run AND source='posthog' FOR UPDATE;
 stamp=clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PostHog run missing' USING ERRCODE='55000';END IF;
 IF r.status IN ('complete','empty') THEN
  IF r.content_digest IS DISTINCT FROM digest_hex THEN RAISE EXCEPTION 'PostHog publication conflict' USING ERRCODE='55000';END IF;
  RETURN jsonb_build_object('status',r.status,'count',r.rows_written,'digest',digest_hex,'duplicate',true);
 END IF;
 IF r.status<>'running' OR p_lease IS NULL OR r.lease_token IS DISTINCT FROM p_lease OR r.lease_until IS NULL OR r.lease_until<=stamp
  OR r.checkpoint->>'version' IS DISTINCT FROM '1' OR (r.checkpoint->>'expiresAt')::timestamptz<=stamp THEN
  RAISE EXCEPTION 'PostHog lease lost' USING ERRCODE='55000';END IF;
 names=r.checkpoint->'context'->'expectedQueries';
 FOR name IN SELECT jsonb_array_elements_text(names) LOOP
  IF r.checkpoint->'queries'->name->>'complete' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PostHog report incomplete' USING ERRCODE='55000';END IF;
 END LOOP;
 IF count_rows<1 THEN RAISE EXCEPTION 'PostHog overview missing' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(p_records) a WHERE a->>'metric_key'=CASE WHEN r.stream_key='quiz_observations' THEN 'posthog_events' ELSE 'posthog_mc_events' END AND a->>'dimensions_key'='all' AND a->'value' IS NOT NULL AND a->'value'<>'null'::jsonb) THEN
  RAISE EXCEPTION 'PostHog overview missing' USING ERRCODE='23514';END IF;
 IF (SELECT (a->>'value')::numeric FROM jsonb_array_elements(p_records) a
     WHERE a->>'metric_key'=CASE WHEN r.stream_key='quiz_observations' THEN 'posthog_events' ELSE 'posthog_mc_events' END AND a->>'dimensions_key'='all' LIMIT 1) IS DISTINCT FROM p_read THEN
  RAISE EXCEPTION 'PostHog read count mismatch' USING ERRCODE='23514';END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_records) LOOP
  IF jsonb_typeof(row)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(row))<>17
   OR NOT (row ?& ARRAY['source','source_namespace','metric_key','period_from','period_to','dimensions_key','report_profile_key','timezone','coverage_state','value','unit','currency','currency_exponent','tax_basis','dimensions','definition_version','source_locator'])
   OR row->>'source' IS DISTINCT FROM 'posthog' OR row->>'source_namespace' IS DISTINCT FROM r.source_namespace
   OR row->>'report_profile_key' IS DISTINCT FROM r.query_profile_key
   OR row->>'period_from' IS NULL OR row->>'period_to' IS NULL
   OR (row->>'period_from')::timestamptz<>r.period_from OR (row->>'period_to')::timestamptz<>r.period_to
   OR row->>'timezone' IS DISTINCT FROM 'Europe/Paris' OR row->>'coverage_state' IS DISTINCT FROM 'complete'
   OR row->>'unit' IS DISTINCT FROM 'count' OR row->'currency'<>'null'::jsonb OR row->'currency_exponent'<>'null'::jsonb
   OR row->>'tax_basis' IS DISTINCT FROM 'unknown' OR row->>'definition_version' IS DISTINCT FROM r.query_profile_key
   OR jsonb_typeof(row->'dimensions')<>'object' OR octet_length((row->'dimensions')::text)>=4000
   OR length(row->>'dimensions_key') NOT BETWEEN 1 AND 200 OR length(row->>'source_locator') NOT BETWEEN 1 AND 300
  THEN RAISE EXCEPTION 'PostHog record context mismatch' USING ERRCODE='23514';END IF;
  metric=row->>'metric_key';
  IF (r.stream_key='quiz_observations' AND metric NOT IN ('posthog_events','posthog_visitors','posthog_sessions'))
   OR (r.stream_key='masterclass_observations' AND metric<>'posthog_mc_events') THEN RAISE EXCEPTION 'PostHog metric mismatch' USING ERRCODE='23514';END IF;
  IF row->'value'<>'null'::jsonb THEN
   IF jsonb_typeof(row->'value')<>'number' THEN RAISE EXCEPTION 'PostHog count invalid' USING ERRCODE='23514';END IF;
   value_numeric=(row->>'value')::numeric;
   IF value_numeric<0 OR value_numeric>9007199254740991 OR value_numeric<>trunc(value_numeric) THEN RAISE EXCEPTION 'PostHog count invalid' USING ERRCODE='23514';END IF;
  ELSIF metric='posthog_events' OR metric='posthog_mc_events' THEN RAISE EXCEPTION 'PostHog events missing' USING ERRCODE='23514';END IF;
  INSERT INTO public.source_aggregates(source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id,timezone,coverage_state,value,unit,currency,currency_exponent,tax_basis,dimensions,definition_version,source_locator)
  VALUES('posthog',r.source_namespace,metric,r.period_from,r.period_to,row->>'dimensions_key',r.query_profile_key,r.id,'Europe/Paris','complete',value_numeric,'count',NULL,NULL,'unknown',row->'dimensions',r.query_profile_key,row->>'source_locator');
  value_numeric=NULL;
 END LOOP;
 written=count_rows;
 IF r.stream_key='masterclass_observations' THEN
  state=public.cockpit_apply_aggregate_state(r.id,ARRAY['posthog_mc_events'],true);written=(state->>'current')::integer;
 END IF;
 UPDATE public.sync_runs SET status=CASE WHEN p_read=0 THEN 'empty' ELSE 'complete' END,finished_at=stamp,pagination_complete=true,
  covered_from=period_from,covered_to=period_to,rows_read=p_read,rows_written=written,rows_rejected=0,content_digest=digest_hex,
  lease_token=NULL,lease_until=NULL,checkpoint=CASE WHEN state IS NULL THEN checkpoint ELSE checkpoint||jsonb_build_object('state',state-'current') END WHERE id=r.id;
 RETURN jsonb_build_object('status',CASE WHEN p_read=0 THEN 'empty' ELSE 'complete' END,'count',count_rows,'digest',digest_hex,'duplicate',false)
  ||CASE WHEN state IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('state',state) END;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Publicités par jour (ad_daily + meta_conversions_daily) : import_meta_page prépare, cette fonction publie.
-- Périmètre : publicités de l'espace et date dans [date_from, date_to[ de la tentative ; pour les conversions, en plus,
-- les profils de rapport de la même requête (« <query_profile_key>:<fenêtre> »), comme v_meta_conversions_daily.
CREATE OR REPLACE FUNCTION public.cockpit_publish_meta_daily(p_run uuid,p_read integer,p_rejected integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE r public.sync_runs; stamp timestamptz; v_status text; staged integer;
 d_confirmed integer=0; d_changed integer=0; d_retired integer=0; d_inserted integer=0; d_current integer=0;
 c_confirmed integer=0; c_changed integer=0; c_retired integer=0; c_inserted integer=0; c_current integer=0; n_cleaned integer=0; n integer; state jsonb;
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
 -- ad_daily
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
 UPDATE public.ad_daily c SET is_current=false FROM public.ads a
 WHERE a.id=c.ad_id AND a.source='meta' AND a.source_namespace=r.source_namespace AND c.is_current AND c.sync_run_id<>p_run AND c.date>=r.date_from AND c.date<r.date_to;
 GET DIAGNOSTICS d_retired=ROW_COUNT;
 UPDATE public.ad_daily SET is_current=true WHERE sync_run_id=p_run AND NOT is_current;
 GET DIAGNOSTICS d_inserted=ROW_COUNT;
 -- meta_conversions_daily
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
 UPDATE public.meta_conversions_daily c SET is_current=false FROM public.ads a
 WHERE a.id=c.ad_id AND a.source='meta' AND a.source_namespace=r.source_namespace AND c.is_current AND c.sync_run_id<>p_run AND c.date>=r.date_from AND c.date<r.date_to
  AND left(c.report_profile_key,length(r.query_profile_key)+1)=r.query_profile_key||':';
 GET DIAGNOSTICS c_retired=ROW_COUNT;
 UPDATE public.meta_conversions_daily SET is_current=true WHERE sync_run_id=p_run AND NOT is_current;
 GET DIAGNOSTICS c_inserted=ROW_COUNT;
 -- Nettoyage borné : lignes jamais publiées de tentatives Meta en échec de plus de 24 h (5 000 par table et par publication).
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
 state=jsonb_build_object('inserted',d_inserted,'changed',d_changed,'confirmed',d_confirmed,'retired',d_retired,'cleaned',n_cleaned,
  'conversions',jsonb_build_object('inserted',c_inserted,'changed',c_changed,'confirmed',c_confirmed,'retired',c_retired,'current',c_current));
 stamp=clock_timestamp();v_status=CASE WHEN staged=0 THEN 'empty' ELSE 'complete' END;
 UPDATE public.sync_runs SET status=v_status,finished_at=stamp,pagination_complete=true,covered_from=period_from,covered_to=period_to,
  rows_read=p_read,rows_rejected=0,rows_written=d_current,error_code=NULL,checkpoint=checkpoint||jsonb_build_object('state',state) WHERE id=p_run;
 RETURN jsonb_build_object('status',v_status,'duplicate',false,'rowsWritten',d_current,'state',state);
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Inscriptions : une observation identique à la ligne courante (même version source, mêmes empreintes, même mapping,
-- même identité, même éligibilité, mêmes propriétés) n'est plus insérée ; elle est comptée dans checkpoint.unchangedSkipped.
-- Le reste de 009 est repris à l'identique.
-- Remplacées seulement si la table des observations (migration 009) existe : une base de contrôle qui l'omet reste migrable.
DO $migration$
BEGIN
 IF to_regclass('public.lead_source_observations') IS NULL THEN RAISE NOTICE 'lead_source_observations absente : fonctions d''inscriptions inchangées.';RETURN;END IF;
 EXECUTE $stage$
CREATE OR REPLACE FUNCTION public.cockpit_stage_lead_entries(p_run uuid,p_lease uuid,p_page integer,p_records jsonb,p_next_cursor text,p_done boolean,p_read integer,p_ignored integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;x jsonb;existing lead_source_observations;person uuid;identity person_identities;candidate uuid;candidate_count integer;state text;page_hash text;family_name text;rec_count integer;skipped integer=0;
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
  -- Même objet, même contenu que la ligne courante publiée : aucune nouvelle ligne (règle d'état courant, migration 18).
  IF EXISTS(SELECT FROM lead_source_observations c WHERE c.is_current AND c.source_namespace=r.source_namespace AND c.family=family_name AND c.external_id=x->>'externalId'
   AND c.source_updated_at=(x->>'sourceUpdatedAt')::timestamptz AND c.source_payload_hash=x->>'sourcePayloadHash' AND c.payload_hash=x->>'payloadHash'
   AND c.mapping_profile=r.query_profile_key AND c.identity_key IS NOT DISTINCT FROM x->>'identityKey' AND c.person_id IS NOT DISTINCT FROM person
   AND c.identity_state=state AND c.eligible=(x->>'eligible')::boolean AND c.properties=x->'properties'
   AND c.occurred_at IS NOT DISTINCT FROM (x->>'occurredAt')::timestamptz AND c.source_container_id=x->>'containerId'
   AND c.source_contact_id IS NOT DISTINCT FROM x->>'contactId' AND c.source_status IS NOT DISTINCT FROM x->>'sourceStatus') THEN
   skipped=skipped+1;CONTINUE;
  END IF;
  INSERT INTO lead_source_observations(run_id,source,source_namespace,family,external_id,occurred_at,occurred_day,source_updated_at,source_container_id,source_contact_id,source_status,identity_key,person_id,identity_state,eligible,properties,payload_hash,source_payload_hash,mapping_profile)
  VALUES(p_run,r.source,r.source_namespace,family_name,x->>'externalId',(x->>'occurredAt')::timestamptz,((x->>'occurredAt')::timestamptz AT TIME ZONE 'Europe/Paris')::date,(x->>'sourceUpdatedAt')::timestamptz,x->>'containerId',x->>'contactId',x->>'sourceStatus',x->>'identityKey',person,state,(x->>'eligible')::boolean,x->'properties',x->>'payloadHash',x->>'sourcePayloadHash',r.query_profile_key) ON CONFLICT(run_id,source_namespace,family,external_id) DO NOTHING;
 END LOOP;
 UPDATE sync_runs SET rows_read=rows_read+p_read,rows_written=(SELECT count(*) FROM lead_source_observations WHERE run_id=p_run),checkpoint=checkpoint||jsonb_build_object('cursor',p_next_cursor,'page',p_page+1,'done',p_done,'lastPageHash',page_hash,'ignored',coalesce((checkpoint->>'ignored')::integer,0)+p_ignored,'unchangedSkipped',coalesce((checkpoint->>'unchangedSkipped')::integer,0)+skipped),lease_until=now()+interval '2 minutes' WHERE id=p_run;
 RETURN jsonb_build_object('alreadyStaged',false,'read',r.rows_read+p_read);
END $$;
 $stage$;
 EXECUTE $publish$
-- Publication des inscriptions : 009 à l'identique, sauf counts.unchanged qui inclut les observations inchangées non
-- insérées (unchangedSkipped) et un statut « empty » réservé à une tentative sans aucune observation lue.
CREATE OR REPLACE FUNCTION public.cockpit_publish_lead_entries(p_run uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;ns text;stream text;changed integer;unchanged integer;stale integer;conflicts integer;identity_changed integer;mapping_changed integer;missing_mapping integer;staged integer;skipped integer;stamp timestamptz=clock_timestamp();counts jsonb;
BEGIN
 SELECT source_namespace,stream_key INTO ns,stream FROM sync_runs WHERE id=p_run;
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-observation:'||ns||':'||replace(stream,'lead_entries_',''),0));
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND stream_key LIKE 'lead_entries_%' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(r.checkpoint) IS DISTINCT FROM 'object' OR r.checkpoint->>'version' IS DISTINCT FROM '1' OR r.checkpoint->>'done' IS DISTINCT FROM 'true' OR r.checkpoint->>'cursor' IS NOT NULL OR (r.checkpoint->>'page')::integer IS NULL OR (r.checkpoint->>'page')::integer<1 OR r.rows_rejected<>0 THEN RAISE EXCEPTION 'incomplete observation run' USING ERRCODE='55000';END IF;
 SELECT count(*) INTO staged FROM lead_source_observations WHERE run_id=p_run;
 skipped=coalesce((r.checkpoint->>'unchangedSkipped')::integer,0);
 -- A mapping transition cannot silently hide a historical request missing from the source replay.
 -- (Une observation inchangée non insérée a le mapping de la tentative : elle n'entre jamais dans ce contrôle.)
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
  RETURN jsonb_build_object('status','failed','reason','SOURCE_VERSION_CONFLICT','counts',jsonb_build_object('read',r.rows_read,'rejected',conflicts,'changed',0,'unchanged',unchanged+skipped,'stale',stale));
 END IF;
 changed=staged-unchanged-stale;
 -- Keep the previous rows current until this transaction commits. Unchanged/older observations remain audit versions only.
 UPDATE lead_source_observations c SET is_current=false FROM lead_source_observations s WHERE s.run_id=p_run AND c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id AND (s.source_updated_at>c.source_updated_at OR (s.source_updated_at=c.source_updated_at AND s.source_payload_hash=c.source_payload_hash AND (s.mapping_profile<>c.mapping_profile OR s.person_id IS DISTINCT FROM c.person_id OR s.identity_state<>c.identity_state)));
 UPDATE lead_source_observations s SET published_at=stamp,is_current=NOT EXISTS(SELECT FROM lead_source_observations c WHERE c.is_current AND c.source_namespace=s.source_namespace AND c.family=s.family AND c.external_id=s.external_id) WHERE s.run_id=p_run;
 counts=jsonb_build_object('read',r.rows_read,'observations',staged,'changed',changed,'unchanged',unchanged+skipped,'unchangedSkipped',skipped,'stale',stale,'identityChanged',identity_changed,'mappingChanged',mapping_changed,'rejected',0,'ignored',coalesce((r.checkpoint->>'ignored')::integer,0));
 UPDATE sync_runs SET status=CASE WHEN staged+skipped=0 THEN 'empty' ELSE 'complete' END,finished_at=stamp,pagination_complete=true,covered_from=period_from,covered_to=period_to,checkpoint=checkpoint||jsonb_build_object('counts',counts),lease_until=NULL,lease_token=NULL WHERE id=p_run;
 RETURN jsonb_build_object('status',CASE WHEN staged+skipped=0 THEN 'empty' ELSE 'complete' END,'counts',counts);
END $$;
 $publish$;
 REVOKE ALL ON FUNCTION public.cockpit_stage_lead_entries(uuid,uuid,integer,jsonb,text,boolean,integer,integer) FROM PUBLIC,anon,authenticated;
 REVOKE ALL ON FUNCTION public.cockpit_publish_lead_entries(uuid,uuid) FROM PUBLIC,anon,authenticated;
 GRANT EXECUTE ON FUNCTION public.cockpit_stage_lead_entries(uuid,uuid,integer,jsonb,text,boolean,integer,integer) TO service_role;
 GRANT EXECUTE ON FUNCTION public.cockpit_publish_lead_entries(uuid,uuid) TO service_role;
END $migration$;

REVOKE ALL ON FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_publish_aggregate_state(uuid,text[],integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_publish_meta_daily(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cockpit_publish_posthog(uuid,uuid,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_apply_aggregate_state(uuid,text[],boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_publish_aggregate_state(uuid,text[],integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_publish_meta_daily(uuid,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cockpit_publish_posthog(uuid,uuid,jsonb,integer) TO service_role;
COMMIT;

-- ---------------------------------------------------------------------------------------------------------------
-- Reprise des données existantes, dans une SECONDE transaction (reprise CP2, 24 septembre). Mesure sur volume synthétique
-- représentatif (673 000 lignes, private/derived/fable-cockpit-20260923/cp2-reprise-20260924/volume/) : la reprise KPI ci-dessous
-- dure environ 75 s ; tenue dans la même transaction que les ALTER TABLE et CREATE INDEX (verrous exclusifs gardés jusqu'au COMMIT),
-- elle bloquait toute lecture du cockpit pendant ce temps. Ici, le DDL ci-dessus valide en moins d'une seconde ; les mises à jour
-- ci-dessous ne bloquent pas les lectures (elles bloquent seulement les écritures des mêmes lignes : appliquer hors passage).
-- La version 18 n'est inscrite qu'à la fin : une reprise interrompue laisse le DDL en place et 018 se rejoue entièrement (idempotent).
BEGIN;
-- ---------------------------------------------------------------------------------------------------------------
-- Reprise des données existantes (idempotente, aucune suppression) : pour chaque clé métier, est courante la ligne de la
-- dernière tentative complète couvrant sa période (status complete/empty, pagination complète, aucun rejet ; ordre
-- source_as_of DESC, started_at DESC, id DESC, celui des lecteurs). Périmètre limité aux six flux de ce lot ; les lignes
-- quiz restent à false (leurs lecteurs lisent par tentative).
WITH periods AS (
 SELECT DISTINCT source,source_namespace,report_profile_key,period_from,period_to FROM public.source_aggregates
 WHERE report_profile_key='kpi-funnel-sources-v1' AND metric_key IN ('kpi_daily_row','kpi_daily_manifest') AND source IN ('meta','posthog','wix')
), winners AS (
 SELECT p.*,(SELECT r.id FROM public.sync_runs r WHERE r.source=p.source AND r.source_namespace=p.source_namespace AND r.stream_key='kpi_'||p.source||'_daily'
  AND r.query_profile_key=p.report_profile_key AND r.status IN ('complete','empty') AND r.pagination_complete AND r.rows_rejected=0
  AND r.period_from<=p.period_from AND r.period_to>=p.period_to ORDER BY r.source_as_of DESC,r.started_at DESC,r.id DESC LIMIT 1) AS run_id FROM periods p
)
UPDATE public.source_aggregates s SET is_current=true FROM winners w
WHERE w.run_id IS NOT NULL AND s.sync_run_id=w.run_id AND s.source=w.source AND s.source_namespace=w.source_namespace AND s.report_profile_key=w.report_profile_key
 AND s.period_from=w.period_from AND s.period_to=w.period_to AND s.metric_key IN ('kpi_daily_row','kpi_daily_manifest') AND NOT s.is_current
 AND NOT EXISTS(SELECT FROM public.source_aggregates c WHERE c.is_current AND c.source=s.source AND c.source_namespace=s.source_namespace AND c.report_profile_key=s.report_profile_key
  AND c.metric_key=s.metric_key AND c.period_from=s.period_from AND c.period_to=s.period_to AND c.dimensions_key=s.dimensions_key);

-- Masterclass : lecture « exact_report », donc la tentative gagnante est celle de la période exacte (même périmètre que la publication).
WITH periods AS (
 SELECT DISTINCT source,source_namespace,report_profile_key,period_from,period_to FROM public.source_aggregates WHERE source='posthog' AND metric_key='posthog_mc_events'
), winners AS (
 SELECT p.*,(SELECT r.id FROM public.sync_runs r WHERE r.source='posthog' AND r.source_namespace=p.source_namespace AND r.stream_key='masterclass_observations'
  AND r.query_profile_key=p.report_profile_key AND r.status IN ('complete','empty') AND r.pagination_complete AND r.rows_rejected=0 AND r.finished_at IS NOT NULL
  AND r.period_from=p.period_from AND r.period_to=p.period_to ORDER BY r.source_as_of DESC,r.started_at DESC,r.id DESC LIMIT 1) AS run_id FROM periods p
)
UPDATE public.source_aggregates s SET is_current=true FROM winners w
WHERE w.run_id IS NOT NULL AND s.sync_run_id=w.run_id AND s.source=w.source AND s.source_namespace=w.source_namespace AND s.report_profile_key=w.report_profile_key
 AND s.period_from=w.period_from AND s.period_to=w.period_to AND s.metric_key='posthog_mc_events' AND NOT s.is_current
 AND NOT EXISTS(SELECT FROM public.source_aggregates c WHERE c.is_current AND c.source=s.source AND c.source_namespace=s.source_namespace AND c.report_profile_key=s.report_profile_key
  AND c.metric_key=s.metric_key AND c.period_from=s.period_from AND c.period_to=s.period_to AND c.dimensions_key=s.dimensions_key);

-- Publicités par jour : même règle que v_ad_daily (dernière tentative complète couvrant la date, pour l'espace de la publicité).
WITH days AS (
 SELECT DISTINCT a.source_namespace,d.date FROM public.ad_daily d JOIN public.ads a ON a.id=d.ad_id WHERE a.source='meta'
), winners AS (
 SELECT days.*,(SELECT s.id FROM public.sync_runs s WHERE s.source='meta' AND s.source_namespace=days.source_namespace AND s.stream_key='ad_daily'
  AND s.status IN ('complete','empty') AND s.pagination_complete AND s.rows_rejected=0 AND s.date_from<=days.date AND s.date_to>days.date
  ORDER BY s.source_as_of DESC,s.started_at DESC,s.id DESC LIMIT 1) AS run_id FROM days
)
UPDATE public.ad_daily d SET is_current=true FROM winners w,public.ads a
WHERE w.run_id IS NOT NULL AND a.id=d.ad_id AND a.source='meta' AND a.source_namespace=w.source_namespace AND d.date=w.date AND d.sync_run_id=w.run_id AND NOT d.is_current
 AND NOT EXISTS(SELECT FROM public.ad_daily c WHERE c.is_current AND c.ad_id=d.ad_id AND c.date=d.date AND c.base_profile_key=d.base_profile_key);

-- Conversions : même règle que v_meta_conversions_daily (dernière tentative couvrant la date dont le profil préfixe celui de la ligne).
WITH keys AS (
 SELECT DISTINCT a.source_namespace,d.date,d.report_profile_key FROM public.meta_conversions_daily d JOIN public.ads a ON a.id=d.ad_id WHERE a.source='meta'
), winners AS (
 SELECT keys.*,(SELECT s.id FROM public.sync_runs s WHERE s.source='meta' AND s.source_namespace=keys.source_namespace AND s.stream_key='ad_daily'
  AND s.status IN ('complete','empty') AND s.pagination_complete AND s.rows_rejected=0 AND s.date_from<=keys.date AND s.date_to>keys.date
  AND keys.report_profile_key LIKE s.query_profile_key||':%' ORDER BY s.source_as_of DESC,s.started_at DESC,s.id DESC LIMIT 1) AS run_id FROM keys
)
UPDATE public.meta_conversions_daily d SET is_current=true FROM winners w,public.ads a
WHERE w.run_id IS NOT NULL AND a.id=d.ad_id AND a.source='meta' AND a.source_namespace=w.source_namespace AND d.date=w.date AND d.report_profile_key=w.report_profile_key
 AND d.sync_run_id=w.run_id AND NOT d.is_current
 AND NOT EXISTS(SELECT FROM public.meta_conversions_daily c WHERE c.is_current AND c.ad_id=d.ad_id AND c.date=d.date AND c.report_profile_key=d.report_profile_key
  AND c.action_type=d.action_type AND c.metric_kind=d.metric_kind);

INSERT INTO public.cockpit_migrations(version) VALUES(18) ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Retour arrière : ne jamais supprimer de lignes. Voir docs/ACTUALISATION.md §7. Le code antérieur reste compatible avec
-- cette migration appliquée (il lit par tentative ; les lignes courantes portent la dernière tentative). Pour revenir
-- aux fonctions antérieures sans toucher aux données : réappliquer les corps de cockpit_publish_posthog (016),
-- cockpit_stage_lead_entries et cockpit_publish_lead_entries (009) par CREATE OR REPLACE. Les colonnes is_current,
-- les index partiels et les nouvelles fonctions peuvent rester en place (inutilisés par le code antérieur).
