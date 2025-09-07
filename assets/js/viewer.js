// ============================
// Entry do Viewer DOGE (FINAL + pan pós-duplo-clique / double-tap)
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
  orbitTwist,           // roll (twist)
  disableAutoFit        // desativa auto-fit interno do scene
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
// Boot
// ============================
(async function boot(){
  try {
    initTooltip();
    initModal();

    const loading = document.getElementById('doge-loading');
    loading?.classList.remove('hidden');

    // 1) Dados
    await loadAllData();

    // 2) Cena
    initScene();

    // 2.1) Desliga qualquer auto-fit interno do scene (evita “coice”)
    disableAutoFit?.();

    // 3) Montagem do modelo
    buildFromLayout(layoutData || { meta: {}, placements: [] });

    // 4) Primeiro render
    render();

    // 5) Fit inicial = mesma Home do Reset (sem corte no topo)
    (function fitInitialView(){
      requestAnimationFrame(()=>{
        window.dispatchEvent(new Event('resize'));
        requestAnimationFrame(()=>{
          syncOrbitTargetToModel({ saveAsHome: true, animate: false });
          resetRotation();
          render();
        });
      });
    })();

    // 6) HUD e FVS
    initHUD();
    applyFVSAndRefresh();

    // 7) Overlay 2D
    initOverlay2D();
    render2DCards();

    // 8) Picking
    initPicking();

    // 9) Loading off + render
    loading?.classList.add('hidden');
    render();

    // 10) Resize: re-aplica órbita (sem refazer fit)
    let lastW = window.innerWidth, lastH = window.innerHeight;
    window.addEventListener('resize', () => {
      if (window.innerWidth !== lastW || window.innerHeight !== lastH) {
        lastW = window.innerWidth; lastH = window.innerHeight;
        applyOrbitToCamera();
        render();
      }
    }, { passive: true });

    // 11) Input
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
  const backdrop = document.getElementById('doge-modal-backdrop');
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
// Tracking da tecla Space (Space + esquerdo = Pan)
// ============================
let __spacePressed = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { __spacePressed = true; e.preventDefault(); }
}, { passive:false });
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') __spacePressed = false;
}, { passive:true });

// ============================
// Input unificado (Pointer Events)
// PC/Notebook (mouse):
//   - Pan: botão do meio OU Space + botão esquerdo
//   - Orbit (yaw/pitch): botão esquerdo
//   - Twist (roll): botão direito
//   - Zoom: scroll da rodinha
// Touch (smartphone/tablet/notebook com touchscreen):
//   - 1 dedo = orbit (salvo pan com double-tap; ver abaixo)
//   - 2 dedos = pinch (zoom) + pan do centro + twist (ângulo entre dedos)
//
// EXTRA: Pan por arrasto após duplo-clique (mouse) / double-tap (touch)
//        → arma “pan de arrasto” por um curto período.
// ============================
function wireUnifiedInput(){
  const cvs = document.getElementById('doge-canvas') || document.querySelector('#app canvas');
  if (!cvs) return;

  // Bloqueia gestos nativos (iOS)
  cvs.addEventListener('gesturestart',  e => e.preventDefault?.(), { passive:false });
  cvs.addEventListener('gesturechange', e => e.preventDefault?.(), { passive:false });
  cvs.addEventListener('gestureend',    e => e.preventDefault?.(), { passive:false });

  const pointers = new Map(); // id -> {x,y,button,ptype,mode}
  let pinchPrevDist = 0;
  let pinchPrevMid  = null;
  let pinchPrevAng  = 0; // ângulo entre dedos no frame anterior

  // sensibilidade do twist com botão direito (mouse)
  const TWIST_SENS_MOUSE = 0.012; // ajuste aqui se quiser mais/menos sensível

  // ---------- PAN LATCH (duplo-clique / double-tap) ----------
  let panLatchUntil = 0;          // mouse: tempo limite p/ arrasto virar pan
  let touchPanArmedUntil = 0;     // touch: idem (após double-tap)
  const PAN_LATCH_MS = 650;

  // mouse dblclick -> arma panLatch
  cvs.addEventListener('dblclick', (e) => {
    panLatchUntil = performance.now() + PAN_LATCH_MS;
    // impede seleção/zoom native
    e.preventDefault();
  }, { passive:false });

  // touch double-tap detection
  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_MAX_D = 22; // px

  cvs.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return; // só considera 1 dedo p/ double-tap
    const t = performance.now();
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    const dt = t - lastTapTime;
    const dx = x - lastTapX, dy = y - lastTapY;
    if (dt < DOUBLE_TAP_MS && Math.hypot(dx, dy) < DOUBLE_TAP_MAX_D) {
      // DOUBLE-TAP: arma pan de 1 dedo por curto período
      touchPanArmedUntil = t + PAN_LATCH_MS;
      e.preventDefault();
    }
    lastTapTime = t; lastTapX = x; lastTapY = y;
  }, { passive:false });

  const isPanLatchActive = () => performance.now() < panLatchUntil;
  const isTouchPanArmed = () => performance.now() < touchPanArmedUntil;

  const setModeForPointer = (pe, activePointersCount) => {
    // Mouse
    if (pe.pointerType === 'mouse') {
      // Pan “por latch” (duplo-clique recente) tem prioridade para botão esquerdo
      if (pe.button === 0 && isPanLatchActive()) return 'pan';
      if (pe.button === 1) return 'pan';                   // botão do meio
      if (pe.button === 2) return 'twist';                 // botão direito
      if (pe.button === 0 && __spacePressed) return 'pan'; // Space + esquerdo
      return 'orbit';                                      // esquerdo
    }

    // Touch
    // 2 dedos: o bloco de gesto lida (pinch, pan do centro e twist)
    if (activePointersCount >= 2) return 'gesture2';
    // 1 dedo: se armed por double-tap recente → pan; senão orbit
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
    const dx = a[1].x - a[0].x;
    const dy = a[1].y - a[0].y;
    return Math.atan2(dy, dx); // rad
  };

  // Pointer Down
  cvs.addEventListener('pointerdown', (e)=>{
    cvs.setPointerCapture?.(e.pointerId);

    pointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY,
      button: e.button, ptype: e.pointerType,
      mode: setModeForPointer(e, pointers.size + 1)
    });

    // Se acabamos de armar panLatch via dblclick, e o usuário já clicou/segurou,
    // o mode acima virá como 'pan' (botão esquerdo).

    if (pointers.size === 2){
      pinchPrevDist = getDistance();
      pinchPrevMid  = getMidpoint();
      pinchPrevAng  = getAngle();
    }

    e.preventDefault();
  }, { passive:false });

  // Pointer Move
  cvs.addEventListener('pointermove', (e)=>{
    if (!pointers.has(e.pointerId)) return;

    const p = pointers.get(e.pointerId);
    const px = p.x, py = p.y;
    p.x = e.clientX; p.y = e.clientY;

    const count = pointers.size;

    if (count === 1){
      const dx = p.x - px, dy = p.y - py;

      switch (p.mode) {
        case 'pan':
          panDelta(dx, dy);
          break;
        case 'twist':
          // botão direito: roll em torno do eixo de visão
          orbitTwist(dx * TWIST_SENS_MOUSE);
          break;
        default: // 'orbit'
          orbitDelta(dx, dy, p.ptype !== 'mouse'); // yaw/pitch (sem roll)
      }

    } else if (count === 2){
      // === PINCH (zoom), PAN do centro e TWIST (ângulo entre dedos) ===
      const dist = getDistance();
      if (pinchPrevDist > 0 && dist > 0){
        let scale = dist / pinchPrevDist;
        const exponent = 0.85;
        scale = Math.pow(scale, exponent);
        scale = Math.max(0.8, Math.min(1.25, scale));
        zoomDelta({ scale }, true);
      }
      pinchPrevDist = dist;

      const mid  = getMidpoint();
      if (pinchPrevMid && mid){
        const mdx = mid.x - pinchPrevMid.x;
        const mdy = mid.y - pinchPrevMid.y;
        if (mdx || mdy) panDelta(mdx, mdy);
      }
      pinchPrevMid  = mid;

      const ang = getAngle();
      let dAng = ang - pinchPrevAng;
      if (dAng >  Math.PI) dAng -= 2*Math.PI;
      if (dAng < -Math.PI) dAng += 2*Math.PI;
      if (Math.abs(dAng) > 1e-4) {
        // Se preferir o sentido oposto no seu device, troque o sinal
        orbitTwist(-dAng);
      }
      pinchPrevAng = ang;
    }

    e.preventDefault();
  }, { passive:false });

  // Pointer Up/Cancel
  const clearPointer = (e)=>{
    pointers.delete(e.pointerId);
    if (pointers.size < 2){
      pinchPrevDist = 0;
      pinchPrevMid  = null;
      pinchPrevAng  = 0;
    }
  };
  cvs.addEventListener('pointerup', clearPointer,        { passive:true });
  cvs.addEventListener('pointercancel', clearPointer,    { passive:true });
  cvs.addEventListener('lostpointercapture', clearPointer,{ passive:true });

  // Wheel = zoom (desktop/trackpad)
  cvs.addEventListener('wheel', (e)=>{
    e.preventDefault();
    const unit = (e.deltaMode === 1) ? 33 : (e.deltaMode === 2) ? 120 : 1;
    const dy   = e.deltaY * unit;
    let scale = Math.exp(dy * 0.0011);
    scale = Math.max(0.8, Math.min(1.25, scale));
    zoomDelta({ scale }, /*isPinch=*/false);
  }, { passive:false });

  // Bloqueia menu do botão direito (necessário p/ twist com right-drag)
  cvs.addEventListener('contextmenu', e => e.preventDefault(), { passive:false });
}
