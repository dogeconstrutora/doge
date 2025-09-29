import { State } from './state.js';
import { hexToRgba, bestRowForName, extractBetweenPavimentoAndNextDash } from './utils.js';
import { pickFVSColor } from './colors.js';
import { layoutData } from './data.js';
import { openAptModal } from './modal.js';
import { getLevelIndexForName } from './geometry.js';

let host = null;
let getRowsForCurrentFVS = null;

let _preZoomScrollTop = 0;
let _preZoomContentH  = 0;
let _preZoomFocalY    = 0;
let _pendingScrollRestore = false;
let _keepRestoringScroll = false;
let _preZoomScrollLeft = 0;
let _preZoomContentW   = 0;
let _preZoomFocalX     = 0;

export function setRowsResolver(fn){
  getRowsForCurrentFVS = (typeof fn === 'function') ? fn : null;
}

export function initOverlay2D(){
  host = document.getElementById('cards2d');
  if (!host) return;

  host.style.overflowY = 'auto';
  host.style.overflowX = 'hidden';
  host.style.touchAction = 'pan-y';
  host.style.webkitOverflowScrolling = 'touch';

  if (State.grid2DZoom == null) State.grid2DZoom = 1;
}

function _nearestStop(val, stops){
  let best = stops[0], bd = Math.abs(val - best);
  for (const v of stops){
    const d = Math.abs(val - v);
    if (d < bd){ best = v; bd = d; }
  }
  return best;
}
function _nextStop(cur, stops){
  const i = stops.indexOf(cur);
  return stops[(i + 1) % stops.length];
}

function _set3DVisibility(hidden){
  const cvs =
    document.getElementById('doge-canvas') ||
    document.querySelector('canvas[data-engine="doge"]') ||
    document.querySelector('#app canvas') ||
    document.querySelector('canvas');

  if (!cvs) return;
  cvs.style.visibility = hidden ? 'hidden' : 'visible';
}

const Z_STOPS = [1, 0.75, 0.5, 4, 2];

export function getMaxGridZoom(){ return 4; }

let _zoomRAF = null;

export function setGridZoom(targetZ){
  if (!host) initOverlay2D();
  if (!host) return;

  const ZMIN = 0.5;
  const ZMAX = getMaxGridZoom();
  const to = Math.max(ZMIN, Math.min(ZMAX, Number(targetZ) || 1));

  const rect = host.getBoundingClientRect();
  _preZoomFocalY    = rect.height * 0.5;
  _preZoomFocalX    = rect.width  * 0.5;
  _preZoomScrollTop = host.scrollTop;
  _preZoomContentH  = host.scrollHeight;
  _preZoomScrollLeft = host.scrollLeft;
  _preZoomContentW   = host.scrollWidth;
  _pendingScrollRestore = true;

  if (_zoomRAF) { cancelAnimationFrame(_zoomRAF); _zoomRAF = null; }

  const from = Number(State.grid2DZoom || 1);
  if (Math.abs(to - from) < 1e-4){
    State.grid2DZoom = _nearestStop(to, Z_STOPS);
    render2DCards();
    return;
  }

  const start = performance.now();
  const dur   = 140;
  const ease  = t => 1 - Math.pow(1 - t, 3);

  _keepRestoringScroll = true;

  const step = (now)=>{
    const k = Math.min(1, (now - start) / dur);
    const z = from + (to - from) * ease(k);
    State.grid2DZoom = z;

    _pendingScrollRestore = true;
    render2DCards();

    if (k < 1){
      _zoomRAF = requestAnimationFrame(step);
    } else {
      _zoomRAF = null;
      State.grid2DZoom = _nearestStop(to, Z_STOPS);
      _pendingScrollRestore = true;
      render2DCards();
      _keepRestoringScroll = false;
    }
  };
  _zoomRAF = requestAnimationFrame(step);
}

export function resetGridZoom(){ setGridZoom(1); }

export function zoom2DStep(){
  const cur  = _nearestStop(Number(State.grid2DZoom || 1), Z_STOPS);
  const next = _nextStop(cur, Z_STOPS);
  setGridZoom(next);
  return next;
}

export function getNextGridZoomSymbol(){
  const cur = _nearestStop(Number(State.grid2DZoom || 1), Z_STOPS);
  const nxt = _nextStop(cur, Z_STOPS);
  return (nxt > cur) ? '+' : '−';
}
export function getNextGridZoomSymbolFrom(val){
  const cur = _nearestStop(Number(val || 1), Z_STOPS);
  const nxt = _nextStop(cur, Z_STOPS);
  return (nxt > cur) ? '+' : '−';
}

function compareApt(a, b){
  const rx = /(\d+)/g;
  const ax = String(a||'').toUpperCase();
  const bx = String(b||'').toUpperCase();
  const an = ax.match(rx); const bn = bx.match(rx);
  if (an && bn){
    const na = parseInt(an[0], 10), nb = parseInt(bn[0], 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  }
  return ax.localeCompare(bx, 'pt-BR');
}

function buildFloorsFromApartamentos(){
  const placements = Array.isArray(layoutData?.placements) ? layoutData.placements : [];
  if (!placements.length) return [];

  const split = (name)=> String(name||'').split(/\s*-\s*/g).map(s=>s.trim()).filter(Boolean);
  const join  = (parts,n)=> parts.slice(0,n).join(' - ');

  const floorsByIdx = new Map();

  const S_MIN = 0.35, S_MAX = 1.0;
  const clamp = (v,a,b)=> Math.max(a, Math.min(b, v));

  placements.forEach((p, idx)=>{
    const full = String(p?.nome ?? '').trim();
    if (!full) return;

    const lvl = getLevelIndexForName(full);
    if (!Number.isFinite(lvl)) return;

    const parts = split(full);
    const floorLabel = `Nível ${lvl}`;

    const iApt = parts.findIndex(t => /^(Apartamento|Apto|Apt)\b/i.test(t));
    const iPav = parts.findIndex(t => /^Pavimento\b/i.test(t));
    let rootN = (iApt >= 0) ? (iApt + 1)
               : (iPav >= 0) ? (iPav + 2)
               : Math.min(2, parts.length);
    if (rootN > parts.length) rootN = parts.length;
    if (rootN <= 1 && parts.length <= 1) return;

    const rootKey = join(parts, rootN);
    if (!rootKey) return;

    const page = Math.max(1, Math.floor(Number(p.pagina ?? p.page ?? 1) || 1));

    const rawScale = Number(p.proporcao ?? p.scale ?? 1);
    const scale    = clamp((Number.isFinite(rawScale) && rawScale > 0) ? rawScale : 1, S_MIN, S_MAX);

    if (!floorsByIdx.has(lvl)) floorsByIdx.set(lvl, new Map());
    const byRoot = floorsByIdx.get(lvl);

    if (!byRoot.has(rootKey)){
      byRoot.set(rootKey, {
        apt: rootKey,
        floor: floorLabel,
        levelIndex: lvl,
        ordemcol: Number(p?.ordemcol ?? p?.ordemCol ?? p?.ordem),
        firstIndex: idx,
        scale,
        page
      });
    } else {
      const it = byRoot.get(rootKey);
      it.scale = Math.max(it.scale ?? 1, scale);
      it.page  = Math.min(it.page ?? page, page);
    }
  });

  const sortedLvls = Array.from(floorsByIdx.keys()).sort((a,b)=> b - a);

  const sortCards = (A,B)=>{
    const oa = Number.isFinite(A.ordemcol) ? A.ordemcol : null;
    const ob = Number.isFinite(B.ordemcol) ? B.ordemcol : null;
    if (oa!=null && ob!=null && oa!==ob) return oa - ob;

    const rx = /(\d+)/g;
    const ax = String(A.apt||'').toUpperCase();
    const bx = String(B.apt||'').toUpperCase();
    const an = ax.match(rx); const bn = bx.match(rx);
    if (an && bn){
      const na = parseInt(an[0], 10), nb = parseInt(bn[0], 10);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    }
    const cmp = ax.localeCompare(bx, 'pt-BR');
    if (cmp !== 0) return cmp;
    return (A.firstIndex ?? 0) - (B.firstIndex ?? 0);
  };

  const bands = [];
  for (const lvl of sortedLvls){
    const items = Array.from(floorsByIdx.get(lvl).values()).sort(sortCards);
    bands.push({ floor: `Nível ${lvl}`, items });
  }
  return bands;
}

function buildRowsLookup(){
  const rows = (getRowsForCurrentFVS ? (getRowsForCurrentFVS() || []) : []);
  const map = new Map();
  for (const r of rows){
    const aptName = String(r.local_origem ?? '').trim();
    const key = aptName;
    if (!key) continue;
    map.set(key, r);
  }
  return map;
}

function hasNC(row){
  if (!row) return false;
  const nc = Number(row.qtd_nao_conformidades_ultima_inspecao ?? row.nao_conformidades ?? 0) || 0;
  return nc > 0;
}

function hasPend(row){
  if (!row) return false;
  const pend = Number(row.qtd_pend_ultima_inspecao ?? row.pendencias ?? 0) || 0;
  console.log(`[hasPend] row.local_origem=${row.local_origem}, qtd_pend_ultima_inspecao=${row.qtd_pend_ultima_inspecao}, pendencias=${row.pendencias}, pend=${pend}`);
  return pend > 0;
}

function isInProgress(row){
  if (!row) return false;
  return !row.data_termino_inicial || hasNC(row) || hasPend(row);
}

export function recolorCards2D(){
  if (!host) return;

  const rowsMap = buildRowsLookup();
  const NC_MODE = !!State.NC_MODE;
  const IN_PROGRESS_MODE = !!State.IN_PROGRESS_MODE;

  const cards = host.querySelectorAll('.card');
  cards.forEach(card=>{
    const apt = String(card.dataset.apto || '').trim();
    const pav = String(card.dataset.pav  || '').trim();

    const row = bestRowForName(apt, rowsMap);

    card._row = row;
    card._hasData = !!row;

    const nc   = Math.max(0, Number(row?.qtd_nao_conformidades_ultima_inspecao ?? row?.nao_conformidades ?? 0) || 0);
    const pend = Math.max(0, Number(row?.qtd_pend_ultima_inspecao ?? row?.pendencias ?? 0) || 0);
    const perc = Math.max(0, Math.round(Number(row?.percentual_ultima_inspecao ?? row?.percentual ?? 0) || 0));
    const durN = Math.max(0, Math.round(Number(row?.duracao_real ?? row?.duracao ?? row?.duracao_inicial ?? 0) || 0));
    const inProgress = isInProgress(row);

    console.log(`[recolorCards2D] apt=${apt}, nc=${nc}, pend=${pend}, inProgress=${inProgress}, IN_PROGRESS_MODE=${IN_PROGRESS_MODE}, color=${pickFVSColor(apt, pav, State.COLOR_MAP)}`);

    const showData = !!row && (!NC_MODE || nc > 0) && (!IN_PROGRESS_MODE || inProgress);

    let badges = card.querySelector('.badges');
    if (!badges){
      badges = document.createElement('div');
      badges.className = 'badges';
      card.appendChild(badges);
    }
    badges.innerHTML = '';

    if (showData){
      const rowTop = document.createElement('div');
      rowTop.className = 'badge-row';
      const left  = document.createElement('div'); left.className  = 'slot left';
      const right = document.createElement('div'); right.className = 'slot right';

      const bPend = document.createElement('span');
      bPend.className = 'badge pend';
      bPend.textContent = String(pend);
      bPend.title = `Pendências: ${pend}`;
      left.appendChild(bPend);

      const bNc = document.createElement('span');
      bNc.className = 'badge nc';
      bNc.textContent = String(nc);
      bNc.title = `Não conformidades: ${nc}`;
      right.appendChild(bNc);

      rowTop.append(left, right);
      badges.appendChild(rowTop);

      const rowBottom = document.createElement('div');
      rowBottom.className = 'badge-row';
      const left2  = document.createElement('div'); left2.className  = 'slot left';
      const right2 = document.createElement('div'); right2.className = 'slot right';

      const bDur = document.createElement('span');
      bDur.className = 'badge dur';
      bDur.textContent = String(durN);
      bDur.title = `Duração (dias): ${durN}`;
      left2.appendChild(bDur);

      const bPct = document.createElement('span');
      bPct.className = 'badge percent';
      bPct.textContent = `${perc}%`;
      bPct.title = `Percentual executado`;
      right2.appendChild(bPct);

      rowBottom.append(left2, right2);
      badges.appendChild(rowBottom);
    }

    card.style.mixBlendMode = 'normal';

    if (row){
      if (showData){
        const color = pickFVSColor(apt, pav, State.COLOR_MAP);
        const a = Math.max(0, Math.min(1, Number(State.grid2DAlpha ?? 1)));
        card.style.borderColor = color;
        card.style.backgroundColor = hexToRgba(color, a);
        card.style.opacity = '1';
        card.style.pointerEvents = 'auto';
        card.style.cursor = 'pointer';
        card.classList.remove('disabled');
        card.title = apt;
      }else{
        card.style.borderColor = 'rgba(110,118,129,.6)';
        card.style.backgroundColor = 'rgba(34,40,53,1)';
        card.style.opacity = '1';
        card.style.pointerEvents = 'none';
        card.style.cursor = 'default';
        card.classList.add('disabled');
        card.title = '';
      }
    }else{
      card.style.borderColor = 'rgba(110,118,129,.6)';
      card.style.backgroundColor = 'rgba(34,40,53,1)';
      card.style.opacity = '1';
      card.style.pointerEvents = (NC_MODE || IN_PROGRESS_MODE) ? 'none' : 'auto';
      card.style.cursor = (NC_MODE || IN_PROGRESS_MODE) ? 'default' : 'pointer';
      if (NC_MODE || IN_PROGRESS_MODE) card.classList.add('disabled'); else card.classList.remove('disabled');
    }

    if (NC_MODE){
      if (nc > 0){
        card.style.filter = 'none';
        card.style.boxShadow = '0 0 0 2px rgba(248,81,73,.22)';
      }else{
        card.style.filter = 'none';
        card.style.boxShadow = 'none';
      }
    }else if (IN_PROGRESS_MODE){
      if (inProgress){
        card.style.filter = 'none';
        card.style.boxShadow = '0 0 0 2px rgba(88,166,255,.22)';
      }else{
        card.style.filter = 'none';
        card.style.boxShadow = 'none';
      }
    }else{
      card.style.filter = 'none';
      card.style.boxShadow = 'none';
    }
  });
}

export function render2DCards(){
  if (!host) initOverlay2D();
  if (!host) return;

  const hud = document.getElementById('hud');
  const hudH = hud ? hud.offsetHeight : 0;
  host.style.setProperty('bottom', `${hudH}px`, 'important');

  const perFloor = buildFloorsFromApartamentos();
  const rowsMap  = buildRowsLookup();
  const NC_MODE  = !!State.NC_MODE;
  const IN_PROGRESS_MODE = !!State.IN_PROGRESS_MODE;

  host.innerHTML = '';
  const frag = document.createDocumentFragment();

  let maxPage = 1;
  perFloor.forEach(b => b.items.forEach(it => { maxPage = Math.max(maxPage, Number(it.page||1)); }));

  host.style.overflowX = (maxPage > 1) ? 'auto' : 'hidden';
  host.style.overflowY = 'auto';
  host.style.scrollSnapType = (maxPage > 1) ? 'x mandatory' : 'none';
  host.style.touchAction = (maxPage > 1) ? 'pan-x pan-y' : 'pan-y';

  const paneW = Math.max(240, host.clientWidth);
  const paneH = Math.max(180, host.clientHeight);
  for (let p = 1; p <= maxPage; p++){
    const snap = document.createElement('div');
    snap.className = 'page-snap';
    snap.style.position = 'absolute';
    snap.style.left = `${(p-1) * paneW}px`;
    snap.style.top = `0px`;
    snap.style.width = `${paneW}px`;
    snap.style.height = `${paneH}px`;
    snap.style.scrollSnapAlign = 'start';
    snap.style.pointerEvents = 'none';
    frag.appendChild(snap);
  }

  for (const band of perFloor){
    for (const it of band.items){
      const key = it.apt;
      const row = bestRowForName(key, rowsMap);

      const el = document.createElement('div');
      el.className = 'card';
      el.dataset.apto = it.apt;
      el.dataset.pav  = it.floor;
      el.dataset.key  = key;
      el.dataset.page = String(it.page || 1);
      el._row = row;
      el._hasData = !!row;

      el.style.position = 'absolute';
      el.style.transform = 'translate(-50%, -50%)';

      const numEl = document.createElement('div');
      numEl.className = 'num';
      numEl.textContent = extractBetweenPavimentoAndNextDash(it.apt);
      el.appendChild(numEl);

      const durEl = document.createElement('div');
      durEl.className = 'dur';
      durEl.style.display = 'none';
      el.appendChild(durEl);

      const nc   = Math.max(0, Number(row?.qtd_nao_conformidades_ultima_inspecao ?? row?.nao_conformidades ?? 0) || 0);
      const pend = Math.max(0, Number(row?.qtd_pend_ultima_inspecao ?? row?.pendencias ?? 0) || 0);
      const perc = Math.max(0, Math.round(Number(row?.percentual_ultima_inspecao ?? row?.percentual ?? 0) || 0));
      const durN = Math.max(0, Math.round(Number(row?.duracao_real ?? row?.duracao ?? row?.duracao_inicial ?? 0) || 0));
      const inProgress = isInProgress(row);

      const showData = !!row && (!NC_MODE || nc > 0) && (!IN_PROGRESS_MODE || inProgress);

      if (showData){
        const badges = document.createElement('div');
        badges.className = 'badges';
        {
          const rowTop = document.createElement('div');
          rowTop.className = 'badge-row';
          const left  = document.createElement('div'); left.className  = 'slot left';
          const right = document.createElement('div'); right.className = 'slot right';
          const bPend = document.createElement('span'); bPend.className = 'badge pend'; bPend.textContent = String(pend); bPend.title = `Pendências: ${pend}`;
          const bNc   = document.createElement('span'); bNc.className   = 'badge nc';   bNc.textContent   = String(nc);   bNc.title   = `Não conformidades: ${nc}`;
          left.appendChild(bPend); right.appendChild(bNc);
          rowTop.append(left, right);
          badges.appendChild(rowTop);
        }
        {
          const rowBottom = document.createElement('div');
          rowBottom.className = 'badge-row';
          const left2  = document.createElement('div'); left2.className  = 'slot left';
          const right2 = document.createElement('div'); right2.className = 'slot right';
          const bDur = document.createElement('span'); bDur.className = 'badge dur';     bDur.textContent = String(durN);   bDur.title = `Duração (dias): ${durN}`;
          const bPct = document.createElement('span'); bPct.className = 'badge percent'; bPct.textContent = `${perc}%`;     bPct.title = `Percentual executado`;
          left2.appendChild(bDur); right2.appendChild(bPct);
          rowBottom.append(left2, right2);
          badges.appendChild(rowBottom);
        }
        el.appendChild(badges);
      }

      if (row){
        if (showData){
          const color = pickFVSColor(it.apt, it.floor, State.COLOR_MAP);
          const a = Math.max(0, Math.min(1, Number(State.grid2DAlpha ?? 0.75)));
          el.style.borderColor = color;
          el.style.backgroundColor  = hexToRgba(color, a);
          el.style.opacity     = '1';
          el.style.pointerEvents = 'auto';
          el.style.cursor = 'pointer';
          el.classList.remove('disabled');
          el.title = it.apt;
        }else{
          el.style.borderColor = 'rgba(110,118,129,.6)';
          el.style.backgroundColor  = 'rgba(34,40,53,.95)';
          el.style.opacity     = '1';
          el.style.pointerEvents = 'none';
          el.style.cursor = 'default';
          el.classList.add('disabled');
          el.title = '';
        }
      }else{
        el.style.borderColor = 'rgba(110,118,129,.6)';
        el.style.backgroundColor  = 'rgba(34,40,53,.95)';
        el.style.opacity     = '1';
        el.style.pointerEvents = (NC_MODE || IN_PROGRESS_MODE) ? 'none' : 'auto';
        el.style.cursor = (NC_MODE || IN_PROGRESS_MODE) ? 'default' : 'pointer';
        if (NC_MODE || IN_PROGRESS_MODE) el.classList.add('disabled'); else el.classList.remove('disabled');
      }

      frag.appendChild(el);
      it._el = el;
    }
  }

  host.appendChild(frag);

  host.onclick = (e) => {
    const card = e.target.closest('.card');
    if (!card || card.classList.contains('disabled')) return;
    const rowsMap2 = buildRowsLookup();
    const key = card.dataset.key || card.dataset.apto || '';
    const row = bestRowForName(key, rowsMap2);
    const apt = card.dataset.apto || '';
    const pav = card.dataset.pav  || '';
    const hex = pickFVSColor(apt, pav, State.COLOR_MAP);
    openAptModal({ id: apt, floor: pav, row, tintHex: hex });
  };

  const RATIO = 120/72;
  const MIN_W = 60, MIN_H = 40;
  const MAX_H = 160;
  let hGap = Math.max(12, Math.floor(paneW * 0.014));
  let vGap = Math.max(10, Math.floor(paneH * 0.014));

  const Z = Math.max(0.5, Math.min(getMaxGridZoom(), Number(State.grid2DZoom || 1)));
  const TARGET_ROWS = Math.max(1, Math.round(8 / Z));

  let cardH = Math.floor((paneH - (TARGET_ROWS-1)*vGap) / TARGET_ROWS);
  cardH = Math.max(MIN_H, Math.min(cardH, MAX_H));
  let cardW = Math.max(MIN_W, Math.floor(cardH * RATIO));
  let fontPx = Math.max(10, Math.floor(cardH * 0.24));

  const S_MIN = 0.35, S_MAX = 1.0;
  const clampScale = (v)=> Math.max(S_MIN, Math.min(S_MAX, Number(v)||1));
  const widthOf = (w, s)=> Math.floor(w * clampScale(s));

  const calcTWScaled = (items, baseW, gap)=>{
    if (!items.length) return 0;
    const sum = items.reduce((acc, it) => acc + widthOf(baseW, it.scale ?? 1), 0);
    return sum + Math.max(0, items.length - 1) * gap;
  };

  let TWmax = 0;
  for (const band of perFloor){
    const byPage = new Map();
    band.items.forEach(it=>{
      const p = Number(it.page || 1);
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(it);
    });
    for (const [p, items] of byPage){
      TWmax = Math.max(TWmax, calcTWScaled(items, cardW, hGap));
    }
  }
  if (TWmax > paneW){
    const sx = paneW / TWmax;
    cardW = Math.max(MIN_W, Math.floor(cardW * sx));
    cardH = Math.max(MIN_H, Math.floor(cardH * sx));
    fontPx = Math.max(10, Math.floor(fontPx * sx));
    hGap  = Math.max(8, Math.floor(hGap  * sx));
  }

  const badgeFont = Math.max(8,  Math.min(16, Math.round(cardH * 0.15)));
  const badgePadV = Math.max(2,  Math.round(cardH * 0.055));
  const badgePadH = Math.max(4,  Math.round(cardW * 0.08));
  const badgeMinW = Math.max(18, Math.round(cardW * 0.18));
  const badgeGap  = Math.max(3,  Math.round(cardW * 0.04));
  const badgeTop  = Math.max(3,  Math.round(cardH * 0.05));

  host.style.setProperty('--badge-font', `${badgeFont}px`);
  host.style.setProperty('--badge-pad-v', `${badgePadV}px`);
  host.style.setProperty('--badge-pad-h', `${badgePadH}px`);
  host.style.setProperty('--badge-minw', `${badgeMinW}px`);
  host.style.setProperty('--badge-gap',  `${badgeGap}px`);
  host.style.setProperty('--badge-top',  `${badgeTop}px`);

  const topPad  = 16;
  let cursorY   = topPad;

  for (const band of perFloor){
    const byPage = new Map();
    band.items.forEach(it=>{
      const p = Number(it.page || 1);
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(it);
    });

    const rowCenterY = cursorY + Math.floor(cardH/2);

    for (let p = 1; p <= maxPage; p++){
      const items = byPage.get(p) || [];
      if (!items.length) continue;

      const TWf = calcTWScaled(items, cardW, hGap);
      let runX = ((p-1) * paneW) + Math.floor(paneW/2) - Math.floor(TWf/2);

      for (const it of items){
        const el = it._el; if (!el) continue;

        const s = clampScale(it.scale ?? 1);
        const w = widthOf(cardW, s);
        const h = Math.floor(cardH * s);
        const f = Math.max(10, Math.floor(fontPx * s));

        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.fontSize = `${f}px`;
        el.style.opacity = el.style.opacity || '1';
        el.style.mixBlendMode = 'normal';

        const xCenter = runX + Math.floor(w/2);
        const yCenter = rowCenterY;
        el.style.left = `${xCenter}px`;
        el.style.top  = `${yCenter}px`;

        runX += w + hGap;
      }
    }

    cursorY += cardH + vGap;
  }

  if (_pendingScrollRestore){
    const newH = host.scrollHeight || 1;
    const oldH = _preZoomContentH || 1;
    const ratioY = newH / oldH;
    const desiredTop = ((_preZoomScrollTop + _preZoomFocalY) * ratioY) - _preZoomFocalY;
    const maxTop = Math.max(0, newH - host.clientHeight);
    host.scrollTop = Math.max(0, Math.min(maxTop, desiredTop));

    const newW = host.scrollWidth || 1;
    const oldW = _preZoomContentW || 1;
    const ratioX = newW / oldW;
    const desiredLeft = ((_preZoomScrollLeft + _preZoomFocalX) * ratioX) - _preZoomFocalX;
    const maxLeft = Math.max(0, newW - host.clientWidth);
    host.scrollLeft = Math.max(0, Math.min(maxLeft, desiredLeft));

    _pendingScrollRestore = false;

    if (!host.querySelector('.card')) {
      requestAnimationFrame(()=> render2DCards());
    }
  }
}

function _set3DFog(on){
  const cvs = document.querySelector('canvas');
  if (!cvs) return;
  cvs.style.transition = 'filter 140ms ease';
  cvs.style.filter = on
    ? 'blur(3px) brightness(0.85) contrast(0.9) saturate(0.9)'
    : '';
}

export function show2D(){
  if (!host) initOverlay2D();
  if (!host) return;
  host.classList.add('active');
  host.style.pointerEvents = 'auto';
  _set3DVisibility(true);
  render2DCards();
}

export function hide2D(){
  if (!host) initOverlay2D();
  if (!host) return;
  host.classList.remove('active');
  host.style.pointerEvents = 'none';
  _set3DVisibility(false);
}