-- Migration 23 · Notion : relecture complète placée dans une fenêtre horaire (reprise CP2, 24 septembre ; proposition du lot U9
-- « relecture complète la nuit », mesurée dans tests/refresh-mechanism.test.ts : la pointe d'âge des rendez-vous pendant la
-- relecture complète (50 à 80 minutes selon le profil) se déplace à l'heure choisie au lieu de tomber n'importe quand dans la journée).
--
-- Remplace cockpit_claim_notion(text,text,jsonb) (021 ; signature et réponse inchangées ; cockpit_publish_notion inchangée) :
--  * p_schema peut porter « fullHours » = [de, à] (heures entières 0-23, Europe/Paris, de <= à), fourni par le lecteur
--    (src/lib/sync-notion-business.ts) d'après le réglage serveur BLG_NOTION_FULL_HOURS (« 2-4 » par exemple) ;
--  * sans « fullHours » : règle 021 à l'identique (relecture complète dès 24 h après la précédente) ;
--  * avec « fullHours » : relecture complète 24 h après la précédente seulement si l'heure de coupure est dans la fenêtre, et de
--    toute façon dès 36 h (garantie dure). Les autres déclencheurs de relecture complète (première fois, preuve absente ou non
--    sûre, changement de schéma, écart d'inventaire, partitions invalides) ne changent pas.
--  * Forme invalide de « fullHours » : refus 23514 (aucune tentative créée), signalé par le tick comme une unité en échec.
-- Aucune table, aucune colonne, aucune donnée modifiée. Rejouable : CREATE OR REPLACE, droits réappliqués, version inscrite une fois.
BEGIN;

CREATE OR REPLACE FUNCTION public.cockpit_claim_notion(p_namespace text,p_profile text,p_schema jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;previous sync_runs;token uuid=gen_random_uuid();cutoff timestamptz=date_trunc('minute',clock_timestamp());boundary timestamptz;lower_bound timestamptz;inventory_at timestamptz;full_at timestamptz;force_full boolean;mode text;
 partitions_valid boolean=false;in_window boolean=true;split jsonb;merged jsonb='[]'::jsonb;cur jsonb;part jsonb;carried jsonb='[]'::jsonb;tranche jsonb='[]'::jsonb;plan jsonb='{}'::jsonb;total_pages integer;budget integer;fraction numeric;rotation timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||p_namespace,0));
 IF p_schema IS NOT NULL AND ((p_schema->>'digest' IS NULL OR p_schema->>'digest' !~ '^[a-f0-9]{64}$') OR jsonb_typeof(p_schema->'deltaSafe') IS DISTINCT FROM 'boolean') THEN RAISE EXCEPTION 'invalid schema proof' USING ERRCODE='23514';END IF;
 IF p_schema ? 'fullHours' AND (jsonb_typeof(p_schema->'fullHours') IS DISTINCT FROM 'array' OR jsonb_array_length(p_schema->'fullHours')<>2 OR jsonb_typeof(p_schema->'fullHours'->0)<>'number' OR jsonb_typeof(p_schema->'fullHours'->1)<>'number'
  OR (p_schema->'fullHours'->>0)::numeric<>trunc((p_schema->'fullHours'->>0)::numeric) OR (p_schema->'fullHours'->>1)::numeric<>trunc((p_schema->'fullHours'->>1)::numeric)
  OR (p_schema->'fullHours'->>0)::integer NOT BETWEEN 0 AND 23 OR (p_schema->'fullHours'->>1)::integer NOT BETWEEN 0 AND 23 OR (p_schema->'fullHours'->>0)::integer>(p_schema->'fullHours'->>1)::integer) THEN
  RAISE EXCEPTION 'invalid full window' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status='running' ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
 IF r.id IS NOT NULL AND r.lease_until>now() THEN RETURN jsonb_build_object('busy',true,'runId',r.id);END IF;
 IF r.id IS NOT NULL AND (r.query_profile_key IS DISTINCT FROM p_profile OR (r.checkpoint ? 'schemaDigest' AND r.checkpoint->>'schemaDigest' IS DISTINCT FROM p_schema->>'digest')) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='superseded_schema',lease_token=NULL,lease_until=NULL WHERE id=r.id;
  r.id=NULL;
 END IF;
 IF r.id IS NULL THEN
  SELECT * INTO previous FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND query_profile_key=p_profile AND status IN ('complete','empty') AND pagination_complete ORDER BY finished_at DESC LIMIT 1;
  inventory_at=nullif(previous.checkpoint->>'inventoryThrough','')::timestamptz;
  full_at=nullif(previous.checkpoint->>'fullThrough','')::timestamptz;
  SELECT EXISTS(SELECT FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status='failed' AND error_code='DELTA_INVENTORY_GAP' AND started_at>=coalesce(previous.started_at,'1970-01-01'::timestamptz)) INTO force_full;
  -- Partitions héritées utilisables seulement si elles couvrent [1970, period_to) sans trou ni chevauchement.
  IF jsonb_typeof(previous.checkpoint->'partitions')='array' AND previous.period_to IS NOT NULL AND previous.period_to<=cutoff THEN
   SELECT count(*)>0 AND count(*) FILTER (WHERE f IS NULL OR t IS NULL OR f>=t OR (nxt IS NOT NULL AND nxt<>t) OR (nxt IS NULL AND t<>previous.period_to) OR (prv IS NULL AND f>'1970-01-02'::timestamptz))=0 INTO partitions_valid
   FROM (SELECT f,t,lead(f) OVER w nxt,lag(t) OVER w prv FROM (SELECT nullif(p->>'from','')::timestamptz f,nullif(p->>'to','')::timestamptz t FROM jsonb_array_elements(previous.checkpoint->'partitions') p) x WINDOW w AS (ORDER BY f,t)) y;
  END IF;
  -- 023 : fenêtre horaire de la relecture complète (p_schema.fullHours = [de, à] en heures Europe/Paris, facultatif). Absente : règle 021
 -- inchangée (relecture complète dès 24 h). Présente : relecture complète 24 h après la précédente seulement dans la fenêtre, et de
 -- toute façon dès 36 h (garantie dure : jamais plus de 36 h sans relecture complète, même si la fenêtre a été manquée).
 in_window=p_schema->'fullHours' IS NULL OR extract(hour FROM cutoff AT TIME ZONE 'Europe/Paris')::integer BETWEEN (p_schema->'fullHours'->>0)::integer AND (p_schema->'fullHours'->>1)::integer;
 mode=CASE WHEN previous.id IS NULL OR p_schema IS NULL OR p_schema->>'deltaSafe' IS DISTINCT FROM 'true' OR previous.checkpoint->>'schemaDigest' IS DISTINCT FROM p_schema->>'digest' OR force_full OR full_at IS NULL OR (cutoff-full_at>=interval '24 hours' AND (in_window OR cutoff-full_at>=interval '36 hours')) OR NOT partitions_valid THEN 'full' ELSE 'delta' END;
  lower_bound=CASE WHEN mode='full' THEN '1970-01-01'::timestamptz ELSE greatest('1970-01-01'::timestamptz,coalesce(nullif(previous.checkpoint->>'completedThrough','')::timestamptz,previous.period_to)-interval '2 minutes') END;
  boundary=date_trunc('year',cutoff);
  IF mode='delta' THEN
   -- a + b : partitions héritées, découpées à 100 fiches d'après createdAt du miroir (estimation, jamais une preuve).
   WITH base AS (
    SELECT (p->>'from')::timestamptz f,(p->>'to')::timestamptz t,coalesce(nullif(p->>'inventoriedAt','')::timestamptz,inventory_at,previous.period_to) inv
    FROM jsonb_array_elements(previous.checkpoint->'partitions') p),
   numbered_base AS (SELECT base.*,row_number() OVER (ORDER BY f) bi FROM base),
   base_bounds AS (SELECT array_agg(f ORDER BY f) a FROM base),
   mirror AS (
    SELECT (business->>'createdAt')::timestamptz c FROM prospects
    WHERE source='notion' AND source_namespace=p_namespace AND NOT archived AND business->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'),
   ranked AS (
    SELECT b.f,m.c,lag(m.c) OVER w prev,row_number() OVER w rn
    FROM mirror m JOIN numbered_base b ON b.bi=width_bucket(m.c,(SELECT a FROM base_bounds)) WHERE m.c<b.t WINDOW w AS (PARTITION BY b.f ORDER BY m.c)),
   -- Borne au milieu de l'écart entre la 100e et la 101e fiche (jamais sur une date de création : voir la marge de publication).
   starts AS (SELECT f,f s FROM base UNION SELECT f,prev+(c-prev)/2 FROM ranked WHERE rn>1 AND (rn-1)%100=0 AND c>prev),
   pieces AS (SELECT s.s f,coalesce(lead(s.s) OVER (PARTITION BY s.f ORDER BY s.s),b.t) t,b.inv FROM starts s JOIN base b ON b.f=s.f),
   numbered AS (SELECT pieces.*,row_number() OVER (ORDER BY f) i FROM pieces),
   piece_bounds AS (SELECT array_agg(f ORDER BY f) a FROM pieces),
   counts AS (SELECT width_bucket(m.c,(SELECT a FROM piece_bounds)) i,count(*) n FROM mirror m GROUP BY 1)
   SELECT coalesce(jsonb_agg(jsonb_build_object('from',n.f,'to',n.t,'inventoriedAt',n.inv,'rows',coalesce(c.n,0)) ORDER BY n.f),'[]'::jsonb) INTO split
   FROM numbered n LEFT JOIN counts c ON c.i=n.i;
   -- c : fusion des voisines petites (au plus 100 fiches estimées) ; la plus ancienne inventoriedAt est gardée.
   FOR part IN SELECT value FROM jsonb_array_elements(split) WITH ORDINALITY x(value,o) ORDER BY o LOOP
    IF cur IS NOT NULL AND (cur->>'to')::timestamptz=(part->>'from')::timestamptz AND (cur->>'rows')::integer+(part->>'rows')::integer<=100 THEN
     cur=jsonb_build_object('from',cur->'from','to',part->'to','inventoriedAt',CASE WHEN (part->>'inventoriedAt')::timestamptz<(cur->>'inventoriedAt')::timestamptz THEN part->'inventoriedAt' ELSE cur->'inventoriedAt' END,'rows',(cur->>'rows')::integer+(part->>'rows')::integer);
    ELSE
     IF cur IS NOT NULL THEN merged=merged||jsonb_build_array(cur);END IF;
     cur=part;
    END IF;
   END LOOP;
   IF cur IS NOT NULL THEN merged=merged||jsonb_build_array(cur);END IF;
   -- d + e : budget proportionnel au temps écoulé (6 h pour tout l'inventaire), plus anciennes d'abord, retard > 6 h obligatoire.
   fraction=least(1::numeric,greatest(1::numeric/12,extract(epoch FROM cutoff-previous.period_to)::numeric/21600));
   SELECT coalesce(sum(greatest(1,ceil((value->>'rows')::numeric/100))),0)::integer INTO total_pages FROM jsonb_array_elements(merged);
   budget=greatest(1,ceil(total_pages*fraction))::integer;
   -- Égalité de dates (passages dans la même minute) : la rotation reprend après la dernière partition lue au passage précédent.
   rotation=nullif(previous.checkpoint->'inventoryPlan'->>'cursor','')::timestamptz;
   WITH q AS (SELECT value p,(value->>'from')::timestamptz f,(value->>'inventoriedAt')::timestamptz inv,greatest(1,ceil((value->>'rows')::numeric/100))::integer pages FROM jsonb_array_elements(merged)),
   o AS (SELECT q.*,sum(pages) OVER (ORDER BY inv,(rotation IS NOT NULL AND f<rotation),f ROWS UNBOUNDED PRECEDING)-pages before FROM q),
   s AS (SELECT o.*,(before<budget OR inv<cutoff-interval '6 hours') chosen FROM o)
   SELECT coalesce(jsonb_agg(jsonb_build_object('from',p->'from','to',p->'to') ORDER BY f) FILTER (WHERE chosen),'[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('from',p->'from','to',p->'to','inventoriedAt',p->'inventoriedAt') ORDER BY f) FILTER (WHERE NOT chosen),'[]'::jsonb),
    jsonb_build_object('partitions',count(*),'pages',total_pages,'budget',budget,'fraction',round(fraction,4),'trancheCount',count(*) FILTER (WHERE chosen),'tranchePages',coalesce(sum(pages) FILTER (WHERE chosen),0),'overdue',count(*) FILTER (WHERE inv<cutoff-interval '6 hours'),'oldestInventoriedAt',min(inv),'cursor',(array_agg(p->'to' ORDER BY before DESC) FILTER (WHERE chosen))[1])
   INTO tranche,carried,plan FROM s;
   -- Toujours la partition nouvelle : fiches créées depuis la coupure précédente.
   IF previous.period_to<cutoff THEN tranche=tranche||jsonb_build_array(jsonb_build_object('from',previous.period_to,'to',cutoff));END IF;
   plan=plan||jsonb_build_object('newPartition',previous.period_to<cutoff);
  END IF;
  INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,period_from,period_to,coverage_kind,checkpoint)
  VALUES('notion',p_namespace,'prospects_business',p_profile,mode||':'||cutoff::text,'notion-'||mode||':'||p_namespace||':'||clock_timestamp()::text,p_profile,lower_bound,cutoff,'source_snapshot',
   jsonb_build_object('version',CASE WHEN p_schema IS NULL THEN 1 ELSE 2 END,'mode',mode,'schemaDigest',p_schema->>'digest','inventoryThrough',inventory_at,'fullThrough',full_at,'partitions',CASE WHEN mode='full' THEN '[]'::jsonb ELSE carried END,'page',0,
    'intervals',CASE WHEN mode='full' THEN jsonb_build_array(jsonb_build_object('from',lower_bound,'to',boundary,'read',0),jsonb_build_object('from',boundary,'to',cutoff,'read',0))
     ELSE jsonb_build_array(jsonb_build_object('kind','delta','from',lower_bound,'to',cutoff,'read',0))||(SELECT coalesce(jsonb_agg(jsonb_build_object('kind','inventory','from',x->'from','to',x->'to','read',0) ORDER BY o),'[]'::jsonb) FROM jsonb_array_elements(tranche) WITH ORDINALITY z(x,o)) END)
   ||CASE WHEN mode='delta' THEN jsonb_build_object('tranche',tranche,'inventoryPlan',plan) ELSE '{}'::jsonb END) RETURNING * INTO r;
 END IF;
 UPDATE sync_runs SET lease_token=token,lease_until=now()+interval '2 minutes',error_code=NULL WHERE id=r.id;
 RETURN jsonb_build_object('busy',false,'runId',r.id,'lease',token,'checkpoint',r.checkpoint,'from',r.period_from,'to',r.period_to,'rowsRead',r.rows_read);
END $$;

DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='cockpit_claim_notion' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
INSERT INTO public.cockpit_migrations(version) VALUES(23) ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Retour arrière (aucune donnée concernée) : exécuter le bloc ci-dessous (lignes entre les deux marqueurs, sans le préfixe « -- »).
-- Il réapplique le corps 021 de cockpit_claim_notion(text,text,jsonb) : un « fullHours » encore envoyé par le lecteur est alors ignoré
-- (021 ne lit que digest et deltaSafe). Le code n'a pas besoin d'être redéployé.
-- RETOUR ARRIERE 023 DEBUT
-- BEGIN;
-- CREATE OR REPLACE FUNCTION public.cockpit_claim_notion(p_namespace text,p_profile text,p_schema jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
-- DECLARE r sync_runs;previous sync_runs;token uuid=gen_random_uuid();cutoff timestamptz=date_trunc('minute',clock_timestamp());boundary timestamptz;lower_bound timestamptz;inventory_at timestamptz;full_at timestamptz;force_full boolean;mode text;
--  partitions_valid boolean=false;split jsonb;merged jsonb='[]'::jsonb;cur jsonb;part jsonb;carried jsonb='[]'::jsonb;tranche jsonb='[]'::jsonb;plan jsonb='{}'::jsonb;total_pages integer;budget integer;fraction numeric;rotation timestamptz;
-- BEGIN
--  PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||p_namespace,0));
--  IF p_schema IS NOT NULL AND ((p_schema->>'digest' IS NULL OR p_schema->>'digest' !~ '^[a-f0-9]{64}$') OR jsonb_typeof(p_schema->'deltaSafe') IS DISTINCT FROM 'boolean') THEN RAISE EXCEPTION 'invalid schema proof' USING ERRCODE='23514';END IF;
--  SELECT * INTO r FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status='running' ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
--  IF r.id IS NOT NULL AND r.lease_until>now() THEN RETURN jsonb_build_object('busy',true,'runId',r.id);END IF;
--  IF r.id IS NOT NULL AND (r.query_profile_key IS DISTINCT FROM p_profile OR (r.checkpoint ? 'schemaDigest' AND r.checkpoint->>'schemaDigest' IS DISTINCT FROM p_schema->>'digest')) THEN
--   UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='superseded_schema',lease_token=NULL,lease_until=NULL WHERE id=r.id;
--   r.id=NULL;
--  END IF;
--  IF r.id IS NULL THEN
--   SELECT * INTO previous FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND query_profile_key=p_profile AND status IN ('complete','empty') AND pagination_complete ORDER BY finished_at DESC LIMIT 1;
--   inventory_at=nullif(previous.checkpoint->>'inventoryThrough','')::timestamptz;
--   full_at=nullif(previous.checkpoint->>'fullThrough','')::timestamptz;
--   SELECT EXISTS(SELECT FROM sync_runs WHERE source='notion' AND source_namespace=p_namespace AND stream_key='prospects_business' AND status='failed' AND error_code='DELTA_INVENTORY_GAP' AND started_at>=coalesce(previous.started_at,'1970-01-01'::timestamptz)) INTO force_full;
--   -- Partitions héritées utilisables seulement si elles couvrent [1970, period_to) sans trou ni chevauchement.
--   IF jsonb_typeof(previous.checkpoint->'partitions')='array' AND previous.period_to IS NOT NULL AND previous.period_to<=cutoff THEN
--    SELECT count(*)>0 AND count(*) FILTER (WHERE f IS NULL OR t IS NULL OR f>=t OR (nxt IS NOT NULL AND nxt<>t) OR (nxt IS NULL AND t<>previous.period_to) OR (prv IS NULL AND f>'1970-01-02'::timestamptz))=0 INTO partitions_valid
--    FROM (SELECT f,t,lead(f) OVER w nxt,lag(t) OVER w prv FROM (SELECT nullif(p->>'from','')::timestamptz f,nullif(p->>'to','')::timestamptz t FROM jsonb_array_elements(previous.checkpoint->'partitions') p) x WINDOW w AS (ORDER BY f,t)) y;
--   END IF;
--   mode=CASE WHEN previous.id IS NULL OR p_schema IS NULL OR p_schema->>'deltaSafe' IS DISTINCT FROM 'true' OR previous.checkpoint->>'schemaDigest' IS DISTINCT FROM p_schema->>'digest' OR force_full OR full_at IS NULL OR cutoff-full_at>=interval '24 hours' OR NOT partitions_valid THEN 'full' ELSE 'delta' END;
--   lower_bound=CASE WHEN mode='full' THEN '1970-01-01'::timestamptz ELSE greatest('1970-01-01'::timestamptz,coalesce(nullif(previous.checkpoint->>'completedThrough','')::timestamptz,previous.period_to)-interval '2 minutes') END;
--   boundary=date_trunc('year',cutoff);
--   IF mode='delta' THEN
--    -- a + b : partitions héritées, découpées à 100 fiches d'après createdAt du miroir (estimation, jamais une preuve).
--    WITH base AS (
--     SELECT (p->>'from')::timestamptz f,(p->>'to')::timestamptz t,coalesce(nullif(p->>'inventoriedAt','')::timestamptz,inventory_at,previous.period_to) inv
--     FROM jsonb_array_elements(previous.checkpoint->'partitions') p),
--    numbered_base AS (SELECT base.*,row_number() OVER (ORDER BY f) bi FROM base),
--    base_bounds AS (SELECT array_agg(f ORDER BY f) a FROM base),
--    mirror AS (
--     SELECT (business->>'createdAt')::timestamptz c FROM prospects
--     WHERE source='notion' AND source_namespace=p_namespace AND NOT archived AND business->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'),
--    ranked AS (
--     SELECT b.f,m.c,lag(m.c) OVER w prev,row_number() OVER w rn
--     FROM mirror m JOIN numbered_base b ON b.bi=width_bucket(m.c,(SELECT a FROM base_bounds)) WHERE m.c<b.t WINDOW w AS (PARTITION BY b.f ORDER BY m.c)),
--    -- Borne au milieu de l'écart entre la 100e et la 101e fiche (jamais sur une date de création : voir la marge de publication).
--    starts AS (SELECT f,f s FROM base UNION SELECT f,prev+(c-prev)/2 FROM ranked WHERE rn>1 AND (rn-1)%100=0 AND c>prev),
--    pieces AS (SELECT s.s f,coalesce(lead(s.s) OVER (PARTITION BY s.f ORDER BY s.s),b.t) t,b.inv FROM starts s JOIN base b ON b.f=s.f),
--    numbered AS (SELECT pieces.*,row_number() OVER (ORDER BY f) i FROM pieces),
--    piece_bounds AS (SELECT array_agg(f ORDER BY f) a FROM pieces),
--    counts AS (SELECT width_bucket(m.c,(SELECT a FROM piece_bounds)) i,count(*) n FROM mirror m GROUP BY 1)
--    SELECT coalesce(jsonb_agg(jsonb_build_object('from',n.f,'to',n.t,'inventoriedAt',n.inv,'rows',coalesce(c.n,0)) ORDER BY n.f),'[]'::jsonb) INTO split
--    FROM numbered n LEFT JOIN counts c ON c.i=n.i;
--    -- c : fusion des voisines petites (au plus 100 fiches estimées) ; la plus ancienne inventoriedAt est gardée.
--    FOR part IN SELECT value FROM jsonb_array_elements(split) WITH ORDINALITY x(value,o) ORDER BY o LOOP
--     IF cur IS NOT NULL AND (cur->>'to')::timestamptz=(part->>'from')::timestamptz AND (cur->>'rows')::integer+(part->>'rows')::integer<=100 THEN
--      cur=jsonb_build_object('from',cur->'from','to',part->'to','inventoriedAt',CASE WHEN (part->>'inventoriedAt')::timestamptz<(cur->>'inventoriedAt')::timestamptz THEN part->'inventoriedAt' ELSE cur->'inventoriedAt' END,'rows',(cur->>'rows')::integer+(part->>'rows')::integer);
--     ELSE
--      IF cur IS NOT NULL THEN merged=merged||jsonb_build_array(cur);END IF;
--      cur=part;
--     END IF;
--    END LOOP;
--    IF cur IS NOT NULL THEN merged=merged||jsonb_build_array(cur);END IF;
--    -- d + e : budget proportionnel au temps écoulé (6 h pour tout l'inventaire), plus anciennes d'abord, retard > 6 h obligatoire.
--    fraction=least(1::numeric,greatest(1::numeric/12,extract(epoch FROM cutoff-previous.period_to)::numeric/21600));
--    SELECT coalesce(sum(greatest(1,ceil((value->>'rows')::numeric/100))),0)::integer INTO total_pages FROM jsonb_array_elements(merged);
--    budget=greatest(1,ceil(total_pages*fraction))::integer;
--    -- Égalité de dates (passages dans la même minute) : la rotation reprend après la dernière partition lue au passage précédent.
--    rotation=nullif(previous.checkpoint->'inventoryPlan'->>'cursor','')::timestamptz;
--    WITH q AS (SELECT value p,(value->>'from')::timestamptz f,(value->>'inventoriedAt')::timestamptz inv,greatest(1,ceil((value->>'rows')::numeric/100))::integer pages FROM jsonb_array_elements(merged)),
--    o AS (SELECT q.*,sum(pages) OVER (ORDER BY inv,(rotation IS NOT NULL AND f<rotation),f ROWS UNBOUNDED PRECEDING)-pages before FROM q),
--    s AS (SELECT o.*,(before<budget OR inv<cutoff-interval '6 hours') chosen FROM o)
--    SELECT coalesce(jsonb_agg(jsonb_build_object('from',p->'from','to',p->'to') ORDER BY f) FILTER (WHERE chosen),'[]'::jsonb),
--     coalesce(jsonb_agg(jsonb_build_object('from',p->'from','to',p->'to','inventoriedAt',p->'inventoriedAt') ORDER BY f) FILTER (WHERE NOT chosen),'[]'::jsonb),
--     jsonb_build_object('partitions',count(*),'pages',total_pages,'budget',budget,'fraction',round(fraction,4),'trancheCount',count(*) FILTER (WHERE chosen),'tranchePages',coalesce(sum(pages) FILTER (WHERE chosen),0),'overdue',count(*) FILTER (WHERE inv<cutoff-interval '6 hours'),'oldestInventoriedAt',min(inv),'cursor',(array_agg(p->'to' ORDER BY before DESC) FILTER (WHERE chosen))[1])
--    INTO tranche,carried,plan FROM s;
--    -- Toujours la partition nouvelle : fiches créées depuis la coupure précédente.
--    IF previous.period_to<cutoff THEN tranche=tranche||jsonb_build_array(jsonb_build_object('from',previous.period_to,'to',cutoff));END IF;
--    plan=plan||jsonb_build_object('newPartition',previous.period_to<cutoff);
--   END IF;
--   INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,period_from,period_to,coverage_kind,checkpoint)
--   VALUES('notion',p_namespace,'prospects_business',p_profile,mode||':'||cutoff::text,'notion-'||mode||':'||p_namespace||':'||clock_timestamp()::text,p_profile,lower_bound,cutoff,'source_snapshot',
--    jsonb_build_object('version',CASE WHEN p_schema IS NULL THEN 1 ELSE 2 END,'mode',mode,'schemaDigest',p_schema->>'digest','inventoryThrough',inventory_at,'fullThrough',full_at,'partitions',CASE WHEN mode='full' THEN '[]'::jsonb ELSE carried END,'page',0,
--     'intervals',CASE WHEN mode='full' THEN jsonb_build_array(jsonb_build_object('from',lower_bound,'to',boundary,'read',0),jsonb_build_object('from',boundary,'to',cutoff,'read',0))
--      ELSE jsonb_build_array(jsonb_build_object('kind','delta','from',lower_bound,'to',cutoff,'read',0))||(SELECT coalesce(jsonb_agg(jsonb_build_object('kind','inventory','from',x->'from','to',x->'to','read',0) ORDER BY o),'[]'::jsonb) FROM jsonb_array_elements(tranche) WITH ORDINALITY z(x,o)) END)
--    ||CASE WHEN mode='delta' THEN jsonb_build_object('tranche',tranche,'inventoryPlan',plan) ELSE '{}'::jsonb END) RETURNING * INTO r;
--  END IF;
--  UPDATE sync_runs SET lease_token=token,lease_until=now()+interval '2 minutes',error_code=NULL WHERE id=r.id;
--  RETURN jsonb_build_object('busy',false,'runId',r.id,'lease',token,'checkpoint',r.checkpoint,'from',r.period_from,'to',r.period_to,'rowsRead',r.rows_read);
-- END $$;
-- REVOKE ALL ON FUNCTION public.cockpit_claim_notion(text,text,jsonb) FROM PUBLIC,anon,authenticated;
-- GRANT EXECUTE ON FUNCTION public.cockpit_claim_notion(text,text,jsonb) TO service_role;
-- DELETE FROM public.cockpit_migrations WHERE version=23;
-- COMMIT;
-- RETOUR ARRIERE 023 FIN
