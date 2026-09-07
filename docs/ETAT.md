# État du chantier

Mis à jour le 7 septembre 2026. Ceci décrit des réalisations, pas seulement des intentions.

- Dépôt GitHub créé par le propriétaire, vide au démarrage ; accès de lecture/écriture vérifié. Visibilité publique.
- KPI principaux, secondaires et tertiaires validés ; LTV facultative.
- Schéma Supabase : revue indépendante reçue, contrat corrigé à 19 tables dans SCHEMA-REVU.md ; contre-lecture documentaire finale et tests SQL à réaliser. Aucune table distante créée.
- Prototype local antérieur disponible comme référence de kit et comportements ; il n'est pas une application financière connectée.
- Supabase : clés applicatives disponibles dans le fichier env privé du coordinateur. Connexion PostgreSQL/installation SQL non disponible à ce stade.
- Notion : connexion de lecture valide et schéma Prospects accessible ; import commercial non installé.
- PostHog : clé de lecture et configuration de projet locales ; ingestion complète à construire.
- Wix : lecture MCP des agrégats de paiements vérifiée ; accès autonome du serveur et transactions par personne à raccorder.
- Meta : approbation, compte et jeton reçus ; lecture du compte et de l’API Insights vérifiée (HTTP 200). Synchronisation applicative récurrente à construire.
- Déploiement Vercel et installation des snippets dans les pages : à effectuer par le propriétaire ultérieurement.

Relecture indépendante en cours et tâche CTO de construction lancée. Le CTO avance sur les éléments indépendants ; la migration attend la revue puis une connexion SQL. Les secrets ne sont jamais copiés dans la passation publique.
