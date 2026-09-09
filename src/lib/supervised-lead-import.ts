import type {Database} from './db';
import {AppError} from './errors';
import {synchronizeLeadEntries,type LeadPageReader} from './sync-lead-entries';
import type {LeadEntryFamily} from '../connectors/wix-lead-entries';

/**
 * Deliberately has no Wix or Notion credential path: the caller supplies a
 * read-only, in-memory page reader built from a reviewed source extraction.
 * The existing worker remains the sole path that stages and atomically
 * publishes lead observations.
 */
export async function runSupervisedLeadImport(options:{
 db:Database;
 env:Record<string,string|undefined>;
 readers:Partial<Record<LeadEntryFamily,LeadPageReader>>;
 families:LeadEntryFamily[];
 authorization:'reviewed-supervised-import';
 maxRounds?:number;
}) {
 if(options.authorization!=='reviewed-supervised-import')throw new AppError('Cette importation doit être revue avant exécution.',403,'supervised_import_not_reviewed');
 const maxRounds=Math.min(Math.max(options.maxRounds??250,1),250);
 const outcomes:Record<string,unknown>={};
 for(const family of options.families){
  const reader=options.readers[family];
  if(!reader)throw new AppError(`Lecteur supervisé absent pour ${family}.`,422,'supervised_reader_missing');
  let result:Awaited<ReturnType<typeof synchronizeLeadEntries>>|undefined;
  for(let round=0;round<maxRounds;round++){
   result=await synchronizeLeadEntries(family,{db:options.db,env:options.env,reader,maxPages:5});
   if(result.status!=='partial')break;
  }
  if(!result||result.status==='partial')throw new AppError(`Lecture ${family} incomplète : aucun relevé partiel ne peut être publié.`,409,'supervised_source_incomplete');
  if(result.status==='failed')throw new AppError(`Lecture ${family} refusée : ${result.reason??'la source a signalé un échec'}.`,409,'supervised_source_failed');
  outcomes[family]=result;
 }
 return outcomes;
}
