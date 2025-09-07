// ============================
// Entry do Viewer DOGE
// ============================

import { initTooltip } from './utils.js';
import { State } from './state.js';
import { loadAllData, layoutData } from './data.js';
import {
  initScene,
  applyOrbitToCamera,
  render,
  camera,
  orbitDelta,
  panDelta,
  zoomDelta,
  recenterCamera,
  INITIAL_THETA,
  INITIAL_PHI,
  refreshModelPivotAndFit // <- para hookar também
} from './scene.js';
import {
  buildFromLayout,
  getTorre,
  apply2DVisual
} from './geometry.js';
import { initOverlay2D, render2DCards, hide2D } from './overlay2d.js';
import { initPicking, selectGroup } from './picking.js';
import { initModal } from './modal.js';
import { initHUD, applyFVSAndRefresh } from './hud.js';

// === DEBUG: medir top do prédio em pixels de tela ===
import { scene, renderer } from './scene.js';

function __doge_getBBoxRoot() {
  const torre = getTorre?.();
  return torre || scene;
}
function __doge_computeBBox(root) {
  try {
    const bb = new THREE.Box3().setFromObject(root);
    if (!Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x)) return null;
    return bb;
  } catch (e) { return null; }
}
function __doge_worldToScreen(v3) {
  const v = v3.clone().project(camera);
  const size = renderer.getSize(new THREE.Vector2());
  return {
    x: (v.x * 0.5 + 0.5) * size.x,
    y: (-v.y * 0.5 + 0.5) * size.y,
    w: size.x,
    h: size.y
  };
}
function __doge_measureScreen(label = '') {
  const root = __doge_getBBoxRoot();
  const bb = __doge_computeBBox(root);
  if (!bb) { console.log('[DOGE:measure]', label, 'bbox=null'); return null; }
  const topCenter = new THREE.Vector3(
    (bb.min.x + bb.max.x) * 0.5,
    bb.max.y,
    (bb.min.z + bb.max.z) * 0.5
  );
  const scr = __doge_worldToScreen(topCenter);
  const info = {
    label,
    topPx: { x: Math.round(scr.x), y: Math.round(scr.y) },
    viewport: { w: scr.w, h: scr.h },
    marginTopPx: Math.round(scr.y),
    cutTop: scr.y < 0,
    orbitTarget: { x: +(State.orbitTarget?.x ?? 0).toFixed?.(3) ?? State.orbitTarget?.x, y: +(State.orbitTarget?.y ?? 0).toFixed?.(3) ?? State.orbitTarget?.y, z: +(State.orbitTarget?.z ?? 0).toFixed?.(3) ?? State.orbitTarget?.z },
    radius: Number(State.radius).toFixed(3),
    theta: Number(State.theta).toFixed(3),
    phi: Number(State.phi).toFixed(3),
    camPos: {
      x: Number(camera.position.x).toFixed(3),
      y: Number(camera.position.y).toFixed(3),
      z: Number(camera.position.z).toFixed(3)
    }
  };
  console.log('[DOGE:measure]', info);
  return info;
}
function __doge_watchForJumps(ms = 2000, pxJump = 8) {
  let prevY = null;
  const t0 = performance.now();
  function tick() {
    const m = __doge_measureScreen('watch');
    if (m) {
      if (prevY !== null) {
        const dy = m.topPx.y - prevY;
        if (Math.abs(dy) >= pxJump) {
          console.warn('[DOGE:jump]', `ΔY=${Math.round(dy)}px`, 'em', Math.round(performance.now() - t0), 'ms');
          console.warn('[DOGE:jump:after]', m);
        }
      }
      prevY = m.topPx.y;
    }
    if (performance.now() - t0 < ms) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// === DEBUG HOOK: rastrear e (opcional) bloquear fits “intrusos” nos 2s iniciais
const __DOGE_BOOT_T0 = performance.now();
let __DOGE_BOOT_LOCK_MS = 2000;  // mude p/ 0 para só logar (sem bloquear)
let __doge_fitHooksInstalled = false;

function __doge_installFitHooks() {
  if (__doge_fitHooksInstalled) return;
  __doge_fitHooksInstalled = true;

  const __orig_recenter = recenterCamera;
  const __orig_refresh  = refreshModelPivotAndFit;

  const guard = (name, orig) => (...args) => {
    const since = Math.round(performance.now() - __DOGE_BOOT_T0);
    const block = since < __DOGE_BOOT_LOCK_MS;
    console.warn(`[DOGE:CALL ${name}] t=${since}ms`, { args, block });
    console.trace(`[DOGE:TRACE ${name}]`);
    if (block) return;     // BLOQUEIA durante lock
    return orig(...args);  // ou só loga se __DOGE_BOOT_LOCK_MS=0
  };

  // expõe originais e wrappers no window (ajuda depurar no console)
  // @ts-ignore
  window.__DOGE_ORIG_RECENTER = __orig_recenter;
  // @ts-ignore
  window.__DOGE_ORIG_REFRESH  = __orig_refresh;
  // @ts-ignore
  window.recenterCamera = guard('recenterCamera', __orig_recenter);
  // @ts-ignore
  window.refreshModelPivotAndFit = guard('refreshModelPivotAndFit', __orig_refresh);
  // @ts-ignore
  window.__DOGE_DISABLE_BOOT_LOCK = () => { __DOGE_BOOT_LOCK_MS = -1; };
}

// ============================
// Boot
// ============================
(async function boot(){
  try {
    __doge_installFitHooks(); // << instala hooks ANTES de tudo

    // UI base
    initTooltip();
    initModal();

    // Loading on
    const loading = document.getElementById('doge-loading');
    loading?.classList.remove('hidden');

    // 1) Carrega dados
    await loadAllData();

    // 2) Cena / câmera / renderer
    initScene();

    // 3) Monta a torre
    const { bbox } = buildFromLayout(layoutData || { meta:{}, placements:[] });

    // --- LOGS iniciais ---
    __doge_measureScreen('apos build (antes do 1o render)');
    render();
    __doge_measureScreen('apos 1o render');

    // === Fit inicial adiado (garante viewport/HUD estabilizados) ===
    (function fitInitialView(){
      // 1º frame: deixa layout/CSS assentarem
      requestAnimationFrame(()=>{
        __doge_measureScreen('fit: antes de resize');
        // força um recálculo de aspect se algo mudou
        window.dispatchEvent(new Event('resize'));

        // 2º frame: faz o fit-to-bbox já com aspect correto
        requestAnimationFrame(()=>{
          __doge_measureScreen('fit: antes de recenterCamera (adiado)');
          recenterCamera({
            // sem bbox explícito: scene calcula a BBox atual
            theta: INITIAL_THETA,
            phi:   INITIAL_PHI,
            margin: 1.20,
            animate: false
          });
          __doge_measureScreen('fit: apos recenterCamera (adiado)');
          render();
          __doge_measureScreen('fit: apos render (adiado)');
          __doge_watchForJumps(2000, 8);
        });
      });
    })();

    // Enquadra 100% e coloca “de frente”
    __doge_measureScreen('antes: recenterCamera bbox (frente)');
    recenterCamera({ bbox, theta: INITIAL_THETA, phi: INITIAL_PHI, animate: false, margin: 1.18 });
    __doge_measureScreen('apos:  recenterCamera bbox (frente)');

    // 4) Ajuste inicial — mesmo enquadramento usado no recenter
    if (bbox && bbox.isBox3){
      __doge_measureScreen('antes: recenterCamera offset 0.12');
      recenterCamera({ bbox, verticalOffsetRatio: 0.12 });
      __doge_measureScreen('apos:  recenterCamera offset 0.12');
    } else {
      applyOrbitToCamera();
      render();
      __doge_measureScreen('apos: applyOrbitToCamera (sem bbox)');
    }

    // 5) HUD (dropdowns, botões, sliders)
    initHUD();
    __doge_measureScreen('apos initHUD');

    // 6) Aplica FVS/NC — injeta resolvers e COLOR_MAP
    applyFVSAndRefresh();
    __doge_measureScreen('apos applyFVSAndRefresh');

    // 7) Overlay 2D (render já com resolvers prontos)
    initOverlay2D();
    __doge_measureScreen('apos initOverlay2D');

    render2DCards();
    __doge_measureScreen('apos render2DCards');

    // 8) Picking (hover + click) no 3D
    initPicking();
    __doge_measureScreen('apos initPicking');

    // 9) Loading off
    loading?.classList.add('hidden');
    __doge_measureScreen('apos esconder loading');

    // 10) Render inicial
    __doge_measureScreen('antes do render final');
    render();
    __doge_measureScreen('apos render final');

    // 11) Reaplica o offset vertical no resize mantendo enquadramento
    window.addEventListener('resize', ()=> {
      const torre = getTorre();
      if (!torre) return;
      const bb = new THREE.Box3().setFromObject(torre);
      if (!bb || !bb.isBox3) return;
      __doge_measureScreen('resize handler: antes');
      recenterCamera({ bbox: bb, verticalOffsetRatio: 0.12 });
      __doge_measureScreen('resize handler: apos');
    }, { passive:true });

    // 12) Input unificado (mouse + touch) – suave no mobile/desktop
    wireUnifiedInput();
  } catch (err){
    console.error('[viewer] erro no boot:', err);
  }
})();

// ============================
// Selecionar também o grupo 3D ao clicar num card 2D
// ============================
(function wireSelect3DFrom2D(){
  const host = document.getElementById('cards2d');
  if (!host) return;
  host.addEventListener('click', (e)=>{
    const card = e.target.closest?.('.card');
    if (!card || card.classList.contains('disabled')) return;

    const apt = card.dataset.apto || '';
    const torre = getTorre();
    if (!torre) return;

    const target = torre.children.find(g => String(g.userData?.nome || '').trim() === apt);
    if (target) {
      selectGroup(target);
      render();
    }
  });
})();

// ============================
// Input unificado (Pointer Events)
// - 1 ponteiro:
//     * mouse esquerdo  -> ORBIT
//     * mouse direito   -> PAN
//     * touch           -> ORBIT
// - 2 ponteiros (touch): PINCH para zoom + PAN pelo movimento do centro
// - Wheel: zoom
// ============================
function wireUnifiedInput(){
  const cvs = document.getElementById('doge-canvas') || document.querySelector('#app canvas');
  if (!cvs) return;

  // Importantíssimo: já definimos touch-action: none no scene.js
  cvs.addEventListener('gesturestart', e => e.preventDefault?.(), { passive:false });
  cvs.addEventListener('gesturechange', e => e.preventDefault?.(), { passive:false });
  cvs.addEventListener('gestureend', e => e.preventDefault?.(), { passive:false });

  const pointers = new Map(); // id -> {x,y,button,ptype,mode}
  let pinchPrevDist = 0;
  let pinchPrevMid  = null;

  const setModeForPointer = (pe) => {
    if (pe.pointerType === 'mouse'){
      return (pe.button === 2) ? 'pan' : 'orbit';
    }
    return 'orbit';
  };

  const getMidpoint = () => {
    const arr = [...pointers.values()];
    if (arr.length < 2) return null;
    return { x: (arr[0].x + arr[1].x) * 0.5, y: (arr[0].y + arr[1].y) * 0.5 };
  };
  const getDistance = () => {
    const arr = [...pointers.values()];
    if (arr.length < 2) return 0;
    const dx = arr[0].x - arr[1].x;
    const dy = arr[0].y - arr[1].y;
    return Math.hypot(dx, dy);
  };

  // Pointer Down
  cvs.addEventListener('pointerdown', (e)=>{
    cvs.setPointerCapture?.(e.pointerId);

    pointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY,
      button: e.button,
      ptype: e.pointerType,
      mode: setModeForPointer(e)
    });

    if (pointers.size === 2){
      pinchPrevDist = getDistance();
      pinchPrevMid  = getMidpoint();
    }

    e.preventDefault();
  }, { passive:false });

  // Pointer Move
  cvs.addEventListener('pointermove', (e)=>{
    if (!pointers.has(e.pointerId)) return;

    const p = pointers.get(e.pointerId);
    const prevX = p.x, prevY = p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (pointers.size === 1){
      const dx = p.x - prevX;
      const dy = p.y - prevY;

      if (p.mode === 'pan'){
        panDelta(dx, dy);
      } else {
        orbitDelta(dx, dy, p.ptype !== 'mouse');
      }
    } else if (pointers.size === 2){
      const dist = getDistance();
      const mid  = getMidpoint();

      if (pinchPrevDist > 0){
        const dScale = dist - pinchPrevDist;
        if (Math.abs(dScale) > 0.5){
          zoomDelta(-Math.sign(dScale));
        }
      }
      if (pinchPrevMid){
        const mdx = mid.x - pinchPrevMid.x;
        const mdy = mid.y - pinchPrevMid.y;
        if (Math.abs(mdx) > 0 || Math.abs(mdy) > 0){
          panDelta(mdx, mdy);
        }
      }

      pinchPrevDist = dist;
      pinchPrevMid  = mid;
    }

    e.preventDefault();
  }, { passive:false });

  // Pointer Up/Cancel
  const clearPointer = (e)=>{
    pointers.delete(e.pointerId);
    if (pointers.size < 2){
      pinchPrevDist = 0;
      pinchPrevMid  = null;
    }
  };
  cvs.addEventListener('pointerup', clearPointer, { passive:true });
  cvs.addEventListener('pointercancel', clearPointer, { passive:true });
  cvs.addEventListener('lostpointercapture', clearPointer, { passive:true });

  // Wheel (desktop)
  cvs.addEventListener('wheel', (e)=>{
    e.preventDefault();
    const sign = Math.sign(e.deltaY);
    zoomDelta(sign);
  }, { passive:false });

  // Botão direito = pan (somente mouse)
  cvs.addEventListener('contextmenu', e => e.preventDefault(), { passive:false });
}

// ============================
// ESC fecha 2D se ativo (quando o modal não está aberto)
// ============================
window.addEventListener('keydown', (e)=>{
  if (e.key !== 'Escape') return;

  const modalBackdrop = document.getElementById('doge-modal-backdrop');
  const modalOpen = modalBackdrop && modalBackdrop.classList.contains('show');
  if (modalOpen) return;

  // (mantive como no seu arquivo: lugar para desligar overlay 2D, se necessário)
});
