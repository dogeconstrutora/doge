// ============================
// Picking (raycast), Hover (tooltip) e Seleção
// ============================
import * as THREE from 'three';
import { State } from './state.js';
import { showTip, hideTip } from './utils.js';
import { pickFVSColor } from './colors.js';
import { camera, renderer, render } from './scene.js'; // <-- render adicionado
import { getPickTargets, stepX, stepZ, setGroupHighlight, getTorre } from './geometry.js';
import { openAptModal } from './modal.js';

let raycaster = null;
let mouse = null;

// Resolver injetável: recebe o NOME cru do layout -> row | null
let getRowForApt = null;
export function setRowResolver(fn){
  getRowForApt = (typeof fn === 'function') ? fn : null;
}

// ---------- helpers ----------
function isNCRow(row){
  const nc = Number(row?.qtd_nao_conformidades_ultima_inspecao ?? row?.nao_conformidades ?? 0) || 0;
  return nc > 0;
}

// =========== init ===========
export function initPicking(){
  if (!renderer) throw new Error('[picking] renderer não inicializado');
  if (raycaster) return; // já iniciado

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  const dom = renderer.domElement;

  // Hover (tooltip)
  dom.addEventListener('pointermove', onPointerMove, { passive: true });
  dom.addEventListener('pointerleave', onPointerLeave, { passive: true });

  // Clique robusto (evita “ghost click” e drag)
  dom.addEventListener('pointerdown', onPointerDown, { passive: true });
  dom.addEventListener('pointerup',   onPointerUp,   { passive: true });
}

// ---------- estado de clique ----------
let downX = 0, downY = 0, downTS = 0;
let dragging = false;

const CLICK_MOVE_TOL = 6;   // px
const CLICK_TIME_MAX = 450; // ms

function onPointerDown(e){
  downX = e.clientX; downY = e.clientY; downTS = performance.now();
  dragging = false;
}

function onPointerUp(e){
  const dt = performance.now() - downTS;
  const dx = Math.abs(e.clientX - downX);
  const dy = Math.abs(e.clientY - downY);
  const moved = (dx > CLICK_MOVE_TOL || dy > CLICK_MOVE_TOL);
  if (!moved && dt <= CLICK_TIME_MAX){
    onPointerClick(e);
  }
}

// ========== handlers ==========
function onPointerLeave(){
  // sai do canvas → some tooltip e hover, mas mantém seleção
  hideTip(0);
  const changed = applyHover(null);
  if (changed) render(); // <-- garante redraw quando hover some
}

function onPointerClick(e){
  // Em 2D, o click abre modal pelos cards — não pelo 3D
  if (State.flatten2D >= 0.95) { hideTip(0); return; }

  const g = pickAtClientXY(e.clientX, e.clientY);
  if (!g) {
    // clicou fora → limpa seleção e hover
    hideTip(0);
    const changedHover = applyHover(null);
    const changedSel   = applySelect(null);
    if (changedHover || changedSel) render();
    return;
  }

  // info cru do layout
  const nome = String(g.userData?.nome ?? '').trim();
  const pav  = String(g.userData?.pavimento_origem ?? g.userData?.levelIndex ?? '');

  const row  = getRowForApt ? (getRowForApt(nome) || null) : null;

  // NC MODE: só pode clicar se tiver NC>0
  if (State.NC_MODE && !isNCRow(row)) {
    hideTip(0);
    return;
  }

  // Seleciona (borda branca persistente). Limpa seleção anterior automaticamente.
  const changedSel = applySelect(g);
  if (changedSel) render();

  // Abre modal
  const hex  = pickFVSColor(nome, pav, State.COLOR_MAP);
  openAptModal({ id: nome, floor: pav, row, tintHex: hex });
}

let lastHoverTS = 0;
const HOVER_THROTTLE_MS = 40;

function onPointerMove(e){
  if (State.flatten2D >= 0.95) { hideTip(0); return; }
  const now = performance.now();
  if (now - lastHoverTS < HOVER_THROTTLE_MS) return;
  lastHoverTS = now;

  const g = pickAtClientXY(e.clientX, e.clientY, /*forHover=*/true);
  if (!g) {
    hideTip(60);
    const changed = applyHover(null);
    if (changed) render();
    return;
  }

  const nome = String(g.userData?.nome ?? '').trim();
  if (State.NC_MODE){
    const row = getRowForApt ? (getRowForApt(nome) || null) : null;
    if (!isNCRow(row)) {
      hideTip(60);
      const changed = applyHover(null);
      if (changed) render();
      return;
    }
  }

  showTip(e.clientX, e.clientY, nome || 'apt');
  const changed = applyHover(g);
  if (changed) render();
}

// ========== núcleo de raycast ==========
export function pickAtClientXY(clientX, clientY, _forHover=false){
  const targets = getPickTargets();
  const faces = targets.faces || [];
  const edges = targets.edges || [];
  if (!faces.length && !edges.length) return null;

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // 1) Faces
  let inter = faces.length ? raycaster.intersectObjects(faces, false) : [];

  // 2) Fallback: edges com threshold
  if (!inter.length && edges.length){
    raycaster.params.Line = raycaster.params.Line || {};
    raycaster.params.Line.threshold = Math.max(stepX, stepZ) * 0.06;
    inter = raycaster.intersectObjects(edges, false);
  }

  if (!inter.length) return null;

  // Pega a primeira interseção cujo group seja realmente "pickable"
  for (const hit of inter){
    let g = hit.object?.parent || null;
    // sobe até achar o group do apto (caso tenha aninhamentos)
    while (g && !g.userData?.mesh && g.parent) g = g.parent;
    if (isPickableGroup(g)) return g;
  }

  return null;
}


// ========== HOVER/SELEÇÃO (somente bordas) ==========
// Retorna true se mudou algo visualmente (para sabermos se devemos renderizar)
// Retorna true se mudou algo visualmente (para sabermos se devemos renderizar)
function applyHover(g){
  // se 2D estiver ativo, não mostra hover
  if (State.flatten2D >= 0.95) g = null;

  const sel = State.__SEL_GROUP__ || null;
  const prev = State.__HOVER_GROUP__ || null;

  // Se nada para hover: limpa todos os hovers que não são seleção
  if (!g){
    const torre = getTorre?.();
    if (torre){
      for (const child of torre.children){
        if (child !== sel){
          setGroupHighlight(child, 'none');
        }
      }
    } else if (prev && prev !== sel){
      setGroupHighlight(prev, 'none');
    }
    State.__HOVER_GROUP__ = null;
    return true;
  }

  // Se o hover não mudou, nada a fazer
  if (prev === g) return false;

  // Limpa hover anterior (se não for a seleção)
  if (prev && prev !== sel){
    setGroupHighlight(prev, 'none');
  }

  // Garante que mais ninguém (além da seleção) permaneça em hover
  const torre = getTorre?.();
  if (torre){
    for (const child of torre.children){
      if (child !== g && child !== sel){
        setGroupHighlight(child, 'none');
      }
    }
  }

  // Aplica hover no atual (prioridade menor que seleção)
  if (g !== sel){
    setGroupHighlight(g, 'hover');
  }

  State.__HOVER_GROUP__ = g;
  return true;
}

function isPickableGroup(g){
  if (!g || !g.userData) return false;

  // group precisa estar visível
  if (g.visible === false) return false;

  // se geometry colocou uma flag ao ocultar por pavimento
  if (g.userData.__hiddenForFloor) return false;

  // precisa ter mesh e edges e ambos visíveis
  const mesh  = g.userData.mesh;
  const edges = g.userData.edges;

  if (!mesh || mesh.visible === false) return false;
  if (!edges || edges.visible === false) return false;

  // se a face ficou praticamente transparente, não considera clicável
  const mat = mesh.material;
  if (mat && mat.transparent && (Number(mat.opacity) || 0) < 0.05) return false;

  return true;
}

// Retorna true se mudou algo visualmente
function applySelect(g){
  const prev = State.__SEL_GROUP__;
  if (prev === g) return false;

  if (prev && prev !== g){
    // limpa seleção anterior
    setGroupHighlight(prev, 'none');
  }

  if (g){
    setGroupHighlight(g, 'selected');
  }

  State.__SEL_GROUP__ = g;

  // ao selecionar, o hover atual deixa de ter efeito visual se for o mesmo group
  if (State.__HOVER_GROUP__ && State.__HOVER_GROUP__ === g){
    // garantimos prioridade visual de "selected"
    setGroupHighlight(State.__HOVER_GROUP__, 'selected');
  }
  return true;
}

// ========== APIs públicas auxiliares ==========
export function selectGroup(g){
  const changed = applySelect(g || null);
  if (changed) render();
}

export function syncSelectedColor(){
  // mantém só a cor do material do mesh; borda continua controlada pelo highlight
  const g = State.__SEL_GROUP__;
  if (!g) return;
  const nome = String(g.userData?.nome ?? '').trim();
  const pav  = String(g.userData?.pavimento_origem ?? g.userData?.levelIndex ?? '');
  const hex  = pickFVSColor(nome, pav, State.COLOR_MAP);
  const m = g.userData?.mesh?.material;
  if (m && hex){
    m.color.set(hex);
    m.needsUpdate = true;
  }
}
// Limpa qualquer destaque (hover/seleção) e força um redraw
export function clear3DHighlight(){
  const changedHover = applyHover(null);
  const changedSel   = applySelect(null);
  if (changedHover || changedSel) render();
}