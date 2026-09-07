# Revue indépendante du schéma Supabase du cockpit BLG

Date : 7 septembre 2026. Objet : revue documentaire préalable à la construction.

**Verdict : à corriger.** Les 15 tables constituent une bonne base, mais le document n'est pas encore prêt à servir de contrat de migration. Les ambiguïtés restantes peuvent doubler le CA, inventer des nouveaux clients, changer un ROAS historique ou attribuer des dépenses à un tunnel sans preuve.

**Architecture technique retenue par cette revue : 19 tables.** Conserver les 15 tables, préciser leurs contraintes et ajouter uniquement **lead_registrations**, **source_aggregates**, **attribution_runs** et **attribution_results**. Les vues portent les visites, parcours, clients et KPI. Différer la table de coûts complets, le catalogue de types d'événements et toute LTV prédictive.

Toutes les règles proposées ci-dessous sont des **choix techniques du relecteur**, pas de nouvelles décisions de Mehdi. Le périmètre validé demeure : trois niveaux de KPI, trois piliers contenu/acquisition/conversion, CA encaissé en tête, suivi commercial réel, ROAS attribué, CPL/CPA/CAC distingués, LTV facultative et aucune analyse automatique.

Aucune application, migration SQL ou intégration n'a été construite ou exécutée dans cette revue. Aucun accès à un compte métier, aucun fichier env lu, aucun agent lancé, aucun commit, push ou déploiement. La consultation de documentation publique PostgreSQL/Supabase sert uniquement à vérifier les garanties de contraintes et d'accès. Les fichiers relus sont restés intacts.

## 1. Sources, autorité et limites

Les identifiants S, D, E, A et H servent de locateurs dans ce rapport. Les constats sur les accès sont ceux des documents locaux ; cette revue n'a pas vérifié leur fonctionnement à distance.

| Référence | Document et locateur | Usage |
|---|---|---|
| R | DECISIONS-ACTEES.md à la racine du dépôt BLG, section « Cockpit acquisition, KPI et chantier GitHub » du 07-09 | Autorité de Mehdi et séparation audit privé / produit public. Référence obligatoire de reprise. |
| K | .agents/skills/blg-operate-audit-control-center/SKILL.md, « Journal every task » et « Audit and plan » | Journal manuel dans le dépôt original ; sources, grains et preuves. |
| S | Dépôt produit, docs/SCHEMA-PROPOSE.md, lignes 1–68 | Proposition technique à 15 tables examinée. |
| D | Dépôt produit, DECISIONS-ACTEES.md, lignes 5–28 | KPI validés et séparation explicite des choix techniques. |
| E | Dépôt produit, docs/ETAT.md, lignes 7–16 | Schéma non créé ; agrégats Wix disponibles selon le coordinateur ; raccord transactionnel restant. |
| A | Dépôt produit, AGENTS.md, lignes 3–11 | Produit descriptif, données publiques expurgées, intégrations en lecture seule. |
| H | Dépôt BLG, apps/cockpit-blg/DATA-CONTRACT.md, lignes 13–20, 48–50, 84–118 | Prototype historique, sans obligation de conserver ses six tables ou ses anciennes règles de comptage. |

« Dépôt produit » désigne le checkout du coordinateur nommé cockpit-blg. Le présent rapport est dans le checkout distinct cockpit-blg-schema-review. Il ne reprend aucun export d'audit, identité client, identifiant de compte ou montant réel.

Actualisation reçue pendant la revue : le coordinateur signale que les lectures Meta compte et Insights ont répondu HTTP 200. La nouvelle version de docs/ETAT.md, lignes 13 et 16, confirme ce constat rapporté et le démarrage de la tâche CTO sur les éléments indépendants. L'ancien état de jeton/approbation absent n'est donc pas un blocage actuel. La synchronisation récurrente et ses garanties restent à construire ; aucun nouvel appel métier n'a été fait par le relecteur.

La demande autorise une revue technique ; elle ne valide pas les propositions de cette revue comme décisions produit et n'autorise aucune migration distante.

## 2. Problèmes bloquants avant rédaction de la migration

Les blocages concernent le **contrat de données**, pas le lancement des pages ou des campagnes.

| ID | Constat et preuve | Exemple de chiffre faux | Correction imposée à l'architecture proposée |
|---|---|---|---|
| B1 | Le CA agrégé Wix est autorisé en lecture mais aucune des 15 tables ne le reçoit. S:24,41,62 ; E:12. | Importer le total comme un paiement sans personne, puis ajouter les vrais paiements : CA doublé. Répartir ce total entre les clients : ROAS fabriqué. | Ajouter source_aggregates sans FK vers people/deals ; sélection d'une seule autorité financière par périmètre. Conserver les agrégats à côté des transactions pour réconciliation. |
| B2 | S:48–50 demande une attribution traçable mais laisse son stockage et sa version ouverts. Une version de code ne fige ni les données, ni les identités, ni les mappings. | Un raccord d'identité tardif ou un changement pub→tunnel modifie le ROAS affiché hier sans explication. Le dernier clic d'un ancien client est crédité de toutes ses échéances. | Ajouter attribution_runs et attribution_results, snapshots immuables par calcul ; ancrage d'acquisition unique et explicite, héritage des échéances et remboursements. |
| B3 | S:19,50,54,64 ne donne pas de clé métier indépendante pour l'inscription réussie, ni de règle cross-source complète. | Un succès envoyé par le backend, copié dans PostHog puis importé d'une source métier devient plusieurs leads. Un événement navigateur forgé crée un lead « réussi ». | Ajouter lead_registrations, autorité de sauvegarde obligatoire. Events décrit les observations ; les événements miroirs se rattachent à la même inscription ou restent diagnostics. |
| B4 | S:19,54 ne fixe pas le grain visite/parcours, le traitement des identifiants absents et des cohortes traversant la borne de période. | Trois pages vues deviennent trois visiteurs ; deux sessions d'une personne sont cousues en un parcours complet ; un lead après minuit disparaît d'un tunnel. | Contrat explicite de visite et tentative de parcours ; agrégats distincts par personne, visite et parcours ; chargement des événements antérieurs nécessaires à la cohorte. |
| B5 | S:18,21–24,37,42–43 reste indicatif sur le namespace, les reports, le premier achat et les remboursements. | IDs identiques de deux comptes fusionnés ; une modification de date Notion crée deux RDV réalisés ; première échéance observée d'un ancien client comptée comme nouveau client ; refund compté deux fois. | Clés scoping source+namespace partout, historique d'observation distinct du temps métier, règles de rapprochement et de refund, preuve de premier client et source transactionnelle canonique. |
| B6 | S:26–27 sépare bien dépenses et conversions, mais « fenêtre/modèle » ne ferme pas le grain Meta. S:40 mélange un énoncé « toutes dates timestamptz » avec un fait journalier. | Deux fenêtres multiplient spend après jointure ; une action rapportée à la date du clic et la même à la date de conversion sont additionnées ; une date du compte est déplacée artificiellement à Paris. | Clé de profil de reporting complète, date locale de compte en DATE, publication par lot complet, aucune jointure brute 1:N entre dépenses et actions. |
| B7 | S:28,39 décrit une couverture par exécution sans distinguer type de flux, instantané et intervalle métier. | Une lecture paginée complète des prospects actuels est prise pour l'historique de leurs RDV ; un import de ventes fait croire les refunds complets ; une page reçue remplace tout un jour Meta. | sync_runs au grain source+namespace+flux+profil+partition ; couverture déclarée selon sa vraie nature ; checkpoints atomiques ; règles de complétude par KPI. |
| B8 | S:9 et 64 prévoit RLS et serveur, sans contrat pour les vues, fonctions et service_role. | Un endpoint authentifié mais ouvert à tout utilisateur connecté expose le CRM ; une vue ou RPC reste accessible ; ingestion publique injecte une preuve de paiement. | Retrait explicite des privilèges clients, vues et RPC comprises ; liste d'utilisateurs applicatifs autorisés ; ingestion publique limitée aux observations non financières ; tests des refus. |

## 3. Ce qui est correct et doit être conservé

- Séparer prospects, rendez-vous, engagement commercial et encaissement ; people est un pont technique et ne fusionne pas les bases Notion Prospect/Client. S:20–24,31.
- Liens logiques distincts de leurs révisions immuables ; sauvegarde atomique et anciennes URLs stables. S:15–16,35.
- Identités opaques, rapprochements prouvés, HMAC serveur, null permis lorsqu'une correspondance manque. S:17–18,36–38.
- Dépenses Meta distinctes des conversions rapportées, refus des répartitions inventées par asset ou placement. S:26–27,44.
- Refus d'assimiler Closé à réalisé/payé ; absence d'historique antérieur inventé ; montants contractés non multipliés par les échéances. S:42–43.
- UTC pour les instants, demi-intervalles, monnaies séparées, coverage/unknown distincts de zéro. S:40–41,68.
- Requêtes déterministes, aucune recommandation automatique, LTV facultative et observée. S:7,48,56 ; D:13,19.
- Aucune dépendance Calendly ; pas d'écriture dans les systèmes sources ni de changement live pendant cette revue. D:20–24 ; A:6–8.

## 4. Arbitrage sur les tables complémentaires

| Élément | Choix unique de cette revue | Pourquoi |
|---|---|---|
| Inscription réussie canonique | **lead_registrations dès V1** | Une sauvegarde métier n'est pas une observation de navigateur. Nécessaire pour dédupliquer les parcours et prouver l'origine du lead. |
| Attribution traçable | **attribution_runs + attribution_results dès V1** | Les résultats doivent rester explicables après enrichissement d'identité, correction de mapping et remboursement tardif. |
| Agrégats non joignables | **source_aggregates dès V1** | Permet le CA agrégé Wix disponible sans inventer de transactions ; reçoit aussi les contrôles au niveau compte Meta. |
| Coûts complets | **acquisition_costs différée** | Aucune source exhaustive de coûts non publicitaires n'est dans le périmètre courant. CAC complet = indisponible, jamais égal au coût publicitaire/client. |
| Typage d'événements | **Obligatoire dès V1, sans table event_types** | Petit vocabulaire versionné dans le code + CHECK SQL + validation des propriétés. Une table administrable ajoute une synchronisation inutile. |
| Visites, sessions, parcours | **Vues, pas de tables dédiées V1** | Grains et identifiants imposés dans events ; pas de deuxième stockage à synchroniser. |
| Clients / LTV | **Vues, pas de table clients/LTV V1** | Première acquisition prouvée et paiements suffisent. LTV prédictive, rétention contractuelle et allocation de marge hors V1. |
| Comptes, campagnes, responsables | **Pas de nouvelles dimensions V1** | Namespace qualifié et métadonnées source suffisent. Pas de répertoire RH ni d'arbre de dimensions sans usage. |

Différer acquisition_costs ne supprime pas l'exigence de définition : une évolution de CAC devra importer les frais marketing et commerciaux selon leur période, catégorie, devise, base HT/TTC, périmètre d'acquisition et règle d'allocation ; une source manquante interdit « complet ». Les frais déjà inclus dans une autre source devront être exclus des doublons. Ce n'est pas un chantier V1 autorisé par ce rapport.

## 5. Architecture corrigée : contrat commun

Une base PostgreSQL, un serveur applicatif et des synchronisations indépendantes. Les 19 tables restent dans public avec accès réservé au serveur. Aucun moteur de scoring, aucun entrepôt parallèle.

Notation : PK = clé primaire, FK = clé étrangère, UQ = unicité. Toutes les PK sont UUID sauf les PK composites indiquées. Tous les IDs métier externes sont du texte opaque, sans conversion numérique. Un namespace est un identifiant stable du périmètre de source incluant environnement et, selon le cas, site/projet/compte/base ; jamais un libellé susceptible de changer.

Pour chaque ligne importée : source_system, source_namespace, source_record_id ou clé naturelle exacte, source_updated_at nullable, observed_at, ingestion_run_id FK sync_runs, connector_version et référence de mapping appliqué. Les champs communs ne dispensent pas des clés spécifiques ci-dessous. Créations locales : horodatage, auteur technique et provenance locale ; pas de faux ID d'import.

Instants métier/réception en TIMESTAMPTZ ; jours de reporting en DATE avec fuseau capturé. Périodes [début inclus, fin exclue). Argent : BIGINT en unités mineures, devise ISO et exposant explicites ; taux et actions fractionnaires Meta en NUMERIC, jamais float. Pas de conversion monétaire implicite. Les états normalisés ont une valeur unknown explicite ; un montant absent reste NULL.

Une mesure expose value, observed_value si partielle, unit, definition_version, currency/basis si applicables, time_axis, timezone, source, coverage_state, observed_at et motif d'indisponibilité. Un indicateur « complet » exige sa couverture métier et technique ; une lecture exhaustive d'une source ne prouve pas que tous les faits métier y existent.

FK indexées, ON DELETE RESTRICT pour les faits et preuves. Archivage et corrections explicites ; pas de cascade supprimant des preuves. Les identités et mappings conservent leur historique. Les résultats d'attribution publiés ne sont jamais réécrits.

### 5.1 Les 19 tables, leurs grains et leurs contraintes

| # | Table / grain exact | PK, FK, UQ et champs déterminants |
|---|---|---|
| 1 | **tracked_links** : un lien logique | PK id ; title, placement, created_at, updated_at, archived_at, current_version entier >= 0. Verrou du parent pour créer une révision. |
| 2 | **link_revisions** : une version immuable d'un lien | PK id ; FK link_id→tracked_links ; UQ(link_id, version), version > 0 ; destination_url, generated_url, source/medium/campaign/content, funnel_key, placement et title figés. Interdiction UPDATE/DELETE ; URL générée contenant cet ID. |
| 3 | **people** : une personne canonique opaque | PK id ; created_at. Pas de statut commercial, compteur client ou CA stocké. Pas de fusion par nom, IP, appareil ou simple cooccurrence de session. |
| 4 | **person_identities** : une affectation versionnée d'une clé d'identité à une personne | PK id ; FK person_id→people nullable si ambigu ; system, namespace, identity_kind, identity_key, key_version, assignment_version, valid_from, valid_to, state, evidence, recorded_at. UQ(system,namespace,identity_kind,identity_key,key_version,assignment_version). Index UNIQUE partiel sur la même clé sans assignment_version WHERE valid_to IS NULL. Absence de chevauchement des intervalles d'affectation pour une clé. Un état linked exige person_id et preuve ; ambiguous n'en impose aucun. |
| 5 | **events** : une observation reçue d'une source, pas nécessairement une occurrence canonique | PK id ; UQ(source_system,source_namespace,source_event_id). event_type, schema_version, occurred_at, received_at, source_sequence nullable, event_origin_namespace/canonical_event_id nullable ensemble, visitor_namespace, anonymous_id, session_id, journey_id, funnel_key, page_key/page_version, video_key/video_version, FK link_revision_id, FK lead_registration_id nullable, FK person_identity_id nullable, person_id prouvé nullable, ad_id/campaign_id observés avec leur namespace, trust_level attribué par le serveur, properties allowlist, ingestion_run_id. Les copies cross-source partagent la clé canonique lorsqu'elle existe ; la vue en choisit une. Un conflit de contenu avec le même ID est signalé, pas écrasé. |
| 6 | **lead_registrations** : une sauvegarde réussie de coordonnées dans un formulaire/parcours | PK id ; UQ(authority_system,authority_namespace,registration_id) tous NOT NULL ; FK person_identity_id nullable et person_id prouvé nullable ; funnel_key, saved_at, journey_id nullable, FK success_event_id→events nullable, FK link_revision_id nullable, evidence_state, source_locator, ingestion_run_id. La FK circulaire optionnelle avec events s'ajoute après création des deux tables ; liens croisés cohérents vérifiés à l'ingestion. Pas de UQ(person_id) ni UQ(person_id,funnel) : les réinscriptions sont conservées. |
| 7 | **prospects** : une fiche commerciale Notion courante | PK id ; UQ(source_system,source_namespace,source_page_id), namespace incluant la base ; FK person_identity_id/person_id nullable ; source_status, normalized_status, FK status_mapping_id→source_mappings nullable, assignee_source_id, next_followup_at, created_at_source, source_updated_at, observed_at, archived_in_source, champs commerciaux allowlist. Un doublon de fiche n'est pas supprimé au prétexte qu'il partage people. |
| 8 | **appointments** : une occurrence de RDV distincte ou un emplacement courant Notion identifié comme tel | PK id ; UQ(source_system,source_namespace,source_appointment_key) NOT NULL ; identity_basis = stable_booking / notion_current_slot ; FK prospect_id et person_identity_id/person_id nullable ; booked_at, scheduled_start_at, held_at, outcome_at nullable ; booking_time_quality, schedule_version, source_status, normalized_status, evidence_state, FK status_mapping_id nullable ; FK supersedes_appointment_id→appointments nullable. Interdire auto-lien et cycle de reports. Une preuve de held_at est requise pour utiliser cette date ; l'heure prévue n'est pas une preuve de présence. |
| 9 | **commercial_history** : une différence observée dans une fiche ou un RDV | PK id ; FK prospect_id ou appointment_id, exactement une non NULL ; field_key, before_value/after_value allowlist, source_version_key, source_effective_at nullable, observed_at, mapping_id FK nullable, ingestion_run_id. Deux UQ partielles : (prospect_id,source_version_key,field_key) et (appointment_id,source_version_key,field_key). snapshot_initial distingué d'un changement ; un retry ne rajoute pas d'historique. |
| 10 | **deals** : un engagement identifié | PK id ; UQ(source_system,source_namespace,source_deal_id), FK person_identity_id/person_id et prospect_id nullable ; signed_at, state, contracted_minor nullable, currency/exponent, tax_basis = tax_inclusive / tax_exclusive / unknown, source_locator. Une fiche marquée Closé peut rester signal commercial, sans deal inventé si aucun engagement distinct n'est identifiable. |
| 11 | **payments** : une transaction financière canonique, paiement, refund ou reversal explicite | PK id ; UQ(authority_system,authority_namespace,transaction_id) tous NOT NULL ; FK person_identity_id/person_id/deal_id nullable ; kind = receipt / refund / reversal, status = pending / settled / failed / cancelled / unknown ; effective_at nullable si non settled, gross_minor > 0, currency/exponent, tax_minor nullable, tax_basis, source_locator ; FK original_payment_id→payments nullable, external_original_id nullable ; reversal_direction nullable, reconciliation_state, order/subscription/installment IDs nullable. settled exige effective_at. Les règles financières de §7 complètent les FK. |
| 12 | **ads** : une publicité dans un compte Meta | PK id ; UQ(source_system,account_namespace,external_ad_id) ; campaign_id/adset_id/creative_id observés, noms courants, first_seen_at/last_seen_at, status. Métadonnées utiles seulement. Les noms courants ne redéfinissent pas un historique de dépenses ou de destination. |
| 13 | **ad_daily** : un snapshot des compteurs de base d'une pub/jour/profil de base dans un lot | PK id ; FK ad_id→ads et ingestion_run_id→sync_runs ; UQ(ad_id,account_day,base_profile_key,ingestion_run_id) ; account_day DATE, account_timezone, currency/exponent, spend_minor, impressions, outbound_clicks, counts_present, row_state = complete / partial. base_profile_key fixe niveau ad, sans breakdown, sans variantes d'attribution. Les anciens snapshots restent ; v_ad_daily choisit uniquement le dernier lot complet pour la partition. |
| 14 | **meta_conversions_daily** : une mesure d'action Meta/pub/jour/profil dans un lot | PK id ; FK ad_id et ingestion_run_id ; UQ(ad_id,account_day,report_profile_key,action_type,metric_kind,ingestion_run_id) ; action_count NUMERIC nullable, action_value_minor NUMERIC nullable, currency/exponent, timezone. metric_kind = actions / unique_actions / action_values, CHECK de la colonne de valeur correspondante. Le profil fige fenêtres, action_report_time, paramètres d'attribution demandés et effectifs, version API, niveau et breakdown vide. |
| 15 | **sync_runs** : une tentative d'import d'une partition homogène d'un flux | PK id ; UQ(job_key,attempt_no), FK retry_of_run_id nullable ; source_system, source_namespace, stream_key, query_profile_key, partition_key, connector_version, started_at, finished_at, status ; coverage_kind = event_interval / source_snapshot / aggregate_period ; requested_start/end, covered_start/end nullable, source_as_of nullable, pagination_complete, cursor_before/after expurgés, source_watermark, counts read/written/rejected, content_digest, error_code. Aucun curseur contenant un secret. Publication conditionnée au contrat §10. |
| 16 | **source_mappings** : une version immuable d'une correspondance explicite | PK id ; UQ(system,namespace,mapping_kind,source_key,version) ; mapping_kind = status / event_alias / ad_destination / source_authority ; normalized_value allowlist, effective_from/to, recorded_at, supersedes_id FK nullable, provenance. Une révision explicite remplace la précédente dans le jeu courant ; pas de deux règles courantes contradictoires sur le même intervalle. Une correction rétroactive crée une version, sans modifier l'ancienne. |
| 17 | **source_aggregates** : une mesure agrégée d'une source pour un périmètre/période/profil observé | PK id ; FK ingestion_run_id ; UQ(source_system,source_namespace,metric_key,period_start,period_end,dimensions_key,report_profile_key,ingestion_run_id), tous composants NOT NULL ; timezone, coverage_state, value NUMERIC nullable, unit, currency/exponent ou marqueur non monétaire, tax_basis, dimensions allowlist, definition_version, source_locator. Aucun person_id, deal_id ou paiement fictif. Le profil distingue reçu, refund, net reçu, vente et versement bancaire. |
| 18 | **attribution_runs** : un calcul publié ou préparé avec paramètres et état des entrées figés | PK id ; UQ(calculation_fingerprint), FK supersedes_run_id nullable ; status = building / published / failed ; code_version, metric_definition_version, identity_cutoff_at, input_manifest borné (IDs sync, mappings, versions des faits), model, lookback_days, observation_horizon_days, input_cutoff_at, cohort_start/end, cohort_timezone, currency/basis, scope, coverage_summary, started_at/published_at. Les valeurs par défaut techniques du §8 sont enregistrées, jamais implicites. |
| 19 | **attribution_results** : le résultat d'une cible et d'un rôle d'attribution dans un calcul | PK id ; FK attribution_run_id, person_id nullable ; target_kind, FK lead_registration_id / appointment_id / payment_id, exactement une cible selon kind ; FK anchor_result_id→attribution_results nullable ; FK selected_event_id, link_revision_id, ad_id nullable ; UQ partielles (run_id,target_kind,chaque FK cible) ; UQ partielle(run_id,person_id) WHERE target_kind='acquisition' et person_id non NULL. status = attributed / direct / organic / unknown / ineligible ; reason_code ; conversion_at, acquisition_at, person_evidence_refs, mapping_refs, dimensions_snapshot, candidate_evidence_snapshot, target_snapshot, contribution_minor nullable, currency/basis, first_customer_proof, input_digest. Poids V1 strictement 1 pour une attribution unique, aucun multi-touch. |

Dans les UQ ci-dessus, run_id abrège attribution_run_id uniquement dans la dernière ligne. Une clé optionnelle ne doit pas permettre des doublons via NULL : utiliser des index partiels ou des composants de clé non NULL normalisés. Les champs communs et les FK optionnelles sont précisées dans la migration, sans transformer une donnée inconnue en valeur métier fictive.

Enums commerciaux techniques V1 : appointments.normalized_status = scheduled / held / no_show / cancelled / rescheduled / unknown ; deals.state = open / signed / cancelled / unknown. Les statuts prospect sont des codes descriptifs issus d'un mapping versionné ; ils ne déclenchent pas à eux seuls une conversion financière.

Les CHECK concernent une seule ligne. Les cohérences entre lignes, les cycles et les invariants financiers exigent FK/UNIQUE/exclusions, ou une transaction avec verrou et trigger adapté ; un CHECK qui lit d'autres lignes n'est pas une garantie PostgreSQL. [Documentation des contraintes PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html)

### 5.2 Jointures autorisées et anti-multiplication

- people → plusieurs identités, inscriptions, fiches, RDV et paiements. **Ne jamais joindre toutes ces branches avant SUM/COUNT.** Préagréger chaque fait au grain de la sortie ; joindre ensuite les résultats.
- source → person_id uniquement par une preuve d'identité. Une source peut fournir un person_id direct prouvé ; si elle fournit aussi une identité affectée, les deux doivent concorder. Un conflit reste en attente.
- events → lead_registrations en N:1 ; une inscription est le fait métier, ses événements sont des preuves. L'inscription référencée doit correspondre à la même source de sauvegarde et au même parcours lorsqu'ils sont connus.
- appointments → prospect facultatif ; une personne peut avoir plusieurs fiches et plusieurs RDV. Une jointure person_id seule n'associe pas une vente à tous les RDV.
- payments → deals en N:1 quand prouvé. V1 n'alloue pas un même paiement à plusieurs engagements. Un paiement couvrant plusieurs engagements reste sans deal attribué, visible dans le CA ; la table de ventilation est différée jusqu'à une source qui la rende nécessaire.
- refunds/reversals → transaction originale quand prouvé ; les paiements restent en une ligne chacun. Le montant contracté est agrégé dans une requête indépendante.
- ad_daily et meta_conversions_daily sont deux faits indépendants. Aucune jointure brute ad+jour avant l'agrégation du profil d'action sélectionné.
- source_aggregates n'entre jamais dans une jointure par personne ; son rapprochement financier se fait uniquement sur périmètre, période, définition et devise.
- attribution_results reprend les dimensions et contributions figées du calcul ; une vue historique ne relit pas le nom, statut ou mapping courant pour réécrire son résultat.

## 6. Identités, événements, visites et leads

### 6.1 Identité explicite et réversible

La clé externe de source et le HMAC d'email normalisé sont des moyens de rapprochement côté serveur. Enregistrer méthode, version de normalisation, version de clé HMAC et preuve. Ne pas retirer arbitrairement points ou suffixes d'une adresse ; cela peut fusionner deux personnes.

Une affectation modifiée ferme la précédente et crée la suivante atomiquement. Les faits originaux et résultats publiés ne sont pas réécrits. La résolution d'identité du prochain calcul utilise les affectations au cutoff enregistré ; une fusion ou séparation est une opération explicite, avec liste des clés concernées. Aucun lien transitif automatique via appareil partagé. Un identifiant anonyme reste un identifiant de navigateur, pas une preuve d'identité client.

Les faits importés liés à une ancienne affectation conservent leur preuve ; la vue de résolution retrouve la version applicable de **la même clé externe** au cutoff. Elle ne rattache jamais toutes les anciennes données d'une personne à une autre sans liste de clés/preuves. Les éléments portant uniquement une preuve directe conservent cette personne jusqu'à correction explicite et versionnée.

### 6.2 Typage minimal obligatoire

Le contrat événementiel versionné V1 couvre :

| Type normalisé | Exigences et usage |
|---|---|
| page_view / landing_arrival | page_key, funnel, namespace visiteur, session_id ; journey_id pour l'entrée dans un tunnel. Un clic sortant n'est pas une arrivée. |
| quiz_started / quiz_step_viewed / quiz_step_completed / contact_form_viewed | journey_id, page_version, step_key quand applicable. Ne pas enregistrer les réponses personnelles. |
| lead_save_succeeded | Backend/source de sauvegarde identifié, registration_id stable ; référence à lead_registrations. Un événement navigateur seul n'est pas autorité. |
| result_viewed / calendar_opened | Observation d'étape ; ne prouve ni lead ni réservation. |
| booking_observed | ID de réservation seulement s'il existe réellement et preuve/source. Jamais transformé en RDV réalisé. Notion reste la source descriptive disponible. |
| video_playback_started / video_ranges_watched | video_key/version, playback_id, durée de la vidéo et intervalles effectivement lus, bornés et validés. Un seek ou une position maximale n'est pas du temps regardé. |
| outbound_click | destination classifiée, lien/révision si connu. Compté séparément des landing_arrival et des outbound_clicks rapportés par Meta. |

CHECK(event_type, schema_version) et validation stricte des propriétés par type ; correspondances des noms historiques dans source_mappings. Les types inconnus sont rejetés/quarantainés, comptabilisés et n'entrent pas silencieusement dans les KPI. La table events peut porter une preuve liée, mais aucune émission publique ne crée directement une vente, un paiement, une identité confirmée ou une inscription prouvée.

Le même ID d'origine propagé au collecteur et à PostHog permet de sélectionner une occurrence canonique. Sans ID commun, le contrat fixe une source autoritaire par type/période ; l'autre flux reste comparatif. **Pas de déduplication probabiliste sur personne+seconde.** Deux vraies soumissions proches doivent rester deux inscriptions.

### 6.3 Grains de calcul

- **Visite de page/tunnel** : (visitor_namespace, session_id, funnel_key), avec au moins une arrivée/page vue valide. Le contrat du snippet maintient session_id pendant l'activité et le renouvelle après 30 minutes d'inactivité ; c'est un choix technique versionné.
- **Visiteur mesuré** : distinct (visitor_namespace, anonymous_id) sur la période. Ce n'est pas une personne cross-device. Sans anonymous_id, la visite reste comptable si session_id existe, mais le visiteur unique est incomplet.
- **Parcours** : (visitor_namespace, journey_id, funnel_key). Une nouvelle tentative après abandon explicite/recommencement reçoit un nouveau journey_id. Une progression ordonnée n'assemble pas deux journey_id.
- **Lead global de période** : personne résolue ayant au moins une sauvegarde réussie dans [début, fin), DISTINCT personne. La même personne dans quiz et masterclass compte une fois au total, une fois dans chaque tunnel concerné. Les sous-totaux ne sont pas additifs.
- **Inscriptions** : nombre de sauvegardes canoniques, utile séparément des leads. Une inscription sans personne est conservée et affiche un volume non rapproché ; pas de personne artificielle pour compléter un total de leads.
- **Lead acquis pour le coût d'acquisition** : première inscription réussie observée par personne dans l'historique couvert, avec ancrage du §8. Libellé « première inscription observée », pas promesse de première inscription historique.

Le funnel sélectionne les parcours entrés dans la période, puis charge les étapes antérieures/ultérieures nécessaires à la fenêtre d'observation explicite. Il affiche les étapes ordonnées et les réussites observées sans amont. Les KPI d'activité par date de réussite restent séparés des taux de cohorte de parcours. Un ordre source fiable départage les timestamps égaux ; si l'ordre reste indéterminé, ne pas inventer une progression séquentielle. Les données historiques sans journey_id restent utilisables en événements/inscriptions, sans tunnel séquentiel garanti.

Vidéo : union des plages par parcours+playback+version pour éviter les retries ; union par visiteur+version pour le taux de couverture unique. Ne pas sommer les recouvrements ni présenter cette couverture comme la durée totale de visionnage avec relectures. Les versions et dénominateurs de spectateurs restent séparés.

## 7. Suivi commercial, ventes et encaissements

### 7.1 Notion sans Calendly

Un ID de réservation source fiable donne une occurrence distincte. Un report conserve cet ID si la source le conserve ; si elle crée un nouvel ID, supersedes_appointment_id relie les deux et l'ancien porte l'issue rescheduled. La vue distingue occurrences réservées, rendez-vous restant prévus et personnes reçues.

Sans ID de réservation, source_appointment_key identifie **l'emplacement courant de RDV de la fiche Notion**, jamais un hash de sa date. Changer la date actualise cet emplacement et ajoute l'avant/après à commercial_history ; cela ne prouve pas une nouvelle réservation. Si la date change après une issue terminale sans identité d'occurrence, conserver l'ancienne issue dans l'historique et marquer le nouvel état ambigu ; ne pas transporter automatiquement held_at sur la nouvelle date. La source peut avoir remplacé un ancien RDV par un nouveau sans laisser de trace. Le nombre exhaustif de RDV distincts historiques devient indisponible sur cette portion, avec le nombre d'emplacements observés à côté.

Le premier import enregistre un état initial, pas un événement « vient de réserver », « vient de se présenter » ou « vient de closer ». source_effective_at reste NULL si Notion ne donne pas la date du changement. Une date last_edited_time ne devient pas la date de signature ou de présence. Un statut réalisé prouvé sans date réelle de réalisation apparaît dans une vue séparée « RDV au statut réalisé, par date prévue » ; il n'entre pas dans la série de dates held_at comme si celles-ci étaient connues.

Les transitions manquées entre deux imports ne sont pas reconstituées. Ne pas marquer une fiche absente d'une page paginée comme supprimée : il faut un instantané entièrement parcouru et une indication suffisamment fiable de la source. Les droits d'accès modifiés ne prouvent pas une suppression métier.

Taux de présence : RDV réalisés / (réalisés + absences), sur une cohorte de RDV passés avec issue connue. Afficher aussi la couverture des issues, annulations, reports et inconnus. Les emplacements Notion sans granularité historique sûre restent un périmètre explicitement limité.

Closing : personnes avec engagement signé **postérieur au RDV réalisé et dans la fenêtre d'observation** / personnes reçues de la cohorte, dédupliquées. Si aucun deal ne peut être lié au RDV, ne pas faire la jointure sur toutes les lignes de la même personne : rattacher à une cohorte d'acquisition connue, contrôler l'ordre temporel et nommer « conversion des personnes reçues ». La preuve d'un deal manque : taux de vente indisponible, compteur de statuts commerciaux à côté. Une vente antérieure au RDV n'est pas un closing de ce RDV.

### 7.2 Autorité financière

Un seul flux transactionnel est canonique par périmètre, choisi dans une règle source_authority versionnée. Une copie du même paiement dans deux outils n'est pas deux paiements. La correspondance exige un ID de transaction commun fiable ; sans lui, ne pas unir deux flux qui couvrent les mêmes encaissements. Conserver les agrégats de l'autre source comme contrôle.

Définition technique V1 de la tuile principale : **CA encaissé net de remboursements, TTC, à la date effective des mouvements**, dans une devise à la fois, avant frais de prestataire. Afficher également encaissé brut et remboursements. Il s'agit d'encaissements clients enregistrés par la source, pas d'un rapprochement des versements bancaires. Si la source ne prouve pas cette définition ou la base TTC, afficher sa métrique source avec son libellé exact ; la tuile normalisée reste indisponible.

Par transaction settled :

- receipt ajoute gross_minor à sa date effective ;
- refund soustrait gross_minor à sa propre date effective ;
- reversal est une contre-écriture explicite de source, avec sens et transaction visée vérifiés. Elle annule un mouvement réellement enregistré ; ne pas en fabriquer à partir d'un simple état annulé.

Une autorisation, un paiement pending, un échec ou un contrat signé ne sont pas un encaissement. Un reçu ensuite marqué remboursé conserve son mouvement reçu : normaliser le changement en refund distinct uniquement si la source fournit cette transaction et sa preuve. Ne pas retirer le reçu et soustraire encore le remboursement.

Contrôles transactionnels : original différent de soi ; un refund lié vise un receipt compatible dans le même périmètre et la même devise ; une contre-écriture vise le type permis ; le cumul net des remboursements attribués ne dépasse pas le reçu sans anomalie explicite ; parent et enfants sont verrouillés lors d'écritures concurrentes. Les anomalies sont conservées comme faits source non réconciliés, exclues des mesures nécessitant cette cohérence, avec motif. Pas de suppression silencieuse de lignes.

Un remboursement orphelin settled peut réduire le CA d'activité de sa période, car l'argent a été remboursé. Son attribution et sa cohorte restent inconnues jusqu'au raccord au paiement original. Un changement de statut reçu avant son parent ne doit pas être perdu.

Un engagement payé en plusieurs échéances : un deal, plusieurs receipts, une première acquisition client au maximum. Un encaissement sans deal reste dans le CA. Les frais de paiement ne sont ni refund ni réduction arbitraire du CA ; les données de carte ou instrument ne sont pas importées.

### 7.3 Agrégat Wix et transactions : règle de sélection

source_aggregates conserve les périodes et définitions exactes de la source : flux financier, base de taxe, monnaie, fuseau et dimensions. Aucune ventilation quotidienne inventée d'un agrégat mensuel ; aucune addition d'intervalles qui se chevauchent.

Pour chaque cellule de reporting (périmètre, période, définition, devise), r_cash_activity sélectionne **une** provenance :

1. flux canonique de transactions, si reçu/refund/contre-écritures et couverture sont réconciliés pour cette cellule ;
2. sinon agrégat de source compatible et complet pour **exactement** ce périmètre temporel ;
3. sinon valeur normalisée indisponible et observation partielle/source explicitement exposée.

Ce classement est un choix technique documenté dans source_authority. Aucun mélange d'un agrégat couvrant un mois et de transactions couvrant une partie de ce mois. Un agrégat sans dimensions campagne/tunnel n'est pas filtrable par campagne/tunnel : filtre actif = non attribuable, pas total global inchangé présenté comme filtré.

Le rapprochement calcule l'écart entre agrégat et transactions comparables, sans forcer l'égalité. Un agrégat comptant ventes/commandes ou versements bancaires ne valide pas un CA encaissé client.

### 7.4 Nouveau client et LTV facultative

Choix technique : un nouveau client est une personne dont le **premier encaissement client positif settled est prouvé**, daté par ce paiement. Un remboursement ultérieur ne recrée pas une nouvelle acquisition lors du prochain paiement ; il diminue le revenu. Une contre-écriture qui prouve que le premier paiement n'a jamais été valide entraîne un nouveau calcul versionné, pas un effacement du résultat publié.

Preuve suffisante : historique transactionnel antérieur exhaustif dans le périmètre de clients concerné, ou indication source fiable du premier achat couvrant ce même périmètre. La complétude des dernières semaines ne suffit pas. La couverture d'un seul canal de paiement ne prouve pas l'absence d'achat par un autre canal existant.

Sans preuve : « premier paiement observé », sans incrémenter nouveaux clients confirmés ni le dénominateur coût publicitaire/nouveau client. Conserver le volume d'inconnus. Ne pas fabriquer une valeur zéro sur l'absence de clients confirmés avec historique tronqué.

LTV observée différable : somme des receipts par personne moins refunds liés, par cohorte de première acquisition prouvée, divisée par le nombre initial de personnes de cette cohorte. Les clients intégralement remboursés restent au dénominateur. Fenêtres 30/90/180 jours et date d'observation affichées ; les cohortes trop jeunes sont signalées. Pour les refunds tardifs, distinguer revenu à horizon de paiement et revenu corrigé des remboursements connus à la date du calcul. Ni valeur future prédite, ni marge, ni somme multi-devise.

## 8. Attribution et coûts : une règle V1 explicite

### 8.1 Modèle unique retenu

**Dernier contact non direct observé, fenêtre de 30 jours avant le fait d'acquisition ; observation de revenu à 90 jours après le contact d'acquisition.** Ces paramètres sont des propositions techniques explicites, stockées dans attribution_runs et visibles dans les résultats. First-touch, multi-touch, view-through et moteurs probabilistes sont différés.

Le fait d'acquisition d'une personne est sa première inscription réussie observée dans l'historique couvert. Si aucune inscription n'existe mais qu'un premier achat est prouvé, le premier paiement peut être l'ancre, avec origine « acquisition sans inscription observée ». Un événement d'inscription tardivement reçu peut changer cette ancre dans un nouveau calcul publié ; l'ancien subsiste.

Chercher des contacts observés dans [fait d'acquisition − 30 jours, fait d'acquisition], en excluant les contacts postérieurs. Un contact est une arrivée effective identifiable : pas un simple événement vidéo ou un clic supposé vu. Une égalité non départageable de contacts reste unknown ; pas de gagnant arbitraire. Un lien bio prouve la bio, pas le contenu qui aurait précédé.

Le dernier contact non direct comprend payé et organique. Un contact organique plus récent peut donc gagner sur une publicité ; on ne choisit pas « le dernier contact payé » en l'appelant last non-direct. Si le seul contact réellement connu est direct et que le lookback observable est couvert, classer direct. Une absence d'UTM ou de lien ne prouve pas direct. Données insuffisantes, identité ambiguë, mapping contradictoire : unknown avec motif.

Un ad ID présent dans une URL est une dimension observée, pas une preuve d'impression/clic vérifiée par Meta. Le rapport parle d'attribution observée et ne lui donne pas le statut de conversion certifiée par la plateforme.

### 8.2 Cibles et traçabilité

target_kind de attribution_results appartient à :

- acquisition : cible lead_registration, ou receipt du premier achat prouvé sans inscription ;
- lead : cible lead_registration, pour rattacher les sauvegardes/recaptures à l'ancre et dédupliquer par personne ;
- appointment_booked / appointment_held : cible appointment, avec preuve temporelle spécifique ;
- new_customer : cible receipt qui prouve le premier achat ;
- payment : cible receipt/refund/reversal pour les contributions financières.

Un CHECK associe exactement ces kinds à leur FK cible. L'ancre acquisition est unique par personne résolue et par run. Chaque résultat dérivé référence anchor_result_id ; un contrôle exige la même personne, le même run et target_kind='acquisition' pour l'ancre. Les résultats inconnus sont aussi conservés : ils expliquent le dénominateur et les exclusions.

Les paiements d'une personne nouvellement acquise **héritent** de son ancre ; ils ne choisissent pas un nouveau clic avant chaque échéance. Un refund hérite du receipt original ; impossible de l'attribuer à une campagne venue après la vente. Le revenu d'un client déjà acquis avant la cohorte ne rejoint pas le ROAS des nouveaux clients de cette cohorte.

Un calcul enregistre les paramètres complets, les faits cibles et leurs montants/statuts au cutoff, la preuve de premier client, les liens d'identité utilisés, les mappings et dimensions, les candidats examinés dans le lookback avec leur ordre/priorité, le contact retenu ou le motif d'échec. Le manifeste contient les IDs des snapshots de coûts et de couverture effectivement consommés. **Un hash seul n'est pas une preuve consultable.**

candidate_evidence_snapshot et target_snapshot contiennent seulement des champs techniques nécessaires, jamais des propriétés brutes de quiz ou de CRM. Le nombre de candidats peut être borné pour maîtriser le volume ; si la borne est atteinte, le calcul est incomplet et ne choisit pas silencieusement parmi une liste tronquée.

Un résultat publié se lit depuis ses snapshots, sans dépendre des tables courantes. Une arrivée tardive, un changement d'identité ou de mapping, ou une correction financière déclenche un nouveau run explicitement rattaché au précédent. Publication atomique de l'en-tête et de l'ensemble des résultats ; un calcul building/failed n'alimente pas le cockpit.

### 8.3 Cohortes et dénominateurs

Le sélecteur de performance d'acquisition utilise **la date du contact d'acquisition**, dans le fuseau natif du compte Meta pour un ratio publicitaire. L'activité CA garde sa date de paiement à Paris. L'écran nomme ces deux axes ; une même date civile n'est pas prétendue représenter le même intervalle quand les fuseaux divergent.

Pour une période D de contacts et un ensemble de publicités A :

- Dépense = toute la dépense de A durant D, y compris les clics sans lead. Jamais uniquement les publicités qui ont converti.
- Leads acquis = personnes avec première inscription observée dont l'ancre retenue appartient à A×D. Les réinscriptions restent visibles dans les leads d'activité, mais ne recréent pas une acquisition.
- CPA RDV pris / CPA RDV réalisé = dépense A×D / occurrences distinctes et prouvées du kind annoncé, rattachées aux personnes de la cohorte, dans l'horizon d'observation. Un emplacement Notion sans identité d'occurrence fiable rend ce ratio indisponible pour cette portion.
- Coût publicitaire par nouveau client = dépense A×D / nouveaux clients prouvés de cette cohorte, premier paiement dans l'horizon de 90 jours.
- ROAS attribué encaissé à 90 jours = encaissements de ces nouveaux clients durant [contact, contact+90 jours), corrigés des remboursements/contre-écritures connus visant ces encaissements à input_cutoff_at, divisés par dépense A×D.

Un paiement avant le contact ne rejoint jamais ce numérateur. Les paiements après 90 jours sont disponibles dans l'activité/LTV, mais exclus du ROAS à 90 jours. Un refund arrivé après l'horizon diminue la version ultérieure du revenu net de cette cohorte si son reçu appartient à l'horizon ; il reste daté de son propre jour dans le CA d'activité.

Les inscriptions peuvent arriver après D dans la limite du lookback de 30 jours ; elles restent dans la cohorte du contact. Une cohorte récente s'affiche « observée à ce jour », pas complète à 90 jours. La stabilisation des leads exige aussi que les contacts puissent avoir accompli leur délai de conversion observé.

Le CPL principal d'acquisition prend les **leads acquis** ci-dessus. Les leads uniques d'activité peuvent inclure des recaptures et n'ont pas le même axe de date. Ne pas présenter spend du mois / leads d'activité du mois comme le même CPL attribué.

Chaque ratio expose numérateur, dénominateur, période, fuseau, horizon, profil et couverture. Dénominateur zéro ou inconnu ⇒ NULL avec motif, pas zéro ni infini. Monnaies/base de taxe incompatibles ⇒ ratio indisponible. Les dépenses non répartissables par tunnel ne sont pas ventilées en fonction des conversions obtenues.

### 8.4 Couverture de l'attribution

Distinguer couverture de collecte, d'identité, de transaction, de premier client, de mapping et de dépenses. Un ratio utilisant seulement la fraction attribuée d'une source partielle doit porter **ROAS observé partiel**, avec les volumes/montants non attribués à côté ; il ne devient jamais le ROAS total.

Les remboursements orphelins ou manquants peuvent diminuer le numérateur ; un ROAS partiel n'est donc pas automatiquement une borne basse. Si le net n'est pas déterminable, afficher la contribution brute observée séparément et laisser le ROAS net indisponible.

Le CA global agrégé Wix ne remplit aucune ligne d'attribution individuelle. En l'état E:12, il permet du CA source ; ROAS client et LTV attendent le raccord transactionnel et l'identité. Cela n'empêche pas de construire les autres écrans descriptifs.

## 9. Meta : compte, jour, profils et fenêtres

Un profil de base pour ad_daily : niveau publicité, jour natif du compte, aucun breakdown et aucune conversion embarquée dans le calcul des dépenses. Un profil Meta conversions contient au minimum les fenêtres demandées, les paramètres use_account_attribution_setting / use_unified_attribution_setting quand utilisés, leur résolution effective connue, action_report_time, niveau, breakdown, version API et définition de l'action. Les noms exacts disponibles sont à valider par le connecteur, sans modifier le compte.

Une fenêtre combinée constitue **un profil**, pas une somme des fenêtres individuelles. Deux profils ne s'additionnent pas. Ni les familles purchase et omni_purchase, ni des actions imbriquées ne s'additionnent automatiquement : une définition canonique d'action est sélectionnée et affichée. Les compteurs unique_actions sont non additifs entre annonces/jours et restent au grain d'origine.

Les dépenses, impressions et clics sortants sont additionnables sur des partitions disjointes du même profil. CTR = somme clics sortants / somme impressions ; CPC = somme spend / somme clics sortants ; CPM = somme spend / somme impressions × 1000. Pas de moyenne des ratios par annonce. Si outbound_clicks manque, ne pas le remplacer par clicks tous types.

Le niveau compte/jour est contrôlé par des lignes source_aggregates dédiées lorsque la source le fournit. Un total de compte et la somme des annonces se comparent ; ils ne s'additionnent pas. Une annonce historique/archivée absente du catalogue courant ne doit pas disparaître des dépenses : créer sa dimension minimale lors de l'import d'insights.

Les lots de snapshots ad_daily et meta_conversions_daily sont publiés par partition compte+jour+profil après pagination complète. Pour une partition de conversions devenue vide après révision, le dernier lot complet vide remplace l'ancien lot non vide. La vue sélectionne d'abord le **lot**, puis ses lignes ; sélectionner seulement la dernière version des lignes laisserait des conversions périmées.

Une pub à destinations multiples ou dynamiques ne reçoit pas une destination unique inventée. source_mappings ad_destination porte une période réelle et sa preuve ; si la destination change en cours de journée sans dépenses horaires disponibles, le coût par tunnel de ce jour est non répartissable. Au total compte/campagne, cette dépense reste visible. Les noms courants de campagne sont des libellés, pas des clés historiques.

Si le fuseau du compte diffère de Paris, les séries Meta gardent leur jour d'origine. Les ratios d'acquisition utilisent ce fuseau annoncé et les instants de contacts convertis dans celui-ci ; on ne déplace pas des dépenses journalières entre jours sans détail horaire. Aucune séparation Instagram/Facebook ou par asset sans breakdown réellement disponible et profil séparé.

## 10. Idempotence, pagination et fraîcheur

### 10.1 Contrat de publication

Un import est une partition homogène. Un source_snapshot Notion couvre l'état observé à source_as_of ; un event_interval couvre l'intervalle réel d'événements ; un aggregate_period couvre la mesure agrégée et sa définition. Ne pas déduire ces trois couvertures les unes des autres.

Pipeline obligatoire :

1. Décrire source, namespace, flux, profil, partition et intervalle demandé dans sync_runs.
2. Lire toutes les pages ; stocker les faits idempotents ou les snapshots liés au run. Contrôler curseur qui boucle, tri instable, pages manquantes et rejets.
3. En transaction, publier les lignes normalisées avec leur version et valider la couverture réellement atteinte. Le checkpoint ne passe au-delà que de ce qui est durablement stocké.
4. Les métriques finales choisissent uniquement des partitions publiées. Les observations provisoires restent distinctes et explicitement partielles.
5. Sur échec, nouveau attempt lié à l'ancien ; reprendre ou relire une zone de chevauchement. Jamais déclarer toute la demande couverte parce qu'une première page a réussi.

Pour les miroirs courants comme prospects, des upserts paginés peuvent exposer des observations récentes avec leur provenance, mais la couverture globale reste partielle jusqu'à la fin du snapshot. L'import historique commercial est écrit dans la même transaction que la mise à jour de l'objet. Un état plus ancien reçu en retard ne remplace pas le courant : comparer la version source, sinon le conserver comme observation non ordonnée.

La sélection du dernier snapshot publié compare d'abord la version/watermark source, puis l'instant de lecture source, avec un ID de lot pour départager techniquement. Un import plus ancien qui termine plus tard ne prend pas la place d'une observation plus récente ; si leur ordre source ne peut être établi, signaler le conflit. Les curseurs et publications d'une même partition sont sérialisés.

Un flux transactionnel utilise les clés stables pour l'idempotence, mais les états pending→settled et les corrections nécessitent des mises à jour versionnées dans les preuves d'attribution. Un événement immuable avec même ID et payload différent n'est pas un simple retry. Les mapping_versions font partie du calcul ; rejouer les mêmes faits avec un mapping neuf est une nouvelle interprétation explicite.

Pour Meta, la reprise relit les partitions récentes jusqu'à la plus grande fenêtre d'attribution utilisée avec une marge technique explicite, et permet un backfill borné pour les révisions plus anciennes. Ne jamais déclarer les valeurs historiques immuables par principe. Les frais/remboursements nécessitent un flux d'updates ou leur propre intervalle de date, sans dépendre seulement de la date de création du paiement initial.

### 10.2 Lecture et fraîcheur de l'application

Les listes utilisent une pagination stable par (date métier, id), avec filtre et cutoff de lecture identiques sur les pages. Les compteurs/ratios sont calculés côté base sur tout le périmètre, **pas sur la première page** d'une liste de prospects ou paiements.

last_success_at n'est pas data_through. Afficher dernier import, dernier état source observé, intervalle couvert et nature de cette couverture. Un succès récent important de vieux événements ne rend pas la journée courante complète.

Le contrat de chaque KPI énumère ses dépendances : CA = transactions reçues/refunds ou agrégat adéquat ; nouveau client = identité+preuve historique ; show-up = dates+issues RDV ; ROAS = dépenses+ancrage+clients+cash+refunds. La fraîcheur et la couverture sont celles de toutes ces dépendances, pas le MAX des dates d'import.

L'absence de ligne vaut zéro uniquement avec couverture complète et une sémantique source qui garantit l'absence d'activité. Sinon NULL/partiel. Une publication complète vide doit exister comme partition dans sync_runs pour représenter un vrai zéro. Les périodes comparées utilisent les mêmes définitions et horizons de maturation.

## 11. RLS, privilèges et frontière serveur

Choix V1 : application privée unique, accès via serveur authentifié avec liste explicite d'utilisateurs autorisés. Une session Supabase valide quelconque ne suffit pas à autoriser la lecture BLG. Aucune table de multi-tenancy n'est nécessaire à ce périmètre.

RLS activée sur les 19 tables ; aucun GRANT métier pour PUBLIC, anon ou authenticated, aucune policy permissive. Contrôler aussi les séquences, vues et EXECUTE des fonctions ; définir les privilèges par défaut pour les objets futurs. Les vues sont créées security_invoker=true sur une version PostgreSQL compatible. Supabase rappelle que service_role contourne RLS et que les vues exigent leur propre protection. [RLS et vues Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security), [rôles Supabase](https://supabase.com/docs/guides/database/postgres/roles)

Les routes de lecture vérifient session **et autorisation BLG** avant tout appel privilégié. Le client ne reçoit que les données de l'écran demandé. Les secrets ne vont ni dans le bundle, ni dans les réponses ou logs. Ne pas prétendre que RLS protège un endpoint qui utilise service_role puis renvoie les données à tout visiteur.

Les RPC ne sont exécutables que par le rôle serveur prévu. Fonctions en SECURITY INVOKER par défaut ; si un besoin documenté impose SECURITY DEFINER, fixer search_path, qualifier les objets, réduire les droits et tester le contournement. Aucune fonction générique « execute SQL » ou import arbitraire.

La route publique d'observations accepte exclusivement les champs événementiels autorisés, impose limites de volume/taille, contrôle les versions et déduplique. Elle n'accepte pas de person_id confirmé, trust_level, effective_at financier ou source d'autorité depuis le corps navigateur. Les succès de sauvegarde viennent d'une communication de backend authentifiée ; leur preuve n'est pas créée par CORS. Aucun secret de service dans les snippets.

## 12. Requêtes et vues à livrer à la tâche CTO

Pas de table de KPI saisissable. Les vues simples exposent les faits canoniques ; les requêtes paramétrées reçoivent explicitement période, axe temporel, fuseau, filtres, devise, définition et, pour l'attribution, attribution_run_id.

| Vue / requête | Grain / résultat | Garde-fou principal |
|---|---|---|
| v_links_current | Un lien + sa dernière révision | Archivage du parent, ancienne révision toujours retrouvable. |
| r_person_resolution(cutoff) | Une clé d'identité → personne/ambiguïté | Affectations applicables au cutoff, preuve et version conservées. |
| v_events_canonical | Une occurrence canonique admissible | Source autoritaire ou ID commun, conflits visibles, aucune somme des miroirs. |
| v_visits | Namespace+session+tunnel | Plusieurs pages ≠ plusieurs visites ; statut identité visiteur distinct. |
| v_journeys | Namespace+journey+tunnel | Pas d'assemblage entre tentatives ; version page/étapes connue. |
| r_funnel_cohorts | Parcours entrés dans D, étapes et maturation | Fenêtre d'observation explicite, événements hors D nécessaires chargés. |
| r_video_coverage | Visiteur/parcours+vidéo/version+segment | Union des plages ; pas de durée fictive après seek. |
| r_leads_activity | Personnes uniques ayant une inscription dans D, global et par tunnel | Non-additivité des segments, inscriptions non rapprochées séparées. |
| v_prospects_current | Une fiche Notion | Rapprochement facultatif ; frais, santé et exports libres exclus. |
| v_commercial_timeline | Un état initial/changement observé | Temps source distinct du temps d'observation ; reimports idempotents. |
| r_appointments_activity | Occurrences fiables par dates booking/held, état courant séparé | Notion current_slot ne devient pas un historique exhaustif. |
| r_showup_cohort | Cohorte de RDV prévus passés, volumes et issues | Réalisés/(réalisés+absents), issues inconnues et reports visibles. |
| r_closing_cohort | Personnes reçues et engagements postérieurs dans l'horizon | Déduplication, ordre temporel, preuve de vente, pas de multiplication par RDV. |
| r_deals_signed | Engagements signés, montants contractés et devise | Sans jointure brute aux échéances ; états et base de taxe explicites. |
| v_cash_movements | Un mouvement canonique avec signe | pending exclu, receipt conservé après refund, anomalies séparées. |
| r_cash_activity | CA brut/refunds/net par date effective et devise | Sélection transaction OU agrégat compatible, jamais addition. |
| r_source_reconciliation | Une cellule source/période/définition/devise | Agrégat et somme transactionnelle comparables, écart et couverture. |
| r_first_customer_evidence | Une personne + premier achat prouvé/observé/inconnu | Historique tronqué ≠ nouveau client confirmé. |
| v_ad_daily | Une pub/jour/profil de base depuis le dernier lot complet | Lot complet vide remplace un ancien lot ; coûts comptés une fois. |
| r_meta_account_control | Compte/jour : total source vs somme ads | Aucun ajout du total de compte aux annonces. |
| r_meta_reported_actions | Pub/jour/action/profil sélectionné | Fenêtres et familles d'actions non additives. |
| r_paid_delivery | Dépenses, impressions, clics, CTR/CPC/CPM | Ratios de sommes, périmètres et devises compatibles. |
| r_attribution_trace | Une cible dans un run publié | Contact/preuves/paramètres/snapshots consultables, inconnus inclus. |
| r_acquisition_cohort | Personnes/ancre et actions à horizon dans A×D | Dépenses complètes de la cohorte et ancre unique, pas de CA ancien client. |
| r_acquisition_costs | CPL acquis, CPA action nommée, coût pub/nouveau client | Numérateur/dénominateur et maturité ; CAC complet = indisponible. |
| r_attributed_roas | Net attribué à horizon / spend de la cohorte | Héritage remboursements, première acquisition prouvée, partiel explicite. |
| r_source_coverage | Flux/partition/profil/intervalle ou snapshot | Dernier import ≠ couverture complète ≠ historique source. |
| r_data_quality | Conflits, non rapprochés, inconnus, doublons rejetés | Descriptif uniquement, aucun score ou diagnostic automatique. |
| r_ltv_observed, différée | Cohorte de clients + horizon + devise | Revenu net observé, dénominateur initial, maturité et refunds tardifs. |

Les requêtes de suivi détaillé sont paginées séparément des requêtes d'agrégation. Les filtres campagne/source/tunnel qui n'existent pas dans une source renvoient un état non répartissable. Les ratios ne font pas disparaître les exclusions dans un simple WHERE non documenté.

## 13. Scénarios de validation attendus

Ces tests sont des exigences pour la future implémentation. **Ils n'ont pas été exécutés en SQL dans cette revue documentaire.** Toutes les fixtures devront être synthétiques, sans identifiant ou montant réel.

| Cas | Résultat attendu |
|---|---|
| Une personne s'inscrit au quiz puis à la masterclass | Deux inscriptions ; un lead global dans la période ; un par tunnel ; une seule ancre d'acquisition. |
| Une inscription copiée dans collecteur, PostHog et source métier | Une inscription canonique ; preuves liées ; aucun triple comptage. |
| Deux sauvegardes réelles de la même personne dans la même seconde | Deux inscriptions, une personne ; pas de déduplication temporelle destructive. |
| Événement public déclarant « lead réussi » ou une personne confirmée | Observation rejetée ou non probante ; aucun lead canonique créé sans preuve backend. |
| Navigateur partagé et identité ambiguë | Pas de fusion ; volumes non rapprochés visibles. |
| Correction de fusion/séparation d'identité | Nouveau run d'attribution ; ancien résultat et ses preuves inchangés. |
| Deux sources/comptes utilisent le même ID externe | Deux objets grâce aux namespaces ; aucun rapprochement accidentel. |
| Parcours commençant avant minuit, lead après minuit | Cohorte d'entrée conserve le lead ; activité lead comptée à sa date de sauvegarde. |
| Deux parcours incomplets d'une personne | Aucun faux parcours complet obtenu par jointure personne seule. |
| Timestamps d'étapes égaux et absence d'ordre fiable | Ordre indéterminé exposé ; pas de funnel complet inventé. |
| Notion livre une date de RDV initiale puis la remplace | Historique observé avant/après ; pas de nouveau RDV distinct sans preuve. |
| Report avec ID stable / remplacement par ID relié | Même occurrence ou chaîne prouvée ; pas deux présences, reports visibles. |
| Statut Closé sans deal/paiement ; réalisé sans heure réelle | Compteur commercial seulement ; aucune vente/recette/heure réelle inventée. |
| Vente antérieure à un rendez-vous réalisé | Ne rejoint pas son closing de cohorte. |
| Un deal en plusieurs échéances | Un montant contracté ; encaissements par échéance ; au plus un nouveau client. |
| Historique de paiements commençant au milieu de la relation | Premier paiement observé ; nouveau client et CAC client non prouvés. |
| Paiement partiellement remboursé puis nouvelle échéance | Net exact ; aucune nouvelle acquisition ; ancre conservée. |
| Refund arrivé après l'horizon de revenu | CA d'activité au jour du refund ; nouveau snapshot de cohorte corrigé sur le reçu initial. |
| Refund avant son receipt à l'import, ou parent inconnu | Refund conservé ; CA activité possible selon couverture ; attribution inconnue. |
| Deux refunds concurrents dépassent le reçu | Contrôle sous verrou ; anomalie explicite, aucun net réconcilié faux. |
| Reçu devenu « refunded » chez la source | Reçu conservé et remboursement déduit une fois. |
| Reçu visible dans deux outils sans clé de rapprochement | Une seule autorité utilisée ; pas de UNION de flux superposés. |
| Agrégat Wix mensuel + transactions partielles du mois | Agrégat ou transactions validées ; jamais leur somme, jamais de répartition journalière fictive. |
| Agrégat global sous filtre campagne | Non attribuable ; aucun montant global présenté comme montant de campagne. |
| Source TTC inconnue, devise différente ou DST | Mesure qualifiée/indisponible si incompatible ; bornes exactes, aucune somme multi-devise. |
| Deux fenêtres Meta et deux bases de date de conversion | Profils séparés ; spend compté une seule fois ; conversions non additionnées. |
| Une partition Meta devient vide après révision | Dernier lot complet vide sélectionné ; anciennes actions supprimées de la vue courante. |
| Campagne sans conversion et publicité archivée avec spend | Leur dépense reste au dénominateur du bon périmètre. |
| Pub change de tunnel dans la journée | Coût du jour non répartissable au tunnel ; total compte conservé. |
| Pagination interrompue, curseur répété ou mapping inconnu rejeté | Import partiel/échec ; aucune couverture globale ni zéro fabriqué. |
| Le premier écran reçoit seulement une page de paiements | Total calculé sur tout le périmètre côté base, pas sur la page reçue. |
| Ancien client clique une nouvelle publicité avant une échéance | Échéance reste rattachée à son acquisition ; pas au ROAS nouveaux clients de la nouvelle publicité. |
| Refunds manquants ou non rapprochés | ROAS net incomplet/indisponible ; pas annoncé comme borne basse garantie. |
| Dernier contact organique après contact publicitaire | Modèle last non-direct attribue à l'organique ; pas de préférence payante cachée. |
| Observation vidéo avec seek, retry, recouvrement et deux versions | Union des plages réellement lues ; versions et dénominateurs séparés. |
| Accès anon, utilisateur connecté hors liste, vue ou RPC directe | Refus ; l'utilisateur applicatif autorisé passe par le serveur. |
| Écriture publique d'un montant ou d'une identité confirmée | Refus ; seule l'ingestion autorisée peut produire ces faits. |
| Deux créations concurrentes d'une révision de lien | Contrôle de version ; une réussite, un conflit explicite ; aucune mutation d'ancienne URL. |

## 14. Corrections recommandées sans ajout de tables

- Indexer les FK et les recherches dominantes : events(namespace,journey_id,occurred_at,id), events(person_identity_id,occurred_at,id), lead_registrations(person_id,saved_at,id), appointments(scheduled_start_at,id), payments(effective_at,id), payments(original_payment_id), ads(account_namespace,external_ad_id), et sync_runs(source_namespace,stream_key,partition_key,status,finished_at).
- Stocker la révision des définitions et mappings dans les résultats ; afficher un changement de version lorsqu'il modifie une comparaison de période.
- Limiter taille des propriétés et snapshots, conserver les données strictement nécessaires ; pas de JSON libre de fiches commerciales ni de quiz.
- Séparer signal de fraîcheur, preuve de couverture et volume observé dans le contrat de réponse, au lieu de plusieurs états implicites selon l'écran.
- Documenter la durée de conservation des observations techniques et la conservation des snapshots d'attribution suffisante à leur explication. Aucune purge automatique qui casse une preuve référencée.
- Garder les vues en SQL simple et les paramètres de calcul dans un module déterministe testé. Différer cache, partitionnement physique, multi-touch, allocations de marge et moteur de règles administrable.

## 15. Plan de correction, dans l'ordre

| Étape | Responsable attendu | Modification précise | Preuve de sortie |
|---|---|---|---|
| 1 | Coordinateur | Intégrer ce verdict en tant que revue technique ; conserver D comme décisions utilisateur ; référencer R à chaque reprise. | Proposition mise à jour avec 19 tables et liste explicite des choix techniques. |
| 2 | Coordinateur / CTO | Compléter grains, PK/FK/UQ, enums et invariants selon §5–7 ; fermer les cas namespace, identité, RDV courant, refunds et premier client. | Contrat sans champ métier décisif implicite ni FK polymorphe libre. |
| 3 | CTO | Décrire source_aggregates et l'autorité financière ; définir le contrat des flux et partitions sync_runs. | Les cas Wix sans transactions et Notion sans historique ont une sortie correcte. |
| 4 | CTO | Décrire le modèle unique d'attribution, ses 30/90 jours explicites, ancre, snapshots et dépendances de couverture ; nommer CPL/CPA/coût pub/client. | Une conversion, son origine, ses montants et la dépense utilisée sont retraçables dans un run publié. |
| 5 | CTO | Fermer les profils Meta, sélection du dernier lot complet, cas des lots vides et dépenses non répartissables. | Aucune multiplication des dépenses ou addition de fenêtres. |
| 6 | CTO | Définir privilèges, RLS, vues, RPC et routes serveur ; préparer les fixtures synthétiques de §13. | Matrice allow/deny et attentes chiffrables avec données synthétiques. |
| 7 | Relecture du contrat corrigé | Vérifier B1–B8 et la cohérence des requêtes §12 contre les cas §13. | Alors seulement : verdict « prêt pour écrire la migration ». |
| 8 | Tâche de construction dédiée | Écrire la migration locale et exécuter contraintes, droits et scénarios sur PostgreSQL de test. | Résultats effectifs des tests, version PostgreSQL et limites restantes documentés. |

La connexion SQL distante et les accès aux sources manquants sont des dépendances d'exécution, pas des raisons de remplacer les données manquantes par des suppositions. La rédaction puis les tests locaux peuvent être préparés après correction du contrat. Aucun verdict de cette revue n'autorise d'application distante.

## 16. Contrôle de cette livraison

Périmètre relu : les quatre documents du coordinateur, les décisions/règles du dépôt BLG et le contrat historique. Rapport produit dans un checkout local distinct, cloné depuis le dépôt produit local sans récupération distante. Celui-ci était vide au début de la mission et avait reçu son socle documentaire local au moment du clone ; seuls ces fichiers de base ont été matérialisés dans le checkout de revue. Aucun fichier de travail du coordinateur modifié.

Empreintes SHA-256 des documents examinés :

| Document du coordinateur | SHA-256 |
|---|---|
| docs/SCHEMA-PROPOSE.md | f4dd282dddf3fa842756bb94ba02bcb025a2b697b8618ea97a317e0e9c2b70e3 |
| DECISIONS-ACTEES.md | cad85964895da67b32b445d469639d427670103ccb4372a29321010384b3f8f8 |
| docs/ETAT.md | 0af2db0b6bac899979f5e04cc35ce72460986b995aa626eaa7b4a2b42c91b05f |
| AGENTS.md | e895e25001d0d5a537f462f5b6360197190ffc7cc58a75a05b32182c8f17aecb |

Le contrôle final retrouve les mêmes empreintes pour SCHEMA-PROPOSE.md, DECISIONS-ACTEES.md et AGENTS.md. Le coordinateur a actualisé ETAT.md pendant la revue ; sa nouvelle empreinte est c5f05797b6a28ad3e70638724ccbb97f8e9e7d58fe62f332e63a076300b4ee51. Cette modification externe a été relue et intégrée au paragraphe d'actualisation Meta ci-dessus.

Ces empreintes identifient la version relue ; si le coordinateur poursuit son travail, une nouvelle version doit être comparée avant de lui transférer le verdict. La revue est documentaire : aucun résultat de test PostgreSQL, aucune intégration ou couverture métier n'est prétendu acquis.

**Verdict final sur cette version : à corriger.** Le plan ci-dessus conduit à un contrat prêt pour écrire la migration, sans imposer de microservices, de tables de KPI ou de grains spéculatifs.
