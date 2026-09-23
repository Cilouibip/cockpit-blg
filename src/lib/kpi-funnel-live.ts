import { Temporal } from '@js-temporal/polyfill';
import type { Database, Row } from './db';
import type { DashboardFilters } from './ui-contract';
import { KPI_ADDITIVE_FIELDS, KPI_BLOCKS, KPI_COUNT_FIELDS, KPI_FUNNEL_SCHEMA_VERSION, KPI_RATIO_KEYS, KPI_SUMMARY_KEYS, kpiCountReason, kpiFunnelSnapshotSchema, kpiRatios, type KpiBlockCoverage, type KpiCountField, type KpiFunnelDay, type KpiFunnelSnapshot, type KpiFunnelSummary, type KpiFunnelResponse, type KpiMeasures } from './kpi-funnel-contract';
import { kpiDays, kpiWindowId, nextDay, pagedRows, readKpiSource, readKpiWindows, type KpiStoredSource, type KpiStoredWindow } from './kpi-source-store';
import { KPI_MASTERCLASS_CAMPAIGNS, kpiAccountRowKey, kpiCampaignSetKey, kpiMasterclassCampaigns } from '../connectors/kpi-meta';
import { canonicalRegistrationOrigins, observationOrigin, originMatchesSelection } from './ad-funnel';
import { reconcileAcquisitionPeople } from './results-acquisition';
import { isExcludedTestTraffic } from './traffic-scope';
import { appointmentBooking, appointmentDay, appointmentOutcome, businessDay, isEffectiveAppointment } from './appointment-semantics';
import { readNotionCommerceReport } from './notion-commerce-storage';
import { VISUAL_JOURNEY_FORM_ID } from './visual-journey-report';
import { leadEntryProfile, wixLeadEntryConfig } from '../connectors/wix-lead-entries';
import { startOfParisDay } from '../domain/dates';
import { refreshCadences, type SyncJob } from './sync-jobs';
import { commerceReaderMode } from './config';
import { KPI_DETAIL_COLUMNS, KPI_EXCEL_COLUMNS, frenchDay, parisMinute } from './kpi-funnel-export';

// Périmètre des campagnes Masterclass : défini avec le lecteur Meta (lectures niveau compte et fenêtres du même jeu).
export { KPI_MASTERCLASS_CAMPAIGNS };
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const complete = (row: Row) => ['complete','empty'].includes(String(row.status)) && row.pagination_complete === true && Number(row.rows_rejected ?? 0) === 0;
const missing = () => Object.fromEntries(KPI_COUNT_FIELDS.map(key => [key, null])) as KpiMeasures;
const sum = (values: (number | null)[]) => values.length && values.every(v => v !== null) ? Math.round(values.reduce<number>((n,v)=>n+(v ?? 0),0)*100)/100 : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const observed = (run: Row | undefined) => { const bounds=run?[run.source_as_of,run.started_at,run.finished_at].filter(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))).map(v=>String(v)).sort((a,b)=>Date.parse(a)-Date.parse(b)):[];return bounds[0]??null; };
/** Taux d'une ligne et motifs : motifs des taux non mesurés, puis motifs des comptes non mesurés quand ils sont connus. */
const rowRatios = (values: KpiMeasures, blocks: KpiBlockCoverage, grain: 'day' | 'window', termReasons: Partial<Record<KpiCountField,string>>) => {
 const { ratios, reasons } = kpiRatios(values, blocks, { grain, termReasons });
 const counts = Object.fromEntries(KPI_COUNT_FIELDS.filter(key => values[key] === null).map(key => [key, kpiCountReason(key, blocks, grain, termReasons[key])]));
 return { ratios, blocks, reasons: { ...counts, ...reasons } as Record<string,string> };
};
/** Comptes uniques Meta d'une ligne : publiés seulement s'ils ne dépassent pas les totaux de la même ligne (uniques ≤ clics lien,
 * comptes touchés ≤ impressions) ; sinon non mesurés avec le motif. Renvoie les motifs des comptes laissés non mesurés. */
const uniqueCounts = (values: KpiMeasures, unique: { reach: number | null; clicks: number | null } | null, missingReason: string): Partial<Record<KpiCountField,string>> => {
 if (!unique || unique.reach === null || unique.clicks === null) return { meta_reach: missingReason, meta_unique_link_clicks: missingReason };
 if ((values.impressions !== null && unique.reach > values.impressions) || (values.link_clicks !== null && unique.clicks > values.link_clicks)) { const reason = 'CTR unique non mesuré : lecture Meta incohérente (comptes uniques supérieurs aux totaux de la même période).'; return { meta_reach: reason, meta_unique_link_clicks: reason }; }
 values.meta_reach = unique.reach; values.meta_unique_link_clicks = unique.clicks;
 return {};
};
const isoParis = (value: string) => Temporal.Instant.from(value).toZonedDateTimeISO('Europe/Paris').toString({ timeZoneName: 'never', calendarName: 'never' });
const freshThrough = (source: KpiStoredSource) => [...source.days.values()].map(v=>v.observedAt).sort()[0] ?? null;
const defs: Record<string,string> = {
 ...Object.fromEntries([...KPI_EXCEL_COLUMNS,...KPI_DETAIL_COLUMNS].map(column => [column.id, column.definition])),
 unique_link_clicks_campaign_sum: 'Somme au grain campagne-jour, sans déduplication (relevé JSON seulement, jamais affichée ni additionnée comme des personnes).',
 wix_distinct_contacts: 'Clés de contact distinctes parmi les soumissions de la période, sans identité dans la réponse.',
};
export async function readLiveKpiFunnel(db: Database, filters: DashboardFilters, options: { env?: NodeJS.ProcessEnv; now?: string; includeTests?: boolean } = {}): Promise<KpiFunnelResponse> {
 if (filters.tunnel === 'quiz') return { status: 'unavailable', message: 'Ce tableau suit la masterclass. Le parcours et les résultats du quiz restent accessibles dans leurs vues.' };
 const env = options.env ?? process.env, now = options.now ?? new Date().toISOString(), includeTests = options.includeTests === true, to = nextDay(filters.to), dates = kpiDays(filters.from, to);
 const today = Temporal.Instant.from(now).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
 // D3 : un jour passé n'est mesuré que si la lecture couvre toute la journée ; le jour en cours reste partiel et signalé (partial_day).
 const covers = (at: string | null | undefined, date: string) => !!at && (date === today ? Date.parse(startOfParisDay(date)) < Date.parse(at) : Date.parse(at) >= Date.parse(startOfParisDay(nextDay(date))));
 const failures: string[] = [];
 const source = async (kind: 'meta'|'posthog'|'wix', namespace: string | undefined) => { try { return await readKpiSource(db,kind,namespace,filters.from,to); } catch { failures.push(kind); return { days: new Map(), latestAttempt: null } as KpiStoredSource; } };
 const [meta, posthog, email, leadRows, prospects, runs, ads, links, appointments, commerce, windows] = await Promise.all([
  source('meta',env.META_AD_ACCOUNT_ID?.replace(/^act_/,'')), source('posthog',env.POSTHOG_PROJECT_ID), source('wix',env.WIX_SITE_ID),
  pagedRows(db,'lead_source_observations',{eq:{is_current:'true'},order:'occurred_day,id'}),
  pagedRows(db,'prospects',{eq:env.NOTION_DATA_SOURCE_ID?{source:'notion',source_namespace:env.NOTION_DATA_SOURCE_ID}:undefined,order:'id',columns:['id','external_id','source','source_namespace','person_id','business','archived']}),
  pagedRows(db,'sync_runs',{order:'started_at,id',columns:['id','source','source_namespace','stream_key','status','pagination_complete','rows_rejected','finished_at','source_as_of','period_to','started_at','query_profile_key','error_code']}),
  pagedRows(db,'ads',{order:'id',columns:['id','external_id','campaign_id','creative_id','ad_name']}),
  pagedRows(db,'link_revisions',{order:'id',columns:['id','campaign','medium','label']}),
  pagedRows(db,'appointments',{order:'id'}),
  readNotionCommerceReport(db,{...filters,source:'all',campaign:'',tunnel:'all'},env).catch(()=>null),
  readKpiWindows(db,'meta',env.META_AD_ACCOUNT_ID?.replace(/^act_/,'')).catch(()=>{failures.push('meta (fenêtres)');return new Map<string,KpiStoredWindow>();}),
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
 const campaigns = kpiMasterclassCampaigns(env);
 const metaCampaigns = filters.campaign.startsWith('meta:') ? [filters.campaign.slice(5)] : campaigns;
 const metaSupported = ['all','paid'].includes(filters.source)&&(!filters.campaign||filters.campaign==='all'||filters.campaign.startsWith('meta:'));
 const unlinked=requests.filter(r=>!(r.identity_state==='linked'&&r.person_id)).length;
 const cohortNote=unlinked?`${unlinked} inscription${unlinked>1?'s':''} de la période non reliée${unlinked>1?'s':''} à une personne : tout le bloc reste non mesuré (règle actuelle : toutes les inscriptions reliées).`:undefined;
 // Appels réservés : réservations des personnes de la cohorte datées par la date de réservation explicite (appointmentBooking),
 // même règle que Résultats « Réservés » (buildAdFunnel.appointmentsReserved) : un créneau courant compte une fois à sa date
 // de réservation, qu'il soit ensuite annulé ou reporté ; une fiche sans créneau compte par sa date de réservation seule.
 const appointmentProspects=new Set(appointments.map(a=>String(a.prospect_id??'')));
 const bookingDays=[
  ...cohortAppointments.map(a=>appointmentBooking(a,record(prospectById.get(String(a.prospect_id))?.business)).day),
  ...prospects.filter(p=>p.archived!==true&&!appointmentProspects.has(String(p.id))&&(!env.NOTION_DATA_SOURCE_ID||p.source==='notion'&&p.source_namespace===env.NOTION_DATA_SOURCE_ID)&&people.has(String(p.person_id))&&!isExcludedTestTraffic({includeTests},record(p.business)))
   .map(p=>{const business=record(p.business);return businessDay(record(business.dates).booked)??businessDay(business.bookedDay);}),
 ].filter((day):day is string=>!!day);
 const requestsOn=(from:string,to:string)=>requests.filter(r=>String(r.occurred_day)>=from&&String(r.occurred_day)<=to);
 const distinctContacts=(rows:Row[])=>rows.every(r=>r.identity_key)?new Set(rows.map(r=>r.identity_key)).size:null;
 const identityReason='Une soumission sans clé de contact : inscrits non mesurés (soumissions conservées).';
 const reachReason='CTR unique non mesuré : aucune lecture Meta des comptes touchés (reach) au niveau compte pour ce jour.';
 const daily: KpiFunnelDay[] = dates.map(date=> {
  const values=missing(),termReasons:Partial<Record<KpiCountField,string>>={};
  const metaDay=meta.days.get(date),ph=posthog.days.get(date);
  // Couverture par bloc et par jour (D3) : chaque bloc dépend de ses propres lectures.
  const blocks:KpiBlockCoverage={
   meta:!!metaDay&&metaSupported&&covers(metaDay.observedAt,date),
   forms:formsAvailable&&covers(formsAt,date),
   notion:formsAvailable&&!!notionRun&&covers(notionAt,date)&&covers(formsAt,date),
   commerce:formsAvailable&&!!notionRun&&!!clientsRun&&!!commerce?.available&&!!commerce.paidSales&&[commerceAt,clientsAt,formsAt,notionAt].every(at=>covers(at,date)),
   posthog:!!ph&&covers(ph.observedAt,date),
  };
  if(blocks.meta){const rows=metaDay!.rows.filter(r=>metaCampaigns.includes(String(r.data.campaignId)));for(const key of ['spend_eur','impressions','link_clicks','unique_link_clicks_campaign_sum','landing_page_views','booking_meta_attributed','outbound_clicks'] as const)values[key]=rows.length?sum(rows.map(r=>number(r.data[key]))):null;if(!rows.length)for(const key of ['spend_eur','impressions','link_clicks'] as const)termReasons[key]='Non mesuré : aucune ligne des campagnes Masterclass lue pour ce jour (jamais zéro).';
   // CTRU du jour : comptes uniques du niveau compte (dédoublonnés entre campagnes) ; pour une seule campagne, sa propre ligne. Jamais une somme d'uniques.
   const account=metaDay!.rows.find(r=>r.key===kpiAccountRowKey(metaCampaigns)),single=metaCampaigns.length===1&&rows.length===1?rows[0]:null;
   const unique=account?{reach:number(account.data.reach),clicks:number(account.data.unique_link_clicks)}:single?{reach:number(single.data.reach),clicks:number(single.data.unique_link_clicks_campaign_sum)}:null;
   Object.assign(termReasons,uniqueCounts(values,unique,reachReason));}
  if(blocks.forms){const day=requestsOn(date,date);values.wix_form_submission_occurrences=day.length;values.registrants=distinctContacts(day);if(values.registrants===null)termReasons.registrants=identityReason;}
  if(blocks.posthog){const rows=ph!.rows.filter(r=>!isExcludedTestTraffic({includeTests},r.data)&&matches(observationOrigin({origin:{...r.data,linkId:r.data.link},firstTouch:null})));values.booking_clicks=rows.filter(r=>r.data.kind==='click').reduce((n,r)=>n+Number(r.data.sessions),0);values.booking_confirmed_browser=rows.filter(r=>r.data.kind==='confirmed').reduce((n,r)=>n+Number(r.data.sessions),0);}
  if(cohortComplete&&blocks.notion){
   const calls=cohortAppointments.filter(a=>appointmentDay(a)===date);values.calls_scheduled=calls.filter(a=>isEffectiveAppointment(a,record(prospectById.get(String(a.prospect_id))?.business))).length;values.calls_held=calls.filter(a=>appointmentOutcome(a,record(prospectById.get(String(a.prospect_id))?.business),date)==='attended').length;
   values.calls_booked=bookingDays.filter(day=>day===date).length;
  } else if(!cohortComplete&&cohortNote)for(const key of ['calls_booked','calls_scheduled','calls_held','sales','cash_collected_eur'] as const)termReasons[key]=cohortNote;
  if(cohortComplete&&blocks.commerce){
   const payments=cohortPayments.filter(p=>p.day===date),unresolved=(commerce?.paidSales?.details??[]).some(p=>p.day===date&&(p.clientIds.length!==1||!clientPeople.has(p.clientIds[0]))&&p.state!=='excluded'),pending=unresolved||payments.some(p=>p.state==='pending'||p.state==='reconciled');
   values.sales=pending?null:payments.filter(p=>p.state==='confirmed').length;
   values.cash_collected_eur=pending?null:sum(payments.filter(p=>p.state==='confirmed'||p.reasons.includes('subsequent_payment_for_client')).map(p=>p.amountMinor===null?null:p.amountMinor/100))??(payments.length?null:0);
   if(pending){termReasons.sales='Un paiement du jour reste à rapprocher : ventes non mesurées.';termReasons.cash_collected_eur=termReasons.sales;}
  }
  return {date,partial_day:date>=today?'Journée en cours ou à venir':null,...values,...rowRatios(values,blocks,'day',termReasons)};
 });
 // Récapitulatifs de l'Excel : fenêtres finissant le dernier jour de la période ; sommes des jours puis taux des sommes.
 const lastDay=dates.at(-1)!,shift=(day:string,days:number)=>Temporal.PlainDate.from(day).add({days}).toString();
 const summaryStart:Record<typeof KPI_SUMMARY_KEYS[number],string>={global:filters.from,last_3_days:shift(lastDay,-2),last_7_days:shift(lastDay,-6)};
 const summaryName:Record<typeof KPI_SUMMARY_KEYS[number],string>={global:'Global',last_3_days:'3 derniers jours',last_7_days:'7 derniers jours'};
 const summaries: KpiFunnelSummary[] = KPI_SUMMARY_KEYS.map(key=> {
  const from=summaryStart[key],label=`${summaryName[key]} · du ${frenchDay(from)} au ${frenchDay(lastDay)}`,values=missing(),termReasons:Partial<Record<KpiCountField,string>>={};
  if(from<filters.from){
   const reason=`Non mesuré : la fenêtre commence le ${frenchDay(from)}, avant la période sélectionnée ; élargir la période pour la lire.`;
   return {key,label,from,to:lastDay,within_period:false,partial_day:null,...values,ratios:Object.fromEntries(KPI_RATIO_KEYS.map(k=>[k,null])) as KpiFunnelSummary['ratios'],blocks:Object.fromEntries(KPI_BLOCKS.map(b=>[b,false])) as KpiBlockCoverage,reasons:{window:reason,...Object.fromEntries(KPI_RATIO_KEYS.map(k=>[k,reason]))}};
  }
  const days=daily.filter(d=>d.date>=from&&d.date<=lastDay);
  const blocks=Object.fromEntries(KPI_BLOCKS.map(b=>[b,days.every(d=>d.blocks[b])])) as KpiBlockCoverage;
  for(const field of KPI_ADDITIVE_FIELDS)values[field]=sum(days.map(d=>d[field]));
  // Inscrits : contacts distincts de toute la fenêtre, jamais la somme des jours.
  values.registrants=days.every(d=>d.registrants!==null)?distinctContacts(requestsOn(from,lastDay)):null;
  for(const field of KPI_COUNT_FIELDS)if(values[field]===null){const reason=days.find(d=>d.reasons[field])?.reasons[field];if(reason)termReasons[field]=reason;}
  // CTRU du récapitulatif : lecture Meta de la fenêtre entière (dates égales, même jeu de campagnes), jamais une moyenne ni une somme de jours.
  const window=windows.get(kpiWindowId(from,nextDay(lastDay),kpiCampaignSetKey(metaCampaigns)));
  const windowReason=!window?'CTR unique non mesuré : fenêtre non lue à la source (jamais une moyenne ni une somme de jours).':!covers(window.observedAt,lastDay)?'CTR unique non mesuré : la lecture de la fenêtre précède la fin de son dernier jour.':!blocks.meta?'CTR unique non mesuré : Diffusion Meta ne couvre pas toute la fenêtre.':null;
  if(windowReason){termReasons.meta_reach=termReasons.meta_unique_link_clicks=windowReason;}
  else Object.assign(termReasons,uniqueCounts(values,window!.data?{reach:number(window!.data.reach),clicks:number(window!.data.unique_link_clicks)}:values.impressions===0?{reach:0,clicks:0}:null,'CTR unique non mesuré : la lecture de la fenêtre ne donne pas les comptes uniques (ou aucune diffusion alors que les jours en montrent).'));
  return {key,label,from,to:lastDay,within_period:true,partial_day:days.some(d=>d.partial_day)?'Inclut la journée en cours ou à venir':null,...values,...rowRatios(values,blocks,'window',termReasons)};
 });
 const totals = {...Object.fromEntries(KPI_COUNT_FIELDS.map(field=>[field,summaries[0][field]])) as KpiMeasures,wix_distinct_contacts:null as number|null,wix_repeat_occurrences:null as number|null};
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
 cover('Diffusion Meta',[{at:freshThrough(meta),job:'kpi_meta'}],metaSupported&&daily.every(r=>r.spend_eur!==null),metaSupported?'Campagnes masterclass identifiées ; absence de ligne différente de zéro.':'Ce filtre ne permet pas de répartir la dépense campagne. Les mesures Meta restent non mesurées.',meta.latestAttempt);
 const setWindows=[...windows.values()].filter(w=>w.key===kpiCampaignSetKey(metaCampaigns)).sort((a,b)=>a.to.localeCompare(b.to)||a.from.localeCompare(b.from));
 const ends=[...new Set(setWindows.map(w=>frenchDay(Temporal.PlainDate.from(w.to).subtract({days:1}).toString())))];
 cover('Fenêtres Meta (CTR unique)',[{at:setWindows.map(w=>w.observedAt).sort()[0]??null,job:'kpi_meta'}],metaSupported&&setWindows.length>0,setWindows.length?`Lectures Meta de la fenêtre entière (niveau compte, campagnes Masterclass) : ${[...new Set(setWindows.map(w=>Temporal.PlainDate.from(w.from).until(Temporal.PlainDate.from(w.to)).days))].sort((a,b)=>a-b).join(', ')} jours finissant le ${ends.join(' et le ')}. Un récapitulatif sans fenêtre lue reste non mesuré, jamais une moyenne ni une somme de jours.`:'Aucune fenêtre lue à la source pour ce jeu de campagnes : CTR unique des récapitulatifs non mesuré.');
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
  metadata:{dataset_id:'blg-kpi-automatic',schema_version:KPI_FUNNEL_SCHEMA_VERSION,mode:'automatic',include_tests:includeTests,generated_at:now,timezone:'Europe/Paris',window_start:isoParis(startOfParisDay(filters.from)),window_end_meta:isoParis(end),window_end_email:isoParis(end),window_end_commercial:isoParis(end),scope:'mixed_source_masterclass_monitoring',scope_note:'Période sélectionnée. Chaque bloc garde sa source, son groupe de personnes et sa date de lecture ; aucune conversion entre bases non rapprochées.',campaign_ids:metaCampaigns,exclusions:includeTests?[]:['Essais explicitement marqués']},
  definitions:defs,daily,totals,summaries,
  attribution_breakdown:{freshness:freshThrough(posthog)??now,metric:'Sessions de clic bilan ; lecture automatique.',rows:[...breakdown.values()],wix_submission_context:{arrival,selected_first_origin_else_arrival:selectedContext,rule:'Première origine canonique conservée ; sinon arrivée.',interpretation:'Le contexte ne prouve pas à lui seul la causalité publicitaire.',freshness:formsAt??now}},
  email_summary:{scope:'Activités email sur la période sélectionnée.',all_three_forms:{sent:emailTotal('sent',false),delivered:emailTotal('delivered',false),opens_sum_by_message:emailTotal('opens',false),clicks_sum_by_message:emailTotal('clicks',false)},facebook_form_recipient_filter:{submissions:totals.wix_form_submission_occurrences,distinct_emails:totals.wix_distinct_contacts,sent:emailTotal('sent',true),delivered:emailTotal('delivered',true),opens:emailTotal('opens',true),clicks:emailTotal('clicks',true)}},
  coverage,source_locators:[{source:'Meta',locator:'Collecte quotidienne par campagne, complète et datée.'},{source:'Wix',locator:'Formulaire masterclass actuel et séquence de neuf messages.'},{source:'PostHog',locator:'mc_booking_click / mc_booking_confirmed, production.'},{source:'Notion',locator:'Miroir prospects, créneaux et dernière publication commerciale complète.'}],
 };
 return {status:'ready',snapshot:kpiFunnelSnapshotSchema.parse(snapshot)};
}
