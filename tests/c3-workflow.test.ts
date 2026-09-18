import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('hourly worker drains after one failed unit and remains red for a persistent failure',()=>{
 const workflow=readFileSync('.github/workflows/hourly-sync.yml','utf8');
 const script=workflow.slice(workflow.indexOf('          deadline=')).split('\n').map(line=>line.slice(10)).join('\n');
 for(const end of ['complete','failed']){
  const dir=mkdtempSync(join(tmpdir(),'c3-workflow-'));
  try{
   const curl=join(dir,'curl');writeFileSync(curl,`#!/bin/bash\nn=0\n[ ! -f "$C3_COUNT" ] || read n < "$C3_COUNT"\nn=$((n+1))\necho "$n" > "$C3_COUNT"\nif [ "$n" = 1 ]; then echo '{"status":"partial","unitResults":[{"job":"masterclass","status":"failed"}]}'; else echo '{"status":"${end}","unitResults":[]}'; fi\n`);chmodSync(curl,0o700);
   const sleep=join(dir,'sleep');writeFileSync(sleep,'#!/bin/bash\nexit 0\n');chmodSync(sleep,0o700);
   const result=spawnSync('bash',['-e','-o','pipefail','-c',script],{env:{...process.env,PATH:`${dir}:${process.env.PATH}`,C3_COUNT:join(dir,'count'),CRON_SECRET:'synthetic'},encoding:'utf8'});
   assert.equal(result.status,end==='complete'?0:1,result.stderr);assert.equal(readFileSync(join(dir,'count'),'utf8').trim(),'2');
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});
