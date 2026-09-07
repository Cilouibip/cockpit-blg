# Installation et exploitation

État au 7 septembre 2026 : application et cinq migrations testées localement ; cinq migrations distantes installées et vérifiées via MCP par le coordinateur, aucun déploiement applicatif ni snippet ajouté à une page réelle. Lire les décisions dans `../DECISIONS-ACTEES.md` avant toute reprise.

## 1. Base du cockpit

L’installation sur le projet Supabase choisi est **terminée**. Le coordinateur a appliqué les cinq fichiers SQL exactement dans leur état `a79f991`, puis vérifié le schéma. Ne pas les réappliquer.

Les fichiers `001_cockpit.sql` à `005_paginated_reads.sql` sont enregistrés comme versions 1–5 dans `cockpit_migrations`. Le coordinateur a vérifié le schéma et les lectures serveur ; les droits directs du navigateur restent retirés. Les preuves détaillées d’installation sont conservées dans le journal privé.

Aucun import métier réel ni donnée de démonstration distante. Le schéma est prêt pour les premiers imports contrôlés. Pour une future évolution, vérifier l’identité du projet, relire l’historique, produire une nouvelle migration additive et sauvegarder les données concernées ; ne pas utiliser de reset. La démonstration locale reste indépendante.

## 2. Accès privé et variables serveur

Le cockpit utilise un mot de passe partagé réservé aux deux utilisateurs, sans comptes nominatifs ni gestion de rôles. Le cookie signé dure huit heures. Changer le hash du mot de passe ou le secret de session invalide les sessions existantes. Le hash est au format scrypt utilisé dans `src/lib/auth.ts` ; aucune comparaison de mot de passe en clair n'est stockée.

Exécuter `npm run access:prepare` pour préparer un mot de passe dédié et son hash dans `.local/access-production.txt` et `.local/server-access.env` (permissions privées, hors Git). Le script refuse de remplacer des accès existants et ne les imprime pas. Il ne déploie rien. Une configuration de test peut être créée avec `npm run setup:local` ; pour le vrai hébergement, générer des secrets distincts dans un gestionnaire local et renseigner uniquement les variables nécessaires dans Vercel. Ne pas copier `.env.local` de démonstration vers l'hébergement.

Variables obligatoires :

| Variable | Usage |
|---|---|
| `COCKPIT_MODE=live` | Mode réel ; le mode demo est bloqué sur Vercel |
| `APP_ORIGIN` | Origine HTTPS exacte du cockpit, sans chemin |
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

Importer le dépôt dans Vercel, framework Next.js, Node.js22, installer les variables serveur du projet cible puis lancer le build. Utiliser l'URL HTTPS finale pour `APP_ORIGIN`. Les aperçus doivent recevoir leur origine propre et des variables distinctes ou rester non configurés. Le code ne crée aucun abonnement, domaine ni tâche planifiée.

Recette minimale : déconnexion→API privée401 ; connexion valide→résultats ; écriture depuis une autre origine refusée ; création de lien/rechargement/version/archivage conservés. Vérifier que la page Connexions décrit l'état réel et ne présente aucune donnée synthétique. Contrôler la limite persistante de connexion après migration.

## 4. Synchronisations préparées

Meta et Notion disposent d'un bouton de synchronisation authentifié dans Connexions. Les appels externes sont exclusivement en lecture. Meta relit par défaut les 35 jours précédents (jusqu'à hier inclus), avec un maximum de 93 jours par appel. Notion relit le périmètre courant autorisé, page par page, et conserve les modifications observées ; cela ne reconstitue pas l'histoire antérieure.

Les routes `GET /api/jobs/meta` et `GET /api/jobs/notion` sont prêtes pour un ordonnanceur avec `Authorization: Bearer <CRON_SECRET>`. Aucun ordonnanceur n'a été installé. Choisir sa fréquence après contrôle du premier import et des limites de l'hébergement. Un import partiel ne devient pas une partition Meta publiée ; une relance reprend la partition bornée depuis le début. Une relance de la même partition clôt en échec une ancienne tentative restée `running` depuis plus de dix minutes ; une tentative plus récente conserve son verrou et refuse une synchronisation concurrente. Examiner les erreurs persistantes avant nouvelle relance.

Wix fournit un adaptateur d'agrégats sous mapping relu, sans route automatique activée ni transactions inventées. La clé Wix serveur est reçue ; le coordinateur a lu les modèles Analytics et une transaction APPROVED avec succès. Le raccord métier aux paiements par personne reste à réaliser. PostHog fournit un contrôle de projet ; aucun export Query massif ni alimentation automatique du cockpit n'est activé. Le raccord first-party prévu suffit à recevoir les observations nécessaires sans abonnement supplémentaire.

## 5. Installation coordonnée du tracking

Transmettre `tracking/collector.js`, `tracking/quiz.js`, `tracking/masterclass.js`, `tracking/server-lead.mjs` et `docs/DATA-CONTRACT.md` aux responsables des pages. Les destinations fixes sont le quiz existant et la masterclass existante. Conserver les12 questions, les coordonnées avant résultat, et l'opt-in avant la vidéo sur la même page.

Le navigateur fournit des observations sans données personnelles ni réponses au quiz. Seul le backend appelle l'inscription signée après confirmation de la sauvegarde. Prévoir une file de reprise/outbox avec ID stable et corps identique ; signer l'horodatage courant à chaque tentative. Aucun email, secret HMAC ou succès commercial n'est accepté dans un événement navigateur.

Valider un parcours technique autorisé de bout en bout avant de présenter la collecte comme active. Ne pas utiliser un clic bilan comme rendez-vous réalisé.

## 6. Attribution et exploitation

`publishAttribution` dans `src/lib/attribution.ts` attend des données préparées par un opérateur serveur de confiance et des références exactes aux lignes persistées. L'appel direct accepte uniquement la cohorte globale. `publishScopedAttribution` prépare et publie les périmètres globaux, payants, campagne Meta, publicité ou créative depuis les publicités, coûts et synchronisations persistés du compte. Il vérifie chaque jour, rapproche les coûts du compte avec le global et inclut les publicités sans conversion. Les ancres globales sont choisies avant filtrage : une campagne antérieure ne récupère pas la vente acquise par un contact plus récent. Le calcul conserve des snapshots des publicités, coûts et runs. Une créative sans métadonnées complètes ou un tunnel sans mapping de dépenses reste indisponible ; aucune allocation proportionnelle. Le publisher vérifie aussi publicité, compte et campagne contre la ligne persistée. La politique, les preuves, les candidats, les coûts et les contributions sont figés dans une transaction. Une correction produit un nouveau run ; aucun historique publié n'est modifié. Il n'existe pas d'API publique de calcul acceptant des montants arbitraires.

Le cockpit choisit le cutoff de données le plus récent, puis la date de publication. Les comparaisons demandent une même définition et des fenêtres identiques. Il lit un calcul publié pour la même cohorte et le même périmètre seulement si sa couverture est validée. La route privée `GET /api/attribution?run=<uuid>` restitue les preuves. Aucun calcul réel n'est publié avant réconciliation des paiements, identités, acquisitions et dépenses.

Les vues principales calculent les totaux dans PostgreSQL sur toute la période demandée, sans transférer les événements, inscriptions ou transactions au serveur applicatif. Les intervalles vidéo sont réunis dans la base ; les séries sont agrégées par jour de Paris. Les détails et prospects sont lus séparément par pages de 50, avec total calculé avant pagination. Les comparaisons interrogent leur propre période. Les snapshots d’attribution sont ciblés par cohorte et périmètre, et la vue Connexions ne charge que les dernières synchronisations. Des tests dépassent 10 000 événements et 15 000 prospects.

Le registre de liens et la préparation opérateur d'attribution conservent une lecture bornée explicite ; ils refusent un jeu dépassant10 000 lignes au lieu de tronquer. Cette borne n'affecte plus les totaux du tableau de bord ni les listes commerciales. Aucune purge automatique ne supprime les preuves ou snapshots ; définir une politique de conservation avec le propriétaire avant accumulation importante. Les limites de requêtes expirées peuvent être nettoyées séparément.
