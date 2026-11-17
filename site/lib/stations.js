// Station names and city groupings.
// The dataset labels several stations with a single "(intramuros)" name, so the
// IATA code is the only reliable key. This table gives each station its real name.

export const STATION_NAMES = {
  FRPLY: 'Paris Gare de Lyon',
  FRPBE: 'Paris Bercy',
  FRPMO: 'Paris Montparnasse',
  FRMPV: 'Paris Montparnasse Vaugirard',
  FRPNO: 'Paris Nord',
  FRPST: 'Paris Est',
  FRPAZ: 'Paris Austerlitz',
  FRLPD: 'Lyon Part-Dieu',
  FRLPE: 'Lyon Perrache',
  FRJDQ: 'Lyon Saint-Exupéry TGV',
  FRLLE: 'Lille Europe',
  FRADJ: 'Lille Flandres',
  FRMLW: 'Aéroport CDG 2 TGV',
  FRMLV: 'Marne-la-Vallée Chessy',
  FRDJU: 'Massy TGV',
  FRMPU: 'Massy Palaiseau',
  FRVLA: 'Valence TGV',
  FRXMK: 'Montélimar',
  FRBXB: 'Bretenoux Biars',
  FRGBG: 'Laroquebrou',
  FRXBF: 'Bellegarde',
  FRFQG: "L'Hospitalet-près-l'Andorre",
  FRFTA: 'Caussade',
  FRETA: 'Étaples Le Touquet',
  FRHQN: 'Nurieux',
};

// Stations in the same city where you can change trains on foot or by a short
// shuttle or metro ride. `minutes` is the default minimum transfer time between two
// different stations of the group, and `pairs` overrides it for close stations.
export const CITY_GROUPS = [
  {
    city: 'Paris',
    stations: ['FRPLY', 'FRPBE', 'FRPMO', 'FRMPV', 'FRPNO', 'FRPST', 'FRPAZ'],
    minutes: 60,
    pairs: { 'FRPLY|FRPBE': 20, 'FRPNO|FRPST': 20, 'FRPMO|FRMPV': 15, 'FRPLY|FRPAZ': 30, 'FRPNO|FRPLY': 45 },
  },
  { city: 'Lyon', stations: ['FRLPD', 'FRLPE', 'FRJDQ'], minutes: 35, pairs: { 'FRLPD|FRJDQ': 60, 'FRLPE|FRJDQ': 75 } },
  { city: 'Lille', stations: ['FRLLE', 'FRADJ'], minutes: 15 },
  { city: 'Marseille', stations: ['FRMSC', 'FRMBC'], minutes: 25 },
  { city: 'Montpellier', stations: ['FRMPL', 'FRSUF'], minutes: 40 },
  { city: 'Avignon', stations: ['FRAES', 'FRAVG'], minutes: 30 },
  { city: 'Nîmes', stations: ['FRFNI', 'FRXZP'], minutes: 45 },
  { city: 'Valence', stations: ['FRVAF', 'FRVLA'], minutes: 35 },
  { city: 'Besançon', stations: ['FRABG', 'FRTJB'], minutes: 40 },
  { city: 'Mâcon', stations: ['FRHGU', 'FRMLT'], minutes: 50 },
  { city: 'Albi', stations: ['FRAMA', 'FRAFJ'], minutes: 20 },
  { city: 'Massy', stations: ['FRDJU', 'FRMPU'], minutes: 15 },
  { city: 'Berlin', stations: ['DEHBF', 'DEHBS', 'DEBGB'], minutes: 30 },
];

const KEEP_UPPER = new Set(['TGV', 'SNCF', 'CDG', 'SBB', 'HBF', 'HB']);
const LOWER = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'sur', 'en', 'et', 'am', 'près', "l'", 'd']);
const ACCENTS = {
  NIMES: 'Nîmes', BEZIERS: 'Béziers', BESANCON: 'Besançon', MACON: 'Mâcon', SETE: 'Sète',
  CHAMBERY: 'Chambéry', ANGOULEME: 'Angoulême', GENEVE: 'Genève', MUNCHEN: 'München',
  ORLEANS: 'Orléans', EVIAN: 'Évian', EPINAL: 'Épinal', SAARBRUECKEN: 'Saarbrücken',
  CHATEAUROUX: 'Châteauroux', CHATELLERAULT: 'Châtellerault', CHALON: 'Chalon',
  CHALONS: 'Châlons', BENEDICTINS: 'Bénédictins', MEZIERES: 'Mézières', BRIANCON: 'Briançon',
  FRANCOIS: 'François', ISSOUDUN: 'Issoudun', SAINCAIZE: 'Saincaize', NEUFCHATEAU: 'Neufchâteau',
  SEVERAC: 'Sévérac', CHATEAU: 'Château', LUCON: 'Luçon', VITRE: 'Vitré', MERENS: 'Mérens',
  BEDARIEUX: 'Bédarieux', ARLES: 'Arles', ECRINS: 'Écrins', SELESTAT: 'Sélestat',
  REMIREMONT: 'Remiremont', DEVOLUY: 'Dévoluy', MATABIAU: 'Matabiau', THONON: 'Thonon',
  MONTELIMAR: 'Montélimar', ST: 'St', STE: 'Ste', ZURICH: 'Zürich', FIGUERES: 'Figueres',
};

export function prettyName(raw) {
  const words = raw.replace(/\.$/, '').trim().split(/\s+/);
  return words
    .map((w, i) => {
      if (KEEP_UPPER.has(w)) return w;
      if (ACCENTS[w]) return ACCENTS[w];
      const lw = w.toLowerCase();
      if (i > 0 && LOWER.has(lw)) return lw;
      return lw.replace(/(^|[-'(/])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
    })
    .join(' ');
}

export function displayName(iata, raw) {
  return STATION_NAMES[iata] || prettyName(raw);
}

export function cityOf(iata) {
  const g = CITY_GROUPS.find((g) => g.stations.includes(iata));
  return g ? g.city : null;
}

// Minimum transfer time between two stations in the same city, or null when they
// are not in the same city.
export function interStationMinutes(a, b) {
  if (a === b) return null;
  for (const g of CITY_GROUPS) {
    if (g.stations.includes(a) && g.stations.includes(b)) {
      return (g.pairs && (g.pairs[`${a}|${b}`] ?? g.pairs[`${b}|${a}`])) ?? g.minutes;
    }
  }
  return null;
}
