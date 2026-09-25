import test from 'node:test';
import assert from 'node:assert/strict';
import {EXCLUDED_TEST_SESSION_IDS,isExplicitTestTraffic,isExcludedTestTraffic} from '../src/lib/traffic-scope';
import {readVisitorCohort,readVisitsByOrigin,visitQueries} from '../src/lib/ad-arrivals';

test('le périmètre de recette reconnaît seulement les marqueurs explicitement écrits',()=>{
 assert.equal(isExplicitTestTraffic({source:'TEST'}),true);
 assert.equal(isExplicitTestTraffic({medium:'recette'}),true);
 assert.equal(isExplicitTestTraffic({campaign:'test-mehdi-rdv-9-septembre'}),true);
 assert.equal(isExplicitTestTraffic({is_test:true}),true);
 for(const sid of EXCLUDED_TEST_SESSION_IDS){assert.equal(isExplicitTestTraffic({sid}),true,`la session iPhone ${sid} est explicitement exclue`);assert.equal(isExplicitTestTraffic({origin:{session:sid}}),true,`la session transmise à Wix ${sid} est explicitement exclue`);}
 assert.equal(isExplicitTestTraffic({sid:'mc-00000000-0000-4000-8000-000000000000'}),false,'une autre session masterclass reste dans le périmètre');
 assert.equal(isExplicitTestTraffic({campaign:'testimonial-septembre',source:'facebook'}),false,'un nom ressemblant à test reste réel sans marqueur explicite');
 assert.equal(isExcludedTestTraffic({includeTests:false},{source:'test'}),true);
 assert.equal(isExcludedTestTraffic({includeTests:true},{source:'test'}),false);
 const excluded=visitQueries('2026-09-01','2026-09-30',{},false),included=visitQueries('2026-09-01','2026-09-30',{},true);
 assert.match(excluded.quiz,/NOT \(/);assert.match(excluded.masterclass,/test-mehdi/);assert.match(excluded.legacyMasterclass,/is_test/);
 assert.match(excluded.quiz,/premiere_utm_source/);assert.match(excluded.quiz,/premiere_utm_medium/);assert.match(excluded.quiz,/premiere_utm_campaign/);assert.match(excluded.quiz,/premiere_utm_is_test/);
 assert.match(excluded.masterclass,/first_origin/);assert.match(excluded.masterclass,/first_touch/);
 for(const sid of EXCLUDED_TEST_SESSION_IDS){assert.match(excluded.masterclass,new RegExp(sid));assert.doesNotMatch(included.masterclass,new RegExp(sid));}
 assert.doesNotMatch(included.quiz,/test-mehdi/,'le paramètre inclut les événements de recette sans modifier les hôtes ou les pages actives');
});

test('une réponse PostHog partielle ou en erreur rend la lecture indisponible',async()=>{
 const env={POSTHOG_HOST:'https://eu.posthog.com',POSTHOG_PROJECT_ID:'123',POSTHOG_PERSONAL_API_KEY:'test'};
 const partial=async()=>new Response(JSON.stringify({results:[],hasMore:true}),{headers:{'content-type':'application/json'}});
 const failed=async()=>new Response(JSON.stringify({results:[],error:'upstream'}),{headers:{'content-type':'application/json'}});
 const visits=await readVisitsByOrigin('2026-09-01','2026-09-30',env,partial,false);
 const cohort=await readVisitorCohort('2026-09-01','2026-09-30',env,failed,false);
 assert.equal(visits.available,false);assert.match(visits.reason!,/interrompue/);assert.deepEqual(visits.scope,{includeTests:false});
 assert.equal(cohort.available,false);assert.match(cohort.reason!,/interrompue/);assert.deepEqual(cohort.scope,{includeTests:false});
});
