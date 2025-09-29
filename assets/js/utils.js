// ============================
// Utils gerais do Viewer DOGE
// ============================

// Clamp genérico
export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Normalização ÚNICA de chaves de apartamento/unidade
 * Prioriza o 'nome' do layout-3d.json, mas serve para qualquer string.
 * Estratégia:
 *  - trim
 *  - remove acentos (NFD)
 *  - uppercase
 *  - remove tokens comuns (APARTAMENTO|APTO|AP|APT|APART)
 *  - remove separadores comuns (espaço, -, ., _, /)
 */
export function normNameKey(s){
  if (s == null) return '';
  let t = String(s).trim().toUpperCase();
  // remove acentos
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  // remove tokens comuns de identificação
  t = t.replace(/\b(APARTAMENTO|APTO|APT|AP|APART)\b\.?/g, '');
  // remove separadores
  t = t.replace(/[\s\-\._\/]/g, '');
  return t;
}

/**
 * Normalização de IDs de apartamentos (retrocompat)
 * Agora delega para normNameKey para que todo o projeto
 * passe a falar a mesma "língua" (nome do layout).
 */
export function normAptoId(s) {
  return normNameKey(s);
}

// Atalhos de compatibilidade (se alguém chamar pelo nome antigo)
export const normAptoKey = normAptoId;
export const normApto    = normAptoId;

// === Hierarquia EXATA (compartilhada pelo 2D e 3D) ===
export function splitHierarchy(name){
  return String(name||'')
    .split(/\s*-\s*/g)     // só quebra por " - "
    .map(s => s.trim())
    .filter(Boolean);
}

export function joinHierarchy(parts, n){
  return parts.slice(0, n).join(' - ');
}

/**
 * Busca a melhor linha por hierarquia **EXATA**:
 * tenta o nome completo; se não achar, remove o último termo e tenta de novo.
 * (Sem normalização/sinônimos; apenas trim e quebra por " - ")
 */
export function bestRowForName(rawName, mapByName){
  const parts = splitHierarchy(rawName);
  for (let n = parts.length; n >= 1; n--){
    const key = joinHierarchy(parts, n);
    if (mapByName.has(key)) return mapByName.get(key);
  }
  return null;
}

/**
 * Verifica se o fullName matcha o prefixo hierárquico (subindo partes).
 * Ex.: prefix "Torre - Pavimento 25 - " matcha "Torre - Pavimento 25 - Apto 2501".
 */
export function isHierarchyMatch(fullName, prefix) {
  const fullParts = splitHierarchy(fullName);
  const prefixParts = splitHierarchy(prefix);
  if (prefixParts.length > fullParts.length) return false;
  for (let i = 0; i < prefixParts.length; i++) {
    if (prefixParts[i] !== fullParts[i]) return false;
  }
  return true;
}

export function extractBetweenPavimentoAndNextDash(full){
  if (!full) return '';
  const re = /Pavimento\s+\d+\s*-\s*([^-\n\r]+)(?:\s*-\s*.*)?/i;
  const m = String(full).match(re);
  return m ? m[1].trim() : String(full).trim();
}

/**
 * Normaliza CHAVE de FVS (para dropdown/lookup estável)
 * Estratégia:
 *  - trim
 *  - remove acentos (NFD)
 *  - uppercase
 *  - remove tudo que não é A–Z ou 0–9
 */
export function normFVSKey(s){
  if (s == null) return '';
  let t = String(s).trim().toUpperCase();
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  t = t.replace(/[^A-Z0-9]+/g, '');
  return t;
}

/**
 * Extrai a melhor chave possível de um objeto de dados.
 * Ordem de preferência: nome → apartamento → apto → id → name
 * Usa o normalizador único (normNameKey).
 */
export function keyFromAny(obj){
  if (!obj) return '';
  return String((obj.local_origem ?? obj.nome ?? '')).trim();
}



// Formatação de data (yyyy-mm-dd → dd/mm/yyyy)
export function formatDateBR(dateStr){
  if(!dateStr) return "";
  const parts = String(dateStr).split('-');
  if(parts.length<3) return dateStr;
  const yyyy = parseInt(parts[0],10);
  const mm = parseInt(parts[1],10)-1;
  const dd = parseInt(parts[2].substring(0,2),10);
  const d = new Date(yyyy,mm,dd);
  if(isNaN(d)) return dateStr;
  return `${String(dd).padStart(2,'0')}/${String(mm+1).padStart(2,'0')}/${yyyy}`;
}

// Tooltip helpers (reutilizáveis)
let tipEl = null;
let tipVisible = false;
let tipHideTO = null;

export function initTooltip(){
  tipEl = document.getElementById('doge-tip');
}

export function showTip(x, y, text){
  if (!tipEl) return;
  tipEl.textContent = text || '';
  if (!text) { hideTip(); return; }

  // posiciona (protege bordas)
  const pad = 10;
  const W = innerWidth, H = innerHeight;
  let tx = Math.max(pad, Math.min(W - pad, x));
  let ty = Math.max(pad, Math.min(H - pad, y));
  tipEl.style.left = tx + 'px';
  tipEl.style.top  = ty + 'px';

  tipEl.classList.add('show');
  tipEl.setAttribute('aria-hidden','false');
  tipVisible = true;

  if (tipHideTO) { clearTimeout(tipHideTO); tipHideTO = null; }
}

export function hideTip(delay=0){
  if (!tipEl || !tipVisible) return;
  if (tipHideTO) clearTimeout(tipHideTO);
  tipHideTO = setTimeout(()=>{
    tipEl.classList.remove('show');
    tipEl.setAttribute('aria-hidden','true');
    tipVisible = false;
  }, delay);
}

/**
 * Converte cor HEX (#RGB/#RRGGBB) ou rgb/rgba(...) para rgba(..., alpha)
 */
export function hexToRgba(hex, alpha = 1){
  if (!hex) return `rgba(0,0,0,${alpha})`;
  let c = String(hex).trim();

  // aceita rgba(...) direto
  const m = c.match(/^rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m){
    const r = +m[1], g = +m[2], b = +m[3];
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // normaliza #RGB ou #RRGGBB
  c = c.replace('#','');
  if (c.length === 3) c = c.split('').map(ch => ch+ch).join('');
  const n = parseInt(c, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;

}
