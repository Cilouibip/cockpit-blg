import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '@/lib/config';
import { authenticate, cookieHeader, requireUser, requireOrigin } from '@/lib/auth';
import { json, readBody, errorResponse } from '@/lib/http';
import { AppError } from '@/lib/errors';
import { rateLimit } from '@/lib/rate-limit';
import { database } from '@/lib/db';
import { linkInputSchema, linkMutationSchema, listLinks, saveLink } from '@/lib/links';
import { connections } from '@/lib/connections';
import { defaultCommercialQuery, invalidateCommercialSnapshot, loadCommercialDashboard } from '@/lib/commercial-dashboard';
import { writeLinkThenRead } from '@/lib/link-write-result';
import { listProspects } from '@/lib/prospects';
import { dashboard, dashboardDetails, emptyDashboard, parseFilters } from '@/lib/dashboard';
import { synchronize } from '@/lib/sync';
import { synchronizeWix } from '@/lib/sync-wix';
import { postHogPeriod,postHogMasterclassPeriod,postHogScopeFromFilters } from '@/lib/posthog-dashboard';
import { synchronizeWixTransactionCounts } from '@/lib/wix-transaction-counts';
import { tickSyncJobs } from '@/lib/sync-jobs';
import { synchronizeLeadEntries } from '@/lib/sync-lead-entries';
import { postHogReportRequest,requestPostHogReport } from '@/lib/posthog-report-request';
import { invalidateSourceWindow } from '@/lib/source-snapshots';
import { Temporal } from '@js-temporal/polyfill';
import { ingestBrowser, ingestLead } from '@/lib/ingest';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
async function syncSource(source:'meta'|'notion'|'wix'|'receipts',from?:string,to?:string) {
 if(source==='meta'||source==='notion'){
  const result=await synchronize(source,from,to);
  if(source==='notion'&&['complete','empty'].includes(result.status))invalidateCommercialSnapshot(database());
  return result;
 }
 const today=Temporal.Now.plainDateISO('Europe/Paris');
 const start=from??today.with({day:1}).toString(),end=to??today.add({days:1}).toString();
 return source==='receipts'?synchronizeWixTransactionCounts(start,end):synchronizeWix(start,end);
}
const syncHttpStatus=(status:string|undefined)=>status==='complete'||status==='empty'?200:status==='failed'?502:207;
async function handle(request:Request){
 try{
  const config=getConfig(),url=new URL(request.url),route=url.pathname.replace(/^\/api\//,''),method=request.method;
  if(route==='ingest/events')return await ingestBrowser(request,config);
  if(route==='ingest/leads'&&method==='POST')return await ingestLead(request,config);
  if(route==='login'&&method==='POST'){
   requireOrigin(request,config);await rateLimit(config,'login','shared',10,600);
   const body=z.object({password:z.string().min(1).max(256)}).strict().parse(await readBody(request,1500));
   return json({ok:true},200,{'Set-Cookie':cookieHeader(authenticate(body.password,config),config)});
  }
  if(route.startsWith('jobs/')&&method==='GET'){
   const supplied=request.headers.get('authorization')||'',expected='Bearer '+config.cronSecret;
   if(config.cronSecret.length<32||supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw new AppError('Accès refusé.',401,'unauthorized');
   if(route==='jobs/tick'){const result=await tickSyncJobs();return json(result,syncHttpStatus(result.status));}
   const source=z.enum(['meta','notion','wix']).parse(route.slice(5));await rateLimit(config,'sync',source,2,60);const result=await syncSource(source);return json(result,syncHttpStatus(result.status));
  }
  requireUser(request,config);
  if(!['GET','HEAD'].includes(method))requireOrigin(request,config);
  if(route==='logout'&&method==='POST')return json({ok:true},200,{'Set-Cookie':cookieHeader('',config,true)});
  if(route==='connections'&&method==='GET')return json(await connections());
  if(route==='dashboard'&&method==='GET'){
   const filters=parseFilters(url),db=database();
   if(url.searchParams.get('refreshPosthog')==='1'){
    const days=Temporal.PlainDate.from(filters.from).until(Temporal.PlainDate.from(filters.to)).days+1;
    const previous={...filters,from:Temporal.PlainDate.from(filters.from).subtract({days}).toString(),to:Temporal.PlainDate.from(filters.from).subtract({days:1}).toString(),compare:false};
    for(const selected of filters.compare?[filters,previous]:[filters])for(const type of ['quiz','masterclass'] as const){
     const descriptor=postHogReportRequest(selected,type);if(descriptor)invalidateSourceWindow(db,'posthog',descriptor.namespace,{stream:descriptor.stream,profile:descriptor.profile,from:descriptor.from,to:descriptor.to,timezone:'Europe/Paris',currency:null,currencyExponent:null,kind:'exact_report'});
    }
   }
   try{return json(await dashboard(db,filters,config.mode));}catch(e){if(e instanceof AppError&&['schema_missing','database_missing'].includes(e.code))return json(emptyDashboard(filters,config.mode));throw e;}
  }
  if(route==='reports/posthog'&&(method==='GET'||method==='POST')){
   const filters=parseFilters(url),type=z.enum(['quiz','masterclass']).parse(url.searchParams.get('type'));
   if(method==='GET'){const descriptor=postHogReportRequest(filters,type);return json({key:descriptor?.key??null,supported:!!descriptor});}
   if(config.mode==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
   await rateLimit(config,'report','posthog',24,60);
   const result=await requestPostHogReport(filters,type);
   return json(result,{ready:200,waiting:202,failed:502,unsupported:422}[result.state]);
  }
  if(route==='attribution'&&method==='GET'){const id=z.uuid().parse(url.searchParams.get('run'));const result=await database().rpc<{run:unknown;results:unknown[]}>('cockpit_attribution_detail',{p_run:id});if(!result.run)throw new AppError('Calcul publié introuvable.',404,'not_found');return json(result);}
  if(route==='details'&&method==='GET')return json(await dashboardDetails(database(),parseFilters(url),z.coerce.number().int().min(0).max(100000).parse(url.searchParams.get('page')||0)));
  if(route==='commercial'&&method==='GET'){
   const day=z.iso.date().optional().parse(url.searchParams.get('day')||undefined),from=z.iso.date().optional().parse(url.searchParams.get('from')||undefined),to=z.iso.date().optional().parse(url.searchParams.get('to')||undefined),scope=z.enum(['all']).optional().parse(url.searchParams.get('scope')||undefined);
   if((from&&!to)||(!from&&to)||(from&&to&&from>to)||(scope==='all'&&!!(day||from||to)))throw new AppError('La période demandée est invalide.',400,'invalid_period');
   const base=defaultCommercialQuery(day??new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
   const query={...base,from:scope==='all'?null:from??base.from,to:scope==='all'?null:to??base.to,view:z.enum(['appointments','prospects','followups']).parse(url.searchParams.get('view')||'appointments'),page:z.coerce.number().int().min(0).max(100000).parse(url.searchParams.get('page')||'0'),pageSize:z.coerce.number().int().min(1).max(50).parse(url.searchParams.get('pageSize')||'50'),search:z.string().max(100).parse(url.searchParams.get('q')||''),origin:z.string().max(120).parse(url.searchParams.get('origin')||'all'),status:z.string().max(120).parse(url.searchParams.get('status')||'all'),attendance:z.enum(['all','present','absent','planned','cancelled','rescheduled','unknown']).parse(url.searchParams.get('attendance')||'all'),owner:z.string().max(120).parse(url.searchParams.get('owner')||'all'),nextAction:z.enum(['all','recorded','missing']).parse(url.searchParams.get('nextAction')||'all'),followUp:z.enum(['all','overdue','today','upcoming']).parse(url.searchParams.get('followUp')||'all')};
   return json(await loadCommercialDashboard(database(),config.mode,query));
  }
  if(route==='prospects'&&method==='GET')return json(await listProspects(database(),config.mode,z.string().max(200).parse(url.searchParams.get('search')||''),z.string().max(200).parse(url.searchParams.get('stage')||''),z.coerce.number().int().min(0).max(100000).parse(url.searchParams.get('page')||0)));
  if(route==='links'){
   const db=database();
   if(method==='POST'){
    const input=linkInputSchema.parse(await readBody(request));
    const id=z.uuid().optional().parse(request.headers.get('X-BLG-Link-Id')??undefined);
    return json(await writeLinkThenRead({save:()=>saveLink(db,input,id),read:()=>listLinks(db,config.mode)}));
   }
   if(method==='PATCH'){
    const input=linkMutationSchema.parse(await readBody(request));
    return json(await writeLinkThenRead({save:()=>input.action==='revise'?saveLink(db,input.input,input.id,input.expectedVersion):db.rpc('archive_tracked_link',{p_link_id:input.id,p_archived:input.action==='archive',p_expected_version:input.expectedVersion}),read:()=>listLinks(db,config.mode)}));
   }
   if(method!=='GET')throw new AppError('Méthode non autorisée.',405,'method_not_allowed');
   return json(await listLinks(db,config.mode));
  }
  if(route==='sync/analytics'&&method==='POST'){
   if(config.mode==='demo')throw new AppError('Données de démonstration.',409,'demo_mode');
   const filters=parseFilters(url),to=Temporal.PlainDate.from(filters.to).add({days:1}).toString();
   await rateLimit(config,'sync','analytics',12,60);
   const type=z.enum(['quiz','masterclass']).parse(url.searchParams.get('type')??(filters.tunnel==='masterclass'?'masterclass':'quiz'));
   const scope=postHogScopeFromFilters(filters);
   if(!scope||(type==='masterclass'&&(scope.source!=='all'||scope.campaignId)))throw new AppError('Ce filtre n’est pas raccordé à ce parcours.',422,'unsupported_scope');
   const result=type==='masterclass'?await postHogMasterclassPeriod(filters.from,to):await postHogPeriod(filters.from,to,{scope});
   const status=result?.status??'failed';
   return json({status,sources:[{source:type,status}]},syncHttpStatus(status));
  }
  if(route==='sync/lead-entries'&&method==='POST'){
   const family=z.enum(['forms','quiz','client_history']).parse(url.searchParams.get('family'));
   await rateLimit(config,'sync','lead_entries_'+family,60,60);
   const result=await synchronizeLeadEntries(family);
   return json(result,syncHttpStatus(result.status));
  }
  if(route.startsWith('sync/')&&method==='POST'){
   const source=z.enum(['meta','notion','wix','receipts']).parse(route.slice(5));
   await rateLimit(config,'sync',source,source==='notion'?60:12,60);
   const selected=url.searchParams.has('from')?parseFilters(url):null;
   const to=selected?Temporal.PlainDate.from(selected.to).add({days:1}).toString():undefined;
   const result=await syncSource(source,selected?.from,to);
   return json(result,syncHttpStatus(result.status));
  }
  throw new AppError('Page introuvable.',404,'not_found');
 }catch(e){return errorResponse(e);}
}
export const GET=handle;export const POST=handle;export const PATCH=handle;export const OPTIONS=handle;
