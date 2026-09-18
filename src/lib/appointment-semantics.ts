import {Temporal} from '@js-temporal/polyfill';
import type {Row} from './db';

export type AppointmentOutcome='attended'|'no_show'|'cancelled'|'rescheduled'|'scheduled'|'unknown';
export function businessDay(value:unknown):string|null {
 if(typeof value!=='string')return null;
 try{return value.length===10?Temporal.PlainDate.from(value).toString():Temporal.Instant.from(value).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();}catch{return null;}
}
export function appointmentDay(appointment:Row):string|null {
 return businessDay(appointment.scheduled_at)??businessDay(appointment.scheduled_day);
}
/** Current Notion classification applies only to its own slot. A replaced slot never inherits its attendance. */
export function appointmentOutcome(appointment:Row,business:Row|null,day=appointmentDay(appointment)):AppointmentOutcome {
 const status=String(appointment.status??'unknown');
 if(status==='cancelled'||status==='rescheduled')return status;
 if(appointment.source_status==='RDV Reporté')return 'rescheduled';
 if(day&&business?.scheduledDay===day){
  if(business.attendance==='show_up')return 'attended';
  if(business.attendance==='no_show')return 'no_show';
  if(business.attendance==='cancelled')return 'cancelled';
  if(business.attendance==='scheduled')return 'scheduled';
  // The adapter explicitly flags contradictory source classifications as unknown.
  if(business.attendance==='unknown'&&business.attendanceBasis==='unknown')return 'unknown';
 }
 return ['attended','no_show','scheduled'].includes(status)?status as AppointmentOutcome:'unknown';
}
/** Booking date is the explicit source field, never a page creation/edit timestamp or the day of the call. */
export function appointmentBooking(appointment:Row,business:Row|null):{at:string|null;day:string|null} {
 const dates=business?.dates&&typeof business.dates==='object'?business.dates as Row:{};
 const sameSlot=appointment.identity_basis==='notion_current_slot'||!!appointmentDay(appointment)&&business?.scheduledDay===appointmentDay(appointment);
 const raw=appointment.booked_at??(sameSlot?dates.booked:null);
 let at:string|null=null;
 if(typeof raw==='string'&&raw.length>10)try{at=Temporal.Instant.from(raw).toString();}catch{/* A day-only value cannot prove a same-visit sequence. */}
 return {at,day:businessDay(raw)??(sameSlot?businessDay(business?.bookedDay):null)};
}
export function isEffectiveAppointment(appointment:Row,business:Row|null):boolean {
 return appointmentDay(appointment)!==null&&!['cancelled','rescheduled'].includes(appointmentOutcome(appointment,business));
}
export function isUpcomingAppointment(appointment:Row,now:string):boolean {
 try{if(typeof appointment.scheduled_at==='string')return Temporal.Instant.compare(appointment.scheduled_at,now)>=0;}catch{/* Fall back to the known day. */}
 const today=Temporal.Instant.from(now).toZonedDateTimeISO('Europe/Paris').toPlainDate().toString();
 const day=appointmentDay(appointment);return !!day&&day>=today;
}
