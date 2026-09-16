BEGIN;

-- Migration 12 · destination des liens masterclass.
-- La destination est générée côté serveur. L'URL historique immuable reste acceptée ;
-- toute page HTTPS du domaine BLG Studio devient possible pour le tunnel masterclass
-- (adresse finale publiée par Mehdi le 16 septembre 2026 : /masterclass26 ; /blank-1 redirige vers elle).
--
-- Rejouable : si la version 12 est déjà inscrite, rien n'est modifié.
-- Précontrôle : aucune ligne existante ne doit contredire la nouvelle règle, sinon arrêt sans modification.
-- Retour arrière préservant les données : voir output/tracking-deux-tunnels-2026-09-15/installation/sql/012-retour-arriere.sql
-- (remplace la règle par une liste fermée qui conserve les liens /masterclass26 ou /blank-1 déjà créés).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.cockpit_migrations WHERE version = 12) THEN
    RAISE NOTICE 'Migration 12 déjà appliquée : aucune modification.';
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.link_revisions
    WHERE NOT (
      destination_url = 'https://quizz.blg-studio.fr/'
      OR (tunnel = 'masterclass' AND destination_url ~ '^https://([a-z0-9-]+[.])*blg-studio[.]fr(/[^?#]*)?$')
    )
  ) THEN
    RAISE EXCEPTION 'link_revisions contient une destination incompatible avec la migration 12 : aucune modification.' USING ERRCODE = '23514';
  END IF;
  ALTER TABLE public.link_revisions DROP CONSTRAINT IF EXISTS link_revisions_destination_url_check;
  ALTER TABLE public.link_revisions ADD CONSTRAINT link_revisions_destination_url_check CHECK (
    destination_url = 'https://quizz.blg-studio.fr/'
    OR (
      tunnel = 'masterclass'
      AND destination_url ~ '^https://([a-z0-9-]+[.])*blg-studio[.]fr(/[^?#]*)?$'
    )
  );
  INSERT INTO public.cockpit_migrations(version) VALUES(12);
END $$;

COMMIT;
