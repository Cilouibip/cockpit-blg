import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import type { DashboardResponse } from '../src/lib/ui-contract';

// Read-only review checks. Mutating journey/link tests use the separate QA server.
const origin = 'http://127.0.0.1:3100';
const output = '.local/ux'; await fs.mkdir(output, { recursive: true, mode: 0o700 });
const password = (await fs.readFile('.local/access.txt','utf8')).match(/^Mot de passe\s*:\s*(.+)$/m)?.[1]?.trim();
if (!password) throw Error('Local test access absent.');
const browser = await chromium.launch({ channel:'chrome', headless:true });
const page = await browser.newPage({ viewport:{width:1366,height:768},locale:'fr-FR',timezoneId:'Europe/Paris' });
const checks: string[] = []; const bounds: unknown[] = []; let errors = 0; let failures = 0;
page.on('pageerror',()=>errors++); page.on('response',r=>{if(new URL(r.url()).origin === origin && r.status()>=500) failures++;});
function pass(text: string) { checks.push(text); console.log('PASS '+text); }
async function ready() { await page.waitForFunction(()=>document.querySelector('.blg-content')?.getAttribute('aria-busy')==='false' && !!document.querySelector('.results-kpi,.blg-panel')); }
async function overflow() { assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false); }
async function view(name: string) { await page.getByRole('navigation',{name:'Navigation principale'}).getByRole('button',{name,exact:true}).click(); await ready(); }
async function shot(name: string, fullPage=false) { await page.screenshot({path:`${output}/${name}.png`,fullPage}); }
try {
  await page.goto(origin); await page.getByLabel('Mot de passe',{exact:true}).fill(password); await page.getByRole('button',{name:'Ouvrir le cockpit',exact:true}).click(); await page.waitForURL(origin+'/'); await ready();
  const dashboard: DashboardResponse = await (await page.request.get(origin+'/api/dashboard?from=2026-09-01&to=2026-09-07&source=all&tunnel=all&campaign=&compare=true')).json();
  assert.equal(dashboard.mode,'demo'); assert.equal(dashboard.details.length,3); assert.equal(dashboard.metrics.find(m=>m.id==='leads')?.value,12); assert.equal(dashboard.campaigns.some(c=>/qa-|QA synthétique/i.test(c.label)),false);
  pass('clean review fixtures: 3 detail rows, 12 unique leads, no QA campaigns');
  for(const size of [{width:1366,height:768},{width:1440,height:900}]) {
    await page.setViewportSize(size); await page.evaluate(()=>scrollTo(0,0));
    const boxes = await page.locator('.results-kpi').evaluateAll(nodes=>nodes.map(n=>({id:n.getAttribute('data-metric'),top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom})));
    assert.equal(boxes.length,8); assert.ok(boxes.every(b=>b.top>=0 && b.bottom<=size.height)); bounds.push({size,boxes}); await overflow(); await shot(`results-${size.width}`);
  }
  pass('all 8 KPI cards fully visible at 1366×768 and 1440×900');
  assert.equal(await page.locator('.blg-demo-banner').count(),0); assert.equal(await page.locator('.results-demo').count(),1);
  await page.locator('.results-demo').click(); await expect(page.getByRole('dialog')).toContainText('fictifs'); await page.keyboard.press('Escape'); await expect(page.locator('.results-demo')).toBeFocused();
  pass('one discreet demo indication opens its explanation and returns focus');
  const cash = page.getByRole('button',{name:'Voir le détail : CA encaissé',exact:true}); await cash.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); assert.equal(await dialog.locator('details[open]').count(),0); await expect(dialog).toContainText('remboursements déduits');
  assert.equal(await dialog.locator('details').count(),0);
  await expect(dialog.locator('.a-d-value')).toHaveText(await page.locator('[data-metric="cash"] .a-d-value').innerText());
  await expect(dialog.locator('.results-source')).toBeVisible();
  await shot('results-cash-detail');
  for(let i=0;i<10;i++){await page.keyboard.press(i%2?'Tab':'Shift+Tab'); assert.equal(await dialog.evaluate(node=>node.contains(document.activeElement)),true);}
  await page.keyboard.press('Escape'); await expect(cash).toBeFocused(); pass('KPI drawer preserves its displayed value, concise source, focus trap and Escape without hidden audit sections');
  await page.getByRole('button',{name:/^Filtres/}).click(); await expect(page.getByLabel('Source',{exact:true})).toBeVisible(); await page.getByLabel('Source',{exact:true}).selectOption('paid'); await page.getByLabel('Tunnel',{exact:true}).selectOption('quiz');
  const request = page.waitForResponse(r=>r.url().includes('/api/dashboard?')&&r.url().includes('source=paid')&&r.url().includes('tunnel=quiz'));
  await page.getByRole('button',{name:'Appliquer',exact:true}).click(); assert.equal((await request).status(),200); await ready(); await expect(page.getByRole('button',{name:/^Filtres/})).toHaveAttribute('aria-expanded','false'); await expect(page.locator('.results-count')).toHaveText('2');
  await page.getByRole('button',{name:/^Filtres/}).click(); await expect(page.getByLabel('Source',{exact:true})).toHaveValue('paid'); await page.getByRole('button',{name:'Effacer les filtres',exact:true}).click(); await page.getByRole('button',{name:'Appliquer',exact:true}).click(); await ready(); assert.equal(await page.locator('.results-count').count(),0);
  pass('all secondary filters retained, apply closes panel, active count and reset work');
  await page.getByLabel('Du',{exact:true}).fill('2026-09-08'); await page.getByLabel('Au',{exact:true}).fill('2026-09-01'); await page.getByRole('button',{name:'Appliquer',exact:true}).click(); await expect(page.locator('.results-error')).toContainText('La date de fin');
  await page.getByLabel('Du',{exact:true}).fill('2026-09-01'); await page.getByLabel('Au',{exact:true}).fill('2026-09-07'); const correctedDates=page.waitForResponse(r=>r.url().includes('/api/dashboard?')&&new URL(r.url()).searchParams.get('to')==='2026-09-07'); await page.getByRole('button',{name:'Appliquer',exact:true}).click(); await correctedDates; await ready(); pass('invalid dates rejected without applying the draft');
  await page.locator('.a-d-chart-point').first().focus(); await expect(page.locator('.results-chart-readout')).toContainText('€'); await page.getByRole('button',{name:'Dépenses publicitaires',exact:true}).click(); await expect(page.getByRole('button',{name:'Dépenses publicitaires',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.locator('.a-d-values summary').click(); assert.equal(await page.locator('.a-d-data-table tbody tr').count(),7); await page.locator('.a-d-values summary').click(); pass('curve keyboard readout, series switch and daily values work');
  const conversion = page.getByRole('button',{name:/^03 Conversion/}); await conversion.focus(); await page.keyboard.press('Enter'); await expect(conversion).toHaveAttribute('aria-expanded','true');
  await page.getByRole('button',{name:/Taux de présence aux rendez-vous/}).click(); assert.equal(await page.getByRole('dialog').locator('details').count(),0); await expect(page.getByRole('dialog')).toContainText('66,7'); await shot('results-attendance-detail'); await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/Résultats par campagne et par lien/}).click(); await expect(page.locator('.results-table')).toBeVisible(); await page.locator('.results-table .a-t-name').first().click(); assert.equal(await page.getByRole('dialog').locator('details').count(),0); await page.keyboard.press('Escape'); await shot('results-expanded',true); pass('pillar keyboard accordion, unchanged attendance rate and campaign detail without audit sections');
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844}); await page.evaluate(()=>scrollTo(0,0)); await overflow(); await shot(`results-mobile-${width}`,true); await cash.click(); await expect(dialog).toBeVisible(); await overflow(); await page.keyboard.press('Escape');
    await expect(page.locator('.results-mobile-list')).toBeVisible();
  }
  pass('390px and 320px layouts, campaign list and drawers have no page overflow');
  for(const width of [1366,390]) { await page.setViewportSize({width,height:844}); for(const [label,heading] of [['Parcours','Du contenu au client.'],['Commercial','Le suivi commercial.'],['Liens','Un lien. Un emplacement.'],['Connexions','D’où viennent les chiffres ?']]) { await view(label); await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible(); await expect(page.locator('.blg-demo-banner')).toBeVisible(); await overflow(); await page.evaluate(()=>scrollTo(0,0)); await shot(`unchanged-${label}-${width}`); } }
  pass('four other pages preserve original headings, banners, layouts and mobile bounds');
  await page.route('**/api/dashboard?*',async route=>{const state=structuredClone(dashboard);state.metrics=state.metrics.map(m=>({...m,value:m.id==='cash'?0:m.id==='spend'?200:m.id==='leads'?8:m.value,previous:m.id==='cash'?100:m.id==='spend'?100:m.id==='leads'?0:null}));await route.fulfill({json:state});});
  await page.setViewportSize({width:1366,height:768}); await view('Résultats'); await expect(page.locator('[data-metric="cash"]')).toContainText('-100');
  await expect(page.locator('[data-metric="spend"] .a-d-change')).toHaveAttribute('data-direction','up'); await expect(page.locator('[data-metric="leads"]')).toContainText('De 0 à 8'); assert.equal(await page.locator('[data-metric="new_clients"] .a-d-change').count(),0); await shot('results-comparison-states'); pass('zero is visible, negative/positive changes signed, zero baseline readable and missing comparison omitted');
  assert.equal(errors,0); assert.equal(failures,0); pass('no browser error or failed server response');
  await fs.writeFile(`${output}/results-checks.json`,JSON.stringify({checks,bounds,errors,failures},null,2));
} finally {await browser.close();}
