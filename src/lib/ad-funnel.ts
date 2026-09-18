/**
 * Projection par publicité : publicité → visiteurs → inscriptions → personnes → rendez-vous → première vente payée → encaissements.
 * Lecture seule des tables déjà publiées ; aucune nouvelle table, aucun import, aucune fusion de personnes.
 *
 * Règle actée par Mehdi (15 septembre 2026) : la première origine mesurable A conserve le crédit, même si l'inscription
 * arrive plus tard par B. Mise en œuvre : l'origine d'une personne est la plus ANCIENNE origine datée parmi toutes ses
 * inscriptions (première origine A conservée par le navigateur, datée par son horodatage ; sinon l'arrivée de
 * l'inscription, datée par l'inscription). Les inscriptions suivantes ne déplacent jamais ce crédit.
 * Ce qui n'est pas relié reste « non attribué » ou « partiel », jamais zéro.
 *
 * Pourcentages validés par Mehdi le 16 septembre 2026 : opt-in (visiteurs mesurés → inscrits), réservation (inscrits → RDV
 * réservé) et présence (RDV passés à issue connue → présents). Chaque taux expose numérateur, dénominateur et période.
 * Opt-in : cohorte d'entrée. Un visiteur mesuré (identifiant de navigateur `blg_vid`) dont la première visite tombe dans la période
 * est suivi jusqu'à la date de lecture ; il est « inscrit » s'il a ensuite une inscription confirmée portant le même identifiant,
 * sur le même tunnel (ou sur l'un des deux pour le total). Les visiteurs sans identifiant et les inscriptions sans visite
 * raccordable sont comptés à part, jamais dans le calcul. Numérateur et dénominateur décrivent donc le même groupe.
 */
import {Temporal} from '@js-temporal/polyfill';
import type {Database,Row} from './db';
import {commerceReadMemo,readNotionCommerceReport} from './notion-commerce-storage';
import type {PaidSaleDetail} from './paid-sales';
import type {SourceFilter,TunnelFilter} from './ui-contract';
import {businessDay,appointmentDay,appointmentOutcome,appointmentBooking,isEffectiveAppointment,isUpcomingAppointment} from './appointment-semantics';
import {wixLeadEntryConfig} from '../connectors/wix-lead-entries';
import {reconcileAcquisitionPeople,acquisitionDays} from './results-acquisition';
export {appointmentOutcome} from './appointment-semantics';
import {DEFAULT_TRAFFIC_SCOPE,isExcludedTestTraffic,type TrafficScope} from './traffic-scope';

export type FunnelTunnel='quiz'|'masterclass';
export interface AdFunnelOrigin {adId:string|null;campaignId:string|null;adsetId:string|null;linkId:string|null;source:string|null;medium?:string|null;basis:'first_touch'|'arrival'|'none'}
/** Un pourcentage n'existe que si son dénominateur est mesuré et non nul ; sinon il reste indisponible avec sa raison. */
export interface Rate {value:number|null;numerator:number|null;denominator:number|null;reason?:string}
export interface TunnelCounts {quiz:number|null;masterclass:number|null}
export interface AdFunnelRow {
 key:string;kind:'ad'|'organic'|'unattributed';source:'paid'|'organic'|'unknown';label:string;campaignLabel:string|null;
 adId:string|null;campaignId:string|null;adsetId:string|null;creativeId:string|null;linkIds:string[];links:{id:string;label:string;campaign:string}[];
 tunnels:FunnelTunnel[];
 spendMinor:number|null;impressions:number|null;outboundClicks:number|null;
 /** Visiteurs uniques et pages vues mesurés (PostHog), rattachés à la première origine quand elle est mesurée, sinon à l'arrivée. */
 visitors:TunnelCounts;pageviews:TunnelCounts;visitorsWithFirstOrigin:number|null;
 optin:OptinDetail;
 registrations:number;registrationsByTunnel:{quiz:number;masterclass:number};uniqueRegistrants:number;uniqueLeads:number;uniqueLeadsByTunnel:{quiz:number;masterclass:number};knownBefore:number;unresolvedIdentity:number;
 /** Inscrits uniques de la période ayant au moins un rendez-vous effectif (créneau Notion non annulé), quelle que soit sa date. */
 leadsBooked:number;
	appointmentsReserved:number;appointmentsBooked:number;appointmentsAttended:number;appointmentsNoShow:number;appointmentsCancelled:number;appointmentsRescheduled:number;appointmentsUpcoming:number;appointmentsUnknown:number;
	firstSalesConfirmed:number|null;firstSalesReconciled:number|null;firstSalesPending:number|null;cashMinor:number|null;refundsMinor:number|null;
 attributionBasis:{firstTouch:number;arrival:number};
 rates:{optin:Rate;booking:Rate;attendance:Rate};
}
export type AdFunnelTotals=Omit<AdFunnelRow,'key'|'kind'|'source'|'label'|'campaignLabel'|'adId'|'campaignId'|'adsetId'|'creativeId'|'linkIds'|'links'|'tunnels'>;
export interface AdFunnelReport {
 available:boolean;period:{from:string;to:string;timezone:string};generatedAt:string;
 filters:{tunnel:TunnelFilter;source:SourceFilter;campaign:string;includeTests:boolean};
 campaigns?:{id:string;label:string}[];
 linkDetails?:AdFunnelRow[];
 rows:AdFunnelRow[];totals:AdFunnelTotals;
 coverage:{
  leads:{available?:boolean;complete?:boolean;observedAt:string|null;families:string[];rows:number;withFirstTouch:number;withVisitor:number};
  meta:{lastDay:string|null;ads:number;adsWithoutCreative:number};
  appointments:{rows:number;linkedPeople:number;attendanceFromBusiness:number;observedAt?:string|null;available?:boolean;reason?:string|null;bookingDates?:number;bookingInstants?:number};
	  commerce:{available:boolean;reason:string|null;observedAt:string|null;paidSaleRows:number|null;clientsLinked:number|null;clientsUnlinked:number|null;moneyRowsUnavailable:number|null};
  visits:{available:boolean;reason:string|null;observedAt:string|null;legacyMasterclassViews:number|null};
  optin:{available:boolean;reason:string|null;observedAt:string|null;entryPeriod:{from:string;to:string};visitorsLinkable:number|null;visitorsUnlinkable:number|null;registrationsInCohort:number;registrationsWithoutVisitor:number;registrationsOutsideCohort:number};
  testing:{includeTests:boolean;registrationsExcluded:number;appointmentsExcluded:number;salesExcluded:number;visitsScoped:boolean;cohortScoped:boolean};
 };
 definitions:Record<string,string>;notices:string[];
}
type Observation={id:string;sourceNamespace:string;family:'forms'|'quiz'|'client_history';externalId:string;personId:string|null;identityState:string;eligible:boolean;occurredAt:string|null;occurredDay:string|null;origin:Record<string,unknown>;firstTouch:Record<string,unknown>|null;testMarker:Record<string,unknown>;publishedAt:string|null};
export interface VisitCounts {visitors:number;pageviews:number;withFirstOrigin:number}
/** Visites mesurées, déjà regroupées par clé d'origine (même clé que les lignes du tableau) et par tunnel. */
export interface VisitsByOrigin {available:boolean;reason:string|null;observedAt:string|null;byKey:Map<string,{quiz:VisitCounts;masterclass:VisitCounts}>;legacyMasterclassViews:number|null;scope?:TrafficScope}
/** Un visiteur raccordable entré dans la période sur un tunnel : identifiant, origine A, instant exact et jour Paris de première visite. Lu en mémoire serveur, jamais renvoyé. */
export interface CohortVisitor {id:string;tunnel:FunnelTunnel;key:string;firstSeen:string;firstDay:string}
export interface VisitorCohort {available:boolean;reason:string|null;observedAt:string|null;visitors:CohortVisitor[];unlinkable:Map<string,{quiz:number;masterclass:number}>;truncated:boolean;scope?:TrafficScope}
export interface OptinCounts {visitors:number;registered:number}
export interface OptinAll extends OptinCounts {newLeads:number;knownPeople:number;unresolvedIdentity:number}
/** Opt-in par cohorte : par tunnel (inscription sur le même tunnel) et total (un visiteur compte une fois, inscription sur l'un des deux tunnels) ; couverture à part. */
export interface OptinDetail {quiz:OptinCounts|null;masterclass:OptinCounts|null;all:OptinAll|null;unlinkableVisitors:{quiz:number;masterclass:number}|null;registrationsWithoutVisitor:number;registrationsOutsideCohort:number}
export interface AdFunnelFilters {from:string;to:string;tunnel:TunnelFilter;source?:SourceFilter;campaign?:string;includeTests?:boolean}
export interface AdFunnelOptions {env?:Record<string,string|undefined>;visits?:VisitsByOrigin|null;cohort?:VisitorCohort|null;now?:string;includeCommerce?:boolean}

export const ORGANIC='__organic__',UNATTRIBUTED='__unattributed__',UNRESOLVED='__unresolved__',PAID_UNATTRIBUTED='__paid_unattributed__';
const numericId=(v:unknown)=>typeof v==='string'&&/^\d{10,30}$/.test(v)?v:null;
const text=(v:unknown,max=180)=>typeof v==='string'&&v.length<=max?v:null;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EARLIEST_MEASURABLE='2026-07-01T00:00:00Z';

function originFrom(record:Record<string,unknown>|null,basis:'first_touch'|'arrival'):AdFunnelOrigin{
 if(!record)return {adId:null,campaignId:null,adsetId:null,linkId:null,source:null,basis:'none'};
 const adId=numericId(record.ad),campaignId=numericId(record.campaign),adsetId=numericId(record.adset),link=text(record.linkId,36),linkId=link&&UUID.test(link)?link.toLowerCase():null,source=text(record.source,60),medium=text(record.medium,60);
 if(adId||campaignId||adsetId||linkId||source||medium)return {adId,campaignId,adsetId,linkId,source,...(medium?{medium}:{}),basis};
 return {adId:null,campaignId:null,adsetId:null,linkId:null,source:null,basis:'none'};
}
/** L'origine d'une inscription prise seule : A si elle existe, sinon l'arrivée. */
export function observationOrigin(o:Pick<Observation,'origin'|'firstTouch'>):AdFunnelOrigin {
 const first=originFrom(o.firstTouch,'first_touch');
 return first.basis==='none'?originFrom(o.origin,'arrival'):first;
}
/** Clé de ligne commune aux inscriptions, rendez-vous, ventes et visites : publicité, sinon lien, sinon campagne, sinon source (organique). */
export function originKeyFor(o:{adId?:string|null;linkId?:string|null;campaignId?:string|null;source?:string|null;medium?:string|null}):string {
 return o.adId?'ad:'+o.adId:o.linkId?'link:'+o.linkId:o.campaignId?'campaign:'+o.campaignId:['paid','cpc','ppc','paid_social','paid-search'].includes(o.medium??'')?PAID_UNATTRIBUTED:o.source||['organic','social','email','referral','organic_social','organic_video'].includes(o.medium??'')?ORGANIC:UNATTRIBUTED;
}
const originKey=(o:AdFunnelOrigin)=>originKeyFor(o);
/** Horodatage de première origine borné : jamais après l'inscription qui le porte, jamais avant la première mesure possible. */
function firstTouchInstant(raw:unknown,occurredAt:string):string {
 if(typeof raw!=='string')return occurredAt;
 let at:string;try{at=Temporal.Instant.from(raw).toString();}catch{return occurredAt;}
 if(Temporal.Instant.compare(at,EARLIEST_MEASURABLE)<0||Temporal.Instant.compare(at,occurredAt)>0)return occurredAt;
 return at;
}
type Candidate={origin:AdFunnelOrigin;at:string;observationId:string};
const earlier=(a:Candidate,b:Candidate)=>Temporal.Instant.compare(a.at,b.at)<0||(Temporal.Instant.compare(a.at,b.at)===0&&(a.origin.basis==='first_touch'&&b.origin.basis!=='first_touch'||(a.origin.basis===b.origin.basis&&a.observationId<b.observationId)));

async function pages(db:Database,table:Parameters<Database['select']>[0],options:Parameters<Database['select']>[1],max=20000):Promise<Row[]>{
 const rows:Row[]=[];
 for(let from=0;from<max;from+=1000){const page=await db.select(table,{...options,from,limit:1000});rows.push(...page);if(page.length<1000)return rows;}
 throw new Error('AD_FUNNEL_READ_LIMIT');
}
function toObservation(r:Row):Observation{
 const p=(r.properties&&typeof r.properties==='object'?r.properties:{}) as Record<string,unknown>;
 const occurredAt=r.occurred_at?Temporal.Instant.from(String(r.occurred_at)).toString():null;
 return {id:String(r.id),sourceNamespace:String(r.source_namespace??''),family:r.family as Observation['family'],externalId:String(r.external_id),personId:r.person_id?String(r.person_id):null,identityState:String(r.identity_state??'unresolved'),eligible:r.eligible===true,occurredAt,occurredDay:occurredAt?Temporal.Instant.from(occurredAt).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString():r.occurred_day?String(r.occurred_day):null,origin:(p.origin&&typeof p.origin==='object'?p.origin:{}) as Record<string,unknown>,firstTouch:(p.firstTouch&&typeof p.firstTouch==='object'?p.firstTouch:null) as Record<string,unknown>|null,testMarker:{is_test:p.is_test,isTest:p.isTest},publishedAt:r.published_at?String(r.published_at):null};
}
/** Canonical first origin for published registrations, across periods and tunnels. Pure: no identity merge or external read. */
export function canonicalRegistrationOrigins(rows:Row[],includeTests=false):Map<string,{origin:AdFunnelOrigin;at:string}> {
 const best=new Map<string,Candidate>();
 for(const row of rows){
  if(row.is_current===false||!row.published_at||row.eligible!==true||!['forms','quiz'].includes(String(row.family)))continue;
  const o=toObservation(row);
  if(!o.personId||o.identityState!=='linked'||!o.occurredAt||isExcludedTestTraffic({includeTests},o.origin,o.firstTouch,o.testMarker))continue;
  const arrival=originFrom(o.origin,'arrival'),first=originFrom(o.firstTouch,'first_touch'),candidates:Candidate[]=[];
  if(first.basis!=='none')candidates.push({origin:first,at:firstTouchInstant(o.firstTouch?.at,o.occurredAt),observationId:o.id});
  if(arrival.basis!=='none')candidates.push({origin:arrival,at:o.occurredAt,observationId:o.id});
  for(const candidate of candidates){const prior=best.get(o.personId);if(!prior||earlier(candidate,prior))best.set(o.personId,candidate);}
 }
 return new Map([...best].map(([person,{origin,at}])=>[person,{origin,at}]));
}
const inPeriod=(day:string|null,from:string,to:string)=>!!day&&day>=from&&day<=to;
const rate=(numerator:number|null,denominator:number|null,reason:string):Rate=>numerator===null||denominator===null?{value:null,numerator,denominator,reason}:denominator>0?{value:numerator/denominator,numerator,denominator}:{value:null,numerator,denominator,reason};
const RATE_REASONS={optin:'Aucun visiteur raccordable entré dans la période sur cette ligne.',cohort:'Visiteurs entrés dans la période non lus : pourcentage d’opt-in indisponible.',booking:'Aucun inscrit unique sur cette ligne pour la période.',attendance:'Aucun rendez-vous passé à issue connue sur cette ligne pour la période.',visits:'Visites non lues : pourcentage d’opt-in indisponible.'};
const emptyCounts=():TunnelCounts=>({quiz:null,masterclass:null});
function emptyRow(key:string,kind:AdFunnelRow['kind'],label:string):AdFunnelRow{
	 return {key,kind,source:kind==='ad'?'paid':kind==='organic'?'organic':'unknown',label,campaignLabel:null,adId:null,campaignId:null,adsetId:null,creativeId:null,linkIds:[],links:[],tunnels:[],spendMinor:null,impressions:null,outboundClicks:null,visitors:emptyCounts(),pageviews:emptyCounts(),visitorsWithFirstOrigin:null,optin:{quiz:null,masterclass:null,all:null,unlinkableVisitors:null,registrationsWithoutVisitor:0,registrationsOutsideCohort:0},registrations:0,registrationsByTunnel:{quiz:0,masterclass:0},uniqueRegistrants:0,uniqueLeads:0,uniqueLeadsByTunnel:{quiz:0,masterclass:0},knownBefore:0,unresolvedIdentity:0,leadsBooked:0,appointmentsReserved:0,appointmentsBooked:0,appointmentsAttended:0,appointmentsNoShow:0,appointmentsCancelled:0,appointmentsRescheduled:0,appointmentsUpcoming:0,appointmentsUnknown:0,firstSalesConfirmed:null,firstSalesReconciled:null,firstSalesPending:null,cashMinor:null,refundsMinor:null,attributionBasis:{firstTouch:0,arrival:0},rates:{optin:rate(null,null,RATE_REASONS.cohort),booking:rate(0,0,RATE_REASONS.booking),attendance:rate(0,0,RATE_REASONS.attendance)}};
}
/** Origine minimale reconstruite depuis une clé de ligne (visites et cohortes arrivent déjà regroupées par clé). */
function keyOrigin(key:string):AdFunnelOrigin {
 const [scope,value]=[key.slice(0,key.indexOf(':')),key.slice(key.indexOf(':')+1)];
 return {adId:scope==='ad'?value:null,campaignId:scope==='campaign'?value:null,adsetId:null,linkId:scope==='link'?value:null,source:key===ORGANIC?'organic':null,basis:'none'};
}
function matchesFilters(row:AdFunnelRow,source:SourceFilter,campaign:string):boolean {
 if(source!=='all'&&row.source!==source)return false;
 if(!campaign||campaign==='all')return true;
 const [scope,value]=[campaign.slice(0,campaign.indexOf(':')),campaign.slice(campaign.indexOf(':')+1)];
 if(scope==='meta')return row.campaignId===value;
 if(scope==='meta-ad')return row.adId===value;
 if(scope==='meta-creative')return row.creativeId===value;
 if(scope==='link')return row.links.some(l=>l.campaign===value);
 return false;
}

/** Une lecture bornée par période. Chaque colonne a sa propre date : visite, inscription, rendez-vous, paiement. */
export async function buildAdFunnel(db:Database,filters:AdFunnelFilters,options:AdFunnelOptions={}):Promise<AdFunnelReport>{
 const env=options.env??process.env,{from,to}=filters,notices:string[]=[],sourceFilter=filters.source??'all',campaignFilter=filters.campaign??'',testScope:TrafficScope={...DEFAULT_TRAFFIC_SCOPE,includeTests:filters.includeTests===true};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to||Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days>366)throw new Error('AD_FUNNEL_INVALID_PERIOD');
 const generatedAt=options.now??new Date().toISOString();
 const today=Temporal.Instant.from(generatedAt).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
 const siteId=env.WIX_SITE_ID??null,entryConfig=wixLeadEntryConfig(env.WIX_LEAD_ENTRY_CONFIG);
 const allowedContainer=(r:Row)=>!entryConfig||r.family==='client_history'||r.family==='forms'&&entryConfig.formIds.includes(String(r.source_container_id))||r.family==='quiz'&&entryConfig.quiz?.collectionId===r.source_container_id;
 // 1. Inscriptions publiées (Wix formulaires + quiz) et antériorités Client (Notion), toutes périodes : l'origine d'une personne dépend de tout son historique.
 const [leadRows,prospects,sourceRuns]=await Promise.all([
  pages(db,'lead_source_observations',{eq:{is_current:'true'},order:'occurred_day,id'}),
  pages(db,'prospects',{order:'id',columns:['id','external_id','source','source_namespace','person_id','business','archived']},50000),
  pages(db,'sync_runs',{order:'started_at,id',columns:['id','source','source_namespace','stream_key','status','pagination_complete','rows_rejected','finished_at','source_as_of','covered_to','period_to','started_at','query_profile_key']},50000),
 ]);
 const completedRuns=sourceRuns.filter(r=>['complete','empty'].includes(String(r.status))&&r.pagination_complete===true&&Number(r.rows_rejected??0)===0);
 const runById=new Map(completedRuns.map(run=>[String(run.id),run]));
 const latestProfile=new Map<string,unknown>();
 for(const run of [...completedRuns].sort((a,b)=>String(a.finished_at??a.started_at).localeCompare(String(b.finished_at??b.started_at))||String(a.id).localeCompare(String(b.id))))if(String(run.stream_key).startsWith('lead_entries_'))latestProfile.set(run.source_namespace+':'+String(run.stream_key).slice(13),run.query_profile_key);
 const publishedObservation=(row:Row)=>!row.run_id||runById.has(String(row.run_id))&&row.mapping_profile===latestProfile.get(row.source_namespace+':'+row.family);
 const reconciledRows=reconcileAcquisitionPeople(leadRows.filter(r=>r.published_at&&publishedObservation(r)&&allowedContainer(r)&&(!env.NOTION_CLIENT_DATA_SOURCE_ID||r.family!=='client_history'||r.source_namespace===env.NOTION_CLIENT_DATA_SOURCE_ID)),prospects,env.NOTION_DATA_SOURCE_ID).filter(r=>!siteId||r.family==='client_history'||r.source_namespace===siteId);
 const observations=reconciledRows.map(toObservation);
 const candidateRequests=observations.filter(o=>(o.family==='forms'||o.family==='quiz')&&o.eligible&&o.occurredDay&&o.occurredAt);
 const excludedTestRequests=candidateRequests.filter(o=>isExcludedTestTraffic(testScope,o.origin,o.firstTouch,o.testMarker));
 const requests=candidateRequests.filter(o=>!isExcludedTestTraffic(testScope,o.origin,o.firstTouch,o.testMarker)).sort((a,b)=>Temporal.Instant.compare(a.occurredAt!,b.occurredAt!)||a.id.localeCompare(b.id));
 const excludedTestPeople=new Set(excludedTestRequests.filter(o=>o.personId&&o.identityState==='linked').map(o=>o.personId!));
 const retainedPeople=new Set(requests.filter(o=>o.personId&&o.identityState==='linked').map(o=>o.personId!));
 const clientHistory=observations.filter(o=>o.family==='client_history');
 const clientById=new Map(clientHistory.map(c=>[c.externalId,c]));
 const earliestClientDay=new Map<string,string>();for(const c of clientHistory)if(c.eligible&&c.personId&&c.occurredDay&&(!earliestClientDay.has(c.personId)||c.occurredDay<earliestClientDay.get(c.personId)!))earliestClientDay.set(c.personId,c.occurredDay);
 // 2. Première inscription (par horodatage) et origine canonique = plus ancienne origine datée de la personne (A prime sur l'arrivée à date égale).
 const firstRequest=new Map<string,Observation>(),canonicalOrigins=canonicalRegistrationOrigins(reconciledRows,testScope.includeTests);
 const firstKnownDay=acquisitionDays(prospects,env.NOTION_DATA_SOURCE_ID,testScope.includeTests);
 for(const o of requests){
  if(!o.personId||o.identityState!=='linked')continue;
  if(!firstRequest.has(o.personId))firstRequest.set(o.personId,o);
  if(!firstKnownDay.has(o.personId)||o.occurredDay!<firstKnownDay.get(o.personId)!)firstKnownDay.set(o.personId,o.occurredDay!);

 }
 const personOrigin=new Map<string,AdFunnelOrigin>();for(const [person,c] of canonicalOrigins)personOrigin.set(person,c.origin);
 const personTunnel=(person:string):FunnelTunnel|null=>{const first=firstRequest.get(person);return first?first.family==='quiz'?'quiz':'masterclass':null;};
 // 3. Catalogue Meta, dépenses de la période et registre des liens.
 const ads=await pages(db,'ads',{order:'id'});
 const adByExternal=new Map(ads.map(a=>[String(a.external_id),a]));
 const adDaily=await pages(db,'v_ad_daily',{gte:{date:from},lt:{date:Temporal.PlainDate.from(to).add({days:1}).toString()},order:'date,id'});
 let metaLastDay:string|null=null;for(const d of adDaily){const day=String(d.date);if(!metaLastDay||day>metaLastDay)metaLastDay=day;}
 const adUuidToExternal=new Map(ads.map(a=>[String(a.id),String(a.external_id)]));
 const revisions=await pages(db,'link_revisions',{order:'id',columns:['id','label','campaign','tunnel','medium']},10000);
 const revisionMedium=new Map(revisions.map(r=>[String(r.id),String(r.medium??'')]));
 const revisionById=new Map(revisions.map(r=>[String(r.id),{id:String(r.id),label:String(r.label??''),campaign:String(r.campaign??'')}]));
 // 4. Rendez-vous (miroir Notion) reliés à la personne par le prospect ; présence lue dans la classification courante du prospect.
 const appointments=await pages(db,'appointments',{order:'id'});
 const prospectById=new Map(prospects.map(p=>[String(p.id),{personId:p.person_id?String(p.person_id):null,business:p.business&&typeof p.business==='object'?p.business as Row:null,archived:p.archived===true}]));
 // 5. Ventes payées déjà classées (relevé Notion-commerce), reliées à la personne par le Client Notion.
	 const commerce=options.includeCommerce===false?null:await readNotionCommerceReport(db,{from:'1900-01-01',to:'2999-12-31',source:'all',tunnel:'all',campaign:'all',compare:false},env,commerceReadMemo());
	 const commerceAvailable=!!commerce?.available&&!!commerce.paidSales;
	 const commerceReason=commerceAvailable?null:commerce?.reason??'Le relevé détaillé des ventes payées n’est pas configuré : ventes et encaissements restent indisponibles.';
	 const paidSales:PaidSaleDetail[]=commerceAvailable?commerce!.paidSales!.details:[];
	 if(!commerceAvailable)notices.push(commerceReason!);
 // 6. Lignes.
 const rows=new Map<string,AdFunnelRow>();
 const originSource=(origin:AdFunnelOrigin|null):'paid'|'organic'|'unknown'=>{
  const medium=origin?.medium??(origin?.linkId?revisionMedium.get(origin.linkId):null);
  if(origin?.adId||origin?.campaignId||origin?.adsetId||['paid','cpc','ppc','paid_social','paid-search'].includes(medium??''))return 'paid';
  if(['organic','social','email','referral','organic_social','organic_video'].includes(medium??'')||origin?.source)return 'organic';
  return 'unknown';
 };
 const matchingOrigin=(origin:AdFunnelOrigin|null)=>{
  if(sourceFilter!=='all'&&originSource(origin)!==sourceFilter)return false;
  if(campaignFilter.startsWith('link:'))return !!origin?.linkId&&revisionById.get(origin.linkId)?.campaign===campaignFilter.slice(5);
  const ad=origin?.adId?adByExternal.get(origin.adId):undefined;
  if(campaignFilter.startsWith('meta-ad:'))return origin?.adId===campaignFilter.slice(8);
  if(campaignFilter.startsWith('meta:'))return (origin?.campaignId??ad?.campaign_id)===campaignFilter.slice(5);
  if(campaignFilter.startsWith('meta-creative:'))return ad?.creative_id===campaignFilter.slice(14);
  return true;
 };
 const rowFor=(key:string,origin:AdFunnelOrigin|null)=>{
  let row=rows.get(key);
  if(row)return row;
  if(key===UNATTRIBUTED)row=emptyRow(key,'unattributed','Non attribué · aucune origine mesurée');
  else if(key===UNRESOLVED)row=emptyRow(key,'unattributed','Partiel · identité non rapprochée');
  else if(key===PAID_UNATTRIBUTED)row=emptyRow(key,'ad','Origine publicitaire · annonce non identifiée');
  else if(key===ORGANIC)row=emptyRow(key,'organic','Hors publicité · organique ou direct');
	   else{
   const ad=origin?.adId?adByExternal.get(origin.adId):undefined,link=origin?.linkId?revisionById.get(origin.linkId):undefined;
   row=emptyRow(key,'ad',ad?String(ad.ad_name??origin!.adId):origin?.adId?`Publicité ${origin.adId} (hors catalogue Meta)`:origin?.linkId?`Lien · ${link?.label||origin.linkId.slice(0,8)}`:`Campagne ${origin?.campaignId}`);
   const catalogue=(v:unknown)=>v?String(v):null;
	    row.adId=origin?.adId??null;row.campaignId=origin?.campaignId??catalogue(ad?.campaign_id);row.adsetId=origin?.adsetId??catalogue(ad?.adset_id);row.creativeId=catalogue(ad?.creative_id);row.campaignLabel=catalogue(ad?.campaign_name)??(link?link.campaign:null);
	    if(link&&origin?.linkId){row.linkIds.push(origin.linkId);row.links.push(link);}
  }
  row.source=originSource(origin);if(row.source!=='paid')row.kind=row.source==='organic'?'organic':'unattributed';
  rows.set(key,row);return row;
 };
 const addTunnel=(row:AdFunnelRow,tunnel:FunnelTunnel)=>{if(!row.tunnels.includes(tunnel))row.tunnels.push(tunnel);};
 const addLink=(row:AdFunnelRow,linkId:string|null)=>{if(linkId&&!row.linkIds.includes(linkId)){row.linkIds.push(linkId);const r=revisionById.get(linkId);row.links.push(r??{id:linkId,label:linkId.slice(0,8),campaign:''});}};
 const filterTunnel=(tunnel:FunnelTunnel|null)=>filters.tunnel==='all'||(tunnel!==null&&filters.tunnel===tunnel);
 const keyForPerson=(person:string|null)=>{if(!person)return UNRESOLVED;const origin=personOrigin.get(person);return origin?originKey(origin):UNATTRIBUTED;};
 // 6a. Inscriptions de la période, inscrits uniques et leur origine canonique ; index des inscriptions par identifiant de navigateur (cohorte d'opt-in).
	 const registeredPersonsByRow=new Map<string,Set<string>>(),classifiedPersons=new Set<string>();let withFirstTouch=0,withVisitor=0;
 type VisitorRegistration={id:string;day:string;occurredAt:string;tunnel:FunnelTunnel;personId:string|null;linked:boolean};
 const registrationsByVisitor=new Map<string,VisitorRegistration[]>();
 const periodRegistrations:{id:string;key:string;visitor:string|null}[]=[];
 for(const o of requests){
  const tunnel:FunnelTunnel=o.family==='quiz'?'quiz':'masterclass';
  if(o.firstTouch&&originFrom(o.firstTouch,'first_touch').basis!=='none')withFirstTouch++;
  const visitorId=typeof o.origin.visitor==='string'&&UUID.test(o.origin.visitor)?o.origin.visitor.toLowerCase():null;
  if(visitorId){withVisitor++;const list=registrationsByVisitor.get(visitorId)??[];list.push({id:o.id,day:o.occurredDay!,occurredAt:o.occurredAt!,tunnel,personId:o.personId,linked:!!o.personId&&o.identityState==='linked'});registrationsByVisitor.set(visitorId,list);}
  if(!filterTunnel(tunnel)||!inPeriod(o.occurredDay,from,to))continue;
  const own=observationOrigin(o),linked=!!o.personId&&o.identityState==='linked';
  const origin=linked?personOrigin.get(o.personId!)??own:own;
  if(!matchingOrigin(origin))continue;
  const key=!linked?(originKey(own)===UNATTRIBUTED?UNRESOLVED:originKey(own)):originKey(origin);
  const row=rowFor(key,origin.basis==='none'?own:origin);addTunnel(row,tunnel);
  periodRegistrations.push({id:o.id,key,visitor:visitorId});
  row.registrations++;row.registrationsByTunnel[tunnel]++;
  if(origin.basis==='first_touch')row.attributionBasis.firstTouch++;else if(origin.basis==='arrival')row.attributionBasis.arrival++;
  // Only the retained origin belongs to attribution filters. Arrival B must not make A match B's link.
  if(origin.linkId)addLink(row,origin.linkId);
  if(!linked){row.unresolvedIdentity++;continue;}
  const registered=registeredPersonsByRow.get(key)??new Set<string>();registered.add(o.personId!);registeredPersonsByRow.set(key,registered);
	  if(!classifiedPersons.has(o.personId!)){
	   classifiedPersons.add(o.personId!);const first=firstRequest.get(o.personId!),clientDay=earliestClientDay.get(o.personId!);
	   if(first?.id===o.id&&inPeriod(firstKnownDay.get(o.personId!)??null,from,to)&&!(clientDay&&clientDay<firstKnownDay.get(o.personId!)!)){row.uniqueLeads++;row.uniqueLeadsByTunnel[tunnel]++;}else row.knownBefore++;
	  }
 }
 // A first contact recorded only in Notion remains in the global total, without an invented source or tunnel.
 if(filters.tunnel==='all')for(const [person,day] of firstKnownDay){
  if(classifiedPersons.has(person)||!inPeriod(day,from,to)||earliestClientDay.has(person)&&earliestClientDay.get(person)!<day||!testScope.includeTests&&excludedTestPeople.has(person)&&!retainedPeople.has(person))continue;
  // A registration outside this period is not moved into it; only its proven first origin can be reused.
  const origin=personOrigin.get(person)??null;if(matchingOrigin(origin))rowFor(keyForPerson(person),origin).uniqueLeads++;
 }
 // 6b. Rendez-vous : créneau courant Notion par personne ; issue lue dans la classification du prospect ; futurs et inconnus à part.
 let linkedAppointments=0,attendanceFromBusiness=0,appointmentsExcluded=0,bookingDates=0,bookingInstants=0;const bookedPersons=new Set<string>();
 for(const a of appointments){
  const prospect=a.prospect_id?prospectById.get(String(a.prospect_id)):undefined,person=a.person_id?String(a.person_id):prospect?.personId??null;
  if(prospect?.archived||env.NOTION_DATA_SOURCE_ID&&a.source==='notion'&&a.source_namespace!==env.NOTION_DATA_SOURCE_ID)continue;
  if(isExcludedTestTraffic(testScope,prospect?.business,a)||!testScope.includeTests&&person&&excludedTestPeople.has(person)&&!retainedPeople.has(person)){appointmentsExcluded++;continue;}
  const day=appointmentDay(a);
  const booking=appointmentBooking(a,prospect?.business??null);if(booking.day)bookingDates++;if(booking.at)bookingInstants++;
  const outcome=appointmentOutcome(a,prospect?.business??null,day);
  if(prospect?.business&&day&&prospect.business.scheduledDay===day&&outcome!=='unknown')attendanceFromBusiness++;
	  if(person&&isEffectiveAppointment(a,prospect?.business??null))bookedPersons.add(person);
  const origin=person?personOrigin.get(person)??null:null;
  if(!matchingOrigin(origin))continue;
  if(filters.tunnel!=='all'&&(!person||!filterTunnel(personTunnel(person))))continue;
  if(inPeriod(booking.day,from,to))rowFor(keyForPerson(person),origin).appointmentsReserved++;
  if(!inPeriod(day,from,to))continue;
  if(person&&origin)linkedAppointments++;
  const row=rowFor(keyForPerson(person),origin);
	  if(outcome==='cancelled'){row.appointmentsCancelled++;continue;}
	  if(outcome==='rescheduled'){row.appointmentsRescheduled++;continue;}
  row.appointmentsBooked++;
  if(isUpcomingAppointment(a,generatedAt))row.appointmentsUpcoming++;
  else if(outcome==='attended')row.appointmentsAttended++;
  else if(outcome==='no_show')row.appointmentsNoShow++;
  else row.appointmentsUnknown++;
 }
 // “RDV pris” is already defined by the explicit reservation date on a Notion fiche.
 // A fiche without a current appointment row can contribute that date, never an invented slot or attendance.
 const appointmentProspectIds=new Set(appointments.map(a=>String(a.prospect_id??'')));
 const bookingOnly: {person:string|null;day:string}[]=[];
 for(const p of prospects){
  if(p.archived===true||appointmentProspectIds.has(String(p.id))||env.NOTION_DATA_SOURCE_ID&&(p.source!=='notion'||p.source_namespace!==env.NOTION_DATA_SOURCE_ID))continue;
  const business=p.business&&typeof p.business==='object'?p.business as Row:{},dates=business.dates&&typeof business.dates==='object'?business.dates as Row:{};
  const day=businessDay(dates.booked)??businessDay(business.bookedDay),person=p.person_id?String(p.person_id):null;
  if(!day||isExcludedTestTraffic(testScope,business)||!testScope.includeTests&&person&&excludedTestPeople.has(person)&&!retainedPeople.has(person))continue;
  bookingDates++;if(!inPeriod(day,from,to))continue;
  const origin=person?personOrigin.get(person)??null:null;
  if(!matchingOrigin(origin)||filters.tunnel!=='all'&&(!person||!filterTunnel(personTunnel(person))))continue;
  bookingOnly.push({person,day});rowFor(keyForPerson(person),origin).appointmentsReserved++;
 }
 for(const [key,persons] of registeredPersonsByRow){const row=rows.get(key);if(!row)continue;row.uniqueRegistrants=persons.size;for(const p of persons)if(bookedPersons.has(p))row.leadsBooked++;}
 // 6c. Ventes et encaissements de la période, attribués par le Client Notion → personne.
 let clientsLinked=0,clientsUnlinked=0,moneyRowsUnavailable=0,salesExcluded=0;const incompleteMoneyKeys=new Set<string>();
 for(const sale of paidSales){
  if(!inPeriod(sale.day,from,to))continue;
  const client=sale.clientIds.length===1?clientById.get(sale.clientIds[0]):undefined;
  const person=client?.identityState==='linked'?client.personId:null;
  if(!testScope.includeTests&&person&&excludedTestPeople.has(person)&&!retainedPeople.has(person)){salesExcluded++;continue;}
  if(person)clientsLinked++;else clientsUnlinked++;
  const origin=person?personOrigin.get(person)??null:null;
  if(!matchingOrigin(origin))continue;
  if(filters.tunnel!=='all'&&(!person||!filterTunnel(personTunnel(person))))continue;
	  const row=rowFor(keyForPerson(person),origin),key=row.key;
	  const refunded=sale.reasons.includes('payment_refunded'),paid=!sale.reasons.includes('payment_not_succeeded_or_amount_missing');
	  if(sale.amountMinor===null){moneyRowsUnavailable++;incompleteMoneyKeys.add(key);continue;}
	  row.firstSalesConfirmed??=0;row.firstSalesReconciled??=0;row.firstSalesPending??=0;row.cashMinor??=0;row.refundsMinor??=0;
	  if(refunded){row.refundsMinor+=sale.amountMinor;continue;}
	  if(!paid)continue;
	  row.cashMinor+=sale.amountMinor;
  if(sale.state==='confirmed')row.firstSalesConfirmed++;else if(sale.state==='reconciled')row.firstSalesReconciled++;else if(sale.state==='pending')row.firstSalesPending++;
 }
	 // 6d. Visiteurs et pages vues (PostHog) par origine, si fournis ; même clé et même règle A que les inscriptions.
 const visits=options.visits??null;
 if(visits?.available){
  const tunnelsWanted:FunnelTunnel[]=filters.tunnel==='all'?['quiz','masterclass']:[filters.tunnel];
  const apply=(row:AdFunnelRow,counts:{quiz:VisitCounts;masterclass:VisitCounts})=>{row.visitorsWithFirstOrigin=0;for(const t of tunnelsWanted){row.visitors[t]=counts[t].visitors;row.pageviews[t]=counts[t].pageviews;row.visitorsWithFirstOrigin+=counts[t].withFirstOrigin;}};
  for(const row of rows.values()){const counts=visits.byKey.get(row.key);if(counts)apply(row,counts);else{for(const t of tunnelsWanted){row.visitors[t]=0;row.pageviews[t]=0;}row.visitorsWithFirstOrigin=0;}}
  for(const [key,counts] of visits.byKey){
   if(rows.has(key)||!tunnelsWanted.some(t=>counts[t].visitors>0||counts[t].pageviews>0))continue;
   apply(rowFor(key,keyOrigin(key)),counts);
  }
  if(visits.legacyMasterclassViews)notices.push(`${visits.legacyMasterclassViews} vue${visits.legacyMasterclassViews>1?'s':''} de la masterclass sans adresse de page mesurée sur la période : version publiée antérieure, non comptée dans les visiteurs de la page active.`);
 }else notices.push(visits?.reason??'Visites par publicité non lues (PostHog). Les clics sortants Meta ne sont pas des visites.');
	 // 6e. Opt-in par cohorte d'entrée : visiteurs raccordables entrés dans la période, suivis jusqu'à la lecture ; inscription postérieure ou égale à l'instant exact de première visite.
 const cohort=options.cohort??null;let registrationsInCohort=0,visitorsLinkable=0,visitorsUnlinkable=0;
 const matchedRegistrations=new Set<string>();
	 const knownBeforeInstant=(person:string,instant:string,day:string)=>{const first=firstRequest.get(person),client=earliestClientDay.get(person),known=firstKnownDay.get(person);return !!(first?.occurredAt&&first.occurredAt<instant)||!!(client&&client<day)||!!(known&&known<day);};
 if(cohort?.available){
  const tunnelsWanted:FunnelTunnel[]=filters.tunnel==='all'?['quiz','masterclass']:[filters.tunnel];
  const ensure=(row:AdFunnelRow)=>{for(const t of tunnelsWanted)row.optin[t]??={visitors:0,registered:0};row.optin.all??={visitors:0,registered:0,newLeads:0,knownPeople:0,unresolvedIdentity:0};row.optin.unlinkableVisitors??={quiz:0,masterclass:0};return row;};
  const overall=new Map<string,{key:string;firstSeen:string;firstDay:string;tunnel:FunnelTunnel}>();
  for(const v of cohort.visitors){
   if(!tunnelsWanted.includes(v.tunnel))continue;
   const row=ensure(rowFor(v.key,keyOrigin(v.key)));
   const same=(registrationsByVisitor.get(v.id)??[]).filter(r=>r.occurredAt>=v.firstSeen&&r.tunnel===v.tunnel);
   row.optin[v.tunnel]!.visitors++;
   if(same.length){row.optin[v.tunnel]!.registered++;for(const r of same)matchedRegistrations.add(r.id);}
   const prior=overall.get(v.id);
   if(!prior||v.firstSeen<prior.firstSeen||(v.firstSeen===prior.firstSeen&&v.tunnel==='quiz'&&prior.tunnel!=='quiz'))overall.set(v.id,{key:v.key,firstSeen:v.firstSeen,firstDay:v.firstDay,tunnel:v.tunnel});
  }
  visitorsLinkable=overall.size;
  for(const [id,entry] of overall){
   const row=ensure(rowFor(entry.key,keyOrigin(entry.key)));
   const any=(registrationsByVisitor.get(id)??[]).filter(r=>r.occurredAt>=entry.firstSeen).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id));
   row.optin.all!.visitors++;
   if(!any.length)continue;
   row.optin.all!.registered++;for(const r of any)matchedRegistrations.add(r.id);
	   const linkedPeople=new Set(any.filter(r=>r.linked&&r.personId).map(r=>r.personId!));
	   if(any.some(r=>!r.linked||!r.personId)||linkedPeople.size!==1)row.optin.all!.unresolvedIdentity++;
	   else{const person=[...linkedPeople][0];if(knownBeforeInstant(person,entry.firstSeen,entry.firstDay))row.optin.all!.knownPeople++;else row.optin.all!.newLeads++;}
  }
  for(const [key,counts] of cohort.unlinkable){
   const wanted={quiz:tunnelsWanted.includes('quiz')?counts.quiz:0,masterclass:tunnelsWanted.includes('masterclass')?counts.masterclass:0};
   if(!wanted.quiz&&!wanted.masterclass)continue;
   const row=ensure(rowFor(key,keyOrigin(key)));row.optin.unlinkableVisitors={quiz:row.optin.unlinkableVisitors!.quiz+wanted.quiz,masterclass:row.optin.unlinkableVisitors!.masterclass+wanted.masterclass};visitorsUnlinkable+=wanted.quiz+wanted.masterclass;
  }
  for(const row of rows.values())ensure(row);
	 }else notices.push(cohort?.reason??'Visiteurs entrés dans la période non lus (PostHog) : pourcentage d’opt-in indisponible.');
	 for(const r of periodRegistrations){const row=rows.get(r.key);if(!row)continue;if(!r.visitor)row.optin.registrationsWithoutVisitor++;else if(matchedRegistrations.has(r.id))registrationsInCohort++;else row.optin.registrationsOutsideCohort++;}
	 // 6f. Dépenses Meta après les visites/cohortes : un filtre tunnel conserve la dépense d'une publicité dont l'activité n'existe que dans PostHog.
 const incompleteMeta=new Map<string,Set<'spendMinor'|'impressions'|'outboundClicks'>>();
	 for(const d of adDaily){
   if(campaignFilter.startsWith('link:'))continue; // An ad's total cost cannot be allocated to one link from its registrations.
	  const external=adUuidToExternal.get(String(d.ad_id));if(!external)continue;
	  const key='ad:'+external;
	  if(!rows.has(key)&&filters.tunnel!=='all')continue;
	  const row=rowFor(key,{adId:external,campaignId:null,adsetId:null,linkId:null,source:null,basis:'none'});
  for(const [field,column] of [['spendMinor','spend_minor'],['impressions','impressions'],['outboundClicks','outbound_clicks']] as const){
   const compatible=d.currency==='EUR'&&Number(d.currency_exponent)===2&&d.timezone==='Europe/Paris';
   const value=compatible?d[column]:null;
   if(value===null||value===undefined||!Number.isFinite(Number(value))){const missing=incompleteMeta.get(key)??new Set();missing.add(field);incompleteMeta.set(key,missing);}
   else row[field]=(row[field]??0)+Number(value);
  }
	 }
 // Catalogue sans activité : présence connue, mesures absentes conservées à null.
 // Sans inscription/visite, aucun tunnel n’est déduit du nom de la campagne.
 if(filters.tunnel==='all')for(const ad of ads)rowFor('ad:'+String(ad.external_id),{adId:String(ad.external_id),campaignId:null,adsetId:null,linkId:null,source:null,basis:'none'});
	 for(const row of rows.values()){
  for(const field of incompleteMeta.get(row.key)??[])row[field]=null;
	  if(commerceAvailable){row.firstSalesConfirmed??=0;row.firstSalesReconciled??=0;row.firstSalesPending??=0;row.cashMinor??=0;row.refundsMinor??=0;}
	  if(incompleteMoneyKeys.has(row.key)){row.cashMinor=null;row.refundsMinor=null;}
	 }
 const publishedRuns=completedRuns;
 const expectedFamilies=filters.tunnel==='quiz'?['quiz']:filters.tunnel==='masterclass'?['forms']:entryConfig?[...(entryConfig.formIds.length?['forms']:[]),...(entryConfig.quiz?['quiz']:[])]:['forms','quiz'];
 const familyReady=(family:string)=>observations.some(o=>o.family===family)||publishedRuns.some(r=>r.source==='wix'&&(!siteId||r.source_namespace===siteId)&&r.stream_key==='lead_entries_'+family);
 const leadAvailable=entryConfig?expectedFamilies.length>0&&expectedFamilies.every(familyReady):expectedFamilies.some(familyReady);
 const appointmentRun=publishedRuns.filter(r=>r.source==='notion'&&r.stream_key==='prospects_business'&&(!env.NOTION_DATA_SOURCE_ID||r.source_namespace===env.NOTION_DATA_SOURCE_ID)).sort((a,b)=>String(b.finished_at??b.started_at).localeCompare(String(a.finished_at??a.started_at)))[0];
 const appointmentObservedAt=appointmentRun?String(appointmentRun.finished_at??appointmentRun.source_as_of??appointmentRun.started_at):appointments.map(a=>typeof a.observed_at==='string'?a.observed_at:null).filter((v):v is string=>!!v).sort().at(-1)??null;
 const periodEnd=Temporal.PlainDate.from(to).add({days:1}).toZonedDateTime('Europe/Paris').toInstant().toString();
 // A requested window may end tomorrow. Its end or publication time never proves a read after the scan began.
 const readCutoff=(run:Row|undefined):number|null=>{
  if(!run||!Number.isFinite(Date.parse(String(run.started_at??''))))return null;
  const bounds=[run.started_at,run.finished_at,run.covered_to,run.period_to,run.source_as_of].map(value=>Date.parse(String(value??''))).filter(Number.isFinite);
  return bounds.length?Math.min(...bounds):null;
 };
 const appointmentCutoff=readCutoff(appointmentRun);
 const requiredCutoff=Date.parse(periodEnd)<Date.parse(generatedAt)?Date.parse(periodEnd):Date.parse(generatedAt)-3600000;
 const leadsComplete=expectedFamilies.every(family=>publishedRuns.filter(r=>r.source==='wix'&&(!siteId||r.source_namespace===siteId)&&r.stream_key==='lead_entries_'+family).some(run=>{const cutoff=readCutoff(run);return cutoff!==null&&cutoff>=requiredCutoff;}));
 const appointmentsAvailable=appointmentCutoff!==null&&appointmentCutoff>=requiredCutoff;
 const appointmentReason=appointmentsAvailable?null:appointmentObservedAt?'La copie des rendez-vous ne couvre pas encore cette période ; les valeurs connues restent partielles.':'La fraîcheur du miroir des rendez-vous n’est pas établie.';
 if(appointmentReason)notices.push(appointmentReason);
 if(leadAvailable&&!leadsComplete)notices.push('Les inscriptions connues restent affichées ; la couverture de toute la période n’est pas encore établie.');
 // 7. Filtres source/campagne, pourcentages, tri et totaux.
 const visible=[...rows.values()].filter(r=>matchesFilters(r,sourceFilter,campaignFilter));
 const sumTunnel=(c:TunnelCounts)=>c.quiz===null&&c.masterclass===null?null:(c.quiz??0)+(c.masterclass??0);
 const optinCounts=(r:AdFunnelRow|AdFunnelTotals):OptinCounts|null=>filters.tunnel==='all'?r.optin.all:r.optin[filters.tunnel];
 const withRates=(r:AdFunnelRow|AdFunnelTotals)=>{
  const counts=optinCounts(r);
  r.rates={optin:!cohort?.available?rate(null,null,cohort?.reason??RATE_REASONS.cohort):counts?rate(counts.registered,counts.visitors,RATE_REASONS.optin):rate(0,0,RATE_REASONS.optin),booking:appointmentsAvailable?rate(r.leadsBooked,r.uniqueRegistrants,RATE_REASONS.booking):rate(null,r.uniqueRegistrants,appointmentReason!),attendance:appointmentsAvailable?rate(r.appointmentsAttended,r.appointmentsAttended+r.appointmentsNoShow,RATE_REASONS.attendance):rate(null,r.appointmentsAttended+r.appointmentsNoShow,appointmentReason!)};
 };
 for(const r of visible)withRates(r);
 const ordered=visible.sort((a,b)=>(a.kind==='ad'?0:a.kind==='organic'?1:2)-(b.kind==='ad'?0:b.kind==='organic'?1:2)||(b.spendMinor??-1)-(a.spendMinor??-1)||b.registrations-a.registrations||a.label.localeCompare(b.label));
	 const totals=emptyRow('total','ad','Total');
	 if(commerceAvailable){totals.firstSalesConfirmed=0;totals.firstSalesReconciled=0;totals.firstSalesPending=0;totals.cashMinor=0;totals.refundsMinor=0;}
	 const addNullable=(a:number|null,b:number|null)=>b===null?a:(a??0)+b;
	 const addComplete=(a:number|null,b:number|null)=>a===null||b===null?null:a+b;
 const addOptin=(t:OptinDetail,r:OptinDetail)=>{
  for(const k of ['quiz','masterclass'] as const)if(r[k]){t[k]={visitors:(t[k]?.visitors??0)+r[k]!.visitors,registered:(t[k]?.registered??0)+r[k]!.registered};}
  if(r.all)t.all={visitors:(t.all?.visitors??0)+r.all.visitors,registered:(t.all?.registered??0)+r.all.registered,newLeads:(t.all?.newLeads??0)+r.all.newLeads,knownPeople:(t.all?.knownPeople??0)+r.all.knownPeople,unresolvedIdentity:(t.all?.unresolvedIdentity??0)+r.all.unresolvedIdentity};
  if(r.unlinkableVisitors)t.unlinkableVisitors={quiz:(t.unlinkableVisitors?.quiz??0)+r.unlinkableVisitors.quiz,masterclass:(t.unlinkableVisitors?.masterclass??0)+r.unlinkableVisitors.masterclass};
  t.registrationsWithoutVisitor+=r.registrationsWithoutVisitor;t.registrationsOutsideCohort+=r.registrationsOutsideCohort;
 };
 for(const r of ordered){
  addOptin(totals.optin,r.optin);
  totals.registrations+=r.registrations;totals.registrationsByTunnel.quiz+=r.registrationsByTunnel.quiz;totals.registrationsByTunnel.masterclass+=r.registrationsByTunnel.masterclass;totals.uniqueRegistrants+=r.uniqueRegistrants;totals.uniqueLeads+=r.uniqueLeads;totals.uniqueLeadsByTunnel.quiz+=r.uniqueLeadsByTunnel.quiz;totals.uniqueLeadsByTunnel.masterclass+=r.uniqueLeadsByTunnel.masterclass;totals.knownBefore+=r.knownBefore;totals.unresolvedIdentity+=r.unresolvedIdentity;totals.leadsBooked+=r.leadsBooked;
	  totals.appointmentsReserved+=r.appointmentsReserved;totals.appointmentsBooked+=r.appointmentsBooked;totals.appointmentsAttended+=r.appointmentsAttended;totals.appointmentsNoShow+=r.appointmentsNoShow;totals.appointmentsCancelled+=r.appointmentsCancelled;totals.appointmentsRescheduled+=r.appointmentsRescheduled;totals.appointmentsUpcoming+=r.appointmentsUpcoming;totals.appointmentsUnknown+=r.appointmentsUnknown;
	  totals.firstSalesConfirmed=addComplete(totals.firstSalesConfirmed,r.firstSalesConfirmed);totals.firstSalesReconciled=addComplete(totals.firstSalesReconciled,r.firstSalesReconciled);totals.firstSalesPending=addComplete(totals.firstSalesPending,r.firstSalesPending);totals.cashMinor=addComplete(totals.cashMinor,r.cashMinor);totals.refundsMinor=addComplete(totals.refundsMinor,r.refundsMinor);totals.attributionBasis.firstTouch+=r.attributionBasis.firstTouch;totals.attributionBasis.arrival+=r.attributionBasis.arrival;
  totals.spendMinor=addNullable(totals.spendMinor,r.spendMinor);totals.impressions=addNullable(totals.impressions,r.impressions);totals.outboundClicks=addNullable(totals.outboundClicks,r.outboundClicks);
  for(const t of ['quiz','masterclass'] as const){totals.visitors[t]=addNullable(totals.visitors[t],r.visitors[t]);totals.pageviews[t]=addNullable(totals.pageviews[t],r.pageviews[t]);}
  totals.visitorsWithFirstOrigin=addNullable(totals.visitorsWithFirstOrigin,r.visitorsWithFirstOrigin);
 }
 for(const field of ['spendMinor','impressions','outboundClicks'] as const)if(ordered.some(row=>incompleteMeta.get(row.key)?.has(field)))totals[field]=null;
 if(ordered.some(row=>incompleteMeta.has(row.key)))notices.push('Certaines mesures Meta sont absentes : les colonnes concernées restent indisponibles, y compris dans le total.');
 withRates(totals);
 const {key:_k,kind:_kind,source:_source,label:_l,campaignLabel:_c,adId:_a,campaignId:_ci,adsetId:_as,creativeId:_cr,linkIds:_li,links:_ln,tunnels:_t,...totalsOnly}=totals;
 const leadObservedAt=observations.filter(o=>o.family==='forms'||o.family==='quiz').reduce<string|null>((max,o)=>o.publishedAt&&(!max||o.publishedAt>max)?o.publishedAt:max,null);
 if(!requests.length)notices.push('Aucune inscription publiée : lancer la lecture Wix (formulaires et quiz) avant de lire ce tableau.');
 if(!metaLastDay)notices.push('Aucune dépense Meta publiée sur cette période : dépenses et clics restent indisponibles, pas nuls.');
 if(requests.length&&!withFirstTouch)notices.push('Aucune inscription ne porte encore de première origine mesurée : le crédit suit l’arrivée de l’inscription tant que les pages mises à jour ne sont pas installées.');
 if(cohort?.available&&!visitorsLinkable&&visitorsUnlinkable)notices.push(`${visitorsUnlinkable} visiteur${visitorsUnlinkable>1?'s':''} mesuré${visitorsUnlinkable>1?'s':''} sans identifiant de navigateur sur la période : pourcentage d’opt-in indisponible tant que les pages mises à jour ne sont pas installées.`);
 // The legacy Results table also shows registered links. A link and an ad may describe the same people;
 // these supplemental detail rows never enter the additive advertising totals.
 const linkDetails=new Map<string,AdFunnelRow>(),linkPeople=new Map<string,Set<string>>(),linkClassified=new Set<string>();
 const linkRow=(id:string)=>{
  let row=linkDetails.get(id);if(row)return row;
  const link=revisionById.get(id);if(!link)return null;
  row=emptyRow('link:'+id,'unattributed',link.label||'Lien identifié');row.linkIds=[id];row.links=[link];row.campaignLabel=link.campaign;
  row.source=originSource({adId:null,campaignId:null,adsetId:null,linkId:id,source:null,basis:'none'});
  row.kind=row.source==='paid'?'ad':row.source==='organic'?'organic':'unattributed';linkDetails.set(id,row);return row;
 };
 for(const revision of revisions){
  const origin={adId:null,campaignId:null,adsetId:null,linkId:String(revision.id),source:null,basis:'none' as const};
  if((filters.tunnel==='all'||revision.tunnel===filters.tunnel)&&matchingOrigin(origin))linkRow(String(revision.id));
 }
 for(const o of requests){
  const tunnel:FunnelTunnel=o.family==='quiz'?'quiz':'masterclass';if(!filterTunnel(tunnel)||!inPeriod(o.occurredDay,from,to))continue;
  const linked=!!o.personId&&o.identityState==='linked',origin=linked?personOrigin.get(o.personId!)??observationOrigin(o):observationOrigin(o);
  if(!origin.linkId||!matchingOrigin(origin))continue;const row=linkRow(origin.linkId);if(!row)continue;
  row.registrations++;row.registrationsByTunnel[tunnel]++;
  if(!linked){row.unresolvedIdentity++;continue;}
  const people=linkPeople.get(origin.linkId)??new Set<string>();people.add(o.personId!);linkPeople.set(origin.linkId,people);
  if(linkClassified.has(o.personId!))continue;linkClassified.add(o.personId!);
  const day=firstKnownDay.get(o.personId!),client=earliestClientDay.get(o.personId!);
  if(firstRequest.get(o.personId!)?.id===o.id&&inPeriod(day??null,from,to)&&!(client&&client<day!)){row.uniqueLeads++;row.uniqueLeadsByTunnel[tunnel]++;}else row.knownBefore++;
 }
 for(const [id,people] of linkPeople)linkDetails.get(id)!.uniqueRegistrants=people.size;
 if(filters.tunnel==='all')for(const [person,day] of firstKnownDay){
  if(linkClassified.has(person)||!inPeriod(day,from,to)||earliestClientDay.has(person)&&earliestClientDay.get(person)!<day||!testScope.includeTests&&excludedTestPeople.has(person)&&!retainedPeople.has(person))continue;
  const origin=personOrigin.get(person);if(origin?.linkId&&matchingOrigin(origin)){const row=linkRow(origin.linkId);if(row)row.uniqueLeads++;}
 }
 for(const a of appointments){
  const prospect=a.prospect_id?prospectById.get(String(a.prospect_id)):undefined,person=a.person_id?String(a.person_id):prospect?.personId??null,origin=person?personOrigin.get(person):undefined;
  if(prospect?.archived||env.NOTION_DATA_SOURCE_ID&&a.source==='notion'&&a.source_namespace!==env.NOTION_DATA_SOURCE_ID||!origin?.linkId||!matchingOrigin(origin)||filters.tunnel!=='all'&&(!person||!filterTunnel(personTunnel(person))))continue;
  if(isExcludedTestTraffic(testScope,prospect?.business,a)||!testScope.includeTests&&person&&excludedTestPeople.has(person)&&!retainedPeople.has(person))continue;
  const row=linkRow(origin.linkId);if(!row)continue;const booking=appointmentBooking(a,prospect?.business??null),day=appointmentDay(a),outcome=appointmentOutcome(a,prospect?.business??null,day);
  if(inPeriod(booking.day,from,to))row.appointmentsReserved++;
  if(!inPeriod(day,from,to))continue;
  if(outcome==='cancelled')row.appointmentsCancelled++;else if(outcome==='rescheduled')row.appointmentsRescheduled++;
  else{row.appointmentsBooked++;if(isUpcomingAppointment(a,generatedAt))row.appointmentsUpcoming++;else if(outcome==='attended')row.appointmentsAttended++;else if(outcome==='no_show')row.appointmentsNoShow++;else row.appointmentsUnknown++;}
 }
 for(const booking of bookingOnly){const origin=booking.person?personOrigin.get(booking.person):undefined;if(origin?.linkId){const row=linkRow(origin.linkId);if(row)row.appointmentsReserved++;}}
 const measuredAds=[...new Set(observations.map(observationOrigin).map(o=>o.adId).filter((id):id is string=>!!id))].filter(id=>!adByExternal.has(id)).map(id=>({id:'meta-ad:'+id,label:'Publicité · '+id+' (hors catalogue Meta)'}));
 const campaigns=[...new Map([...measuredAds,...ads.flatMap(ad=>[{id:'meta-ad:'+ad.external_id,label:'Publicité · '+(ad.ad_name??ad.external_id)},...(ad.campaign_id?[{id:'meta:'+ad.campaign_id,label:'Meta · '+(ad.campaign_name??ad.campaign_id)}]:[]),...(ad.creative_id?[{id:'meta-creative:'+ad.creative_id,label:'Créative · '+ad.creative_id}]:[])]),...revisions.map(r=>({id:'link:'+r.campaign,label:'Liens · '+r.campaign}))].map(option=>[option.id,option])).values()];
 return {
  campaigns,linkDetails:[...linkDetails.values()],available:leadAvailable,period:{from,to,timezone:'Europe/Paris'},generatedAt,filters:{tunnel:filters.tunnel,source:sourceFilter,campaign:campaignFilter,includeTests:testScope.includeTests},rows:ordered,totals:totalsOnly,
  coverage:{
   leads:{available:leadAvailable,complete:leadsComplete,observedAt:leadObservedAt,families:[...new Set(requests.map(o=>o.family))],rows:requests.length,withFirstTouch,withVisitor},
   meta:{lastDay:metaLastDay,ads:ads.length,adsWithoutCreative:ads.filter(a=>!a.creative_id).length},
   appointments:{rows:appointments.length,linkedPeople:linkedAppointments,attendanceFromBusiness,observedAt:appointmentObservedAt,available:appointmentsAvailable,reason:appointmentReason,bookingDates,bookingInstants},
	   commerce:{available:commerceAvailable,reason:commerceReason,observedAt:commerceAvailable?commerce!.observedAt:null,paidSaleRows:commerceAvailable?paidSales.length:null,clientsLinked:commerceAvailable?clientsLinked:null,clientsUnlinked:commerceAvailable?clientsUnlinked:null,moneyRowsUnavailable:commerceAvailable?moneyRowsUnavailable:null},
   visits:{available:!!visits?.available,reason:visits?.reason??null,observedAt:visits?.observedAt??null,legacyMasterclassViews:visits?.legacyMasterclassViews??null},
   optin:{available:!!cohort?.available,reason:cohort?.available?null:cohort?.reason??RATE_REASONS.cohort,observedAt:cohort?.available?generatedAt:null,entryPeriod:{from,to},visitorsLinkable:cohort?.available?visitorsLinkable:null,visitorsUnlinkable:cohort?.available?visitorsUnlinkable:null,registrationsInCohort,registrationsWithoutVisitor:totalsOnly.optin.registrationsWithoutVisitor,registrationsOutsideCohort:totalsOnly.optin.registrationsOutsideCohort},
   testing:{includeTests:testScope.includeTests,registrationsExcluded:excludedTestRequests.length,appointmentsExcluded,salesExcluded,visitsScoped:visits?.scope?.includeTests===testScope.includeTests,cohortScoped:cohort?.scope?.includeTests===testScope.includeTests},
  },
  definitions:{
   attribution:'Une personne garde sa première origine mesurée (première origine publicitaire enregistrée, même avant l’inscription). Sans mémoire, l’arrivée de la première inscription fait foi.',
   visitors:'Visiteurs uniques mesurés sur les pages du quiz et sur la page masterclass active (/masterclass26), datés de la visite, rattachés à leur première origine quand elle est mesurée.',
   registrations:'Inscriptions confirmées (formulaire ou quiz) datées dans la période, y compris répétées.',
   uniqueLeads:'Personnes dont le premier contact connu (inscription ou date métier Notion) tombe dans la période, sans antériorité Client. Une personne déjà connue ne redevient pas un lead.',
   optin:'Visiteurs mesurés (identifiant de navigateur) dont la première visite tombe dans la période, devenus inscrits ensuite sur le même tunnel (total : sur l’un des deux, un visiteur compte une fois), à toute date jusqu’à la lecture ; crédités à leur première origine. Visiteurs sans identifiant et inscriptions sans visite raccordable comptés à part.',
   booking:'Inscrits uniques de la période ayant un rendez-vous effectif (créneau Notion non annulé), quelle que soit sa date ÷ inscrits uniques.',
   appointments:'Créneau courant du prospect Notion daté dans la période ; présence et absence selon la classification Notion ; un clic calendrier ne vaut pas réservation.',
   attendance:'Rendez-vous passés à issue connue : présents ÷ (présents + absents). Les rendez-vous à venir et sans issue renseignée restent à part.',
   sales:'Première vente payée classée par le relevé Notion-commerce (confirmée, rapprochée, en attente), datée du paiement ; trois mensualités = une vente.',
   cash:'Somme des paiements réussis datés dans la période, remboursements à part ; toujours lu par date de paiement.',
   spend:'Dépenses, impressions et clics sortants Meta par publicité ; une publicité à plusieurs assets reste une ligne, jamais une vidéo précise.',
   testing:'Par défaut, seules les données portant un marqueur de recette explicite sont exclues : source=test, medium=recette, campagne test-mehdi… ou is_test. Les autres données restent incluses.',
  },
  notices,
 };
}
