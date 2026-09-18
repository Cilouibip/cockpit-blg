# Parcours validé : rendu, erreurs et contrôles

Décision directe de Mehdi, 18 septembre 2026 : « Tu lances les agents comme ça. Je veux exactement ce rendu. » Maquette corrigée Atelier A validée, cinq étapes cliquables, un détail visible à la fois. Les chiffres de la maquette sont fictifs, jamais une source de production. Autorisation de réalisation locale et vérification ; aucun nouveau droit Vercel ni modification des sources externes.

## Les erreurs à ne pas reproduire

1. Imposer une version technique avant de montrer les données. Contrôle : aucune sélection de version obligatoire ; les étapes compatibles restent agrégées, le contenu vidéo est identifié séparément si nécessaire sans écran bloqué.
2. Masquer tout le parcours pour un problème limité à une mesure. Contrôle : disponibilité par mesure/source et état clair, pas de faux zéro ni blocage général automatique.
3. Mettre du jargon et des avertissements à chaque ligne. Contrôle : textes compréhensibles sans vocabulaire technique ; diagnostics hors de la vue principale.
4. Afficher des nombres sans population de référence. Contrôle : chaque flèche porte un pourcentage et son numérateur/dénominateur est accessible ; vidéo affiche explicitement pourcentage et nombre sur le total.
5. Omettre les conversions intermédiaires. Contrôle : formulaire ouvert→rempli→inscrit, inscrit→vidéo et clic→calendrier→réservation ont chacun leur taux lorsque le rapprochement est établi.
6. Confondre visites, personnes et événements répétés. Contrôle : dédupliquer les visiteurs connus, conserver les retours, ne pas sommer les lectures ou clics pour compter des personnes. Sans identifiant commun, aucune fusion probabiliste.
7. Déduire l'absence d'inscription Wix d'un signal navigateur manquant. Contrôle : les soumissions confirmées du formulaire actif sont la preuve d'inscription ; raccorder par visiteur ou session non ambiguë, dédupliquer les enregistrements.
8. Confondre clic de réservation, signal Meta et rendez-vous enregistré. Contrôle : les vrais rendez-vous viennent du miroir commercial déjà existant ; aucune addition des signaux Meta. Réservations différées/email rapprochées lorsque l'identité le permet.
9. Utiliser une position dans la vidéo comme temps regardé ou abandon certain. Contrôle : durée mesurée, pas dernier curseur ; aucun taux interpolé entre valeurs inventées, aucune double addition des relectures ou retours.
10. Afficher des données anciennes sans préciser leur fraîcheur utile. Contrôle : heure Paris correcte, horodatages par source dans le détail, actualisation fonctionnelle et erreur lisible ; chargement ne signifie pas réussite.
11. Redessiner au lieu de reprendre le kit. Contrôle : primitives Atelier A existantes, chiffres noirs, fonds blancs, sélection et halos du kit ; empreintes des fichiers source inchangées, styles du kit effectivement chargés dans le navigateur.
12. Ajouter des tableaux, cases et sections permanentes. Contrôle : cinq étapes visuelles, un panneau cliquable à la fois ; aucun tableau dans le parcours masterclass validé.
13. Déduire une autorisation d'une demande d'explication. Contrôle : périmètre écrit dans ce document ; toute extension métier, tracking ou publication reste une décision distincte de Mehdi.
14. Déclarer fini sur un test local ou une configuration. Contrôle : distinguer code prêt, recette synthétique, lecture des données existantes et publication en ligne. Chaque limite restante doit figurer dans la restitution.

## Rendu à reproduire

- Navigation existante ; filtres simples période, masterclass/quiz et toutes les publicités/par publicité avec vrais libellés disponibles.
- Masterclass : Visitent la page → Ouvrent le formulaire → S'inscrivent → Démarrent la vidéo → Réservent un rendez-vous. Icône et nombre pour chaque étape, taux sous chaque flèche. Ordre et rendu de la maquette corrigée conservés.
- Clic page : miniature schématique + barres sections et clics, noms lisibles des sections réelles. Une section apparue n'est pas une preuve de lecture du texte ; ne pas inventer une durée par section.
- Clic formulaire/inscription : trois nombres et deux flèches avec taux.
- Clic vidéo : nombre de démarrages, durée totale, pourcentage + effectif sur total selon durée regardée ; choix 30 s, 1 min, 3 min, 5 min, fin quand mesurables, contrôle clavier.
- Clic RDV : clic de réservation, ouverture calendrier, réservation réelle ; conversions correspondantes, sans confondre la réservation avec un simple clic.
- Mobile : parcours vertical, nombres/labels sans chevauchement. Un détail à la fois, pas de tableau.

## Règles de données et preuve attendue

- Conserver la première origine A et la mémoire 180 jours déjà actées. Le filtre publicitaire doit suivre la même attribution aux étapes ; ne pas mélanger UTM courante et origine retenue.
- Garder la même population dans chaque taux et identifier la relation réellement prouvée. Le KPI réservation/inscrits existant ne devient pas silencieusement réservation/spectateurs : le taux sous une flèche est local à ce passage.
- Les inscriptions sans suivi navigateur existent tout de même. Les compter dans les totaux métier appropriés et exposer les limites de raccordement sans fabriquer leur navigation.
- Dates Europe/Paris, filtres et exclusion des essais explicites identiques partout. Aucun filtrage des personnes par nom/email deviné.
- Identifiants pseudonymes et rapprochements restent côté serveur ; aucun email/nom ni export CRM dans les réponses publiques, journaux ou tests.
- Aucun nouveau tracking ni modification de source. Réutiliser les lecteurs et miroirs existants ; constat d'une source trop ancienne reste explicite.

## Répartition et validation

Un auteur par fichier. Agent données : contrat et lecture/projection dédiés. Agent interface : composant Parcours et style selon maquette. Coordinateur : API, filtres de la coque, intégration, preuve live en lecture seule. Relecteur indépendant : sources de risque puis résultat final, sans correction silencieuse.

Vérifier : filtres période/pub/tunnel ; retours d'un visiteur ; répétitions ; multi-versions compatibles ; inscription confirmée sans événement de confirmation ; identité absente ou conflictuelle ; réservation ultérieure ; essais exclus ; valeurs nulles et zéro réel ; horodatages ; aucune fuite de données ; responsive et rendu comparé à la maquette. Tests ciblés puis typecheck/build/suite existante nécessaires. Aucun test ni déploiement ne vaut validation humaine du parcours commercial.

## Vérification réalisée le 18 septembre 2026

367 tests réussis, typage et compilation complète réussis. Rendu vérifié sur cinq largeurs (320 à 1440 px), quatre détails, filtres publicité/période, retour Quiz, source partielle et échec de relecture. Huit fichiers du kit inchangés. Relecture indépendante sans défaut prioritaire restant.

Lecture réelle en lecture seule : visites, formulaires, inscriptions confirmées Wix et vidéo alimentent le rendu. La durée 436,82/436,84 s est affichée à la seconde (7 min 17) sans modifier la précision de calcul. Les rendez-vous restent issus de la copie du 18 septembre à 01 h 35 Paris ; les taux concernés ne sont pas calculés comme des zéros. Aucune publication ni modification de tracking ou de source effectuée.
