import {Temporal} from '@js-temporal/polyfill';
/** Meta account requests remain bounded; dates here are inclusive UI dates. */
export function metaRefreshPeriods(from:string,to:string){
 const periods:{from:string;to:string}[]=[];
 let start=Temporal.PlainDate.from(from);const end=Temporal.PlainDate.from(to).add({days:1});
 while(Temporal.PlainDate.compare(start,end)<0){const candidate=start.add({days:93}),next=Temporal.PlainDate.compare(candidate,end)<0?candidate:end;periods.push({from:start.toString(),to:next.subtract({days:1}).toString()});start=next;}
 return periods;
}

export type RefreshResult={status:string;counts?:{pages?:number;read?:number};coverage?:{reason?:string}};
/** Every request is short; the same server checkpoint is resumed after interruption. */
export async function refreshNotionToCompletion(invoke:()=>Promise<RefreshResult>,onProgress:(read:number)=>void,maxChunks=40):Promise<RefreshResult>{
 for(let chunk=0;chunk<maxChunks;chunk++){
  const result=await invoke();
  if(result.status!=='partial'||!result.counts?.pages)return result;
  onProgress(result.counts.read??0);
 }
 return {status:'partial',coverage:{reason:'Lecture Notion à poursuivre : clique à nouveau sur Actualiser pour reprendre.'}};
}
