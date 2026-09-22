import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readLiveKpiFunnel } from '../src/lib/kpi-funnel-live';
import { syncKpiSource } from '../src/lib/kpi-source-store';
import { memoryKpiDatabase } from '../tests/helpers/kpi-memory';
import { kpiFunnelCsv } from '../src/lib/kpi-funnel-export';

const origin=process.env.KPI_PREVIEW_ORIGIN??'http://127.0.0.1:3100';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw Error('LOCAL_QA_ONLY');
const password=(await fs.readFile('.local/access.txt','utf8')).match(/^Mot de passe\s*:\s*(.+)$/m)?.[1]?.trim();if(!password)throw Error('TEST_ACCESS_MISSING');
const from='2026-09-20',to='2026-09-22',now='2026-09-22T10:00:00Z',memory=memoryKpiDatabase({},()=>now);
await syncKpiSource(memory.db,'meta','synthetic',from,to,async()=>({from,to,observedAt:now,rows:[{day:from,key:'120248692698770714',data:{campaignId:'120248692698770714',spend_eur:12.34,impressions:100,link_clicks:10,unique_link_clicks_campaign_sum:9,landing_page_views:8,booking_meta_attributed:0}}]}));
const response=await readLiveKpiFunnel(memory.db,{from,to:'2026-09-21',source:'all',tunnel:'masterclass',campaign:'',compare:false},{env:{NODE_ENV:'test',META_AD_ACCOUNT_ID:'synthetic'},now});if(response.status!=='ready')throw Error('FIXTURE_NOT_READY');
const queries:string[]=[];
await fs.mkdir('.local/ux',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},locale:'fr-FR',timezoneId:'Europe/Paris'});
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.route('**/api/kpi-funnel?*',async route=>{queries.push(new URL(route.request().url()).search);await route.fulfill({json:response});});
 await page.goto(origin);await page.getByLabel('Mot de passe',{exact:true}).fill(password);await page.getByRole('button',{name:'Ouvrir le cockpit',exact:true}).click();await page.waitForURL(origin+'/');
 const panel=page.locator('.kpi-funnel');await panel.getByRole('button',{name:'Exporter pour Excel'}).waitFor();
 assert.equal(await panel.locator('.kpi-funnel-scroll tbody tr').count(),3);assert.match(await panel.innerText(),/12,34/);assert.match(await panel.innerText(),/Non mesuré/);assert.match(await panel.innerText(),/Lecture la plus ancienne/);
 const download=page.waitForEvent('download');await panel.getByRole('button',{name:'Exporter pour Excel'}).click();const file=await download;const path=await file.path();assert.ok(path);assert.equal(await fs.readFile(path!,'utf8'),kpiFunnelCsv(response.snapshot));
 await Promise.all([page.waitForResponse(r=>r.url().includes('/api/kpi-funnel?')&&r.url().includes('includeTests=true')),page.getByLabel('Inclure les essais explicitement marqués').check()]);assert.ok(queries.some(q=>q.includes('includeTests=true')));
 await page.getByLabel('Période rapide',{exact:true}).selectOption('custom');await page.getByLabel('Du',{exact:true}).fill('2026-09-20');await page.getByLabel('Au',{exact:true}).fill('2026-09-21');const changed=page.waitForResponse(r=>r.url().includes('/api/kpi-funnel?')&&r.url().includes('from=2026-09-20')&&r.url().includes('to=2026-09-21'));await page.getByRole('button',{name:'Appliquer',exact:true}).click();await changed;
 for(const width of [1440,390,320]){await page.setViewportSize({width,height:width===1440?1000:844});await panel.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.equal(await panel.locator('.kpi-funnel-scroll').evaluate(e=>e.scrollWidth>e.clientWidth),true);if(width!==320)await panel.screenshot({path:`.local/ux/kpi-automatic-${width}.png`});}
 assert.deepEqual(errors,[]);console.log('PASS automatic table: dates/tests requests, exact CSV export, null/zero, freshness, 1440/390/320 px. Synthetic source publications; surrounding views use the local demo server.');
}finally{await browser.close();}
