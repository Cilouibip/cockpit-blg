# Connexions et installation

État vérifié le 7 septembre 2026. Ce document ne contient aucun identifiant privé ni secret. « Lecture vérifiée » ne signifie pas « synchronisation applicative installée ».

| Source | Disponible | À faire dans le produit |
|---|---|---|
| Supabase | Cinq migrations installées et données réelles persistées | Ne pas réinstaller ; prochaines évolutions additives |
| Meta | Historique quotidien importé et rapproché de l’export source | Planifier les rafraîchissements après hébergement ; raccord des conversions séparé |
| Notion | Miroir commercial importé en lecture seule | Rapprocher les identités et distinguer dates courantes et occurrences de rendez-vous |
| PostHog | Agrégats de production lus et persistés par période | Les événements navigateur restent distincts des inscriptions serveur |
| Wix | Synthèse des paiements et détail quotidien importés | Paiements par personne à raccorder pour attribution et LTV |

## Wix

Le propriétaire/co-propriétaire du compte ouvre le [gestionnaire de clés API](https://manage.wix.com/account/api-keys), crée une clé dédiée et limite l’accès à **Sites spécifiques → BLG Studio**, avec l’autorisation de base.

Dans la liste de permissions transmise par Mehdi le 7 septembre 2026, les libellés affichés sont :

- **Wix Données analytiques** : consultation des statistiques du site.
- **Wix Cashier** : consultation des transactions du site.

Ce sont les deux cases retenues pour préparer la clé. Ne pas sélectionner **Tout** ni **Wix Payments**, dont le texte inclut la gestion des transactions, litiges et remboursements. Le coordinateur confirme ensuite avoir reçu la clé et le site ID dans l’environnement privé racine : lecture des modèles Analytics et d’une transaction APPROVED réussies (HTTP 200). Le connecteur Analytics a ensuite été relié au cockpit. Aucun montant ni donnée individuelle n’est copié dans ce document.

La documentation de l’API Analytics nomme **Site Analytics – read** (`SCOPE.DC-ANALYTICS-AND-REPORTS.READ-SITE-ANALYTICS`). C’est le nom du droit requis par l’API, pas le libellé à chercher tel quel dans l’écran de création de clé. L’ancienne consigne mélangeait ces deux niveaux. Le [support Wix sur la granularité des clés](https://support.wix.com/en/article/developer-request-adding-granular-scope-permissions-for-api-keys) décrit aussi une limite de distinction lecture/écriture : les cases visibles ne suffisent donc pas à conclure que la clé entière est techniquement limitée à la lecture. Le connecteur, lui, n’effectue que des opérations de lecture.

Les appels REST du site portent l'en-tête d'autorisation côté serveur et `wix-site-id`. L'accès MCP de Codex ne doit jamais être extrait ni supposé disponible pour l'application hébergée. Le contrat du connecteur vérifie les modèles et champs réels avant la requête ; absences et remboursements inconnus restent explicites. Documentation : [génération de clé](https://dev.wix.com/docs/develop-websites/articles/coding-with-velo/authorization/generate-an-api-key), [appels REST](https://dev.wix.com/docs/develop-websites/articles/coding-with-velo/authorization/make-rest-api-calls-with-an-api-key), [modèles Analytics](https://dev.wix.com/docs/api-reference/business-management/analytics/skills/query-site-analytics).

## Supabase

L’installation du projet est terminée : le coordinateur a appliqué les cinq fichiers SQL inchangés depuis `a79f991` via MCP et vérifié les versions 1–5. Les preuves détaillées restent dans le journal privé.

Les imports réels sont chargés ; aucune démonstration distante. Ne pas réappliquer les cinq migrations ni demander une nouvelle connexion pour cette installation. La clé privée serveur est utilisée par l’application.

## PostHog et pages

Le cockpit lit les événements déjà mesurés via des requêtes agrégées pour son affichage. Il conserve les distincts sur toute la période et ne somme pas les visiteurs journaliers. Il n’effectue aucun export brut Query. Une destination/export officiel peut alimenter un schéma d'arrivée avec un utilisateur limité et des propriétés minimisées ; son activation et son éventuel coût ne sont pas autorisés par défaut. Préparer une ingestion first-party si préférable, en conservant des IDs canoniques partagés pour éviter le double comptage. [API et limites](https://posthog.com/docs/api), [batch export Postgres](https://posthog.com/docs/cdp/batch-exports/postgres).

Les snippets quiz/masterclass sont livrés aux tâches qui gèrent ces pages, sans modification live par la tâche cockpit. Vercel est configuré et déployé par le propriétaire avec le guide livré ; aucune connexion Vercel n'est nécessaire pour coder et tester localement.


Extension 006 installée et vérifiée : PostHog est ajouté au journal d’import existant. Registre métier 1–6 ; aucune table, politique ou permission supplémentaire. Les cinq migrations initiales ne sont pas réappliquées.
