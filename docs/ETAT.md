## 23 septembre 2026 : inscriptions, une modification met à jour la même ligne (U4c-inscriptions, local, revue requise)

Migration 020. Une inscription modifiée à la source, re-liée à une autre personne ou reclassée par un profil de mapping revu met à jour sa ligne existante (même identifiant) au lieu d'en ajouter une copie complète. Une collecte identique n'ajoute rien, un nouvel objet ajoute une ligne. Les changements métier (fiche modifiée à la source, personne ou état d'identité, éligibilité) sont datés dans une trace minimale sans aucun contenu de fiche ; un changement de profil seul n'y écrit rien (déjà suivi par passage). Aucun lecteur modifié, aucun changement de code.

Validation locale : 36 tests PostgreSQL des inscriptions (15 nouveaux, dont les quatre lecteurs réels), 593 tests, typage et compilation ; contre-épreuve faite (ancien basculement remis : 11 échecs). Changement de profil sur 5 inscriptions : 5 → 5 lignes (10 avant). Reste : application de 020 hors passage, revue Codex, volume réel.

## 23 septembre 2026 : taux inscription → vidéo borné aussi par l'heure de lecture navigateur (U6b, local, revue requise)

Complément de D3 option A : le taux inscription → vidéo porte sur les inscriptions antérieures à la plus ancienne des deux heures suivantes : couverture des inscriptions et heure de lecture des observations navigateur (PostHog). Une personne inscrite après la dernière lecture navigateur sort des deux termes du taux au lieu d'être comptée comme « n'a pas regardé » ; l'heure affichée avec le taux est cette plus ancienne heure. Si l'heure de lecture navigateur est inconnue, le taux est indisponible avec ce motif. Les quatre autres taux, les taux navigateur et les compteurs ne changent pas. Vérifié sans changement : quand « S'inscrivent » est « — », le taux formulaire → inscription peut afficher 0 % sur la population couverte ; le compteur porte son motif (« Les inscriptions attendent une mise à jour couvrant les formulaires de cette sélection. »).

Validation locale : 593 tests (5 nouveaux), typage et compilation ; contre-épreuve faite (correction retirée : « 1 sur 2 » au lieu de « 1 sur 1 »). Limites : décalage d'ingestion PostHog de quelques minutes, aucune lecture réelle, recette navigateur à faire.

## 23 septembre 2026 : Parcours, taux sur les activités couvertes (D3 option A) et bases de dates des rendez-vous (local, revue requise)

Décision Mehdi du 23/09 (D3, option A) : les taux du Parcours qui font intervenir les inscriptions ou les rendez-vous ne disparaissent plus pendant une campagne. Ils portent sur les personnes dont l'activité est antérieure à l'heure de couverture des sources concernées : inscriptions pour formulaire → inscription et inscription → vidéo ; la plus ancienne des inscriptions et des rendez-vous pour vidéo → rendez-vous et calendrier → rendez-vous. Une personne plus récente sort des deux termes du taux et n'est jamais comptée comme « n'a pas fait ». Les compteurs restent complets. Chaque flèche dit « activités jusqu'au … » et combien de personnes plus récentes sont hors taux ; une ligne sous le parcours donne l'heure des taux et celle de la lecture des compteurs. Une source à actualiser, en cours de lecture ou dont la dernière tentative a échoué reste utilisable jusqu'à sa dernière couverture publiée, signalée dans la fraîcheur des chiffres ; une source absente ou sans couverture connue, une date de réservation manquante ou des rendez-vous non reliés laissent le taux indisponible, avec son motif.

Résultats : la carte Rendez-vous affiche « Réservés · date de réservation » et « Réalisés · date du créneau », avec « Deux bases de dates : un écart entre les deux n'est pas une erreur. » ; la note du tableau par publicité précise les deux bases. Aucun calcul de Résultats modifié.

Validation locale : 576 tests (7 nouveaux), typage et compilation ; contre-épreuve faite (garde précédente remise : le taux à deux personnes couvertes redevient indisponible). Limites : aucune lecture réelle ; recette navigateur à faire.

## 23 septembre 2026 : stockage par identifiant stable, verrou partagé, défaut 60 (local, revue requise)

Le lot U4 est corrigé sur les trois points de la revue. Rien n'est appliqué en production.

- Cadence : sans réglage, les six flux du pilotage Masterclass restent à 60 minutes (défaut de transition). `BLG_REFRESH_CADENCE_MINUTES=30` est la seule activation de la demi-heure, à poser après trois constats : migrations 017 et 018 appliquées, observation à 60 conforme, verrou partagé actif (`lock.kind` = `shared` dans les réponses du tick).
- Stockage : un objet source inchangé n'ajoute plus aucune ligne ; une modification met à jour la même ligne ; un nouvel objet ajoute seulement cet objet ; un objet disparu est retiré de l'état courant sans être effacé (KPI Meta, PostHog, Wix, rapport Masterclass, publicités par jour). Inscriptions : une inscription inchangée n'est plus réécrite. Publication atomique en une transaction ; les lecteurs existants restent exacts. Aucune purge ; les versions écrites avant la migration restent en place.
- Verrou partagé du tick en base (migration 017), branché après le verrou de processus ; si la migration manque, le passage continue avec le seul verrou de processus et le dit.

Preuves : 560 tests, typage et compilation ; 99 tests PostgreSQL 17 jetable, dont lecture ancienne et nouvelle identiques après reprise des données et non-accumulation flux par flux. Ordre de mise en service : migrations 017 et 018 avant le code (docs/ACTUALISATION.md, section 5.1). Restent : application des migrations et observation à 60 (coordinateur), arbitrage de deux écarts au brief (erreur du bail en HTTP 503 ; bail par défaut sur la seule route), double en mémoire de la vérification navigateur KPI à adapter.

## 23 septembre 2026 : tableau « Suivi quotidien du funnel », colonne par colonne (local, revue requise)

Chaque colonne du tableau a sa source, sa définition, son flux automatique, sa fraîcheur et sa preuve (livraison U8). Les blocs sont désormais datés par la plus ancienne des lectures dont ils dépendent et marqués « ancien » dès qu'une lecture dépasse la cadence réelle de son flux (réglage des flux pilotes, une heure pour Notion et les ventes), au lieu d'un seuil fixe d'une heure. L'heure de chaque bloc est visible au-dessus du tableau, la plus ancienne des blocs disponibles en tête, et l'export Excel reprend ces lignes.

Un jour passé lu en cours de journée n'est plus présenté comme complet : il reste « Non mesuré » (le jour en cours reste partiel et signalé). Chaque taux affiché rapproche deux mesures du même bloc et du même jour. Ventes et cash : « Lecture suspendue (réglage BLG_COMMERCE_READER) » avec la date de la dernière publication complète et de la dernière tentative ; les jours qu'elle ne couvre pas restent non mesurés et les totaux indisponibles. CTA oral, offres faites et CA contracté restent non mesurés avec leur responsable et leur prochaine étape. Aucune nouvelle collecte, aucune définition nouvelle, colonnes inchangées.

Validation locale : 569 tests (21 nouveaux), typage et compilation ; contre-épreuves faites (campagne actuelle retirée du périmètre, seuil fixe d'une heure). Limites : aucune lecture réelle ; conversion Meta, cadence réelle et données réelles (CP3) à constater par Codex ; règle de cohorte des rendez-vous (une inscription non reliée rend le bloc non mesuré) soumise à arbitrage.

## 23 septembre 2026 : Parcours, lecture des visites via le cache PostHog (local, revue requise)

Le Parcours Masterclass demande désormais à PostHog son cache récent pour les deux lectures des visites : une réouverture ou un « Réessayer » de la même période est servi immédiatement une fois le calcul précédent terminé. Le navigateur attend jusqu'à 4 minutes (14 appels au plus) au lieu de 2. S'il s'arrête sans résultat, l'écran l'écrit clairement : « Lecture des visites non terminée », avec l'heure de la tentative et le bouton Réessayer ; les inscriptions et rendez-vous restent affichés, aucun zéro n'est ajouté. Un résultat servi par le cache est daté de son calcul.

Chaque lecture journalise sa durée et son issue, sans donnée de visiteur. Aucune table, aucun stockage, aucun changement de filtre, de définition, de taux ou d'exclusion d'essais. 527 tests, typage et compilation réussis en local ; simulation hors ligne : une lecture PostHog de 140 s ou 230 s aboutit désormais, une de 260 s affiche « non terminée ». La cause de la lenteur en production reste à mesurer sur données réelles.

## 23 septembre 2026 : actualisation 30 minutes préparée (local, non activée)

GitHub ne lance que 2 à 7 passages par jour au lieu de 72. Ce lot prépare un déclencheur principal en base (pg_cron + pg_net, toutes les 2 minutes) et rend la cadence des flux Masterclass réglable. Rien n'est activé : aucune extension, aucun secret, aucune tâche planifiée, workflow GitHub inchangé.

- Cadence : réglage serveur `BLG_REFRESH_CADENCE_MINUTES` (absent = 30 minutes, `60` = comportement actuel) pour PostHog Masterclass, formulaires Wix, trois KPI quotidiens et publicités par jour. Notion (inventaire complet relu à chaque passage) et le catalogue Meta (relu en entier) restent à une heure. Passage au créneau UTC suivant étendu aux demi-heures pour qu'un déclenchement toutes les quelques minutes ne fasse pas dériver la cadence.
- Non-chevauchement : un refus 409 `source_busy` est « waiting », plus « failed » ; verrou de passage en mémoire du processus (même instance seulement). Verrou partagé en base préparé, non branché : `supabase/manual/2026-09-23_cockpit_tick_lease.sql`.
- Déclencheur préparé : `supabase/manual/2026-09-23_cockpit_refresh_cron.sql` (secret dans Vault, fonction privée, planification toutes les 2 minutes, contrôles, retour arrière).
- Dimensionnement (simulation avec le vrai planificateur, durées supposées sauf Notion mesuré) : toutes les 5 minutes ne suffit pas en profil pessimiste ; toutes les 2 minutes tient 30 minutes d'écart moyen (45 au plus). Notion ne peut pas publier plus souvent qu'environ toutes les 20 à 50 minutes.
- Volume : chaque passage des flux Masterclass conserve sa version de fenêtre, sans purge ; à 30 minutes ce volume double. À mesurer et arbitrer (docs/ACTUALISATION.md, section 4).

Validation locale : typage, suite complète et compilation (`npm run check`) ; 59 tests PostgreSQL 17 sur une base jetable. SQL préparé vérifié contre des doublures des signatures documentées et, pour le verrou partagé, sur les 14 migrations réelles. Limites : aucun appel réel, durées de production des unités non mesurées hors Notion, bascule et cadence réelle à constater (docs/ACTUALISATION.md, sections 5 et 6).

## 23 septembre 2026 : Isolation du lecteur financier Notion (local)

Le lecteur des ventes Notion (`commerce`) échoue à chaque passage depuis le 22 septembre : la recherche de son point de reprise est trop lente sur la table des agrégats. Il consomme le budget du passage horaire et le fait terminer en échec. Ce lot l'isole côté serveur sans toucher à la correction de fond (index, réécriture), ni aux migrations, ni aux sources.

Réglage serveur unique `BLG_COMMERCE_READER`. Absent, vide ou toute autre valeur que `active` : lecture suspendue. `active` rétablit exactement le comportement précédent.

En pause :
- planning : le passage horaire ne planifie plus, ne lit plus et n'exécute plus l'unité `commerce` ; son état ne compte plus dans le résultat du passage. Les autres unités (CA Wix, paiements reçus, inscriptions, suivi commercial, antériorité client, Meta, PostHog, tableau quotidien) sont inchangées ;
- appel direct : `POST /api/sync/commerce` répond 423, code `commerce_paused`, « La lecture des ventes est suspendue. » ;
- Actualiser (Résultats) : l'état lu dans Connexions retire la lecture des ventes ; toutes les autres lectures partent comme avant. Si Connexions ne répond pas, le serveur refuse de lui-même et l'avis affiche « lecture suspendue » ;
- Connexions : la carte « Notion · ventes payées » affiche « Lecture suspendue », la date réelle de la dernière publication complète et de la dernière tentative lues dans `sync_runs`, sans bouton de lecture.

Contrôle réservé : `GET /api/jobs/commerce` avec le bearer `CRON_SECRET` (même vérification que `jobs/tick`, deux appels par minute au plus) exécute une seule unité bornée du lecteur, identique à celle du passage horaire (trois pages Notion au plus, budget de 45 secondes), même en pause, et renvoie son statut, ses compteurs et un code d'échec lisible. Une session de l'interface ne suffit pas ; aucune autre voie ne contourne la pause.

Lectures conservées : la dernière publication des ventes reste lue. « Nouveaux clients », « Nouvelles ventes payées », les colonnes ventes et encaissé du détail par publicité et du tableau quotidien gardent la date de leur propre rapport. Aucune carte n'est masquée par déduction, aucune date n'est figée.

Résilience : une erreur de lecture du rapport des ventes ne fait plus échouer `/api/dashboard` ni `/api/ad-funnel`. Seules les mesures ventes deviennent indisponibles, avec leur raison, jamais remplacées par zéro ; les autres blocs restent servis.

Validation locale : 523 tests unitaires (514 existants et 9 nouveaux : réglage, planning, passage de contrôle, route, Connexions avec deux dates, Actualiser, Résultats et détail par publicité en échec), typage et compilation de production réussis. 59 tests PostgreSQL 17 réussis sur une base locale jetable (aucun ne vise directement les fichiers modifiés). Les deux jeux de données existants qui décrivent la planification des ventes portent désormais `BLG_COMMERCE_READER=active`.

Limites : local uniquement, rien de publié. Au déploiement sans variable, la lecture des ventes est suspendue (voulu). La fin des échecs du passage horaire et la cadence réelle ne sont pas prouvées en production. Le passage de contrôle échouera tant que la correction de fond n'est pas faite. Les ventes affichées restent celles de la dernière publication complète.

## 22 septembre 2026 — intégration revue du tableau automatique et de l’historique archivé

Le tableau conserve les vues existantes et lit les relevés automatiques des sources, avec les mêmes dates, filtres et essais. Le commerce conserve séparément un Client historique absent uniquement après lecture de sa page confirmant archive et corbeille dans la source attendue. Les données du dernier miroir publié sont conservées ; toute autre disparition reste bloquante. Aucun changement des sources Notion, des ventes ou des paiements. Les erreurs HTTP après une page sauvegardée restent lisibles et la reprise est préservée.

Revue indépendante favorable du lot KPI puis du correctif final ; 22 tests ciblés commerce réussis, typage après intégration réussi. Les 27 autres fichiers KPI du dossier de revue sont identiques. Les contrôles CI sur le lot intégré, la publication et les passages automatiques réels restent à constater. Aucun nettoyage de stockage, nouveau service ou changement des sources n’est inclus.

## 22 septembre 2026 — automatisation KPI préparée localement, revue requise

Le tableau KPI lit désormais les publications de sources automatiques : Meta quotidien, clics/confirmations PostHog et activité des neuf messages Wix validés. Trois unités rejoignent le tick existant ; les identifiants existants sont réutilisés. Les sources restent en lecture seule. Période, filtres, essais explicites, fraîcheur et export CSV reprennent le relevé affiché. Les vues historiques restent dans le cockpit ; aucune refonte Parcours, Liens ou Commercial. Conservation des versions et des derniers relevés valides, sans purge ni migration de schéma.

Deux cycles de lectures réelles ont abouti avec publications uniquement en mémoire locale. 500 tests unitaires et compilation passent avant les dernières corrections bornées ; ensuite dix tests ciblés (dont PostgreSQL JSONB réel et échec HTTP), typage et recette navigateur du tableau passent. Dernière correction de texte contrôlée par typage. La recette exhaustive des cinq vues en production, la fenêtre automatique complète de 35 jours et deux passages du planificateur en production restent à faire après revue/intégration. Une fiche Client archivée bloquait la publication commerciale ; sa conservation historique est maintenant couverte par le correctif revu ci-dessus. Aucune donnée individuelle n’est incluse dans la documentation produit. La publication distante reste à constater.

## 19 septembre 2026 — Parcours : intersection vidéo vers rendez-vous (local)

Complément séparé après `76c4c07` : le taux vidéo→RDV pouvait afficher 2/1. Son dénominateur exigeait une vidéo après inscription, mais son numérateur acceptait aussi un réservant ayant regardé avant de s’inscrire. Le numérateur réutilise maintenant exactement les personnes du dénominateur existant, puis leur applique la condition vidéo→RDV déjà présente. Aucun plafonnement artificiel du pourcentage.

Le cas synthétique A inscrit→vidéo→RDV et B vidéo→inscription→RDV donne 1/1 ; les deux personnes restent dans le compteur RDV et dans son détail. Le taux calendrier→RDV conserve sa propre base. Filtres, identité, attribution, dénominateur et toutes les gardes de disponibilité sont inchangés. 32 tests ciblés passent, dont quatre nouveaux couvrant ce cas, un RDV uniquement hors dénominateur, égalité des dates, annulation, absence de RDV/base et conservation de la garde sur une date de réservation manquante. Suite complète : 490 tests réussis ; typage et compilation de production Turbopack réussis. Aucun push, migration ni système distant ; revue et intégration restent au coordinateur.

## 19 septembre 2026 — Parcours : ordre chronologique des instants (local)

Correction préparée depuis `57fb427` dans `codex/parcours-instant-ordering`. Une couverture `09:26:48.500Z` pouvait être classée avant `09:26:48Z` en comparant les chaînes, ce qui masquait des taux pourtant couverts. Le même défaut concernait l’ordre des étapes, les premiers/derniers événements et la première origine.

Les comparaisons utilisent désormais `Temporal.Instant`, sans réduction à la milliseconde : les fractions jusqu’à la nanoseconde et les décalages horaires sont conservés. Les règles existantes d’égalité, cohortes, filtres, compteurs, dépendances de couverture et disponibilité restent inchangées. Les instants invalides rencontrés par une comparaison sont refusés ; ils ne valident aucun taux. Les anciens créneaux contenant uniquement une date gardent leur ordre calendaire d’affichage, sans heure inventée et sans servir de date de réservation. Le tri reste cohérent lorsqu’ils sont mélangés à des instants exprimés avec un autre décalage.

Validation ciblée : 28 tests réussis, dont dix nouveaux tests couvrant fractions variables, nanosecondes, instants égaux avec décalages différents, couverture avant/après/égale, minima/maxima, première origine, ordre des étapes, dates invalides et créneaux historiques sans heure. Suite complète : 486 tests réussis ; typage et compilation de production Turbopack réussis. Aucun changement de cadence ni traitement de la course entre lecture des sources ; aucune source, migration ou publication distante. Intégration et recette réelle restent au coordinateur. Autorité : `ETAT-ACTUEL.md` et `DECISIONS-ACTEES.md` du centre BLG.

## 19 septembre 2026 — C3 : interruption du corps de réponse PostHog

La contre-relecture a reproduit un cas restant après `0df4d18` : les en-têtes HTTP 202 arrivent, puis le corps est interrompu à la limite de temps. La lecture générique masquait cette interruption sous `INVALID_RESPONSE` ; le rapport était déclaré échoué malgré son identifiant sauvegardé.

Le correctif est limité à `posthog-query.ts`. Il conserve la classification du transport pendant la lecture du flux, avant la normalisation générique ; le parsing JSON reste distinct. `http.ts` et les erreurs des autres connecteurs ne changent pas. Les réponses non-2xx et les limites de taille restent prioritaires. Un corps POST ou GET interrompu au budget devient une continuation en attente ; la reprise récupère le même identifiant sans nouveau POST. Un document entièrement reçu mais invalide reste un échec, y compris à la limite de temps. Le dernier rapport complet reste conservé dans les deux cas.

Validation du complément : reproduction avant/après identique (échec puis attente, checkpoint présent, aucune publication), cinq tests supplémentaires couvrant POST/GET interrompus, JSON invalide POST/GET et refus de réémettre après réception des en-têtes ; 476 tests généraux, typage et compilation Webpack réussis. Les 12 tests PostgreSQL C3 réexécutés réussissent également et vérifient le lecteur contre la persistance réelle. Aucun changement SQL, filtre, calcul, délai ou système distant. La revue finale et l’intégration restent au coordinateur, selon `ETAT-ACTUEL.md` et `DECISIONS-ACTEES.md` du centre BLG.

## 22 septembre 2026 — relevé KPI daté dans Résultats (local)

Le cockpit local lit maintenant un relevé JSON agrégé et validé depuis une variable serveur privée, ou depuis un fichier absolu local explicitement configuré. La variable JSON est prioritaire ; aucune donnée métier n'est embarquée dans le dépôt. Sans relevé, l'écran affiche simplement « Aucun relevé chargé ».

Le tableau fixe sa propre fenêtre et sa fraîcheur, indépendamment des filtres globaux. Il sépare Meta, occurrences et contacts Wix, réservation, appels, ventes et cash ; les valeurs non mesurées restent indisponibles. Les ratios qui croiseraient la dépense Meta et le suivi commercial sont masqués faute de cohorte payante chaînée. Validation : tests ciblés, typage, build et recette 1440/390 px réussis. Aucun changement du Parcours, publication ou raccord automatique n'a été effectué.

## 19 septembre 2026 — C3 : reprise durable des rapports PostHog (local)

Sur la base de production `9d9c016`, la branche `codex/c3-posthog-resume` prépare la correction des expirations Quiz/Masterclass. Elle est indépendante de `codex/c3-native-clock` (`1379dee`) et des migrations 014/015 non installées. Le coordinateur conserve seul intégration, installation et recette réelle ; aucune source ni système distant n’a été modifié ici.

Le quiz exécute ses quatre ou cinq requêtes existantes et la masterclass sa requête existante en mode asynchrone. Les identifiants sont enregistrés dans `sync_runs.checkpoint` avant envoi ; l’identifiant serveur effectivement retourné est ensuite enregistré. Une reprise récupère le même calcul. Le projet, l’origine, le profil, les filtres, la période, l’empreinte SQL et le début restent liés. Le délai absolu est dix minutes. Les résultats bruts ne sont pas persistés dans le checkpoint ; tous les agrégats sont relus et rapprochés avant publication.

La migration additive 016 utilise les tables existantes. Ses quatre RPC réclament un bail, sauvegardent une continuation, libèrent une attente ou publient le rapport complet et son marqueur de réussite dans une transaction. La publication répétée du même contenu est idempotente. Un ancien worker ne peut plus sauvegarder, libérer ou publier après perte du bail ; l’heure est relue après acquisition des verrous. Les payloads incomplets, JSON null, types incorrects, dépassements et compteurs de reprise régressifs sont refusés.

Les recherches de récupération d’un ID non reconnu réservent leur compteur en base AVANT chaque GET : trois au plus à travers les reprises et arrêts de processus. Un accusé POST peut désigner un autre ID par déduplication PostHog. S’il est perdu avant que cet ID soit connu et que l’ID client reste introuvable, l’échec reste borné ; aucune garantie universelle d’exécution exactement une fois n’est revendiquée. Les refus d’accès, réponses tronquées ou de plus de 2 Mo et incohérences restent des échecs. Le dernier rapport complet est conservé. Un échec déclenche le délai existant de cinq minutes avant une nouvelle tentative.

Une attente libère son bail et reste reprenable par le tick ou la préparation explicite. Le tick termine la période déjà engagée s’il franchit minuit à Paris ; une demande utilisateur sur une autre période n’utilise jamais ce rapport. Le navigateur garde son plafond de 120 secondes/huit passages : si le calcul continue, il affiche « En attente » avec un bouton de reprise effectif. Les calculs, définitions et filtres métier ne changent pas.

Budget : lectures PostHog bornées à 20 secondes par invocation de rapport, appels de persistance à cinq secondes maximum et au temps restant ; budget partagé existant 40 secondes sources / 45 secondes nominales conservé. Les autres opérations du tick conservent leurs limites existantes : cela ne prouve pas un plafond global strict pour tous les chemins du scheduler. Un timeout de réponse DB ne prouve pas l’annulation de sa transaction ; le bail et l’idempotence gèrent cette ambiguïté.

Validation locale : 471 tests unitaires/contrats, 58 tests PostgreSQL dont 12 C3 PostHog, typage et compilation Next Webpack réussis. Tests C3 : concurrence, reprise Quiz5/MC1 et lecture exacte `cockpit_source_window`, perte ACK publication, arrêt forcé du processus après POST, bail expirant pendant verrou, trois recherches réparties sur trois invocations, changement de période, permissions et absence de publication partielle. Chrome réel avec réponses synthétiques : arrêt des reprises automatiques, bouton disponible et cliquable, nouvelle lecture après succès, aucune erreur JavaScript. `npm run build`/Turbopack refuse le lien local `node_modules` extérieur au clone ; `next build --webpack` réussit sans changement de configuration produit.

Prochaine action : revue finale du coordinateur, installation de 016 seulement dans le périmètre autorisé, intégration du commit puis observation réelle de reprises et publications Quiz/Masterclass. Ces contrôles locaux ne prouvent ni le délai PostHog réel ni la fraîcheur automatique en production. Les registres d’autorité restent `ETAT-ACTUEL.md` et `DECISIONS-ACTEES.md` du centre BLG.

# Rendez-vous visibles — 18 septembre 2026

Complément demandé par Mehdi : même carte Résultats pour réservés et réalisés, détail privé des personnes, date de réservation, date du call, origine et coût publicitaire moyen. Le détail Parcours utilise exactement les personnes de son compteur ; les coordonnées personnelles ne sont pas ajoutées.

PR18 publiée et recette réelle passée : compteurs et personnes visibles, dates futures, ordinateur/mobile. Complément relu : annulation explicite sans créneau, accord singulier et calcul accéléré des checkpoints Commerce. 455 tests, typage et compilation réussis. Lecture de la copie réelle confirme que les listes concordent avec les compteurs. La colonne publicitaire RDV réservés utilise maintenant la date de réservation déjà calculée, y compris pour un créneau futur. Coût non calculé si les réservations ou leur attribution attendent une lecture complète. Aucun nouveau tracking, aucune modification des sources. Recette navigateur passée en 1440, 390 et 320 px : liste des personnes, dates, onglets, filtres, clavier et absence de débordement. La dernière publication et la cadence automatique restent suivies dans le journal de coordination.

# État technique du cockpit

Contrôle complémentaire du 18 septembre : deux premières ouvertures de Résultats ont rencontré une erreur de lecture. Correction préparée : quatre lectures de base simultanées maximum par requête, comparaison incluse, identité du cache existant et invalidation conservées. Les 459 tests, le typage et le build passent. La vérification du premier chargement en production reste nécessaire ; le code exact des deux incidents antérieurs n’a pas été récupéré.

## 18 septembre 2026 — livraison coordonnée du parcours et des actualisations

Publication PR15 (fusion6ae4296) : contrôles GitHub réussis, recette production en cours. Une lecture réelle du Parcours retrouve253 visites suivies,35 ouvertures,20 inscrits,12 démarrages vidéo et2 inscrits ayant réservé. Ces nombres sont un relevé daté du18/09, pas des valeurs fixes.

Cadence : les dix déclenchements GitHub observés depuis le16/09 sont séparés de142 à336minutes, alors que les runners démarrent en quelques secondes et finissent en environ dix minutes au maximum. Trois réveils par heure remplacent le réveil unique pour permettre une reprise plus rapide ; le moteur ignore les sources déjà fraîches. Cela atténue les départs manquants, sans garantir une heure tant que plusieurs cycles automatiques ne sont pas observés. Les pannes persistantes restent signalées et peuvent encore produire plusieurs alertes. Aucun nouveau service ni réglage de notifications n'est ajouté.

Le parcours validé présente cinq étapes cliquables, les taux sous les flèches, puis un seul détail à la fois : page, inscription, vidéo ou rendez-vous. Le filtre publicitaire et les dates restent simples ; aucun choix de version technique n'est imposé. Les confirmations Wix et les réservations Notion existantes sont raccordées sans modifier les sources ni additionner les événements Meta aux rendez-vous.

Résultats utilise le même calcul des nouveaux leads que le détail par publicité. Les inscriptions répétées et les personnes déjà connues restent distinctes ; première origine et identités réciproques existantes sont conservées. Une origine absente n'est pas inventée. Les premiers accompagnements ne sont pas remplacés par un décompte de ventes : leur attribution par publicité reste en attente de relation suffisante.

Les actualisations reprennent leurs points enregistrés, poursuivent les autres sources après une panne et distinguent attente et fin réelle. La migration additive013, relue et installée, permet de lire les fiches Notion modifiées et de vérifier un inventaire léger des suppressions/dépendances. Les fiches inchangées et l'historique restent conservés. Le dernier relevé valide reste lisible ; un relevé ancien ne prouve pas un zéro récent.

Validation locale intégrée : suite432tests, typage et build ; neuf tests PostgreSQL (dont12050fiches, reprise, suppression, dépendances et permissions) ; navigateur320/390/768/1024/1440 et revue visuelle. Les contre-relectures ont validé les faux zéros, l'origine, les différences de périmètre et la reprise des calculs longs. Le lecteur reprend le même calcul PostHog sur plusieurs appels courts ; la continuation privée est chiffrée, liée aux filtres et expire. Les preuves finales de publication, récupération réelle des sources et cadence restent suivies séparément. GitHub peut retarder ses déclenchements : un passage manuel réussi ne valide pas l'automatique.


## 18 septembre 2026 — rétablir la lecture des parcours

Incident reproduit sur la route publiée : la lecture synchrone PostHog expire avec une erreur amont, y compris pour une requête sans lecture de table. Les mêmes agrégats aboutissent par la voie asynchrone documentée ; aucune panne globale du service ni absence de collecte n’est déduite.

Le connecteur Parcours utilise désormais cette voie, attend le résultat complet avec un budget commun et limite la concurrence à deux requêtes. Il ne demande plus les mesures sans objet pour le parcours choisi. Une interruption réseau ou une erreur serveur amont est reprise une seule fois, dans le même budget total ; les refus d’accès et les données invalides ne sont pas relancés. Les filtres et calculs restent identiques. L’interface conserve uniquement une lecture réussie du même périmètre, avec sa date en cas d’échec ; aucun panneau vide n’est présenté comme une ancienne mesure.

Validation : 347 tests unitaires, TypeScript, construction de production, test navigateur synthétique, relecture indépendante. Les lectures locales des sources réelles réussissent pour la masterclass sur la période du mois et pour les deux parcours sur la journée. Visites et mesures vidéo présentes ; le signal de confirmation d’inscription masterclass et les vues par question du quiz restent des limites distinctes. Publication et recette de production consignées dans le journal privé BLG.


## 17 septembre 2026 — parcours, vidéo et périmètre des essais

Cette révision remplace l’ancien bloc Parcours par une lecture dédiée à la masterclass `/masterclass26` et au quiz : étapes, taux entre deux étapes d’une même visite, sections affichées, réponses par question et mesures du lecteur. Les visites suivies ne sont pas des personnes CRM ; les confirmations web ne remplacent pas les rendez-vous métier de Commercial et les événements Meta ne leur sont jamais additionnés.

La vidéo dispose de paliers, durées distinctes et d’une courbe de dernière position observée avec tableau accessible. Cette courbe inclut pauses et lectures en cours ; elle ne prouve ni abandon définitif ni attention. Les versions de page et vidéos incompatibles restent séparées. Les mesures absentes, tronquées ou interrompues restent indisponibles.

Les essais identifiés sont exclus par défaut dans Parcours et dans le tableau par publicité, avec une option pour les inclure. Les filtres de Parcours sont consolidés par session avant calcul. Le tableau publicitaire lit maintenant les dates de rendez-vous `scheduled_at` en jour de Paris, avec repli sur le jour historique. Commercial est conservé.

Contrôles : 340 tests unitaires, route privée, vérification TypeScript, navigateur local ordinateur/mobile avec données synthétiques ; lectures agrégées réelles PostHog sur les deux parcours et avec/sans essais. La nouvelle masterclass remonte des étapes de page, mais aucune mesure détaillée de vidéo n’est présente dans la lecture contrôlée. Le quiz remonte des réponses ; l’affichage par question et le clic vers le bilan manquent encore dans le script public. Aucune modification des pages sources dans ce lot. Les preuves de publication et les lectures de production sont consignées séparément dans le journal privé BLG.

Notifications : le dernier échec GitHub examiné correspond à la fin de la fenêtre de reprises alors que des unités étaient encore partielles ; un précédent passage a rencontré une erreur Notion. Distinguer « à poursuivre » et « en échec » est une recommandation, non une correction appliquée. Aucun réglage de notification ou d’ordonnanceur modifié.

## Lot précédent — publié avec la PR 11

Ce bloc remplace les états locaux historiques ci-dessous. Référentiel privé courant : `ETAT-ACTUEL.md` puis `DECISIONS-ACTEES.md` du centre de contrôle BLG. Les notes anciennes ne sont pas des instructions de reprise.

Lot préparé : filtres REST cumulés (borne basse et haute), dépenses issues de `v_ad_daily`, mesures absentes conservées à `null`, catalogue Meta complet indépendant de l’activité, import du jour inclus et deux événements de parcours supplémentaires. Catalogue présent sans activité : ligne disponible sans déduire un tunnel du nom de campagne.

Contrôle réel des dépenses sur une période historique : égalité entre Meta et la vue publiée ; les répétitions de la table brute ne sont plus additionnées. Import catalogue complet effectué. Actualisation : ordonnanceur GitHub existant, aucune seconde planification. Passage planifié contrôlé en échec sur Notion après succès Wix/Meta ; reprise Notion terminée manuellement. Cela ne prouve pas une cadence horaire fiable. PR 11 publiée et production contrôlée dans le périmètre de ce lot.

Les événements quiz ajoutés à la lecture ne prouvent pas leur émission publique. Première origine 180 jours, parcours croisé réel, exclusions et rapprochements commerciaux restent à contrôler dans le périmètre décidé.

## Historique conservé

# État du cockpit — reprise du 9 septembre 2026

Lire `DECISIONS-ACTEES.md` à chaque reprise. Les preuves, valeurs métier, identifiants et configurations restent privés. La publication GitHub/Vercel est autorisée par Mehdi le 9 septembre 2026 et en cours. La planification automatique reste différée.


## Actualisation du 16 septembre — lot local de contrôle avant installation

Ce bloc remplace les chiffres de tests et les états locaux plus anciens. Le lot tracking/cockpit reste local ; aucun déploiement ou import distant effectué pendant ce contrôle. Le code distingue les rendez-vous reportés, conserve les visites sous les filtres, choisit l’origine de façon déterministe et affiche les données financières absentes comme indisponibles. Les personnes déjà connues ne sont plus appelées systématiquement clients.

Les lecteurs sont configurés localement pour une heure ; le résultat d’un lot complet n’est plus présenté comme partiel. Forms ne demande que les formulaires configurés. CMS utilise la pagination documentée count/offset/total, avec garde sur les totaux absents ou approximatifs et compatibilité du booléen tooManyToCount omis. Les reprises Forms restent inchangées.

Validation finale : `npm run check` réussi — vérification TypeScript, **313 tests unitaires réussis**, construction de production. Les scénarios sont synthétiques ; aucun test navigateur, inscription, réservation ou email réel. La recette et l’installation demeurent des étapes distinctes. La présence du code horaire ne prouve pas qu’un déclencheur est actif ; aucune configuration de planification modifiée.

## Finalisation de publication du 16 septembre

La revue avant publication ne trouve ni secret, ni identité client, ni export métier dans les fichiers à publier. La migration 012 est déjà installée sur la base existante et ne doit pas être rejouée. Les deux révisions de liens déjà actives restent inchangées ; ce lot publie leur lecture et le suivi par publicité, sans recréer de lien.

L’actualisation horaire est installée et active dans GitHub Actions sur le dépôt existant. À la minute 17, le workflow appelle `GET /api/jobs/tick` avec le secret chiffré `CRON_SECRET`, puis reprend les réponses partielles dans le même passage, dans une fenêtre maximale de vingt-quatre appels et quinze minutes. Un seul appel de fonction ne suffit pas à garantir que toutes les sources dues sont traitées : chaque fonction conserve son budget court, tandis que le workflow draine les unités jusqu’au statut complet. Il échoue si une source échoue ou si le drainage reste partiel après la borne. Le workflow ne modifie aucune source : il lit les connecteurs autorisés et publie uniquement dans Supabase par les chemins serveur existants.

La configuration privée disponible contient `WIX_LEAD_ENTRY_CONFIG` et la destination masterclass. Elle ne contient pas les trois réglages PostHog explicites ni les deux profils Notion supplémentaires ; les valeurs déjà présentes sur Vercel sont conservées. Le premier drainage réel confirme que la clé Wix de production refuse actuellement Forms et le CMS quiz (`403`, dont `WDE0027` pour le CMS) et que Meta refuse les deux lectures (`400`, code Meta 200). Ces droits ne sont pas élargis par la publication et les données concernées restent signalées indisponibles. Le secret `CRON_SECRET`, explicitement autorisé ensuite par Mehdi, est installé dans GitHub Actions sans apparaître dans le dépôt ou les journaux.


## Version et périmètre de livraison

Les trois premières parties sont partiellement livrées : leads et rendez-vous, clients et paiements, acquisition et parcours. La prochaine reprise demandée doit terminer les données restantes, contrôler les liens de bout en bout et les connexions quiz/masterclass, puis proposer un Commercial proche d’un CRM. Actualisation continue, mise en ligne et design Parcours/Connexions restent différés.

Le résultat reste une interface courte avec des sources et limites expliquées. Les vues et interactions du futur Commercial doivent être proposées à l’utilisateur avant la refonte ; le miroir Notion reste en lecture seule.

Dans le dossier local du centre de contrôle BLG, la reprise commence par `private/derived/cockpit/PASSATION-COURANTE.md`, puis le lot pertinent de `SUIVI.json`. Les anciennes notes d’exécution ne remplacent pas cet état courant. La prévisualisation locale sert le build `Gss7Lk2OPVlCTSU7VSgne` avec la correction 011. Le code est modifié localement et non publié ; reprendre le dossier existant en préservant tous les changements.

## Stockage et données publiées

Les migrations privées versionnées jusqu’à 011 sont installées. Elles ajoutent le stockage technique nécessaire aux observations d’inscription et aux métadonnées créatives, sans modifier les données métier existantes. Elles ne valent ni autorisation d’import supplémentaire, ni activation d’une tâche planifiée.

Le rapport commercial L3 est publié. Il conserve un rapport complet par lecture, les jours associés et les empreintes minimisées nécessaires à la reprise. La carte Nouveaux clients correspond aux personnes qui commencent leur premier accompagnement, binômes inclus, à partir du Démarrage Client effectif. Les démarrages sans date ou à venir restent hors compteur. Un renouvellement ne reçoit jamais une date historique inventée.

Le cash et les transactions conservent leur définition Wix. Le rapprochement financier entre sources reste partiel. Pour les offres explicitement en trois fois, Mehdi confirme que le prix vendu correspond à trois mensualités. Le champ Total vente de l’échéancier permet cette lecture ; son raccord au cockpit reste à faire une seule fois par vente avec sa date, sans additionner le prix complet de chacune des trois échéances. Le CA contracté reste donc indisponible pendant ce raccord.

## Leads et rendez-vous

La définition actée des leads est : personnes qui contactent BLG pour la première fois. Les demandes répétées sont conservées dans les volumes source mais ne créent pas un nouveau lead.

L’import supervisé L1 est publié et le dernier double compte est corrigé. La correction 011, autorisée précisément par Mehdi, utilise en lecture seule les relations réciproques Client–Prospect avant le choix de la première date. Elle est installée ; les tables métier contrôlées sont inchangées. La fonction reste privée, accessible au serveur. Les périodes de référence historiques et celle incluant le jour du relevé sont contrôlées dans la vraie API. La prévisualisation locale a été reconstruite avec cette fonction.

Les observations de formulaires, quiz et historique Client sont séparées, minimisées et reprises de façon bornée. Les rendez-vous restent affichés selon leur classification source ; les reports historiques ne sont pas reconstitués.

## Acquisition et parcours

Les rapports PostHog réels sont préparés et vérifiés pour les périodes et filtres disponibles. Ils restent séparés des inscriptions, des ventes et des mesures de durée vidéo. Un rapport navigateur vide ne transforme jamais une donnée CRM en zéro.

L’historique Meta est publié et contre-vérifié. Les derniers lots de métadonnées créatives sont suspendus par une limitation temporaire de lecture Meta. Les lots déjà publiés sont conservés ; ne pas rejouer l’historique. L’attribution entre publicité, personne, rendez-vous et vente reste distincte. Aucun ROAS, CPL ou coût client n’est fabriqué en attendant ces liens.

## État des autres pages

- **Liens** : génération, paramètres de campagne, identifiant du lien, copie, versions et archivage implémentés. Les contrôles de logique sont synthétiques ; la chaîne réelle création du lien, arrivée, inscription et résultat commercial reste à prouver.
- **Commercial** : liste issue de Notion avec recherche, statuts et pagination. Un CRM lisible avec fiche et historique est demandé ; aucune refonte ni écriture dans Notion réalisée dans la préparation de passation.
- **Connexions** : le code distingue configuration, accès et dernière lecture. Vérifier ces états sur les usages quiz/masterclass ; la présence d’une clé ne prouve ni collecte complète ni mise à jour automatique. Refonte visuelle différée.
- **Parcours** : rapports PostHog vérifiés sur les cas conservés ; toutes les étapes de chaque page et leur attribution ne sont pas certifiées. Design différé.

## Configuration à reporter séparément

Les variables privées existantes restent nécessaires. Le nouveau L1 ajoute **`WIX_LEAD_ENTRY_CONFIG`** (familles, formulaires, exclusions explicites et champs) et **`NOTION_CLIENT_DATA_SOURCE_ID`, `NOTION_COMMERCE_CONFIG`**. Elles sont chargées dans la prévisualisation locale privée ; leur report sur Vercel reste à faire lors du déploiement par Mehdi. Une famille non configurée n’est pas un zéro ni une couverture exhaustive.

Les profils PostHog utilisent aussi **`POSTHOG_QUIZ_HOST`**, **`POSTHOG_PRODUCTION_HOSTS`** et **`POSTHOG_MASTERCLASS_PAGE_ID`**. Reporter les valeurs du profil client vérifié, sans supposer que l’ancien jeu de variables suffit. Les secrets et identifiants réels restent hors Git.

La clé serveur Wix permet les lectures financières existantes mais les lectures Contacts, Data Items et Forms du nouveau raccord sont refusées. La permission Forms documentée pour le polling est plus large qu’une simple lecture ; la modification des droits a été présentée séparément au propriétaire. Aucun droit ni clé n’a été modifié.

## Limites et suite

L’absence d’une source, d’une permission ou d’un rapprochement donne une indisponibilité expliquée, jamais un zéro implicite. Le dernier rapport complet reste disponible lorsqu’une lecture échoue.

Les périodes historiques et une période incluant le jour du relevé ont été lues dans la vraie API et l’interface ; les anciennes recettes figées ne sont pas des mesures du jour courant. Le dernier contrôle L1 est terminé après installation autorisée de 011. Les métadonnées restantes attendent le retour du quota Meta. Le raccord du montant confirmé des offres en trois fois reste à terminer pour le CA contracté ; le rapprochement financier et l’attribution demeurent ouverts. Les trois parties ne sont donc pas déclarées entièrement terminées. L’actualisation automatique, la rotation historique, le déploiement et la vérification de la version en ligne restent différés. La publication de cette version par Codex est maintenant autorisée par Mehdi le 9 septembre 2026.

Choix de travail pour la reprise : Terra pour pilotage et exécution courante, Luna pour vérification ciblée, Sol pour intégration ou conception complexe, Astra en recours. Cette répartition ne remplace pas les décisions de l’utilisateur ; la règle globale ne change pas automatiquement le modèle d’une conversation en cours.


## Préparations locales après les précisions du 9 septembre

Le besoin Commercial est précisé : journée, rendez-vous, présences, origine, fiche/historique et situation commerciale avec badges. Une proposition cliquable avec exemples fictifs est présentée dans la conversation avant refonte. L’application active n’a pas été remplacée. Le RPC actuel ne renseigne pas source/tunnel et expose le dernier RDV par personne sans chronologie ; sa pagination de50 ne permet pas les compteurs du jour. Ces raccords restent à réaliser.

Le générateur accepte désormais **`BLG_MASTERCLASS_URL`**, facultative et vide dans `.env.example`. Sans configuration, l’ancienne destination est conservée. La valeur est lue pour les nouvelles révisions ; les URLs persistées restent inchangées. URL HTTPS du domaine BLG sans identifiants ni paramètres imposés, indépendance du quiz, UTM et macros Meta couverts par les contrôles ciblés. Aucun réglage réel, lien distant ou page modifié. Au lancement de la nouvelle masterclass, le propriétaire doit aussi aligner la reconnaissance de l’adresse dans la page et le profil de mesure, conserver l’identité/version cohérente et distinguer ancien historique. La future adresse n’est pas encore choisie.

La préparation `contracted-revenue.ts` regroupe uniquement des preuves explicites d’une même vente : identifiant, date de conclusion, total confirmé et relations aux échéances. Elle ne déduit plus une vente d’une mensualité ou d’un bénéficiaire DUO et rend le total indisponible en cas d’élément incomplet/contradictoire. Ce module est préparatoire, non raccordé aux données réelles ni à la carte. Les derniers travaux de lecture ciblée et la limite finale restent consignés dans la passation privée. Aucun CA contracté supplémentaire publié, aucun import ou migration installé.

La lecture ciblée de reprise a retrouvé le chemin Échéancier → Paiements → Parcours et le champ Date de closing. Ce chemin doit être éprouvé avec le total vendu et les cardinalités ; il ne faut pas exiger par principe une nouvelle base de contrats ni rejeter une date de closing faute de document signé. La preuve privée distingue schémas réellement lus et interprétation du coordinateur.

## Publication du 9 septembre — état prioritaire

Mise à jour du dépôt et du projet Vercel existants autorisée ; contrôles prépublication en cours. Le périmètre livré comprend les résultats existants, le Commercial quotidien et ses fiches, les corrections du registre de liens et des flux Connexions. Supabase est conservée ; aucun nouveau schéma distant, cron, envoi ni modification des pages d’acquisition n’est inclus. Le CA contracté et l’attribution complète restent indisponibles tant que leurs raccordements ne sont pas établis.


Publication du9septembre2026 autorisée et terminée : GitHub PR1 fusionnée, production d4211e20172b3ce24ff88ecb53d47aa232daf8d1 sur https://cockpit-blg.vercel.app. Accès privé et lectures réelles vérifiés ; même Supabase, aucun cron ni migration distante. 246tests unitaires et37testsSQL, typage et build réussis. Suite en pause.


Correction Commercial du9septembre2026 : périodes au-delà dujour, registredeprospects même sansRDV, recherche/filtres/pagination cohérents et fiche/historique. Actualiser relie la lectureNotion existante à la demande. Tests256dont22Commercial, build et CIréussis, contrôle HTTPproduction et CUAChrome local effectué. PR2 fusionnée ; production 34b843977086b23d9aa01a622b610d2add49bf21 ; https://cockpit-blg.vercel.app. Pas d’importsource lancé en test, ni cron ou migration distante. Autres travaux enpause.

## 10 septembre 2026 — lecture des périodes accélérée

Fait : la lecture des Résultats lance ensemble toutes les lectures publiées d’une période et ne relit plus le relevé des ventes payées pour la période comparée ; fonction Vercel dans la région de la base. Preuve : mesures avant/après et tests dans le journal du 10 septembre ; PR5 fusionnée. Restant : lenteur propre des fonctions SQL (migration nécessaire, non autorisée) ; recette production des trois périodes à confirmer après déploiement. Prochaine action : contrôle en ligne des trois périodes avec comparaison, détails et liens, sans relance.

Recette production du 14 septembre 2026 terminée : trois périodes avec comparaison en 3 à 4 s sans relance, comptes 8 / 7 / 5 et détail août 7 / 1 / 3 / 17 inchangés. Restant : lenteur propre des fonctions SQL, à traiter par migration seulement sur décision de l’utilisateur.


## 15 septembre 2026 — suivi par publicité, préparation locale

Fait : contrat commun de paramètres (macros Meta dans les UTM, `blg_link_id` conservé), import Wix étendu à la première origine A et aux champs cachés du formulaire masterclass, projection serveur par publicité sans nouvelle table, tableau « Par publicité » dans Résultats. Preuves : tests `links*`, `lead-entries`, `ad-funnel`, build. Restant : migration 012 distante (accord Mehdi), champs cachés du formulaire Wix et code Velo/Cloudflare à installer (voir passation privée), lecture Wix des inscriptions à relancer, visites PostHog à vérifier sur les premiers parcours réels. Prochaine action : relecture Codex des diffs puis PR, sans déploiement automatique.


## 16 septembre 2026 — pourcentages, règle A datée, présence, visiteurs et actualisation (Claude Code)

Fait localement, non publié : la projection par publicité crédite chaque personne à sa plus ancienne origine mesurée (première origine A datée par le navigateur, sinon l'arrivée de la première inscription, l'heure décidant entre deux inscriptions du même jour et entre tunnels) ; la présence aux rendez-vous est lue dans la classification Notion du prospect (`prospects.business`), les rendez-vous à venir et sans issue restent à part ; les visiteurs uniques sont lus dans PostHog par origine A (quiz : `$pageview` de l'accueil, masterclass : `mc_page_view` sur l'adresse `/blank-1` seulement, versions antérieures signalées) ; les trois pourcentages validés (opt-in, réservation, présence) sont calculés avec numérateur, dénominateur et période, jamais un zéro sans mesure ; les filtres source, campagne, publicité, créative et lien s'appliquent au tableau 05. Le quiz envoie sa vue de page lui-même avec visiteur et première origine ; le composant masterclass attend la réponse du parent avant sa vue de page (version `mc-wix-surprise-2026-09-16.4`). Les inscriptions Wix, l'antériorité Client et les ventes payées deviennent des unités planifiables (`jobs/tick`) et se lisent depuis Connexions et Actualiser ; un échec de droits reste visible. Migration 012 rendue rejouable avec précontrôle et retour arrière sans perte (`output/tracking-deux-tunnels-2026-09-15/installation/sql`).

Preuves : 297 tests unitaires, 40 tests SQL locaux (dont migration 012), typecheck, build de production ; 30 tests de pages dans le paquet. Restant : installation distante (migration 012, champs Wix, codes Wix et Cloudflare, configuration d'import, relecture de l'historique, droits de la clé serveur Wix, accès Meta), puis recette réelle des deux parcours ; planification non activée (proposition dans le manifeste d'installation). Prochaine action : relecture Codex des diffs et du manifeste `installation/operations.json`, puis exécution des opérations qui lui reviennent.


## 16 septembre 2026 (suite) — adresse /masterclass26 et opt-in par cohorte (Claude Code)

Fait localement, non publié : destination masterclass par défaut `https://www.blg-studio.fr/masterclass26` (page publiée par Mehdi ; `/blank-1` redirige 301 et reste reconnue comme ancienne adresse pour les visites, jamais comme destination active) ; pourcentage d'opt-in recalculé sur un même groupe : visiteurs mesurés (identifiant de navigateur `blg_vid`) dont la première visite tombe dans la période, reliés côté serveur à leurs inscriptions confirmées (même identifiant, inscription au plus tôt le jour de la première visite, même tunnel ; total sans double compte), lus jusqu'à la date d'observation. Nouveaux leads, personnes déjà connues et identités non rapprochées distingués ; visiteurs sans identifiant et inscriptions sans visite raccordable comptés à part. Aucun identifiant ni parcours individuel ne sort de l'API.

Preuves : tests `ad-funnel` (11), typecheck, build, tests SQL et tests de pages relancés (voir journal). Restant : identique à l'entrée précédente ; tant que les pages mises à jour ne sont pas installées, aucune inscription ne porte d'identifiant de navigateur et le pourcentage d'opt-in reste affiché « indisponible » avec sa raison.
