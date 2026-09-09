import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin=process.env.HTTP_REPRISE_ORIGIN;
const password=process.env.HTTP_REPRISE_PASSWORD;
if(!origin||!password||new URL(origin).origin!==origin||new URL(origin).port!=='3103')throw new Error('ISOLATED_HTTP_REPRISE_ONLY');
const headers={'Content-Type':'application/json',Origin:origin};
const noStore=(response:Response)=>assert.match(response.headers.get('cache-control')??'',/private, no-store/);
let cookie='';

test('toutes les lectures privées, Commercial inclus, et son jour valide',async()=>{
 for(const path of ['dashboard','prospects','links','connections','commercial?day=2026-09-09']){const response: Response=await fetch(`${origin}/api/${path}`);assert.equal(response.status,401,path);noStore(response);}
 const login=await fetch(`${origin}/api/login`,{method:'POST',headers,body:JSON.stringify({password})});assert.equal(login.status,200);noStore(login);cookie=login.headers.get('set-cookie')!.split(';')[0];
 const invalid=await fetch(`${origin}/api/commercial?day=not-a-day`,{headers:{Cookie:cookie}});assert.equal(invalid.status,400);noStore(invalid);
 const valid=await fetch(`${origin}/api/commercial?day=2026-09-09`,{headers:{Cookie:cookie}});assert.equal(valid.status,200);noStore(valid);
});

test('création stable, conflit non duplicatif, révision, archivage et restauration',async()=>{
 const input={placement:'instagram_bio',destination:'quiz',campaign:'http-reprise',label:'Lien synthétique HTTP'};
 const id=randomUUID();
 const created=await fetch(`${origin}/api/links`,{method:'POST',headers:{...headers,Cookie:cookie,'X-BLG-Link-Id':id},body:JSON.stringify(input)});assert.equal(created.status,200);noStore(created);const creation=await created.json();assert.equal(creation.saved,true);assert.ok(creation.links);
 let listed=await fetch(`${origin}/api/links`,{headers:{Cookie:cookie}});assert.equal(listed.status,200);noStore(listed);let registry=await listed.json();let link=registry.links.find((row:{id:string})=>row.id===id);assert.ok(link);assert.equal(link.revisions.length,1);assert.equal(new URL(link.current.url).searchParams.get('blg_link_id'),link.current.id);
 const retry=await fetch(`${origin}/api/links`,{method:'POST',headers:{...headers,Cookie:cookie,'X-BLG-Link-Id':id},body:JSON.stringify(input)});assert.equal(retry.status,409);noStore(retry);
 listed=await fetch(`${origin}/api/links`,{headers:{Cookie:cookie}});assert.equal(listed.status,200);noStore(listed);registry=await listed.json();link=registry.links.find((row:{id:string})=>row.id===id);assert.equal(link.revisions.length,1);
 const revisedInput={...input,destination:'masterclass',label:'Lien synthétique HTTP v2'};
 const revised=await fetch(`${origin}/api/links`,{method:'PATCH',headers:{...headers,Cookie:cookie},body:JSON.stringify({action:'revise',id,expectedVersion:1,input:revisedInput})});assert.equal(revised.status,200);noStore(revised);assert.equal((await revised.json()).saved,true);
 const archived=await fetch(`${origin}/api/links`,{method:'PATCH',headers:{...headers,Cookie:cookie},body:JSON.stringify({action:'archive',id,expectedVersion:2})});assert.equal(archived.status,200);noStore(archived);assert.equal((await archived.json()).saved,true);
 const restored=await fetch(`${origin}/api/links`,{method:'PATCH',headers:{...headers,Cookie:cookie},body:JSON.stringify({action:'restore',id,expectedVersion:2})});assert.equal(restored.status,200);noStore(restored);assert.equal((await restored.json()).saved,true);
 listed=await fetch(`${origin}/api/links`,{headers:{Cookie:cookie}});assert.equal(listed.status,200);noStore(listed);registry=await listed.json();link=registry.links.find((row:{id:string})=>row.id===id);assert.equal(link.archived,false);assert.equal(link.current.version,2);assert.equal(link.revisions.length,2);
});

test('une origine étrangère est refusée et les réponses restent privées',async()=>{
 const response: Response=await fetch(`${origin}/api/links`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example',Cookie:cookie},body:JSON.stringify({placement:'email',destination:'quiz',campaign:'blocked',label:'blocked'})});
 assert.equal(response.status,403);noStore(response);
});
