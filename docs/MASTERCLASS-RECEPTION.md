# Réception de la fiabilité du parcours masterclass

État du 6 octobre 2026 : corrections locales du contrat Notion et du raccord inscription → rendez-vous en revue. Ce document ne constate ni mise en service ni fiabilité automatique. Le coordinateur reçoit les preuves de bout en bout ; les auteurs ne valident pas seuls leur lot.

## Objectifs

Préserver le parcours page → inscription → vidéo → réservation, ses filtres et ses sources existantes. Corriger les causes confirmées : dépendance aux noms visibles des propriétés Notion, réservation ancienne rapprochée d'une inscription récente, et reprise après interruption. Les finances restent hors de ce lot.

## Critères de succès

- Contrat Notion attaché aux propriétés stables : un renommage seul conserve les données et la preuve de dépendance. Champ remplacé, absent, ambigu ou incompatible : erreur explicite, aucune publication déclarée complète.
- Formule inconnue : relecture complète de sécurité conservée. Les chaînes et les dépendances ne sont pas normalisées au point de changer leur sens.
- Conversion : une identité prouvée et une réservation chronologiquement postérieure à l'inscription retenue sont nécessaires. Les réservations différées restent valables sans nouvelle fenêtre arbitraire. Une date sans heure le même jour ne prouve pas l'ordre.
- Une réservation orpheline hors cohorte ne contamine pas les personnes liées. Une incertitude concernant un membre de la cohorte reste explicite en interne ; aucune conversion, origine ou heure inventée.
- Compteur, liste et taux utilisent les populations prévues par le contrat existant ; un taux limité par la couverture ne devient pas le ratio de deux compteurs qui ont une autre couverture.

## Critères d'échec

Perte d'une date ou d'un identifiant après normalisation, faux zéro, doublon, mélange d'identités ou de périodes, données sensibles dans le dépôt, arrêt de reprise masqué, modification des sources externes ou de la définition métier. Un test local réussi, une réponse HTTP200 ou une relance manuelle ne prouve pas l'automatisation.

## Tests

- Contre-exemples : renommages, identifiants encodés/décodés dans toute la chaîne, champ absent/type incompatible, formule inconnue et chaînes dont les espaces sont significatifs.
- PostgreSQL réel isolé : nouveau contrat impose la relecture requise, renommage suivant préserve le delta, formule inconnue force full, interruption/rejeu ne publie pas un résultat incomplet.
- Raccord : ancien RDV + réinscription, ancien et nouveau RDV, réservation différée, date seule, fuseau Paris, identité ambiguë, positif + candidat incertain et orphelin hors cohorte y compris si aucun autre rendez-vous n'est lié.
- Vérifications intégrées : typage, tests, compilation, migrations et reprises sur base synthétique. Comparaison avec les sources réelles effectuée séparément, en lecture seule et dans les preuves privées.

## Roadmap

1. Cadrage, causes et contre-revue des critères : reçus, réserves d'automatisation conservées.
2. Corrections locales et contre-revue indépendante : en cours. Les contre-exemples découverts par la revue doivent être corrigés avant publication.
3. Mise en service : seulement après revue et vérifications intégrées. Contrôler le commit réellement déployé puis la publication complète du miroir. Comparer événements source et cockpit à période/coupure identiques ; ne pas confondre total source et conversions attribuées.
4. Cadence/reprise/surveillance : encore à recevoir. Mesurer la couverture par source, espace, flux, profil, période, population et exclusions ; ne pas utiliser seulement la dernière heure de traitement. Distinguer les nouveaux événements, modifications et disparitions d'inventaire. Prouver capacité au volume réel et détection du silence du collecteur.
5. Observation : au moins sept jours consécutifs incluant un week-end, sans relance humaine, après référence source et mécanisme automatique reçus. Conserver les trous et incidents dans la preuve ; pas de sélection des seuls jours réussis.

## Ce qu'il ne faut pas faire

Aucune écriture Notion/Wix/Meta, aucun accès n8n, interface Calendly ou compte Vercel, aucune nouvelle inscription de test, aucun changement de finance, de campagne ou de suivi navigateur dans ce lot. Pas de secret ni d'export CRM dans Git. Pas de purge ou reset du miroir. Une architecture engageant un autre outil ou coût doit être arbitrée séparément.

En cas de régression, conserver le dernier miroir publié et les preuves. Un retour au commit précédent doit être testé ; il rétablit aussi ses défauts connus et ne constitue donc pas, à lui seul, une restauration de la fiabilité. Ne pas supprimer les checkpoints ou forcer une publication partielle pour obtenir un indicateur vert.
