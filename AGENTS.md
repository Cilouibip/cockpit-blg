# Règles du chantier Cockpit BLG

- Lire `DECISIONS-ACTEES.md` puis `docs/ETAT.md` à chaque reprise. Les décisions produit viennent de l'utilisateur ; les choix techniques et propositions doivent être étiquetés comme tels.
- Construire une application descriptive : aucune analyse automatique, score de performance ou recommandation commerciale.
- Le dépôt est public. Aucun token, fichier env réel, export CRM, donnée de santé, identité client, transaction réelle ni trace contenant ces éléments ne doit être commité. `.env.example` contient uniquement des valeurs vides ou fictives. Utiliser des données synthétiques pour les tests.
- Les intégrations Notion, Wix, Meta et PostHog sont en lecture seule. Ne pas modifier les pages, campagnes, automatisations, prospects ou paiements. Aucun accès Calendly dans ce chantier.
- Créer le code, les tests et les migrations locales est autorisé. Une migration distante du projet neuf exige une relecture terminée, l'identité du projet vérifiée et une connexion SQL autorisée disponible. Aucun reset/drop destructif. Préparer une migration reviewable avant application ; documenter son résultat réel.
- Le déploiement Vercel et les ajouts de tracking aux pages sont faits par le propriétaire avec les tâches qui gèrent ces pages. Préparer les fichiers et instructions ; ne pas déployer à sa place.
- Un seul responsable intègre la branche de construction. Les sous-agents ont des fichiers ou worktrees distincts ; jamais deux rédacteurs simultanés sur le même fichier. Un relecteur indépendant ne corrige pas silencieusement ce qu'il relit.
- Tout travail est journalisé dans `docs/JOURNAL.md` (données techniques non sensibles). Mettre `docs/ETAT.md` à jour avec fait, preuve, restant et prochaine action. La mémoire d'audit privée, si accessible, reste hors dépôt.
- Préserver la source originale ; ne jamais remplacer une mesure absente par zéro, un clic par un RDV, une échéance par un client, une position vidéo par du temps regardé ou le CA global par du ROAS attribué.
- Ne pas relire de secrets pour les afficher. Ne pas faire de `git add .` sans contrôle ; inspecter précisément la liste des fichiers et le diff avant tout push. Pas de force push.
