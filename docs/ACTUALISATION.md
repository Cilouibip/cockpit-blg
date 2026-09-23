# Actualisation toutes les 30 minutes : analyse et procédure de bascule

Document de travail pour Codex. Rien n'est activé : le code est local, le SQL est préparé dans `supabase/manual/` et le workflow GitHub est inchangé. La collecte actuelle (GitHub, départs à 17, 37 et 57 minutes) reste en service jusqu'à la bascule décrite en section 5.

Principe : un déclenchement toutes les 30 minutes ne prouve pas une actualisation toutes les 30 minutes. La seule preuve est la table `sync_runs` : date de la dernière publication complète de chaque flux (`status` `complete` ou `empty`, `pagination_complete`).

## 1. Ce que dit le code (lu) et ce qui est estimé

### 1.1 Règles lues dans le code

| Règle | Valeur | Où |
|---|---|---|
| Budget d'un appel `GET /api/jobs/tick` | 45 s, dont 40 s de lectures sources et 5 s réservées aux écritures | `src/lib/sync-budget.ts` |
| Durée maximale de la route | 60 s | `src/app/api/[...path]/route.ts` (`maxDuration`) |
| Limite de débit de `jobs/tick` | aucune ; réponse HTTP 200 pour tout état métier | route |
| Démarrage d'une unité | seulement s'il reste au moins son délai source : Notion 20 s ; Meta compte, CA Wix, paiements reçus, inscriptions, antériorité client 25 s ; publicités par jour, catalogue, PostHog quiz et Masterclass, trois KPI 30 s | `sourceTimeoutMs` dans `sync-jobs.ts` |
| Unités par passage | 1 par flux non reprenable ; 4 au plus par flux reprenable (Notion, PostHog, inscriptions, antériorité) | `MAX_CHUNKS` |
| Ordre | le flux dû touché le plus anciennement passe d'abord | `chooseSyncJob` |
| Flux dû | aucune publication ; tentative en cours sans bail ; début de la tentative précédente + cadence ; entrée dans le créneau UTC suivant de la cadence ; données publiées plus anciennes que la cadence | `syncStreamStates` |
| Après un échec | attente de 5 minutes | idem |
| Bail actif | le flux est « waiting » (fin du bail, ou 10 minutes après le départ s'il n'y a pas de bail) | idem |
| Verrou par flux en base | `begin_sync_stream` : verrou consultatif, tentative « running » de plus de 10 minutes passée en échec `expired_worker`, sinon refus 55P03 (traduit en 409 `source_busy`) ; `cockpit_claim_notion`, `_lead_entries`, `_posthog` : bail de 2 minutes, réponse « occupé » sans écriture | migrations 007, 009, 013, 016 |

Conséquence directe de la règle de démarrage : une unité à délai 30 s ne part que si 30 s restent sur 40. Si la première unité d'un passage dure plus de 10 s, aucune autre unité à 30 s ne peut partir dans ce passage. C'est la vraie limite de capacité, plus que le nombre de flux.

### 1.2 Mesures déjà disponibles (documentées le 18/09, `docs/C3-SYNC-DELIVERY.md`)

Un passage Notion complet = 36 unités, 106 pages, environ 10 250 fiches inventoriées, 95,19 s de travail (2,64 s par unité en moyenne). Ce passage a demandé 24 appels du tick en présence du lecteur des ventes, aujourd'hui suspendu. Les durées des autres unités ne sont pas mesurées dans ce dépôt : elles figurent dans le champ `measurements` de chaque réponse du tick (journaux des passages GitHub).

### 1.3 Nombre d'appels pour terminer un cycle

Borne lue dans le code : Notion demande 36 unités par passage, 4 au plus par appel, donc au moins 9 appels du tick, même quand rien n'a changé dans Notion (section 2). Les 13 autres flux tiennent en 1 à 4 unités chacun.

Unités par heure avec la cadence de 30 minutes (lu + estimé) : environ 36 unités Notion, 7 unités à 25 s, et 9 + 3n unités à 30 s, n étant le nombre d'unités d'un rapport PostHog (1 à 4 ; une requête réelle de 63 s a déjà été observée). Soit 12 à 21 unités à 30 s par heure, qui passent à raison d'une ou deux par appel.

Simulation (estimé) : le vrai planificateur, une horloge et un budget virtuels, Notion à sa durée mesurée, les autres durées supposées. Profil central : Meta compte, Wix, paiements, catalogue 6 s ; publicités par jour 10 s ; KPI 8 s ; inscriptions 4 s ; PostHog 2 unités de 12 s. Profil pessimiste : Notion 4 s par unité, PostHog 4 unités de 20 s, autres durées doublées. Test reproductible : `tests/refresh-cycle.test.ts`.

| Déclenchement | Profil | Appels/jour | Écart max entre publications, flux Masterclass | Écart moyen | Passage Notion | Premier cycle complet (tout dû) |
|---|---|---|---|---|---|---|
| 1 min | central | 1 440 | 34 min | 30 min | 11 min | 12 appels |
| 2 min | central | 720 | 38 min | 30 min | 22 min | 12 appels |
| 5 min | central | 288 | 50 min | 30 min | 65 à 75 min | 19 appels |
| 1 min | pessimiste | 1 440 | 37 min | 30 min | 19 min | 20 appels |
| 2 min | pessimiste | 720 | 44 min | 30 min | 48 min | 26 appels |
| 3 min | pessimiste | 480 | 57 min | 48 min | 93 à 105 min | 29 appels |
| 5 min | pessimiste | 288 | 165 min | 159 min | 140 à 160 min | 31 appels |

Cas courant (rien de nouveau) : avec un déclenchement toutes les 2 minutes, 16 (profil central) à 26 (pessimiste) appels par heure ont du travail, sur 30 ; les autres ne trouvent rien à faire (section 3.3). Travail total estimé : 4,6 à 10 minutes de fonction active par heure. Pire cas (tous les flux dus, par exemple après une panne) : 12 à 26 appels, soit 24 à 52 minutes avec un appel toutes les 2 minutes.

### 1.4 Durée minimale entre deux travaux d'un même flux (lu)

- Dans un même appel : un flux non reprenable ne passe qu'une fois ; un flux reprenable enchaîne au plus 4 unités de la même tentative.
- Entre deux appels : une nouvelle tentative démarre au plus tôt à l'entrée du créneau suivant (heure, ou demi-heure pour les flux Masterclass). Si la tentative précédente a démarré tard dans son créneau (retard de file), l'écart peut descendre à un intervalle de déclenchement (2 minutes). C'est la règle horaire actuelle, étendue aux demi-heures. Au plus un départ par créneau et par flux.
- Exception existante : Notion republie immédiatement si sa dernière publication couvre des données plus anciennes que sa cadence (passage plus long qu'une heure).
- Après un échec : 5 minutes. Tentative abandonnée sans bail : 10 minutes (`expired_worker`).

## 2. Cadence par flux

Réglage serveur unique `BLG_REFRESH_CADENCE_MINUTES` : absent, vide ou toute autre valeur que `60` = 30 minutes ; `60` = comportement horaire actuel, à l'identique. Aucune valeur ne descend sous 30 minutes. La réponse du tick expose `cadence` (`pilotMinutes`, `pilotJobs`) pour vérifier le réglage réellement lu.

Flux qui conditionnent le pilotage Masterclass (lu dans `kpi-funnel-live.ts`, `visual-journey-analytics.ts`, `ad-funnel.ts`, `posthog-dashboard.ts`) :

| Flux | Lu par | Ce qu'un passage relit | Cadence |
|---|---|---|---|
| `masterclass_observations` (PostHog) | rapport Masterclass | un rapport agrégé du 1er du mois précédent à demain | 30 min |
| `lead_entries_forms` (Wix) | parcours, tableau quotidien | delta depuis la dernière couverture, moins 2 jours | 30 min |
| `kpi_meta_daily`, `kpi_posthog_daily`, `kpi_wix_daily` | tableau quotidien | fenêtre de 36 jours | 30 min |
| `ad_daily` (Meta) | détail par publicité | fenêtre de 36 jours, 20 pages au plus | 30 min |
| `prospects_business` (Notion) | parcours, tableau quotidien, détail par publicité | delta, plus l'inventaire complet de la base à chaque passage, plus un miroir complet toutes les 24 h | 60 min, voir ci-dessous |
| `ad_catalog` (Meta) | noms et campagnes des publicités | toutes les publicités du compte | 60 min, voir ci-dessous |
| `lead_entries_client_history` (Notion) | tableau quotidien, seulement le bloc ventes et cash | delta, moins 2 jours | 60 min (bloc indisponible tant que le lecteur des ventes est suspendu) |

Notion reste à 60 minutes : `cockpit_claim_notion` (migration 013) construit à chaque nouveau passage l'intervalle delta et l'inventaire de toutes les partitions déjà connues (environ 10 250 fiches, 106 pages mesurées). Passer à 30 minutes doublerait cette relecture complète. De plus, un passage demande au moins 9 appels : il ne peut pas publier plus souvent qu'environ toutes les 20 à 50 minutes avec un appel toutes les 2 minutes. Conséquence pour le pilotage : les rendez-vous (« Réservent un rendez-vous », « RDV réservés ») ont un âge de données de 1 h à 1 h 50 au pire, pas 30 minutes. Levier possible, non appliqué : un inventaire incrémental, ou plus de 4 unités Notion par appel.

`ad_catalog` reste à 60 minutes : chaque passage relit tout le catalogue d'annonces. Les noms et campagnes des annonces qui dépensent sont de toute façon rafraîchis toutes les 30 minutes par `ad_daily` (`import_meta_page` met à jour la table `ads`).

## 3. Non-chevauchement et reprise

### 3.1 Ce qui existait déjà (lu)

Les verrous par flux sont en base et valent entre instances : jamais deux lectures simultanées d'un même flux. Un passage perdant reçoit 409 `source_busy` (`begin_sync_stream`) ou « occupé » (réclamations à bail) sans rien écrire.

### 3.2 Ce que ce lot ajoute (`src/lib/sync-jobs.ts`)

- Un refus 409 `source_busy` est classé « waiting » et non plus « failed » : un passage concurrent n'annonce plus une panne de source.
- Verrou de passage en mémoire du processus : un second passage sur la même instance répond « waiting » sans aucune lecture. Limite : il ne voit pas une autre instance Vercel. Un détenteur bloqué plus de 120 s n'empêche plus les passages suivants.
- Verrou partagé en base, préparé et non branché : `supabase/manual/2026-09-23_cockpit_tick_lease.sql` (une ligne de bail, `cockpit_claim_tick`, `cockpit_release_tick`). Il empêcherait qu'un passage relise un flux qu'un autre vient de publier. Il exigerait une migration numérotée, l'ajout des deux RPC à `allowedRPC` (`src/lib/db.ts`) et un `TickLock` en base dans `sync-jobs.ts` (détail en tête du fichier). Avec un seul déclencheur toutes les 2 minutes et une route limitée à 60 s, il n'est pas nécessaire à la bascule.

Preuves par test (`tests/refresh-overlap.test.ts`, double de base qui reproduit `begin_sync_stream`, `finish_sync` et la clé unique de `source_aggregates`) :
- même instance : deux passages simultanés, une seule unité exécutée, l'autre « waiting » sans lecture ;
- deux instances : les deux croient le flux dû, une seule réclamation réussit, l'autre reçoit 409 et répond « waiting » ; une lecture source, une publication, aucune ligne dupliquée ;
- reprise : une tentative interrompue bloque le flux 10 minutes, puis la suivante publie ; la tentative abandonnée ne laisse aucune ligne publiée.

Limite des tests : ils utilisent un double de base, pas la base réelle. Les 59 tests PostgreSQL existants passent sur une base 17 locale jetable, sans viser ces fichiers.

### 3.3 Passage sans travail (`tests/refresh-cadence.test.ts`)

Quand rien n'est dû : aucun appel Meta, PostHog, Wix ou Notion, aucune écriture, deux lectures du journal par flux en parallèle, réponse `complete`. C'est ce qui rend acceptable un déclenchement toutes les 2 minutes.

## 4. Données : rejeu et volume

Écritures lues : `source_aggregates` est écrit par `upsert` avec la clé `source, source_namespace, metric_key, period_from, period_to, dimensions_key, report_profile_key, sync_run_id` ; `finish_sync` ne termine qu'une tentative encore « running ». `ad_daily` et `meta_conversions_daily` ont une clé unique qui contient `sync_run_id` (`ON CONFLICT DO NOTHING`) ; `lead_source_observations` est unique par tentative et par inscription ; le staging Notion rejoue une page grâce à son reçu.

- Rejouer une unité (réponse perdue, même tentative) ne duplique aucune ligne. Prouvé par test pour `source_aggregates`.
- Une tentative interrompue passe en échec au bout de 10 minutes ; ses lignes éventuelles restent stockées mais ne sont jamais lues (les lectures ne retiennent que des tentatives complètes).
- Chaque nouvelle tentative écrit sa propre version complète de sa fenêtre et rien n'est purgé. Aucun flux ne copie la base entière, mais pour les six flux Masterclass le volume ajouté par jour double à 30 minutes (48 versions au lieu de 24) : KPI et publicités par jour (36 jours par version), rapport PostHog, observations d'inscriptions de la fenêtre de 2 jours. À mesurer avant et après la bascule (requête 6.6) et à arbitrer au regard de la consigne « sans copies complètes cumulatives ». Retour au volume actuel : `BLG_REFRESH_CADENCE_MINUTES=60`.

## 5. Procédure de bascule (ordre exact)

### 5.1 Prérequis

1. Ce lot relu, fusionné et déployé en production avec `BLG_REFRESH_CADENCE_MINUTES=60` : comportement identique à aujourd'hui, mêmes flux, mêmes cadences.
2. Valeur de `CRON_SECRET` : celle de Vercel Production, au moins 32 caractères. Si elle n'est pas relisible, en créer une nouvelle et la poser au même moment dans Vercel (puis redéployer), dans le secret GitHub `CRON_SECRET` (recours manuel) et dans Vault (étape 5.2.2).
3. Quotas du plan Vercel relevés (page Usage) : estimation 720 appels par jour, environ 5 à 10 minutes de fonction active par heure. Repère Hobby : 1 000 000 d'appels, 4 h de CPU actif et 360 Go-heures de mémoire par mois. Aucune dépense nouvelle attendue sur Supabase (extensions incluses).
4. Relevé de départ : requêtes 6.1 et 6.6 enregistrées.

### 5.2 Étapes

1. SQL, sections A et C de `supabase/manual/2026-09-23_cockpit_refresh_cron.sql` : extensions `pg_cron` et `pg_net`, schéma privé `cockpit_ops` et fonction `request_refresh_tick`. Rien n'est planifié.
2. Secret : Vault, « Add new secret », nom `cockpit_cron_secret`, valeur de l'étape 5.1.2. Contrôle de la section B (longueur seulement, jamais la valeur).
3. Essai unique, section D : un appel réel. Attendu : `status_code` 200, `tick_status` renseigné, `cadence.pilotMinutes` = 60, et une nouvelle ligne dans `sync_runs` si un flux était dû.
4. Arrêt des départs GitHub : pousser sur la branche par défaut la modification de 5.3. Vérifier dans Actions qu'aucun passage « Actualiser le cockpit » n'est en cours (sinon attendre sa fin, 15 minutes au plus).
5. Dans les minutes qui suivent : section E, `cron.schedule('cockpit-refresh-tick', '*/2 * * * *', ...)`. Facultatif : la tâche de purge de l'historique pg_cron à 7 jours.
6. Contrôle des trois premières exécutions : section F (`cron.job_run_details`, `net._http_response`).
7. Observation 2 à 3 heures à cadence horaire : chaque flux publié dans l'heure (6.1, 6.2).
8. Passage à 30 minutes : supprimer `BLG_REFRESH_CADENCE_MINUTES` (ou la mettre à `30`) en production, redéployer. Contrôle : `cadence.pilotMinutes` = 30 dans `net._http_response`.
9. Observation 24 à 48 heures (section 6), puis décision.

### 5.3 Modification exacte de `.github/workflows/hourly-sync.yml` (au moment de l'étape 5.2.4)

Remplacer :

```yaml
on:
  schedule:
    # GitHub may drop scheduled starts. Extra wakeups resume work; the worker
    # skips sources already covered for the current hour and retains its lease.
    - cron: '17,37,57 * * * *'
  workflow_dispatch:
```

par :

```yaml
on:
  # Recours manuel uniquement : le déclencheur principal est pg_cron (docs/ACTUALISATION.md).
  workflow_dispatch:
```

Le reste du fichier ne change pas (groupe de concurrence, boucle bornée à 720 s). Un passage manuel pendant que pg_cron tourne reste sans risque pour les données (verrous par flux) ; il peut seulement voir des flux « waiting ».

## 6. Vérification sur 24 à 48 heures

6.1 Dernière publication complète par flux :

```sql
SELECT source, stream_key, max(finished_at) AS derniere_publication,
       round(extract(epoch FROM now() - max(finished_at)) / 60) AS minutes_depuis
  FROM sync_runs WHERE status IN ('complete','empty') AND pagination_complete
 GROUP BY source, stream_key ORDER BY minutes_depuis DESC;
```

6.2 Écarts entre publications complètes consécutives (24 h) :

```sql
WITH p AS (
  SELECT source, stream_key, finished_at,
         finished_at - lag(finished_at) OVER (PARTITION BY source, source_namespace, stream_key, query_profile_key ORDER BY finished_at) AS ecart
    FROM sync_runs WHERE status IN ('complete','empty') AND pagination_complete AND finished_at > now() - interval '24 hours')
SELECT source, stream_key, count(*) AS publications,
       round(extract(epoch FROM avg(ecart)) / 60, 1) AS ecart_moyen_min,
       round(extract(epoch FROM max(ecart)) / 60, 1) AS ecart_max_min
  FROM p GROUP BY source, stream_key ORDER BY ecart_max_min DESC NULLS FIRST;
```

6.3 Échecs par flux et reprise (24 h) : chaque échec doit être suivi d'une publication complète du même flux.

```sql
SELECT f.source, f.stream_key, f.started_at AS echec, f.error_code,
       (SELECT min(c.finished_at) FROM sync_runs c
         WHERE c.source = f.source AND c.source_namespace = f.source_namespace AND c.stream_key = f.stream_key
           AND c.query_profile_key = f.query_profile_key AND c.status IN ('complete','empty') AND c.pagination_complete
           AND c.started_at > f.started_at) AS republie_a
  FROM sync_runs f WHERE f.status = 'failed' AND f.started_at > now() - interval '24 hours' ORDER BY f.started_at DESC;
```

6.4 Aucun chevauchement : deux tentatives d'un même flux ne doivent jamais se recouvrir.

```sql
SELECT a.source, a.stream_key, a.id, b.id, a.started_at, b.started_at
  FROM sync_runs a JOIN sync_runs b
    ON a.source = b.source AND a.source_namespace = b.source_namespace AND a.stream_key = b.stream_key
   AND a.query_profile_key = b.query_profile_key AND a.id < b.id
   AND b.started_at < coalesce(a.finished_at, now()) AND a.started_at < coalesce(b.finished_at, now())
 WHERE a.started_at > now() - interval '48 hours';
```

6.5 Aucune double publication dans un même créneau (flux Masterclass : demi-heure ; autres : heure) :

```sql
SELECT source, stream_key,
       to_timestamp(floor(extract(epoch FROM started_at) / 1800) * 1800) AS creneau, count(*) AS publications
  FROM sync_runs WHERE status IN ('complete','empty') AND pagination_complete AND started_at > now() - interval '24 hours'
 GROUP BY 1, 2, 3 HAVING count(*) > 1 ORDER BY creneau DESC;
```

Une ligne pour `prospects_business` peut être normale (republication immédiate d'un passage plus long qu'une heure). Pour les autres flux, toute ligne est à expliquer.

6.6 Volume ajouté par publication et taille des tables :

```sql
SELECT r.stream_key, count(DISTINCT r.id) AS publications_24h, round(count(a.*)::numeric / nullif(count(DISTINCT r.id), 0)) AS lignes_par_publication
  FROM sync_runs r LEFT JOIN source_aggregates a ON a.sync_run_id = r.id
 WHERE r.status IN ('complete','empty') AND r.finished_at > now() - interval '24 hours'
   AND r.stream_key IN ('kpi_meta_daily','kpi_posthog_daily','kpi_wix_daily','masterclass_observations')
 GROUP BY r.stream_key;
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS taille
  FROM pg_class WHERE relname IN ('source_aggregates','ad_daily','meta_conversions_daily','lead_source_observations','sync_runs');
```

6.7 Déclencheur : section F du fichier SQL (`cron.job_run_details` : statut « succeeded » ; `net._http_response` : 200, `timed_out` faux). Un « succeeded » pg_cron signifie seulement que la requête a été mise en file.

### Critères de réussite

- Chaque flux Masterclass (`masterclass_observations`, `lead_entries_forms`, `kpi_meta_daily`, `kpi_posthog_daily`, `kpi_wix_daily`, `ad_daily`) : au moins 44 publications complètes par 24 h, écart moyen 32 minutes au plus, écart maximal 45 minutes au plus, sur au moins deux périodes de 24 h, hors panne de source documentée.
- Flux horaires : écart maximal 65 minutes ; `prospects_business` : écart maximal 80 minutes.
- Requête 6.4 vide ; requête 6.5 vide hors cas Notion expliqué.
- Chaque échec de 6.3 suivi d'une publication complète en moins de 40 minutes, sinon panne de source à traiter à part.
- Au moins 95 % des réponses `net._http_response` en 200 sans dépassement de délai.
- Usage Vercel dans les quotas du plan, aucune facturation additionnelle ; volume de 6.6 conforme à l'arbitrage de la section 4.

Si l'écart maximal dépasse 45 minutes de façon répétée : relever `measurements` dans les réponses du tick pour identifier l'unité lente ; le déclenchement toutes les minutes est l'option suivante (la route de 60 s peut alors toucher le déclenchement suivant, le verrou de processus et les verrous par flux s'appliquent).

## 7. Retour arrière complet

Ordre sans chevauchement : arrêter pg_cron d'abord, rétablir GitHub ensuite.

1. SQL section G : `cron.unschedule('cockpit-refresh-tick')` (et la tâche de purge si créée), suppression de la fonction et du schéma `cockpit_ops`. Extensions laissées en place ; ne pas supprimer `pg_cron` (cela effacerait toutes les tâches). Secret : laissé, ou neutralisé par une valeur aléatoire.
2. Workflow : rétablir le bloc `schedule` d'origine (annulation du commit de 5.3).
3. Cadence : `BLG_REFRESH_CADENCE_MINUTES=60` puis redéploiement, ou annulation du commit de code de ce lot. Aucune donnée n'est à reprendre : aucune table ni fonction existante n'est modifiée.
4. Si le verrou partagé a été adopté entre-temps : son propre retour arrière est en fin de `supabase/manual/2026-09-23_cockpit_tick_lease.sql`.

## 8. Pourquoi ce SQL n'est ramassé par rien

`scripts/migrate-local.ts` et tous les tests d'intégration lisent `readdirSync('supabase/migrations')`, sans parcours récursif ; aucun ne lit `supabase/manual/`. Le dépôt n'a pas de `supabase/config.toml` et le CI (`ci.yml`) lance seulement `npm run check` et `npm run test:db`. Le fichier du déclencheur commence en plus par une garde qui arrête une exécution d'un bloc.
