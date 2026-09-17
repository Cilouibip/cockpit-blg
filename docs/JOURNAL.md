# Journal technique

## 7 septembre 2026 — préparation du chantier

L'utilisateur valide les trois niveaux de KPI et autorise l'organisation d'une relecture indépendante, suivie d'une construction dédiée dans ce dépôt. La LTV est une évolution facultative.

Le coordinateur vérifie l'accès au dépôt vide et prépare la passation, les décisions produit et un modèle relationnel candidat. Aucun secret ou contenu client copié. Aucune migration distante ni mise en ligne effectuée.

Le premier push a été refusé par le contrôle automatique en raison du caractère public du dépôt. Le propriétaire a ensuite autorisé explicitement la publication du code et du cadrage préparé, sans secrets ni données clients. Le commit de cadrage a été publié sur main.

La création automatique de la tâche de revue en worktree a échoué ; le propriétaire a lancé lui-même la conversation de relecture. Le coordinateur suit cette tâche existante. Une tâche CTO locale a été lancée avec un worktree Git natif préparé dans un dossier distinct et une branche de construction propre.

Meta : jeton reçu hors Git, tests de lecture compte et Insights réussis. Le retour vide du test Insights ne vaut pas une dépense zéro.

Revue indépendante : huit ambiguïtés corrigées, quatre tables ajoutées pour inscriptions canoniques, agrégats de source et traçabilité de l’attribution. Contrat final à 19 tables adopté comme choix technique. La contre-lecture conclut « prêt pour écrire la migration locale » ; aucun test SQL ni installation distante déduit de cette revue. Le CTO a reçu le contrat et continue sur codex/build.

## 7 septembre 2026 — application construite et recette locale

Deux sous-agents ont traité l'interface et les contrats/connecteurs pendant que le responsable intégrait serveur, authentification, persistance et migrations dans le worktree `codex/build`. Le kit Atelier A a été repris sans modifier le kit source. Les données et accès réels sont restés hors Git.

Le contrat indépendant à19 tables a été traduit en trois migrations, complété de deux tables techniques. La première tentative sur PostgreSQL14 a révélé l'incompatibilité des vues avec droits de l'appelant ; la validation a été reprise avec PostgreSQL17 local. L'installation complète, les droits client, les écritures concurrentes, les reprises de lots, les paiements/remboursements et l'immuabilité ont ensuite passé les tests SQL.

Les parcours HTTP et navigateur ont été exécutés contre l'application et la base locales synthétiques. La recette navigateur couvre27 contrôles, cinq vues sur ordinateur/mobile, persistance du registre, conflit de version, clavier et déconnexion. Les corrections ont porté sur focus/accessibilité, couverture Notion, affichage des dates, courbe et détails des mesures.

La relecture finale du publisher a identifié un scope filtré déclaré sans preuve et la sélection possible d'un cutoff ancien republié. La publication V1 a été restreinte à la cohorte globale, la référence publicitaire est vérifiée contre compte et campagne persistés, le cutoff récent est prioritaire et les comparaisons exigent des définitions identiques. Des tests de régression couvrent ces constats.

La validation automatique a refusé le contrôle Supabase avec clé secrète avant son exécution. Le coordinateur a repris ce point d'autorisation ; aucune tentative de contournement et aucune migration distante. Les lectures Meta/Notion/PostHog autorisées ont été bornées ; aucun contenu client ni secret n'est conservé dans le dépôt public.

L'application, les contrats de tracking, la procédure de déploiement et la checklist de réconciliation sont livrés pour revue. Le build et les tests sont reproductibles par les commandes documentées ; les rapports bruts et captures restent privés. Aucun déploiement Vercel ni modification des pages ou sources réelles.

## 7 septembre 2026 — complément de granularité et de capacité

PR1 ouverte en brouillon après le premier push. Le préparateur a été étendu aux campagnes, publicités et créatives prouvées : coûts complets du compte, jour par jour, publicités sans conversion, ancres globales avant filtre, snapshots de toutes les preuves.13 tests ciblés plus le test de publication couvrent ces cas et refusent les périmètres non justifiés.

Le plafond de lecture des lignes brutes a été retiré des vues principales. Deux migrations supplémentaires ajoutent agrégats SQL par période et listes paginées séparément. Les tests vérifient10 051 événements et 15 005 prospects avec totaux exacts et filtres sur l'ensemble du périmètre. La pagination UI possède9 contrôles supplémentaires. Cinq migrations appliquées localement, aucune distante. Les captures finales confirment les valeurs synthétiques et la présentation après cette évolution.


## 7 septembre 2026 — correction UX de Résultats

Mehdi demande l’audit des cinq pages puis la reconstruction de Résultats seulement, avant une revue humaine. Le constat initial mesuré à 1366 × 768 place la première carte entre y645,6 et y831,8. Le texte et les avertissements occupent le premier écran.

Les familles Atelier A A.11.4, A.10.3, A.04.2 et A.08 sont portées dans un composant Résultats séparé. Huit cartes entre y209 et y541, filtres secondaires repliés, une seule indication Démo, volet de définition puis calcul/source repliables, courbe et piliers en accordéons. Les autres pages gardent leur composition. Une base locale neuve sert à la revue ; l’ancienne base synthétique est conservée pour les tests qui créent des données. Aucun filtre de masquage QA n’est ajouté au produit.

TypeScript, build, 78 tests unitaires, 27 parcours navigateur, 9 contrôles de pagination et 12 contrôles UX passent. Les captures restent privées. Les docs Wix distinguent le droit Analytics documenté, les cases réellement transmises par Mehdi (Wix Données analytiques et Wix Cashier) et les limites des clés. Le coordinateur confirme ensuite la réception privée de la clé et du site ID, ainsi que deux lectures HTTP 200 (modèles Analytics et une transaction APPROVED), sans import métier. Ces opérations sont distinctes du chantier UX. Livraison pour revue humaine, arrêt avant la page suivante.


## 7 septembre 2026 — installation Supabase prise en charge par le coordinateur

Après livraison du commit UX, le coordinateur confirme avoir appliqué et vérifié les cinq migrations inchangées de `a79f991` via MCP. Versions métier 1–5 et contrôles de fonctionnement réussis. Les preuves détaillées d’installation sont conservées dans le journal privé. Aucun import métier ou jeu de démonstration distant.

L’état, les connexions et la livraison retirent le blocage SQL/MCP et la demande d’installer ces migrations. Cette tâche n’a effectué aucune action distante. La revue locale de Résultats reste la prochaine étape UX.


## 7 septembre 2026 — alimentation réelle et filtres de dates

Après autorisation explicite, les six documents de cadrage ont été publiés. Le coordinateur a ensuite importé le miroir Notion complet et l’historique quotidien Meta. Le total Meta a été rapproché de l’export source à périmètre identique, sans importer une seconde fois les dépenses du fichier. Les lectures interrompues ont été reprises par sous-périodes.

Wix fournit la synthèse des paiements et les montants quotidiens. Sa définition source reste explicite même si certains détails sont absents. PostHog est raccordé par requêtes agrégées avec hôtes de production, distincts sur la période et question technique ; aucun export de réponses ou profil client. Les agrégats sont persistés dans les tables existantes. La migration additive 006 ajoute uniquement PostHog à la liste des sources du journal ; relecture indépendante, tests SQL et application via MCP réussis, droits serveur conservés.

Le cockpit réel est séparé des deux environnements de démonstration/QA. Le même accès privé est conservé. Les dates rapides et les trimestres sont testés ; les métriques commerciales non raccordées restent indisponibles. Aucun déploiement ni modification des pages sources.


## 7 septembre 2026 — filtre annuel, vitesse et audit indépendant

Après le signalement utilisateur, correction de la lecture Wix depuis les journées déjà importées, sans doublonner les rapports qui se chevauchent. Les totaux quotidiens doivent réconcilier le rapport source avant utilisation. Les jours non couverts restent absents. Le GET dashboard ne lance plus d'import Wix/PostHog ; current/comparison sont lus en parallèle. PostHog conserve les comptes distincts exacts de période et les agrégats par événement ; aucune somme de distincts. Le bouton Actualiser déclenche explicitement une lecture des sources. La comparaison des dépenses est rétablie.

Le lecteur Wix demande une page plus grande, accepte les totaux présents seulement en première page et conserve les contrôles de doublons, bornes et réconciliation. Le rapport annuel réel a été relu complètement. Les tests ajoutés couvrent le chevauchement, une période non couverte, les remboursements négatifs, la pagination et l'absence d'appels source lors des filtres.

Une nouvelle tâche indépendante vérifie données et liens. Elle a identifié l'import Notion limité à six champs, des champs commerciaux disponibles non importés et des raccords de liens non installés. Ces points restent ouverts ; connexion technique et exhaustivité métier sont désormais explicitement séparées dans l'état. Les preuves et chiffres réels sont conservés uniquement dans le dossier privé.


## 8 septembre 2026 — premier déploiement Vercel

L’origine du cockpit est détectée depuis les variables système Vercel lorsque APP_ORIGIN est absente. Cela permet de préparer les variables avant de connaître l’adresse du premier déploiement. La production utilise son domaine stable, les aperçus leur URL propre ; l’origine explicite reste prioritaire. Sans adresse disponible sur Vercel, la configuration échoue au lieu de prendre localhost. Les contrôles d’origine et le cookie sécurisé sont conservés. Les fichiers d’accès réels restent privés et hors du dépôt. Aucun déploiement effectué par cette tâche.
# 8 septembre 2026 — audit de fiabilité et correctifs locaux

Le défaut de passage au lendemain est reproduit sur le serveur réel, sans import. La lecture Wix conserve désormais le sous-total connu avec couverture partielle et signale les jours relevés avant leur fin. Les comparaisons partielles sont neutralisées. L'actualisation analytique expose les résultats des deux sources et leurs échecs ; le cache de quinze minutes qui empêchait une nouvelle tentative PostHog est supprimé. Le GET dashboard reste une lecture Supabase.

Tests ajoutés : jour suivant sans nouvel import, relevé intrajournalier provisoire, échec puis relance PostHog immédiate, résultats mixtes et échecs HTTP, pagination Wix au-delà de mille lignes. Typecheck, 131 tests unitaires et build réussis ; contrôle du rendu réel sur 3102. Les tests synthétiques ne constituent pas une validation de la couverture des KPI.

Compte Vercel inspecté en lecture seule : domaine sur ancien main sans application, framework Other, variables présentes, aucun Cron configuré. Configuration de correction fournie au propriétaire. Les rapprochements de sources, transactions et engagements, limites commerciales et plan de synchronisation sont archivés uniquement dans l'audit privé. Aucun push, déploiement, import métier ou migration distante.

## 8 septembre 2026 — reprise métier, lot central

Audit source métier suivi d’un raccord local Notion descriptif, transactions Wix et huit cartes. Identité commune avec le backend, dates métier conservées, créations seules et statuts inconnus distincts. Compte Meta raccordé avec couverture et ratios observés ; profils PostHog filtrés et observations masterclass séparés. Tick borné préparé, aucun cron activé.

Migration 007 appliquée seule après contre-revue : staging privé, reprise avec lease, publication collective atomique, archivage sans perte des acquisitions historiques et registre 1–7. Aucun ancien import rejoué. Les contrôles de droits et comptages avant/après passent. La charge synthétique a révélé puis permis de corriger l’accumulation de verrous, la requête d’omission et les timestamps de publications dans une même transaction.

Tests unitaires et SQL, typecheck et build local exécutés. Les imports réels, la recette API/écran et les rapprochements financiers historiques restent des opérations distinctes ; aucune valeur métier réelle ou identité n’est inscrite dans ce dépôt.


## 8 septembre 2026 — imports contrôlés et parcours Actualiser

Après revue de chaque runner et contrôle de cible, publication complète du miroir Notion, puis imports séparés du compte Meta, des reçus Wix, de la synthèse Wix et des rapports PostHog quiz/masterclass. Les contrôles indépendants rapprochent les membres et les journées aux sources ; les écarts de bornes entre année civile et année jusqu’au jour du relevé sont explicités. Les données financières historiques non rapprochées restent ouvertes.

La recette du vrai handler a révélé un endpoint reçus absent, des bornes Meta ignorées et un quota incompatible avec quatre partitions annuelles. Ces trois défauts sont corrigés et testés. Wix et les deux familles PostHog ont des requêtes séparées. Notion enchaîne les chunks bornés jusqu’à publication, avec progression et reprise après interruption. Tests : 159 unitaires, 32 SQL, typecheck et build réussis. Serveur de lecture local 3102 redémarré pour la contre-recette API/écran ; aucun push, déploiement, source modifiée ni cron activé. ETAT réécrit en état courant unique.


## 8 septembre 2026 — lecture bornée des observations publiées

008 ajoute deux index et une RPC de lecture STABLE/INVOKER, limitée au serveur. Les lots de métriques quotidiens restent homogènes ; les inconnus Meta restent inconnus, les reçus exigent deux mesures numériques, un rapport PostHog vide remplace les anciens groupes et Wix valide le rapport entier avant sa découpe quotidienne. Sélection par date de relevé puis début du run, sans faire gagner un ancien relevé terminé tard. Dernière tentative et dernière publication utile restent distinctes.

Application unique après revue indépendante et contrôle de cible ; registre métier 1–8, droits vérifiés et comptages inchangés. Les requêtes arbitraires de tables/agrégats historiques sont remplacées par une seule lecture cohérente par fenêtre. Cache borné à 128 entrées, nettoyage des expirées, échecs non mémorisés et mutualisation des lectures en cours.162 tests unitaires, 37 SQL et build ; contre-revues SQL/lecteurs/cache et comparaison cloud sans écart. Les intervalles multiannuels restent un coût supérieur explicite, sans relever le timeout.

Le clic réel du lot précédent a été contre-vérifié : publication Notion complète, une seule lecture Wix, reçus distincts, périodes Meta exactes et deux familles PostHog séparées. Aucun second clic, import, cron ou déploiement dans le lot008. Contre-recette finale sur le build `VooIRl5UAmBkQw5Y-Lnz0` : 82 contrôles API, 17 d’interface et 129 rapprochements passent. Contrôle du diff public sans secret connu ni preuve métier réelle ; les changements préexistants sont conservés. Le lot validé fait l’objet d’une sauvegarde locale sur `codex/build`, avec manifeste et patch complets dans le journal privé. Aucun push, merge, cron ni déploiement.

## 8 septembre 2026 — protocole L1/L2 et rapports PostHog ciblés

L2 simplifie les textes de Résultats et ses détails sans refondre les autres pages ni changer les calculs. Build de référence local `QxXbic7n8UDtYWbCs_KGY` conservé sur3102. L1 compare désormais fiches Contacts, vraies inscriptions et suivi Notion, avec répétitions et antériorité ; la création/import d’un contact n’est pas une acquisition. Les deux définitions proposées de Leads restent distinctes et non attribuées à l’utilisateur.

009 développée localement : observations métier isolées des événements navigateur, publication atomique, reprise, identité commune, source et mapping versionnés séparément, antériorité globale et périmètre configuré. Revue indépendante44cas et charge locale ;21tests SQL. Application distante refusée par auto-review avant écriture, puis absence de table/registre inchangé vérifiés. Aucun import L1, droit source ou clé modifié. L’autorisation précise reste une étape distincte.

Le raccord PH GETdescripteur/POSTrapport et l’invalidation ciblée du cache après publication passent les tests du vrai handler, y compris deux instances de lecture, comparaison et rapport vide. Les profils source/campagne restent distincts. Les valeurs vides mesurées concernent seulement le navigateur ; aucun zéro CRM fabriqué. Typecheck et199tests unitaires passent ; contre-revue centrale15cas. Aucun nouveau build sur3102 : l’interface déclencherait un import ciblé à autoriser séparément. L’état courant et les nouvelles clés de configuration privée sont documentés dans ETAT.

L3 proposé à partir des relations Client disponibles : séparer premiers clients accompagnés et premiers acheteurs, conserver les dates contradictoires et l’antériorité, ne pas substituer prix catalogue/échéances au CA contracté. Les preuves réelles et contre-comptages sont privés ; aucun code L3 ni paiement canonique ajouté.


## 8 septembre 2026 — préparation des métadonnées créatives Meta

010 intègre la RPC proposée et relue pour enrichir uniquement creative_id des annonces existantes. Contrôle du compte, de l’identifiant et de l’ancienne valeur ; petit lot atomique et rejeu exact sans nouvelle mutation. Quatre tests SQL locaux et typecheck passent, dont invariance des autres colonnes et installation sans la table métier009. Aucun apply ni import. Le hash final et les dépendances sont remis à la contre-revue avant toute opération distante.

### Rapport commercial descriptif L3 — local, collecte séparée

Le rapport Clients/Paiements/Parcours conserve les premières déclarations, le classement payeur, les bénéficiaires, la preuve de paiement et les contradictions comme mesures distinctes. L’antériorité est calculée sur toute la population disponible avant les dates de consultation. La carte Nouveaux clients ne change pas de définition automatiquement. Publication d’un rapport global via les agrégats existants ; lecture du dernier complet avant les journées, omission d’un ancien membre refusée et date corrigée retirée de l’ancien jour. Plafond de 999 jours renseignés explicite, sans troncature. Aucun nouveau schéma requis ; collecte initiale supervisée, reprise locale, pas de cadence automatique livrée.

Neuf tests métier/source, quatre tests sur PostgreSQL jetable avec migrations1–8, suite unitaire et vérification TypeScript passent. Le code et le runner sont remis à une revue indépendante. Une lecture source seule est autorisée séparément pour préparer les preuves minimisées ; aucune publication L3 n’est autorisée. La configuration serveur optionnelle `NOTION_COMMERCE_CONFIG` reste à reporter séparément dans les variables privées avant activation.

Le garde initial limité aux Parcours a été corrigé après deux contre-cas : disparition d’un Paiement ancien ou d’un Client. Les membres utiles des trois familles sont maintenant contrôlés avant toute publication ; quatorze tests ciblés passent. La lecture Notion autorisée est complète, sans publication ; le rapport a été reconstruit localement depuis son checkpoint après ce delta. Une ancienne conclusion d’absence de relation Binôme est invalidée : double encodage de l’identifiant de propriété dans le helper privé, corrigé sans modifier Notion. Arrêt demandé par Mehdi pour reprendre avec des modèles moins coûteux ; checkout et preuves conservés.

## 8 septembre 2026 — installation autorisée du stockage 009

Après autorisation explicite de Mehdi, revue indépendante et contrôle de cible, installation de la seule migration 009. Le refus d’approbation antérieur est résolu. Les empreintes de contenu des tables existantes sont identiques avant/après ; leurs colonnes, index, droits et règles RLS sont également inchangés. Les relations ajoutées n’entraînent aucune suppression en cascade. Le registre technique passe à 1–9 ; le nouveau stockage privé reste vide et ses cinq fonctions sont réservées au serveur. Aucun import, changement Wix/Notion, déploiement ou activation de cron. La migration 010 reste locale et non autorisée.


## 8 septembre 2026 — livraison locale des trois premières parties

Mehdi choisit les premiers contacts pour Leads uniques et les personnes au premier accompagnement, binômes inclus, pour Nouveaux clients. Le raccord commercial utilise désormais les Démarrages Client sur tout l’historique disponible avant filtrage, sans fusionner deux bénéficiaires par leur email partagé. Le rapport commercial est publié après revue ; tests ciblés métier/PostgreSQL et vérification de la version locale passent.

Le lecteur supervisé L1 réutilise le stockage009 avec des relevés source minimaux. La lecture réelle Wix Forms a révélé que les réponses sont dans `submissions`, alors que le normaliseur attendait `properties` ; extraction et empreinte de provenance corrigées ensemble. Les trois familles d’inscriptions et d’antériorité sont publiées sans rejet. Le dernier contrecontrôle d’un écart avec la référence préparatoire reste ouvert dans le suivi privé.

010 est installée et les métadonnées créatives sont partiellement publiées. Une limitation de lecture Meta suspend les derniers lots ; les mesures quotidiennes et les lots précédents restent conservés. Les rapports PostHog sur dates choisies ont passé la recette réelle source, stockage, seconde instance et comparaison. Les sélections annuelle et du jour sont vérifiées dans le navigateur.

La version privée locale est reconstruite sur3102 avec les raccords publiés. Le volet Leads présente une définition courte, ses deux sources et la date de mise à jour ; Transactions reste distinct des nouveaux clients. ETAT conserve les configurations à reporter séparément et les limites financières/attribution encore ouvertes. Automatisation, refonte des autres pages et déploiement attendent la reprise par Mehdi ; aucune écriture dans les sources, aucun commit ou push dans cette livraison.

### Dernier contrôle des leads : correction locale, installation en attente

Le contrecontrôle a identifié un double compte dû à l’ordre d’import. Un formulaire peut recevoir une identité différente avant que le lien réciproque Client–Prospect ne soit lu. La correction 011 rassemble ces preuves avant de choisir la première date et de filtrer la période. Elle exige une relation réciproque unique, le même périmètre configuré et l’absence de Prospect concurrent ; elle ne fusionne pas les données stockées. Les cas d’ordre inversé, antériorité, ambiguïté et séparation des périmètres sont couverts par les tests PostgreSQL. Deux anciennes fixtures Forms ont été alignées sur la réponse réelle, sans changer leurs assertions. Les 32 tests SQL ciblés et le contrôle TypeScript passent.

L’installation Supabase a été refusée avant exécution par le contrôle automatique : l’accord précédent concernait 009, pas cette nouvelle fonction. La fonction et la version 011 sont confirmées absentes après ce refus. Aucun contournement ni changement de données. L’accord précis a été demandé ; le build déjà servi conserve la lecture précédente. Le code préparé pour 011 ne doit être déployé qu’après son installation et le contrôle réel du résultat.

## 9 septembre 2026 — correction finale des leads installée

Après accord direct pour 011, installation du SQL exact précédemment relu et testé. Le contrôle avant/après confirme un contenu inchangé dans les dix-neuf tables métier suivies ; seul le registre technique reçoit la version11 et la fonction de lecture privée est ajoutée. Exécution interdite aux rôles navigateur, accordée au serveur. Le refus d’approbation précédent est résolu. Build local reconstruit ; la vraie API confirme la suppression du double compte et la stabilité des années précédentes et des autres KPI. Aucun réimport, aucune écriture Wix/Notion ni déploiement public.

Mehdi confirme la règle de prix pour les offres en trois fois. L’échéancier existant possède les montants et le total calculé ; le raccord au CA contracté doit constituer une seule vente datée et éviter de compter son montant à chaque mensualité. Ce raccord n’a pas été implémenté dans cette opération011. La différence entre prix vendu et encaissements ne résout pas l’écart intersource des paiements.

## 9 septembre 2026 — passation et état consolidés

Les définitions de leads et nouveaux clients encore présentées à tort comme en attente dans le document produit sont remplacées par les réponses directes de l’utilisateur. ETAT décrit désormais chaque page comme vérifiée, partielle ou encore à tester. Les contrôles synthétiques du générateur de liens ne sont pas présentés comme une preuve de trajet réel jusqu’à la vente. Une passation privée unique relie versions, preuves, décisions, autorisations et prochaine action ; les anciens états sont conservés comme historique.

La prochaine tâche doit terminer les données financières, tester les liens et connexions quiz/masterclass, et proposer un Commercial lisible avec historique. Le design Parcours et Connexions, la mise à jour continue et le déploiement restent différés. Aucun nouveau test de parcours, accès source, changement de données ni refonte effectué pendant cette préparation. La préférence globale de modèles économe est enregistrée séparément dans les instructions Codex ; aucun réglage global de modèle modifié.


## 9 septembre 2026 — Commercial quotidien et préparations de reprise

L’utilisateur précise Commercial : ouvrir sur la journée, les RDV, présences, origines et situations commerciales, puis une fiche/historique au clic avec badges et couleurs cohérentes. Une maquette de conversation fictive est préparée ; aucune refonte de l’écran actif ni saisie source effectuée. Le contrôle des données exposées montre que les origines et la chronologie ne sont pas encore raccordées et que les compteurs journaliers ne peuvent pas être calculés depuis une page de prospects.

Le générateur lit maintenant une destination Masterclass configurable au moment de créer une révision. Valeur facultative, ancienne adresse par défaut, révisions persistées inchangées et quiz indépendant d’une mauvaise configuration Masterclass. Préservation UTM/identifiant du lien/macros Meta, validation de l’URL et lecture historique contrôlées ; typecheck et tests ciblés passent. `.env.example` ne contient aucune valeur réelle. Aucun changement d’adresse active ni du tracking de page.

La première préparation de calcul financier a été rejetée en revue pour confusion échéance/vente, bénéficiaires/ventes DUO et données manquantes/zéro. Elle a été corrigée sur des preuves explicites d’identifiant, date et total vendu. Quatre tests ciblés couvrent les regroupements et l’indisponibilité ; typecheck passe. Le module reste isolé des indicateurs réels tant que le raccord aux sources n’est pas établi. Aucune somme compensatoire de l’écart Notion/Wix, connexion Stripe, migration distante, publication ou activation.

## 9 septembre 2026 — préparation de la mise à jour autorisée

Commercial quotidien raccordé aux données publiées avec composants du kit, présence distincte du closing, filtre origine et historique enregistré. Liens : accusé de sauvegarde distinct de la relecture et identifiant de création stable contre doublons après coupure. Connexions : import filtré par flux et deux cartes PostHog distinctes. Les destinations Masterclass restent historiques tant que la nouvelle adresse n’est pas configurée ; la migration 012 est locale, non appliquée en ligne.

Mehdi autorise la mise à jour du dépôt existant et sa publication Vercel. Le framework distant est corrigé en Next.js et Node22 ; aucune planification ni écriture dans les sources n’est activée. Publication et validation en ligne en cours ; ne pas interpréter cette préparation comme un déploiement réussi.


Publication du9septembre2026 autorisée et terminée : GitHub PR1 fusionnée, production d4211e20172b3ce24ff88ecb53d47aa232daf8d1 sur https://cockpit-blg.vercel.app. Accès privé et lectures réelles vérifiés ; même Supabase, aucun cron ni migration distante. 246tests unitaires et37testsSQL, typage et build réussis. Suite en pause.


Correction Commercial du9septembre2026 : périodes au-delà dujour, registredeprospects même sansRDV, recherche/filtres/pagination cohérents et fiche/historique. Actualiser relie la lectureNotion existante à la demande. Tests256dont22Commercial, build et CIréussis, contrôle HTTPproduction et CUAChrome local effectué. PR2 fusionnée ; production 34b843977086b23d9aa01a622b610d2add49bf21 ; https://cockpit-blg.vercel.app. Pas d’importsource lancé en test, ni cron ou migration distante. Autres travaux enpause.

## 10 septembre 2026 — lenteur au changement de période

Mesure de la chaîne `GET /api/dashboard` sur la prévisualisation privée et par script d’appel : 27 appels à la base enchaînés en douze étapes, 12 à 18 s par période depuis un poste local, mêmes ordres de grandeur sans comparaison. `pg_stat_statements` montre des fonctions SQL lentes (`cockpit_source_window` 404 ms en moyenne et jusqu’à 7,5 s, `cockpit_business_rollup` 991 ms, `cockpit_lead_entry_rollup_v2` 1,3 s) et le relevé des ventes payées de 2,5 Mo relu pour la période comparée. La fonction Vercel s’exécutait à Washington alors que la base est à Londres.

Correction, choix technique : les lectures indépendantes d’une période partent ensemble (`dashboard.ts`, `business-dashboard.ts`) et sont appliquées dans l’ordre historique ; les familles de lignes d’une publication sont lues ensemble et une seule fois par requête (`notion-commerce-storage.ts`, mémo limité à la requête) ; la fonction est placée dans la région de la base (`vercel.json`). Aucun délai augmenté, aucune erreur masquée, calcul des ventes payées inchangé. Typecheck, 284 tests unitaires et 37 tests SQL locaux réussis, dont deux nouveaux tests (lectures simultanées, mémo par requête). Après correction : 1,5 à 3 s par période au script, 1,4 à 4,7 s en HTTP local sur douze lectures, résultats 8 / 7 / 5 et détail août 7 / 1 / 3 / 17 avec 68 liens Notion inchangés. PR5 fusionnée, commit de fusion `e987cae66975372a73e9df1ccfdcb848ab01f8ed`.

Limite restante : la lenteur propre des fonctions SQL et l’absence d’index composite sur `source_aggregates (sync_run_id, metric_key)` ne se traitent que par migration, non autorisée dans ce cadre ; une lecture peut encore dépasser quelques secondes sous charge de la base.

Recette production du 14 septembre 2026, session ouverte par l’utilisateur : les trois périodes avec Comparer se lisent en 3 à 4 s sans erreur ni relance (8, 7, 5) ; détail août 7 / 1 / 3 / 17 avec 68 liens Notion. Aucune mensualité comptée comme nouvelle vente. Chantier clos ; le reste du projet demeure en pause.


## 15 septembre 2026 — préparation locale du suivi par publicité sur les deux tunnels (Claude Code)

Objectif : créer un lien dans le cockpit, le poser sur une publicité Meta et lire par publicité et par tunnel les visites, inscriptions, leads uniques, rendez-vous, nouvelles ventes et encaissements. Règle du pilote : la première origine mesurable A conserve le crédit, même après un retour par B avant l'inscription.

Fait localement, non publié :
- `src/lib/links.ts` : pour l'emplacement Meta, `utm_campaign`, `utm_content`, `utm_term` et `utm_id` portent les macros `{{campaign.id}}`, `{{ad.id}}`, `{{adset.id}}` ; `meta_*` conservés en doublon ; destination masterclass par défaut `/blank-1` (`BLG_MASTERCLASS_URL` la remplace). Tests liens et PostHog alignés.
- `src/connectors/wix-lead-entries.ts` (version `source-entry-v4`) : origine du quiz étendue (`adset`, `linkId`, `visitor`, `pagePath` avec paramètres de campagne lus dans l'URL d'arrivée) ; première origine A (`firstTouchFields`) ; champs cachés des formulaires (`formOriginFields` : visitor, first, current, session) ; JSON borné, aucune valeur personnelle.
- `src/lib/db.ts` : `lead_source_observations` lisible par le serveur ; filtres bornés `in`, `gte`, `lt` et `columns`.
- `src/lib/ad-funnel.ts` : projection par publicité (inscriptions, leads uniques, personnes connues, identités non rapprochées, rendez-vous du miroir Notion, premières ventes et encaissements du relevé Notion-commerce, dépenses et clics Meta). Aucune nouvelle table.
- `src/lib/ad-arrivals.ts` : visites par publicité lues dans PostHog (agrégats).
- Route `GET /api/ad-funnel` et accordéon « 05 · Par publicité » dans Résultats.

Contrôles : 293 tests unitaires, typecheck et build de production réussis. Tests SQL Postgres non relancés. Rien n'est déployé ; la migration 012 (destination `/blank-1`) reste à installer avant de créer un lien masterclass en production.


## 16 septembre 2026 — pourcentages validés, règle A datée, présence Notion, visiteurs uniques et actualisation sans agent (Claude Code)

Objectif : corriger les écarts relevés le 15 septembre (taux absents, filtres ignorés par la route, visites comptées en événements, attribution par jour puis identifiant, ancienne masterclass non exclue), inclure la base et préparer l'installation.

Fait localement, non publié :
- `src/lib/ad-funnel.ts` : origine d'une personne = plus ancienne origine datée parmi toutes ses inscriptions (première origine A horodatée par le navigateur, bornée entre le 1er juillet 2026 et l'inscription qui la porte ; sinon l'arrivée, datée par `occurred_at`) ; l'heure départage deux inscriptions du même jour ; présence lue dans `prospects.business` (classification Notion datée du créneau) sinon statut de la ligne ; rendez-vous à venir (`appointmentsUpcoming`) et sans issue (`appointmentsUnknown`) séparés ; `leadsBooked` (inscrits de la période ayant un créneau non annulé) ; taux `optin`, `booking`, `attendance` avec numérateur/dénominateur/raison ; filtres `source` et `campaign` (`meta:`, `meta-ad:`, `meta-creative:`, `link:`) ; registre des liens joint aux lignes ; totaux recalculés sur les lignes visibles.
- `src/lib/ad-arrivals.ts` : visiteurs uniques et pages vues par origine (même clé que les lignes), regroupés par visiteur (`blg_vid` sinon identifiant PostHog) puis rattachés à la première origine transmise par la page, sinon à la première arrivée ; masterclass limitée à `page_path` de `BLG_MASTERCLASS_URL` (défaut `/blank-1`) ; vues sans adresse comptées à part.
- Route `GET /api/ad-funnel` : transmet tunnel, source et campagne ; écran Résultats, accordéon 05 : colonnes Visiteurs, Inscrits, Opt-in, RDV réservés, Réservation, RDV réalisés, Présence ; tiret quand une mesure manque.
- `src/lib/sync-jobs.ts` : unités `forms`, `quiz_entries`, `client_history`, `commerce` planifiables quand leur configuration existe (`jobScope`), reprise de plusieurs unités partielles par tick ; `src/lib/connections.ts` et `Cockpit.tsx` : cartes « Wix · inscriptions » et « Notion · ventes payées » avec bouton de lecture, inscriptions ajoutées au bouton Actualiser.
- `supabase/migrations/012_masterclass_destination_constraint.sql` : rejouable, précontrôle des lignes existantes, retour arrière sans perte dans le paquet d'installation ; `tests/migration-012.integration.ts` ajouté à `test:db`.
- `scripts/replay-lead-entries.ts` : relecture des inscriptions par la clé serveur ou par pages exportées (import supervisé), cible Supabase vérifiée, mode simulation.

Contrôles : typecheck, 297 tests unitaires, build de production, 40 tests SQL Postgres 17 locaux ; paquet pages : 30 tests (dont vue de page masterclass après réponse visiteur, vue de page quiz avec origine). Rien n'est déployé ; aucune donnée source modifiée ; lecture seule Supabase (migrations 1–11 installées, 012 absente, 0 lien, 1537 rendez-vous en statut inconnu portés par la classification Notion) et PostHog (aucun événement avec visiteur ni première origine avant installation).


## 16 septembre 2026 (suite) — deux correctifs avant installation : /masterclass26 et opt-in par cohorte (Claude Code)

Revue Codex du retour précédent : la destination par défaut visait encore `/blank-1` alors que Mehdi a publié `/masterclass26` (redirection 301 vérifiée), et l'opt-in divisait les inscrits de la période par les visiteurs de la même période sans relier chaque visiteur à son inscription.

Fait localement, non publié :
- `src/lib/links.ts` : destination masterclass `/masterclass26` ; anciennes adresses listées à part (`legacyMasterclassDestinations`), jamais proposées.
- `src/lib/ad-arrivals.ts` : `MASTERCLASS_PAGE_PATH='/masterclass26'`, `masterclassPagePaths()` = adresse active puis `/blank-1` (reconnue) ; visiteurs du quiz sur toutes ses pages ; nouvelle lecture `readVisitorCohort` (une ligne par visiteur dont la première visite mesurée tombe dans la période, toute l'histoire lue pour dater cette première visite, identifiant raccordable `blg_vid` distingué de l'identifiant PostHog, limite 20 000 au-delà de laquelle le pourcentage devient indisponible).
- `src/lib/ad-funnel.ts` : `optin` par ligne (quiz, masterclass, total, visiteurs sans identifiant, inscriptions sans visiteur ou hors cohorte) ; jointure visiteur → inscriptions confirmées (`properties.origin.visitor`), inscription au plus tôt le jour de la première visite, une seule fois par visiteur ; total sur visiteurs uniques (première visite la plus ancienne) ; nouveaux leads / déjà connus / identité non rapprochée ; `rates.optin` = cohorte du tunnel filtré ou totale ; couverture `coverage.optin` (période d'entrée, date de lecture, visiteurs raccordables/non raccordables, inscriptions reliées, sans identifiant, hors cohorte).
- Route `GET /api/ad-funnel` lit la cohorte en parallèle des visites ; écran Résultats : opt-in avec numérateur/dénominateur, visiteurs sans identifiant en contexte, note de définition et de couverture avec date de lecture.
- Migration 012 (commentaires), `installation/sql` (postcontrôle et retour arrière incluant `/masterclass26`), tests `links-destinations`, `migration-012`, paquet pages (tests sur `/masterclass26`), manifeste OP06/OP07/OP09/OP11/OP12/OP16 et guide d'installation.

Contrôles : typecheck ; tests `ad-funnel` (11 : dix visiteurs → 20 %, visite du 31 et inscription du 1er, inscription antérieure, double soumission, visiteur déjà connu quiz → masterclass crédité à A malgré B, totaux sans double compte, lecture ultérieure plus complète, cohorte tronquée ou absente → indisponible) ; suites complètes relancées (voir retour du lot). Lecture seule PostHog : aucun `mc_page_view` avec `page_path` et aucun `$pageview` quiz avec `visiteur` depuis le 15/09 (pages non installées) : le pourcentage restera « indisponible » avec sa raison jusqu'à l'installation.


## 16 septembre 2026 — intégration des contrôles avant installation

Corrections locales : attribution déterministe et filtres du tableau publicitaire, cohorte et antériorité à l’instant, reports distincts, valeurs financières absentes conservées à null, libellé des personnes déjà connues. Cadences des lecteurs ramenées à une heure ; statut final complet/partiel corrigé pour les lots à plusieurs tâches et reprises. Lecteur Forms borné aux formIds configurés ; pagination CMS compatible avec le contrat count/offset/total et refus des preuves terminales incomplètes.

Validation finale : types + 313 tests + build réussis. Tests ciblés de régression avant/après pour les défauts de synchronisation et de périmètre Forms ; scénarios cohorte/finance/identité et pagination CMS. Aucun navigateur, déploiement, migration distante, envoi ou réservation. L’ordonnanceur et les connexions déployées restent à contrôler avant activation.

## 16 septembre 2026 — revue de publication et cadence horaire

Relecture du lot complet, de la liste des fichiers et des motifs sensibles : aucune valeur de secret, identité client ou donnée CRM destinée au dépôt public. La suite déjà validée (types, 313 tests, build) n’est pas relancée car aucun code applicatif n’a changé après cette preuve ; contrôle de diff et du workflow ajouté seulement.

Ajout d’un workflow GitHub Actions horaire qui appelle la route serveur `jobs/tick` avec `CRON_SECRET` chiffré. Revue finale : un seul appel de fonction, limité par son budget court, ne garantit pas le passage des onze unités dues. Le workflow reprend donc immédiatement les réponses `partial` dans le même passage, avec une borne de huit appels et quinze minutes, puis exige `complete`. Une erreur HTTP, une réponse illisible ou un drainage toujours partiel échoue explicitement. En l’absence du secret GitHub, l’appel est ignoré proprement et la cadence reste inactive. Aucun cron Vercel, nouvel abonnement ou service externe ajouté.

Le contrôle automatique a refusé avant exécution le transfert de la valeur privée `CRON_SECRET` vers les secrets du dépôt GitHub : il demande un accord explicite sur ce payload et cette destination. Aucune seconde tentative ni contournement ; le secret n’a pas été affiché. La liste des secrets GitHub a ensuite été lue sans valeur et confirme qu’aucun secret n’est configuré.

Après accord explicite, le secret est enregistré et la PR 6 est fusionnée. Le premier déclenchement manuel a été refusé par GitHub avant exécution (`422`, déclencheur non reconnu) : le scalaire YAML du message de configuration contenait un deux-points et empêchait l’enregistrement correct du workflow, visible par son nom réduit au chemin du fichier. Le message est converti en bloc YAML ; aucune route de synchronisation n’a été appelée pendant cet échec.

Après la PR corrective 7, le workflow est reconnu et son premier passage réel traite successivement Forms, quiz, antériorité Client, reçus, Wix, Meta, publicités Meta et plusieurs reprises Notion/Commerce. Les huit appels initiaux restent partiels après trois minutes, sans perte du dernier rapport complet. La fenêtre est élargie à vingt-quatre appels dans la même limite de quinze minutes afin de terminer le premier rattrapage et de garder une marge pour les reprises historiques ; chaque appel serveur conserve sa propre borne courte.

Le second passage termine Commerce (6 409 lignes lues) et l’antériorité Client (856 lignes publiées), puis révèle les états source réels : Forms et quiz Wix restent `running` avec `ACCESS_DENIED HTTP 403`, les deux lectures Meta sont `failed` en HTTP 400, PostHog quiz est partiel après un HTTP 503 ponctuel ; le dernier rapport Masterclass reste complet. Le workflow répétait les deux unités Wix en reprise sans pouvoir les faire avancer. Il affiche désormais les statuts de chaque unité et s’arrête dès qu’une unité est `failed`, au lieu de répéter un accès refusé ; le dernier rapport complet reste conservé.

Clarification du journal de workflow : les noms `forms` et `quiz_entries` dans le premier passage signifient que l’ordonnanceur a tenté ces unités. Ils ne prouvent pas un import réussi. L’état autoritatif après tentative est zéro ligne lue et écrite, avec refus HTTP 403 pour les deux. Les lecteurs Wix paiements et reçus utilisent des endpoints distincts et ont pu avancer ; leur résultat ne donne aucun droit Forms ou CMS.

État des raccords avant publication : configuration Wix des inscriptions et destination masterclass disponibles dans le fichier privé de déploiement ; profils PostHog explicites et profils Notion supplémentaires absents de ce fichier et donc non inventés. Forms répond, CMS quiz reste refusé par Wix (`WDE0027`) et Meta refuse la lecture complémentaire (code Meta 200). Les derniers rapports conservés restent la référence quand une lecture échoue.


## 17 septembre 2026 — filtres, dépenses et catalogue

Conservation des changements locaux puis intégration des deux bornes REST, de la vue des dépenses publiées, du catalogue Meta sans activité, du jour courant dans les imports et des événements question_affichee / clic_vers_bilan. Valeurs Meta absentes laissées indisponibles jusque dans les totaux. Aucun changement des sources Wix/Notion/Meta, ni seconde planification.

Rapprochement réel dépenses validé contre Meta sur une période historique ; répétitions brutes exclues. Catalogue importé et relu. Diagnostic du passage horaire réellement planifié : succès Wix/Meta puis échec Notion ; reprise Notion terminée manuellement. Les preuves privées et identifiants restent dans le centre de contrôle. La cadence reste à observer après publication.

## 17 septembre 2026 — parcours lisibles, vidéo et essais

Lot validé par Mehdi dans la tâche cockpit : intégrer les mesures déjà émises et rendre leurs limites lisibles, en conservant Commercial et les sources. Nouvelle route privée GET `/api/journey`, requêtes PostHog agrégées et bornées, versions séparées, étapes et paires séquentielles dans une même session. Origine et marqueurs d’essai sont consolidés par session avant lecture des étapes. Cache de courte durée séparé par projet, configuration et filtres ; aucune donnée individuelle renvoyée.

Écran Parcours : masterclass active, quiz, essais exclus par défaut, choix de version, taux avec numérateur/dénominateur, paliers vidéo, dernière position observée, durées de contenu et lecture au premier plan distinctes, sections affichées et questions. Courbe accompagnée d’un tableau accessible ; « non disponible » remplace les mesures manquantes. La réservation métier reste distincte de la mesure web et des événements Meta.

Tableau publicitaire : correction des rendez-vous datés par `scheduled_at`, conversion en jour de Paris et repli historique ; exclusion des marqueurs d’essai conservés dans les inscriptions et visites, option explicite pour les inclure. Aucune règle de première attribution modifiée, aucune refonte Commercial.

Validation : 340 tests unitaires ; route authentifiée et entrées invalides contrôlées ; TypeScript ; navigateur local avec données fictives sur ordinateur/mobile, filtres, versions, clavier et absence de débordement. Lectures réelles PostHog confirmées pour la version masterclass actuelle et le quiz, avec et sans essais. Absence de mesures détaillées de vidéo dans la lecture contrôlée ; affichage des questions et clic bilan encore absents du script public du quiz. Cela limite les mesures disponibles, sans prouver une panne du lecteur.

Diagnostic des emails en lecture seule : dernier workflow arrêté après ses 24 tentatives avec lectures encore partielles ; un autre passage présente une erreur Notion. Recommandation de distinguer reprise et vraie erreur ; aucun changement du workflow ni des notifications. Aucun accès au compte Vercel, modification Wix/Meta/Notion, nouveau test d’inscription, réservation ou email. Les preuves privées de publication sont conservées par le centre de contrôle BLG.
