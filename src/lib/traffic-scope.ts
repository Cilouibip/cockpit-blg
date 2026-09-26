/**
 * Périmètre explicite de recette pour les lectures d'acquisition.
 * Une absence de marqueur ne permet jamais d'écarter une donnée : seules les
 * valeurs écrites par les parcours de test sont reconnues ici.
 */
export interface TrafficScope { includeTests: boolean }

export const DEFAULT_TRAFFIC_SCOPE: TrafficScope = {includeTests:false};

/** Sessions de recette relevées les 25 et 26 septembre 2026, sans marqueur
 * événementiel. La liste est fermée afin de ne jamais assimiler un navigateur
 * ou une session réelle à de la recette. */
export const EXCLUDED_TEST_SESSION_IDS = [
 'mc-48297eb4-9138-4ef2-98f9-2c7a7d52f949',
 'mc-d7c043c8-6a29-4a8a-9646-d535ea295e26',
 'mc-cdf71364-e11a-4b50-b766-4e7e7973a2de',
 'mc-a9f12135-e503-4ac2-9a42-3615ab31067b',
 'mc-94524f30-dc32-470f-8fb9-fd60599f41c9',
 'mc-9dbab732-1307-4184-be11-8f40f81a3c08',
 'mc-92010f2f-b048-43b6-bd89-5f0f348f735d',
 'mc-b2037685-1336-4de5-af6d-219334881c61',
 'mc-fbcb861a-bb7b-46b6-96ee-0f12ec849b96',
 'mc-a43cf817-a5e0-43b5-b238-938e64605ce1',
] as const;
const excludedTestSessions = new Set<string>(EXCLUDED_TEST_SESSION_IDS);

const marker=(value:unknown)=>typeof value==='string'?value.trim().toLowerCase():'';
const truthy=(value:unknown)=>value===true||marker(value)==='true'||marker(value)==='1';
const record=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const sessionValues=(value:Record<string,unknown>)=>[
 value.sid,value.session,value.session_id,value.sessionId,value.blg_session,value.blgSession,
 ...['origin','firstTouch','first_touch'].flatMap(key=>{const nested=record(value[key]);return nested?[nested.sid,nested.session,nested.session_id,nested.sessionId,nested.blg_session,nested.blgSession]:[];}),
];
const knownTestSession=(value:Record<string,unknown>)=>sessionValues(value).some(session=>excludedTestSessions.has(marker(session)));

/** Test déterministe des champs d'origine conservés par Wix et les parcours Web.
 * `test-mehdi…` est volontairement précis : les autres noms de campagne restent
 * dans le périmètre tant qu'ils ne portent pas un marqueur explicite. */
export function isExplicitTestTraffic(record:Record<string,unknown>|null|undefined):boolean {
 if(!record)return false;
 const source=marker(record.source??record.utm_source),medium=marker(record.medium??record.utm_medium),campaign=marker(record.campaign??record.utm_campaign);
 return knownTestSession(record)||truthy(record.is_test??record.isTest)||source==='test'||medium==='recette'||campaign.startsWith('test-mehdi');
}

/** Une origine A de recette reste un marqueur de recette même si l'arrivée courante diffère. */
export function isExcludedTestTraffic(scope:TrafficScope, ...records:(Record<string,unknown>|null|undefined)[]):boolean {
 return !scope.includeTests&&records.some(isExplicitTestTraffic);
}
