import type { ConnectionsResponse, Connection } from './ui-contract';
import { getConfig } from './config';
import { database } from './db';
export async function connections():Promise<ConnectionsResponse> {
  const config=getConfig();let available=false;let runs:Record<string,unknown>[]=[];let firstParty:{eventAt:string|null;leadAt:string|null}={eventAt:null,leadAt:null};
  try {await database().probe();available=true;const state=await database().rpc<{runs:Record<string,unknown>[];firstParty:typeof firstParty}>('cockpit_connection_status',{});runs=state.runs;firstParty=state.firstParty;}catch{/* only sanitized state is exposed */}
  const recent=(source:string)=>runs.filter(r=>r.source===source).sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)))[0];
  const connection=(id:string,name:string,configured:boolean,limits:string[],syncable=false):Connection=>{
    const last=recent(id);const complete=last?.status==='complete';
    const demo=config.mode==='demo';
    return {id,name,status:demo?'demo':!configured?'missing':last?.status==='failed'?'error':complete?'connected':'partial',
      summary:demo?'Données synthétiques de test.':!configured?'Connexion serveur à renseigner.':!available?'Accès fourni ; base du cockpit à installer.':!last?'Accès fourni ; aucun import effectué.':complete?'Dernier import enregistré.':last.status==='empty'?'Lecture réussie, aucune ligne reçue.':last.status==='partial'?'Import partiel à reprendre.':'Dernier import en échec.',
      lastSyncAt:last?.finished_at?String(last.finished_at):null,coverage:last?(id==='notion'?`Miroir commercial : ${last.rows_written||0} lignes enregistrées · ${complete?'lecture complète du périmètre autorisé':'lecture non complète'}. Historique observé depuis le premier import.`:`Période interrogée : ${new Date(String(last.period_from)).toLocaleDateString('fr-FR',{timeZone:'Europe/Paris'})} au ${new Date(String(last.period_to)).toLocaleDateString('fr-FR',{timeZone:'Europe/Paris'})} (fin exclue) · ${last.rows_written||0} lignes enregistrées.`):'Aucune couverture de données établie.',limits,canSync:!demo&&configured&&available&&syncable};
  };
  return {mode:config.mode,connections:[
    {id:'database',name:'Base du cockpit',status:config.mode==='demo'?'demo':available?'connected':'missing',summary:available?(config.mode==='demo'?'PostgreSQL local, données synthétiques.':'Tables accessibles dans Supabase.'):'Migration Supabase à installer.',lastSyncAt:null,coverage:available?'Persistance disponible.':'Aucune donnée métier chargée.',limits:config.mode==='demo'?['Ce mode local est interdit sur Vercel.']:['Les clés API ne permettent pas d’installer les tables SQL.'],canSync:false},
    connection('meta','Meta Ads',!!process.env.META_ACCESS_TOKEN&&!!process.env.META_AD_ACCOUNT_ID,['Statistiques rapportées par Meta, séparées de l’attribution commerciale.','Réponse vide distincte de dépenses nulles.'],true),
    connection('notion','Notion · commercial',!!process.env.NOTION_TOKEN&&!!process.env.NOTION_DATA_SOURCE_ID,['Lecture des propriétés commerciales autorisées uniquement.','Historique observé à partir du premier import. Une date courante ne prouve pas un RDV distinct.'],true),
    connection('wix','Wix · encaissements',!!process.env.WIX_API_KEY,['Accès MCP interactif distinct du serveur autonome.','Agrégats séparés des transactions. Attribution et LTV attendent les paiements par personne.']),
    connection('posthog','PostHog · parcours',!!process.env.POSTHOG_PERSONAL_API_KEY,['Clé de lecture disponible : elle ne prouve pas une alimentation du cockpit.','Raccord first-party préparé ; aucun export massif Query ni nouvel abonnement activé.']),
    firstParty.leadAt?{id:'first_party',name:'Quiz et masterclass',status:config.mode==='demo'?'demo':'partial',summary:'Inscriptions serveur reçues. Couverture de la collecte à valider.',lastSyncAt:firstParty.leadAt,coverage:'Premier raccord observé ; un enregistrement ne prouve pas une couverture exhaustive.',limits:['Observations navigateur et inscriptions serveur distinctes.','Vérifier le parcours réel de bout en bout après installation.'],canSync:false}:connection('first_party','Quiz et masterclass',false,['Snippets préparés à transmettre aux responsables des pages.','Installation et premier enregistrement serveur signé à vérifier après déploiement.']),
  ]};
}
