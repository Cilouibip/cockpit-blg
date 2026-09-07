# Connexions et installation

État vérifié le 7 septembre 2026. Ce document ne contient aucun identifiant privé ni secret. « Lecture vérifiée » ne signifie pas « synchronisation applicative installée ».

| Source | Disponible | À faire dans le produit |
|---|---|---|
| Supabase | Cinq migrations installées et vérifiées via MCP par le coordinateur ; registre 1–5, tables privées avec RLS | Contrôle des premiers imports métier ; aucune réinstallation SQL à faire |
| Meta | Compte autorisé, jeton, lecture du compte et Insights HTTP 200 | Adaptateur paginé, reprises, profils de reporting, stockage et couverture ; une réponse vide de test n'est pas un montant zéro validé |
| Notion | Jeton et accès au schéma de la base Prospects | Miroir des champs commerciaux autorisés, correspondances de statuts et historique des observations, en lecture seule |
| PostHog | Hôte, ID du projet et clé privée de lecture | Adaptation des événements existants, collecte des événements manquants ou destination officielle appropriée ; ne pas utiliser Query comme export brut périodique massif |
| Wix | Clé serveur privée reçue ; coordinateur : lectures des modèles Analytics et d’une transaction APPROVED réussies (HTTP 200) | Aucun import métier ; réconcilier agrégats, transactions et personnes avant attribution ou LTV |

## Wix

Le propriétaire/co-propriétaire du compte ouvre le [gestionnaire de clés API](https://manage.wix.com/account/api-keys), crée une clé dédiée et limite l’accès à **Sites spécifiques → BLG Studio**, avec l’autorisation de base.

Dans la liste de permissions transmise par Mehdi le 7 septembre 2026, les libellés affichés sont :

- **Wix Données analytiques** : consultation des statistiques du site.
- **Wix Cashier** : consultation des transactions du site.

Ce sont les deux cases retenues pour préparer la clé. Ne pas sélectionner **Tout** ni **Wix Payments**, dont le texte inclut la gestion des transactions, litiges et remboursements. Le coordinateur confirme ensuite avoir reçu la clé et le site ID dans l’environnement privé racine : lecture des modèles Analytics et d’une transaction APPROVED réussies (HTTP 200). Ces vérifications ne constituent pas un import métier ; aucune donnée individuelle n’est copiée dans ce document. La tâche UX n’a effectué aucun appel Wix.

La documentation de l’API Analytics nomme **Site Analytics – read** (`SCOPE.DC-ANALYTICS-AND-REPORTS.READ-SITE-ANALYTICS`). C’est le nom du droit requis par l’API, pas le libellé à chercher tel quel dans l’écran de création de clé. L’ancienne consigne mélangeait ces deux niveaux. Le [support Wix sur la granularité des clés](https://support.wix.com/en/article/developer-request-adding-granular-scope-permissions-for-api-keys) décrit aussi une limite de distinction lecture/écriture : les cases visibles ne suffisent donc pas à conclure que la clé entière est techniquement limitée à la lecture. Le connecteur, lui, n’effectue que des opérations de lecture.

Les appels REST du site portent l'en-tête d'autorisation côté serveur et `wix-site-id`. L'accès MCP de Codex ne doit jamais être extrait ni supposé disponible pour l'application hébergée. Le contrat du connecteur vérifie les modèles et champs réels avant la requête ; absences et remboursements inconnus restent explicites. Documentation : [génération de clé](https://dev.wix.com/docs/develop-websites/articles/coding-with-velo/authorization/generate-an-api-key), [appels REST](https://dev.wix.com/docs/develop-websites/articles/coding-with-velo/authorization/make-rest-api-calls-with-an-api-key), [modèles Analytics](https://dev.wix.com/docs/api-reference/business-management/analytics/skills/query-site-analytics).

## Supabase

L’installation du projet est terminée : le coordinateur a appliqué les cinq fichiers SQL inchangés depuis `a79f991` via MCP et vérifié les versions 1–5. Les preuves détaillées restent dans le journal privé.

Aucun import réel ni démonstration distante n’a été chargé. Ne pas réappliquer les cinq migrations ni demander une nouvelle connexion pour cette installation. L’application utilisera sa clé serveur ; la prochaine étape de données concerne les premiers imports contrôlés.

## PostHog et pages

Réutiliser les événements déjà mesurés. Une destination/export officiel peut alimenter un schéma d'arrivée avec un utilisateur limité et des propriétés minimisées ; son activation et son éventuel coût ne sont pas autorisés par défaut. Préparer une ingestion first-party si préférable, en conservant des IDs canoniques partagés pour éviter le double comptage. [API et limites](https://posthog.com/docs/api), [batch export Postgres](https://posthog.com/docs/cdp/batch-exports/postgres).

Les snippets quiz/masterclass sont livrés aux tâches qui gèrent ces pages, sans modification live par la tâche cockpit. Vercel est configuré et déployé par le propriétaire avec le guide livré ; aucune connexion Vercel n'est nécessaire pour coder et tester localement.
