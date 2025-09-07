// ============================
// Geometria / Torre 3D (surface mesh por NOME, igual ao viewer)
// ============================

import { State } from './state.js';
import { scene, syncOrbitTargetToModel} from './scene.js';
import { pickFVSColor } from './colors.js';

// Grupo raiz (exportado)
export let torre = null;

// Passos e gap (exportados)
export let stepX = 1.0;
export let stepZ = 1.0;
export let stepY = 1.0; // mantém para compat; com profile variável, vira “média”/referência
export let gap   = 0.0;

// ===== Ponte 3D→2D: levelIndex por nome completo =====
let _nameToLevelIndex = new Map();

/** Registra levelIndex do grupo pelo nome completo (ex.: "Torre - Pavimento 25 - Apartamento 2501 - Sala") */
export function registerNameLevelIndex(fullName, levelIndex){
  const nm = String(fullName || '').trim();
  if (!nm) return;
  const idx = Number(levelIndex);
  if (!Number.isFinite(idx)) return;
  // guarda o menor índice visto para esse nome (segurança)
  const prev = _nameToLevelIndex.get(nm);
  if (prev == null || idx < prev) _nameToLevelIndex.set(nm, idx);
}

/** Lê o levelIndex pelo nome completo (retorna null se não houver) */
export function getLevelIndexForName(fullName){
  const nm = String(fullName || '').trim();
  if (!nm) return null;
  const v = _nameToLevelIndex.get(nm);
  return (v == null) ? null : Number(v);
}

/** Limpa o cache (chamar antes de reconstruir a torre) */
export function resetNameLevelIndexMap(){
  _nameToLevelIndex = new Map();
}

// Alvos para picking
let faceTargets = [];
let edgeTargets = [];

// Opacidade atual das faces
let faceOpacity = 1.0;

// ====== Profile de alturas por pavimento (opcional) ======
let _floorsProfile = null; // array de fatores (ex.: [1,1,0.8,1.2,...]) ou null

// Limite de pavimento (levelIndex) e o máximo detectado
let _maxLevelIndex = 0;
export function getMaxLevelIndex(){ return _maxLevelIndex; }


/** Mostra apenas aptos com levelIndex <= limit (null/undefined => todos) */
export function applyFloorLimit(limit){
  if (!torre) return;
  const hasLimit = Number.isFinite(limit);
  torre.children.forEach(g=>{
    if (!g?.userData) return;
    const li = Number(g.userData.levelIndex||0);
    g.visible = !hasLimit || (li <= limit);
  });
}

// ===== Visibilidade por pavimento =====
export function getMaxLevel(){
  if (!torre) return 0;
  let mx = 0;
  for (const g of torre.children){
    const lv = Number(g.userData?.levelIndex ?? 0) || 0;
    if (lv > mx) mx = lv;
  }
  return mx;
}

/** Mostra apenas um pavimento (oculta anteriores e posteriores). */
export function showOnlyFloor(levelIndex){
  if (!torre) return;
  const tgt = Number(levelIndex) || 0;
  for (const g of torre.children){
    const lv = Number(g.userData?.levelIndex ?? 0) || 0;
    g.visible = (lv === tgt);
  }
}

/** Restaura todos os pavimentos visíveis. */
export function showAllFloors(){
  if (!torre) return;
  for (const g of torre.children){
    g.visible = true;
  }
}


function _getFloorScale(gy){
  if (!_floorsProfile || !Array.isArray(_floorsProfile)) return 1;
  const v = _floorsProfile[gy];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Retorna uma função yOf(level) que dá a cota acumulada até o início do "level"
// Considera: yOf(0) = 0; yOf(k+1) = yOf(k) + (floorH * scale(k)) + gap
function _makeYOf(occSet, floorH){
  // memoização por level
  const memo = new Map();
  memo.set(0, 0);

  // tenta inferir um “máximo” de nível para acelerar (opcional)
  let maxLevel = 0;
  if (occSet && occSet.size){
    for (const key of occSet){
      const parts = key.split(',');
      const gy = parseInt(parts[1], 10);
      if (gy > maxLevel) maxLevel = gy;
    }
  }

  // pré-computar prefixo até maxLevel+1
  for (let k = 0; k <= maxLevel + 1; k++){
    if (!memo.has(k)){
      const yk = memo.get(k - 1) + (floorH * _getFloorScale(k - 1)) + gap;
      memo.set(k, yk);
    }
  }

  return function yOf(level){
    if (level <= 0) return 0;
    if (memo.has(level)) return memo.get(level);
    // extrapola além do maxLevel conhecido
    const yprev = yOf(level - 1);
    const yk = yprev + (floorH * _getFloorScale(level - 1)) + gap;
    memo.set(level, yk);
    return yk;
  };
}

// ===== Helpers do meshing (iguais ao viewer) =====

// Voxeliza todos os placements agrupando por nome
function voxelizeByNome(layout, cellW, cellD, floorH){
  const by = new Map(); // nome -> Set("x,y,z")
  for (const p of (layout?.placements || [])){
    // 🔒 TRAVADO: só vale p.nome (sem fallback)
    const nome = String(p?.nome ?? '').trim();
    if (!nome){
      console.warn('[geometry] placement ignorado por falta de "nome":', p);
      continue;
    }
    if (!by.has(nome)) by.set(nome, new Set());
    const occ = by.get(nome);

    const baseY = Number.isFinite(p.andar) ? Number(p.andar) : Number(p.floor) || 0;
    const nx = Number(p.x)||0, nz = Number(p.z)||0, nw = Number(p.w)||1, nd = Number(p.d)||1, nh = Number(p.h)||1;

    for (let gx = nx; gx < nx + nw; gx++){
      for (let gz = nz; gz < nz + nd; gz++){
        for (let gy = baseY; gy < baseY + nh; gy++){
          occ.add(`${gx},${gy},${gz}`);
        }
      }
    }
  }
  return by;
}

// Gera apenas a superfície externa do conjunto de voxels
function buildSurfaceGeometryFromOcc(occSet, cellW, cellD, floorH){
  if (!occSet || occSet.size===0) return null;
  const has = (x,y,z)=> occSet.has(`${x},${y},${z}`);

  // função Y dinâmica por pavimento:
  const yOf = _makeYOf(occSet, floorH);

  const pos = [];
  const idx = [];
  let vbase = 0;

  const pushQuad = (a,b,c,d)=>{
    pos.push(...a, ...b, ...c, ...d);
    idx.push(vbase, vbase+1, vbase+2, vbase, vbase+2, vbase+3);
    vbase += 4;
  };

  const xStep = stepX, zStep = stepZ; // y é variável via yOf
  function bounds(gx,gy,gz){
    const x0 = gx * xStep, x1 = x0 + cellW;
    const z0 = gz * zStep, z1 = z0 + cellD;
    const y0 = yOf(gy);
    const y1 = yOf(gy + 1);
    return {x0,x1,y0,y1,z0,z1};
  }

  for (const key of occSet){
    const [gx,gy,gz] = key.split(',').map(Number);
    const {x0,x1,y0,y1,z0,z1} = bounds(gx,gy,gz);

    if (!has(gx-1,gy,gz)) pushQuad([x0,y0,z1],[x0,y0,z0],[x0,y1,z0],[x0,y1,z1]); // -X
    if (!has(gx+1,gy,gz)) pushQuad([x1,y0,z0],[x1,y0,z1],[x1,y1,z1],[x1,y1,z0]); // +X
    if (!has(gx,gy,gz-1)) pushQuad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]); // -Z
    if (!has(gx,gy,gz+1)) pushQuad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]); // +Z
    if (!has(gx,gy-1,gz)) pushQuad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]); // -Y
    if (!has(gx,gy+1,gz)) pushQuad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]); // +Y
  }

  if (!pos.length) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pos), 3));
  geom.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(idx), 1));
  geom.computeVertexNormals();
  geom.computeBoundingBox(); geom.computeBoundingSphere();
  return geom;
}

// Infla ligeiramente para desenhar edges sem “costuras”
function inflateGeometry(geom, offset=0.01){
  const g = geom.clone();
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  for (let i=0;i<pos.count;i++){
    pos.setXYZ(i,
      pos.getX(i) + nor.getX(i)*offset,
      pos.getY(i) + nor.getY(i)*offset,
      pos.getZ(i) + nor.getZ(i)*offset
    );
  }
  pos.needsUpdate = true;
  return g;
}

// ===== materiais de linha (cada objeto com o seu; nada compartilhado)
const DEFAULT_LINE_OPACITY = 0.6; // discreto
const DEFAULT_LINE_COLOR   = 0x21252d;
function makeLineMat(opacity = DEFAULT_LINE_OPACITY, color = DEFAULT_LINE_COLOR){
  return new THREE.LineBasicMaterial({
    color,
    linewidth: 1,         // (nota: a maioria dos desktops ignora >1)
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity
  });
}

// ============================
// Build a partir do layout
// ============================
export function buildFromLayout(layout){
  // limpa torre anterior
  if (torre && scene){
    scene.remove(torre);
    torre.traverse(o=>{
      if (o.geometry) o.geometry.dispose?.();
      if (o.material){
        if (Array.isArray(o.material)) o.material.forEach(m=>m.dispose?.());
        else o.material.dispose?.();
      }
    });
  }

  // 🔴 (1) RESETA o cache nome→levelIndex para a nova construção
  resetNameLevelIndexMap();

  torre = new THREE.Group();
  torre.name = 'Torre';
  faceTargets = [];
  edgeTargets = [];

  // meta (mesma semântica do viewer)
  const meta = layout?.meta || {};
  const cellW   = Number(meta.cellW  ?? 1.2) || 1.2;
  const cellD   = Number(meta.cellD  ?? 1.2) || 1.2;
  const floorH  = Number(meta.floorH ?? 0.5) || 0.5;  // altura base do pavimento (= fator 1)
  gap           = Number(meta.gap    ?? 0.15) || 0.0;

  // profile de alturas por pavimento:
  // tenta primeiro em layout.floors (top-level), depois meta.floors
  const prof = Array.isArray(layout?.floors) ? layout.floors
              : (Array.isArray(meta?.floors) ? meta.floors : null);
  _floorsProfile = prof ? [...prof] : null;

  stepX = cellW + gap;
  stepZ = cellD + gap;

  // stepY “de referência” (usado só para compat em outros módulos)
  // como agora pode variar, mantemos o equivalente ao “padrão” (fator 1)
  stepY = floorH + gap;

  // 🔎 índice de placements por nome (para debug no clique)
  const rawByNome = new Map();
  for (const p of (layout?.placements || [])){
    const nome = String(p?.nome ?? '').trim(); // travado em 'nome'
    if (!nome) continue;
    if (!rawByNome.has(nome)) rawByNome.set(nome, []);
    rawByNome.get(nome).push(p);
  }

  // voxeliza por nome (travado)
  const occByNome = voxelizeByNome(layout, cellW, cellD, floorH);

  for (const [nome, occ] of occByNome.entries()){
    const surface = buildSurfaceGeometryFromOcc(occ, cellW, cellD, floorH);
    if (!surface) continue;

    // face (com polygonOffset para não brigar com edges)
    const faceMat = new THREE.MeshStandardMaterial({
      color: 0x6e7681,
      metalness: 0.05,
      roughness: 0.9,
      side: THREE.DoubleSide,
      transparent: faceOpacity < 0.999,
      opacity: Math.min(1, faceOpacity),
      depthWrite: faceOpacity >= 0.999,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    });
    const mesh = new THREE.Mesh(surface, faceMat);
    mesh.renderOrder = 1;

    // edges sobre geometria inflada
    const inflated = inflateGeometry(surface, 0.01);
    const matNormal    = makeLineMat();
    const matHighlight = makeLineMat(0.9, 0xffffff);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(inflated, 1), matNormal);
    edges.renderOrder = 2;

    // levelIndex = menor gy ocupado (para explode Y estável)
    let minLevel = Infinity;
    for (const key of occ){
      const gy = parseInt(key.split(',')[1], 10);
      if (gy < minLevel) minLevel = gy;
    }
    if (!Number.isFinite(minLevel)) minLevel = 0;

    // 🔴 (2) REGISTRA nome→levelIndex para o 2D ordenar igual ao 3D
    registerNameLevelIndex(nome, minLevel);

    // grupo do apto
    const g = new THREE.Group();
    g.name = nome || 'apt';
    g.add(mesh); g.add(edges);

    // centro local -> anchor
    surface.computeBoundingBox();
    const localCenter = new THREE.Vector3();
    surface.boundingBox.getCenter(localCenter);

    g.userData = {
      nome,                      // 🔒 chave canônica para tudo
      mesh,
      edges,
      matNormal,
      matHighlight,
      levelIndex: minLevel,
      basePos: new THREE.Vector3(0,0,0),
      anchor:  new THREE.Vector3(0,0,0),

      // 🧩 payload do layout-3d.json para este apto (para debug via console no clique)
      layout: {
        meta: layout?.meta ?? null,           // meta do arquivo
        placements: rawByNome.get(nome) || [] // todos os blocos que compõem o apto
      },

      meta: { id: String(nome), name: String(nome) }
    };
    g.__localCenter = localCenter;

    torre.add(g);

    // picking
    faceTargets.push(mesh);
    edgeTargets.push(edges);
  }

  // centraliza torre no origin (como no viewer)
  const bbox = new THREE.Box3().setFromObject(torre);
  const center = new THREE.Vector3(); bbox.getCenter(center);

  for (const g of torre.children){
    g.position.sub(center);
    g.userData.basePos.copy(g.position);

    const lc = g.__localCenter || new THREE.Vector3();
    g.userData.anchor.set(
      g.position.x + lc.x,
      g.position.y + lc.y,
      g.position.z + lc.z
    );
    delete g.__localCenter;
  }

  // encosta no solo (y=0)
  const bbox2 = new THREE.Box3().setFromObject(torre);
  if (Number.isFinite(bbox2.min.y)){
    const dy = bbox2.min.y;
    for (const g of torre.children){
      g.position.y -= dy;
      g.userData.basePos.y -= dy;
      g.userData.anchor.y  -= dy;
    }
  }

  // Detecta o maior levelIndex para configurar o slider de pavimentos
  _maxLevelIndex = 0;
  for (const g of torre.children){
    const li = Number(g?.userData?.levelIndex || 0);
    if (li > _maxLevelIndex) _maxLevelIndex = li;
  }

  scene.add(torre); 

  syncOrbitTargetToModel({ root: torre, animate: true });
  // aplica estado inicial (100% opaco)
  State.faceOpacity = 1;
  setFaceOpacity(1, true);
  applyExplode();
// avisa o mundo que o 3D foi montado e o mapa nome→levelIndex está pronto
try {
  window.dispatchEvent(new CustomEvent('layout-3d-built'));
} catch (_) {}
  return { bbox: bbox2, center };
}


// ============================
// 2D visual — sem clarear linhas (só opacidade)
// ============================
export function apply2DVisual(on, edgeOpacity = 0.85){
  if (!torre) return;

  // faces totalmente transparentes no 2D; ao sair, volta ao valor atual do State
  if (on){
    setFaceOpacity(0, true);
  }else{
    setFaceOpacity(State.faceOpacity ?? 1, true);
  }

  // linhas: mantêm a mesma cor; apenas opacidade varia
  const targetLineOpacity = on ? edgeOpacity : DEFAULT_LINE_OPACITY;
  setLinesOpacity(targetLineOpacity);

  // Ao sair do 2D, restaurar as cores por FVS
  if (!on){
    recolorMeshes3D();
  }
}

// ============================
// Opacidade de faces (exata)
// ============================
export function setFaceOpacity(v, forceExact = true){
  faceOpacity = Math.max(0, Math.min(1, Number(v) || 0));
  if (!torre) return;

  const eff = faceOpacity; // sem mistura com flatten2D

  const isOpaque = eff >= 0.999;
  torre.traverse(n=>{
    if (!n.isMesh || !n.material) return;
    n.material.opacity = eff;
    if (isOpaque){
      n.material.transparent = false;
      n.material.depthWrite  = true;
    } else {
      n.material.transparent = true;
      n.material.depthWrite  = false;
    }
    n.material.needsUpdate = true;
  });
}

// ============================
// Opacidade das linhas (exportada p/ controle fino do grid 2D)
// ============================
export function setLinesOpacity(op = DEFAULT_LINE_OPACITY){
  const v = Math.max(0, Math.min(1, Number(op)||0));
  torre?.traverse(n=>{
    if (!(n.isLine || n.isLineSegments) || !n.material) return;
    n.material.opacity     = v;
    n.material.transparent = v < 1;
    n.material.depthWrite  = !n.material.transparent;
    n.material.needsUpdate = true;
  });
}

// ============================
// Recolor (cores herdadas da FVS)
// ============================
export function recolorMeshes3D(){
  if (!torre) return;
  const cmap = State.COLOR_MAP;
  torre.children.forEach(g=>{
    const nome = g.userData?.nome || '';
    const pav  = g.userData?.levelIndex ?? 0;
    const hex  = pickFVSColor(nome, pav, cmap);
    const m = g.userData?.mesh?.material;
    if (m && hex){
      m.color.set(hex);
      m.needsUpdate = true;
    }
  });
}

// ============================
// Explode (não decompõe mesclas)
// ============================
export function applyExplode(){
  if (!torre) return;
  const ex = Number(State.explodeXY || 0);
  const ey = Number(State.explodeY  || 0);

  // zero → volta exatamente à base
  if ((!ex || Math.abs(ex) < 1e-6) && (!ey || Math.abs(ey) < 1e-6)){
    for (const g of torre.children) g.position.copy(g.userData.basePos);
    return;
  }

  // centroide das âncoras para direção radial
  let sx=0, sz=0, n=0;
  for (const g of torre.children){
    const a = g.userData.anchor || g.userData.basePos;
    sx += a.x; sz += a.z; n++;
  }
  const cx = n ? sx/n : 0;
  const cz = n ? sz/n : 0;

  const step = Math.max(stepX, stepZ) || 1;

  for (const g of torre.children){
    const base = g.userData.basePos;
    const pos  = base.clone();

    if (ex){
      const a = g.userData.anchor || base;
      const dir = new THREE.Vector3(a.x - cx, 0, a.z - cz);
      const len = dir.length();
      if (len > 1e-6){
        dir.multiplyScalar(1/len);
        pos.addScaledVector(dir, ex * step);
      }
    }

    if (ey){
      pos.y += (g.userData.levelIndex || 0) * ey;
    }

    g.position.copy(pos);
  }
}

// ============================
// Picking
// ============================
export function getPickTargets(){
  return { faces: faceTargets.slice(), edges: edgeTargets.slice() };
}

export function getTorre(){
  return torre;
}

// =============== HIGHLIGHT HELPERS (hover/selected) ===============
export function ensureEdgeMats(group, THREERef) {
  const THREE = THREERef || window.THREE;
  if (!group || !group.userData || !group.userData.edges) return;

  if (!group.userData.__edgeMatBase) {
    group.userData.__edgeMatBase = new THREE.LineBasicMaterial({
      color: 0xcad7ff,
      linewidth: 1,
      transparent: true,
      opacity: 0.95,
      depthWrite: false
    });
  }
  if (!group.userData.__edgeMatHover) {
    group.userData.__edgeMatHover = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 2,
      transparent: true,
      opacity: 1.0,
      depthWrite: false
    });
  }
  if (!group.userData.__edgeMatSelected) {
    group.userData.__edgeMatSelected = new THREE.LineBasicMaterial({
      color: 0xffc107,
      linewidth: 2,
      transparent: true,
      opacity: 1.0,
      depthWrite: false
    });
  }

  if (!group.userData.edges.material) {
    group.userData.edges.material = group.userData.__edgeMatBase;
  }
}

/**
 * Aplica realce nas bordas do group.
 * mode: 'none' | 'hover' | 'selected'
 */
/**
 * Aplica realce nas bordas e também nas FACES (via emissive).
 * mode: 'none' | 'hover' | 'selected'
 */
export function setGroupHighlight(group, mode = 'none', THREERef) {
  if (!group || !group.userData) return;

  const edges = group.userData.edges;
  const mesh  = group.userData.mesh;
  if (!edges || !mesh || !mesh.material) return;

  // ——— bordas (como já estava) ———
  ensureEdgeMats(group, THREERef);
  let targetMat = group.userData.__edgeMatBase;
  switch (mode) {
    case 'hover':    targetMat = group.userData.__edgeMatHover;    break;
    case 'selected': targetMat = group.userData.__edgeMatSelected; break;
    case 'none':
    default:         targetMat = group.userData.__edgeMatBase;     break;
  }
  if (edges.material !== targetMat) {
    edges.material = targetMat;
    edges.material.needsUpdate = true;
  }

  // ——— faces: snapshot do estado base uma única vez ———
  const m = mesh.material; // MeshStandardMaterial
  if (!group.userData.__faceBase) {
    group.userData.__faceBase = {
      emissive: (m.emissive ? m.emissive.clone() : null),
      emissiveIntensity: (typeof m.emissiveIntensity === 'number') ? m.emissiveIntensity : 0,
      opacity: m.opacity,
      transparent: m.transparent
    };
  }
  const base = group.userData.__faceBase;

  // ——— aplica o efeito no volume inteiro ———
  if (mode === 'hover') {
    if (m.emissive) m.emissive.set(0xffffff);
    if (typeof m.emissiveIntensity === 'number') m.emissiveIntensity = 0.1; // brilho sutil
    // se estiver translúcido, dá um leve ganho p/ “subir” o volume no hover
    if (m.opacity < 1 && typeof base.opacity === 'number') {
      m.opacity = Math.min(1, base.opacity + 0.10);
      m.transparent = m.opacity < 1;
    }
    m.needsUpdate = true;

  } else if (mode === 'selected') {
    if (m.emissive) m.emissive.set(0xffffff);
    if (typeof m.emissiveIntensity === 'number') m.emissiveIntensity = 0.5;  // mais forte que hover
    if (m.opacity < 1 && typeof base.opacity === 'number') {
      m.opacity = Math.min(1, base.opacity + 0.15);
      m.transparent = m.opacity < 1;
    }
    m.needsUpdate = true;

  } else { // 'none' → restaura exatamente o estado base
    if (base.emissive && m.emissive) m.emissive.copy(base.emissive);
    if (typeof base.emissiveIntensity === 'number') m.emissiveIntensity = base.emissiveIntensity;
    if (typeof base.opacity === 'number') {
      m.opacity = base.opacity;
      m.transparent = base.transparent;
    }
    m.needsUpdate = true;
  }
}

