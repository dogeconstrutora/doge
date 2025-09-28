// ============================
// Entry do Viewer DOGE
// ============================
import * as THREE from 'three';
import { initTooltip } from './utils.js';
import { State } from './state.js';
import { loadAllData, layoutData } from './data.js';
import {
  initScene,
  applyOrbitToCamera,
  render,
  resetRotation,
  syncOrbitTargetToModel,
  camera,
  scene,
  renderer,
  disableAutoFit        // desativa auto-fit interno do scene (timer)
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
// Long-press → isolar/desfazer pavimento (evento p/ HUD)
// ============================

// Sobe na hierarquia procurando um índice de pavimento
function findLevelIndexOn(obj){
  let cur = obj;
  while (cur){
    const li =
      cur.userData?.levelIndex ??
      cur.userData?.nivelIndex ??
      cur.userData?.nivel ??
      cur.userData?.level;
    if (Number.isFinite(li)) return Math.max(0, Math.floor(Number(li)));
    cur = cur.parent;
  }
  return null;
}

// Raycast no ponto (clientX,clientY) → { object, levelIdx }
// Escolhe o pavimento pela posição Y do hit (pega o “de baixo”).
function pickObjectAtClientXY(clientX, clientY){
  const cvs = getCanvas();
  if (!cvs || !camera || !scene) return null;

  const r = cvs.getBoundingClientRect();
  const x = ((clientX - r.left) / r.width)  * 2 - 1;
  const y = -(((clientY - r.top)  / r.height) * 2 - 1);

  const ray = new THREE.Raycaster();
  ray.setFromCamera({ x, y }, camera);

  const root = (typeof getTorre === 'function' && getTorre()) || scene;
  const hits = ray.intersectObject(root, true);
  if (!hits || !hits.length) return null;

  const iso = (window.DOGE && Number.isFinite(window.DOGE.__isoFloor)) ? window.DOGE.__isoFloor : null;
  const EPS = 0.01; // folga de 1 cm no eixo Y

  // helper para centerY
  const centerY = (obj) => {
    try {
      const bb = new THREE.Box3().setFromObject(obj);
      return (bb.min.y + bb.max.y) * 0.5;
    } catch { return null; }
  };

  // Constrói candidatos visíveis, com levelIdx e centerY
  const candidates = [];
  for (const h of hits){
    const obj = h.object;
    if (!obj) continue;

    // Ignora invisíveis (reforço)
    let visOK = true, p = obj;
    while (p && visOK){ if (p.visible === false) visOK = false; p = p.parent; }
    if (!visOK) continue;

    const li = findLevelIndexOn(obj);
    if (!Number.isFinite(li)) continue; // só consideramos quem tem nível definido

    if (iso != null && li !== iso) continue; // respeita isolamento

    const cy = centerY(obj);
    if (!Number.isFinite(cy)) continue;

    candidates.push({ obj, li, hitY: h.point?.y ?? cy, cy });
  }

  if (!candidates.length) return null;

  // Preferência: maior centerY que seja <= hitY+EPS (o “piso de baixo”)
  let best = null, bestBelow = -Infinity, bestAbove = Infinity;
  for (const c of candidates){
    if (c.cy <= c.hitY + EPS){
      if (c.cy > bestBelow){ bestBelow = c.cy; best = c; }
    } else {
      // fallback: guarda o mais próximo acima caso não haja “de baixo”
      if (c.cy < bestAbove){ bestAbove = c.cy; if (!Number.isFinite(bestBelow)) best = c; }
    }
  }

  return best ? { object: best.obj, levelIdx: best.li } : null;
}


// Define listeners de long-press no canvas e dispara o evento para o HUD
function wireLongPressIsolateFloor(){
  const cvs = getCanvas();
  if (!cvs) return;

  let downId = null;
  let downXY = { x:0, y:0 };
  let timer  = null;
  let moved  = false;

  // rastreia toques ativos para detectar gesto de 2+ dedos
  const touchIds = new Set();

  const HOLD_MS = 450;      // tempo do toque-e-segure
  const CANCEL_DIST = 12;   // px: se mover mais que isso, cancela

  const clear = () => { if (timer){ clearTimeout(timer); } timer=null; downId=null; moved=false; };

  const cancelIfMultiTouch = () => {
    if (touchIds.size >= 2) {  // pinch/pan a dois dedos: cancela long-press
      if (timer){ clearTimeout(timer); timer=null; }
      downId = null;
      moved = false;
    }
  };

  cvs.addEventListener('pointerdown', (e)=>{
    if (inputLocked()) return;

    // mouse: só botão esquerdo; touch: ok
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // registra toques ativos
    if (e.pointerType === 'touch') {
      touchIds.add(e.pointerId);
      // se já tem mais de um toque, NÃO arma long-press
      if (touchIds.size >= 2) { cancelIfMultiTouch(); return; }
    }

    // a partir daqui, garantido que é 1 dedo ou mouse
    downId = e.pointerId;
    downXY = { x: e.clientX, y: e.clientY };
    moved  = false;

    // arma o long-press (apenas 1 dedo/mouse)
    timer = setTimeout(()=>{
      if (moved || (e && e.pointerType === 'touch' && touchIds?.size >= 2)) { clear(); return; }

      const hit = pickObjectAtClientXY(downXY.x, downXY.y);
      const levelIdx = hit?.levelIdx;

      if (Number.isFinite(levelIdx)){
        (window.DOGE ||= {}).__userInteracted = true;
        window.dispatchEvent(new CustomEvent('doge:isolate-floor', {
          detail: { levelIdx, source: 'longpress' }
        }));
      }
      clear();
    }, HOLD_MS);
  }, { passive:true });

  cvs.addEventListener('pointermove', (e)=>{
    // se virou multi-touch, cancela
    if (e.pointerType === 'touch' && touchIds.size >= 2) { cancelIfMultiTouch(); return; }

    if (downId == null || e.pointerId !== downId) return;
    const dx = (e.clientX ?? 0) - downXY.x;
    const dy = (e.clientY ?? 0) - downXY.y;
    if (Math.hypot(dx, dy) > CANCEL_DIST) moved = true;
  }, { passive:true });

  const endLike = (e)=>{
    if (e.pointerType === 'touch') touchIds.delete(e.pointerId);
    if (e.pointerId === downId) clear();
  };
  ['pointerup','pointercancel','lostpointercapture','pointerout','pointerleave'].forEach(type=>{
    cvs.addEventListener(type, endLike, { passive:true });
  });

  // failsafe extra: se por algum motivo um segundo dedo tocar depois (dentro do canvas),
  // o pointerdown acima já cancela; se tocar fora do canvas, normalmente não chega aqui.
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

    // Namespace/flags globais leves
    window.DOGE ||= {};
    window.DOGE.__userInteracted = false; // cena marca true no primeiro input

    // Inicializa cena (scene.js já liga o input unificado internamente)
    initScene();

    // IMPORTANTE: desliga qualquer auto-fit interno (timer) do scene
    disableAutoFit?.();

    // Constrói a torre/andares a partir do layout
    buildFromLayout(layoutData || { meta: {}, placements: [] });

    render();

    // Fit inicial “guardado” (mesma Home do Reset) com watchdog simples anti-corte
    (function fitInitialView(){
      requestAnimationFrame(()=>{
        // garante aspect correto após CSS/layout
        window.dispatchEvent(new Event('resize'));

        requestAnimationFrame(()=>{
          // Faz UM único fit e salva como Home
          syncOrbitTargetToModel({ saveAsHome: true, animate: false });
          resetRotation(); // deixa “em pé”
          render();

          // --- Watchdog 1.2s: apenas evita "corte de topo"
          //     e DESLIGA ao primeiro input do usuário
          const T_GUARD = 1200;
          const t0 = performance.now();

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

            // se já houve QUALQUER interação do usuário, encerra o guard
            if (window.DOGE?.__userInteracted) return;

            // só corrige se o topo cortar (nada de "drift" no alvo/raio)
            const scr = worldTopToScreen();
            const cutTop = scr && scr.y < 0;
            if (cutTop) {
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

    // HUD + aplicação de FVS
    initHUD();
    applyFVSAndRefresh();

    // Overlay 2D e cartões
    initOverlay2D();
    render2DCards();

    // Picking/seleção 3D
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

    // Ativa o toque-e-segure para isolar/desfazer pavimento
    wireLongPressIsolateFloor();

    // (Sem outros handlers de input aqui — tudo vive em scene.js)
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
// ============================
// ESC desfaz isolamento (se houver) ou fecha 2D (se ativo e sem modal)
// ============================
window.addEventListener('keydown', (e)=>{
  if (e.key !== 'Escape') return;

  // Se houver isolamento de pavimento ativo → desfaz primeiro
  const iso = (window.DOGE && Number.isFinite(window.DOGE.__isoFloor)) ? window.DOGE.__isoFloor : null;
  if (iso != null){
    // dispara o mesmo evento usado no toggle do HUD para "desfazer"
    window.dispatchEvent(new CustomEvent('doge:isolate-floor', {
      detail: { levelIdx: iso, source: 'esc' }
    }));
    return;
  }

  // Caso contrário, mantém comportamento de fechar 2D (se não houver modal)
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
