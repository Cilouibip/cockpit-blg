BEGIN;

-- The destination is generated server-side. Preserve the immutable historical
-- URL while allowing a future HTTPS page on the BLG Studio domain.
ALTER TABLE public.link_revisions
  DROP CONSTRAINT link_revisions_destination_url_check;

ALTER TABLE public.link_revisions
  ADD CONSTRAINT link_revisions_destination_url_check CHECK (
    destination_url = 'https://quizz.blg-studio.fr/'
    OR (
      tunnel = 'masterclass'
      AND destination_url ~ '^https://([a-z0-9-]+[.])*blg-studio[.]fr(/[^?#]*)?$'
    )
  );

INSERT INTO public.cockpit_migrations(version) VALUES(12);

COMMIT;
