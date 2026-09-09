# Installation et exploitation

État au 7 septembre 2026 : application et cinq migrations testées localement ; cinq migrations distantes installées et vérifiées via MCP par le coordinateur, aucun déploiement applicatif ni snippet ajouté à une page réelle. Lire les décisions dans `../DECISIONS-ACTEES.md` avant toute reprise.

## 1. Base du cockpit

L’installation sur le projet Supabase choisi est **terminée**. Le coordinateur a appliqué les cinq fichiers SQL exactement dans leur état `a79f991`, puis vérifié le schéma. Ne pas les réappliquer.

Les fichiers `001_cockpit.sql` à `005_paginated_reads.sql` sont enregistrés comme versions 1–5 dans `cockpit_migrations`. Le coordinateur a vérifié le schéma et les lectures serveur ; les droits directs du navigateur restent retirés. Les preuves détaillées d’installation sont conservées dans le journal privé.

Les imports métier réels sont chargés ; aucune donnée de démonstration distante. Pour une future évolution, vérifier l’identité du projet, relire l’historique, produire une nouvelle migration additive et sauvegarder les données concernées ; ne pas utiliser de reset. La démonstration locale reste indépendante.

## 2. Accès privé et variables serveur

Le cockpit utilise un mot de passe partagé réservé aux deux utilisateurs, sans comptes nominatifs ni gestion de rôles. Le cookie signé dure huit heures. Changer le hash du mot de passe ou le secret de session invalide les sessions existantes. Le hash est au format scrypt utilisé dans `src/lib/auth.ts` ; aucune comparaison de mot de passe en clair n'est stockée.

Exécuter `npm run access:prepare` pour préparer un mot de passe dédié et son hash dans `.local/access-production.txt` et `.local/server-access.env` (permissions privées, hors Git). Le script refuse de remplacer des accès existants et ne les imprime pas. Il ne déploie rien. Une configuration de test peut être créée avec `npm run setup:local` ; pour le vrai hébergement, générer des secrets distincts dans un gestionnaire local et renseigner uniquement les variables nécessaires dans Vercel. Ne pas copier `.env.local` de démonstration vers l'hébergement.

Variables obligatoires :

| Variable | Usage |
|---|---|
| `COCKPIT_MODE=live` | Mode réel ; le mode demo est bloqué sur Vercel |
| `APP_ORIGIN` | Facultative sur Vercel avec variables système activées ; ailleurs, origine HTTPS exacte du cockpit, sans chemin |
| `COCKPIT_PASSWORD_HASH` | Hash scrypt du mot de passe dédié |
| `COCKPIT_SESSION_SECRET` | Secret aléatoire de session, au moins 32 caractères |
| `SUPABASE_URL` et `SUPABASE_SECRET_KEY` | Accès serveur aux tables privées |
| `IDENTITY_HMAC_SECRET` | Clé stable de rapprochement pseudonymisé des coordonnées |
| `INGEST_HMAC_SECRET` | Secret partagé uniquement avec le backend qui sauvegarde les inscriptions |
| `INGEST_ALLOWED_ORIGINS` | Origines exactes autorisées pour les observations navigateur |
| `CRON_SECRET` | Secret pour les routes de synchronisation planifiables |

Les autres variables sont listées dans `.env.example`. `SUPABASE_PUBLISHABLE_KEY` n'est pas utilisée par l'application privée ; aucun SDK métier Supabase n'est installé dans le navigateur. `DATABASE_URL` sert uniquement à la migration ou aux tests locaux. Ne jamais préfixer un secret par `NEXT_PUBLIC_`.

Une clé d'identité est durable : sa rotation nécessite une nouvelle version et une réconciliation explicite ; ne pas la changer au fil des déploiements. Aucun secret réel n'est inclus dans les exemples.

## 3. Mise en ligne par le propriétaire

Importer le dépôt dans Vercel, framework Next.js, Node.js22, installer les variables serveur du projet cible puis lancer le build. Au premier déploiement Vercel, laisser `APP_ORIGIN` absente et activer l’accès aux variables système. Le domaine de production est lu dans `VERCEL_PROJECT_PRODUCTION_URL`, avec repli sur `VERCEL_URL`. En aperçu, seule l’URL propre du déploiement est utilisée. Une valeur explicite de `APP_ORIGIN` reste prioritaire pour imposer un domaine. Les aperçus doivent recevoir leur origine propre et des variables distinctes ou rester non configurés. Le code ne crée aucun abonnement, domaine ni tâche planifiée.

Recette minimale : déconnexion→API privée401 ; connexion valide→résultats ; écriture depuis une autre origine refusée ; création de lien/rechargement/version/archivage conservés. Vérifier que la page Connexions décrit l'état réel et ne présente aucune donnée synthétique. Contrôler la limite persistante de connexion après migration.

## 4. Synchronisations préparées

Meta et Notion disposent d'un bouton de synchronisation authentifié dans Connexions. Les appels externes sont exclusivement en lecture. Meta relit par défaut les 35 jours précédents (jusqu'à hier inclus), avec un maximum de 93 jours par appel. Notion relit le périmètre courant autorisé, page par page, et conserve les modifications observées ; cela ne reconstitue pas l'histoire antérieure.

Les routes `GET /api/jobs/meta` et `GET /api/jobs/notion` sont prêtes pour un ordonnanceur avec `Authorization: Bearer <CRON_SECRET>`. Aucun ordonnanceur n'a été installé. Choisir sa fréquence après contrôle du premier import et des limites de l'hébergement. Un import partiel ne devient pas une partition Meta publiée ; une relance reprend la partition bornée depuis le début. Une relance de la même partition clôt en échec une ancienne tentative restée `running` depuis plus de dix minutes ; une tentative plus récente conserve son verrou et refuse une synchronisation concurrente. Examiner les erreurs persistantes avant nouvelle relance.

Les filtres lisent les agrégats déjà stockés dans Supabase, sans appel à Wix ou PostHog. Un cache serveur de 30 secondes évite de relire les mêmes snapshots pendant la navigation ; les imports terminés l’invalident. Wix est recomposé depuis des rapports quotidiens réconciliés, avec une seule version par jour. PostHog conserve les distincts exacts de chaque période : une période non importée ne peut pas être obtenue en sommant ses journées. Le bouton Actualiser appelle `POST /api/sync/analytics` avec la période sélectionnée ; cette action explicite peut prendre plus de temps que les filtres. `GET /api/jobs/wix` relit le mois courant. Les sources restent en lecture seule, les écritures concernent Supabase. Aucun ordonnanceur de rafraîchissement régulier n’est encore activé.

Pour une prévisualisation locale réelle, utiliser un processus distinct avec `COCKPIT_MODE=live`, les variables serveur privées et l’origine correspondant au port choisi. L’aperçu réel préparé est sur `http://127.0.0.1:3102/` ; le port 3100 conserve la démonstration et 3101 reste réservé à la QA. Ne jamais lancer le jeu de données de test sur le projet réel.

## 5. Installation coordonnée du tracking

Transmettre `tracking/collector.js`, `tracking/quiz.js`, `tracking/masterclass.js`, `tracking/server-lead.mjs` et `docs/DATA-CONTRACT.md` aux responsables des pages. Les destinations fixes sont le quiz existant et la masterclass existante. Conserver les12 questions, les coordonnées avant résultat, et l'opt-in avant la vidéo sur la même page.

Le navigateur fournit des observations sans données personnelles ni réponses au quiz. Seul le backend appelle l'inscription signée après confirmation de la sauvegarde. Prévoir une file de reprise/outbox avec ID stable et corps identique ; signer l'horodatage courant à chaque tentative. Aucun email, secret HMAC ou succès commercial n'est accepté dans un événement navigateur.

Valider un parcours technique autorisé de bout en bout avant de présenter la collecte comme active. Ne pas utiliser un clic bilan comme rendez-vous réalisé.

## 6. Attribution et exploitation

`publishAttribution` dans `src/lib/attribution.ts` attend des données préparées par un opérateur serveur de confiance et des références exactes aux lignes persistées. L'appel direct accepte uniquement la cohorte globale. `publishScopedAttribution` prépare et publie les périmètres globaux, payants, campagne Meta, publicité ou créative depuis les publicités, coûts et synchronisations persistés du compte. Il vérifie chaque jour, rapproche les coûts du compte avec le global et inclut les publicités sans conversion. Les ancres globales sont choisies avant filtrage : une campagne antérieure ne récupère pas la vente acquise par un contact plus récent. Le calcul conserve des snapshots des publicités, coûts et runs. Une créative sans métadonnées complètes ou un tunnel sans mapping de dépenses reste indisponible ; aucune allocation proportionnelle. Le publisher vérifie aussi publicité, compte et campagne contre la ligne persistée. La politique, les preuves, les candidats, les coûts et les contributions sont figés dans une transaction. Une correction produit un nouveau run ; aucun historique publié n'est modifié. Il n'existe pas d'API publique de calcul acceptant des montants arbitraires.

Le cockpit choisit le cutoff de données le plus récent, puis la date de publication. Les comparaisons demandent une même définition et des fenêtres identiques. Il lit un calcul publié pour la même cohorte et le même périmètre seulement si sa couverture est validée. La route privée `GET /api/attribution?run=<uuid>` restitue les preuves. Aucun calcul réel n'est publié avant réconciliation des paiements, identités, acquisitions et dépenses.

Les vues principales calculent les totaux dans PostgreSQL sur toute la période demandée, sans transférer les événements, inscriptions ou transactions au serveur applicatif. Les intervalles vidéo sont réunis dans la base ; les séries sont agrégées par jour de Paris. Les détails et prospects sont lus séparément par pages de 50, avec total calculé avant pagination. Les comparaisons interrogent leur propre période. Les snapshots d’attribution sont ciblés par cohorte et périmètre, et la vue Connexions ne charge que les dernières synchronisations. Des tests dépassent 10 000 événements et 15 000 prospects.

Le registre de liens et la préparation opérateur d'attribution conservent une lecture bornée explicite ; ils refusent un jeu dépassant10 000 lignes au lieu de tronquer. Cette borne n'affecte plus les totaux du tableau de bord ni les listes commerciales. Aucune purge automatique ne supprime les preuves ou snapshots ; définir une politique de conservation avec le propriétaire avant accumulation importante. Les limites de requêtes expirées peuvent être nettoyées séparément.


Extension 006 installée et vérifiée : PostHog est ajouté au journal d’import existant. Registre métier 1–6 ; aucune table, politique ou permission supplémentaire. Les cinq migrations initiales ne sont pas réappliquées.

Le miroir Notion complet peut dépasser la durée d’une requête hébergée. Avant de planifier son exécution en production, utiliser un worker adapté ou des partitions reprises par curseur ; la route locale seule ne garantit pas ce fonctionnement sur Vercel.


### Fréquence proposée (choix technique, non activée)

Préparer des synchronisations séparées de la navigation : rafraîchissement fréquent des périodes récentes, reprise nocturne d'une fenêtre historique plus large, et contrôle périodique du reste de l'historique. Conserver le dernier import complet pendant un échec, publier atomiquement une version réconciliée, exposer sa date dans le détail. Les remboursements/rétrofacturations Wix et les événements tardifs PostHog justifient ces reprises ; ils ne justifient pas un appel source à chaque filtre. L'ordonnanceur doit être adapté à l'hébergement et aux limites d'exécution avant activation.
# Correction du déploiement observé le 8 septembre 2026

Le domaine de production pointe vers un déploiement Ready de l'ancien `main`, commit `07de82a`, sans application. L'application se trouve sur `codex/build`, à partir de `c743d67`. Framework observé : Other ; racine vide ; Node 24 ; variables présentes dans Production et Preview ; accès aux variables système activé. Aucun réglage modifié pendant l'audit.

À exécuter par le propriétaire dans Vercel :

1. Settings → Environments → Production → Branch Tracking : `codex/build`.
2. Settings → Build and Deployment : framework **Next.js**, Root Directory vide (racine du dépôt produit), Build Command `npm run build`, sortie et installation par défaut Next.js. Node **22.x** correspond au runtime local testé ; Node 24 n'a pas fait l'objet de cette recette.
3. Conserver les variables Production préparées et l'accès aux variables système. `APP_ORIGIN` peut rester absente : l'application utilise `VERCEL_PROJECT_PRODUCTION_URL` en production. Ne pas révéler ou recopier les valeurs dans un journal public.
4. Créer un nouveau déploiement depuis la référence `codex/build`. Redéployer l'ancien déploiement de main ne change pas son code source. Contrôler le commit affiché. Les correctifs d'audit locaux doivent être publiés séparément avant de pouvoir les inclure.
5. Après Ready : `/login` doit répondre 200 ; `/` doit demander l'accès privé si non connecté ; l'API dashboard doit refuser une session absente puis répondre 200 après connexion. Le domaine final doit appartenir au nouveau déploiement. Tester montant connu, date de fraîcheur et couverture sur une période fixe, puis sur aujourd'hui.

Références : [déploiements Git](https://vercel.com/docs/git), [NOT_FOUND](https://vercel.com/docs/errors/not_found), [variables système](https://vercel.com/docs/environment-variables/system-environment-variables).

La section Cron Jobs présente l'écran de démarrage, aucune tâche configurée. Les routes existantes ne constituent pas une planification. Sur Hobby, la fréquence Cron est au plus quotidienne et sa précision est horaire : [limites](https://vercel.com/docs/cron-jobs/usage-and-pricing). Ne pas configurer un job horaire incompatible ni activer l'import Notion complet dans la route actuelle à 60 secondes. Préparer d'abord un traitement borné avec reprise durable ; le plan et les critères de recette sont dans l'audit privé. Aucun abonnement supplémentaire n'est présumé autorisé.
