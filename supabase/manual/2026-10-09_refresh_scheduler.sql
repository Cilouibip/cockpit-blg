-- Install through Supabase MCP after the existing Vault-backed request function
-- has been verified. This file installs instrumentation, NOT a cron schedule.
-- Activation: cron.schedule('cockpit-refresh-tick','* * * * *',
--                         'SELECT cockpit_ops.run_refresh_scheduler()');
-- Rollback: unschedule that named job only. No business history is deleted.
CREATE TABLE IF NOT EXISTS cockpit_ops.refresh_dispatch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id bigint NOT NULL,
  requested_at timestamptz NOT NULL,
  observed_at timestamptz,
  http_status integer,
  timed_out boolean,
  business_status text,
  response_error text,
  late_response boolean NOT NULL DEFAULT false,
  units integer,
  cadence_minutes integer,
  shared_lease boolean,
  unit_results jsonb
);
CREATE INDEX IF NOT EXISTS refresh_dispatch_pending ON cockpit_ops.refresh_dispatch(request_id) WHERE observed_at IS NULL;
ALTER TABLE cockpit_ops.refresh_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cockpit_ops.refresh_dispatch FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE cockpit_ops.refresh_dispatch_id_seq FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION cockpit_ops.capture_refresh_responses() RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE item record; payload jsonb; verdict text; captured integer := 0; safe_units jsonb;
BEGIN
  FOR item IN
    SELECT d.id, r.status_code, r.timed_out, r.error_msg IS NOT NULL AS transport_error, r.content
    FROM cockpit_ops.refresh_dispatch d
    JOIN net._http_response r ON r.id=d.request_id AND r.created>=d.requested_at
    WHERE d.observed_at IS NULL OR d.response_error='RESPONSE_MISSING'
  LOOP
    payload := NULL;
    -- Syntactically valid JSON may still exceed jsonb numeric/Unicode limits.
    -- An unusable response must never prevent expiration of pending requests.
    BEGIN
      IF item.content IS JSON OBJECT THEN payload := item.content::jsonb; END IF;
    EXCEPTION WHEN data_exception THEN payload := NULL;
    END;
    verdict := CASE
      WHEN item.timed_out OR item.transport_error THEN 'TRANSPORT_ERROR'
      WHEN payload IS NULL THEN 'INVALID_JSON'
      WHEN coalesce(payload->>'status','') NOT IN ('complete','partial','waiting','failed') THEN 'INVALID_RESPONSE'
      WHEN payload->>'status'='complete' AND (
        (payload#>>'{lock,kind}') IS DISTINCT FROM 'shared'
        OR coalesce(payload#>>'{cadence,pilotMinutes}','') NOT IN ('30','60')
        OR jsonb_typeof(payload->'unitResults') IS DISTINCT FROM 'array'
        -- A paginated job can be partial, then complete in the same tick.
        -- Preserve all units in the journal, but evaluate its final unit.
        OR EXISTS(
          SELECT FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'unitResults')='array' THEN payload->'unitResults' ELSE '[]'::jsonb END) u
          WHERE coalesce(u->>'job','')=''
            OR coalesce(u->>'status','') NOT IN ('complete','empty','partial','pending','waiting')
        )
        OR EXISTS(
          SELECT FROM (
            SELECT DISTINCT ON (u.value->>'job') u.value
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'unitResults')='array' THEN payload->'unitResults' ELSE '[]'::jsonb END) WITH ORDINALITY u(value, position)
            ORDER BY u.value->>'job',u.position DESC
          ) final_unit
          WHERE coalesce(final_unit.value->>'status','') NOT IN ('complete','empty')
        )
      ) THEN 'INVALID_RESPONSE'
      ELSE NULL END;
    SELECT coalesce(jsonb_agg(jsonb_build_object('job',u->>'job','status',u->>'status')),'[]'::jsonb) INTO safe_units
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'unitResults')='array' THEN payload->'unitResults' ELSE '[]'::jsonb END) u
    WHERE u->>'job' IN ('notion','meta','wix','receipts','meta_ads','meta_catalog','quiz','masterclass','forms','quiz_entries','client_history','kpi_meta','kpi_posthog','kpi_email')
      AND u->>'status' IN ('complete','empty','partial','pending','waiting','failed');
    UPDATE cockpit_ops.refresh_dispatch SET observed_at=clock_timestamp(),
      http_status=item.status_code,timed_out=item.timed_out,late_response=(response_error='RESPONSE_MISSING') IS TRUE,response_error=verdict,
      business_status=CASE WHEN verdict IS NULL THEN payload->>'status' END,
      units=CASE WHEN payload->>'units' ~ '^[0-9]{1,5}$' THEN (payload->>'units')::integer END,
      cadence_minutes=CASE WHEN payload#>>'{cadence,pilotMinutes}' IN ('30','60') THEN (payload#>>'{cadence,pilotMinutes}')::integer END,
      shared_lease=(payload#>>'{lock,kind}')='shared',unit_results=safe_units
    WHERE id=item.id AND (observed_at IS NULL OR response_error='RESPONSE_MISSING');
    captured := captured+1;
  END LOOP;
  UPDATE cockpit_ops.refresh_dispatch SET observed_at=clock_timestamp(),response_error='RESPONSE_MISSING'
    WHERE observed_at IS NULL AND requested_at<clock_timestamp()-interval '120 seconds';
  -- Only this new technical journal is bounded; sync_runs and business history remain intact.
  DELETE FROM cockpit_ops.refresh_dispatch WHERE requested_at<clock_timestamp()-interval '14 days';
  RETURN captured;
END $$;
REVOKE ALL ON FUNCTION cockpit_ops.capture_refresh_responses() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION cockpit_ops.run_refresh_scheduler() RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE latest cockpit_ops.refresh_dispatch%ROWTYPE; request bigint; dispatch_at timestamptz;
BEGIN
  -- Serialize manual/cron calls; the application also has its existing shared lease.
  IF NOT pg_try_advisory_xact_lock(64061009,1) THEN RETURN NULL; END IF;
  PERFORM cockpit_ops.capture_refresh_responses();
  SELECT * INTO latest FROM cockpit_ops.refresh_dispatch ORDER BY id DESC LIMIT 1;
  IF FOUND THEN
    IF latest.observed_at IS NULL THEN RETURN NULL; END IF;
    -- Successful idle polls need not wake the application every minute. A new due
    -- half-hour slot is detected within five minutes; partial/error work continues.
    IF latest.http_status=200 AND latest.response_error IS NULL AND latest.business_status='complete'
      AND latest.requested_at>clock_timestamp()-interval '5 minutes' THEN RETURN NULL; END IF;
  END IF;
  dispatch_at := clock_timestamp();
  SELECT cockpit_ops.request_refresh_tick() INTO request;
  INSERT INTO cockpit_ops.refresh_dispatch(request_id,requested_at) VALUES(request,dispatch_at);
  RETURN request;
END $$;
REVOKE ALL ON FUNCTION cockpit_ops.run_refresh_scheduler() FROM PUBLIC, anon, authenticated, service_role;
