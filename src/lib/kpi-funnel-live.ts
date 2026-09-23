import { Temporal } from '@js-temporal/polyfill';
import type { Database, Row } from './db';
import type { DashboardFilters } from './ui-contract';
import { kpiFunnelSnapshotSchema, type KpiFunnelDay, type KpiFunnelSnapshot, type KpiFunnelResponse } from './kpi-funnel-contract';
import { kpiDays, nextDay, pagedRows, readKpiSource, type KpiStoredSource } from './kpi-source-store';
import { canonicalRegistrationOrigins, observationOrigin, originMatchesSelection } from './ad-funnel';
import { reconcileAcquisitionPeople } from './results-acquisition';
import { isExcludedTestTraffic } from './traffic-scope';
import { appointmentDay, appointmentOutcome, isEffectiveAppointment } from './appointment-semantics';
import { readNotionCommerceReport } from './notion-commerce-storage';
import { VISUAL_JOURNEY_FORM_ID } from './visual-journey-report';
import { leadEntryProfile, wixLeadEntryConfig } from '../connectors/wix-lead-entries';
import { startOfParisDay } from '../domain/dates';
import { refreshCadences, type SyncJob } from './sync-jobs';
import { commerceReaderMode } from './config';
import { parisMinute } from './kpi-funnel-export';

// Campaign scope already used by the reviewed masterclass table, plus the explicitly prepared replacement campaign.
export const KPI_MASTERCLASS_CAMPAIGNS = ['120248692698770714','120248692706180714','120248808857790714'];
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const complete = (row: Row) => ['complete','empty'].includes(String(row.status)) && row.pagination_complete === true && Number(row.rows_rejected ?? 0) === 0;
const fields = ['spend_eur','impressions','link_clicks','unique_link_clicks_campaign_sum','landing_page_views','wix_form_submission_occurrences','reached_cta_oral','booking_clicks','booking_confirmed_browser','booking_meta_attributed','calls_scheduled','calls_held','offers_made','sales','cash_collected_eur','contracted_revenue_eur'] as const;
const missing = () => Object.fromEntries(fields.map(key => [key, null])) as Omit<KpiFunnelDay,'date'|'partial_day'>;
const sum = (values: (number | null)[]) => values.length && values.every(v => v !== null) ? Math.round(values.reduce<number>((n,v)=>n+(v ?? 0),0)*100)/100 : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const observed = (run: Row | undefined) => { const bounds=run?[run.source_as_of,run.started_at,run.finished_at].filter(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))).map(v=>String(v)).sort((a,b)=>Date.parse(a)-Date.parse(b)):[];return bounds[0]??null; };
const isoParis = (value: string) => Temporal.Instant.from(value).toZonedDateTimeISO('Europe/Paris').toString({ timeZoneName: 'never', calendarName: 'never' });
const freshThrough = (source: KpiStoredSource) => [...source.days.values()].map(v=>v.observedAt).sort()[0] ?? null;
const defs = {
 spend_eur: 'Dépenses Meta des campagnes masterclass identifiées, par jour de diffusion.', impressions: 'Impressions Meta par campagne et jour.', link_clicks: 'Clics lien Meta (inline_link_clicks), base du CTR et du CPC.',
 unique_link_clicks_campaign_sum: 'Somme au grain campagne-jour, sans déduplication de la période.', landing_page_views: 'Vues de landing attribuées par Meta ; différentes des visites PostHog.',
 wix_form_submission_occurrences: 'Soumissions confirmées du formulaire de la masterclass actuelle, datées en Europe/Paris ; répétitions conservées.', wix_distinct_contacts: 'Clés de contact distinctes parmi ces soumissions, sans identité dans la réponse.',
 reached_cta_oral: 'Non mesuré : aucun signal validé du passage au CTA oral.', booking_clicks: 'Sessions PostHog de production, datées au premier clic bilan de la fenêtre collectée.', booking_confirmed_browser: 'Sessions avec confirmation navigateur, distinctes des appels tenus.',
 booking_meta_attributed: 'Conversion personnalisée RDV Calendly BLG HOMME, 7 jours clic / 1 jour vue ; distincte de Schedule générique.', calls_scheduled: 'Créneaux effectifs Notion des contacts inscrits sur la période, datés au jour du call.', calls_held: 'Présences Notion des mêmes contacts, datées au jour du call.',
 offers_made: 'Non mesuré : aucun champ source validé.', sales: 'Premières ventes payées confirmées de la cohorte des inscrits ; cas à rapprocher exclus et signalés.', cash_collected_eur: 'Paiements réussis de cette cohorte, par date de paiement, avant remboursements.', contracted_revenue_eur: 'Non mesuré : aucune source contractuelle alignée.',
};
export async function readLiveKpiFunnel(db: Database, filters: DashboardFilters, options: { env?: NodeJS.ProcessEnv; now?: string; includeTests?: boolean } = {}): Promise<KpiFunnelResponse> {
 if (filters.tunnel === 'quiz') return { status: 'unavailable', message: 'Ce tableau suit la masterclass. Le parcours et les résultats du quiz restent accessibles dans leurs vues.' };
 const env = options.env ?? process.env, now = options.now ?? new Date().toISOString(), includeTests = options.includeTests === true, to = nextDay(filters.to), dates = kpiDays(filters.from, to);
 const today = Temporal.Instant.from(now).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
 // D3 : un jour passé n'est mesuré que si la lecture couvre toute la journée ; le jour en cours reste partiel et signalé (partial_day).
 const covers = (at: string | null | undefined, date: string) => !!at && (date === today ? Date.parse(startOfParisDay(date)) < Date.parse(at) : Date.parse(at) >= Date.parse(startOfParisDay(nextDay(date))));
 const failures: string[] = [];
 const source = async (kind: 'meta'|'posthog'|'wix', namespace: string | undefined) => { try { return await readKpiSource(db,kind,namespace,filters.from,to); } catch { failures.push(kind); return { days: new Map(), latestAttempt: null } as KpiStoredSource; } };
 const [meta, posthog, email, leadRows, prospects, runs, ads, links, appointments, commerce] = await Promise.all([
  source('meta',env.META_AD_ACCOUNT_ID?.replace(/^act_/,'')), source('posthog',env.POSTHOG_PROJECT_ID), source('wix',env.WIX_SITE_ID),
  pagedRows(db,'lead_source_observations',{eq:{is_current:'true'},order:'occurred_day,id'}),
  pagedRows(db,'prospects',{eq:env.NOTION_DATA_SOURCE_ID?{source:'notion',source_namespace:env.NOTION_DATA_SOURCE_ID}:undefined,order:'id',columns:['id','external_id','source','source_namespace','person_id','business','archived']}),
  pagedRows(db,'sync_runs',{order:'started_at,id',columns:['id','source','source_namespace','stream_key','status','pagination_complete','rows_rejected','finished_at','source_as_of','period_to','started_at','query_profile_key','error_code']}),
  pagedRows(db,'ads',{order:'id',columns:['id','external_id','campaign_id','creative_id','ad_name']}),
  pagedRows(db,'link_revisions',{order:'id',columns:['id','campaign','medium','label']}),
  pagedRows(db,'appointments',{order:'id'}),
  readNotionCommerceReport(db,{...filters,source:'all',campaign:'',tunnel:'all'},env).catch(()=>null),
 ]);
 const completeRuns = runs.filter(complete), runById = new Map(completeRuns.map(r=>[r.id,r]));
 const latest = (stream: string, namespace?: string) => completeRuns.filter(r=>r.stream_key===stream&&(!namespace||r.source_namespace===namespace)).sort((a,b)=>String(b.finished_at).localeCompare(String(a.finished_at)))[0];
 const config = wixLeadEntryConfig(env.WIX_LEAD_ENTRY_CONFIG), profile = config ? leadEntryProfile('forms',config) : null;
 const formsRun = latest('lead_entries_forms',env.WIX_SITE_ID), notionRun = latest('prospects_business',env.NOTION_DATA_SOURCE_ID), clientsRun = latest('lead_entries_client_history',env.NOTION_CLIENT_DATA_SOURCE_ID);
 const latestProfiles=new Map<string,unknown>();for(const run of [...completeRuns].sort((a,b)=>String(a.finished_at).localeCompare(String(b.finished_at))))if(String(run.stream_key).startsWith('lead_entries_'))latestProfiles.set(run.source_namespace+':'+String(run.stream_key).slice(13),run.query_profile_key);
 const published = leadRows.filter(row=>row.published_at&&row.run_id&&runById.has(row.run_id)&&row.mapping_profile===latestProfiles.get(row.source_namespace+':'+row.family)&&(!env.WIX_SITE_ID||row.family==='client_history'||row.source_namespace===env.WIX_SITE_ID));
 const reconciled = reconcileAcquisitionPeople(published,prospects,env.NOTION_DATA_SOURCE_ID), origins = canonicalRegistrationOrigins(reconciled,includeTests);
 const adById = new Map(ads.map(a=>[String(a.external_id),a])), linkById = new Map(links.map(l=>[String(l.id),l]));
 const matches = (origin: ReturnType<typeof observationOrigin>) => { const ad = origin.adId ? adById.get(origin.adId) : undefined, link = origin.linkId ? linkById.get(origin.linkId) : undefined; return originMatchesSelection(origin,{source:filters.source,campaign:filters.campaign},{adCampaignId:ad?.campaign_id?String(ad.campaign_id):null,adCreativeId:ad?.creative_id?String(ad.creative_id):null,linkCampaign:link?.campaign?String(link.campaign):null,linkMedium:link?.medium?String(link.medium):null}); };
 const requests = reconciled.filter(row=> {
  if (row.family!=='forms'||row.source_container_id!==VISUAL_JOURNEY_FORM_ID||row.eligible!==true||row.mapping_profile!==profile||!row.occurred_day||String(row.occurred_day)<filters.from||String(row.occurred_day)>=to) return false;
  const props=record(row.properties), origin=record(props.origin), first=record(props.firstTouch);
  if (isExcludedTestTraffic({includeTests},origin,first,props)) return false;
  return matches((row.person_id ? origins.get(String(row.person_id))?.origin : null) ?? observationOrigin({origin,firstTouch:first}));
 });
 const identities = new Set(requests.map(r=>r.identity_key).filter(Boolean)), people = new Set(requests.filter(r=>r.identity_state==='linked'&&r.person_id).map(r=>String(r.person_id)));
 const formsAvailable = !!formsRun && !!profile && formsRun.query_profile_key===profile && !!config?.formIds.includes(VISUAL_JOURNEY_FORM_ID);
 const identitiesComplete = requests.every(r=>r.identity_key), cohortComplete = formsAvailable&&requests.every(r=>r.identity_state==='linked'&&r.person_id);
 const formsAt=observed(formsRun), notionAt=observed(notionRun), clientsAt=observed(clientsRun), commerceAt=commerce?.observedAt??null;
 const prospectById = new Map(prospects.map(p=>[String(p.id),p]));
 const cohortAppointments = appointments.filter(a=> { const p=prospectById.get(String(a.prospect_id)), person=a.person_id??p?.person_id; return p&&p.archived!==true&&people.has(String(person))&&(!env.NOTION_DATA_SOURCE_ID||a.source_namespace===env.NOTION_DATA_SOURCE_ID)&&!isExcludedTestTraffic({includeTests},a,record(p.business)); });
 const clientLinks = reconciled.filter(r=>r.family==='client_history'&&r.person_id&&r.run_id&&runById.has(r.run_id)&&(!env.NOTION_CLIENT_DATA_SOURCE_ID||r.source_namespace===env.NOTION_CLIENT_DATA_SOURCE_ID));
 const clientCandidates=new Map<string,Set<string>>();for(const row of clientLinks){const key=String(row.external_id),ids=clientCandidates.get(key)??new Set<string>();ids.add(String(row.person_id));clientCandidates.set(key,ids);}
 const clientPeople=new Map([...clientCandidates].filter(([,ids])=>ids.size===1).map(([key,ids])=>[key,[...ids][0]]));
 const cohortPayments = (commerce?.paidSales?.details??[]).filter(p=>p.clientIds.length===1&&people.has(clientPeople.get(p.clientIds[0])??''));
 const moneyAvailable = cohortComplete&&!!notionRun&&!!clientsRun&&!!commerce?.available&&!!commerce.paidSales;
 const campaigns = (env.BLG_KPI_MASTERCLASS_CAMPAIGN_IDS?.trim()||undefined)?.split(',').map(v=>v.trim()).filter(v=>/^\d+$/.test(v)) ?? KPI_MASTERCLASS_CAMPAIGNS;
 const metaCampaigns = filters.campaign.startsWith('meta:') ? [filters.campaign.slice(5)] : campaigns;
 const metaSupported = ['all','paid'].includes(filters.source)&&(!filters.campaign||filters.campaign==='all'||filters.campaign.startsWith('meta:'));
 const daily: KpiFunnelDay[] = dates.map(date=> {
  const row: KpiFunnelDay={date,partial_day:date>=today?'Journée en cours ou à venir':null,...missing()};
  const metaDay=meta.days.get(date);
  if(metaDay&&metaSupported&&covers(metaDay.observedAt,date)){const rows=metaDay.rows.filter(r=>metaCampaigns.includes(String(r.data.campaignId)));for(const key of ['spend_eur','impressions','link_clicks','unique_link_clicks_campaign_sum','landing_page_views','booking_meta_attributed'] as const)row[key]=rows.length?sum(rows.map(r=>number(r.data[key]))):null;}
  if(formsAvailable&&covers(formsAt,date))row.wix_form_submission_occurrences=requests.filter(r=>r.occurred_day===date).length;
  const ph=posthog.days.get(date);
  if(ph&&covers(ph.observedAt,date)){const rows=ph.rows.filter(r=>!isExcludedTestTraffic({includeTests},r.data)&&matches(observationOrigin({origin:{...r.data,linkId:r.data.link},firstTouch:null})));row.booking_clicks=rows.filter(r=>r.data.kind==='click').reduce((n,r)=>n+Number(r.data.sessions),0);row.booking_confirmed_browser=rows.filter(r=>r.data.kind==='confirmed').reduce((n,r)=>n+Number(r.data.sessions),0);}
  if(cohortComplete&&covers(notionAt,date)&&covers(formsAt,date)){
   const calls=cohortAppointments.filter(a=>appointmentDay(a)===date);row.calls_scheduled=calls.filter(a=>isEffectiveAppointment(a,record(prospectById.get(String(a.prospect_id))?.business))).length;row.calls_held=calls.filter(a=>appointmentOutcome(a,record(prospectById.get(String(a.prospect_id))?.business),date)==='attended').length;
  }
  if(moneyAvailable&&[commerceAt,clientsAt,formsAt,notionAt].every(at=>covers(at,date))){
   const payments=cohortPayments.filter(p=>p.day===date),unresolved=(commerce?.paidSales?.details??[]).some(p=>p.day===date&&(p.clientIds.length!==1||!clientPeople.has(p.clientIds[0]))&&p.state!=='excluded'),pending=unresolved||payments.some(p=>p.state==='pending'||p.state==='reconciled');
   row.sales=pending?null:payments.filter(p=>p.state==='confirmed').length;
   row.cash_collected_eur=pending?null:sum(payments.filter(p=>p.state==='confirmed'||p.reasons.includes('subsequent_payment_for_client')).map(p=>p.amountMinor===null?null:p.amountMinor/100))??(payments.length?null:0);
  }
  return row;
 });
 const totals = {...missing(),wix_distinct_contacts:null as number|null,wix_repeat_occurrences:null as number|null};for(const key of fields)totals[key]=sum(daily.map(r=>r[key]));
 if(totals.wix_form_submission_occurrences!==null&&identitiesComplete){totals.wix_distinct_contacts=identities.size;totals.wix_repeat_occurrences=requests.length-identities.size;}
 const emailRows=dates.flatMap(day=>email.days.get(day)?.rows??[]),emailCovered=dates.every(day=>covers(email.days.get(day)?.observedAt,day));
 const emailTotal=(key:string,cohort:boolean)=>emailCovered&&(!cohort||formsAvailable&&identitiesComplete)?(emailRows.filter(r=>!cohort||identities.has(r.data.identity)).length?sum(emailRows.filter(r=>!cohort||identities.has(r.data.identity)).map(r=>number(r.data[key]))):0):null;
 const coverage: KpiFunnelSnapshot['coverage'] = [];
 // Fraîcheur : chaque bloc est daté par la plus ancienne des lectures dont il dépend ; il est « ancien » dès qu'une de ces lectures
 // dépasse la cadence réelle de son flux (réglage serveur des flux pilotes, une heure pour Notion et les ventes).
 const cadences = refreshCadences(env);
 type Part = { at: string | null; job: SyncJob };
 const cover=(field_group:string,parts:Part[],available:boolean,reason:string,attempt?:Row|null,detail?:string)=>{
  // Sans l'une de ses lectures, un bloc n'a pas d'heure de couverture.
  const dated=parts.filter((p):p is {at:string;job:SyncJob}=>!!p.at),through=dated.length===parts.length?dated.map(p=>p.at).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]:undefined;
  coverage.push({field_group,status:available?'available':'missing',...(through?{through,stale:dated.some(p=>Date.parse(now)-Date.parse(p.at)>=cadences[p.job])}:{}),reason,...(detail?{detail}:{}),...(attempt?{last_attempt:String(attempt.started_at),...(attempt.status==='failed'?{last_error:String(attempt.error_code??'SYNC_UNIT_FAILED')}:{})}:{})});
 };
 const unlinked=requests.filter(r=>!(r.identity_state==='linked'&&r.person_id)).length;
 const cohortNote=unlinked?`${unlinked} inscription${unlinked>1?'s':''} de la période non reliée${unlinked>1?'s':''} à une personne : tout le bloc reste non mesuré (règle actuelle : toutes les inscriptions reliées).`:undefined;
 cover('Diffusion Meta',[{at:freshThrough(meta),job:'kpi_meta'}],metaSupported&&daily.every(r=>r.spend_eur!==null),metaSupported?'Campagnes masterclass identifiées ; absence de ligne différente de zéro.':'Ce filtre ne permet pas de répartir la dépense campagne. Les mesures Meta restent non mesurées.',meta.latestAttempt);
 cover('Occurrences du formulaire Wix',[{at:formsAt,job:'forms'}],formsAvailable,'Formulaire de la masterclass actuelle ; occurrences et contacts distincts restent séparés.');
 cover('Clics bilan et confirmations navigateur',[{at:freshThrough(posthog),job:'kpi_posthog'}],daily.every(r=>r.booking_clicks!==null),'Sessions, première origine et essais explicites ; ce ne sont pas des rendez-vous réalisés.',posthog.latestAttempt);
 cover('Rendez-vous et présence',[{at:notionAt,job:'notion'},{at:formsAt,job:'forms'}],cohortComplete&&!!notionRun,`${people.size} contacts raccordés pour ${identities.size} contacts distincts de la période.`,null,cohortNote);
 const commerceAttempt=runs.filter(r=>['commerce_declared_snapshot','commerce_reader_checkpoint'].includes(String(r.stream_key))).sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)))[0];
 const publication=commerceAt?`dernière publication complète du ${parisMinute(commerceAt)}`:'aucune publication complète lisible',lastTry=commerceAttempt?`dernière tentative le ${parisMinute(String(commerceAttempt.started_at))}${commerceAttempt.status==='failed'?' (échec)':''}`:'aucune tentative enregistrée';
 const commerceReason=!commerce?'Rapport des ventes non configuré ou illisible : ventes et cash non mesurés, jamais à zéro.':commerceReaderMode(env)==='paused'?`Lecture suspendue (réglage BLG_COMMERCE_READER) : ${publication}, ${lastTry}. Les jours qu’elle ne couvre pas restent non mesurés, jamais à zéro.`:commerceAttempt?.status==='failed'?`Dernier rapport valide conservé (${publication}) ; ${lastTry}. Les cas à rapprocher restent non mesurés.`:'Paiements de la cohorte raccordée, ventes confirmées distinctes des cas à rapprocher.';
 cover('Ventes payées et cash',[{at:commerceAt,job:'commerce'},{at:clientsAt,job:'client_history'},{at:notionAt,job:'notion'},{at:formsAt,job:'forms'}],moneyAvailable,commerceReason,commerceAttempt,cohortNote??(commerce&&!commerce.available?commerce.reason:undefined));
 cover('Activité email',[{at:freshThrough(email),job:'kpi_email'}],emailCovered,'Séquence commune à trois formulaires. Le rapprochement porte sur les destinataires ; il ne prouve pas le formulaire déclencheur.',email.latestAttempt);
 for(const [group,reason,detail] of [
  ['CTA oral','Non mesuré : aucun signal validé du passage au CTA oral.','Responsable : Mehdi et Codex. Prochaine étape : choisir le signal vidéo ; aucune collecte créée d’ici là.'],
  ['Offres faites','Non mesuré : aucun champ source validé.','Responsable : Jérôme avec Codex. Prochaine étape : définir le champ source dans Notion ; aucune écriture Notion d’ici là.'],
  ['CA contracté','Non mesuré : aucune source contractuelle alignée ; sans lien avec la pause des ventes.','Responsable : lot finance de la suite. Prochaine étape : aligner la source contractuelle dans ce lot.'],
 ])cover(group,[],false,reason,null,detail);
 for(const failure of failures)cover(`Lecture ${failure}`,[],false,'La lecture a échoué ; aucune absence convertie en zéro.');
 const breakdown=new Map<string,{label:string;ad_id:string|null;booking_click_sessions:number;booking_confirmed_browser:number}>();
 for(const [day,{rows,observedAt}] of posthog.days){if(!covers(observedAt,day))continue;for(const row of rows){
  if(isExcludedTestTraffic({includeTests},row.data))continue;
  const origin=observationOrigin({origin:{...row.data,linkId:row.data.link},firstTouch:null});if(!matches(origin))continue;
  const key=origin.adId??origin.linkId??origin.campaignId??origin.source??'unknown';
  const linkLabel=origin.linkId?linkById.get(origin.linkId)?.label:null;
  const item=breakdown.get(key)??{label:origin.adId?String(adById.get(origin.adId)?.ad_name??`Publicité ${origin.adId}`):origin.linkId?(linkLabel?`Lien identifié · ${String(linkLabel)}`:'Lien identifié'):origin.campaignId?`Campagne ${origin.campaignId}`:origin.source??'Non attribué',ad_id:origin.adId,booking_click_sessions:0,booking_confirmed_browser:0};
  if(row.data.kind==='click')item.booking_click_sessions+=Number(row.data.sessions);else item.booking_confirmed_browser+=Number(row.data.sessions);breakdown.set(key,item);
 }}
 const arrival:Record<string,number>={},selectedContext:Record<string,number>={};
 for(const row of requests){const props=record(row.properties),own=observationOrigin({origin:record(props.origin),firstTouch:null}),selected=(row.person_id?origins.get(String(row.person_id))?.origin:null)??observationOrigin({origin:record(props.origin),firstTouch:record(props.firstTouch)});for(const [target,origin] of [[arrival,own],[selectedContext,selected]] as const){const key=origin.adId?String(adById.get(origin.adId)?.ad_name??`Publicité ${origin.adId}`):origin.linkId?'Lien identifié':origin.campaignId?`Campagne ${origin.campaignId}`:origin.source??'missing_context';target[key]=(target[key]??0)+1;}}
 const end = Temporal.PlainDate.from(filters.to).toZonedDateTime({timeZone:'Europe/Paris',plainTime:'23:59:59'}).toInstant().toString();
 const snapshot: KpiFunnelSnapshot={
  metadata:{dataset_id:'blg-kpi-automatic',schema_version:'2.0.0',mode:'automatic',include_tests:includeTests,generated_at:now,timezone:'Europe/Paris',window_start:isoParis(startOfParisDay(filters.from)),window_end_meta:isoParis(end),window_end_email:isoParis(end),window_end_commercial:isoParis(end),scope:'mixed_source_masterclass_monitoring',scope_note:'Période sélectionnée. Chaque bloc garde sa source, son groupe de personnes et sa date de lecture ; aucune conversion entre bases non rapprochées.',campaign_ids:metaCampaigns,exclusions:includeTests?[]:['Essais explicitement marqués']},
  definitions:defs,daily,totals,
  attribution_breakdown:{freshness:freshThrough(posthog)??now,metric:'Sessions de clic bilan ; lecture automatique.',rows:[...breakdown.values()],wix_submission_context:{arrival,selected_first_origin_else_arrival:selectedContext,rule:'Première origine canonique conservée ; sinon arrivée.',interpretation:'Le contexte ne prouve pas à lui seul la causalité publicitaire.',freshness:formsAt??now}},
  email_summary:{scope:'Activités email sur la période sélectionnée.',all_three_forms:{sent:emailTotal('sent',false),delivered:emailTotal('delivered',false),opens_sum_by_message:emailTotal('opens',false),clicks_sum_by_message:emailTotal('clicks',false)},facebook_form_recipient_filter:{submissions:totals.wix_form_submission_occurrences,distinct_emails:totals.wix_distinct_contacts,sent:emailTotal('sent',true),delivered:emailTotal('delivered',true),opens:emailTotal('opens',true),clicks:emailTotal('clicks',true)}},
  coverage,source_locators:[{source:'Meta',locator:'Collecte quotidienne par campagne, complète et datée.'},{source:'Wix',locator:'Formulaire masterclass actuel et séquence de neuf messages.'},{source:'PostHog',locator:'mc_booking_click / mc_booking_confirmed, production.'},{source:'Notion',locator:'Miroir prospects, créneaux et dernière publication commerciale complète.'}],
 };
 return {status:'ready',snapshot:kpiFunnelSnapshotSchema.parse(snapshot)};
}
