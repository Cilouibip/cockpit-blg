# État du cockpit — 7 septembre 2026

Référence de reprise : `../DECISIONS-ACTEES.md`. Les preuves, exports et montants métiers restent dans le journal privé.

## Disponible

- Cinq migrations Supabase installées et vérifiées ; pas de réinstallation nécessaire.
- Historique quotidien Meta importé, rapproché de l’export source sans double comptage. Les partitions interrompues restent hors publication jusqu’à leur reprise complète.
- Miroir des propriétés commerciales Notion importé ; le découpage des requêtes permet de dépasser le plafond source de 10 000 résultats. Lecture seule côté Notion.
- Encaissements Wix TTC issus de la synthèse des paiements : remboursements, cartes cadeaux utilisées et rétrofacturations selon la définition Wix, avant frais de paiement. Totaux et courbe quotidienne ; les mois sans mesure restent distincts d’un zéro.
- Quiz PostHog : agrégats de visiteurs et sessions par événement et hôte de production, sur la période entière ; questions techniques sans réponses personnelles. Les domaines de test identifiables sont exclus.
- Résultats reconstruits avec Atelier A : KPI en haut, filtres secondaires repliés, détails à la demande, piliers en accordéons. Raccourcis de dates, années et trimestres disponibles.
- Générateur de liens et registre persistant ; URL et emplacement explicités.

## En attente

Les inscriptions serveur, les présences effectives, les ventes et leurs correspondances d’identité ne sont pas encore raccordées de bout en bout. Les événements navigateur PostHog ne sont pas transformés en inscriptions backend ou en personnes CRM. Les dates courantes Notion restent des dates courantes, pas un historique de rendez-vous distincts. ROAS attribué, CAC complet et LTV attendent les données nécessaires.

Le propriétaire coordonne le déploiement Vercel et l’installation des snippets par les responsables du quiz et de la masterclass. La fréquence des synchronisations Meta/Notion après hébergement reste à configurer ; un ordinateur fermé ne maintient pas l’application locale en ligne. Wix/PostHog se rafraîchissent pour les dates demandées, avec un cache de 15 minutes.

La revue humaine de Résultats reste attendue avant la reconstruction UX des autres pages. [Demande de revue en brouillon](https://github.com/Cilouibip/cockpit-blg/pull/1).


Extension 006 installée et vérifiée : PostHog est ajouté au journal d’import existant. Registre métier 1–6 ; aucune table, politique ou permission supplémentaire. Les cinq migrations initiales ne sont pas réappliquées.
