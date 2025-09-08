// ============================
// Cena 3D / Câmera / Renderer
// ============================

import { State } from './state.js';

export let scene, renderer, camera;

// IDs de animação
let _panAnim = null;
let _pendingPan = null;

// Parâmetros de controle
const ORBIT_MIN_PHI = 0.05;
const ORBIT_MAX_PHI = Math.PI - 0.05;
export const INITIAL_THETA = Math.PI * 0.25; // pose "em pé"
export const INITIAL_PHI   = Math.PI * 0.35; // pose "em pé"

// Ajustes finos
const ROT_SPEED_DESKTOP = 0.0042;
const ROT_SPEED_TOUCH   = 0.0042;
const PAN_FACTOR = 0.4;
const PAN_SMOOTH = 0.22;
const ZOOM_EXP_K_WHEEL = 0.27;
const ZOOM_EXP_K_PINCH = 2;
const ZOOM_FACTOR_MIN = 0.5;
const ZOOM_FACTOR_MAX = 1.35; // (ajuste fino p/ wheel/pinch)
export const ZOOM_MIN = 4;
export const ZOOM_MAX = 400;

// Auto-fit inicial
let _autoFitTimer = null;
const AUTO_FIT_MAX_MS = 4000;
const AUTO_FIT_POLL_MS = 120;

// Pivô fixo do modelo (centro do BBox), calculado 1x
let _modelPivot = null;

// Margem mínima “à prova de corte”
const SAFE_MIN_MARGIN = 1.5;

// Pose inicial (“Home”) para Reset
const Home = {
  has: false,
  target: new THREE.Vector3(),
  radius: 0,
  theta: 0,
  phi: 0
};

// Guard para gestos de dois dedos (evita recenters/fit/reset durante pinch)
let __touchIds = new Set();
function _onPtrDown(e){ if (e.pointerType === 'touch') __touchIds.add(e.pointerId); }
function _onPtrUp(e){ if (e.pointerType === 'touch') __touchIds.delete(e.pointerId); }
function isTwoFingerActive(){ return __touchIds.size >= 2; }
function installTwoFingerGuard(){
  window.addEventListener('pointerdown', _onPtrDown, { passive:true });
  window.addEventListener('pointerup', _onPtrUp, { passive:true });
  window.addEventListener('pointercancel', _onPtrUp, { passive:true });
  window.addEventListener('lostpointercapture', _onPtrUp, { passive:true });
}

// Leitura do lock global (modal etc.) — viewer mantém window.DOGE.inputLocked
function inputLocked(){
  return !!(window.DOGE && window.DOGE.inputLocked);
}

function saveHomeFromState() {
  Home.has = true;
  Home.target.copy(State.orbitTarget);
  Home.radius = State.radius;
  Home.theta = State.theta;
  Home.phi = State.phi;
}

function getAppEl() {
  const el = document.getElementById('app');
  if (!el) throw new Error('[scene] #app não encontrado');
  return el;
}

function ensureOrbitTargetVec3() {
  if (!State.orbitTarget || typeof State.orbitTarget.set !== 'function') {
    State.orbitTarget = new THREE.Vector3(0, 0, 0);
  }
  return State.orbitTarget;
}

export function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f141b);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 2000);
  camera.position.set(8, 8, 8);
  camera.up.set(0, 1, 0);

  // Luzes
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dir = new THREE.DirectionalLight(0xffffff, 0.65);
  dir.position.set(8, 12, 6);
  scene.add(dir);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

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

  ensureOrbitTargetVec3();
  if (!Number.isFinite(State.theta)) State.theta = INITIAL_THETA;
  if (!Number.isFinite(State.phi))   State.phi   = INITIAL_PHI;
  if (!Number.isFinite(State.radius)) State.radius = 28;

  getAppEl().prepend(cvs);
  installTwoFingerGuard();

  window.addEventListener('resize', onResize, { passive: true });
  onResize();

  applyOrbitToCamera();
  startAutoFitOnce(); // calcula pivô fixo + Home (não roda se Home já existir)

  // Input unificado agora mora aqui
  wireUnifiedInput();

  return { scene, renderer, camera };
}

function onResize() {
  if (!renderer || !camera) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
}

export function applyOrbitToCamera() {
  ensureOrbitTargetVec3();

  const r  = THREE.MathUtils.clamp(Number(State.radius) || 20, ZOOM_MIN, ZOOM_MAX);
  const th = Number.isFinite(State.theta) ? State.theta : 0;
  const ph = THREE.MathUtils.clamp(Number(State.phi)   || INITIAL_PHI, ORBIT_MIN_PHI, ORBIT_MAX_PHI);

  const target = State.orbitTarget;
  const x = target.x + r * Math.sin(ph) * Math.cos(th);
  const y = target.y + r * Math.cos(ph);
  const z = target.z + r * Math.sin(ph) * Math.sin(th);

  camera.position.set(x, y, z);
  camera.lookAt(target);
}

// -------- Bounding Box Utils --------
function computeCurrentBBox(root = null) {
  const targetRoot = root || scene;
  if (!targetRoot) return null;

  const box = new THREE.Box3();
  let has = false;

  targetRoot.traverse((obj) => {
    if (!obj.visible) return;
    if (obj.isMesh && obj.geometry) {
      const geomBox = new THREE.Box3().setFromObject(obj);
      if (
        Number.isFinite(geomBox.min.x) && Number.isFinite(geomBox.max.x) &&
        Number.isFinite(geomBox.min.y) && Number.isFinite(geomBox.max.y) &&
        Number.isFinite(geomBox.min.z) && Number.isFinite(geomBox.max.z)
      ) {
        box.union(geomBox);
        has = true;
      }
    }
  });

  return has ? box : null;
}

// Distância para caber 100% (pior caso V/H) + margem, considerando offsets
function fitDistanceToBBox(bb, { vfovRad, aspect, margin = 1.6, verticalOffsetRatio = 0 }) {
  const size = bb.getSize(new THREE.Vector3());
  const h = size.y;
  const w = Math.hypot(size.x, size.z);

  const vHalf = (h * 0.5) + Math.abs(h * verticalOffsetRatio);
  const hHalf = w * 0.5;

  const distV = vHalf / Math.tan(vfovRad * 0.5);
  const hfovRad = 2 * Math.atan(Math.tan(vfovRad * 0.5) * aspect);
  const distH = hHalf / Math.tan(hfovRad * 0.5);

  return Math.max(distV, distH) * Math.max(margin, SAFE_MIN_MARGIN);
}

// ------------- Camera recentre (fit) -------------
export function recenterCamera(a = undefined, b = undefined, c = undefined) {
  if (isTwoFingerActive()) return; // ⛔ durante gesto mobile
  let options = {};
  if (a && typeof a === 'object' && !('x' in a)) {
    options = a;
  } else {
    const target = (a && typeof a === 'object' && 'x' in a) ? a : null;
    const dist = (typeof b === 'number' && isFinite(b)) ? b : null;
    const opts = (c && typeof c === 'object') ? c : {};
    options = { target, dist, ...opts };
  }

  const {
    bbox = null,
    root = null,
    verticalOffsetRatio = 0.0,
    target = null,
    dist = null,
    theta = null,
    phi = null,
    margin = SAFE_MIN_MARGIN,
    animate = false,
    dur = 280,
    forceUpright = true
  } = options;

  const bb = bbox || computeCurrentBBox(root);
  const size = bb ? bb.getSize(new THREE.Vector3()) : new THREE.Vector3(20, 20, 20);
  const ctr  = bb ? bb.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);

  const cy = ctr.y + (size.y * verticalOffsetRatio);

  const vfovRad = (camera.fov || 50) * Math.PI / 180;
  const idealDist = bb
    ? fitDistanceToBBox(bb, { vfovRad, aspect: camera.aspect || 1, margin, verticalOffsetRatio })
    : 28;

  const finalDist = (typeof dist === 'number' && isFinite(dist)) ? dist : idealDist;

  if (typeof theta === 'number' && isFinite(theta)) State.theta = theta;
  if (typeof phi   === 'number' && isFinite(phi))   State.phi   = THREE.MathUtils.clamp(phi, ORBIT_MIN_PHI, ORBIT_MAX_PHI);
  if (target && typeof target === 'object' && 'x' in target) ctr.copy(target);

  ensureOrbitTargetVec3();

  const doApply = () => {
    State.orbitTarget.set(ctr.x, cy, ctr.z);
    State.radius = finalDist;
    if (forceUpright) camera.up.set(0, 1, 0);
    applyOrbitToCamera();
    render();
  };

  if (!animate) {
    doApply();
    return;
  }

  const fromTarget = State.orbitTarget.clone();
  const toTarget   = new THREE.Vector3(ctr.x, cy, ctr.z);
  const rFrom = Number(State.radius || 20);
  const rTo   = finalDist;

  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    const e = ease(k);

    State.orbitTarget.set(
      fromTarget.x + (toTarget.x - fromTarget.x) * e,
      fromTarget.y + (toTarget.y - fromTarget.y) * e,
      fromTarget.z + (toTarget.z - fromTarget.z) * e
    );
    State.radius = rFrom + (rTo - rFrom) * e;

    if (forceUpright) camera.up.set(0, 1, 0);
    applyOrbitToCamera();
    if (k < 1) requestAnimationFrame(step); else render();
  };
  requestAnimationFrame(step);
}

// ---------- Auto-fit inicial (pivô fixo + Home) ----------
export function disableAutoFit(){
  if (_autoFitTimer){
    clearInterval(_autoFitTimer);
    _autoFitTimer = null;
  }
}

function startAutoFitOnce() {
  if (Home.has) return;       // viewer já definiu a Home → não faz auto-fit
  if (_autoFitTimer) return;

  const t0 = performance.now();
  const tick = () => {
    if (Home.has) { disableAutoFit(); return; } // Home definida no meio do caminho

    const bb = computeCurrentBBox();
    if (bb) {
      _modelPivot = bb.getCenter(new THREE.Vector3());

      camera.up.set(0, 1, 0);
      State.theta = INITIAL_THETA;
      State.phi   = THREE.MathUtils.clamp(INITIAL_PHI, ORBIT_MIN_PHI, ORBIT_MAX_PHI);
      State.orbitTarget.copy(_modelPivot);

      const vfovRad = (camera.fov || 50) * Math.PI / 180;
      State.radius = fitDistanceToBBox(bb, { vfovRad, aspect: camera.aspect || 1, margin: 1.6, verticalOffsetRatio: 0 });

      applyOrbitToCamera();
      render();
      saveHomeFromState();

      disableAutoFit();
      return;
    }

    if (performance.now() - t0 > AUTO_FIT_MAX_MS) {
      disableAutoFit();
    }
  };

  _autoFitTimer = setInterval(tick, AUTO_FIT_POLL_MS);
}

// (Opcional) Recalcula o pivô e re-enquadra; pode ser chamado quando trocar o modelo
export function refreshModelPivotAndFit({ animate = false } = {}) {
  const bb = computeCurrentBBox();
  if (!bb) return;
  _modelPivot = bb.getCenter(new THREE.Vector3());
  recenterCamera({ bbox: bb, animate, margin: 1.6, verticalOffsetRatio: 0, forceUpright: true });
}

// Compat: centraliza e (opcional) salva como Home
export function syncOrbitTargetToModel({ root = null, animate = false, saveAsHome = false } = {}) {
  if (isTwoFingerActive()) return; // ⛔ durante gesto mobile
  const bb = computeCurrentBBox(root);
  if (!bb) return;

  _modelPivot = bb.getCenter(new THREE.Vector3());
  recenterCamera({ bbox: bb, animate, margin: 1.6, verticalOffsetRatio: 0, forceUpright: true });

  if (saveAsHome) {
    camera.up.set(0, 1, 0);
    saveHomeFromState();
    disableAutoFit(); // evita "coice" posterior
  }
}

// ------------- Reset (volta ao Home “em pé”) -------------
export function resetRotation() {
  if (isTwoFingerActive()) return; // ⛔ durante gesto mobile
  if (Home.has) {
    State.orbitTarget.copy(Home.target);
    State.radius = Home.radius;
    State.theta  = Home.theta;
    State.phi    = Home.phi;
    camera.up.set(0, 1, 0);
    applyOrbitToCamera();
    render();
  } else {
    const bb = computeCurrentBBox();
    if (bb) {
      _modelPivot = bb.getCenter(new THREE.Vector3());
      recenterCamera({ bbox: bb, animate: false, margin: 1.6, verticalOffsetRatio: 0, forceUpright: true });
      saveHomeFromState();
      disableAutoFit();
    } else {
      State.theta = INITIAL_THETA;
      State.phi   = THREE.MathUtils.clamp(INITIAL_PHI, ORBIT_MIN_PHI, ORBIT_MAX_PHI);
      camera.up.set(0, 1, 0);
      applyOrbitToCamera();
      render();
    }
  }
}

// ------------- Render -------------
export function render() {
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// === Util: pan instantâneo em eixos de tela (para compensar drift de rotação)
function panInstantScreen(dx, dy) {
  const base = (State.radius || 20) * (0.0035 * PAN_FACTOR);
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const upScreen = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  State.orbitTarget.addScaledVector(right, -dx * base);
  State.orbitTarget.addScaledVector(upScreen, dy * base);
}

// === Util: projeta ponto do mundo para coordenadas de tela (px)
function worldToScreen(vec3) {
  const v = vec3.clone().project(camera);
  const size = renderer.getSize(new THREE.Vector2());
  return new THREE.Vector2((v.x * 0.5 + 0.5) * size.x, (-v.y * 0.5 + 0.5) * size.y);
}

// ========== ROTATION (1 dedo): YAW/PITCH sem roll, em torno do pivô ==========
export function orbitDelta(dx, dy, isTouch = false) {
  const ROT = isTouch ? ROT_SPEED_TOUCH : ROT_SPEED_DESKTOP;

  // sinais para "seguir o dedo"
  const yaw   = -dx * ROT; // arrastar p/ direita → yaw para a direita
  const pitch = -dy * ROT; // arrastar p/ cima    → inclina para cima

  const pivot = _modelPivot ? _modelPivot : State.orbitTarget.clone();

  // posição de tela do pivô ANTES (para compensar drift)
  const scrBefore = worldToScreen(pivot);

  // Vetores relativos ao pivô
  const P = camera.position.clone();
  const T = State.orbitTarget.clone();
  const up0 = camera.up.clone();

  const vP = P.sub(pivot);
  const vT = T.sub(pivot);

  // Base atual
  const forward0 = vT.clone().sub(vP).normalize();           // direção câmera->target
  let right0 = new THREE.Vector3().crossVectors(forward0, up0).normalize();
  if (!Number.isFinite(right0.x) || right0.lengthSq() === 0) right0.set(1, 0, 0);
  const up1 = new THREE.Vector3().crossVectors(right0, forward0).normalize();

  // 1) Yaw em Y global
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), yaw);
  const vP1 = vP.clone().applyQuaternion(qYaw);
  const vT1 = vT.clone().applyQuaternion(qYaw);
  const right1 = right0.clone().applyQuaternion(qYaw);
  const upYaw  = up1.clone().applyQuaternion(qYaw);

  // 2) Pitch em torno do "right" já yawado
  const qPitch = new THREE.Quaternion().setFromAxisAngle(right1, pitch);
  const qTotal = new THREE.Quaternion().multiplyQuaternions(qPitch, qYaw);

  // Candidatos com yaw+pitch aplicados também no alvo (arcball real)
  const vP2 = vP.clone().applyQuaternion(qTotal);
  const vT2 = vT.clone().applyQuaternion(qTotal);
  const up2 = up0.clone().applyQuaternion(qTotal);

  // Clamp de phi (evita virar de ponta cabeça)
  const rel2 = vP2.clone().sub(vT2);
  const r2   = rel2.length();
  const ph2  = Math.acos(THREE.MathUtils.clamp(rel2.y / r2, -1, 1));
  const pitchOk = (ph2 >= ORBIT_MIN_PHI && ph2 <= ORBIT_MAX_PHI);

  // Commit (ignora pitch se estourar)
  const used_vP = pitchOk ? vP2 : vP1;
  const used_vT = pitchOk ? vT2 : vT1;
  const used_up = pitchOk ? up2 : upYaw;

  const Pnew = pivot.clone().add(used_vP);
  const Tnew = pivot.clone().add(used_vT);

  camera.position.copy(Pnew);
  camera.up.copy(used_up.normalize());
  State.orbitTarget.copy(Tnew);

  // Atualiza esféricas (para manter applyOrbitToCamera coerente)
  const rel = camera.position.clone().sub(State.orbitTarget);
  const r   = rel.length();
  const ph  = Math.acos(THREE.MathUtils.clamp(rel.y / r, -1, 1));
  const th  = Math.atan2(rel.z, rel.x);

  State.radius = THREE.MathUtils.clamp(r, ZOOM_MIN, ZOOM_MAX);
  State.theta  = th;
  State.phi    = THREE.MathUtils.clamp(ph, ORBIT_MIN_PHI, ORBIT_MAX_PHI);

  // Compensa drift de tela: mantém o pivô no mesmo pixel
  const scrAfter = worldToScreen(pivot);
  const dScreenX = scrAfter.x - scrBefore.x;
  const dScreenY = scrAfter.y - scrBefore.y;
  if (Math.abs(dScreenX) > 0.01 || Math.abs(dScreenY) > 0.01) {
    panInstantScreen(dScreenX, dScreenY);
  }

  camera.lookAt(State.orbitTarget);
  render();
}

// ========== TWIST (2 dedos): roll em torno do eixo de visão ==========
export function orbitTwist(deltaAngleRad) {
  if (!Number.isFinite(deltaAngleRad) || Math.abs(deltaAngleRad) < 1e-6) return;

  const pivot = _modelPivot ? _modelPivot : State.orbitTarget.clone();
  const forward = camera.getWorldDirection(new THREE.Vector3()).normalize();

  const q = new THREE.Quaternion().setFromAxisAngle(forward, deltaAngleRad);

  const posRel = camera.position.clone().sub(pivot).applyQuaternion(q);
  const tgtRel = State.orbitTarget.clone().sub(pivot).applyQuaternion(q);

  camera.position.copy(pivot.clone().add(posRel));
  State.orbitTarget.copy(pivot.clone().add(tgtRel));
  camera.up.applyQuaternion(q).normalize();

  camera.lookAt(State.orbitTarget);
  render();
}

// ========== PAN SUAVE ==========
export function panDelta(dx, dy) {
  ensureOrbitTargetVec3();
  if (_pendingPan) {
    _pendingPan.dx += dx;
    _pendingPan.dy += dy;
    return;
  }
  _pendingPan = { dx, dy };
  if (_panAnim) cancelAnimationFrame(_panAnim);
  _panAnim = requestAnimationFrame(animatePan);
}

function animatePan() {
  if (!_pendingPan) return;
  let { dx, dy } = _pendingPan;
  const applyDx = dx * PAN_SMOOTH;
  const applyDy = dy * PAN_SMOOTH;
  _pendingPan.dx -= applyDx;
  _pendingPan.dy -= applyDy;

  const base = (State.radius || 20) * (0.0035 * PAN_FACTOR);

  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const upScreen = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();

  State.orbitTarget.addScaledVector(right, -applyDx * base);
  State.orbitTarget.addScaledVector(upScreen, applyDy * base);

  applyOrbitToCamera();
  render();

  if (Math.abs(_pendingPan.dx) > 0.2 || Math.abs(_pendingPan.dy) > 0.2) {
    _panAnim = requestAnimationFrame(animatePan);
  } else {
    _pendingPan = null;
    _panAnim = null;
  }
}

// ====== ZOOM SUAVE (acumulativo, com foco opcional no ponteiro) ======
let _zoomRAF = null;
let _zoomTargetRadius = null;
let _zoomTargetOrbit = null;
let _zoomSmoothing = 0.22;

export function zoomDelta(deltaOrObj = 0, isPinch = false) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rNow = clamp(Number(State.radius) || 20, ZOOM_MIN, ZOOM_MAX);

  // 1) normaliza "scale"
  let scale = 1;
  if (deltaOrObj && typeof deltaOrObj === 'object' && typeof deltaOrObj.scale === 'number') {
    scale = Number(deltaOrObj.scale) || 1;
  } else {
    const delta = Number(deltaOrObj) || 0;
    if (delta === 0) return;
    const k = isPinch ? ZOOM_EXP_K_PINCH : ZOOM_EXP_K_WHEEL;
    scale = Math.exp(delta * k);
  }
  scale = clamp(scale, ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX);

  // 2) destino de raio acumulado
  const rBase = (_zoomTargetRadius != null) ? _zoomTargetRadius : rNow;
  let rDest = clamp(rBase * scale, ZOOM_MIN, ZOOM_MAX);

  // 3) foco opcional no ponteiro (NDC)
  const atMin = Math.abs(rDest - ZOOM_MIN) < 1e-6;
  const atMax = Math.abs(rDest - ZOOM_MAX) < 1e-6;

  const tBase = (_zoomTargetOrbit && _zoomTargetOrbit.isVector3) ? _zoomTargetOrbit.clone()
                : State.orbitTarget.clone();
  let tDest = tBase.clone();

  if (!atMin && !atMax && deltaOrObj && deltaOrObj.focusNDC && typeof deltaOrObj.focusNDC.x === 'number') {
    try {
      const ndcX = deltaOrObj.focusNDC.x;
      const ndcY = deltaOrObj.focusNDC.y;

      const camPos = camera.position.clone();
      const ptNdc  = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
      const dir    = ptNdc.sub(camPos).normalize();

      const n = camera.getWorldDirection(new THREE.Vector3());
      const denom = dir.dot(n);
      if (Math.abs(denom) > 1e-6) {
        const t = tBase.clone().sub(camPos).dot(n) / denom;
        if (t > 0) {
          const hit    = camPos.clone().addScaledVector(dir, t);
          const toward = hit.sub(tBase);
          const eff    = rDest / rBase;
          const alpha  = (1 - eff);
          tDest = tBase.clone().addScaledVector(toward, alpha);
        }
      }
    } catch {}
  }

  _zoomTargetRadius = rDest;
  _zoomTargetOrbit  = tDest;

  if (_zoomRAF) return;

  const step = () => {
    if (_zoomTargetRadius == null) { _zoomRAF = null; return; }

    const rCur = clamp(Number(State.radius) || 20, ZOOM_MIN, ZOOM_MAX);
    const tCur = State.orbitTarget.clone();

    const s = _zoomSmoothing;

    const ratio = (_zoomTargetRadius / Math.max(rCur, 1e-9));
    const rNext = clamp(rCur * Math.pow(Math.max(ratio, 1e-9), s), ZOOM_MIN, ZOOM_MAX);

    const tNext = new THREE.Vector3(
      tCur.x + (_zoomTargetOrbit.x - tCur.x) * s,
      tCur.y + (_zoomTargetOrbit.y - tCur.y) * s,
      tCur.z + (_zoomTargetOrbit.z - tCur.z) * s
    );

    State.radius = rNext;
    State.orbitTarget.copy(tNext);
    applyOrbitToCamera();
    render();

    const closeR = Math.abs(_zoomTargetRadius - rNext) / Math.max(_zoomTargetRadius, 1) < 1e-3;
    const closeT = tNext.distanceToSquared(_zoomTargetOrbit) < 1e-4;

    if (closeR && closeT) {
      State.radius = _zoomTargetRadius;
      State.orbitTarget.copy(_zoomTargetOrbit);
      applyOrbitToCamera();
      render();

      _zoomTargetRadius = null;
      _zoomTargetOrbit  = null;
      _zoomRAF = null;
      return;
    }

    _zoomRAF = requestAnimationFrame(step);
  };

  _zoomRAF = requestAnimationFrame(step);
}

// ========== TOQUE / MOUSE / TRACKPAD UNIFICADO ==========
export function wireUnifiedInput(){
  const cvs = renderer?.domElement;
  if (!cvs) return;

  // marca “houve interação” (para qualquer watchdog externo que o viewer use)
  const markInteracted = () => { (window.DOGE ||= {}).__userInteracted = true; };

  // 1) Bloqueio do page-zoom apenas sobre o canvas
  (function installGlobalPinchBlock(el){
    const inCanvasByPoint = (ev) => {
      if (typeof ev.clientX !== 'number' || typeof ev.clientY !== 'number') return false;
      const r = el.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right &&
             ev.clientY >= r.top  && ev.clientY <= r.bottom;
    };

    const onWheelCapture = (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && inCanvasByPoint(ev)) ev.preventDefault();
    };
    const onGestureCapture = (ev) => { if (inCanvasByPoint(ev)) ev.preventDefault(); };

    document.addEventListener('wheel',         onWheelCapture,    { passive:false, capture:true });
    document.addEventListener('gesturestart',  onGestureCapture,  { passive:false, capture:true });
    document.addEventListener('gesturechange', onGestureCapture,  { passive:false, capture:true });
  })(cvs);

  // 2) Gestos legacy (Safari/macOS)
  let _gPrevScale = 1;
  let _gPrevRotationDeg = 0;

  cvs.addEventListener('gesturestart',  (e) => {
    markInteracted();
    if (inputLocked()) return;
    _gPrevScale = (typeof e.scale === 'number' && e.scale > 0) ? e.scale : 1;
    _gPrevRotationDeg = (typeof e.rotation === 'number') ? e.rotation : 0;
    e.preventDefault();
  }, { passive:false });

  cvs.addEventListener('gesturechange', (e) => {
    if (inputLocked()) return;

    if (typeof e.scale === 'number' && e.scale > 0) {
      let factor = e.scale / (_gPrevScale || 1);
      if (Math.abs(Math.log(factor)) > 0.003){
        factor = Math.max(0.8, Math.min(1.25, Math.pow(factor, 0.85)));
        zoomDelta({ scale: 1 / factor }, /*isPinch=*/true);
      }
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

  // 3) Pan latch (duplo clique/toque)
  let panLatchUntil = 0;
  let touchPanArmedUntil = 0;
  const PAN_LATCH_MS = 650;

  cvs.addEventListener('dblclick', (e) => {
    markInteracted();
    if (inputLocked()) return;
    panLatchUntil = performance.now() + PAN_LATCH_MS;
    e.preventDefault();
  }, { passive:false });

  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_MAX_D = 22;

  cvs.addEventListener('touchstart', (e) => {
    markInteracted();
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

  // 4) Pointer unificado
  const pointers = new Map();
  let pinchPrevDist = 0;
  let pinchPrevMid  = null;
  let pinchPrevAng  = 0;

  const TWIST_SENS_MOUSE = 0.012;

  // Tracking da tecla Ctrl (Ctrl + esquerdo = Pan)
  let __ctrlPressed = false;
  const onKeyDown = (e) => {
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
      __ctrlPressed = true;
      e.preventDefault();
    }
  };
  const onKeyUp = (e) => {
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
      __ctrlPressed = false;
    }
  };
  window.addEventListener('keydown', onKeyDown, { passive:false });
  window.addEventListener('keyup', onKeyUp, { passive:true });

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
    markInteracted();

    // failsafe: se algum lock persistiu, solta o pointer-events
    if (!inputLocked() && getComputedStyle(cvs).pointerEvents !== 'auto') {
      cvs.style.pointerEvents = 'auto';
    }
    if (inputLocked()) return;

    // pointer capture apenas para mouse (multi-touch em mobile pode quebrar)
    if (e.pointerType === 'mouse') {
      cvs.setPointerCapture?.(e.pointerId);
    }

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
      // === sempre calcule 'mid' primeiro ===
      const mid  = getMidpoint();

      // === PINCH ZOOM (MOBILE) com deadzone + inversão natural ===
      const dist = getDistance();
      if (pinchPrevDist > 0 && dist > 0){
        const raw = dist / pinchPrevDist;
        const logDelta = Math.log(raw);
        if (Math.abs(logDelta) > 0.003){
          let scale = Math.pow(raw, 0.85);
          scale = Math.max(0.8, Math.min(1.25, scale));
          // mobile “natural”: pinçar para fora => zoom IN
          scale = 1 / scale;
          zoomDelta({ scale }, true);
        }
      }
      pinchPrevDist = dist;

      // === PAN do centro (suave) ===
      const midPrev = pinchPrevMid;
      if (midPrev && mid){
        const mdx = mid.x - midPrev.x;
        const mdy = mid.y - midPrev.y;
        if (mdx || mdy) panDelta(mdx, mdy);
      }
      pinchPrevMid  = mid;

      // === TWIST 2 dedos (ângulo) ===
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
    pointers.delete(e.pointerId);
    if (pointers.size < 2){
      pinchPrevDist = 0;
      pinchPrevMid  = null;
      pinchPrevAng  = 0;
    }
  };
  cvs.addEventListener('pointerup', clearPointer,        { passive:true });
  cvs.addEventListener('pointercancel', clearPointer,    { passive:true });
  cvs.addEventListener('lostpointercapture', clearPointer, { passive:true });

  // 5) Wheel (mouse/trackpad) = zoom com foco no ponteiro
  cvs.addEventListener('wheel', (e) => {
    markInteracted();
    if (inputLocked()) return;

    e.preventDefault();
    e.stopPropagation();

    const unit = (e.deltaMode === 1) ? 33 : (e.deltaMode === 2) ? 120 : 1;
    const dy   = e.deltaY * unit;

    const isTrackpadPinch = (e.ctrlKey || e.metaKey);
    const k = isTrackpadPinch ? +0.008 : -0.008;
    let scale = Math.exp(dy * k);
    scale = Math.max(0.75, Math.min(1.35, scale));

    // NDC do ponteiro
    const r = cvs.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top)  / r.height;
    const ndc = { x: x * 2 - 1, y: -(y * 2 - 1) };

    zoomDelta({ scale, focusNDC: ndc }, /*isPinch=*/isTrackpadPinch);
  }, { passive:false });

  // Necessário para twist com right-drag
  cvs.addEventListener('contextmenu', e => e.preventDefault(), { passive:false });
}
