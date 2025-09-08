// ============================
// HUD (controles) — FVS / NC / Opacidade / Explode / 2D / Reset
// ============================

import { State, savePrefs, loadPrefs, getQS, setQS } from './state.js';
import { applyModalTint } from './modal.js'; // garanta esse import no topo
import {
  setFaceOpacity, applyExplode, recolorMeshes3D, apply2DVisual,
  getMaxLevelIndex, showOnlyFloor, showAllFloors, applyFloorLimit, getMaxLevel
} from './geometry.js';
import {
  render2DCards, recolorCards2D, show2D, hide2D,
  setGridZoom, getNextGridZoomSymbol, zoom2DStep, getNextGridZoomSymbolFrom,
  setRowsResolver as setRowsResolver2D
} from './overlay2d.js';
import { buildColorMapForFVS, buildColorMapForFVS_NC } from './colors.js';
import { syncSelectedColor, setRowResolver as setRowResolver3D, clear3DHighlight } from './picking.js';
import { recenterCamera, INITIAL_THETA, INITIAL_PHI, render } from './scene.js';
import { normFVSKey, bestRowForName } from './utils.js';
import { apartamentos, fvsList } from './data.js'; // << usa lista global fvs-list_by_obra.json

// ---- elementos
let hudEl, rowSliders, fvsSelect, btnNC, opacityRange, explodeXYRange, explodeYRange, btn2D, btnZoom2D, btnResetAll, floorLimitRange, floorLimitGroup, floorLimitValue;

// ============================
// Índice FVS -> rows / lookup por nome (ORDEM = fvsList)
// ============================
function buildFVSIndexFromLists(fvsStrings, apts){
  // Map<FVS_KEY, { label, rows, rowsByNameKey(Map<string,row>), counts:{total,withNC} }>
  const buckets = new Map();
  const order = [];

  // 1) cria buckets respeitando a ordem do fvs-list_by_obra.json
  for (const label of (Array.isArray(fvsStrings) ? fvsStrings : [])){
    const key = normFVSKey(label);
    if (!key) continue;
    if (!buckets.has(key)){
      buckets.set(key, {
        label: String(label),
        rows: [],
        rowsByNameKey: new Map(),
        counts: { total: 0, withNC: 0 }
      });
      order.push(key);
    }
  }

  // 2) distribui apartamentos em seus respectivos buckets (apenas se a FVS existir na lista oficial)
  for (const r of (apts || [])){
    const key = normFVSKey(r.fvs ?? r.FVS ?? '');
    if (!key) continue;
    const b = buckets.get(key);
    if (!b) continue; // ignora FVS que não está na lista oficial

    b.rows.push(r);
    b.counts.total++;

    const ncVal = Number(r.qtd_nao_conformidades_ultima_inspecao ?? r.nao_conformidades ?? 0) || 0;
    if (ncVal > 0) b.counts.withNC++;

    const exactKey = String((r.local_origem ?? r.nome ?? '')).trim();
    if (exactKey && !b.rowsByNameKey.has(exactKey)) {
      b.rowsByNameKey.set(exactKey, r);
    }
  }

  // anexa ordem estável
  Object.defineProperty(buckets, '__order', { value: order, enumerable: false });
  return buckets;
}

// === Compat: applyFVSAndRefresh (chamada pelo viewer.js) ===
export function applyFVSAndRefresh(){
  const fvsIndex = buildFVSIndexFromLists(fvsList || [], apartamentos || []);

  let key = State.CURRENT_FVS_KEY || '';
  if (!key && State.CURRENT_FVS_LABEL) key = normFVSKey(State.CURRENT_FVS_LABEL);

  // escolhe primeira da ordem oficial se necessário
  if (!key || !fvsIndex.has(key)){
    const ord = fvsIndex.__order || Array.from(fvsIndex.keys());
    key = ord[0] || '';
  }

  if (fvsSelect) {
    populateFVSSelect(fvsSelect, fvsIndex, /*showNCOnly=*/!!State.NC_MODE);
    if (key && fvsIndex.has(key)) fvsSelect.value = key;
  }

  if (key) applyFVSSelection(key, fvsIndex);

  render2DCards();
  render();
}

function populateFVSSelect(selectEl, fvsIndex, showNCOnly=false){
  if (!selectEl) return;

  const prevVal = selectEl.value;
  selectEl.innerHTML = '';

  // usa ordem do arquivo fvs-list_by_obra.json
  const keys = (fvsIndex.__order && fvsIndex.__order.length)
    ? fvsIndex.__order.slice()
    : Array.from(fvsIndex.keys());

  let added = 0;

  for (const k of keys){
    const b = fvsIndex.get(k);
    if (!b) continue;

    // Garante counts mesmo que rows venham vazias
    const c = b.counts || { total: (b.rows?.length || 0), withNC: (b.rows || []).reduce((acc, r)=>{
      const ncVal = Number(r.qtd_nao_conformidades_ultima_inspecao ?? r.nao_conformidades ?? 0) || 0;
      return acc + (ncVal > 0 ? 1 : 0);
    }, 0) };

    if (showNCOnly && (c.withNC || 0) === 0) continue;

    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = showNCOnly
      ? `${b.label} (NC:${c.withNC||0})`
      : `${b.label} (${c.total||0})`;
    selectEl.appendChild(opt);
    added++;
  }

  // Se o filtro NC zerou a lista por algum motivo, mostra todos
  if (added === 0){
    for (const k of keys){
      const b = fvsIndex.get(k);
      if (!b) continue;
      const c = b.counts || { total: (b.rows?.length || 0), withNC: 0 };
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = `${b.label} (${c.total||0})`;
      selectEl.appendChild(opt);
    }
  }

  // Tenta restaurar a seleção anterior, senão fica no primeiro
  if (prevVal && [...selectEl.options].some(o => o.value === prevVal)){
    selectEl.value = prevVal;
  } else if (selectEl.options.length){
    selectEl.value = selectEl.options[0].value;
  }
}

// === Helpers de Hierarquia (match do mais específico para o mais genérico) ===
// (bestRowForName já importado de utils.js)

function applyFVSSelection(fvsKey, fvsIndex){
  const bucket = fvsIndex.get(fvsKey);
  const rows   = bucket?.rows || [];

  State.CURRENT_FVS_KEY   = fvsKey;
  State.CURRENT_FVS_LABEL = bucket?.label || '';

  // 2D recebe lista bruta da FVS selecionada
  setRowsResolver2D(() => rows);

  // 3D: tenta match exato; se não houver, sobe na hierarquia textual exata
  const byName = bucket?.rowsByNameKey || new Map();
  setRowResolver3D((rawName)=>{
    const nm = String(rawName||'').trim();
    if (!nm) return null;
    return bestRowForName(nm, byName);
  });

  // Mapas de cor (ver colors.js)
  State.COLOR_MAP = State.NC_MODE
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
export function initHUD(){
  // refs
  hudEl        = document.getElementById('hud');
  fvsSelect    = document.getElementById('fvsSelect');
  btnNC        = document.getElementById('btnNC');
  btn2D        = document.getElementById('btn2D');
  btnZoom2D    = document.getElementById('btnZoom2D');
  btnResetAll  = document.getElementById('btnResetAll');

  rowSliders     = document.getElementById('row-sliders');
  opacityRange   = document.getElementById('opacity');
  explodeXYRange = document.getElementById('explodeXY');
  explodeYRange  = document.getElementById('explodeY');

  // --- Slider de pavimento (“escadinha”) ---
  floorLimitRange = document.getElementById('floorLimit');
  floorLimitValue = document.getElementById('floorLimitValue');
  floorLimitGroup = document.getElementById('floorLimitGroup')
                        || floorLimitRange?.closest('.control')
                        || floorLimitRange?.parentElement;

  if (!hudEl) return;

  // ===== Tela inicial: garantir obra escolhida =====
  {
    const qs        = new URL(location.href).searchParams;
    const obraQS    = qs.get('obra') || '';
    const obraCache = localStorage.getItem('obraId') || '';

    if (!obraQS && obraCache){
      const url = new URL(location.href);
      url.searchParams.set('obra', obraCache);
      location.replace(url.toString());
      return;
    }
    if (!obraQS && !obraCache){
      setTimeout(()=> openSettingsModal?.(), 0);
    }
  }

  // Prefs + QS
  const prefs = loadPrefs();
  const qsFvs = getQS('fvs');
  const qsNc  = getQS('nc');
  State.NC_MODE = (qsNc != null) ? (qsNc === '1' || qsNc === 'true') : !!prefs.nc;

  // estado visual do NC
  btnNC?.setAttribute('aria-pressed', String(!!State.NC_MODE));
  btnNC?.classList.toggle('active', !!State.NC_MODE);

  // sliders compactos
  [opacityRange, explodeXYRange, explodeYRange].forEach(inp=>{
    if (!inp) return;
    inp.classList.add('slim');
    inp.style.maxWidth = '140px';
  });

  // valores iniciais
  if (explodeXYRange) explodeXYRange.value = String(State.explodeXY ?? 0);
  if (explodeYRange)  explodeYRange.value  = String(State.explodeY  ?? 0);
  if (opacityRange)   opacityRange.value   = String(Math.round((State.faceOpacity ?? 1) * 100));

  // ===== 2D: só esconder a “escadinha” + esconder linha de sliders =====
  const is2D = (State.flatten2D >= 0.95);
  btn2D?.setAttribute('aria-pressed', String(is2D));
  btn2D?.classList.toggle('active', is2D);

  const floorLabel = document.querySelector('label[for="floorLimit"]');

  const toggle2DUI = (on /* true=2D ligado */) => {
    if (rowSliders) rowSliders.style.display = on ? 'none' : '';
    [floorLabel, floorLimitRange, floorLimitValue].forEach(el=>{
      if (el) el.style.display = on ? 'none' : '';
    });
    if (btnZoom2D){
      btnZoom2D.textContent = '🔍' + getNextGridZoomSymbol();
      btnZoom2D.style.display = on ? 'inline-flex' : 'none';
    }
  };

  toggle2DUI(is2D);
  if (is2D) { show2D(); } else { hide2D(); }

  // ===== Dropdown FVS — usa SOMENTE fvsList (ordem preservada)
  const fvsIndex = buildFVSIndexFromLists(fvsList || [], apartamentos || []);
  populateFVSSelect(fvsSelect, fvsIndex, /*showNCOnly=*/State.NC_MODE);

  // seleção inicial (QS > prefs > primeira da lista oficial)
  let initialKey = '';
  const prefKey  = prefs?.fvs ? normFVSKey(prefs.fvs) : '';
  const qsKey    = qsFvs ? normFVSKey(qsFvs) : '';
  if (qsKey && fvsIndex.has(qsKey)) initialKey = qsKey;
  else if (prefKey && fvsIndex.has(prefKey)) initialKey = prefKey;
  else {
    const ord = fvsIndex.__order || Array.from(fvsIndex.keys());
    initialKey = ord[0] || '';
  }

  if (initialKey){
    fvsSelect.value = initialKey;
    applyFVSSelection(initialKey, fvsIndex);
  }

  // ---- Pavimento (modo solo)
  const maxLvl = getMaxLevel();
  if (floorLimitRange){
    floorLimitRange.min  = '0';
    floorLimitRange.max  = String(maxLvl);
    floorLimitRange.step = '1';

    showAllFloors(); // começa sem corte
    if (!floorLimitRange.value) floorLimitRange.value = '0';
    if (floorLimitValue) floorLimitValue.textContent = '—';

    floorLimitRange.addEventListener('input', ()=>{
      const lv = Number(floorLimitRange.value) || 0;
      showOnlyFloor(lv);
      if (floorLimitValue) floorLimitValue.textContent = `${lv}`;
      render();
    });
  }

  // Listeners padrão (NC, FVS, sliders etc)
  wireEvents(fvsIndex);

  // Observer para mudanças no HUD (recalcula cards 2D)
  setupHudResizeObserver();

  // === Handle (grabber) expandir/recolher HUD (2 estados) ===
  const hudHandle = document.getElementById('hudHandle');
  if (hudHandle && hudEl) {
    hudHandle.setAttribute('role', 'button');
    hudHandle.setAttribute('tabindex', '0');
    hudHandle.setAttribute('aria-label', 'Mostrar ou ocultar controles');
    hudHandle.style.cursor = 'pointer';

    const syncExpanded = () => {
      const collapsed = hudEl.classList.contains('collapsed');
      hudHandle.setAttribute('aria-expanded', String(!collapsed));
    };
    const toggleHud = () => {
      hudEl.classList.toggle('collapsed');
      syncExpanded();
    };

    hudHandle.addEventListener('click', toggleHud, { passive: true });
    hudHandle.addEventListener('keydown', (e)=>{
      if (e.key==='Enter' || e.key===' '){
        e.preventDefault();
        toggleHud();
      }
    }, { passive:false });

    let dragging=false, startY=0, curY=0;
    const THRESHOLD=28;
    const onPD = (ev)=>{
      if (ev.button!==undefined && ev.button!==0) return;
      dragging=true;
      startY = ev.clientY ?? ev.touches?.[0]?.clientY ?? 0;
      curY   = startY;
      hudEl.classList.add('dragging');
      hudHandle.setPointerCapture?.(ev.pointerId);
    };
    const onPM = (ev)=>{
      if (!dragging) return;
      curY = ev.clientY ?? ev.touches?.[0]?.clientY ?? 0;
      const dy = curY - startY;
      const clamped = Math.max(-60, Math.min(60, dy));
      hudEl.style.transform = `translateY(${clamped}px)`;
    };
    const onPU = ()=>{
      if (!dragging) return;
      dragging=false;
      hudEl.classList.remove('dragging');
      hudEl.style.transform='';
      const dy = curY - startY;
      if (dy <= -THRESHOLD){ hudEl.classList.remove('collapsed'); }
      else if (dy >= THRESHOLD){ hudEl.classList.add('collapsed'); }
      syncExpanded();
    };
    hudHandle.addEventListener('pointerdown', onPD, { passive:true });
    hudHandle.addEventListener('pointermove', onPM, { passive:true });
    hudHandle.addEventListener('pointerup', onPU, { passive:true });
    hudHandle.addEventListener('pointercancel', onPU, { passive:true });
    hudHandle.addEventListener('lostpointercapture', onPU, { passive:true });

    syncExpanded();
  }

  // ===== Configurações (dot) — selecionar obra =====
  const btnSettings = document.getElementById('btnHudSettings');
  if (btnSettings) {
    btnSettings.addEventListener('pointerdown', (e)=>{ e.preventDefault(); e.stopPropagation(); }, { passive:false });
    btnSettings.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); openSettingsModal(); }, { passive:false });
  }

async function openSettingsModal(){
  const backdrop = document.getElementById('doge-modal-backdrop');
  const modal    = document.getElementById('doge-modal');
  const titleEl  = document.getElementById('doge-modal-title');
  const content  = document.getElementById('doge-modal-content');
  const closeBtn = document.getElementById('doge-modal-close');
  const pill     = document.getElementById('doge-modal-pill');

  if (!backdrop || !modal || !titleEl || !content) return;

  // === helpers (mesma ideia do modal.js) ===
  const getCanvas = () => document.getElementById('doge-canvas') || document.querySelector('#app canvas');
  const setInputLock = (on) => { (window.DOGE ||= {}).inputLocked = !!on; };
  const releaseAllCanvasCaptures = () => {
    const cvs = getCanvas();
    const dbg = window.DOGE?.__inputDbg;
    if (!cvs || !dbg) return;
    if (dbg.captures && cvs.releasePointerCapture) {
      for (const id of Array.from(dbg.captures)) { try { cvs.releasePointerCapture(id); } catch {} }
      dbg.captures.clear?.();
    }
    try { dbg.pointers?.clear?.(); } catch {}
  };

  const closeSettingsModal = () => {
    // fecha visualmente
    backdrop.classList.remove('show');
    backdrop.setAttribute('aria-hidden','true');
    document.body.classList.remove('modal-open');

    // reabilita canvas/input
    const cvs = getCanvas();
    if (cvs) {
      cvs.style.pointerEvents = 'auto';
      releaseAllCanvasCaptures();
    }
    setInputLock(false);

    // remove marcação de "obra" (evita herdar cinza no próximo modal de detalhes)
    modal.removeAttribute('data-kind');

    // limpa listeners
    backdrop.removeEventListener('click', onClickOutside, true);
    content.removeEventListener('click', onCancelBtn);
    closeBtn?.removeEventListener('click', closeSettingsModal);
    document.removeEventListener('keydown', onEsc);

    if (pill) pill.style.display = '';
  };

  const onEsc = (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('show')) {
      e.preventDefault();
      closeSettingsModal();
    }
  };
  const onClickOutside = (e) => { if (e.target === backdrop) closeSettingsModal(); };
  const onCancelBtn = (e) => {
    const el = e.target.closest?.('#obraCancel,[data-modal-cancel],.js-modal-cancel,[data-dismiss="modal"]');
    if (el) { e.preventDefault(); closeSettingsModal(); }
  };

  // ====== Monta conteúdo ======
  // Marca explicitamente este modal como "obra" e força o tint cinza
  modal.setAttribute('data-kind', 'obra');
  applyModalTint?.('#6e7681');

  titleEl.textContent = 'Configurações';
  if (pill) { pill.textContent = 'Obra'; pill.style.display = 'inline-block'; }

  let obras = [];
  let errorMsg = '';
  try{
    const resp = await fetch('./data/obras.json', { cache:'no-store' });
    if (!resp.ok){
      errorMsg = `Não encontrei ./data/obras.json (status ${resp.status}).`;
    } else {
      const json = await resp.json();
      if (Array.isArray(json)) {
        obras = json.filter(o => o && typeof o.id === 'string');
        if (obras.length === 0) errorMsg = 'obras.json está vazio ou sem objetos { id, label }.';
      } else {
        errorMsg = 'obras.json não é um array JSON.';
      }
    }
  }catch(e){
    errorMsg = 'Falha ao requisitar obras.json.';
    console.error('[obras.json] fetch/parse:', e);
  }

  const qs = new URL(location.href).searchParams;
  const obraAtual = qs.get('obra') || '';
  if ((!Array.isArray(obras) || obras.length === 0) && obraAtual) {
    obras = [{ id: obraAtual, label: obraAtual }];
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div class="form-grid">
      <label>
        <span>Obra</span>
        <select id="obraSelect">
          ${obras.map(o => `<option value="${o.id}" ${o.id===obraAtual?'selected':''}>${o.label ?? o.id}</option>`).join('')}
        </select>
      </label>
      ${errorMsg ? `<p class="error-msg">${errorMsg}</p>` : ''}
      <div class="actions">
        <button id="obraCancel" type="button" class="btn-cancel">Cancelar</button>
        <button id="obraApply" type="button" class="btn-apply">Aplicar</button>
      </div>
    </div>
  `;
  content.replaceChildren(wrapper);

  const obraSelect = wrapper.querySelector('#obraSelect');

  wrapper.querySelector('#obraApply')?.addEventListener('click', ()=>{
    const chosen = obraSelect?.value || '';
    if (!chosen) return;
    localStorage.setItem('obraId', chosen);
    const url = new URL(location.href);
    url.searchParams.set('obra', chosen);
    location.href = url.toString();
  }, { passive:true });

  // ====== ABRIR modal ======
  const cvs = getCanvas();
  if (cvs) {
    cvs.style.pointerEvents = 'none';
    releaseAllCanvasCaptures();
  }
  (window.DOGE ||= {}).__inputDbg ||= {};
  setInputLock(true);

  backdrop.classList.add('show');
  backdrop.setAttribute('aria-hidden','false');
  document.body.classList.add('modal-open');

  content.addEventListener('click', onCancelBtn);
  closeBtn?.addEventListener('click', closeSettingsModal, { passive:true });
  backdrop.addEventListener('click', onClickOutside, true);
  document.addEventListener('keydown', onEsc);
}

  // ===== Sync UI 2D após clique no botão 2D
  const sync2DUI = () => {
    const on = (btn2D?.getAttribute('aria-pressed') === 'true')
            ||  btn2D?.classList.contains('active')
            || (State.flatten2D >= 0.95);
    toggle2DUI(on);
    if (on) show2D(); else hide2D();
  };
  btn2D?.addEventListener('click', ()=> setTimeout(sync2DUI, 0), { passive:true });
  btn2D?.addEventListener('keydown', (e)=>{
    if (e.key==='Enter' || e.key===' '){ setTimeout(sync2DUI, 0); }
  }, { passive:true });
}

// ============================
// Eventos do HUD
// ============================
function wireEvents(fvsIndex){
  // FVS change
  fvsSelect?.addEventListener('change', ()=>{
    const key = normFVSKey(fvsSelect.value);
    setQS({ fvs: key || null });
    const prefs = loadPrefs() || {};
    prefs.fvs = key;
    savePrefs(prefs);

    applyFVSSelection(key, fvsIndex);
    render2DCards();
    render();
  });

  // Corte por pavimento (granular, step=1)
  floorLimitRange?.addEventListener('input', ()=>{
    const lv = Number(floorLimitRange.value) || 0;
    showOnlyFloor(lv);
    render();
  });

  // NC toggle
  btnNC?.addEventListener('click', ()=>{
    with2DScrollPreserved(()=>{
      State.NC_MODE = !State.NC_MODE;
      const on = !!State.NC_MODE;
      btnNC.setAttribute('aria-pressed', String(on));
      btnNC.classList.toggle('active', on);
      setQS({ nc: on ? '1' : null });
      const prefs = loadPrefs() || {};
      prefs.nc = on;
      savePrefs(prefs);

      populateFVSSelect(fvsSelect, fvsIndex, /*showNCOnly=*/on);

      if (State.CURRENT_FVS_KEY && fvsIndex.has(State.CURRENT_FVS_KEY)){
        if (![...fvsSelect.options].some(o=>o.value===State.CURRENT_FVS_KEY)){
          const ord = fvsIndex.__order || Array.from(fvsIndex.keys());
          State.CURRENT_FVS_KEY = ord[0] || '';
        }
        if (State.CURRENT_FVS_KEY){
          fvsSelect.value = State.CURRENT_FVS_KEY;
          applyFVSSelection(State.CURRENT_FVS_KEY, fvsIndex);
        }
      } else if (fvsSelect.options.length){
        State.CURRENT_FVS_KEY = fvsSelect.options[0].value;
        fvsSelect.value = State.CURRENT_FVS_KEY;
        applyFVSSelection(State.CURRENT_FVS_KEY, fvsIndex);
      }

      render2DCards();
      render();
    });
  });

  // Opacidade
  opacityRange?.addEventListener('input', ()=>{
    const v = Math.max(0, Math.min(100, Number(opacityRange.value)||0)) / 100;
    State.faceOpacity = v;
    setFaceOpacity(v);
    render();
  });

  // Explode XY
  explodeXYRange?.addEventListener('input', ()=>{
    State.explodeXY = Number(explodeXYRange.value) || 0;
    applyExplode();
    render();
  });

  // Explode Y
  explodeYRange?.addEventListener('input', ()=>{
    State.explodeY = Number(explodeYRange.value) || 0;
    applyExplode();
    render();
  });

  // Reset geral (volta tudo ao padrão)
  btnResetAll?.addEventListener('click', ()=>{
    State.explodeXY = 0;
    State.explodeY  = 0;
    if (explodeXYRange) explodeXYRange.value = '0';
    if (explodeYRange)  explodeYRange.value  = '0';

    const maxLvl2 = getMaxLevelIndex();
    State.floorLimit = maxLvl2;
    if (floorLimitRange) floorLimitRange.value = String(maxLvl2);
    if (floorLimitValue) floorLimitValue.textContent = '—all—';
    applyFloorLimit(maxLvl2);

    applyExplode();

    State.flatten2D = 0;
    btn2D?.setAttribute('aria-pressed','false');
    btn2D?.classList.remove('active');
    hide2D();
    if (btnZoom2D){
      btnZoom2D.style.display = 'none';
      btnZoom2D.textContent = '🔍' + getNextGridZoomSymbolFrom(1);
    }
    if (rowSliders) rowSliders.style.display = '';

    State.faceOpacity = 1;
    if (opacityRange) opacityRange.value = '100';
    setFaceOpacity(1, true);

    recenterCamera({ theta: INITIAL_THETA, phi: INITIAL_PHI, animate: false, margin: 1.18 });

    recolorMeshes3D();
    render2DCards();
    render();
  });

  // Toggle 2D
  btn2D?.addEventListener('click', ()=>{
    const turningOn = !(State.flatten2D >= 0.95);

    State.flatten2D = turningOn ? 1 : 0;
    btn2D.setAttribute('aria-pressed', turningOn ? 'true' : 'false');
    btn2D.classList.toggle('active', turningOn);

    if (turningOn){
      if (floorLimitRange) floorLimitRange.style.display = 'none';
      if (floorLimitValue) floorLimitValue.style.display = 'none';
      clear3DHighlight();

      apply2DVisual(true);
      show2D();

      if (rowSliders) rowSliders.style.display = 'none';

      if (btnZoom2D){
        btnZoom2D.style.display = 'inline-flex';
        setGridZoom(1);
        const sym = getNextGridZoomSymbolFrom(1);
        btnZoom2D.textContent = (sym === '+') ? '🔍+' : '🔍−';
      }

      render2DCards();
    }else{
      if (floorLimitRange) floorLimitRange.style.display = '';
      if (floorLimitValue) floorLimitValue.style.display = '';
      apply2DVisual(false);
      hide2D();

      if (rowSliders) rowSliders.style.display = '';
      if (btnZoom2D) btnZoom2D.style.display = 'none';
    }
    render();
  });

  // Botão de Zoom 2D
  btnZoom2D?.addEventListener('click', ()=>{
    const host = document.getElementById('cards2d');
    const focalY = host ? Math.floor(host.clientHeight / 2) : 0;
    const focalX = host ? Math.floor(host.clientWidth  / 2) : 0;

    with2DScrollPreserved(()=>{
      const reached = zoom2DStep();
      const sym = getNextGridZoomSymbolFrom(reached);
      btnZoom2D.textContent = (sym === '+') ? '🔍+' : '🔍−';
    }, { focalY, focalX });
  });
}

function with2DScrollPreserved(
  action,
  { containerId = 'cards2d', focalY, focalX } = {}
){
  const host = document.getElementById(containerId);
  if (!host){ action?.(); return; }

  const preTop   = host.scrollTop;
  const preH     = host.scrollHeight  || 1;
  const preLeft  = host.scrollLeft;
  const preW     = host.scrollWidth   || 1;

  const fy = (typeof focalY === 'number')
    ? focalY
    : Math.max(0, Math.min(host.clientHeight, Math.floor(host.clientHeight / 2)));
  const fx = (typeof focalX === 'number')
    ? focalX
    : Math.max(0, Math.min(host.clientWidth,  Math.floor(host.clientWidth  / 2)));

  const yAbs = preTop  + fy;
  const xAbs = preLeft + fx;

  const cards = Array.from(host.querySelectorAll('.card'));
  let anchor = null, anchorPrevY = null, anchorPrevX = null, anchorKey = null;
  let bestY = Infinity, bestX = Infinity;

  for (const el of cards){
    const cy = Number.parseFloat(el.style.top)  || el.offsetTop  || 0;
    const cx = Number.parseFloat(el.style.left) || el.offsetLeft || 0;
    const dy = Math.abs(cy - yAbs);
    const dx = Math.abs(cx - xAbs);

    if (dy < bestY || (dy === bestY && dx < bestX)){
      bestY = dy; bestX = dx;
      anchor = el;
      anchorPrevY = cy;
      anchorPrevX = cx;
      anchorKey = (el.dataset.apto || '') + '|' + (el.dataset.pav || '');
    }
  }

  action?.();

  const restore = ()=>{
    let newAnchor = null, newY = null, newX = null;
    if (anchorKey){
      const [apt,pav] = anchorKey.split('|');
      newAnchor = Array.from(host.querySelectorAll('.card'))
        .find(el => el.dataset.apto === apt && el.dataset.pav === pav) || null;
      if (newAnchor){
        newY = Number.parseFloat(newAnchor.style.top)  || newAnchor.offsetTop  || 0;
        newX = Number.parseFloat(newAnchor.style.left) || newAnchor.offsetLeft || 0;
      }
    }

    if (newAnchor != null && anchorPrevY != null && anchorPrevX != null){
      const dy = newY - anchorPrevY;
      const dx = newX - anchorPrevX;
      host.scrollTop  = preTop  + dy;
      host.scrollLeft = preLeft + dx;
    } else {
      const newH = host.scrollHeight || 1;
      const newW = host.scrollWidth  || 1;

      const ratioY = newH / preH;
      const ratioX = newW / preW;

      const desiredTop  = ((preTop  + fy) * ratioY) - fy;
      const desiredLeft = ((preLeft + fx) * ratioX) - fx;

      const maxTop  = Math.max(0, newH - host.clientHeight);
      const maxLeft = Math.max(0, newW - host.clientWidth);

      host.scrollTop  = Math.max(0, Math.min(maxTop,  desiredTop));
      host.scrollLeft = Math.max(0, Math.min(maxLeft, desiredLeft));
    }
  };

  requestAnimationFrame(()=> requestAnimationFrame(restore));
}

// ============================
// Observador de tamanho do HUD
// ============================
function setupHudResizeObserver(){
  if (!hudEl) return;
  if ('ResizeObserver' in window){
    const ro = new ResizeObserver(()=>{
      if (State.flatten2D >= 0.95){
        render2DCards();
      }
    });
    ro.observe(hudEl);
  }
}
