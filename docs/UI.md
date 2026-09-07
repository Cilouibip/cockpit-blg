# Interface du cockpit BLG

Référence produit : `DECISIONS-ACTEES.md`. Réalisation du 7 septembre 2026. Ce document décrit le code livré, pas une validation esthétique par le propriétaire ni une connexion des données réelles.

## Composition

`src/components/Cockpit.tsx` est le composant client unique intégré dans la page privée. Il reçoit `mode: 'demo' | 'live'` et `user: string`. Le layout fournit le conteneur `#atelier-a` ; le composant n’ajoute pas un second identifiant identique.

- Résultats : KPI globaux, comparaison, source et couverture, détail modal, montants quotidiens et relevés accessibles sous la courbe, détail des campagnes et liens.
- Parcours : contenu, acquisition, conversion ; étapes des tunnels quiz et masterclass ; volumes accompagnant les taux.
- Commercial : recherche, responsable, rendez-vous et présence, prochaine relance, résultat ; détail du prospect. Le miroir est présenté en lecture seule et n’est pas filtré par les dates du tableau de bord.
- Liens : création par emplacement/destination/campagne/nom ; copie et explication de l’endroit où coller ; versions visibles ; archivage/restauration. Une nouvelle version est une mutation contrôlée par `expectedVersion`, jamais un remplacement de l’ancienne URL.
- Connexions : état technique, couverture, dernière synchronisation et limites. Lecture manuelle seulement pour les connecteurs Meta et Notion lorsque le serveur renvoie `canSync: true`.

## Contrat de données

Les types partagés sont dans `src/lib/ui-contract.ts`. Les exemples et identités réelles restent hors de ce fichier.

| Route privée | Usage |
| --- | --- |
| `GET /api/dashboard` | Query `from`, `to`, `source`, `tunnel`, `campaign`, `compare`; réponse `DashboardResponse`. |
| `GET /api/prospects` | Réponse `ProspectsResponse` ; miroir commercial disponible. |
| `GET /api/connections` | Réponse `ConnectionsResponse`. |
| `GET /api/links` | Réponse `LinksResponse`, dont `persistent` et limites de stockage. |
| `POST /api/links` | `LinkInput`; réponse `LinksResponse`. |
| `PATCH /api/links` | `LinkMutation`: `revise` avec `input`, ou `archive`/`restore`. Toutes incluent `id` et `expectedVersion`; réponse `LinksResponse`. |
| `POST /api/sync/meta` ou `/api/sync/notion` | Lecture manuelle permise par le serveur. La liste des connexions est relue ensuite. |
| `POST /api/logout` | Ferme la session, puis navigation vers `/login`. |

Les dates `from` et `to` sont toutes deux incluses et interprétées en Europe/Paris. Le serveur convertit la borne finale en lendemain exclusif. Les valeurs de métrique ayant l’unité `percent` sont exprimées en points de pourcentage, par exemple `12.5` pour 12,5 %. Les dénominateurs absents et nuls restent distincts.

Une absence ne devient jamais zéro. Une base précédente nulle n’est pas convertie en variation infinie. Un trou dans les relevés interrompt la courbe : il n’est ni interpolé ni remplacé par zéro. La variation verte/rouge indique seulement le signe numérique.

Les erreurs du serveur doivent respecter `ApiError` et être expurgées. L’interface donne un message spécifique pour la session expirée et les conflits de version. La lecture en cours est annulée lors d’un changement de requête ; une actualisation sur la même vue conserve les données et la saisie avec un état explicite de lecture.

## Provenance visuelle

Le kit À ta Sauce A.18.1 fourni pour ce chantier est la référence de réutilisation : guide, direction visuelle, état courant et validations lus avant la construction. Son dépôt source est resté inchangé.

`public/kit/atelier.css` est une copie exacte de la feuille de base déjà fournie au prototype autorisé. SHA-256 : `060b91ecec67d98142b924df576b34bcfbb7d9d50a6eec1c648087d52d4bdc1a`.

Le portage React reprend les tokens et comportements utiles, avec des classes `blg-*` isolées. La feuille originale est importée dans la couche CSS `kit` pour que ses sélecteurs de démonstration ne prennent pas le pas sur les styles de l’application. Aucun script de démonstration du kit ni média privé n’est embarqué. La signature pervenche/cyan/rose accompagne les actions principales et les repères de navigation. Le filet de sélection reste pervenche/cyan. Les chiffres restent noirs sur blanc, les états n’utilisent pas de pastilles colorées et les champs groupés ne reçoivent pas de halo.

## Accessibilité et petit écran

Navigation nommée, lien d’évitement, champs étiquetés, repère clavier, bouton de déconnexion sur mobile, dialogues natifs avec Échap et retour du focus, annonces de copie/enregistrement et lecture en cours. Les tableaux conservent leur structure sémantique dans une zone à défilement horizontal. Les courbes possèdent une alternative tabulaire. Aucun secret de serveur n’est importé par le composant client.

Les grilles passent de quatre à deux cartes KPI, les panneaux se placent sur une colonne et la navigation devient horizontale sur petit écran. Les mouvements sont désactivés par le layout et la préférence système est respectée.

## Vérifications

`node --import tsx --test tests/ui-format.test.ts` : 5 tests réussis. Ils couvrent absence contre zéro, comparaison depuis une base nulle, calendrier invalide, date de Paris à minuit et changement d’heure, ainsi que l’encodage d’une campagne contenant des caractères de requête.

Le contrôle TypeScript global passe après intégration. Le parcours navigateur intégré passe 27 contrôles sur les cinq vues en ordinateur 1440 px et mobile 390 px, avec zéro erreur JavaScript ou serveur 5xx. Les interactions, corrections et limites sont détaillées dans `docs/QA-NAVIGATEUR.md`.
