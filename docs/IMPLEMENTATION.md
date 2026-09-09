# Contrat de construction

Choix techniques du CTO, 7 septembre 2026. Lire `../DECISIONS-ACTEES.md`. La revue indépendante à 19 tables est intégrée au contrat ; elle n'est pas une validation utilisateur de définitions nouvelles.

Une application Next.js App Router / React / TypeScript, hébergeable sur Vercel. Les routes serveur portent l'accès privé et parlent à Supabase REST avec la clé secrète. Le navigateur ne contacte aucune API métier. PostgreSQL local sert aux tests et au mode synthétique explicitement local. Aucun stockage métier éphémère sur Vercel. Dépendances exactes dans package-lock.json.

Corrections B1–B8 de la revue :

- B1 : agrégats de source séparés ; pas de personne ni de paiement fictif. Le CA normalisé requiert une autorité transactionnelle réconciliée TTC ou un agrégat exact compatible ; jamais leur somme.
- B2 : attribution_runs/results avec paramètres, candidats, cibles et couverture figés. Aucun ROAS tant qu'une publication valide n'existe. Choix technique : dernier contact non direct, 30 jours, observation 90 jours depuis le contact ; aucune estimation inventée.
- B3 : lead_registrations canonique, succès exclusivement signé par le backend de sauvegarde. Navigateur sans identité commerciale, sans succès financier. IDs stables et refus des conflits de payload.
- B4 : IDs de visite/parcours distincts. Pas de couture entre tentatives. Les étapes observées ne deviennent pas une progression séquentielle prouvée. Vidéo en intervalles réellement lus, par version.
- B5 : identités versionnées, namespace source, HMAC ; RDV Notion courant conservé comme tel ; paiements distincts des engagements, refunds verrouillés. Un paiement ancien premier dans l'import ne prouve pas un nouveau client.
- B6 : dépenses et actions Meta dans des snapshots séparés par run et profil. La sélection du dernier lot publié précède celle des lignes ; un lot complet vide peut remplacer l'ancien sans prouver zéro activité.
- B7 : source_snapshot / event_interval / aggregate_period explicites. Checkpoint et page enregistrés dans une transaction. Un run partiel n'alimente pas les dépenses publiées. Notion courant reste consultable mais sa couverture n'est pas un historique.
- B8 : un mot de passe privé partagé, cookies signés HttpOnly, SameSite strict, contrôle d'origine sur mutations privées, limite persistante sur hébergement ; droits clients retirés des tables, vues et fonctions. Ingestion publique séparée de l'inscription serveur signée.

Le SQL utilise des noms courts cohérents : source/source_namespace/external_id, status, period_from/period_to. Ces noms gardent les grains de la revue. Deux tables purement techniques s'ajoutent aux 19 tables métier : versions de migration et limites de requêtes.

Le produit reste descriptif. Le suivi commercial est un miroir en lecture seule ; aucune commande ne modifie Notion. Les données financières non raccordées restent indisponibles. Une limite de lecture ferme empêche d'afficher un total tronqué. Les étapes d'exploitation et les limites effectives sont dans ETAT.md.

Documentation primaire vérifiée : [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers), [cookies](https://nextjs.org/docs/app/api-reference/functions/cookies), [clés API Supabase](https://supabase.com/docs/guides/getting-started/api-keys), [sécuriser la Data API](https://supabase.com/docs/guides/api/securing-your-api). Next 16.3.4, React 19.2.8 installés lors de cette construction.

Les totaux des vues principales passent par `cockpit_dashboard_rollup` : agrégats SQL filtrés par dates/source/tunnel/campagne, avec comptages distincts, intervalles vidéo réunis et sommes monétaires sûres. `dashboard-rollup.ts` adapte ces résultats compacts au contrat UI. `buildDashboard` conserve les définitions et un chemin pur utilisé par les fixtures ; le serveur ne lui transmet plus de lignes métier brutes. Les listes sont paginées par fonctions séparées, avec total avant pagination.

`prepareAttributionScope` et `publishScopedAttribution` produisent les cohortes campagne/pub/créative depuis un global prouvé et les coûts persistés du compte. Un champ scope arbitraire ne suffit jamais à publier une attribution filtrée. Le total compte, chaque jour et les profils sont réconciliés ; les preuves sont figées. Les pubs sans conversion restent au dénominateur.
