// ============================
// Estado global + Prefs (QS / LocalStorage)
// ============================
// em algum lugar do init do State
export const STORAGE_KEYS = {
  FVS: 'doge.viewer.fvs',
  NC:  'doge.viewer.nc',
  IN_PROGRESS: 'doge.viewer.inProgress', // Novo
};

export const State = {
  // ==== Grid 2D (zoom/linhas/alpha) ====
  grid2DZoom: 1,          // fator contínuo de zoom do grid 2D (usado no overlay2d)
  grid2DRows: 8,          // linhas alvo quando grid2DZoom = 1 (overlay usa para TARGET_ROWS)
  grid2DAlpha: 0.5,       // alpha padrão do fundo dos cards 2D (overlay respeita se existir)

  // ==== Filtros / cores ====
  CURRENT_FVS: '',
  NC_MODE: false,
  IN_PROGRESS_MODE: false, // Novo
  COLOR_MAP: { default: '#6e7681', colors: {}, byFloor: {} },
  META_MAP: new Map(),

  // Seleção e modal
  __SEL_GROUP__: null,

  // Orbit/câmera
  radius: 28,
  theta: Math.PI * 0.25,
  phi: Math.PI * 0.35,
  orbitTarget: null,

  // Explode/opacidade/2D
  faceOpacity: 0.30,
  explodeXY: 0,
  explodeY: 0,
  flatten2D: 0
};

// ----------------------
// Query string helpers
// ----------------------
export function getQS(name){
  const u = new URL(location.href);
  return u.searchParams.get(name);
}
export function setQS(updates){
  const u = new URL(location.href);
  for (const [k,v] of Object.entries(updates)){
    if (v == null || v === '' || v === false) u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  }
  history.replaceState(null, '', u.toString());
}

// ----------------------
// Prefs (localStorage)
// ----------------------
export function savePrefs() {
  try {
    if (State.CURRENT_FVS) localStorage.setItem(STORAGE_KEYS.FVS, State.CURRENT_FVS);
    localStorage.setItem(STORAGE_KEYS.NC, String(!!State.NC_MODE));
    localStorage.setItem(STORAGE_KEYS.IN_PROGRESS, String(!!State.IN_PROGRESS_MODE)); // Novo
  } catch {}
}

export function loadPrefs() {
  let fvs = null, nc = null, inProgress = null;
  try {
    fvs = localStorage.getItem(STORAGE_KEYS.FVS);
    nc = localStorage.getItem(STORAGE_KEYS.NC);
    inProgress = localStorage.getItem(STORAGE_KEYS.IN_PROGRESS); // Novo
  } catch {}
  return {
    fvs: fvs || '',
    nc: (nc === 'true'),
    inProgress: (inProgress === 'true'), // Novo
  };
}

// garante defaults se este arquivo for carregado após outro trecho que define State
State.grid2DRows = State.grid2DRows ?? 8;
State.grid2DZoom = State.grid2DZoom ?? 1;
State.grid2DAlpha = State.grid2DAlpha ?? 0.5;