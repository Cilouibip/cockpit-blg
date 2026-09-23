-- =====================================================================================
-- Cockpit BLG : verrou partagé de niveau passage (tick), en base. PRÉPARÉ, NON APPLIQUÉ, NON BRANCHÉ.
-- Aucune migration automatique ne lit ce dossier (supabase/manual/). Rien dans le code n'appelle ces fonctions.
--
-- Pourquoi : le verrou de passage actuel vit dans la mémoire du processus (src/lib/sync-jobs.ts,
-- createProcessTickLock) ; il n'empêche pas deux passages sur deux instances Vercel différentes.
-- Entre instances, les verrous par flux en base protègent déjà les données (begin_sync_stream,
-- cockpit_claim_notion / _lead_entries / _posthog) : jamais deux lectures simultanées d'un même flux,
-- aucune ligne dupliquée. Ce verrou ajouterait seulement : un seul passage à la fois, toutes instances
-- confondues, donc plus de seconde lecture d'un flux juste publié par un passage concurrent.
-- Avec un seul déclencheur toutes les 2 minutes et une route limitée à 60 s, ce cas ne se produit pas ;
-- il ne peut venir que d'un recouvrement (départ GitHub manuel, bascule mal séquencée).
--
-- Pour l'adopter, il faudrait (hors de ce lot) :
--   1. renommer ce fichier en migration numérotée suivante (supabase/migrations/017_...) et ajouter
--      INSERT INTO public.cockpit_migrations(version) VALUES(17); avant COMMIT ;
--   2. ajouter cockpit_claim_tick et cockpit_release_tick à la liste allowedRPC de src/lib/db.ts ;
--   3. fournir à tickSyncJobs un TickLock en base : acquire = rpc cockpit_claim_tick(uuid aléatoire, 90),
--      refus = passage « waiting » sans lecture ; release = rpc cockpit_release_tick dans le finally ;
--      conserver le verrou de processus devant (il évite l'appel en base sur la même instance) ;
--   4. un test d'intégration PostgreSQL : deux réclamations concurrentes, une seule réussit ; bail expiré repris.
-- =====================================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.cockpit_tick_lease (
  id smallint PRIMARY KEY CHECK (id = 1),
  holder uuid,
  lease_until timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO public.cockpit_tick_lease(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.cockpit_tick_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cockpit_tick_lease FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.cockpit_tick_lease TO service_role;

-- Une seule ligne ; la mise à jour conditionnelle prend son verrou de ligne : deux réclamations concurrentes
-- sont sérialisées, la seconde relit le bail posé par la première et échoue (READ COMMITTED).
-- Un bail expiré (passage interrompu) est repris sans intervention.
CREATE OR REPLACE FUNCTION public.cockpit_claim_tick(p_holder uuid, p_seconds integer) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF p_holder IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'invalid tick lease' USING ERRCODE = '23514';
  END IF;
  UPDATE cockpit_tick_lease SET holder = p_holder, lease_until = clock_timestamp() + make_interval(secs => p_seconds)
   WHERE id = 1 AND (lease_until <= clock_timestamp() OR holder = p_holder);
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.cockpit_release_tick(p_holder uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE cockpit_tick_lease SET holder = NULL, lease_until = clock_timestamp() WHERE id = 1 AND holder = p_holder;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.cockpit_claim_tick(uuid, integer), public.cockpit_release_tick(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_claim_tick(uuid, integer), public.cockpit_release_tick(uuid) TO service_role;

COMMIT;

-- Retour arrière (décommenter) :
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.cockpit_claim_tick(uuid, integer);
-- DROP FUNCTION IF EXISTS public.cockpit_release_tick(uuid);
-- DROP TABLE IF EXISTS public.cockpit_tick_lease;
-- COMMIT;
