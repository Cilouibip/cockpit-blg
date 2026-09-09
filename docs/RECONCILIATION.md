# Recette et réconciliation

Le code est testé sur des fixtures synthétiques ; cette recette reste à exécuter sur les sources raccordées avant de considérer les mesures réelles exhaustives. Les tests nommés dans les fichiers sont les preuves exécutables. Lire `../DECISIONS-ACTEES.md`.

| Cas | Résultat exigé | Preuve locale |
|---|---|---|
| Même personne dans quiz et masterclass, retries d'envoi | Deux inscriptions, une personne ; un retry n'ajoute pas de ligne | domain, PostgreSQL et HTTP |
| Navigateur déclare une inscription réussie | Refus ; seul le backend signé crée le succès canonique | domain-tracking, HTTP, PostgreSQL |
| Même identifiant externe dans deux comptes | Namespaces conservés ; aucun rapprochement implicite | PostgreSQL |
| Identité contradictoire | Inconnue/ambiguë, sans réaffectation silencieuse | PostgreSQL |
| Modification ou archivage de lien | Nouvelle révision/archivage ; URL antérieure inchangée | links, PostgreSQL, navigateur |
| Deux modifications concurrentes | Une seule version gagnante ; conflit explicite | PostgreSQL |
| Date Notion remplacée, relance d'une page | Historique avant/après ; aucun RDV distinct inventé | connectors, PostgreSQL |
| Rendez-vous sans preuve de présence | Pas de RDV réalisé ; emplacement Notion séparé | domain, dashboard |
| Échéances puis remboursement ou contrepassation | Somme nette cohérente ; aucun client par échéance | domain, PostgreSQL |
| Refund sans parent/devise incompatible/correction du reçu | Non réconcilié ou anomalie ; pas de CA validé | PostgreSQL |
| Agrégat source et transactions disponibles | Une seule autorité ; jamais leur addition | domain, dashboard |
| Fin de mois Paris / changement d'heure | Bornes UTC calculées depuis le calendrier Paris | domain, dashboard |
| Meta partiel, vide, retry et profils | Lot complet sélectionné avant ses lignes ; vide distinct de zéro | connectors, PostgreSQL |
| Saut/relecture vidéo ou autre version | Union des intervalles réellement lus ; versions séparées | domain-tracking, dashboard |
| Vue question et réponse dans deux tentatives | Aucun appariement entre tentatives | dashboard |
| Attribution corrigée après publication | Nouveau snapshot ; précédent immuable, cibles/FK cohérentes | domain, PostgreSQL, dashboard |
| Plus de 10 000 événements, filtre après le seuil,15 005 prospects | Total exact en SQL, pages séparées et recherche globale | dashboard-sql, pagination, dashboard-read, UI ciblée |
| Campagne A puis B, publicité sans conversion, créative absente | B garde l’acquisition ; toutes les dépenses du périmètre comptent ; créative manquante refusée | attribution-scope, attribution-publication |
| Accès anonyme, origine étrangère, brute force | Refus ; aucune fuite de réponse source | security, HTTP, PostgreSQL |

## Avant lecture financière réelle

- Identifier la source financière canonique et son namespace ; rapprocher reçu, remboursement et contrepassation avec les totaux source sur la même période Paris.
- Vérifier devise, exposant monétaire, base HT/TTC, date effective, statut et couverture des paiements ET remboursements. Un total brut ne devient pas du net ; un agrégat incompatible reste séparé.
- Relier les paiements à la personne sans noms approximatifs. Prouver le premier achat à partir d'un historique antérieur exhaustif ou d'une preuve source équivalente.
- Valider le montant signé et sa date séparément des échéances encaissées. Les valeurs contractées sont des observations explicites, pas une garantie d'exhaustivité du registre.
- Réconcilier compte Meta, fuseau, devise, publicités/jours et profil ; ne pas répartir la dépense entre tunnels sans mapping versionné.
- Publier un calcul d'attribution avec les identités et mappings au cutoff, les dépenses de la cohorte et les preuves de première acquisition. Expliquer les inconnus et conserver les preuves.

## Limites visibles prévues

Les principaux résultats distinguent activité à la date effective et cohorte de contacts. Les étapes de parcours mesurent des observations par tentative ; elles ne prétendent pas à une progression séquentielle reconstituée. Les questions et versions vidéo sont détaillées sans données sensibles.

Le CA, le ROAS et le coût par nouveau client sont comparables entre périodes si chaque période possède les preuves requises. Les comparaisons d'observations partielles (leads, RDV, diffusion) restent suspendues en mode réel en attendant une couverture comparable. L'interface signale la période précédente et n'invente pas un pourcentage à partir d'une valeur manquante.

Le CPL attribué, les nouveaux clients globaux, le closing par cohorte et le CAC complet restent indisponibles tant que les dépendances correspondantes ne sont pas raccordées. Les conversions rapportées par Meta, créatives et appareils ne sont pas automatiquement déduits des clics. Instagram natif est reporté et la LTV est facultative. Aucun diagnostic automatique n'est produit.

## Contrôles métier de la reprise

Chaque total Notion doit conserver sa balance fiches datées = identifiées + sans identité + copies d’identité, et créations seules à part. Les RDV sont balancés entre présences selon groupe, absences, annulations et autres ; seuls présence + absence forment le taux de présence. Les dates contradictoires ne produisent pas de conversion. La complétude d’un scan courant ne certifie pas l’historique exhaustif des créneaux.

Les reçus Wix sont balancés entre positifs inclus et autres parents exclus, avec remboursements séparés. Rapprocher les IDs fournisseur avec les paiements historiques avant tout cumul intersource. Une période entièrement importée dans Wix ne démontre pas le CA global ; la carte conserve sa valeur connue avec périmètre partiel. Un titre de paiement répété n’est pas une preuve de copie.
