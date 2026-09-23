import type { ConnectionsResponse, Connection } from './ui-contract';
import { commerceReaderMode, getConfig } from './config';
import { database, type Database } from './db';
import { configuredJobScope, type SyncJob } from './sync-jobs';
import {connectionFreshness, type SyncRun} from './sync-freshness';
export {latestConnectionRun,connectionFreshness} from './sync-freshness';
const connectionJobs:{job:SyncJob;source:string;stream:string}[]=[
  {job:'kpi_meta',source:'meta',stream:'kpi_meta_daily'},
  {job:'kpi_posthog',source:'posthog',stream:'kpi_posthog_daily'},
  {job:'kpi_email',source:'wix',stream:'kpi_wix_daily'},
  {job:'meta_ads',source:'meta',stream:'ad_daily'},
  {job:'notion',source:'notion',stream:'prospects_business'},
  {job:'wix',source:'wix',stream:'payments_analytics'},
  {job:'forms',source:'wix',stream:'lead_entries_forms'},
  {job:'quiz_entries',source:'wix',stream:'lead_entries_quiz'},
  {job:'commerce',source:'notion',stream:'commerce_declared_snapshot'},
  {job:'quiz',source:'posthog',stream:'quiz_observations'},
  {job:'masterclass',source:'posthog',stream:'masterclass_observations'},
];
export async function readConnectionRuns(db:Database,env:NodeJS.ProcessEnv=process.env):Promise<SyncRun[]> {
  const results=await Promise.allSettled(connectionJobs.map(async definition=>{
    // Configuration seule : une lecture suspendue garde ses dates réelles de publication.
    const scope=configuredJobScope(definition.job,env);if(!scope)return [];
    const eq={source:definition.source,source_namespace:scope.namespace,stream_key:definition.stream,query_profile_key:scope.profile};
    const columns=['source','stream_key','status','started_at','finished_at','period_from','period_to','pagination_complete','rows_read','error_code'];
    const [attempts,published]=await Promise.all([
      db.select('sync_runs',{eq,columns,order:'started_at',descending:true,limit:1}),
      db.select('sync_runs',{eq:{...eq,pagination_complete:'true'},in:{status:['complete','empty']},columns,order:'finished_at',descending:true,limit:1}),
    ]);
    if(definition.job==='commerce'){const checkpoints=await db.select('sync_runs',{eq:{...eq,stream_key:'commerce_reader_checkpoint',status:'failed'},columns,order:'started_at',descending:true,limit:1});return [...attempts,...published,...checkpoints.map(row=>({...row,stream_key:definition.stream}))];}
    return [...attempts,...published];
  }));
  return results.flatMap(result=>result.status==='fulfilled'?result.value:[]);
}
export async function connections(db?:Database,env:NodeJS.ProcessEnv=process.env):Promise<ConnectionsResponse> {
  const config=getConfig(env);let available=false;let runs:Record<string,unknown>[]=[];let firstParty:{eventAt:string|null;leadAt:string|null}={eventAt:null,leadAt:null};
  try {const store=db??database();await store.probe();available=true;const state=await store.rpc<{runs:Record<string,unknown>[];firstParty:typeof firstParty}>('cockpit_connection_status',{});firstParty=state.firstParty;runs=await readConnectionRuns(store,env);}catch{/* Never replace current-profile data with an unrelated historical stream. */}
  const connection=(id:string,name:string,streams:string[],configured:boolean,limits:string[],syncable=false,source=id,paused=false):Connection=>{
    const freshness=connectionFreshness(runs,source,streams),last=freshness.last;const complete=last?.status==='complete';
    const demo=config.mode==='demo';
    // Suspendue : état explicite, date réelle de la dernière publication complète, aucun bouton de lecture.
    return {id,name,status:demo?'demo':!configured?'missing':paused?'paused':freshness.failed?'error':freshness.fresh&&!freshness.running?'connected':'partial',
      summary:demo?'Données synthétiques de test.':!configured?'Connexion à renseigner.':!available?'La base du cockpit ne répond pas.':paused?(freshness.lastSyncAt?'Lecture suspendue. La dernière publication complète reste affichée ; aucune nouvelle lecture n’est lancée depuis le cockpit.':'Lecture suspendue. Aucune publication complète n’est enregistrée.'):!last?'La date de la dernière mise à jour est indisponible.':freshness.failed?'La dernière tentative a échoué. Les données déjà enregistrées restent disponibles.':freshness.running?'Une mise à jour est en cours. Les données précédentes restent affichées.':!freshness.allPublished?'Une partie des données attend encore sa première mise à jour complète.':freshness.fresh?'Les données ont été actualisées dans la dernière heure.':'Les données ont plus d’une heure. Une nouvelle mise à jour est nécessaire.',
      lastSyncAt:freshness.lastSyncAt,lastAttemptAt:freshness.lastAttemptAt,dataAsOf:freshness.dataAsOf,coverage:last?(id==='notion'?`${last.rows_read||0} fiches parcourues pendant la dernière tentative · ${complete?'lecture complète':'lecture à poursuivre'}.`:`Dernière tentative : ${last.rows_read||0} lignes lues.`):'Aucune lecture complète disponible.',limits,canSync:!demo&&configured&&available&&syncable&&!paused};
  };
  return {mode:config.mode,connections:[
    {id:'database',name:'Base du cockpit',status:config.mode==='demo'?'demo':available?'connected':'missing',summary:available?(config.mode==='demo'?'PostgreSQL local, données synthétiques.':'Tables accessibles dans Supabase.'):'Migration Supabase à installer.',lastSyncAt:null,coverage:available?'Persistance disponible.':'Aucune donnée métier chargée.',limits:config.mode==='demo'?['Ce mode local est interdit sur Vercel.']:['Les données restent dans le projet Supabase du cockpit.'],canSync:false},
    connection('kpi_meta','Meta · tableau quotidien',['kpi_meta_daily'],!!env.META_ACCESS_TOKEN,['Campagnes et dates du tableau ; relevé complet requis.'],false,'meta'),
    connection('kpi_posthog','PostHog · clics et confirmations du tableau',['kpi_posthog_daily'],!!env.POSTHOG_PERSONAL_API_KEY,['Sessions de production ; première origine et essais explicites.'],false,'posthog'),
    connection('kpi_email','Wix · emails de suivi',['kpi_wix_daily'],!!env.WIX_API_KEY,['Séquence existante de neuf messages ; activité par destinataire pseudonymisé, pas de preuve du formulaire déclencheur.'],false,'wix'),
    connection('meta','Meta Ads',['ad_daily'],!!env.META_ACCESS_TOKEN&&!!env.META_AD_ACCOUNT_ID,['Statistiques rapportées par Meta, séparées de l’attribution commerciale.','Réponse vide distincte de dépenses nulles.'],true),
    connection('notion','Notion · commercial',['prospects_business'],!!env.NOTION_TOKEN&&!!env.NOTION_DATA_SOURCE_ID,['Lecture des propriétés commerciales autorisées uniquement.','Dates métier historiques conservées ; créations seules signalées à part. Présences selon classification courante Notion, sans reconstituer les créneaux remplacés.'],true),
    connection('wix','Wix · encaissements',['payments_analytics'],!!env.WIX_API_KEY,['CA issu de la synthèse des paiements Wix, actualisé pour la période choisie.','Périmètre Wix seulement ; rapprochement historique Notion et paiements par client encore incomplet.'],true),
    connection('wix_inscriptions','Wix · inscriptions (quiz et masterclass)',['lead_entries_forms','lead_entries_quiz'],!!env.WIX_API_KEY&&!!env.WIX_LEAD_ENTRY_CONFIG,['Inscriptions lues dans les formulaires et la collection du quiz ; une inscription non lue n’est pas une absence.','La clé serveur doit pouvoir lire les formulaires et le contenu du site (CMS) ; sinon l’import supervisé reste la voie.'],true,'wix'),
    connection('notion_commerce','Notion · ventes payées',['commerce_declared_snapshot'],!!env.NOTION_TOKEN&&!!env.NOTION_COMMERCE_CONFIG,['Paiements, échéanciers et parcours lus en entier ; une vente = premier paiement admissible, trois mensualités = une vente.','Reprise au point enregistré ; la dernière publication reste affichée pendant une lecture.'],true,'notion',commerceReaderMode(env)==='paused'),
    connection('posthog_quiz','PostHog · Quiz',['quiz_observations'],!!env.POSTHOG_PERSONAL_API_KEY,['Étapes et visiteurs du quiz mesurés pour la période interrogée.','Données agrégées ; inscriptions serveur et rattachement aux ventes distincts.'],false,'posthog'),
    connection('posthog_masterclass','PostHog · Masterclass',['masterclass_observations'],!!env.POSTHOG_PERSONAL_API_KEY,['Rapports de la masterclass26, séparés du quiz.','Une lecture interrompue conserve le dernier rapport complet.'],false,'posthog'),
    firstParty.leadAt?{id:'first_party',name:'Quiz et masterclass',status:config.mode==='demo'?'demo':'partial',summary:'Inscriptions serveur reçues. Couverture de la collecte à valider.',lastSyncAt:firstParty.leadAt,coverage:'Premier raccord observé ; un enregistrement ne prouve pas une couverture exhaustive.',limits:['Observations navigateur et inscriptions serveur distinctes.','Vérifier le parcours réel de bout en bout après installation.'],canSync:false}:connection('first_party','Quiz et masterclass',[],false,['Snippets préparés à transmettre aux responsables des pages.','Installation et premier enregistrement serveur signé à vérifier après déploiement.']),
  ]};
}
