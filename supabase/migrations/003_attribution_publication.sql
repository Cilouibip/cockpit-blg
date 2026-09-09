-- Atomic publication of a validated deterministic calculation. Server access only.
BEGIN;
CREATE FUNCTION public.publish_attribution(p_run jsonb,p_results jsonb) RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE run uuid; row jsonb; prior uuid;
BEGIN
 IF jsonb_array_length(p_results)>5000 OR octet_length(p_run::text)>2000000 OR p_run->>'model'<>'last_non_direct' OR (p_run->>'lookback_days')::int<>30 OR (p_run->>'observation_horizon_days')::int<>90 THEN RAISE EXCEPTION 'invalid publication' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_run->>'calculation_fingerprint',0));
 SELECT id INTO prior FROM public.attribution_runs WHERE calculation_fingerprint=p_run->>'calculation_fingerprint' AND status='published';IF FOUND THEN RETURN prior;END IF;
 run=coalesce((p_run->>'id')::uuid,gen_random_uuid());
 INSERT INTO public.attribution_runs(id,calculation_fingerprint,supersedes_run_id,status,code_version,metric_definition_version,identity_cutoff_at,input_cutoff_at,input_manifest,model,lookback_days,observation_horizon_days,cohort_from,cohort_to,cohort_timezone,currency,tax_basis,scope,coverage_summary)
 VALUES(run,p_run->>'calculation_fingerprint',(p_run->>'supersedes_run_id')::uuid,'building',p_run->>'code_version',p_run->>'metric_definition_version',(p_run->>'identity_cutoff_at')::timestamptz,(p_run->>'input_cutoff_at')::timestamptz,p_run->'input_manifest','last_non_direct',30,90,(p_run->>'cohort_from')::timestamptz,(p_run->>'cohort_to')::timestamptz,p_run->>'cohort_timezone',p_run->>'currency','tax_inclusive',p_run->'scope',p_run->'coverage_summary');
 FOR row IN SELECT value FROM jsonb_array_elements(p_results) ORDER BY CASE WHEN value->>'target_kind'='acquisition' THEN 0 ELSE 1 END LOOP
  INSERT INTO public.attribution_results(id,attribution_run_id,person_id,target_kind,lead_registration_id,appointment_id,payment_id,anchor_result_id,selected_event_id,link_revision_id,ad_id,status,reason_code,conversion_at,acquisition_at,person_evidence_refs,mapping_refs,dimensions_snapshot,candidate_evidence_snapshot,target_snapshot,contribution_minor,currency,tax_basis,first_customer_proof,input_digest)
  VALUES((row->>'id')::uuid,run,(row->>'person_id')::uuid,row->>'target_kind',(row->>'lead_registration_id')::uuid,(row->>'appointment_id')::uuid,(row->>'payment_id')::uuid,(row->>'anchor_result_id')::uuid,(row->>'selected_event_id')::uuid,(row->>'link_revision_id')::uuid,(row->>'ad_id')::uuid,row->>'status',row->>'reason_code',(row->>'conversion_at')::timestamptz,(row->>'acquisition_at')::timestamptz,row->'person_evidence_refs',row->'mapping_refs',row->'dimensions_snapshot',row->'candidate_evidence_snapshot',row->'target_snapshot',(row->>'contribution_minor')::bigint,row->>'currency','tax_inclusive',row->'first_customer_proof',row->>'input_digest');
 END LOOP;
 UPDATE public.attribution_runs SET status='published',published_at=now() WHERE id=run;RETURN run;
END $$;
REVOKE ALL ON FUNCTION public.publish_attribution(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_attribution(jsonb,jsonb) TO service_role;
INSERT INTO public.cockpit_migrations(version) VALUES(3);
COMMIT;
