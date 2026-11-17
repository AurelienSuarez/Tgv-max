import { fmtTime, fmtDuration, DAY } from './lib/csa.js';

const EMB = window.__MAXRELAIS__ || null;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`maxrelais:${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`maxrelais:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const PAGE = 15;
const state = { from: null, to: null, date: null, tab: 'trajets', shown: PAGE, exploreFilter: '' };
let meta, stations, axes, places, dates, worker;
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

function query() {
  return {
    origins: state.from.ids,
    dests: state.to.ids,
    maxLegs: Number($('#maxLegs').value),
    minChange: Number($('#minChange').value),
    maxWait: Number($('#maxWait').value),
  };
}

function renderDates() {
  $('#dates').innerHTML = dates
    .map((d) => {
      const o = dateObj(d);
      return `<button type="button" class="date-chip" role="option" data-date="${d}" aria-selected="${d === state.date}">
        <span class="dow">${esc(o.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', ''))}</span>
        <span class="num">${o.getDate()}</span>
        <span class="mon">${esc(o.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', ''))}</span></button>`;
    })
    .join('');
  const sel = $('#dates [aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function setDate(d) {
  state.date = d;
  state.shown = PAGE;
  document.querySelectorAll('.date-chip').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.date === d)));
  const sel = $('#dates [aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setTab(t) {
  state.tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
}

function stationName(i) {
  return stations[i].name;
}

function journeyCard(j) {
  const n = j.legs.length;
  const nextDay = Math.floor(j.arr / DAY);
  const chips = [];
  if (n === 1) chips.push('<span class="chip direct">Direct</span>');
  else chips.push(`<span class="chip">${n} billets</span>`);
  if (j.legs.some((l) => l.sameTrain)) chips.push('<span class="chip split">Billets découpés, même train</span>');
  if (j.legs.some((l) => l.stationChange)) chips.push('<span class="chip">Changement de gare</span>');
  if (j.legs.some((l) => l.axe != null && axes[l.axe] === 'IC NUIT')) chips.push('<span class="chip">Train de nuit</span>');

  const parts = [];
  j.legs.forEach((l, k) => {
    if (k > 0) {
      const prev = j.legs[k - 1];
      if (l.sameTrain) parts.push(`<li class="transfer same">Reste dans le train ${esc(l.train)} à ${esc(stationName(l.from))} : nouveau billet à partir d'ici (arrêt de ${l.wait} min)</li>`);
      else if (l.stationChange) parts.push(`<li class="transfer city">Changement de gare : ${esc(stationName(prev.to))} → ${esc(stationName(l.from))}, ${fmtDuration(l.wait)} entre les deux trains</li>`);
      else parts.push(`<li class="transfer">Correspondance de ${fmtDuration(l.wait)} à ${esc(stationName(l.from))}</li>`);
    }
    parts.push(`<li class="ticket">
      <div class="tk-time"><span>${fmtTime(l.dep).replace(' (+1)', '')}</span><span>${fmtTime(l.arr).replace(' (+1)', '')}</span></div>
      <div class="tk-body"><span class="tk-route">${esc(stationName(l.from))} → ${esc(stationName(l.to))}</span><span class="tk-train">${n > 1 ? `<span class="tk-num">Billet ${k + 1}/${n}</span>` : ''}${esc(trainLabel(l.axe, l.train))} · ${fmtDuration(l.arr - l.dep)}${l.dep >= DAY ? ' · lendemain' : ''}</span></div>
    </li>`);
  });

  return `<article class="trip">
    <header class="trip-head">
      <div class="times"><span>${fmtTime(j.dep)}</span><span class="arrow">→</span><span>${fmtTime(j.arr % DAY)}${nextDay ? `<sup>+${nextDay}</sup>` : ''}</span></div>
      <div class="trip-meta">${fmtDuration(j.arr - j.dep)}</div>
      <div class="chips">${chips.join('')}</div>
    </header>
    <ol class="tickets">${parts.join('')}</ol>
  </article>`;
}

function needPlaces(view) {
  if (!state.from || (view !== 'depart' && !state.to)) {
    $('#view').innerHTML = `<div class="empty"><strong>Choisis ${!state.from ? 'une gare de départ' : 'une gare d\'arrivée'}</strong>Tape le nom d'une ville ou d'une gare.</div>`;
    return true;
  }
  return false;
}

async function showTrips() {
  if (needPlaces('trajets')) return;
  const view = $('#view');
  view.innerHTML = '<p class="loading">Recherche des places…</p>';
  const q = query();
  if (state.date === todayParis()) q.from = nowMinutesParis();
  const token = ++showTrips.token;
  let js;
  try {
    js = await call('search', { date: state.date, query: q });
  } catch (e) {
    view.innerHTML = `<div class="empty"><strong>Les données de ce jour n'ont pas pu être chargées.</strong>${esc(e.message)}. Recharge la page pour réessayer.</div>`;
    return;
  }
  if (token !== showTrips.token) return;
  const day = fmtDate(state.date, { weekday: 'long', day: 'numeric', month: 'long' });
  if (!js.length) {
    view.innerHTML = `<div class="empty"><strong>Aucune place MAX ${esc(state.from.label)} → ${esc(state.to.label)} le ${esc(day)}.</strong>
      Essaie d'autoriser plus de billets ou une attente plus longue dans les réglages, ou regarde les autres jours.
      <div><button type="button" class="btn" data-goto="calendrier">Voir le calendrier</button></div></div>`;
    return;
  }
  const direct = js.filter((j) => j.legs.length === 1).length;
  const summary = `<p class="summary"><strong>${js.length} trajet${js.length > 1 ? 's' : ''}</strong> ${esc(state.from.label)} → ${esc(state.to.label)} le ${esc(day)} · ${direct} direct${direct > 1 ? 's' : ''}, ${js.length - direct} en plusieurs billets</p>`;
  const more = js.length > state.shown ? `<button type="button" class="btn ghost more" id="more">Afficher ${Math.min(PAGE, js.length - state.shown)} trajets de plus</button>` : '';
  view.innerHTML = summary + js.slice(0, state.shown).map(journeyCard).join('') + more;
}
showTrips.token = 0;

async function showCalendar() {
  if (needPlaces('calendrier')) return;
  const view = $('#view');
  view.innerHTML = '<p class="loading">Calcul des 30 prochains jours…</p>';
  const token = ++showTrips.token;
  const res = await call('calendar', { dates, query: query() });
  if (token !== showTrips.token) return;
  const max = Math.max(1, ...res.map((r) => r.count));
  const total = res.filter((r) => r.count).length;
  let html = `<p class="summary"><strong>${total} jour${total > 1 ? 's' : ''} sur ${res.length}</strong> avec au moins un trajet ${esc(state.from.label)} → ${esc(state.to.label)}. Touche un jour pour voir les trajets.</p>`;
  let month = '';
  let grid = '';
  const flush = () => { if (grid) html += `<div class="cal">${['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'].map((d) => `<span class="dow">${d}</span>`).join('')}${grid}</div>`; grid = ''; };
  for (const r of res) {
    const o = dateObj(r.date);
    const m = o.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    if (m !== month) {
      flush();
      month = m;
      html += `<h2 class="cal-month">${esc(m)}</h2>`;
      grid += '<span></span>'.repeat((o.getDay() + 6) % 7);
    }
    const heat = r.count ? 0.25 + 0.75 * (r.count / max) : 0;
    const label = r.count ? `${r.count} trajet${r.count > 1 ? 's' : ''}${r.direct ? `, ${r.direct} direct${r.direct > 1 ? 's' : ''}` : ''}` : 'aucun';
    grid += `<button type="button" class="cal-cell${r.count ? '' : ' none'}${heat > 0.6 ? ' hot' : ''}" style="--heat:${heat.toFixed(2)}" data-date="${r.date}" ${r.date === state.date ? 'aria-current="date"' : ''} aria-label="${esc(fmtDate(r.date, { weekday: 'long', day: 'numeric', month: 'long' }))} : ${label}">
      <span class="d">${o.getDate()}</span><span class="n">${r.count ? `${r.count}${r.direct ? ` · ${r.direct}D` : ''}` : '–'}</span></button>`;
  }
  flush();
  html += '<p class="legend">Le chiffre compte les trajets possibles ce jour-là ; « D » compte ceux qui sont directs. Plus la case est foncée, plus il y a de choix.</p>';
  view.innerHTML = html;
}

async function showExplore() {
  if (needPlaces('depart')) return;
  const view = $('#view');
  view.innerHTML = '<p class="loading">Recherche des destinations…</p>';
  const token = ++showTrips.token;
  const res = await call('explore', { date: state.date, origins: state.from.ids });
  if (token !== showTrips.token) return;
  const day = fmtDate(state.date, { weekday: 'long', day: 'numeric', month: 'long' });
  if (!res.length) {
    view.innerHTML = `<div class="empty"><strong>Aucun train direct avec des places MAX au départ de ${esc(state.from.label)} le ${esc(day)}.</strong>Essaie un autre jour.</div>`;
    return;
  }
  res.sort((a, b) => b.count - a.count || stationName(a.dest).localeCompare(stationName(b.dest), 'fr'));
  const f = norm(state.exploreFilter);
  const rows = res.filter((r) => !f || norm(stationName(r.dest)).includes(f));
  view.innerHTML = `<p class="summary"><strong>${res.length} destinations</strong> en direct avec des places MAX au départ de ${esc(state.from.label)} le ${esc(day)}.</p>
    <div class="filter"><input id="explore-filter" type="search" placeholder="Filtrer les destinations" value="${esc(state.exploreFilter)}" aria-label="Filtrer les destinations"></div>
    <ul class="dest-list">${rows.map((r) => `<li><span class="name">${esc(stationName(r.dest))}</span>
      <span class="info">${r.count} train${r.count > 1 ? 's' : ''} · ${r.first === r.last ? `à ${fmtTime(r.first)}` : `de ${fmtTime(r.first)} à ${fmtTime(r.last)}`} · dès ${fmtDuration(r.shortest)}</span>
      <button type="button" class="btn ghost" data-dest="${r.dest}">Voir</button></li>`).join('')}</ul>`;
}

function refresh() {
  persist();
  if (state.tab === 'calendrier') return showCalendar();
  if (state.tab === 'depart') return showExplore();
  return showTrips();
}

function persist() {
  const s = { from: state.from?.key, to: state.to?.key, date: state.date, maxLegs: $('#maxLegs').value, minChange: $('#minChange').value, maxWait: $('#maxWait').value, tab: state.tab };
  store.set('last', s);
  if (!EMB) {
    try {
      const p = new URLSearchParams();
      if (s.from) p.set('de', s.from);
      if (s.to) p.set('a', s.to);
      if (s.date) p.set('le', s.date);
      if (s.tab !== 'trajets') p.set('vue', s.tab);
      history.replaceState(null, '', `${location.pathname}?${p}`);
    } catch { /* no history API */ }
  }
}

function restore() {
  const saved = store.get('last') || {};
  let params = new URLSearchParams();
  try { params = new URLSearchParams(location.search); } catch { /* ignore */ }
  const from = params.get('de') || saved.from || 'city:Paris';
  const to = params.get('a') || saved.to || 'city:Marseille';
  state.from = findPlace(from);
  state.to = findPlace(to);
  const d = params.get('le') || saved.date;
  state.date = dates.includes(d) ? d : dates[0];
  const tab = params.get('vue') || saved.tab;
  if (['trajets', 'calendrier', 'depart'].includes(tab)) state.tab = tab;
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

  const updated = meta.sourceModified || meta.generatedAt;
  const when = new Date(updated).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  $('#freshness').textContent = `Places SNCF du ${when}${EMB ? ' (instantané)' : ''}`;

  restore();
  $('#from').value = state.from?.label || '';
  $('#to').value = state.to?.label || '';
  renderDates();
  setTab(state.tab);

  combobox($('#from'), $('#from-list'), (p) => { state.from = p; state.shown = PAGE; refresh(); });
  combobox($('#to'), $('#to-list'), (p) => { state.to = p; state.shown = PAGE; refresh(); });
  $('#swap').addEventListener('click', () => {
    [state.from, state.to] = [state.to, state.from];
    $('#from').value = state.from?.label || '';
    $('#to').value = state.to?.label || '';
    refresh();
  });
  $('#search').addEventListener('submit', (e) => { e.preventDefault(); refresh(); });
  $('#dates').addEventListener('click', (e) => {
    const b = e.target.closest('.date-chip');
    if (b) { setDate(b.dataset.date); if (state.tab === 'calendrier') setTab('trajets'); refresh(); }
  });
  for (const id of ['maxLegs', 'minChange', 'maxWait']) $(`#${id}`).addEventListener('change', refresh);
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) { setTab(b.dataset.tab); refresh(); }
  });
  $('#view').addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'more') { state.shown += PAGE; showTrips(); return; }
    const go = t.closest('[data-goto]');
    if (go) { setTab(go.dataset.goto); refresh(); return; }
    const cell = t.closest('.cal-cell');
    if (cell) { setDate(cell.dataset.date); setTab('trajets'); refresh(); window.scrollTo({ top: $('.tabs').offsetTop - 8 }); return; }
    const dest = t.closest('[data-dest]');
    if (dest) {
      state.to = places.find((p) => p.key === stations[Number(dest.dataset.dest)].id);
      $('#to').value = state.to.label;
      setTab('trajets');
      refresh();
    }
  });
  $('#view').addEventListener('input', (e) => {
    if (e.target.id !== 'explore-filter') return;
    state.exploreFilter = e.target.value;
    const pos = e.target.selectionStart;
    showExplore().then(() => { const i = $('#explore-filter'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } });
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
