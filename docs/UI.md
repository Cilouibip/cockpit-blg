# Interface du cockpit BLG

Référence produit : `DECISIONS-ACTEES.md`. Réalisation du 7 septembre 2026. Ce document décrit le code livré, pas une validation esthétique par le propriétaire ni une connexion des données réelles.

## Composition

`src/components/Cockpit.tsx` porte la navigation et les quatre pages conservées. `src/components/ResultsPage.tsx` porte la nouvelle composition de Résultats, avec une feuille de styles dédiée. Il reçoit `mode: 'demo' | 'live'` et `user: string`. Le layout fournit le conteneur `#atelier-a` ; le composant n’ajoute pas un second identifiant identique.

- Résultats : huit KPI sans paragraphes, comparaison uniquement lorsqu’elle existe, détail dans un volet ; période compacte et filtres secondaires repliables avec compteur ; courbe interactive et montants quotidiens ; trois piliers repliables ; tableau paginé des campagnes et liens, présenté en liste sur mobile. Une seule indication Démo ouvre son explication. Les pages de détail ne rechargent pas les agrégats du tableau de bord.
- Parcours : contenu, acquisition, conversion ; étapes des tunnels quiz et masterclass ; volumes accompagnant les taux.
- Commercial : recherche et statut filtrés par le serveur, pagination, responsable affiché, rendez-vous et présence, prochaine relance, résultat ; détail du prospect. Le miroir est présenté en lecture seule et n’est pas filtré par les dates du tableau de bord.
- Liens : création par emplacement/destination/campagne/nom ; copie et explication de l’endroit où coller ; versions visibles ; archivage/restauration. Une nouvelle version est une mutation contrôlée par `expectedVersion`, jamais un remplacement de l’ancienne URL.
- Connexions : état technique, couverture, dernière synchronisation et limites. Lecture manuelle seulement pour les connecteurs Meta et Notion lorsque le serveur renvoie `canSync: true`.

## Contrat de données

Les types partagés sont dans `src/lib/ui-contract.ts`. Les exemples et identités réelles restent hors de ce fichier.

| Route privée | Usage |
| --- | --- |
| `GET /api/dashboard` | Query `from`, `to`, `source`, `tunnel`, `campaign`, `compare`; réponse `DashboardResponse`. |
| `GET /api/details` | Query `from`, `to`, `source`, `tunnel`, `campaign`, `page` ; réponse `DetailsResponse` avec pagination de 50 lignes. |
| `GET /api/prospects` | Query `search`, `stage`, `page` ; réponse `ProspectsResponse`, pagination de 50 lignes et liste globale des statuts. |
| `GET /api/connections` | Réponse `ConnectionsResponse`. |
| `GET /api/links` | Réponse `LinksResponse`, dont `persistent` et limites de stockage. |
| `POST /api/links` | `LinkInput`; réponse `LinksResponse`. |
| `PATCH /api/links` | `LinkMutation`: `revise` avec `input`, ou `archive`/`restore`. Toutes incluent `id` et `expectedVersion`; réponse `LinksResponse`. |
| `POST /api/sync/meta` ou `/api/sync/notion` | Lecture manuelle permise par le serveur. La liste des connexions est relue ensuite. |
| `POST /api/logout` | Ferme la session, puis navigation vers `/login`. |

Les dates `from` et `to` sont toutes deux incluses et interprétées en Europe/Paris. Le serveur convertit la borne finale en lendemain exclusif. Les valeurs de métrique ayant l’unité `percent` sont exprimées en points de pourcentage, par exemple `12.5` pour 12,5 %. Les dénominateurs absents et nuls restent distincts.

Une absence ne devient jamais zéro. Une base précédente nulle n’est pas convertie en variation infinie. Un trou dans les relevés interrompt la courbe : il n’est ni interpolé ni remplacé par zéro. La variation verte/rouge indique seulement le signe numérique.

Les numéros de page commencent à zéro. `pagination.total` et `detailsPagination.total` fournissent les totaux des listes, indépendamment des seules lignes visibles ; ils ne deviennent jamais des KPI. La première page de détail vient du tableau de bord, les pages suivantes de l’API privée dédiée. Changer les filtres du tableau de bord réinitialise le détail ; rechercher ou choisir un statut commercial puis valider réinitialise la liste commerciale à la page zéro. Les contrôles Précédent/Suivant affichent la plage courante et désactivent les pages inexistantes. Les anciennes fixtures sans métadonnées de pagination restent lisibles, avec filtrage local de leur liste complète.

Les erreurs du serveur doivent respecter `ApiError` et être expurgées. L’interface donne un message spécifique pour la session expirée et les conflits de version. La lecture en cours est annulée lors d’un changement de requête ; une actualisation sur la même vue conserve les données et la saisie avec un état explicite de lecture.

## Provenance visuelle

Le kit À ta Sauce A.18.1 fourni pour ce chantier est la référence de réutilisation : guide, direction visuelle, état courant et validations lus avant la construction. Son dépôt source est resté inchangé.

`public/kit/atelier.css` est une copie exacte de la feuille de base déjà fournie au prototype autorisé. SHA-256 : `060b91ecec67d98142b924df576b34bcfbb7d9d50a6eec1c648087d52d4bdc1a`.

La correction de Résultats réutilise les feuilles exactes `dashboards.css`, `tableaux.css`, `hierarchie.css`, `retours.css`, `formulaires.css`, `navigation.css` et `lumiere.css`. Leurs classes et compositions sont portées en React : cartes A.11.4, filtres/tableaux A.10.3, hiérarchie A.04.2, fenêtres A.08. Les empreintes sont conservées dans `public/kit/SOURCES.json`. Les adaptations de densité et de largeur sont limitées à `results.css` ; aucune feuille source du kit n’a été modifiée. La feuille originale est importée dans la couche CSS `kit` pour que ses sélecteurs de démonstration ne prennent pas le pas sur les styles de l’application. Aucun script de démonstration du kit ni média privé n’est embarqué. La signature pervenche/cyan/rose accompagne les actions principales et les repères de navigation. Le filet de sélection reste pervenche/cyan. Les chiffres restent noirs sur blanc, les états n’utilisent pas de pastilles colorées et les champs groupés ne reçoivent pas de halo.

## Accessibilité et petit écran

Navigation nommée, lien d’évitement, champs étiquetés, repère clavier, bouton de déconnexion sur mobile, dialogues natifs avec Échap et retour du focus, annonces de copie/enregistrement et lecture en cours. Les tableaux conservent leur structure sémantique dans une zone à défilement horizontal. Les courbes possèdent une alternative tabulaire. Aucun secret de serveur n’est importé par le composant client.

Les grilles passent de quatre à deux cartes KPI, les panneaux se placent sur une colonne et la navigation devient horizontale sur petit écran. Les mouvements sont désactivés par le layout et la préférence système est respectée.

## Vérifications

`node --import tsx --test tests/ui-format.test.ts` : 5 tests réussis. Ils couvrent absence contre zéro, comparaison depuis une base nulle, calendrier invalide, date de Paris à minuit et changement d’heure, ainsi que l’encodage d’une campagne contenant des caractères de requête.

Le contrôle TypeScript global passe après intégration. Le parcours navigateur initial passe 27 contrôles sur les cinq vues en ordinateur 1440 px et mobile 390 px, avec zéro erreur JavaScript ou serveur 5xx. Le complément de pagination passe 9 contrôles UI ciblés sur des réponses HTTP synthétiques, sans nouvelle exécution de la recette générale. Les interactions, corrections et limites sont détaillées dans `docs/QA-NAVIGATEUR.md`.


## Correction Résultats — revue humaine en attente

Audit des cinq pages : [AUDIT-UX.html](AUDIT-UX.html). Seule Résultats a été reconstruite. Parcours, Commercial, Liens et Connexions gardent leur composition précédente.

À 1366 × 768 et 1440 × 900, les huit cartes occupent y = 209 à 541 px, sans défilement initial. Le volet commence par une définition courte ; calcul, source, dernière mise à jour et limites se déplient séparément. Les montants encaissés et contractés, les remboursements, le coût publicitaire et le coût total restent distincts. L’absence ne devient pas zéro. La pagination continue d’utiliser les agrégats du serveur.

La base locale de revue contient les seuls exemples prévus (trois lignes de détail). La base ayant servi aux tests de création/révision de liens a été conservée séparément. Aucun filtrage d’étiquettes QA n’a été ajouté au produit ni aux calculs. La recette de peuplement utilise des libellés de campagne/lien ordinaires ; l’indication Démo identifie explicitement l’espace fictif.

Contrôles de cette correction : TypeScript, 78 tests unitaires, construction Next.js ; 27 contrôles de parcours sur le serveur QA séparé, 9 contrôles de pagination et 12 contrôles UX ciblés. Les captures restent privées dans `.local/ux/`. La réussite des contrôles ne constitue pas une validation UX par Mehdi.

`npm run test:browser` et `npm run test:pagination-ui` utilisent par défaut le serveur QA local sur le port 3101. Il doit pointer vers une base synthétique distincte de la revue sur 3100. Le parcours qui crée des liens refuse le port de revue 3100. `npm run test:results-ui` vérifie la revue sans mutation métier ; seules les connexions privées de session sont utilisées. Le serveur QA et ses accès sont préparés localement, hors Git.


## Périodes rapides de Résultats

Le menu propose Aujourd’hui, Hier, 7 derniers jours, 30 derniers jours, Ce mois-ci, Mois dernier, Cette année, Année dernière, Trimestre en cours, Trimestre précédent, T1/T2/T3/T4 avec l’année courante et Dates personnalisées. Les périodes en cours s’arrêtent aujourd’hui ; les périodes précédentes et les trimestres nommés couvrent toute la période civile. Les jours glissants incluent aujourd’hui.

Toutes les dates utilisent Europe/Paris, avec bornes inclusives. Les raccourcis remplissent les champs sans lire de nouvelles données ; le bouton Appliquer existant valide la sélection. Modifier manuellement l’une des dates bascule sur Dates personnalisées. Aucun calcul métier ni conversion backend n’est modifié.

Vérifications : cinq tests de dates (minuit Paris, heure d’été/hiver, janvier, année bissextile, fin de trimestre et année) et quatre contrôles navigateur ciblés. Ligne unique sur ordinateur, huit cartes encore visibles à l’ouverture, absence de débordement à 1366/1440/390/320 px. Commande ciblée : `node --import tsx tests/results-periods-ui.integration.ts`.
