# Décisions produit confirmées

Source : validation directe de l'utilisateur le 7 septembre 2026, après discussion des KPI. Ce fichier contient le périmètre du cockpit ; la mémoire privée de l'audit ne doit pas être copiée dans ce dépôt public.

## KPI validés

- Trois niveaux : principaux pour les résultats globaux ; secondaires pour le parcours ; tertiaires pour une créative, une page, une étape ou un prospect.
- Trois piliers : contenu, acquisition, conversion. Le suivi commercial fait partie de la conversion.
- Principaux : CA encaissé, dépenses publicitaires, leads uniques, RDV réalisés, nouveaux clients, ROAS attribué, coût publicitaire par nouveau client. CA contracté distinct si une source fiable fournit le montant engagé et la date de signature.
- Secondaires : impressions, clics sortants, CTR, CPM, CPC ; visiteurs/arrivées, leads par source et tunnel, CPL ; étapes quiz et masterclass, progression vidéo ; RDV pris/réalisés/absents/annulés/reportés, show-up, ventes, closing, coûts par RDV.
- Tertiaires : campagne/ensemble/publicité/créative/lien, landing/source/appareil, étapes et questions du quiz, segments vidéo réellement vus, suivi des prospects/responsables/relances/résultats.
- CPL = coût par lead. CPA doit nommer l'action. Le coût publicitaire par nouveau client ne doit pas être présenté comme un CAC complet sans les autres coûts marketing et commerciaux.
- LTV souhaitée en évolution facultative. Prévoir les identités et paiements nécessaires ; ne pas bloquer la première version. Ne pas présenter une valeur prédictive inventée comme une LTV réalisée.

## Produit et exécution

- Filtres de dates, comparaison de périodes et filtres source/tunnel/campagne. Afficher les volumes qui accompagnent les taux, les sources, la fraîcheur et la couverture.
- Générateur de liens simple avec emplacement expliqué, copie, registre persistant, versions et archivage. Un lien de bio attribue à la bio, pas au post qui aurait précédé le clic.
- Pas de diagnostic automatique. L'utilisateur interprète les chiffres.
- Suivi commercial dans Notion, remontée descriptive dans l'application ; lecture seule côté Notion.
- Connexion des statistiques natives Instagram reportée. Liens organiques inclus dès le départ.
- Pas d'accès Calendly disponible. Ne pas demander ni rechercher d'anciens identifiants.
- Construction autonome autorisée dans ce dépôt, avec une relecture du schéma puis une tâche de construction dédiée. Réutiliser le kit visuel fourni ; le prototype précédent sert de référence de comportement, sans obligation de conserver son architecture.
- Déploiement et installation des snippets dans les pages coordonnés par le propriétaire. Aucun abonnement ou achat supplémentaire autorisé par cette validation.

## Choix encore techniques, à documenter

Le choix précis des tables, la bibliothèque serveur, le mode d'authentification simple, les règles d'attribution, la fenêtre d'observation et les bases HT/TTC ne sont pas des phrases de l'utilisateur. Le responsable technique doit proposer des valeurs explicites, isoler les paramètres et laisser indisponible un indicateur dont la définition ou la source manque. Les définitions de leads et nouveaux clients ont ensuite été tranchées par l'utilisateur, voir ci-dessous.
# Complément confirmé le 8 septembre 2026

L'utilisateur demande le **nombre de transactions parmi les huit KPI principaux**, distinct du nombre de nouveaux clients. Une même personne peut effectuer plusieurs transactions. Cette demande ne supprime pas Nouveaux clients et n'autorise pas implicitement une neuvième carte. L'organisation des huit et la définition précise du compteur sont à proposer. Le CA contracté doit être audité et raccordé à une source de montant engagé et de date de signature/closing, sans substitution par le CA encaissé.

## État de reprise technique du 8 septembre 2026

Le protocole de comparaison des sources et de correction est autorisé. L’interface Résultats simplifiée est servie localement ; les étapes de mise en production restent séparées. Voir `docs/ETAT.md` pour le build, les opérations réellement exécutées et les autorisations restantes.

État historique remplacé par les réponses directes de l'utilisateur des 8 et 9 septembre : **Leads uniques = personnes qui contactent BLG pour la première fois ; Nouveaux clients = personnes qui commencent leur premier accompagnement, binômes inclus.** Une demande répétée d'un ancien contact ne crée pas un nouveau lead. Le nombre d'acheteurs reste distinct du nombre de personnes accompagnées. Les nouveaux profils privés et variables sont documentés dans ETAT et `.env.example` ; leur préparation ne vaut pas installation ou autorisation d'import.

## Compléments directs des 8 et 9 septembre 2026

- Les réponses et livraisons sont courtes, en français simple, dans le chat. Aucun rapport HTML par défaut. Les preuves et diagnostics restent internes, sans jargon d'audit dans les volets KPI.
- Pour l'offre explicitement payée en trois fois décrite par l'utilisateur, le total vendu correspond à trois mensualités. Aucun tarif exact ni généralisation à toutes les offres déduit. Le raccord doit compter une vente une seule fois et la distinguer des encaissements.
- La correction finale des leads 011 a reçu un accord précis ; son installation et ses contrôles sont consignés dans ETAT/JOURNAL. Cet accord n'autorise pas une nouvelle modification de source ou le déploiement.
- Prochaine reprise demandée : vérifier Liens de bout en bout et les connexions quiz/masterclass ; proposer un Commercial lisible proche d'un CRM, avec historique réel. Les vues et possibilités d'écriture restent à arbitrer avec l'utilisateur. Le design Parcours et Connexions vient plus tard.
- Déléguer selon difficulté et coût aux modèles disponibles : Luna pour contrôles simples, Terra pour exécution, Sol pour intégration/conception complexe, Astra en recours ciblé. Ce choix opérationnel ne remplace pas la validation utilisateur des nouvelles règles métier, du périmètre ou d'actions externes non autorisées.
- Déploiement Vercel conservé par l'utilisateur ; activation des mises à jour continues encore différée. Aucun contrôle local ne vaut validation complète de la version en ligne.


## Commercial quotidien et nouvelle masterclass — précisions du 9 septembre 2026

- L’utilisateur demande un Commercial ouvert sur la journée : rendez-vous, présences, origine, clic vers fiche/historique et situation commerciale, avec badges et couleurs dans le ton existant. Ces besoins guident la proposition ; aucune saisie dans les sources n’est déduite.
- La nouvelle masterclass est retenue pour le futur lancement avec une adresse encore à choisir. L’ancienne page et son historique restent distincts. Aucun renommage, redirection, activation ou publication exécuté par cette préparation.
- L’utilisateur n’a pas accès Stripe ; continuer avec les sources disponibles, sans inventer les correspondances financières manquantes.
- Source : instructions directes de l’utilisateur du 9 septembre 2026, conservées dans le journal privé de reprise. Une maquette fictive et des préparations de code ne constituent pas des données réellement raccordées ni une validation finale de l’interface.


## Correction impérative du kit et reprise complète — 9 septembre 2026

L’utilisateur rejette le style/couleurs de la maquette Commercial, accepte son organisation dans l’idée et demande sa correction ainsi que la poursuite de tous les travaux. Appliquer les composants exacts du kit A.18.1, sans badges teintés ou accents inventés ; les sources du kit ne sont pas à modifier. Une palette approchante ne remplace pas la réutilisation des familles et de leurs états.

Poursuivre Commercial, Liens et le contrôle de chaque onglet : action, persistance, relecture et messages de réussite/erreur. L’organisation Commercial n’est plus en attente d’accord ; cette acceptation ne crée aucune permission de saisie dans les sources ni de déploiement/activation automatique.

## 9 septembre 2026 — publication autorisée

Mehdi autorise explicitement Codex à mettre à jour le dépôt GitHub et le projet Vercel existants pour cette version du cockpit. La connexion Supabase et l’accès privé sont conservés. Cette décision remplace le report antérieur du déploiement au propriétaire ; elle ne relance pas les autres chantiers différés.
