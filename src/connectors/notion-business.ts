import { emailIdentity } from '../domain/identity';
import { Temporal } from '@js-temporal/polyfill';

export const NOTION_BUSINESS_VERSION = 'notion-acquisition-known-v1';
export const NOTION_BUSINESS_FIELDS = {
 email: 'E-mail', emailBis: 'E-mail BIS', clients: 'Clients', createdAt: 'Date de création',
 acquisitionReal: 'Date acquisition reelle', acquisitionLegacy: 'Date Exponensia', acquisitionWix: 'Date Wix',
 bookedAt: 'Réservation faite le', closedAt: 'Date closing', attendanceGroup: "Groupe d'état Noshow",
 channels: 'Canal acquisition', tunnels: "Point d'entrée",
} as const;
export type BusinessField = keyof typeof NOTION_BUSINESS_FIELDS;
export interface NotionBusiness {
 version: string; identityKey: string | null; identityBasis: 'email_hmac' | null;
 createdAt: string | null; acquisitionDay: string | null; acquisitionBasis: string | null;
 dates: Record<string, string | null>; scheduledDay: string | null; bookedDay: string | null; closedDay: string | null;
 attendance: 'show_up' | 'no_show' | 'cancelled' | 'scheduled' | 'unknown';
 attendanceBasis: 'source_group' | 'explicit_finished' | 'source_status' | 'unknown';
 attendanceGroup: string | null; explicitFinished: boolean; clientIds: string[]; channels: string[]; tunnels: string[];
}
type Property = Record<string, unknown>;
const obj=(v:unknown):Property=>v&&typeof v==='object'&&!Array.isArray(v)?v as Property:{};
export function sourceBusinessDay(value:string|null,timezone='Europe/Paris'):string|null {
 if(!value)return null;
 return value.length===10?Temporal.PlainDate.from(value).toString():Temporal.Instant.from(value).toZonedDateTimeISO(timezone).toPlainDate().toString();
}
/** Fixed allowlist. No answers, health properties, free-form CRM bodies or raw contact details leave this adapter. */
export function normalizeNotionBusiness(properties:Property, options:{fields?:Partial<Record<BusinessField,string>>;identitySecret?:string;createdAt?:string|null;appointmentAt?:string|null;status?:string|null;timezone?:string;version?:string}):NotionBusiness {
 const fields=options.fields??NOTION_BUSINESS_FIELDS;
 const field=(key:BusinessField)=>{const name=fields[key]??'';return obj(properties[name]??Object.values(properties).find(v=>obj(v).id===name));};
 const date=(key:BusinessField)=>{const v=obj(field(key).date).start;return typeof v==='string'?v:null;};
 const created=field('createdAt').created_time;
 const createdAt=typeof created==='string'?created:options.createdAt??null;
 const dates={real:date('acquisitionReal'),legacy:date('acquisitionLegacy'),wix:date('acquisitionWix'),booked:date('bookedAt'),closed:date('closedAt'),appointment:options.appointmentAt??null};
 const basis=(['real','legacy','wix'] as const).find(k=>dates[k])??null;
 const rawEmail=field('email').email;
 const email=typeof rawEmail==='string'?rawEmail:'';
 // No silent weak-hash fallback: the application already has an identity HMAC secret.
 let identityKey:string|null=null;
 if(email&&options.identitySecret){try{identityKey=emailIdentity(email,options.identitySecret);}catch(error){if(!(error instanceof Error&&error.message==='INVALID_EMAIL'))throw error;}}
 const formula=obj(field('attendanceGroup').formula),group=typeof formula.string==='string'?formula.string:null;
 const status=options.status;
 const explicitFinished=status==='RDV Terminé';
 const contradictory=(group==='Show up'&&['Noshow','RDV Annulé'].includes(status??''))||(group==='Noshow'&&explicitFinished);
 const attendance=contradictory?'unknown':group==='Show up'?'show_up':group==='Noshow'||status==='Noshow'?'no_show':explicitFinished?'show_up':status==='RDV Annulé'?'cancelled':status==='RDV Programmé'?'scheduled':'unknown';
 const list=(key:BusinessField,type:'relation'|'multi_select')=>{const values=field(key)[type];return Array.isArray(values)?values.map(v=>obj(v)[type==='relation'?'id':'name']).filter((v):v is string=>typeof v==='string'):[];};
 const day=(v:string|null)=>sourceBusinessDay(v,options.timezone);
 return {version:options.version??NOTION_BUSINESS_VERSION,identityKey,identityBasis:identityKey?'email_hmac':null,createdAt,
  acquisitionDay:basis?day(dates[basis]):null,acquisitionBasis:basis,dates,scheduledDay:day(dates.appointment),bookedDay:day(dates.booked),closedDay:day(dates.closed),
  attendance,attendanceBasis:contradictory||attendance==='unknown'?'unknown':group==='Show up'||group==='Noshow'?'source_group':explicitFinished?'explicit_finished':'source_status',
  attendanceGroup:group,explicitFinished,clientIds:list('clients','relation'),channels:list('channels','multi_select'),tunnels:list('tunnels','multi_select')};
}
