-- Migration 21 · Notion : inventaire tournant borné (lot U9-notion-30, option (a) de u4b §3.7).
-- 013 relisait à chaque passage delta l'inventaire léger de TOUTES les partitions created_time (~10 250 fiches,
-- 106 pages, 36 unités mesurées le 18/09) : au moins 9 appels du tick par passage, rendez-vous vieux de 1 h 50 au pire.
--
-- Remplace (CREATE OR REPLACE, signatures inchangées ; 013 n'est pas modifiée) :
-- 1. cockpit_claim_notion(text,text,jsonb). Mode full inchangé (première fois, preuve de schéma absente ou non sûre,
--    changement de schéma, écart d'inventaire DELTA_INVENTORY_GAP, toutes les 24 h) ; il devient aussi full si les
--    partitions du passage précédent sont absentes ou ne couvrent pas [1970, period_to) sans trou ni chevauchement.
--    Mode delta : l'intervalle des modifications (last_edited_time depuis completedThrough - 2 min, inchangé) plus une
--    TRANCHE de l'inventaire au lieu de tout l'inventaire :
--     a. partitions héritées, chacune avec inventoriedAt (heure de coupure du dernier passage qui l'a lue en entier ;
--        absente dans un point de reprise 013 = inventoryThrough du passage précédent, qui relisait tout) ;
--     b. découpage à 100 fiches (une page Notion) d'après createdAt du miroir (prospects.business->>'createdAt', fiches
--        non archivées), borne au milieu de l'écart entre la 100e et la 101e fiche (jamais sur une date de création) ;
--        une sous-partition hérite de inventoriedAt (une sous-plage lue à T l'a été à T) ;
--     c. fusion des partitions voisines tant que leur somme estimée reste <= 100 fiches ; la fusion garde la plus
--        ancienne inventoriedAt (jamais plus fraîche que la réalité) ;
--     d. budget B = plafond(S x f) pages, S = somme des pages estimées (au moins 1 par partition),
--        f = temps écoulé depuis la coupure précédente / 6 h, borné à [1/12, 1] : 1/12 à cadence 30 (12 passages),
--        1/6 à cadence 60 ; couverture complète en 6 h dans les deux cas ;
--     e. tranche = partitions les plus anciennement inventoriées d'abord (à date égale : rotation après la dernière
--        partition lue au passage précédent, « cursor », puis par date de création), prises tant que
--        les pages déjà prises restent < B (au moins B pages lues si l'inventaire les a), plus toute partition dont
--        inventoriedAt est antérieure à la coupure - 6 h (garantie dure), plus toujours la partition nouvelle
--        [coupure précédente, coupure) ;
--     f. point de reprise : partitions = partitions NON lues (avec inventoriedAt), tranche = plages lues,
--        inventoryPlan = mesures (partitions, pages S, budget B, pages de la tranche, partitions en retard).
--    Le lecteur (src/lib/sync-notion-business.ts, inchangé sur ce point, 013 compris) ajoute à « partitions » chaque
--    intervalle d'inventaire terminé.
-- 2. cockpit_publish_notion(uuid,uuid). Contrôles 013 inchangés ; les lignes d'inventaire ne viennent que de la tranche,
--    donc la détection d'une modification manquée (013 ligne 93), de la dérive de formule (ligne 97) et la revalidation
--    des relations (ligne 133) ne portent que sur les partitions relues. Nouveau :
--     * une fiche n'est archivée en delta que si elle est absente des lignes du passage et que son createdAt tombe dans
--       une plage de la tranche (bornes du filtre Notion on_or_after / before ; plages contiguës réunies) à plus d'une
--       minute de ses bords : created_time est arrondi à la minute par Notion, une fiche créée près d'un bord a pu être
--       rangée par Notion dans la partition voisine non relue. Une fiche sans createdAt lisible, ou proche d'un bord,
--       n'est archivée que par un passage full (24 h au plus) ;
--     * partitions de la tranche datées inventoriedAt = coupure du passage (period_to) ; autres inchangées ;
--       inventoryThrough publié = la plus ancienne inventoriedAt (fraîcheur réelle de la détection des disparitions,
--       exposée par cockpit_business_rollup comme en 013) ; en full, toutes = period_to ;
--     * partitions incohérentes (trou, chevauchement, date absente) en delta : échec DELTA_INVENTORY_GAP, donc full au
--       passage suivant (réparation), sans aucun changement du miroir ;
--     * un passage delta réclamé par 013 (sans « tranche ») garde exactement la règle 013 (tout l'inventaire relu).
-- cockpit_stage_notion et cockpit_business_rollup ne changent pas. Aucune table, aucune colonne, aucune donnée modifiée.
-- Rejouable : CREATE OR REPLACE, droits réappliqués, version inscrite une fois.
BEGIN;

CREATE OR REPLACE FUNCTION public.cockpit_claim_notion(p_namespace text,p_profile text,p_schema jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;previous sync_runs;token uuid=gen_random_uuid();cutoff timestamptz=date_trunc('minute',clock_timestamp());boundary timestamptz;lower_bound timestamptz;inventory_at timestamptz;full_at timestamptz;force_full boolean;mode text;
 partitions_valid boolean=false;split jsonb;merged jsonb='[]'::jsonb;cur jsonb;part jsonb;carried jsonb='[]'::jsonb;tranche jsonb='[]'::jsonb;plan jsonb='{}'::jsonb;total_pages integer;budget integer;fraction numeric;rotation timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||p_namespace,0));
 IF p_schema IS NOT NULL AND ((p_schema->>'digest' IS NULL OR p_schema->>'digest' !~ '^[a-f0-9]{64}$') OR jsonb_typeof(p_schema->'deltaSafe') IS DISTINCT FROM 'boolean') THEN RAISE EXCEPTION 'invalid schema proof' USING ERRCODE='23514';END IF;
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
  mode=CASE WHEN previous.id IS NULL OR p_schema IS NULL OR p_schema->>'deltaSafe' IS DISTINCT FROM 'true' OR previous.checkpoint->>'schemaDigest' IS DISTINCT FROM p_schema->>'digest' OR force_full OR full_at IS NULL OR cutoff-full_at>=interval '24 hours' OR NOT partitions_valid THEN 'full' ELSE 'delta' END;
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

CREATE OR REPLACE FUNCTION public.cockpit_publish_notion(p_run uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r sync_runs;key_namespace text;n integer;ns text;is_full boolean;changed integer;rotating boolean;parts jsonb;inventory_min timestamptz;bad integer;archived_now integer;safe jsonb='[]'::jsonb;
BEGIN
 SELECT source_namespace INTO ns FROM sync_runs WHERE id=p_run;
 PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||ns,0));
 SELECT * INTO r FROM sync_runs WHERE id=p_run;
 IF r.source='notion' AND r.stream_key='prospects_business' AND r.status IN ('complete','empty') AND r.pagination_complete THEN RETURN jsonb_build_object('status',r.status,'count',r.rows_written,'duplicate',true);END IF;
 SELECT * INTO r FROM sync_runs WHERE id=p_run AND source='notion' AND stream_key='prospects_business' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND OR jsonb_typeof(r.checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(r.checkpoint->'intervals') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'snapshot incomplete' USING ERRCODE='55000';END IF;
 IF jsonb_array_length(r.checkpoint->'intervals') IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'snapshot incomplete' USING ERRCODE='55000';END IF;
 is_full=coalesce(r.checkpoint->>'mode','full')='full';
 IF NOT is_full AND r.checkpoint->>'inventoryComplete' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'inventory incomplete' USING ERRCODE='55000';END IF;
 -- Passage à tranche (021) ; un passage delta réclamé par 013 (sans tranche) a relu tout l'inventaire : règle 013.
 rotating=NOT is_full AND jsonb_typeof(r.checkpoint->'tranche')='array';
 -- Partitions : celles de la tranche (ou toutes hors tranche) datées de la coupure du passage, les autres inchangées.
 WITH x AS (
  SELECT nullif(p->>'from','')::timestamptz f,nullif(p->>'to','')::timestamptz t,
   CASE WHEN NOT rotating OR EXISTS(SELECT FROM jsonb_array_elements(r.checkpoint->'tranche') z WHERE (p->>'from')::timestamptz>=(z->>'from')::timestamptz AND (p->>'to')::timestamptz<=(z->>'to')::timestamptz) THEN r.period_to ELSE nullif(p->>'inventoriedAt','')::timestamptz END inv
  FROM jsonb_array_elements(coalesce(r.checkpoint->'partitions','[]'::jsonb)) p),
 y AS (SELECT x.*,lead(f) OVER w nxt,lag(t) OVER w prv FROM x WINDOW w AS (ORDER BY f,t))
 SELECT coalesce(jsonb_agg(jsonb_build_object('from',f,'to',t,'inventoriedAt',inv) ORDER BY f,t),'[]'::jsonb),min(inv),
  count(*) FILTER (WHERE f IS NULL OR t IS NULL OR inv IS NULL OR f>=t OR (nxt IS NOT NULL AND nxt<>t) OR (nxt IS NULL AND t<>r.period_to) OR (prv IS NULL AND f>'1970-01-02'::timestamptz))
 INTO parts,inventory_min,bad FROM y;
 IF rotating AND (bad>0 OR jsonb_array_length(parts)=0) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='DELTA_INVENTORY_GAP',checkpoint=checkpoint||jsonb_build_object('gapReason','partitions'),lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','count',0,'reason','DELTA_INVENTORY_GAP');
 END IF;
 -- Lignes d'inventaire = tranche seulement : ces deux contrôles ne portent que sur les partitions relues.
 IF NOT is_full AND EXISTS(SELECT FROM notion_import_rows s LEFT JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND NOT s.payload ? 'business' AND (p.id IS NULL OR p.archived OR (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz>p.source_updated_at AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<r.period_to)) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='DELTA_INVENTORY_GAP',lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','count',0,'reason','DELTA_INVENTORY_GAP');
 END IF;
 IF NOT is_full AND EXISTS(SELECT FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND s.payload ? 'inventory' AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<=coalesce((s.payload->>'sourceUpdatedAt')::timestamptz,p.source_updated_at) AND coalesce(s.payload->'business'->'attendanceGroup',p.business->'attendanceGroup') IS DISTINCT FROM (s.payload->'inventory'->'attendanceGroup')) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='DELTA_INVENTORY_GAP',lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','count',0,'reason','DELTA_INVENTORY_GAP');
 END IF;
 -- The old published mirror stays intact until this terminal transaction commits.
 SELECT count(*) INTO n FROM notion_import_rows WHERE run_id=p_run;
 IF EXISTS(SELECT FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND p.source_updated_at>(s.payload->>'sourceUpdatedAt')::timestamptz) THEN
  UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='STALE_SOURCE_VERSION',lease_until=NULL,lease_token=NULL WHERE id=p_run;
  RETURN jsonb_build_object('status','failed','count',0,'reason','STALE_SOURCE_VERSION');
 END IF;
 -- Resolve under the same bounded global lock as the signed backend. All identity inserts happened during staging.
 key_namespace='blg-email-v1';
 PERFORM pg_advisory_xact_lock(hashtextextended('lead-identity-resolution',0));
 WITH inserted AS (
  INSERT INTO prospects(source,source_namespace,external_id,display_name,source_status,owner_label,responsible_ids,closer_ids,current_appointment_at,next_follow_up_at,archived,notion_url,source_updated_at,observed_at,connector_version,mapping_version,sync_run_id)
  SELECT 'notion',r.source_namespace,s.external_id,left(s.payload->>'name',249),s.payload->>'status',s.payload->'responsible'->>0,coalesce(s.payload->'responsible','[]'),coalesce(s.payload->'closer','[]'),s.payload->>'appointmentAt',s.payload->>'nextFollowUpAt',(s.payload->>'archived')::boolean,s.payload->>'notionUrl',(s.payload->>'sourceUpdatedAt')::timestamptz,(s.payload->>'observedAt')::timestamptz,s.payload->>'connectorVersion',s.payload->>'mappingVersion',p_run
  FROM notion_import_rows s WHERE s.run_id=p_run AND s.payload ? 'business' ON CONFLICT(source,source_namespace,external_id) DO NOTHING RETURNING *
 ) INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
 SELECT id,'snapshot_initial',NULL,jsonb_build_object('source_status',source_status,'owner_label',owner_label,'current_appointment_at',current_appointment_at,'next_follow_up_at',next_follow_up_at,'archived',archived),source_updated_at::text,p_run FROM inserted ON CONFLICT DO NOTHING;
 -- Capture changed fields before replacing the mirror. Equal versions are idempotent; omission/reappearance has its own observation key.
 INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
 SELECT p.id,f.key,to_jsonb(p)->f.key,updated.data->f.key,CASE WHEN f.key='archived' THEN 'snapshot:'||p_run::text ELSE s.payload->>'sourceUpdatedAt' END,p_run
 FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id
 CROSS JOIN LATERAL (SELECT jsonb_build_object('source_status',s.payload->'status','owner_label',s.payload->'responsible'->>0,'current_appointment_at',s.payload->'appointmentAt','next_follow_up_at',s.payload->'nextFollowUpAt','archived',s.payload->'archived') data) updated
 CROSS JOIN unnest(ARRAY['source_status','owner_label','current_appointment_at','next_follow_up_at','archived']) AS f(key)
 WHERE s.run_id=p_run AND s.payload ? 'business' AND to_jsonb(p)->f.key IS DISTINCT FROM updated.data->f.key ON CONFLICT DO NOTHING;
 UPDATE prospects p SET display_name=left(s.payload->>'name',249),source_status=s.payload->>'status',owner_label=s.payload->'responsible'->>0,responsible_ids=coalesce(s.payload->'responsible','[]'),closer_ids=coalesce(s.payload->'closer','[]'),current_appointment_at=s.payload->>'appointmentAt',next_follow_up_at=s.payload->>'nextFollowUpAt',
  source_updated_at=(s.payload->>'sourceUpdatedAt')::timestamptz,archived=(s.payload->>'archived')::boolean,business=s.payload->'business',person_identity_id=i.id,person_id=CASE WHEN i.state='linked' THEN i.person_id END,
  mapping_version=s.payload->>'mappingVersion',connector_version=s.payload->>'connectorVersion',observed_at=(s.payload->>'observedAt')::timestamptz,sync_run_id=p_run
 FROM notion_import_rows s LEFT JOIN person_identities i ON i.source='identity' AND i.source_namespace=key_namespace AND i.identity_kind='email_hmac' AND i.identity_key=s.payload->'business'->>'identityKey' AND i.valid_to IS NULL
 WHERE s.run_id=p_run AND s.payload ? 'business' AND p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id
 AND (p.display_name,p.source_status,p.owner_label,p.responsible_ids,p.closer_ids,p.current_appointment_at,p.next_follow_up_at,p.source_updated_at,p.archived,p.business,p.person_identity_id,p.person_id,p.mapping_version,p.connector_version)
 IS DISTINCT FROM (left(s.payload->>'name',249),s.payload->>'status',s.payload->'responsible'->>0,coalesce(s.payload->'responsible','[]'::jsonb),coalesce(s.payload->'closer','[]'::jsonb),s.payload->>'appointmentAt',s.payload->>'nextFollowUpAt',(s.payload->>'sourceUpdatedAt')::timestamptz,(s.payload->>'archived')::boolean,s.payload->'business',i.id,CASE WHEN i.state='linked' THEN i.person_id END,s.payload->>'mappingVersion',s.payload->>'connectorVersion');
 GET DIAGNOSTICS changed = ROW_COUNT;
 -- Relations revalidated from the inventory rows of this pass only (the tranche in a rotating pass).
 UPDATE prospects p SET business=jsonb_set(p.business,'{clientIds}',s.payload->'inventory'->'clientIds'),observed_at=(s.payload->'inventory'->>'observedAt')::timestamptz,sync_run_id=p_run
 FROM notion_import_rows s WHERE s.run_id=p_run AND s.payload ? 'inventory' AND NOT s.payload ? 'business' AND p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id AND p.business->'clientIds' IS DISTINCT FROM s.payload->'inventory'->'clientIds' AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<=p.source_updated_at;
 INSERT INTO appointments(source,source_namespace,external_id,identity_basis,prospect_id,scheduled_at,scheduled_day,status,source_status,evidence_state,source_updated_at,observed_at,connector_version,sync_run_id)
 SELECT 'notion',r.source_namespace,p.external_id||':current-slot','notion_current_slot',p.id,
  CASE WHEN length(p.current_appointment_at)>10 THEN p.current_appointment_at::timestamptz END,CASE WHEN length(p.current_appointment_at)=10 THEN p.current_appointment_at::date END,
  'unknown',p.source_status,'current_slot_only',p.source_updated_at,p.observed_at,p.connector_version,p_run
 FROM prospects p WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND p.sync_run_id=p_run AND (p.current_appointment_at IS NOT NULL OR EXISTS(SELECT FROM appointments a WHERE a.source='notion' AND a.source_namespace=r.source_namespace AND a.external_id=p.external_id||':current-slot'))
 ON CONFLICT(source,source_namespace,external_id) DO UPDATE SET scheduled_at=excluded.scheduled_at,scheduled_day=excluded.scheduled_day,status='unknown',attended_at=NULL,attendance_evidence=NULL,source_status=excluded.source_status,
  schedule_version=CASE WHEN appointments.scheduled_at IS DISTINCT FROM excluded.scheduled_at OR appointments.scheduled_day IS DISTINCT FROM excluded.scheduled_day THEN appointments.schedule_version+1 ELSE appointments.schedule_version END,
  source_updated_at=excluded.source_updated_at,observed_at=excluded.observed_at,connector_version=excluded.connector_version,sync_run_id=p_run;
 -- Disappearance: full = absent from the whole read; 013 delta = absent from the whole inventory; rotating delta = absent
 -- from the inventory AND created inside a range read by this pass. Unknown createdAt: only a full pass may archive.
 -- Ranges of the slice are joined when they touch, then shrunk by one minute at each edge: Notion rounds created_time to
 -- the minute, so a page created near an edge may belong to the unread neighbour partition; it waits for the full pass.
 IF rotating THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('from',lo+interval '1 minute','to',hi-interval '1 minute')) FILTER (WHERE hi-lo>interval '2 minutes'),'[]'::jsonb) INTO safe
  FROM (SELECT min(f) lo,max(t) hi FROM (SELECT f,t,sum(brk) OVER (ORDER BY f,t) grp FROM (SELECT f,t,CASE WHEN f=lag(t) OVER (ORDER BY f,t) THEN 0 ELSE 1 END brk FROM (SELECT (x->>'from')::timestamptz f,(x->>'to')::timestamptz t FROM jsonb_array_elements(r.checkpoint->'tranche') x) z) a) b GROUP BY grp) c;
 END IF;
 INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
 SELECT p.id,'archived','false'::jsonb,'true'::jsonb,'snapshot:'||p_run::text,p_run FROM prospects p
 WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND NOT p.archived AND NOT EXISTS(SELECT FROM notion_import_rows s WHERE s.run_id=p_run AND s.external_id=p.external_id AND (is_full OR s.payload ? 'inventory'))
 AND (NOT rotating OR EXISTS(SELECT FROM jsonb_array_elements(safe) z WHERE CASE WHEN p.business->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN (p.business->>'createdAt')::timestamptz END>=(z->>'from')::timestamptz AND CASE WHEN p.business->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN (p.business->>'createdAt')::timestamptz END<(z->>'to')::timestamptz)) ON CONFLICT DO NOTHING;
 UPDATE prospects p SET archived=true WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND NOT p.archived AND NOT EXISTS(SELECT FROM notion_import_rows s WHERE s.run_id=p_run AND s.external_id=p.external_id AND (is_full OR s.payload ? 'inventory'))
 AND (NOT rotating OR EXISTS(SELECT FROM jsonb_array_elements(safe) z WHERE CASE WHEN p.business->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN (p.business->>'createdAt')::timestamptz END>=(z->>'from')::timestamptz AND CASE WHEN p.business->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN (p.business->>'createdAt')::timestamptz END<(z->>'to')::timestamptz));
 GET DIAGNOSTICS archived_now = ROW_COUNT;
 SELECT count(*) INTO n FROM prospects WHERE source='notion' AND source_namespace=r.source_namespace AND NOT archived;
 UPDATE sync_runs SET checkpoint=checkpoint||jsonb_build_object('completedThrough',period_to,'inventoryThrough',CASE WHEN rotating THEN inventory_min ELSE period_to END,'fullThrough',CASE WHEN is_full THEN period_to ELSE nullif(checkpoint->>'fullThrough','')::timestamptz END,'changed',changed,'archivedRows',archived_now,'partitions',parts),source_as_of=period_to,status=CASE WHEN n=0 THEN 'empty' ELSE 'complete' END,finished_at=clock_timestamp(),pagination_complete=true,rows_written=n,covered_from=period_from,covered_to=period_to,lease_until=NULL,lease_token=NULL WHERE id=p_run;
 DELETE FROM notion_import_rows WHERE run_id=p_run;
 RETURN jsonb_build_object('status',CASE WHEN n=0 THEN 'empty' ELSE 'complete' END,'count',n,'changed',changed,'archivedRows',archived_now,'mode',coalesce(r.checkpoint->>'mode','full'),'inventoryThrough',CASE WHEN rotating THEN inventory_min ELSE r.period_to END);
END $$;

DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('cockpit_claim_notion','cockpit_publish_notion') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
INSERT INTO public.cockpit_migrations(version) VALUES(21) ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Retour arrière (aucune donnée supprimée ni modifiée dans le miroir) : exécuter le bloc ci-dessous (lignes entre les deux
-- marqueurs, sans le préfixe « -- »). Il réapplique les corps 013 de cockpit_claim_notion(text,text,jsonb) et de
-- cockpit_publish_notion. Il met d'abord en échec (« rollback_021 ») un passage à tranche encore en cours : la publication
-- 013 archiverait sinon toute fiche hors tranche (elle suppose tout l'inventaire relu). Les points de reprise écrits par 021
-- restent lisibles par 013 : « partitions » garde from/to (inventoriedAt, tranche et inventoryPlan sont ignorés) et le
-- passage 013 suivant relit tout l'inventaire. Le code (src/lib/sync-notion-business.ts) n'a pas besoin d'être redéployé.
-- RETOUR ARRIERE 021 DEBUT
-- BEGIN;
-- UPDATE public.sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='rollback_021',lease_token=NULL,lease_until=NULL WHERE source='notion' AND stream_key='prospects_business' AND status='running' AND checkpoint ? 'tranche';
-- CREATE OR REPLACE FUNCTION public.cockpit_claim_notion(p_namespace text,p_profile text,p_schema jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
-- DECLARE r sync_runs;previous sync_runs;token uuid=gen_random_uuid();cutoff timestamptz=date_trunc('minute',clock_timestamp());boundary timestamptz;lower_bound timestamptz;inventory_at timestamptz;full_at timestamptz;force_full boolean;inventory_intervals jsonb;mode text;proof text;
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
--   -- Hourly edit pass; periodic complete inventory detects omissions and refreshes
--   -- dependent properties. Only the inventory may infer disappearance.
--   mode=CASE WHEN previous.id IS NULL OR p_schema IS NULL OR p_schema->>'deltaSafe' IS DISTINCT FROM 'true' OR previous.checkpoint->>'schemaDigest' IS DISTINCT FROM p_schema->>'digest' OR force_full OR full_at IS NULL OR cutoff-full_at>=interval '24 hours' THEN 'full' ELSE 'delta' END;
--   lower_bound=CASE WHEN mode='full' THEN '1970-01-01'::timestamptz ELSE greatest('1970-01-01'::timestamptz,coalesce(nullif(previous.checkpoint->>'completedThrough','')::timestamptz,previous.period_to)-interval '2 minutes') END;
--   boundary=date_trunc('year',cutoff);
--   SELECT coalesce(jsonb_agg(jsonb_build_object('kind','inventory','from',part->>'from','to',part->>'to','read',0)),'[]'::jsonb) INTO inventory_intervals FROM jsonb_array_elements(coalesce(previous.checkpoint->'partitions','[]'::jsonb)) part;
--   IF jsonb_array_length(inventory_intervals)=0 THEN inventory_intervals=jsonb_build_array(jsonb_build_object('kind','inventory','from','1970-01-01T00:00:00Z','to',boundary,'read',0),jsonb_build_object('kind','inventory','from',boundary,'to',cutoff,'read',0));
--   ELSIF previous.period_to<cutoff THEN inventory_intervals=inventory_intervals||jsonb_build_array(jsonb_build_object('kind','inventory','from',previous.period_to,'to',cutoff,'read',0));END IF;
--   INSERT INTO sync_runs(source,source_namespace,stream_key,query_profile_key,partition_key,job_key,connector_version,period_from,period_to,coverage_kind,checkpoint)
--   VALUES('notion',p_namespace,'prospects_business',p_profile,mode||':'||cutoff::text,'notion-'||mode||':'||p_namespace||':'||clock_timestamp()::text,p_profile,lower_bound,cutoff,'source_snapshot',
--    jsonb_build_object('version',CASE WHEN p_schema IS NULL THEN 1 ELSE 2 END,'mode',mode,'schemaDigest',p_schema->>'digest','inventoryThrough',inventory_at,'fullThrough',full_at,'partitions','[]'::jsonb,'page',0,'intervals',CASE WHEN mode='full' THEN jsonb_build_array(jsonb_build_object('from',lower_bound,'to',boundary,'read',0),jsonb_build_object('from',boundary,'to',cutoff,'read',0)) ELSE jsonb_build_array(jsonb_build_object('kind','delta','from',lower_bound,'to',cutoff,'read',0))||inventory_intervals END)) RETURNING * INTO r;
--  END IF;
--  UPDATE sync_runs SET lease_token=token,lease_until=now()+interval '2 minutes',error_code=NULL WHERE id=r.id;
--  RETURN jsonb_build_object('busy',false,'runId',r.id,'lease',token,'checkpoint',r.checkpoint,'from',r.period_from,'to',r.period_to,'rowsRead',r.rows_read);
-- END $$;
-- CREATE OR REPLACE FUNCTION public.cockpit_publish_notion(p_run uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
-- DECLARE r sync_runs;key_namespace text;n integer;ns text;is_full boolean;changed integer;
-- BEGIN
--  SELECT source_namespace INTO ns FROM sync_runs WHERE id=p_run;
--  PERFORM pg_advisory_xact_lock(hashtextextended('notion-snapshot:'||ns,0));
--  SELECT * INTO r FROM sync_runs WHERE id=p_run;
--  IF r.source='notion' AND r.stream_key='prospects_business' AND r.status IN ('complete','empty') AND r.pagination_complete THEN RETURN jsonb_build_object('status',r.status,'count',r.rows_written,'duplicate',true);END IF;
--  SELECT * INTO r FROM sync_runs WHERE id=p_run AND source='notion' AND stream_key='prospects_business' AND status='running' AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
--  IF NOT FOUND OR jsonb_typeof(r.checkpoint) IS DISTINCT FROM 'object' OR jsonb_typeof(r.checkpoint->'intervals') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'snapshot incomplete' USING ERRCODE='55000';END IF;
--  IF jsonb_array_length(r.checkpoint->'intervals') IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'snapshot incomplete' USING ERRCODE='55000';END IF;
--  is_full=coalesce(r.checkpoint->>'mode','full')='full';
--  IF NOT is_full AND r.checkpoint->>'inventoryComplete' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'inventory incomplete' USING ERRCODE='55000';END IF;
--  IF NOT is_full AND EXISTS(SELECT FROM notion_import_rows s LEFT JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND NOT s.payload ? 'business' AND (p.id IS NULL OR p.archived OR (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz>p.source_updated_at AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<r.period_to)) THEN
--   UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='DELTA_INVENTORY_GAP',lease_until=NULL,lease_token=NULL WHERE id=p_run;
--   RETURN jsonb_build_object('status','failed','count',0,'reason','DELTA_INVENTORY_GAP');
--  END IF;
--  IF NOT is_full AND EXISTS(SELECT FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND s.payload ? 'inventory' AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<=coalesce((s.payload->>'sourceUpdatedAt')::timestamptz,p.source_updated_at) AND coalesce(s.payload->'business'->'attendanceGroup',p.business->'attendanceGroup') IS DISTINCT FROM (s.payload->'inventory'->'attendanceGroup')) THEN
--   UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='DELTA_INVENTORY_GAP',lease_until=NULL,lease_token=NULL WHERE id=p_run;
--   RETURN jsonb_build_object('status','failed','count',0,'reason','DELTA_INVENTORY_GAP');
--  END IF;
--  -- The old published mirror stays intact until this terminal transaction commits.
--  SELECT count(*) INTO n FROM notion_import_rows WHERE run_id=p_run;
--  IF EXISTS(SELECT FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id WHERE s.run_id=p_run AND p.source_updated_at>(s.payload->>'sourceUpdatedAt')::timestamptz) THEN
--   UPDATE sync_runs SET status='failed',finished_at=clock_timestamp(),error_code='STALE_SOURCE_VERSION',lease_until=NULL,lease_token=NULL WHERE id=p_run;
--   RETURN jsonb_build_object('status','failed','count',0,'reason','STALE_SOURCE_VERSION');
--  END IF;
--  -- Resolve under the same bounded global lock as the signed backend. All identity inserts happened during staging.
--  key_namespace='blg-email-v1';
--  PERFORM pg_advisory_xact_lock(hashtextextended('lead-identity-resolution',0));
--  WITH inserted AS (
--   INSERT INTO prospects(source,source_namespace,external_id,display_name,source_status,owner_label,responsible_ids,closer_ids,current_appointment_at,next_follow_up_at,archived,notion_url,source_updated_at,observed_at,connector_version,mapping_version,sync_run_id)
--   SELECT 'notion',r.source_namespace,s.external_id,left(s.payload->>'name',249),s.payload->>'status',s.payload->'responsible'->>0,coalesce(s.payload->'responsible','[]'),coalesce(s.payload->'closer','[]'),s.payload->>'appointmentAt',s.payload->>'nextFollowUpAt',(s.payload->>'archived')::boolean,s.payload->>'notionUrl',(s.payload->>'sourceUpdatedAt')::timestamptz,(s.payload->>'observedAt')::timestamptz,s.payload->>'connectorVersion',s.payload->>'mappingVersion',p_run
--   FROM notion_import_rows s WHERE s.run_id=p_run AND s.payload ? 'business' ON CONFLICT(source,source_namespace,external_id) DO NOTHING RETURNING *
--  ) INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
--  SELECT id,'snapshot_initial',NULL,jsonb_build_object('source_status',source_status,'owner_label',owner_label,'current_appointment_at',current_appointment_at,'next_follow_up_at',next_follow_up_at,'archived',archived),source_updated_at::text,p_run FROM inserted ON CONFLICT DO NOTHING;
--  -- Capture changed fields before replacing the mirror. Equal versions are idempotent; omission/reappearance has its own observation key.
--  INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
--  SELECT p.id,f.key,to_jsonb(p)->f.key,updated.data->f.key,CASE WHEN f.key='archived' THEN 'snapshot:'||p_run::text ELSE s.payload->>'sourceUpdatedAt' END,p_run
--  FROM notion_import_rows s JOIN prospects p ON p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id
--  CROSS JOIN LATERAL (SELECT jsonb_build_object('source_status',s.payload->'status','owner_label',s.payload->'responsible'->>0,'current_appointment_at',s.payload->'appointmentAt','next_follow_up_at',s.payload->'nextFollowUpAt','archived',s.payload->'archived') data) updated
--  CROSS JOIN unnest(ARRAY['source_status','owner_label','current_appointment_at','next_follow_up_at','archived']) AS f(key)
--  WHERE s.run_id=p_run AND s.payload ? 'business' AND to_jsonb(p)->f.key IS DISTINCT FROM updated.data->f.key ON CONFLICT DO NOTHING;
--  UPDATE prospects p SET display_name=left(s.payload->>'name',249),source_status=s.payload->>'status',owner_label=s.payload->'responsible'->>0,responsible_ids=coalesce(s.payload->'responsible','[]'),closer_ids=coalesce(s.payload->'closer','[]'),current_appointment_at=s.payload->>'appointmentAt',next_follow_up_at=s.payload->>'nextFollowUpAt',
--   source_updated_at=(s.payload->>'sourceUpdatedAt')::timestamptz,archived=(s.payload->>'archived')::boolean,business=s.payload->'business',person_identity_id=i.id,person_id=CASE WHEN i.state='linked' THEN i.person_id END,
--   mapping_version=s.payload->>'mappingVersion',connector_version=s.payload->>'connectorVersion',observed_at=(s.payload->>'observedAt')::timestamptz,sync_run_id=p_run
--  FROM notion_import_rows s LEFT JOIN person_identities i ON i.source='identity' AND i.source_namespace=key_namespace AND i.identity_kind='email_hmac' AND i.identity_key=s.payload->'business'->>'identityKey' AND i.valid_to IS NULL
--  WHERE s.run_id=p_run AND s.payload ? 'business' AND p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id
--  AND (p.display_name,p.source_status,p.owner_label,p.responsible_ids,p.closer_ids,p.current_appointment_at,p.next_follow_up_at,p.source_updated_at,p.archived,p.business,p.person_identity_id,p.person_id,p.mapping_version,p.connector_version)
--  IS DISTINCT FROM (left(s.payload->>'name',249),s.payload->>'status',s.payload->'responsible'->>0,coalesce(s.payload->'responsible','[]'::jsonb),coalesce(s.payload->'closer','[]'::jsonb),s.payload->>'appointmentAt',s.payload->>'nextFollowUpAt',(s.payload->>'sourceUpdatedAt')::timestamptz,(s.payload->>'archived')::boolean,s.payload->'business',i.id,CASE WHEN i.state='linked' THEN i.person_id END,s.payload->>'mappingVersion',s.payload->>'connectorVersion');
--  GET DIAGNOSTICS changed = ROW_COUNT;
--  -- Light hourly inventory also revalidates relation membership. The reviewed
--  -- attendance formula depends on Etat; unexpected drift forces a full reload.
--  UPDATE prospects p SET business=jsonb_set(p.business,'{clientIds}',s.payload->'inventory'->'clientIds'),observed_at=(s.payload->'inventory'->>'observedAt')::timestamptz,sync_run_id=p_run
--  FROM notion_import_rows s WHERE s.run_id=p_run AND s.payload ? 'inventory' AND NOT s.payload ? 'business' AND p.source='notion' AND p.source_namespace=r.source_namespace AND p.external_id=s.external_id AND p.business->'clientIds' IS DISTINCT FROM s.payload->'inventory'->'clientIds' AND (s.payload->'inventory'->>'sourceUpdatedAt')::timestamptz<=p.source_updated_at;
--  INSERT INTO appointments(source,source_namespace,external_id,identity_basis,prospect_id,scheduled_at,scheduled_day,status,source_status,evidence_state,source_updated_at,observed_at,connector_version,sync_run_id)
--  SELECT 'notion',r.source_namespace,p.external_id||':current-slot','notion_current_slot',p.id,
--   CASE WHEN length(p.current_appointment_at)>10 THEN p.current_appointment_at::timestamptz END,CASE WHEN length(p.current_appointment_at)=10 THEN p.current_appointment_at::date END,
--   'unknown',p.source_status,'current_slot_only',p.source_updated_at,p.observed_at,p.connector_version,p_run
--  FROM prospects p WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND p.sync_run_id=p_run AND (p.current_appointment_at IS NOT NULL OR EXISTS(SELECT FROM appointments a WHERE a.source='notion' AND a.source_namespace=r.source_namespace AND a.external_id=p.external_id||':current-slot'))
--  ON CONFLICT(source,source_namespace,external_id) DO UPDATE SET scheduled_at=excluded.scheduled_at,scheduled_day=excluded.scheduled_day,status='unknown',attended_at=NULL,attendance_evidence=NULL,source_status=excluded.source_status,
--   schedule_version=CASE WHEN appointments.scheduled_at IS DISTINCT FROM excluded.scheduled_at OR appointments.scheduled_day IS DISTINCT FROM excluded.scheduled_day THEN appointments.schedule_version+1 ELSE appointments.schedule_version END,
--   source_updated_at=excluded.source_updated_at,observed_at=excluded.observed_at,connector_version=excluded.connector_version,sync_run_id=p_run;
--  INSERT INTO commercial_history(prospect_id,field_key,before_value,after_value,source_version_key,sync_run_id)
--  SELECT p.id,'archived','false'::jsonb,'true'::jsonb,'snapshot:'||p_run::text,p_run FROM prospects p
--  WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND NOT p.archived AND NOT EXISTS(SELECT FROM notion_import_rows s WHERE s.run_id=p_run AND s.external_id=p.external_id AND (is_full OR s.payload ? 'inventory')) ON CONFLICT DO NOTHING;
--  UPDATE prospects p SET archived=true WHERE p.source='notion' AND p.source_namespace=r.source_namespace AND NOT p.archived AND NOT EXISTS(SELECT FROM notion_import_rows s WHERE s.run_id=p_run AND s.external_id=p.external_id AND (is_full OR s.payload ? 'inventory'));
--  SELECT count(*) INTO n FROM prospects WHERE source='notion' AND source_namespace=r.source_namespace AND NOT archived;
--  UPDATE sync_runs SET checkpoint=checkpoint||jsonb_build_object('completedThrough',period_to,'inventoryThrough',period_to,'fullThrough',CASE WHEN is_full THEN period_to ELSE nullif(checkpoint->>'fullThrough','')::timestamptz END,'changed',changed),source_as_of=period_to,status=CASE WHEN n=0 THEN 'empty' ELSE 'complete' END,finished_at=clock_timestamp(),pagination_complete=true,rows_written=n,covered_from=period_from,covered_to=period_to,lease_until=NULL,lease_token=NULL WHERE id=p_run;
--  DELETE FROM notion_import_rows WHERE run_id=p_run;
--  RETURN jsonb_build_object('status',CASE WHEN n=0 THEN 'empty' ELSE 'complete' END,'count',n,'changed',changed,'mode',coalesce(r.checkpoint->>'mode','full'),'inventoryThrough',r.period_to);
-- END $$;
-- REVOKE ALL ON FUNCTION public.cockpit_claim_notion(text,text,jsonb) FROM PUBLIC,anon,authenticated;
-- REVOKE ALL ON FUNCTION public.cockpit_publish_notion(uuid,uuid) FROM PUBLIC,anon,authenticated;
-- GRANT EXECUTE ON FUNCTION public.cockpit_claim_notion(text,text,jsonb) TO service_role;
-- GRANT EXECUTE ON FUNCTION public.cockpit_publish_notion(uuid,uuid) TO service_role;
-- DELETE FROM public.cockpit_migrations WHERE version=21;
-- COMMIT;
-- RETOUR ARRIERE 021 FIN
