/**
 * Périmètre explicite de recette pour les lectures d'acquisition.
 * Une absence de marqueur ne permet jamais d'écarter une donnée : seules les
 * valeurs écrites par les parcours de test sont reconnues ici.
 */
export interface TrafficScope { includeTests: boolean }

export const DEFAULT_TRAFFIC_SCOPE: TrafficScope = {includeTests:false};

const marker=(value:unknown)=>typeof value==='string'?value.trim().toLowerCase():'';
const truthy=(value:unknown)=>value===true||marker(value)==='true'||marker(value)==='1';

/** Test déterministe des champs d'origine conservés par Wix et les parcours Web.
 * `test-mehdi…` est volontairement précis : les autres noms de campagne restent
 * dans le périmètre tant qu'ils ne portent pas un marqueur explicite. */
export function isExplicitTestTraffic(record:Record<string,unknown>|null|undefined):boolean {
 if(!record)return false;
 const source=marker(record.source??record.utm_source),medium=marker(record.medium??record.utm_medium),campaign=marker(record.campaign??record.utm_campaign);
 return truthy(record.is_test??record.isTest)||source==='test'||medium==='recette'||campaign.startsWith('test-mehdi');
}

/** Une origine A de recette reste un marqueur de recette même si l'arrivée courante diffère. */
export function isExcludedTestTraffic(scope:TrafficScope, ...records:(Record<string,unknown>|null|undefined)[]):boolean {
 return !scope.includeTests&&records.some(isExplicitTestTraffic);
}
