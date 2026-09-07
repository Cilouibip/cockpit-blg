import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {randomUUID} from 'node:crypto';
import {signIngestion} from '../src/domain/ingestion';
process.loadEnvFile('.env.local');
const origin='http://127.0.0.1:3100';if(process.env.COCKPIT_MODE!=='demo')throw new Error('LOCAL_DEMO_ONLY');
const access=fs.readFileSync('.local/access.txt','utf8');const password=access.match(/Mot de passe : (.+)/)?.[1];if(!password)throw new Error('LOCAL_ACCESS_MISSING');
const bodyHeaders={'Content-Type':'application/json',Origin:origin};
const login=await fetch(origin+'/api/login',{method:'POST',headers:bodyHeaders,body:JSON.stringify({password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
test('routes commerciales toutes privées, connexion et sortie',async()=>{
 for(const path of ['dashboard','prospects','links','connections']){const r=await fetch(origin+'/api/'+path);assert.equal(r.status,401);assert.match(r.headers.get('cache-control')||'',/no-store/);}
 const success=await fetch(origin+'/api/connections',{headers:{Cookie:cookie}});assert.equal(success.status,200);assert.equal((await success.json()).mode,'demo');
 const bad=await fetch(origin+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:'https://evil.example'}});assert.equal(bad.status,403);
 const out=await fetch(origin+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:origin}});assert.equal(out.status,200);assert.match(out.headers.get('set-cookie')||'',/Max-Age=0/);
});
test('écriture sans session / origine et corps invalide refusés',async()=>{
 const input={placement:'instagram_bio',destination:'quiz',campaign:'http-test',label:'Synthetic test'};
 assert.equal((await fetch(origin+'/api/links',{method:'POST',headers:bodyHeaders,body:JSON.stringify(input)})).status,401);
 assert.equal((await fetch(origin+'/api/links',{method:'POST',headers:{...bodyHeaders,Origin:'https://evil.example',Cookie:cookie},body:JSON.stringify(input)})).status,403);
 assert.equal((await fetch(origin+'/api/links',{method:'POST',headers:{...bodyHeaders,Cookie:cookie},body:JSON.stringify({...input,secret:'not-allowed'})})).status,400);
 assert.equal((await fetch(origin+'/api/sync/meta',{method:'POST',headers:{...bodyHeaders,Cookie:cookie},body:'{}'})).status,409);
 assert.equal((await fetch(origin+'/api/jobs/meta')).status,401);
});
test('ingestion publique limitée aux observations, preuve serveur signée distincte et idempotente',async()=>{
 const telemetry={event_id:randomUUID(),schema_version:1,event_name:'landing_arrival',occurred_at:new Date().toISOString(),anonymous_id:randomUUID(),session_id:randomUUID(),journey_id:randomUUID(),tunnel:'quiz',link_revision_id:null,page_version:'http-test',properties:{}};
 const headers={'Content-Type':'application/json',Origin:'https://quizz.blg-studio.fr'};
 assert.equal((await fetch(origin+'/api/ingest/events',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(telemetry)})).status,403);
 assert.equal((await fetch(origin+'/api/ingest/events',{method:'POST',headers,body:JSON.stringify({...telemetry,person_id:randomUUID()})})).status,400);
 const a=await fetch(origin+'/api/ingest/events',{method:'POST',headers,body:JSON.stringify(telemetry)});assert.equal(a.status,202);assert.equal(a.headers.get('access-control-allow-origin'),headers.Origin);
 const b=await fetch(origin+'/api/ingest/events',{method:'POST',headers,body:JSON.stringify(telemetry)});assert.equal(b.status,202);assert.equal((await b.json()).result.duplicate,true);
 const lead={event_id:randomUUID(),schema_version:1,event_name:'lead_registered',registered_at:new Date().toISOString(),source:'first_party',source_account_id:'http-synthetic',external_id:randomUUID(),tunnel:'quiz',anonymous_id:telemetry.anonymous_id,session_id:telemetry.session_id,journey_id:telemetry.journey_id,link_revision_id:null,identity:{namespace:'test',external_id:randomUUID(),email:'synthetic-http@example.test'}};
 const raw=JSON.stringify(lead),timestamp=String(Math.floor(Date.now()/1000));
 assert.equal((await fetch(origin+'/api/ingest/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:raw})).status,401);
 const signed={'Content-Type':'application/json','x-blg-timestamp':timestamp,'x-blg-signature':signIngestion(raw,timestamp,process.env.INGEST_HMAC_SECRET!)};
 for(let i=0;i<2;i++){const r=await fetch(origin+'/api/ingest/leads',{method:'POST',headers:signed,body:raw});assert.equal(r.status,202);assert.equal((await r.json()).result.duplicate,i>0);}
});
