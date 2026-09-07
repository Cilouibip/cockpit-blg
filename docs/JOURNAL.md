# Journal technique

## 7 septembre 2026 — préparation du chantier

L'utilisateur valide les trois niveaux de KPI et autorise l'organisation d'une relecture indépendante, suivie d'une construction dédiée dans ce dépôt. La LTV est une évolution facultative.

Le coordinateur vérifie l'accès au dépôt vide et prépare la passation, les décisions produit et un modèle relationnel candidat. Aucun secret ou contenu client copié. Aucune migration distante ni mise en ligne effectuée.

Le premier push a été refusé par le contrôle automatique en raison du caractère public du dépôt. Le propriétaire a ensuite autorisé explicitement la publication du code et du cadrage préparé, sans secrets ni données clients. Le commit de cadrage a été publié sur main.

La création automatique de la tâche de revue en worktree a échoué ; le propriétaire a lancé lui-même la conversation de relecture. Le coordinateur suit cette tâche existante. Une tâche CTO locale a été lancée avec un worktree Git natif préparé dans un dossier distinct et une branche de construction propre.

Meta : jeton reçu hors Git, tests de lecture compte et Insights réussis. Le retour vide du test Insights ne vaut pas une dépense zéro.

Revue indépendante : huit ambiguïtés corrigées, quatre tables ajoutées pour inscriptions canoniques, agrégats de source et traçabilité de l’attribution. Contrat final à 19 tables adopté comme choix technique. La contre-lecture conclut « prêt pour écrire la migration locale » ; aucun test SQL ni installation distante déduit de cette revue. Le CTO a reçu le contrat et continue sur codex/build.

## 7 septembre 2026 — application construite et recette locale

Deux sous-agents ont traité l'interface et les contrats/connecteurs pendant que le responsable intégrait serveur, authentification, persistance et migrations dans le worktree `codex/build`. Le kit Atelier A a été repris sans modifier le kit source. Les données et accès réels sont restés hors Git.

Le contrat indépendant à19 tables a été traduit en trois migrations, complété de deux tables techniques. La première tentative sur PostgreSQL14 a révélé l'incompatibilité des vues avec droits de l'appelant ; la validation a été reprise avec PostgreSQL17 local. L'installation complète, les droits client, les écritures concurrentes, les reprises de lots, les paiements/remboursements et l'immuabilité ont ensuite passé les tests SQL.

Les parcours HTTP et navigateur ont été exécutés contre l'application et la base locales synthétiques. La recette navigateur couvre27 contrôles, cinq vues sur ordinateur/mobile, persistance du registre, conflit de version, clavier et déconnexion. Les corrections ont porté sur focus/accessibilité, couverture Notion, affichage des dates, courbe et détails des mesures.

La relecture finale du publisher a identifié un scope filtré déclaré sans preuve et la sélection possible d'un cutoff ancien republié. La publication V1 a été restreinte à la cohorte globale, la référence publicitaire est vérifiée contre compte et campagne persistés, le cutoff récent est prioritaire et les comparaisons exigent des définitions identiques. Des tests de régression couvrent ces constats.

La validation automatique a refusé le contrôle Supabase avec clé secrète avant son exécution. Le coordinateur a repris ce point d'autorisation ; aucune tentative de contournement et aucune migration distante. Les lectures Meta/Notion/PostHog autorisées ont été bornées ; aucun contenu client ni secret n'est conservé dans le dépôt public.

L'application, les contrats de tracking, la procédure de déploiement et la checklist de réconciliation sont livrés pour revue. Le build et les tests sont reproductibles par les commandes documentées ; les rapports bruts et captures restent privés. Aucun déploiement Vercel ni modification des pages ou sources réelles.
