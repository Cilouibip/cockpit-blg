# État du cockpit — 7 septembre 2026

Référence de reprise : `../DECISIONS-ACTEES.md`. Les preuves, exports et montants métiers restent dans le journal privé.

## Disponible

- Six migrations Supabase installées et vérifiées ; pas de réinstallation nécessaire.
- Historique quotidien Meta importé, rapproché de l’export source sans double comptage. Les partitions interrompues restent hors publication jusqu’à leur reprise complète.
- Miroir des propriétés commerciales Notion importé ; le découpage des requêtes permet de dépasser le plafond source de 10 000 résultats. Lecture seule côté Notion.
- Encaissements Wix TTC issus de la synthèse des paiements : remboursements, cartes cadeaux utilisées et rétrofacturations selon la définition Wix, avant frais de paiement. Totaux et courbe quotidienne ; les mois sans mesure restent distincts d’un zéro.
- Quiz PostHog : agrégats de visiteurs et sessions par événement et hôte de production, sur la période entière ; questions techniques sans réponses personnelles. Les domaines de test identifiables sont exclus.
- Résultats reconstruits avec Atelier A : KPI en haut, filtres secondaires repliés, détails à la demande, piliers en accordéons. Raccourcis de dates, années et trimestres disponibles.
- Générateur de liens et registre persistant ; URL et emplacement explicités.

## En attente

Les inscriptions serveur, les présences effectives, les ventes et leurs correspondances d’identité ne sont pas encore raccordées de bout en bout. Les événements navigateur PostHog ne sont pas transformés en inscriptions backend ou en personnes CRM. Les dates courantes Notion restent des dates courantes, pas un historique de rendez-vous distincts. ROAS attribué, CAC complet et LTV attendent les données nécessaires.

Le propriétaire coordonne le déploiement Vercel et l’installation des snippets par les responsables du quiz et de la masterclass. La fréquence des synchronisations Meta/Notion après hébergement reste à configurer ; un ordinateur fermé ne maintient pas l’application locale en ligne. Les changements de filtre lisent désormais uniquement Supabase. Les rapports Wix quotidiens sont recomposés sans doublons ; les visiteurs PostHog utilisent un rapport exact de période déjà importé. Les périodes PostHog non importées nécessitent le bouton Actualiser ; aucune somme de visiteurs quotidiens. Le bouton relit Wix/PostHog séparément de la navigation. La planification périodique après hébergement reste à activer.

La revue humaine de Résultats reste attendue avant la reconstruction UX des autres pages. [Demande de revue en brouillon](https://github.com/Cilouibip/cockpit-blg/pull/1).


Extension 006 installée et vérifiée : PostHog est ajouté au journal d’import existant. Registre métier 1–6 ; aucune table, politique ou permission supplémentaire. Les cinq migrations initiales ne sont pas réappliquées.


## Audit des données — correction du 7 septembre

Le contrôle initial couvrait août et début septembre, pas toutes les périodes ni tous les KPI. Le filtre annuel a révélé une pagination Wix incompatible avec les hypothèses du lecteur, et la page attendait des requêtes Wix/PostHog. Ces appels ont été retirés du GET dashboard. Une page Wix plus grande a permis de relire le rapport annuel complet et réconcilié ; les erreurs de pagination, doublons et désaccords de totaux restent bloquants. Les comparaisons disponibles, dont les dépenses, sont de nouveau transmises.

L'audit indépendant confirme que le miroir Notion omet encore des champs disponibles : acquisition, réservation, closing, canal et entrée du tunnel. Leur import et leur branchement aux KPI restent à terminer. Les états courants et les dates de closing/rendez-vous doivent être présentés avec leurs définitions propres ; une ligne CRM ne suffit pas à qualifier un nouveau client global. Le suivi par campagne manque aussi de raccords d'identité et plusieurs colonnes sont encore laissées vides dans le code.

Le suivi des liens n'est pas installé de bout en bout. Le registre existe, mais le collecteur et le raccord serveur aux inscriptions doivent être intégrés dans les pages par leurs responsables. L'alignement des noms de paramètres avec le projet masterclass a été demandé à sa tâche responsable. Ne pas annoncer un ROAS ou un résultat commercial par publicité comme disponible.
