import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {attributeCohort,type AttributionInput} from '../domain/attribution';
import {prepareAttributionScope,type ScopeAdEvidence,type ScopeCostEvidence,type ScopeSyncEvidence} from '../domain/attribution-scope';
import {evidenceKey} from '../domain/metrics';
import {allRows,type Database,type Row} from './db';
import {AppError} from './errors';
const uuid=z.uuid();
export interface AttributionReferences {
  /** Exact persisted row IDs; no implicit lookup by name/time. */
  paidAccountId:string;
  acquisitionByPerson:Record<string,{kind:'lead'|'payment';id:string}>;
  paymentByEvidence:Record<string,string>; eventByEvidence:Record<string,string>; adByExternal:Record<string,string>;
  scope:{source:'all'|'paid'|'organic'|'unknown';tunnel:'all'|'quiz'|'masterclass';campaign:string};
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Called only by the trusted server/operator after authoritative input preparation. No public calculation input API. */
export async function publishAttribution(db:Database,input:AttributionInput,refs:AttributionReferences,supersedesId?:string){
 if(refs.scope.source!=='all'||refs.scope.tunnel!=='all'||refs.scope.campaign!=='')throw new AppError('Le périmètre filtré exige ses preuves persistées et le préparateur serveur.',422,'attribution_scope');
 return persistAttribution(db,input,refs,supersedesId);
}
async function persistAttribution(db:Database,input:AttributionInput,refs:AttributionReferences,supersedesId?:string,scopeProof?:unknown){
 const calculated=attributeCohort(input);if(!input.policy)throw new AppError('Politique d’attribution absente.',422,'attribution_policy');
 const verifiedAds=new Map<string,string>();
 for(const anchor of calculated.anchors){
  const selected=anchor.selected;if(selected?.sourceType!=='paid')continue;
  const adId=selected.adId&&refs.adByExternal[selected.adId];
  if(!refs.paidAccountId||!adId||!uuid.safeParse(adId).success)throw new AppError('Publicité persistée et compte source requis.',422,'attribution_reference');
  const rows=await db.select('ads',{eq:{id:adId},limit:2});const row=rows[0];
  if(rows.length!==1||row.source!=='meta'||row.source_namespace!==refs.paidAccountId||row.external_id!==selected.adId||row.campaign_id!==selected.campaignId)throw new AppError('La publicité ne correspond pas au compte et à la campagne du contact.',422,'attribution_reference');
  verifiedAds.set(selected.adId!,adId);
 }
 const results:Row[]=[],anchors=new Map<string,string>();
 for(const anchor of calculated.anchors){
  uuid.parse(anchor.personId);const target=refs.acquisitionByPerson[anchor.personId];if(!target)throw new AppError('Cible d’acquisition persistée absente.',422,'attribution_reference');uuid.parse(target.id);
  const id=randomUUID();anchors.set(anchor.personId,id);const selected=anchor.selected;
  const selectedId=selected?refs.eventByEvidence[evidenceKey(selected)]:null;if(selected&&!selectedId)throw new AppError('Contact source persisté absent.',422,'attribution_reference');
  results.push({id,person_id:anchor.personId,target_kind:'acquisition',lead_registration_id:target.kind==='lead'?target.id:null,payment_id:target.kind==='payment'?target.id:null,appointment_id:null,anchor_result_id:null,selected_event_id:selectedId,link_revision_id:selected?.linkRevisionId||null,ad_id:selected?.adId?verifiedAds.get(selected.adId)||null:null,status:!selected?'unknown':selected.sourceType==='paid'?'attributed':selected.sourceType==='organic'?'organic':selected.sourceType==='direct'?'direct':'unknown',reason_code:anchor.reason,conversion_at:anchor.acquisitionFactAt,acquisition_at:selected?.occurredAt||null,person_evidence_refs:input.manifest.identitySnapshotIds,mapping_refs:input.manifest.mappingSnapshotIds,dimensions_snapshot:{source:selected?.sourceType||'unknown',campaignId:selected?.campaignId||null,inCohort:anchor.inCohort},candidate_evidence_snapshot:anchor.candidateEvidenceSnapshot,target_snapshot:{kind:target.kind,id:target.id,acquisitionFactAt:anchor.acquisitionFactAt},contribution_minor:null,currency:input.currency,first_customer_proof:input.newCustomerEvidence[anchor.personId]||{},input_digest:digest(anchor)});
 }
 for(const result of calculated.results){
  const paymentId=refs.paymentByEvidence[result.paymentKey];if(!paymentId)throw new AppError('Transaction persistée absente.',422,'attribution_reference');uuid.parse(paymentId);
  const base={id:randomUUID(),person_id:result.personId,target_kind:'payment',lead_registration_id:null,appointment_id:null,payment_id:paymentId,anchor_result_id:anchors.get(result.personId),selected_event_id:refs.eventByEvidence[result.touchpointKey],link_revision_id:result.linkRevisionId,ad_id:result.adId?verifiedAds.get(result.adId)||null:null,status:result.sourceType==='paid'?'attributed':result.sourceType==='organic'?'organic':result.sourceType==='direct'?'direct':'unknown',reason_code:null,conversion_at:result.targetSnapshot.effectiveAt,acquisition_at:calculated.anchors.find(a=>a.personId===result.personId)?.selected?.occurredAt,person_evidence_refs:input.manifest.identitySnapshotIds,mapping_refs:input.manifest.mappingSnapshotIds,dimensions_snapshot:{source:result.sourceType,campaignId:result.campaignId},candidate_evidence_snapshot:[],target_snapshot:result.targetSnapshot,contribution_minor:result.netMinor,currency:result.currency,first_customer_proof:input.newCustomerEvidence[result.personId]||{},input_digest:digest(result)};
  results.push(base);
  if(result.paymentKey===input.newCustomerEvidence[result.personId]?.firstReceiptKey)results.push({...base,id:randomUUID(),target_kind:'new_customer',contribution_minor:null});
 }
 const run={calculation_fingerprint:digest({input,refs}),supersedes_run_id:supersedesId||null,code_version:'attribution-v1',metric_definition_version:input.policy.version,identity_cutoff_at:input.manifest.inputCutoffAt,input_cutoff_at:input.manifest.inputCutoffAt,input_manifest:{...input.manifest,spend:input.spend,...(scopeProof?{scopeProof}:{})},model:input.policy.method,lookback_days:30,observation_horizon_days:90,cohort_from:input.policy.cohort.from,cohort_to:input.policy.cohort.to,cohort_timezone:input.policy.cohort.timezone,currency:input.currency,scope:refs.scope,coverage_summary:{available:calculated.available,reason:calculated.reason,dependencies:input.coverage}};
 const runId=await db.rpc<string>('publish_attribution',{p_run:run,p_results:results});
 return {runId,available:calculated.available,reason:calculated.reason};
}

/** Read complete persisted account evidence, prepare a scoped cohort, then publish atomically.
 * No caller-supplied proof/readsComplete flag is accepted by this server boundary.
 */
export async function publishScopedAttribution(db:Database,global:AttributionInput,refs:AttributionReferences,scope:AttributionReferences['scope'],supersedesId?:string){
 const [catalog,daily,runs]=await Promise.all([allRows(db,'ads'),allRows(db,'v_ad_daily'),allRows(db,'sync_runs')]);
 const ads=catalog.filter(row=>row.source==='meta'&&row.source_namespace===refs.paidAccountId);
 const adIds=new Set(ads.map(row=>row.id));
 const safeInteger=(value:unknown):number|null=>value===null?null:typeof value==='number'?value:typeof value==='string'&&/^-?\d+$/.test(value)?Number(value):NaN;
 const costs=daily.filter(row=>adIds.has(row.ad_id)).map(row=>({...row,spend_minor:safeInteger(row.spend_minor),currency_exponent:safeInteger(row.currency_exponent)}));
 const syncRuns=runs.filter(row=>row.source==='meta'&&row.source_namespace===refs.paidAccountId).map(row=>({...row,rows_rejected:safeInteger(row.rows_rejected)}));
 const prepared=prepareAttributionScope({global,scope,evidence:{accountId:refs.paidAccountId,ads:ads as unknown as ScopeAdEvidence[],daily:costs as unknown as ScopeCostEvidence[],syncRuns:syncRuns as unknown as ScopeSyncEvidence[],readsComplete:{ads:true,daily:true,syncRuns:true}}});
 if(!prepared.ok)throw new AppError(prepared.reason,422,'attribution_scope_'+prepared.code);
 const selectedRefs={...refs,scope:prepared.proof.scope};
 const result=await persistAttribution(db,prepared.input,selectedRefs,supersedesId,prepared.proof);
 return {...result,scope:prepared.proof.scope,proof:prepared.proof};
}
