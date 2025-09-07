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
  INITIAL_PHI
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


// ============================
// Boot
// ============================
(async function boot(){
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


// ...

// No final do boot(), depois do primeiro render():
render();

// === Fit inicial adiado (garante viewport/HUD estabilizados) ===
(function fitInitialView(){
  // 1º frame: deixa layout/CSS assentarem
  requestAnimationFrame(()=>{
    // força um recálculo de aspect se algo mudou
    window.dispatchEvent(new Event('resize'));

    // 2º frame: faz o fit-to-bbox já com aspect correto
    requestAnimationFrame(()=>{
      recenterCamera({
        // sem bbox: ele computa a BBox atual da torre
        theta: INITIAL_THETA,    // 90° anti-horário (a “frente” que você pediu)
        phi:   INITIAL_PHI,      // inclinação padrão (~63°)
        margin: 1.20,            // pode ajustar se quiser mais “respiro”
        animate: false
      });
      render();
    });
  });
})();


// Enquadra 100% e coloca “de frente”
recenterCamera({ bbox, theta: INITIAL_THETA, phi: INITIAL_PHI, animate: false, margin: 1.18 });

  // 4) Ajuste inicial — mesmo enquadramento usado no recenter
  if (bbox && bbox.isBox3){
    recenterCamera({ bbox, verticalOffsetRatio: 0.12 });
  } else {
    applyOrbitToCamera();
  }

  // 5) HUD (dropdowns, botões, sliders)
  initHUD();

  // 6) Aplica FVS/NC — injeta resolvers e COLOR_MAP
  applyFVSAndRefresh();

  // 7) Overlay 2D (render já com resolvers prontos)
  initOverlay2D();
  render2DCards();

  // 8) Picking (hover + click) no 3D
  initPicking();

  // 9) Loading off
  loading?.classList.add('hidden');

  // 10) Render inicial
  render();

  // 11) Reaplica o offset vertical no resize mantendo enquadramento
  window.addEventListener('resize', ()=> {
    const torre = getTorre();
    if (!torre) return;
    const bb = new THREE.Box3().setFromObject(torre);
    if (!bb || !bb.isBox3) return;
    recenterCamera({ bbox: bb, verticalOffsetRatio: 0.12 });
  }, { passive:true });

  // 12) Input unificado (mouse + touch) – suave no mobile
  wireUnifiedInput();
})().catch(err=>{
  console.error('[viewer] erro no boot:', err);
});


// ============================
// Selecionar também o grupo 3D ao clicar num card 2D
// (o overlay já abre o modal; aqui apenas sincronizamos a seleção 3D)
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
  // Aqui só garantimos que não há seleção/zoom do navegador
  cvs.addEventListener('gesturestart', e => e.preventDefault?.(), { passive:false });
  cvs.addEventListener('gesturechange', e => e.preventDefault?.(), { passive:false });
  cvs.addEventListener('gestureend', e => e.preventDefault?.(), { passive:false });

  // Estado de ponteiros
  const pointers = new Map(); // id -> {x,y,button,ptype,mode}
  let pinchPrevDist = 0;
  let pinchPrevMid  = null;

  const setModeForPointer = (pe) => {
    // mouse: button 2 = pan; caso contrário orbit
    if (pe.pointerType === 'mouse'){
      return (pe.button === 2) ? 'pan' : 'orbit';
    }
    // touch: 1 dedo -> orbit (pan fica para gesto de 2 dedos)
    return 'orbit';
  };

  const getMidpoint = () => {
    const arr = [...pointers.values()];
    if (arr.length < 2) return null;
    return {
      x: (arr[0].x + arr[1].x) * 0.5,
      y: (arr[0].y + arr[1].y) * 0.5
    };
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
    // Captura o ponteiro para evitar "pulos" ao sair da área
    cvs.setPointerCapture?.(e.pointerId);

    pointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY,
      button: e.button,
      ptype: e.pointerType,
      mode: setModeForPointer(e)
    });

    // Se virou pinch (2 dedos), inicializa estado
    if (pointers.size === 2){
      pinchPrevDist = getDistance();
      pinchPrevMid  = getMidpoint();
    }

    // Evita texto/scroll do navegador
    e.preventDefault();
  }, { passive:false });

  // Pointer Move
  cvs.addEventListener('pointermove', (e)=>{
    if (!pointers.has(e.pointerId)) return;

    const p = pointers.get(e.pointerId);
    const prevX = p.x, prevY = p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (pointers.size === 1){
      // 1 ponteiro: ORBIT ou PAN
      const dx = p.x - prevX;
      const dy = p.y - prevY;

      if (p.mode === 'pan'){
        panDelta(dx, dy);
      } else {
        // ORBIT – usa sensibilidade mobile igual à do 2D
        orbitDelta(dx, dy, p.ptype !== 'mouse');
      }
    } else if (pointers.size === 2){
      // 2 ponteiros: PINCH + PAN pelo centro
      const dist = getDistance();
      const mid  = getMidpoint();

      if (pinchPrevDist > 0){
        const dScale = dist - pinchPrevDist;
        if (Math.abs(dScale) > 0.5){
          // aproximação suave: sinal do delta
          zoomDelta(-Math.sign(dScale)); // gesto padrão: afastar dedos -> zoom out
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

  // Se o modal estiver aberto, deixamos o handler do modal agir.
  const modalBackdrop = document.getElementById('doge-modal-backdrop');
  const modalOpen = modalBackdrop && modalBackdrop.classList.contains('show');
  if (modalOpen) return;

  // Se 2D estiver ativo, desliga

});
