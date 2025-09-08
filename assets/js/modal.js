// ============================
// Modal (abrir/fechar + conteúdo + tint) — idêntico ao viewer.html
// ============================

import { formatDateBR, normAptoId, hexToRgba, extractBetweenPavimentoAndNextDash } from './utils.js';
import { State } from './state.js';

let backdrop, modal, titleEl, pillEl, contentEl, closeBtn;
let lastFocused = null;

// protege contra “clique fantasma” ao abrir
let _modalJustOpenedAt = 0;

// 🔒 trava global de input enquanto o modal está aberto
function setInputLock(on) {
  if (!window.DOGE) window.DOGE = {};
  window.DOGE.inputLocked = !!on;
}
function getCanvas(){
  return document.getElementById('doge-canvas') || document.querySelector('#app canvas');
}
function releaseAllCanvasCaptures() {
  const cvs = getCanvas();
  const dbg = window.DOGE?.__inputDbg;
  if (!cvs || !dbg) return;
  if (dbg.captures && cvs.releasePointerCapture) {
    for (const id of Array.from(dbg.captures)) {
      try { cvs.releasePointerCapture(id); } catch {}
    }
    dbg.captures.clear?.();
  }
  // limpa ponteiros em movimento no viewer para não “acordarem” depois
  try { dbg.pointers?.clear?.(); } catch {}
}

// ---------------
// Inicialização
// ---------------
export function initModal(){
  backdrop  = document.getElementById('doge-modal-backdrop');
  modal     = document.getElementById('doge-modal');
  titleEl   = document.getElementById('doge-modal-title');
  pillEl    = document.getElementById('doge-modal-pill');
  contentEl = document.getElementById('doge-modal-content');
  closeBtn  = document.getElementById('doge-modal-close');

  if (!backdrop || !modal) return;

  closeBtn?.addEventListener('click', closeModal, { passive:true });
  backdrop.addEventListener('click', (e)=>{ if (e.target === backdrop) closeModal(); }, { passive:true });

  document.addEventListener('keydown', (e)=>{
    if (e.key === 'Escape' && backdrop.classList.contains('show')){
      e.stopPropagation();
      closeModal();
    }
  });

  // trap de foco simples dentro do modal
  document.addEventListener('keydown', (e)=>{
    if (!backdrop.classList.contains('show')) return;
    if (e.key !== 'Tab') return;
    const focusables = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length-1];
    if (e.shiftKey && document.activeElement === first){ last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last){ first.focus(); e.preventDefault(); }
  });

  // --- Bloqueio de “clique fantasma” nos primeiros ~400ms após abrir ---
  function suppressGhostClick(e){
    if (!backdrop.classList.contains('show')) return;
    const dt = performance.now() - _modalJustOpenedAt;
    if (dt < 400){
      e.stopPropagation();
      e.preventDefault();
    }
  }
  backdrop.addEventListener('click',        suppressGhostClick, true);
  // Qualquer botão/link com semântica de cancel deve fechar o modal
modal.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-modal-cancel], .js-modal-cancel, #doge-modal-cancel, [data-dismiss="modal"]');
  if (!el) return;
  e.preventDefault();
  closeModal();
}, { passive: false });

  backdrop.addEventListener('pointerdown',  suppressGhostClick, true);
  modal.addEventListener('pointerdown',     suppressGhostClick, true);
}

// ---------------
// API pública
// ---------------
export function openAptModal({ id, floor=null, row=null, tintHex=null }){
  if (!modal || !backdrop) return;

  lastFocused = document.activeElement;

  const aptName = String(id || '').trim();
  const aptKey  = normAptoId(aptName);

  // Título (regra Pavimento XX - ... - ... )
  const aptNameForTitle = extractBetweenPavimentoAndNextDash(aptName) || 'Apartamento';
  titleEl.textContent = aptNameForTitle;

  // Pill curto
  const pill = buildHeaderPill(row);
  pillEl.textContent = pill;

  // Tint
  if (!tintHex){
    tintHex = State.COLOR_MAP?.colors?.[aptKey] || State.COLOR_MAP?.default || '#6e7681';
  }
  applyModalTint(tintHex);

  // Conteúdo
  renderModalContent({ row });

  // --- Antes de mostrar: desabilita canvas e SOLTA CAPTURES existentes
  const canvas = getCanvas();
  if (canvas) {
    canvas.style.pointerEvents = 'none';
    releaseAllCanvasCaptures();
  }

  // Mostrar
  backdrop.classList.add('show');
  backdrop.setAttribute('aria-hidden','false');
  setInputLock(true); // 🔒 trava input no viewer enquanto aberto

  setTimeout(()=> closeBtn?.focus(), 0);

  // 🔒 Bloquear eventos por 2 frames para matar click fantasma
  _modalJustOpenedAt = performance.now();
  backdrop.style.pointerEvents = 'none';
  modal.style.pointerEvents = 'none';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    backdrop.style.pointerEvents = 'auto';
    modal.style.pointerEvents = 'auto';
  }));
}

export function closeModal(){
  if (!backdrop) return;

  backdrop.classList.remove('show');
  backdrop.setAttribute('aria-hidden','true');

  // reabilita canvas 3D e garante que não restou capture
  const canvas = getCanvas();
  if (canvas) {
    canvas.style.pointerEvents = 'auto';
    releaseAllCanvasCaptures();
  }
  setInputLock(false); // 🔓 libera input do viewer

  if (lastFocused && typeof lastFocused.focus === 'function'){
    setTimeout(()=> lastFocused.focus(), 0);
  }
}

/** Aplica tonalidade ao modal via CSS vars (igual viewer.html) */
export function applyModalTint(hex){
  if (!modal) return;
  modal.style.setProperty('--modal-tint-strong', hexToRgba(hex, 0.20));
  modal.style.setProperty('--modal-tint-soft',   hexToRgba(hex, 0.10));
  modal.style.setProperty('--modal-border',      hexToRgba(hex, 0.28));
}

// ---------------
// Renderização (markup idêntico ao viewer.html)
// ---------------
function renderModalContent({ row }){
  if (!contentEl) return;

  if (!row){
    pillEl.textContent = '';
    contentEl.innerHTML = `<p>Sem dados para este apartamento.</p>`;
    return;
  }

  const pct        = num(row.percentual_ultima_inspecao);
  const pendUlt    = int(row.qtd_pend_ultima_inspecao);
  const ncUlt      = int(row.qtd_nao_conformidades_ultima_inspecao);
  const durReal    = int(row.duracao_real);
  const durIni     = int(row.duracao_inicial);
  const durReab    = int(row.duracao_reaberturas);

  const dataAbert  = row.data_abertura ? formatDateBR(row.data_abertura) : '—';
  const terminoIni = row.data_termino_inicial ? formatDateBR(row.data_termino_inicial) : null;
  const terminoFin = row.termino_final ? formatDateBR(row.termino_final) : null;

  pillEl.textContent = (row.duracao_real != null)
    ? `Duração: ${int(row.duracao_real)} dia${int(row.duracao_real)===1 ? '' : 's'}`
    : (row.percentual_ultima_inspecao != null ? `Progresso: ${int(row.percentual_ultima_inspecao)}%` : '');

  const idLink  = row.id_ultima_inspecao || row.id;
  const inmetaUrl = idLink
    ? `https://app.inmeta.com.br/app/360/servico/inspecoes/realizadas?inspecao=${encodeURIComponent(idLink)}`
    : null;

  let progressColorCSS = null;
  if (Number.isFinite(pct)) {
    if (!row.data_termino_inicial) progressColorCSS = 'var(--blue)';
    else if ((pendUlt > 0) || (ncUlt > 0) || pct < 100) progressColorCSS = 'var(--yellow)';
    else progressColorCSS = 'var(--green)';
  }
  const progressMarkup = (Number.isFinite(pct) && progressColorCSS)
    ? linearProgress(pct, progressColorCSS)
    : '';

  const reabArr = Array.isArray(row.reaberturas) ? row.reaberturas.slice() : [];
  if (reabArr.length){
    reabArr.sort((a,b)=>{
      const na = Date.parse(a?.data_abertura ?? '') || 0;
      const nb = Date.parse(b?.data_abertura ?? '') || 0;
      if (na !== nb) return na - nb;
      return String(a.codigo ?? '').localeCompare(String(b.codigo ?? ''), 'pt-BR', { numeric:true });
    });
  }

  let html = '';
  html += `<p><strong>Apartamento:</strong> ${row?.nome ?? row?.apartamento ?? '—'}</p>`;
  if (row.pavimento_origem){
    html += `<p><strong>Pavimento origem:</strong> ${row.pavimento_origem}</p>`;
  }
  html += `<p><strong>Início:</strong> ${dataAbert}</p>`;
  if (terminoIni){
    html += `<p><strong>Término:</strong> ${terminoIni}</p>`;
  }

  html += `<p class="line-progress">
            <span><strong>Duração inicial:</strong> ${safeNum(durIni)}</span>
            ${progressMarkup}
          </p>`;

  if (reabArr.length){
    html += `<hr><table><tr><th>Código</th><th>Data Abertura</th><th>Pendências</th><th>Não conformidades</th></tr>`;
    reabArr.forEach(r=>{
      html += `<tr>
        <td>${r.codigo ?? '-'}</td>
        <td>${formatDateBR(r.data_abertura)}</td>
        <td>${r.qtd_itens_pendentes ?? '-'}</td>
        <td>${r.qtd_nao_conformidades ?? '-'}</td>
      </tr>`;
    });
    html += `</table>`;
    html += `<p><strong>Duração reinspeções:</strong> ${safeNum(durReab)}</p>`;
  }

  if (inmetaUrl){
    html += `
      <p>
        <a class="link-row" href="${inmetaUrl}" target="_blank" rel="noopener noreferrer">
          <span><strong>Última inspeção:</strong> código ${row.codigo_ultima_inspecao ?? row.codigo ?? '—'} |
          Pendências ${pendUlt ?? '-'}${(ncUlt!=null)?` | NC ${ncUlt}`:''}</span>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1-2-2h6"/>
          </svg>
        </a>
      </p>`;
  } else {
    html += `<p><strong>Última inspeção:</strong> código ${row.codigo_ultima_inspecao ?? row.codigo ?? '—'} | Pendências ${pendUlt ?? '-'}${(ncUlt!=null)?` | NC ${ncUlt}`:''}</p>`;
  }

  html += `<p><strong>Duração total:</strong> ${safeNum(durReal)}</p>`;
  if (terminoFin){
    html += `<p><strong>Término final:</strong> ${terminoFin}</p>`;
  }

  contentEl.innerHTML = html;

  animateProgressBars(contentEl);
}

// ---------------
// Helpers (iguais ao viewer)
// ---------------
function buildHeaderPill(row){
  if (!row) return '';
  if (row.duracao_real != null){
    const d = int(row.duracao_real);
    return `Duração: ${d} dia${d===1 ? '' : 's'}`;
  }
  if (row.percentual_ultima_inspecao != null){
    const p = int(row.percentual_ultima_inspecao);
    return `Progresso: ${p}%`;
  }
  return '';
}

function linearProgress(percent, colorCSSVar){
  const p = Math.max(0, Math.min(100, Math.round(Number(percent)||0)));
  return `
    <span class="q-linear-progress" style="color:${colorCSSVar}">
      <span class="q-linear-progress__track">
        <span class="q-linear-progress__bar" data-w="${p}%"></span>
      </span>
      <span class="q-linear-progress__label">${p}%</span>
    </span>`;
}

function animateProgressBars(root=document){
  const bars = root.querySelectorAll('.q-linear-progress__bar[data-w]');
  requestAnimationFrame(()=> bars.forEach(b => { b.style.width = b.dataset.w; }));
}

function num(v){
  if (v==null || v==='') return NaN;
  const s = String(v).replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : Number(s);
}
function int(v){
  const n = num(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function safeNum(v){ return (v==null || v==='') ? '—' : int(v); }
