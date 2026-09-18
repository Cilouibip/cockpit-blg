import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { issueSession, COOKIE_NAME, passwordHash } from '../src/lib/auth';
import { getConfig } from '../src/lib/config';
import { emptyDashboard } from '../src/lib/dashboard';
import { journeyFixture } from './fixtures/journey';
import { visualJourneyUiFixture } from './fixtures/visual-journey-ui';

const base=process.env.JOURNEY_PREVIEW_URL || 'http://127.0.0.1:3126';
assert.equal(new URL(base).hostname,'127.0.0.1');
Object.assign(process.env,{COCKPIT_MODE:'live',APP_ORIGIN:base,COCKPIT_SESSION_SECRET:'synthetic-journey-preview-secret-0123456789',COCKPIT_PASSWORD_HASH:passwordHash('synthetic-journey-password','00000000000000000000000000000000')});
const out=process.env.JOURNEY_SCREENSHOT_DIR;
if(out)fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1100}});
await context.addCookies([{name:COOKIE_NAME,value:issueSession(getConfig()),url:base,httpOnly:true,sameSite:'Strict'}]);
const page=await context.newPage();const errors:string[]=[];const requests:URL[]=[];
let mode:'complete'|'partial'|'failed'|'waiting'='complete';
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,base);requests.push(url);
  assert.equal(route.request().method(),'GET','Browsing the funnel must not trigger an import or source write');
  if(url.pathname==='/api/journey-visual'){
    if(mode==='failed')return route.fulfill({status:502,json:{error:{message:'Lecture interrompue.'}}});
    const report=visualJourneyUiFixture();report.filters.campaign=url.searchParams.get('campaign')??'';
    report.period.from=url.searchParams.get('from')!;report.period.to=url.searchParams.get('to')!;
    if(report.filters.campaign)report.stages[0].count=400;
    if(mode==='partial'){
      report.status='partial';report.booking.booked={count:null,available:false,reason:'Les rendez-vous sont en cours d’actualisation.'};
      report.stages[4].count=null;report.stages[4].availability=report.booking.booked;
      report.stages[4].fromPrevious={numerator:null,denominator:100,rate:null,available:false,reason:'Les rendez-vous sont en cours d’actualisation.'};
      report.limits=['Les rendez-vous sont en cours d’actualisation.'];
    }
    if(mode==='waiting'&&!url.searchParams.has('resume')){
      report.status='partial';report.loading={resume:'synthetic-signed-resume',retryAfterMs:1000};
      for(const stage of report.stages.filter(s=>['page','form','watch'].includes(s.id))){stage.count=null;stage.availability={available:false,reason:'Lecture en cours'};}
      return route.fulfill({status:202,json:report});
    }
    return route.fulfill({json:report});
  }
  if(url.pathname==='/api/journey')return route.fulfill({json:{...journeyFixture(),scope:{...journeyFixture().scope,tunnel:'quiz'},questions:[]}});
  if(url.pathname==='/api/dashboard')return route.fulfill({json:emptyDashboard({from:'2026-09-01',to:'2026-09-18',source:'all',tunnel:'all',campaign:'',compare:false},'live')});
  return route.fulfill({json:{connections:[]}});
});
try{
 await page.goto(base);
 await page.getByRole('button',{name:'Parcours',exact:true}).click();
 const root=page.locator('.journey-page');
 await root.locator('.journey-stop').nth(0).waitFor();
 assert.equal(await root.locator('table').count(),0);
 const kit=await page.locator('#atelier-a').evaluate(node=>getComputedStyle(node).getPropertyValue('--a-black').trim());
 assert.equal(kit,'#17181d','The actual design-kit styles must be loaded');
 assert.equal(await page.getByLabel('Version de la page').count(),0);
 assert.equal(await root.locator('.journey-edge').count(),4);
 assert.match(await root.locator('.journey-edge').allTextContents().then(a=>a.join(' ')),/16.*75.*83,3.*12/);
 await page.evaluate(()=>window.scrollTo(0,0));
 if(out)await page.screenshot({path:out+'/desktop-page.png',fullPage:true});
 await root.locator('.journey-stop').nth(1).click();
 assert.match(await root.locator('.journey-small-route').innerText(),/87,5 %/);
 assert.match(await root.locator('.journey-small-route').innerText(),/85,7 %/);
 await page.evaluate(()=>window.scrollTo(0,0));
 if(out)await page.screenshot({path:out+'/desktop-form.png',fullPage:true});
 await root.locator('.journey-stop').nth(3).click();
 await root.getByRole('button',{name:'3 min',exact:true}).click();
 assert.match(await root.locator('.journey-big-reading').innerText(),/45 %\s*45 personnes sur 100/);
 await page.evaluate(()=>window.scrollTo(0,0));
 if(out)await page.screenshot({path:out+'/desktop-video.png',fullPage:true});
 await root.getByRole('button',{name:'Toute la vidéo',exact:true}).click();
 assert.match(await root.locator('.journey-big-reading').innerText(),/18 %\s*18 personnes sur 100/);
 await root.locator('.journey-stop').nth(4).click();
 assert.match(await root.locator('.journey-small-route').innerText(),/66,7 %/);
 await page.getByLabel('Publicité',{exact:true}).selectOption('meta-ad:120248712468250714');
 await root.locator('.journey-stop').nth(0).locator('strong').filter({hasText:'400'}).waitFor();
 await page.getByLabel('Période',{exact:true}).selectOption('custom');
 await page.getByLabel('Du',{exact:true}).fill('2026-09-17');
 await page.getByLabel('Au',{exact:true}).fill('2026-09-18');
 await Promise.all([page.waitForResponse(response=>response.url().includes('/api/journey-visual')&&response.url().includes('from=2026-09-17')),page.getByRole('button',{name:'Appliquer',exact:true}).click()]);
 assert.ok(requests.some(url=>url.pathname==='/api/journey-visual'&&url.searchParams.get('campaign')==='meta-ad:120248712468250714'&&url.searchParams.get('from')==='2026-09-17'));
 await page.getByLabel('Publicité',{exact:true}).selectOption('');
 await root.locator('.journey-stop').nth(0).locator('strong').filter({hasText:'1'}).waitFor();
 mode='partial';await page.getByRole('button',{name:'Actualiser',exact:true}).click();
 await root.locator('.journey-stop').nth(4).locator('strong').filter({hasText:'—'}).waitFor();
 assert.match(await root.locator('.journey-stop').nth(0).locator('strong').innerText(),/1.?000/);
 mode='failed';await page.getByRole('button',{name:'Actualiser',exact:true}).click();
 await root.getByRole('alert').waitFor();
 assert.match(await root.locator('.journey-stop').nth(0).locator('strong').innerText(),/1.?000/,'Keep last successful matching scope on failure');
 mode='complete';await page.getByRole('button',{name:'Actualiser',exact:true}).click();
 await root.locator('.journey-stop').nth(4).locator('strong').filter({hasText:'12'}).waitFor();
 mode='waiting';await page.getByRole('button',{name:'Actualiser',exact:true}).click();
 await root.getByRole('status').filter({hasText:'Les visites et la vidéo se chargent'}).waitFor();
 assert.equal(await root.locator('.journey-stop').nth(2).locator('strong').innerText(),'120','Inscrits conservés pendant le calcul');
 await root.locator('.journey-stop').nth(0).locator('strong').filter({hasText:'1'}).waitFor();
 assert.ok(requests.some(url=>url.searchParams.get('resume')==='synthetic-signed-resume'),'La même lecture est reprise automatiquement');
 mode='complete';
 const geometry=[];
 for(const width of [1440,1024,768,390,320]){
  await page.setViewportSize({width,height:1100});
  for(const step of ['page','form','watch','call']){
   await root.locator('.journey-stop').nth(['page','form','signup','watch','call'].indexOf(step)).click();
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   assert.equal(overflow,false,width+' '+step);
   geometry.push({width,step,overflow});
  }
  if(out&&width===390){await root.locator('.journey-stop').nth(3).click();await root.getByRole('button',{name:'3 min',exact:true}).click();await page.screenshot({path:out+'/mobile-video.png',fullPage:true});}
 }
 await page.getByRole('button',{name:'Quiz',exact:true}).click();
 await root.locator('.journey-panel').first().waitFor();
 assert.ok(requests.some(url=>url.pathname==='/api/journey'&&url.searchParams.get('tunnel')==='quiz'));
 await page.getByRole('button',{name:'Masterclass',exact:true}).click();
 await root.locator('.journey-stop').first().waitFor();
 assert.deepEqual(errors,[]);
 if(out)fs.writeFileSync(out+'/browser-verification.json',JSON.stringify({synthetic:true,errors,geometry,checks:['5 étapes','4 conversions','formulaire','vidéo % et effectif','RDV','filtre publicité','dates personnalisées','partiel','erreur sans effacer','responsive','kit chargé','quiz conservé']},null,2));
 console.log('Visual journey browser checks passed. Synthetic data, no source writes.');
}finally{await context.close();await browser.close();}
