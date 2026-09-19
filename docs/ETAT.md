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
