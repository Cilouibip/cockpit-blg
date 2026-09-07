# Contrat métier et mesure — V1

Lire `../DECISIONS-ACTEES.md`, puis `SCHEMA-REVU.md` et les sections 5–14 de `REVUE-INDEPENDANTE.md`. Les paramètres techniques ci-dessous reprennent ce contrat ; ils ne constituent pas de nouvelles décisions attribuées à Mehdi. Toutes les fixtures du dépôt sont synthétiques.

## Types et frontières

`src/domain/models.ts` sépare inscriptions réussies, personnes, rendez-vous, engagements, mouvements financiers, contacts d'acquisition et agrégats. Les noms du domaine sont en camelCase ; les routes d'ingestion utilisent le contrat JSON snake_case décrit ci-dessous. Les adaptateurs de persistance convertissent explicitement vers le schéma SQL.

Chaque ligne importée conserve source, namespace/compte, identifiant externe, dates d'observation et de mise à jour source, version de connecteur et identifiant du run. Une clé de dédoublonnage est le triplet `(source, accountId, externalId)`, jamais `externalId` seul. La source reste autoritaire sur ses faits ; l'application expose les rapprochements manquants.

Un événement navigateur prouve uniquement une observation reçue. Le collecteur ne prend ni réponses de quiz, ni identité confirmée, ni montant. Un enregistrement canonique est créé exclusivement par un backend signé après une sauvegarde métier. Une copie PostHog n'est pas une deuxième sauvegarde. Ne pas transformer une proximité temporelle entre événements en identité commune.

## Règles de calcul exécutables

| Fonction | Sortie et limites |
|---|---|
| `parisPeriod` | Convertit chaque date de frontière en minuit Paris UTC ; `[début, fin)` ; DST 23/25 heures vérifié. |
| `moneyFromDecimal` / `sumMoney` | Unités mineures exactes, exposant explicite ; dépassement et mélange de devises refusés. |
| `leadMetrics` | Inscriptions sauvegardées, personnes identifiées uniques et inscriptions sans identité séparées. Total global `null` si incomplet/non résolu. |
| `appointmentMetrics` | Cohorte par date prévue ; réalisés seulement avec date/provenance de présence. Reports, annulations, absences et inconnus conservés ; show-up = réalisés/(réalisés+absents), avec volumes. Ce n'est pas l'activité par date réalisée. |
| `cashMetrics` | Mouvements settled par date effective, brut/refunds/net, devises séparées. Bases fiscales mélangées = null ; `normalizedNet` exige TTC et couverture complète. Aucun zéro créé sur une réponse vide. L'appelant fournit un flux transactionnel canonique réconcilié. |
| `contractedMetrics` | Engagement signé distinct des échéances ; montant/provenance/base de taxe nécessaires ; devises et bases séparées. |
| `newClientMetrics` | Première recette settled seulement avec définition explicite et historique suffisant. Historique tronqué : inconnu. Une échéance ou un refund ne crée pas de nouveau client. |
| `selectCashAuthority` | Sélectionne les transactions complètes réconciliées OU un agrégat exact compatible. Ne les additionne jamais. Un filtre campagne absent des dimensions de l'agrégat rend la valeur indisponible. |
| `attributeCohort` | Modèle décrit ci-dessous ; renvoie candidats, cibles et manifeste consultables, pas seulement un hash. |
| `watchedSeconds` | Union d'intervalles lus pour UNE vidéo/version ; rejette les intervalles invalides ; aucune somme d'une position de lecture. |
| `advertisingCostPerAction` | Coût publicitaire par action explicitement nommée ; exige cohorte commune, maturité et couverture. Ne fournit jamais un CAC complet. |

Le CA normalisé demande du TTC net de remboursements avant frais de prestataire. Une base inconnue demeure une mesure source étiquetée ; elle ne suffit pas au CA normalisé. Les écritures de contrepassation et anomalies financières sont traitées dans le contrat SQL, pas devinées depuis un statut. Un remboursement orphelin peut réduire l'activité de cash ; il ne peut pas fournir d'attribution connue.

Le coût publicitaire par nouveau client ne se nomme pas CAC complet. Un CPA nomme son action et sa cohorte. Les ratios demandent le même périmètre et affichent leurs volumes ; dénominateur nul ou inconnu = `null`. Le domaine n'effectue aucune recommandation, score de qualité commerciale ou prédiction de LTV.

## Attribution observée

V1 technique : `last_non_direct`, lookback 30 jours avant la première inscription canonique observée, revenu à 90 jours **après le contact retenu**. Une première recette prouvée peut remplacer l'inscription absente ; l'appelant garde sa preuve. Seuls `landing_arrival` et `page_view` constituent des candidats ; vidéo, clic bilan et réussite de formulaire ne sont pas des contacts d'arrivée.

Le dernier contact non direct peut être organique ou payé. Un contact organique plus récent gagne sur une publicité. Si seuls des contacts directs sont connus dans une collecte complète, la source reste directe. Sans preuve de direct, elle reste inconnue. Deux contacts simultanés sans séquence source fiable ne sont pas départagés par UUID : résultat inconnu.

La cohorte suit la date du contact. Une inscription après la fin de période peut appartenir à cette cohorte ; l'activité des leads suit séparément sa date d'inscription. La dépense fournie au calcul couvre **toutes** les annonces du périmètre et de la période, même sans conversion. L'horizon de revenu commence au contact, pas à la facture ou à l'inscription.

Les échéances héritent de l'ancre initiale ; une publicité cliquée avant une échéance ultérieure ne récupère pas ce revenu. Un refund rattaché à un receipt admissible corrige cette cohorte même après ses 90 jours, selon le cutoff du nouveau calcul. La première acquisition client doit être prouvée ; revenu d'ancien client, devise/base incompatibles, refund orphelin, collecte ou identité incomplète rendent le ROAS net indisponible. Une cohorte récente peut exposer le revenu observé mais pas un ROAS complet à 90 jours.

Le manifeste fournit les IDs de snapshots d'identité, mapping, coûts et couverture, avec cutoff. Les cibles financières et candidats sont copiés dans le résultat. Les données courantes ne doivent jamais réécrire une publication passée. Le stockage publie atomiquement en-tête et résultats dans `attribution_runs/results`. Le module ne publie pas lui-même : une application doit lui fournir les preuves et persister sa sortie immuable. Sans source transactionnelle réconciliée, ce calcul demeure indisponible dans le produit.

## JSON navigateur — `/api/ingest/events`

Les champs obligatoires sont `event_id` UUID, `schema_version:1`, `occurred_at` ISO avec offset, `anonymous_id`, `session_id`, `journey_id` UUID, `tunnel` (`quiz` ou `masterclass`), `link_revision_id` UUID ou null, `page_version`, `event_name`, `properties`. `ad_id`, `adset_id` et `campaign_id` sont facultatifs et uniquement numériques lorsqu'ils existent.

| Événement | Propriétés autorisées |
|---|---|
| `landing_arrival`, `page_view` | objet vide |
| `quiz_started` | objet vide |
| `quiz_question_viewed`, `quiz_question_answered` | `question_number` entier 1–12 ; jamais la réponse |
| `quiz_completed`, `lead_form_viewed` | `answered_count:12` |
| `lead_form_submitted`, `result_viewed` | objet vide |
| `masterclass_optin_submitted` | objet vide |
| `video_started` | `video_id`, `video_version`, `playback_id` UUID |
| `video_watch` | mêmes IDs + `duration` secondes + 1–30 `intervals` `{start,end}` ; intervalle au plus 30 secondes, contenu dans la durée |
| `bilan_clicked` | objet vide |

Le schéma Zod est strict sur l'enveloppe et les propriétés. Un nom/type inconnu, `person_id`, `trust_level`, montant, email, URL complète ou réponse personnelle est rejeté. La route contrôle taille, débit global et par session, origine et date. CORS protège l'usage navigateur ; il n'authentifie pas un fait métier. Une réponse HTTP d'acceptation ne certifie pas le comportement humain.

Les IDs Meta viennent des valeurs observées `meta_ad_id`, `meta_adset_id`, `meta_campaign_id` ; les macros non substituées sont omises. `blg_link_id` est une révision opaque du registre de liens. Une bio désigne cette bio, sans attribution automatique au contenu précédent.

## JSON backend signé — `/api/ingest/leads`

Le contrat `serverLeadSchema` exige `event_id`, `schema_version:1`, `event_name:'lead_registered'`, `registered_at`, `tunnel`, `source` (`wix` ou `first_party`), `source_account_id`, `external_id` de sauvegarde stable, `journey_id`, `anonymous_id`, `session_id`, `link_revision_id` nullable et `identity:{namespace,external_id,email?}`. L'email facultatif est transmis uniquement du backend métier au backend cockpit pour produire immédiatement un HMAC ; il ne demeure ni dans les événements ni dans les journaux.

En-têtes : `x-blg-timestamp` secondes Unix et `x-blg-signature`, HMAC SHA-256 hex de `timestamp + '.' + corps JSON exact`, secret serveur d'au moins 32 caractères. Tolérance cinq minutes, comparaison à temps constant. La même sauvegarde garde ses IDs et son corps au retry, avec un nouvel horodatage de signature. La base doit aussi refuser le même ID avec un contenu différent. Les signatures seules ne remplacent pas la déduplication.

La normalisation d'email supprime les espaces aux extrémités, applique NFC et minuscules ; elle ne retire ni points ni suffixes `+`. Le secret HMAC est versionné côté serveur. Nom identique, IP et appareil commun ne prouvent pas une personne commune.

## Installation des snippets

Les modules complets sont dans `tracking/` : `collector.js`, `quiz.js`, `masterclass.js` et `server-lead.mjs`. Le déploiement et le raccord aux callbacks réels appartiennent aux responsables des pages, après livraison de l'URL du cockpit. Aucun de ces fichiers n'a été installé sur les pages publiques durant cette tâche.

1. Copier les modules navigateur dans le projet de page. Passer à `instrumentQuiz` ou `instrumentMasterclass` l'URL déployée terminant par `/api/ingest/events` et la version de page.
2. Quiz : appeler `start`, `questionViewed`, `questionAnswered` depuis le parcours existant ; `showCoordinates` seulement après les 12 questions. `submitCoordinates` reçoit le callback de sauvegarde existant et n'affiche le résultat qu'après `{saved:true}`. Ne pas modifier les textes, ordre des questions ou moment de capture.
3. Masterclass : `submitOptin` appelle la sauvegarde existante puis révèle la vraie vidéo sur la même page. Le module reçoit le `HTMLVideoElement`, l'ID/version vidéo et le bouton bilan. Les players iframe exigent leur API officielle : ce module ne prétend pas lire leur progression.
4. Backend : enregistrer une ligne outbox avec l'inscription et ses IDs stables, puis appeler `sendSavedLead` après la sauvegarde. Une livraison échouée conserve l'outbox pour reprise ; ne pas annuler l'inscription réelle parce que l'analytics est indisponible. Utiliser le gestionnaire de secrets du backend de page ; jamais le secret dans le JavaScript navigateur.
5. Conserver la mesure PostHog existante. Aucun transfert vers PostHog ni export payant n'est activé par ces fichiers. Un seul émetteur d'observations canoniques doit être choisi lors du raccord pour éviter les copies additionnées.
6. Vérifier un parcours synthétique complet avant activation : réseau sans réponses personnelles, même ID au retry, succès signé après sauvegarde, vidéo avec seek, absence de résultat avant capture.

Le collecteur expire la session après 30 minutes d'inactivité. Les tentatives ont des `journey_id` séparés. Le stockage navigateur bloqué utilise des IDs mémoire et réduit la couverture ; aucun raccord inter-domaines ou inter-appareils n'est deviné. La vidéo échantillonne des intervalles continus, coupe aux seeks/pauses/onglets cachés, fusionne les recouvrements au calcul et distingue les versions. Une perte à la fermeture reste une limite de collecte exposée, pas du temps regardé reconstitué.

## Validation effectuée

`tests/domain.test.ts`, `tests/domain-tracking.test.ts` et `tests/connectors.test.ts` couvrent données synthétiques, frontières DST, identités, échéances/refunds, reports, attribution, fenêtres/cohortes, source financière exclusive, schémas stricts, signatures, ordre quiz, opt-in et lecture réelle avec seek, pagination, erreurs et checkpoints. Le test des snippets exécute leurs callbacks avec des surfaces navigateur simulées ; la validation visuelle de l'application et les tests PostgreSQL sont des preuves distinctes tenues par l'intégrateur.

## Préparation et publication d’un périmètre

Le serveur `publishScopedAttribution` lit les preuves persistées du compte, les transmet au préparateur pur, puis publie dans la même fonction atomique que le global. Les périmètres `meta:campagne`, `meta-ad:publicité` et `meta-creative:créative` exigent un coût explicite chaque jour, une couverture de compte complète et un profil cohérent. La somme compte doit correspondre au global ; aucun coût n'est sélectionné seulement parce qu'il a une conversion. Une créative exige les métadonnées complètes du compte. Le filtre tunnel attend un mapping versionné disponible.

Le choix du dernier contact est effectué sur le global avant de retenir les personnes du périmètre. Les contacts candidats, l'ancre, les échéances et remboursements conservent leur filiation. Les publicités, coûts et synchronisations utilisés sont figés dans le manifeste. Le publisher direct refuse un scope filtré non passé par ce préparateur.
