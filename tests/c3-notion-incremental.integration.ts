import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {synchronizeNotionChunk} from '../src/lib/sync-notion-business';
import {BLG_NOTION_FIELDS} from '../src/connectors/notion';
import {NOTION_BUSINESS_VERSION} from '../src/connectors/notion-business';
import type {Database,Row} from '../src/lib/db';
const base=new URL(process.env.TEST_DATABASE_URL||'postgresql://localhost:55440/postgres');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('LOCAL_ONLY');
const dbName='c3_delta_'+Date.now(),admin=new Client({connectionString:base.href}),target=new URL(base);target.pathname='/'+dbName;
let sql:Client;const proof={digest:'a'.repeat(64),deltaSafe:true};
const rpc=async<T=any>(name:string,args:Row):Promise<T>=>{const keys=Object.keys(args);return (await sql.query(`SELECT public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) AS x`,Object.values(args).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows[0].x;};
const db:Database={rpc,select:async()=>[],upsert:async()=>assert.fail('RPC only'),probe:async()=>{}};
before(async()=>{await admin.connect();await admin.query(`CREATE DATABASE ${dbName}`);sql=new Client({connectionString:target.href});await sql.connect();for(const f of readdirSync('supabase/migrations').filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort())await sql.query(readFileSync('supabase/migrations/'+f,'utf8'));});
after(async()=>{await sql?.end();await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);await admin.end();});
const ns='22222222-2222-4222-8222-222222222222';
const makeRow=(index:number)=>({id:`11111111-1111-4111-8111-${index.toString(16).padStart(12,'0')}`,created_time:new Date(Date.parse('2026-01-02T00:00:00Z')+index*1500000).toISOString(),last_edited_time:'2026-01-02T00:00:00Z',properties:{'Nom complet':{id:'name',title:[{plain_text:'Synthetic'}]},Etat:{id:'status',select:{name:'RDV Programmé'}},Clients:{id:'clients',relation:[] as {id:string}[],has_more:false},"Groupe d'état Noshow":{id:'attendance',formula:{type:'string',string:''}},'Date acquisition reelle':{date:{start:'2026-01-02'}},'Date du RDV':{date:{start:'2026-09-22'}},'Réservation faite le':{date:{start:'2026-09-01'}}}});
let source=Array.from({length:3},(_,i)=>makeRow(i));let requests=0,inventoryRequests=0,responseBytes=0;
// U9 : source synthétique propre à un espace (sinon « source ») et pages lues par espace et par nature de lecture.
const sources=new Map<string,ReturnType<typeof makeRow>[]>(),pagesBy=new Map<string,{delta:number;inventory:number;full:number}>();
const fetcher:typeof fetch=async(url,init)=>{
 requests++;const body=JSON.parse(String(init?.body)),stamp=body.filter.and[0].timestamp,lo=Date.parse(body.filter.and[0][stamp].on_or_after),hi=Date.parse(body.filter.and[1][stamp].before);
 const inventory=new URL(String(url)).searchParams.getAll('filter_properties[]').length===2;if(inventory)inventoryRequests++;
 const space=new URL(String(url)).pathname.split('/')[3],pages=pagesBy.get(space)??{delta:0,inventory:0,full:0};pagesBy.set(space,pages);pages[inventory?'inventory':stamp==='last_edited_time'?'delta':'full']++;
 const filtered=(sources.get(space)??source).filter(row=>Date.parse(row[stamp as 'created_time'|'last_edited_time'])>=lo&&Date.parse(row[stamp as 'created_time'|'last_edited_time'])<hi).sort((a,b)=>String(a[stamp as 'created_time']).localeCompare(String(b[stamp as 'created_time']))).slice(0,10000);
 const offset=Number(body.start_cursor??0),more=offset+100<filtered.length;
 const payload={results:filtered.slice(offset,offset+100).map(row=>inventory?{...row,properties:{Clients:row.properties.Clients,"Groupe d'état Noshow":row.properties["Groupe d'état Noshow"]}}:row),has_more:more,next_cursor:more?String(offset+100):null};responseBytes+=Buffer.byteLength(JSON.stringify(payload));return Response.json(payload);
};
const env=(namespace=ns)=>({COCKPIT_MODE:'live',NOTION_TOKEN:'synthetic',NOTION_DATA_SOURCE_ID:namespace,IDENTITY_HMAC_SECRET:'synthetic-secret-at-least-32-characters'});
const worker=(maxPages=5,namespace=ns,schema=proof,database=db)=>synchronizeNotionChunk({db:database,env:env(namespace),fetcher,maxPages,schemaReader:async()=>({proof:schema,fields:BLG_NOTION_FIELDS})});
const finish=async(namespace=ns,schema=proof)=>{for(let i=0;i<300;i++){const result=await worker(5,namespace,schema);if(result.status!=='partial')return result;}throw Error('bounded test did not complete');};
const mirror=async(namespace=ns)=>(await sql.query('SELECT external_id,source_status,archived,business,sync_run_id FROM prospects WHERE source_namespace=$1 ORDER BY external_id',[namespace])).rows;
const roll=async(namespace=ns)=>rpc<any>('cockpit_business_rollup',{p_namespace:namespace,p_from:'2026-01-01',p_to:'2027-01-01'});
const runOf=async(id:string)=>(await sql.query('SELECT id,status,error_code,period_to,checkpoint FROM sync_runs WHERE id=$1',[id])).rows[0];
const published=async(namespace:string)=>(await sql.query("SELECT id,period_to,checkpoint FROM sync_runs WHERE source_namespace=$1 AND stream_key='prospects_business' AND status IN ('complete','empty') AND pagination_complete ORDER BY finished_at DESC LIMIT 1",[namespace])).rows[0];
const inTranche=(tranche:{from:string;to:string}[],at:string)=>tranche.some(z=>Date.parse(at)>=Date.parse(z.from)&&Date.parse(at)<Date.parse(z.to));
/** Un passage complet (plusieurs invocations au besoin) et les pages Notion qu'il a lues, par nature. */
const pass=async(namespace:string,schema=proof)=>{const before={...(pagesBy.get(namespace)??{delta:0,inventory:0,full:0})};const result=await finish(namespace,schema);const after=pagesBy.get(namespace)!;return {result,run:await runOf(result.runId),delta:after.delta-before.delta,inventory:after.inventory-before.inventory,full:after.full-before.full};};
/** Vieillit les inventoriedAt de la dernière publication (horloge simulée). */
const age=async(namespace:string,hours:number)=>sql.query("UPDATE sync_runs SET checkpoint=checkpoint||jsonb_build_object('partitions',(SELECT jsonb_agg(p||jsonb_build_object('inventoriedAt',period_to-make_interval(hours=>$2)) ORDER BY o) FROM jsonb_array_elements(checkpoint->'partitions') WITH ORDINALITY x(p,o)),'inventoryThrough',period_to-make_interval(hours=>$2)) WHERE id=$1",[(await published(namespace)).id,hours]);
test('delta stages, resumes, retains unchanged rows/history, reconciles omissions only after complete inventory',async()=>{
 assert.equal((await finish()).status,'complete');const old=await mirror();assert.equal(old.length,3);assert.equal((await roll()).appointments.total,3);
 const bound=(await sql.query("SELECT period_to FROM sync_runs WHERE source_namespace=$1 ORDER BY started_at DESC LIMIT 1",[ns])).rows[0].period_to;
 source[0].last_edited_time=new Date(Date.parse(bound)-30000).toISOString();source[0].properties.Etat.select.name='RDV Annulé';source=source.filter((_,i)=>i!==1);
 const partial=await worker(1);assert.equal(partial.status,'partial');assert.deepEqual(await mirror(),old,'no partial CRM publication');
 const completed=await finish();assert.equal(completed.status,'complete');assert.equal(completed.coverage.mode,'delta');assert.ok(inventoryRequests>0);
 const current=await mirror();assert.equal(current[0].source_status,'RDV Annulé');assert.equal(current[1].archived,true);assert.equal(current[2].sync_run_id,old[2].sync_run_id,'unchanged record is not rewritten');
 const summary=await roll();assert.equal(summary.sourceRows,2);assert.equal(summary.leads.rows,3);assert.equal(summary.leads.archivedRows,1);assert.equal(summary.appointments.cancelled,1);assert.ok(summary.inventoryThrough);
 const afterHistory=(await sql.query('SELECT count(*) n FROM commercial_history')).rows[0].n;
 await finish();assert.equal((await sql.query('SELECT count(*) n FROM commercial_history')).rows[0].n,afterHistory,'overlap replay adds no duplicate history');
});
test('relation changes without a parent edit are detected by hourly dependency projection',async()=>{
 source[1].properties.Clients.relation=[{id:'33333333-3333-4333-8333-333333333333'}];
 assert.equal((await finish()).status,'complete');assert.deepEqual((await mirror())[2].business.clientIds,['33333333-3333-4333-8333-333333333333']);
});
test('deletion after delta read is only applied after inventory, and formula drift forces full recovery',async()=>{
 const old=await mirror();const kept=source[1];
 const bound=(await sql.query("SELECT period_to FROM sync_runs WHERE source_namespace=$1 ORDER BY started_at DESC LIMIT 1",[ns])).rows[0].period_to;
 source[0].last_edited_time=new Date(Date.parse(bound)-10000).toISOString();
 assert.equal((await worker(1)).status,'partial');source=source.slice(1);
 await finish();assert.equal((await mirror())[0].archived,true,'a staged delta row absent from terminal inventory is archived');
 const before=await mirror();source[0].properties["Groupe d'état Noshow"].formula.string='Show up';
 const failed=await finish();assert.equal(failed.status,'failed');assert.equal(failed.coverage.reason,'DELTA_INVENTORY_GAP');assert.deepEqual(await mirror(),before,'formula drift cannot partially change published values');
 const recovered=await finish();assert.equal(recovered.coverage.mode,'full');assert.equal(recovered.status,'complete');
 source[0].properties["Groupe d'état Noshow"].formula.string='';await finish();await finish();
});
test('lease expires, page replay is idempotent, conflicting replay is rejected and checkpoint remains',async()=>{
 const namespace='lease-fixture';const args={p_namespace:namespace,p_profile:'v1',p_schema:proof};const claim=await rpc('cockpit_claim_notion',args);
 assert.equal((await rpc('cockpit_claim_notion',args)).busy,true);
 const stage={p_run:claim.runId,p_lease:claim.lease,p_records:[],p_read:0,p_checkpoint:{intervals:claim.checkpoint.intervals,page:1}};
 await rpc('cockpit_stage_notion',stage);await rpc('cockpit_stage_notion',stage);
 assert.equal((await sql.query('SELECT rows_read FROM sync_runs WHERE id=$1',[claim.runId])).rows[0].rows_read,0);
 await assert.rejects(rpc('cockpit_stage_notion',{...stage,p_read:1}),{code:'55000'});
 await sql.query("UPDATE sync_runs SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.runId]);
 const resumed=await rpc('cockpit_claim_notion',args);assert.equal(resumed.runId,claim.runId);assert.notEqual(resumed.lease,claim.lease);assert.equal(resumed.checkpoint.page,1);
 await assert.rejects(rpc('cockpit_publish_notion',{p_run:claim.runId,p_lease:claim.lease}),{code:'55000'});
});
test('more than 10000 rows reach publication across interval splits and persisted worker invocations',async()=>{
 source=Array.from({length:12050},(_,i)=>makeRow(i));requests=0;inventoryRequests=0;responseBytes=0;
 const namespace='44444444-4444-4444-8444-444444444444';const result=await finish(namespace);
 assert.equal(result.status,'complete');assert.equal((await mirror(namespace)).length,12050);assert.equal((await roll(namespace)).sourceRows,12050);assert.ok(requests>120);
 const published=(await sql.query("SELECT checkpoint FROM sync_runs WHERE source_namespace=$1 ORDER BY started_at DESC LIMIT 1",[namespace])).rows[0].checkpoint;assert.ok(published.completedThrough);assert.deepEqual(published.intervals,[]);
 const readsBefore=requests,bytesBefore=responseBytes;const delta=await finish(namespace);assert.equal(delta.coverage.mode,'delta');
 // U9 (adapté) : 013 relisait ici tout l'inventaire (inventoryRequests >= 121). Le passage delta ne lit plus qu'une tranche :
 // budget = plafond(pages estimées / 12) ; les 12 050 fiches sont couvertes en 12 passages (test « capacité » plus bas).
 const plan=(await runOf(delta.runId)).checkpoint.inventoryPlan;assert.ok(plan.pages>=121);assert.equal(plan.budget,Math.ceil(plan.pages/12));
 assert.ok(inventoryRequests<=plan.budget+1,`tranche seulement : ${inventoryRequests} pages d'inventaire`);assert.ok(requests-readsBefore<=plan.budget+2,'delta full rows are replaced by a thin inventory slice');assert.equal((await roll(namespace)).sourceRows,12050);assert.ok(responseBytes-bytesBefore<bytesBefore/10);console.log(JSON.stringify({synthetic:true,rows:12050,initialRequests:readsBefore,deltaRequests:requests-readsBefore,initialResponseBytes:bytesBefore,deltaResponseBytes:responseBytes-bytesBefore,plan}));
});
test('new RPC remains private; old/new rollup counts agree for the same fully published synthetic mirror',async()=>{
 for(const role of ['anon','authenticated']){
  const allowed=(await sql.query("SELECT has_function_privilege($1,'public.cockpit_claim_notion(text,text,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed;assert.equal(allowed,false);
 }
 const old=readFileSync('supabase/migrations/007_business_metrics_and_resumable_imports.sql','utf8');const start=old.indexOf('CREATE FUNCTION public.cockpit_business_rollup'),end=old.indexOf('DO $$ DECLARE f record',start);
 await sql.query(old.slice(start,end).replace('public.cockpit_business_rollup','public.c3_old_business_rollup'));
 const namespace='44444444-4444-4444-8444-444444444444';
 // Request a full pass through the legacy claim to compare equal source snapshots.
 const c=await rpc('cockpit_claim_notion',{p_namespace:namespace,p_profile:'notion-acquisition-known-v1'});await rpc('cockpit_release_notion',{p_run:c.runId,p_lease:c.lease,p_error:null});await finish(namespace);
 const fresh=await roll(namespace),baseline=await rpc<any>('c3_old_business_rollup',{p_namespace:namespace,p_from:'2026-01-01',p_to:'2027-01-01'});
 // Old rollup intentionally loses unchanged rows with its latest-run filter; emulate
 // a legacy rewrite on a rollback-only transaction for an exact old/new comparison.
 await sql.query('BEGIN');try{await sql.query("UPDATE prospects SET sync_run_id=(SELECT id FROM sync_runs WHERE source_namespace=$1 AND status IN ('complete','empty') ORDER BY finished_at DESC LIMIT 1) WHERE source_namespace=$1 AND NOT archived",[namespace]);const expected=await rpc<any>('c3_old_business_rollup',{p_namespace:namespace,p_from:'2026-01-01',p_to:'2027-01-01'});for(const key of ['sourceRows','leads','appointments'])assert.deepEqual(fresh[key],expected[key]);}finally{await sql.query('ROLLBACK');}
 assert.ok(baseline.sourceRows<=fresh.sourceRows);
});

// ---- U9 : inventaire tournant borné (migration 021). Espace dédié, 2 400 fiches synthétiques créées toutes les 25 min :
// 24 partitions de 100 fiches (une page Notion chacune), budget = plafond(24 / 12) = 2 pages par passage à cadence 30.
const MID='55555555-5555-4555-8555-555555555555',midRows=Array.from({length:2400},(_,i)=>makeRow(i));
const mirrorRow=async(externalId:string)=>(await sql.query('SELECT archived,source_updated_at,source_status FROM prospects WHERE source_namespace=$1 AND external_id=$2',[MID,externalId])).rows[0];
const archivedCount=async()=>Number((await sql.query('SELECT count(*) n FROM prospects WHERE source_namespace=$1 AND archived',[MID])).rows[0].n);
test('U9 scénarios 1, 2, 3, 7, 8 : tranche seule par passage delta, archivage limité à la tranche relue, couverture en 12 passages, pages bornées',async()=>{
 sources.set(MID,midRows);
 const initial=await pass(MID);assert.equal(initial.result.coverage.mode,'full');assert.equal(initial.result.status,'complete');assert.equal(initial.inventory,0);
 const start=Date.parse(initial.run.period_to);assert.deepEqual(initial.run.checkpoint.partitions.map((p:{inventoriedAt:string})=>Date.parse(p.inventoriedAt)),initial.run.checkpoint.partitions.map(()=>start),'full : toutes les partitions datées de la coupure');
 // Scénario 8 : une fiche du miroir sans createdAt connu, absente de Notion.
 await sql.query("INSERT INTO prospects(source,source_namespace,external_id,connector_version,mapping_version,business,sync_run_id) VALUES('notion',$1,'orphan-without-created-at','synthetic','synthetic','{}'::jsonb,$2)",[MID,initial.run.id]);
 await age(MID,1);const old=start-3_600_000;
 // Scénario 2 : fiche supprimée dans Notion, créée tard (dans la dernière partition relue).
 const gone=midRows[2350];sources.set(MID,midRows.filter(row=>row!==gone));
 let archivedAt=0;const perPass:{inventory:number;delta:number;budget:number;tranchePages:number}[]=[];
 for(let k=1;k<=12;k++){
  const {result,run,inventory,delta,full}=await pass(MID),cp=run.checkpoint,plan=cp.inventoryPlan;
  assert.equal(result.status,'complete',`passage ${k} publié`);assert.equal(result.coverage.mode,'delta');assert.equal(full,0);
  // Scénario 1 et 7 : 24 partitions, 2 pages de budget, tranche = budget (+ partition nouvelle si la minute a changé).
  assert.equal(plan.partitions,24);assert.equal(plan.pages,24);assert.equal(plan.budget,2);assert.equal(plan.tranchePages,2);assert.equal(plan.overdue,0);
  assert.equal(inventory,plan.tranchePages+(plan.newPartition?1:0),`passage ${k} : pages d'inventaire = tranche`);assert.equal(delta,1);
  perPass.push({inventory,delta,budget:plan.budget,tranchePages:plan.tranchePages});
  const readGone=inTranche(cp.tranche,gone.created_time),state=await mirrorRow(gone.id);
  if(!archivedAt){assert.equal(state.archived,readGone,`passage ${k} : archivée si et seulement si sa tranche est relue`);if(readGone)archivedAt=k;}
  else assert.equal(state.archived,true);
  assert.equal(await archivedCount(),archivedAt?1:0,'aucune fiche hors tranche archivée à tort');
  assert.equal((await mirrorRow('orphan-without-created-at')).archived,false,'fiche sans createdAt jamais archivée en delta');
  // Scénario 3 : inventoryThrough publié = la plus ancienne inventoriedAt (ancienne tant qu'une partition n'est pas relue).
  const oldest=Math.min(...cp.partitions.map((p:{inventoriedAt:string})=>Date.parse(p.inventoriedAt)));
  assert.equal(Date.parse(cp.inventoryThrough),oldest);assert.equal(Date.parse(String(result.coverage.inventoryThrough)),oldest);assert.equal(Date.parse((await roll(MID)).inventoryThrough),oldest);
  if(k<12)assert.equal(oldest,old,`passage ${k} : des partitions restent à relire`);
 }
 assert.ok(archivedAt>1,'pas archivée avant le passage qui lit sa tranche');assert.equal(archivedAt,12,'dernière partition, relue au douzième passage');
 const cp=(await published(MID)).checkpoint;
 assert.ok(cp.partitions.every((p:{inventoriedAt:string})=>Date.parse(p.inventoriedAt)>=start),'12 passages : toutes les partitions relues depuis le départ (6 h à cadence 30)');
 assert.ok(Date.parse(cp.inventoryThrough)>=start);
 console.log(JSON.stringify({synthetic:true,rows:2400,perPass}));
 // Scénario 5 : full toutes les 24 h inchangé (re-partitionnement complet) ; la fiche sans createdAt est alors archivée.
 await sql.query("UPDATE sync_runs SET checkpoint=checkpoint||jsonb_build_object('fullThrough',now()-interval '25 hours') WHERE id=$1",[(await published(MID)).id]);
 const daily=await pass(MID);assert.equal(daily.result.coverage.mode,'full');assert.equal(daily.result.status,'complete');assert.equal(daily.inventory,0);assert.ok(daily.full>=24);
 assert.equal((await mirrorRow('orphan-without-created-at')).archived,true,'seul un passage full archive une fiche sans createdAt');assert.equal(await archivedCount(),2);
 assert.equal(daily.run.checkpoint.tranche,undefined);assert.equal(Date.parse(daily.run.checkpoint.inventoryThrough),Date.parse(daily.run.period_to));
 assert.ok(daily.run.checkpoint.partitions.length<=3,'full : partitions recalculées depuis la lecture complète');
 // Changement de schéma : full inchangé ; puis delta avec la nouvelle preuve.
 const other={digest:'b'.repeat(64),deltaSafe:true};
 assert.equal((await pass(MID,other)).result.coverage.mode,'full');assert.equal((await pass(MID,other)).result.coverage.mode,'delta');
 assert.equal((await pass(MID)).result.coverage.mode,'full','retour à la preuve de départ = nouveau changement de schéma');
});
test('U9 scénario 4 : une modification manquée n’est détectée que par le passage qui relit sa partition, puis full',async()=>{
 const target=midRows[250],published0=await published(MID);assert.equal(published0.checkpoint.mode,'full');
 // Modifiée avant la coupure mais hors de tout intervalle de modifications (antérieure à completedThrough - 2 min).
 target.last_edited_time=new Date(Date.parse(published0.period_to)-600_000).toISOString();target.properties.Etat.select.name='RDV Annulé';
 let detectedAt=0;
 for(let k=1;k<=12&&!detectedAt;k++){
  const {result,run}=await pass(MID),tranche=run.checkpoint.tranche;
  if(process.env.U9_DEBUG)console.log(JSON.stringify({k,status:result.status,mode:result.coverage.mode,tranche,created:target.created_time,edited:target.last_edited_time,period_to:run.period_to,plan:run.checkpoint.inventoryPlan}));
  if(result.status==='failed'){assert.equal(result.coverage.reason,'DELTA_INVENTORY_GAP');assert.ok(inTranche(tranche,target.created_time),'échec seulement quand sa partition est relue');detectedAt=k;}
  else {assert.equal(result.status,'complete');assert.equal(inTranche(tranche,target.created_time),false);assert.equal((await mirrorRow(target.id)).source_status,'RDV Programmé');}
 }
 assert.equal(detectedAt,2,'hors de la première tranche (fiches 0 à 199), dans la deuxième (200 à 399)');
 const recovered=await pass(MID);assert.equal(recovered.result.coverage.mode,'full');assert.equal(recovered.result.status,'complete');assert.equal((await mirrorRow(target.id)).source_status,'RDV Annulé');
});
test('U9 scénario 6 : interruption et reprise à la page enregistrée, rejeu idempotent, tranche figée à la réclamation',async()=>{
 let lastStage:Row|undefined;const recording:Database={...db,rpc:async<T>(name:string,args:Row)=>{if(name==='cockpit_stage_notion')lastStage=args;return rpc<T>(name,args);}};
 const first=await worker(1,MID,proof,recording);assert.equal(first.status,'partial');
 const running=await runOf(first.runId);assert.equal(running.status,'running');assert.equal(running.checkpoint.mode,'delta');assert.equal(running.checkpoint.page,1);
 const resumed=await rpc<any>('cockpit_claim_notion',{p_namespace:MID,p_profile:NOTION_BUSINESS_VERSION,p_schema:proof});assert.equal(resumed.runId,first.runId);assert.deepEqual(resumed.checkpoint.tranche,running.checkpoint.tranche);assert.equal(resumed.checkpoint.page,1);
 const readBefore=(await runOf(first.runId)).checkpoint,rowsBefore=(await sql.query('SELECT rows_read FROM sync_runs WHERE id=$1',[first.runId])).rows[0].rows_read;
 assert.equal(await rpc('cockpit_stage_notion',{...lastStage!,p_lease:resumed.lease}),true,'rejeu de la page enregistrée');
 assert.equal((await sql.query('SELECT rows_read FROM sync_runs WHERE id=$1',[first.runId])).rows[0].rows_read,rowsBefore,'aucun double comptage');
 assert.deepEqual((await runOf(first.runId)).checkpoint,readBefore,'rejeu sans effet');
 await rpc('cockpit_release_notion',{p_run:first.runId,p_lease:resumed.lease,p_error:null});
 let done:Awaited<ReturnType<typeof worker>>;
 for(let i=0;;i++){assert.ok(i<50);done=await worker(1,MID);if(done.status!=='partial')break;assert.deepEqual((await runOf(first.runId)).checkpoint.tranche,running.checkpoint.tranche,'reprise : même tranche');}
 assert.equal(done.status,'complete');assert.equal(done.runId,first.runId);assert.deepEqual((await runOf(first.runId)).checkpoint.tranche,running.checkpoint.tranche);
});
test('U9 garanties : partition en retard de plus de 6 h relue d’office ; budget proportionnel au temps écoulé (cadence 60 = 1/6)',async()=>{
 await age(MID,7);const overdue=await pass(MID),plan=overdue.run.checkpoint.inventoryPlan;
 assert.equal(overdue.result.status,'complete');assert.equal(plan.overdue,plan.partitions);assert.equal(plan.tranchePages,plan.pages);assert.ok(overdue.run.checkpoint.partitions.every((p:{inventoriedAt:string})=>Date.parse(p.inventoriedAt)===Date.parse(overdue.run.period_to)),'toutes relues');
 assert.equal(Date.parse(overdue.run.checkpoint.inventoryThrough),Date.parse(overdue.run.period_to));
 // Horloge simulée : la publication précédente a eu lieu il y a 60 minutes (aucune fiche créée dans cette heure).
 const last=await published(MID);
 await sql.query("UPDATE sync_runs SET period_from=least(period_from,period_to-interval '70 minutes'),period_to=period_to-interval '60 minutes',checkpoint=checkpoint||jsonb_build_object('completedThrough',period_to-interval '60 minutes','partitions',(SELECT jsonb_agg(p||jsonb_build_object('to',least((p->>'to')::timestamptz,period_to-interval '60 minutes')) ORDER BY (p->>'from')::timestamptz) FROM jsonb_array_elements(checkpoint->'partitions') p WHERE (p->>'from')::timestamptz<period_to-interval '60 minutes')) WHERE id=$1",[last.id]);
 const hourly=await pass(MID),hp=hourly.run.checkpoint.inventoryPlan;assert.equal(hourly.result.status,'complete');
 // 60 ou 61 minutes écoulées selon la minute de coupure : f = 1/6 (à une minute près), budget = plafond(S x f).
 assert.ok(hp.fraction>=0.1666&&hp.fraction<=0.1723,`fraction ${hp.fraction}`);assert.ok(hp.budget>=Math.ceil(hp.pages/6)&&hp.budget<=Math.ceil(hp.pages/6)+1,`budget ${hp.budget} pour ${hp.pages} pages`);assert.ok(hp.budget>2*Math.ceil(hp.pages/12)-1,'double de la cadence 30');assert.ok(hp.tranchePages>=hp.budget&&hp.tranchePages<=hp.budget+1);
});
test('U9 capacité à l’échelle (12 050 fiches) : 12 passages delta couvrent tout l’inventaire, au plus 13 pages et 5 unités par passage',async()=>{
 const namespace='44444444-4444-4444-8444-444444444444';const start=Date.parse((await published(namespace)).period_to);
 await age(namespace,1);const perPass:number[]=[];let plan:any;
 for(let k=1;k<=12;k++){const {result,run,inventory,delta}=await pass(namespace);assert.equal(result.status,'complete');assert.equal(result.coverage.mode,'delta');plan=run.checkpoint.inventoryPlan;perPass.push(inventory+delta);assert.ok(inventory+delta<=plan.budget+2,`passage ${k} : ${inventory+delta} pages`);}
 const cp=(await published(namespace)).checkpoint;assert.ok(cp.partitions.every((p:{inventoriedAt:string})=>Date.parse(p.inventoriedAt)>=start),'inventaire complet relu en 12 passages');
 assert.ok(Math.max(...perPass)<=13);assert.ok(Math.max(...perPass.map(pages=>Math.ceil(pages/3)))<=5,'unités de 3 pages (défaut du tick)');assert.equal((await roll(namespace)).sourceRows,12050);
 console.log(JSON.stringify({synthetic:true,rows:12050,partitions:plan.partitions,pages:plan.pages,budget:plan.budget,pagesPerPass:perPass}));
});
test('U9 bord de partition : une fiche créée à moins d’une minute d’un bord de tranche n’est archivée que par le full (created_time arrondi à la minute)',async()=>{
 const EDGE='66666666-6666-4666-8666-666666666666',rows=Array.from({length:150},(_,i)=>makeRow(i));
 // Y créée une minute après la 100e fiche : borne de découpage au milieu (30 s), Y à 30 s du bord ; Z au cœur de la seconde partition.
 const near={...makeRow(0),id:'11111111-1111-4111-8111-00000000beef',created_time:new Date(Date.parse(rows[99].created_time)+60_000).toISOString()},deep=rows[120];
 sources.set(EDGE,[...rows,near]);assert.equal((await pass(EDGE)).result.coverage.mode,'full');
 sources.set(EDGE,[...rows.filter(row=>row!==deep),]);
 const archivedIn=async()=>(await sql.query('SELECT external_id FROM prospects WHERE source_namespace=$1 AND archived ORDER BY external_id',[EDGE])).rows.map(row=>row.external_id);
 const first=await pass(EDGE),second=await pass(EDGE);
 assert.equal(first.run.checkpoint.inventoryPlan.partitions,2);assert.equal(first.run.checkpoint.inventoryPlan.budget,1);
 const bound=Date.parse(rows[99].created_time)+30_000;
 assert.ok(first.run.checkpoint.tranche.some((z:{to:string})=>Date.parse(z.to)===bound),'passage 1 : première partition, bornée au milieu de l’écart');
 assert.ok(second.run.checkpoint.tranche.some((z:{from:string})=>Date.parse(z.from)===bound),'passage 2 : seconde partition (rotation)');
 assert.deepEqual(await archivedIn(),[deep.id],'Z archivée ; Y, à 30 s du bord, attend le full');
 await sql.query("UPDATE sync_runs SET checkpoint=checkpoint||jsonb_build_object('fullThrough',now()-interval '25 hours') WHERE id=$1",[(await published(EDGE)).id]);
 assert.equal((await pass(EDGE)).result.coverage.mode,'full');assert.deepEqual(await archivedIn(),[near.id,deep.id].sort(),'le full archive Y');
});
test('U9 retour arrière : le bloc commenté de 021 remet les corps 013 (passage à tranche en cours mis en échec, aucune fiche archivée à tort), puis 021 se réapplique',async()=>{
 const migration=readFileSync('supabase/migrations/021_notion_rotating_inventory.sql','utf8');
 const block=migration.slice(migration.indexOf('-- RETOUR ARRIERE 021 DEBUT'),migration.indexOf('-- RETOUR ARRIERE 021 FIN')).split('\n').slice(1).map(line=>line.replace(/^-- ?/,'')).join('\n');
 const inFlight=await worker(1,MID);assert.equal(inFlight.status,'partial');assert.ok((await runOf(inFlight.runId)).checkpoint.tranche);
 const archivedBefore=await archivedCount();
 await sql.query(block);
 const stopped=await runOf(inFlight.runId);assert.equal(stopped.status,'failed');assert.equal(stopped.error_code,'rollback_021');
 assert.equal((await sql.query('SELECT count(*) n FROM cockpit_migrations WHERE version=21')).rows[0].n,'0');
 const legacy=await pass(MID);assert.equal(legacy.result.status,'complete');assert.equal(legacy.result.coverage.mode,'delta');assert.equal(legacy.run.checkpoint.tranche,undefined,'corps 013 : pas de tranche');
 assert.ok(legacy.inventory>=24,'013 relit tout l’inventaire, points de reprise 021 compris');assert.equal(await archivedCount(),archivedBefore,'aucune fiche archivée à tort');
 assert.equal(Date.parse(legacy.run.checkpoint.inventoryThrough),Date.parse(legacy.run.period_to));
 await sql.query(migration);assert.equal((await sql.query('SELECT count(*) n FROM cockpit_migrations WHERE version=21')).rows[0].n,'1');
 const again=await pass(MID);assert.equal(again.result.status,'complete');assert.equal(again.result.coverage.mode,'delta');assert.ok(again.run.checkpoint.tranche,'021 réappliquée : tranche depuis un point de reprise 013');
 assert.ok(again.inventory<legacy.inventory);assert.equal(await archivedCount(),archivedBefore);
});
test('023 fenêtre de relecture complète : hors fenêtre, 25 h sans relecture = delta ; dans la fenêtre = full ; 37 h = full quoi qu’il arrive ; sans fenêtre = règle 021 ; forme invalide refusée',async()=>{
 // Espace propre à ce scénario ; la migration 023 est réappliquée (rejouable) : le scénario de retour arrière 021 ci-dessus a remis le corps 021.
 const WIN='77777777-7777-4777-8777-777777777777';sources.set(WIN,midRows.slice(0,300));await sql.query(readFileSync('supabase/migrations/023_notion_full_window.sql','utf8'));
 const parisHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Paris',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
 const inside:[number,number]=[parisHour,parisHour],outside:[number,number]=[(parisHour+2)%24,(parisHour+2)%24],windowed=(hours:[number,number])=>({...proof,fullHours:hours});
 const ageFull=async(hours:number)=>sql.query("UPDATE sync_runs SET checkpoint=checkpoint||jsonb_build_object('fullThrough',now()-make_interval(hours=>$2)) WHERE id=$1",[(await published(WIN)).id,hours]);
 assert.equal((await pass(WIN,windowed(outside))).result.coverage.mode,'full','première fois : relecture complète, fenêtre ou non');
 assert.equal((await pass(WIN,windowed(outside))).result.coverage.mode,'delta');
 await ageFull(25);
 assert.equal((await pass(WIN,windowed(outside))).result.coverage.mode,'delta','25 h sans relecture complète, hors fenêtre : elle attend');
 assert.equal((await pass(WIN,windowed(inside))).result.coverage.mode,'full','dans la fenêtre : relecture complète');
 assert.equal((await pass(WIN,windowed(inside))).result.coverage.mode,'delta','puis delta (moins de 24 h)');
 await ageFull(37);
 assert.equal((await pass(WIN,windowed(outside))).result.coverage.mode,'full','37 h : relecture complète même hors fenêtre (garantie dure)');
 await ageFull(25);
 assert.equal((await pass(WIN)).result.coverage.mode,'full','sans fenêtre : règle 021, relecture complète dès 24 h');
 const runsBefore=(await sql.query("SELECT count(*) n FROM sync_runs WHERE source_namespace=$1",[WIN])).rows[0].n;
 for(const bad of [[5],[7,3],[2.5,4],[-1,4],['2','4'],[0,24],'2-4'])await assert.rejects(rpc('cockpit_claim_notion',{p_namespace:WIN,p_profile:'v1',p_schema:{...proof,fullHours:bad}}),{code:'23514'},JSON.stringify(bad));
 assert.equal((await sql.query("SELECT count(*) n FROM sync_runs WHERE source_namespace=$1",[WIN])).rows[0].n,runsBefore,'forme invalide : aucune tentative créée');
});
