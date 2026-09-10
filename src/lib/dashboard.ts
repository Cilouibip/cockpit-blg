import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { allRows, type Database, type Row } from './db';
import { AppError } from './errors';
import type { DashboardResponse, Metric, DataMode, DashboardFilters, JourneyStep } from './ui-contract';
import { parisPeriod, inPeriod } from '../domain/dates';
import { watchedSeconds, type WatchedInterval } from '../domain/video';
import {applyDashboardRollup,type DashboardRollup} from './dashboard-rollup';
import type {DetailsResponse} from './ui-contract';
import { readWixReportedPeriod } from './sync-wix';
import { applyStoredBusiness } from './business-dashboard';
import { readPostHogPeriod, applyPostHogQuiz, postHogScopeFromFilters, readPostHogMasterclassPeriod, applyPostHogMasterclass } from './posthog-dashboard';
export function parseFilters(url:URL):DashboardFilters {
 const today=Temporal.Now.plainDateISO('Europe/Paris');
 const from=url.searchParams.get('from')||today.with({day:1}).toString(),to=url.searchParams.get('to')||today.toString();
 try{const a=Temporal.PlainDate.from(from),b=Temporal.PlainDate.from(to);if(a.until(b).days<0||a.until(b).days>366)throw 0;}catch{throw new AppError('Choisis une période valide de 367 jours maximum.',400,'invalid_period');}
 return {from,to,source:z.enum(['all','paid','organic','unknown']).parse(url.searchParams.get('source')||'all'),tunnel:z.enum(['all','quiz','masterclass']).parse(url.searchParams.get('tunnel')||'all'),campaign:(url.searchParams.get('campaign')||'').slice(0,150),compare:url.searchParams.get('compare')==='true'};
}
type Dataset={leads:Row[];events:Row[];payments:Row[];appointments:Row[];deals:Row[];ads:Row[];revisions:Row[];runs:Row[];aggregates:Row[];adCatalog?:Row[];attributionRuns?:Row[];attributionResults?:Row[]};
const time=(v:unknown)=>v instanceof Date?v.toISOString():String(v);
const parisDay=(v:unknown)=>Temporal.Instant.from(time(v)).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
const sum=(rows:Row[],key:string)=>rows.reduce((n,r)=>n+Number(r[key]||0),0);
function traffic(revision:Row|undefined){return !revision?'unknown':revision.medium==='paid_social'?'paid':['organic_social','organic_video','email'].includes(String(revision.medium))?'organic':'unknown';}
function metric(id:string,label:string,value:number|null,unit:Metric['unit'],source:string,definition:string,coverage:string,updatedAt:string|null,reason?:string):Metric{return {id,label,value,unit,source,definition,coverage,updatedAt,...(value===null?{unavailableReason:reason||'Données ou couverture non disponibles.'}:{})};}
export function buildDashboard(data:Dataset,filters:DashboardFilters,mode:DataMode):DashboardResponse {
 const period=parisPeriod(filters.from,Temporal.PlainDate.from(filters.to).add({days:1}).toString());
 const within=(v:unknown)=>!!v&&inPeriod(time(v),period);
 const rev=(id:unknown)=>data.revisions.find(r=>r.id===id);
 const linkScope=(r:Row)=> (filters.tunnel==='all'||r.tunnel===filters.tunnel)&&(filters.source==='all'||traffic(rev(r.link_revision_id))===filters.source)&&(!filters.campaign||filters.campaign==='all'||filters.campaign===`link:${rev(r.link_revision_id)?.campaign}`);
 const hasCampaign=!!filters.campaign&&filters.campaign!=='all'; const financialFilter=filters.source!=='all'||filters.tunnel!=='all'||hasCampaign;
 const leads=data.leads.filter(r=>within(r.registered_at)&&linkScope(r));
 const resolved=leads.filter(r=>r.person_id!==null);const unique=new Set(resolved.map(r=>r.person_id)).size;const unresolved=leads.length-resolved.length;
 const completeDemo=mode==='demo';
 const metaScoped=/^meta(?:-ad|-creative)?:/.test(filters.campaign);
 const leadAssignable=!hasCampaign||!metaScoped;
 const leadValue=!leadAssignable?null:leads.length&&unresolved===0?unique:completeDemo&&!unresolved?0:null;
 const events=data.events.filter(r=>within(r.occurred_at)&&linkScope(r));
 const appointments=data.appointments.filter(r=>within(r.scheduled_at)&&r.identity_basis==='stable_booking');
 const attended=appointments.filter(r=>r.status==='attended'&&r.attended_at&&r.attendance_evidence);
 const noShow=appointments.filter(r=>r.status==='no_show');
 const apptValue=financialFilter?null:appointments.length||completeDemo?attended.length:null;
 const adCatalog=(r:Row)=>data.adCatalog?.find(ad=>ad.id===r.ad_id);
 const ads=data.ads.filter(r=>String(r.date).slice(0,10)>=filters.from&&String(r.date).slice(0,10)<=filters.to&&(!hasCampaign||filters.campaign===`meta:${r.campaign_id}`||filters.campaign===`meta-ad:${adCatalog(r)?.external_id}`||filters.campaign===`meta-creative:${adCatalog(r)?.creative_id}`));
 const spendScope=filters.tunnel==='all'&&['all','paid'].includes(filters.source)&&(!hasCampaign||metaScoped);
 const compatibleAds=ads.filter(r=>r.currency==='EUR'&&r.timezone==='Europe/Paris');
 const adReady=spendScope&&ads.length>0&&compatibleAds.length===ads.length&&ads.every(r=>r.spend_minor!==null);
 const spend=adReady?sum(ads,'spend_minor')/100:null;
 const payments=data.payments.filter(r=>within(r.effective_at)&&r.status==='settled');
 const authorities=new Set(payments.map(r=>`${r.source}:${r.source_namespace}`));
 const exactCash=payments.length>0&&authorities.size===1&&payments.every(r=>r.currency==='EUR'&&Number(r.currency_exponent)===2&&r.tax_basis==='tax_inclusive'&&r.reconciliation_state==='reconciled');
 const financialNamespace=authorities.size===1?[...authorities][0]:null;
 const cashRun=data.runs.filter(r=>`${r.source}:${r.source_namespace}`===financialNamespace&&r.stream_key==='payments_and_refunds'&&r.status==='complete'&&r.pagination_complete&&time(r.period_from)<=period.from&&time(r.period_to)>=period.to).sort((a,b)=>time(b.source_as_of).localeCompare(time(a.source_as_of)))[0];
 const gross=payments.filter(r=>r.kind==='receipt').reduce((n,r)=>n+Number(r.gross_minor),0)/100;
 const refunds=payments.filter(r=>r.kind==='refund').reduce((n,r)=>n+Number(r.gross_minor),0)/100;
 const reversals=payments.filter(r=>r.kind==='reversal').reduce((n,r)=>n+Number(r.gross_minor)*Number(r.reversal_direction),0)/100;
 const aggregateCandidates=data.aggregates.filter(r=>r.metric_key==='net_cash'&&r.definition_version==='net-ttc-v1'&&r.currency==='EUR'&&Number(r.currency_exponent)===2&&r.unit==='minor'&&r.timezone==='Europe/Paris'&&r.tax_basis==='tax_inclusive'&&r.coverage_state==='complete'&&time(r.period_from)===period.from&&time(r.period_to)===period.to&&r.dimensions_key==='all'&&data.runs.some(run=>run.id===r.sync_run_id&&run.source===r.source&&run.source_namespace===r.source_namespace&&run.status==='complete'&&run.pagination_complete));
 const aggregateAuthorities=new Set(aggregateCandidates.map(r=>`${r.source}:${r.source_namespace}:${r.report_profile_key}`));
 const latestAggregate=aggregateAuthorities.size===1?aggregateCandidates.sort((a,b)=>time(data.runs.find(r=>r.id===b.sync_run_id)?.source_as_of).localeCompare(time(data.runs.find(r=>r.id===a.sync_run_id)?.source_as_of)))[0]:undefined;
 const ambiguousAggregate=latestAggregate&&aggregateCandidates.filter(r=>r.sync_run_id===latestAggregate.sync_run_id).length>1;
 const exactAggregate=ambiguousAggregate?undefined:latestAggregate;
 const usingTransactions=!financialFilter&&exactCash&&(!!cashRun||completeDemo);
 const usingAggregate=!financialFilter&&!usingTransactions&&!!exactAggregate;
 const revenue=financialFilter?null:usingTransactions?gross-refunds+reversals:usingAggregate?Number(exactAggregate!.value)/100:null;
 const latestSource=(source:string)=>data.runs.filter(r=>r.source===source&&['complete','empty'].includes(String(r.status))&&r.finished_at).map(r=>time(r.finished_at)).sort().at(-1)||null;
 const observedAt=usingTransactions?(cashRun?time(cashRun.finished_at):mode==='demo'?new Date().toISOString():null):usingAggregate?time(data.runs.find(r=>r.id===exactAggregate!.sync_run_id)?.finished_at):null;
 const eventObservedAt=events.map(r=>time(r.observed_at||r.occurred_at)).sort().at(-1)||null;
 const apptObservedAt=appointments.map(r=>time(r.observed_at||r.scheduled_at)).sort().at(-1)||null;
 const deals=data.deals.filter(r=>within(r.signed_at)&&r.status==='signed');
 const dealReady=!financialFilter&&deals.length>0&&new Set(deals.map(r=>`${r.source}:${r.source_namespace}`)).size===1&&deals.every(r=>r.currency==='EUR'&&Number(r.currency_exponent)===2&&r.tax_basis==='tax_inclusive'&&r.source_locator&&r.contracted_minor!==null);
 const observed=mode==='demo'?'Périmètre synthétique complet pour cet exemple.':'Observations reçues ; exhaustivité métier non établie.';
 const metrics:Metric[]=[
  metric('cash','CA encaissé',revenue,'eur','Paiements / agrégat compatible','Net TTC, remboursements déduits, à la date effective, avant frais. Une seule provenance financière par cellule.',revenue===null?'Transactions et remboursements à raccorder.':usingAggregate?'Agrégat net source exact. Brut et remboursements détaillés non disponibles.':`Encaissé brut ${gross.toFixed(2)} € · remboursements ${refunds.toFixed(2)} €`,observedAt,financialFilter?'Les encaissements ne sont pas répartissables selon ces filtres.':'Source financière TTC et couverture non établies.'),
  metric('spend','Dépenses publicitaires',spend,'eur','Meta Ads · publicité / jour','Somme des dépenses des annonces du périmètre, sans addition des profils de conversions.',adReady?observed:'Aucune partition Meta publiée et compatible.',latestSource('meta'),spendScope?'Aucune mesure reçue ; une réponse vide ne signifie pas zéro.':'Les dépenses ne sont pas répartissables selon ce filtre.'),
  metric('leads','Leads uniques',leadValue,'count','Inscriptions serveur vérifiées','Personnes rapprochées ayant une inscription réussie dans la période. Quiz et masterclass ne s’additionnent pas.',`${leads.length} inscriptions · ${unresolved} non rapprochées. ${observed}`,leads.map(r=>time(r.observed_at||r.registered_at)).sort().at(-1)||null,!leadAssignable?'Rattachement des inscriptions à cette campagne Meta non établi.':unresolved?'Des inscriptions restent sans identité résolue.':'Aucune inscription serveur reçue.'),
  metric('appointments','RDV réalisés',apptValue,'count','Occurrences commerciales prouvées','Rendez-vous distincts avec preuve de présence ; activité classée ici par date prévue.',`${attended.length} réalisés · ${noShow.length} absents · ${appointments.filter(r=>['unknown','scheduled'].includes(String(r.status))).length} issues inconnues. Les emplacements Notion courants sont séparés.`,latestSource('notion'),financialFilter?'Rattachement à la source ou campagne non établi.':'Aucune présence prouvée dans une occurrence distincte.'),
  metric('new_clients','Nouveaux clients',null,'count','Premier accompagnement déclaré','Personnes qui commencent leur premier accompagnement ; les binômes sont inclus. Un renouvellement ne crée pas un nouveau client.','Rapport commercial à publier.',null,'Les premiers accompagnements ne sont pas encore publiés.'),
  metric('roas','ROAS attribué',null,'ratio','Cohorte d’acquisition · dernier contact non direct','Dernier contact non direct à 30 jours ; revenu à 90 jours depuis le contact, corrigé des remboursements connus.','Aucun calcul d’attribution publié pour ce périmètre.',null,'Paiements, première acquisition, identité, dépenses et couverture à réconcilier.'),
  metric('ad_customer_cost','Coût pub. / nouveau client',null,'eur','Cohorte d’acquisition','Toute la dépense de la cohorte / nouveaux clients prouvés. Distinct du CAC complet.','Acquisitions et coûts non rapprochés.',null,'Nouveaux clients de la cohorte non prouvés.'),
 ];
 metrics.push(metric('contracted','CA contracté',dealReady?sum(deals,'contracted_minor')/100:null,'eur','Engagements signés','Montant TTC engagé, à la date de signature ; distinct des encaissements.','Engagements signés observés ; exhaustivité du registre à établir.',deals.map(r=>time(r.observed_at||r.signed_at)).sort().at(-1)||null,financialFilter?'Rattachement commercial à ce filtre non établi.':'Source du montant engagé et de la signature non raccordée.'));
 const published=(data.attributionRuns||[]).filter(r=>r.status==='published'&&time(r.cohort_from)===period.from&&time(r.cohort_to)===period.to&&r.cohort_timezone==='Europe/Paris'&&r.currency==='EUR'&&r.tax_basis==='tax_inclusive'&&(r.scope as Row)?.source===filters.source&&(r.scope as Row)?.tunnel===filters.tunnel&&String((r.scope as Row)?.campaign||'')===(filters.campaign==='all'?'':filters.campaign)).sort((a,b)=>time(b.input_cutoff_at).localeCompare(time(a.input_cutoff_at))||time(b.published_at).localeCompare(time(a.published_at)))[0];
 if(published&&(published.coverage_summary as Row)?.available===true){
  const rows=(data.attributionResults||[]).filter(r=>r.attribution_run_id===published.id);
  const paid=rows.filter(r=>(r.dimensions_snapshot as Row)?.source==='paid');
  const spendInput=(published.input_manifest as {spend?:{minor:number;currency:string}})?.spend;
  const receipts=paid.filter(r=>r.target_kind==='payment');
  const customerCount=new Set(paid.filter(r=>r.target_kind==='new_customer').map(r=>r.person_id)).size;
  if(spendInput?.currency==='EUR'&&Number.isSafeInteger(spendInput.minor)&&spendInput.minor>0&&receipts.every(r=>r.currency==='EUR')){
   const cash=sum(receipts,'contribution_minor');
   const roas=metrics.find(r=>r.id==='roas')!;Object.assign(roas,{value:cash/spendInput.minor,numerator:cash/100,denominator:spendInput.minor/100,coverage:`Calcul publié ${published.id} · entrées au ${time(published.input_cutoff_at)}. Cohorte de contacts à 90 jours.`,updatedAt:time(published.published_at),unavailableReason:undefined});
   const cost=metrics.find(r=>r.id==='ad_customer_cost')!;Object.assign(cost,{value:customerCount?spendInput.minor/100/customerCount:null,numerator:spendInput.minor/100,denominator:customerCount,coverage:roas.coverage,updatedAt:roas.updatedAt,unavailableReason:customerCount?undefined:'Aucun nouveau client prouvé de la cohorte.'});
  }
 }
 const hasClicks=adReady&&ads.every(r=>r.outbound_clicks!==null),hasImpressions=adReady&&ads.every(r=>r.impressions!==null);
 const clicks=hasClicks?sum(ads,'outbound_clicks'):null,impressions=hasImpressions?sum(ads,'impressions'):null;
 const rateMetric=(id:string,label:string,n:number|null,d:number|null,scale:number,unit:Metric['unit'])=>({...metric(id,label,n!==null&&d!==null&&d>0?n/d*scale:null,unit,'Meta Ads','Ratio des sommes dans le même périmètre.',observed,latestSource('meta')),numerator:n,denominator:d});
 const pillars=[
  {id:'content',title:'Contenu',description:'Arrivées et lecture réellement observées.',metrics:[metric('arrivals','Visites mesurées',events.length?new Set(events.filter(r=>['page_view','landing_arrival'].includes(String(r.event_name))).map(r=>`${r.visitor_namespace}:${r.session_id}:${r.tunnel}`)).size:null,'count','Collecte des pages','Session du navigateur par tunnel ; ce n’est pas une personne cross-device.',observed,eventObservedAt),metric('impressions','Impressions',impressions,'count','Meta Ads','Impressions rapportées des annonces sélectionnées.',observed,latestSource('meta'))]},
  {id:'acquisition',title:'Acquisition',description:'Diffusion publicitaire et inscriptions sauvegardées.',metrics:[metric('clicks','Clics sortants',clicks,'count','Meta Ads','Clics sortants, sans substitution par tous les clics.',observed,latestSource('meta')),rateMetric('ctr','CTR sortant',clicks,impressions,100,'percent'),rateMetric('cpc','CPC sortant',spend,clicks,1,'eur'),rateMetric('cpm','CPM',spend,impressions,1000,'eur'),metric('cpl','Coût / lead acquis',null,'eur','Cohorte d’acquisition','Dépense des contacts de la cohorte / premières inscriptions observées rattachées.','Attribution nécessaire.',null)]},
  {id:'conversion',title:'Conversion',description:'Présences et résultats commerciaux avec leur preuve.',metrics:[{...metric('showup','Taux de présence',!financialFilter&&(attended.length+noShow.length)>0?attended.length/(attended.length+noShow.length)*100:null,'percent','RDV distincts','Réalisés / (réalisés + absents), cohorte passée à issue connue. Annulations et reports séparés.',observed,apptObservedAt),numerator:attended.length,denominator:attended.length+noShow.length},metric('closing','Conversion des personnes reçues',null,'percent','RDV et engagements','Personnes reçues avec engagement postérieur dans une fenêtre commune.','Engagements signés et raccord RDV manquants.',null),metric('cac','CAC complet',null,'eur','Coûts marketing et commerciaux','Inclut tous les coûts retenus ; jamais assimilé aux dépenses publicitaires seules.','Coûts non publicitaires non raccordés.',null)]}
 ];
 const countEvent=(name:string,tunnel:string)=>{const rows=events.filter(r=>r.tunnel===tunnel&&r.event_name===name);return events.some(r=>r.tunnel===tunnel)?new Set(rows.map(r=>`${r.visitor_namespace}:${r.journey_id}`)).size:null;};
 const step=(id:string,label:string,value:number|null):JourneyStep=>({id,label,value,source:'Collecte des pages / backend',coverage:'Tentatives observées dans la période. Aucun taux séquentiel fabriqué entre deux parcours.'});
 const journeys=[{id:'quiz',title:'Quiz',description:'12 questions, coordonnées avant le résultat. Mesures d’activité par tentative.',steps:[step('arrival','Arrivées',countEvent('landing_arrival','quiz')),step('start','Quiz commencés',countEvent('quiz_started','quiz')),step('complete','12 questions terminées',countEvent('quiz_completed','quiz')),step('saved','Inscriptions sauvegardées',leads.some(r=>r.tunnel==='quiz')?leads.filter(r=>r.tunnel==='quiz').length:null),step('result','Résultats vus',countEvent('result_viewed','quiz'))]}, {id:'masterclass',title:'Masterclass',description:'Opt-in puis lecture sur la même page. Les clics bilan restent distincts des RDV.',steps:[step('arrival','Arrivées',countEvent('landing_arrival','masterclass')),step('saved','Inscriptions sauvegardées',leads.some(r=>r.tunnel==='masterclass')?leads.filter(r=>r.tunnel==='masterclass').length:null),step('video','Lectures commencées',countEvent('video_started','masterclass')),step('bilan','Clics vers le bilan',countEvent('bilan_clicked','masterclass'))]}];
 const questionSteps:JourneyStep[]=[];
 for(let q=1;q<=12;q++){
  const seen=events.filter(r=>r.tunnel==='quiz'&&r.event_name==='quiz_question_viewed'&&(r.properties as Row).question_number===q);
  const answered=events.filter(r=>r.tunnel==='quiz'&&r.event_name==='quiz_question_answered'&&(r.properties as Row).question_number===q);
  const viewers=new Set(seen.map(r=>`${r.visitor_namespace}:${r.journey_id}`));
  const matchedAnswers=new Set(answered.map(r=>`${r.visitor_namespace}:${r.journey_id}`).filter(key=>viewers.has(key)));
  questionSteps.push({...step('q'+q,`Question ${q} · réponses observées`,seen.length?matchedAnswers.size:null),denominator:seen.length?viewers.size:null,coverage:'Même tentative et même question. Les réponses personnelles ne sont pas enregistrées. Une observation ne prouve pas un ordre séquentiel.'});
 }
 journeys.push({id:'questions',title:'12 questions',description:'Détail des vues et réponses techniques par question, dans la période.',steps:questionSteps});
 const videos=new Map<string,Map<string,{duration:number;intervals:WatchedInterval[]}>>();
 for(const ev of events.filter(r=>r.event_name==='video_watch')){
  const properties=ev.properties as {video_id:string;video_version:string;duration:number;intervals:WatchedInterval[]};
  const key=`${properties.video_id} · ${properties.video_version} · ${properties.duration} s`;
  const viewers=videos.get(key)||new Map();const person=`${ev.visitor_namespace}:${ev.anonymous_id}`;
  const current=viewers.get(person)||{duration:properties.duration,intervals:[]};
  current.intervals.push(...properties.intervals);viewers.set(person,current);videos.set(key,viewers);
 }
 const videoSteps:JourneyStep[]=[];
 for(const [version,viewers] of videos){
  const coverage=[...viewers.values()].map(v=>({seconds:watchedSeconds(v.intervals,v.duration),duration:v.duration}));
  for(const threshold of [0.25,0.5,0.75,0.95])videoSteps.push({id:version+threshold,label:`${version} · ${threshold*100} % réellement vus`,value:coverage.filter(v=>v.seconds/v.duration>=threshold).length,denominator:viewers.size,source:'Intervalles lus par navigateur et version',coverage:'Union des plages observées, sans compter les sauts ni les relectures deux fois. Spectateurs mesurés, pas personnes cross-device.'});
 }
 journeys.push({id:'video',title:'Lecture vidéo',description:'Couverture de visionnage unique. Les versions et durées restent séparées.',steps:videoSteps.length?videoSteps:[step('video-missing','Intervalles réellement lus',null)]});
 const details=data.revisions.filter(r=>(filters.tunnel==='all'||r.tunnel===filters.tunnel)&&(!hasCampaign||filters.campaign===`link:${r.campaign}`)&&(filters.source==='all'||traffic(r)===filters.source)).map(r=>{const registrations=leads.filter(l=>l.link_revision_id===r.id);return {id:String(r.id),label:String(r.label),source:traffic(r),leads:registrations.length&&registrations.every(l=>l.person_id!==null)?new Set(registrations.map(l=>l.person_id)).size:null,appointments:null,clients:null,spend:null as number|null,coverage:'Personnes par révision. Dépenses et RDV sans correspondance restent indisponibles.'};});
 for(const ad of [...new Map(ads.map(r=>[r.ad_id,r])).values()]){
  const rows=ads.filter(r=>r.ad_id===ad.ad_id);
  details.push({id:String(ad.ad_id),label:String(ad.ad_name||'Publicité identifiée'),source:'paid',leads:null,appointments:null,clients:null,spend:adReady?sum(rows,'spend_minor')/100:null,coverage:'Annonce Meta · dépenses observées. Créative/asset et conversions commerciales non rapprochés.'});
 }
 const campaigns=[...new Map(data.revisions.map(r=>[`link:${r.campaign}`,{id:`link:${r.campaign}`,label:`Liens · ${r.campaign}`}])).values(),...new Map(data.ads.filter(r=>r.campaign_id).map(r=>[`meta:${r.campaign_id}`,{id:`meta:${r.campaign_id}`,label:`Meta · ${r.campaign_name||r.campaign_id}`}])).values(),...(data.adCatalog||[]).map(r=>({id:`meta-ad:${r.external_id}`,label:`Publicité · ${r.ad_name||r.external_id}`})),...new Map((data.adCatalog||[]).filter(r=>r.creative_id).map(r=>[`meta-creative:${r.creative_id}`,{id:`meta-creative:${r.creative_id}`,label:`Créative · ${r.creative_id}`}])).values()];
 const series=[];for(let day=Temporal.PlainDate.from(filters.from);Temporal.PlainDate.compare(day,Temporal.PlainDate.from(filters.to))<=0;day=day.add({days:1})){const d=day.toString();const dailyAds=ads.filter(r=>String(r.date).slice(0,10)===d);const cash=payments.filter(r=>parisDay(r.effective_at)===d);series.push({date:d,revenue:usingTransactions&&cash.length?cash.reduce((n,r)=>n+Number(r.gross_minor)*(r.kind==='refund'?-1:r.kind==='receipt'?1:Number(r.reversal_direction)),0)/100:null,spend:adReady&&dailyAds.length?sum(dailyAds,'spend_minor')/100:null});}
 const cost=metrics.find(m=>m.id==='ad_customer_cost')!;pillars.find(p=>p.id==='acquisition')!.metrics.push(cost);metrics.splice(metrics.indexOf(cost),1);
 metrics.push(metric('paid_sales','Nouvelles ventes payées',null,'count','Notion · ventes et paiements','Premières ventes dont le paiement initial est relié à une échéance réglée. Les mensualités suivantes restent séparées.','Rattachement des ventes et paiements en cours.',null,'Le relevé des ventes payées doit être actualisé.'));
 const mainOrder=['cash','contracted','paid_sales','spend','leads','appointments','new_clients','roas'];metrics.sort((a,b)=>mainOrder.indexOf(a.id)-mainOrder.indexOf(b.id));
 const response:DashboardResponse={mode,generatedAt:new Date().toISOString(),period:{from:filters.from,to:filters.to,timezone:'Europe/Paris'},metrics,pillars,journeys,details,series,campaigns,notices:[mode==='demo'?'Données synthétiques de test. Aucun chiffre de cette vue ne décrit BLG.':'Les valeurs absentes restent indisponibles ; un accès technique ne prouve pas une alimentation automatique.','Activité : dates effectives / prévues à Paris. Attribution : cohorte de contacts, 30 jours / 90 jours.',...(hasCampaign&&metaScoped?['Périmètre Meta : inscriptions sans raccord au compte publicitaire indisponibles.']:[])]};
 if(filters.compare){const days=Temporal.PlainDate.from(filters.from).until(Temporal.PlainDate.from(filters.to)).days+1;const previous=buildDashboard(data,{...filters,from:Temporal.PlainDate.from(filters.from).subtract({days}).toString(),to:Temporal.PlainDate.from(filters.from).subtract({days:1}).toString(),compare:false},mode);response.comparisonLabel=`Période précédente : ${previous.period.from} au ${previous.period.to}`;for(const m of response.metrics)m.previous=mode==='demo'||(['cash','roas','ad_customer_cost'].includes(m.id)&&m.value!==null)?previous.metrics.find(p=>p.id===m.id)?.value??null:null;
  if(mode!=='demo'&&published){
   const previousPeriod=parisPeriod(previous.period.from,Temporal.PlainDate.from(previous.period.to).add({days:1}).toString());
   const prior=(data.attributionRuns||[]).filter(r=>r.status==='published'&&time(r.cohort_from)===previousPeriod.from&&time(r.cohort_to)===previousPeriod.to&&JSON.stringify(r.scope)===JSON.stringify(published.scope)).sort((a,b)=>time(b.input_cutoff_at).localeCompare(time(a.input_cutoff_at))||time(b.published_at).localeCompare(time(a.published_at)))[0];
   if(!prior||prior.metric_definition_version!==published.metric_definition_version||prior.model!==published.model||prior.lookback_days!==published.lookback_days||prior.observation_horizon_days!==published.observation_horizon_days)for(const m of response.metrics.filter(m=>['roas','ad_customer_cost'].includes(m.id)))m.previous=null;
  }
 }
 return response;
}
export async function dashboardDetails(db:Database,filters:DashboardFilters,page=0){
 return db.rpc<DetailsResponse&{campaigns:DashboardResponse['campaigns']}>('cockpit_dashboard_lists',{p_from:filters.from,p_to:Temporal.PlainDate.from(filters.to).add({days:1}).toString(),p_source:filters.source,p_tunnel:filters.tunnel,p_campaign:filters.campaign==='all'?'':filters.campaign,p_page:page,p_page_size:50});
}
export async function dashboard(db:Database,filters:DashboardFilters,mode:DataMode){
 async function view(selected:DashboardFilters,withLists:boolean){
  const to=Temporal.PlainDate.from(selected.to).add({days:1}).toString(),period=parisPeriod(selected.from,to),campaign=selected.campaign==='all'?'':selected.campaign;
  const [rollup,snapshot,lists]=await Promise.all([
   db.rpc<DashboardRollup>('cockpit_dashboard_rollup',{p_from:selected.from,p_to:to,p_source:selected.source,p_tunnel:selected.tunnel,p_campaign:campaign}),
   db.rpc<{run:Row|null;results:Row[]}>('cockpit_attribution_snapshot',{p_from:period.from,p_to:period.to,p_source:selected.source,p_tunnel:selected.tunnel,p_campaign:campaign}),
   withLists?dashboardDetails(db,selected):Promise.resolve(null),
  ]);
  const skeleton=buildDashboard({leads:[],events:[],payments:[],appointments:[],deals:[],ads:[],revisions:[],runs:[],aggregates:[],attributionRuns:snapshot.run?[snapshot.run]:[],attributionResults:snapshot.results},{...selected,compare:false},mode);
  const response=applyDashboardRollup(skeleton,rollup,selected,mode);
  if(mode==='live' && selected.source==='all' && selected.tunnel==='all' && !campaign) {
   const wix=await readWixReportedPeriod(db,selected.from,to);
   if(wix) {
    response.metrics=response.metrics.map(m=>m.id==='cash'?wix.cash:m);
    const daily=new Map(wix.dailyRevenue.map(row=>[row.date,row.value]));
    response.series=response.series.map(row=>({...row,revenue:daily.get(row.date)??null}));
   }
  }
  if(mode==='live')await applyStoredBusiness(response,db,selected,to);
  if(lists){response.details=lists.details;response.detailsPagination=lists.pagination;response.campaigns=lists.campaigns;}
  if(mode==='live'){
   const scope=postHogScopeFromFilters(selected);
   if(scope&&selected.tunnel!=='masterclass')applyPostHogQuiz(response,await readPostHogPeriod(db,selected.from,to,{scope}),selected);
   if(selected.tunnel!=='quiz'&&selected.source==='all'&&!campaign)applyPostHogMasterclass(response,await readPostHogMasterclassPeriod(db,selected.from,to),selected);
  }
  return {response,run:snapshot.run};
 }
 const days=Temporal.PlainDate.from(filters.from).until(Temporal.PlainDate.from(filters.to)).days+1;
 const previousFilters={...filters,from:Temporal.PlainDate.from(filters.from).subtract({days}).toString(),to:Temporal.PlainDate.from(filters.from).subtract({days:1}).toString(),compare:false};
 const [current,prior]=await Promise.all([view(filters,true),filters.compare?view(previousFilters,false):Promise.resolve(null)]);
 if(prior){
  current.response.comparisonLabel=`Période précédente : ${prior.response.period.from} au ${prior.response.period.to}`;
  const compatible=current.run&&prior.run&&['metric_definition_version','model','lookback_days','observation_horizon_days'].every(key=>current.run![key]===prior.run![key]);
  const currentMetrics=[...current.response.metrics,...current.response.pillars.flatMap(p=>p.metrics)],priorMetrics=[...prior.response.metrics,...prior.response.pillars.flatMap(p=>p.metrics)];
  for(const metric of currentMetrics){
   const priorMetric=priorMetrics.find(m=>m.id===metric.id);
   if(metric.completeness==='partial'||priorMetric?.completeness==='partial'){metric.previous=null;continue;}
   const posthogComparable=metric.id==='arrivals'&&metric.source.startsWith('PostHog')&&priorMetric?.source===metric.source&&metric.completeness==='complete'&&priorMetric.completeness==='complete';
   metric.previous=mode==='demo'||(metric.value!==null&&(posthogComparable||['cash','spend','leads','appointments','contracted','paid_sales'].includes(metric.id)||(['roas','ad_customer_cost'].includes(metric.id)&&compatible)))?priorMetric?.value??null:null;
  }
 }
 return current.response;
}
export function emptyDashboard(filters:DashboardFilters,mode:DataMode){const d=buildDashboard({leads:[],events:[],payments:[],appointments:[],deals:[],ads:[],revisions:[],runs:[],aggregates:[]},filters,mode);d.metrics.forEach(m=>{m.value=null;m.coverage='Base du cockpit à installer.';});d.notices.unshift('Les tables Supabase ne sont pas encore installées.');return d;}
