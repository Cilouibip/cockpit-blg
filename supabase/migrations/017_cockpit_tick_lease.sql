-- Migration 17 · verrou partagé de niveau passage (tick), en base.
-- Reprend supabase/manual/2026-09-23_cockpit_tick_lease.sql (préparé le 23 septembre, jamais appliqué).
-- Le verrou de processus (src/lib/sync-jobs.ts) reste devant : il évite l'appel en base sur la même instance.
-- Ce bail ajoute : un seul passage à la fois, toutes instances confondues. Les verrous par flux
-- (begin_sync_stream 55P03, cockpit_claim_*) restent inchangés et protègent toujours les données.
-- Rejouable : table et ligne créées si absentes, fonctions remplacées à l'identique, version inscrite une fois.
-- Aucune donnée existante n'est lue ni modifiée.
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
-- Un bail expiré (passage interrompu) est repris sans intervention. Durée bornée : 30 à 300 secondes.
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

-- Seul le détenteur libère ; un bail déjà repris par un autre détenteur n'est jamais effacé.
CREATE OR REPLACE FUNCTION public.cockpit_release_tick(p_holder uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE cockpit_tick_lease SET holder = NULL, lease_until = clock_timestamp() WHERE id = 1 AND holder = p_holder;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.cockpit_claim_tick(uuid, integer), public.cockpit_release_tick(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cockpit_claim_tick(uuid, integer), public.cockpit_release_tick(uuid) TO service_role;

INSERT INTO public.cockpit_migrations(version) VALUES(17) ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Retour arrière (hors migration automatique ; aucune donnée métier concernée) :
-- 1. redéployer le code antérieur (il n'appelle pas ces fonctions) ;
-- 2. puis, si nécessaire :
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.cockpit_claim_tick(uuid, integer);
-- DROP FUNCTION IF EXISTS public.cockpit_release_tick(uuid);
-- DROP TABLE IF EXISTS public.cockpit_tick_lease;
-- DELETE FROM public.cockpit_migrations WHERE version = 17;
-- COMMIT;
-- Avec le code de ce lot encore déployé, retirer les fonctions fait passer le tick en « process-only » (signalé dans sa réponse).
