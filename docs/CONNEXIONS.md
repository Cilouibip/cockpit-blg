# Connexions et installation

État vérifié le 7 septembre 2026. Ce document ne contient aucun identifiant privé ni secret. « Lecture vérifiée » ne signifie pas « synchronisation applicative installée ».

| Source | Disponible | À faire dans le produit |
|---|---|---|
| Supabase | URL et clés applicatives privées | Migration revue puis installation avec une connexion PostgreSQL autorisée ou dans SQL Editor ; les clés REST ne suffisent pas au DDL |
| Meta | Compte autorisé, jeton, lecture du compte et Insights HTTP 200 | Adaptateur paginé, reprises, profils de reporting, stockage et couverture ; une réponse vide de test n'est pas un montant zéro validé |
| Notion | Jeton et accès au schéma de la base Prospects | Miroir des champs commerciaux autorisés, correspondances de statuts et historique des observations, en lecture seule |
| PostHog | Hôte, ID du projet et clé privée de lecture | Adaptation des événements existants, collecte des événements manquants ou destination officielle appropriée ; ne pas utiliser Query comme export brut périodique massif |
| Wix | Lecture MCP des agrégats de paiement | Clé API propre au serveur, puis import des agrégats ; vérifier les transactions rattachables à une personne avant attribution ou LTV |

## Wix

Le propriétaire/co-propriétaire du compte ouvre le [gestionnaire de clés API](https://manage.wix.com/account/api-keys), crée une clé dédiée au cockpit et limite les sites autorisés au site visé. Pour la recette Analytics utilisée : permission **Site Analytics – read** (`SCOPE.DC-ANALYTICS-AND-REPORTS.READ-SITE-ANALYTICS`). Une lecture des paramètres du site peut être ajoutée si le connecteur récupère dynamiquement le fuseau. Pas de permission d'écriture ou remboursement.

Les appels REST du site portent l'en-tête d'autorisation côté serveur et `wix-site-id`. L'accès MCP de Codex ne doit jamais être extrait ni supposé disponible pour l'application hébergée. Le contrat du connecteur vérifie les modèles et champs réels avant la requête ; absences et remboursements inconnus restent explicites. Documentation : [génération de clé](https://dev.wix.com/docs/develop-websites/articles/coding-with-velo/authorization/generate-an-api-key), [appels REST](https://dev.wix.com/docs/develop-websites/articles/coding-with-velo/authorization/make-rest-api-calls-with-an-api-key), [modèles Analytics](https://dev.wix.com/docs/api-reference/business-management/analytics/skills/query-site-analytics).

## Supabase

Installation autonome : chaîne PostgreSQL du bouton **Connect** avec le mot de passe du projet. Pour les migrations, connexion directe ou Session pooler selon la connectivité ; ne pas utiliser un pool transactionnel comme une session persistante. Alternative sans nouveau secret : le propriétaire exécute le fichier SQL revu dans **SQL Editor**. Aucun jeton global de gestion n'est nécessaire par défaut. [Documentation des connexions](https://supabase.com/docs/guides/database/connecting-to-postgres).

Avant application : vérifier le projet exact, exécuter les migrations sur PostgreSQL de test, examiner les droits et ne lancer aucune réinitialisation destructive. L'application utilise ensuite sa clé serveur ; le navigateur ne reçoit pas de clé secrète.

## PostHog et pages

Réutiliser les événements déjà mesurés. Une destination/export officiel peut alimenter un schéma d'arrivée avec un utilisateur limité et des propriétés minimisées ; son activation et son éventuel coût ne sont pas autorisés par défaut. Préparer une ingestion first-party si préférable, en conservant des IDs canoniques partagés pour éviter le double comptage. [API et limites](https://posthog.com/docs/api), [batch export Postgres](https://posthog.com/docs/cdp/batch-exports/postgres).

Les snippets quiz/masterclass sont livrés aux tâches qui gèrent ces pages, sans modification live par la tâche cockpit. Vercel est configuré et déployé par le propriétaire avec le guide livré ; aucune connexion Vercel n'est nécessaire pour coder et tester localement.
