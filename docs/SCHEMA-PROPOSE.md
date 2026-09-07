# Proposition de modèle Supabase — v1 à relire

Statut : proposition technique du coordinateur, 7 septembre 2026. KPI approuvés ; tables non encore approuvées techniquement ni créées. Lire `../DECISIONS-ACTEES.md`. Aucun montant ou identifiant client réel dans ce document.

## Organisation

Une base Postgres, un serveur applicatif, un collecteur d'événements et des synchronisations indépendantes. Pas de microservices, de moteur de recommandations ou d'entrepôt parallèle. Le navigateur ne reçoit jamais les clés secrètes. Les écrans consomment des requêtes/vues déterministes, pas une table de KPI modifiables à la main.

Proposition : tables dans `public` avec RLS et aucun droit anonyme ; accès aux données exclusivement par les routes serveur authentifiées. Les événements publics passent par une route d'ingestion limitée et validée, jamais par une clé Supabase de service dans le navigateur. Les exemples ci-dessous décrivent le grain et les relations ; le CTO produit ensuite une migration SQL complète.

## Tables métier et grains

| Groupe | Table | Une ligne représente | Clés et principales données |
|---|---|---|---|
| Liens | `tracked_links` | Un lien logique | UUID, titre, emplacement, créé/modifié/archivé |
| Liens | `link_revisions` | Une version immuable du lien | UUID, FK lien, version unique par lien, URL destination/générée, source/medium/campagne/contenu, tunnel, créé le |
| Identités | `people` | Une personne dédupliquée | UUID opaque, créé le ; aucune déduction par homonymie |
| Identités | `person_identities` | Une identité de source rattachée explicitement | FK personne, système, namespace/compte, ID externe ou HMAC d'email normalisé, méthode/preuve/date ; unicité système+namespace+ID |
| Parcours | `events` | Un événement observé | UUID, système+compte+ID externe unique, dates métier/réception, personne nullable, identifiants anonyme/session/parcours, FK révision lien nullable, ad/campaign IDs observés, page/vidéo/version, événement versionné, propriétés autorisées |
| Commercial | `prospects` | Un prospect Notion courant | UUID, source+ID page unique, personne nullable, nom commercial, statut source, assigné/closer, dates création/édition, URL Notion, prochain suivi, champs commerciaux allowlist |
| Commercial | `appointments` | Un rendez-vous distinct | UUID, personne/prospect nullable, ID source stable si disponible, réservé le, prévu le, réalisé le si prouvé, statut normalisé et statut source, responsable, lien de report vers autre RDV, dates observation |
| Commercial | `commercial_history` | Un changement observé de prospect ou RDV | UUID, FK prospect ou RDV (exactement une cible), champ/statut, avant/après allowlist, date métier nullable, observé le, source ; historique seulement à partir du premier import |
| Ventes | `deals` | Un engagement commercial distinct | UUID, source+ID externe unique, personne/prospect nullable, signé le, état, montant contracté/devise nullable, base HT/TTC explicite, origine du montant |
| Finance | `payments` | Un paiement OU remboursement identifié | UUID, source+compte+ID transaction unique, personne/deal nullable, type paiement/remboursement, FK paiement original pour remboursement si fourni, statut, date effective, montant positif en unités mineures, devise, HT/taxe nullable, commande/abonnement/échéance IDs si fournis |
| Publicités | `ads` | Une publicité externe identifiée | compte+ad ID unique, campaign/adset/creative IDs et noms, destination connue, période d'observation, métadonnées utiles ; créative inconnue reste inconnue |
| Publicités | `ad_daily` | Les compteurs de base d'une publicité et d'un jour du compte | FK ad, date, devise, fuseau, spend, impressions, outbound clicks, autres compteurs nommés ; unicité ad+jour, sans mélange des breakdowns |
| Publicités | `meta_conversions_daily` | Une action rapportée par Meta | FK ad, date, action, fenêtre/modèle de reporting, valeur/nombre, devise le cas échéant ; séparée des compteurs de dépenses |
| Exploitation | `sync_runs` | Une exécution d'import et sa couverture | UUID, système+compte, version connecteur, début/fin, état, intervalle [début, fin), curseur/checkpoint validé, volumes lus/écrits/rejetés, erreur expurgée, couverture partielle explicite |
| Exploitation | `source_mappings` | Une règle explicite de correspondance | système, namespace, champ/valeur source, valeur normalisée, version/dates ; ex. statuts Notion, événements existants, pub→tunnel ; provenance obligatoire |

15 tables candidates. Réduire ou compléter si la relecture justifie le changement ; leur nombre ne doit pas conduire à supprimer les grains distincts des paiements ou RDV. Pas de table clients fusionnée avec Prospects : `people` n'est qu'un pont technique d'identité.

## Relations et exigences

- Un lien a plusieurs révisions ; aucune mutation ni suppression d'une révision déjà diffusée. Sauvegarde parent+révision atomique avec contrôle de version. Anciennes URLs stables après archivage.
- Une personne a plusieurs événements, identités, prospects, RDV, ventes et paiements. Tous les raccords restent facultatifs tant que la correspondance n'est pas prouvée. Ne pas perdre un paiement ou prospect non rapproché.
- Les identités ambiguës sont mises en attente. Le HMAC nécessite un secret côté serveur ; un simple hash public d'email est insuffisant. Ne pas exposer l'email/HMAC dans les liens ou événements navigateur. Documenter toute fusion et retour arrière.
- Les `properties` et historiques reçoivent une liste blanche commerciale/technique, jamais une copie libre des réponses personnelles au quiz ou de la fiche Notion.
- Toutes les données importées gardent IDs de source, source_updated_at si fourni, observed_at, version connecteur/mapping et référence de sync. Un retry ne doit pas créer de doublon. Une pagination incomplète ne couvre pas tout l'intervalle demandé.
- Dates en timestamptz ; filtres métier en Europe/Paris et périodes [début inclus, fin exclue). Journées Meta dans le fuseau du compte : afficher le décalage au lieu d'inventer une redistribution horaire.
- Devises jamais additionnées ; montants en unités mineures avec règle d'exposant de devise. Valeurs financières d'un agrégat Wix ne peuvent pas devenir des transactions individuelles fictives.
- Notion peut ne fournir qu'un RDV courant par prospect. Capturer les changements observés sans fabriquer l'historique des RDV antérieurs. Statut Closé ne prouve ni présence ni paiement. Un RDV reporté n'est pas une seconde personne.
- Un montant contracté décrit l'engagement total ; les paiements partiels ne le multiplient pas. Paiement enregistré n'est pas un virement bancaire. Reçus/remboursements/pending/cancelled séparés.
- Pour les publicités dynamiques, le niveau créative/asset ne peut être affiché que si une granularité réelle le permet. Aucun partage arbitraire des dépenses par asset, parcours ou source Instagram/Facebook.

## Agrégats et attribution

Pas de matérialisation d'un ROAS arbitraire dans les tables. Produire un module de calcul testable et des vues/requêtes : CA encaissé, activité commerciale, acquisition et cohortes. La méthode et la fenêtre d'attribution sont des paramètres versionnés, visibles et communs au numérateur et au dénominateur. V1 candidate à challenger : first-touch et last non-direct touch observés, fenêtre configurable ; aucune fenêtre choisie silencieusement. Mode ROAS non disponible tant que source de vente, identité et attribution ne sont pas raccordées.

La traçabilité d'une attribution doit rendre retrouvables conversion, personne, événement retenu, publicité/lien, méthode, fenêtre et version du calcul. Le relecteur doit décider si une table de résultats d'attribution est nécessaire dès V1 ou si des requêtes déterministes et un identifiant de version suffisent. Ne pas dupliquer une conversion entre les sources PostHog et Notion.

CA activité = date du paiement. Performance acquisition = conversions d'un même groupe acquis, avec durée d'observation affichée ; ne pas comparer CA des anciens clients avec acquisition du mois pour prétendre à un ROAS. Les montants Meta rapportés restent une vue séparée.

Leads = personnes avec enregistrement réussi, global dédupliqué quiz/masterclass. RDV = objets RDV distincts, et personnes reçues distinctes si calcul de closing. Nouveau client : première acquisition avec preuve et date ; inconnue si l'historique est tronqué. Taux de présence proposé = réalisés/(réalisés+absences), sur RDV passés à statut connu ; annulations/reports/inconnus exposés séparément. CPL/CPA utilisent le même périmètre de dépenses et de conversions. CAC complet non disponible sans tous les coûts ; extension future `acquisition_costs` si saisie ou source validée.

LTV facultative : revenu net effectivement reçu par personne et par cohorte, à 30/90/180 jours par exemple, fenêtre et couverture explicites. C'est une valeur observée à ce jour, sans promesse de valeur future ni assimilation à une marge. Les remboursements sont rattachés même s'ils surviennent plus tard ; pas de double comptage des échéances ni des agrégats.

## Ingestion et APIs

- Meta : API officielle `ads_read`, pagination, incréments journaliers et reprise d'une fenêtre récente pour conversions révisées ; jeton encore absent. Read-only, pas CAPI ni modification de campagne.
- Notion : jeton de connexion existant, schéma Prospects accessible ; requêtes paginées et blocs commerciaux sélectionnés si utiles. Miroir read-only ; aucun webhook nécessaire pour démarrer.
- Wix : MCP interactif de lecture des agrégats vérifié. Une connexion serveur indépendante et une source transactionnelle sont nécessaires pour paiements par personne/attribution/LTV. Le connecteur peut afficher du CA agrégé vérifié sans prétendre qu'il est attribuable ; prévoir un stockage séparé des agrégats si le V1 doit fonctionner avant les transactions.
- PostHog : accès personnel de lecture et projet existants. Ne pas automatiser un export massif récurrent via l'API Query. Étudier une destination/export adapté ou collecter les nouveaux événements minimaux via l'ingestion du cockpit en parallèle de PostHog ; pas de double collecte de PII ni changement live sans coordination.
- Tracking : fournir un contrat et des snippets séparés pour quiz et masterclass. Envoyer event_id stable, schema_version, session/parcours opaque, link_revision_id et IDs publicitaires observés. Backend d'enregistrement de lead émet un succès après sauvegarde ; cliquer n'est pas réussir. La vidéo envoie des intervalles réellement lus. Route publique avec validation, déduplication et limites ; CORS ne constitue pas une authentification.

## Vérifications attendues avant migration

SQL exécuté sur PostgreSQL de test : PK/FK/UNIQUE/CHECK, migrations ordonnées, transactions, rollback avant commit, RLS/GRANT et accès serveur. Scénarios : même lead deux tunnels ; retry multi-sources ; même personne plusieurs RDV/reports ; Closé sans paiement ; paiement en trois échéances ; remboursement tardif ; début d'historique incomplet ; devises/fuseaux/DST ; Meta fenêtres différentes ; attribution inconnue ; sauts vidéo ; liens archivés ; pagination interrompue ; données vides vs zéro ; injection de propriétés non autorisées. L'application doit montrer les états vide/partiel/non connecté, sans données de démonstration déguisées.
