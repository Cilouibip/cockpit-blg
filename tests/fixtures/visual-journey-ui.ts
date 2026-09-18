import type { VisualJourneyMetric, VisualJourneyRate, VisualJourneyReport } from '../../src/lib/visual-journey-contract';

const available={available:true,reason:null};
const metric=(count:number):VisualJourneyMetric=>({count,...available});
const rate=(numerator:number,denominator:number):VisualJourneyRate=>({numerator,denominator,rate:numerator/denominator,...available});
/** Exact sample figures of the approved mockup. Used only by local browser tests. */
export function visualJourneyUiFixture():VisualJourneyReport {
  const freshness={observedAt:'2026-09-18T11:00:00Z',coveredThrough:'2026-09-18T11:00:00Z',status:'available' as const,reason:null};
  return {
    status:'complete',generatedAt:'2026-09-18T11:01:00Z',period:{from:'2026-09-01',to:'2026-09-18',timezone:'Europe/Paris'},filters:{source:'all',campaign:'',includeTests:false},
    availableAds:[{id:'meta-ad:120248712469420714',label:'Publicité image A'},{id:'meta-ad:120248712468250714',label:'Publicité vidéo B'}],
    stages:[
      {id:'page',label:'Visitent la page',count:1000,availability:available,fromPrevious:null},
      {id:'form',label:'Ouvrent le formulaire',count:160,availability:available,fromPrevious:rate(160,1000)},
      {id:'signup',label:'S’inscrivent',count:120,availability:available,fromPrevious:rate(120,160)},
      {id:'watch',label:'Démarrent la vidéo',count:100,availability:available,fromPrevious:rate(100,120)},
      {id:'call',label:'Réservent un rendez-vous',count:12,availability:available,fromPrevious:rate(12,100)},
    ],
    page:{visitors:metric(1000),sections:[{id:'top',label:'Le haut de la page',visitors:metric(1000)},{id:'testimonials',label:'Les témoignages',visitors:metric(580)},{id:'bottom',label:'Le bas de la page',visitors:metric(340)}],cta:metric(160),ctaPlacements:[{id:"top",label:"En haut",visitors:metric(115)},{id:"bottom",label:"En bas",visitors:metric(45)}]},
    form:{opened:metric(160),started:metric(140),registered:metric(120),rates:{startedFromOpened:rate(140,160),registeredFromStarted:rate(120,140)}},
    video:{durationSeconds:437,durationAvailability:available,started:metric(100),thresholds:[{seconds:30,visitors:82,fromStarted:rate(82,100)},{seconds:60,visitors:68,fromStarted:rate(68,100)},{seconds:180,visitors:45,fromStarted:rate(45,100)},{seconds:300,visitors:28,fromStarted:rate(28,100)}],finished:metric(18)},
    booking:{clicked:metric(24),calendar:metric(18),booked:metric(12),rates:{calendarFromClicked:rate(18,24),bookedFromCalendar:rate(12,18)}},
    freshness:{posthog:freshness,wix:freshness,appointments:freshness},
    coverage:{browserVisitors:1000,browserSessions:1040,registrations:120,registrationsWithVisitor:120,registrationsWithSession:120,registrationsWithoutBrowserIdentity:0,appointments:12,appointmentsLinkedToPerson:12,testsIncluded:false},limits:[],
  };
}
