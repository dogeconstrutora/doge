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
// Debug helpers (não alteram estado do viewer)
// ============================
(function ensureDOGE(){
  if (!window.DOGE) window.DOGE = {};
})();
function getCanvas(){
  return document.getElementById('doge-canvas') || document.querySelector('#app canvas');
}
function dbgGetBackdrop(){
  return document.getElementById('doge-modal-backdrop') || null;
}
function snap(label, extra = {}){
  try{
    const cvs = getCanvas();
    const bd  = dbgGetBackdrop();
    const peInline = cvs?.style?.pointerEvents || '(none-inline)';
    const peComputed = cvs ? getComputedStyle(cvs).pointerEvents : '(no-canvas)';
    const active = document.activeElement;
    const actStr = active ? `${active.tagName.toLowerCase()}#${active.id||''}.${(active.className||'').toString().split(' ').slice(0,2).join('.')}` : '(null)';
    const dbg = window.DOGE?.__inputDbg || {};
    const capIds = Array.from(dbg.captures || []);
    const payload = {
      label,
      time: `${Math.round(performance.now())}ms`,
      backdrop: bd ? {
        ariaHidden: bd.getAttribute('aria-hidden'),
        hasShowClass: bd.classList.contains('show')
      } : '(no-backdrop)',
      canvas: {
        inlinePointerEvents: peInline,
        computedPointerEvents: peComputed
      },
      activeElement: actStr,
      pointersSize: dbg.pointers?.size ?? '(n/a)',
      counters: {
        pointerdown: dbg.cntDown|0,
        pointerup: dbg.cntUp|0,
        lostcapture: dbg.cntLost|0,
        wheel: dbg.cntWheel|0,
        gesture: dbg.cntGesture|0
      },
      captures: capIds,
      state: {
        orbitTarget: { x: +State.orbitTarget?.x?.toFixed?.(3) || 0, y: +State.orbitTarget?.y?.toFixed?.(3) || 0, z: +State.orbitTarget?.z?.toFixed?.(3) || 0 },
        radius: +(+State.radius || 0).toFixed(3),
        theta: +(+State.theta || 0).toFixed(3),
        phi: +(+State.phi || 0).toFixed(3)
      },
      camera: camera ? {
        pos: { x:+camera.position.x.toFixed(3), y:+camera.position.y.toFixed(3), z:+camera.position.z.toFixed(3) },
        up:  { x:+camera.up.x.toFixed(3), y:+camera.up.y.toFixed(3), z:+camera.up.z.toFixed(3) }
      } : '(no-camera)',
      ...extra
    };
    console.log('[DOGE:snap]', payload);
  }catch(err){
    console.warn('[DOGE:snap:error]', err);
  }
}
window.DOGE.snap = snap;

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
              console.warn('[DOGE:guard] reajustando fit (cutTop/drift detectado)', {
                cutTop, driftTarget, scr, orbitTarget: {...State.orbitTarget}, radius: State.radius
              });
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

    // ======= LOG: diagnóstico ao cancelar/fechar modal (sem alterar estado) =======
    (function wireModalDiagnostics(){
      const backdrop = document.getElementById('doge-modal-backdrop');
      const cancelBtn = document.getElementById('doge-modal-close');

      // Log em clique do botão Cancelar (fase de captura, antes de handlers do modal)
      if (cancelBtn){
        cancelBtn.addEventListener('click', (e)=>{
          snap('modal:cancel:click(capture)', { target: '#doge-modal-close' });
          setTimeout(()=>snap('modal:cancel:+16ms'), 16);
          requestAnimationFrame(()=>snap('modal:cancel:rAF'));
          setTimeout(()=>snap('modal:cancel:+250ms'), 250);
          setTimeout(()=>snap('modal:cancel:+1000ms'), 1000);
        }, true);
      }

      // Log em clique no backdrop (fechar ao clicar fora)
      if (backdrop){
        backdrop.addEventListener('click', (e)=>{
          if (e.target === backdrop){
            snap('modal:backdrop:click(capture)', { target: '#doge-modal-backdrop' });
            setTimeout(()=>snap('modal:backdrop:+16ms'), 16);
            requestAnimationFrame(()=>snap('modal:backdrop:rAF'));
            setTimeout(()=>snap('modal:backdrop:+250ms'), 250);
            setTimeout(()=>snap('modal:backdrop:+1000ms'), 1000);
          }
        }, true);

        // MutationObserver só para logar transições de aria-hidden
        const mo = new MutationObserver(()=>{
          const hidden = backdrop.getAttribute('aria-hidden');
          const hasShow = backdrop.classList.contains('show');
          snap('modal:backdrop:mut', { ariaHidden: hidden, hasShow });
        });
        mo.observe(backdrop, { attributes: true, attributeFilter: ['aria-hidden', 'class'] });
      }

      // ESC (caso feche por teclado)
      window.addEventListener('keydown', (e)=>{
        if (e.key === 'Escape'){
          snap('modal:esc:keydown');
          setTimeout(()=>snap('modal:esc:+16ms'), 16);
          requestAnimationFrame(()=>snap('modal:esc:rAF'));
          setTimeout(()=>snap('modal:esc:+250ms'), 250);
        }
      }, true);
    })();

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
  const cvs = document.getElementById('doge-canvas') || document.querySelector('#app canvas');
  if (!cvs) return;

  // ---------- Gestos "legacy" do Safari/macOS (escala/rotação expostas no DOM)
  let _gPrevScale = 1;
  let _gPrevRotationDeg = 0;

  cvs.addEventListener('gesturestart',  (e) => {
    _gPrevScale = (typeof e.scale === 'number' && e.scale > 0) ? e.scale : 1;
    _gPrevRotationDeg = (typeof e.rotation === 'number') ? e.rotation : 0;
    (window.DOGE.__inputDbg.cntGesture)++; // log
    e.preventDefault();
  }, { passive:false });

  cvs.addEventListener('gesturechange', (e) => {
    (window.DOGE.__inputDbg.cntGesture)++; // log
    // Pinch (zoom)
    if (typeof e.scale === 'number' && e.scale > 0) {
      let factor = e.scale / (_gPrevScale || 1);
      factor = Math.max(0.8, Math.min(1.25, factor));
      zoomDelta({ scale: factor }, /*isPinch=*/true);
      _gPrevScale = e.scale;
    }
    // Twist (rotação) — graus → rad
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

  cvs.addEventListener('gestureend',    (e) => {
    (window.DOGE.__inputDbg.cntGesture)++; // log
    _gPrevScale = 1;
    _gPrevRotationDeg = 0;
    e.preventDefault();
  }, { passive:false });

  // ---------- PAN LATCH (duplo-clique / double-tap) ----------
  let panLatchUntil = 0;          // mouse: tempo limite p/ arrasto virar pan
  let touchPanArmedUntil = 0;     // touch: idem (após double-tap)
  const PAN_LATCH_MS = 650;

  // Mouse: duplo-clique arma pan com botão esquerdo temporariamente
  cvs.addEventListener('dblclick', (e) => {
    panLatchUntil = performance.now() + PAN_LATCH_MS;
    e.preventDefault();
  }, { passive:false });

  // Touch: double-tap detection (para armar pan de 1 dedo)
  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_MAX_D = 22; // px

  cvs.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return; // apenas 1 dedo conta como tap
    const t = performance.now();
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    const dt = t - lastTapTime;
    const dx = x - lastTapX, dy = y - lastTapY;
    if (dt < DOUBLE_TAP_MS && Math.hypot(dx, dy) < DOUBLE_TAP_MAX_D) {
      // Double-tap: arma pan de 1 dedo por curto período
      touchPanArmedUntil = t + PAN_LATCH_MS;
      e.preventDefault();
    }
    lastTapTime = t; lastTapX = x; lastTapY = y;
  }, { passive:false });

  const isPanLatchActive = () => performance.now() < panLatchUntil;
  const isTouchPanArmed = () => performance.now() < touchPanArmedUntil;

  // ---------- Pointer Events unificados (mouse/touch)
  const pointers = new Map(); // id -> {x,y,button,ptype,mode}
  let pinchPrevDist = 0;
  let pinchPrevMid  = null;
  let pinchPrevAng  = 0; // ângulo entre dedos no frame anterior

  const TWIST_SENS_MOUSE = 0.012; // sensibilidade do twist no botão direito

  // ====== DEBUG: estado de input exposto para snapshots ======
  window.DOGE.__inputDbg = {
    pointers,
    captures: new Set(),
    cntDown: 0, cntUp: 0, cntLost: 0, cntWheel: 0, cntGesture: 0
  };

  const setModeForPointer = (pe, activePointersCount) => {
    if (pe.pointerType === 'mouse') {
      // Pan temporário por duplo-clique tem prioridade para o botão esquerdo
      if (pe.button === 0 && isPanLatchActive()) return 'pan';
      if (pe.button === 1) return 'pan';                   // botão do meio
      if (pe.button === 2) return 'twist';                 // botão direito
      if (pe.button === 0 && __spacePressed) return 'pan'; // Space + esquerdo
      return 'orbit';                                      // esquerdo
    }
    // Touch:
    if (activePointersCount >= 2) return 'gesture2';       // 2 dedos = bloco de gesto
    if (isTouchPanArmed()) return 'pan';                   // 1 dedo armado por double-tap
    return 'orbit';                                        // padrão 1 dedo
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
          // botão direito (mouse): roll em torno do eixo de visão
          orbitTwist(dx * TWIST_SENS_MOUSE);
          break;
        default: // 'orbit'
          orbitDelta(dx, dy, p.ptype !== 'mouse'); // yaw/pitch (sem roll)
      }

    } else if (count === 2){
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

      if (Math.abs(dAng) > 1e-4) {
        orbitTwist(-dAng); // troque o sinal se preferir o oposto no seu device
      }
      pinchPrevAng = ang;
    }

    e.preventDefault();
  }, { passive:false });

  // Pointer Up/Cancel
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

  // Wheel (desktop/trackpad) = zoom
  // - Trackpad pinch (Chrome/Edge/Firefox) chega como wheel com ctrlKey=true.
  cvs.addEventListener('wheel', (e)=>{
    window.DOGE.__inputDbg.cntWheel++;
    e.preventDefault();

    if (e.ctrlKey) {
      // Fallback para pinch do trackpad (Ctrl+wheel)
      const unit = (e.deltaMode === 1) ? 33 : (e.deltaMode === 2) ? 120 : 1;
      const dy   = e.deltaY * unit;
      let scale = Math.exp((-dy) * 0.0012);
      scale = Math.max(0.8, Math.min(1.25, scale));
      zoomDelta({ scale }, /*isPinch=*/true);
      return;
    }

    // Scroll normal → zoom por roda (mouse)
    const unit = (e.deltaMode === 1) ? 33 : (e.deltaMode === 2) ? 120 : 1;
    const dy   = e.deltaY * unit;
    let scale = Math.exp(dy * 0.0011);
    scale = Math.max(0.8, Math.min(1.25, scale));
    zoomDelta({ scale }, /*isPinch=*/false);
  }, { passive:false });

  // Bloqueia menu do botão direito (necessário para twist com right-drag)
  cvs.addEventListener('contextmenu', e => e.preventDefault(), { passive:false });
}
