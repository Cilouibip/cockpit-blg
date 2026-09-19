import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium,expect} from '@playwright/test';
import {issueSession,COOKIE_NAME,passwordHash} from '../src/lib/auth';
import {getConfig} from '../src/lib/config';
import {emptyDashboard,parseFilters} from '../src/lib/dashboard';
import {postHogReportRequest} from '../src/lib/posthog-report-request';
import {buildAdFunnel} from '../src/lib/ad-funnel';
import type {Database} from '../src/lib/db';

// Real browser/controller/button, local app and synthetic intercepted API only.
const base='http://127.0.0.1:3194';
Object.assign(process.env,{COCKPIT_MODE:'live',APP_ORIGIN:base,COCKPIT_SESSION_SECRET:'synthetic-posthog-ui-session-0123456789',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-ui-password','00000000000000000000000000000000'),POSTHOG_PROJECT_ID:'123'});
const db:Database={select:async()=>[],rpc:async()=>{throw Error('no DB RPC');},upsert:async()=>assert.fail(),probe:async()=>assert.fail()};
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3194'],{env:process.env,stdio:'ignore'});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 for(let i=0;i<100;i++){try{await fetch(base);break;}catch{if(i===99)throw Error('local app unavailable');await new Promise(r=>setTimeout(r,100));}}
 browser=await chromium.launch({headless:true,channel:'chrome'});const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addCookies([{name:COOKIE_NAME,value:issueSession(getConfig()),url:base,httpOnly:true,sameSite:'Strict'}]);
 const page=await context.newPage();page.setDefaultTimeout(10000);await page.clock.install();let posts=0,ready=false,dashboardReads=0;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,base);const filters=parseFilters(url);
  if(url.pathname==='/api/reports/posthog'){
   const request=postHogReportRequest(filters,'quiz',undefined,'123')!;
   if(route.request().method()==='GET')return route.fulfill({json:{key:request.key,supported:true}});
   posts++;return route.fulfill({json:{key:request.key,state:ready?'ready':'waiting',message:'Ces chiffres sont en cours de chargement.',retryAfterMs:15000}});
  }
  if(url.pathname.startsWith('/api/sync/'))return route.fulfill({json:{status:url.pathname==='/api/sync/analytics'?'pending':'complete'}});
  if(url.pathname==='/api/dashboard'){dashboardReads++;return route.fulfill({json:emptyDashboard(filters,'live')});}
  if(url.pathname==='/api/ad-funnel')return route.fulfill({json:await buildAdFunnel(db,filters,{env:{},includeCommerce:false})});
  return route.fulfill({json:{connections:[]}});
 });
 await page.goto(base);await expect.poll(()=>posts).toBeGreaterThanOrEqual(1);
 const content=page.getByRole('button',{name:/Contenu/});await content.click();
 await page.getByRole('button',{name:/Visites des pages/}).click();await page.getByRole('dialog').waitFor();
 for(let i=0;i<7;i++){await page.clock.fastForward(15000);await expect.poll(()=>posts).toBeGreaterThanOrEqual(i+2);}
 const retry=page.getByRole('button',{name:'Réessayer ces chiffres',exact:true});await expect(retry).toBeVisible();
 await expect(page.getByRole('dialog')).toContainText('Le calcul est toujours en cours');await expect(page.getByRole('dialog')).toContainText('En attente');
 const before=posts,reads=dashboardReads;ready=true;await retry.click();await expect.poll(()=>posts).toBeGreaterThan(before);await expect.poll(()=>dashboardReads).toBeGreaterThan(reads);
 await expect(retry).toHaveCount(0);
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'Actualiser',exact:true}).click();
 await expect(page.locator('.blg-toast')).toContainText('Quiz : lecture en cours');
 assert.deepEqual(errors,[]);
 console.log('PASS actual browser: finite automatic waiting, manual retry visible/clickable, ready reload, global refresh pending is not failure, no JS error');
}finally{await browser?.close();child.kill('SIGTERM');}
