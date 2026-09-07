import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Row } from './db';
import { allRows } from './db';
import type { LinkInput, LinksResponse, DataMode, LinkRevision } from './ui-contract';
import { AppError } from './errors';
export const linkInputSchema=z.object({placement:z.enum(['instagram_bio','youtube_description','meta_ad','email','other']),destination:z.enum(['quiz','masterclass']),campaign:z.string().trim().min(1).max(100),label:z.string().trim().min(1).max(120)}).strict();
export const linkMutationSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('revise'),id:z.uuid(),expectedVersion:z.number().int().positive(),input:linkInputSchema}).strict(),
  z.object({action:z.enum(['archive','restore']),id:z.uuid(),expectedVersion:z.number().int().positive().optional()}).strict()
]);
export const placements={instagram_bio:{source:'instagram',medium:'organic_social'},youtube_description:{source:'youtube',medium:'organic_video'},meta_ad:{source:'meta',medium:'paid_social'},email:{source:'newsletter',medium:'email'},other:{source:'unknown',medium:'unknown'}};
export const destinations={quiz:'https://quizz.blg-studio.fr/',masterclass:'https://www.blg-studio.fr/blg-rugby-mc'};
const slug=(s:string)=>s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
export function makeRevision(input:LinkInput,linkId:string=randomUUID(),version=1,id:string=randomUUID(),now=new Date().toISOString()) {
  const data=linkInputSchema.parse(input); const p=placements[data.placement];const url=new URL(destinations[data.destination]);
  for(const [k,v] of Object.entries({utm_source:p.source,utm_medium:p.medium,utm_campaign:slug(data.campaign)||'campagne',utm_content:slug(data.label)||'lien',utm_term:data.placement,blg_link_id:id}))url.searchParams.set(k,v);
  if(data.placement==='meta_ad')for(const [k,v] of Object.entries({meta_campaign_id:'{{campaign.id}}',meta_adset_id:'{{adset.id}}',meta_ad_id:'{{ad.id}}'}))url.searchParams.set(k,v);
  return {id,link_id:linkId,version,label:data.label,placement:data.placement,tunnel:data.destination,campaign:data.campaign,source:p.source,medium:p.medium,destination_url:destinations[data.destination],generated_url:url.href.replace(/%7B%7B(ad|adset|campaign)\.id%7D%7D/g,'{{$1.id}}'),created_at:now};
}
function mapRevision(r:Row):LinkRevision {return {id:String(r.id),version:Number(r.version),url:String(r.generated_url),createdAt:String(r.created_at),placement:r.placement as LinkInput['placement'],destination:r.tunnel as LinkInput['destination'],campaign:String(r.campaign),label:String(r.label)};}
export async function listLinks(db:Database,mode:DataMode):Promise<LinksResponse> {
  const [links,revisions]=await Promise.all([allRows(db,'tracked_links'),allRows(db,'link_revisions')]);
  return {mode,persistent:true,links:links.map(link=>{const versions=revisions.filter(r=>r.link_id===link.id).sort((a,b)=>Number(b.version)-Number(a.version)).map(mapRevision);if(!versions.length)throw new AppError('Un lien est incomplet.',503,'integrity_error');return {id:String(link.id),archived:!!link.archived_at,current:versions[0],revisions:versions};})};
}
export async function saveLink(db:Database,input:LinkInput,id?:string,expectedVersion=0) {
  const revision=makeRevision(input,id,expectedVersion+1);
  await db.rpc('save_tracked_link',{p_link_id:revision.link_id,p_revision:revision,p_expected_version:expectedVersion});
  return revision;
}
