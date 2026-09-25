'use client';

import { useState, type FormEvent } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import type { DashboardFilters } from '../lib/ui-contract';
import { CURRENT_MASTERCLASS_CAMPAIGNS, currentCampaignForAd } from '../lib/current-campaigns';
import { formatDate, validateDateRange } from './ui-format';

export default function JourneyFilters({ value, ads, onChange }: {
  value: DashboardFilters;
  ads: { id: string; label: string }[];
  onChange: (value: DashboardFilters) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState({ from: value.from, to: value.to });
  const [error, setError] = useState('');
  const today = Temporal.Now.plainDateISO('Europe/Paris');
  const options = [
    { id: 'today', label: 'Aujourd’hui', from: today.toString(), to: today.toString() },
    { id: 'week', label: '7 derniers jours', from: today.subtract({ days: 6 }).toString(), to: today.toString() },
    { id: 'month', label: 'Ce mois-ci', from: today.with({ day: 1 }).toString(), to: today.toString() },
  ];
  const selected = options.find(option => option.from === value.from && option.to === value.to)?.id ?? 'selected';
  const selectedAd = /^meta-ad:(\d+)$/.exec(value.campaign)?.[1] ?? null;
  const selectedCampaign = /^meta:(\d+)$/.exec(value.campaign)?.[1] ?? (selectedAd ? currentCampaignForAd(selectedAd) : null);
  const uniqueAds = [...new Map([
    ...CURRENT_MASTERCLASS_CAMPAIGNS.flatMap(campaign => campaign.ads.map(ad => ({ id: `meta-ad:${ad.id}`, label: ad.label }))),
    ...ads.filter(ad => /^meta-ad:\d+$/.test(ad.id)),
  ].map(ad => [ad.id, ad])).values()];
  if (selectedAd && !uniqueAds.some(ad => ad.id === value.campaign)) uniqueAds.push({ id: value.campaign, label: 'Publicité sélectionnée' });
  const shownAds = selectedCampaign ? uniqueAds.filter(ad => currentCampaignForAd(ad.id.slice(8)) === selectedCampaign || ad.id === value.campaign) : uniqueAds;
  function choosePeriod(id: string) {
    setError('');
    if (id === 'custom') { setDraft({ from: value.from, to: value.to }); setCustom(true); return; }
    const option = options.find(item => item.id === id);
    if (option) { setCustom(false); onChange({ ...value, from: option.from, to: option.to }); }
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    const invalid = validateDateRange(draft.from, draft.to);
    setError(invalid ?? '');
    if (!invalid) { onChange({ ...value, ...draft }); setCustom(false); }
  }
  return <div className="journey-filter-bar">
    <div className="journey-filter-pickers">
      <div className="a-field a-f-field" data-emphasis="quiet">
        <label htmlFor="journey-period">Période</label>
        <div className="a-field-shell"><select id="journey-period" value={custom ? 'custom' : selected} onChange={event => choosePeriod(event.target.value)}>
          {selected === 'selected' && <option value="selected">{formatDate(value.from)} — {formatDate(value.to)}</option>}
          {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          <option value="custom">Choisir les dates…</option>
        </select></div>
      </div>
      <div className="a-field a-f-field" data-emphasis="quiet">
        <label htmlFor="journey-campaign">Campagne</label>
        <div className="a-field-shell"><select id="journey-campaign" value={selectedCampaign ?? ''} onChange={event => onChange({ ...value, campaign: event.target.value ? `meta:${event.target.value}` : '' })}>
          <option value="">Toutes les campagnes</option>
          {CURRENT_MASTERCLASS_CAMPAIGNS.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.label}</option>)}
        </select></div>
      </div>
      <div className="a-field a-f-field" data-emphasis="quiet">
        <label htmlFor="journey-ad">Publicité</label>
        <div className="a-field-shell"><select id="journey-ad" value={selectedAd ? value.campaign : ''} onChange={event => onChange({ ...value, campaign: event.target.value || (selectedCampaign ? `meta:${selectedCampaign}` : '') })}>
          <option value="">Toutes les publicités</option>
          {shownAds.map(ad => <option key={ad.id} value={ad.id}>{ad.label}</option>)}
        </select></div>
      </div>
    </div>
    {custom && <form className="journey-custom-period" onSubmit={apply}>
      <div className="a-field a-f-field" data-emphasis="quiet"><label htmlFor="journey-from">Du</label><div className="a-field-shell"><input id="journey-from" type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} required /></div></div>
      <div className="a-field a-f-field" data-emphasis="quiet"><label htmlFor="journey-to">Au</label><div className="a-field-shell"><input id="journey-to" type="date" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} required /></div></div>
      <button className="a-button a-primary" type="submit">Appliquer</button>
      {error && <p role="alert">{error}</p>}
    </form>}
  </div>;
}
