/** Campagnes et annonces de la masterclass relevées le 25 septembre 2026.
 * Ce catalogue sert aux choix visibles même avant la première visite mesurée.
 * Les chiffres proviennent toujours des lecteurs du cockpit. */
export const CURRENT_MASTERCLASS_CAMPAIGNS = [
  {
    id: '120248808857790714',
    label: 'Campagne froide',
    ads: [
      { id: '120248869859870714', label: 'V4 · Infographie kilos ou gras' },
      { id: '120248824721600714', label: 'V3 · Ils n’y croyaient pas' },
      { id: '120248824582140714', label: 'V1b · Vidéo 5.2' },
      { id: '120248809668370714', label: 'V2b · Daniel abdos fond noir' },
    ],
  },
  {
    id: '120248692706180714',
    label: 'Campagne de reciblage',
    ads: [
      { id: '120248712470690714', label: 'C1 · Ils n’y croyaient pas' },
      { id: '120248712473850714', label: 'C2 · Daniel abdos fond noir' },
    ],
  },
] as const;

export function currentCampaignForAd(adId: string): string | null {
  return CURRENT_MASTERCLASS_CAMPAIGNS.find(campaign => campaign.ads.some(ad => ad.id === adId))?.id ?? null;
}
