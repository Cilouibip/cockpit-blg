# Connecteurs serveur — état, contrats et reprise

Lire `../DECISIONS-ACTEES.md` et `SCHEMA-REVU.md` à chaque reprise. Les clés réelles restent dans l'environnement serveur ignoré ; ce document n'en contient aucune. Tous les appels métier des connecteurs sont en lecture seule. Les `POST` Notion et Wix sont des requêtes de lecture.

## État réellement vérifié le 7 septembre 2026

| Source | Preuve technique de cette construction | Alimentation du cockpit |
|---|---|---|
| Meta | Nouveau module `syncMeta` exécuté sur le compte fourni, contrôle d'identité/devise/fuseau puis Insights publicité/jour du 1 au 6 septembre. Réponse complète vide ; aucun montant ou campagne copié dans le dépôt. | Accès de lecture vérifié. Le bouton d'import/persistance est intégré séparément ; la preuve HTTP n'est pas une programmation automatique. |
| Notion | GET du schéma de la data source, HTTP 200 et identité correspondante. Projection commerciale ci-dessous contrôlée. Aucun prospect ni bloc de page lu pour cette vérification. | Module paginé prêt. Un miroir actuel ne prouve pas l'historique des rendez-vous ni la présence ou les ventes. |
| PostHog | Nouveau `probePostHog` exécuté : GET du projet exact accepté. Aucune Query/export d'événements. | `automaticFeed:false`. Instrumentation first-party préparée, non installée ; conserver la mesure existante. |
| Wix | Recette officielle Analytics lue ; adaptateur testé avec fixtures synthétiques. L'accès MCP aux agrégats avait été confirmé dans le cadrage. | Clé privée reçue et lectures Analytics/transaction APPROVED réussies HTTP 200 par le coordinateur. Aucun import métier, attribution ou LTV réelle. |

Une réponse Meta vide correspond à `status:'empty'`, `records:[]`. Aucun enregistrement de dépense nulle n'est créé. Un checkpoint complet documente la lecture demandée ; il ne garantit ni activité nulle ni couverture historique commerciale. Les statuts sont distincts : `not_configured`, `failed`, `partial`, `empty`, `complete`.

## Contrat des adaptateurs

Exports depuis `src/connectors/index.ts` : `syncMeta`, `syncNotion`, `syncWixAggregates`, `wixConnectionState`, `probePostHog`, types et `BLG_NOTION_FIELDS`.

Chaque synchronisation retourne `SyncBatch<T>` : source, accountId, version, status, records, coverage `{from,to,complete,reason?,observedAt?}`, checkpoint `{cursor?,completedThrough?}`, counts `{read,accepted,rejected,pages}`, safeError facultative. `accepted` désigne les clés uniques de cette tentative, `read` les lignes lues, retries et doublons compris. Les curseurs ne doivent pas être affichés dans l'interface publique.

Options `from`, `to`, `fetcher`, `sleep`, `now`, `maxPages`, `cursor` et `commitPage` : callback `async ({records,checkpoint,terminal})`. Le callback doit écrire une page **et** son checkpoint dans la même transaction. S'il échoue, le connecteur conserve le checkpoint validé précédent. `terminal` ne suffit pas à publier : consulter le `status`, les rejets et la couverture finale.

Meta et agrégats : les pages alimentent un lot non publié ; seul un run complet permet la publication des partitions. Le dernier lot complet est sélectionné avant ses lignes, même quand le lot est vide. Notion : les mises à jour courantes peuvent être visibles avec leur date d'observation, mais la couverture globale reste partielle jusqu'à la fin. L'historique initial est distinct d'un changement et ne remonte pas avant la première observation.

Un nouveau run rejoue les partitions en conservant les clés stables ; la route intégrée relit depuis le départ. Une reprise manuelle au curseur doit rester attachée au même lot incomplet, jamais créer une couverture complète à partir de sa seule dernière page. Les callbacks d'import doivent aussi refuser qu'une version source plus ancienne remplace une plus récente.

L'HTTP partagé utilise hôtes fixes, Authorization en en-tête, `redirect:'error'`, timeout 15 secondes, au plus trois essais par défaut et corps de réponse borné à 2 Mo. Seuls réseau, 429 et 5xx sont réessayés, avec attente bornée. Les erreurs exposées sont des codes contrôlés et éventuellement un statut HTTP ; aucun message amont, URL, corps, stack ou jeton ne passe dans les résultats. Un curseur répété ou absent quand la source annonce une suite interrompt le run.

## Meta

`MetaConfig` demande `accessToken`, `accountId`, `from` et `to` en dates civiles `YYYY-MM-DD` dans le fuseau **du compte**, fin exclue. `v23.0` est la version explicite par défaut, configurable. Le compte est relu avec `account_id,currency,timezone_name` avant Insights. EUR utilise l'exposant 2 ; une autre monnaie exige un exposant explicite.

GET Insights : niveau ad, `time_increment=1`, aucun breakdown, bornes `since` inclus et `until` égal au jour précédant `to`, champs projetés et pages de 100. La pagination reconstruit toujours la même URL sur `graph.facebook.com` avec seulement `paging.cursors.after` ; elle ne suit jamais `paging.next`, susceptible de contenir un jeton.

`MetaAdDay` renvoie IDs/libellés observés, date native, devise/fuseau, `spendMinor`, `impressions`, `outboundClicks` nullable. L'absence de `outbound_clicks` n'est pas remplacée par `clicks`. Les anciennes annonces sont conservées même sans catalogue courant. Pas de ventilation de dépense entre Instagram/Facebook, assets ou tunnels sans mesure distincte.

Les `reportedConversions` ne sont demandées que si `reportingWindows` est explicitement fourni ; elles portent action, fenêtre, `reportingTime:'impression'` et `method:'meta_reported'`. Fenêtres et familles d'action ne s'additionnent pas. Le profil de base ne compte jamais sa dépense plusieurs fois en joignant les conversions. Un import planifié doit relire une période récente au moins égale à la fenêtre utilisée avec marge technique ; aucun abonnement ni planificateur payant n'a été activé.

Documentation primaire : [SDK officiel Meta, pagination](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/api.py), [champs Insights du SDK officiel](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py), [collection officielle Marketing API](https://www.postman.com/meta/facebook-marketing-api/documentation/0zr4mes/facebook-marketing-api-mapi). Les pages directes de documentation Meta ont limité la lecture HTTP ; les sources officielles SDK/collection ont servi à vérifier champs et curseurs.

## Notion

Version d'API fixée à `2025-09-03`, endpoint `/v1/data_sources/{id}/query`, tri ascendant `last_edited_time`, intervalle `[from,to)`, `start_cursor`, page_size 100 et projection `filter_properties[]`. Aucune requête de blocs, de fiche complète, de données de santé ou d'email. La limite maximale de 10 000 résultats est traitée comme incomplète si atteinte ; réduire les fenêtres d'import pour continuer.

`BLG_NOTION_FIELDS` provient du schéma commercial vérifié :

| Champ domaine | Propriété Notion | Type |
|---|---|---|
| name | Nom complet | title |
| status | Etat | select |
| responsible | Animateur RDV | select |
| closer | Closer | relation |
| appointmentAt | Date du RDV | date |
| nextFollowUpAt | À relancer le | date |

`responsible` contient le libellé commercial sélectionné. `closer` conserve des IDs de relation opaques, sans parcourir la base cible. Les types people/relation peuvent fournir des IDs ; aucune adresse email ou image utilisateur n'est extraite. Les dates sans heure restent des dates sans heure : ne pas inventer un timestamp de présence.

Une ligne `NotionProspect` est une proposition de miroir courant. `personId` reste null sans preuve d'identité. Le statut source est conservé ; aucun mapping Closé→paiement ni présence n'est fourni. Même un mapping technique vers `attended` reste inconnu dans ce connecteur en l'absence de preuve de présence. La date courante d'une fiche sans ID de réservation stable produit un emplacement courant, pas une série de RDV distincts. Les suppressions qui ne sont plus retournées par la requête ne sont pas devinées depuis une absence de ligne.

Documentation primaire : [Query a data source](https://developers.notion.com/reference/query-a-data-source), [migration d'API 2025-09-03](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03).

## Wix

`wixConnectionState` distingue clé absente de clé présente non vérifiée. L'authentification serveur est `Authorization` + `wix-site-id` ; le MCP interactif n'est pas une réserve de clés à extraire. Le droit documenté par l’API Analytics est `Site Analytics – read` ; ce nom ne décrit pas une case vérifiée dans l’interface de création de clé. La liste transmise par Mehdi le 7 septembre 2026 affiche **Wix Données analytiques** (consulter les statistiques) et **Wix Cashier** (consulter les transactions). Ces deux cases sont retenues, avec Sites spécifiques → BLG Studio et autorisation de base ; ni Tout, ni Wix Payments. Mise à jour du coordinateur : clé et site ID reçus dans l’environnement privé racine ; lectures des modèles Analytics et d’une transaction APPROVED réussies HTTP 200. Aucun import métier ni copie de transaction dans Git. Ces lectures ont été effectuées séparément de la tâche UX.

Le caractère exclusivement lecteur de cet adaptateur décrit ses appels, pas une garantie de restriction de la clé entière. Le [support officiel Wix](https://support.wix.com/en/article/developer-request-adding-granular-scope-permissions-for-api-keys) signale des limites de granularité des clés API. Voir [CONNEXIONS.md](CONNEXIONS.md) pour distinguer le droit requis par l’API, les libellés réellement vus et l’état des accès.

`syncWixAggregates` exige un mapping revu : ID/slug de modèle réellement découvert, champ de mesure, champ devise, dépendances, date de revue, exposant et base de taxe. Il vérifie List→Get contre ce mapping explicite avant Query. Aucun champ n'est choisi par ressemblance de nom. Les dépendances et l'identité du modèle sont contrôlées ; un champ silencieusement absent entraîne un rejet, jamais zéro.

Les intervalles sont des instants UTC correspondant aux bornes locales voulues, avec timezone explicite. La pagination offset est bornée. Le retour est `SourceAggregate` avec `transactionGrain:false`, période/dimensions exactes et aucun personId. Les paramètres de mapping ne doivent contenir que les dimensions agrégées commerciales revues ; pas de champs d'email, nom, instrument de paiement ou contenu libre. Pour une mesure numérique négative, choisir une normalisation explicitement revue : l'adaptateur monétaire courant accepte des montants positifs ou nuls et n'interprète pas le signe d'un refund.

Le raccord transactionnel reste distinct : ID canonique, reçu/refund/contrepassation, date effective, devise/base, personne nullable, parent du refund et preuve d'historique. Un total Analytics ne fournit aucun de ces objets individuels. Sans clé et preuve transactionnelle, ne pas activer la route de synchronisation réelle ni le ROAS/LTV.

Documentation primaire lue via outils de documentation Wix : [recette Query Site Analytics](https://dev.wix.com/docs/api-reference/business-management/analytics/skills/query-site-analytics). Base officielle utilisée : `https://www.wixapis.com/analytics/semantic-model/v3/semantic-models` ; GET liste/schéma et POST `query-data` pour la lecture.

## PostHog et nouvelles observations

`probePostHog` lit une fois `/api/projects/{id}/` sur le host privé EU/US explicitement autorisé, vérifie l'identité et ne conserve ni nom du projet ni données utilisateur. Il ne fait pas d'export Query et ne dit jamais que le cockpit reçoit déjà les événements.

La V1 livre le collecteur first-party et les contrats décrits dans `DATA-CONTRACT.md`. Le propriétaire des pages choisit son raccord et conserve la mesure existante. Un export historique régulier devra utiliser une destination officielle et un mapping minimal avec coût vérifié ; aucune option n'est activée silencieusement.

Documentation primaire : [API PostHog, clés et limites](https://posthog.com/docs/api), [batch exports](https://posthog.com/docs/cdp/batch-exports), [destination Postgres](https://posthog.com/docs/cdp/batch-exports/postgres).
