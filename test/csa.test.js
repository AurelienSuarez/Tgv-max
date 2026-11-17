import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTimetable, makeTransfers, profile, scan, fmtTime } from '../site/lib/csa.js';
import { parseCsv, buildDataset } from '../scripts/lib/ingest.js';

// Synthetic stations: A, B, C, Paris Nord, Paris Gare de Lyon, Marseille.
const ST = [
  { id: 'XA', city: null }, { id: 'XB', city: null }, { id: 'XC', city: null },
  { id: 'FRPNO', city: 'Paris' }, { id: 'FRPLY', city: 'Paris' }, { id: 'FRMSC', city: 'Marseille' },
];
const [A, B, C, PN, PL, M] = [0, 1, 2, 3, 4, 5];
const h = (s) => { const [x, y] = s.split(':').map(Number); return x * 60 + y; };
const c = (train, o, d, dep, arr) => {
  const a = h(arr), b = h(dep);
  return [train, o, d, b, a < b ? a + 1440 : a, 0];
};
const run = (days, opts) => {
  const tt = makeTimetable(days);
  return profile(tt, makeTransfers(ST, opts.minChange ?? 10), opts);
};

test('direct train', () => {
  const r = run([[c('1', A, B, '08:00', '10:00')]], { origins: [A], dests: [B] });
  assert.equal(r.length, 1);
  assert.equal(r[0].legs.length, 1);
});

test('split ticket on the same train: 2 min stop accepted', () => {
  // A→C has no MAX seat, but A→B and B→C on the same train do.
  const r = run([[c('7', A, B, '08:00', '09:00'), c('7', B, C, '09:02', '10:00')]], { origins: [A], dests: [C] });
  assert.equal(r.length, 1);
  assert.equal(r[0].legs.length, 2);
  assert.equal(r[0].legs[1].sameTrain, true);
});

test('different trains: minimum change time respected', () => {
  const day = [c('1', A, B, '08:00', '09:00'), c('2', B, C, '09:05', '10:00')];
  assert.equal(run([day], { origins: [A], dests: [C], minChange: 10 }).length, 0);
  assert.equal(run([day], { origins: [A], dests: [C], minChange: 5 }).length, 1);
});

test('change of station within Paris: Nord → Gare de Lyon takes 45 min', () => {
  const tight = [c('1', A, PN, '08:00', '10:00'), c('2', PL, M, '10:30', '13:30')];
  assert.equal(run([tight], { origins: [A], dests: [M] }).length, 0);
  const ok = [c('1', A, PN, '08:00', '10:00'), c('2', PL, M, '10:50', '13:50')];
  const r = run([ok], { origins: [A], dests: [M] });
  assert.equal(r.length, 1);
  assert.equal(r[0].legs[1].stationChange, true);
});

test('origin as a city: any Paris station', () => {
  const day = [c('1', PN, A, '08:00', '09:00'), c('2', PL, A, '09:00', '09:30')];
  const r = run([day], { origins: [PN, PL], dests: [A] });
  assert.equal(r.length, 2);
});

test('past midnight: arrival at 00:29 then connection on the next day', () => {
  const d0 = [c('6953', A, B, '23:50', '00:29')];
  const d1 = [c('9', B, C, '06:00', '07:00')];
  const r = run([d0, d1], { origins: [A], dests: [C], maxWait: 8 * 60 });
  assert.equal(r.length, 1);
  assert.equal(r[0].arr, 1440 + h('07:00'));
  assert.equal(fmtTime(r[0].arr), '07:00 (+1)');
});

test('past midnight: connection at 00:45 on day D+1 without a long wait', () => {
  const d0 = [c('1', A, B, '23:30', '00:20')];
  const d1 = [c('2', B, C, '00:45', '01:30')];
  const r = run([d0, d1], { origins: [A], dests: [C] });
  assert.equal(r.length, 1);
  assert.equal(r[0].legs[1].dep, 1440 + 45);
});

test('next-day trains are not used for the first departure', () => {
  const r = run([[], [c('1', A, B, '06:00', '07:00')]], { origins: [A], dests: [B] });
  assert.equal(r.length, 0);
});

test('ticket limit', () => {
  const day = [c('1', A, B, '08:00', '09:00'), c('2', B, PN, '09:30', '10:00'), c('3', PN, C, '10:30', '11:00')];
  assert.equal(run([day], { origins: [A], dests: [C], maxLegs: 2 }).length, 0);
  assert.equal(run([day], { origins: [A], dests: [C], maxLegs: 3 }).length, 1);
});

test('profile: keeps the non-dominated trips only', () => {
  const day = [
    c('1', A, B, '08:00', '12:00'), // dominated by train 2
    c('2', A, B, '08:30', '11:00'),
    c('3', A, B, '09:00', '13:00'),
    c('4', A, C, '07:00', '07:30'), c('5', C, B, '07:45', '08:30'), // 2 tickets, earliest arrival
  ];
  const r = run([day], { origins: [A], dests: [B] });
  assert.deepEqual(r.map((j) => j.legs.map((l) => l.train).join('+')), ['4+5', '2', '3']);
});

test('real sample: duplicates merged, Paris → Nice on 20/11', () => {
  const ds = buildDataset(parseCsv(readFileSync(new URL('../docs/sample/tgvmax-sample.csv', import.meta.url), 'utf8')));
  // Night train 5781 on 18/11: OUI+NON duplicates → a single OUI connection.
  const nice = ds.stations.findIndex((s) => s.id === 'FRNIC');
  const paz = ds.stations.findIndex((s) => s.id === 'FRPAZ');
  const n18 = ds.days['2026-11-18'].filter((x) => x[1] === paz && x[2] === nice);
  assert.equal(n18.length, 1);
  assert.equal(n18[0][4], 1440 + 9 * 60 + 9);

  const paris = ds.stations.map((s, i) => (s.city === 'Paris' ? i : -1)).filter((i) => i >= 0);
  const tt = makeTimetable([ds.days['2026-11-20'], ds.days['2026-11-21']]);
  const r = profile(tt, makeTransfers(ds.stations), { origins: paris, dests: [nice] });
  assert.ok(r.some((j) => j.legs.length === 1 && j.legs[0].train === '6175'));
  assert.equal(ds.stations.find((s) => s.id === 'FRPLY').name, 'Paris Gare de Lyon');
});

test('coaches are excluded', () => {
  const rows = parseCsv('date;train_no;entity;axe;origine_iata;destination_iata;origine;destination;heure_depart;heure_arrivee;od_happy_card\n'
    + '2026-11-20;1;X;AUTOCAR SNCF;FRAAA;FRBBB;AAA;BBB;08:00;09:00;OUI\n'
    + '2026-11-20;2;X;SUD EST;FRAAA;FRCCC;AAA;CCC;08:00;09:00;OUI');
  const ds = buildDataset(rows);
  assert.equal(ds.days['2026-11-20'].length, 1);
  assert.ok(!ds.stations.some((s) => s.id === 'FRBBB'));
});

test('scan: the first leg may depart from any origin station', () => {
  const tt = makeTimetable([[c('1', PL, A, '08:00', '09:00')]]);
  const best = scan(tt, makeTransfers(ST), { origins: new Set([PN, PL]), dests: new Set([A]), start: 0, maxLegs: 1 });
  assert.equal(best[1].t, h('09:00'));
});

test('maximum wait in a connection: no night spent in the station by default', () => {
  const day = [c('1', A, B, '21:00', '23:00')];
  const next = [c('2', B, C, '07:00', '08:00')];
  assert.equal(run([day, next], { origins: [A], dests: [C] }).length, 0);
  assert.equal(run([day, next], { origins: [A], dests: [C], maxWait: 12 * 60 }).length, 1);
});
