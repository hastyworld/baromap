// 검증 결과 목록(05 3절): 심각도별 개수·거르기·근거 도면 조각(시트 그림에서 근거 상자 부분을 잘라 빨간 상자로)·해결/무시/수정 요청/AI 다시 검토.
// 3D 보기(06)의 오른쪽 패널로도 쓰고(createFindingsPanel), 도서 관리에서 전체 화면으로도 연다(openFindings).
import { store } from '../ctx.js';
import { addDrawingsTool, drawingsState } from '../drawings.js';
import { openSheetViewer } from './sheet-viewer.js';
import { unpackSheet } from '../cad/flatten.js';
import { drawItems, drawHighlights } from '../cad/render.js';
import { KIND_LABEL, SEVERITY } from './checks.js';
import { $, esc, icon, onAction, onForm, openModal, closeModal, toast } from '../util.js';

const SEV_LABEL = { error: '오류', warn: '경고', info: '정보' };
const STATUS_LABEL = { open: '열림', resolved: '해결됨', ignored: '무시' };
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const geomCache = new Map(); // sheetId → flat
let reviewHandler = null; // 07 수정 요청 창 열기(검증 결과로 채워서)
export const setReviewHandler = (fn) => { reviewHandler = fn; };

async function sheetsOf(model) {
  if (!model?.setId) return [];
  return store.drawings.cachedSheets(model.setId) || store.drawings.sheets(model.setId).catch(() => []);
}
async function flatOf(sheet) {
  if (!geomCache.has(sheet.id)) geomCache.set(sheet.id, store.drawings.sheetAsset(sheet, 'geom').then(unpackSheet).catch(() => null));
  return geomCache.get(sheet.id);
}

// 근거 도면 조각: bbox 둘레를 넉넉히 잘라 그리고 빨간 상자
export async function drawCrop(canvas, sheet, bbox) {
  const flat = await flatOf(sheet);
  if (!flat || !canvas.isConnected) return;
  const f = flat.frame;
  const fw = f.x1 - f.x0;
  const fh = f.y1 - f.y0;
  let b = bbox ? [bbox.x0, bbox.y0, bbox.x1, bbox.y1] : [f.x0, f.y0, f.x1, f.y1];
  const w = Math.max(b[2] - b[0], fw * 0.04);
  const h = Math.max(b[3] - b[1], fh * 0.04);
  const pad = bbox ? Math.max(w, h) * 1.2 : 0;
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const W = canvas.width;
  const H = canvas.height;
  const scale = Math.min(W / (w + pad * 2), H / (h + pad * 2));
  const view = { frame: { x0: cx - W / 2 / scale, y0: cy - H / 2 / scale, x1: cx + W / 2 / scale, y1: cy + H / 2 / scale }, scale, width: W, height: H };
  const ctx = canvas.getContext('2d');
  drawItems(ctx, flat.items, view, { dark: dark() });
  if (bbox) drawHighlights(ctx, view, [b], { width: 2 });
}

/**
 * @param {HTMLElement} el
 * @param {{ siteId: string, model: any, onSelect?: (f: any) => void, compact?: boolean }} opts
 */
export function createFindingsPanel(el, { siteId, model, onSelect = null, compact = false }) {
  const st = { sev: '', status: 'open', kind: '', q: '', sel: null, sheets: [] };
  let alive = true;
  const editable = () => store.can('edit', siteId);
  const list = () => store.bim.cachedFindings(model.id) || [];
  const sheetById = (id) => st.sheets.find((s) => s.id === id);
  (async () => {
    st.sheets = await sheetsOf(model);
    if (!store.bim.cachedFindings(model.id)) await store.bim.findings(model.id).catch(() => {});
    if (alive) render();
  })();
  const unsub = store.subscribe(() => { if (alive && !el.contains(document.activeElement)) render(); });

  function filtered() {
    const q = st.q.trim().toLowerCase();
    return list().filter((f) => (!st.sev || f.severity === st.sev) && (st.status === 'all' || f.status === st.status) && (!st.kind || f.kind === st.kind) && (!q || f.message.toLowerCase().includes(q)))
      .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.kind.localeCompare(b.kind));
  }

  function render() {
    const all = list();
    const open = all.filter((f) => f.status === 'open');
    const c = { error: 0, warn: 0, info: 0 };
    for (const f of open) c[f.severity]++;
    const kinds = [...new Set(all.map((f) => f.kind))].sort();
    const items = filtered();
    el.innerHTML = `<div class="fd-head">
        <div class="fd-counts" role="tablist" aria-label="심각도">
          ${[['', `전체 ${open.length}`], ['error', `오류 ${c.error}`], ['warn', `경고 ${c.warn}`], ['info', `정보 ${c.info}`]].map(([k, l]) => `<button type="button" role="tab" class="fd-sev ${k || 'all'} ${st.sev === k ? 'on' : ''}" aria-selected="${st.sev === k}" data-fd-sev="${k}">${l}</button>`).join('')}
        </div>
        <div class="fd-filters">
          <select data-fd-status aria-label="처리 상태">${[['open', '열림'], ['resolved', '해결됨'], ['ignored', '무시'], ['all', '전체 상태']].map(([k, l]) => `<option value="${k}" ${st.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${kinds.length > 1 ? `<select data-fd-kind aria-label="종류"><option value="">종류 전체</option>${kinds.map((k) => `<option value="${esc(k)}" ${st.kind === k ? 'selected' : ''}>${esc(KIND_LABEL[k] || k)}</option>`).join('')}</select>` : ''}
          ${compact ? '' : `<input type="search" data-fd-q placeholder="내용으로 찾기" value="${esc(st.q)}" aria-label="검증 결과 찾기">`}
        </div>
      </div>
      <ul class="fd-list">${items.map(itemHtml).join('') || `<li class="fd-empty muted small">${all.length ? '조건에 맞는 항목이 없습니다.' : '검증 결과가 없습니다.'}</li>`}</ul>`;
    for (const cv of el.querySelectorAll('canvas[data-crop]')) {
      const f = all.find((x) => x.id === cv.dataset.crop);
      const e = f?.evidence?.[Number(cv.dataset.ev)];
      const sh = e && sheetById(e.sheetId);
      if (sh) drawCrop(cv, sh, e.bbox);
    }
  }

  function itemHtml(f) {
    const evs = (f.evidence || []).filter((e) => sheetById(e.sheetId)).slice(0, compact ? 1 : 3);
    const sel = st.sel === f.id;
    return `<li class="fd-item ${f.severity} ${f.status} ${sel ? 'sel' : ''}">
      <button type="button" class="fd-main" data-fd-pick="${esc(f.id)}" aria-expanded="${sel}">
        <span class="badge ${f.severity === 'error' ? 'crit' : f.severity === 'warn' ? 'warn' : 'info'}">${SEV_LABEL[f.severity]}</span>
        <span class="fd-kind">${esc(KIND_LABEL[f.kind] || f.kind)}${f.source === 'ai' ? ' <small>AI</small>' : f.source === 'doc' ? ' <small>문서</small>' : f.source === 'public' ? ' <small>정부 기록</small>' : ''}${f.status !== 'open' ? ` · ${STATUS_LABEL[f.status]}` : ''}</span>
        <span class="fd-msg">${esc(f.message)}</span>
        ${f.note ? `<span class="fd-note muted small">사유: ${esc(f.note)}</span>` : ''}
      </button>
      ${(f.evidence || []).some((e) => e.docId) ? `<div class="fd-docs">${(f.evidence || []).filter((e) => e.docId).slice(0, 3).map((e) => `<button type="button" class="btn sm ghost" data-act="doc-open" data-id="${esc(e.docId)}" data-page="${esc(e.page ?? 1)}">${icon('file')}${esc(e.docName || '문서')}${e.page ? ` ${esc(e.page)}쪽` : ''}${e.note ? ` · ${esc(e.note)}` : ''}</button>`).join('')}</div>` : ''}
      ${evs.length ? `<div class="fd-evs">${evs.map((e, i) => { const sh = sheetById(e.sheetId); return `<button type="button" class="fd-ev" data-fd-sheet="${esc(f.id)}" data-ev="${i}" title="${esc(sh.sheetNo || '')} ${esc(sh.title || '')} 크게 보기"><canvas data-crop="${esc(f.id)}" data-ev="${i}" width="${compact ? 300 : 240}" height="${compact ? 150 : 150}"></canvas><span>${esc(sh.sheetNo || '도면')}${e.note ? ` · ${esc(e.note)}` : ''}</span></button>`; }).join('')}</div>` : ''}
      ${sel ? `<div class="fd-actions">
        ${f.elementIds?.length ? `<span class="muted small">관련 요소 ${f.elementIds.length}개</span>` : ''}
        ${editable() && f.status === 'open' ? `<button type="button" class="btn sm" data-fd-act="resolved" data-id="${esc(f.id)}">${icon('check')}해결됨</button><button type="button" class="btn sm ghost" data-fd-act="ignored" data-id="${esc(f.id)}">무시</button>` : ''}
        ${editable() && f.status !== 'open' ? `<button type="button" class="btn sm ghost" data-fd-act="open" data-id="${esc(f.id)}">다시 열기</button>` : ''}
        ${editable() && reviewHandler ? `<button type="button" class="btn sm" data-fd-act="review" data-id="${esc(f.id)}">${icon('edit')}수정 요청</button>` : ''}
        ${editable() && store.mode === 'remote' && store.ai.available ? `<button type="button" class="btn sm ghost" data-fd-act="ai" data-id="${esc(f.id)}">${icon('refresh')}AI에게 다시 검토</button>` : ''}
      </div>` : ''}
    </li>`;
  }

  const onClick = async (e) => {
    const t = e.target.closest('[data-fd-sev],[data-fd-pick],[data-fd-sheet],[data-fd-act]');
    if (!t || !el.contains(t)) return;
    if (t.dataset.fdSev != null) { st.sev = t.dataset.fdSev; render(); return; }
    if (t.dataset.fdPick) {
      st.sel = st.sel === t.dataset.fdPick ? null : t.dataset.fdPick;
      render();
      const f = list().find((x) => x.id === t.dataset.fdPick);
      if (f && st.sel) onSelect?.(f);
      return;
    }
    if (t.dataset.fdSheet) {
      const f = list().find((x) => x.id === t.dataset.fdSheet);
      const ev = f?.evidence?.[Number(t.dataset.ev)];
      const sh = ev && sheetById(ev.sheetId);
      if (sh) openSheetViewer(sh, { boxes: ev.bbox ? [[ev.bbox.x0, ev.bbox.y0, ev.bbox.x1, ev.bbox.y1]] : [] });
      return;
    }
    const f = list().find((x) => x.id === t.dataset.id);
    if (!f) return;
    const act = t.dataset.fdAct;
    try {
      if (act === 'resolved' || act === 'open') { await store.bim.setFinding(f.id, act); render(); }
      else if (act === 'ignored') ignoreDialog(f);
      else if (act === 'review') reviewHandler?.({ finding: f, model, siteId });
      else if (act === 'ai') {
        t.disabled = true;
        toast('AI에게 이 항목을 다시 검토하게 했습니다. 잠시 걸립니다.');
        await store.ai.call('ai-review', { modelId: model.id, findingId: f.id });
        await store.bim.findings(model.id);
        toast('AI 검토를 마쳤습니다.');
      }
    } catch (err) { toast(err.message, 'crit'); }
  };
  const onChange = (e) => {
    const t = e.target;
    if (!el.contains(t)) return;
    if (t.matches('[data-fd-status]')) { st.status = t.value; render(); }
    if (t.matches('[data-fd-kind]')) { st.kind = t.value; render(); }
  };
  const onInput = (e) => {
    if (!el.contains(e.target) || !e.target.matches('[data-fd-q]')) return;
    st.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const q = el.querySelector('[data-fd-q]');
    q?.focus();
    q?.setSelectionRange(pos, pos);
  };
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('input', onInput);
  return {
    render,
    select(id) { st.sel = id; st.status = 'all'; render(); el.querySelector('.fd-item.sel')?.scrollIntoView({ block: 'nearest' }); },
    destroy() { alive = false; unsub(); el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); el.removeEventListener('input', onInput); },
  };
}

function ignoreDialog(f) {
  openModal({
    title: '검증 결과 무시',
    body: `<form id="f-ignore" data-form="fd-ignore" novalidate><p class="small">${esc(f.message)}</p>
      <label class="field"><span>무시하는 사유 <em>*</em></span><input name="note" maxlength="500" required placeholder="예) 현장 확인 결과 문제 없음"></label></form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" class="btn primary" form="f-ignore">무시</button>`,
  }).dataset.findingId = f.id;
}
onForm('fd-ignore', async (data) => {
  const id = $('#modal')?.dataset.findingId;
  if (!String(data.note || '').trim()) throw new Error('사유를 입력해주세요.');
  await store.bim.setFinding(id, 'ignored', data.note);
  closeModal(true);
  toast('무시로 표시했습니다.');
});

// ---------------------------------------------------------------- 전체 화면(도서 관리에서)

let fv = null;
let pushed = false;
export async function openFindings(siteId, modelId) {
  closeFindings({ keepHistory: true });
  const versions = store.bim.cachedVersions(siteId) || await store.bim.versions(siteId);
  const model = versions.find((m) => m.id === modelId);
  if (!model) return;
  const el = document.createElement('div');
  el.className = 'board fview';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `검증 결과 v${model.version}`);
  el.innerHTML = `<header class="board-head">
      <button type="button" class="icon-btn" data-act="fv-close" aria-label="닫기" title="닫기">${icon('close')}</button>
      <div class="board-title"><b>검증 결과</b><span>모델 v${model.version} · ${esc(model.note || '')}</span></div>
      <div class="board-tools">${store.can('edit', siteId) && store.mode === 'remote' ? `<button type="button" class="btn sm" data-act="fv-ai" title="그림을 봐야 아는 모순을 AI가 도면끼리 대조해 찾습니다">${icon('refresh')}<span>AI 대조 검토</span></button>` : ''}</div>
    </header>
    <div class="fview-body" id="fv-body"></div>
    <footer class="board-foot">항목을 누르면 근거 도면 조각과 처리 단추가 보입니다. 조각을 누르면 도면을 크게 봅니다.</footer>`;
  document.body.append(el);
  document.body.classList.add('board-open');
  fv = { el, siteId, model, returnFocus: document.activeElement };
  fv.panel = createFindingsPanel($('#fv-body'), { siteId, model });
  if (!pushed) { history.pushState({ baromapFindings: true }, ''); pushed = true; }
  el.querySelector('[data-act="fv-close"]').focus();
}

export function closeFindings({ fromHistory = false, keepHistory = false } = {}) {
  if (!fv) return;
  const v = fv;
  fv = null;
  v.panel?.destroy();
  v.el.remove();
  if (!document.querySelector('.board, .mview, .sview, .bview')) document.body.classList.remove('board-open');
  if (keepHistory) return;
  v.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.back();
  pushed = false;
}

onAction('fv-close', () => closeFindings());
onAction('fv-ai', async (el) => {
  if (!fv) return;
  el.disabled = true;
  const model = fv.model;
  try {
    const { bundles = [] } = await store.ai.call('ai-review', { modelId: model.id });
    if (!bundles.length) { toast('검토할 묶음이 없습니다.'); return; }
    // 이전 AI 검토 결과는 새로 바꾼다(규칙 검사 결과는 그대로)
    await store.bim.saveFindings(model.id, [], { source: 'ai' });
    let added = 0;
    let cost = 0;
    for (let i = 0; i < bundles.length; i++) {
      toast(`AI 대조 검토 ${i + 1}/${bundles.length}: ${bundles[i].label}`);
      const r = await store.ai.call('ai-review', { modelId: model.id, bundle: bundles[i].key });
      added += r?.added || 0;
      cost += Number(r?.costUsd || 0);
      await store.bim.findings(model.id);
    }
    toast(`AI 대조 검토를 마쳤습니다: 새로 찾은 것 ${added}건, 비용 $${cost.toFixed(2)}`);
  } catch (err) { toast(err.message, 'crit'); } finally { el.disabled = false; }
});
window.addEventListener('popstate', () => { if (fv && !history.state?.baromapFindings && !history.state?.baromapSheet) closeFindings({ fromHistory: true }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fv && !$('#modal') && !document.querySelector('.sview')) closeFindings(); });

// 도서 관리 도구 막대: 이 묶음으로 만든 최신 모델의 검증 결과
addDrawingsTool((dv, { set }) => {
  const mid = set.stats?.model?.id;
  if (!mid) return '';
  const list = store.bim.cachedFindings(mid);
  if (!list && !dv.findingsLoading) { dv.findingsLoading = true; queueMicrotask(() => store.bim.findings(mid).catch(() => {}).finally(() => { dv.findingsLoading = false; })); }
  const open = (list || []).filter((f) => f.status === 'open');
  const err = open.filter((f) => f.severity === 'error').length;
  const warn = open.filter((f) => f.severity === 'warn').length;
  return `<button type="button" class="btn sm" data-act="fv-open" data-id="${esc(mid)}">${icon('alert')}검증 <b class="${err ? 't-crit' : ''}">오류 ${err}</b> · 경고 ${warn}</button>`;
});
onAction('fv-open', (el) => { const dv = drawingsState(); if (dv) openFindings(dv.siteId, el.dataset.id); });
