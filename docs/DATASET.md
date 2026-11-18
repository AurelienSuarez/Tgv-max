# Dataset `tgvmax` : reconnaissance (étape 0)

Observé le **2026-11-17** sur l'API en direct. Tout ce qui suit a été mesuré, rien n'est supposé.

## Source

| | |
|---|---|
| Titre | Disponibilité à 30 jours de places MAX JEUNE et MAX SENIOR ouvertes à la réservation |
| Éditeur | SNCF Voyageurs |
| Portail | `https://ressources.data.sncf.com` (Opendatasoft, Explore API v2.1) |
| Licence | **ODbL**, https://data.sncf.com/pages/cgu/A1#A1 |
| Dernière MAJ | `modified` = `data_processed` = 2026-11-17T05:23:12Z |
| Fréquence | Non déclarée dans les métadonnées (`accrualperiodicity` = null). Observé deux jours de suite : 05:23:12 UTC le 17/11 et 05:23:13 UTC le 18/11, soit 6h23 à Paris ; le site l'annonce comme « vers 6h20 » et affiche l'heure réelle de la dernière mise à jour. L'horodatage vers 05h20 UTC laisse penser à une **mise à jour quotidienne** dans la nuit. Le cron doit enregistrer `metas.default.modified` à chaque exécution pour le confirmer. |

### Endpoints

```
# métadonnées + schéma
GET https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax
# enregistrements paginés (100 par page au maximum, inutilisable pour un dump complet)
GET .../datasets/tgvmax/records?limit=100
# EXPORT COMPLET : c'est celui à utiliser dans le cron
GET .../datasets/tgvmax/exports/csv?delimiter=%3B
```

- L'export CSV complet pèse **32 Mo** pour **345 572 lignes**. Il se télécharge en ~14 s.
- Le CSV commence par un **BOM UTF-8**, il faut donc le lire en `utf-8-sig`.
- Le portail coupe parfois la connexion (`connection reset by peer`) quand on enchaîne les requêtes d'agrégation. Le cron doit **réessayer avec un délai croissant**.
- `metas.default.records_count` (493 340) **ne correspond pas** au nombre réel de lignes (345 572). Il ne faut pas s'y fier : compter les lignes exportées.

## Schéma (11 colonnes, toutes texte sauf `date`)

| Champ | Type | Exemple | Remarques |
|---|---|---|---|
| `date` | date `YYYY-MM-DD` | `2026-11-20` | Date de **départ** depuis l'origine |
| `train_no` | texte | `6175` | 1 392 valeurs distinctes, pas unique d'un jour à l'autre |
| `entity` | texte | `PAAZUR` | Code de ligne interne (101 valeurs) |
| `axe` | texte | `SUD EST` | 9 valeurs : ATLANTIQUE, SUD EST, EST, NORD, IC SRO, IC ARO, INTERNATIONAL, **AUTOCAR SNCF**, IC NUIT |
| `origine_iata` | texte | `FRPLY` | **Identifiant de gare stable** (328 valeurs) |
| `destination_iata` | texte | `FRXAT` | |
| `origine` | texte | `PARIS (intramuros)` | Libellé affiché, **qui peut être partagé par plusieurs gares** |
| `destination` | texte | `ANTIBES` | |
| `heure_depart` | texte `HH:MM` | `10:10` | Toujours 5 caractères |
| `heure_arrivee` | texte `HH:MM` | `15:45` | Peut être **< heure_depart** : le train arrive après minuit |
| `od_happy_card` | `OUI`/`NON` | `OUI` | Place MAX JEUNE/SENIOR disponible pour **ce couple O-D précis** |

## Volumes

- Fenêtre glissante de **31 jours** (J à J+30) : du 2026-11-17 au 2026-12-17.
- Environ **8 000 à 12 600 lignes par jour**. Les vendredis sont les jours les plus chargés.
- Disponibilité : **71 100 OUI (20,6 %)** contre 274 472 NON.
- 25 352 couples (date, train).
- Un jour en JSON compact (tableaux `[train, o, d, dep, arr, ok]`) pèse **~590 Ko brut et ~120 Ko en gzip**. En ne gardant que les lignes OUI, on tombe à **~10 Ko en gzip**. Un JSON par jour sur GitHub Pages est donc tout à fait viable.

## Constats qui pèsent sur l'algorithme de routage

1. **Une ligne correspond à un couple O-D, pas à un tronçon.** Un train qui dessert N gares produit jusqu'à N(N-1)/2 lignes. Exemple : le train 6175 du 2026-11-20 (Paris → Nice, 7 gares) produit 21 lignes, dont `MARSEILLE 13:28 → TOULON 14:10`. On peut en déduire les horaires aux arrêts intermédiaires : arrivée à Marseille à 13:14, départ à 13:28.
   - Le découpage **sur un même train** est donc un vrai cas d'usage. Exemple : Paris→Marseille OUI + Marseille→Nice OUI alors que Paris→Nice est NON. La disponibilité d'un couple **ne se déduit pas** de celle de ses sous-segments : chaque couple a son propre quota.
   - Pour le CSA, chaque ligne OUI est une *connexion* (dep, arr, o, d, trip=train_no+date). Les sous-segments sont déjà dans les données, pas besoin de reconstruire le parcours des trains pour chercher.
2. **Passage de minuit** : 3 884 lignes ont `heure_arrivee < heure_depart`. Règle : si arr < dep, alors arr += 24 h. Le départ tombe toujours le jour `date`. Un trajet parti à 23:50 le jour J doit pouvoir correspondre avec des trains de J+1, donc le worker doit charger **au moins deux jours consécutifs**.
3. **Le regroupement par ville est déjà dans les libellés** : plusieurs codes IATA partagent un même nom `(intramuros)`.
   - `PARIS (intramuros)` : FRPLY (Lyon), FRPMO (Montparnasse), FRPNO (Nord), FRPST (Est), FRPAZ (Austerlitz), FRPBE (Bercy)
   - `LYON (intramuros)` : FRLPD (Part-Dieu), FRLPE (Perrache)
   - `LILLE (intramuros)` : FRLLE (Lille Europe : TGV vers CDG, Lyon, Bruxelles), FRADJ (Lille Flandres : trains vers Paris Nord)
   - Gares de la même ville qui ne sont pas regroupées et gardent leur propre libellé : MARSEILLE ST CHARLES / BLANCARDE, MONTPELLIER SAINT ROCH / SUD DE FRANCE, LYON ST EXUPERY TGV., PARIS MONTPARNASSE VAUGIRARD.
   - Conséquence : il faut **toujours utiliser `*_iata` comme clé**, jamais le libellé. Il faut aussi une table écrite à la main `iata → vrai nom de gare` pour l'affichage, puisque le dataset affiche « PARIS (intramuros) » pour les 6 gares. Un changement de gare dans une même ville (par ex. Paris Nord → Paris Lyon) demande un **temps de correspondance minimum spécifique**, bien plus long qu'un changement de quai dans la même gare.
4. **Doublons contradictoires** : 566 clés `(date, train_no, o, d, dep)` apparaissent deux fois, une fois `OUI` et une fois `NON`. Ce sont des trains de nuit (`IC NUIT`), sans doute une ligne par classe (siège/couchette). Règle d'ingestion : **fusionner en OUI dès qu'une des lignes est OUI**, avec si besoin un drapeau `multi`.
5. **Les autocars** (`AUTOCAR SNCF`, 14 291 lignes) sont inclus. Il reste à décider si on les affiche (filtre dans l'interface ?).
6. On trouve 50 cas où un même train a des horaires différents à la même gare le même jour, probablement les doublons de trains de nuit ou des trains scindés. Le code doit les tolérer et ne pas supposer l'unicité.
7. `train_no` ne suffit pas à identifier un trajet : l'identifiant doit être `date + train_no`. Pour un train de nuit, J+1 peut contenir un autre train portant le même numéro.

## Le jour qui vient d'ouvrir (J+30)

Observé le 2026-11-17 à 6h23 : le dernier jour de la fenêtre (2026-12-17) n'avait que **26 places OUI** pour 11 024 lignes, contre 2 348 la veille et 1 000 à 6 000 les autres jours. Les places MAX du jour qui vient d'ouvrir ne sont donc pas encore toutes en ligne au moment de la mise à jour. Confirmé le lendemain : le 2026-12-17 est passé de 26 à **1 475** places OUI entre les mises à jour du 17/11 et du 18/11, et le nouveau dernier jour (2026-12-18) n'en avait que 19. Les places du jour J+30 arrivent donc le lendemain de son ouverture ; elles apparaissent alors comme « nouvelles ». `meta.seatsByDate` continue de l'enregistrer.

## Échantillon de test

`docs/sample/tgvmax-sample.csv` (67 lignes, extrait sous ODbL, source SNCF) contient :
- le train 6175 du 2026-11-20 (Paris → Nice, tous les couples O-D)
- le train 8392 du 2026-11-20 (arrivée à Paris à 00:19, passage de minuit)
- le train 6953 du 2026-11-20 (Chambéry 23:50 → Annecy 00:29)
- les trains 3750 du 2026-11-17 et 5781 du 2026-11-18 (trains de nuit avec doublons OUI/NON)

---
Données : © SNCF Voyageurs, licence ODbL. Source : ressources.data.sncf.com, dataset `tgvmax`.
