import {Temporal} from '@js-temporal/polyfill';
import type {DashboardResponse,DashboardFilters,DataMode,Metric} from './ui-contract';
import type {Row} from './db';
/** Compact SQL aggregates; raw event/contact/payment rows never travel through this view. */
export interface DashboardRollup {
 leads:{registrations:number;unique:number;unresolved:number;observedAt:string|null;byTunnel?:{tunnel:string;count:number;unique:number;unresolved:number}[]};
 events:{count:number;arrivals:number;observedAt:string|null;steps:{tunnel:string;event_name:string;value:number}[];questions:{q:number;views:number;answers:number}[];videos:{video_id:string;version:string;duration:number;threshold:number;viewers:number;reached:number}[]};
 appointments:{total:number;attended:number;noShow:number;unknown:number;observedAt:string|null};
 finance:{transactionCount:number;authorityCount:number;compatible:boolean;grossMinor:number;refundMinor:number;reversalMinor:number;coverageComplete:boolean;observedAt:string|null;daily:{date:string;netMinor:number}[]};
 aggregate:{valueMinor:number;observedAt:string|null}|null;
 deals:{count:number;compatible:boolean;contractedMinor:number;observedAt:string|null};
 meta:{rows:number;compatible:boolean;spendMinor:number|null;impressions:number|null;outboundClicks:number|null;observedAt:string|null;daily:{date:string;spendMinor:number}[]};
}
export function applyDashboardRollup(response:DashboardResponse,r:DashboardRollup,filters:DashboardFilters,mode:DataMode){
 const allMetrics=[...response.metrics,...response.pillars.flatMap(p=>p.metrics)];
 const set=(id:string,value:number|null,extras:Partial<Metric>={})=>{const m=allMetrics.find(m=>m.id===id);if(m){Object.assign(m,{value,...extras});if(value!==null)delete m.unavailableReason;}};
 const campaign=filters.campaign&&filters.campaign!=='all'?filters.campaign:'';
 const metaScope=/^meta(?:-ad|-creative)?:/.test(campaign);
 const financialFilter=filters.source!=='all'||filters.tunnel!=='all'||!!campaign;
 const transactions=!financialFilter&&r.finance.transactionCount>0&&r.finance.authorityCount===1&&r.finance.compatible&&(r.finance.coverageComplete||mode==='demo');
 const aggregate=!financialFilter&&!transactions?r.aggregate:null;
 const cash=transactions?(r.finance.grossMinor-r.finance.refundMinor+r.finance.reversalMinor)/100:aggregate?aggregate.valueMinor/100:null;
 set('cash',cash,{updatedAt:transactions?r.finance.observedAt:aggregate?.observedAt||null,coverage:transactions?`Encaissé brut ${(r.finance.grossMinor/100).toFixed(2)} € · remboursements ${(r.finance.refundMinor/100).toFixed(2)} €` : aggregate?'Agrégat net source exact. Brut et remboursements détaillés non disponibles.':'Transactions et remboursements à raccorder.'});
 const observation=mode==='demo'?'Périmètre synthétique de test.':'Observations reçues ; exhaustivité métier non établie.';
 const spendScope=filters.tunnel==='all'&&['all','paid'].includes(filters.source)&&(!campaign||metaScope);
 const adReady=spendScope&&r.meta.rows>0&&r.meta.compatible;
 const spend=adReady&&r.meta.spendMinor!==null?r.meta.spendMinor/100:null;
 set('spend',spend,{updatedAt:r.meta.observedAt,coverage:adReady?observation:'Aucune partition Meta publiée et compatible.'});
 const leadValue=metaScope||r.leads.unresolved>0?null:r.leads.registrations>0?r.leads.unique:mode==='demo'?0:null;
 set('leads',leadValue,{updatedAt:r.leads.observedAt,coverage:`${r.leads.registrations} inscriptions · ${r.leads.unresolved} non rapprochées. ${observation}`});
 set('appointments',!financialFilter&&(r.appointments.total>0||mode==='demo')?r.appointments.attended:null,{updatedAt:r.appointments.observedAt,coverage:`${r.appointments.attended} réalisés · ${r.appointments.noShow} absents · ${r.appointments.unknown} issues inconnues. Les emplacements Notion courants sont séparés.`});
 set('contracted',!financialFilter&&r.deals.count>0&&r.deals.compatible?r.deals.contractedMinor/100:null,{updatedAt:r.deals.observedAt});
 const clicks=adReady?r.meta.outboundClicks:null,impressions=adReady?r.meta.impressions:null;
 set('arrivals',r.events.count?r.events.arrivals:null,{updatedAt:r.events.observedAt,coverage:observation});
 set('impressions',impressions,{updatedAt:r.meta.observedAt,coverage:observation});
 set('clicks',clicks,{updatedAt:r.meta.observedAt,coverage:observation});
 const ratio=(id:string,n:number|null,d:number|null,scale:number)=>set(id,n!==null&&d!==null&&d>0?n/d*scale:null,{numerator:n,denominator:d,updatedAt:r.meta.observedAt,coverage:observation});
 ratio('ctr',clicks,impressions,100);ratio('cpc',spend,clicks,1);ratio('cpm',spend,impressions,1000);
 const outcomes=r.appointments.attended+r.appointments.noShow;
 set('showup',!financialFilter&&outcomes>0?r.appointments.attended/outcomes*100:null,{numerator:financialFilter?null:r.appointments.attended,denominator:financialFilter?null:outcomes,updatedAt:r.appointments.observedAt,coverage:observation});
 const events=r.events.steps||[];
 const names:Record<string,string>={arrival:'landing_arrival',start:'quiz_started',complete:'quiz_completed',result:'result_viewed',video:'video_started',bilan:'bilan_clicked'};
 for(const journey of response.journeys.filter(j=>['quiz','masterclass'].includes(j.id))){
  const has=events.some(e=>e.tunnel===journey.id);
  for(const step of journey.steps){const count=step.id==='saved'?(r.leads.byTunnel||[]).find(l=>l.tunnel===journey.id)?.count:null;step.value=step.id==='saved'?(count||null):has?events.find(e=>e.tunnel===journey.id&&e.event_name===names[step.id])?.value||0:null;}
 }
 for(const step of response.journeys.find(j=>j.id==='questions')!.steps){const q=r.events.questions.find(q=>`q${q.q}`===step.id);step.value=q&&q.views>0?q.answers:null;step.denominator=q&&q.views>0?q.views:null;}
 if(r.events.videos.length)response.journeys.find(j=>j.id==='video')!.steps=r.events.videos.map(v=>({id:`${v.video_id}:${v.version}:${v.duration}:${v.threshold}`,label:`${v.video_id} · ${v.version} · ${v.duration} s · ${v.threshold*100} % réellement vus`,value:v.reached,denominator:v.viewers,source:'Intervalles lus par navigateur et version',coverage:'Union des plages observées, sans compter les sauts ni les relectures deux fois. Spectateurs mesurés, pas personnes cross-device.'}));
 response.series=[];
 for(let day=Temporal.PlainDate.from(filters.from);Temporal.PlainDate.compare(day,Temporal.PlainDate.from(filters.to))<=0;day=day.add({days:1})){
  const date=day.toString(),cashDay=r.finance.daily.find(row=>row.date===date),adDay=r.meta.daily.find(row=>row.date===date);
  response.series.push({date,revenue:transactions&&cashDay?cashDay.netMinor/100:null,spend:adReady&&adDay?adDay.spendMinor/100:null});
 }
 return response;
}
