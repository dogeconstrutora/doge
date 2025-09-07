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

          let logged = false;
          function guardTick(){
            const dt = performance.now() - t0;
            const scr = worldTopToScreen();
            const cutTop = scr && scr.y < 0;
            const driftTarget =
              Math.abs(State.orbitTarget.x - target0.x) > 1e-3 ||
              Math.abs(State.orbitTarget.y - target0.y) > 1e-3 ||
              Math.abs(State.orbitTarget.z - target0.z) > 1e-3 ||
              Math.abs(State.radius - radius0) > 1e-3;

            if ((cutTop || driftTarget) && !logged) {
              logged = true;
              console.warn('[DOGE:guard] reajustando fit (cutTop/drift detectado)', {
                cutTop, driftTarget, scr, orbitTarget: {...State.orbitTarget}, radius: State.radius
              });
            }

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
// PC:
//   - Pan: botão do meio OU Space + esquerdo
//   - Orbit (yaw/pitch): botão esquerdo
//   - Twist (roll): botão direito
//   - Zoom: scroll
// Touch:
//   - 1 dedo = orbit
//   - 2 dedos = pinch (zoom) + pan do centro + twist (ângulo entre dedos)
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

  const setModeForPointer = (pe) => {
    if (pe.pointerType === 'mouse') {
      if (pe.button === 1) return 'pan';                 // botão do meio
      if (pe.button === 2) return 'twist';               // botão direito
      if (pe.button === 0 && __spacePressed) return 'pan'; // Space + esquerdo
      return 'orbit';                                    // esquerdo
    }
    // touch 1 dedo = orbit
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
      mode: setModeForPointer(e)
    });
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

    if (pointers.size === 1){
      const dx = p.x - px, dy = p.y - py;

      switch (p.mode) {
        case 'pan':
          panDelta(dx, dy);
          break;
        case 'twist':
          // botão direito: roll em torno do eixo de visão
          // segue o movimento horizontal (troque o sinal se preferir o inverso)
          orbitTwist(dx * TWIST_SENS_MOUSE);
          break;
        default: // 'orbit'
          orbitDelta(dx, dy, p.ptype !== 'mouse'); // yaw/pitch (sem roll)
      }

    } else if (pointers.size === 2){
      // === PINCH (zoom) ===
      const dist = getDistance();
      if (pinchPrevDist > 0 && dist > 0){
        let scale = dist / pinchPrevDist;
        const exponent = 0.85;
        scale = Math.pow(scale, exponent);
        scale = Math.max(0.8, Math.min(1.25, scale));
        zoomDelta({ scale }, true);
      }
      pinchPrevDist = dist;

      // === PAN do centro ===
      const mid  = getMidpoint();
      if (pinchPrevMid && mid){
        const mdx = mid.x - pinchPrevMid.x;
        const mdy = mid.y - pinchPrevMid.y;
        if (mdx || mdy) panDelta(mdx, mdy);
      }
      pinchPrevMid  = mid;

      // === TWIST (roll) — rotação de dois dedos ===
      const ang = getAngle();
      let dAng = ang - pinchPrevAng;
      if (dAng >  Math.PI) dAng -= 2*Math.PI;
      if (dAng < -Math.PI) dAng += 2*Math.PI;

      // Se preferir o sentido oposto no seu device, troque para orbitTwist(-dAng)
      if (Math.abs(dAng) > 1e-4) {
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

  // Wheel (desktop/trackpad) = zoom
  cvs.addEventListener('wheel', (e)=>{
    e.preventDefault();
    const unit = (e.deltaMode === 1) ? 33 : (e.deltaMode === 2) ? 120 : 1;
    const dy   = e.deltaY * unit;
    let scale = Math.exp(dy * 0.0011);
    scale = Math.max(0.8, Math.min(1.25, scale));
    zoomDelta({ scale }, /*isPinch=*/false);
  }, { passive:false });

  // Bloqueia menu do botão direito (necessário para twist com right-drag)
  cvs.addEventListener('contextmenu', e => e.preventDefault(), { passive:false });
}
