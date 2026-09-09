import { createHash } from 'node:crypto';
import { browserEventSchema, serverLeadSchema, verifyIngestionSignature, validateEventClock } from '../domain/ingestion';
import { emailIdentity } from '../domain/identity';
import type { Config } from './config';
import { database } from './db';
import { json, readBody, readRawBody } from './http';
import { AppError } from './errors';
import { rateLimit } from './rate-limit';
export function corsHeaders(request:Request,config:Config) {
  const origin=request.headers.get('origin');
  if(!origin || !config.allowedOrigins.includes(origin))throw new AppError('Origine de mesure non autorisée.',403,'origin_rejected');
  return {'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'};
}
export async function ingestBrowser(request:Request,config:Config) {
  const cors=corsHeaders(request,config);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='POST')throw new AppError('Méthode non autorisée.',405);
  const body=browserEventSchema.parse(await readBody(request));
  if(!validateEventClock(body.occurred_at))throw new AppError('Date de mesure hors fenêtre acceptée.',422,'event_time');
  await rateLimit(config,'browser-global','all',6000,60);
  await rateLimit(config,'browser-session',body.session_id,90,60);
  const result=await database().rpc('ingest_browser_event',{p_event:body,p_payload_hash:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
  return json({accepted:true,result},202,cors);
}
export async function ingestLead(request:Request,config:Config) {
  const raw=await readRawBody(request);
  if(!verifyIngestionSignature(raw,request.headers.get('x-blg-timestamp'),request.headers.get('x-blg-signature'),config.ingestSecret))throw new AppError('Signature d’enregistrement refusée.',401,'invalid_signature');
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new AppError('Le JSON est invalide.');}
  const body=serverLeadSchema.parse(value);
  if(!validateEventClock(body.registered_at,Date.now(),7*86400000))throw new AppError('Date d’inscription hors fenêtre acceptée.',422,'event_time');
  await rateLimit(config,'lead-global','all',500,60);
  if(config.identitySecret.length<32)throw new AppError('Le rapprochement des identités doit être configuré.',503,'identity_setup');
  const email=body.identity.email;
  const sanitized={...body,identity:{namespace:body.identity.namespace,external_id:body.identity.external_id,email_hmac:email?emailIdentity(email,config.identitySecret):null}};
  const result=await database().rpc('register_lead',{p_lead:sanitized,p_payload_hash:createHash('sha256').update(JSON.stringify(sanitized)).digest('hex')});
  return json({accepted:true,result},202);
}
