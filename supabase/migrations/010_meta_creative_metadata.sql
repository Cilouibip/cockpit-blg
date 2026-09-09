-- CLI scaffold normalized to the repository INTEGER registry (10).
-- Current creative metadata only; existing ad-day measures remain unchanged.
BEGIN;
CREATE FUNCTION public.import_meta_creative_metadata(p_run uuid,p_records jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.sync_runs; a public.ads; item jsonb; n integer; stamp timestamptz;
BEGIN
 IF jsonb_typeof(p_records) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid batch' USING ERRCODE='23514';END IF;
 n=jsonb_array_length(p_records);
 IF n<1 OR n>8 THEN RAISE EXCEPTION 'invalid batch size' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM public.sync_runs WHERE id=p_run FOR UPDATE;
 IF NOT FOUND OR r.source<>'meta' OR r.stream_key<>'ad_creative_metadata'
  OR r.query_profile_key<>'meta-creative-id-v1' OR r.coverage_kind<>'source_snapshot'
  THEN RAISE EXCEPTION 'invalid metadata run' USING ERRCODE='55000';END IF;
 -- Safe retry of the exact atomically published operation after lost HTTP response.
 IF r.status='complete' AND r.checkpoint=jsonb_build_object('records',p_records)
  AND r.pagination_complete AND r.rows_written=n THEN RETURN n;END IF;
 IF r.status<>'running' THEN RAISE EXCEPTION 'inactive metadata run' USING ERRCODE='55000';END IF;
 IF (SELECT count(DISTINCT value->>'adId') FROM jsonb_array_elements(p_records))<>n
  THEN RAISE EXCEPTION 'duplicate ad' USING ERRCODE='23514';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_records) ORDER BY value->>'adId' LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR
   NOT(item ?& ARRAY['accountId','adId','creativeId','previousCreativeId','observedAt']) OR
   (SELECT count(*) FROM jsonb_object_keys(item))<>5 OR
   item->>'accountId' IS DISTINCT FROM r.source_namespace OR
   coalesce(item->>'adId','')!~'^[0-9]{1,30}$' OR coalesce(item->>'creativeId','')!~'^[0-9]{1,30}$' OR
   jsonb_typeof(item->'previousCreativeId') NOT IN ('null','string') OR
   (item->>'previousCreativeId' IS NOT NULL AND item->>'previousCreativeId'!~'^[0-9]{1,30}$') OR
   coalesce(item->>'observedAt','')!~'(Z|[+-][0-9]{2}:[0-9]{2})$'
   THEN RAISE EXCEPTION 'invalid metadata record' USING ERRCODE='23514';END IF;
  stamp=(item->>'observedAt')::timestamptz;
  IF NOT isfinite(stamp) OR stamp<r.period_from OR stamp>=r.period_to OR stamp>clock_timestamp()+interval '1 minute'
   THEN RAISE EXCEPTION 'invalid observation time' USING ERRCODE='23514';END IF;
  SELECT * INTO a FROM public.ads WHERE source='meta' AND source_namespace=r.source_namespace
   AND external_id=item->>'adId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown ad' USING ERRCODE='P0002';END IF;
  IF a.creative_id IS DISTINCT FROM item->>'previousCreativeId'
   THEN RAISE EXCEPTION 'metadata changed' USING ERRCODE='40001';END IF;
  UPDATE public.ads SET creative_id=item->>'creativeId' WHERE id=a.id;
 END LOOP;
 UPDATE public.sync_runs SET status='complete',finished_at=clock_timestamp(),pagination_complete=true,
  rows_read=n,rows_written=n,rows_rejected=0,error_code=NULL,covered_from=period_from,covered_to=period_to,
  source_as_of=(SELECT min((value->>'observedAt')::timestamptz) FROM jsonb_array_elements(p_records)),
  checkpoint=jsonb_build_object('records',p_records) WHERE id=p_run;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.import_meta_creative_metadata(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_meta_creative_metadata(uuid,jsonb) TO service_role;

INSERT INTO public.cockpit_migrations(version) VALUES(10);
COMMIT;
