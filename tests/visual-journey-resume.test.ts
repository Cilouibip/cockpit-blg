import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readPostHogQuery} from '../src/connectors/posthog-query';
import {sealJourneyResume,openJourneyResume} from '../src/lib/visual-journey-resume';
import {loadVisualJourney,unfinishedVisualJourney,VisualJourneyUnfinished,VISUAL_JOURNEY_BUDGET_MS,VISUAL_JOURNEY_MAX_CALLS} from '../src/lib/visual-journey-client';
import {buildVisualJourneyReport} from '../src/lib/visual-journey-report';
import {visualJourneyFixture} from './fixtures/visual-journey';
const secret='synthetic-resume-secret-000000000000000000',scope={project:'123',period:'2026-09',ad:'synthetic'};
test('la reprise privée est chiffrée, expire et reste liée au périmètre exact',()=>{
 const now=1000000,state={expiresAt:now+300000,queries:{identity:{version:1 as const,id:'synthetic-private-query',origin:'https://eu.posthog.com',projectId:'123',queryHash:'a'.repeat(64),startedAt:now}}};
 const token=sealJourneyResume(state,scope,secret);assert.doesNotMatch(Buffer.from(token,'base64url').toString(),/synthetic-private-query/);assert.deepEqual(openJourneyResume(token,scope,secret,now),state);
 for(const read of [()=>openJourneyResume(token,{...scope,ad:'different'},secret,now),()=>openJourneyResume(token,scope,secret+'x',now),()=>openJourneyResume(token.slice(0,-8)+'aaaaaaaa',scope,secret,now),()=>openJourneyResume(token,scope,secret,state.expiresAt)])assert.throws(read,/expiré/);
});
test('la lecture affiche les chiffres connus puis reprend le même calcul jusqu’au résultat',async()=>{
 const ready=buildVisualJourneyReport(visualJourneyFixture()),pending={...ready,loading:{resume:'opaque-signed-token',retryAfterMs:1000}};
 const urls:string[]=[],shown:number[]=[];await loadVisualJourney({url:'/api/journey-visual?campaign=synthetic',signal:new AbortController().signal,sleep:async()=>{},transport:async url=>{urls.push(url);return urls.length===1?pending:ready;},onReport:r=>shown.push(r.form.registered.count!)});
 assert.deepEqual(shown,[2,2]);assert.equal(urls.length,2);assert.match(urls[1],/campaign=synthetic&resume=opaque-signed-token$/);
});
test('un changement de filtre annule la reprise et ignore une ancienne réponse',async()=>{
 const controller=new AbortController();let shown=0,requests=0;
 await loadVisualJourney({url:'/api/journey-visual?campaign=A',signal:controller.signal,transport:async()=>{requests++;controller.abort();return buildVisualJourneyReport(visualJourneyFixture());},onReport:()=>shown++});
 assert.equal(shown,0);assert.equal(requests,1);
});
test('une attente persistante est bornée sans annoncer la réussite',async()=>{
 const ready=buildVisualJourneyReport(visualJourneyFixture());let clock=0,shown=0;
 await assert.rejects(()=>loadVisualJourney({url:'/api/journey-visual?',signal:new AbortController().signal,budgetMs:2000,now:()=>clock,sleep:async ms=>{clock+=ms;},transport:async()=>({...ready,loading:{resume:'opaque',retryAfterMs:1000}}),onReport:()=>shown++}),/Lecture des visites non terminée/);
 assert.equal(shown,2);
});

test('l’expiration du délai pendant une requête reste expliquée en français',async()=>{
 const controller=new AbortController();
 await assert.rejects(()=>loadVisualJourney({url:'/api/journey-visual?',signal:controller.signal,budgetMs:15,transport:async(_url,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('This operation was aborted','AbortError')),{once:true})),onReport:()=>assert.fail()}),/Les autres chiffres restent disponibles/);
});

const PENDING='La lecture des visites et de la vidéo est en cours.';
const pendingReport=()=>{
 const input=visualJourneyFixture();
 const report=buildVisualJourneyReport({...input,browser:null,browserError:PENDING,freshness:{...input.freshness,posthog:{observedAt:null,coveredThrough:null,status:'running',reason:PENDING}}});
 return {...report,loading:{resume:'opaque-signed-token',retryAfterMs:5000}};
};

test('le navigateur attend 240 s au plus, rythme réel : 20 s par appel et 5 s entre deux appels',async()=>{
 assert.deepEqual([VISUAL_JOURNEY_BUDGET_MS,VISUAL_JOURNEY_MAX_CALLS],[240_000,14]);
 let clock=0;const starts:number[]=[];
 const error=await loadVisualJourney({url:'/api/journey-visual?',signal:new AbortController().signal,now:()=>clock,sleep:async ms=>{clock+=ms;},
  transport:async()=>{starts.push(clock);clock+=20_000;return pendingReport();},onReport:()=>{}}).then(()=>null,reason=>reason);
 assert.ok(error instanceof VisualJourneyUnfinished);assert.match(error.message,/^Lecture des visites non terminée\./);
 assert.equal(starts.length,10);assert.ok(starts.at(-1)!<240_000);assert.ok(clock<=240_000+20_000);
 // L'ancien budget (120 s) aurait abandonné après 5 appels.
 assert.ok(starts.filter(start=>start<120_000).length<=5);
});

test('le navigateur fait 14 appels au plus quand chaque réponse arrive vite',async()=>{
 let clock=0,calls=0;
 await assert.rejects(()=>loadVisualJourney({url:'/api/journey-visual?',signal:new AbortController().signal,now:()=>clock,sleep:async ms=>{clock+=ms;},
  transport:async()=>{calls++;clock+=200;return {...pendingReport(),loading:{resume:'opaque',retryAfterMs:1000}};},onReport:()=>{}}),VisualJourneyUnfinished);
 assert.equal(calls,14);
});

test('un résultat qui arrive au moment où le délai expire est affiché, une attente persistante devient « non terminée »',async()=>{
 const ready=buildVisualJourneyReport(visualJourneyFixture());
 for(const [late,expected] of [[ready,'shown'],[pendingReport(),'unfinished']] as const){
  const shown:string[]=[];
  const outcome=await loadVisualJourney({url:'/api/journey-visual?',signal:new AbortController().signal,budgetMs:15,
   transport:async(_url,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(late),{once:true})),onReport:r=>shown.push(r.freshness.posthog.status)}).then(()=>'shown',reason=>reason instanceof VisualJourneyUnfinished?'unfinished':String(reason));
  assert.equal(outcome,expected);assert.equal(shown.length,1);
 }
});

test('après abandon, la lecture en attente devient « non terminée » sans zéro fabriqué',()=>{
 const pending=pendingReport(),reason='Lecture des visites non terminée (tentative du 23 sept. 2026, 14:05).';
 const settled=unfinishedVisualJourney(pending,reason);
 assert.equal(settled.loading,undefined);assert.equal(settled.freshness.posthog.status,'unfinished');assert.equal(settled.freshness.posthog.reason,reason);
 assert.doesNotMatch(JSON.stringify(settled),/en cours/);
 assert.deepEqual(settled.stages.map(stage=>stage.count),pending.stages.map(stage=>stage.count),'aucun chiffre ajouté ni retiré');
 assert.equal(settled.page.visitors.count,null);assert.equal(settled.form.registered.count,2);
 assert.deepEqual(settled.freshness.wix,pending.freshness.wix);assert.equal(pending.freshness.posthog.status,'running','le rapport affiché avant reste intact');
 const ready=buildVisualJourneyReport(visualJourneyFixture());
 assert.equal(unfinishedVisualJourney(ready,reason),ready,'un résultat complet ou en échec franc ne change pas');
});

test('le jeton de reprise (5 min) et la continuation PostHog (10 min) couvrent tout le budget de 240 s',async()=>{
 const firstAnswer=0,queryHash=createHash('sha256').update('SELECT 1').digest('hex');
 const continuation={version:1 as const,id:'synthetic-query',origin:'https://eu.posthog.com',projectId:'123',queryHash,startedAt:firstAnswer,registered:true};
 // La route fixe expiresAt à la première réponse en attente, puis le réutilise tel quel.
 const token=sealJourneyResume({queries:{identity:continuation},expiresAt:firstAnswer+300_000},scope,secret);
 assert.equal(openJourneyResume(token,scope,secret,firstAnswer+VISUAL_JOURNEY_BUDGET_MS).queries.identity?.id,'synthetic-query');
 const result={columns:['alive'],results:[[1]]};
 assert.deepEqual(await readPostHogQuery({endpoint:new URL('https://eu.posthog.com'),projectId:'123',headers:{},query:'SELECT 1',name:'synthetic',deadline:firstAnswer+VISUAL_JOURNEY_BUDGET_MS+20_000,signal:new AbortController().signal,
  clock:()=>firstAnswer+VISUAL_JOURNEY_BUDGET_MS,sleep:async()=>{},resumable:true,resume:continuation,fetcher:async(_url,init)=>{assert.equal(init?.method,'GET');return Response.json({query_status:{id:'synthetic-query',team_id:123,complete:true,results:result}});}}),result);
});
