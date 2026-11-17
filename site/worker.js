// Web Worker: loads the daily files and runs the searches outside the main thread.
import { makeTimetable, makeTransfers, profile, reachAll, reverseTimetable, DAY } from './lib/csa.js';

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

const ttCache = new Map();
async function timetableFor(date, reversed = false) {
  const key = `${date}|${reversed}`;
  if (!ttCache.has(key)) {
    if (ttCache.size > 8) ttCache.clear();
    const next = dates[dates.indexOf(date) + 1];
    const [a, b] = await Promise.all([getDay(date), getDay(next)]);
    const tt = makeTimetable([a, b]);
    ttCache.set(`${date}|false`, tt);
    ttCache.set(`${date}|true`, null);
  }
  if (reversed && !ttCache.get(key)) ttCache.set(key, reverseTimetable(ttCache.get(`${date}|false`)));
  return ttCache.get(key);
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

// Stations linked to `places` (dir 'from': destinations, dir 'to': origins).
// maxLegs 1 = direct trains only, read straight from the day file.
async function explore(date, places, dir, q) {
  const fromMin = q.from || 0;
  if ((q.maxLegs || 1) <= 1) {
    const list = await getDay(date);
    const set = new Set(places);
    const byOther = new Map();
    for (const [, o, d, dep, arr, , isNew] of list) {
      const mine = dir === 'from' ? o : d;
      const other = dir === 'from' ? d : o;
      if (!set.has(mine) || set.has(other) || dep < fromMin) continue;
      const e = byOther.get(other) || { station: other, count: 0, first: DAY * 2, last: -1, shortest: Infinity, direct: true, fresh: 0, via: new Map() };
      e.count++;
      if (isNew) e.fresh++;
      e.first = Math.min(e.first, dep);
      e.last = Math.max(e.last, dep);
      e.shortest = Math.min(e.shortest, arr - dep);
      e.via.set(mine, (e.via.get(mine) || 0) + 1);
      byOther.set(other, e);
    }
    return [...byOther.values()].map((e) => ({ ...e, via: [...e.via].sort((a, b) => b[1] - a[1])[0][0] }));
  }
  const opts = { origins: places, maxLegs: q.maxLegs, maxWait: q.maxWait, maxDuration: 24 * 60 };
  let reach;
  if (dir === 'from') {
    reach = reachAll(await timetableFor(date), transfers(q.minChange), { ...opts, from: fromMin, to: DAY - 1 });
  } else {
    const back = reachAll(await timetableFor(date, true), transfers(q.minChange), { ...opts, from: -3 * DAY, to: 0 });
    reach = new Map();
    for (const [s, list] of back) {
      const real = list.map((o) => ({ ...o, dep: -o.arr, arr: -o.dep })).filter((o) => o.dep >= fromMin && o.dep < DAY);
      if (real.length) reach.set(s, real);
    }
  }
  const out = [];
  for (const [station, list] of reach) {
    out.push({
      station,
      count: list.length,
      first: Math.min(...list.map((o) => o.dep)),
      last: Math.max(...list.map((o) => o.dep)),
      shortest: Math.min(...list.map((o) => o.arr - o.dep)),
      direct: list.some((o) => o.legs === 1),
      fresh: list.filter((o) => o.isNew).length,
      via: list[0].via,
    });
  }
  return out;
}

// Week-ends: destinations with a free outbound on Friday (after `friAfter`) or
// Saturday and a free return on Sunday towards the origin.
async function weekends(origins, q, friAfter = 15 * 60) {
  const tr = transfers(q.minChange);
  const opts = { origins, maxLegs: q.maxLegs, maxWait: q.maxWait, maxDuration: 24 * 60 };
  const nowFrom = q.from || 0;
  const today = q.today;
  const out = [];
  for (const sun of dates) {
    if (new Date(`${sun}T12:00:00Z`).getUTCDay() !== 0) continue;
    const i = dates.indexOf(sun);
    const fri = dates[i - 2];
    const sat = dates[i - 1];
    const startFrom = (d, base) => Math.max(base, d === today ? nowFrom : 0);
    const summarize = (list) => (list && list.length ? {
      count: list.length,
      first: Math.min(...list.map((o) => o.dep)),
      last: Math.max(...list.map((o) => o.dep)),
      direct: list.some((o) => o.legs === 1),
      fresh: list.some((o) => o.isNew),
    } : null);
    const outFri = fri && fri >= today ? reachAll(await timetableFor(fri), tr, { ...opts, from: startFrom(fri, friAfter), to: DAY - 1 }) : new Map();
    const outSat = sat && sat >= today ? reachAll(await timetableFor(sat), tr, { ...opts, from: startFrom(sat, 0), to: DAY - 1 }) : new Map();
    const back = reachAll(await timetableFor(sun, true), tr, { ...opts, from: -3 * DAY, to: 0 });
    const items = [];
    for (const [station, list] of back) {
      const ret = list.map((o) => ({ ...o, dep: -o.arr, arr: -o.dep })).filter((o) => o.dep >= startFrom(sun, 0) && o.dep < DAY);
      const f = summarize(outFri.get(station));
      const s = summarize(outSat.get(station));
      const r = summarize(ret);
      if (r && (f || s)) items.push({ station, fri: f, sat: s, ret: r, score: (f ? f.count : 0) + (s ? s.count : 0) + r.count });
    }
    items.sort((a, b) => b.score - a.score);
    if (fri >= today || sat >= today) out.push({ fri: fri && fri >= today ? fri : null, sat: sat && sat >= today ? sat : null, sun, items });
  }
  return out;
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
        fresh: js.filter((j) => j.isNew).length,
        count: js.length,
        direct: js.filter((j) => j.legs.length === 1).length,
        fastest: js.length ? Math.min(...js.map((j) => j.arr - j.dep)) : null,
      });
    }
    return out;
  },
  explore: (msg) => explore(msg.date, msg.places, msg.dir, msg.query),
  weekends: (msg) => weekends(msg.origins, msg.query, msg.friAfter),
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
