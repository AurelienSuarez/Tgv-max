# Max Relais

Trouve une place **MAX JEUNE / MAX SENIOR** sur les 30 prochains jours, même quand le trajet direct est complet : Max Relais combine plusieurs billets disponibles (changement de train, changement de gare dans une même ville, ou deux billets sur le même train).

- **Trajets du jour** : tous les trajets intéressants d'une journée, en aller simple ou en aller-retour.
- **Tri et filtres** : par heure de départ, d'arrivée, durée ou nombre de billets ; partir après / arriver avant une heure ; sans train de nuit.
- **Week-ends** : pour chaque week-end des 30 jours, les destinations avec un aller gratuit le vendredi ou le samedi et un retour gratuit le dimanche.
- **Nouvelles places** : les places apparues depuis la veille sont signalées, avec un filtre pour ne voir qu'elles.
- **Calendrier** : le nombre de trajets possibles pour chacun des 30 prochains jours.
- **Explorer** : sur une carte interactive, toutes les gares reliées avec des places (en direct ou avec une correspondance), au départ d'une gare ou à l'arrivée à une gare.

## Fonctionnement

Pas de serveur. Une GitHub Action (`.github/workflows/deploy.yml`) tourne chaque matin :
1. elle télécharge l'export CSV du dataset SNCF `tgvmax` ;
2. elle retire les autocars, fusionne les doublons et ne garde que les places disponibles ;
3. elle écrit un JSON par jour dans `site/data/` et déploie `site/` sur GitHub Pages.

Le navigateur calcule les itinéraires dans un Web Worker avec le Connection Scan Algorithm (`site/lib/csa.js`). Le détail du dataset et ses pièges sont dans [`docs/DATASET.md`](docs/DATASET.md).

## Développer

```sh
npm test                 # tests (node:test, aucune dépendance)
npm run build:data       # télécharge les données dans site/data/
npm run serve            # http://localhost:8080/
node scripts/build-single.js   # version autonome (données incluses) dans dist/
```

## Mise en ligne (une seule fois)

Dans le repo GitHub : **Settings → Pages → Build and deployment → Source : GitHub Actions**. Relance ensuite le workflow « Places MAX et déploiement » (onglet Actions → Run workflow). Le site sera publié sur `https://aureliensuarez.github.io/Tgv-max/`.

## Licences

Code sous licence MIT. Données dérivées sous licence ODbL : © SNCF Voyageurs, dataset `tgvmax` sur ressources.data.sncf.com. Coordonnées des gares : trainline-eu/stations (ODbL). Fond de carte : Natural Earth (domaine public). Max Relais n'est pas affilié à la SNCF.
