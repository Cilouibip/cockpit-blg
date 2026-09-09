import type {Database} from './db';
import type {DashboardFilters,LeadDefinitions} from './ui-contract';
import {wixLeadEntryConfig,leadEntryProfile} from '../connectors/wix-lead-entries';
import {notionClientHistoryConfig} from '../connectors/notion-client-history';
import {AppError} from './errors';

/** Optional parallel definitions until the business meaning of the Leads card is selected. */
export async function readLeadDefinitions(db:Database,filters:DashboardFilters,to:string,env:Record<string,string|undefined>=process.env):Promise<LeadDefinitions|null> {
 const config=wixLeadEntryConfig(env.WIX_LEAD_ENTRY_CONFIG);
 if(!config||!env.WIX_SITE_ID)return null;
 const scope=filters.source==='all'&&filters.tunnel==='all'&&(!filters.campaign||filters.campaign==='all');
 if(!scope)return {available:false,sourceBasis:'Wix + Notion',definitionState:'first_contact',firstKnownAcquisitions:null,peopleWithRequests:null,sourceRequestPeople:null,requestCount:null,unresolvedDatedRequests:null,unresolvedNotionRows:null,earlierClientEvidence:null,knownBeforePeriod:null,excludedSourceRequests:null,observedAt:null,families:[],reason:'Le rapprochement des inscriptions avec ce filtre source, campagne ou parcours reste à établir.'};
 try{
  const client=notionClientHistoryConfig(env);
  const activeScope={...(config.formIds.length?{forms:{profile:leadEntryProfile('forms',config),containerIds:config.formIds}}:{}),...(config.quiz?{quiz:{profile:leadEntryProfile('quiz',config),containerIds:[config.quiz.collectionId]}}:{}),...(client?{client_history:{profile:leadEntryProfile('client_history',client),containerIds:[client.dataSourceId]}}:{})};
  const result=await db.rpc<LeadDefinitions>('cockpit_lead_entry_rollup_v2',{p_wix_namespace:env.WIX_SITE_ID,p_notion_namespace:env.NOTION_DATA_SOURCE_ID??null,p_client_namespace:env.NOTION_CLIENT_DATA_SOURCE_ID??null,p_from:filters.from,p_to:to,p_scope:activeScope});
  const expected=[...(config.formIds.length?['forms']:[]),...(config.quiz?['quiz']:[]),...(env.NOTION_CLIENT_DATA_SOURCE_ID?['client_history']:[])];
  result.missingFamilies=expected.filter(f=>!result.families.some(x=>x.family===f));
  if(result.missingFamilies.length)result.reason+=' Une famille configurée n’a pas encore de relevé publié.';
  if(result.mappingPending?.length)result.reason+=' Le nouveau mapping n’est pas publié : les dernières observations validées restent affichées avec leur ancien mapping.';
  if(!result.available)for(const key of ['firstKnownAcquisitions','peopleWithRequests','sourceRequestPeople','requestCount','unresolvedDatedRequests','unresolvedNotionRows','earlierClientEvidence','knownBeforePeriod','excludedSourceRequests'] as const)result[key]=null;
  return result;
 }catch(e){if(e instanceof AppError&&e.code==='schema_missing')return null;throw e;}
}
