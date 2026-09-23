-- =====================================================================================
-- Cockpit BLG : déclencheur automatique principal de l'actualisation (pg_cron + pg_net)
-- PRÉPARÉ, NON APPLIQUÉ. Aucune migration automatique ne lit ce dossier (supabase/manual/).
-- Mode d'emploi, ordre des opérations, contrôles et retour arrière : docs/ACTUALISATION.md.
--
-- Ne jamais exécuter ce fichier d'un bloc (ni « Run » sur tout le fichier, ni psql -f) :
-- copier une section à la fois. Les sections qui déclenchent un appel réel, stockent un secret
-- ou planifient une tâche sont commentées et doivent être décommentées volontairement.
--
-- Documentation lue le 23/09/2026 :
--   pg_cron  : https://github.com/citusdata/pg_cron
--              https://supabase.com/docs/guides/cron/install
--              https://supabase.com/docs/guides/cron/quickstart
--   pg_net   : https://github.com/supabase/pg_net
--              https://supabase.com/docs/guides/database/extensions/pg_net
--   Vault    : https://supabase.com/docs/guides/database/vault
--              https://supabase.com/docs/guides/functions/schedule-functions
--
-- Rappel : une réponse HTTP 200 du tick n'est pas une actualisation réussie. La route répond 200
-- pour tout état métier (complete, partial, waiting, failed). La preuve est dans public.sync_runs :
-- dernière publication complète par flux (status complete ou empty, pagination_complete).
-- =====================================================================================

-- Garde : si tout le fichier est lancé d'un bloc dans l'éditeur SQL, la transaction implicite s'arrête ici.
DO $$ BEGIN RAISE EXCEPTION 'Fichier manuel : exécuter section par section (docs/ACTUALISATION.md).'; END $$;


-- -------------------------------------------------------------------------------------
-- SECTION A : extensions (idempotent). Projet contrôlé le 23/09 : pg_cron 1.6.4 et pg_net 0.20.4
-- disponibles, non installés ; supabase_vault 0.3.1 installé.
-- -------------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;
-- Les fonctions de pg_net sont toujours créées dans le schéma « net » ; « extensions » évite de l'exposer dans public.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;


-- -------------------------------------------------------------------------------------
-- SECTION B : secret du tick dans Vault. La valeur n'est JAMAIS écrite dans ce fichier.
-- Voie recommandée : tableau de bord Supabase, Vault, « Add new secret », nom cockpit_cron_secret,
-- valeur = exactement la valeur CRON_SECRET de Vercel Production (au moins 32 caractères).
-- Voie SQL équivalente (dans un onglet non enregistré, puis fermer l'onglet sans sauvegarder) :
--   SELECT vault.create_secret('<VALEUR_SAISIE_PAR_CODEX>', 'cockpit_cron_secret', 'Bearer du tick cockpit (pg_cron)');
-- Changement de valeur ultérieur :
--   SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'cockpit_cron_secret'), '<NOUVELLE_VALEUR>');
-- Contrôle sans afficher la valeur :
--   SELECT name, length(decrypted_secret) >= 32 AS assez_long, updated_at FROM vault.decrypted_secrets WHERE name = 'cockpit_cron_secret';
-- -------------------------------------------------------------------------------------


-- -------------------------------------------------------------------------------------
-- SECTION C : fonction d'appel du tick (idempotent). Schéma privé non exposé par l'API,
-- aucun droit pour anon, authenticated ni service_role. pg_cron l'exécute sous le rôle qui a planifié la tâche.
-- -------------------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS cockpit_ops;
REVOKE ALL ON SCHEMA cockpit_ops FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION cockpit_ops.request_refresh_tick() RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  bearer text;
  request_id bigint;
BEGIN
  SELECT s.decrypted_secret INTO bearer FROM vault.decrypted_secrets s WHERE s.name = 'cockpit_cron_secret';
  -- La route refuse un secret de moins de 32 caractères : échouer ici rend l'erreur visible dans cron.job_run_details.
  IF bearer IS NULL OR length(bearer) < 32 THEN
    RAISE EXCEPTION 'cockpit_cron_secret absent ou trop court dans Vault' USING ERRCODE = '22023';
  END IF;
  -- Appel asynchrone : la requête est mise en file et envoyée par le processus de pg_net.
  -- 65 s couvrent la durée maximale de la route (60 s) pour que la réponse soit enregistrée dans net._http_response.
  SELECT net.http_get(
    url := 'https://cockpit-blg.vercel.app/api/jobs/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' || bearer),
    timeout_milliseconds := 65000
  ) INTO request_id;
  RETURN request_id;
END $$;

REVOKE ALL ON FUNCTION cockpit_ops.request_refresh_tick() FROM PUBLIC, anon, authenticated, service_role;


-- -------------------------------------------------------------------------------------
-- SECTION D : essai unique (appel réel du tick, une fois). Décommenter, exécuter, noter l'identifiant.
-- -------------------------------------------------------------------------------------
-- SELECT cockpit_ops.request_refresh_tick() AS request_id;
-- Environ 60 s plus tard (remplacer 0 par l'identifiant) :
-- SELECT id, status_code, timed_out, error_msg, created,
--        CASE WHEN content LIKE '{%' THEN (content::jsonb)->>'status' END AS tick_status,
--        CASE WHEN content LIKE '{%' THEN (content::jsonb)->'unitResults' END AS unites,
--        CASE WHEN content LIKE '{%' THEN (content::jsonb)->'cadence' END AS cadence
--   FROM net._http_response WHERE id = 0;


-- -------------------------------------------------------------------------------------
-- SECTION E : activation (décommenter au moment de la bascule, après la section D et l'arrêt des départs GitHub).
-- Toutes les 2 minutes : justification dans docs/ACTUALISATION.md (dimensionnement), et une exécution de la route
-- (60 s au plus) ne peut pas chevaucher la suivante (120 s). pg_cron ne lance jamais deux fois la même tâche en parallèle ;
-- ici la tâche se contente de mettre la requête en file et se termine en quelques millisecondes.
-- -------------------------------------------------------------------------------------
-- SELECT cron.schedule('cockpit-refresh-tick', '*/2 * * * *', $cmd$SELECT cockpit_ops.request_refresh_tick()$cmd$);
--
-- Facultatif : historique pg_cron borné à 7 jours pour les seules tâches du cockpit (cron.job_run_details n'est pas purgé automatiquement).
-- SELECT cron.schedule('cockpit-cron-history-cleanup', '17 3 * * *',
--   $cmd$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days' AND jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'cockpit-%')$cmd$);


-- -------------------------------------------------------------------------------------
-- SECTION F : contrôles (lecture seule, après la section A).
-- -------------------------------------------------------------------------------------
-- Tâches planifiées
SELECT jobid, jobname, schedule, active, username FROM cron.job WHERE jobname LIKE 'cockpit-%';

-- Exécutions pg_cron des 2 dernières heures (une par déclenchement ; « succeeded » = requête mise en file, pas tick réussi)
SELECT d.start_time, d.end_time, d.status, left(d.return_message, 200) AS message
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 WHERE j.jobname = 'cockpit-refresh-tick' AND d.start_time > now() - interval '2 hours'
 ORDER BY d.start_time DESC;

-- Réponses HTTP (conservées 6 h par pg_net) : code, délai dépassé, état métier renvoyé par le tick
SELECT created, status_code, timed_out, left(error_msg, 200) AS erreur,
       CASE WHEN content LIKE '{%' THEN (content::jsonb)->>'status' END AS tick_status,
       CASE WHEN content LIKE '{%' THEN (content::jsonb)->>'units' END AS unites
  FROM net._http_response WHERE created > now() - interval '2 hours' ORDER BY created DESC;

-- Preuve d'actualisation : dernière publication complète par flux et délai depuis (requêtes détaillées dans docs/ACTUALISATION.md)
SELECT source, stream_key, max(finished_at) AS derniere_publication,
       round(extract(epoch FROM now() - max(finished_at)) / 60) AS minutes_depuis
  FROM public.sync_runs
 WHERE status IN ('complete', 'empty') AND pagination_complete
 GROUP BY source, stream_key ORDER BY minutes_depuis DESC;


-- -------------------------------------------------------------------------------------
-- SECTION G : retour arrière (décommenter). Les extensions restent installées.
-- Ne pas lancer « DROP EXTENSION pg_cron » : cela supprime toutes les tâches et n'est pas demandé.
-- -------------------------------------------------------------------------------------
-- SELECT cron.unschedule('cockpit-refresh-tick');
-- SELECT cron.unschedule('cockpit-cron-history-cleanup');   -- seulement si elle a été créée
-- DROP FUNCTION IF EXISTS cockpit_ops.request_refresh_tick();
-- DROP SCHEMA IF EXISTS cockpit_ops;
-- Secret : le laisser (inactif sans la tâche) ou le neutraliser en le remplaçant par une valeur aléatoire :
-- SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'cockpit_cron_secret'), encode(extensions.gen_random_bytes(32), 'hex'));
