// Web Worker: loads the daily files and runs the searches outside the main thread.
import { makeTimetable, makeTransfers, profile, DAY } from './lib/csa.js';

let stations = [];
let dates = [];
let base = '';
let embedded = null;
const dayCache = new Map();
const transfersCache = new Map();

function getDay(date) {
  if (!date || !dates.includes(date)) return Promise.resolve([]);
  if (!dayCache.has(date)) {
    dayCache.set(
      date,
      embedded
        ? Promise.resolve(embedded[date] || [])
        : fetch(`${base}days/${date}.json`).then((r) => {
            if (!r.ok) throw new Error(`Day ${date} unavailable (HTTP ${r.status})`);
            return r.json();
          }),
    );
  }
  return dayCache.get(date);
}

function transfers(minChange) {
  if (!transfersCache.has(minChange)) transfersCache.set(minChange, makeTransfers(stations, minChange));
  return transfersCache.get(minChange);
}

async function timetableFor(date) {
  const next = dates[dates.indexOf(date) + 1];
  const [a, b] = await Promise.all([getDay(date), getDay(next)]);
  return makeTimetable([a, b]);
}

async function journeys(date, q) {
  const tt = await timetableFor(date);
  return profile(tt, transfers(q.minChange), {
    origins: q.origins,
    dests: q.dests,
    maxLegs: q.maxLegs,
    maxWait: q.maxWait,
    maxDuration: 24 * 60,
    from: q.from || 0,
  });
}

// Direct seats from a set of stations (dir 'from') or towards it (dir 'to').
async function explore(date, places, dir = 'from') {
  const list = await getDay(date);
  const set = new Set(places);
  const byOther = new Map();
  for (const [, o, d, dep, arr] of list) {
    const mine = dir === 'from' ? o : d;
    const other = dir === 'from' ? d : o;
    if (!set.has(mine) || set.has(other)) continue;
    const e = byOther.get(other) || { station: other, count: 0, first: DAY * 2, last: -1, shortest: Infinity, via: new Map() };
    e.count++;
    e.first = Math.min(e.first, dep);
    e.last = Math.max(e.last, dep);
    e.shortest = Math.min(e.shortest, arr - dep);
    e.via.set(mine, (e.via.get(mine) || 0) + 1);
    byOther.set(other, e);
  }
  return [...byOther.values()].map((e) => ({ ...e, via: [...e.via].sort((a, b) => b[1] - a[1])[0][0] }));
}

const handlers = {
  init(msg) {
    stations = msg.stations;
    dates = msg.dates;
    base = msg.base || '';
    embedded = msg.days || null;
    return { ok: true };
  },
  search: (msg) => journeys(msg.date, msg.query),
  async calendar(msg) {
    const out = [];
    for (const date of msg.dates) {
      const js = await journeys(date, msg.query);
      out.push({
        date,
        count: js.length,
        direct: js.filter((j) => j.legs.length === 1).length,
        fastest: js.length ? Math.min(...js.map((j) => j.arr - j.dep)) : null,
      });
    }
    return out;
  },
  explore: (msg) => explore(msg.date, msg.places, msg.dir),
};

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const result = await handlers[msg.type](msg);
    self.postMessage({ id: msg.id, result });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message ? err.message : err) });
  }
};
