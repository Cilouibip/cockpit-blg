import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secret='synthetic-cron-never-print-this-value';
const privateBody='synthetic-private-body-never-log';
const workflow=readFileSync('.github/workflows/hourly-sync.yml','utf8');
const script=workflow.slice(workflow.indexOf('          deadline=')).split('\n').map(line=>line.slice(10)).join('\n');
type Reply={code:number;body:string}|{hang:true};
function execute(code:string,temporary:string):Promise<{status:number|null;stdout:string;stderr:string}> {
 return new Promise((resolve,reject)=>{
  const child=spawn('bash',['-e','-o','pipefail','-c',code],{env:{...process.env,CRON_SECRET:secret,TMPDIR:temporary},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('LOCAL_WORKFLOW_TEST_DEADLINE'));},10000);
  child.on('error',error=>{clearTimeout(timeout);reject(error);});child.on('close',status=>{clearTimeout(timeout);resolve({status,stdout,stderr});});
 });
}
async function run(replies:Reply[], originalStdout=false, timeout=false){
 const temporary=mkdtempSync(join(tmpdir(),'hourly-sync-response-'));let requests=0;
 const pending=new Set<ServerResponse>();
 const server=createServer((request,response)=>{
  assert.equal(request.headers.authorization,'Bearer '+secret);requests++;pending.add(response);response.on('close',()=>pending.delete(response));
  const reply=replies[Math.min(requests-1,replies.length-1)];
  if('hang' in reply)return;
  response.writeHead(reply.code,{'Content-Type':'application/json'});response.end(reply.body);
 });
 try {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}/tick`;
  let local=script.replace('https://cockpit-blg.vercel.app/api/jobs/tick',url);
  // Keep the production retry policy for HTTP cases. Only the deliberately
  // stalled local server uses scaled limits; the workflow constants stay intact.
  if(timeout)local=local.replace('--max-time 90','--max-time 0.15').replace('--retry-max-time 100','--retry-max-time 1').replace('--retry-delay 2','--retry-delay 0');
  if(originalStdout)local=`response="$(curl --silent --show-error --fail-with-body --max-time 90 --retry 2 --retry-delay 2 --retry-max-time 100 --header "Authorization: Bearer $CRON_SECRET" ${url})"\nprintf '%s' "$response" | jq -r '.status'\n`;
  const at=performance.now(),result=await execute(local,temporary);
  assert.deepEqual(readdirSync(temporary),[],'response file removed on every normal/failure exit');
  if(!originalStdout){assert.ok(!result.stdout.includes(secret));assert.ok(!result.stderr.includes(secret));assert.ok(!result.stdout.includes(privateBody));assert.ok(!result.stderr.includes(privateBody));}
  return {...result,requests,elapsedMs:performance.now()-at};
 }finally{
  for(const response of pending)response.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(temporary,{recursive:true,force:true});
 }
}
const transient={code:503,body:JSON.stringify({status:null,private:privateBody,credential:secret})};
const complete={code:200,body:JSON.stringify({status:'complete',units:1,private:privateBody,credential:secret})};

test('real curl reproduces concatenated retry stdout from the previous workflow',async()=>{
 const result=await run([transient,{code:200,body:'{"status":"partial"}'}],true);
 assert.equal(result.status,0);assert.equal(result.requests,2);assert.equal(result.stdout,'null\npartial\n');
});
test('only final retry response is parsed, then partial Meta still drains another healthy unit',async()=>{
 const result=await run([transient,{code:200,body:'{"status":"partial","unitResults":[{"job":"meta_ads","status":"failed"}]}'},complete]);
 assert.equal(result.status,0,result.stderr);assert.equal(result.requests,3);
 assert.deepEqual(result.stdout.trim().split('\n').map(line=>JSON.parse(line).status),['partial','complete']);
});
test('persistent real HTTP503 stays failed after the existing bounded retries and discards all response bodies',async()=>{
 const result=await run([transient]);assert.equal(result.status,1);assert.equal(result.requests,3);assert.equal(result.stdout,'');assert.match(result.stderr,/checkpoints sont conservés/);assert.ok(result.elapsedMs<9000);
});
test('HTTP200 invalid JSON, two JSON documents and absent status never become success',async()=>{
 for(const body of ['not-json '+privateBody,'{"status":"complete"}\n{"status":"partial"}','{"status":null}']){
  const result=await run([{code:200,body}]);assert.equal(result.status,1);assert.equal(result.requests,1);assert.equal(result.stdout,'');assert.match(result.stderr,/invalide/);
 }
});
test('successful HTTP with persistent failed status remains failed, and auth failures are not retried',async()=>{
 const failed=await run([{code:200,body:'{"status":"failed"}'}]);assert.equal(failed.status,1);assert.equal(failed.requests,1);
 const auth=await run([{code:401,body:JSON.stringify({credential:secret})}]);assert.equal(auth.status,1);assert.equal(auth.requests,1);assert.equal(auth.stdout,'');
});
test('real stalled HTTP obeys bounded retry time and cleans its private response file',async()=>{
 const result=await run([{hang:true}],false,true);assert.equal(result.status,1);assert.ok(result.requests>=1&&result.requests<=3);assert.ok(result.elapsedMs<2500);assert.equal(result.stdout,'');assert.match(result.stderr,/checkpoints sont conservés/);
});
