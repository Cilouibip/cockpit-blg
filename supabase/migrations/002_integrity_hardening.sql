-- Harden published attribution and reversal/receipt corrections found by independent code review.
BEGIN;
CREATE OR REPLACE FUNCTION public.cockpit_attribution_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE anchor public.attribution_results; run_status text;
BEGIN
 IF TG_TABLE_NAME='attribution_runs' THEN
  IF TG_OP<>'INSERT' AND OLD.status='published' THEN RAISE EXCEPTION 'published run immutable' USING ERRCODE='55000';END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN
  SELECT status INTO run_status FROM public.attribution_runs WHERE id=OLD.attribution_run_id FOR UPDATE;
  IF run_status='published' THEN RAISE EXCEPTION 'published result immutable' USING ERRCODE='55000';END IF;
  IF TG_OP='UPDATE' AND NEW.attribution_run_id<>OLD.attribution_run_id THEN RAISE EXCEPTION 'result run immutable' USING ERRCODE='55000';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 SELECT status INTO run_status FROM public.attribution_runs WHERE id=NEW.attribution_run_id FOR UPDATE;
 IF run_status='published' THEN RAISE EXCEPTION 'published result immutable' USING ERRCODE='55000';END IF;
 IF NEW.anchor_result_id IS NOT NULL THEN
  SELECT * INTO anchor FROM public.attribution_results WHERE id=NEW.anchor_result_id;
  IF anchor.target_kind<>'acquisition' OR anchor.attribution_run_id<>NEW.attribution_run_id OR anchor.person_id IS DISTINCT FROM NEW.person_id THEN RAISE EXCEPTION 'invalid acquisition anchor' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.cockpit_payment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE original public.payments; total_refunded bigint; total_reversed bigint;
BEGIN
 IF TG_OP='UPDATE' AND OLD.source_updated_at IS NOT NULL AND NEW.source_updated_at<OLD.source_updated_at THEN RETURN OLD;END IF;
 IF NEW.kind IN ('refund','reversal') AND NEW.original_payment_id IS NULL THEN NEW.reconciliation_state='unresolved';NEW.anomaly_code='original_missing';
 ELSIF NEW.kind IN ('refund','reversal') THEN
  SELECT * INTO original FROM public.payments WHERE id=NEW.original_payment_id FOR UPDATE;
  IF original.id IS NULL THEN RETURN NEW;END IF;
  IF original.source<>NEW.source OR original.source_namespace<>NEW.source_namespace OR original.currency<>NEW.currency OR original.currency_exponent<>NEW.currency_exponent OR original.status<>'settled' OR (NEW.kind='refund' AND original.kind<>'receipt') THEN NEW.reconciliation_state='anomaly';NEW.anomaly_code='incompatible_original';
  ELSIF NEW.kind='refund' AND NEW.status='settled' THEN
   SELECT coalesce(sum(gross_minor),0) INTO total_refunded FROM public.payments WHERE original_payment_id=original.id AND kind='refund' AND status='settled' AND reconciliation_state='reconciled' AND id<>NEW.id;
   IF total_refunded+NEW.gross_minor>original.gross_minor THEN NEW.reconciliation_state='anomaly';NEW.anomaly_code='refund_exceeds_receipt';END IF;
  ELSIF NEW.kind='reversal' AND NEW.status='settled' THEN
   SELECT coalesce(sum(gross_minor),0) INTO total_reversed FROM public.payments WHERE original_payment_id=original.id AND kind='reversal' AND status='settled' AND reconciliation_state='reconciled' AND id<>NEW.id;
   IF original.kind NOT IN ('receipt','refund') OR NEW.reversal_direction<>(CASE original.kind WHEN 'receipt' THEN -1 ELSE 1 END) OR total_reversed+NEW.gross_minor>original.gross_minor THEN NEW.reconciliation_state='anomaly';NEW.anomaly_code='invalid_reversal';
   ELSIF EXISTS(SELECT 1 FROM public.payments WHERE original_payment_id=original.id AND kind='refund' AND status='settled') THEN NEW.reconciliation_state='unresolved';NEW.anomaly_code='reversal_with_refunds';END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.kind='receipt' THEN
  SELECT coalesce(sum(gross_minor),0) INTO total_refunded FROM public.payments WHERE original_payment_id=NEW.id AND kind='refund' AND status='settled' AND reconciliation_state='reconciled';
  IF total_refunded>NEW.gross_minor OR EXISTS(SELECT 1 FROM public.payments WHERE original_payment_id=NEW.id AND (currency<>NEW.currency OR currency_exponent<>NEW.currency_exponent OR source<>NEW.source OR source_namespace<>NEW.source_namespace)) THEN NEW.reconciliation_state='anomaly';NEW.anomaly_code='receipt_children_incompatible';END IF;
 END IF;RETURN NEW;
END $$;
INSERT INTO public.cockpit_migrations(version) VALUES(2);
COMMIT;
