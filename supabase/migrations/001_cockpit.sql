-- Cockpit BLG: additive baseline, PostgreSQL 15+ / Supabase. No source account mutations.
-- See DECISIONS-ACTEES.md and docs/IMPLEMENTATION.md. Run once, inside this transaction.
BEGIN;
CREATE TABLE public.cockpit_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.rate_limits (key text PRIMARY KEY CHECK(length(key)=64), count integer NOT NULL CHECK(count>=0), expires_at timestamptz NOT NULL);
CREATE TABLE public.sync_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL,
 stream_key text NOT NULL, query_profile_key text NOT NULL, partition_key text NOT NULL,
 job_key text NOT NULL, attempt_no integer NOT NULL DEFAULT 1 CHECK(attempt_no>0), retry_of_run_id uuid REFERENCES public.sync_runs(id),
 connector_version text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','empty','partial','failed')),
 coverage_kind text NOT NULL CHECK(coverage_kind IN ('event_interval','source_snapshot','aggregate_period')),
 period_from timestamptz NOT NULL, period_to timestamptz NOT NULL, source_as_of timestamptz NOT NULL DEFAULT now(),
 covered_from timestamptz, covered_to timestamptz, pagination_complete boolean NOT NULL DEFAULT false, absence_means_zero boolean NOT NULL DEFAULT false,
 cursor_before text, cursor_after text, source_watermark text, rows_read integer NOT NULL DEFAULT 0, rows_written integer NOT NULL DEFAULT 0, rows_rejected integer NOT NULL DEFAULT 0,
 error_code text, content_digest text, UNIQUE(job_key,attempt_no), CHECK(period_from<period_to),
 CHECK(cursor_after IS NULL OR length(cursor_after)<1000), CHECK(error_code IS NULL OR error_code ~ '^[A-Za-z0-9_ -]{1,100}$'),
 CHECK(status NOT IN ('complete','empty') OR (finished_at IS NOT NULL AND pagination_complete AND rows_rejected=0))
);
CREATE UNIQUE INDEX one_running_partition ON public.sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key) WHERE status='running';
CREATE TABLE public.source_mappings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL,
 mapping_kind text NOT NULL CHECK(mapping_kind IN ('status','event_alias','ad_destination','source_authority')),
 source_key text NOT NULL, version integer NOT NULL CHECK(version>0), normalized_value jsonb NOT NULL,
 effective_from timestamptz NOT NULL, effective_to timestamptz, recorded_at timestamptz NOT NULL DEFAULT now(),
 supersedes_id uuid REFERENCES public.source_mappings(id), provenance text NOT NULL,
 UNIQUE(source,source_namespace,mapping_kind,source_key,version), CHECK(effective_to IS NULL OR effective_to>effective_from),
 CHECK(octet_length(normalized_value::text)<4000)
);
CREATE TABLE public.tracked_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
 placement text NOT NULL, current_version integer NOT NULL DEFAULT 0 CHECK(current_version>=0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE TABLE public.link_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), link_id uuid NOT NULL REFERENCES public.tracked_links(id),
 version integer NOT NULL CHECK(version>0), label text NOT NULL, placement text NOT NULL,
 tunnel text NOT NULL CHECK(tunnel IN ('quiz','masterclass')), campaign text NOT NULL, source text NOT NULL, medium text NOT NULL,
 destination_url text NOT NULL CHECK(destination_url IN ('https://quizz.blg-studio.fr/','https://www.blg-studio.fr/blg-rugby-mc')),
 generated_url text NOT NULL CHECK(length(generated_url)<3000), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(link_id,version), CHECK(position(id::text IN generated_url)>0)
);
CREATE TABLE public.people (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.person_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid REFERENCES public.people(id), source text NOT NULL, source_namespace text NOT NULL,
 identity_kind text NOT NULL CHECK(identity_kind IN ('external','email_hmac')), identity_key text NOT NULL,
 key_version integer NOT NULL DEFAULT 1, assignment_version integer NOT NULL DEFAULT 1,
 valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz,
 state text NOT NULL CHECK(state IN ('linked','ambiguous','unresolved')), evidence text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source,source_namespace,identity_kind,identity_key,key_version,assignment_version),
 CHECK(state<>'linked' OR (person_id IS NOT NULL AND length(evidence)>0)), CHECK(valid_to IS NULL OR valid_to>valid_from),
 CHECK(identity_kind<>'email_hmac' OR identity_key ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX identity_current ON public.person_identities(source,source_namespace,identity_kind,identity_key,key_version) WHERE valid_to IS NULL;
CREATE TABLE public.lead_registrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL, external_id text NOT NULL,
 person_identity_id uuid REFERENCES public.person_identities(id), person_id uuid REFERENCES public.people(id),
 tunnel text NOT NULL CHECK(tunnel IN ('quiz','masterclass')), registered_at timestamptz NOT NULL,
 journey_id uuid, anonymous_id uuid, session_id uuid, link_revision_id uuid REFERENCES public.link_revisions(id),
 evidence_state text NOT NULL CHECK(evidence_state IN ('backend_verified','unresolved','conflict')), source_locator text NOT NULL,
 payload_hash text NOT NULL, event_id uuid UNIQUE, sync_run_id uuid REFERENCES public.sync_runs(id),
 observed_at timestamptz NOT NULL DEFAULT now(), connector_version text NOT NULL DEFAULT 'signed-lead-v1',
 UNIQUE(source,source_namespace,external_id)
);
CREATE TABLE public.events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL, external_id text NOT NULL,
 event_name text NOT NULL CHECK(event_name IN ('landing_arrival','page_view','quiz_started','quiz_question_viewed','quiz_question_answered','quiz_completed','lead_form_viewed','lead_form_submitted','result_viewed','masterclass_optin_submitted','video_started','video_watch','bilan_clicked','lead_registered')),
 schema_version integer NOT NULL CHECK(schema_version=1), occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 visitor_namespace text NOT NULL, anonymous_id uuid, session_id uuid, journey_id uuid, tunnel text NOT NULL CHECK(tunnel IN ('quiz','masterclass')),
 page_version text NOT NULL, video_version text, playback_id uuid,
 link_revision_id uuid REFERENCES public.link_revisions(id), lead_registration_id uuid REFERENCES public.lead_registrations(id),
 person_identity_id uuid REFERENCES public.person_identities(id), person_id uuid REFERENCES public.people(id),
 ad_id text, adset_id text, campaign_id text, ad_namespace text,
 trust_level text NOT NULL CHECK(trust_level IN ('browser_observed','backend_verified','source_verified')),
 canonical_origin text, canonical_event_id text, source_sequence bigint,
 properties jsonb NOT NULL DEFAULT '{}', payload_hash text NOT NULL, sync_run_id uuid REFERENCES public.sync_runs(id),
 connector_version text NOT NULL DEFAULT 'first-party-v1',
 UNIQUE(source,source_namespace,external_id), CHECK(octet_length(properties::text)<12000),
 CHECK((canonical_origin IS NULL)=(canonical_event_id IS NULL)),
 CHECK(trust_level<>'browser_observed' OR (person_id IS NULL AND person_identity_id IS NULL AND lead_registration_id IS NULL AND event_name<>'lead_registered'))
);
ALTER TABLE public.lead_registrations ADD COLUMN success_event_id uuid REFERENCES public.events(id);
CREATE TABLE public.prospects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL, external_id text NOT NULL,
 person_id uuid REFERENCES public.people(id), person_identity_id uuid REFERENCES public.person_identities(id),
 display_name text, source_status text, normalized_status text NOT NULL DEFAULT 'unknown', status_mapping_id uuid REFERENCES public.source_mappings(id),
 owner_label text, responsible_ids jsonb NOT NULL DEFAULT '[]', closer_ids jsonb NOT NULL DEFAULT '[]',
 current_appointment_at text, next_follow_up_at text, outcome text, archived boolean NOT NULL DEFAULT false, notion_url text,
 source_updated_at timestamptz, observed_at timestamptz NOT NULL DEFAULT now(), connector_version text NOT NULL, mapping_version text NOT NULL,
 sync_run_id uuid REFERENCES public.sync_runs(id), UNIQUE(source,source_namespace,external_id),
 CHECK(display_name IS NULL OR length(display_name)<250), CHECK(octet_length(responsible_ids::text)<2000), CHECK(octet_length(closer_ids::text)<2000)
);
CREATE TABLE public.appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL, external_id text NOT NULL,
 identity_basis text NOT NULL CHECK(identity_basis IN ('stable_booking','notion_current_slot')),
 prospect_id uuid REFERENCES public.prospects(id), person_id uuid REFERENCES public.people(id), person_identity_id uuid REFERENCES public.person_identities(id),
 booked_at timestamptz, scheduled_at timestamptz, scheduled_day date, attended_at timestamptz, outcome_at timestamptz,
 status text NOT NULL CHECK(status IN ('scheduled','attended','no_show','cancelled','rescheduled','unknown')), source_status text,
 attendance_evidence text, evidence_state text NOT NULL DEFAULT 'unknown', schedule_version integer NOT NULL DEFAULT 1,
 status_mapping_id uuid REFERENCES public.source_mappings(id), supersedes_appointment_id uuid REFERENCES public.appointments(id),
 source_updated_at timestamptz, observed_at timestamptz NOT NULL DEFAULT now(), connector_version text NOT NULL, sync_run_id uuid REFERENCES public.sync_runs(id),
 UNIQUE(source,source_namespace,external_id), CHECK(supersedes_appointment_id IS DISTINCT FROM id),
 CHECK(attended_at IS NULL OR (status='attended' AND attendance_evidence IS NOT NULL))
);
CREATE TABLE public.commercial_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), prospect_id uuid REFERENCES public.prospects(id), appointment_id uuid REFERENCES public.appointments(id),
 field_key text NOT NULL CHECK(field_key IN ('snapshot_initial','source_status','owner_label','current_appointment_at','next_follow_up_at','archived','scheduled_at','status')),
 before_value jsonb, after_value jsonb, source_version_key text NOT NULL, source_effective_at timestamptz, observed_at timestamptz NOT NULL DEFAULT now(),
 mapping_id uuid REFERENCES public.source_mappings(id), sync_run_id uuid REFERENCES public.sync_runs(id),
 CHECK(num_nonnulls(prospect_id,appointment_id)=1), CHECK(octet_length(coalesce(before_value,'null')::text)<4000 AND octet_length(coalesce(after_value,'null')::text)<4000)
);
CREATE UNIQUE INDEX history_prospect_unique ON public.commercial_history(prospect_id,source_version_key,field_key) WHERE prospect_id IS NOT NULL;
CREATE UNIQUE INDEX history_appointment_unique ON public.commercial_history(appointment_id,source_version_key,field_key) WHERE appointment_id IS NOT NULL;
CREATE TABLE public.deals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL, external_id text NOT NULL,
 person_id uuid REFERENCES public.people(id), person_identity_id uuid REFERENCES public.person_identities(id), prospect_id uuid REFERENCES public.prospects(id),
 signed_at timestamptz, status text NOT NULL CHECK(status IN ('open','signed','cancelled','unknown')), contracted_minor bigint CHECK(contracted_minor>=0),
 currency text CHECK(currency ~ '^[A-Z]{3}$'), currency_exponent smallint CHECK(currency_exponent BETWEEN 0 AND 4),
 tax_basis text NOT NULL DEFAULT 'unknown' CHECK(tax_basis IN ('tax_inclusive','tax_exclusive','unknown')), source_locator text NOT NULL,
 source_updated_at timestamptz, observed_at timestamptz NOT NULL DEFAULT now(), connector_version text NOT NULL, sync_run_id uuid REFERENCES public.sync_runs(id),
 UNIQUE(source,source_namespace,external_id), CHECK(contracted_minor IS NULL OR (currency IS NOT NULL AND currency_exponent IS NOT NULL))
);
CREATE TABLE public.payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL, external_id text NOT NULL,
 person_id uuid REFERENCES public.people(id), person_identity_id uuid REFERENCES public.person_identities(id), deal_id uuid REFERENCES public.deals(id),
 kind text NOT NULL CHECK(kind IN ('receipt','refund','reversal')), status text NOT NULL CHECK(status IN ('pending','settled','failed','cancelled','unknown')),
 effective_at timestamptz, gross_minor bigint NOT NULL CHECK(gross_minor>0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 currency_exponent smallint NOT NULL CHECK(currency_exponent BETWEEN 0 AND 4), tax_minor bigint CHECK(tax_minor>=0 AND tax_minor<=gross_minor),
 tax_basis text NOT NULL DEFAULT 'unknown' CHECK(tax_basis IN ('tax_inclusive','tax_exclusive','unknown')), source_locator text NOT NULL,
 original_payment_id uuid REFERENCES public.payments(id), external_original_id text, reversal_direction smallint CHECK(reversal_direction IN (-1,1)),
 reconciliation_state text NOT NULL DEFAULT 'unresolved' CHECK(reconciliation_state IN ('reconciled','unresolved','anomaly')),
 anomaly_code text, order_id text, subscription_id text, installment_id text,
 source_updated_at timestamptz, observed_at timestamptz NOT NULL DEFAULT now(), connector_version text NOT NULL, sync_run_id uuid REFERENCES public.sync_runs(id),
 UNIQUE(source,source_namespace,external_id), CHECK(status<>'settled' OR effective_at IS NOT NULL),
 CHECK(original_payment_id IS DISTINCT FROM id), CHECK(kind<>'receipt' OR original_payment_id IS NULL),
 CHECK((kind='reversal')=(reversal_direction IS NOT NULL))
);
CREATE TABLE public.ads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL DEFAULT 'meta', source_namespace text NOT NULL, external_id text NOT NULL,
 campaign_id text, adset_id text, creative_id text, ad_name text, campaign_name text,
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 connector_version text NOT NULL, UNIQUE(source,source_namespace,external_id)
);
CREATE TABLE public.ad_daily (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ad_id uuid NOT NULL REFERENCES public.ads(id), sync_run_id uuid NOT NULL REFERENCES public.sync_runs(id),
 date date NOT NULL, base_profile_key text NOT NULL DEFAULT 'ad-day-no-breakdown-v1', timezone text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 currency_exponent smallint NOT NULL DEFAULT 2 CHECK(currency_exponent BETWEEN 0 AND 4), spend_minor bigint CHECK(spend_minor>=0),
 impressions bigint CHECK(impressions>=0), outbound_clicks bigint CHECK(outbound_clicks>=0), row_state text NOT NULL CHECK(row_state IN ('complete','partial')),
 campaign_id text, campaign_name text, ad_name text, UNIQUE(ad_id,date,base_profile_key,sync_run_id)
);
CREATE TABLE public.meta_conversions_daily (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ad_id uuid NOT NULL REFERENCES public.ads(id), sync_run_id uuid NOT NULL REFERENCES public.sync_runs(id),
 date date NOT NULL, report_profile_key text NOT NULL, action_type text NOT NULL, metric_kind text NOT NULL CHECK(metric_kind IN ('actions','unique_actions','action_values')),
 action_count numeric CHECK(action_count>=0), action_value_minor numeric, currency text, currency_exponent smallint, timezone text NOT NULL,
 report_profile jsonb NOT NULL, UNIQUE(ad_id,date,report_profile_key,action_type,metric_kind,sync_run_id),
 CHECK((metric_kind IN ('actions','unique_actions') AND action_count IS NOT NULL AND action_value_minor IS NULL) OR (metric_kind='action_values' AND action_count IS NULL AND action_value_minor IS NOT NULL))
);
CREATE TABLE public.source_aggregates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL, source_namespace text NOT NULL, metric_key text NOT NULL,
 period_from timestamptz NOT NULL, period_to timestamptz NOT NULL, dimensions_key text NOT NULL, report_profile_key text NOT NULL,
 sync_run_id uuid NOT NULL REFERENCES public.sync_runs(id), timezone text NOT NULL, coverage_state text NOT NULL CHECK(coverage_state IN ('complete','partial','unknown')),
 value numeric, unit text NOT NULL, currency text, currency_exponent smallint,
 tax_basis text NOT NULL DEFAULT 'unknown' CHECK(tax_basis IN ('tax_inclusive','tax_exclusive','unknown')), dimensions jsonb NOT NULL DEFAULT '{}',
 definition_version text NOT NULL, source_locator text NOT NULL,
 UNIQUE(source,source_namespace,metric_key,period_from,period_to,dimensions_key,report_profile_key,sync_run_id), CHECK(period_from<period_to), CHECK(octet_length(dimensions::text)<4000)
);
CREATE TABLE public.attribution_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), calculation_fingerprint text NOT NULL UNIQUE,
 supersedes_run_id uuid REFERENCES public.attribution_runs(id), status text NOT NULL CHECK(status IN ('building','published','failed')),
 code_version text NOT NULL, metric_definition_version text NOT NULL, identity_cutoff_at timestamptz NOT NULL, input_cutoff_at timestamptz NOT NULL,
 input_manifest jsonb NOT NULL, model text NOT NULL CHECK(model='last_non_direct'), lookback_days integer NOT NULL CHECK(lookback_days=30), observation_horizon_days integer NOT NULL CHECK(observation_horizon_days=90),
 cohort_from timestamptz NOT NULL, cohort_to timestamptz NOT NULL, cohort_timezone text NOT NULL, currency text NOT NULL,
 tax_basis text NOT NULL CHECK(tax_basis='tax_inclusive'), scope jsonb NOT NULL, coverage_summary jsonb NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
 CHECK(cohort_from<cohort_to), CHECK(status<>'published' OR published_at IS NOT NULL), CHECK(octet_length(input_manifest::text)<2000000)
);
CREATE TABLE public.attribution_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attribution_run_id uuid NOT NULL REFERENCES public.attribution_runs(id), person_id uuid REFERENCES public.people(id),
 target_kind text NOT NULL CHECK(target_kind IN ('acquisition','lead','appointment_booked','appointment_held','new_customer','payment')),
 lead_registration_id uuid REFERENCES public.lead_registrations(id), appointment_id uuid REFERENCES public.appointments(id), payment_id uuid REFERENCES public.payments(id),
 anchor_result_id uuid REFERENCES public.attribution_results(id), selected_event_id uuid REFERENCES public.events(id), link_revision_id uuid REFERENCES public.link_revisions(id), ad_id uuid REFERENCES public.ads(id),
 status text NOT NULL CHECK(status IN ('attributed','direct','organic','unknown','ineligible')), reason_code text,
 conversion_at timestamptz, acquisition_at timestamptz, person_evidence_refs jsonb NOT NULL, mapping_refs jsonb NOT NULL,
 dimensions_snapshot jsonb NOT NULL, candidate_evidence_snapshot jsonb NOT NULL, target_snapshot jsonb NOT NULL,
 contribution_minor bigint, currency text, tax_basis text NOT NULL DEFAULT 'unknown', first_customer_proof jsonb NOT NULL, input_digest text NOT NULL,
 weight numeric NOT NULL DEFAULT 1 CHECK(weight=1),
 CHECK(num_nonnulls(lead_registration_id,appointment_id,payment_id)=1),
 CHECK((target_kind='acquisition' AND appointment_id IS NULL) OR (target_kind='lead' AND lead_registration_id IS NOT NULL) OR (target_kind IN ('appointment_booked','appointment_held') AND appointment_id IS NOT NULL) OR (target_kind IN ('new_customer','payment') AND payment_id IS NOT NULL)),
 CHECK((target_kind='acquisition' AND anchor_result_id IS NULL) OR (target_kind<>'acquisition' AND anchor_result_id IS NOT NULL)),
 CHECK(octet_length(candidate_evidence_snapshot::text)<250000 AND octet_length(target_snapshot::text)<16000)
);
CREATE UNIQUE INDEX attribution_lead_target ON public.attribution_results(attribution_run_id,target_kind,lead_registration_id) WHERE lead_registration_id IS NOT NULL;
CREATE UNIQUE INDEX attribution_appointment_target ON public.attribution_results(attribution_run_id,target_kind,appointment_id) WHERE appointment_id IS NOT NULL;
CREATE UNIQUE INDEX attribution_payment_target ON public.attribution_results(attribution_run_id,target_kind,payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX attribution_person_anchor ON public.attribution_results(attribution_run_id,person_id) WHERE target_kind='acquisition' AND person_id IS NOT NULL;

-- Invariants and server-only RPCs. No SECURITY DEFINER and no arbitrary SQL RPC.
CREATE FUNCTION public.cockpit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'immutable evidence' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_link_revision BEFORE UPDATE OR DELETE ON public.link_revisions FOR EACH ROW EXECUTE FUNCTION public.cockpit_immutable();
CREATE TRIGGER immutable_mapping BEFORE UPDATE OR DELETE ON public.source_mappings FOR EACH ROW EXECUTE FUNCTION public.cockpit_immutable();
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON public.events FOR EACH ROW EXECUTE FUNCTION public.cockpit_immutable();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON public.commercial_history FOR EACH ROW EXECUTE FUNCTION public.cockpit_immutable();
CREATE FUNCTION public.cockpit_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.source||':'||NEW.source_namespace||':'||NEW.identity_kind||':'||NEW.identity_key,0));
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'valid_to') IS DISTINCT FROM (to_jsonb(OLD)-'valid_to') THEN RAISE EXCEPTION 'identity assignment immutable' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.person_identities i WHERE i.id<>NEW.id AND i.source=NEW.source AND i.source_namespace=NEW.source_namespace AND i.identity_kind=NEW.identity_kind AND i.identity_key=NEW.identity_key AND i.key_version=NEW.key_version AND tstzrange(i.valid_from,i.valid_to,'[)') && tstzrange(NEW.valid_from,NEW.valid_to,'[)')) THEN RAISE EXCEPTION 'overlapping identity assignment' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_guard BEFORE INSERT OR UPDATE ON public.person_identities FOR EACH ROW EXECUTE FUNCTION public.cockpit_identity_guard();
CREATE TRIGGER identity_no_delete BEFORE DELETE ON public.person_identities FOR EACH ROW EXECUTE FUNCTION public.cockpit_immutable();
CREATE FUNCTION public.cockpit_appointment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('appointment-chain',0));
 IF NEW.supersedes_appointment_id IS NOT NULL AND EXISTS(WITH RECURSIVE chain AS (SELECT id,supersedes_appointment_id FROM public.appointments WHERE id=NEW.supersedes_appointment_id UNION SELECT a.id,a.supersedes_appointment_id FROM public.appointments a JOIN chain c ON a.id=c.supersedes_appointment_id) SELECT 1 FROM chain WHERE id=NEW.id) THEN RAISE EXCEPTION 'appointment cycle' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER appointment_guard BEFORE INSERT OR UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.cockpit_appointment_guard();
CREATE FUNCTION public.cockpit_payment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original public.payments; total_refunded bigint;
BEGIN
 IF NEW.kind IN ('refund','reversal') AND NEW.original_payment_id IS NOT NULL THEN
  SELECT * INTO original FROM public.payments WHERE id=NEW.original_payment_id FOR UPDATE;
  IF original.id IS NULL THEN RETURN NEW; END IF;
  IF original.source<>NEW.source OR original.source_namespace<>NEW.source_namespace OR original.currency<>NEW.currency OR original.currency_exponent<>NEW.currency_exponent OR (NEW.kind='refund' AND original.kind<>'receipt') THEN NEW.reconciliation_state='anomaly';NEW.anomaly_code='incompatible_original';
  ELSIF NEW.kind='refund' AND NEW.status='settled' THEN
   SELECT coalesce(sum(gross_minor),0) INTO total_refunded FROM public.payments WHERE original_payment_id=original.id AND kind='refund' AND status='settled' AND reconciliation_state='reconciled' AND id<>NEW.id;
   IF total_refunded+NEW.gross_minor>original.gross_minor THEN NEW.reconciliation_state='anomaly';NEW.anomaly_code='refund_exceeds_receipt';END IF;
  END IF;
 ELSIF NEW.kind='refund' THEN NEW.reconciliation_state='unresolved';NEW.anomaly_code='original_missing';
 END IF;
 IF TG_OP='UPDATE' AND OLD.source_updated_at IS NOT NULL AND NEW.source_updated_at<OLD.source_updated_at THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_guard BEFORE INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.cockpit_payment_guard();
CREATE FUNCTION public.cockpit_attribution_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE anchor public.attribution_results; run_status text;
BEGIN
 IF TG_TABLE_NAME='attribution_runs' THEN
  IF TG_OP<>'INSERT' AND OLD.status='published' THEN RAISE EXCEPTION 'published run immutable' USING ERRCODE='55000';END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  RETURN NEW;
 END IF;
 SELECT status INTO run_status FROM public.attribution_runs WHERE id=coalesce(NEW.attribution_run_id,OLD.attribution_run_id) FOR UPDATE;
 IF run_status='published' THEN RAISE EXCEPTION 'published result immutable' USING ERRCODE='55000';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.anchor_result_id IS NOT NULL THEN
  SELECT * INTO anchor FROM public.attribution_results WHERE id=NEW.anchor_result_id;
  IF anchor.target_kind<>'acquisition' OR anchor.attribution_run_id<>NEW.attribution_run_id OR anchor.person_id IS DISTINCT FROM NEW.person_id THEN RAISE EXCEPTION 'invalid acquisition anchor' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attribution_run_guard BEFORE UPDATE OR DELETE ON public.attribution_runs FOR EACH ROW EXECUTE FUNCTION public.cockpit_attribution_guard();
CREATE TRIGGER attribution_result_guard BEFORE INSERT OR UPDATE OR DELETE ON public.attribution_results FOR EACH ROW EXECUTE FUNCTION public.cockpit_attribution_guard();

CREATE FUNCTION public.save_tracked_link(p_link_id uuid,p_revision jsonb,p_expected_version integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE current_link public.tracked_links;
BEGIN
 INSERT INTO public.tracked_links(id,title,placement) VALUES(p_link_id,p_revision->>'label',p_revision->>'placement') ON CONFLICT(id) DO NOTHING;
 SELECT * INTO current_link FROM public.tracked_links WHERE id=p_link_id FOR UPDATE;
 IF current_link.current_version<>p_expected_version THEN RAISE EXCEPTION 'version conflict' USING ERRCODE='40001';END IF;
 IF current_link.archived_at IS NOT NULL THEN RAISE EXCEPTION 'archived link' USING ERRCODE='55000';END IF;
 IF (p_revision->>'link_id')::uuid<>p_link_id OR (p_revision->>'version')::int<>p_expected_version+1 THEN RAISE EXCEPTION 'revision mismatch' USING ERRCODE='23514';END IF;
 INSERT INTO public.link_revisions(id,link_id,version,label,placement,tunnel,campaign,source,medium,destination_url,generated_url)
 VALUES((p_revision->>'id')::uuid,p_link_id,p_expected_version+1,p_revision->>'label',p_revision->>'placement',p_revision->>'tunnel',p_revision->>'campaign',p_revision->>'source',p_revision->>'medium',p_revision->>'destination_url',p_revision->>'generated_url');
 UPDATE public.tracked_links SET current_version=p_expected_version+1,title=p_revision->>'label',placement=p_revision->>'placement',updated_at=now() WHERE id=p_link_id;
 RETURN jsonb_build_object('id',p_link_id,'version',p_expected_version+1);
END $$;
CREATE FUNCTION public.archive_tracked_link(p_link_id uuid,p_archived boolean,p_expected_version integer) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE current_link public.tracked_links;
BEGIN
 SELECT * INTO current_link FROM public.tracked_links WHERE id=p_link_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE='P0002';END IF;
 IF current_link.current_version<>p_expected_version THEN RAISE EXCEPTION 'version conflict' USING ERRCODE='40001';END IF;
 UPDATE public.tracked_links SET archived_at=CASE WHEN p_archived THEN now() ELSE NULL END,updated_at=now() WHERE id=p_link_id;
 RETURN true;
END $$;
CREATE FUNCTION public.consume_rate_limit(p_key text,p_limit integer,p_seconds integer) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 10000 OR p_seconds NOT BETWEEN 1 AND 3600 THEN RAISE EXCEPTION 'invalid limiter' USING ERRCODE='23514';END IF;
 DELETE FROM public.rate_limits WHERE expires_at<now()-interval '1 hour';
 INSERT INTO public.rate_limits(key,count,expires_at) VALUES(p_key,1,now()+make_interval(secs=>p_seconds)) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.count+1 END,expires_at=CASE WHEN rate_limits.expires_at<=now() THEN now()+make_interval(secs=>p_seconds) ELSE rate_limits.expires_at END RETURNING count INTO n;
 RETURN n<=p_limit;
END $$;

CREATE FUNCTION public.ingest_browser_event(p_event jsonb,p_payload_hash text) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE prior public.events; link uuid;
BEGIN
 SELECT * INTO prior FROM public.events WHERE source='first_party' AND source_namespace=p_event->>'tunnel' AND external_id=p_event->>'event_id';
 IF FOUND THEN IF prior.payload_hash<>p_payload_hash THEN RAISE EXCEPTION 'event conflict' USING ERRCODE='23505';END IF;RETURN jsonb_build_object('duplicate',true);END IF;
 link=(p_event->>'link_revision_id')::uuid;
 IF link IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.link_revisions WHERE id=link AND tunnel=p_event->>'tunnel') THEN link=NULL;END IF;
 INSERT INTO public.events(source,source_namespace,external_id,event_name,schema_version,occurred_at,visitor_namespace,anonymous_id,session_id,journey_id,tunnel,page_version,video_version,playback_id,link_revision_id,ad_id,adset_id,campaign_id,trust_level,properties,payload_hash,canonical_origin,canonical_event_id)
 VALUES('first_party',p_event->>'tunnel',p_event->>'event_id',p_event->>'event_name',1,(p_event->>'occurred_at')::timestamptz,'blg-web-v1',(p_event->>'anonymous_id')::uuid,(p_event->>'session_id')::uuid,(p_event->>'journey_id')::uuid,p_event->>'tunnel',p_event->>'page_version',p_event->'properties'->>'video_version',(p_event->'properties'->>'playback_id')::uuid,link,p_event->>'ad_id',p_event->>'adset_id',p_event->>'campaign_id','browser_observed',p_event->'properties',p_payload_hash,'blg-web-v1',p_event->>'event_id');
 RETURN jsonb_build_object('duplicate',false);
END $$;
CREATE FUNCTION public.register_lead(p_lead jsonb,p_payload_hash text) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE prior public.lead_registrations; ext public.person_identities; em public.person_identities; person uuid; assignment uuid; lead uuid; ev uuid; link uuid; state text='backend_verified';
BEGIN
 -- A stable global lock keeps cross-namespace/email resolution deterministic at this small intake volume.
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-identity-resolution',0));
 SELECT * INTO prior FROM public.lead_registrations WHERE source=p_lead->>'source' AND source_namespace=p_lead->>'source_account_id' AND external_id=p_lead->>'external_id';
 IF FOUND THEN IF prior.payload_hash<>p_payload_hash THEN RAISE EXCEPTION 'lead conflict' USING ERRCODE='23505';END IF;RETURN jsonb_build_object('duplicate',true,'resolved',prior.person_id IS NOT NULL);END IF;
 SELECT * INTO ext FROM public.person_identities WHERE source=p_lead->>'source' AND source_namespace=(p_lead->>'source_account_id')||':'||(p_lead->'identity'->>'namespace') AND identity_kind='external' AND identity_key=p_lead->'identity'->>'external_id' AND valid_to IS NULL;
 IF p_lead->'identity'->>'email_hmac' IS NOT NULL THEN SELECT * INTO em FROM public.person_identities WHERE source='identity' AND source_namespace='blg-email-v1' AND identity_kind='email_hmac' AND identity_key=p_lead->'identity'->>'email_hmac' AND valid_to IS NULL;END IF;
 IF (ext.id IS NOT NULL AND ext.state<>'linked') OR (em.id IS NOT NULL AND em.state<>'linked') OR (ext.person_id IS NOT NULL AND em.person_id IS NOT NULL AND ext.person_id<>em.person_id) THEN state='unresolved';person=NULL;
 ELSE
  person=coalesce(ext.person_id,em.person_id);
  IF person IS NULL THEN INSERT INTO public.people DEFAULT VALUES RETURNING id INTO person;END IF;
  IF ext.id IS NULL THEN
   INSERT INTO public.person_identities(person_id,source,source_namespace,identity_kind,identity_key,state,evidence) VALUES(person,p_lead->>'source',(p_lead->>'source_account_id')||':'||(p_lead->'identity'->>'namespace'),'external',p_lead->'identity'->>'external_id','linked','signed backend registration') RETURNING id INTO assignment;
  ELSE assignment=ext.id; END IF;
  IF em.id IS NULL AND p_lead->'identity'->>'email_hmac' IS NOT NULL THEN INSERT INTO public.person_identities(person_id,source,source_namespace,identity_kind,identity_key,state,evidence) VALUES(person,'identity','blg-email-v1','email_hmac',p_lead->'identity'->>'email_hmac','linked','normalized email HMAC from signed backend');END IF;
 END IF;
 link=(p_lead->>'link_revision_id')::uuid;IF link IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.link_revisions WHERE id=link AND tunnel=p_lead->>'tunnel') THEN link=NULL;END IF;
 INSERT INTO public.lead_registrations(source,source_namespace,external_id,person_identity_id,person_id,tunnel,registered_at,journey_id,anonymous_id,session_id,link_revision_id,evidence_state,source_locator,payload_hash,event_id)
 VALUES(p_lead->>'source',p_lead->>'source_account_id',p_lead->>'external_id',assignment,person,p_lead->>'tunnel',(p_lead->>'registered_at')::timestamptz,(p_lead->>'journey_id')::uuid,(p_lead->>'anonymous_id')::uuid,(p_lead->>'session_id')::uuid,link,state,'backend:'||(p_lead->>'external_id'),p_payload_hash,(p_lead->>'event_id')::uuid) RETURNING id INTO lead;
 INSERT INTO public.events(source,source_namespace,external_id,event_name,schema_version,occurred_at,visitor_namespace,anonymous_id,session_id,journey_id,tunnel,page_version,link_revision_id,lead_registration_id,person_identity_id,person_id,trust_level,properties,payload_hash,canonical_origin,canonical_event_id)
 VALUES(p_lead->>'source',p_lead->>'source_account_id',p_lead->>'event_id','lead_registered',1,(p_lead->>'registered_at')::timestamptz,'blg-web-v1',(p_lead->>'anonymous_id')::uuid,(p_lead->>'session_id')::uuid,(p_lead->>'journey_id')::uuid,p_lead->>'tunnel','backend-v1',link,lead,assignment,person,'backend_verified','{}',p_payload_hash,p_lead->>'source_account_id',p_lead->>'event_id') RETURNING id INTO ev;
 UPDATE public.lead_registrations SET success_event_id=ev WHERE id=lead;
 RETURN jsonb_build_object('duplicate',false,'resolved',person IS NOT NULL);
END $$;
ALTER TABLE public.sync_runs ADD COLUMN date_from date, ADD COLUMN date_to date;
CREATE FUNCTION public.begin_sync(p_source text,p_namespace text,p_from timestamptz,p_to timestamptz,p_profile text,p_coverage_kind text,p_date_from date DEFAULT NULL,p_date_to date DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE run uuid; job text; attempt integer;
BEGIN
 IF p_source NOT IN ('meta','notion','wix') THEN RAISE EXCEPTION 'unsupported source' USING ERRCODE='23514';END IF;
 job=p_source||':'||p_namespace||':'||p_profile||':'||p_from::text||':'||p_to::text;
 PERFORM pg_advisory_xact_lock(hashtextextended(job,0));
 UPDATE public.sync_runs SET status='failed',finished_at=now(),error_code='expired_worker' WHERE job_key=job AND status='running' AND started_at<now()-interval '10 minutes';
 SELECT coalesce(max(attempt_no),0)+1 INTO attempt FROM public.sync_runs WHERE job_key=job;
 INSERT INTO public.sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,attempt_no,connector_version,period_from,period_to,coverage_kind,date_from,date_to)
 VALUES(p_source,p_namespace,CASE p_source WHEN 'meta' THEN 'ad_daily' WHEN 'notion' THEN 'prospects_current' ELSE 'aggregates' END,p_profile,p_from::text||'/'||p_to::text,job,attempt,'read-v1',p_from,p_to,p_coverage_kind,p_date_from,p_date_to) RETURNING id INTO run;
 RETURN run;
END $$;
CREATE FUNCTION public.import_meta_page(p_run uuid,p_records jsonb,p_cursor text) RETURNS integer LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE run public.sync_runs; row jsonb; ad uuid; conversion jsonb; n integer=0;
BEGIN
 SELECT * INTO run FROM public.sync_runs WHERE id=p_run AND source='meta' AND status='running' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'inactive run' USING ERRCODE='55000';END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_records) LOOP
  IF row->>'accountId'<>run.source_namespace OR (row->>'date')::date<run.date_from OR (row->>'date')::date>=run.date_to THEN RAISE EXCEPTION 'source mismatch' USING ERRCODE='23514';END IF;
  INSERT INTO public.ads(source,source_namespace,external_id,campaign_id,adset_id,ad_name,campaign_name,connector_version,last_seen_at)
  VALUES('meta',run.source_namespace,row->>'adId',row->>'campaignId',row->>'adsetId',row->>'adName',row->>'campaignName',row->>'connectorVersion',(row->>'observedAt')::timestamptz)
  ON CONFLICT(source,source_namespace,external_id) DO UPDATE SET campaign_id=excluded.campaign_id,adset_id=excluded.adset_id,ad_name=excluded.ad_name,campaign_name=excluded.campaign_name,last_seen_at=excluded.last_seen_at WHERE excluded.last_seen_at>=ads.last_seen_at RETURNING id INTO ad;
  IF ad IS NULL THEN SELECT id INTO ad FROM public.ads WHERE source='meta' AND source_namespace=run.source_namespace AND external_id=row->>'adId';END IF;
  INSERT INTO public.ad_daily(ad_id,sync_run_id,date,timezone,currency,spend_minor,impressions,outbound_clicks,row_state,campaign_id,campaign_name,ad_name)
  VALUES(ad,p_run,(row->>'date')::date,row->>'timezone',row->>'currency',(row->>'spendMinor')::bigint,(row->>'impressions')::bigint,(row->>'outboundClicks')::bigint,CASE WHEN row->>'spendMinor' IS NOT NULL AND row->>'impressions' IS NOT NULL AND row->>'outboundClicks' IS NOT NULL THEN 'complete' ELSE 'partial' END,row->>'campaignId',row->>'campaignName',row->>'adName')
  ON CONFLICT(ad_id,date,base_profile_key,sync_run_id) DO NOTHING;
  FOR conversion IN SELECT value FROM jsonb_array_elements(row->'reportedConversions') LOOP
   INSERT INTO public.meta_conversions_daily(ad_id,sync_run_id,date,report_profile_key,action_type,metric_kind,action_count,timezone,report_profile)
   VALUES(ad,p_run,(row->>'date')::date,run.query_profile_key||':'||(conversion->>'window'),conversion->>'action','actions',(conversion->>'count')::numeric,row->>'timezone',jsonb_build_object('window',conversion->>'window','action_report_time','impression','level','ad','breakdowns','none','api_profile',run.query_profile_key)) ON CONFLICT DO NOTHING;
  END LOOP;
  n=n+1;
 END LOOP;
 UPDATE public.sync_runs SET cursor_after=p_cursor,rows_written=(SELECT count(*) FROM public.ad_daily WHERE sync_run_id=p_run) WHERE id=p_run;
 RETURN n;
END $$;
CREATE FUNCTION public.import_notion_page(p_run uuid,p_records jsonb,p_cursor text) RETURNS integer LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE run public.sync_runs; row jsonb; old public.prospects; pid uuid; field text; before_val jsonb; after_val jsonb; data jsonb; n integer=0; appt public.appointments; date_value text;
BEGIN
 SELECT * INTO run FROM public.sync_runs WHERE id=p_run AND source='notion' AND status='running' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'inactive run' USING ERRCODE='55000';END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_records) LOOP
  IF row->>'accountId'<>run.source_namespace THEN RAISE EXCEPTION 'source mismatch' USING ERRCODE='23514';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('notion:'||run.source_namespace||':'||(row->>'externalId'),0));
  SELECT * INTO old FROM public.prospects WHERE source='notion' AND source_namespace=run.source_namespace AND external_id=row->>'externalId' FOR UPDATE;
  IF old.id IS NOT NULL AND old.source_updated_at>=(row->>'sourceUpdatedAt')::timestamptz THEN CONTINUE;END IF;
  data=jsonb_build_object('source_status',row->'status','owner_label',row->'responsible'->>0,'current_appointment_at',row->'appointmentAt','next_follow_up_at',row->'nextFollowUpAt','archived',row->'archived');
  INSERT INTO public.prospects(source,source_namespace,external_id,display_name,source_status,owner_label,responsible_ids,closer_ids,current_appointment_at,next_follow_up_at,archived,notion_url,source_updated_at,observed_at,connector_version,mapping_version,sync_run_id)
  VALUES('notion',run.source_namespace,row->>'externalId',left(row->>'name',249),row->>'status',row->'responsible'->>0,coalesce(row->'responsible','[]'),coalesce(row->'closer','[]'),row->>'appointmentAt',row->>'nextFollowUpAt',(row->>'archived')::boolean,row->>'notionUrl',(row->>'sourceUpdatedAt')::timestamptz,(row->>'observedAt')::timestamptz,row->>'connectorVersion',row->>'mappingVersion',p_run)
  ON CONFLICT(source,source_namespace,external_id) DO UPDATE SET display_name=excluded.display_name,source_status=excluded.source_status,owner_label=excluded.owner_label,responsible_ids=excluded.responsible_ids,closer_ids=excluded.closer_ids,current_appointment_at=excluded.current_appointment_at,next_follow_up_at=excluded.next_follow_up_at,archived=excluded.archived,source_updated_at=excluded.source_updated_at,observed_at=excluded.observed_at,sync_run_id=p_run RETURNING id INTO pid;
  IF old.id IS NULL THEN
   INSERT INTO public.commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id) VALUES(pid,'snapshot_initial',NULL,data,row->>'sourceUpdatedAt',p_run) ON CONFLICT DO NOTHING;
  ELSE
   FOREACH field IN ARRAY ARRAY['source_status','owner_label','current_appointment_at','next_follow_up_at','archived'] LOOP
    before_val=to_jsonb(old)->field;after_val=data->field;
    IF before_val IS DISTINCT FROM after_val THEN INSERT INTO public.commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id) VALUES(pid,field,before_val,after_val,row->>'sourceUpdatedAt',p_run) ON CONFLICT DO NOTHING;END IF;
   END LOOP;
  END IF;
  date_value=row->>'appointmentAt';
  SELECT * INTO appt FROM public.appointments WHERE source='notion' AND source_namespace=run.source_namespace AND external_id=(row->>'externalId')||':current-slot' FOR UPDATE;
  IF date_value IS NOT NULL OR appt.id IS NOT NULL THEN
   INSERT INTO public.appointments(source,source_namespace,external_id,identity_basis,prospect_id,scheduled_at,scheduled_day,status,source_status,evidence_state,source_updated_at,observed_at,connector_version,sync_run_id)
   VALUES('notion',run.source_namespace,(row->>'externalId')||':current-slot','notion_current_slot',pid,CASE WHEN length(date_value)>10 THEN date_value::timestamptz ELSE NULL END,CASE WHEN length(date_value)=10 THEN date_value::date ELSE NULL END,'unknown',row->>'status','current_slot_only',(row->>'sourceUpdatedAt')::timestamptz,(row->>'observedAt')::timestamptz,row->>'connectorVersion',p_run)
   ON CONFLICT(source,source_namespace,external_id) DO UPDATE SET scheduled_at=excluded.scheduled_at,scheduled_day=excluded.scheduled_day,status='unknown',attended_at=NULL,attendance_evidence=NULL,source_status=excluded.source_status,schedule_version=CASE WHEN appointments.scheduled_at IS DISTINCT FROM excluded.scheduled_at OR appointments.scheduled_day IS DISTINCT FROM excluded.scheduled_day THEN appointments.schedule_version+1 ELSE appointments.schedule_version END,source_updated_at=excluded.source_updated_at,observed_at=excluded.observed_at,sync_run_id=p_run;
  END IF;
  n=n+1;
 END LOOP;
 UPDATE public.sync_runs SET cursor_after=p_cursor,rows_written=rows_written+n WHERE id=p_run;
 RETURN n;
END $$;
CREATE FUNCTION public.finish_sync(p_run uuid,p_status text,p_read integer,p_rejected integer,p_complete boolean,p_error text) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.sync_runs SET status=p_status,finished_at=now(),rows_read=p_read,rows_rejected=p_rejected,pagination_complete=p_complete,error_code=p_error,covered_from=CASE WHEN p_complete THEN period_from ELSE NULL END,covered_to=CASE WHEN p_complete THEN period_to ELSE NULL END WHERE id=p_run AND status='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'inactive run' USING ERRCODE='55000';END IF;
 RETURN true;
END $$;

CREATE VIEW public.v_links_current WITH (security_invoker=true) AS SELECT l.archived_at,r.* FROM public.tracked_links l JOIN public.link_revisions r ON r.link_id=l.id AND r.version=l.current_version;
CREATE VIEW public.v_events_canonical WITH (security_invoker=true) AS SELECT DISTINCT ON (coalesce(canonical_origin,source||':'||source_namespace),coalesce(canonical_event_id,external_id)) * FROM public.events ORDER BY coalesce(canonical_origin,source||':'||source_namespace),coalesce(canonical_event_id,external_id),CASE trust_level WHEN 'backend_verified' THEN 0 WHEN 'source_verified' THEN 1 ELSE 2 END,received_at,id;
CREATE VIEW public.v_visits WITH (security_invoker=true) AS SELECT visitor_namespace,session_id,tunnel,min(occurred_at) AS arrived_at,count(*) AS page_observations FROM public.v_events_canonical WHERE event_name IN ('landing_arrival','page_view') AND session_id IS NOT NULL GROUP BY visitor_namespace,session_id,tunnel;
CREATE VIEW public.v_journeys WITH (security_invoker=true) AS SELECT visitor_namespace,journey_id,tunnel,min(occurred_at) AS first_observed_at,max(occurred_at) AS last_observed_at,count(*) AS observations FROM public.v_events_canonical WHERE journey_id IS NOT NULL GROUP BY visitor_namespace,journey_id,tunnel;
CREATE VIEW public.v_ad_daily WITH (security_invoker=true) AS
 SELECT d.* FROM public.ad_daily d JOIN public.ads a ON a.id=d.ad_id
 WHERE d.sync_run_id=(SELECT s.id FROM public.sync_runs s WHERE s.source='meta' AND s.source_namespace=a.source_namespace AND s.stream_key='ad_daily' AND s.status IN ('complete','empty') AND s.pagination_complete AND s.date_from<=d.date AND s.date_to>d.date ORDER BY s.source_as_of DESC,s.started_at DESC,s.id DESC LIMIT 1);
CREATE VIEW public.v_meta_conversions_daily WITH (security_invoker=true) AS
 SELECT d.* FROM public.meta_conversions_daily d JOIN public.ads a ON a.id=d.ad_id
 WHERE d.sync_run_id=(SELECT s.id FROM public.sync_runs s WHERE s.source='meta' AND s.source_namespace=a.source_namespace AND s.stream_key='ad_daily' AND s.status IN ('complete','empty') AND s.pagination_complete AND s.date_from<=d.date AND s.date_to>d.date AND d.report_profile_key LIKE s.query_profile_key||':%' ORDER BY s.source_as_of DESC,s.started_at DESC,s.id DESC LIMIT 1);
CREATE VIEW public.v_cash_movements WITH (security_invoker=true) AS SELECT *,gross_minor*CASE kind WHEN 'receipt' THEN 1 WHEN 'refund' THEN -1 ELSE reversal_direction END AS signed_minor FROM public.payments WHERE status='settled';
CREATE VIEW public.v_commercial_timeline WITH (security_invoker=true) AS SELECT * FROM public.commercial_history;
CREATE VIEW public.v_attribution_published WITH (security_invoker=true) AS SELECT r.* FROM public.attribution_results r JOIN public.attribution_runs a ON a.id=r.attribution_run_id WHERE a.status='published';

-- Every FK used for joins is indexed, with additional timeline access paths.
DO $$DECLARE row record;BEGIN FOR row IN SELECT conrelid::regclass AS relation,conname,pg_get_constraintdef(oid) AS definition,conkey FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace AND conrelid IN (SELECT oid FROM pg_class WHERE relname IN ('sync_runs','source_mappings','link_revisions','person_identities','events','lead_registrations','prospects','appointments','commercial_history','deals','payments','ad_daily','meta_conversions_daily','source_aggregates','attribution_runs','attribution_results')) LOOP EXECUTE format('CREATE INDEX %I ON %s (%s)',left(row.conname||'_idx',63),row.relation,(SELECT string_agg(quote_ident(attname),',') FROM pg_attribute WHERE attrelid=row.relation AND attnum=ANY(row.conkey)));END LOOP;END $$;
CREATE INDEX events_journey_time ON public.events(visitor_namespace,journey_id,occurred_at,id);
CREATE INDEX lead_person_time ON public.lead_registrations(person_id,registered_at,id);
CREATE INDEX appointments_time ON public.appointments(scheduled_at,id);
CREATE INDEX payments_time ON public.payments(effective_at,id);
CREATE INDEX sync_publication ON public.sync_runs(source,source_namespace,stream_key,source_as_of,status);

-- Explicitly scoped to cockpit objects; no rights on unrelated tables are changed.
DO $$DECLARE name text; f record;BEGIN
 FOREACH name IN ARRAY ARRAY['cockpit_migrations','rate_limits','sync_runs','source_mappings','tracked_links','link_revisions','people','person_identities','lead_registrations','events','prospects','appointments','commercial_history','deals','payments','ads','ad_daily','meta_conversions_daily','source_aggregates','attribution_runs','attribution_results'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['v_links_current','v_events_canonical','v_visits','v_journeys','v_ad_daily','v_meta_conversions_daily','v_cash_movements','v_commercial_timeline','v_attribution_published'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',name);EXECUTE format('GRANT SELECT ON public.%I TO service_role',name);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'cockpit_%' OR p.proname IN ('save_tracked_link','archive_tracked_link','consume_rate_limit','ingest_browser_event','register_lead','begin_sync','finish_sync','import_meta_page','import_notion_page')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon,authenticated;
INSERT INTO public.cockpit_migrations(version) VALUES(1);
COMMIT;
