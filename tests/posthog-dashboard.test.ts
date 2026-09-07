import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyPostHogQuiz} from '../src/lib/posthog-dashboard';
import {emptyDashboard} from '../src/lib/dashboard';
import type {DashboardFilters} from '../src/lib/ui-contract';
import type {PostHogAnalyticsReport} from '../src/connectors/posthog-analytics';
const filters:DashboardFilters={from:'2026-08-01',to:'2026-08-31',source:'all',tunnel:'quiz',campaign:'',compare:false};
const counts={events:30,visitors:10,sessions:12,eventsWithVisitorId:30,eventsWithSessionId:30};
const report:PostHogAnalyticsReport={source:'posthog',projectId:'synthetic',connectorVersion:'test',from:'2026-07-31T22:00:00Z',to:'2026-08-31T22:00:00Z',timezone:'Europe/Paris',observedAt:'2026-09-07T12:00:00Z',status:'complete',overview:counts,daily:[],byEvent:[{event:'$pageview',...counts}],
 byHostEvent:[{host:'quizz.blg-studio.fr',event:'$pageview',...counts},{host:'www.blg-studio.fr',event:'$pageview',...counts,visitors:8},{host:'quizz.blg-studio.fr',event:'quiz_demarre',...counts,visitors:4}],questions:[{questionNumber:1,...counts,visitors:3}],schema:{sessionIdAvailable:true,questionNumberProperty:'numero'},
 coverage:{queryComplete:true,allTrafficComplete:false,firstObservedAt:null,lastObservedAt:null,observedTrackedEvents:90,excludedHostEvents:0,missingHostEvents:0,conflictingHostEvents:0,identifiableTestEvents:0,reason:'test'},semantics:{visitorIdentity:'distinct_id',sessionIdentity:'$session_id',verifiedBackendLeads:false,sequentialFunnel:false}};
test('Quiz display uses production-host period distincts without creating leads, attendance or sequential rates',()=>{
 const data=emptyDashboard(filters,'live');const result=applyPostHogQuiz(data,report,filters);
 assert.equal(result.journeys.find(j=>j.id==='quiz')!.steps[0].value,10);
 assert.equal(result.journeys.find(j=>j.id==='quiz')!.steps[1].value,4);
 assert.equal(result.journeys.find(j=>j.id==='questions')!.steps[0].value,3);
 assert.ok(result.journeys.find(j=>j.id==='quiz')!.steps.every(s=>s.denominator===undefined));
 assert.equal(result.metrics.find(m=>m.id==='leads')!.value,null);assert.equal(result.metrics.find(m=>m.id==='appointments')!.value,null);
 assert.equal(result.pillars[0].metrics.find(m=>m.id==='arrivals')!.value,12);
});
test('PostHog never fills a paid/campaign filter or a different period from global counts',()=>{
 for(const selected of [{...filters,source:'paid' as const},{...filters,campaign:'meta:123'},{...filters,from:'2026-08-02'}]){
  const data=emptyDashboard(selected,'live');const before=structuredClone(data);assert.deepEqual(applyPostHogQuiz(data,report,selected),before);
 }
 const data=emptyDashboard(filters,'live');const before=structuredClone(data);assert.deepEqual(applyPostHogQuiz(data,{...report,status:'partial',coverage:{...report.coverage,queryComplete:false}},filters),before);
});
