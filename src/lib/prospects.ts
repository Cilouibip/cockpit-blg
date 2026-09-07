import type {Database} from './db';
import type {ProspectsResponse,DataMode} from './ui-contract';
export async function listProspects(db:Database,mode:DataMode,search='',stage='',page=0):Promise<ProspectsResponse>{
 const rows=await db.rpc<Omit<ProspectsResponse,'mode'|'coverage'>>('cockpit_prospects_page',{p_search:search,p_stage:stage,p_page:page,p_page_size:50});
 return {...rows,mode,coverage:'État commercial observé depuis le premier import. Les dates courantes ne reconstituent pas les rendez-vous antérieurs.',notice:rows.pagination?.total===0?'Aucun prospect correspondant.':undefined};
}
