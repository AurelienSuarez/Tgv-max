import { fmtTime, fmtDuration, DAY } from './lib/csa.js';
import { createMap } from './map.js';
import { interStationMinutes } from './lib/stations.js';

const EMB = window.__MAXRELAIS__ || null;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`maxrelais:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`maxrelais:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const PAGE = 15;
const state = {
  from: null, to: null, date: null, retDate: null, rt: false, tab: 'trajets',
  shown: { a: PAGE, r: PAGE }, onlyNew: false, calPick: 'a',
  exploreFilter: '', exploreDir: 'from', exploreLegs: 1, trip: 'a0',
  sort: 'dep', after: 0, before: 0, noNight: false,
  friAfter: 15 * 60, weekend: 0, weekendOpen: {},
};
let lastWeekends = [];
let meta, stations, axes, places, dates, worker, map;
let lastTrips = { a: [], r: [] };
let reqId = 0;
const pending = new Map();

function call(type, payload) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
  });
}

function trainLabel(axeIdx, train) {
  const axe = axes[axeIdx] || '';
  const kind = axe === 'IC NUIT' ? 'Intercités de nuit' : axe.startsWith('IC') ? 'Intercités' : axe === 'INTERNATIONAL' ? 'TGV international' : 'TGV INOUI';
  return `${kind} ${train}`;
}

function todayParis() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}
function nowMinutesParis() {
  const [h, m] = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
  return h * 60 + m;
}
const dateObj = (d) => new Date(`${d}T12:00:00`);
const fmtDate = (d, opts) => dateObj(d).toLocaleDateString('fr-FR', opts);

function buildPlaces() {
  const out = [];
  const cities = new Map();
  stations.forEach((s, i) => {
    out.push({ key: s.id, label: s.name, sub: s.city ? `gare de ${s.city}` : '', ids: [i], n: norm(s.name) });
    if (s.city) (cities.get(s.city) || cities.set(s.city, []).get(s.city)).push(i);
  });
  for (const [city, ids] of cities) {
    if (ids.length < 2) continue;
    out.push({ key: `city:${city}`, label: city, sub: `toutes les gares (${ids.length})`, ids, n: norm(city), city: true });
  }
  return out;
}

function findPlace(key) {
  return places.find((p) => p.key === key) || null;
}

function matchPlaces(q) {
  const nq = norm(q);
  if (!nq) return places.filter((p) => p.city).slice(0, 8);
  const scored = [];
  for (const p of places) {
    const i = p.n.indexOf(nq);
    if (i < 0) continue;
    const wordStart = i === 0 || p.n[i - 1] === ' ';
    scored.push([p, (i === 0 ? 0 : wordStart ? 1 : 2) * 10 + (p.city ? 0 : 1), p.label]);
  }
  scored.sort((a, b) => a[1] - b[1] || a[2].localeCompare(b[2], 'fr'));
  return scored.slice(0, 8).map((x) => x[0]);
}

function combobox(input, list, onPick) {
  let items = [];
  let active = -1;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const render = () => {
    items = matchPlaces(input.value);
    list.innerHTML = items.length
      ? items.map((p, i) => `<li role="option" id="${list.id}-${i}" aria-selected="${i === active}" data-i="${i}"><span>${esc(p.label)}</span><small>${esc(p.sub)}</small></li>`).join('')
      : '<li aria-disabled="true"><span>Aucune gare trouvée</span></li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `${list.id}-${active}` : '');
  };
  const pick = (i) => {
    const p = items[i];
    if (!p) return;
    input.value = p.label;
    close();
    onPick(p);
  };
  input.addEventListener('focus', () => { input.select(); active = -1; render(); });
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { render(); return; }
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (!list.hidden) { pick(Math.max(0, active)); e.preventDefault(); } }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); pick(Number(li.dataset.i)); }
  });
  input.addEventListener('blur', () => {
    setTimeout(close, 100);
    const cur = input.id === 'from' ? state.from : state.to;
    if (cur && input.value !== cur.label) input.value = cur.label;
  });
}

function query(reverse = false) {
  return {
    origins: (reverse ? state.to : state.from).ids,
    dests: (reverse ? state.from : state.to).ids,
    maxLegs: Number($('#maxLegs').value),
    minChange: Number($('#minChange').value),
    maxWait: Number($('#maxWait').value),
  };
}

const DAY_LONG = { weekday: 'long', day: 'numeric', month: 'long' };
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

// The last date of the window is the day SNCF just opened (D+30).
const openedDate = () => meta.dates[meta.dates.length - 1];

function dateChips(list, selected) {
  return list
    .map((d) => {
      const o = dateObj(d);
      const isOpened = d === openedDate();
      return `<button type="button" class="date-chip${isOpened ? ' opened-chip' : ''}" role="option" data-date="${d}" aria-selected="${d === selected}"${isOpened ? ' title="Jour qui vient d\'ouvrir"' : ''}>
        <span class="dow">${esc(o.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', ''))}</span>
        <span class="num">${o.getDate()}</span>
        <span class="mon">${isOpened ? 'ouvert' : esc(o.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', ''))}</span></button>`;
    })
    .join('');
}

function renderOpened() {
  const d = openedDate();
  const box = $('#opened');
  if (!d || !meta.seatsByDate || !dates.includes(d) || isStale()) return; // an old 'new day' would be wrong
  const counts = meta.dates.filter((x) => x !== d && dates.includes(x)).map((x) => meta.seatsByDate[x] || 0).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const n = meta.seatsByDate[d] || 0;
  const day = fmtDate(d, DAY_LONG);
  const few = median && n < median * 0.2;
  box.innerHTML = `<span class="opened-tag">Nouveau jour</span>
    <span>Le <strong>${esc(day)}</strong> vient d'ouvrir à la réservation. ${few
      ? `Pour l'instant, il n'a que ${n} place${n > 1 ? 's' : ''} gratuite${n > 1 ? 's' : ''} (environ ${median.toLocaleString('fr-FR')} les autres jours) : ses places arrivent sans doute plus tard. Reviens voir après la prochaine mise à jour.`
      : `Il a déjà ${n.toLocaleString('fr-FR')} places gratuites : c'est le moment d'en profiter.`}</span>
    <button type="button" class="linkish" id="opened-go">Voir ce jour</button>`;
  box.hidden = false;
  $('#opened-go').addEventListener('click', () => { setDate(d); if (state.tab !== 'trajets') setTab('trajets'); refresh(); });
}

function renderDates() {
  $('#dates').innerHTML = dateChips(dates, state.date);
  $('#ret-field').hidden = !state.rt;
  $('#rt').checked = state.rt;
  if (state.rt) $('#ret-dates').innerHTML = dateChips(dates.filter((d) => d >= state.date), state.retDate);
  for (const box of ['#dates', '#ret-dates']) {
    const sel = $(`${box} [aria-selected="true"]`);
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function addDays(d, n) {
  const o = dateObj(d);
  o.setDate(o.getDate() + n);
  return o.toLocaleDateString('en-CA');
}

function setDate(d) {
  state.date = d;
  if (!state.retDate || state.retDate < d) state.retDate = dates.includes(addDays(d, 2)) ? addDays(d, 2) : dates[dates.length - 1];
  state.trip = 'a0';
  state.shown = { a: PAGE, r: PAGE };
  renderDates();
}

function setRetDate(d) {
  state.retDate = d;
  state.trip = 'a0';
  state.shown.r = PAGE;
  renderDates();
}

function setTab(t) {
  state.tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
}

function stationName(i) {
  return stations[i].name;
}

function journeyCard(j, key) {
  const n = j.legs.length;
  const nextDay = Math.floor(j.arr / DAY);
  const chips = [];
  if (j.isNew) chips.push('<span class="chip new">Nouveau</span>');
  if (n === 1) chips.push('<span class="chip direct">Direct</span>');
  else chips.push(`<span class="chip">${n} billets</span>`);
  if (j.legs.some((l) => l.sameTrain)) chips.push('<span class="chip split">2 billets dans le même train</span>');
  if (j.legs.some((l) => l.stationChange)) chips.push('<span class="chip">Changement de gare</span>');
  if (j.legs.some((l) => l.axe != null && axes[l.axe] === 'IC NUIT')) chips.push('<span class="chip">Train de nuit</span>');

  const parts = [];
  j.legs.forEach((l, k) => {
    if (k > 0) {
      const prev = j.legs[k - 1];
      if (l.sameTrain) {
        parts.push(`<li class="transfer same">Tu restes dans le train ${esc(l.train)} à ${esc(stationName(l.from))} : le billet suivant commence ici (arrêt de ${l.wait} min).</li>`);
      } else if (l.stationChange) {
        const need = interStationMinutes(stations[prev.to].id, stations[l.from].id);
        parts.push(`<li class="transfer city">Changement de gare : ${esc(stationName(prev.to))} → ${esc(stationName(l.from))}. Tu as ${fmtDuration(l.wait)}${need ? ` ; compte environ ${fmtDuration(need)} pour aller d'une gare à l'autre (estimation)` : ''}.</li>`);
      } else {
        parts.push(`<li class="transfer">Correspondance de ${fmtDuration(l.wait)} à ${esc(stationName(l.from))}</li>`);
      }
    }
    parts.push(`<li class="ticket">
      <div class="tk-time"><span>${fmtTime(l.dep).replace(/ \(\+\d\)/, '')}</span><span>${fmtTime(l.arr).replace(/ \(\+\d\)/, '')}</span></div>
      <div class="tk-body"><span class="tk-route">${esc(stationName(l.from))} → ${esc(stationName(l.to))}</span><span class="tk-train">${n > 1 ? `<span class="tk-num">Billet ${k + 1}/${n}</span>` : ''}${esc(trainLabel(l.axe, l.train))} · ${fmtDuration(l.arr - l.dep)}${l.dep >= DAY ? ' · lendemain' : ''}${l.isNew ? ' · <b class="new-txt">place apparue depuis hier</b>' : ''}</span></div>
    </li>`);
  });

  return `<article class="trip${key === state.trip ? ' selected' : ''}" data-j="${key}" tabindex="0" aria-label="Trajet de ${fmtTime(j.dep)}, voir sur la carte">
    <header class="trip-head">
      <div class="times"><span>${fmtTime(j.dep)}</span><span class="arrow">→</span><span>${fmtTime(j.arr % DAY)}${nextDay ? `<sup>+${nextDay}</sup>` : ''}</span></div>
      <div class="trip-meta">${fmtDuration(j.arr - j.dep)}</div>
      <div class="chips">${chips.join('')}</div>
    </header>
    <ol class="tickets">${parts.join('')}</ol>
  </article>`;
}

function needPlaces(view) {
  const needFrom = view === 'depart' ? state.exploreDir === 'from' : true;
  const needTo = view === 'depart' ? state.exploreDir === 'to' : true;
  if ((needFrom && !state.from) || (needTo && !state.to)) {
    const which = needFrom && !state.from ? 'une gare de départ' : "une gare d'arrivée";
    $('#view').innerHTML = `<div class="empty"><strong>Choisis ${which}</strong>Tape le nom d'une ville ou d'une gare, ou touche une gare sur la carte.</div>`;
    if (map) map.draw({ items: [], legs: [], focus: [] });
    return true;
  }
  return false;
}

function placeOf(i) {
  return places.find((p) => p.key === stations[i].id);
}

function tripByKey(key) {
  return lastTrips[key[0]] && lastTrips[key[0]][Number(key.slice(1))];
}

function drawTripMap() {
  const j = tripByKey(state.trip) || lastTrips.a[0] || lastTrips.r[0];
  if (!j) { map.draw({ items: [], legs: [], focus: [...state.from.ids.slice(0, 1), ...state.to.ids.slice(0, 1)] }); return; }
  const legs = [];
  const items = [];
  j.legs.forEach((l, k) => {
    if (k > 0 && l.stationChange) legs.push([j.legs[k - 1].to, l.from, 'walk']);
    legs.push([l.from, l.to, 'leg']);
    if (k > 0) items.push({ station: l.from, weight: 1, info: `Changement à ${fmtTime(l.dep)}` });
  });
  map.draw({ items, legs, focus: [j.legs[0].from, j.legs[j.legs.length - 1].to] });
}

async function searchSide(side) {
  const reverse = side === 'r';
  const date = reverse ? state.retDate : state.date;
  const q = query(reverse);
  if (date === todayParis()) q.from = nowMinutesParis();
  return call('search', { date, query: q });
}

const isNight = (j) => j.legs.some((l) => axes[l.axe] === 'IC NUIT');

function applyFilters(js) {
  const out = js.filter((j) =>
    (!state.after || j.dep >= state.after)
    && (!state.before || j.arr <= state.before)
    && (!state.noNight || !isNight(j))
    && (!state.onlyNew || j.isNew));
  const key = {
    dep: (j) => j.dep,
    arr: (j) => j.arr,
    dur: (j) => j.arr - j.dep,
    legs: (j) => j.legs.length * 1e5 + j.dep,
  }[state.sort];
  return out.sort((a, b) => key(a) - key(b) || a.dep - b.dep);
}

function filterBar(anyNew) {
  const opt = (v, label, cur) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${label}</option>`;
  const hours = [0, 6, 9, 12, 15, 17, 19].map((h) => opt(h * 60, h ? `après ${h}h` : 'à toute heure', state.after)).join('');
  const arrive = [0, 12, 15, 18, 21, 24].map((h) => opt(h * 60, h ? (h === 24 ? 'avant minuit' : `avant ${h}h`) : 'à toute heure', state.before)).join('');
  return `<div class="filters" role="group" aria-label="Trier et filtrer">
    <label class="mini"><span>Trier par</span><select id="f-sort">
      ${opt('dep', 'heure de départ', state.sort)}${opt('arr', "heure d'arrivée", state.sort)}${opt('dur', 'durée', state.sort)}${opt('legs', 'nombre de billets', state.sort)}
    </select></label>
    <label class="mini"><span>Partir</span><select id="f-after">${hours}</select></label>
    <label class="mini"><span>Arriver</span><select id="f-before">${arrive}</select></label>
    <label class="check"><input type="checkbox" id="f-nonight"${state.noNight ? ' checked' : ''}> Sans train de nuit</label>
    ${anyNew || state.onlyNew ? `<button type="button" class="toggle" data-onlynew aria-pressed="${state.onlyNew}">Nouvelles places seulement</button>` : ''}
  </div>`;
}

function sectionHtml(side, js) {
  const reverse = side === 'r';
  const a = reverse ? state.to : state.from;
  const b = reverse ? state.from : state.to;
  const date = reverse ? state.retDate : state.date;
  const day = fmtDate(date, DAY_LONG);
  const title = state.rt ? `<h2 class="leg-title"><span>${reverse ? 'Retour' : 'Aller'}</span> ${esc(day)}</h2>` : '';
  const shownList = applyFilters(js);
  if (!js.length) {
    return `${title}<div class="empty"><strong>Aucune place gratuite ${esc(a.label)} → ${esc(b.label)} le ${esc(day)}.</strong>
      Essaie d'autoriser plus de billets ou une attente plus longue dans les réglages, ou regarde le calendrier.
      <div><button type="button" class="btn" data-goto="calendrier">Voir le calendrier</button></div></div>`;
  }
  const direct = js.filter((j) => j.legs.length === 1).length;
  const fresh = js.filter((j) => j.isNew).length;
  const filtered = shownList.length !== js.length ? ` · ${shownList.length} avec tes filtres` : '';
  const summary = `<p class="summary"><strong>${plural(js.length, 'trajet')}</strong> ${esc(a.label)} → ${esc(b.label)}${state.rt ? '' : ` le ${esc(day)}`} · ${direct} direct${direct > 1 ? 's' : ''}, ${js.length - direct} en plusieurs billets${fresh ? ` · <b class="new-txt">${plural(fresh, 'nouveau', 'nouveaux')}</b>` : ''}${filtered}</p>`;
  const limit = state.shown[side];
  const cards = shownList.slice(0, limit).map((j) => journeyCard(j, `${side}${js.indexOf(j)}`)).join('');
  const more = shownList.length > limit ? `<button type="button" class="btn ghost more" data-more="${side}">Afficher ${Math.min(PAGE, shownList.length - limit)} trajets de plus</button>` : '';
  const none = !shownList.length ? `<div class="empty">${state.onlyNew ? 'Pas de nouvelle place depuis hier avec ces filtres.' : 'Aucun trajet ne correspond aux filtres.'}</div>` : '';
  return `<section class="leg-block">${title}${summary}${cards}${none}${more}</section>`;
}

async function showTrips() {
  if (needPlaces('trajets')) return;
  const view = $('#view');
  view.innerHTML = '<p class="loading">Recherche des places…</p>';
  const token = ++showTrips.token;
  let a;
  let r = [];
  try {
    [a, r] = await Promise.all([searchSide('a'), state.rt ? searchSide('r') : Promise.resolve([])]);
  } catch (e) {
    view.innerHTML = `<div class="empty"><strong>Les données de ce jour n'ont pas pu être chargées.</strong>${esc(e.message)}. Recharge la page pour réessayer.</div>`;
    return;
  }
  if (token !== showTrips.token) return;
  lastTrips = { a, r };
  if (!tripByKey(state.trip)) state.trip = a.length ? 'a0' : 'r0';
  drawTripMap();
  const anyNew = [...a, ...r].some((j) => j.isNew);
  view.innerHTML = filterBar(anyNew) + sectionHtml('a', a) + (state.rt ? sectionHtml('r', r) : '');
}
showTrips.token = 0;

async function showCalendar() {
  if (needPlaces('calendrier')) return;
  const view = $('#view');
  view.innerHTML = '<p class="loading">Calcul des 30 prochains jours…</p>';
  const token = ++showTrips.token;
  const [resA, resR] = await Promise.all([
    call('calendar', { dates, query: query() }),
    state.rt ? call('calendar', { dates, query: query(true) }) : Promise.resolve(null),
  ]);
  if (token !== showTrips.token) return;
  const pickR = state.rt && state.calPick === 'r';
  const main = pickR ? resR : resA;
  const max = Math.max(1, ...main.map((r) => r.count));
  const total = main.filter((r) => r.count).length;
  const a = pickR ? state.to : state.from;
  const b = pickR ? state.from : state.to;
  let html = '';
  if (state.rt) {
    html += `<div class="seg" role="radiogroup" aria-label="Jour à choisir">
      <button type="button" role="radio" data-calpick="a" aria-checked="${!pickR}">Choisir le jour de l'aller</button>
      <button type="button" role="radio" data-calpick="r" aria-checked="${pickR}">Choisir le jour du retour</button></div>`;
  }
  html += `<p class="summary"><strong>${total} jour${total > 1 ? 's' : ''} sur ${main.length}</strong> avec au moins un trajet gratuit ${esc(a.label)} → ${esc(b.label)}. Touche un jour pour voir les trajets.</p>`;
  let month = '';
  let grid = '';
  const flush = () => { if (grid) html += `<div class="cal">${['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'].map((d) => `<span class="dow">${d}</span>`).join('')}${grid}</div>`; grid = ''; };
  main.forEach((r, i) => {
    const o = dateObj(r.date);
    const m = o.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    if (m !== month) {
      flush();
      month = m;
      html += `<h2 class="cal-month">${esc(m)}</h2>`;
      grid += '<span></span>'.repeat((o.getDay() + 6) % 7);
    }
    const other = state.rt ? (pickR ? resA[i] : resR[i]) : null;
    const heat = r.count ? 0.25 + 0.75 * (r.count / max) : 0;
    const selected = pickR ? state.retDate : state.date;
    const label = `${r.count ? plural(r.count, 'trajet') : 'aucun trajet'}${r.fresh ? `, dont ${plural(r.fresh, 'nouveau', 'nouveaux')}` : ''}${other ? `, ${plural(other.count, 'trajet')} dans l'autre sens` : ''}`;
    const disabled = pickR && r.date < state.date;
    const opened = r.date === openedDate() ? '<span class="cal-opened">ouvert</span>' : '';
    grid += `<button type="button" class="cal-cell${r.count ? '' : ' none'}${heat > 0.6 ? ' hot' : ''}" style="--heat:${heat.toFixed(2)}" data-date="${r.date}" ${disabled ? 'disabled' : ''} ${r.date === selected ? 'aria-current="date"' : ''} aria-label="${esc(fmtDate(r.date, DAY_LONG))} : ${label}">
      <span class="d">${o.getDate()}${r.fresh ? '<i class="fresh" aria-hidden="true"></i>' : ''}${opened}</span>
      <span class="n">${r.count ? `${r.count}${r.direct ? ` · ${r.direct}D` : ''}` : '–'}${other ? `<br><span class="other">${pickR ? 'A' : 'R'} ${other.count}</span>` : ''}</span></button>`;
  });
  flush();
  html += `<p class="legend">Le chiffre compte les trajets gratuits possibles ce jour-là ; « D » compte les directs.${state.rt ? ` « ${pickR ? 'A' : 'R'} » compte les trajets dans l'autre sens.` : ''} Un point signale des places apparues depuis hier ; « ouvert » marque le jour qui vient d'ouvrir à la réservation. Plus la case est foncée, plus il y a de choix.</p>`;
  view.innerHTML = html;
}

async function showExplore() {
  const dir = state.exploreDir;
  const legs = state.exploreLegs;
  const seg = `<div class="seg" role="radiogroup" aria-label="Sens">
      <button type="button" role="radio" data-dir="from" aria-checked="${dir === 'from'}">Au départ de ${esc(state.from ? state.from.label : '…')}</button>
      <button type="button" role="radio" data-dir="to" aria-checked="${dir === 'to'}">À l'arrivée à ${esc(state.to ? state.to.label : '…')}</button>
    </div>
    <div class="seg small" role="radiogroup" aria-label="Correspondances">
      <button type="button" role="radio" data-legs="1" aria-checked="${legs === 1}">Trains directs</button>
      <button type="button" role="radio" data-legs="2" aria-checked="${legs === 2}">Avec correspondance</button>
    </div>`;
  if (needPlaces('depart')) { $('#view').insertAdjacentHTML('afterbegin', seg); return; }
  const place = dir === 'from' ? state.from : state.to;
  const view = $('#view');
  view.innerHTML = seg + `<p class="loading">${legs === 1 ? 'Recherche des trains directs…' : 'Recherche des trajets avec correspondance…'}</p>`;
  const token = ++showTrips.token;
  const q = { ...query(), maxLegs: legs };
  if (state.date === todayParis()) q.from = nowMinutesParis();
  const res = await call('explore', { date: state.date, places: place.ids, dir, query: q });
  if (token !== showTrips.token) return;
  const day = fmtDate(state.date, DAY_LONG);
  const unit = legs === 1 ? 'train' : 'trajet';
  const info = (r) => [
    `${plural(r.count, unit)}`,
    r.first === r.last ? `à ${fmtTime(r.first)}` : `de ${fmtTime(r.first)} à ${fmtTime(r.last)}`,
    `dès ${fmtDuration(r.shortest)}`,
    legs > 1 ? (r.direct ? 'direct possible' : 'avec correspondance') : '',
  ].filter(Boolean).join(' · ') + (r.fresh ? ` · <b class="new-txt">${plural(r.fresh, 'nouveau', 'nouveaux')}</b>` : '');
  map.draw({
    focus: place.ids,
    focusLabel: place.city ? place.label : null,
    items: res.map((r) => ({ station: r.station, weight: r.count, info: info(r), trips: true })),
    legs: res.map((r) => (dir === 'from' ? [r.via, r.station, 'from'] : [r.station, r.via, 'to'])),
  });
  const how = legs === 1 ? 'en direct' : 'en 2 billets au plus';
  if (!res.length) {
    view.innerHTML = seg + `<div class="empty"><strong>Aucune place gratuite ${how} ${dir === 'from' ? 'au départ de' : "pour aller à"} ${esc(place.label)} le ${esc(day)}.</strong>Essaie un autre jour${legs === 1 ? ' ou « Avec une correspondance »' : ''}.</div>`;
    return;
  }
  res.sort((a, b) => b.count - a.count || stationName(a.station).localeCompare(stationName(b.station), 'fr'));
  const f = norm(state.exploreFilter);
  const what = dir === 'from' ? 'destinations' : 'gares de départ';
  view.innerHTML = seg + `<p class="summary"><strong>${res.length} ${what}</strong> avec des places gratuites ${how} ${dir === 'from' ? 'au départ de' : 'pour aller à'} ${esc(place.label)} le ${esc(day)}. Touche une gare sur la carte ou dans la liste.</p>
    <div class="filter"><input id="explore-filter" type="search" placeholder="Filtrer les gares" value="${esc(state.exploreFilter)}" aria-label="Filtrer les gares"></div>
    <ul class="dest-list">${res.map((r) => `<li${f && !norm(stationName(r.station)).includes(f) ? ' hidden' : ''}><span class="name">${esc(stationName(r.station))}</span>
      <span class="info">${info(r)}</span>
      <button type="button" class="btn ghost" data-pick="${r.station}">Trajets</button></li>`).join('')}</ul>`;
}

function shortDay(d) {
  return fmtDate(d, { weekday: 'short', day: 'numeric' }).replace('.', '');
}

function drawWeekendMap() {
  const w = lastWeekends[state.weekend];
  if (!w) { map.draw({ items: [], legs: [], focus: state.from.ids }); return; }
  const via = state.from.ids[0];
  map.draw({
    focus: state.from.ids,
    focusLabel: state.from.city ? state.from.label : null,
    items: w.items.map((it) => ({ station: it.station, weight: it.score, info: weekendInfo(w, it, ' · '), trips: true })),
    legs: w.items.map((it) => [via, it.station, 'from']),
  });
}

function weekendInfo(w, it, sep = '<br>') {
  const outs = [];
  if (it.fri) outs.push(`${shortDay(w.fri)} dès ${fmtTime(it.fri.first)} (${it.fri.count})`);
  if (it.sat) outs.push(`${shortDay(w.sat)} dès ${fmtTime(it.sat.first)} (${it.sat.count})`);
  return `Aller : ${outs.join(', ')}${sep}Retour : ${shortDay(w.sun)} jusqu'à ${fmtTime(it.ret.last)} (${it.ret.count})`;
}

async function showWeekends() {
  const legs = state.exploreLegs;
  const opt = (v, label) => `<option value="${v}"${v === state.friAfter ? ' selected' : ''}>${label}</option>`;
  const controls = `<div class="seg small" role="radiogroup" aria-label="Correspondances">
      <button type="button" role="radio" data-legs="1" aria-checked="${legs === 1}">Trains directs</button>
      <button type="button" role="radio" data-legs="2" aria-checked="${legs === 2}">Avec correspondance</button>
    </div>
    <div class="filters"><label class="mini"><span>Le vendredi, partir</span><select id="f-friafter">
      ${opt(12 * 60, 'après 12h')}${opt(15 * 60, 'après 15h')}${opt(17 * 60, 'après 17h')}${opt(19 * 60, 'après 19h')}
    </select></label></div>`;
  if (!state.from) {
    $('#view').innerHTML = '<div class="empty"><strong>Choisis une gare de départ</strong>Les week-ends sont calculés au départ de cette gare.</div>';
    return;
  }
  const view = $('#view');
  view.innerHTML = controls + '<p class="loading">Recherche des week-ends possibles…</p>';
  const token = ++showTrips.token;
  const q = { ...query(), maxLegs: legs, today: todayParis(), from: nowMinutesParis() };
  lastWeekends = await call('weekends', { origins: state.from.ids, query: q, friAfter: state.friAfter });
  if (token !== showTrips.token) return;
  if (state.weekend >= lastWeekends.length) state.weekend = 0;
  drawWeekendMap();
  if (!lastWeekends.length) {
    view.innerHTML = controls + '<div class="empty"><strong>Aucun week-end dans les 30 prochains jours.</strong></div>';
    return;
  }
  const blocks = lastWeekends.map((w, wi) => {
    const start = w.fri || w.sat;
    const title = `Week-end du ${fmtDate(start, { weekday: 'long', day: 'numeric' })} au ${fmtDate(w.sun, { weekday: 'long', day: 'numeric', month: 'long' })}`;
    const open = state.weekendOpen[w.sun];
    const list = open ? w.items : w.items.slice(0, 8);
    const items = list.map((it) => `<li><span class="name">${esc(stationName(it.station))}${(it.fri && it.fri.fresh) || (it.sat && it.sat.fresh) || it.ret.fresh ? ' <span class="chip new">Nouveau</span>' : ''}</span>
        <span class="info">${weekendInfo(w, it)}</span>
        <button type="button" class="btn ghost" data-wk="${wi}" data-st="${it.station}">Voir</button></li>`).join('');
    const more = w.items.length > 8 && !open ? `<button type="button" class="btn ghost more" data-wkopen="${w.sun}">Voir les ${w.items.length} destinations</button>` : '';
    return `<section class="wk${wi === state.weekend ? ' selected' : ''}">
      <button type="button" class="wk-head" data-wksel="${wi}" aria-pressed="${wi === state.weekend}">
        <span class="wk-title">${esc(title)}</span>
        <span class="wk-count">${w.items.length ? plural(w.items.length, 'destination') : 'aucune destination'} aller + retour gratuits</span>
      </button>
      ${w.items.length ? `<ul class="dest-list">${items}</ul>${more}` : '<p class="summary">Pas de combinaison aller + retour gratuite ce week-end.</p>'}
    </section>`;
  }).join('');
  view.innerHTML = controls + `<p class="summary">Destinations où tu peux partir <strong>gratuitement</strong> le vendredi ou le samedi <strong>et</strong> revenir gratuitement le dimanche, au départ de ${esc(state.from.label)}. Touche un week-end pour le voir sur la carte.</p>` + blocks;
}

function openWeekendTrip(wi, station) {
  const w = lastWeekends[wi];
  const it = w.items.find((x) => x.station === station);
  const p = placeOf(station);
  if (!p) return;
  state.to = p;
  $('#to').value = p.label;
  state.rt = true;
  const out = it.fri ? w.fri : w.sat;
  setDate(out);
  setRetDate(w.sun);
  if (it.fri && out === w.fri) state.after = state.friAfter;
  $('#maxLegs').value = String(Math.max(Number($('#maxLegs').value), state.exploreLegs));
  setTab('trajets');
  refresh();
  window.scrollTo({ top: $('.tabs').offsetTop - 8 });
}

function mapAction(act, i) {
  const p = placeOf(i);
  if (!p) return;
  if (act === 'from') { state.from = p; $('#from').value = p.label; }
  else if (act === 'to') { state.to = p; $('#to').value = p.label; }
  else if (act === 'trips') {
    if (state.tab === 'weekends') {
      const w = lastWeekends[state.weekend];
      if (w && w.items.some((x) => x.station === i)) { openWeekendTrip(state.weekend, i); return; }
    }
    if (state.tab === 'depart' && state.exploreDir === 'to') { state.from = p; $('#from').value = p.label; }
    else { state.to = p; $('#to').value = p.label; }
    if (state.tab === 'depart') {
      $('#maxLegs').value = String(Math.max(Number($('#maxLegs').value), state.exploreLegs));
    }
    setTab('trajets');
  }
  state.trip = 'a0';
  state.shown = { a: PAGE, r: PAGE };
  refresh();
}

function selectTrip(key) {
  state.trip = key;
  document.querySelectorAll('.trip[data-j]').forEach((c) => c.classList.toggle('selected', c.dataset.j === key));
  drawTripMap();
  const m = $('#map');
  if (m.getBoundingClientRect().bottom < 60) m.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function refresh() {
  persist();
  $('#map').hidden = state.tab === 'calendrier';
  if (state.tab === 'calendrier') return showCalendar();
  if (state.tab === 'depart') return showExplore();
  if (state.tab === 'weekends') return showWeekends();
  return showTrips();
}

function persist() {
  const s = {
    from: state.from?.key, to: state.to?.key, date: state.date, retDate: state.retDate, rt: state.rt,
    maxLegs: $('#maxLegs').value, minChange: $('#minChange').value, maxWait: $('#maxWait').value,
    tab: state.tab, dir: state.exploreDir, legs: state.exploreLegs,
    sort: state.sort, after: state.after, before: state.before, noNight: state.noNight, friAfter: state.friAfter,
  };
  store.set('last', s);
  if (!EMB) {
    try {
      const p = new URLSearchParams();
      if (s.from) p.set('de', s.from);
      if (s.to) p.set('a', s.to);
      if (s.date) p.set('le', s.date);
      if (s.rt && s.retDate) p.set('retour', s.retDate);
      if (s.tab !== 'trajets') p.set('vue', s.tab);
      history.replaceState(null, '', `${location.pathname}?${p}`);
    } catch { /* no history API */ }
  }
}

function restore() {
  const saved = store.get('last') || {};
  let params = new URLSearchParams();
  try { params = new URLSearchParams(location.search); } catch { /* ignore */ }
  const shared = params.has('de') || params.has('a');
  state.from = findPlace(params.get('de') || saved.from || 'city:Paris');
  state.to = findPlace(params.get('a') || saved.to || 'city:Marseille');
  const d = params.get('le') || saved.date;
  setDate(dates.includes(d) ? d : dates[0]);
  const ret = params.get('retour') || (shared ? null : saved.rt && saved.retDate);
  state.rt = !!ret;
  if (ret && dates.includes(ret) && ret >= state.date) state.retDate = ret;
  const tab = params.get('vue') || saved.tab;
  if (['trajets', 'calendrier', 'depart', 'weekends'].includes(tab)) state.tab = tab;
  if (saved.dir === 'to') state.exploreDir = 'to';
  if (saved.legs === 2) state.exploreLegs = 2;
  if (['dep', 'arr', 'dur', 'legs'].includes(saved.sort)) state.sort = saved.sort;
  for (const k of ['after', 'before', 'friAfter']) if (Number.isFinite(saved[k])) state[k] = saved[k];
  state.noNight = !!saved.noNight;
  for (const k of ['maxLegs', 'minChange', 'maxWait']) {
    if (saved[k] && [...$(`#${k}`).options].some((o) => o.value === saved[k])) $(`#${k}`).value = saved[k];
  }
}

function makeWorker() {
  if (EMB) return new Worker(URL.createObjectURL(new Blob([EMB.workerSource], { type: 'text/javascript' })));
  return new Worker('worker.js', { type: 'module' });
}

async function loadJSON(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path} : HTTP ${r.status}`);
  return r.json();
}

// Data is late when it comes from an earlier day than today (Paris time) after
// 7:00, when today's SNCF update (around 6:20) should already be online.
function isStale() {
  const dataDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(meta.sourceModified || meta.generatedAt));
  const today = todayParis();
  if (dataDay >= today) return false;
  return nowMinutesParis() >= 7 * 60 || dataDay < addDays(today, -1);
}

function renderFreshness() {
  const updated = meta.sourceModified || meta.generatedAt;
  const when = new Date(updated).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const el = $('#freshness');
  let text = `La SNCF met les places à jour une fois par jour, vers 6h20. Dernière mise à jour : ${when}`;
  if (meta.newSince && meta.newSeats) text += ` · ${meta.newSeats} nouvelles depuis hier`;
  if (EMB) text += ' (instantané)';
  el.textContent = text;
  if (isStale()) {
    el.classList.add('stale');
    el.textContent += EMB
      ? ". Cette copie n'est plus à jour : des places ont pu partir ou se libérer."
      : ". Les places d'aujourd'hui ne sont pas encore arrivées sur le site : celles affichées sont celles d'avant. Réessaie un peu plus tard, et vérifie sur SNCF Connect.";
  }
}

async function main() {
  try {
    meta = EMB ? EMB.meta : await loadJSON('data/meta.json');
    ({ stations, axes } = EMB ? EMB.stations : await loadJSON('data/stations.json'));
  } catch (e) {
    $('#view').innerHTML = `<div class="empty"><strong>Les données n'ont pas pu être chargées.</strong>${esc(e.message)}</div>`;
    $('#freshness').textContent = '';
    return;
  }
  const today = todayParis();
  dates = meta.dates.filter((d) => d >= today);
  if (!dates.length) dates = meta.dates.slice(-1);
  places = buildPlaces();

  worker = makeWorker();
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  };
  await call('init', { stations, dates: meta.dates, base: EMB ? '' : new URL('data/', location.href).href, days: EMB ? EMB.days : null });

  renderFreshness();
  renderOpened();
  map = createMap($('#map'), { stations, onAction: mapAction });
  restore();
  $('#from').value = state.from?.label || '';
  $('#to').value = state.to?.label || '';
  renderDates();
  setTab(state.tab);

  const resetAndRefresh = () => { state.shown = { a: PAGE, r: PAGE }; state.trip = 'a0'; refresh(); };
  combobox($('#from'), $('#from-list'), (p) => { state.from = p; resetAndRefresh(); });
  combobox($('#to'), $('#to-list'), (p) => { state.to = p; resetAndRefresh(); });
  $('#swap').addEventListener('click', () => {
    [state.from, state.to] = [state.to, state.from];
    $('#from').value = state.from?.label || '';
    $('#to').value = state.to?.label || '';
    resetAndRefresh();
  });
  $('#search').addEventListener('submit', (e) => { e.preventDefault(); refresh(); });
  $('#dates').addEventListener('click', (e) => {
    const b = e.target.closest('.date-chip');
    if (b) { setDate(b.dataset.date); if (state.tab === 'calendrier') setTab('trajets'); refresh(); }
  });
  $('#ret-dates').addEventListener('click', (e) => {
    const b = e.target.closest('.date-chip');
    if (b) { setRetDate(b.dataset.date); if (state.tab === 'calendrier') setTab('trajets'); refresh(); }
  });
  $('#rt').addEventListener('change', (e) => {
    state.rt = e.target.checked;
    if (state.rt && !state.retDate) setDate(state.date);
    state.calPick = 'a';
    renderDates();
    resetAndRefresh();
  });
  for (const id of ['maxLegs', 'minChange', 'maxWait']) $(`#${id}`).addEventListener('change', refresh);
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) { setTab(b.dataset.tab); refresh(); }
  });
  $('#view').addEventListener('click', (e) => {
    const t = e.target;
    const more = t.closest('[data-more]');
    if (more) { state.shown[more.dataset.more] += PAGE; showTrips(); return; }
    if (t.closest('[data-onlynew]')) { state.onlyNew = !state.onlyNew; showTrips(); return; }
    const go = t.closest('[data-goto]');
    if (go) { setTab(go.dataset.goto); refresh(); return; }
    const calPick = t.closest('[data-calpick]');
    if (calPick) { state.calPick = calPick.dataset.calpick; showCalendar(); return; }
    const cell = t.closest('.cal-cell');
    if (cell) {
      if (state.rt && state.calPick === 'r') setRetDate(cell.dataset.date);
      else setDate(cell.dataset.date);
      setTab('trajets');
      refresh();
      window.scrollTo({ top: $('.tabs').offsetTop - 8 });
      return;
    }
    const pick = t.closest('[data-pick]');
    if (pick) { mapAction('trips', Number(pick.dataset.pick)); window.scrollTo({ top: $('.tabs').offsetTop - 8 }); return; }
    const dirBtn = t.closest('[data-dir]');
    if (dirBtn) { state.exploreDir = dirBtn.dataset.dir; state.exploreFilter = ''; refresh(); return; }
    const legsBtn = t.closest('[data-legs]');
    if (legsBtn) { state.exploreLegs = Number(legsBtn.dataset.legs); refresh(); return; }
    const wk = t.closest('[data-wk]');
    if (wk) { openWeekendTrip(Number(wk.dataset.wk), Number(wk.dataset.st)); return; }
    const wkSel = t.closest('[data-wksel]');
    if (wkSel) {
      state.weekend = Number(wkSel.dataset.wksel);
      document.querySelectorAll('.wk').forEach((el, i) => el.classList.toggle('selected', i === state.weekend));
      document.querySelectorAll('[data-wksel]').forEach((el, i) => el.setAttribute('aria-pressed', String(i === state.weekend)));
      drawWeekendMap();
      $('#map').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const wkOpen = t.closest('[data-wkopen]');
    if (wkOpen) { state.weekendOpen[wkOpen.dataset.wkopen] = true; showWeekends(); return; }
    const card = t.closest('.trip[data-j]');
    if (card) selectTrip(card.dataset.j);
  });
  $('#view').addEventListener('keydown', (e) => {
    const card = e.target.closest && e.target.closest('.trip[data-j]');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectTrip(card.dataset.j); }
  });
  $('#view').addEventListener('change', (e) => {
    const id = e.target.id;
    if (id === 'f-sort') state.sort = e.target.value;
    else if (id === 'f-after') state.after = Number(e.target.value);
    else if (id === 'f-before') state.before = Number(e.target.value);
    else if (id === 'f-nonight') state.noNight = e.target.checked;
    else if (id === 'f-friafter') { state.friAfter = Number(e.target.value); persist(); showWeekends(); return; }
    else return;
    persist();
    showTrips();
  });
  $('#view').addEventListener('input', (e) => {
    if (e.target.id !== 'explore-filter') return;
    state.exploreFilter = e.target.value;
    const f = norm(e.target.value);
    document.querySelectorAll('.dest-list li').forEach((li) => { li.hidden = !!f && !norm(li.querySelector('.name').textContent).includes(f); });
  });

  if (!EMB) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'linkish';
    btn.textContent = 'Copier le lien de cette recherche';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); btn.textContent = 'Lien copié'; }
      catch { btn.textContent = location.href; }
      setTimeout(() => (btn.textContent = 'Copier le lien de cette recherche'), 2500);
    });
    $('#share-slot').append(btn);
  }

  refresh();
}

main();
