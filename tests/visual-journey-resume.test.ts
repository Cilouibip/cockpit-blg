import test from 'node:test';import assert from 'node:assert/strict';
import {sealJourneyResume,openJourneyResume} from '../src/lib/visual-journey-resume';
import {loadVisualJourney} from '../src/lib/visual-journey-client';
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
 await assert.rejects(()=>loadVisualJourney({url:'/api/journey-visual?',signal:new AbortController().signal,budgetMs:2000,now:()=>clock,sleep:async ms=>{clock+=ms;},transport:async()=>({...ready,loading:{resume:'opaque',retryAfterMs:1000}}),onReport:()=>shown++}),/prend plus de temps/);
 assert.equal(shown,2);
});

test('l’expiration du délai pendant une requête reste expliquée en français',async()=>{
 const controller=new AbortController();
 await assert.rejects(()=>loadVisualJourney({url:'/api/journey-visual?',signal:controller.signal,budgetMs:15,transport:async(_url,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('This operation was aborted','AbortError')),{once:true})),onReport:()=>assert.fail()}),/Les autres chiffres restent disponibles/);
});
