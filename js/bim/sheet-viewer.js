// 시트 보기(전체 화면): 도면 한 장을 확대·이동하고 레이어를 켜고 끄며, 표제란·요약(표·범례)을 본다.
// 근거 상자(빨간 테두리)를 받아 그 자리로 이동한다 — 검증 결과(05)·수정 요청(07)과 공용.
// 그림은 저장해 둔 시트 모양(.geom.json)을 캔버스에 직접 그려 확대해도 선명하다.
import { store } from '../ctx.js';
import { unpackSheet } from '../cad/flatten.js';
import { drawItems, drawHighlights, toSheet, toPixel, FONT_STACK } from '../cad/render.js';
import { CATEGORY_LABEL, CATEGORIES } from '../cad/classify.js';
import { aciColor } from '../cad/geom.js';
import { $, esc, icon, toast, onAction, onForm } from '../util.js';
import { itemVerdict, clusterVerdict, setCluster, countClasses, CLASSES, CLASS_LABEL, WHY_LABEL } from '../cad/triage.js';
import { rememberTriage, OVERLAY } from './triage-run.js';
import { DETAIL_KEYS, detailLabel, scopeText } from './detail-keys.js';
import { parseComposition } from './materials-ko.js';
import { sheetDetailOps } from './details.js';
import { applyPatch } from './validate.js';

// [상세 값] 탭을 여는 판독 종류(38 지시서 4절)
const DETAIL_KINDS = new Set(['SectionDetailExtract', 'ConstructionDetailExtract', 'StructureScheduleExtract']);
const STRUCT_KO = { wall: '벽', slab: '슬래브', column: '기둥', beam: '보', other: '기타' };

const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
let sv = null; // { el, sheet, flat, view, hidden, boxes, canvas, raf, pointers, onSaved }
let pushed = false;

/**
 * @param {any} sheet drawing_sheets 행
 * @param {{ boxes?: number[][], title?: string, onSaved?: (s: any) => void }} [opts] boxes: 시트 좌표 [x0,y0,x1,y1]
 */
export async function openSheetViewer(sheet, { boxes = [], onSaved } = {}) {
  closeSheetViewer({ keepHistory: true });
  const el = document.createElement('div');
  el.className = 'sview';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `${sheet.sheetNo || ''} ${sheet.title || '도면'} 보기`);
  el.innerHTML = `<header class="board-head">
      <button type="button" class="icon-btn" data-act="sv-close" aria-label="닫기" title="닫기">${icon('close')}</button>
      <div class="board-title"><b>${esc(sheet.sheetNo || '도면번호 없음')} ${esc(sheet.title || '')}</b>
        <span>${esc(CATEGORY_LABEL[sheet.category] || '모름')}${sheet.scale ? ` · ${esc(sheet.scale)}` : ''}${sheet.meta?.manual ? ' · 사람이 고침' : sheet.confidence ? ` · 신뢰도 ${Math.round(sheet.confidence * 100)}%` : ''}</span></div>
      <div class="board-tools">
        <button type="button" class="icon-btn" data-act="sv-zoom" data-z="1.4" aria-label="확대" title="확대">${icon('plus')}</button>
        <button type="button" class="icon-btn" data-act="sv-zoom" data-z="0.7" aria-label="축소" title="축소"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>
        <button type="button" class="icon-btn" data-act="sv-fit" aria-label="전체 보기" title="전체 보기">${icon('expand')}</button>
        <button type="button" class="icon-btn sv-panel-btn" data-act="sv-panel" aria-label="정보·레이어" title="정보·레이어">${icon('settings')}</button>
      </div>
    </header>
    <div class="sview-body">
      <div class="sview-stage" id="sv-stage"><canvas id="sv-canvas" aria-label="도면 그림"></canvas><p class="viewer-msg" id="sv-msg">도면을 불러오는 중…</p></div>
      <aside class="sview-side" id="sv-side"></aside>
    </div>`;
  document.body.append(el);
  document.body.classList.add('board-open');
  sv = { el, sheet, flat: null, digest: null, view: null, hidden: new Set(), boxes, raf: 0, pointers: new Map(), onSaved, returnFocus: document.activeElement, tab: 'info' };
  if (!pushed) { history.pushState({ baromapSheet: true }, ''); pushed = true; }
  el.querySelector('[data-act="sv-close"]').focus();
  renderSide();
  const v = sv;
  try {
    const [geom, digest, triage] = await Promise.all([store.drawings.sheetAsset(sheet, 'geom'), store.drawings.sheetAsset(sheet, 'digest').catch(() => null), store.drawings.sheetAsset(sheet, 'triage').catch(() => null)]);
    if (sv !== v) return;
    v.flat = unpackSheet(geom);
    v.digest = digest;
    if (triage?.of?.length === v.flat.items.length) { v.tri = { t: triage, view: 'building', off: new Set(), pick: null }; markVerdicts(); }
    $('#sv-msg')?.remove();
    setupCanvas();
    fit();
    renderSide();
  } catch (err) {
    const m = $('#sv-msg');
    if (m && sv === v) m.textContent = err.message;
  }
}

export function closeSheetViewer({ fromHistory = false, keepHistory = false } = {}) {
  if (!sv) return;
  const v = sv;
  sv = null;
  cancelAnimationFrame(v.raf);
  v.ro?.disconnect();
  v.el.remove();
  if (!document.querySelector('.board, .mview, .dview, .bview')) document.body.classList.remove('board-open');
  if (keepHistory) return;
  v.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.back();
  pushed = false;
}

export const sheetViewerOpen = () => Boolean(sv);

// ---------------------------------------------------------------- 그리기·확대·이동

function setupCanvas() {
  const stage = $('#sv-stage');
  const canvas = $('#sv-canvas');
  sv.canvas = canvas;
  sv.ro = new ResizeObserver(() => { resize(); paint(); });
  sv.ro.observe(stage);
  resize();
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => { const r = canvas.getBoundingClientRect(); zoomAt(2, e.clientX - r.left, e.clientY - r.top); });
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); sv.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); sv.tap = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointermove', (e) => {
    if (!sv || !sv.pointers.has(e.pointerId)) return;
    const prev = sv.pointers.get(e.pointerId);
    const pts = [...sv.pointers.values()];
    if (sv.pointers.size === 1) {
      sv.view.cx -= (e.clientX - prev.x) / sv.view.s;
      sv.view.cy += (e.clientY - prev.y) / sv.view.s;
    } else if (sv.pointers.size === 2) {
      const other = pts.find((p) => p !== prev);
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const r = canvas.getBoundingClientRect();
      if (d0 > 0) zoomAt(d1 / d0, (e.clientX + other.x) / 2 - r.left, (e.clientY + other.y) / 2 - r.top, false);
    }
    sv.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    paint();
  });
  const up = (e) => {
    if (!sv) return;
    sv.pointers.delete(e.pointerId);
    if (sv.tab === 'triage' && sv.tri && sv.tap && Math.hypot(e.clientX - sv.tap.x, e.clientY - sv.tap.y) < 5) { const r = canvas.getBoundingClientRect(); pickAt(e.clientX - r.left, e.clientY - r.top); }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
}

function resize() {
  const stage = $('#sv-stage');
  if (!stage || !sv?.canvas) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  sv.dpr = dpr;
  sv.w = stage.clientWidth || 300;
  sv.h = stage.clientHeight || 200;
  sv.canvas.width = Math.round(sv.w * dpr);
  sv.canvas.height = Math.round(sv.h * dpr);
  sv.canvas.style.width = `${sv.w}px`;
  sv.canvas.style.height = `${sv.h}px`;
}

function fit(box = null) {
  if (!sv?.flat) return;
  const f = sv.flat.frame;
  const [x0, y0, x1, y1] = box || [f.x0, f.y0, f.x1, f.y1];
  const pad = box ? 2.2 : 1.04;
  const s = Math.min(sv.w / ((x1 - x0) * pad || 1), sv.h / ((y1 - y0) * pad || 1));
  sv.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s };
  paint();
}

function zoomAt(k, px, py, repaint = true) {
  const v = sv.view;
  const ns = Math.max(1e-6, Math.min(v.s * k, 400));
  const before = [v.cx + (px - sv.w / 2) / v.s, v.cy - (py - sv.h / 2) / v.s];
  v.s = ns;
  v.cx = before[0] - (px - sv.w / 2) / v.s;
  v.cy = before[1] + (py - sv.h / 2) / v.s;
  if (repaint) paint();
}

function paint() {
  if (!sv?.flat || !sv.view) return;
  cancelAnimationFrame(sv.raf);
  sv.raf = requestAnimationFrame(() => {
    if (!sv?.canvas) return;
    const { cx, cy, s } = sv.view;
    const dpr = sv.dpr;
    const view = {
      frame: { x0: cx - sv.w / 2 / s, y0: cy - sv.h / 2 / s, x1: cx + sv.w / 2 / s, y1: cy + sv.h / 2 / s },
      scale: s * dpr, width: sv.canvas.width, height: sv.canvas.height,
    };
    const ctx = sv.canvas.getContext('2d');
    drawItems(ctx, sv.flat.items, view, { dark: dark(), hidden: sv.hidden, lineWidth: dpr, ...triageView() });
    const pick = sv.tab === 'triage' && sv.tri?.pick;
    if (pick?.box) drawHighlights(ctx, view, [pick.box], { width: 2 * dpr });
    if (sv.boxes.length) drawHighlights(ctx, view, sv.boxes, { width: 3 * dpr });
    if (sv.tab === 'extract') {
      ctx.font = `${11 * dpr}px ${FONT_STACK}`;
      for (const { p, label, c } of extractPoints(sv.sheet.extracted)) {
        const [x, y] = toPixel(view, p[0], p[1]);
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(x, y, 4 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(label, x + 6 * dpr, y - 4 * dpr);
      }
    }
  });
}

// ---------------------------------------------------------------- 옆 패널: 정보(표제란·요약)·레이어·분류 고치기

function layerList() {
  const m = new Map();
  for (const it of sv.flat?.items || []) {
    const l = m.get(it.layer) || { name: it.layer, n: 0, color: it.color };
    l.n++;
    m.set(it.layer, l);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

function renderSide() {
  const side = $('#sv-side');
  if (!side || !sv) return;
  const s = sv.sheet;
  const d = sv.digest;
  const editable = store.can('edit', s.siteId);
  const tabs = `<div class="sv-tabs" role="tablist">
    ${[['info', '표제란·요약'], ['layers', '레이어'], ...(sv.tri ? [['triage', '건물만 보기']] : []), ...(s.extracted?.data ? [['extract', '판독']] : []), ...(DETAIL_KINDS.has(s.extracted?.kind) ? [['detail', '상세 값']] : []), ...(editable ? [['edit', '종류 고치기']] : [])].map(([k, l]) => `<button type="button" role="tab" class="${sv.tab === k ? 'on' : ''}" aria-selected="${sv.tab === k}" data-act="sv-tab" data-tab="${k}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (sv.tab === 'layers') {
    const layers = layerList();
    body = layers.length ? `<div class="sv-layer-tools"><button type="button" class="link small" data-act="sv-layers-all" data-on="1">모두 켜기</button><button type="button" class="link small" data-act="sv-layers-all" data-on="0">모두 끄기</button></div>
      <ul class="sv-layers">${layers.map((l) => `<li><label><input type="checkbox" data-sv-layer="${esc(l.name)}" ${sv.hidden.has(l.name) ? '' : 'checked'}><i style="background:${aciColor(Math.abs(l.color || 7))}"></i><span>${esc(l.name)}</span>${s.layerRoles?.[l.name] ? `<em>${esc(s.layerRoles[l.name])}</em>` : ''}<small>${l.n}</small></label></li>`).join('')}</ul>`
      : '<p class="muted small">불러오는 중…</p>';
  } else if (sv.tab === 'triage') {
    body = triageHtml(editable);
  } else if (sv.tab === 'extract') {
    body = extractHtml(s.extracted);
  } else if (sv.tab === 'detail') {
    body = detailHtml(s, editable);
  } else if (sv.tab === 'edit') {
    const r = s.refs || {};
    body = `<form class="sv-edit" data-form="sv-edit" novalidate>
      <label class="field"><span>도면 종류</span><select name="category">${CATEGORIES.map((c) => `<option value="${c}" ${c === s.category ? 'selected' : ''}>${esc(CATEGORY_LABEL[c])}</option>`).join('')}</select></label>
      <label class="field"><span>도면번호</span><input name="sheetNo" maxlength="40" value="${esc(s.sheetNo)}"></label>
      <label class="field"><span>도면명</span><input name="title" maxlength="200" value="${esc(s.title)}"></label>
      <label class="field"><span>동 <small class="muted">(쉼표로 구분)</small></span><input name="buildings" value="${esc((r.buildings || []).join(', '))}" placeholder="101동, 102동"></label>
      <label class="field"><span>세대 타입</span><input name="unitTypes" value="${esc((r.unitTypes || []).join(', '))}" placeholder="84A"></label>
      <label class="field"><span>층</span><input name="floors" value="${esc((r.floors || []).join(', '))}" placeholder="기준층, 1층"></label>
      <label class="field"><span>시설</span><input name="facility" value="${esc(r.facility || '')}" placeholder="주민공동시설"></label>
      <button type="submit" class="btn primary">${icon('check')}저장</button>
      <p class="muted small">사람이 고친 값은 AI 판독이 덮어쓰지 않습니다.</p>
    </form>`;
  } else {
    const tb = d?.titleBlock || {};
    const tables = d?.tables || [];
    body = `<dl class="kvs sv-kv">
        <div><dt>도면번호</dt><dd>${esc(tb.sheetNo || s.sheetNo || '-')}</dd></div>
        <div><dt>도면명</dt><dd>${esc(tb.title || s.title || '-')}</dd></div>
        <div><dt>축척</dt><dd>${esc(s.scale || d?.scaleText || '-')}</dd></div>
        <div><dt>종류</dt><dd>${esc(CATEGORY_LABEL[s.category] || '모름')}${s.meta?.manual ? ' (사람)' : s.meta?.source === 'ai' ? ' (AI)' : ' (규칙)'}</dd></div>
        ${refsLine(s.refs)}
        <div><dt>단위</dt><dd>${esc(d?.units || '-')}</dd></div>
        <div><dt>개체·글자</dt><dd>${d ? `${d.stats.entities.toLocaleString()}개 · 글자 ${d.stats.textCount.toLocaleString()}개${d.truncated ? ' (요약에서 일부 생략)' : ''}` : '-'}</dd></div>
      </dl>
      ${d?.legend?.length ? `<h4>범례</h4><ul class="sv-legend">${d.legend.slice(0, 40).map((l) => `<li><b>${esc(l.symbol)}</b><span>${esc(l.text)}</span></li>`).join('')}</ul>` : ''}
      ${tables.length ? `<h4>표 ${tables.length}개</h4>${tables.slice(0, 3).map((t) => `<div class="sv-table"><table class="mini-table">${t.rows.slice(0, 30).map((r, i) => `<tr>${r.map((c) => (i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`)).join('')}</tr>`).join('')}</table>${t.rows.length > 30 ? `<p class="muted small">… ${t.rows.length - 30}행 더</p>` : ''}</div>`).join('')}` : ''}
      ${s.notes ? `<h4>메모</h4><p class="small">${esc(s.notes)}</p>` : ''}`;
  }
  side.innerHTML = tabs + `<div class="sv-side-body">${body}</div>`;
}

// ---------------------------------------------------------------- 건물만 보기(19 4절)

const CLASS_DOT = { building: '#2B8A3E', unknown: OVERLAY.unknown };
const whoLabel = (c) => (c.human ? (c.human.by === 'memory' ? '이 현장 기억' : '사람') : c.ai ? 'AI' : '규칙');

function markVerdicts() {
  const { t } = sv.tri;
  sv.flat.items.forEach((it, i) => { it.tv = itemVerdict(t, sv.flat.items, i); it.ti = i; });
}

function triageView() {
  const tri = sv.tab === 'triage' ? sv.tri : null;
  if (!tri || tri.view === 'original') return {};
  const shown = (it) => !tri.off.has(it.tv?.cls);
  if (tri.view === 'building') return { only: (it) => it.tv?.cls === 'building' && shown(it) };
  return {
    only: shown,
    tint: (it) => (it.tv?.cls === 'building' ? null : it.tv?.cls === 'unknown' ? OVERLAY.unknown : OVERLAY.drop),
  };
}

function clusterRow(c) {
  const v = clusterVerdict(c);
  const on = sv.tri.pick?.id === c.id;
  return `<li><button type="button" class="tg-row${on ? ' on' : ''}" data-act="tg-cluster" data-id="${esc(c.id)}">
    <i style="background:${CLASS_DOT[v.cls] || OVERLAY.drop}"></i><span>${esc(CLASS_LABEL[v.cls])}${v.part ? ` · ${esc(v.part)}` : ''}<small>${esc(c.layer)}${c.block ? ` · ${esc(c.block)}` : ''} · ${esc(c.kind)}</small></span><b>${c.n}</b></button></li>`;
}

function triageHtml(editable) {
  const { t, view, off, pick } = sv.tri;
  const counts = countClasses(t);
  const order = [...t.clusters].sort((a, b) => (clusterVerdict(a).cls === 'unknown' ? -1 : 0) - (clusterVerdict(b).cls === 'unknown' ? -1 : 0) || b.n - a.n);
  const c = pick && t.clusters.find((x) => x.id === pick.id);
  const v = c && clusterVerdict(c);
  return `<div class="seg tg-seg" role="tablist">${[['building', '건물만'], ['original', '원본'], ['overlay', '겹쳐보기']].map(([k, l]) => `<button type="button" role="tab" class="${view === k ? 'on' : ''}" aria-selected="${view === k}" data-act="tg-view" data-view="${k}">${l}</button>`).join('')}</div>
    ${view === 'overlay' ? `<p class="small tg-legend"><i style="background:${OVERLAY.drop}"></i>버린 선 <i style="background:${OVERLAY.unknown}"></i>모름</p>` : ''}
    <ul class="tg-classes">${CLASSES.filter((k) => counts[k]).map((k) => `<li><label><input type="checkbox" data-tg-class="${k}" ${off.has(k) ? '' : 'checked'}><span>${esc(CLASS_LABEL[k])}</span><small>${counts[k].toLocaleString()}</small></label></li>`).join('')}</ul>
    ${c ? `<div class="tg-pick"><b>${esc(CLASS_LABEL[v.cls])}${v.part ? ` · ${esc(v.part)}` : ''}</b>
      <p class="small muted">${esc(whoLabel(c))} 판정 · ${esc(c.ai?.reason || WHY_LABEL[c.rule.why] || c.rule.why)}<br>같은 무리 ${c.n}개 · 레이어 ${esc(c.layer)}</p>
      ${editable ? `<div class="tg-btns"><button type="button" class="btn sm primary" data-act="tg-set" data-yes="1">${icon('check')}건물이다</button><button type="button" class="btn sm" data-act="tg-set" data-yes="0">건물이 아니다</button></div>
        <label class="field"><span>분류 고르기</span><select id="tg-class">${CLASSES.map((k) => `<option value="${k}" ${k === v.cls ? 'selected' : ''}>${esc(CLASS_LABEL[k])}</option>`).join('')}</select></label>` : ''}</div>` : '<p class="muted small">그림에서 선을 누르면 어느 무리인지, 왜 그렇게 판단했는지 보여 줍니다.</p>'}
    <h4>무리 ${t.clusters.length}개</h4><ul class="tg-list">${order.slice(0, 80).map(clusterRow).join('')}</ul>`;
}

// 누른 곳에서 가장 가까운 개체
function pickAt(px, py) {
  const p = screenToSheet(px, py);
  if (!p) return;
  const tol = 8 / sv.view.s;
  const tri = sv.tri;
  const seen = triageView().only;
  let best = null;
  let bestD = tol;
  for (const it of sv.flat.items) {
    if (seen && !seen(it)) continue;
    if (sv.hidden.has(it.layer) || !it.tv) continue;
    let d = Infinity;
    if (it.k === 'path' && it.pts.length > 1) {
      const n = it.closed ? it.pts.length : it.pts.length - 1;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = it.pts[i];
        const [bx, by] = it.pts[(i + 1) % it.pts.length];
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
        const u = Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / L2));
        d = Math.min(d, Math.hypot(p[0] - ax - u * (bx - ax), p[1] - ay - u * (by - ay)));
      }
    } else if (it.box && p[0] >= it.box[0] && p[0] <= it.box[2] && p[1] >= it.box[1] && p[1] <= it.box[3]) d = tol / 2;
    if (d < bestD) { best = it; bestD = d; }
  }
  const c = best ? tri.t.clusters[tri.t.of[best.ti]] : null;
  tri.pick = c ? { id: c.id, box: c.box } : null;
  sv.el.classList.add('side-open');
  renderSide();
  paint();
}

async function setVerdict(cls, part) {
  const { t, pick } = sv.tri;
  setCluster(t, pick.id, cls, part);
  markVerdicts();
  renderSide();
  paint();
  sv.sheet = await store.drawings.saveTriage(sv.sheet, t);
  await rememberTriage(sv.sheet, t).catch(() => {});
  sv.onSaved?.(sv.sheet);
  toast('판정을 고쳤습니다. 같은 무리에 모두 적용했고, 이 현장의 다음 도서에도 씁니다.');
}

onAction('tg-view', (el) => { sv.tri.view = el.dataset.view; renderSide(); paint(); });
onAction('tg-cluster', (el) => {
  const c = sv.tri.t.clusters.find((x) => x.id === el.dataset.id);
  sv.tri.pick = c ? { id: c.id, box: c.box } : null;
  renderSide();
  paint();
});
onAction('tg-set', async (el) => {
  const c = sv.tri.t.clusters.find((x) => x.id === sv.tri.pick?.id);
  if (!c) return;
  if (el.dataset.yes === '1') await setVerdict('building', clusterVerdict(c).part || (c.kind === 'hatch' || ['line', 'poly'].includes(c.kind) ? 'wall' : 'other'));
  else await setVerdict(clusterVerdict(c).cls === 'building' ? 'annotation' : clusterVerdict(c).cls === 'unknown' ? 'annotation' : clusterVerdict(c).cls, null);
});

// 판독 결과(규칙·AI) 요약 — 위치가 있는 항목은 그림에 점으로 표시된다
function extractHtml(ex) {
  const d = ex?.data || {};
  const src = ex?.source === 'ai' ? `AI(${esc(ex.model || '')})` : '규칙';
  const rows = [];
  const list = (title, items, fmt) => { if (items?.length) rows.push(`<h4>${title} ${items.length}</h4><ul class="sv-legend">${items.slice(0, 200).map(fmt).join('')}</ul>`); };
  list('동', d.buildings, (b) => `<li><b>${esc(b.label)}</b><span>${esc(b.kind)} · ${esc(b.floorsText || '층수 모름')}</span></li>`);
  list('레벨', d.levels, (l) => `<li><b>${esc(l.name)}</b><span>FL ${l.elevationMm.toLocaleString()}${l.heightMm ? ` · 층고 ${l.heightMm.toLocaleString()}` : ''} · ${esc(l.kind)}</span></li>`);
  list('세대', d.units, (u) => `<li><b>${esc(u.line ? `${u.line}호` : '-')}</b><span>${esc(u.unitType || '타입 모름')}</span></li>`);
  list('실', d.rooms, (r) => `<li><b>${esc(r.name || r.roomName)}</b><span>${esc(r.use || [r.floor, r.wall, r.ceiling].filter(Boolean).join(' / '))}${r.areaText ? ` · ${esc(r.areaText)}` : ''}${r.zones?.length ? ` · ${esc(r.zones.join(','))}` : ''}</span></li>`);
  list('조립체', d.assemblies, (a) => `<li><b>${esc(a.code)}</b><span>${esc(a.layers.map((l) => `${l.material}${l.thicknessMm ? ` ${l.thicknessMm}` : ''}`).join(' + '))}</span></li>`);
  list('창호', d.items, (i) => `<li><b>${esc(i.code)}</b><span>${i.kind === 'door' ? '문' : '창'} ${i.widthMm ?? '?'}×${i.heightMm ?? '?'}${i.sillMm ? ` 창대 ${i.sillMm}` : ''}</span></li>`);
  if (d.tags?.length) {
    const by = {};
    for (const t of d.tags) by[t.code] = (by[t.code] || 0) + 1;
    rows.push(`<h4>기호 ${d.tags.length}</h4><p class="small">${Object.entries(by).map(([k, n]) => `${esc(k)}×${n}`).join(' · ')}</p>`);
  }
  return `<p class="muted small">판독: ${src}${d.floorsAbove ? ` · 지상 ${d.floorsAbove}층` : ''}${d.typeName ? ` · ${esc(d.typeName)}` : ''}${d.areaM2 ? ` ${d.areaM2}㎡` : ''}</p>${rows.join('') || '<p class="muted small">판독한 항목이 없습니다.</p>'}`;
}

function extractPoints(ex) {
  const d = ex?.data || {};
  const pts = [];
  for (const r of d.rooms || []) if (r.labelPos) pts.push({ p: r.labelPos, label: r.name, c: '#1C7ED6' });
  for (const u of d.units || []) if (u.labelPos) pts.push({ p: u.labelPos, label: `${u.line || ''}호 ${u.unitType || ''}`, c: '#7950F2' });
  for (const t of d.tags || []) if (t.pos) pts.push({ p: t.pos, label: t.code, c: '#E8590C' });
  for (const b of d.buildings || []) if (b.labelPos) pts.push({ p: b.labelPos, label: b.label, c: '#2B8A3E' });
  for (const c of d.cores || []) if (c.pos) pts.push({ p: c.pos, label: c.kind === 'stair' ? '계단' : '승강기', c: '#C2255C' });
  return pts;
}

// ---------------------------------------------------------------- 상세 값(38 지시서 4절 "사람"): 읽은 값·근거 위치·고치기

const posBtn = (p) => (p ? `<button type="button" class="icon-btn dv-pos" data-act="dv-pos" data-x="${p[0]}" data-y="${p[1]}" aria-label="도면에서 위치 보기" title="도면에서 위치 보기">${icon('target')}</button>` : '');
const numIn = (name, v, ro, label) => `<input name="${name}" type="number" inputmode="numeric" min="0" step="1" value="${v ?? ''}" ${ro ? 'readonly' : ''} aria-label="${esc(label)}">`;
const layerText = (layers) => (layers || []).map((l) => `${l.slab ? '콘크리트 슬래브' : l.material} ${l.thicknessMm ?? ''}`.trim()).join(' + ');

function detailHtml(s, editable) {
  const ex = s.extracted;
  const d = ex?.data || {};
  const ro = !editable;
  const src = ex?.edited ? '사람이 고침' : ex?.source === 'ai' ? 'AI 판독' : '규칙 판독';
  let rows = '';
  if (ex.kind === 'SectionDetailExtract') {
    rows = `<p class="muted small">${esc(d.unitType || '타입 모름')} 단위세대 단면 · ${src}</p>
      <div class="grid2"><label class="field"><span>층고(mm)</span>${numIn('floorHeightMm', d.floorHeightMm, ro, '층고')}</label><label class="field"><span>슬래브(mm)</span>${numIn('slabMm', d.slabMm, ro, '슬래브')}</label></div>
      <h4>바닥 구성 <small class="muted">위 → 아래, "재료 두께 + …"</small></h4>
      ${(d.floors || []).map((fl, i) => `<div class="dv-row"><label class="field"><span>${esc(fl.rooms.join('·') || `묶음 ${i + 1}`)}</span><input name="floor-${i}" value="${esc(layerText(fl.layers))}" ${ro ? 'readonly' : ''}></label>${posBtn(fl.pos)}</div>`).join('') || '<p class="muted small">읽은 바닥 구성이 없습니다.</p>'}
      <h4>실별 천장고</h4>
      <table class="mini-table dv-table"><tr><th>실</th><th>천장고</th><th>천장 속</th><th></th></tr>${(d.rooms || []).map((r, i) => `<tr><td>${esc(r.name)}</td><td>${numIn(`ceil-${i}`, r.ceilingMm, ro, `${r.name} 천장고`)}</td><td>${numIn(`void-${i}`, r.voidMm, ro, `${r.name} 천장 속`)}</td><td>${posBtn(r.pos)}</td></tr>`).join('')}</table>`;
  } else if (ex.kind === 'ConstructionDetailExtract') {
    rows = `<p class="muted small">시공 상세 값 ${(d.details || []).length}개 · ${src}. 값이 없으면 넣지 않습니다(기본값으로 채우지 않음).</p>
      <ul class="dv-list">${(d.details || []).map((x, i) => {
        const scope = scopeText(x.appliesTo);
        const unit = DETAIL_KEYS.find((k) => k.key === x.key)?.unit;
        return `<li class="dv-row"><div class="dv-main"><b>${esc(detailLabel(x.key))}</b><small class="muted">${esc(x.title || '')}${scope ? ` · ${esc(scope)}` : ''}</small></div>
          <input name="dv-${i}" ${unit === 'mm' ? 'type="number" inputmode="numeric"' : ''} value="${esc(x.value)}" ${ro ? 'readonly' : ''} aria-label="${esc(detailLabel(x.key))}">
          ${editable ? `<label class="dv-del" title="이 값 빼기"><input type="checkbox" name="del-${i}"><span>빼기</span></label>` : ''}${posBtn(x.pos)}</li>`;
      }).join('')}</ul>`;
  } else {
    rows = `<p class="muted small">구조 부재 ${(d.members || []).length}개 · 평면 기호 ${(d.planMarks || []).length}곳 · ${src}</p>
      <table class="mini-table dv-table"><tr><th>기호</th><th>부재</th><th>두께·크기(mm)</th></tr>${(d.members || []).map((m, i) => `<tr><td><b>${esc(m.mark)}</b></td><td>${esc(STRUCT_KO[m.kind] || m.kind)}</td><td><input name="mem-${i}" value="${esc(m.sizeMm ? m.sizeMm.join('×') : m.thicknessMm ?? '')}" ${ro ? 'readonly' : ''} aria-label="${esc(m.mark)} 두께"></td></tr>`).join('')}</table>`;
  }
  return `<form class="dv" data-form="dv-save" novalidate>${rows}
    ${editable ? `<div class="dv-btns"><button type="submit" class="btn primary">${icon('check')}저장</button><button type="button" class="btn" data-act="dv-apply">${icon('cube')}모델에 반영(새 버전)</button></div>
    <p class="muted small">저장하면 이 시트의 판독값이 바뀝니다. [모델에 반영]은 최신 모델에 수정 연산으로 넣어 새 버전을 만듭니다.</p>` : ''}</form>`;
}

const intOr = (v) => { const n = Number(String(v ?? '').replace(/[,\s]/g, '')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };

onForm('dv-save', async (f) => {
  if (!sv) return;
  const ex = sv.sheet.extracted;
  const d = JSON.parse(JSON.stringify(ex.data || {}));
  if (ex.kind === 'SectionDetailExtract') {
    d.floorHeightMm = intOr(f.floorHeightMm);
    d.slabMm = intOr(f.slabMm);
    d.floors = (d.floors || []).map((fl, i) => {
      const layers = parseComposition(f[`floor-${i}`]).map((l) => { const slab = /슬래브|SLAB/i.test(l.material) || l.category === 'structure'; return { material: slab ? '콘크리트' : l.material, category: slab ? 'structure' : l.category, thicknessMm: l.thicknessMm, slab }; });
      return { ...fl, layers };
    });
    d.rooms = (d.rooms || []).map((r, i) => ({ ...r, ceilingMm: intOr(f[`ceil-${i}`]), voidMm: intOr(f[`void-${i}`]) }));
  } else if (ex.kind === 'ConstructionDetailExtract') {
    d.details = (d.details || []).map((x, i) => {
      if (f[`del-${i}`]) return null;
      const unit = DETAIL_KEYS.find((k) => k.key === x.key)?.unit;
      const v = unit === 'mm' ? intOr(f[`dv-${i}`]) : String(f[`dv-${i}`] || '').trim();
      return v == null || v === '' ? null : { ...x, value: v };
    }).filter(Boolean);
  } else {
    d.members = (d.members || []).map((m, i) => {
      const t = String(f[`mem-${i}`] || '').replace(/\s/g, '');
      const two = /^(\d+)[x×X*](\d+)$/.exec(t);
      return two ? { ...m, sizeMm: [Number(two[1]), Number(two[2])], thicknessMm: null } : { ...m, thicknessMm: intOr(t), sizeMm: null };
    });
  }
  const saved = await store.drawings.updateSheet(sv.sheet.id, { extracted: { ...ex, data: d, edited: true, editedAt: new Date().toISOString() } });
  sv.sheet = saved;
  sv.onSaved?.(saved);
  toast('상세 값을 저장했습니다. [모델에 반영]을 누르면 새 버전이 됩니다.');
  renderSide();
});

onAction('dv-pos', (el) => {
  if (!sv) return;
  const x = Number(el.dataset.x);
  const y = Number(el.dataset.y);
  const r = Math.max(200, sv.flat?.frame ? (sv.flat.frame.x1 - sv.flat.frame.x0) / 60 : 400);
  sv.boxes = [[x - r, y - r, x + r, y + r]];
  sv.el.classList.remove('side-open');
  fit(sv.boxes[0]);
});

// 최신 모델(이전 버전이 아닌 것 중 가장 새 버전)에 이 시트의 값을 수정 연산으로 넣어 새 버전
onAction('dv-apply', async (el) => {
  if (!sv) return;
  const s = sv.sheet;
  el.disabled = true;
  try {
    const versions = await store.bim.versions(s.siteId);
    const base = versions.filter((v) => v.status !== 'superseded').sort((a, b) => b.version - a.version)[0];
    if (!base) throw new Error('이 현장에 아직 모델이 없습니다. 도서에서 모델을 먼저 만들어 주세요.');
    const idx = await store.bim.load(base, 'index.json');
    const names = ['site.json', 'catalog.json', ...Object.values(idx.files.buildings || {}), ...Object.values(idx.files.unitTypes || {})];
    const files = { 'index.json': idx, ...Object.fromEntries(await Promise.all(names.map(async (n) => [n, await store.bim.load(base, n)]))) };
    const ops = sheetDetailOps(files, s);
    if (!ops.length) { toast('모델에 넣을 값이 없습니다.', 'warn'); return; }
    const r = applyPatch(files, ops, { method: 'manual' });
    if (!r.ok) throw new Error(`모델에 넣지 못했습니다: ${r.errors[0]}`);
    const m = await store.bim.save(s.siteId, r.files, { setId: base.setId || s.setId, parentId: base.id, note: `${s.sheetNo || '시트'} 상세 값 반영(수정 ${ops.length}건)`, summary: r.files['index.json']?.summary || {} });
    toast(`모델 v${m.version}을 만들었습니다(수정 ${ops.length}건).`);
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    el.disabled = false;
  }
});

function refsLine(r = {}) {
  const parts = [...(r.buildings || []), ...(r.unitTypes || []), ...(r.floors || []), r.facility].filter(Boolean);
  return parts.length ? `<div><dt>대상</dt><dd>${esc(parts.join(' · '))}</dd></div>` : '';
}

const splitList = (v) => String(v || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);

onForm('sv-edit', async (f) => {
  if (!sv) return;
  const saved = await store.drawings.updateSheet(sv.sheet.id, {
    category: f.category, sheetNo: f.sheetNo, title: f.title,
    refs: { buildings: splitList(f.buildings), unitTypes: splitList(f.unitTypes), floors: splitList(f.floors), facility: String(f.facility || '').trim() || null },
    confidence: 1, status: sv.sheet.status === 'extracted' ? 'extracted' : 'classified',
    meta: { ...(sv.sheet.meta || {}), manual: true },
  });
  sv.sheet = saved;
  toast('도면 정보를 고쳤습니다.');
  sv.onSaved?.(saved);
  sv.tab = 'info';
  renderSide();
});

document.addEventListener('change', (e) => {
  if (!sv) return;
  if (e.target.dataset?.tgClass) {
    const k = e.target.dataset.tgClass;
    if (e.target.checked) sv.tri.off.delete(k); else sv.tri.off.add(k);
    paint();
    return;
  }
  if (e.target.id === 'tg-class' && sv.tri?.pick) { setVerdict(e.target.value, e.target.value === 'building' ? 'wall' : null); return; }
  const name = e.target.dataset?.svLayer;
  if (name == null) return;
  if (e.target.checked) sv.hidden.delete(name); else sv.hidden.add(name);
  paint();
});

onAction('sv-close', () => closeSheetViewer());
onAction('sv-fit', () => fit());
onAction('sv-zoom', (el) => { if (sv?.view) zoomAt(Number(el.dataset.z), sv.w / 2, sv.h / 2); });
onAction('sv-tab', (el) => { if (sv) { sv.tab = el.dataset.tab; renderSide(); paint(); } });
onAction('sv-panel', () => sv?.el.classList.toggle('side-open'));
onAction('sv-layers-all', (el) => {
  if (!sv) return;
  if (el.dataset.on === '1') sv.hidden.clear(); else for (const l of layerList()) sv.hidden.add(l.name);
  renderSide();
  paint();
});

window.addEventListener('popstate', () => { if (sv && !history.state?.baromapSheet) closeSheetViewer({ fromHistory: true }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sv && !$('#modal')) { e.stopPropagation(); closeSheetViewer(); } }, true);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => paint());

// 근거 상자 쪽으로 이동(검증 결과·수정안에서)
export function focusBox(box) {
  if (!sv) return;
  sv.boxes = [box];
  fit(box);
}

// 화면 좌표 → 시트 좌표(영역 고르기 등에 쓴다)
export function screenToSheet(px, py) {
  if (!sv?.view) return null;
  const { cx, cy, s } = sv.view;
  return toSheet({ frame: { x0: cx - sv.w / 2 / s, y1: cy + sv.h / 2 / s }, scale: s }, px, py);
}
