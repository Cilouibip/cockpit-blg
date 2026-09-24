# Actualisation toutes les 30 minutes : analyse et procédure de bascule

Document de travail pour Codex. Rien n'est activé : le code est local, le déclencheur est préparé dans `supabase/manual/`, les migrations 017 (verrou partagé du tick), 018 (état courant par identifiant stable), 019 (nettoyage borné de la zone de préparation, reprise de l'état courant après retour arrière), 020 (inscriptions en place), 021 (inventaire Notion tournant), 022 (réapparition = même ligne) et 023 (fenêtre de relecture Notion complète) sont préparées dans `supabase/migrations/` et testées sur PostgreSQL 17 jetable, non appliquées. Le workflow GitHub est inchangé. La collecte actuelle (GitHub, départs à 17, 37 et 57 minutes) reste en service jusqu'à la bascule décrite en section 5.

Mise à jour du lot U4b (23 septembre) : défaut de transition à 60 minutes (30 seulement sur activation explicite, section 2), verrou partagé du tick branché (section 3), plus aucune version complète par passage pour les six flux Masterclass (section 4).

Mise à jour du lot U4c-garde (23 septembre) : la demi-heure n'est effective que sous bail partagé détenu, sinon 60 signalé (section 2) ; nettoyage borné de la zone de préparation à chaque passage, indépendant des publications réussies (section 4, migration 019) ; marche exacte du retour arrière après nouvelles écritures et reprise de l'état courant (section 7).

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

Borne lue dans le code avant la migration 021 : Notion demandait 36 unités par passage, 4 au plus par appel, donc au moins 9 appels du tick, même quand rien n'avait changé dans Notion. Depuis la migration 021 (lot U9, inventaire tournant borné, section 2), un passage delta lit l'intervalle des modifications (1 page pour 30 minutes de modifications), une tranche de l'inventaire (budget = plafond(pages estimées / 12) à cadence 30, soit 9 pages pour environ 10 250 fiches, plafond(pages / 6) à cadence 60) et la partition nouvelle (1 page) : environ 11 pages, 4 unités de 3 pages, donc 1 appel du tick (2 si les modifications dépassent une page ou si le passage est partagé). Mesure synthétique (`tests/c3-notion-incremental.integration.ts`, 12 050 fiches, 121 partitions) : 12 à 13 pages par passage, au plus 5 unités, inventaire complet relu en 12 passages. Au rythme mesuré le 18/09 (0,9 s par page), un passage delta dure environ 10 à 12 s de travail, sous le budget de 45 s. La relecture complète toutes les 24 h reste à 36 unités (9 appels). Les 13 autres flux tiennent en 1 à 4 unités chacun.

Unités par heure avec la cadence de 30 minutes (lu + estimé) : environ 8 à 10 unités Notion (deux passages delta ; plus 36 unités une fois par 24 h pour la relecture complète ; 36 par heure avant la migration 021), 7 unités à 25 s, et 9 + 3n unités à 30 s, n étant le nombre d'unités d'un rapport PostHog (1 à 4 ; une requête réelle de 63 s a déjà été observée). Soit 12 à 21 unités à 30 s par heure, qui passent à raison d'une ou deux par appel.

Simulation (estimé) : le vrai planificateur, une horloge et un budget virtuels, Notion à sa durée mesurée (36 unités par passage : profil antérieur à la migration 021, conservé comme borne pessimiste ; le test reste vert avec Notion devenu flux pilote), les autres durées supposées. Profil central : Meta compte, Wix, paiements, catalogue 6 s ; publicités par jour 10 s ; KPI 8 s ; inscriptions 4 s ; PostHog 2 unités de 12 s. Profil pessimiste : Notion 4 s par unité, PostHog 4 unités de 20 s, autres durées doublées. Test reproductible : `tests/refresh-cycle.test.ts`.

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

### 1.5 Mécanisme des retards mesuré et correction (reprise CP2, 24 septembre)

Mesure avec le vrai planificateur (`tests/refresh-mechanism.test.ts` : horloge virtuelle, budget 40 s sur 45 s, déclenchement toutes les 2 minutes puis toutes les minutes, Notion en delta de 5 unités avec une relecture complète de 36 unités par 24 h, profils central et pessimiste du §1.3 ; durées supposées sauf Notion). Pour chaque publication : instant dû (créneau), départ, attente en file, écart avec la publication précédente, âge visible juste avant la publication (publication moins heure de lecture précédente ; Notion : moins la coupure). Preuves : `private/derived/fable-cockpit-20260923/cp2-reprise-20260924/preuves/cadence-mecanisme-avant-correction.json` et `…-apres-correction.json`.

D'où viennent les minutes au-delà de 30 (version `748c6d0`) :

1. **Ordre de la file au changement d'heure** (cause principale) : `chooseSyncJob` prenait le flux « touché le plus anciennement ». À l'heure pleine, les sept flux horaires (touchés depuis 60 min) passaient avant les sept flux à 30 (touchés depuis 30 min) ; avec la règle de budget (une unité de 30 s ne part que s'il reste 30 s sur 40, donc une ou deux unités par passage), les flux Masterclass attendaient 6 à 10 min (central) et jusqu'à 16 min (pessimiste) une fois par heure, puis retrouvaient leur place à la demi-heure suivante (écart court ensuite). D'où des écarts de 32 à 38 min (central) et 38 à 44 min (pessimiste), moyenne 30.
2. **Budget par passage** : une seule unité longue par appel du tick (règle de démarrage §1.1) ; un passage de 2 minutes par unité de file.
3. **Relecture Notion complète** (36 unités, 9 appels) : une fois par 24 h, l'âge des rendez-vous monte à 50 min (central) ou 58 min (pessimiste) quelle que soit l'heure.

Correction appliquée (`chooseSyncJob`) : à cadence égale, ordre inchangé ; à 30, les flux à 30 passent avant les flux horaires ; un flux en retard de plus d'une cadence sur son échéance passe d'abord (garde contre la famine, jamais atteinte dans les profils mesurés). Sans réglage (60 partout), rien ne change.

| Flux, déclenchement 2 min | Avant : écart max central / pessimiste | Après : écart max central / pessimiste | Après : âge visible max central / pessimiste |
|---|---|---|---|
| `kpi_meta_daily`, `kpi_posthog_daily`, `kpi_wix_daily` | 34,2 à 35,9 / 38 | 30,0 / 30,0 | 30,1 / 30,3 |
| `ad_daily` | 35,9 / 38 | 30,0 / 30,0 | 30,2 / 30,3 |
| `lead_entries_forms` | 32,2 / 38 | 30,0 / 30,0 | 30,1 / 30,1 |
| `masterclass_observations` (2 à 4 unités) | 38 / 44 | 30,0 / 30,0 | 32,1 / 36,3 |
| `prospects_business` (Notion), régime courant | 34,3 / 51,7 (âge) | 30 (écart moyen) | 32,1 / 36,1 |
| `prospects_business`, pendant la relecture complète | 52,1 / 79,9 (âge) | 47,7 / 51,8 (écart) | 49,9 / 57,9 |
| flux horaires (`meta_account_daily`, `payments_analytics`, `receipt_observations`, `ad_catalog`, `quiz_observations`, `lead_entries_quiz`, `lead_entries_client_history`) | 60 (quiz 68 à 80 d'âge) | 62 à 72 / 72 à 90 | idem |

Déclenchement toutes les minutes (même rapport) : mêmes 30,0 pour les six flux Masterclass ; Notion 31 (courant) et 40 à 44 (relecture complète) ; flux horaires 61 à 66 (central) et 66 à 69 (pessimiste). Limites : durées supposées hors Notion, un seul passage à la fois, aucune panne simulée ; l'écart réel se lit dans `sync_runs` (6.2), l'âge visible dans les heures de couverture du tableau. Ce que cette correction ne fait pas : elle ne réduit pas l'écart en dessous de 30 min + intervalle de déclenchement + durée d'une unité, et elle retarde les flux horaires derrière les flux pilotes (jusqu'à une demi-heure de plus en profil pessimiste). Le seuil d'acceptation de CP4 reste une décision de Mehdi (section 6) ; l'ancien seuil de 45 min du runbook était un choix technique, pas une décision.

Relecture Notion complète la nuit (migration 023, réglage facultatif `BLG_NOTION_FULL_HOURS`, par exemple `2-4`) : la relecture complète quotidienne n'est lancée que dans cette fenêtre (heures Europe/Paris), et de toute façon au plus 36 h après la précédente ; sans réglage, règle 021 inchangée (dès 24 h). Elle ne réduit pas la pointe (50 à 58 min d'âge des rendez-vous pendant la relecture) : elle la place à l'heure choisie. Mesure : `tests/refresh-mechanism.test.ts` (scénarios `…-relecture-nuit`) ; preuves PostgreSQL : `tests/c3-notion-incremental.integration.ts` (hors fenêtre à 25 h = delta, dans la fenêtre = complète, 37 h = complète quoi qu'il arrive, sans réglage = règle 021, forme invalide refusée sans tentative).

## 2. Cadence par flux

Réglage serveur unique `BLG_REFRESH_CADENCE_MINUTES`. Défaut de transition : absent, vide, `60` ou toute valeur autre que `30` = 60 minutes, comportement horaire actuel à l'identique. `30` (espaces ignorés) est la seule activation de la demi-heure. Aucune valeur ne descend sous 30 minutes. 60 n'est pas la cible finale : c'est l'état sûr tant que les conditions ci-dessous ne sont pas réunies. La réponse du tick expose `cadence` (`pilotMinutes`, `pilotJobs`) pour vérifier le réglage réellement appliqué.

Garde (lot U4c-garde, `passCadence` dans `sync-jobs.ts`) : la demi-heure n'est effective que si le passage détient le bail partagé (`lock.kind` = `shared`). Avec `30` et sans bail détenu (fonctions de 017 absentes : `process-only` ; base injectée sans bail), le passage tourne avec les cadences de 60 et la réponse porte `"cadence":{"pilotMinutes":60,"requestedMinutes":30,"degradedReason":"Bail partagé indisponible : cadence de transition 60 min appliquée.",…}`. Avec `60` ou sans réglage, rien ne change (`requestedMinutes` absent). Les réponses `waiting` et le passage sans source configurée annoncent la cadence demandée. Le tableau garde la cadence demandée (`refreshCadences`) : si les données n'arrivent pas à 30, il les affiche « anciennes », le retard n'est pas masqué. Preuves : `tests/refresh-cadence.test.ts` (bail détenu = 30 ; base injectée sans bail = 60 signalé ; fonction absente = 60 signalé ; 60 inchangé) et `tests/state-tick-lease.test.ts` sur le chemin réel de la route (fetch doublé : bail pris = 30 ; PGRST202 = 60 signalé) ; contre-épreuve : garde retirée, ces trois tests échouent.

Activer 30 (`BLG_REFRESH_CADENCE_MINUTES=30` en production, puis redéploiement) est une étape explicite, possible seulement quand les quatre conditions sont constatées :

1. migrations 017 à 023 appliquées en production (contrôle 5.1.1 : `cockpit_migrations` contient 17 à 23) ;
2. observation à 60 conforme (section 6, critères des flux horaires) avec le code de ce lot déployé, y compris le volume de 6.6 : aucune croissance des tables métier pour une source inchangée ;
3. verrou partagé constaté actif : `lock.kind` = `shared` dans les réponses du tick relevées dans `net._http_response` (section 3.2), jamais `process-only`. Sans lui, `30` reste sans effet (garde ci-dessus) : la réponse porte alors `requestedMinutes` = 30 et `degradedReason`.
4. migration 021 appliquée (lot U9, inventaire Notion tournant) : `cockpit_migrations` contient 21. Sans elle, les rendez-vous Notion, devenus flux pilote, relieraient l'inventaire complet à chaque demi-heure (9 appels du tick par passage). Facultatif, décision Codex/Fable : `BLG_NOTION_FULL_HOURS` (migration 023, §1.5) pour placer la relecture complète quotidienne la nuit.

Flux qui conditionnent le pilotage Masterclass (lu dans `kpi-funnel-live.ts`, `visual-journey-analytics.ts`, `ad-funnel.ts`, `posthog-dashboard.ts`) :

| Flux | Lu par | Ce qu'un passage relit | Cadence |
|---|---|---|---|
| `masterclass_observations` (PostHog) | rapport Masterclass | un rapport agrégé du 1er du mois précédent à demain | 60 min, 30 sur activation |
| `lead_entries_forms` (Wix) | parcours, tableau quotidien | delta depuis la dernière couverture, moins 2 jours | 60 min, 30 sur activation |
| `kpi_meta_daily`, `kpi_posthog_daily`, `kpi_wix_daily` | tableau quotidien | fenêtre de 36 jours | 60 min, 30 sur activation |
| `ad_daily` (Meta) | détail par publicité | fenêtre de 36 jours, 20 pages au plus | 60 min, 30 sur activation |
| `prospects_business` (Notion) | parcours, tableau quotidien, détail par publicité | delta, plus une tranche de l'inventaire (1/12 à cadence 30, 1/6 à cadence 60 : tout l'inventaire en 6 h), plus un miroir complet toutes les 24 h (migration 021) | 60 min, 30 sur activation (migration 021 appliquée), voir ci-dessous |
| `ad_catalog` (Meta) | noms et campagnes des publicités | toutes les publicités du compte | 60 min, voir ci-dessous |
| `lead_entries_client_history` (Notion) | tableau quotidien, seulement le bloc ventes et cash | delta, moins 2 jours | 60 min (bloc indisponible tant que le lecteur des ventes est suspendu) |

Notion (lot U9, migration 021) : avant 021, `cockpit_claim_notion` (migration 013) relisait à chaque passage l'inventaire de toutes les partitions (environ 10 250 fiches, 106 pages, au moins 9 appels du tick) : les rendez-vous avaient jusqu'à 1 h 50 d'âge. Depuis 021, chaque passage delta lit les modifications et une seule tranche de l'inventaire : partitions de 100 fiches environ (découpées d'après la date de création du miroir), les plus anciennement relues d'abord, budget proportionnel au temps écoulé (1/12 de l'inventaire par passage à cadence 30, 1/6 à cadence 60), toute partition relue il y a plus de 6 h relue d'office, partition nouvelle toujours lue. Une fiche n'est archivée qu'au passage qui relit sa partition (disparitions détectées en 6 h au plus ; fiche sans date de création ou créée à moins d'une minute d'un bord de tranche : au passage complet, 24 h au plus). La fraîcheur de cette détection est publiée : `inventoryThrough` (réponse du tick, `cockpit_business_rollup`) = la plus ancienne date de relecture des partitions ; le détail par partition (`inventoriedAt`) et les mesures de la tranche (`inventoryPlan`) sont dans le point de reprise de `sync_runs`. Notion est donc un flux pilote : 60 minutes par défaut, 30 sur activation. Âge maximal des rendez-vous après activation, déclenchement toutes les 2 minutes (simulation du planificateur, §1.5, après correction de l'ordre de la file) : 32 min (profil central) à 36 min (pessimiste) en régime courant ; une fois par 24 h, pendant la relecture complète, 50 min (central) à 58 min (pessimiste), à l'heure choisie si `BLG_NOTION_FULL_HOURS` est posé (migration 023). Les six autres flux Masterclass publient à 30 min d'écart exact en simulation (avant correction : 32 à 44 min). Condition propre à Notion : la migration 021 doit être appliquée avant l'activation de 30 (contrôle : `cockpit_migrations` contient 21) ; sans elle, Notion relirait l'inventaire complet toutes les 30 minutes.

`ad_catalog` reste à 60 minutes : chaque passage relit tout le catalogue d'annonces. Les noms et campagnes des annonces qui dépensent sont de toute façon rafraîchis toutes les 30 minutes par `ad_daily` (`import_meta_page` met à jour la table `ads`).

## 3. Non-chevauchement et reprise

### 3.1 Ce qui existait déjà (lu)

Les verrous par flux sont en base et valent entre instances : jamais deux lectures simultanées d'un même flux. Un passage perdant reçoit 409 `source_busy` (`begin_sync_stream`) ou « occupé » (réclamations à bail) sans rien écrire.

### 3.2 Ce que ce lot ajoute (`src/lib/sync-jobs.ts`)

- Un refus 409 `source_busy` est classé « waiting » et non plus « failed » : un passage concurrent n'annonce plus une panne de source.
- Verrou de passage en mémoire du processus : un second passage sur la même instance répond « waiting » sans aucune lecture. Limite : il ne voit pas une autre instance Vercel. Un détenteur bloqué plus de 120 s n'empêche plus les passages suivants.
- Verrou partagé en base, branché (lot U4b) : migration `017_cockpit_tick_lease.sql` (une ligne de bail, `cockpit_claim_tick`, `cockpit_release_tick`, droits `service_role` seulement ; le fichier `supabase/manual/2026-09-23_cockpit_tick_lease.sql` n'est plus qu'un renvoi). Ordre dans `tickSyncJobs` : verrou de processus d'abord (aucun appel en base si cette instance travaille déjà), puis bail en base de 90 s (au-dessus des 60 s de la route), détenteur aléatoire par passage, rendu dans le `finally` même après une exception, jamais renouvelé. Un bail interrompu expire seul au bout de 90 s.

Champ `lock` de la réponse du tick, à contrôler dans `net._http_response` (section F du fichier du déclencheur, colonne `content`) :

| Réponse | Sens |
|---|---|
| `"lock":{"kind":"shared","leaseSeconds":90}` | bail pris ; un seul passage à la fois, toutes instances confondues |
| `status` `waiting`, `reason` « Un autre passage détient le verrou partagé en base… » | bail détenu par un autre passage : aucune lecture du journal ni des sources, aucune écriture |
| `"lock":{"kind":"process-only","reason":"…migration 017 non appliquée…"}` | fonctions absentes de la base (codes « fonction inconnue » 42883 ou PGRST202, traduits en `schema_missing` par `db.ts`) : le passage continue avec le seul verrou de processus ; les verrous par flux protègent toujours les données. Cadence 60 appliquée même si `30` est demandé (`cadence.requestedMinutes`, `cadence.degradedReason`). À corriger avant d'activer 30 |
| HTTP 503 | base injoignable pendant la réclamation : aucune lecture, erreur visible comme toute panne de stockage (contrat existant de la route) |

Le bail est pris par défaut pour la base de production (appel sans base, c'est-à-dire la route du tick). Un appel qui injecte sa propre base (tests, scripts) le reçoit explicitement (`sharedLease`), sinon sa réponse l'indique en `process-only`. Aucun passage ne commence de réclamation s'il n'a aucune source configurée.

Preuves par test (`tests/refresh-overlap.test.ts`, double de base qui reproduit `begin_sync_stream`, `finish_sync` et la clé unique de `source_aggregates`) :
- même instance : deux passages simultanés, une seule unité exécutée, l'autre « waiting » sans lecture ;
- deux instances : les deux croient le flux dû, une seule réclamation réussit, l'autre reçoit 409 et répond « waiting » ; une lecture source, une publication, aucune ligne dupliquée ;
- reprise : une tentative interrompue bloque le flux 10 minutes, puis la suivante publie ; la tentative abandonnée ne laisse aucune ligne publiée.

- bail partagé (lot U4b) : bail refusé = « waiting » sans aucune lecture ; bail rendu après une unité qui lève et après une erreur du journal ; fonction absente = passage « process-only » signalé ; verrou de processus toujours premier ; deux instances : une seule lit le journal et réclame le flux, l'autre ne lit rien (`tests/refresh-overlap.test.ts`, `tests/state-tick-lease.test.ts` pour le chemin de la route).

Sur PostgreSQL 17 (`tests/state-tick-lease.integration.ts`) : deux réclamations concurrentes, une seule réussit ; bail expiré repris par un autre détenteur ; libération par un mauvais détenteur refusée ; durée bornée 30 à 300 s ; `anon` et `authenticated` sans droit ; migration rejouable ; base sans 017 reconnue comme « fonction absente ».

### 3.3 Passage sans travail (`tests/refresh-cadence.test.ts`)

Quand rien n'est dû : aucun appel Meta, PostHog, Wix ou Notion, aucune écriture métier ni dans le journal `sync_runs`, deux lectures du journal par flux en parallèle, réponse `complete`. Depuis le lot U4b, le passage réclame puis rend le bail partagé (mise à jour de l'unique ligne de `cockpit_tick_lease`, aucune ligne ajoutée). Depuis le lot U4c-garde, il appelle aussi une fois `cockpit_cleanup_staged` (section 4) : rien n'est supprimé tant qu'aucune tentative en échec n'a plus de 24 heures. C'est ce qui rend acceptable un déclenchement toutes les 2 minutes.

## 4. Données : état courant par identifiant stable (migration 018)

Règle (Mehdi, 23 septembre) : un objet source inchangé ne produit aucune nouvelle ligne ; une modification met à jour la même ligne ; un nouvel objet ajoute seulement cet objet ; un objet disparu de la source est retiré de l'état courant sans être effacé. Plus aucune version complète par passage pour les six flux Masterclass ; la volumétrie métier ne dépend plus de la cadence.

Modèle « préparation puis publication atomique » :

| Flux | Table | Clé métier (sans tentative) | Préparation | Publication |
|---|---|---|---|---|
| `kpi_meta_daily`, `kpi_posthog_daily`, `kpi_wix_daily` | `source_aggregates` | source, espace, profil, métrique, période, `dimensions_key` | `upsert` par lots de 100 (`syncKpiSource`) | `cockpit_publish_aggregate_state` ; périmètre : jours compris dans la fenêtre |
| `masterclass_observations` | `source_aggregates` | idem | insertion dans `cockpit_publish_posthog` | même transaction ; périmètre : période exacte du rapport |
| `ad_daily` | `ad_daily`, `meta_conversions_daily` | publicité, jour, profil (et action, nature pour les conversions) | `import_meta_page` page par page | `cockpit_publish_meta_daily` si la lecture est complète, sinon `finish_sync` comme avant ; périmètre : publicités de l'espace, jours de la fenêtre |
| `lead_entries_forms` (et `quiz`, `client_history`) | `lead_source_observations` | espace, famille, identifiant | `cockpit_stage_lead_entries` : une observation identique à la ligne courante n'est plus insérée (`checkpoint.unchangedSkipped`) | `cockpit_publish_lead_entries` (migration 020) : ligne courante mise à jour en place (même `id`, `run_id` = tentative, `recorded_at` conservé) après suppression de la ligne préparée ; préparée périmée ou inchangée supprimée ; nouvel objet promu ; `counts.events` |

- Préparation : lignes écrites avec `sync_run_id` = tentative et `is_current` = false ; aucun lecteur ne les voit.
- Publication (une transaction, tentative verrouillée) : pour chaque ligne préparée comparée à la ligne courante de même clé (valeurs `numeric`/`jsonb`, jamais un texte sérialisé) : identique = ligne courante confirmée (`sync_run_id` = tentative) ; différente = ligne courante mise à jour en place (même `id`) ; absente = la ligne préparée devient courante ; la ligne préparée fusionnée est supprimée. Une ligne courante du périmètre absente de la tentative passe `is_current` = false, jamais effacée. Puis clôture `complete`/`empty`, `rows_written` = lignes courantes du périmètre, `checkpoint.state` = `{inserted, changed, confirmed, retired, reappeared, cleaned}`.
- Réapparition (migration 022, reprise CP2) : un objet retiré de l'état courant (fenêtre CTRU non lue à un passage, campagne absente d'une lecture, publicité sans ligne un jour) puis présent à la lecture suivante redevient courant **sur la même ligne** (valeurs lues, tentative, `is_current` = true ; compteur `reappeared`). Constat sur `748c6d0` (`tests/state-days.integration.ts`) : il était promu comme un nouvel objet, la ligne retirée restant à côté (une ligne de plus par aller-retour). Même règle pour `ad_daily` et `meta_conversions_daily`. Les doublons créés avant 022 restent en place (aucune purge).
- Croissance au fil des jours (même scénario, 35 jours, changement de mois compris, 48 passages le premier jour) : zéro ligne par passage ; par jour, les objets nouveaux du jour (une ligne par campagne et par jour, un manifeste), trois fenêtres CTRU nouvelles (les trois de l'avant-veille sont retirées, conservées) avec leurs manifestes, et les lignes du rapport Masterclass de la nouvelle période exacte (les rapports des jours précédents restent courants : périmètre exact, jamais relus). Les jours sortis de la fenêtre de 36 jours restent courants. Preuve : `private/derived/fable-cockpit-20260923/cp2-reprise-20260924/preuves/stockage-35-jours.json`.
- Pourquoi la confirmation met à jour `sync_run_id` : les lecteurs SQL existants (`cockpit_source_window`, `v_ad_daily`, `v_meta_conversions_daily`, `004` et l'attribution) lisent « les lignes de la dernière tentative complète couvrant la période ». Les lignes courantes portent toujours cette tentative : ces lecteurs restent exacts sans modification (prouvé par test, contre-épreuve comprise).
- Rejeu : une publication rejouée après un accusé perdu renvoie l'accusé déjà enregistré sans rien changer. Tentative interrompue : ses lignes préparées restent invisibles, la tentative passe en échec au bout de 10 minutes (`expired_worker`) et la suivante publie normalement.
- Nettoyage borné de la zone de préparation, à la publication (018) : chaque publication supprime au plus 5 000 lignes préparées de tentatives `failed` du même flux, commencées depuis plus de 24 h. Jamais une ligne d'une tentative `complete`/`empty`, jamais une ligne courante ou retirée. Limite constatée (lot U4c-garde) : cette règle n'a pas de condition sur la date de 018, elle supprime donc aussi les lignes de tentatives `failed` écrites avant la migration (lignes jamais lues, mais héritées). Garde ajoutée à la fusion U4c-garde (23/09) : ce nettoyage ne touche que les tentatives commencées après l'application de 018 (`started_at >= applied_at` de la version 18) ; les lignes en échec écrites avant la migration restent en place (aucune purge héritée), comme pour 019.
- Nettoyage borné indépendant du succès (migration 019, lot U4c-garde) : `cockpit_cleanup_staged(p_limit)` est appelée une fois par passage du tick, après les unités et avant la réponse. Elle supprime uniquement les lignes jamais publiées (`source_aggregates`, `ad_daily`, `meta_conversions_daily` : `NOT is_current` ; `lead_source_observations` : `published_at IS NULL AND NOT is_current`) de tentatives terminales en échec (`failed` ou `partial`, aucune réclamation ne reprend ces tentatives), terminées depuis plus de 24 h et commencées après l'application de 018 (`cockpit_migrations.applied_at`, aucune purge héritée), au plus 5 000 lignes par table et par passage. Jamais une ligne d'une tentative `complete`, `empty` ou `running`. Réponse du tick : `"cleanup":{"deleted":{"source_aggregates":n,"ad_daily":n,"meta_conversions_daily":n,"lead_source_observations":n}}` ; un échec est seulement signalé (`"cleanup":{"error":"…"}`, `schema_missing` si 019 n'est pas appliquée) et ne fait jamais échouer le passage. Effet : des pannes répétées sans aucun succès gardent au plus les lignes préparées des tentatives des dernières 24 h (prouvé par de vrais passages du tick sur PostgreSQL, `tests/state-meta-leads.integration.ts`). `notion_import_rows` (préparation Notion) n'a pas de nettoyage des tentatives en échec : hors de ce lot.
- Lignes anciennes conservées : les versions écrites avant la migration restent en place (non courantes), aucune purge. La reprise (dans 018) a marqué courante, pour chaque clé, la ligne de la dernière tentative complète couvrant sa période (KPI, Masterclass en période exacte, `ad_daily`, conversions) ; les lignes quiz restent par tentative.
- Inscriptions (migration 020) : une modification réelle, une re-liaison d'identité ou une reclassification par un profil revu met à jour la ligne courante en place ; aucune copie de fiche n'est conservée. Les changements métier (`source`, `identity`, `eligibility`) sont tracés dans `lead_source_observation_changes` (anciennes date source, empreintes, mapping, personne, état, éligibilité ; jamais `properties`) ; une re-dérivation purement technique (profil de mapping, propriétés recalculées) ne laisse que le compteur `mappingChanged` de la tentative. Une absence dans une lecture par delta ne retire rien. Retour arrière : bloc en fin de 020 (corps 018), sans suppression de données.
- `sync_runs` garde une ligne par tentative (journal technique, voir la livraison U4b pour l'estimation et la proposition de rétention, rien n'est purgé).

## 5. Procédure de bascule (ordre exact)

### 5.1 Prérequis

1. Migrations 017, 018, 019, 020, 021, 022 et 023 appliquées dans cet ordre, AVANT le déploiement du code de ce lot, hors passage (le code appelle `cockpit_publish_aggregate_state`, `cockpit_publish_meta_daily`, `cockpit_cleanup_staged` et lit `is_current` ; sans 019, le tick signale seulement `cleanup.error` = `schema_missing` ; 022 et 023 ne changent que des fonctions). Contrôle : `SELECT version, applied_at FROM cockpit_migrations WHERE version BETWEEN 17 AND 23 ORDER BY version;` renvoie sept lignes (17, 18, 19, 20, 21, 22, 23). Relevé 6.6 enregistré juste avant et juste après la migration 018 (la reprise ne supprime rien). Durées et verrous mesurés sur volume synthétique représentatif : `private/derived/fable-cockpit-20260923/cp2-reprise-20260924/volume/RESULTATS.md`.
2. Ce lot relu, fusionné et déployé en production sans `BLG_REFRESH_CADENCE_MINUTES` (ou avec `60`) : cadence horaire, mêmes flux. Contrôle : `cadence.pilotMinutes` = 60, `lock.kind` = `shared` et `cleanup.deleted` présent dans la réponse d'un passage.
3. Valeur de `CRON_SECRET` : celle de Vercel Production, au moins 32 caractères. Si elle n'est pas relisible, en créer une nouvelle et la poser au même moment dans Vercel (puis redéployer), dans le secret GitHub `CRON_SECRET` (recours manuel) et dans Vault (étape 5.2.2).
4. Quotas du plan Vercel relevés (page Usage) : estimation 720 appels par jour, environ 5 à 10 minutes de fonction active par heure. Repère Hobby : 1 000 000 d'appels, 4 h de CPU actif et 360 Go-heures de mémoire par mois. Aucune dépense nouvelle attendue sur Supabase (extensions incluses).
5. Relevé de départ : requêtes 6.1 et 6.6 enregistrées.

### 5.2 Étapes

1. SQL, sections A et C de `supabase/manual/2026-09-23_cockpit_refresh_cron.sql` : extensions `pg_cron` et `pg_net`, schéma privé `cockpit_ops` et fonction `request_refresh_tick`. Rien n'est planifié.
2. Secret : Vault, « Add new secret », nom `cockpit_cron_secret`, valeur de l'étape 5.1.3. Contrôle de la section B (longueur seulement, jamais la valeur).
3. Essai unique, section D : un appel réel. Attendu : `status_code` 200, `tick_status` renseigné, `cadence.pilotMinutes` = 60, `lock.kind` = `shared`, et une nouvelle ligne dans `sync_runs` si un flux était dû.
4. Arrêt des départs GitHub : pousser sur la branche par défaut la modification de 5.3. Vérifier dans Actions qu'aucun passage « Actualiser le cockpit » n'est en cours (sinon attendre sa fin, 15 minutes au plus).
5. Dans les minutes qui suivent : section E, `cron.schedule('cockpit-refresh-tick', '*/2 * * * *', ...)`. Facultatif : la tâche de purge de l'historique pg_cron à 7 jours.
6. Contrôle des trois premières exécutions : section F (`cron.job_run_details`, `net._http_response`).
7. Observation à cadence horaire (au moins 24 heures) : chaque flux publié dans l'heure (6.1, 6.2), `lock.kind` = `shared` sur toutes les réponses, 6.6 sans croissance des tables métier pour une source inchangée.
8. Activation de 30 minutes, seulement si les quatre conditions de la section 2 (dont la migration 021, inventaire Notion tournant) sont constatées : `BLG_REFRESH_CADENCE_MINUTES=30` en production, redéployer. Contrôle : `cadence.pilotMinutes` = 30 et aucun `cadence.requestedMinutes` dans `net._http_response` (sinon la demi-heure n'est pas appliquée : bail partagé indisponible).
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

6.6 Volume : lignes courantes et total par table, effet des publications, croissance par jour, zone de préparation, taille.

```sql
-- Lignes courantes et total (les lignes non courantes = versions héritées d'avant 018, objets retirés, lignes préparées).
SELECT 'source_aggregates' AS t, count(*) FILTER (WHERE is_current) AS courantes, count(*) AS total FROM source_aggregates
UNION ALL SELECT 'ad_daily', count(*) FILTER (WHERE is_current), count(*) FROM ad_daily
UNION ALL SELECT 'meta_conversions_daily', count(*) FILTER (WHERE is_current), count(*) FROM meta_conversions_daily
UNION ALL SELECT 'lead_source_observations', count(*) FILTER (WHERE is_current), count(*) FROM lead_source_observations;

-- Effet des publications sur 24 h (checkpoint.state) : pour une source inchangée, inserted = 0 et retired = 0.
SELECT stream_key, count(*) AS publications,
       sum((checkpoint->'state'->>'inserted')::int) AS ajoutees, sum((checkpoint->'state'->>'changed')::int) AS modifiees,
       sum((checkpoint->'state'->>'confirmed')::int) AS confirmees, sum((checkpoint->'state'->>'retired')::int) AS retirees,
       sum((checkpoint->'state'->>'cleaned')::int) AS nettoyees
  FROM sync_runs WHERE status IN ('complete','empty') AND finished_at > now() - interval '24 hours' AND checkpoint ? 'state'
 GROUP BY stream_key;
SELECT stream_key, sum((checkpoint->'counts'->>'unchangedSkipped')::int) AS inscriptions_inchangees_non_ecrites
  FROM sync_runs WHERE stream_key LIKE 'lead_entries_%' AND finished_at > now() - interval '24 hours' GROUP BY stream_key;

-- Croissance par jour des tables métier (lignes nouvelles, d'après leur tentative d'origine).
SELECT date_trunc('day', r.started_at) AS jour, count(*) AS lignes_source_aggregates
  FROM source_aggregates a JOIN sync_runs r ON r.id = a.sync_run_id WHERE r.started_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1;
SELECT date_trunc('day', r.started_at) AS jour, count(*) AS lignes_ad_daily
  FROM ad_daily d JOIN sync_runs r ON r.id = d.sync_run_id WHERE r.started_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1;
-- Remarque : une ligne confirmée porte la dernière tentative ; ces requêtes montrent où vivent les lignes, la croissance réelle
-- se lit sur le total ci-dessus relevé chaque jour.

-- Lignes préparées orphelines (tentatives non publiées) : doivent rester bornées et disparaître 24 h après l'échec
-- (celles d'avant 018 restent : aucune purge héritée par 019).
SELECT 'source_aggregates' AS t, r.status, count(*) AS lignes, min(r.finished_at) AS plus_ancienne
  FROM source_aggregates a JOIN sync_runs r ON r.id = a.sync_run_id WHERE NOT a.is_current AND r.status IN ('running','failed','partial') GROUP BY 1, 2
UNION ALL SELECT 'ad_daily', r.status, count(*), min(r.finished_at)
  FROM ad_daily d JOIN sync_runs r ON r.id = d.sync_run_id WHERE NOT d.is_current AND r.status IN ('running','failed','partial') GROUP BY 1, 2
UNION ALL SELECT 'meta_conversions_daily', r.status, count(*), min(r.finished_at)
  FROM meta_conversions_daily d JOIN sync_runs r ON r.id = d.sync_run_id WHERE NOT d.is_current AND r.status IN ('running','failed','partial') GROUP BY 1, 2
UNION ALL SELECT 'lead_source_observations', r.status, count(*), min(r.finished_at)
  FROM lead_source_observations o JOIN sync_runs r ON r.id = o.run_id WHERE o.published_at IS NULL AND r.status IN ('running','failed','partial') GROUP BY 1, 2;
-- Lignes éligibles au nettoyage borné et pas encore supprimées (attendu : 0, ou moins de 5 000 par table en rattrapage).
SELECT count(*) AS eligibles_source_aggregates FROM sync_runs f JOIN source_aggregates x ON x.sync_run_id = f.id
 WHERE f.status IN ('failed','partial') AND f.finished_at < now() - interval '24 hours'
   AND f.started_at >= (SELECT applied_at FROM cockpit_migrations WHERE version = 18) AND NOT x.is_current;

SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS taille
  FROM pg_class WHERE relname IN ('source_aggregates','ad_daily','meta_conversions_daily','lead_source_observations','sync_runs','cockpit_tick_lease');
```

6.7 Déclencheur : section F du fichier SQL (`cron.job_run_details` : statut « succeeded » ; `net._http_response` : 200, `timed_out` faux). Un « succeeded » pg_cron signifie seulement que la requête a été mise en file.

### Critères de réussite

- Chaque flux Masterclass (`masterclass_observations`, `lead_entries_forms`, `kpi_meta_daily`, `kpi_posthog_daily`, `kpi_wix_daily`, `ad_daily`) : au moins 44 publications complètes par 24 h, écart moyen 30 minutes (32 au plus), sur au moins deux périodes de 24 h, hors panne de source documentée. Écart maximal attendu d'après la simulation (§1.5) : 30 min + intervalle de déclenchement (2 min) + durée de l'unité, soit 30 à 33 min (36 min pour `masterclass_observations` en profil pessimiste). **Le seuil d'acceptation est une décision de Mehdi, pas un choix du runbook** : l'ancien « 45 minutes au plus » de ce document n'était pas une décision. À constater aussi : âge visible dans les heures de couverture du tableau (lecture précédente → publication suivante).
- `prospects_business` (Notion) : 32 à 36 min en régime courant ; 50 à 58 min une fois par 24 h pendant la relecture complète (dans la fenêtre `BLG_NOTION_FULL_HOURS` si elle est posée). Flux horaires : 60 min plus l'attente derrière les flux pilotes, 62 à 72 min (central) et jusqu'à 90 min (pessimiste) en simulation ; aucune famine (garde d'échéance).
- Requête 6.4 vide ; requête 6.5 vide hors cas Notion expliqué.
- Chaque échec de 6.3 suivi d'une publication complète en moins de 40 minutes, sinon panne de source à traiter à part.
- Au moins 95 % des réponses `net._http_response` en 200 sans dépassement de délai.
- Usage Vercel dans les quotas du plan, aucune facturation additionnelle ; 6.6 : total des tables métier stable pour une source inchangée (seule `sync_runs` croît d'une ligne par tentative), lignes préparées orphelines bornées (aucune ligne éligible au nettoyage restante au-delà d'un passage), `cleanup.error` absent des réponses du tick.
- `lock.kind` = `shared` sur toutes les réponses du tick relevées ; à 30, aucun `cadence.requestedMinutes` (demi-heure réellement appliquée).

Si l'écart maximal dépasse de façon répétée la valeur attendue (30 min + 2 min + durée de l'unité) : relever `measurements` dans les réponses du tick pour identifier l'unité lente ; le déclenchement toutes les minutes est l'option suivante (la route de 60 s peut alors toucher le déclenchement suivant, le verrou de processus et les verrous par flux s'appliquent).

## 7. Retour arrière complet

Ordre sans chevauchement : arrêter pg_cron d'abord, rétablir GitHub ensuite.

1. SQL section G : `cron.unschedule('cockpit-refresh-tick')` (et la tâche de purge si créée), suppression de la fonction et du schéma `cockpit_ops`. Extensions laissées en place ; ne pas supprimer `pg_cron` (cela effacerait toutes les tâches). Secret : laissé, ou neutralisé par une valeur aléatoire.
2. Workflow : rétablir le bloc `schedule` d'origine (annulation du commit de 5.3).
3. Cadence : retirer `BLG_REFRESH_CADENCE_MINUTES` (défaut 60) ou la mettre à `60`, puis redéploiement. Aucune donnée n'est à reprendre.
4. Code du lot U4b : un retour au code antérieur sans retirer les migrations reste compatible. L'ancien code lit par tentative (`readKpiSource` d'avant, `cockpit_source_window`, `v_ad_daily`) et les lignes courantes portent la dernière tentative : il lit exactement ce que lisait le nouveau. Ce qui se passe s'il écrit de nouveau :
   - KPI : il écrit une version complète par passage (lignes `is_current` = false) et clôt par `finish_sync` ; son lecteur lit cette dernière version, donc des données justes, mais le volume par passage revient et `is_current` n'est plus tenu à jour pour ces tentatives ;
   - Masterclass et inscriptions : les fonctions SQL de 018 restent en place et continuent de publier dans l'état courant (le code antérieur appelle les mêmes RPC) ;
   - `ad_daily` : `finish_sync` clôt la tentative sans publication d'état ; `v_ad_daily` lit les lignes de cette dernière tentative, justes ; les lignes courantes gardent une tentative plus ancienne et ne sont plus lues tant que l'ancien code tourne.
   Revenir ensuite au code de ce lot : la publication suivante de chaque flux fusionne à nouveau les lignes préparées dans l'état courant, mais seulement dans sa fenêtre, et le nouveau lecteur KPI lit l'état courant : sans reprise, il afficherait jusqu'à cette publication (et, hors de la fenêtre, durablement) les valeurs d'avant le retour arrière. Marche exacte ci-dessous (7.1).
5. Migrations : ne jamais les retirer en supprimant des données. 019 : son retour arrière est en fin de fichier (deux fonctions, aucune donnée ; redéployer d'abord un code qui n'appelle plus `cockpit_cleanup_staged`, sinon le tick signale seulement `cleanup.error`). 018 : les colonnes `is_current`, les index partiels et les nouvelles fonctions peuvent rester (inutilisés par le code antérieur) ; pour revenir aux fonctions antérieures sans toucher aux lignes, réappliquer par `CREATE OR REPLACE` les corps de `cockpit_publish_posthog` (016) et de `cockpit_stage_lead_entries` / `cockpit_publish_lead_entries` (009). 017 : son retour arrière est en fin de fichier (fonctions et table du bail, sans donnée métier) ; avec le code de ce lot encore déployé, le tick passe alors en `process-only`, signalé dans sa réponse.

### 7.1 Retour arrière du code puis redéploiement, avec écritures entre les deux (lot U4c-garde)

Prouvé par `tests/state-rollback.integration.ts` (PostgreSQL 17 jetable, dans `npm run test:db`) :

1. Retour arrière du code (redéploiement de la version antérieure), migrations laissées en place. Aucune action en base. Avant toute écriture de l'ancien code, l'ancien lecteur KPI (copie de `7bc6a68`), `v_ad_daily`, `v_meta_conversions_daily` et `cockpit_source_window` Masterclass lisent exactement ce que lit le nouveau, y compris après des collectes du nouveau chemin (valeur modifiée, objet disparu, objet apparu, tentative interrompue).
2. Écritures de l'ancien code : KPI et publicités par jour par `finish_sync complete` (une version complète par passage, lignes non courantes), lues par l'ancien lecteur et les vues ; Masterclass et inscriptions par les mêmes RPC qu'aujourd'hui (fonctions de 018 en base : état courant tenu). Le nouveau lecteur KPI ne voit pas ces tentatives.
3. **Ordre protégé du retour au code de ce lot** (reprise CP2, 24 septembre ; sans lui, entre le redéploiement et la reprise, le nouveau lecteur montre les valeurs d'avant le retour arrière pour les jours de la fenêtre : état périmé visible) :
   a. suspendre le déclencheur : `SELECT cron.unschedule('cockpit-refresh-tick');` (section G ; ou, si GitHub est encore le déclencheur, désactiver le workflow) et attendre la fin du passage en cours (`SELECT count(*) FROM sync_runs WHERE status='running' AND lease_until > now();` = 0, ou 10 minutes) ;
   b. contrôle « reprise nécessaire » (attendu : au moins une ligne après des écritures de l'ancien code) :
      ```sql
      -- Dernière tentative complète de chaque flux KPI / publicités dont les lignes ne sont pas courantes : écritures de l'ancien code non reprises.
      SELECT r.source, r.stream_key, r.id AS derniere_tentative, r.finished_at
        FROM sync_runs r
       WHERE r.stream_key IN ('kpi_meta_daily','kpi_posthog_daily','kpi_wix_daily','ad_daily') AND r.status IN ('complete','empty') AND r.pagination_complete
         AND r.finished_at = (SELECT max(x.finished_at) FROM sync_runs x WHERE x.source = r.source AND x.source_namespace = r.source_namespace AND x.stream_key = r.stream_key
                               AND x.query_profile_key = r.query_profile_key AND x.status IN ('complete','empty') AND x.pagination_complete)
         AND (EXISTS (SELECT FROM source_aggregates a WHERE a.sync_run_id = r.id) OR EXISTS (SELECT FROM ad_daily d WHERE d.sync_run_id = r.id))
         AND NOT EXISTS (SELECT FROM source_aggregates a WHERE a.sync_run_id = r.id AND a.is_current)
         AND NOT EXISTS (SELECT FROM ad_daily d WHERE d.sync_run_id = r.id AND d.is_current);
      ```
   c. reprise de l'état courant, une fois (SQL, rôle `service_role` ou propriétaire) : `SELECT public.cockpit_resume_current_state();` (migration 019) ; puis la requête b doit être vide ;
   d. redéploiement du code de ce lot ; le passage suivant reprend normalement ;
   e. réactivation du déclencheur (section E).
   Le rejeu de la migration 018 ne suffit pas à reprendre les données de la transition : il ne complète que les clés sans ligne courante et laisse le nouveau lecteur sur les valeurs d'avant le retour arrière (constat prouvé par le même test). Si le déclencheur ne peut pas être suspendu, l'ordre « redéployer puis reprendre » reste possible mais expose l'état périmé jusqu'à la reprise (quelques minutes) ; la publication suivante de chaque flux ne corrige que sa fenêtre.
4. Ce que fait la reprise : Pour chaque jour KPI, jour de publicités, profil de conversions et période exacte Masterclass, les lignes que lisent les anciens lecteurs deviennent courantes, les autres lignes courantes sont retirées (`is_current` = false, jamais effacées). Aucune ligne ajoutée ni supprimée ; les publications attendent la fin de l'appel (verrou des trois tables, lectures non bloquées) ; un second appel ne change rien (réponse à zéro). Réponse : `{"kpi":{"periods":n,"retired":n,"promoted":n},"masterclass":{…},"ad_daily":{…},"meta_conversions_daily":{…}}`, à conserver avec le relevé 6.6.
5. Contrôle : requête 3.b vide, relevé 6.6 (totaux inchangés par la reprise), tableau quotidien identique à celui affiché par l'ancien code juste avant le redéploiement ; la collecte suivante du nouveau chemin n'ajoute aucune ligne pour une source inchangée. La requête 3.b est prouvée dans `tests/state-rollback.integration.ts` (non vide après les écritures de l'ancien code, vide après la reprise).

Coût : comme la reprise de 018, l'appel parcourt les périodes de `source_aggregates`, `ad_daily` et `meta_conversions_daily` ; mesure sur volume synthétique représentatif (≈ 680 000 lignes) dans `private/derived/fable-cockpit-20260923/cp2-reprise-20260924/volume/RESULTATS.md` ; à lancer déclencheur suspendu.

## 8. Pourquoi ce SQL n'est ramassé par rien

`scripts/migrate-local.ts` et tous les tests d'intégration lisent `readdirSync('supabase/migrations')`, sans parcours récursif ; aucun ne lit `supabase/manual/`. Les migrations 017, 018 et 019 sont, elles, dans `supabase/migrations/` : elles sont lues par ces scripts et tests locaux, et s'appliquent en production par le coordinateur (section 5.1.1). Le dépôt n'a pas de `supabase/config.toml` et le CI (`ci.yml`) lance seulement `npm run check` et `npm run test:db`. Le fichier du déclencheur commence en plus par une garde qui arrête une exécution d'un bloc.
