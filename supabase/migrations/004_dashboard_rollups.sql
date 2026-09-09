-- Compact service-only aggregates. Raw events and business records never leave this RPC.
BEGIN;
CREATE INDEX dashboard_events_time ON public.events(occurred_at,id);
CREATE INDEX dashboard_leads_time ON public.lead_registrations(registered_at,id);
CREATE INDEX dashboard_ad_daily_date ON public.ad_daily(date,ad_id);
CREATE INDEX dashboard_deals_signed_time ON public.deals(signed_at,id);
CREATE FUNCTION public.cockpit_dashboard_rollup(
 p_from date,p_to date,p_source text,p_tunnel text,p_campaign text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
    OR p_from>=p_to OR p_to-p_from>367 OR p_source IS NULL OR p_source NOT IN ('all','paid','organic','unknown')
    OR p_tunnel IS NULL OR p_tunnel NOT IN ('all','quiz','masterclass') OR p_campaign IS NULL
    OR length(p_campaign)>150 OR (p_campaign NOT IN ('','all') AND p_campaign !~ '^(link|meta|meta-ad|meta-creative):.+$')
 THEN RAISE EXCEPTION 'invalid dashboard scope' USING ERRCODE='22023';END IF;
 WITH
 bounds AS (SELECT p_from::timestamp AT TIME ZONE 'Europe/Paris' AS lo,p_to::timestamp AT TIME ZONE 'Europe/Paris' AS hi),
 revisions AS (
  SELECT r.id,r.campaign,CASE WHEN r.medium='paid_social' THEN 'paid'
    WHEN r.medium IN ('organic_social','organic_video','email') THEN 'organic' ELSE 'unknown' END AS traffic
  FROM public.link_revisions r
 ),
 leads AS MATERIALIZED (
  SELECT l.* FROM public.lead_registrations l CROSS JOIN bounds b LEFT JOIN revisions r ON r.id=l.link_revision_id
  WHERE l.registered_at>=b.lo AND l.registered_at<b.hi
    AND (p_tunnel='all' OR l.tunnel=p_tunnel)
    AND (p_source='all' OR coalesce(r.traffic,'unknown')=p_source)
    AND (p_campaign IN ('','all') OR p_campaign='link:'||r.campaign)
 ),
 lead_totals AS (
  SELECT count(*) AS registrations,count(DISTINCT person_id) AS people,
    count(*) FILTER(WHERE person_id IS NULL) AS unresolved,max(observed_at) AS observed_at FROM leads
 ),
 lead_tunnels AS (
  SELECT tunnel,count(*) AS count,count(DISTINCT person_id) AS people,count(*) FILTER(WHERE person_id IS NULL) AS unresolved
  FROM leads GROUP BY tunnel
 ),
 ev AS MATERIALIZED (
  SELECT e.* FROM public.v_events_canonical e CROSS JOIN bounds b LEFT JOIN revisions r ON r.id=e.link_revision_id
  WHERE e.occurred_at>=b.lo AND e.occurred_at<b.hi
    AND (p_tunnel='all' OR e.tunnel=p_tunnel)
    AND (p_source='all' OR coalesce(r.traffic,'unknown')=p_source)
    AND (p_campaign IN ('','all') OR p_campaign='link:'||r.campaign)
 ),
 event_totals AS (
  SELECT count(*) AS count,max(received_at) AS observed_at,
    count(DISTINCT (visitor_namespace,session_id,tunnel)) FILTER(WHERE session_id IS NOT NULL AND event_name IN ('landing_arrival','page_view')) AS arrivals FROM ev
 ),
 event_steps AS (
  SELECT tunnel,event_name,count(DISTINCT (visitor_namespace,journey_id)) FILTER(WHERE journey_id IS NOT NULL) AS value
  FROM ev GROUP BY tunnel,event_name
 ),
 question_events AS MATERIALIZED (
  SELECT visitor_namespace,journey_id,event_name,
    CASE WHEN jsonb_typeof(properties->'question_number')='number' THEN (properties->>'question_number')::numeric END AS q
  FROM ev WHERE tunnel='quiz' AND journey_id IS NOT NULL AND event_name IN ('quiz_question_viewed','quiz_question_answered')
 ),
 question_views AS (
  SELECT DISTINCT visitor_namespace,journey_id,q FROM question_events WHERE event_name='quiz_question_viewed' AND q BETWEEN 1 AND 12 AND q=trunc(q)
 ),
 question_totals AS (
  SELECT q.q,count(v.journey_id) AS views,
    count(v.journey_id) FILTER(WHERE EXISTS(SELECT 1 FROM question_events a WHERE a.event_name='quiz_question_answered'
      AND a.visitor_namespace=v.visitor_namespace AND a.journey_id=v.journey_id AND a.q=v.q)) AS answers
  FROM generate_series(1,12) q(q) LEFT JOIN question_views v ON v.q=q.q GROUP BY q.q
 ),
 video_raw AS MATERIALIZED (
  SELECT visitor_namespace,anonymous_id,properties->>'video_id' AS video_id,properties->>'video_version' AS version,
    CASE WHEN jsonb_typeof(properties->'duration')='number' THEN (properties->>'duration')::numeric END AS duration,
    CASE WHEN jsonb_typeof(properties->'intervals')='array' THEN properties->'intervals' ELSE '[]'::jsonb END AS intervals
  FROM ev WHERE event_name='video_watch' AND anonymous_id IS NOT NULL
 ),
 video_viewers AS MATERIALIZED (
  SELECT * FROM video_raw WHERE video_id ~ '^[A-Za-z0-9._-]{1,80}$' AND version ~ '^[A-Za-z0-9._-]{1,64}$' AND duration>0 AND duration<=86400
 ),
 interval_values AS (
  SELECT v.visitor_namespace,v.anonymous_id,v.video_id,v.version,v.duration,
    CASE WHEN jsonb_typeof(i.value->'start')='number' THEN (i.value->>'start')::numeric END AS lo,
    CASE WHEN jsonb_typeof(i.value->'end')='number' THEN (i.value->>'end')::numeric END AS hi
  FROM video_viewers v CROSS JOIN LATERAL jsonb_array_elements(v.intervals) i(value)
 ),
 video_ranges AS (
  SELECT visitor_namespace,anonymous_id,video_id,version,duration,
    range_agg(numrange(lo,hi,'[)')) FILTER(WHERE lo>=0 AND hi>lo AND hi<=duration AND hi-lo<=30) AS watched
  FROM interval_values GROUP BY visitor_namespace,anonymous_id,video_id,version,duration
 ),
 video_seconds AS (
  SELECT visitor_namespace,anonymous_id,video_id,version,duration,
    coalesce((SELECT sum(upper(r)-lower(r)) FROM unnest(watched) r),0) AS seconds FROM video_ranges
 ),
 video_totals AS (
  SELECT video_id,version,duration,t.threshold,count(*) AS viewers,count(*) FILTER(WHERE seconds/duration>=t.threshold) AS reached
  FROM video_seconds CROSS JOIN (VALUES(0.25::numeric),(0.5::numeric),(0.75::numeric),(0.95::numeric)) t(threshold)
  GROUP BY video_id,version,duration,t.threshold
 ),
 appts AS (
  SELECT a.* FROM public.appointments a CROSS JOIN bounds b
  WHERE a.identity_basis='stable_booking' AND a.scheduled_at>=b.lo AND a.scheduled_at<b.hi
 ),
 appointment_totals AS (
  SELECT count(*) AS total,count(*) FILTER(WHERE status='attended' AND attended_at IS NOT NULL AND nullif(btrim(attendance_evidence),'') IS NOT NULL) AS attended,
    count(*) FILTER(WHERE status='no_show') AS no_show,
    count(*) FILTER(WHERE status IN ('unknown','scheduled') OR (status='attended' AND (attended_at IS NULL OR nullif(btrim(attendance_evidence),'') IS NULL))) AS unknown,
    max(observed_at) AS observed_at FROM appts
 ),
 cash AS MATERIALIZED (
  SELECT p.* FROM public.payments p CROSS JOIN bounds b WHERE p.status='settled' AND p.effective_at>=b.lo AND p.effective_at<b.hi
 ),
 cash_totals AS (
  SELECT count(*) AS count,count(DISTINCT (source,source_namespace)) AS authorities,
    coalesce(bool_and(currency='EUR' AND currency_exponent=2 AND tax_basis='tax_inclusive' AND reconciliation_state='reconciled'),false) AS units,
    coalesce(sum(gross_minor::numeric) FILTER(WHERE kind='receipt'),0) AS gross,
    coalesce(sum(gross_minor::numeric) FILTER(WHERE kind='refund'),0) AS refunds,
    coalesce(sum(gross_minor::numeric*reversal_direction) FILTER(WHERE kind='reversal'),0) AS reversals,
    max(observed_at) AS observed_at FROM cash
 ),
 cash_ready AS (
  SELECT *,count>0 AND authorities=1 AND units AND greatest(abs(gross),abs(refunds),abs(reversals),abs(gross-refunds+reversals))<=9007199254740991
    AND NOT EXISTS(SELECT 1 FROM cash GROUP BY (effective_at AT TIME ZONE 'Europe/Paris')::date
      HAVING abs(sum(gross_minor::numeric*CASE kind WHEN 'receipt' THEN 1 WHEN 'refund' THEN -1 ELSE reversal_direction END))>9007199254740991) AS compatible FROM cash_totals
 ),
 cash_authority AS (SELECT DISTINCT source,source_namespace FROM cash),
 cash_run AS (
  SELECT r.* FROM public.sync_runs r JOIN cash_authority a USING(source,source_namespace) CROSS JOIN bounds b
  WHERE r.stream_key='payments_and_refunds' AND r.status='complete' AND r.pagination_complete AND r.rows_rejected=0
    AND r.period_from<=b.lo AND r.period_to>=b.hi AND r.covered_from<=b.lo AND r.covered_to>=b.hi
    AND (SELECT authorities FROM cash_totals)=1
  ORDER BY r.source_as_of DESC,r.started_at DESC,r.id DESC LIMIT 1
 ),
 cash_days AS (
  SELECT (effective_at AT TIME ZONE 'Europe/Paris')::date AS date,
    sum(gross_minor::numeric*CASE kind WHEN 'receipt' THEN 1 WHEN 'refund' THEN -1 ELSE reversal_direction END) AS net
  FROM cash GROUP BY (effective_at AT TIME ZONE 'Europe/Paris')::date
 ),
 aggregate_candidates AS MATERIALIZED (
  SELECT a.*,r.source_as_of,r.started_at,r.finished_at FROM public.source_aggregates a JOIN public.sync_runs r ON r.id=a.sync_run_id CROSS JOIN bounds b
  WHERE a.metric_key='net_cash' AND a.definition_version='net-ttc-v1' AND a.currency='EUR' AND a.currency_exponent=2
    AND a.unit='minor' AND a.timezone='Europe/Paris' AND a.tax_basis='tax_inclusive' AND a.coverage_state='complete'
    AND a.period_from=b.lo AND a.period_to=b.hi AND a.dimensions_key='all' AND a.dimensions='{}'::jsonb
    AND a.value IS NOT NULL AND a.value=trunc(a.value) AND abs(a.value)<=9007199254740991
    AND r.source=a.source AND r.source_namespace=a.source_namespace AND r.status='complete' AND r.pagination_complete AND r.rows_rejected=0
    AND r.period_from<=b.lo AND r.period_to>=b.hi AND r.covered_from<=b.lo AND r.covered_to>=b.hi
 ),
 aggregate_latest AS (
  SELECT * FROM aggregate_candidates WHERE (SELECT count(DISTINCT (source,source_namespace,report_profile_key)) FROM aggregate_candidates)=1
  ORDER BY source_as_of DESC,started_at DESC,sync_run_id DESC LIMIT 1
 ),
 aggregate_ready AS (
  SELECT * FROM aggregate_latest a WHERE (SELECT count(*) FROM aggregate_candidates c WHERE c.sync_run_id=a.sync_run_id)=1
 ),
 signed_deals AS MATERIALIZED (
  SELECT d.* FROM public.deals d CROSS JOIN bounds b WHERE d.status='signed' AND d.signed_at>=b.lo AND d.signed_at<b.hi
 ),
 deal_totals AS (
  SELECT count(*) AS count,count(DISTINCT (source,source_namespace)) AS authorities,
    coalesce(bool_and(currency='EUR' AND currency_exponent=2 AND tax_basis='tax_inclusive' AND nullif(btrim(source_locator),'') IS NOT NULL AND contracted_minor IS NOT NULL),false) AS units,
    sum(contracted_minor::numeric) AS contracted,max(observed_at) AS observed_at FROM signed_deals
 ),
 deal_ready AS (SELECT *,count>0 AND authorities=1 AND units AND contracted<=9007199254740991 AS compatible FROM deal_totals),
 meta_rows AS MATERIALIZED (
  SELECT d.*,a.source,a.source_namespace,a.external_id,a.creative_id,a.campaign_id AS catalog_campaign,
    r.query_profile_key,r.status AS run_status,r.pagination_complete,r.rows_rejected,r.finished_at
  FROM public.v_ad_daily d JOIN public.ads a ON a.id=d.ad_id JOIN public.sync_runs r ON r.id=d.sync_run_id
  WHERE d.date>=p_from AND d.date<p_to AND p_source IN ('all','paid') AND p_tunnel='all'
    AND (p_campaign IN ('','all') OR p_campaign='meta:'||d.campaign_id OR p_campaign='meta-ad:'||a.external_id OR p_campaign='meta-creative:'||a.creative_id)
 ),
 meta_totals AS (
  SELECT count(*) AS count,count(DISTINCT (source,source_namespace)) AS authorities,count(DISTINCT query_profile_key) AS profiles,
    coalesce(bool_and(source='meta' AND currency='EUR' AND currency_exponent=2 AND timezone='Europe/Paris'
      AND base_profile_key='ad-day-no-breakdown-v1' AND spend_minor IS NOT NULL
      AND run_status='complete' AND pagination_complete AND rows_rejected=0
      AND query_profile_key ~ '^v([2-9][3-9]|[3-9][0-9]|[1-9][0-9]{2,})\.0-ad-day-none$'
      AND campaign_id IS NOT DISTINCT FROM catalog_campaign),false) AS units,
    sum(spend_minor::numeric) AS spend,sum(impressions::numeric) AS impressions,sum(outbound_clicks::numeric) AS clicks,
    count(*) FILTER(WHERE impressions IS NULL) AS missing_impressions,count(*) FILTER(WHERE outbound_clicks IS NULL) AS missing_clicks,
    max(finished_at) AS observed_at FROM meta_rows
 ),
 meta_ready AS (
  SELECT *,count>0 AND authorities=1 AND profiles=1 AND units AND spend<=9007199254740991
    AND (p_campaign NOT LIKE 'meta-creative:%' OR NOT EXISTS(
      SELECT 1 FROM public.ads a WHERE a.source='meta' AND a.source_namespace IN (SELECT source_namespace FROM meta_rows) AND nullif(a.creative_id,'') IS NULL
    )) AS compatible FROM meta_totals
 ),
 meta_days AS (SELECT date,sum(spend_minor::numeric) AS spend FROM meta_rows GROUP BY date)
 SELECT jsonb_build_object(
  'leads',(SELECT jsonb_build_object('assignable',p_campaign !~ '^meta(-ad|-creative)?:','registrations',registrations,'unique',people,'unresolved',unresolved,'observedAt',observed_at,
    'byTunnel',coalesce((SELECT jsonb_agg(jsonb_build_object('tunnel',tunnel,'count',count,'unique',people,'unresolved',unresolved) ORDER BY tunnel) FROM lead_tunnels),'[]'::jsonb)) FROM lead_totals),
  'events',(SELECT jsonb_build_object('assignable',p_campaign !~ '^meta(-ad|-creative)?:','count',count,'arrivals',arrivals,'observedAt',observed_at,
    'steps',coalesce((SELECT jsonb_agg(jsonb_build_object('tunnel',tunnel,'event_name',event_name,'value',value) ORDER BY tunnel,event_name) FROM event_steps),'[]'::jsonb),
    'questions',(SELECT jsonb_agg(jsonb_build_object('q',q,'views',views,'answers',answers) ORDER BY q) FROM question_totals),
    'videos',coalesce((SELECT jsonb_agg(jsonb_build_object('video_id',video_id,'version',version,'duration',duration,'threshold',threshold,'viewers',viewers,'reached',reached) ORDER BY video_id,version,duration,threshold) FROM video_totals),'[]'::jsonb)) FROM event_totals),
  'appointments',(SELECT jsonb_build_object('total',total,'attended',attended,'noShow',no_show,'unknown',unknown,'observedAt',observed_at) FROM appointment_totals),
  'finance',(SELECT jsonb_build_object('transactionCount',count,'authorityCount',authorities,'compatible',compatible,
    'grossMinor',CASE WHEN compatible THEN gross END,'refundMinor',CASE WHEN compatible THEN refunds END,'reversalMinor',CASE WHEN compatible THEN reversals END,
    'coverageComplete',EXISTS(SELECT 1 FROM cash_run),'observedAt',coalesce((SELECT finished_at FROM cash_run),observed_at),
    'daily',CASE WHEN compatible THEN coalesce((SELECT jsonb_agg(jsonb_build_object('date',date,'netMinor',net) ORDER BY date) FROM cash_days),'[]'::jsonb) ELSE '[]'::jsonb END) FROM cash_ready),
  'aggregate',(SELECT jsonb_build_object('valueMinor',value,'observedAt',finished_at) FROM aggregate_ready),
  'deals',(SELECT jsonb_build_object('count',count,'compatible',compatible,'contractedMinor',CASE WHEN compatible THEN contracted END,'observedAt',observed_at) FROM deal_ready),
  'meta',(SELECT jsonb_build_object('rows',count,'compatible',compatible,'spendMinor',CASE WHEN compatible THEN spend END,
    'impressions',CASE WHEN compatible AND missing_impressions=0 AND impressions<=9007199254740991 THEN impressions END,
    'outboundClicks',CASE WHEN compatible AND missing_clicks=0 AND clicks<=9007199254740991 THEN clicks END,'observedAt',observed_at,
    'daily',CASE WHEN compatible THEN coalesce((SELECT jsonb_agg(jsonb_build_object('date',date,'spendMinor',spend) ORDER BY date) FROM meta_days),'[]'::jsonb) ELSE '[]'::jsonb END) FROM meta_ready)
 ) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.cockpit_dashboard_rollup(date,date,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_dashboard_rollup(date,date,text,text,text) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(4);
COMMIT;
