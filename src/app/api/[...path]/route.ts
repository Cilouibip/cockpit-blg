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
import { listProspects } from '@/lib/prospects';
import { dashboard, dashboardDetails, emptyDashboard, parseFilters } from '@/lib/dashboard';
import { synchronize } from '@/lib/sync';
import { synchronizeWix } from '@/lib/sync-wix';
import { Temporal } from '@js-temporal/polyfill';
import { ingestBrowser, ingestLead } from '@/lib/ingest';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
async function syncSource(source:'meta'|'notion'|'wix') {
 if(source!=='wix')return synchronize(source);
 const today=Temporal.Now.plainDateISO('Europe/Paris');
 return synchronizeWix(today.with({day:1}).toString(),today.add({days:1}).toString());
}
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
   const source=z.enum(['meta','notion','wix']).parse(route.slice(5));await rateLimit(config,'sync',source,2,60);return json(await syncSource(source));
  }
  requireUser(request,config);
  if(!['GET','HEAD'].includes(method))requireOrigin(request,config);
  if(route==='logout'&&method==='POST')return json({ok:true},200,{'Set-Cookie':cookieHeader('',config,true)});
  if(route==='connections'&&method==='GET')return json(await connections());
  if(route==='dashboard'&&method==='GET'){
   const filters=parseFilters(url);try{return json(await dashboard(database(),filters,config.mode));}catch(e){if(e instanceof AppError&&['schema_missing','database_missing'].includes(e.code))return json(emptyDashboard(filters,config.mode));throw e;}
  }
  if(route==='attribution'&&method==='GET'){const id=z.uuid().parse(url.searchParams.get('run'));const result=await database().rpc<{run:unknown;results:unknown[]}>('cockpit_attribution_detail',{p_run:id});if(!result.run)throw new AppError('Calcul publié introuvable.',404,'not_found');return json(result);}
  if(route==='details'&&method==='GET')return json(await dashboardDetails(database(),parseFilters(url),z.coerce.number().int().min(0).max(100000).parse(url.searchParams.get('page')||0)));
  if(route==='prospects'&&method==='GET')return json(await listProspects(database(),config.mode,z.string().max(200).parse(url.searchParams.get('search')||''),z.string().max(200).parse(url.searchParams.get('stage')||''),z.coerce.number().int().min(0).max(100000).parse(url.searchParams.get('page')||0)));
  if(route==='links'){
   const db=database();
   if(method==='POST'){const input=linkInputSchema.parse(await readBody(request));await saveLink(db,input);}
   else if(method==='PATCH'){const input=linkMutationSchema.parse(await readBody(request));if(input.action==='revise')await saveLink(db,input.input,input.id,input.expectedVersion);else await db.rpc('archive_tracked_link',{p_link_id:input.id,p_archived:input.action==='archive',p_expected_version:input.expectedVersion});}
   else if(method!=='GET')throw new AppError('Méthode non autorisée.',405,'method_not_allowed');
   return json(await listLinks(db,config.mode));
  }
  if(route.startsWith('sync/')&&method==='POST'){const source=z.enum(['meta','notion','wix']).parse(route.slice(5));await rateLimit(config,'sync',source,2,60);return json(await syncSource(source));}
  throw new AppError('Page introuvable.',404,'not_found');
 }catch(e){return errorResponse(e);}
}
export const GET=handle;export const POST=handle;export const PATCH=handle;export const OPTIONS=handle;
