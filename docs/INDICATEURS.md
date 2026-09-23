# Indicateurs du cockpit utiles au pilotage Masterclass

Fiche de définition des chiffres affichés, limitée au lot urgent. Elle reprend les définitions déjà en vigueur dans le code (audit du 23 septembre 2026) et n'en crée aucune. Les ambiguïtés connues sont listées en fin de fiche, ouvertes, sans arbitrage.

Conventions communes : jours Europe/Paris ; essais explicitement marqués exclus sauf option « Inclure les essais » ; une valeur non mesurée s'affiche « Non disponible » ou « Non mesuré », jamais zéro ; la fraîcheur de chaque source est celle de sa dernière lecture complète.

## 1. Parcours Masterclass (cinq étapes)

| Étape | Ce qui est compté | Unité | Source | Base de date | Exclusions | Fraîcheur |
|---|---|---|---|---|---|---|
| Visitent la page | Visiteurs navigateur regroupés (identifiant visiteur, sinon navigateur, sinon session) ayant vu /masterclass26 | visiteurs | PostHog, lecture directe à l'ouverture | événements dans la période | essais, événements sans identifiant | heure de la lecture |
| Ouvrent le formulaire | Visiteurs ayant ouvert le formulaire | visiteurs | PostHog | idem | idem | idem |
| S'inscrivent | Inscriptions confirmées du formulaire Masterclass actif, regroupées par personne reliée, sinon par visiteur ou session | personnes inscrites | Wix (inscriptions publiées) + antériorité Notion | date de soumission dans la période | essais, formulaires non actifs, statut non confirmé | dernière lecture complète des inscriptions Wix |
| Démarrent la vidéo | Visiteurs ayant démarré la vidéo, y compris ceux non reliés à une inscription | visiteurs | PostHog | idem | idem | heure de la lecture |
| Réservent un rendez-vous | Inscrits de la sélection ayant un rendez-vous effectif non annulé, quelle que soit sa date | personnes | miroir Notion des rendez-vous, relié aux inscrits | inscription dans la période ; rendez-vous à toute date | annulés, reportés, rendez-vous non reliés à un inscrit | dernière lecture complète du miroir Notion |

Les cinq nombres n'ont pas la même unité (visiteurs, personnes). Les taux sous les flèches comparent uniquement des paires réellement liées et ordonnées dans le temps :

| Flèche | Numérateur | Dénominateur |
|---|---|---|
| page → formulaire | visiteurs ayant ouvert le formulaire après la page | visiteurs de la page |
| formulaire → inscription | inscrits reliés à un navigateur ayant ouvert le formulaire avant l'inscription | ouvertures de formulaire |
| inscription → vidéo | inscrits reliés à un démarrage vidéo après l'inscription | inscrits |
| vidéo → rendez-vous | inscrits du dénominateur précédent avec une réservation datée après leur démarrage vidéo | inscrits reliés à un démarrage vidéo |

Un taux est indisponible si le dénominateur est nul, si la couverture Wix ou Notion ne dépasse pas la dernière activité navigateur de la sélection, ou si la date de réservation manque. Une inscription sans trace navigateur reste comptée dans « S'inscrivent » et sort des taux, sans navigation inventée. La lecture du détail vidéo mesure des secondes de contenu uniques, pas de l'attention.

## 2. Cartes Résultats utiles au pilotage

| Carte | Ce qui est compté | Source | Base de date | Base du taux ou exclusions |
|---|---|---|---|---|
| RDV réservés | rendez-vous dont la date de réservation explicite tombe dans la période | miroir Notion | date de réservation | annulés hors compte ; sans couverture du miroir : indisponible |
| RDV réalisés | présences classées dans Notion | miroir Notion | date prévue du créneau | rendez-vous futurs et annulés hors compte |
| Taux de présence | réalisés / (réalisés + absents) | miroir Notion | rendez-vous passés à issue connue | annulations et inconnus hors dénominateur |
| Leads uniques | personnes dont le premier contact connu avec BLG tombe dans la période, première origine conservée | Wix + antériorité Notion | premier contact | demandes répétées exclues ; lecture incomplète : indisponible |
| Dépenses publicitaires | total du compte Meta par jour importé | Meta | jour Meta | jours manquants ou provisoires signalés |
| Visites mesurées | sessions navigateur par tunnel (pas des personnes entre appareils) | PostHog (rapport agrégé) | jour Paris | selon couverture |
| CA encaissé | montant TTC Wix après remboursements, cartes cadeaux et rétrofacturations, avant frais | Wix (rapport de paiements) | jour du paiement | un jour sans rapport est inconnu |
| Nouveaux clients | premiers démarrages client effectifs, binômes inclus | rapport commerce Notion (dernière publication) | date de démarrage | démarrages sans date ou futurs exclus |
| Nouvelles ventes payées | premiers paiements confirmés | rapport commerce Notion (dernière publication) | date du paiement | paiements rapprochés ou en attente montrés à part |

Le clic Calendly, l'ouverture du calendrier, la conversion Meta « RDV Calendly BLG HOMME » et le rendez-vous enregistré dans Notion sont quatre mesures distinctes ; seule la dernière compte comme réservation.

## 3. Tableau quotidien Masterclass (par jour)

| Bloc | Colonnes et règle |
|---|---|
| Meta | dépense, impressions, clics lien, vues de page, RDV attribués Meta (conversion personnalisée, 7 jours clic / 1 jour vue) ; CTR = clics / impressions ; CPC = dépense / clics ; CPM = dépense × 1000 / impressions |
| Inscription et navigation | soumissions confirmées du formulaire Masterclass (répétitions conservées), contacts distincts, clics bilan et confirmations navigateur (sessions PostHog) |
| Commercial | appels prévus = créneaux effectifs Notion des inscrits de la cohorte à la date du call ; appels tenus = présences des mêmes ; taux = tenus / prévus |
| Ventes et cash | ventes = premiers paiements confirmés reliés à un inscrit de la cohorte ; cash = paiements confirmés avant remboursements, à la date du paiement ; indisponible en cas d'ambiguïté |

Un total n'additionne les jours que si tous sont mesurés : un seul jour inconnu rend le total indisponible, ce qui n'est pas une absence de vente.

## 4. Détail par publicité (colonnes principales)

Dépense et clics Meta par annonce ; visiteurs et inscrits selon la première origine mesurée ; opt-in = visiteurs entrés dans la période puis inscrits ensuite / visiteurs identifiables ; RDV réservés (date de réservation), réservation = inscrits avec créneau effectif / inscrits, RDV réalisés (présences à date prévue), présence = présents / (présents + absents) ; nouvelles ventes = paiements confirmés + rapprochés ; encaissé = paiements réussis Notion, remboursements à part. Les lignes publicité et lien peuvent décrire les mêmes personnes et ne s'additionnent pas.

## 5. Ambiguïtés ouvertes (à ne pas trancher dans ce lot)

1. « Ventes » : la carte Résultats et le tableau quotidien comptent les paiements confirmés seuls ; le détail par publicité ajoute les paiements rapprochés.
2. « Cash » : le cash du tableau et de la publicité est avant remboursements (Notion) ; le CA encaissé est net (Wix). Ce ne sont pas les mêmes montants.
3. « Taux de présence » : réalisés / (réalisés + absents) dans Résultats, tenus / prévus dans le tableau quotidien.
4. « RDV réservés » et « RDV réalisés » n'ont pas la même base de date : un rendez-vous tenu cette semaine a souvent été réservé la semaine précédente. Un écart entre les deux n'est pas une erreur de calcul.
5. « Leads uniques » : une définition intermédiaire (contacts identifiés datés dans Notion) existe dans le code mais la définition finale affichée est celle du premier contact connu.
6. « Démarrent la vidéo » compte aussi des visiteurs non inscrits ; le taux inscription → vidéo ne porte que sur les inscrits reliés.
7. Visites et vidéo ne sont mesurées qu'après consentement analytics ; inscriptions et rendez-vous ne dépendent pas du consentement. Le haut du parcours est donc sous-compté par rapport aux inscriptions ; ce n'est pas un abandon.
