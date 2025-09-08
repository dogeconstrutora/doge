// ============================
// Data fetchers (layout / fvs / apartamentos)
// ============================

export let layoutData   = null;
export let fvsList      = [];
export let apartamentos = [];

/**
 * Obra ativa: ?obra=... tem prioridade e é cacheada em localStorage.
 */
function resolveObraId() {
  const qs = new URL(location.href).searchParams;
  const obraQS = qs.get('obra') || '';
  const obraLS = localStorage.getItem('obraId') || '';
  const obra   = obraQS || obraLS;
  if (obraQS) { try { localStorage.setItem('obraId', obraQS); } catch {} }
  return obra;
}

/**
 * Deduplica preservando ordem de aparição.
 */
function dedupeKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = String(s);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/**
 * Normaliza a estrutura do fvs-list_by_obra.json (esperada):
 * [
 *   { "alvo_id": "OBRA_ID", "fvs": ["FVS 07.01 ...", ...] },
 *   ...
 * ]
 * Retorna: array de strings (FVS) já deduplicadas e na ordem dos blocos.
 */
function normalizeFvsForObra(raw, obraId) {
  if (!obraId || !Array.isArray(raw)) return [];
  const chunks = raw.filter(x => x && typeof x === 'object' && x.alvo_id === obraId);
  if (chunks.length === 0) return [];
  const flat = [];
  for (const c of chunks) {
    if (Array.isArray(c.fvs)) {
      for (const item of c.fvs) flat.push(String(item));
    }
  }
  return dedupeKeepOrder(flat);
}

/**
 * Carrega todos os arquivos necessários em paralelo.
 * - layout-3d.json e apartamentos.json são por obra: ./data/{obra}/...
 * - fvs-list_by_obra.json é ÚNICO: ./data/fvs-list_by_obra.json (contém todas as obras)
 * - Sem fallback para fvs-list.json.
 */
export async function loadAllData() {
  const obra = resolveObraId();

  // Se não houver obra definida, zera e sai (HUD pode abrir modal de seleção).
  if (!obra) {
    layoutData   = { placements: [], meta: {} };
    fvsList      = [];
    apartamentos = [];
    return;
  }

  const base        = `./data/${obra}`;
  const layoutUrl   = `${base}/layout-3d.json`;
  const aptsUrl     = `${base}/apartamentos.json`;
  const fvsAllUrl   = `./data/fvs-list_by_obra.json`; // <<< único arquivo global

  try {
    // Fazemos as 3 requisições em paralelo
    const [layoutResp, aptsResp, fvsResp] = await Promise.allSettled([
      fetch(layoutUrl, { cache: 'no-store' }),
      fetch(aptsUrl,   { cache: 'no-store' }),
      fetch(fvsAllUrl, { cache: 'no-store' })
    ]);

    // Layout
    if (layoutResp.status === 'fulfilled' && layoutResp.value.ok) {
      layoutData = await layoutResp.value.json();
    } else {
      console.error('[data] layout-3d.json não encontrado para a obra:', obra);
      layoutData = { placements: [], meta: {} };
    }

    // Apartamentos
    if (aptsResp.status === 'fulfilled' && aptsResp.value.ok) {
      const aptsRaw = await aptsResp.value.json();
      apartamentos = Array.isArray(aptsRaw) ? aptsRaw : [];
    } else {
      console.error('[data] apartamentos.json não encontrado para a obra:', obra);
      apartamentos = [];
    }

    // FVS (arquivo único; filtrado por alvo_id === obra)
    if (fvsResp.status === 'fulfilled' && fvsResp.value.ok) {
      const fvsRawAll = await fvsResp.value.json();
      fvsList = normalizeFvsForObra(fvsRawAll, obra);
    } else {
      console.error('[data] fvs-list_by_obra.json não encontrado na pasta ./data');
      fvsList = [];
    }
  } catch (err) {
    console.error('[data] erro ao carregar dados:', err);
    layoutData   = { placements: [], meta: {} };
    fvsList      = [];
    apartamentos = [];
  }
}
