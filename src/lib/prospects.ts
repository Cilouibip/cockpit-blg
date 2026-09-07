import { allRows, type Database } from './db';
import type { ProspectsResponse,DataMode,Prospect } from './ui-contract';
export async function listProspects(db:Database,mode:DataMode):Promise<ProspectsResponse>{
  const [rows,appointments]=await Promise.all([allRows(db,'prospects'),allRows(db,'appointments')]);
  return {mode,updatedAt:rows.length?rows.map(r=>String(r.observed_at)).sort().at(-1)!:null,coverage:'État commercial observé depuis le premier import. Les dates courantes ne reconstituent pas les rendez-vous antérieurs.',notice:rows.length?undefined:'Aucun prospect commercial importé.',prospects:rows.filter(r=>!r.archived).map(r=>{
    const appt=appointments.filter(a=>a.prospect_id===r.id).sort((a,b)=>String(b.scheduled_at).localeCompare(String(a.scheduled_at)))[0];
    const status=appt?String(appt.status):'unknown';
    return {id:String(r.id),name:String(r.display_name||'Sans nom commercial'),owner:r.owner_label?String(r.owner_label):null,stage:String(r.source_status||'Non renseigné'),source:null,tunnel:null,appointmentAt:appt?.scheduled_at?String(appt.scheduled_at):r.current_appointment_at?String(r.current_appointment_at):null,appointmentStatus:(status==='scheduled'?'planned':status) as Prospect['appointmentStatus'],followUpAt:r.next_follow_up_at?String(r.next_follow_up_at):null,outcome:r.outcome?String(r.outcome):null,updatedAt:r.source_updated_at?String(r.source_updated_at):String(r.observed_at)};
  })};
}
