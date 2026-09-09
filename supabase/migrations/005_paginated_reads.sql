-- Read-only aggregate/list endpoints. No authenticated browser role can call these functions.
BEGIN;
CREATE FUNCTION public.cockpit_dashboard_lists(p_from date,p_to date,p_source text,p_tunnel text,p_campaign text,p_page integer DEFAULT 0,p_page_size integer DEFAULT 50) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_from>=p_to OR p_to-p_from>367 OR p_page<0 OR p_page>100000 OR p_page_size<1 OR p_page_size>100 OR p_source NOT IN ('all','paid','organic','unknown') OR p_tunnel NOT IN ('all','quiz','masterclass') THEN RAISE EXCEPTION 'invalid list parameters' USING ERRCODE='23514';END IF;
 WITH link_scope AS (
  SELECT r.*,CASE WHEN medium='paid_social' THEN 'paid' WHEN medium IN ('organic_social','organic_video','email') THEN 'organic' ELSE 'unknown' END traffic FROM link_revisions r
 ), registrations AS (
  SELECT * FROM lead_registrations WHERE registered_at>=p_from::timestamp AT TIME ZONE 'Europe/Paris' AND registered_at<p_to::timestamp AT TIME ZONE 'Europe/Paris'
 ), link_details AS (
  SELECT r.id::text id,r.label,r.traffic source,CASE WHEN count(l.id)>0 AND count(l.id) FILTER(WHERE l.person_id IS NULL)=0 THEN count(DISTINCT l.person_id) ELSE NULL END leads,NULL::numeric spend,
   'Personnes par révision. Dépenses et RDV sans correspondance restent indisponibles.'::text coverage
  FROM link_scope r LEFT JOIN registrations l ON l.link_revision_id=r.id
  WHERE (p_tunnel='all' OR r.tunnel=p_tunnel) AND (p_source='all' OR r.traffic=p_source) AND (p_campaign='' OR p_campaign='all' OR p_campaign='link:'||r.campaign)
  GROUP BY r.id,r.label,r.traffic
 ), ad_details AS (
  SELECT a.id::text id,coalesce(max(d.ad_name),max(a.ad_name),a.external_id) label,'paid'::text source,NULL::bigint leads,
   CASE WHEN bool_and(d.currency='EUR' AND d.currency_exponent=2 AND d.timezone='Europe/Paris' AND d.spend_minor IS NOT NULL) THEN sum(d.spend_minor)/100.0 ELSE NULL END spend,
   'Annonce Meta · dépenses observées. Conversions commerciales sans preuve de rapprochement indisponibles.'::text coverage
  FROM v_ad_daily d JOIN ads a ON a.id=d.ad_id
  WHERE d.date>=p_from AND d.date<p_to AND p_tunnel='all' AND p_source IN ('all','paid') AND (p_campaign='' OR p_campaign='all' OR p_campaign='meta:'||d.campaign_id OR p_campaign='meta-ad:'||a.external_id OR p_campaign='meta-creative:'||a.creative_id)
  GROUP BY a.id,a.external_id
 ), details AS (SELECT * FROM link_details UNION ALL SELECT * FROM ad_details), page AS (
  SELECT jsonb_build_object('id',id,'label',label,'source',source,'leads',leads,'spend',spend,'appointments',NULL,'clients',NULL,'coverage',coverage) item FROM details ORDER BY label,id LIMIT p_page_size OFFSET p_page*p_page_size
 ), relevant_ads AS (
  SELECT DISTINCT a.* FROM ads a JOIN v_ad_daily d ON d.ad_id=a.id WHERE d.date>=p_from AND d.date<p_to
 ), options AS (
  SELECT DISTINCT 'link:'||campaign id,'Liens · '||campaign label FROM link_revisions
  UNION SELECT DISTINCT 'meta:'||campaign_id,'Meta · '||coalesce(campaign_name,campaign_id) FROM relevant_ads WHERE campaign_id IS NOT NULL
  UNION SELECT 'meta-ad:'||external_id,'Publicité · '||coalesce(ad_name,external_id) FROM relevant_ads
  UNION SELECT DISTINCT 'meta-creative:'||creative_id,'Créative · '||creative_id FROM relevant_ads WHERE creative_id IS NOT NULL
 )
 SELECT jsonb_build_object('details',coalesce((SELECT jsonb_agg(item) FROM page),'[]'::jsonb),'pagination',jsonb_build_object('page',p_page,'pageSize',p_page_size,'total',(SELECT count(*) FROM details)),'campaigns',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'label',label) ORDER BY label,id) FROM options),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;

CREATE FUNCTION public.cockpit_prospects_page(p_search text DEFAULT '',p_stage text DEFAULT '',p_page integer DEFAULT 0,p_page_size integer DEFAULT 50) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF length(p_search)>200 OR length(p_stage)>200 OR p_page<0 OR p_page>100000 OR p_page_size<1 OR p_page_size>100 THEN RAISE EXCEPTION 'invalid list parameters' USING ERRCODE='23514';END IF;
 WITH filtered AS (
  SELECT p.* FROM prospects p WHERE NOT p.archived AND (p_search='' OR strpos(lower(coalesce(p.display_name,'')||' '||coalesce(p.owner_label,'')),lower(p_search))>0) AND (p_stage='' OR p_stage='all' OR coalesce(p.source_status,'Non renseigné')=p_stage)
 ), page AS (
  SELECT p.*,a.scheduled_at,a.status appointment_status FROM (SELECT * FROM filtered ORDER BY source_updated_at DESC NULLS LAST,id LIMIT p_page_size OFFSET p_page*p_page_size) p
  LEFT JOIN LATERAL(SELECT scheduled_at,status FROM appointments WHERE prospect_id=p.id ORDER BY scheduled_at DESC NULLS LAST,id LIMIT 1)a ON true
 )
 SELECT jsonb_build_object('prospects',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',coalesce(display_name,'Sans nom commercial'),'owner',owner_label,'stage',coalesce(source_status,'Non renseigné'),'source',NULL,'tunnel',NULL,'appointmentAt',coalesce(to_jsonb(scheduled_at),to_jsonb(current_appointment_at)),'appointmentStatus',CASE WHEN appointment_status='scheduled' THEN 'planned' ELSE coalesce(appointment_status,'unknown') END,'followUpAt',next_follow_up_at,'outcome',outcome,'updatedAt',coalesce(source_updated_at,observed_at))) FROM page),'[]'::jsonb),'pagination',jsonb_build_object('page',p_page,'pageSize',p_page_size,'total',(SELECT count(*) FROM filtered)),'stages',coalesce((SELECT jsonb_agg(stage ORDER BY stage) FROM(SELECT DISTINCT coalesce(source_status,'Non renseigné') stage FROM prospects WHERE NOT archived)s),'[]'::jsonb),'updatedAt',(SELECT max(observed_at) FROM prospects)) INTO result;
 RETURN result;
END $$;

CREATE FUNCTION public.cockpit_attribution_snapshot(p_from timestamptz,p_to timestamptz,p_source text,p_tunnel text,p_campaign text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 WITH selected AS(SELECT * FROM attribution_runs WHERE status='published' AND cohort_from=p_from AND cohort_to=p_to AND cohort_timezone='Europe/Paris' AND currency='EUR' AND tax_basis='tax_inclusive' AND scope->>'source'=p_source AND scope->>'tunnel'=p_tunnel AND coalesce(scope->>'campaign','')=p_campaign ORDER BY input_cutoff_at DESC,published_at DESC,id DESC LIMIT 1)
 SELECT jsonb_build_object('run',(SELECT to_jsonb(s) FROM selected s),'results',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM attribution_results r WHERE attribution_run_id=(SELECT id FROM selected)),'[]'::jsonb));
$$;
CREATE FUNCTION public.cockpit_attribution_detail(p_run uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('run',(SELECT to_jsonb(a) FROM attribution_runs a WHERE id=p_run AND status='published'),'results',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM v_attribution_published r WHERE attribution_run_id=p_run),'[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION public.cockpit_dashboard_lists(date,date,text,text,text,integer,integer),public.cockpit_prospects_page(text,text,integer,integer),public.cockpit_attribution_snapshot(timestamptz,timestamptz,text,text,text),public.cockpit_attribution_detail(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_dashboard_lists(date,date,text,text,text,integer,integer),public.cockpit_prospects_page(text,text,integer,integer),public.cockpit_attribution_snapshot(timestamptz,timestamptz,text,text,text),public.cockpit_attribution_detail(uuid) TO service_role;
CREATE FUNCTION public.cockpit_connection_status() RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('runs',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM(SELECT DISTINCT ON(source) * FROM sync_runs ORDER BY source,started_at DESC,id DESC)r),'[]'::jsonb),'firstParty',jsonb_build_object('eventAt',(SELECT max(received_at) FROM events WHERE source='first_party'),'leadAt',(SELECT max(observed_at) FROM lead_registrations WHERE source='first_party')));
$$;
REVOKE ALL ON FUNCTION public.cockpit_connection_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_connection_status() TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(5);
COMMIT;
