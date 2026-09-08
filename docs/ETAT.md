# État du cockpit — 8 septembre 2026

Lire `DECISIONS-ACTEES.md` à chaque reprise. Le chantier actif est `codex/build`. Les corrections sont locales et les sources restent en lecture seule ; aucun push, déploiement ou cron activé dans ce lot. L’historique des travaux est dans `JOURNAL.md`.

## Données raccordées

Huit migrations Supabase sont installées. La migration additive 007 a été appliquée une seule fois après revue indépendante, sans rejouer les six précédentes. Elle apporte le staging privé Notion, la reprise au checkpoint et la publication atomique. Les identités utilisent le même domaine et le même HMAC que le backend existant ; aucune inscription ou conversion n’est inventée lors de l’import CRM.

Le miroir commercial Notion enrichi est publié. Les acquisitions connues utilisent le mapping versionné date réelle > historique > Wix. Les dates de création seules, les identités absentes et les copies sont comptées séparément. Présences, absences, annulations, réservations et closings décrivent le suivi courant Notion, avec provenance et couverture toujours partielle ; les créneaux remplacés ne deviennent pas des occurrences reconstituées. Les acquisitions publiées sont conservées après archivage.

Les totaux Meta du compte sont importés depuis début 2024 jusqu’au jour du relevé. Totaux et mesures quotidiennes ont été rapprochés de la source indépendamment. Les détails annonces/campagnes restent partiels, notamment avant le 23 octobre 2024 ; les créatives ne sont pas encore raccordées. Les ratios observés sont possibles sur une même plage continue, même provisoire, avec bornes explicites et comparaison désactivée lorsque la couverture est partielle.

Wix synthèse et reçus ont été importés sur les périodes autorisées. Les transactions comptent des reçus positifs distincts, échéances et reçus remboursés inclus, par date de création Wix ; les remboursements restent séparés. Cette date ne devient pas une date effective de règlement. Le cash connu conserve le périmètre Wix et une couverture partielle tant que le rapprochement financier Notion/Wix n’est pas terminé. Une période absente de Wix reste inconnue, y compris si son historique existe dans Notion.

PostHog possède des rapports exacts pour les fenêtres de recette : août, année en cours, période personnalisée et jour du relevé ; les témoins source/campagne ont leurs propres profils. Les distincts ne sont jamais additionnés entre journées. Quiz et observations du kit masterclass sont séparés ; ces dernières ne prouvent ni visite de production, ni inscription, ni durée vidéo.

## Application et actualisation

Huit cartes : encaissé, contracté, transactions, dépenses, leads, RDV, nouveaux clients et ROAS. Disposition réversible choisie par le coordinateur ; le coût publicitaire par nouveau client reste dans Acquisition. Les détails reprennent les définitions et limites retournées par l’API. Les filtres incompatibles donnent leur propre motif d’indisponibilité.

Le GET dashboard lit uniquement la base. Actualiser lance une seule lecture Wix, une lecture de reçus, les périodes Meta de 93 jours au plus et les types PostHog compatibles séparément. Notion poursuit automatiquement les requêtes courtes jusqu’à publication (40 requêtes au plus par clic), affiche sa progression et conserve le checkpoint en cas d’interruption. Le succès n’est annoncé qu’après publication complète ; une relance reprend le travail restant.

Le tick préparé choisit une seule source due et ne lit que les derniers runs du bon namespace/stream/profil. Wix/reçus/PostHog relisent le mois précédent et le mois courant. Aucun planificateur n’est actif. La migration additive 008 borne désormais la lecture des observations à la période et au profil demandés : lots quotidiens, rapport exact PostHog ou rapport Wix entier validé avant découpe. Historique conservé, dernière tentative séparée du dernier bon relevé. Cache 30 secondes, 128 entrées maximum, expirées supprimées et promesses en cours mutualisées. Restent la rotation des anciennes périodes et la planification revue, non activées.

## Validation et prochaine action

Typecheck, 162 tests unitaires, 37 tests SQL et build passent. La contre-revue indépendante a testé la publication sur plus de dix mille fiches synthétiques sous la limite locale de huit secondes ; l’import réel est ensuite parvenu au terminal sans rejet. Contre-recette source→base : Notion, compte Meta et Wix rapprochés par membres et mesures quotidiennes, avec bornes explicites. Les preuves et valeurs métiers restent uniquement dans le journal privé.

La version locale de référence est servie sur le port 3102, build `VooIRl5UAmBkQw5Y-Lnz0`. Sa contre-recette finale passe : 82 contrôles API, 17 contrôles d’interface et 129 rapprochements indépendants. Le parcours Actualiser réel a réussi auparavant en un clic jusqu’à publication, sans changement des comptes ni rejet ; les membres et valeurs avant/après ont été rapprochés indépendamment. Aucun second clic n’a été nécessaire pour valider le lecteur borné. Le manifeste et la preuve de sauvegarde privés fixent les fichiers relus et leur version locale ; les changements antérieurs sont conservés.

Prochaine action métier : expliquer la différence Notion/Wix par identifiants fournisseur exacts, puis raccorder l’historique des paiements absent de Wix. Ce rapprochement doit précéder le calcul des nouveaux clients au premier paiement prouvé. Le CA contracté nécessite encore le lien entre vente, date et montant ; l’attribution nécessite les liens et événements de bout en bout.

Restants exploitation : importer les détails Meta anciens après revue et enrichir les créatives sans remplacer les mesures ; définir la rotation historique et faire relire la planification avant activation. Le déploiement Vercel appartient au propriétaire et reste une opération séparée. Aucun total connu n’est supprimé en attendant ces raccords.

La lecture bornée a passé une contre-revue indépendante de sélection, droits, concurrence, nulls et rapports vides, puis des mesures cloud en lecture seule sans différence des valeurs. Les fenêtres annuelles respectent la limite UI de 367 jours ; les appels internes multiannuels sont plus coûteux et ne doivent pas être présentés comme ayant un coût constant. Aucun timeout global n’a été augmenté.
