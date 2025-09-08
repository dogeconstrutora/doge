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
  orbitDelta,
  panDelta,
  zoomDelta,
  resetRotation,
  syncOrbitTargetToModel,
  orbitTwist,           // roll por gesto de torção (twist)
  camera,
  scene,
  renderer,
  disableAutoFit        // <<< desativa auto-fit interno do scene
} from './scene.js';
import {
  buildFromLayout,
  getTorre,
  apply2DVisual
} from './geometry.js';
import { initOverlay2D, render2DCards, hide2D, show2D } from './overlay2d.js';
import { initPicking, selectGroup } from './picking.js';
import { initModal } from './modal.js';
import { initHUD, applyFVSAndRefresh } from './hud.js';

// ============================
// Helpers (canvas / modal)
// ============================
function getCanvas(){
  return document.getElementById('doge-canvas') || document.querySelector('#app canvas');
}
function getBackdrop(){
  return document.getElementById('doge-modal-backdrop') || null;
}
function isModalOpen(){
  const bd = getBackdrop();
  return !!(bd && (bd.getAttribute('aria-hidden') === 'false' || bd.classList.contains('show')));
}
function inputLocked(){
  // modal.js seta window.DOGE.inputLocked quando o modal abre
  return isModalOpen() || !!(window.DOGE && window.DOGE.inputLocked);
}

// --- Sincroniza lock/canvas a partir do estado real do backdrop (DOM) ---
function syncLockFromBackdrop() {
  const bd = getBackdrop();
  const cvs = getCanvas();
  const open = !!(bd && (bd.getAttribute('aria-hidden') === 'false' || bd.classList.contains('show')));

  if (!window.DOGE) window.DOGE = {};
  window.DOGE.inputLocked = open;

  if (cvs) {
    const want = open ? 'none' : 'auto';
    if (cvs.style.pointerEvents !== want) cvs.style.pointerEvents = want;
  }
}

// Observa mudanças de classe/aria no backdrop para manter sync
function installBackdropObserver() {
  const bd = getBackdrop();
  if (!bd) return;
  const mo = new MutationObserver(syncLockFromBackdrop);
  mo.observe(bd, { attributes: true, attributeFilter: ['class', 'aria-hidden'] });
  // sync imediato
  syncLockFromBackdrop();
}


// ============================
// Boot
// ============================
(async function boot(){
  try {
    initTooltip();
    initModal();

    const loading = document.getElementById('doge-loading');
    loading?.classList.remove('hidden');

    await loadAllData();

    initScene();
    installDebugSpies(); // <<< ADICIONE ESTA LINHA

    // === DEBUG SPIES: loga qualquer write em State.radius e set() do orbitTarget ===
function installDebugSpies() {
  if (!window.DOGE) window.DOGE = {};
  window.DOGE_LOG_ZOOM ??= true; // liga/desliga logs de zoom rapidamente

  // --------- Spy em State.radius (setter com log + stack curta) ---------
  try {
    if (!Object.getOwnPropertyDescriptor(State, '__radiusSpy')) {
      let __r = Number(State.radius) || 0;
      Object.defineProperty(State, 'radius', {
        configurable: true,
        enumerable: true,
        get(){ return __r; },
        set(v){
          const prev = __r;
          __r = v;
          if (window.DOGE_LOG_ZOOM) {
            const st = new Error().stack?.split('\n')?.slice(2,6)?.join(' ⟶ ') || '';
            console.log('[DOGE:spy][radius:set]', { prev, next: v, stack: st });
          }
        }
      });
      Object.defineProperty(State, '__radiusSpy', { value:true });
    }
  } catch (e) {
    console.warn('[DOGE:spy] radius setter falhou:', e);
  }

  // --------- Spy no set(x,y,z) do orbitTarget ---------
  try {
    if (State.orbitTarget && typeof State.orbitTarget.set === 'function' && !State.orbitTarget.__dogeSetPatched) {
      const origSet = State.orbitTarget.set.bind(State.orbitTarget);
      State.orbitTarget.set = function(x,y,z){
        if (window.DOGE_LOG_ZOOM) {
          const before = { x:this.x, y:this.y, z:this.z };
          const after  = { x, y, z };
          console.log('[DOGE:spy][target.set]', { before, after });
        }
        return origSet(x,y,z);
      };
      State.orbitTarget.__dogeSetPatched = true;
    }
  } catch (e) {
    console.warn('[DOGE:spy] orbitTarget.set patch falhou:', e);
  }
}

    // IMPORTANTE: desliga qualquer auto-fit interno que o scene faça (timer)
    disableAutoFit?.();

    buildFromLayout(layoutData || { meta: {}, placements: [] });

    render();

    // Fit inicial "guardado" (mesma Home do Reset), evitando corte/drift
    (function fitInitialView(){
      requestAnimationFrame(()=>{
        // garante aspect correto após CSS/layout
        window.dispatchEvent(new Event('resize'));

        requestAnimationFrame(()=>{
          // Faz UM único fit e salva como Home
          syncOrbitTargetToModel({ saveAsHome: true, animate: false });
          resetRotation(); // deixa "em pé"
          render();

          // --- Watchdog 1.2s: se cortar topo ou o alvo/raio mudar, refaz fit ---
          const T_GUARD = 1200;
          const t0 = performance.now();
          const target0 = State.orbitTarget.clone();
          const radius0 = State.radius;

          function worldTopToScreen() {
            const torre = getTorre?.();
            const root = torre || scene;
            if (!root) return null;
            const bb = new THREE.Box3().setFromObject(root);
            if (!bb) return null;
            const topCenter = new THREE.Vector3(
              (bb.min.x + bb.max.x) * 0.5,
              bb.max.y,
              (bb.min.z + bb.max.z) * 0.5
            );
            const v = topCenter.clone().project(camera);
            const size = renderer.getSize(new THREE.Vector2());
            return { x: (v.x*0.5+0.5)*size.x, y: (-v.y*0.5+0.5)*size.y };
          }

          function guardTick(){
            const dt = performance.now() - t0;
            const scr = worldTopToScreen();
            const cutTop = scr && scr.y < 0;
            const driftTarget =
              Math.abs(State.orbitTarget.x - target0.x) > 1e-3 ||
              Math.abs(State.orbitTarget.y - target0.y) > 1e-3 ||
              Math.abs(State.orbitTarget.z - target0.z) > 1e-3 ||
              Math.abs(State.radius - radius0) > 1e-3;

            if (cutTop || driftTarget) {
              // reaplica o mesmo fit “Home” para estabilizar
              syncOrbitTargetToModel({ saveAsHome: false, animate: false });
              resetRotation();
              render();
            }

            if (dt < T_GUARD) requestAnimationFrame(guardTick);
          }
          requestAnimationFrame(guardTick);
        });
      });
    })();

    initHUD();
    applyFVSAndRefresh();

    initOverlay2D();
    render2DCards();

    initPicking();

    loading?.classList.add('hidden');
    render();
    installBackdropObserver();
    // Resize: não refaça fit; só reaplique órbita
    let lastW = window.innerWidth, lastH = window.innerHeight;
    window.addEventListener('resize', () => {
      if (window.innerWidth !== lastW || window.innerHeight !== lastH) {
        lastW = window.innerWidth; lastH = window.innerHeight;
        applyOrbitToCamera();
        render();
      }
    }, { passive: true });

    // Input
    wireUnifiedInput();
  } catch (err){
    console.error('[viewer] erro no boot:', err);
  }
})();

// ============================
// Seleção 3D a partir do 2D
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
// ESC fecha 2D se ativo (sem modal)
// ============================
window.addEventListener('keydown', (e)=>{
  if (e.key !== 'Escape') return;
  const backdrop = getBackdrop();
  const modalOpen = backdrop && backdrop.getAttribute('aria-hidden') === 'false';
  if (modalOpen) return;
  if (State.flatten2D >= 0.95){
    State.flatten2D = 0;
    hide2D();
    apply2DVisual(false);
    render();
  }
}, { passive:true });

// ============================
// Tracking da tecla Ctrl (Ctrl + esquerdo = Pan)
// ============================
let __ctrlPressed = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
    __ctrlPressed = true;
    e.preventDefault();
  }
}, { passive:false });
window.addEventListener('keyup', (e) => {
  if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
    __ctrlPressed = false;
  }
}, { passive:true });

// ============================
// Input unificado (Pointer / Touch / Touchpad)
// PC:
//   - Pan: botão do meio OU Space + esquerdo OU duplo-clique + arrasto (esquerdo)
//   - Orbit (yaw/pitch): botão esquerdo
//   - Twist (roll): botão direito
//   - Zoom: scroll
// Touch / Touchpad (notebook):
//   - 1 dedo = orbit (double-tap arma pan temporário de 1 dedo)
//   - 2 dedos = pinch (zoom) + pan do centro + twist (ângulo entre dedos, quando suportado)
//   - Safari/macOS: usa gesturechange (scale/rotation); Chrome/Edge/Firefox: pinch via Ctrl+wheel
// ============================
function wireUnifiedInput(){
  const cvs = getCanvas();
  // Só focar no ponteiro se o zoom realmente mudar o radius
  function willZoomApply(scale){
    const r = Number(State.radius) || 20;
    const rMin = (window.DOGE?.ZOOM_MIN ?? 4);
    const rMax = (window.DOGE?.ZOOM_MAX ?? 400);
    const target = Math.min(rMax, Math.max(rMin, r * scale));
    return Math.abs(target - r) > 1e-3;
  }

  if (!cvs) return;

  const dbg = (tag, o) => { if (window.DOGE?.debugZoom) console.debug(tag, o||''); };

  // ───────────────────────────────────────────────────────────────
  // 1) BLOQUEIO GLOBAL do page zoom apenas sobre o canvas
  // ───────────────────────────────────────────────────────────────
  (function installGlobalPinchBlock(el){
    const inCanvasByPoint = (ev) => {
      if (typeof ev.clientX !== 'number' || typeof ev.clientY !== 'number') return false;
      const r = el.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right &&
             ev.clientY >= r.top  && ev.clientY <= r.bottom;
    };

    const onWheelCapture = (ev) => {
      // pinch do touchpad (Chromium/Firefox) sinaliza ctrl/meta — só usamos para BLOQUEAR page-zoom
      if ((ev.ctrlKey || ev.metaKey) && inCanvasByPoint(ev)) {
        ev.preventDefault();
      }
    };

    const onGestureCapture = (ev) => { // Safari/macOS
      if (inCanvasByPoint(ev)) ev.preventDefault();
    };

    document.addEventListener('wheel',         onWheelCapture,    { passive:false, capture:true });
    document.addEventListener('gesturestart',  onGestureCapture,  { passive:false, capture:true });
    document.addEventListener('gesturechange', onGestureCapture,  { passive:false, capture:true });
  })(cvs);

  // ───────────────────────────────────────────────────────────────
  // 2) Gestos "legacy" do Safari/macOS (escala/rotação expostas)
  // ───────────────────────────────────────────────────────────────
  let _gPrevScale = 1;
  let _gPrevRotationDeg = 0;

  cvs.addEventListener('gesturestart',  (e) => {
    if (inputLocked()) return;
    _gPrevScale = (typeof e.scale === 'number' && e.scale > 0) ? e.scale : 1;
    _gPrevRotationDeg = (typeof e.rotation === 'number') ? e.rotation : 0;
    e.preventDefault();
  }, { passive:false });

  cvs.addEventListener('gesturechange', (e) => {
    if (inputLocked()) return;

    if (typeof e.scale === 'number' && e.scale > 0) {
      let factor = e.scale / (_gPrevScale || 1);
      factor = Math.max(0.8, Math.min(1.25, factor));
      dbg('[DOGE:zoom][gesturechange]', {factor});
      zoomDelta({ scale: factor }, /*isPinch=*/true);
      _gPrevScale = e.scale;
    }
    if (typeof e.rotation === 'number') {
      const dDeg = e.rotation - _gPrevRotationDeg;
      if (Math.abs(dDeg) > 0.05) {
        const dRad = -(dDeg * Math.PI / 180);
        orbitTwist(dRad);
        _gPrevRotationDeg = e.rotation;
      }
    }
    e.preventDefault();
  }, { passive:false });

  cvs.addEventListener('gestureend', (e) => {
    if (inputLocked()) return;
    _gPrevScale = 1;
    _gPrevRotationDeg = 0;
    e.preventDefault();
  }, { passive:false });

  // ───────────────────────────────────────────────────────────────
  // 3) PAN LATCH (duplo-clique / double-tap)
  // ───────────────────────────────────────────────────────────────
  let panLatchUntil = 0;
  let touchPanArmedUntil = 0;
  const PAN_LATCH_MS = 650;

  cvs.addEventListener('dblclick', (e) => {
    if (inputLocked()) return;
    panLatchUntil = performance.now() + PAN_LATCH_MS;
    e.preventDefault();
  }, { passive:false });

  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_MAX_D = 22;

  cvs.addEventListener('touchstart', (e) => {
    if (inputLocked()) return;
    if (e.touches.length !== 1) return;
    const t = performance.now();
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    const dt = t - lastTapTime;
    const dx = x - lastTapX, dy = y - lastTapY;
    if (dt < DOUBLE_TAP_MS && Math.hypot(dx, dy) < DOUBLE_TAP_MAX_D) {
      touchPanArmedUntil = t + PAN_LATCH_MS;
      e.preventDefault();
    }
    lastTapTime = t; lastTapX = x; lastTapY = y;
  }, { passive:false });

  const isPanLatchActive = () => performance.now() < panLatchUntil;
  const isTouchPanArmed = () => performance.now() < touchPanArmedUntil;

  // ───────────────────────────────────────────────────────────────
  // 4) Pointer unificado (mouse/touch)
  // ───────────────────────────────────────────────────────────────
  const pointers = new Map();
  let pinchPrevDist = 0;
  let pinchPrevMid  = null;
  let pinchPrevAng  = 0;

  const TWIST_SENS_MOUSE = 0.012;

  if (!window.DOGE) window.DOGE = {};
  window.DOGE.__inputDbg = { pointers, captures:new Set(), cntDown:0, cntUp:0, cntLost:0, cntWheel:0, cntGesture:0 };

  const setModeForPointer = (pe, activeCount) => {
    if (pe.pointerType === 'mouse') {
      if (pe.button === 0 && isPanLatchActive()) return 'pan';
      if (pe.button === 1) return 'pan';
      if (pe.button === 2) return 'twist';
      if (pe.button === 0 && __ctrlPressed) return 'pan';
      return 'orbit';
    }
    if (activeCount >= 2) return 'gesture2';
    if (isTouchPanArmed()) return 'pan';
    return 'orbit';
  };

  const arrPts = () => [...pointers.values()];
  const getMidpoint = () => {
    const a = arrPts(); if (a.length < 2) return null;
    return { x:(a[0].x+a[1].x)*0.5, y:(a[0].y+a[1].y)*0.5 };
  };
  const getDistance = () => {
    const a = arrPts(); if (a.length < 2) return 0;
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  };
  const getAngle = () => {
    const a = arrPts(); if (a.length < 2) return 0;
    const dx = a[1].x - a[0].x, dy = a[1].y - a[0].y;
    return Math.atan2(dy, dx);
  };

  cvs.addEventListener('pointerdown', (e)=>{
    if (!isModalOpen() && window.DOGE && window.DOGE.inputLocked) {
      window.DOGE.inputLocked = false;
      const pe = getComputedStyle(cvs).pointerEvents;
      if (pe !== 'auto') cvs.style.pointerEvents = 'auto';
    }
    if (inputLocked()) return;
    if (getComputedStyle(cvs).pointerEvents !== 'auto') cvs.style.pointerEvents = 'auto';

    window.DOGE.__inputDbg.cntDown++;
    cvs.setPointerCapture?.(e.pointerId);
    window.DOGE.__inputDbg.captures.add(e.pointerId);

    pointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY,
      button: e.button, ptype: e.pointerType,
      mode: setModeForPointer(e, pointers.size + 1)
    });

    if (pointers.size === 2){
      pinchPrevDist = getDistance();
      pinchPrevMid  = getMidpoint();
      pinchPrevAng  = getAngle();
    }
    e.preventDefault();
  }, { passive:false });

  cvs.addEventListener('pointermove', (e)=>{
    if (inputLocked()) return;
    if (!pointers.has(e.pointerId)) return;

    const p = pointers.get(e.pointerId);
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;

    const count = pointers.size;

    if (count === 1){
      const dx = p.x - px, dy = p.y - py;
      switch (p.mode) {
        case 'pan':   panDelta(dx, dy); break;
        case 'twist': orbitTwist(dx * TWIST_SENS_MOUSE); break;
        default:      orbitDelta(dx, dy, p.ptype !== 'mouse');
      }
    } else if (count === 2){
      // === CORREÇÃO: calcule 'mid' ANTES de usá-lo ===
      const mid  = getMidpoint();

      // pinch zoom (tela) — comportamento antigo (sem foco no ponteiro)
      const dist = getDistance();
      if (pinchPrevDist > 0 && dist > 0){
        let scale = dist / pinchPrevDist;
        const exponent = 0.85;
        scale = Math.pow(scale, exponent);
        scale = Math.max(0.8, Math.min(1.25, scale));
        zoomDelta({ scale }, true); // <<< sem focusNDC no mobile
      }
      pinchPrevDist = dist;

      // pan do centro (usa 'mid' agora corretamente definido)
      if (pinchPrevMid && mid){
        const mdx = mid.x - pinchPrevMid.x;
        const mdy = mid.y - pinchPrevMid.y;
        if (mdx || mdy) panDelta(mdx, mdy);
      }
      pinchPrevMid  = mid;

      // twist 2 dedos
      const ang = getAngle();
      let dAng = ang - pinchPrevAng;
      if (dAng >  Math.PI) dAng -= 2*Math.PI;
      if (dAng < -Math.PI) dAng += 2*Math.PI;
      if (Math.abs(dAng) > 1e-4) orbitTwist(-dAng);
      pinchPrevAng = ang;
    }

    e.preventDefault();
  }, { passive:false });

  const clearPointer = (e)=>{
    window.DOGE.__inputDbg.cntUp++;
    window.DOGE.__inputDbg.captures.delete(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2){
      pinchPrevDist = 0;
      pinchPrevMid  = null;
      pinchPrevAng  = 0;
    }
  };
  cvs.addEventListener('pointerup', clearPointer,        { passive:true });
  cvs.addEventListener('pointercancel', clearPointer,    { passive:true });
  cvs.addEventListener('lostpointercapture', (e)=>{
    window.DOGE.__inputDbg.cntLost++;
    window.DOGE.__inputDbg.captures.delete(e.pointerId);
    clearPointer(e);
  }, { passive:true });

  // ——— helpers para decidir se o zoom muda o raio e em que direção
  const ZOOM_MIN = 4, ZOOM_MAX = 400;
  const EPS = 1e-4;
  function nextRadiusIf(scale){
    const r0 = Number(State.radius) || 20;
    const r1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r0 * scale));
    return { r0, r1, delta: r1 - r0 };
  }
  function shouldFocusPointer(scale){
    const { r0, r1, delta } = nextRadiusIf(scale);
    if (Math.abs(delta) < EPS) return false;
    if (r0 <= ZOOM_MIN + 1e-3 && r1 <= r0) return false;
    if (r0 >= ZOOM_MAX - 1e-3 && r1 >= r0) return false;
    return true;
  }

  // ───────────────────────────────────────────────────────────────
  // 5) Wheel (mouse/trackpad) = zoom com foco no ponteiro (mantido)
  // ───────────────────────────────────────────────────────────────
  cvs.addEventListener('wheel', (e) => {
    if (inputLocked()) return;

    e.preventDefault();
    e.stopPropagation();

    const unit = (e.deltaMode === 1) ? 33 : (e.deltaMode === 2) ? 120 : 1;
    const dy   = e.deltaY * unit;

    // Pinch do touchpad (Chromium/Firefox sinalizam ctrl/meta):
    // invertido para: afastar dedos => zoom IN (mantém seu ajuste)
    const isTrackpadPinch = (e.ctrlKey || e.metaKey);
    const k = isTrackpadPinch ? +0.008 : -0.008;
    let scale = Math.exp(dy * k);
    scale = Math.max(0.75, Math.min(1.35, scale));

    // NDC do ponteiro
    const r = cvs.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top)  / r.height;
    const ndc = { x: x * 2 - 1, y: -(y * 2 - 1) };

    // Foco no ponteiro é aplicado dentro do zoomDelta (suave/sem drift)
    zoomDelta({ scale, focusNDC: ndc }, /*isPinch=*/isTrackpadPinch);
  }, { passive:false });

  // Necessário para twist com right-drag
  cvs.addEventListener('contextmenu', e => e.preventDefault(), { passive:false });
}

