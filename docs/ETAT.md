# État du chantier

Mis à jour le 7 septembre 2026. Référence : `../DECISIONS-ACTEES.md`. Aucun chiffre synthétique n'est une mesure BLG.

## Priorité actuelle : revue humaine de Résultats

L’audit des cinq pages est livré dans [AUDIT-UX.html](AUDIT-UX.html). Résultats seule a été reconstruite avec les composants Atelier A : cartes courtes, filtres repliables, volets, courbe et accordéons. Les huit cartes sont entièrement visibles de y209 à y541 en 1366 × 768 et 1440 × 900. Démonstration propre, trois lignes de détail ; les mutations de QA utilisent une base distincte.

12 contrôles UX ciblés, les 27 parcours existants et les 9 scénarios de pagination passent. La revue humaine reste à faire. Ne pas reconstruire Parcours, Commercial, Liens ou Connexions avant le retour sur Résultats. Aucun changement de calcul ou accès réel n’entre dans cette reprise.

## Réalisé et vérifié localement

- Application Next.js/React/TypeScript : Résultats, Parcours, Commercial, Liens et Connexions. Kit Atelier A repris, affichage ordinateur/mobile, filtres dates/source/tunnel/campagne et détails des mesures.
- Accès privé par mot de passe dédié partagé, cookie signé, contrôle d'origine, ingestion navigateur séparée de l'inscription serveur signée, limitation persistante des tentatives côté hébergement.
- Registre de liens PostgreSQL : création, copie, versions immuables, concurrence, archivage/restauration et persistance après rechargement. Destinations quiz et masterclass fixes ; macros Meta préservées.
- Cinq migrations additives appliquées sur une base PostgreSQL17 locale : 19 tables métier, 2 techniques, RLS, droits client retirés, fonctions serveur, intégrité des inscriptions/identités/RDV/paiements et snapshots.
- Connecteurs Meta et Notion en lecture seule, synchronisation manuelle privée et routes planifiables préparées. Lots, pagination et checkpoint atomiques ; aucun ordonnanceur installé.
- Détail de chaque question du quiz et visionnage en intervalles uniques par version vidéo. Contrats/snippets destinés aux responsables des pages, sans installation réelle.
- Moteur d'attribution testé ; publication atomique globale avec preuves figées, contrôle pub/compte/campagne, sélection du cutoff récent. Lecture des ROAS/coûts seulement depuis les snapshots admissibles. Préparateur de campagne/publicité/créative avec coûts complets du compte, pubs sans conversion et preuves figées. Pas de publication financière réelle ; tunnel sans mapping et créative sans métadonnées complètes restent indisponibles.
- CA encaissé net TTC distinct du CA contracté. Autorité transactionnelle ou agrégat source exact, sans addition. Comparaisons financières seulement avec deux périodes couvertes et définition compatible.
- 78 tests unitaires, 30 PostgreSQL et 3 HTTP réussis. Navigateur :27 contrôles intégrés ordinateur/mobile et9 contrôles ciblés de pagination sur fixtures HTTP, sans erreur JS. Captures finales relues après les nouvelles migrations. Détail des scénarios dans RECONCILIATION.md ; preuves brutes privées dans `.local/`.

## Connexions et limites réelles

| Source | Fait et preuve disponibles | Ce qui reste |
|---|---|---|
| Supabase | Coordinateur : MCP disponible, projet ACTIVE_HEALTHY ; schéma public et registre de migrations initialement vides | Application et vérification des cinq migrations inchangées prises en charge exclusivement par le coordinateur ; la tâche UX n’intervient pas dans cette opération. |
| Meta Ads | Lecture réelle du compte et Insights réussie par connecteur ; réponse vide conservée comme vide | Premier import persistant après installation de la base, contrôle de la couverture puis choix d'une fréquence. |
| Notion | Schéma commercial autorisé lu avec succès ; adaptateur testé avec fixtures | Premier import des seules propriétés autorisées. Historique antérieur non reconstitué, aucune écriture Notion. |
| Wix | Coordinateur : clé privée reçue ; lectures des modèles Analytics et d’une transaction APPROVED réussies HTTP 200 | Aucun import métier. Mapping des agrégats et paiements individuels à réconcilier ; aucune route Wix automatique activée. |
| PostHog | Contrôle de projet réussi ; contrat first-party prêt | Pas d'export Query ni d'alimentation automatique du cockpit installée. |
| Pages quiz/masterclass | Collecteur, adaptateurs et confirmation backend signée préparés | Installation coordonnée par le propriétaire et vérification réelle de bout en bout. |

Les nouveaux clients globaux, le CPL attribué, le closing par cohorte, le CAC complet et la LTV ne sont pas fabriqués à partir de données manquantes. Une date Notion courante ne prouve pas un rendez-vous distinct et un clic bilan ne prouve pas une présence. Les étapes affichent des observations par tentative, sans entonnoir séquentiel inventé. Les créatives/appareils et les conversions Meta détaillées ne sont pas automatiquement rapprochés dans cette version. Instagram natif est reporté.

Les vues principales utilisent des agrégats SQL sur la période entière ; détails et prospects disposent de pages de 50 et de totaux indépendants. Tests sur 10 051 événements et 15 005 prospects, y compris un filtre retrouvant les éléments après le seuil de 10 000. Les snapshots sont lus par cohorte précise. Le registre de liens et les préparations opérateur restent bornés explicitement, sans troncature silencieuse. Les limites et états observés sont visibles dans l'application. Aucun diagnostic automatique ni achat d'abonnement.

## Livraison et suite

Code et documentation publiés sur `codex/build`, [PR1 en brouillon](https://github.com/Cilouibip/cockpit-blg/pull/1). Le propriétaire déploie Vercel et coordonne les autres tâches. Aucune mise en ligne ni migration distante effectuée. Procédure : DEPLOIEMENT.md ; recette : RECONCILIATION.md ; revue du contrat : SCHEMA-REVU.md et REVUE-INDEPENDANTE.md.

Prochaine action immédiate : revue humaine de Résultats. Les raccordements restent un chantier séparé : revue du code, installation SQL autorisée, puis validation des premiers imports. L'accès SQL et la vérification REST sont distincts ; ne pas demander de nouvelles clés déjà fournies.
