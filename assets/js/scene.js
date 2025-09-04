// ============================
// Cena 3D / Câmera / Renderer
// ============================

import { State } from './state.js';
// import { clamp } from './utils.js'; // (não usado)
export let scene, renderer, camera;

// Alvo do orbit (reutiliza State.orbitTarget)
const ORBIT_MIN_PHI = 0.05;
const ORBIT_MAX_PHI = Math.PI - 0.05;
export const INITIAL_THETA = Math.PI / 2; // 90° anti-horário
export const INITIAL_PHI   = 1.1;  

// Sensibilidades (ajustadas p/ ficar "leve" no mobile e igual ao 2D)
const ROT_SPEED_DESKTOP = 0.003;   // antes 0.005
const ROT_SPEED_TOUCH   = 0.003;
const PAN_FACTOR        = 0.3;     // pan mais solto
const ZOOM_STEP_FACTOR  = 0.001;   // mantido

// Canvas host
function getAppEl(){
  const el = document.getElementById('app');
  if (!el) throw new Error('[scene] #app não encontrado');
  return el;
}

function ensureOrbitTargetVec3(){
  if (!State.orbitTarget || typeof State.orbitTarget.set !== 'function'){
    State.orbitTarget = new THREE.Vector3(0,0,0);
  }
  return State.orbitTarget;
}

export function initScene(){
  // Cena + câmera
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f141b);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 2000);
  camera.position.set(8, 8, 8);
  camera.up.set(0,1,0);

  // Luzes mínimas
  const amb = new THREE.AmbientLight(0xffffff, 0.75);
  scene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.65);
  dir.position.set(8, 12, 6);
  scene.add(dir);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // Canvas: desabilita gestos do navegador (pinch-zoom, duplo toque, etc.)
  const cvs = renderer.domElement;
  cvs.id = 'doge-canvas';
  Object.assign(cvs.style, {
    display: 'block',
    width: '100%',
    height: '100%',
    touchAction: 'none',
    WebkitTouchCallout: 'none',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    msTouchAction: 'none'
  });

  // Defaults seguros antes de qualquer uso
  ensureOrbitTargetVec3();
  if (!Number.isFinite(State.theta))  State.theta  = Math.PI * 0.25; // ~45°
  if (!Number.isFinite(State.phi))    State.phi    = Math.PI * 0.35; // inclinação
  if (!Number.isFinite(State.radius)) State.radius = 28;             // distância

  // Container
  const app = getAppEl();
  app.prepend(cvs); // canvas fica atrás do grid 2D

  // Redimensiona
  window.addEventListener('resize', onResize, { passive:true });
  onResize();

  // Primeira aplicação de câmera a partir do estado
  applyOrbitToCamera();

  return { scene, renderer, camera };
}

function onResize(){
  if (!renderer || !camera) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
}

// ----------------------------
// Câmera orbital (usa State.*)
// ----------------------------
export function applyOrbitToCamera(){
  ensureOrbitTargetVec3();

  const r  = Math.max(0.1, Number(State.radius) || 20);
  const th = Number.isFinite(State.theta) ? State.theta : 0;
  const ph = Math.max(ORBIT_MIN_PHI, Math.min(ORBIT_MAX_PHI, Number(State.phi) || 1.1));

  const target = State.orbitTarget;
  const x = target.x + r * Math.sin(ph) * Math.cos(th);
  const y = target.y + r * Math.cos(ph);
  const z = target.z + r * Math.sin(ph) * Math.sin(th);

  camera.position.set(x, y, z);
  camera.lookAt(target);
}

// ---- BBox atual da "Torre" (sem importar geometry p/ evitar ciclo) ----
function computeCurrentBBox(){
  let torre = null;
  scene?.traverse(n => { if (!torre && n.name === 'Torre') torre = n; });
  if (!torre) return null;
  const bb = new THREE.Box3().setFromObject(torre);
  if (!Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x)) return null;
  return bb;
}
// Distância necessária para enquadrar a bbox na viewport, respeitando FOV e aspect
function fitDistanceToBBox(bb, { vfovRad, aspect, margin = 1.18 }){
  const size = bb.getSize(new THREE.Vector3());
  const h = size.y;
  const w = Math.hypot(size.x, size.z); // largura “pior caso” no plano XZ

  const vHalf = h * 0.5;
  const hHalf = w * 0.5;

  const distV = vHalf / Math.tan(vfovRad * 0.5);
  const hfovRad = 2 * Math.atan(Math.tan(vfovRad * 0.5) * aspect);
  const distH = hHalf / Math.tan(hfovRad * 0.5);

  return Math.max(distV, distH) * margin;
}

// ---------------------------------------------------------
// Recenter (retrocompat):
// - Novo:  recenterCamera({ bbox, verticalOffsetRatio, animate=false, dur=280 })
// - Antigo: recenterCamera(targetVec3?, dist?, { animate? })
// - Antigão: recenterCamera(null, dist)
// ---------------------------------------------------------
export function recenterCamera(a = undefined, b = undefined, c = undefined){
  // Normalização (compat com formatos antigos)
  let options = {};
  if (a && typeof a === 'object' && !('x' in a)) {
    options = a;
  } else {
    const target = (a && typeof a === 'object' && 'x' in a) ? a : null;
    const dist   = (typeof b === 'number' && isFinite(b)) ? b : null;
    const opts   = (c && typeof c === 'object') ? c : {};
    options = { target, dist, ...opts };
  }

  const {
    bbox = null,
    verticalOffsetRatio = 0.10,
    target = null,       // compat
    dist = null,         // compat
    theta = null,        // NOVO
    phi   = null,        // NOVO
    margin = 1.18,       // margem de respiro
    animate = false,
    dur = 280
  } = options;

  // BBox e centro atualizados (já consideram alturas variáveis da geometry)
  const bb   = bbox || computeCurrentBBox();
  const size = bb ? bb.getSize(new THREE.Vector3()) : new THREE.Vector3(20,20,20);
  const ctr  = bb ? bb.getCenter(new THREE.Vector3()) : new THREE.Vector3(0,0,0);

  const cy = ctr.y + (size.y * verticalOffsetRatio);

  // Se não veio dist, calcula para caber na tela (fit-to-bbox)
  const vfovRad = (camera.fov || 50) * Math.PI / 180;
  const idealDist = bb
    ? fitDistanceToBBox(bb, { vfovRad, aspect: camera.aspect || 1, margin })
    : 28;

  const finalDist = (typeof dist === 'number' && isFinite(dist)) ? dist : idealDist;

  // Se vieram ângulos, aplicamos agora (clamped)
  if (typeof theta === 'number' && isFinite(theta)) State.theta = theta;
  if (typeof phi   === 'number' && isFinite(phi)) {
    const ORBIT_MIN_PHI = 0.05, ORBIT_MAX_PHI = Math.PI - 0.05;
    State.phi = Math.max(ORBIT_MIN_PHI, Math.min(ORBIT_MAX_PHI, phi));
  }

  // Se veio target explícito no formato antigo, usa como centro
  if (target && typeof target === 'object' && 'x' in target) {
    ctr.copy(target);
  }

  ensureOrbitTargetVec3();

  if (!animate){
    State.orbitTarget.set(ctr.x, cy, ctr.z);
    State.radius = finalDist;
    applyOrbitToCamera();
    render();
    return;
  }

  // (opcional) animação suave
  const fromTarget = State.orbitTarget.clone();
  const toTarget   = new THREE.Vector3(ctr.x, cy, ctr.z);
  const rFrom = Number(State.radius || 20);
  const rTo   = finalDist;

  const start = performance.now();
  const ease  = (t)=> 1 - Math.pow(1 - t, 3);

  const step = (now)=>{
    const k = Math.min(1, (now - start) / dur);
    const e = ease(k);

    State.orbitTarget.set(
      fromTarget.x + (toTarget.x - fromTarget.x) * e,
      fromTarget.y + (toTarget.y - fromTarget.y) * e,
      fromTarget.z + (toTarget.z - fromTarget.z) * e
    );
    State.radius = rFrom + (rTo - rFrom) * e;

    applyOrbitToCamera();
    if (k < 1) requestAnimationFrame(step); else render();
  };
  requestAnimationFrame(step);
}


export function resetRotation(){
  // mantém alvo e raio; só reseta ângulos
  State.theta = 0;
  State.phi   = Math.min(Math.max(1.1, ORBIT_MIN_PHI), ORBIT_MAX_PHI);
  applyOrbitToCamera();
  render();
}

// ----------------------------
// Render
// ----------------------------
export function render(){
  if (renderer && scene && camera){
    renderer.render(scene, camera);
  }
}

// =====================================================
// INPUT BASE (opcional)
// =====================================================

// Aplica delta de ORBIT com sensibilidade correta
export function orbitDelta(dx, dy, isTouch=false){
  const ROT = isTouch ? ROT_SPEED_TOUCH : ROT_SPEED_DESKTOP;
  State.theta += dx * ROT;
  State.phi   -= dy * ROT;
  State.phi = Math.max(ORBIT_MIN_PHI, Math.min(ORBIT_MAX_PHI, State.phi));
  applyOrbitToCamera();
  render();
}

// Aplica delta de PAN em pixels de tela
export function panDelta(dx, dy){
  ensureOrbitTargetVec3();

  const base = (State.radius || 20) * (0.0025 * PAN_FACTOR);
  // Eixos aproximados em tela
  const dir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0,1,0);

  camera.getWorldDirection(dir);
  right.crossVectors(dir, up).normalize();
  const camUp = camera.up.clone().normalize();

  State.orbitTarget.addScaledVector(right, -dx * base);
  State.orbitTarget.addScaledVector(camUp,  dy * base);
  applyOrbitToCamera();
  render();
}

// Aplica zoom relativo (delta de wheel)
// Ajuste suave de zoom (diferencia pinch vs scroll)
export function zoomDelta(sign, isTouch = false){
  const r = State.radius || 20;

  let step;
  if (isTouch){
    // 👆 Pinch → step fixo suave (independente da distância)
    step = 0.08;   // ajuste fino (quanto menor, mais suave)
  } else {
    // 🖱️ Scroll → proporcional mas reduzido (mais confortável)
    const ZOOM_STEP_FACTOR = 0.00025; // antes era 0.001 → mais leve
    step = Math.max(0.05, r * ZOOM_STEP_FACTOR);
  }

  State.radius += sign * step;
  State.radius = Math.max(4, Math.min(400, State.radius));

  applyOrbitToCamera();
  render();
}

