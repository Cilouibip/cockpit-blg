# État du chantier

Mis à jour le 7 septembre 2026. Référence : `../DECISIONS-ACTEES.md`. Aucun chiffre synthétique n'est une mesure BLG.

## Réalisé et vérifié localement

- Application Next.js/React/TypeScript : Résultats, Parcours, Commercial, Liens et Connexions. Kit Atelier A repris, affichage ordinateur/mobile, filtres dates/source/tunnel/campagne et détails des mesures.
- Accès privé par mot de passe dédié partagé, cookie signé, contrôle d'origine, ingestion navigateur séparée de l'inscription serveur signée, limitation persistante des tentatives côté hébergement.
- Registre de liens PostgreSQL : création, copie, versions immuables, concurrence, archivage/restauration et persistance après rechargement. Destinations quiz et masterclass fixes ; macros Meta préservées.
- Trois migrations additives appliquées sur une base PostgreSQL17 locale : 19 tables métier, 2 techniques, RLS, droits client retirés, fonctions serveur, intégrité des inscriptions/identités/RDV/paiements et snapshots.
- Connecteurs Meta et Notion en lecture seule, synchronisation manuelle privée et routes planifiables préparées. Lots, pagination et checkpoint atomiques ; aucun ordonnanceur installé.
- Détail de chaque question du quiz et visionnage en intervalles uniques par version vidéo. Contrats/snippets destinés aux responsables des pages, sans installation réelle.
- Moteur d'attribution testé ; publication atomique globale avec preuves figées, contrôle pub/compte/campagne, sélection du cutoff récent. Lecture des ROAS/coûts seulement depuis les snapshots admissibles. Pas de publication financière réelle ni de préparateur de cohorte filtrée.
- CA encaissé net TTC distinct du CA contracté. Autorité transactionnelle ou agrégat source exact, sans addition. Comparaisons financières seulement avec deux périodes couvertes et définition compatible.
- Tests unitaires, PostgreSQL, HTTP et navigateur exécutés. Rapport navigateur :27 contrôles réussis, aucune erreur JS/API5xx. Détail des scénarios dans RECONCILIATION.md ; preuves brutes privées dans `.local/`.

## Connexions et limites réelles

| Source | Fait et preuve disponibles | Ce qui reste |
|---|---|---|
| Supabase | Configuration privée disponible ; migrations validées localement | Connexion SQL autorisée et installation distante. Le contrôle REST privilégié a été refusé par la validation automatique et n'a pas été exécuté. |
| Meta Ads | Lecture réelle du compte et Insights réussie par connecteur ; réponse vide conservée comme vide | Premier import persistant après installation de la base, contrôle de la couverture puis choix d'une fréquence. |
| Notion | Schéma commercial autorisé lu avec succès ; adaptateur testé avec fixtures | Premier import des seules propriétés autorisées. Historique antérieur non reconstitué, aucune écriture Notion. |
| Wix | Lecture MCP d'agrégats vérifiée par le coordinateur ; adaptateur serveur borné sous mapping | Clé serveur autonome, mapping des agrégats relu et paiements individuels réconciliés. Aucune route Wix automatique activée. |
| PostHog | Contrôle de projet réussi ; contrat first-party prêt | Pas d'export Query ni d'alimentation automatique du cockpit installée. |
| Pages quiz/masterclass | Collecteur, adaptateurs et confirmation backend signée préparés | Installation coordonnée par le propriétaire et vérification réelle de bout en bout. |

Les nouveaux clients globaux, le CPL attribué, le closing par cohorte, le CAC complet et la LTV ne sont pas fabriqués à partir de données manquantes. Une date Notion courante ne prouve pas un rendez-vous distinct et un clic bilan ne prouve pas une présence. Les étapes affichent des observations par tentative, sans entonnoir séquentiel inventé. Les créatives/appareils et les conversions Meta détaillées ne sont pas automatiquement rapprochés dans cette version. Instagram natif est reporté.

La lecture est plafonnée à10000 lignes par table et échoue explicitement au plafond. Prévoir une agrégation SQL filtrée avant ce volume. Les limites et états observés sont visibles dans l'application. Aucun diagnostic automatique ni achat d'abonnement.

## Livraison et suite

Code et documentation prêts pour une demande de revue en brouillon sur la branche `codex/build`. Le propriétaire déploie Vercel et coordonne les autres tâches. Aucune mise en ligne ni migration distante effectuée. Procédure : DEPLOIEMENT.md ; recette : RECONCILIATION.md ; revue du contrat : SCHEMA-REVU.md et REVUE-INDEPENDANTE.md.

Prochaine action : terminer la revue du code, fournir la connexion SQL du projet neuf, appliquer les migrations après vérification du projet, puis valider les premiers imports. L'accès SQL et la vérification REST sont distincts ; ne pas demander de nouvelles clés déjà fournies.
