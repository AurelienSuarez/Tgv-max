# Max Relais — notes pour Claude Code

Site statique qui cherche des places MAX JEUNE / MAX SENIOR (dataset SNCF `tgvmax`), avec découpage d'itinéraire en plusieurs billets. Lire `docs/DATASET.md` avant de toucher à l'ingestion ou au routage.

## Choix structurants
- **Zéro backend** : un cron GitHub Actions télécharge le dataset, le découpe en un JSON par jour (`site/data/days/YYYY-MM-DD.json`) et déploie `site/` sur GitHub Pages.
- **Routage côté client** : Connection Scan Algorithm par rounds (`site/lib/csa.js`) dans un Web Worker (`site/worker.js`). Une ligne du dataset = un couple O-D avec son propre quota = un billet.
- **Hors périmètre** : comptes, Premium, alertes de places libérées (tout ce qui demande un serveur). **Autocars exclus** (décision produit).
- **Licences** : code MIT, données dérivées ODbL avec attribution SNCF Voyageurs.

## Règles de données (vérifiées sur le dataset réel)
- Toujours identifier une gare par `*_iata`, jamais par le libellé (« PARIS (intramuros) » couvre 6 gares). Noms réels et groupes de villes dans `site/lib/stations.js`.
- `heure_arrivee < heure_depart` ⇒ +24 h. Une ligne est datée du jour réel de son départ.
- Doublons OUI/NON (trains de nuit) : OUI l'emporte.
- La recherche d'un jour J charge J et J+1. Un train est identifié par son numéro dans cette fenêtre ; « même train » seulement si l'arrêt dure ≤ 60 min.

## Tests imposés (`npm test`)
Passage de minuit, changement de gare dans une même ville, billets découpés sur le même train, temps de correspondance, limite de billets, attente maximale, profil Pareto, échantillon réel (`docs/sample/`). Tout changement de `csa.js` ou `ingest.js` doit garder ces tests verts et en ajouter pour les nouveaux cas.

## Commandes
`npm test` · `npm run build:data` · `npm run serve` · `node scripts/build-single.js` (page autonome avec instantané des données) · `node scripts/build-geo.js <trainline stations.csv> <ne_50m countries.geojson> site/data/stations.json` (coordonnées et fond de carte, à relancer seulement si de nouvelles gares apparaissent).


