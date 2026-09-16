/**
 * Visiteurs du quiz et de la masterclass lus dans PostHog. Deux lectures :
 *  1. `readVisitsByOrigin` : agrégats par origine (visiteurs uniques actifs dans la période, pages vues) pour la colonne Visiteurs.
 *  2. `readVisitorCohort` : une ligne par visiteur dont la PREMIÈRE visite mesurée sur le tunnel tombe dans la période (période d'entrée),
 *     avec son origine A et son identifiant de navigateur `blg_vid` quand il existe. Le serveur relie ensuite ces visiteurs à leurs
 *     inscriptions (pourcentage d'opt-in) et ne renvoie que des agrégats : aucun identifiant ni parcours individuel ne sort de l'API.
 * Quiz : événement `$pageview` sur les hôtes de production (toutes les pages du quiz) ; masterclass : `mc_page_view` en production sur
 * l'adresse mesurée de la page (`page_path`), /masterclass26 en actif et /blank-1 reconnue comme ancienne adresse, ce qui exclut l'ancienne
 * masterclass et les versions antérieures du composant (sans `page_path`).
 * Un visiteur est compté une fois par tunnel (`blg_vid` quand il existe, sinon l'identifiant PostHog du navigateur) et rattaché à sa
 * première origine mesurée (A) quand la page l'a transmise, sinon à l'origine de sa première arrivée. Un rechargement ou un retour par B
 * n'ajoute donc pas de visiteur. Les clics sortants Meta et ces visites mesurées restent deux compteurs distincts.
 */
import {Temporal} from '@js-temporal/polyfill';
import {readJson,object} from '../connectors/http';
import {originKeyFor,type CohortVisitor,type FunnelTunnel,type VisitCounts,type VisitsByOrigin,type VisitorCohort} from './ad-funnel';

const ALLOWED_HOSTS=['https://eu.posthog.com','https://us.posthog.com','https://app.posthog.com'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_HOGQL='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
/** Adresse active de la masterclass (publiée par Mehdi le 16 septembre 2026) et ancienne adresse, reconnue mais jamais seule. */
export const MASTERCLASS_PAGE_PATH='/masterclass26';
export const MASTERCLASS_LEGACY_PATHS=['/blank-1'] as const;
/** Une lecture par visiteur au-delà de cette taille est refusée : le pourcentage devient indisponible plutôt que partiel. */
export const COHORT_LIMIT=20000;
const quoteList=(values:string[])=>values.map(v=>`'${v.replace(/[^a-z0-9.-]/gi,'')}'`).join(',');
const quotePaths=(values:string[])=>values.map(v=>`'${v.replace(/[^a-z0-9/-]/gi,'')}'`).join(',');
const day=(value:string)=>{Temporal.PlainDate.from(value);return value;};
export type VisitRow=[ad:string,link:string,source:string,visitors:number,pageviews:number,withFirst:number];
export type CohortRow=[visitor:string,joinable:number,firstSeen:string,ad:string,link:string,source:string];

/** Adresse mesurée active : chemin de BLG_MASTERCLASS_URL, sinon /masterclass26. */
export function masterclassPagePath(env:Record<string,string|undefined>):string {
 const configured=env.BLG_MASTERCLASS_URL;
 if(configured){try{const path=new URL(configured).pathname;if(/^\/[a-z0-9][a-z0-9-]{0,80}$/i.test(path))return path;}catch{/* adresse invalide : repli sur l'adresse publiée */}}
 return MASTERCLASS_PAGE_PATH;
}
/** Adresses reconnues pour les visites de la masterclass : l'active d'abord, puis les anciennes (redirigées 301, conservées pour l'historique). */
export function masterclassPagePaths(env:Record<string,string|undefined>):string[] {
 const active=masterclassPagePath(env);
 return [active,...MASTERCLASS_LEGACY_PATHS.filter(p=>p!==active)];
}
const url=(param:string)=>`extractURLParameter(coalesce(toString(properties.$current_url),''),'${param}')`;
const firstOrigin=(key:string)=>`JSONExtractString(coalesce(toString(properties.first_origin),''),'${key}')`;
/** Lignes brutes (une par événement) : visiteur, identifiant raccordable, première origine A si transmise, arrivée courante. */
function quizRows(range:string|null,quizHosts:string[]):string {
 return `SELECT timestamp,
   coalesce(nullIf(toString(properties.visiteur),''), toString(distinct_id)) AS visitor,
   if(match(lower(coalesce(toString(properties.visiteur),'')),'${UUID_HOGQL}'),1,0) AS joinable,
   if(coalesce(toString(properties.premiere_utm_content),'')<>'' OR coalesce(toString(properties.premiere_lien),'')<>'' OR coalesce(toString(properties.premiere_utm_source),'')<>'',1,0) AS has_first,
   coalesce(toString(properties.premiere_utm_content),'') AS f_ad_row, coalesce(toString(properties.premiere_lien),'') AS f_link_row, coalesce(toString(properties.premiere_utm_source),'') AS f_source_row,
   coalesce(nullIf(toString(properties.utm_content),''), ${url('utm_content')}, '') AS a_ad_row,
   coalesce(nullIf(toString(properties.blg_link_id),''), ${url('blg_link_id')}, '') AS a_link_row,
   coalesce(nullIf(toString(properties.utm_source),''), ${url('utm_source')}, '') AS a_source_row
  FROM events WHERE event='$pageview'${range?' AND '+range:''} AND coalesce(toString(properties.$host),'') IN (${quoteList(quizHosts)})`;
}
function masterclassRows(range:string|null,paths:string[]):string {
 return `SELECT timestamp,
   coalesce(nullIf(toString(properties.visitor_id),''), toString(distinct_id)) AS visitor,
   if(match(lower(coalesce(toString(properties.visitor_id),'')),'${UUID_HOGQL}'),1,0) AS joinable,
   if(${firstOrigin('utm_content')}<>'' OR ${firstOrigin('link_id')}<>'' OR ${firstOrigin('utm_source')}<>'',1,0) AS has_first,
   ${firstOrigin('utm_content')} AS f_ad_row, ${firstOrigin('link_id')} AS f_link_row, ${firstOrigin('utm_source')} AS f_source_row,
   coalesce(nullIf(toString(properties.utm_content),''), nullIf(toString(properties.ad_id),''), '') AS a_ad_row,
   coalesce(nullIf(toString(properties.link_id),''), '') AS a_link_row,
   coalesce(nullIf(toString(properties.utm_source),''), '') AS a_source_row
  FROM events WHERE event='mc_page_view'${range?' AND '+range:''} AND lower(coalesce(toString(properties.environment),''))='production' AND coalesce(toString(properties.page_path),'') IN (${quotePaths(paths)})`;
}
/** Par visiteur : première origine A si transmise sur un événement, sinon origine de la première arrivée ; date de première visite. */
function perVisitor(source:string):string {
 return `SELECT visitor, max(joinable) AS joinable, min(timestamp) AS first_seen, count() AS views, max(has_first) AS with_first,
   argMinIf(f_ad_row, timestamp, has_first=1) AS f_ad, argMinIf(f_link_row, timestamp, has_first=1) AS f_link, argMinIf(f_source_row, timestamp, has_first=1) AS f_source,
   argMin(a_ad_row, timestamp) AS a_ad, argMin(a_link_row, timestamp) AS a_link, argMin(a_source_row, timestamp) AS a_source
  FROM (${source}) GROUP BY visitor`;
}
function grouped(source:string):string {
 return `SELECT ad, link, source, count() AS visitors, sum(views) AS pageviews, sum(with_first) AS with_first FROM (
 SELECT visitor, views, with_first, if(with_first=1, f_ad, a_ad) AS ad, if(with_first=1, f_link, a_link) AS link, if(with_first=1, f_source, a_source) AS source FROM (${perVisitor(source)})
) GROUP BY ad, link, source`;
}
function cohort(source:string,start:string,end:string):string {
 return `SELECT visitor, joinable, first_seen, if(with_first=1, f_ad, a_ad) AS ad, if(with_first=1, f_link, a_link) AS link, if(with_first=1, f_source, a_source) AS source FROM (${perVisitor(source)})
 WHERE first_seen >= toDateTime('${start} 00:00:00','Europe/Paris') AND first_seen < toDateTime('${end} 00:00:00','Europe/Paris') ORDER BY first_seen, visitor LIMIT ${COHORT_LIMIT+1}`;
}
export function visitQueries(from:string,to:string,env:Record<string,string|undefined>){
 const start=day(from),end=Temporal.PlainDate.from(day(to)).add({days:1}).toString();
 const quizHosts=(env.POSTHOG_QUIZ_HOST??'quizz.blg-studio.fr').split(',').map(h=>h.trim()).filter(Boolean);
 const range=`timestamp >= toDateTime('${start} 00:00:00','Europe/Paris') AND timestamp < toDateTime('${end} 00:00:00','Europe/Paris')`;
 const paths=masterclassPagePaths(env);
 return {
  quiz:grouped(quizRows(range,quizHosts)),
  masterclass:grouped(masterclassRows(range,paths)),
  /** Cohortes d'entrée : première visite mesurée dans la période, toute l'histoire est lue pour dater cette première visite. */
  quizCohort:cohort(quizRows(null,quizHosts),start,end),
  masterclassCohort:cohort(masterclassRows(null,paths),start,end),
  /** Vues de la masterclass sans adresse mesurée : version publiée antérieure au raccord, comptées à part et jamais dans la page active. */
  legacyMasterclass:`SELECT count() AS c FROM events WHERE event='mc_page_view' AND ${range} AND lower(coalesce(toString(properties.environment),''))='production' AND coalesce(toString(properties.page_path),'')=''`,
  pagePath:paths[0],pagePaths:paths,
 };
}

const toVisitRow=(row:unknown[]):VisitRow=>[String(row[0]??''),String(row[1]??''),String(row[2]??''),Number(row[3]??0),Number(row[4]??0),Number(row[5]??0)];
const toCohortRow=(row:unknown[]):CohortRow=>[String(row[0]??''),Number(row[1]??0),String(row[2]??''),String(row[3]??''),String(row[4]??''),String(row[5]??'')];
const empty=():VisitCounts=>({visitors:0,pageviews:0,withFirstOrigin:0});
const keyOf=(ad:string,link:string,source:string)=>originKeyFor({adId:/^\d{10,30}$/.test(ad)?ad:null,linkId:UUID.test(link)?link.toLowerCase():null,campaignId:null,source:source||null});
/** Regroupe les lignes (ad, lien, source, visiteurs, pages vues, avec première origine) sous la même clé que les lignes du tableau. */
export function foldVisits(rows:{quiz:VisitRow[];masterclass:VisitRow[]},extra:{legacyMasterclassViews?:number|null;observedAt?:string|null}={}):VisitsByOrigin{
 const result:VisitsByOrigin={available:true,reason:null,observedAt:extra.observedAt??null,byKey:new Map(),legacyMasterclassViews:extra.legacyMasterclassViews??null};
 for(const tunnel of ['quiz','masterclass'] as const)for(const [ad,link,source,visitors,pageviews,withFirst] of rows[tunnel]){
  if(![visitors,pageviews,withFirst].every(n=>Number.isSafeInteger(n)&&n>=0))return {available:false,reason:'Lecture PostHog des visites incomplète : compteurs invalides.',observedAt:extra.observedAt??null,byKey:new Map(),legacyMasterclassViews:extra.legacyMasterclassViews??null};
  const key=keyOf(ad,link,source);
  const entry=result.byKey.get(key)??{quiz:empty(),masterclass:empty()};
  entry[tunnel].visitors+=visitors;entry[tunnel].pageviews+=pageviews;entry[tunnel].withFirstOrigin+=withFirst;
  result.byKey.set(key,entry);
 }
 return result;
}
/** Instant PostHog normalisé ; null si illisible (le visiteur est alors ignoré, jamais daté au hasard). */
function posthogInstant(value:string):string|null {
 const text=value.includes('T')?value:value.replace(' ','T');
 for(const candidate of [text,text+'Z']){try{return Temporal.Instant.from(candidate).toString();}catch{/* essai suivant */}}
 return null;
}
/** Jour de Paris d'un horodatage PostHog. */
export function parisDay(value:string):string|null {const instant=posthogInstant(value);return instant?Temporal.Instant.from(instant).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString():null;}
/** Cohorte d'entrée : visiteurs raccordables (identifiant de navigateur) datés de leur première visite ; les autres comptés à part. */
export function foldVisitorCohort(rows:{quiz:CohortRow[];masterclass:CohortRow[]},extra:{observedAt?:string|null}={}):VisitorCohort{
 const result:VisitorCohort={available:true,reason:null,observedAt:extra.observedAt??null,visitors:[],unlinkable:new Map(),truncated:false};
 for(const tunnel of ['quiz','masterclass'] as const){
  if(rows[tunnel].length>COHORT_LIMIT){result.truncated=true;}
  for(const [visitor,joinable,firstSeen,ad,link,source] of rows[tunnel].slice(0,COHORT_LIMIT)){
   const key=keyOf(ad,link,source),instant=posthogInstant(firstSeen),firstDay=instant?Temporal.Instant.from(instant).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString():null;
   if(!instant||!firstDay){result.available=false;result.reason='Lecture PostHog de la cohorte incomplète : une première visite est illisible.';continue;}
   if(joinable===1&&UUID.test(visitor))result.visitors.push({id:visitor.toLowerCase(),tunnel:tunnel as FunnelTunnel,key,firstSeen:instant,firstDay});
   else{const entry=result.unlinkable.get(key)??{quiz:0,masterclass:0};entry[tunnel]++;result.unlinkable.set(key,entry);}
  }
 }
 if(result.truncated){result.available=false;result.reason=`Plus de ${COHORT_LIMIT} visiteurs entrés dans la période : réduire la période pour lire le pourcentage d’opt-in.`;}
 if(!result.available){result.visitors=[];result.unlinkable=new Map();}
 return result;
}

function client(env:Record<string,string|undefined>):{endpoint:URL;projectId:string;key:string}|{reason:string}{
 const host=env.POSTHOG_HOST,projectId=env.POSTHOG_PROJECT_ID,key=env.POSTHOG_PERSONAL_API_KEY;
 if(!host||!projectId||!key)return {reason:'PostHog n’est pas configuré : visiteurs par publicité indisponibles.'};
 let endpoint:URL;try{endpoint=new URL(host);}catch{return {reason:'Adresse PostHog invalide.'};}
 if(!ALLOWED_HOSTS.includes(endpoint.origin)||!/^\d+$/.test(projectId))return {reason:'Configuration PostHog refusée.'};
 return {endpoint,projectId,key};
}
function runner(c:{endpoint:URL;projectId:string;key:string},fetcher:typeof fetch,name:string){
 return async(query:string)=>{
  const body=object(await readJson(new URL(`/api/projects/${c.projectId}/query/`,c.endpoint.origin),{method:'POST',headers:{Authorization:`Bearer ${c.key}`,'Content-Type':'application/json'},body:JSON.stringify({query:{kind:'HogQLQuery',query},name})},{fetcher}));
  return Array.isArray(body.results)?body.results.map(row=>Array.isArray(row)?row:[]):[];
 };
}
export async function readVisitsByOrigin(from:string,to:string,env:Record<string,string|undefined>=process.env,fetcher:typeof fetch=fetch):Promise<VisitsByOrigin>{
 const unavailable=(reason:string):VisitsByOrigin=>({available:false,reason,observedAt:null,byKey:new Map(),legacyMasterclassViews:null});
 const c=client(env);if('reason' in c)return unavailable(c.reason);
 const queries=visitQueries(from,to,env),run=runner(c,fetcher,'BLG visitors by origin');
 try{
  const [quiz,masterclass,legacy]=await Promise.all([run(queries.quiz),run(queries.masterclass),run(queries.legacyMasterclass)]);
  const legacyViews=Number(legacy[0]?.[0]??0);
  return foldVisits({quiz:quiz.map(toVisitRow),masterclass:masterclass.map(toVisitRow)},{legacyMasterclassViews:Number.isFinite(legacyViews)?legacyViews:null,observedAt:new Date().toISOString()});
 }catch{return unavailable('Lecture PostHog des visiteurs par publicité interrompue ; les autres colonnes restent lisibles.');}
}
/** Cohorte d'entrée par tunnel : identifiants lus en mémoire serveur seulement, jamais renvoyés. */
export async function readVisitorCohort(from:string,to:string,env:Record<string,string|undefined>=process.env,fetcher:typeof fetch=fetch):Promise<VisitorCohort>{
 const unavailable=(reason:string):VisitorCohort=>({available:false,reason,observedAt:null,visitors:[],unlinkable:new Map(),truncated:false});
 const c=client(env);if('reason' in c)return unavailable(c.reason);
 const queries=visitQueries(from,to,env),run=runner(c,fetcher,'BLG visitor cohort');
 try{
  const [quiz,masterclass]=await Promise.all([run(queries.quizCohort),run(queries.masterclassCohort)]);
  return foldVisitorCohort({quiz:quiz.map(toCohortRow),masterclass:masterclass.map(toCohortRow)},{observedAt:new Date().toISOString()});
 }catch{return unavailable('Lecture PostHog des visiteurs entrés dans la période interrompue : pourcentage d’opt-in indisponible.');}
}
