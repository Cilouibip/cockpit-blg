# Contrat de données corrigé pour la construction

Version technique 1, 7 septembre 2026. Les KPI ont été validés par l'utilisateur ; les paramètres et choix ci-dessous sont des décisions d'implémentation du coordinateur, issues de la revue indépendante. Ce document remplace SCHEMA-PROPOSE.md comme entrée de construction. Aucune migration distante n'est appliquée.

## Référentiel retenu

Le contrat reprend les 19 tables, clés, contraintes, règles de calcul, requêtes et cas de test des sections 5 à 14 de **REVUE-INDEPENDANTE.md**, archivé dans ce même dossier. Ces sections sont la spécification technique à implémenter, avec les précisions ci-dessous. Le verdict « à corriger » de la revue porte sur l'ancienne proposition à 15 tables ; il reste conservé comme historique, pas présenté comme une validation SQL.

| Bloc | Tables retenues |
|---|---|
| Liens et publicités | tracked_links, link_revisions, ads, ad_daily, meta_conversions_daily |
| Personnes et parcours | people, person_identities, events, lead_registrations |
| Commercial | prospects, appointments, commercial_history |
| Engagements et encaissements | deals, payments |
| Attribution | attribution_runs, attribution_results |
| Imports et contrôles | sync_runs, source_mappings, source_aggregates |

Pas d'autres tables métier requises V1. Pas de table clients/LTV, de microservices, de configuration publique de types d'événements ou de moteur de recommandation. Les coûts complets et la LTV restent des extensions documentées, pas des valeurs inventées.

## Résolution des huit points de revue

- **B1 — CA Wix :** adopter source_aggregates et la règle transaction OU agrégat compatible du §7.3. Pas de paiement fictif pour un total, pas de répartition par campagne sans preuve. Réconciliation séparée.
- **B2 — attribution :** adopter attribution_runs/results, publication atomique, paramètres et faits/preuves figés, une ancre par personne/run, héritage par échéances et remboursements. Les résultats existants ne sont pas réécrits par une nouvelle identité/mapping.
- **B3 — inscriptions :** lead_registrations est le fait canonique, avec clé de sauvegarde métier stable. Les événements navigateur et copies PostHog sont des observations/preuves ; aucune déduplication probabiliste personne+seconde. Une source navigateur seule n'est pas une preuve de sauvegarde backend.
- **B4 — parcours :** visites, visiteurs mesurés, personnes et tentatives restent des grains distincts. session_id expire après 30 minutes d'inactivité (choix technique versionné), journey_id distingue les tentatives. Les cohortes chargent les événements nécessaires hors des bornes d'entrée et exposent leur maturité.
- **B5 — commerce/finance :** namespaces non NULL ; historique de l'emplacement courant Notion sans fabriquer des RDV ; premier client seulement avec preuve suffisante, sinon premier paiement observé ; remboursement canonique à sa date et rattaché à son receipt pour l'attribution. PK/FK/UQ, invariants financiers, conflits et anomalies tels que §§5–7.
- **B6 — Meta :** profils fermés et snapshots par partition, dépenses indépendantes des actions, dernier lot complet sélectionné avant ses lignes, y compris lots vides. Jours en DATE dans le fuseau du compte, aucun partage arbitraire par tunnel/asset.
- **B7 — imports :** sync_runs au grain flux+profil+partition, couverture event_interval/source_snapshot/aggregate_period distincte ; pagination et checkpoint publiés atomiquement. Compteurs globaux calculés sur toutes les lignes admissibles, pas sur la page affichée.
- **B8 — accès :** RLS, révocation des droits clients sur tables/vues/RPC et droits futurs, serveur exclusivement. V1 utilise un accès privé simple par mot de passe dédié et cookie signé HttpOnly ; aucun signup public ni compte Supabase arbitraire autorisé. Cette barrière remplace la liste d'utilisateurs évoquée dans la revue, sans changer la restriction d'accès aux données. Une gestion nominative de rôles attend une évolution. Ingestion publique uniquement pour observations allowlist ; preuves de sauvegarde backend authentifiées ; aucune identité, vente ou transaction confirmée par corps navigateur.

## Paramètres techniques visibles

- Tuile financière normalisée candidate : encaissé net de remboursements TTC, avant frais de prestataire, à la date effective ; brut et refunds consultables. Si la source ne prouve pas la base, afficher sa métrique source libellée exactement et laisser le net normalisé indisponible.
- Modèle V1 : dernier contact non direct observé, lookback 30 jours avant l'acquisition ; horizon de revenu 90 jours à partir du contact d'acquisition. Les paramètres sont stockés/versionnés et affichés ; une cohorte jeune indique « observée à ce jour ». Pas de fenêtre ni de revenu futur cachés.
- L'activité CA suit la date de paiement ; le ROAS et les coûts d'acquisition suivent la cohorte de contacts et sa dépense complète. Aucun mélange avec le CA d'anciens clients ou de l'organique. Les actions rapportées par Meta sont à part.
- Les observations positives partielles peuvent être exposées comme telles. Les métriques normalisées qui nécessitent une preuve manquante restent indisponibles. Un accès HTTP 200 ne valide ni zéro activité, ni une couverture historique.

Ces paramètres sont modifiables dans le code/configuration versionnée, sans nouvel écran de réglages complexe et sans les inscrire parmi les décisions de l'utilisateur.

## Entrée en construction

Les corrections B1–B8 sont incorporées dans ce contrat par les règles ci-dessus et le référentiel détaillé. Une contre-lecture finale doit confirmer cette incorporation documentaire. Le CTO peut ensuite écrire la migration locale et tester les scénarios du §13 sur PostgreSQL. Le résultat SQL réel, les droits et les preuves navigateur restent à produire.

La validation de ce contrat n'est pas une preuve d'installation. Supabase requiert encore une connexion SQL autorisée ; Wix autonome requiert sa propre clé. Le CTO continue l'interface, les connecteurs, validateurs et tests indépendants pendant ces attentes. Le déploiement et les snippets live restent gérés par le propriétaire.

## Contre-lecture documentaire terminée

Le 7 septembre 2026, le relecteur indépendant confirme que B1–B8 et les 19 tables sont incorporés, que l’accès privé simple est compatible avec la V1, et qu’aucun blocage documentaire matériel ne reste. **Prêt pour écrire la migration locale.** Cette confirmation ne valide pas le SQL, la sécurité implémentée, les données ou une installation distante.
