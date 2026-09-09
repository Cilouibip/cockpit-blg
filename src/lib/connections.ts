import type { ConnectionsResponse, Connection } from './ui-contract';
import { getConfig } from './config';
import { database } from './db';
type SyncRun=Record<string,unknown>;
export function latestConnectionRun(runs:SyncRun[],source:string,streams:string[]):SyncRun|undefined {
  return runs.filter(run=>run.source===source&&streams.includes(String(run.stream_key))).sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)))[0];
}
export async function connections():Promise<ConnectionsResponse> {
  const config=getConfig();let available=false;let runs:Record<string,unknown>[]=[];let firstParty:{eventAt:string|null;leadAt:string|null}={eventAt:null,leadAt:null};
  try {const db=database();await db.probe();available=true;const state=await db.rpc<{runs:Record<string,unknown>[];firstParty:typeof firstParty}>('cockpit_connection_status',{});firstParty=state.firstParty;try{runs=await db.select('sync_runs',{order:'started_at',descending:true,limit:1000});}catch{runs=state.runs;}}catch{/* only sanitized state is exposed */}
  const connection=(id:string,name:string,streams:string[],configured:boolean,limits:string[],syncable=false,source=id):Connection=>{
    const last=latestConnectionRun(runs,source,streams);const complete=last?.status==='complete';
    const demo=config.mode==='demo';
    return {id,name,status:demo?'demo':!configured?'missing':last?.status==='failed'?'error':'partial',
      summary:demo?'Données synthétiques de test.':!configured?'Connexion serveur à renseigner.':!available?'Accès fourni ; base du cockpit à installer.':!last?'Accès configuré ; aucun import de ce flux effectué.':complete?'Dernier import de ce flux enregistré ; accès actuel non retesté.':last.status==='empty'?'Lecture de ce flux réussie, aucune ligne reçue ; accès actuel non retesté.':last.status==='partial'||last.status==='running'?'Lecture de ce flux en cours ou partielle ; reprise enregistrée.':'Dernier import de ce flux en échec.',
      lastSyncAt:last?.finished_at?String(last.finished_at):null,coverage:last?(id==='notion'?`Miroir commercial : ${last.rows_read||0} lignes lues · ${complete?'lecture complète du périmètre autorisé':'lecture non complète'}. Historique observé depuis le premier import.`:`Période interrogée : ${new Date(String(last.period_from)).toLocaleDateString('fr-FR',{timeZone:'Europe/Paris'})} au ${new Date(String(last.period_to)).toLocaleDateString('fr-FR',{timeZone:'Europe/Paris'})} (fin exclue) · ${last.rows_read||0} lignes lues.`):'Aucune couverture de données établie.',limits,canSync:!demo&&configured&&available&&syncable};
  };
  return {mode:config.mode,connections:[
    {id:'database',name:'Base du cockpit',status:config.mode==='demo'?'demo':available?'connected':'missing',summary:available?(config.mode==='demo'?'PostgreSQL local, données synthétiques.':'Tables accessibles dans Supabase.'):'Migration Supabase à installer.',lastSyncAt:null,coverage:available?'Persistance disponible.':'Aucune donnée métier chargée.',limits:config.mode==='demo'?['Ce mode local est interdit sur Vercel.']:['Les données restent dans le projet Supabase du cockpit.'],canSync:false},
    connection('meta','Meta Ads',['ad_daily'],!!process.env.META_ACCESS_TOKEN&&!!process.env.META_AD_ACCOUNT_ID,['Statistiques rapportées par Meta, séparées de l’attribution commerciale.','Réponse vide distincte de dépenses nulles.'],true),
    connection('notion','Notion · commercial',['prospects_business'],!!process.env.NOTION_TOKEN&&!!process.env.NOTION_DATA_SOURCE_ID,['Lecture des propriétés commerciales autorisées uniquement.','Dates métier historiques conservées ; créations seules signalées à part. Présences selon classification courante Notion, sans reconstituer les créneaux remplacés.'],true),
    connection('wix','Wix · encaissements',['payments_analytics'],!!process.env.WIX_API_KEY,['CA issu de la synthèse des paiements Wix, actualisé pour la période choisie.','Périmètre Wix seulement ; rapprochement historique Notion et paiements par client encore incomplet.'],true),
    connection('posthog_quiz','PostHog · Quiz',['quiz_observations'],!!process.env.POSTHOG_PERSONAL_API_KEY,['Étapes et visiteurs du quiz mesurés pour la période interrogée.','Données agrégées ; inscriptions serveur et rattachement aux ventes distincts.'],false,'posthog'),
    connection('posthog_masterclass','PostHog · Masterclass',['masterclass_observations'],!!process.env.POSTHOG_PERSONAL_API_KEY,['Rapports Masterclass séparés du quiz.','Le lancement de la nouvelle page et son adresse restent à raccorder.'],false,'posthog'),
    firstParty.leadAt?{id:'first_party',name:'Quiz et masterclass',status:config.mode==='demo'?'demo':'partial',summary:'Inscriptions serveur reçues. Couverture de la collecte à valider.',lastSyncAt:firstParty.leadAt,coverage:'Premier raccord observé ; un enregistrement ne prouve pas une couverture exhaustive.',limits:['Observations navigateur et inscriptions serveur distinctes.','Vérifier le parcours réel de bout en bout après installation.'],canSync:false}:connection('first_party','Quiz et masterclass',[],false,['Snippets préparés à transmettre aux responsables des pages.','Installation et premier enregistrement serveur signé à vérifier après déploiement.']),
  ]};
}
