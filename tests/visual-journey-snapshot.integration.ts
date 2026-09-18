import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { issueSession, COOKIE_NAME, passwordHash } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';
import { emptyDashboard } from '../src/lib/dashboard';
import type { VisualJourneyReport } from '../src/lib/visual-journey-contract';

// Renders a previously collected, aggregate-only read. This test never contacts a source.
const input=process.env.JOURNEY_SNAPSHOT;
const out=process.env.JOURNEY_SCREENSHOT_DIR;
assert.ok(input && out,'Provide aggregate snapshot and screenshot directory');
const snapshot=JSON.parse(fs.readFileSync(input,'utf8')) as {report:VisualJourneyReport};
const report=snapshot.report;
const base=process.env.JOURNEY_PREVIEW_URL || 'http://127.0.0.1:3126';
assert.equal(new URL(base).hostname,'127.0.0.1');
Object.assign(process.env,{COCKPIT_MODE:'live',APP_ORIGIN:base,COCKPIT_SESSION_SECRET:'synthetic-journey-preview-secret-0123456789',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-journey-password','00000000000000000000000000000000')});
fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1100}});
await context.addCookies([{name:COOKIE_NAME,value:issueSession(getConfig()),url:base,httpOnly:true,sameSite:'Strict'}]);
const page=await context.newPage();
const errors:string[]=[];
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());
  assert.equal(url.origin,base);
  assert.equal(route.request().method(),'GET');
  if(url.pathname==='/api/journey-visual')return route.fulfill({json:report});
  if(url.pathname==='/api/dashboard')return route.fulfill({json:emptyDashboard({from:report.period.from,to:report.period.to,source:'all',tunnel:'all',campaign:'',compare:false},'live')});
  return route.fulfill({json:{connections:[]}});
});
try {
  await page.goto(base);
  await page.getByRole('button',{name:'Parcours',exact:true}).click();
  const root=page.locator('.journey-page');
  await root.locator('.journey-stop').first().waitFor();
  assert.equal(await root.locator('table').count(),0);
  assert.equal(await page.getByLabel('Version de la page').count(),0);
  for(let i=0;i<report.stages.length;i++){
    const stage=report.stages[i];
    assert.equal((await root.locator('.journey-stop').nth(i).locator('strong').innerText()).replaceAll(/\s/g,''),stage.count==null?'—':String(stage.count));
  }
  const sections=await root.locator('.journey-bar-caption').allTextContents();
  assert.ok(sections.every(value=>!/Hero|Proof section|Last call|Video thumbnail/.test(value)));
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:out+'/desktop-page.png',fullPage:true});
  await root.locator('.journey-stop').nth(3).click();
  await root.getByRole('button',{name:'3 min',exact:true}).click();
  const threshold=report.video.thresholds.find(row=>row.seconds===180)!;
  assert.match(await root.locator('.journey-big-reading').innerText(),new RegExp(`${threshold.visitors} personnes sur ${threshold.fromStarted.denominator}`));
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:out+'/desktop-video.png',fullPage:true});
  await page.setViewportSize({width:390,height:1100});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:out+'/mobile-video.png',fullPage:true});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(out+'/snapshot-verification.json',JSON.stringify({snapshotGeneratedAt:report.generatedAt,sourceRead:false,aggregateSnapshot:true,errors,checked:['stage counts','real labels','actual video fraction','responsive']},null,2));
  console.log('Aggregate snapshot rendering verified; no live source writes or requests.');
}finally{await context.close();await browser.close();}
