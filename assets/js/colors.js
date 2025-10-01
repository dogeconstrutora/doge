// ============================
// Regras de cor / Color Map
// ============================

import { normNameKey, clamp } from './utils.js';
import { State } from './state.js';

export const COLOR_DEFAULT = '#6b7280';  // cinza neutro (tema dark)
export const PALETTE = {
  green:  '#3fb950',
  yellow: '#e3b341',
  orange: '#f0883e',
  red:    '#f85149',
  blue:   '#4493f8',
  gray:   COLOR_DEFAULT
};

// ------------------------------------------------------------------
// Heurísticas de status -> cor
// Campos usuais: percentual_ultima_inspecao, qtd_pend_ultima_inspecao,
// qtd_nao_conformidades_ultima_inspecao, data_termino_inicial, pavimento_origem.
// ------------------------------------------------------------------

// === NORMAL ===
// === NORMAL ===
export function colorFromRowNormal(row) {
  if (!row) {
    //console.log('[colorFromRowNormal] Row is null or undefined, returning gray');
    return PALETTE.gray;
  }

  const nc = Number(row?.qtd_nao_conformidades_ultima_inspecao ?? 0) || 0;
  const pend = Number(row?.qtd_pend_ultima_inspecao ?? 0) || 0;
  const pct = Number(row?.percentual_ultima_inspecao ?? 0) || 0;
  const terminouInicial = !!row?.data_termino_inicial;
  const key = String(row?.local_origem ?? row?.nome ?? '').trim();

  //console.log(`[colorFromRowNormal] key=${key}, nc=${nc}, pend=${pend}, pct=${pct}, terminouInicial=${terminouInicial}`);

  // Em andamento → azul (ainda não tem término inicial)
  if (!terminouInicial) {
    //console.log(`[colorFromRowNormal] key=${key}, not finished, returning blue`);
    return PALETTE.blue;
  }

  // Concluído 100% sem pend/NC → verde; senão → amarelo
  const ultimaOK = (pct === 100 && pend === 0 && nc === 0);
  //console.log(`[colorFromRowNormal] key=${key}, ultimaOK=${ultimaOK}, returning ${ultimaOK ? 'green' : 'yellow'}`);
  return ultimaOK ? PALETTE.green : PALETTE.yellow;
}

// === MODO NC ===
export function colorFromRowNC(row) {
  const nc = Number(row?.qtd_nao_conformidades_ultima_inspecao ?? 0) || 0;
  return (nc > 0) ? PALETTE.red : COLOR_DEFAULT; // sem NC → neutro
}

// === MODO EM ANDAMENTO ===
export function colorFromRowInProgress(row) {
  if (!row) {
    //console.log('[colorFromRowInProgress] Row is null or undefined, returning gray');
    return PALETTE.gray;
  }

  const nc = Number(row?.qtd_nao_conformidades_ultima_inspecao ?? 0) || 0;
  const pend = Number(row?.qtd_pend_ultima_inspecao ?? row?.pendencias ?? 0) || 0;
  const pct = Number(row?.percentual_ultima_inspecao ?? 0) || 0;
  const terminouInicial = !!row?.data_termino_inicial;
  const key = String(row?.local_origem ?? row?.nome ?? '').trim();

  //console.log(`[colorFromRowInProgress] key=${key}, nc=${nc}, pend=${pend}, pct=${pct}, terminouInicial=${terminouInicial}`);

  if (nc > 0) {
    //console.log(`[colorFromRowInProgress] key=${key}, NC > 0, returning red`);
    return PALETTE.red; // Vermelho para NC
  }
  if (!terminouInicial) {
    //console.log(`[colorFromRowInProgress] key=${key}, not finished, returning blue`);
    return PALETTE.blue; // Azul para em andamento (mesmo com pendências)
  }
  if (pend > 0 || pct < 100) {
    //console.log(`[colorFromRowInProgress] key=${key}, pend > 0 or pct < 100, returning yellow`);
    return PALETTE.yellow; // Amarelo para pendências ou incompleto
  }
  //console.log(`[colorFromRowInProgress] key=${key}, finalized perfectly, returning gray`);
  return COLOR_DEFAULT; // Cinza para finalizados perfeitos
}
// ------------------------------------------------------------------
// Color map por FVS (NORMAL)
// Agora a chave principal é `local_origem` (quando disponível), com
// fallback para `nome` (layout-3d.json), depois `apartamento`/apto/id/name.
// ------------------------------------------------------------------
export function buildColorMapForFVS(rows){
  const map = { default: COLOR_DEFAULT, colors: {} };
  if (!Array.isArray(rows)) return map;

  for (const r of rows){
    const key = String((r?.local_origem ?? r?.nome ?? '')).trim();
    if (!key) continue;
    map.colors[key] = colorFromRowNormal(r);
  }
  return map;
}

// ------------------------------------------------------------------
// Color map por FVS (NC)
// Também prioriza `local_origem` na chave.
// ------------------------------------------------------------------
export function buildColorMapForFVS_NC(rows){
  const map = { default: COLOR_DEFAULT, colors: {} };
  if (!Array.isArray(rows)) return map;

  for (const r of rows){
    const key = String((r?.local_origem ?? r?.nome ?? '')).trim();
    if (!key) continue;
    map.colors[key] = colorFromRowNC(r);
  }
  return map;
}

// ------------------------------------------------------------------
// Color map por FVS (EM ANDAMENTO)
// Prioriza `local_origem` na chave.
// ------------------------------------------------------------------
export function buildColorMapForFVS_InProgress(rows) {
  const map = { default: COLOR_DEFAULT, colors: {} };
  if (!Array.isArray(rows)) return map;

  for (const r of rows) {
    const key = String((r?.local_origem ?? r?.nome ?? '')).trim();
    if (!key) continue;
    map.colors[key] = colorFromRowInProgress(r);
  }
  return map;
}

// ------------------------------------------------------------------
// Seleção de cor por Apto/Floor usando COLOR_MAP atual do State
// `aptoName` aqui é o nome do layout-3d.json (campo `nome`) —
// que deve bater com `local_origem` normalizado no color map.
// ------------------------------------------------------------------
export function pickFVSColor(aptoName, _floorStr = null, colorMap = State.COLOR_MAP){
  if (!colorMap) return COLOR_DEFAULT;

  const raw = String(aptoName || '').trim();
  if (!raw) return colorMap.default || COLOR_DEFAULT;

  const parts = raw.split(/\s*-\s*/g).map(s => s.trim()).filter(Boolean);
  for (let n = parts.length; n >= 1; n--){
    const key = parts.slice(0, n).join(' - ');
    const hit = colorMap.colors && colorMap.colors[key];
    if (hit) return hit;
  }
  return colorMap.default || COLOR_DEFAULT;
}

// ------------------------------------------------------------------
// Utilitários de cor
// ------------------------------------------------------------------
const ORDER = [PALETTE.red, PALETTE.orange, PALETTE.yellow, PALETTE.green, PALETTE.blue, PALETTE.gray];
function worstColor(prev, next){
  if (!prev) return next;
  const pi = ORDER.indexOf(prev);
  const ni = ORDER.indexOf(next);
  if (pi === -1) return next;
  if (ni === -1) return prev;
  // "pior" é o menor índice (vermelho domina)
  return (ni < pi) ? next : prev;
}

export function hexToRgb(hex){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 110, g: 118, b: 129 }; // gray fallback
  return { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) };
}

export function tintFromColor(hex, alpha=0.18){
  const {r,g,b} = hexToRgb(hex);
  const a = clamp(alpha, 0, 1);
  return `rgba(${r},${g},${b},${a})`;
}