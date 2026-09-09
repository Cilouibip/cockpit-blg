import type { DashboardFilters, Metric } from '../lib/ui-contract';

// Presentation copy is deliberately separate from source definitions and diagnostics.
// Values, availability and comparison eligibility remain supplied by the API.
export const resultCopy: Record<string, { label: string; description: string; missing: string }> = {
  cash: { label: 'CA encaissé', description: 'L’argent reçu, remboursements déduits. Montant TTC, avant frais.', missing: 'Les paiements ne sont pas encore disponibles ici pour ces dates.' },
  contracted: { label: 'CA contracté', description: 'Le montant des ventes signées, y compris ce qui reste à encaisser.', missing: 'Les ventes signées ne sont pas encore reliées à leurs montants.' },
  transactions: { label: 'Transactions', description: 'Les paiements reçus. Un paiement en plusieurs fois compte plusieurs transactions.', missing: 'Le nombre de paiements n’est pas encore disponible ici pour ces dates.' },
  spend: { label: 'Dépenses publicitaires', description: 'Le montant dépensé pour les publicités Meta.', missing: 'Les dépenses Meta ne sont pas encore disponibles pour ces dates.' },
  leads: { label: 'Leads uniques', description: 'Les personnes qui nous contactent pour la première fois pendant la période.', missing: 'Les premiers contacts ne sont pas encore disponibles ici pour ces dates.' },
  appointments: { label: 'RDV réalisés', description: 'Les rendez-vous honorés selon le suivi commercial.', missing: 'Les rendez-vous réalisés ne sont pas encore disponibles pour ces dates.' },
  new_clients: { label: 'Nouveaux clients', description: 'Les personnes qui commencent leur premier accompagnement, binômes inclus.', missing: 'Les dates de premier accompagnement ne sont pas encore disponibles ici.' },
  roas: { label: 'ROAS attribué', description: 'Le chiffre d’affaires généré pour chaque euro de publicité.', missing: 'Les achats ne sont pas encore reliés aux publicités.' },
  ad_customer_cost: { label: 'Coût pub. par nouveau client', description: 'La dépense publicitaire moyenne pour gagner un nouveau client.', missing: 'Les nouveaux clients ne sont pas encore reliés aux publicités.' },
  arrivals: { label: 'Visites des pages', description: 'Les visites sur les pages sélectionnées. Une personne peut revenir plusieurs fois.', missing: 'Les visites ne sont pas encore disponibles pour cette sélection.' },
  impressions: { label: 'Affichages des publicités', description: 'Le nombre de fois où les publicités ont été affichées.', missing: 'Les affichages Meta ne sont pas encore disponibles pour ces dates.' },
  clicks: { label: 'Clics vers le site', description: 'Les clics sur une publicité pour ouvrir le site.', missing: 'Les clics vers le site ne sont pas encore disponibles pour ces dates.' },
  ctr: { label: 'Taux de clic vers le site', description: 'La part des affichages publicitaires suivis d’un clic vers le site.', missing: 'Il manque des affichages ou des clics pour calculer ce taux.' },
  cpc: { label: 'Coût par clic vers le site', description: 'La dépense publicitaire moyenne pour un clic vers le site.', missing: 'Il manque des dépenses ou des clics pour calculer ce coût.' },
  cpm: { label: 'Coût pour 1 000 affichages', description: 'La dépense publicitaire moyenne pour mille affichages.', missing: 'Il manque des dépenses ou des affichages pour calculer ce coût.' },
  cpl: { label: 'Coût par lead acquis', description: 'La dépense publicitaire moyenne pour obtenir un nouveau contact.', missing: 'Les nouveaux contacts ne sont pas encore reliés aux publicités.' },
  showup: { label: 'Taux de présence aux rendez-vous', description: 'La part des rendez-vous honorés parmi ceux marqués réalisés ou absents.', missing: 'Les présences et absences ne sont pas encore renseignées pour ces dates.' },
  closing: { label: 'Taux de conversion après rendez-vous', description: 'La part des personnes reçues en rendez-vous qui achètent ensuite.', missing: 'Les ventes ne sont pas encore reliées aux rendez-vous.' },
  cac: { label: 'Coût total par client', description: 'Le coût moyen pour gagner un client, publicité, marketing et vente compris.', missing: 'Les dépenses de marketing et de vente ne sont pas encore disponibles ici.' },
  booked: { label: 'RDV pris', description: 'Les rendez-vous réservés pendant la période.', missing: 'Les réservations ne sont pas encore disponibles pour ces dates.' },
  no_show: { label: 'Absences', description: 'Les rendez-vous où la personne ne s’est pas présentée.', missing: 'Les absences ne sont pas encore disponibles pour ces dates.' },
  cancelled: { label: 'RDV annulés', description: 'Les rendez-vous annulés qui étaient prévus sur la période.', missing: 'Les annulations ne sont pas encore disponibles pour ces dates.' },
  closed_observed: { label: 'Ventes enregistrées', description: 'Les ventes marquées comme conclues dans le suivi commercial.', missing: 'Les ventes enregistrées ne sont pas encore disponibles pour ces dates.' },
};

export function resultSource(metric: Metric): string | null {
  const names = ['Wix', 'Notion', 'Meta', 'PostHog'].filter(name => metric.source.includes(name));
  if (names.length) return names.join(' · ');
  if (/rendez-vous|RDV|commercial/i.test(metric.source)) return 'Suivi commercial';
  if (/pages|inscription|serveur/i.test(metric.source)) return 'Pages du site';
  if (/paiement|encaissement/i.test(metric.source)) return 'Paiements';
  return null;
}

export function resultState(metric: Metric): string | null {
  if (metric.value === null) return 'Indisponible';
  if (metric.completeness !== 'partial') return null;
  if (metric.missingDays?.length) return 'Partiel';
  if (metric.source.includes('Wix') && metric.source.includes('Notion')) return 'Selon Wix et Notion';
  if (metric.source.includes('Wix')) return 'Selon Wix';
  if (metric.source.startsWith('Notion')) return 'Selon Notion';
  if (metric.provisionalDays?.length) return 'Provisoire';
  return 'Partiel';
}

export function resultMessage(metric: Metric, filters: DashboardFilters): string | null {
  const filtered = filters.source !== 'all' || filters.tunnel !== 'all' || (!!filters.campaign && filters.campaign !== 'all');
  if (metric.value === null) {
    if (filtered && (metric.source.startsWith('Notion') || ['cash', 'transactions'].includes(metric.id))) {
      return 'Ce chiffre n’est pas encore disponible avec ces filtres. Retire les filtres pour le retrouver.';
    }
    if (['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'].includes(metric.id)) {
      if (filters.source === 'organic' || filters.source === 'unknown') return 'Les statistiques publicitaires ne s’appliquent pas à cette source.';
      if (filters.campaign.startsWith('meta-creative:')) return 'Les chiffres ne sont pas encore reliés à cette création publicitaire.';
    }
    if (metric.denominator === 0) {
      if (metric.id === 'cpc') return 'Il faut au moins un clic mesuré pour calculer ce coût.';
      if (['ctr', 'cpm'].includes(metric.id)) return 'Il faut au moins un affichage mesuré pour faire ce calcul.';
      if (metric.id === 'showup') return 'Aucun rendez-vous marqué réalisé ou absent sur cette période.';
    }
    if (metric.latestAttempt?.status === 'failed' && !metric.updatedAt) return 'La mise à jour n’a pas abouti. Réessaie dans un instant.';
    return resultCopy[metric.id]?.missing ?? 'Ce chiffre n’est pas encore disponible pour cette sélection.';
  }
  const wix = metric.source.includes('Wix') && ['cash', 'transactions'].includes(metric.id)
    ? metric.id === 'cash' ? 'Ce montant couvre les paiements Wix.' : 'Les paiements enregistrés dans Wix.'
    : null;
  let message: string | null = null;
  if (metric.latestAttempt?.status === 'failed') message = 'La dernière mise à jour n’a pas abouti. Le chiffre précédent reste affiché.';
  else if (metric.completeness === 'partial') {
    if (metric.missingDays?.length) message = 'Certains jours manquent encore sur cette période.';
    else if (metric.provisionalDays?.length) message = 'Le chiffre de la dernière journée peut encore évoluer.';
    else if (metric.id === 'leads' && metric.source.startsWith('Notion')) message = 'Certains contacts ne sont pas encore comptés.';
  }
  return [wix, message].filter(Boolean).join(' ') || null;
}
