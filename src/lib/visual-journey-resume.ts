import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {PostHogQueryContinuation} from '../connectors/posthog-query';
import {AppError} from './errors';
export type VisualJourneyContinuation=Partial<Record<'identity'|'overview',PostHogQueryContinuation>>;
export type VisualJourneyResume={queries:VisualJourneyContinuation;expiresAt:number};
const key=(secret:string)=>{if(secret.length<32)throw new AppError('La session privée doit être configurée.',503,'session_missing');return createHash('sha256').update('blg-journey-resume-v1:'+secret).digest();};
const scopeHash=(scope:unknown)=>createHash('sha256').update(JSON.stringify(scope)).digest('hex');
/** Short-lived encrypted server continuation. Contains query handles only, no visitor or CRM data. */
export function sealJourneyResume(state:VisualJourneyResume,scope:unknown,secret:string):string {
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv);cipher.setAAD(Buffer.from(scopeHash(scope)));
 const body=Buffer.from(JSON.stringify(state));if(body.length>6000)throw new Error('RESUME_TOO_LARGE');
 return Buffer.concat([iv,cipher.update(body),cipher.final(),cipher.getAuthTag()]).toString('base64url');
}
export function openJourneyResume(token:string,scope:unknown,secret:string,now=Date.now()):VisualJourneyResume {
 try{
  if(token.length>8500||!/^[A-Za-z0-9_-]+$/.test(token))throw new Error();const raw=Buffer.from(token,'base64url');if(raw.length<29)throw new Error();
  const decipher=createDecipheriv('aes-256-gcm',key(secret),raw.subarray(0,12));decipher.setAAD(Buffer.from(scopeHash(scope)));decipher.setAuthTag(raw.subarray(-16));
  const state=JSON.parse(Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]).toString()) as VisualJourneyResume;
  if(!Number.isSafeInteger(state.expiresAt)||state.expiresAt<=now||state.expiresAt>now+300000||!state.queries||typeof state.queries!=='object'||Array.isArray(state.queries)||Object.keys(state.queries).some(k=>!['identity','overview'].includes(k)))throw new Error();
  return state;
 }catch{throw new AppError('Cette lecture a expiré. Actualise le parcours.',400,'invalid_journey_resume');}
}
