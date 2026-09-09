-- Read-only L1 correction. It never changes observations, identities, people or prospects.
BEGIN;

CREATE FUNCTION public.cockpit_lead_entry_rollup_v2(
 p_wix_namespace text,
 p_notion_namespace text,
 p_client_namespace text,
 p_from date,
 p_to date,
 p_scope jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=public,pg_temp
AS $$
DECLARE result jsonb;
BEGIN
 IF jsonb_typeof(p_scope) IS DISTINCT FROM 'object' OR p_from IS NULL OR p_to IS NULL OR p_from>=p_to OR p_to-p_from>367 THEN
  RAISE EXCEPTION 'invalid period' USING ERRCODE='22023';
 END IF;

 WITH published AS (
  SELECT * FROM sync_runs
  WHERE status IN ('complete','empty') AND pagination_complete AND rows_rejected=0
   AND stream_key LIKE 'lead_entries_%'
 ), selected_profiles AS (
  SELECT scope.key family,scope.value->>'profile' requested_profile,chosen.query_profile_key profile
  FROM jsonb_each(p_scope) scope
  CROSS JOIN LATERAL (
   SELECT r.query_profile_key FROM published r
   WHERE r.stream_key='lead_entries_'||scope.key
    AND r.source_namespace=CASE WHEN scope.key='client_history' THEN p_client_namespace ELSE p_wix_namespace END
   ORDER BY r.finished_at DESC,r.id DESC
   LIMIT 1
  ) chosen
 ), valid_runs AS (
  SELECT r.* FROM published r
  JOIN selected_profiles s ON r.stream_key='lead_entries_'||s.family AND r.query_profile_key=s.profile
 ), observations AS (
  SELECT o.* FROM lead_source_observations o
  JOIN valid_runs r ON r.id=o.run_id
  WHERE o.is_current AND o.published_at IS NOT NULL AND o.mapping_profile=r.query_profile_key
   AND p_scope->o.family->'containerIds' @> jsonb_build_array(o.source_container_id)
   AND (
    (o.source='wix' AND o.source_namespace=p_wix_namespace AND o.family IN ('forms','quiz'))
    OR (o.source='notion' AND o.source_namespace=p_client_namespace AND o.family='client_history')
   )
 ), raw_requests AS (
  SELECT * FROM observations
  WHERE family IN ('forms','quiz') AND eligible AND person_id IS NOT NULL
 ), bridge_candidates AS (
  SELECT r.person_id source_person,r.identity_key source_identity_key,p.person_id target_person
  FROM raw_requests r
  JOIN observations c ON c.family='client_history' AND c.identity_key=r.identity_key
  JOIN LATERAL jsonb_array_elements_text(
   CASE WHEN jsonb_typeof(c.properties->'prospectIds')='array' THEN c.properties->'prospectIds' ELSE '[]'::jsonb END
  ) linked(external_id) ON true
  JOIN prospects p ON p.source='notion' AND p.source_namespace=p_notion_namespace
   AND c.properties->>'prospectNamespace'=p_notion_namespace
   AND p.external_id=linked.external_id AND p.person_id IS NOT NULL
   AND p.business->'clientIds' @> jsonb_build_array(c.external_id)
 ), bridge_people AS (
  SELECT source_person,array_agg(DISTINCT target_person) target_people
  FROM bridge_candidates
  GROUP BY source_person
 ), bridge_targets AS (
  SELECT source_person,source_identity_key,array_agg(DISTINCT target_person) target_people
  FROM bridge_candidates
  GROUP BY source_person,source_identity_key
 ), bridge AS (
  SELECT b.source_person,b.source_identity_key,b.target_people[1] target_person
  FROM bridge_targets b
  JOIN bridge_people person_targets USING(source_person)
  WHERE cardinality(b.target_people)=1 AND cardinality(person_targets.target_people)=1
   AND b.target_people[1]=person_targets.target_people[1]
   AND NOT EXISTS (
    SELECT FROM prospects own
    WHERE own.source='notion' AND own.source_namespace=p_notion_namespace
     AND own.person_id=b.source_person
   )
 ), marked_observations AS (
  SELECT o.*,coalesce(b.target_person,o.person_id) canonical_person_id
  FROM observations o
  LEFT JOIN bridge b ON b.source_identity_key=o.identity_key
   AND (b.source_person=o.person_id OR o.family='client_history')
 ), notion_rows AS (
  SELECT coalesce(b.target_person,p.person_id) person_id,p.external_id,p.business
  FROM prospects p
  LEFT JOIN bridge b ON b.source_person=p.person_id
  WHERE p.source='notion' AND p.source_namespace=p_notion_namespace AND p.business<>'{}'
 ), notion AS (
  SELECT n.person_id,n.external_id,min(d.event_day) event_day
  FROM notion_rows n
  CROSS JOIN LATERAL (
   SELECT CASE
    WHEN length(v)=10 AND pg_input_is_valid(v,'date') THEN v::date
    WHEN length(v)>10 AND pg_input_is_valid(v,'timestamptz') THEN (v::timestamptz AT TIME ZONE 'Europe/Paris')::date
   END event_day
   FROM (VALUES(n.business->'dates'->>'real'),(n.business->'dates'->>'legacy'),(n.business->'dates'->>'wix'),(n.business->>'acquisitionDay')) raw(v)
  ) d
  WHERE d.event_day IS NOT NULL
  GROUP BY n.person_id,n.external_id
 ), requests AS (
  SELECT canonical_person_id person_id,occurred_day
  FROM marked_observations
  WHERE family IN ('forms','quiz') AND eligible
 ), candidates AS (
  SELECT person_id,event_day FROM notion WHERE person_id IS NOT NULL
  UNION ALL
  SELECT person_id,occurred_day FROM requests WHERE person_id IS NOT NULL
 ), earliest AS (
  SELECT person_id,min(event_day) event_day,bool_or(event_day>=p_from AND event_day<p_to) in_period
  FROM candidates
  GROUP BY person_id
 ), client_before AS (
  SELECT canonical_person_id person_id,min(occurred_day) event_day
  FROM marked_observations
  WHERE family='client_history' AND eligible AND canonical_person_id IS NOT NULL
  GROUP BY canonical_person_id
 ), first_known AS (
  SELECT e.*,c.event_day client_day FROM earliest e LEFT JOIN client_before c USING(person_id)
 ), active AS (
  SELECT person_id FROM earliest WHERE in_period
 ), period_requests AS (
  SELECT * FROM requests WHERE occurred_day>=p_from AND occurred_day<p_to
 ), latest_per_family AS (
  SELECT DISTINCT ON (source_namespace,stream_key) * FROM valid_runs
  WHERE (source_namespace=p_wix_namespace AND stream_key IN ('lead_entries_forms','lead_entries_quiz'))
   OR (source_namespace=p_client_namespace AND stream_key='lead_entries_client_history')
  ORDER BY source_namespace,stream_key,source_as_of DESC,started_at DESC,id DESC
 )
 SELECT jsonb_build_object(
  'available',EXISTS(SELECT FROM latest_per_family WHERE source='wix'),
  'observedAt',(SELECT max(finished_at) FROM latest_per_family),
  'firstKnownAcquisitions',(SELECT count(*) FROM first_known WHERE event_day>=p_from AND event_day<p_to AND (client_day IS NULL OR client_day>=event_day)),
  'peopleWithRequests',(SELECT count(*) FROM active),
  'sourceRequestPeople',(SELECT count(DISTINCT person_id) FROM period_requests),
  'requestCount',(SELECT count(*) FROM period_requests),
  'unresolvedDatedRequests',(SELECT count(*) FROM period_requests WHERE person_id IS NULL),
  'unresolvedNotionRows',(SELECT count(*) FROM notion WHERE person_id IS NULL AND event_day>=p_from AND event_day<p_to),
  'earlierClientEvidence',(SELECT count(*) FROM first_known WHERE event_day>=p_from AND event_day<p_to AND client_day<event_day),
  'knownBeforePeriod',(SELECT count(*) FROM first_known WHERE in_period AND least(event_day,client_day)<p_from),
  'excludedSourceRequests',(SELECT count(*) FROM observations WHERE family IN ('forms','quiz') AND NOT eligible AND occurred_day>=p_from AND occurred_day<p_to),
  'reciprocalClientHistoryBridges',(SELECT count(*) FROM bridge),
  'families',(SELECT coalesce(jsonb_agg(jsonb_build_object('family',replace(stream_key,'lead_entries_',''),'status',status,'from',covered_from,'to',covered_to,'observedAt',source_as_of,'counts',checkpoint->'counts')),'[]') FROM latest_per_family),
  'latestAttempts',(SELECT coalesce(jsonb_agg(jsonb_build_object('family',replace(a.stream_key,'lead_entries_',''),'status',a.status,'startedAt',a.started_at,'finishedAt',a.finished_at,'errorCode',a.error_code)),'[]') FROM (
   SELECT DISTINCT ON(stream_key) * FROM sync_runs
   WHERE query_profile_key=p_scope->replace(stream_key,'lead_entries_','')->>'profile'
    AND ((source_namespace=p_wix_namespace AND stream_key IN ('lead_entries_forms','lead_entries_quiz')) OR (source_namespace=p_client_namespace AND stream_key='lead_entries_client_history'))
   ORDER BY stream_key,started_at DESC,id DESC
  ) a),
  'sourceBasis','Wix + Notion',
  'definitionState','first_contact',
  'mappingPending',coalesce((SELECT jsonb_agg(jsonb_build_object('family',family,'requestedProfile',requested_profile,'publishedProfile',profile)) FROM selected_profiles WHERE requested_profile<>profile),'[]'::jsonb),
  'reason','Premières arrivées connues et personnes ayant une demande sont séparées. Les inscriptions Wix conservées ne couvrent pas tout l’historique. Une antériorité client sans date d’acquisition reste distincte.'
 ) INTO result;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.cockpit_lead_entry_rollup_v2(text,text,text,date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_lead_entry_rollup_v2(text,text,text,date,date,jsonb) TO service_role;

INSERT INTO public.cockpit_migrations(version) VALUES(11);
COMMIT;
