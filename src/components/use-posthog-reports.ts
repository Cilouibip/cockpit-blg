'use client';
import {useEffect,useRef,useState} from 'react';
import {createPostHogReportClient,type PostHogClientState,type PostHogDescriptor} from '../lib/posthog-report-client';
import type {PostHogReportState,PostHogReportType} from '../lib/posthog-report-request';
import type {DashboardFilters,DashboardResponse} from '../lib/ui-contract';
import {filtersQuery} from './ui-format';

async function json<T>(url:string,signal:AbortSignal,method='GET'):Promise<T>{
 const response=await fetch(url,{method,signal,credentials:'same-origin',cache:'no-store'});
 const body=await response.json();
 // Failure and unsupported POST bodies retain the server's exact report key.
 if(!response.ok&&!(method==='POST'&&['failed','unsupported'].includes(body?.state)))throw new Error('posthog_request_failed');
 return body as T;
}
export function usePostHogReports(filters:DashboardFilters,enabled:boolean,revision:number,onData:(data:DashboardResponse)=>void,type:PostHogReportType=filters.tunnel==='masterclass'?'masterclass':'quiz'){
 const query=filtersQuery(filters)+'&reportType='+type,active=useRef({query,enabled,onData});active.current={query,enabled,onData};
 const [state,setState]=useState<{query:string;value:PostHogClientState}>({query:'',value:{}}),[retry,setRetry]=useState(0);
 const client=useRef<ReturnType<typeof createPostHogReportClient>|null>(null);
 useEffect(()=>{
  if(!enabled){client.current?.clear();return;}
  const accepted=()=>active.current.enabled&&active.current.query===query;
  const current=createPostHogReportClient({descriptor:(url,signal)=>json<PostHogDescriptor>(url,signal),transport:(selection,signal)=>json<PostHogReportState>(selection.url,signal,'POST'),dashboard:(url,signal)=>json<DashboardResponse>(url,signal),
   onData:data=>{if(accepted())active.current.onData(data);},onState:(slot,value)=>{if(accepted())setState(before=>({query,value:{...(before.query===query?before.value:{}),[slot]:value}}));}});
  client.current=current;void current.select(filters,type);
  return ()=>current.clear();
  // Exact selection identity; changing returned dashboard data must not request again.
 },[query,enabled,revision,retry]);
 return {state:state.query===query&&enabled?state.value:{},retry:()=>setRetry(value=>value+1)};
}
