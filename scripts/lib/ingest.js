// Turns the CSV export of the `tgvmax` dataset into compact structures for the site.
// See docs/DATASET.md for the reasoning behind each rule.
import { displayName, cityOf } from '../../site/lib/stations.js';

export const EXCLUDED_AXES = new Set(['AUTOCAR SNCF']);

export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length);
  const header = lines[0].split(';');
  return lines.slice(1).map((line) => {
    const cells = line.split(';');
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Builds the dataset for the site.
 * - drops coaches;
 * - merges duplicates (date, train, o, d, departure): OUI wins;
 * - keeps only OUI rows as connections, since routing never uses NON rows;
 * - arrival < departure → +24 h (arrives after midnight).
 */
export function buildDataset(rows) {
  const stationRaw = new Map();
  const axes = [];
  const merged = new Map();

  for (const r of rows) {
    if (EXCLUDED_AXES.has(r.axe)) continue;
    stationRaw.set(r.origine_iata, r.origine);
    stationRaw.set(r.destination_iata, r.destination);
    const key = `${r.date}|${r.train_no}|${r.origine_iata}|${r.destination_iata}|${r.heure_depart}`;
    const ok = r.od_happy_card === 'OUI';
    const prev = merged.get(key);
    if (prev) prev.ok = prev.ok || ok;
    else merged.set(key, { r, ok });
  }

  const ids = [...stationRaw.keys()].sort((a, b) =>
    displayName(a, stationRaw.get(a)).localeCompare(displayName(b, stationRaw.get(b)), 'fr'),
  );
  const index = new Map(ids.map((id, i) => [id, i]));
  const stations = ids.map((id) => ({ id, name: displayName(id, stationRaw.get(id)), city: cityOf(id) }));

  const days = {};
  const allDates = new Set();
  for (const { r, ok } of merged.values()) {
    allDates.add(r.date);
    if (!ok) continue;
    let axe = axes.indexOf(r.axe);
    if (axe < 0) axe = axes.push(r.axe) - 1;
    const dep = toMinutes(r.heure_depart);
    let arr = toMinutes(r.heure_arrivee);
    if (arr < dep) arr += 1440;
    (days[r.date] ||= []).push([r.train_no, index.get(r.origine_iata), index.get(r.destination_iata), dep, arr, axe]);
  }
  for (const d of allDates) days[d] ||= [];
  for (const list of Object.values(days)) list.sort((a, b) => a[3] - b[3] || a[4] - b[4]);

  return { stations, axes, days, dates: [...allDates].sort() };
}

// --- New seats since the previous dataset version ---

/** Keys of available seats per date, independent of station indexes. */
export function seatKeys(ds) {
  const out = {};
  for (const date of ds.dates) {
    out[date] = (ds.days[date] || []).map(([train, o, d, dep]) => `${train}|${ds.stations[o].id}|${ds.stations[d].id}|${dep}`);
  }
  return out;
}

/**
 * Flags (index 6 = 1) the seats absent from the previous version.
 * Dates the previous version did not cover (the newly opened day) are not
 * flagged: every seat would look new.
 * @returns {number} number of new seats
 */
export function markNew(ds, previousKeys) {
  let count = 0;
  for (const date of ds.dates) {
    const prev = previousKeys && previousKeys[date];
    if (!prev) continue;
    const set = new Set(prev);
    for (const row of ds.days[date]) {
      const key = `${row[0]}|${ds.stations[row[1]].id}|${ds.stations[row[2]].id}|${row[3]}`;
      if (!set.has(key)) {
        row[6] = 1;
        count++;
      }
    }
  }
  return count;
}
