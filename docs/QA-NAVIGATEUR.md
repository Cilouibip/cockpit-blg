# Vérification navigateur

Référence produit : `DECISIONS-ACTEES.md`. Vérification réalisée le 7 septembre 2026 sur l’application locale intégrée, avec PostgreSQL et données exclusivement synthétiques.

## Résultat

**27 contrôles réussis**, zéro erreur JavaScript et zéro réponse serveur 5xx sur les API de l’application. Le contrôle TypeScript global passe également.

Chrome en contexte isolé piloté par Playwright, langue française, fuseau Europe/Paris, réduction des mouvements. Deux cadres : ordinateur 1440 × 1000 px et mobile 390 × 844 px. Le navigateur utilise un contexte neuf, sans profil utilisateur ni conservation des cookies sur disque.

| Parcours | Vérification effectuée | Résultat |
| --- | --- | --- |
| Accès privé | Redirection vers le login, mot de passe dédié sans identifiant, accès à la démonstration | Réussi |
| Résultats | Affichage des sources et couvertures, absence distincte de zéro, un seul conteneur visuel | Réussi |
| Détail KPI | Source, couverture et mention synthétique ; Échap ; retour au bouton d’origine ; Tab ne rejoint pas les commandes de fond | Réussi |
| Filtres | Période inversée rejetée ; application de dates inclusives, source payée et tunnel quiz ; retour aux valeurs globales | Réussi |
| Navigation clavier | Passage de Résultats à Parcours avec Tab puis Entrée | Réussi |
| Parcours | Trois piliers présents ; sélection de la masterclass et de ses étapes | Réussi |
| Commercial | Lecture seule explicite ; détail prospect avec responsable ; recherche et état sans résultat | Réussi |
| Création de lien | Campagne vide rejetée ; création via API et stockage local effectif ; URL quiz correcte | Réussi |
| Copie | Copie intégrale dans le presse-papiers ; refus simulé du presse-papiers donnant une URL complète sélectionnable | Réussi |
| Versions | Nouvelle destination créant une URL différente ; ancienne URL toujours présente dans l’historique | Réussi |
| Persistance | Rechargement complet puis retour au registre ; version et URL conservées | Réussi |
| Concurrence | Modification parallèle via API ; sauvegarde périmée refusée avec 409 ; saisie conservée pendant actualisation ; sauvegarde réussie après relecture de la version actuelle | Réussi |
| Archivage | Archive puis restauration, sans changer l’URL courante | Réussi |
| Connexions | Limites et distinction entre accès technique et alimentation automatique visibles | Réussi |
| Ordinateur | Cinq vues sans débordement horizontal de la page | Réussi |
| Mobile | Cinq vues sans débordement horizontal de la page ; démonstration affichée dans chaque vue | Réussi |
| Déconnexion mobile | Retour au login ; lecture de l’API commerciale refusée avec 401 | Réussi |

Les tableaux larges défilent dans leur propre zone ; ils n’élargissent pas la page. Les captures intégrales et de fenêtre ont été inspectées. Les chiffres et messages affichés constituent la démonstration de l’interface, jamais une preuve de connexion réelle.

## Corrections issues du contrôle

- Le dialogue rend maintenant le focus au déclencheur d’origine après sa fermeture. L’élément d’origine est conservé entre les doubles effets de React en développement, et le dialogue natif est fermé explicitement au nettoyage.
- Les sélecteurs possèdent un nom accessible explicite correspondant à leur libellé visible. Les textes des options imbriquées ne perturbent plus leur identification.
- Sur mobile, les choix globaux ont des intitulés courts, les champs commerciaux sont empilés et les textes secondaires sont plus lisibles. La ponctuation du titre Connexions reste liée au dernier mot.
- Les sources normalisées connues sont affichées en français et le libellé technique de session est remplacé par « Accès privé ».

Le contrôle a aussi signalé au responsable des données une borne de requête Notion affichée comme couverture depuis 1970. Le payload a été corrigé : la couverture décrit désormais le miroir commercial, le périmètre lu et l’observation depuis le premier import. Les dates Meta sont affichées en français avec la borne de fin exclue explicitée.

La dernière revue visuelle porte aussi sur la huitième carte « CA contracté », son état distinct du CA encaissé, le libellé « Accès privé » et la courbe pervenche/cyan du kit. Ces corrections de présentation ont été relues par captures ; elles n’ont pas motivé une nouvelle exécution des mutations de liens.

## Preuves locales

Ces fichiers sont volontairement ignorés par Git et restent disponibles sur la machine de contrôle.

| Preuve | Emplacement relatif au dépôt |
| --- | --- |
| Résultat des 27 contrôles | `.local/qa/browser-result.json` |
| Résultats ordinateur et mobile | `.local/qa/desktop-results.png`, `.local/qa/mobile-results.png` |
| Huit cartes KPI | `.local/qa/desktop-results-metrics.png`, `.local/qa/mobile-results-metrics.png` |
| Couleurs et trous de la courbe | `.local/qa/desktop-results-chart.png`, `.local/qa/mobile-results-chart.png` |
| Parcours ordinateur et mobile | `.local/qa/desktop-journey.png`, `.local/qa/mobile-journey.png` |
| Commercial ordinateur et mobile | `.local/qa/desktop-sales.png`, `.local/qa/mobile-sales.png` |
| Liens ordinateur et mobile | `.local/qa/desktop-links.png`, `.local/qa/mobile-links.png` |
| Connexions ordinateur et mobile | `.local/qa/desktop-connections.png`, `.local/qa/mobile-connections.png` |
| Détails KPI et prospect | `.local/qa/desktop-kpi-detail.png`, `.local/qa/desktop-prospect-detail.png` |

Chaque capture de vue possède aussi une version cadrée à la fenêtre, suffixée `-viewport.png`, pour lire les détails à leur taille réelle.
Les cadrages isolés `-metrics.png` et `-chart.png` masquent uniquement la navigation fixe et l’indicateur de développement pendant la capture pour éviter leur superposition ; les captures de vues conservent l’interface complète.

## Rejouer le contrôle

Précondition : application de démonstration locale et base PostgreSQL de démonstration actives, Chrome installé, accès local généré. Le script refuse de poursuivre sans les accès privés et vérifie la mention de démonstration avant les mutations.

```text
node --import tsx scripts/browser-check.ts
node --import tsx scripts/browser-check.ts --capture-only
```

Le premier parcours crée un lien explicitement nommé « QA synthétique », ses versions et une modification concurrente dans la base locale. Il ne modifie aucune source externe. Les anciennes exécutions peuvent donc laisser plusieurs liens de test dans le registre. Le second mode relit seulement les écrans et actualise les captures.

La sortie détaillée et les captures sont conservées dans `.local/qa`, dossier ignoré par Git. Aucun mot de passe, cookie, état de session ou secret n’est écrit dans les résultats. Le rapport Git ne contient pas de données commerciales réelles.

## Portée

Ce contrôle couvre l’application locale, Chrome et deux tailles de fenêtre. Il ne vaut ni vérification d’un déploiement Vercel, ni test des intégrations externes en production, ni validation sur téléphone physique, Safari ou lecteur d’écran.
