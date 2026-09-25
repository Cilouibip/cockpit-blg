import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JourneyFilters from '../src/components/JourneyFilters';
import { ResultsFilters } from '../src/components/ResultsPage';
import type { DashboardFilters } from '../src/lib/ui-contract';

const filters: DashboardFilters = { from: '2026-09-25', to: '2026-09-25', source: 'paid', tunnel: 'masterclass', campaign: '', compare: false };
const renderJourney = (campaign: string) => renderToStaticMarkup(createElement(JourneyFilters, { value: { ...filters, campaign }, ads: [], onChange: () => {} }));

test('les deux campagnes et leurs six annonces restent sélectionnables avant les premières arrivées', () => {
  const all = renderJourney('');
  assert.match(all, /Campagne froide/);
  assert.match(all, /Campagne de reciblage/);
  assert.equal((all.match(/value="meta-ad:/g) ?? []).length, 6);
  const cold = renderJourney('meta:120248808857790714');
  assert.equal((cold.match(/value="meta-ad:/g) ?? []).length, 4);
  const retarget = renderJourney('meta:120248692706180714');
  assert.equal((retarget.match(/value="meta-ad:/g) ?? []).length, 2);
});

test('Résultats affiche les deux campagnes dans le filtre rapide', () => {
  const html = renderToStaticMarkup(createElement(ResultsFilters, { draft: filters, applied: filters, onChange: () => {}, onApply: () => {}, campaigns: [{ id: 'meta:120248692698770714', label: 'Campagne historique' }], busy: false, error: '' }));
  assert.match(html, /Campagne froide/);
  assert.match(html, /Campagne de reciblage/);
  assert.match(html, /Toutes les campagnes/);
});
