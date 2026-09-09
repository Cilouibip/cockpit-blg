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
