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

Règle des taux (décision Mehdi du 23/09, D3, option A) : un taux qui fait intervenir les inscriptions Wix ou les rendez-vous Notion est calculé sur la population comparable, c'est-à-dire les personnes dont l'événement d'entrée au dénominateur (ouverture ou début du formulaire, inscription, démarrage vidéo, ouverture du calendrier) est antérieur ou égal à l'heure de couverture commune du taux : couverture des inscriptions pour formulaire → inscription ; la plus ancienne des couvertures des inscriptions et de la lecture navigateur (heure de lecture PostHog, pas son dernier événement observé ; heure inconnue : taux indisponible) pour inscription → vidéo ; la plus ancienne des couvertures inscriptions et rendez-vous pour vidéo → rendez-vous et calendrier → rendez-vous. Une personne plus récente sort du numérateur et du dénominateur ; elle n'est jamais comptée comme « n'a pas fait ». Les compteurs d'étape restent calculés sur toute la sélection, d'où un écart possible avec la base des taux. L'heure de couverture est affichée avec chaque taux (« activités jusqu'au … », personnes plus récentes hors taux) et sous le parcours. Une tentative de mise à jour ne prouve ni n'invalide la couverture. Un taux reste indisponible si une source dont il dépend est absente ou sans couverture connue ; une source à actualiser, en cours de lecture ou dont la dernière tentative a échoué reste utilisable jusqu'à sa dernière couverture publiée, signalée dans la fraîcheur des chiffres. Il reste aussi indisponible si le dénominateur est nul après restriction (motif avec l'heure de couverture), si un réservant de la sélection n'a pas de date de réservation (la date prévue ne prouve pas la réservation) ou si les rendez-vous ne sont pas reliés aux inscrits. Les taux purement navigateur (page → formulaire, début du formulaire, calendrier après clic, seuils vidéo) ne changent pas. Une inscription sans trace navigateur reste comptée dans « S'inscrivent » et sort des taux, sans navigation inventée. La lecture du détail vidéo mesure des secondes de contenu uniques, pas de l'attention.

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

Colonnes dans l'ordre de l'Excel de référence du média buyer (A→AI), en huit groupes ; taux et coûts en colonnes propres. Trois récapitulatifs au-dessus des jours : « Global · du … au … » (période sélectionnée), « 3 derniers jours » et « 7 derniers jours » (fenêtres finissant le dernier jour de la période, dates affichées).

| Groupe | Colonnes et règle |
|---|---|
| Publicité (Meta) | dépense, impressions, CPM = dépense × 1000 / impressions, clics lien (`inline_link_clicks`, « Clics » de l'Excel, ambiguïté 1), CTR = clics lien / impressions, CPC = dépense / clics lien ; campagnes masterclass du code (surcharge serveur `BLG_KPI_MASTERCLASS_CAMPAIGN_IDS`), reciblage exclu ; CTRU = CTR unique Meta = comptes ayant cliqué le lien / comptes touchés (reach), jamais additionné ni moyenné : par jour, lecture Meta du jour ; par récapitulatif, lecture Meta de la fenêtre entière, sinon non mesuré (fenêtre non lue à la source) ; aucun repère affiché (ambiguïté 2) |
| Inscription | inscrits = contacts distincts (clé de contact) parmi les soumissions confirmées et éligibles du formulaire Masterclass du jour ; par récapitulatif, contacts distincts de la fenêtre (les jours ne s'additionnent pas) ; proposition par défaut en attente de confirmation (ambiguïté 3) ; non mesuré si une soumission n'a pas de clé de contact ; soumissions et répétitions conservées dans le détail ; inscrits / clics = inscrits / clics lien (pas des visites) ; coût par inscrit = dépense / inscrits |
| Vidéo | vues du CTA : non mesurées (aucun signal validé, Mehdi et Codex) ; vues CTA / inscrits et coût par vue du CTA non mesurés tant que le terme manque |
| Formulaire | sans objet dans le tunnel BLG (aucun formulaire entre la vidéo et l'appel) : colonnes grisées conservées en attente d'arbitrage (ambiguïté 4) |
| Réservation | appels réservés = réservations des inscrits de la cohorte datées au jour de réservation (date de réservation explicite, jamais la création de la fiche ni le jour du call), même règle que la carte Résultats « Réservés » : une réservation annulée ou reportée ensuite reste comptée une fois à sa date, une fiche sans créneau compte par sa date de réservation, essais exclus ; un clic, une confirmation navigateur ou une conversion Meta ne comptent jamais ; réservés / vues du CTA non mesuré ; coût par réservation = dépense du même jour / appels réservés du jour (l'Excel divisait la dépense de la veille) ; inscrits → réservés = appels réservés / inscrits |
| Appels | appels planifiés = créneaux effectifs Notion des inscrits de la cohorte à la date du call ; appels réalisés = présences des mêmes ; présence = réalisés / planifiés ; bloc calculé seulement si toutes les inscriptions de la période sont reliées à une personne, sinon non mesuré avec le nombre d'inscriptions non reliées |
| Offres | offres faites : non mesurées (aucun champ source, Jérôme avec Codex) ; offres / appels réalisés et coût par offre non mesurés |
| Ventes | ventes = premiers paiements confirmés reliés à un inscrit de la cohorte ; ventes / offres (« closing rate » de l'Excel) non mesuré tant que les offres ne le sont pas, « ventes / appels réalisés » affiché dans le détail sous ce libellé (ambiguïté 5) ; coût par client = dépense / ventes ; cash = paiements confirmés avant remboursements, à la date du paiement ; CA contracté non mesuré (lot finance) ; ROAS cash = cash / dépense ; ROAS = CA contracté / dépense |

Détail « Sources, fraîcheur et définitions » (et export) : vues de page Meta, clics sortants et clics sortants / impressions, comptes touchés et comptes ayant cliqué, clics bilan et confirmations navigateur (sessions PostHog de production, datées à leur premier événement du type), RDV attribués Meta (conversion personnalisée, 7 jours clic / 1 jour vue, au jour de l'impression) et coût par RDV Meta, soumissions et répétitions, ventes / appels réalisés, emails, répartition des clics bilan par publicité.

Un récapitulatif additionne les jours puis calcule les taux sur les sommes, jamais une moyenne de taux quotidiens ; il n'additionne les jours que si tous sont mesurés : un seul jour inconnu rend la somme indisponible, ce qui n'est pas une absence de vente. Une fenêtre qui commence avant la période sélectionnée reste non mesurée (élargir la période). Un ratio est non mesuré si un de ses termes l'est, et non calculé si son dénominateur vaut zéro (jamais 0 % sur zéro, jamais l'infini).

Couverture (D3) : chaque bloc affiche l'heure, à Paris, de la plus ancienne lecture dont il dépend, et « ancien » quand une de ces lectures dépasse la cadence de son flux. Un jour passé lu en cours de journée reste non mesuré ; le jour en cours est partiel et signalé. Un taux ou un coût qui croise deux blocs (Meta × inscriptions, Meta × Notion, Notion × inscriptions, Meta × ventes) n'est calculé, par jour, que si chaque bloc couvre le jour, et par récapitulatif que si chaque bloc couvre tous les jours de la fenêtre ; le motif nomme les blocs manquants. La couverture commune en tête du tableau est la plus ancienne des blocs disponibles.

## 4. Détail par publicité (colonnes principales)

Dépense et clics Meta par annonce ; visiteurs et inscrits selon la première origine mesurée ; opt-in = visiteurs entrés dans la période puis inscrits ensuite / visiteurs identifiables ; RDV réservés (date de réservation), réservation = inscrits avec créneau effectif / inscrits, RDV réalisés (présences à date prévue), présence = présents / (présents + absents) ; nouvelles ventes = paiements confirmés + rapprochés ; encaissé = paiements réussis Notion, remboursements à part. Les lignes publicité et lien peuvent décrire les mêmes personnes et ne s'additionnent pas.

## 5. Ambiguïtés ouvertes (à ne pas trancher dans ce lot)

1. « Ventes » : la carte Résultats et le tableau quotidien comptent les paiements confirmés seuls ; le détail par publicité ajoute les paiements rapprochés.
2. « Cash » : le cash du tableau et de la publicité est avant remboursements (Notion) ; le CA encaissé est net (Wix). Ce ne sont pas les mêmes montants.
3. « Taux de présence » : réalisés / (réalisés + absents) dans Résultats, tenus / prévus dans le tableau quotidien.
4. « RDV réservés » et « RDV réalisés » n'ont pas la même base de date : un rendez-vous tenu cette semaine a souvent été réservé la semaine précédente. Un écart entre les deux n'est pas une erreur de calcul. Bases de dates affichées dans Résultats depuis U6 ; l'écart reste normal.
5. « Leads uniques » : une définition intermédiaire (contacts identifiés datés dans Notion) existe dans le code mais la définition finale affichée est celle du premier contact connu.
6. « Démarrent la vidéo » compte aussi des visiteurs non inscrits ; le taux inscription → vidéo ne porte que sur les inscrits reliés.
7. Visites et vidéo ne sont mesurées qu'après consentement analytics ; inscriptions et rendez-vous ne dépendent pas du consentement. Le haut du parcours est donc sous-compté par rapport aux inscriptions ; ce n'est pas un abandon.
