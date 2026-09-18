import test from 'node:test';
import assert from 'node:assert/strict';
import {passwordHash} from '../src/lib/auth';

test('tick garde les états métier en HTTP200 et les erreurs API en non2xx',async()=>{
 const previous={...process.env},originalFetch=globalThis.fetch;
 for(const key of Object.keys(process.env))if(/^(NOTION_|WIX_|META_|POSTHOG_|VERCEL|DATABASE_URL)/.test(key))delete process.env[key];
 const secret='synthetic-cron-secret-for-route-32-characters';
 Object.assign(process.env,{COCKPIT_MODE:'live',APP_ORIGIN:'http://127.0.0.1:3191',COCKPIT_SESSION_SECRET:'synthetic-session-secret-with-32-characters',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-only'),CRON_SECRET:secret,SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SECRET_KEY:'synthetic-secret'});
 let requests=0;
 globalThis.fetch=async()=>{requests++;throw Error('synthetic database unavailable');};
 try{
  const {GET}=await import('../src/app/api/[...path]/route');
  const url='http://127.0.0.1:3191/api/jobs/tick';
  assert.equal((await GET(new Request(url))).status,401);
  const response=await GET(new Request(url,{headers:{Authorization:'Bearer '+secret}}));
  assert.equal(response.status,200);assert.equal((await response.json()).status,'failed','no configured source is not success');assert.equal(requests,0);
  process.env.NOTION_DATA_SOURCE_ID='synthetic-notion';
  assert.equal((await GET(new Request(url,{headers:{Authorization:'Bearer '+secret}}))).status,503,'API storage failure remains an HTTP error');assert.ok(requests>0);
 }finally{
  globalThis.fetch=originalFetch;
  for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];
  Object.assign(process.env,previous);
 }
});
