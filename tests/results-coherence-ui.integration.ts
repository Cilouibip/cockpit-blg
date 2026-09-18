import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {chromium} from '@playwright/test';
import {issueSession,COOKIE_NAME,passwordHash} from '../src/lib/auth';
import {getConfig} from '../src/lib/config';
import {emptyDashboard,parseFilters} from '../src/lib/dashboard';
import {buildAdFunnel} from '../src/lib/ad-funnel';
import {resultsDetails,applyResultsAcquisition} from '../src/lib/results-details';
import type {Database,Row} from '../src/lib/db';

// Local synthetic fixtures only. No source connection, credential or live identity is used.
const base='http://127.0.0.1:3193',now='2026-09-19T12:00:00Z';
Object.assign(process.env,{COCKPIT_MODE:'live',APP_ORIGIN:base,COCKPIT_SESSION_SECRET:'synthetic-results-ui-secret-0123456789',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-results-password','00000000000000000000000000000000')});
const ads=Array.from({length:53},(_,i)=>({id:'ad-'+i,external_id:String(120200000000000111n+BigInt(i)),ad_name:'Annonce de contrôle '+String(i+1).padStart(2,'0')}));
const entries=ads.map((ad,i)=>({id:'entry-'+i,external_id:'entry-'+i,source_namespace:'synthetic-site',family:'forms',person_id:'person-'+i,identity_state:'linked',is_current:true,eligible:true,published_at:now,occurred_at:'2026-09-10T10:00:00Z',properties:{origin:{ad:ad.external_id}}}));
const tables:Record<string,Row[]>={ads,lead_source_observations:entries};
const db:Database={async select(table,options={}){let rows=tables[table]??[];for(const [k,v] of Object.entries(options.eq??{}))rows=rows.filter(r=>String(r[k])===v);return rows.slice(options.from??0,(options.from??0)+(options.limit??1000));},async upsert(){assert.fail('No writes');},async rpc(){assert.fail('No RPC');},async probe(){assert.fail();}};
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3193'],{env:process.env,stdio:'ignore'});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 for(let i=0;i<100;i++){try{await fetch(base);break;}catch{if(i===99)throw Error('Local server not ready');await new Promise(r=>setTimeout(r,100));}}
 browser=await chromium.launch({headless:true,channel:'chrome'});const context=await browser.newContext();
 await context.addCookies([{name:COOKIE_NAME,value:issueSession(getConfig()),url:base,httpOnly:true,sameSite:'Strict'}]);
 const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,base);assert.equal(route.request().method(),'GET');
  const filters=parseFilters(url),report=await buildAdFunnel(db,filters,{env:{WIX_SITE_ID:'synthetic-site'},includeCommerce:false,now});
  if(url.pathname==='/api/details')return route.fulfill({json:resultsDetails(report,Number(url.searchParams.get('page')??0))});
  if(url.pathname==='/api/ad-funnel')return route.fulfill({json:report});
  if(url.pathname==='/api/dashboard'){const response=emptyDashboard(filters,'live');applyResultsAcquisition(response,report);Object.assign(response,{details:resultsDetails(report).details,detailsPagination:resultsDetails(report).pagination,campaigns:report.campaigns});return route.fulfill({json:response});}
  return route.fulfill({json:{connections:[]}});
 });
 fs.mkdirSync('.local/results-coherence',{recursive:true});
 for(const width of [1440,375]){
  await page.setViewportSize({width,height:1000});await page.goto(base);
  const toggle=page.getByRole('button',{name:/04 Résultats par campagne et par lien/});await toggle.click();
  await page.getByRole('navigation',{name:'Pagination des campagnes et liens'}).waitFor();
  const count=width===1440?page.locator('.results-desktop-table tbody tr'):page.locator('.results-mobile-list > li');
  assert.equal(await count.count(),50);await page.getByRole('button',{name:'Suivant',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.a-t-pagination p')?.textContent?.includes('51'));
  assert.equal(await count.count(),3);const item=width===1440?page.locator('.results-desktop-table .a-t-name').first():page.locator('.results-mobile-list .a-t-name').first();await item.click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();assert.match(await dialog.innerText(),/Nouveaux leads/);assert.match(await dialog.innerText(),/inscriptions confirmées/);assert.match(await dialog.innerText(),/fraîcheur/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:'.local/results-coherence/results-'+width+'.png',fullPage:true});await page.keyboard.press('Escape');
 }
 assert.deepEqual(errors,[]);console.log('PASS desktop/mobile: projected results, pagination, source coverage, unknown appointments, no overflow or browser error');
}finally{await browser?.close();child.kill('SIGTERM');}
