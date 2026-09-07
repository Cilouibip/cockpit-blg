# Cockpit BLG

Application privée descriptive pour lire les résultats, les parcours quiz/masterclass, les liens de campagne et le suivi commercial. Next.js, React et TypeScript ; persistance Supabase, PostgreSQL pour la démonstration locale. Le kit Atelier A fournit l'identité visuelle.

Une prévisualisation privée fonctionne avec les données réelles de Supabase. Les historiques Meta et le miroir commercial Notion sont importés ; les encaissements Wix et les agrégats PostHog sont lus pour la période sélectionnée. La démonstration reste isolée. Aucun déploiement Vercel ni ajout de tracking aux pages n’a été effectué. État détaillé : [chantier](docs/ETAT.md).

## Démarrage local

Prérequis : Node.js 22 et PostgreSQL 15 ou plus (validation sur PostgreSQL 17). Une instance locale doit écouter sur le port 55440 avec une base vide nommée `cockpit_blg_demo` accessible à l'utilisateur local.

```sh
npm ci
npm run setup:local
npm run migrate:local
npm run seed:local
npm run dev
```

Ouvrir http://127.0.0.1:3100. Le mot de passe local généré est dans `.local/access.txt`, hors Git. `setup:local` conserve toute configuration existante. Les migrations locales sont versionnées et le jeu synthétique ne remplace pas une base déjà remplie. Le mode synthétique refuse Vercel et toute base distante.

## Validation

```sh
npm run check
npm run test:db
# Serveur QA isolé sur 3101, accès synthétique configuré :
npm run test:http
npm run test:browser
npm run test:pagination-ui
```

Les tests PostgreSQL créent puis suppriment uniquement leur base locale temporaire `cockpit_test_*`. `TEST_DATABASE_URL` permet de choisir l'instance locale. Les tests HTTP et navigateur qui créent des données utilisent le serveur QA local sur 3101 ; ils refusent le port 3100 réservé à la revue. Préparation détaillée dans [QA-NAVIGATEUR.md](docs/QA-NAVIGATEUR.md#rejouer-le-contrôle). Les tests navigateur nécessitent Chrome installé. Les captures, accès et rapports bruts restent dans `.local/`.

## Reprise et exploitation

Lire `AGENTS.md`, `DECISIONS-ACTEES.md`, puis :

- [Livraison lisible](docs/LIVRAISON.html)
- [État et limites effectives](docs/ETAT.md)
- [Installation et déploiement par le propriétaire](docs/DEPLOIEMENT.md)
- [Recette et réconciliation des sources](docs/RECONCILIATION.md)
- [Contrat de données et tracking](docs/DATA-CONTRACT.md)
- [Connecteurs en lecture seule](docs/CONNECTEURS.md)
- [Recette navigateur](docs/QA-NAVIGATEUR.md)
- [Schéma relu](docs/SCHEMA-REVU.md) et [mise en œuvre](docs/IMPLEMENTATION.md)

Aucun secret, export métier ni donnée personnelle ne doit entrer dans ce dépôt public. Le propriétaire effectue la mise en ligne et coordonne l'installation des snippets dans les pages.
