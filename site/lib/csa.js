// Itinerary search over the MAX JEUNE / MAX SENIOR seats (Connection Scan Algorithm).
//
// Each dataset row is a bookable O-D pair with its own quota, so one row is one
// "connection" and one leg is one ticket. Chaining several legs means booking
// several tickets, possibly on the same train (a split ticket).
//
// Rounds: round k gives the earliest arrival using at most k tickets.
// The "profile" search reruns the scan for each departure time so it returns
// every non-dominated trip of the day (later departure, earlier arrival, fewer
// tickets).

import { interStationMinutes } from './stations.js';

export const DAY = 1440;
// Staying on the same train between two tickets: at most this long at the stop.
const SAME_TRAIN_MAX_STOP = 60;

/**
 * @param {Array} days list of day arrays [[train,o,d,dep,arr,axe],...], already
 *   sorted by departure. Day i is shifted by i*1440 minutes.
 */
export function makeTimetable(days) {
  const rows = [];
  days.forEach((list, i) => {
    for (const c of list || []) rows.push([c[0], c[1], c[2], c[3] + i * DAY, c[4] + i * DAY, c[5]]);
  });
  rows.sort((a, b) => a[3] - b[3] || a[4] - b[4]);
  const n = rows.length;
  const tt = {
    n,
    dep: new Int32Array(n),
    arr: new Int32Array(n),
    o: new Int32Array(n),
    d: new Int32Array(n),
    trip: new Int32Array(n),
    axe: new Int16Array(n),
    train: new Array(n),
  };
  const tripIds = new Map();
  rows.forEach((c, i) => {
    tt.train[i] = c[0];
    tt.o[i] = c[1];
    tt.d[i] = c[2];
    tt.dep[i] = c[3];
    tt.arr[i] = c[4];
    tt.axe[i] = c[5] ?? 0;
    if (!tripIds.has(c[0])) tripIds.set(c[0], tripIds.size);
    tt.trip[i] = tripIds.get(c[0]);
  });
  return tt;
}

/**
 * Possible transfers from each station: [[from station, minimum minutes], ...].
 * The station itself comes first, with the minimum change time.
 */
export function makeTransfers(stations, minChange = 10) {
  const byCity = new Map();
  stations.forEach((s, i) => {
    if (s.city) (byCity.get(s.city) || byCity.set(s.city, []).get(s.city)).push(i);
  });
  return stations.map((s, i) => {
    const list = [[i, minChange]];
    if (s.city) {
      for (const j of byCity.get(s.city)) {
        if (j === i) continue;
        const m = interStationMinutes(stations[j].id, s.id);
        if (m != null) list.push([j, Math.max(m, minChange)]);
      }
    }
    return list;
  });
}

function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Earliest arrival for 1..maxLegs tickets, leaving from `origins` no earlier than `start`. */
export function scan(tt, transfers, { origins, dests, start, maxLegs = 3, maxDuration = 24 * 60, maxWait = 180, lastStart = DAY - 1 }) {
  const nS = transfers.length;
  const destList = [...dests];
  let prev = new Array(nS).fill(null);
  for (const s of origins) prev[s] = { t: start, c: -1, prev: null, origin: true };
  let prevTrip = new Map();
  const horizon = start + maxDuration;
  const i0 = lowerBound(tt.dep, start);
  const best = [];

  for (let k = 1; k <= maxLegs; k++) {
    const cur = prev.slice();
    const curTrip = new Map(prevTrip);
    for (let i = i0; i < tt.n; i++) {
      const t = tt.dep[i];
      if (t > horizon) break;
      const s = tt.o[i];
      let from = null;
      const tl = prevTrip.get(tt.trip[i] * nS + s);
      if (tl && tl.t <= t && t - tl.t <= SAME_TRAIN_MAX_STOP) from = tl;
      else {
        for (const [q, m] of transfers[s]) {
          const L = prev[q];
          if (!L) continue;
          if (L.origin) {
            if (q === s) {
              from = L;
              break;
            }
            continue;
          }
          if (L.t + m <= t && t - L.t <= maxWait) {
            from = L;
            break;
          }
        }
      }
      if (!from) continue;
      if (from.origin && t > lastStart) continue;
      const e = tt.d[i];
      const lab = { t: tt.arr[i], c: i, prev: from };
      if (!cur[e] || lab.t < cur[e].t) cur[e] = lab;
      const key = tt.trip[i] * nS + e;
      const old = curTrip.get(key);
      if (!old || lab.t < old.t) curTrip.set(key, lab);
    }
    let b = null;
    for (const x of destList) if (cur[x] && !cur[x].origin && (!b || cur[x].t < b.t)) b = cur[x];
    best[k] = b;
    prev = cur;
    prevTrip = curTrip;
  }
  return best;
}

function reconstruct(tt, transfers, label) {
  const conns = [];
  for (let L = label; L && !L.origin; L = L.prev) conns.push(L.c);
  conns.reverse();
  const legs = conns.map((i, n) => {
    const leg = { train: tt.train[i], from: tt.o[i], to: tt.d[i], dep: tt.dep[i], arr: tt.arr[i], axe: tt.axe[i] };
    if (n > 0) {
      const p = conns[n - 1];
      leg.wait = tt.dep[i] - tt.arr[p];
      leg.sameTrain = tt.trip[p] === tt.trip[i] && tt.d[p] === tt.o[i] && leg.wait <= SAME_TRAIN_MAX_STOP;
      leg.stationChange = tt.d[p] !== tt.o[i];
    }
    return leg;
  });
  return { dep: legs[0].dep, arr: legs[legs.length - 1].arr, legs };
}

function dominates(a, b) {
  return (
    a.dep >= b.dep && a.arr <= b.arr && a.legs.length <= b.legs.length &&
    (a.dep > b.dep || a.arr < b.arr || a.legs.length < b.legs.length)
  );
}

/**
 * Every non-dominated trip leaving between `from` and `to` (minutes on day 0).
 * @returns {Array<{dep, arr, legs}>} sorted by departure time
 */
export function profile(tt, transfers, { origins, dests, maxLegs = 3, from = 0, to = DAY - 1, maxDuration = 24 * 60, maxWait = 180 }) {
  const originSet = new Set(origins);
  const destSet = new Set(dests);
  for (const o of originSet) if (destSet.has(o)) destSet.delete(o);
  if (!destSet.size) return [];
  const deps = [];
  for (let i = lowerBound(tt.dep, from); i < tt.n && tt.dep[i] <= to; i++) {
    if (originSet.has(tt.o[i])) deps.push(tt.dep[i]);
  }
  const found = new Map();
  let j = 0;
  while (j < deps.length) {
    const start = deps[j];
    const best = scan(tt, transfers, { origins: originSet, dests: destSet, start, maxLegs, maxDuration, maxWait, lastStart: to });
    let minDep = Infinity;
    for (let k = 1; k <= maxLegs; k++) {
      if (!best[k]) continue;
      const jr = reconstruct(tt, transfers, best[k]);
      const sig = jr.legs.map((l) => `${l.train}:${l.from}:${l.to}:${l.dep}`).join('/');
      found.set(sig, jr);
      minDep = Math.min(minDep, jr.dep);
    }
    if (minDep === Infinity) break;
    while (j < deps.length && deps[j] <= minDep) j++;
  }
  const all = [...found.values()];
  return all
    .filter((a) => !all.some((b) => b !== a && dominates(b, a)))
    .sort((a, b) => a.dep - b.dep || a.arr - b.arr || a.legs.length - b.legs.length);
}

export function fmtTime(min) {
  const day = Math.floor(min / DAY);
  const m = ((min % DAY) + DAY) % DAY;
  const s = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return day > 0 ? `${s} (+${day})` : s;
}

export function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
