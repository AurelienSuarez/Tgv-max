// Interactive SVG map, drawn by hand (no external tiles, works offline).
// Pan with a finger or the mouse, pinch or wheel to zoom, tap a station.
import { COORDS, LAND } from './lib/geo-data.js';

const NS = 'http://www.w3.org/2000/svg';
const K = Math.cos((46.5 * Math.PI) / 180);
const FRANCE = { x0: -5.2, y0: 41.3, x1: 9.7, y1: 51.2 };
const project = (lat, lon) => [lon * K, -lat];

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

const landPaths = LAND.map(({ c, p }) => ({
  c,
  d: `M${p.map(([lon, lat]) => project(lat, lon).map((v) => v.toFixed(3)).join(',')).join('L')}Z`,
}));

/**
 * @param {HTMLElement} host
 * @param {{ stations: Array<{id,name}>, onAction: (action, stationIdx) => void }} opts
 */
export function createMap(host, { stations, onAction }) {
  host.classList.add('map');
  host.innerHTML = `
    <svg class="map-svg" role="img" aria-label="Carte des gares"></svg>
    <div class="map-ctrl">
      <button type="button" data-z="in" aria-label="Zoomer">+</button>
      <button type="button" data-z="out" aria-label="Dézoomer">−</button>
      <button type="button" data-z="fit" aria-label="Recentrer">⤢</button>
    </div>
    <div class="map-pop" hidden></div>`;
  const svg = host.querySelector('svg');
  const pop = host.querySelector('.map-pop');
  const gLand = el('g', { class: 'm-land' }, svg);
  for (const { c, d } of landPaths) el('path', { d, class: c === 'FR' ? 'fr' : '' }, gLand);
  const gLines = el('g', { class: 'm-lines' }, svg);
  const gDots = el('g', { class: 'm-dots' }, svg);
  const gLabels = el('g', { class: 'm-labels' }, svg);

  const pos = stations.map((s) => (COORDS[s.id] ? project(...COORDS[s.id]) : null));
  let view = { x: 0, y: 0, w: 1, h: 1 };
  let data = { items: [], legs: [], focus: [] };
  let dots = [];
  let selected = null;

  const pxPerUnit = () => svg.clientWidth / view.w || 1;
  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const u = 1 / pxPerUnit();
    for (const d of dots) d.node.setAttribute('r', (d.r * u).toFixed(4));
    gLabels.querySelectorAll('text').forEach((t) => {
      t.setAttribute('font-size', (12 * u).toFixed(4));
      t.setAttribute('stroke-width', (3 * u).toFixed(4));
      t.setAttribute('x', (+t.dataset.x + 7 * u).toFixed(4));
      t.setAttribute('y', (+t.dataset.y + 4 * u).toFixed(4));
    });
    gLabels.classList.toggle('dense', pxPerUnit() < 60);
    if (selected != null) placePop();
  }

  function fit(points) {
    const ratio = (svg.clientHeight || 400) / (svg.clientWidth || 600);
    let [x0, y0, x1, y1] = [FRANCE.x0 * K, -FRANCE.y1, FRANCE.x1 * K, -FRANCE.y0];
    const pts = points.map((i) => pos[i]).filter(Boolean);
    if (pts.length > 1) {
      x0 = Math.min(...pts.map((p) => p[0]));
      x1 = Math.max(...pts.map((p) => p[0]));
      y0 = Math.min(...pts.map((p) => p[1]));
      y1 = Math.max(...pts.map((p) => p[1]));
      const minSpan = 1.2;
      if (x1 - x0 < minSpan) { const c = (x0 + x1) / 2; x0 = c - minSpan / 2; x1 = c + minSpan / 2; }
    }
    const padX = (x1 - x0) * 0.08 + 0.2;
    const padY = (y1 - y0) * 0.08 + 0.2;
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    let w = x1 - x0;
    let h = y1 - y0;
    if (h / w > ratio) { const nw = h / ratio; x0 -= (nw - w) / 2; w = nw; }
    else { const nh = w * ratio; y0 -= (nh - h) / 2; h = nh; }
    view = { x: x0, y: y0, w, h };
    applyView();
  }

  function zoomAt(f, cx, cy) {
    const nw = Math.min(40, Math.max(0.15, view.w / f));
    const real = view.w / nw;
    const px = view.x + (cx / svg.clientWidth) * view.w;
    const py = view.y + (cy / svg.clientHeight) * view.h;
    view = { x: px - (px - view.x) / real, y: py - (py - view.y) / real, w: nw, h: view.h / real };
    applyView();
  }

  function draw(next) {
    data = next;
    gLines.replaceChildren();
    gDots.replaceChildren();
    gLabels.replaceChildren();
    dots = [];
    closePop();
    const weight = new Map(data.items.map((it) => [it.station, it]));
    const focus = new Set(data.focus);
    const maxW = Math.max(1, ...data.items.map((it) => it.weight));

    for (const [a, b, kind] of data.legs) {
      if (!pos[a] || !pos[b]) continue;
      const it = weight.get(kind === 'to' ? a : b);
      const w = it ? 1 + 3 * Math.sqrt(it.weight / maxW) : 2.5;
      el('line', { x1: pos[a][0], y1: pos[a][1], x2: pos[b][0], y2: pos[b][1], class: `ln ${kind || ''}`, 'stroke-width': w, 'vector-effect': 'non-scaling-stroke' }, gLines);
    }
    const order = stations.map((_, i) => i).sort((a, b) => (weight.has(a) || focus.has(a)) - (weight.has(b) || focus.has(b)));
    for (const i of order) {
      if (!pos[i]) continue;
      const it = weight.get(i);
      const isFocus = focus.has(i);
      const r = isFocus ? 7 : it ? 3.5 + 6 * Math.sqrt(it.weight / maxW) : 2.2;
      const node = el('circle', { cx: pos[i][0], cy: pos[i][1], class: isFocus ? 'dot focus' : it ? 'dot on' : 'dot', 'data-i': i }, gDots);
      dots.push({ node, r });
    }
    // A city (several stations) gets a single label.
    const focusLabelled = data.focusLabel ? data.focus.filter((i) => pos[i]).slice(0, 1) : data.focus;
    const labelled = [...focusLabelled, ...data.items.slice().sort((a, b) => b.weight - a.weight).slice(0, 14).map((it) => it.station)];
    [...new Set(labelled)].forEach((i, n) => {
      if (!pos[i]) return;
      const isFocus = n < focusLabelled.length;
      const t = el('text', { class: isFocus ? 'lb focus' : 'lb', 'data-x': pos[i][0], 'data-y': pos[i][1] }, gLabels);
      t.textContent = isFocus && data.focusLabel ? data.focusLabel : stations[i].name;
    });
    fit([...data.focus, ...data.items.map((it) => it.station)]);
  }

  function placePop() {
    const p = pos[selected];
    if (!p) return;
    const x = ((p[0] - view.x) / view.w) * svg.clientWidth;
    const y = ((p[1] - view.y) / view.h) * svg.clientHeight;
    const pw = pop.offsetWidth;
    pop.style.left = `${Math.min(Math.max(8, x - pw / 2), svg.clientWidth - pw - 8)}px`;
    pop.style.top = `${y > svg.clientHeight / 2 ? y - pop.offsetHeight - 14 : y + 14}px`;
  }
  function closePop() { selected = null; pop.hidden = true; }
  function openPop(i) {
    selected = i;
    const it = data.items.find((x) => x.station === i);
    pop.innerHTML = `<strong>${stations[i].name}</strong>${it && it.info ? `<span>${it.info}</span>` : ''}
      <div class="pop-actions">
        <button type="button" class="btn ghost" data-act="from">Partir d'ici</button>
        <button type="button" class="btn ghost" data-act="to">Y aller</button>
        ${it && it.trips ? '<button type="button" class="btn" data-act="trips">Voir les trajets</button>' : ''}
      </div>`;
    pop.hidden = false;
    placePop();
  }
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && selected != null) { const i = selected; closePop(); onAction(b.dataset.act, i); }
  });

  // Gestures: pan, pinch, tap.
  const pointers = new Map();
  let start = null;
  let moved = false;
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start = { view: { ...view }, pts: [...pointers.values()].map((p) => ({ ...p })) };
    moved = false;
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !start) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.values()];
    const rect = svg.getBoundingClientRect();
    if (pts.length === 1 && start.pts.length === 1) {
      const dx = pts[0].x - start.pts[0].x;
      const dy = pts[0].y - start.pts[0].y;
      if (Math.hypot(dx, dy) > 4) moved = true;
      const u = start.view.w / rect.width;
      view = { ...start.view, x: start.view.x - dx * u, y: start.view.y - dy * u };
      applyView();
    } else if (pts.length === 2 && start.pts.length === 2) {
      moved = true;
      const d0 = Math.hypot(start.pts[0].x - start.pts[1].x, start.pts[0].y - start.pts[1].y);
      const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
      view = { ...start.view };
      zoomAt(d1 / d0, cx, cy);
    }
  });
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!moved && pointers.size === 0 && e.type === 'pointerup') {
      const t = document.elementFromPoint(e.clientX, e.clientY);
      const dot = t && t.closest && t.closest('circle[data-i]');
      if (dot) openPop(Number(dot.dataset.i));
      else if (!pop.contains(t)) closePop();
    }
    start = pointers.size ? { view: { ...view }, pts: [...pointers.values()].map((p) => ({ ...p })) } : null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  host.querySelector('.map-ctrl').addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]');
    if (!z) return;
    if (z.dataset.z === 'fit') fit([...data.focus, ...data.items.map((it) => it.station)]);
    else zoomAt(z.dataset.z === 'in' ? 1.5 : 1 / 1.5, svg.clientWidth / 2, svg.clientHeight / 2);
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => applyView()).observe(svg);

  return { draw };
}
