import { State, savePrefs, loadPrefs, getQS, setQS } from './state.js';
import { applyModalTint } from './modal.js';
import {
  setFaceOpacity, applyExplode, recolorMeshes3D, apply2DVisual,
  getMaxLevelIndex, getLevelIndexForName, showOnlyFloor, showAllFloors, applyFloorLimit, getMaxLevel,
  getPavimentoPrefixForLevel
} from './geometry.js';
import {
  render2DCards, recolorCards2D, show2D, hide2D,
  setGridZoom, getNextGridZoomSymbol, zoom2DStep, getNextGridZoomSymbolFrom,
  setRowsResolver as setRowsResolver2D
} from './overlay2d.js';
import { buildColorMapForFVS, buildColorMapForFVS_NC, buildColorMapForFVS_InProgress } from './colors.js';
import { syncSelectedColor, setRowResolver as setRowResolver3D, clear3DHighlight } from './picking.js';
import { recenterCamera, INITIAL_THETA, INITIAL_PHI, render } from './scene.js';
import { normFVSKey, bestRowForName, isHierarchyMatch } from './utils.js';
import { apartamentos, fvsList } from './data.js';

// ---- elementos
let hudEl, rowSliders, fvsSelect, btnNC, btnInProgress, opacityRange, explodeXYRange, explodeYRange, btn2D, btnZoom2D, btnResetAll, floorLimitRange, floorLimitValue, floorLimitGroup;

// ============================
// Índice FVS -> rows / lookup por nome (ORDEM = fvsList)
// ============================
function buildFVSIndexFromLists(fvsStrings, apts) {
  const buckets = new Map();
  const order = [];

  // 1) Cria buckets respeitando a ordem do fvs-list_by_obra.json
  for (const label of (Array.isArray(fvsStrings) ? fvsStrings : [])) {
    const key = normFVSKey(label);
    if (!key) continue;
    if (!buckets.has(key)) {
      buckets.set(key, {
        label: String(label),
        rows: [],
        rowsByNameKey: new Map(),
        counts: { total: 0, withNC: 0, inProgress: 0 },
        levels: new Set()
      });
      order.push(key);
    }
  }

  // 2) Distribui apartamentos em seus respectivos buckets
  for (const r of (apts || [])) {
    const key = normFVSKey(r.fvs ?? r.FVS ?? '');
    if (!key) continue;
    const b = buckets.get(key);
    if (!b) continue;

    b.rows.push(r);
    b.counts.total++;

    const ncVal = Number(r.qtd_nao_conformidades_ultima_inspecao ?? r.nao_conformidades ?? 0) || 0;
    if (ncVal > 0) b.counts.withNC++;
    if (!r.data_termino_inicial || ncVal > 0 || Number(r.qtd_pend_ultima_inspecao ?? r.pendencias ?? 0) > 0) b.counts.inProgress++;

    const exactKey = String((r.local_origem ?? r.nome ?? '')).trim();
    if (exactKey) {
      b.rowsByNameKey.set(exactKey, r);
      const levelIdx = getLevelIndexForName(exactKey);
      if (Number.isFinite(levelIdx)) {
        r.__levelIdx = levelIdx;
        b.levels.add(levelIdx);
      }
    }
  }

  Object.defineProperty(buckets, '__order', { value: order, enumerable: false });
  return buckets;
}

// === Compat: applyFVSAndRefresh (chamada pelo viewer.js) ===
export function applyFVSAndRefresh() {
  const fvsIndex = buildFVSIndexFromLists(fvsList || [], apartamentos || []);

  let key = State.CURRENT_FVS || '';
  if (!key && State.CURRENT_FVS_LABEL) key = normFVSKey(State.CURRENT_FVS_LABEL);

  if (!key || !fvsIndex.has(key)) {
    const ord = fvsIndex.__order || Array.from(fvsIndex.keys());
    key = ord[0] || '';
  }

  if (fvsSelect) {
    populateFVSSelect(fvsSelect, fvsIndex, !!State.NC_MODE, !!State.IN_PROGRESS_MODE, window.DOGE?.__isoPavPrefix ?? null);
    if (key && fvsIndex.has(key)) fvsSelect.value = key;
  }

  if (key) applyFVSSelection(key, fvsIndex, false);

  render2DCards();
  render();
}

function populateFVSSelect(selectEl, fvsIndex, showNCOnly = false, showInProgressOnly = false, pavimentoFilter = null) {
  if (!selectEl) return;

  const prevVal = selectEl.value;
  selectEl.innerHTML = '';

  const keys = (fvsIndex.__order && fvsIndex.__order.length)
    ? fvsIndex.__order.slice()
    : Array.from(fvsIndex.keys());

  let added = 0;

  for (const k of keys) {
    const b = fvsIndex.get(k);
    if (!b) continue;

    let filteredRows = b.rows;
    if (pavimentoFilter) {
      filteredRows = b.rows.filter(r => isHierarchyMatch(r.local_origem ?? r.nome ?? '', pavimentoFilter));
    }
    const total = filteredRows.length;
    if (total === 0) continue;

    const withNC = filteredRows.reduce((acc, r) => {
      const ncVal = Number(r.qtd_nao_conformidades_ultima_inspecao ?? r.nao_conformidades ?? 0) || 0;
      return acc + (ncVal > 0 ? 1 : 0);
    }, 0);

    const inProgress = filteredRows.reduce((acc, r) => {
      const ncVal = Number(r.qtd_nao_conformidades_ultima_inspecao ?? r.nao_conformidades ?? 0) || 0;
      const pendVal = Number(r.qtd_pend_ultima_inspecao ?? r.pendencias ?? 0) || 0;
      return acc + ((ncVal > 0 || pendVal > 0 || !r.data_termino_inicial) ? 1 : 0);
    }, 0);

    if (showNCOnly && withNC === 0) continue;
    if (showInProgressOnly && inProgress === 0) continue;

    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = showNCOnly
      ? `${b.label} (NC:${withNC})`
      : showInProgressOnly
      ? `${b.label} (Em Andamento:${inProgress})`
      : `${b.label} (${total})`;
    selectEl.appendChild(opt);
    added++;
  }

  if (added === 0 && showNCOnly) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Nenhuma FVS com NC encontrada';
    opt.disabled = true;
    opt.selected = true;
    selectEl.appendChild(opt);
  } else if (added === 0 && showInProgressOnly) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Nenhuma FVS em andamento encontrada';
    opt.disabled = true;
    opt.selected = true;
    selectEl.appendChild(opt);
  } else if (added === 0) {
    for (const k of keys) {
      const b = fvsIndex.get(k);
      if (!b) continue;

      let filteredRows = b.rows;
      if (pavimentoFilter) {
        filteredRows = b.rows.filter(r => isHierarchyMatch(r.local_origem ?? r.nome ?? '', pavimentoFilter));
      }
      const total = filteredRows.length;
      if (total === 0) continue;

      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = `${b.label} (${total})`;
      selectEl.appendChild(opt);
      added++;
    }
    if (added === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Nenhuma FVS encontrada';
      opt.disabled = true;
      opt.selected = true;
      selectEl.appendChild(opt);
    }
  }

  if (prevVal && [...selectEl.options].some(o => o.value === prevVal && !o.disabled)) {
    selectEl.value = prevVal;
  }
}

function applyFVSSelection(fvsKey, fvsIndex, isManualSelection = false) {
  const bucket = fvsIndex.get(fvsKey);
  const rows = bucket?.rows || [];

  console.log(`[applyFVSSelection] fvsKey=${fvsKey}, isManualSelection=${isManualSelection}, rows.length=${rows.length}`);

  State.CURRENT_FVS = fvsKey;
  State.CURRENT_FVS_LABEL = bucket?.label || '';

  // Salvar FVS no cache e na URL
  const prefs = loadPrefs() || {};
  if (fvsKey) {
    prefs.fvs = fvsKey;
    setQS({ fvs: fvsKey });
    console.log(`[applyFVSSelection] Saved fvsKey=${fvsKey} to prefs and URL`);
    if (isManualSelection) {
      window.DOGE.__lastManualFVS = fvsKey;
      console.log(`[applyFVSSelection] Updated __lastManualFVS=${fvsKey}`);
    }
  } else {
    prefs.fvs = '';
    setQS({ fvs: null });
    console.log(`[applyFVSSelection] Cleared fvsKey from prefs and URL`);
    if (isManualSelection) {
      window.DOGE.__lastManualFVS = '';
      console.log(`[applyFVSSelection] Cleared __lastManualFVS`);
    }
  }
  savePrefs(prefs);

  setRowsResolver2D(() => rows);

  const byName = bucket?.rowsByNameKey || new Map();
  setRowResolver3D((rawName) => {
    const nm = String(rawName || '').trim();
    if (!nm) return null;
    return bestRowForName(nm, byName);
  });

  State.COLOR_MAP = State.IN_PROGRESS_MODE
    ? buildColorMapForFVS_InProgress(rows)
    : State.NC_MODE
    ? buildColorMapForFVS_NC(rows)
    : buildColorMapForFVS(rows);

  recolorMeshes3D();
  recolorCards2D();
  syncSelectedColor();
  render();
}

// ============================
// Inicialização pública
// ============================
export function initHUD() {
  hudEl = document.getElementById('hud');
  fvsSelect = document.getElementById('fvsSelect');
  btnNC = document.getElementById('btnNC');
  btnInProgress = document.getElementById('btnInProgress');
  btn2D = document.getElementById('btn2D');
  btnZoom2D = document.getElementById('btnZoom2D');
  btnResetAll = document.getElementById('btnResetAll');

  rowSliders = document.getElementById('row-sliders');
  opacityRange = document.getElementById('opacity');
  explodeXYRange = document.getElementById('explodeXY');
  explodeYRange = document.getElementById('explodeY');

  floorLimitRange = document.getElementById('floorLimit');
  floorLimitValue = document.getElementById('floorLimitValue');
  floorLimitGroup = document.getElementById('floorLimitGroup')
    || floorLimitRange?.closest('.control')
    || floorLimitRange?.parentElement;

  if (!hudEl) return;

  // Tela inicial: garantir obra e FVS escolhidas
  {
    const qs = new URL(location.href).searchParams;
    const obraQS = qs.get('obra') || '';
    const fvsQS = qs.get('fvs') || '';
    const obraCache = localStorage.getItem('obraId') || '';
    const fvsCache = localStorage.getItem('doge.viewer.fvs') || '';

    if (!obraQS && obraCache) {
      const url = new URL(location.href);
      url.searchParams.set('obra', obraCache);
      if (fvsCache) url.searchParams.set('fvs', fvsCache);
      location.replace(url.toString());
      return;
    }
    if (!obraQS && !obraCache) {
      setTimeout(() => openSettingsModal?.(), 0);
    }
  }

  const prefs = loadPrefs();
  const qsFvs = getQS('fvs');
  const qsNc = getQS('nc');
  const qsInProgress = getQS('inProgress');
  State.NC_MODE = (qsNc != null) ? (qsNc === '1' || qsNc === 'true') : !!prefs.nc;
  State.IN_PROGRESS_MODE = (qsInProgress != null) ? (qsInProgress === '1' || qsInProgress === 'true') : !!prefs.inProgress;

  // Carrega a FVS salva
  State.CURRENT_FVS = prefs.fvs || State.CURRENT_FVS || '';

  btnNC?.setAttribute('aria-pressed', String(!!State.NC_MODE));
  btnNC?.classList.toggle('active', !!State.NC_MODE);
  btnInProgress?.setAttribute('aria-pressed', String(!!State.IN_PROGRESS_MODE));
  btnInProgress?.classList.toggle('active', !!State.IN_PROGRESS_MODE);

  [opacityRange, explodeXYRange, explodeYRange].forEach(inp => {
    if (!inp) return;
    inp.classList.add('slim');
    inp.style.maxWidth = '140px';
  });

  if (explodeXYRange) explodeXYRange.value = String(State.explodeXY ?? 0);
  if (explodeYRange) explodeYRange.value = String(State.explodeY ?? 0);
  if (opacityRange) opacityRange.value = String(Math.round((State.faceOpacity ?? 1) * 100));

  const is2D = State.flatten2D >= 0.95;
  btn2D?.setAttribute('aria-pressed', String(is2D));
  btn2D?.classList.toggle('active', is2D);

  const floorLabel = document.querySelector('label[for="floorLimit"]');

  const toggle2DUI = (on) => {
    if (rowSliders) rowSliders.style.display = on ? 'none' : '';
    [floorLabel, floorLimitRange, floorLimitValue].forEach(el => {
      if (el) el.style.display = on ? 'none' : '';
    });
    if (btnZoom2D) {
      btnZoom2D.textContent = '🔍' + getNextGridZoomSymbol();
      btnZoom2D.style.display = on ? 'inline-flex' : 'none';
    }
  };

  toggle2DUI(is2D);
  if (is2D) { show2D(); } else { hide2D(); }

  const fvsIndex = buildFVSIndexFromLists(fvsList || [], apartamentos || []);
  populateFVSSelect(fvsSelect, fvsIndex, State.NC_MODE, State.IN_PROGRESS_MODE, window.DOGE?.__isoPavPrefix ?? null);

  // Aplica a FVS salva ou seleciona a primeira válida
  let initialKey = '';
  const prefKey = prefs?.fvs ? normFVSKey(prefs.fvs) : '';
  const qsKey = qsFvs ? normFVSKey(qsFvs) : '';
  if (qsKey && fvsIndex.has(qsKey)) initialKey = qsKey;
  else if (prefKey && fvsIndex.has(prefKey)) initialKey = prefKey;
  else {
    const ord = fvsIndex.__order || Array.from(fvsIndex.keys());
    initialKey = ord[0] || '';
  }

  if (initialKey) {
    fvsSelect.value = initialKey;
    State.CURRENT_FVS = initialKey;
    window.DOGE.__lastManualFVS = initialKey;
    applyFVSSelection(initialKey, fvsIndex, false);
  } else {
    fvsSelect.value = '';
    State.CURRENT_FVS = '';
    window.DOGE.__lastManualFVS = '';
  }

  const maxLvl = getMaxLevel();
  if (floorLimitRange) {
    floorLimitRange.min = '0';
    floorLimitRange.max = String(maxLvl);
    floorLimitRange.step = '1';

    showAllFloors();
    if (!floorLimitRange.value) floorLimitRange.value = '0';
    if (floorLimitValue) floorLimitValue.textContent = '—';

    floorLimitRange.addEventListener('input', () => {
      const lv = Number(floorLimitRange.value) || 0;
      showOnlyFloor(lv);
      if (floorLimitValue) floorLimitValue.textContent = `${lv}`;
      render();
    });
  }

  wireEvents(fvsIndex);

  (window.DOGE ||= {}).__isoFloor ??= null;
  window.DOGE.__isoPavPrefix ??= null;
  window.DOGE.__lastManualFVS ??= initialKey;

  // Configura eventos do modal
  window.addEventListener('doge:open-settings', () => {
    applyModalTint(true);
  }, { passive: true });

  window.addEventListener('doge:close-settings', () => {
    applyModalTint(false);
    const qs = new URL(location.href).searchParams;
    const obraQS = qs.get('obra') || '';
    if (!obraQS) {
      setTimeout(() => openSettingsModal?.(), 0);
    }
  }, { passive: true });

  window.addEventListener('doge:isolate-floor', (ev) => {
    const d = ev?.detail || {};
    let lv = Number(d.levelIdx);
    if (!Number.isFinite(lv)) {
      console.log('[doge:isolate-floor] Invalid levelIdx:', d.levelIdx);
      return;
    }

    const max = Number(getMaxLevel?.() ?? 0) || 0;
    const fvsIndex = buildFVSIndexFromLists(fvsList || [], apartamentos || []);
    const previousFVS = State.CURRENT_FVS;
    console.log('[doge:isolate-floor] Starting: levelIdx=', lv, 'previousFVS=', previousFVS, 'fvsIndex=', Array.from(fvsIndex.keys()));

    // Toggle: se já está isolado nesse mesmo nível → desfaz (mostrar todos)
    if (window.DOGE.__isoFloor === lv) {
      console.log('[doge:isolate-floor] Desfazer isolamento: levelIdx=', lv);
      window.DOGE.__isoFloor = null;
      window.DOGE.__isoPavPrefix = null;
      if (typeof applyFloorLimit === 'function') applyFloorLimit(max);
      if (typeof showAllFloors === 'function') showAllFloors();
      if (floorLimitRange) floorLimitRange.value = String(max);
      if (floorLimitValue) floorLimitValue.textContent = '—all—';
      populateFVSSelect(fvsSelect, fvsIndex, !!State.NC_MODE, !!State.IN_PROGRESS_MODE, null);
      const targetFVS = window.DOGE.__lastManualFVS || previousFVS;
      if (targetFVS && fvsIndex.has(targetFVS)) {
        fvsSelect.value = targetFVS;
        State.CURRENT_FVS = targetFVS;
        applyFVSSelection(targetFVS, fvsIndex, false);
      } else {
        fvsSelect.value = '';
        State.CURRENT_FVS = '';
        applyFVSSelection('', fvsIndex, false);
      }
      render2DCards();
      render();
      return;
    }

    // Isolar novo nível
    console.log('[doge:isolate-floor] Isolando pavimento: levelIdx=', lv);
    window.DOGE.__isoFloor = lv;
    window.DOGE.__isoPavPrefix = getPavimentoPrefixForLevel(lv);
    if (typeof showOnlyFloor === 'function') showOnlyFloor(lv);
    if (floorLimitRange) floorLimitRange.value = String(lv);
    if (floorLimitValue) floorLimitValue.textContent = String(lv);
    populateFVSSelect(fvsSelect, fvsIndex, !!State.NC_MODE, !!State.IN_PROGRESS_MODE, window.DOGE.__isoPavPrefix);

    const availableOptions = [...fvsSelect.options].filter(o => o.value && !o.disabled);
    console.log('[doge:isolate-floor] Após populate: availableOptions=', availableOptions.map(o => o.value));
    if (availableOptions.length === 0) {
      fvsSelect.innerHTML = '<option value="" disabled selected>Nenhum serviço neste pavimento</option>';
      State.CURRENT_FVS = previousFVS || '';
      console.log('[doge:isolate-floor] Nenhuma FVS disponível no pavimento:', lv, 'preservando previousFVS=', previousFVS);
    } else if (previousFVS && availableOptions.some(o => o.value === previousFVS)) {
      fvsSelect.value = previousFVS;
      State.CURRENT_FVS = previousFVS;
      applyFVSSelection(previousFVS, fvsIndex, false);
      console.log('[doge:isolate-floor] Mantendo FVS anterior:', previousFVS);
    } else {
      fvsSelect.value = '';
      State.CURRENT_FVS = previousFVS || '';
      console.log('[doge:isolate-floor] FVS anterior não disponível, dropdown vazio, preservando:', previousFVS);
    }

    render2DCards();
    render();
  }, { passive: true });
}

function wireEvents(fvsIndex) {
  fvsSelect?.addEventListener('change', () => {
    const key = normFVSKey(fvsSelect.value);
    console.log(`[fvsSelect:change] Selected FVS: ${key}`);
    applyFVSSelection(key, fvsIndex, true);
    render2DCards();
    render();
  });

  btnNC?.addEventListener('click', () => {
    State.NC_MODE = !State.NC_MODE;
    btnNC.setAttribute('aria-pressed', String(!!State.NC_MODE));
    btnNC.classList.toggle('active', !!State.NC_MODE);
    setQS({ nc: State.NC_MODE ? '1' : null });
    const prefs = loadPrefs() || {};
    prefs.nc = State.NC_MODE;
    savePrefs(prefs);
    console.log(`[btnNC] NC_MODE=${State.NC_MODE}`);
    populateFVSSelect(fvsSelect, fvsIndex, !!State.NC_MODE, !!State.IN_PROGRESS_MODE, window.DOGE?.__isoPavPrefix ?? null);
    if (fvsSelect.value) {
      console.log(`[btnNC] Applying FVS: ${fvsSelect.value}`);
      applyFVSSelection(fvsSelect.value, fvsIndex, false);
    } else if (State.CURRENT_FVS && fvsIndex.has(State.CURRENT_FVS)) {
      console.log(`[btnNC] Reapplying previous FVS: ${State.CURRENT_FVS}`);
      applyFVSSelection(State.CURRENT_FVS, fvsIndex, false);
    } else {
      console.log(`[btnNC] No valid FVS, calling applyFVSAndRefresh`);
      applyFVSAndRefresh();
    }
    render2DCards();
    render();
  });

  btnInProgress?.addEventListener('click', () => {
    State.IN_PROGRESS_MODE = !State.IN_PROGRESS_MODE;
    btnInProgress.setAttribute('aria-pressed', String(!!State.IN_PROGRESS_MODE));
    btnInProgress.classList.toggle('active', !!State.IN_PROGRESS_MODE);
    setQS({ inProgress: State.IN_PROGRESS_MODE ? '1' : null });
    const prefs = loadPrefs() || {};
    prefs.inProgress = State.IN_PROGRESS_MODE;
    savePrefs(prefs);
    console.log(`[btnInProgress] IN_PROGRESS_MODE=${State.IN_PROGRESS_MODE}`);
    populateFVSSelect(fvsSelect, fvsIndex, !!State.NC_MODE, !!State.IN_PROGRESS_MODE, window.DOGE?.__isoPavPrefix ?? null);
    if (fvsSelect.value) {
      console.log(`[btnInProgress] Applying FVS: ${fvsSelect.value}`);
      applyFVSSelection(fvsSelect.value, fvsIndex, false);
    } else if (State.CURRENT_FVS && fvsIndex.has(State.CURRENT_FVS)) {
      console.log(`[btnInProgress] Reapplying previous FVS: ${State.CURRENT_FVS}`);
      applyFVSSelection(State.CURRENT_FVS, fvsIndex, false);
    } else {
      console.log(`[btnInProgress] No valid FVS, calling applyFVSAndRefresh`);
      applyFVSAndRefresh();
    }
    render2DCards();
    render();
  });

  opacityRange?.addEventListener('input', () => {
    const v = Number(opacityRange.value) || 0;
    State.faceOpacity = Math.max(0, Math.min(1, v / 100));
    setFaceOpacity(State.faceOpacity);
    render();
  });

  explodeXYRange?.addEventListener('input', () => {
    State.explodeXY = Number(explodeXYRange.value) || 0;
    applyExplode();
    render();
  });

  explodeYRange?.addEventListener('input', () => {
    State.explodeY = Number(explodeYRange.value) || 0;
    applyExplode();
    render();
  });

  btnResetAll?.addEventListener('click', () => {
    State.faceOpacity = 0.30;
    if (opacityRange) opacityRange.value = String(Math.round(State.faceOpacity * 100));

    State.explodeXY = 0;
    if (explodeXYRange) explodeXYRange.value = '0';

    State.explodeY = 0;
    if (explodeYRange) explodeYRange.value = '0';

    State.NC_MODE = false;
    if (btnNC) {
      btnNC.setAttribute('aria-pressed', 'false');
      btnNC.classList.remove('active');
    }
    setQS({ nc: null });

    State.IN_PROGRESS_MODE = false;
    if (btnInProgress) {
      btnInProgress.setAttribute('aria-pressed', 'false');
      btnInProgress.classList.remove('active');
    }
    setQS({ inProgress: null });

    const prefs = loadPrefs() || {};
    prefs.nc = false;
    prefs.inProgress = false;
    savePrefs(prefs);

    if (State.flatten2D >= 0.95) {
      State.flatten2D = 0;
      if (btn2D) {
        btn2D.setAttribute('aria-pressed', 'false');
        btn2D.classList.remove('active');
      }
      apply2DVisual(false);
      hide2D();
      if (btnZoom2D) {
        btnZoom2D.style.display = 'none';
        btnZoom2D.textContent = '🔍' + getNextGridZoomSymbolFrom(1);
      }
      if (rowSliders) rowSliders.style.display = '';
    }

    applyExplode();
    recenterCamera({ theta: INITIAL_THETA, phi: INITIAL_PHI, animate: false, margin: 1.18 });
    recolorMeshes3D();
    render2DCards();
    render();
  });

  btn2D?.addEventListener('click', () => {
    const turningOn = !(State.flatten2D >= 0.95);

    State.flatten2D = turningOn ? 1 : 0;
    btn2D.setAttribute('aria-pressed', String(turningOn));
    btn2D.classList.toggle('active', turningOn);

    if (turningOn) {
      if (floorLimitRange) floorLimitRange.style.display = 'none';
      if (floorLimitValue) floorLimitValue.style.display = 'none';
      clear3DHighlight();

      apply2DVisual(true);
      show2D();

      if (rowSliders) rowSliders.style.display = 'none';

      if (btnZoom2D) {
        btnZoom2D.style.display = 'inline-flex';
        setGridZoom(1);
        const sym = getNextGridZoomSymbolFrom(1);
        btnZoom2D.textContent = (sym === '+') ? '🔍+' : '🔍−';
      }

      render2DCards();
    } else {
      if (floorLimitRange) floorLimitRange.style.display = '';
      if (floorLimitValue) floorLimitValue.style.display = '';
      apply2DVisual(false);
      hide2D();

      if (rowSliders) rowSliders.style.display = '';
      if (btnZoom2D) btnZoom2D.style.display = 'none';
    }
    render();
  });

  btnZoom2D?.addEventListener('click', () => {
    const host = document.getElementById('cards2d');
    const focalY = host ? Math.floor(host.clientHeight / 2) : 0;
    const focalX = host ? Math.floor(host.clientWidth / 2) : 0;

    with2DScrollPreserved(() => {
      const reached = zoom2DStep();
      const sym = getNextGridZoomSymbolFrom(reached);
      btnZoom2D.textContent = (sym === '+') ? '🔍+' : '🔍−';
    }, { focalY, focalX });
  });
}

function with2DScrollPreserved(
  action,
  { containerId = 'cards2d', focalY, focalX } = {}
) {
  const host = document.getElementById(containerId);
  if (!host) { action?.(); return; }

  const preTop = host.scrollTop;
  const preH = host.scrollHeight || 1;
  const preLeft = host.scrollLeft;
  const preW = host.scrollWidth || 1;

  const fy = (typeof focalY === 'number')
    ? focalY
    : Math.max(0, Math.min(host.clientHeight, Math.floor(host.clientHeight / 2)));
  const fx = (typeof focalX === 'number')
    ? focalX
    : Math.max(0, Math.min(host.clientWidth, Math.floor(host.clientWidth / 2)));

  const yAbs = preTop + fy;
  const xAbs = preLeft + fx;

  const cards = Array.from(host.querySelectorAll('.card'));
  let anchor = null, anchorPrevY = null, anchorPrevX = null, anchorKey = null;
  let bestY = Infinity, bestX = Infinity;

  for (const el of cards) {
    const cy = Number.parseFloat(el.style.top) || el.offsetTop || 0;
    const cx = Number.parseFloat(el.style.left) || el.offsetLeft || 0;
    const dy = Math.abs(cy - yAbs);
    const dx = Math.abs(cx - xAbs);

    if (dy < bestY || (dy === bestY && dx < bestX)) {
      bestY = dy; bestX = dx;
      anchor = el;
      anchorPrevY = cy;
      anchorPrevX = cx;
      anchorKey = (el.dataset.apto || '') + '|' + (el.dataset.pav || '');
    }
  }

  action?.();

  const restore = () => {
    let newAnchor = null, newY = null, newX = null;
    if (anchorKey) {
      const [apt, pav] = anchorKey.split('|');
      newAnchor = Array.from(host.querySelectorAll('.card'))
        .find(el => el.dataset.apto === apt && el.dataset.pav === pav) || null;
      if (newAnchor) {
        newY = Number.parseFloat(newAnchor.style.top) || newAnchor.offsetTop || 0;
        newX = Number.parseFloat(newAnchor.style.left) || newAnchor.offsetLeft || 0;
      }
    }

    if (newAnchor != null && anchorPrevY != null && anchorPrevX != null) {
      const dy = newY - anchorPrevY;
      const dx = newX - anchorPrevX;
      host.scrollTop = preTop + dy;
      host.scrollLeft = preLeft + dx;
    } else {
      const newH = host.scrollHeight || 1;
      const newW = host.scrollWidth || 1;

      const ratioY = newH / preH;
      const ratioX = newW / preW;

      const desiredTop = ((preTop + fy) * ratioY) - fy;
      const desiredLeft = ((preLeft + fx) * ratioX) - fx;

      const maxTop = Math.max(0, newH - host.clientHeight);
      const maxLeft = Math.max(0, newW - host.clientWidth);

      host.scrollTop = Math.max(0, Math.min(maxTop, desiredTop));
      host.scrollLeft = Math.max(0, Math.min(maxLeft, desiredLeft));
    }
  };

  requestAnimationFrame(() => requestAnimationFrame(restore));
}

function setupHudResizeObserver() {
  if (!hudEl) return;
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => {
      if (State.flatten2D >= 0.95) {
        render2DCards();
      }
    });
    ro.observe(hudEl);
  }
}

setupHudResizeObserver();