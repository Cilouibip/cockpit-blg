import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const origin='http://127.0.0.1:3100';
const password=(await fs.readFile('.local/access.txt','utf8')).match(/^Mot de passe\s*:\s*(.+)$/m)?.[1]?.trim();if(!password)throw Error('LOCAL_ACCESS_MISSING');
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1366,height:768},locale:'fr-FR',timezoneId:'Europe/Paris'});
let reads=0;let errors=0;const checks:string[]=[];page.on('pageerror',()=>errors++);page.on('request',r=>{if(r.url().startsWith(origin+'/api/dashboard?'))reads++;});
try{
 await page.goto(origin);await page.getByLabel('Mot de passe',{exact:true}).fill(password);await page.getByRole('button',{name:'Ouvrir le cockpit',exact:true}).click();await page.waitForURL(origin+'/');await page.locator('.results-kpi').first().waitFor();
 const period=page.getByLabel('Période rapide',{exact:true});const from=page.getByLabel('Du',{exact:true});const to=page.getByLabel('Au',{exact:true});const initialTo=await to.inputValue();const year=initialTo.slice(0,4);
 await expect(period).toHaveValue('month');assert.equal(await period.locator('option').count(),15);
 for(const q of [1,2,3,4])await expect(period.getByRole('option',{name:`T${q} ${year}`,exact:true})).toHaveCount(1);
 const before=reads;await period.selectOption('previousYear');await expect(from).toHaveValue(`${Number(year)-1}-01-01`);await expect(to).toHaveValue(`${Number(year)-1}-12-31`);assert.equal(reads,before);await expect(page.locator('.results-pending')).toBeVisible();
 const response=page.waitForResponse(r=>r.url().startsWith(origin+'/api/dashboard?')&&new URL(r.url()).searchParams.get('from')===`${Number(year)-1}-01-01`);await page.getByRole('button',{name:'Appliquer',exact:true}).click();assert.equal((await response).status(),200);await page.locator('.results-kpi').first().waitFor();checks.push('15 options, explicit quarter year, preset fills inclusive dates and only Apply reads data');
 await from.fill(`${year}-02-01`);await expect(period).toHaveValue('custom');await period.selectOption('today');await to.fill(`${year}-02-28`);await expect(period).toHaveValue('custom');checks.push('manual edit of either boundary switches to Dates personnalisées');
 await period.selectOption('month');const defaultResponse=page.waitForResponse(r=>r.url().startsWith(origin+'/api/dashboard?')&&new URL(r.url()).searchParams.get('to')===initialTo);await page.getByRole('button',{name:'Appliquer',exact:true}).click();await defaultResponse;await page.locator('.results-kpi').first().waitFor();
 for(const size of [{width:1366,height:768},{width:1440,height:900},{width:390,height:844},{width:320,height:844}]){
  await page.setViewportSize(size);await page.evaluate(()=>scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  if(size.width>1000){const tops=await page.locator('.results-toolbar').evaluate(node=>Array.from(node.children).map(child=>child.getBoundingClientRect().top));assert.ok(Math.max(...tops)-Math.min(...tops)<4,'All desktop controls on one row');const bottoms=await page.locator('.results-kpi').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().bottom));assert.ok(bottoms.every(bottom=>bottom<size.height),'All 8 cards remain visible');}
  await page.screenshot({path:`.local/ux/periods-${size.width}.png`});
 }
 checks.push('one compact desktop row, 8 visible cards, no overflow at 1366/1440/390/320');assert.equal(errors,0);checks.push('no browser JavaScript error');
 await fs.writeFile('.local/ux/periods-checks.json',JSON.stringify({checks,errors},null,2));for(const check of checks)console.log('PASS '+check);
}finally{await browser.close();}
