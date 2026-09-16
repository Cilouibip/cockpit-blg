-- Retour arrière de la migration 12 SANS perte de données.
-- Remplace la règle ouverte par une liste fermée qui conserve toutes les destinations déjà présentes
-- (dont les liens /masterclass26 ou /blank-1 créés entre-temps), puis retire la version 12. Rejouable : sans version 12, rien n'est modifié.
BEGIN;
DO $$
DECLARE allowed text[]; list text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cockpit_migrations WHERE version = 12) THEN
    RAISE NOTICE 'Migration 12 absente : rien à annuler.';
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT u ORDER BY u) INTO allowed FROM (
    SELECT unnest(ARRAY['https://quizz.blg-studio.fr/','https://www.blg-studio.fr/blg-rugby-mc','https://www.blg-studio.fr/blank-1','https://www.blg-studio.fr/masterclass26']) AS u
    UNION SELECT destination_url FROM public.link_revisions
  ) t;
  SELECT string_agg(quote_literal(u), ',') INTO list FROM unnest(allowed) AS u;
  ALTER TABLE public.link_revisions DROP CONSTRAINT IF EXISTS link_revisions_destination_url_check;
  EXECUTE format('ALTER TABLE public.link_revisions ADD CONSTRAINT link_revisions_destination_url_check CHECK (destination_url IN (%s))', list);
  DELETE FROM public.cockpit_migrations WHERE version = 12;
END $$;
COMMIT;
