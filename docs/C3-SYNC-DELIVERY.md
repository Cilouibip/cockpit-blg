# Livraison C3 — actualisation et Masterclass

Lot isolé du 18 septembre 2026. Pas de migration distante, publication, relance de synchronisation ou modification des sources. Les registres privés `ETAT-ACTUEL.md` et `DECISIONS-ACTEES.md` du centre BLG restent l'autorité. Ce document décrit seulement le code et ses preuves locales.

## Correctif urgent

- La tâche horaire conserve son cron minute17, sa concurrence et sa limite15min. Elle draine dans une fenêtre12min et ne s'arrête plus au premier résultat d'unité en échec. Une erreur persistante termine toujours le workflow en échec.
- `TickSummary.status` distingue `partial`, `waiting`, `failed`, `complete`. `streams` expose l'état de chaque flux, la dernière publication (`lastSuccessAt`), sa borne de données (`dataAsOf`), la fraîcheur et les erreurs bornées. Une attente de lease n'est jamais un succès global.
- Les lectures indépendantes de suivi sont parallélisées, leur coût est mesuré, la dernière lecture est réutilisée. L’échéance se base aussi sur le créneau horaire UTC : quelques secondes d’écart entre départs ne peuvent plus faire sauter une heure. Le dernier succès reste accessible après plus de cinq échecs. Les mesures d'unités séparent appels source, base et lignes soumises. Les RPC comptés comme écritures sont des appels, pas un décompte physique des lignes modifiées.
- Masterclass réutilise la lecture PostHog asynchrone existante, avec plafond30s partagé, deux tentatives au plus, Retry-After respecté et codes transport bornés. Le dernier rapport complet reste lisible après un échec. Le chemin bloquant20s était une cause possible reproductible ; il n'est pas la cause prouvée du NETWORK_ERROR historique.
- Les inscriptions Wix/antériorité Client reçoivent le transport partagé du tick. L'annulation testée libère leur lease sans publier une page partielle.

Intégration API : `/jobs/tick` doit répondre HTTP200 pour un résultat métier `partial/waiting/failed`, afin que le workflow traite son état. Les erreurs d'authentification/configuration/API gardent leurs statuts d'erreur. Coordination propriétaire de route.ts et de l'UI.

## Lecture Notion durable — migration013 puis code

- Première passe complète ; ensuite modifications par `last_edited_time` dans une fenêtre fixe avec recouvrement2min. Le point de reprise n'avance qu'au commit de publication complet.
- Chaque cycle ajoute un inventaire **horaire** par `created_time`, limité aux IDs, métadonnées natives, Clients et Groupe d'état Noshow. Cet inventaire conditionne les suppressions et revalide les dépendances. Une réconciliation complète des propriétés reste périodique (24h) ou immédiate après changement de schéma/dépendance. Elle ne remplace pas l'inventaire horaire.
- Le schéma et les IDs de propriétés sont contrôlés. La formule archivée dépend exclusivement d'Etat ; un changement d'expression désactive le delta et force la passe complète. Une incohérence détectée par l'inventaire refuse la publication et force la reprise complète. Une relation tronquée reste une erreur explicite ; aucune valeur partielle n'est publiée.
- Le garde-fou10000 existant est conservé. Les partitions apprises sont réutilisées lors des inventaires suivants. Une partition trop dense reste une erreur, jamais une prétendue fin.
- Une page est identifiée par séquence et empreinte : rejeu identique sans double compte ; rejeu conflictuel refusé. Checkpoint et staging restent transactionnels sous lease. Une réponse terminale perdue peut être relue sans créer un second résultat.
- Les fiches inchangées gardent leur ancienne référence de publication. Le rollup utilise le miroir courant et la validité de chaque publication de ligne ; il ne filtre plus exclusivement sur le dernier `sync_run_id`. L'historique d'acquisition reste conservé après archivage. Aucun `last_edited_by`/bot ne devient une date métier.
- Migration additive013 : nouvelles signatures contrôlées et remplacement des RPC concernés, aucune modification d'une migration appliquée, aucun nouveau droit client. L'ancienne signature de claim conserve le mode inventaire complet pour un déploiement progressif.

## Vérifications locales

- Typage, suite unitaire complète et build Next en mode webpack. Le runtime réutilise node_modules par un lien local ; Turbopack refuse ce lien externe à sa racine, d'où le build webpack.
- PostgreSQL17 isolé, données synthétiques :12050fiches, partitions10000+, interruption/reprise, lease actif/expiré, rejeu et conflit, conservation inchangées/historique, suppression après inventaire (y compris suppression entre delta et inventaire), dépendance relation sans édition parent, dérive formule et repli complet, réconciliation old/new, accès RPC refusés à anon/authenticated.
- Transport/429, Masterclass asynchrone, dernière publication préservée, échec tiers sans bloquer Notion/Wix, échec persistant rouge, frontières UTC/Paris au changement d'heure.
- Fixture12050 :223→124 requêtes de données ;12579620→3464530octets. Le GET métadonnées est injecté dans ce test et exclu de ces mesures. Ce sont des mesures synthétiques, pas une promesse de durée live. Les budgets n'ont pas été augmentés sur cette base.

## Restant réel et limites

Le coordinateur doit relire/appliquer la migration au projet correct, intégrer les commits, vérifier les appels et projections réels, puis observer plusieurs cycles automatiques et une fraîcheur≤1h. Les lecteurs doivent conserver les fiches inchangées ; leur propre `sync_run_id` peut légitimement différer du dernier cycle. Aucun résultat local ne valide déjà la cadence réelle.

Les appels base actuels n'ont pas d'AbortSignal : leur timeout propre limite les écritures ; le budget45s ne garantit pas une durée totale stricte. Notion ne fournit pas un instantané transactionnel : la borne de passe est conservatrice et les nouvelles modifications passent au cycle suivant. Une relation dépassant la réponse complète disponible bloque proprement et exige une lecture paginée dédiée ; la copie valide reste disponible.

Aucun canal d'alerte supplémentaire créé, aucune préférence GitHub modifiée. Le workflow reste rouge sur panne persistante et ne produit qu'un résumé terminal. Les emails automatiques répétés peuvent subsister selon les préférences du propriétaire ; leur suppression n'est pas prétendue réglée par un faux succès.

Références techniques consultées : [fonctions Supabase](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [changelog](https://supabase.com/changelog), [filtres Notion](https://developers.notion.com/reference/filter-data-source-entries), [propriétés](https://developers.notion.com/reference/page-property-values), [limites](https://developers.notion.com/reference/request-limits). L'index changelog.md n'a pas été récupérable par le lecteur ; changelog HTML consulté.


Limite de vérification CLI : `supabase db advisors` n'a pas pu se connecter au PostgreSQL local sans TLS, même avec `sslmode=disable` (deux essais). Il n'est pas déclaré réussi ; les tests SQL vérifient directement les droits client, RLS et RPC. Le fixture de migration012 a été borné aux versions<12 afin de rester isolé des futures migrations.

## Complément PostHog — reprise entre appels courts, 18 septembre 2026

Le journal serveur autour de 16:01 UTC montre une lecture « BLG visual journey identities » terminée en 63 224 ms, après l'abandon du client. Les lectures suivantes ont réussi. Le helper utilise désormais `client_query_id` : un accusé perdu se récupère par GET du même ID, sans second POST incertain. DNS avant envoi et 429 explicite restent réessayables ; les attentes respectent le budget existant.

Contrat d'intégration opt-in : `resumable: true`, `resume?: PostHogQueryContinuation`, `onContinuation?: (c) => void`. Au budget atteint, `PostHogQueryPending` expose `continuation` et `retryAfterMs`. Le checkpoint contient version, id, origin, projectId, queryHash SHA256 du SQL exact et startedAt ; il est contrôlé avant tout appel (âge maximal 10 min). Une reprise lit uniquement le même job. Trois GET 404 peuvent attendre son enregistrement ; aucune donnée vide ni nouvelle soumission ne remplace un résultat absent. Le callback transmet l'ID dès avant le POST pour couvrir aussi un accusé jamais reçu. La couche API doit authentifier et signer ou chiffrer ce checkpoint, le lier à sa sélection exacte et garder les deux IDs des lectures parallèles. Cette intégration API/UI appartient au coordinateur.

Preuves : suite unitaire complète et typage passent ; scénario simulé de 63 s réparti en appels de 20 s avec un seul POST ; identités/périmètres/expiration/reprise404 contrôlés. Sur PostHog réel à 16:20 UTC, SELECT1 a repris en deux appels applicatifs (254 ms puis 898 ms, un POST et un GET). Une autre lecture avec accusé202 supprimé volontairement côté client a retrouvé le même job en 18,55 s, sans nouveau POST. Cette injection contrôlée valide la récupération ; elle ne prétend pas reproduire la lenteur historique. Pas de hausse de délai, migration ou mutation distante. Références : [API Queries](https://posthog.com/docs/api/queries), [query log](https://posthog.com/docs/data/query-log), [implémentation officielle client_query_id](https://github.com/PostHog/posthog/blob/master/posthog/api/query.py).
