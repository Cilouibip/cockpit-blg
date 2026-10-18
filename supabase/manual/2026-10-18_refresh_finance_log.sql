-- Extend only the private dispatcher journal allowlist. No schedule or data change.
-- Run through Supabase MCP after review. Existing deployment only.
DO $patch$
DECLARE definition text;
  old_tail text := $old$'client_history','kpi_meta','kpi_posthog','kpi_email')$old$;
  new_tail text := $new$'client_history','kpi_meta','kpi_posthog','kpi_email','commerce')$new$;
BEGIN
  definition := pg_get_functiondef('cockpit_ops.capture_refresh_responses()'::regprocedure);
  IF strpos(definition,new_tail)>0 THEN RETURN; END IF;
  IF (length(definition)-length(replace(definition,old_tail,'')))/length(old_tail) <> 1 THEN
    RAISE EXCEPTION 'REFRESH_JOURNAL_UNEXPECTED_DEFINITION';
  END IF;
  EXECUTE replace(definition,old_tail,new_tail);
END $patch$;
