// 공정 현황(골구도): 동·호실을 칸으로 그리고, 칸에 공종 번호를 넣으면 그 공종 색으로 칠한다.
// - 동(라인별 층 범위)과 공종 시트(순서대로 진행하는 공종·색)는 현장마다 직접 정한다.
// - 칸을 누르거나 끌어서 고른 뒤 숫자 키(또는 아래 공종 버튼)를 누르면 입력, 0·Delete는 지우기.
// - 보기 권한만 있으면 칸을 눌러 내용을 확인한다.
import { store, state, q, ui } from './ctx.js';
import { todayStr, unitLabel, buildingUnits, floorSpan, sheetStats, inkFor, TRADE_COLORS, SHEET_PRESETS } from './model.js';
import { $, $$, esc, icon, fmtDate, onAction, onForm, openModal, closeModal, toast, confirmDialog } from './util.js';

const errors = {};
const loading = new Set();

async function ensureLoaded(siteId) {
  if (!store.progress || loading.has(siteId)) return;
  loading.add(siteId);
  delete errors[siteId];
  try {
    await store.progress.load(siteId);
  } catch (err) {
    errors[siteId] = err.message;
    ui.render();
  } finally {
    loading.delete(siteId);
  }
}
onAction('prog-retry', () => ensureLoaded(state.siteId));

const sheetOf = (p, id) => p.sheets.find((h) => h.id === id) || p.sheets[0] || null;
const tradeLabel = (sheet, step) => (step > 0 && sheet?.trades[step - 1] ? `${step} ${sheet.trades[step - 1].name}` : '시작 전');

// ---------------------------------------------------------------- 현장 패널 요약

function stackBar(sheet, st) {
  if (!st.total) return '';
  const segs = sheet.trades.map((t, i) => (st.at[i + 1] ? `<span style="width:${(st.at[i + 1] / st.total) * 100}%;background:${t.color}" title="${esc(`${i + 1} ${t.name}: ${st.at[i + 1]}세대`)}"></span>` : '')).join('');
  return `<div class="stack-bar" role="img" aria-label="${esc(sheet.name)} 진행 분포">${segs}</div>`;
}

function sheetSummary(sheet, st) {
  let last = -1;
  st.done.forEach((d, i) => { if (d) last = i; });
  const head = last < 0 ? '아직 입력 없음' : `<b>${esc(sheet.trades[last].name)}</b>까지 ${st.pct[last]}%`;
  return `<button type="button" class="prog-sheet" data-act="board-open" data-sheet="${esc(sheet.id)}">
    <span class="prog-sheet-head"><span>${esc(sheet.name)}</span><span class="muted small">${head}</span></span>
    ${stackBar(sheet, st)}</button>`;
}

export function progressSection(s) {
  if (!store.progress || !store.can('viewSite', s.id)) return '';
  const p = store.progress.cached(s.id);
  const editable = store.can('edit', s.id);
  const head = (extra = '') => `<div class="sec-head"><h3>공정 현황 <small>골구도</small></h3><span class="spacer"></span>${extra}</div>`;
  if (p === undefined) {
    if (errors[s.id]) {
      return `<section class="sec">${head()}<p class="t-warn small">${icon('alert')}${esc(errors[s.id])} <button type="button" class="link small" data-act="prog-retry">다시 시도</button></p></section>`;
    }
    queueMicrotask(() => ensureLoaded(s.id));
    return `<section class="sec">${head()}<p class="muted small loading">불러오는 중…</p></section>`;
  }
  if (!p.buildings.length) {
    return `<section class="sec">${head()}
      <div class="prog-empty">${icon('building')}<span>${editable
        ? '동·라인별 층수를 넣어 골구도를 만들면, 세대마다 공정을 숫자로 입력하고 색으로 볼 수 있어요.'
        : '아직 이 현장의 골구도가 없습니다.'}</span>
        ${editable ? `<button type="button" class="btn sm primary" data-act="bld-new">${icon('plus')}골구도 만들기</button>` : ''}</div></section>`;
  }
  const units = p.buildings.reduce((a, b) => a + buildingUnits(b).length, 0);
  const sheets = p.sheets.map((h) => sheetSummary(h, sheetStats(h, p.buildings, p.cells[h.id]))).join('');
  return `<section class="sec">${head(`<button type="button" class="btn sm" data-act="board-open">${icon('expand')}골구도 열기</button>`)}
    <p class="muted small prog-meta">${p.buildings.map((b) => esc(b.name)).join(' · ')} · ${units}세대</p>
    ${sheets || `<div class="prog-empty">${icon('table')}<span>${editable ? '공종 시트(예: 골조, 세대 마감)를 만들면 진행 상황을 입력할 수 있어요.' : '아직 공종 시트가 없습니다.'}</span>
      ${editable ? `<button type="button" class="btn sm primary" data-act="sheet-new">${icon('plus')}공종 시트 만들기</button>` : ''}</div>`}
  </section>`;
}

// ---------------------------------------------------------------- 골구도 화면(전체 화면)

let board = null; // { el, siteId, sheetId, sel:Set("bid|unit"), anchor, date, buf, timer, drag, unsub }
let pushed = false;

const keyOf = (bid, unit) => `${bid}|${unit}`;
const editable = () => board && store.can('edit', board.siteId);

export function openBoard(siteId, sheetId) {
  const s = q.site(siteId);
  if (!s) return;
  closeBoard({ keepHistory: true });
  const el = document.createElement('div');
  el.id = 'board';
  el.className = 'board';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `${s.name} 공정 현황`);
  document.body.append(el);
  document.body.classList.add('board-open');
  board = { el, siteId, sheetId, sel: new Set(), anchor: null, date: todayStr(), buf: '', timer: 0, drag: null, returnFocus: document.activeElement };
  board.unsub = store.subscribe(() => { if (board) renderBoard(); });
  if (!pushed) {
    history.pushState({ baromapBoard: true }, '');
    pushed = true;
  }
  renderBoard();
  if (store.progress.cached(siteId) === undefined) ensureLoaded(siteId);
  el.querySelector('[data-act="board-close"]')?.focus();
}

export function closeBoard({ fromHistory = false, keepHistory = false } = {}) {
  if (!board) return;
  const b = board;
  board = null;
  clearTimeout(b.timer);
  b.unsub?.();
  b.el.remove();
  document.body.classList.remove('board-open');
  if (keepHistory) return;
  b.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.back();
  pushed = false;
}

window.addEventListener('popstate', () => { if (board) closeBoard({ fromHistory: true }); });

function cellHtml(b, u, cell, sheet) {
  const step = Math.min(cell?.step || 0, sheet?.trades.length || 0);
  const t = step ? sheet.trades[step - 1] : null;
  const label = unitLabel(u.floor, u.line);
  const date = step && cell.dates?.[step] ? ` · ${fmtDate(cell.dates[step])}` : '';
  const sel = board.sel.has(keyOf(b.id, u.key)) ? ' sel' : '';
  return `<div class="cell${step ? ' on' : ''}${sel}" data-b="${esc(b.id)}" data-u="${esc(u.key)}"
    style="grid-row:${board.maxF - u.floor + 1};grid-column:${b.lines.findIndex((l) => l.name === u.line) + 1}${t ? `;--c:${t.color};--i:${inkFor(t.color)}` : ''}"
    title="${esc(`${label}호 · ${tradeLabel(sheet, step)}${date}`)}"><span class="cl">${esc(label)}</span>${step ? `<b>${step}</b>` : ''}</div>`;
}

function gridHtml(p, sheet) {
  const { min, max } = floorSpan(p.buildings);
  board.maxF = max;
  const rows = max - min + 1;
  const floors = [];
  for (let f = max; f >= min; f--) floors.push(`<button type="button" class="bg-floor" data-act="board-sel-floor" data-f="${f}" title="${f}층 모두 고르기">${f}F</button>`);
  const cells = sheet ? p.cells[sheet.id] || {} : {};
  const blds = p.buildings.map((b) => `<div class="bg-bld">
      <div class="bg-cells" style="grid-template-columns:repeat(${b.lines.length},var(--cw));grid-template-rows:repeat(${rows},var(--ch))">
        ${buildingUnits(b).map((u) => cellHtml(b, u, cells[b.id]?.[u.key], sheet)).join('')}</div>
      <div class="bg-lines" style="grid-template-columns:repeat(${b.lines.length},var(--cw))">${b.lines.map((l) => `<button type="button" data-act="board-sel-line" data-b="${esc(b.id)}" data-line="${esc(l.name)}" title="${esc(l.name)}호 라인 모두 고르기">${esc(l.name)}호</button>`).join('')}</div>
      <button type="button" class="bg-name" data-act="board-sel-bld" data-b="${esc(b.id)}" title="${esc(b.name)} 모두 고르기">${esc(b.name)}</button>
    </div>`).join('');
  return `<div class="bg" style="--rows:${rows}"><div class="bg-floors" style="grid-template-rows:repeat(${rows},var(--ch)) var(--foot)">${floors.join('')}<span></span></div>${blds}</div>`;
}

function paletteHtml(p, sheet, edit) {
  if (!sheet) return `<span class="muted small">${edit ? '공종 시트를 먼저 만들어주세요.' : '아직 공종 시트가 없습니다.'}</span>`;
  const st = sheetStats(sheet, p.buildings, p.cells[sheet.id]);
  const chips = sheet.trades.map((t, i) => `<button type="button" class="trade-chip" ${edit ? `data-act="board-apply" data-step="${i + 1}"` : 'disabled'}
      style="--c:${t.color};--i:${inkFor(t.color)}" title="${esc(`${i + 1}번 ${t.name}: ${st.done[i]}/${st.total}세대 완료`)}">
      <b>${i + 1}</b>${esc(t.name)}<small>${st.pct[i]}%</small></button>`).join('');
  return `${chips}${edit ? `<button type="button" class="trade-chip clear" data-act="board-apply" data-step="0" title="고른 칸 지우기"><b>0</b>지우기</button>` : ''}`;
}

function renderBoard() {
  const s = q.site(board.siteId);
  const p = store.progress.cached(board.siteId);
  if (!s) { closeBoard(); return; }
  const edit = editable();
  const sheet = p ? sheetOf(p, board.sheetId) : null;
  if (sheet) board.sheetId = sheet.id;
  const scroll = $('.board-scroll', board.el);
  const keep = scroll ? [scroll.scrollLeft, scroll.scrollTop] : null;
  let body;
  if (!p) body = errors[board.siteId] ? `<p class="board-msg t-warn">${esc(errors[board.siteId])}</p>` : '<p class="board-msg muted loading">불러오는 중…</p>';
  else if (!p.buildings.length) body = `<div class="board-msg">${icon('building')}<p>아직 골구도가 없습니다.</p>${edit ? `<button type="button" class="btn primary" data-act="bld-new">${icon('plus')}동 추가</button>` : ''}</div>`;
  else body = gridHtml(p, sheet);
  board.el.innerHTML = `
    <header class="board-head">
      <button type="button" class="icon-btn" data-act="board-close" aria-label="닫기" title="닫기">${icon('close')}</button>
      <div class="board-title"><b>공정 현황</b><span>${esc(s.name)}</span></div>
      ${edit ? `<div class="board-tools">
        <button type="button" class="btn sm" data-act="bld-list" aria-label="동 설정" title="동 설정">${icon('building')}<span>동 설정</span></button>
        <button type="button" class="btn sm" data-act="sheet-list" aria-label="공종 설정" title="공종 설정">${icon('settings')}<span>공종 설정</span></button></div>` : ''}
    </header>
    <nav class="board-tabs" role="tablist" aria-label="공종 시트">${(p?.sheets || []).map((h) => `<button type="button" role="tab" aria-selected="${h.id === sheet?.id}" class="${h.id === sheet?.id ? 'on' : ''}" data-act="board-sheet" data-sheet="${esc(h.id)}">${esc(h.name)}</button>`).join('')}
      ${edit && p ? `<button type="button" class="tab-add" data-act="sheet-new">${icon('plus')}시트</button>` : ''}</nav>
    <div class="board-bar">
      <div class="board-palette">${p ? paletteHtml(p, sheet, edit) : ''}</div>
      ${edit && sheet ? `<div class="board-sel">
        <label class="board-date"><span>작업일</span><input type="date" id="board-date" value="${esc(board.date)}"></label>
        <span class="muted small" id="board-count">${board.sel.size ? `${board.sel.size}세대 선택` : ''}</span>
        <button type="button" class="btn sm ghost" data-act="board-clear" ${board.sel.size ? '' : 'hidden'}>선택 해제</button></div>` : ''}
    </div>
    <div class="board-scroll">${body}</div>
    <footer class="board-foot" id="board-foot">${edit && sheet
      ? '칸을 누르거나 끌어서 고른 뒤 <b>숫자 키</b> 또는 위 공종 버튼을 누르세요. 0·Delete는 지우기, 층·라인·동 이름을 누르면 한 번에 고릅니다.'
      : '칸을 누르면 그 세대의 공정을 볼 수 있어요.'}</footer>`;
  if (keep) { const sc = $('.board-scroll', board.el); sc.scrollLeft = keep[0]; sc.scrollTop = keep[1]; }
}

// 선택 표시만 바꿀 때(다시 그리지 않음)
function paintSelection() {
  if (!board) return;
  for (const el of $$('.cell', board.el)) el.classList.toggle('sel', board.sel.has(keyOf(el.dataset.b, el.dataset.u)));
  const n = $('#board-count');
  if (n) n.textContent = board.sel.size ? `${board.sel.size}세대 선택` : '';
  const clr = $('[data-act="board-clear"]', board.el);
  if (clr) clr.hidden = !board.sel.size;
}

function unitsWhere(pred) {
  const p = store.progress.cached(board.siteId);
  const out = [];
  for (const b of p?.buildings || []) for (const u of buildingUnits(b)) if (pred(b, u)) out.push(keyOf(b.id, u.key));
  return out;
}

// 다 골라져 있으면 빼고, 아니면 더한다
function toggleGroup(keys) {
  if (!keys.length) return;
  const all = keys.every((k) => board.sel.has(k));
  for (const k of keys) { if (all) board.sel.delete(k); else board.sel.add(k); }
  paintSelection();
}

// a~z 사각형 안의 세대(같은 동 안에서만)
function rectKeys(a, z) {
  if (!a || !z || a.b !== z.b) return [];
  const p = store.progress.cached(board.siteId);
  const b = p.buildings.find((x) => x.id === a.b);
  const [fa, la] = a.u.split(':');
  const [fz, lz] = z.u.split(':');
  const ia = b.lines.findIndex((l) => l.name === la);
  const iz = b.lines.findIndex((l) => l.name === lz);
  const [f0, f1] = [Math.min(fa, fz), Math.max(fa, fz)];
  const [i0, i1] = [Math.min(ia, iz), Math.max(ia, iz)];
  return buildingUnits(b).filter((u) => u.floor >= f0 && u.floor <= f1 && b.lines.findIndex((l) => l.name === u.line) >= i0 && b.lines.findIndex((l) => l.name === u.line) <= i1).map((u) => keyOf(b.id, u.key));
}

function showInfo(bid, unit) {
  const p = store.progress.cached(board.siteId);
  const b = p?.buildings.find((x) => x.id === bid);
  const sheet = p && sheetOf(p, board.sheetId);
  if (!b) return;
  const [f, line] = unit.split(':');
  const cell = sheet ? p.cells[sheet.id]?.[bid]?.[unit] : null;
  const step = Math.min(cell?.step || 0, sheet?.trades.length || 0);
  const hist = sheet ? sheet.trades.map((t, i) => (cell?.dates?.[i + 1] ? `${i + 1} ${t.name} ${fmtDate(cell.dates[i + 1])}` : '')).filter(Boolean).join(' · ') : '';
  $('#board-foot').innerHTML = `<b>${esc(b.name)} ${esc(unitLabel(Number(f), line))}호</b> · ${esc(sheet?.name || '')}: <b>${esc(tradeLabel(sheet, step))}</b>${hist ? ` <span class="muted">(${esc(hist)})</span>` : ''}`;
}

const cellAt = (target) => target?.closest?.('.cell');

document.addEventListener('pointerdown', (e) => {
  const el = board && cellAt(e.target);
  if (!el || !board.el.contains(el)) return;
  board.lastPointer = e.pointerType;
  if (!editable() || e.pointerType !== 'mouse' || e.button !== 0) return;
  e.preventDefault();
  const at = { b: el.dataset.b, u: el.dataset.u };
  if (e.shiftKey && board.anchor) {
    if (!(e.ctrlKey || e.metaKey)) board.sel.clear();
    for (const k of rectKeys(board.anchor, at)) board.sel.add(k);
  } else if (e.ctrlKey || e.metaKey) {
    const k = keyOf(at.b, at.u);
    if (board.sel.has(k)) board.sel.delete(k); else board.sel.add(k);
    board.anchor = at;
  } else {
    board.sel.clear();
    board.anchor = at;
    board.drag = { base: new Set(), from: at };
    board.sel.add(keyOf(at.b, at.u));
  }
  paintSelection();
  showInfo(at.b, at.u);
});

document.addEventListener('pointerover', (e) => {
  if (!board?.drag) return;
  const el = cellAt(e.target);
  const keys = el ? rectKeys(board.drag.from, { b: el.dataset.b, u: el.dataset.u }) : [];
  if (!keys.length) return;
  board.sel = new Set([...board.drag.base, ...keys]);
  paintSelection();
});

window.addEventListener('pointerup', () => { if (board) board.drag = null; });

// 손가락(터치): 누를 때마다 고르기/빼기. 보기 권한이면 내용만 보여준다.
document.addEventListener('click', (e) => {
  const el = board && cellAt(e.target);
  if (!el || !board.el.contains(el)) return;
  if (editable() && board.lastPointer !== 'mouse') {
    const k = keyOf(el.dataset.b, el.dataset.u);
    if (board.sel.has(k)) board.sel.delete(k); else board.sel.add(k);
    board.anchor = { b: el.dataset.b, u: el.dataset.u };
    paintSelection();
  }
  showInfo(el.dataset.b, el.dataset.u);
});

async function apply(step) {
  if (!board || !editable()) return;
  const p = store.progress.cached(board.siteId);
  const sheet = p && sheetOf(p, board.sheetId);
  if (!sheet) return;
  if (!board.sel.size) {
    toast('먼저 칸(세대)을 골라주세요.', 'warn');
    return;
  }
  if (step > sheet.trades.length) {
    toast(`이 시트의 공종은 1~${sheet.trades.length}번까지입니다.`, 'warn');
    return;
  }
  const changes = [...board.sel].map((k) => { const [buildingId, unit] = k.split('|'); return { buildingId, unit, step }; });
  try {
    const n = await store.progress.setCells(sheet.id, changes, board.date);
    toast(step ? `${changes.length}세대 → ${step} ${sheet.trades[step - 1].name}${n ? '' : ' (바뀐 칸 없음)'}` : `${changes.length}세대를 지웠습니다.`);
  } catch (err) {
    toast(err.message, 'crit');
  }
}

onAction('board-open', (el) => openBoard(state.siteId, el.dataset.sheet));
onAction('board-close', () => closeBoard());
onAction('board-sheet', (el) => { board.sheetId = el.dataset.sheet; renderBoard(); });
onAction('board-apply', (el) => apply(Number(el.dataset.step)));
onAction('board-clear', () => { board.sel.clear(); paintSelection(); });
onAction('board-sel-floor', (el) => { if (editable()) toggleGroup(unitsWhere((b, u) => u.floor === Number(el.dataset.f))); });
onAction('board-sel-line', (el) => { if (editable()) toggleGroup(unitsWhere((b, u) => b.id === el.dataset.b && u.line === el.dataset.line)); });
onAction('board-sel-bld', (el) => { if (editable()) toggleGroup(unitsWhere((b) => b.id === el.dataset.b)); });

document.addEventListener('change', (e) => { if (board && e.target.id === 'board-date') board.date = e.target.value; });

// 숫자 키: 한 자리는 잠깐 기다렸다가(두 자리 공종 번호를 위해) 입력, Enter는 바로 입력
document.addEventListener('keydown', (e) => {
  if (!board || $('#modal') || e.target.closest?.('input, select, textarea')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (board.sel.size) { board.sel.clear(); paintSelection(); } else closeBoard();
    return;
  }
  if (!editable()) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    for (const k of unitsWhere(() => true)) board.sel.add(k);
    paintSelection();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); apply(0); return; }
  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    board.buf += e.key;
    clearTimeout(board.timer);
    const go = () => { const v = Number(board.buf); board.buf = ''; apply(v); };
    if (board.buf.length >= 2) go(); else board.timer = setTimeout(go, 450);
  } else if (e.key === 'Enter' && board.buf) {
    e.preventDefault();
    clearTimeout(board.timer);
    const v = Number(board.buf);
    board.buf = '';
    apply(v);
  }
}, true);

// ---------------------------------------------------------------- 동 설정(골구도 모양)

const siteIdNow = () => board?.siteId || state.siteId;

function buildingList(siteId) {
  const p = store.progress.cached(siteId) || { buildings: [] };
  openModal({
    title: '동 설정 (골구도 모양)',
    wide: true,
    body: `<p class="muted small">동마다 라인(호)과 층 범위를 정합니다. 라인마다 최고층이 다르면 그 라인만 고치면 됩니다.</p>
      ${p.buildings.length ? `<ul class="set-list">${p.buildings.map((b) => {
        const n = buildingUnits(b).length;
        const top = Math.max(...b.lines.map((l) => l.to));
        return `<li><span><b>${esc(b.name)}</b><small class="muted"> · 라인 ${b.lines.length}개 · 최고 ${top}층 · ${n}세대</small></span>
          <span class="set-act"><button type="button" class="btn sm" data-act="bld-edit" data-id="${esc(b.id)}">${icon('edit')}수정</button>
          <button type="button" class="icon-btn sm" data-act="bld-del" data-id="${esc(b.id)}" aria-label="${esc(b.name)} 삭제" title="삭제">${icon('trash')}</button></span></li>`;
      }).join('')}</ul>` : '<p class="empty">아직 동이 없습니다.</p>'}`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">닫기</button>
      <button type="button" class="btn primary" data-act="bld-new">${icon('plus')}동 추가</button>`,
  });
}

function lineRow(l = {}) {
  return `<tr><td><input name="lname" value="${esc(l.name ?? '')}" maxlength="10" placeholder="1" aria-label="라인(호)"></td>
    <td><input name="lfrom" type="number" min="1" max="99" value="${esc(l.from ?? 1)}" aria-label="시작층"></td>
    <td><input name="lto" type="number" min="1" max="99" value="${esc(l.to ?? '')}" aria-label="최고층"></td>
    <td><button type="button" class="icon-btn sm" data-act="line-del" aria-label="이 라인 빼기" title="빼기">${icon('close')}</button></td></tr>`;
}

function buildingDialog(siteId, rec = null) {
  const p = store.progress.cached(siteId) || { buildings: [] };
  const next = p.buildings.length ? Math.max(...p.buildings.map((b) => b.sort || 0)) + 1 : 1;
  openModal({
    title: rec ? `${rec.name} 수정` : '동 추가',
    wide: true,
    body: `<form id="f-bld" data-form="bld" data-id="${esc(rec?.id || '')}" data-site="${esc(siteId)}" novalidate>
      <div class="grid2">
        <label class="field"><span>동 이름 <em>*</em></span><input name="name" value="${esc(rec?.name || `${100 + next}동`)}" maxlength="30" required></label>
        <label class="field"><span>표시 순서</span><input name="sort" type="number" value="${esc(rec?.sort ?? next)}"></label>
      </div>
      <div class="bld-quick">
        <span class="muted small">빠르게 만들기</span>
        <label>라인 <input id="q-lines" type="number" min="1" max="30" value="${rec ? rec.lines.length : 4}"></label>
        <label>시작층 <input id="q-from" type="number" min="1" max="99" value="1"></label>
        <label>최고층 <input id="q-to" type="number" min="1" max="99" value="${rec ? Math.max(...rec.lines.map((l) => l.to)) : 15}"></label>
        <button type="button" class="btn sm" data-act="line-gen">${icon('refresh')}라인 만들기</button>
      </div>
      <table class="line-table"><thead><tr><th>라인(호)</th><th>시작층</th><th>최고층</th><th></th></tr></thead>
        <tbody id="line-rows">${(rec?.lines || [1, 2, 3, 4].map((n) => ({ name: String(n), from: 1, to: 15 }))).map(lineRow).join('')}</tbody></table>
      <button type="button" class="btn sm ghost" data-act="line-add">${icon('plus')}라인 추가</button>
      <p class="muted small">세대 번호는 층 + 라인으로 정해집니다(10층 2호 라인 → 1002호). 필로티처럼 1층이 없는 라인은 시작층을 2로 하세요.</p>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="bld-back">목록</button><span class="spacer"></span>
      <button type="button" class="btn ghost" data-act="modal-close">취소</button>
      <button type="submit" class="btn primary" form="f-bld">${icon('check')}저장</button>`,
  });
}

onAction('line-gen', () => {
  const n = Math.max(1, Math.min(30, Number($('#q-lines').value) || 1));
  const from = Number($('#q-from').value) || 1;
  const to = Number($('#q-to').value) || from;
  $('#line-rows').innerHTML = Array.from({ length: n }, (_, i) => lineRow({ name: String(i + 1), from, to })).join('');
});
onAction('line-add', () => {
  const rows = $$('#line-rows tr');
  const last = rows[rows.length - 1];
  const nextName = rows.length + 1;
  $('#line-rows').insertAdjacentHTML('beforeend', lineRow({ name: String(nextName), from: last?.querySelector('[name=lfrom]').value || 1, to: last?.querySelector('[name=lto]').value || '' }));
});
onAction('line-del', (el) => { if ($$('#line-rows tr').length > 1) el.closest('tr').remove(); });

onForm('bld', async (data, form) => {
  const lines = $$('#line-rows tr', form).map((tr) => ({ name: tr.querySelector('[name=lname]').value, from: tr.querySelector('[name=lfrom]').value, to: tr.querySelector('[name=lto]').value }));
  const saved = await store.progress.saveBuilding({ id: form.dataset.id || undefined, siteId: form.dataset.site, name: data.name, sort: data.sort, lines });
  closeModal(true);
  toast(`${saved.name}을(를) 저장했습니다.`);
  if (!board) openBoard(form.dataset.site);
});

onAction('bld-list', () => buildingList(siteIdNow()));
onAction('bld-back', () => buildingList(siteIdNow()));
onAction('bld-new', () => buildingDialog(siteIdNow()));
onAction('bld-edit', (el) => buildingDialog(siteIdNow(), store.progress.cached(siteIdNow())?.buildings.find((b) => b.id === el.dataset.id)));
onAction('bld-del', async (el) => {
  const siteId = siteIdNow();
  const p = store.progress.cached(siteId);
  const b = p?.buildings.find((x) => x.id === el.dataset.id);
  if (!b) return;
  const filled = p.sheets.reduce((a, h) => a + Object.keys(p.cells[h.id]?.[b.id] || {}).length, 0);
  if (!(await confirmDialog(`${b.name}을(를) 지울까요?${filled ? `\n이 동에 입력한 공정 ${filled}칸도 함께 지워집니다.` : ''}`, { title: '동 삭제', ok: '삭제', danger: true }))) return;
  await store.progress.removeBuilding(b.id);
  toast(`${b.name}을(를) 지웠습니다.`);
  buildingList(siteId);
});

// ---------------------------------------------------------------- 공종 설정(시트)

function sheetList(siteId) {
  const p = store.progress.cached(siteId) || { sheets: [] };
  openModal({
    title: '공종 설정',
    wide: true,
    body: `<p class="muted small">시트마다 순서대로 진행하는 공종을 넣습니다. 칸에 넣는 숫자는 공종 순번입니다(예: 1 방수 → 2 미장 → 3 타일).</p>
      ${p.sheets.length ? `<ul class="set-list">${p.sheets.map((h) => `<li><span><b>${esc(h.name)}</b>
          <span class="trade-mini">${h.trades.map((t, i) => `<i style="background:${t.color}" title="${esc(`${i + 1} ${t.name}`)}"></i>`).join('')}</span>
          <small class="muted">공종 ${h.trades.length}개</small></span>
          <span class="set-act"><button type="button" class="btn sm" data-act="sheet-edit" data-id="${esc(h.id)}">${icon('edit')}수정</button>
          <button type="button" class="icon-btn sm" data-act="sheet-del" data-id="${esc(h.id)}" aria-label="${esc(h.name)} 삭제" title="삭제">${icon('trash')}</button></span></li>`).join('')}</ul>` : '<p class="empty">아직 공종 시트가 없습니다.</p>'}
      <div class="preset-row"><span class="muted small">예시로 시작하기</span>${SHEET_PRESETS.map((pr, i) => `<button type="button" class="btn sm ghost" data-act="sheet-preset" data-i="${i}">${icon('plus')}${esc(pr.name)}</button>`).join('')}</div>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">닫기</button>
      <button type="button" class="btn primary" data-act="sheet-new">${icon('plus')}시트 추가</button>`,
  });
}

function tradeRow(t, i) {
  return `<tr><td class="num">${i + 1}</td>
    <td><input name="tname" value="${esc(t.name || '')}" maxlength="30" placeholder="공종 이름" aria-label="공종 이름"></td>
    <td><input name="tcolor" type="color" value="${esc(t.color || TRADE_COLORS[i % TRADE_COLORS.length])}" aria-label="색"></td>
    <td class="row-act"><button type="button" class="icon-btn sm" data-act="trade-up" aria-label="위로" title="위로">${icon('back')}</button>
      <button type="button" class="icon-btn sm" data-act="trade-del" aria-label="빼기" title="빼기">${icon('close')}</button></td></tr>`;
}

function renumber() { $$('#trade-rows tr').forEach((tr, i) => { tr.querySelector('.num').textContent = i + 1; }); }

function sheetDialog(siteId, rec = null, preset = null) {
  const p = store.progress.cached(siteId) || { sheets: [] };
  const next = p.sheets.length ? Math.max(...p.sheets.map((h) => h.sort || 0)) + 1 : 1;
  const trades = rec?.trades || (preset ? preset.trades.map((name, i) => ({ name, color: TRADE_COLORS[i % TRADE_COLORS.length] })) : [{ name: '' }, { name: '' }, { name: '' }]);
  const used = rec && p.sheets.length ? Object.values(p.cells[rec.id] || {}).reduce((a, m) => a + Object.keys(m).length, 0) : 0;
  openModal({
    title: rec ? `${rec.name} 수정` : '공종 시트 추가',
    wide: true,
    body: `<form id="f-sheet" data-form="sheet" data-id="${esc(rec?.id || '')}" data-site="${esc(siteId)}" novalidate>
      <div class="grid2">
        <label class="field"><span>시트 이름 <em>*</em></span><input name="name" value="${esc(rec?.name || preset?.name || '')}" maxlength="30" placeholder="예) 세대 마감" required></label>
        <label class="field"><span>표시 순서</span><input name="sort" type="number" value="${esc(rec?.sort ?? next)}"></label>
      </div>
      <table class="trade-table"><thead><tr><th>번호</th><th>공종</th><th>색</th><th></th></tr></thead>
        <tbody id="trade-rows">${trades.map(tradeRow).join('')}</tbody></table>
      <button type="button" class="btn sm ghost" data-act="trade-add">${icon('plus')}공종 추가</button>
      ${used ? `<p class="t-warn small">${icon('alert')}이미 ${used}칸이 입력돼 있습니다. 순서를 바꾸거나 빼면 칸의 숫자가 다른 공종을 가리키게 됩니다.</p>` : ''}
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="sheet-back">목록</button><span class="spacer"></span>
      <button type="button" class="btn ghost" data-act="modal-close">취소</button>
      <button type="submit" class="btn primary" form="f-sheet">${icon('check')}저장</button>`,
  });
}

onAction('trade-add', () => {
  const n = $$('#trade-rows tr').length;
  $('#trade-rows').insertAdjacentHTML('beforeend', tradeRow({ name: '' }, n));
  $$('#trade-rows tr')[n].querySelector('[name=tname]').focus();
});
onAction('trade-del', (el) => { if ($$('#trade-rows tr').length > 1) { el.closest('tr').remove(); renumber(); } });
onAction('trade-up', (el) => {
  const tr = el.closest('tr');
  if (tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling);
  renumber();
});

onForm('sheet', async (data, form) => {
  const trades = $$('#trade-rows tr', form).map((tr) => ({ name: tr.querySelector('[name=tname]').value, color: tr.querySelector('[name=tcolor]').value }));
  const saved = await store.progress.saveSheet({ id: form.dataset.id || undefined, siteId: form.dataset.site, name: data.name, sort: data.sort, trades });
  closeModal(true);
  toast(`${saved.name} 시트를 저장했습니다.`);
  if (board) { board.sheetId = saved.id; renderBoard(); } else openBoard(form.dataset.site, saved.id);
});

onAction('sheet-list', () => sheetList(siteIdNow()));
onAction('sheet-back', () => sheetList(siteIdNow()));
onAction('sheet-new', () => sheetDialog(siteIdNow()));
onAction('sheet-preset', (el) => sheetDialog(siteIdNow(), null, SHEET_PRESETS[Number(el.dataset.i)]));
onAction('sheet-edit', (el) => sheetDialog(siteIdNow(), store.progress.cached(siteIdNow())?.sheets.find((h) => h.id === el.dataset.id)));
onAction('sheet-del', async (el) => {
  const siteId = siteIdNow();
  const p = store.progress.cached(siteId);
  const h = p?.sheets.find((x) => x.id === el.dataset.id);
  if (!h) return;
  const filled = Object.values(p.cells[h.id] || {}).reduce((a, m) => a + Object.keys(m).length, 0);
  if (!(await confirmDialog(`${h.name} 시트를 지울까요?${filled ? `\n입력한 공정 ${filled}칸도 함께 지워집니다.` : ''}`, { title: '시트 삭제', ok: '삭제', danger: true }))) return;
  await store.progress.removeSheet(h.id);
  toast(`${h.name} 시트를 지웠습니다.`);
  sheetList(siteId);
});
