// 내역서·단가·공사 업체·시공 기준 화면(24 지시서). 3D 보기의 [단가] 탭(금액 권한만)과 재료 카드의 칸(공종·공사 업체·시공 기준·단가·금액).
// 읽기·잇기·계산은 순수 모듈(cost-core·cost-link·cost-calc). 단가·금액 칸은 store.can('viewMoney')일 때만 그린다 — 숨기는 것은 안내이고 막는 것은 RLS.
// 금액은 AI로 보내지 않는다(AI 후보 요청은 costAiRequest: 품명·규격·단위만). 원본 내역서 파일은 저장하지 않는다(읽은 항목만).
import { store } from '../ctx.js';
import { $, esc, icon, onAction, onForm, openModal, closeModal, toast, confirmDialog } from '../util.js';
import { xlsx } from '../excel-ui.js';
import { readXlsx } from '../ops/schedule/xlsx.js';
import { aiOn } from '../ops/ai.js';
import { addViewerHook, bimViewerState, viewerModelFiles, viewerRenderTab, viewerRenderPanel } from './viewer.js';
import { addMaterialSection } from './model-panel.js';
import { modelTakeoff } from './takeoff-ui.js';
import { tradeMaterials, materialMatches } from './mesh-calc.js';
import { readCostBook, readCost, plainGrid, headerLabels, findCostHeader, tradeTotals, itemKey, COST_LABEL } from './cost-core.js';
import { costTargets, recommend, linkRow, dictMap, dictRow, costAiRequest, normUnit } from './cost-link.js';
import { costScope, costRows, costByTrade, costByBuilding, boqCompare, costDiff, linkStatus, sumAmount, MONEY_NOTE } from './cost-calc.js';

// 국가건설기준(KCS) 기본 코드표: 조사의 2차 자료라 원문 확인 전이다(본문은 복사하지 않고 코드·제목·링크만, 24 지시서 4절)
const KCS_HOME = 'https://www.kcsc.re.kr';
export const KCS_DEFAULT = { 골조: ['41 30 00', '콘크리트공사'], 조적: ['41 34 00', '조적공사'], 방수: ['41 40 00', '방수공사'], 단열: ['41 42 00', '단열공사'], 미장: ['41 46 00', '미장공사'], 도장: ['41 47 00', '도장공사'], 타일: ['41 48 00', '타일공사'] };
const FIELDS = ['name', 'spec', 'unit', 'qty', 'materialUnit', 'laborUnit', 'expenseUnit', 'totalUnit', 'amount', 'code', 'note'];

const won = (v) => (v == null ? '-' : `${Math.round(v).toLocaleString()}원`);
const n2 = (v) => (v == null ? '-' : (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const pct = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${Math.round(v * 1000) / 10}%`);
const money = (siteId) => Boolean(store.can?.('viewMoney', siteId));
const canEdit = (siteId) => Boolean(store.can?.('edit', siteId));
const isAdmin = () => store.me?.role === 'admin';

// 현장·모델별로 한 번 불러 둔다(재료 카드가 바로 쓰게)
let S = { key: '', loading: null };
const ui = { filter: 'todo', threshold: 10, diff: null, upload: null };
try { ui.threshold = Number(localStorage.getItem('baromap.cost.threshold')) || 10; } catch { /* 기본 10% */ }

function load(force = false) {
  const v = bimViewerState();
  if (!v?.model || !store.cost) return Promise.resolve(null);
  const key = `${v.siteId}|${v.model.id}`;
  if (!force && S.key === key && (S.ready || S.loading)) return S.loading || Promise.resolve(S);
  const run = (async () => {
    const siteId = v.siteId;
    const safe = (p) => p.catch(() => []);
    const [trades, standards, companies] = await Promise.all([safe(store.cost.trades(siteId)), safe(store.cost.standards(siteId)), safe(store.rows('companies').list({ siteId }))]);
    let books = [];
    let items = new Map();
    let links = [];
    let dict = [];
    let error = '';
    if (money(siteId)) {
      try {
        books = await store.cost.books(siteId);
        items = await store.cost.itemMap(books.filter((b) => b.status !== 'archived'));
        [links, dict] = await Promise.all([store.cost.links(siteId), safe(store.cost.dict())]);
      } catch (err) { error = err.message; }
    }
    const t = await modelTakeoff(v.model);
    const targets = costTargets(await viewerModelFiles(v.model), t);
    const dm = dictMap(dict);
    const done = new Set(links.filter((l) => l.confirmed).map((l) => l.itemId));
    const recs = new Map([...items.values()].filter((it) => !done.has(it.id)).map((it) => [it.id, recommend(it, targets, dm)]));
    const next = { key, siteId, modelId: v.model.id, ready: true, loading: null, trades, standards, companies, books, items, links, dict, t, targets, recs, error, ai: S.key === key ? S.ai || new Map() : new Map() };
    if (bimViewerState()?.model?.id === v.model.id) S = next;
    return next;
  })().catch((err) => { S = { key: '', loading: null }; throw err; });
  S = { ...(S.key === key ? S : {}), key, loading: run };
  return run;
}
const refresh = async () => { await load(true); viewerRenderTab(); viewerRenderPanel(); };

// ---------------------------------------------------------------- 엑셀 읽기(.xlsx는 자체 읽기, .xls는 SheetJS)

async function readBook(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return (await readXlsx(bytes)).sheets.filter((s) => !s.hidden);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    const X = await xlsx();
    const wb = X.read(bytes, { type: 'array' });
    return wb.SheetNames.map((name) => {
      const ws = wb.Sheets[name];
      const grid = X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      return { name, grid, merges: (ws['!merges'] || []).map((m) => ({ r0: m.s.r, c0: m.s.c, r1: m.e.r, c1: m.e.c })) };
    });
  }
  throw new Error('엑셀 파일(.xlsx, .xls)을 올려 주세요.');
}

// 저장한 양식 중 이 파일의 머리글과 같은 것(있으면 열 대응을 다시 확인하지 않는다)
function savedFormats() {
  return (S.books || []).filter((b) => b.format?.columns).map((b) => ({ ...b.format, from: b.name }));
}

function previewHtml(r) {
  const totals = tradeTotals(r.items);
  const bad = r.checks.filter((c) => !c.ok);
  return `<p class="small">항목 <b>${r.items.length}</b>개 · 공종 ${totals.length}개 · 항목 합계 <b>${won(r.total)}</b>${r.fileTotal != null ? ` · 파일 총계 ${won(r.fileTotal)}` : ''}</p>
    ${bad.length ? `<p class="notice warn small">${icon('alert')}<span>합계가 안 맞는 줄 ${bad.length}개: ${bad.slice(0, 5).map((c) => `${esc(c.label)}(파일 ${won(c.file)} / 항목 합 ${won(c.computed)})`).join(', ')}. 열 대응이나 파일을 확인하세요.</span></p>`
      : r.checks.length ? `<p class="small t-ok">${icon('check')}소계·총계 ${r.checks.length}줄이 항목 합과 맞습니다.</p>` : '<p class="small muted">파일에 소계·합계 줄이 없어 대조하지 않았습니다.</p>'}
    <table class="mini-table cs-prev"><tr><th>공종</th><th>금액</th></tr>${totals.slice(0, 12).map((x) => `<tr><td>${esc(x.trade)}</td><td>${won(x.amount)}</td></tr>`).join('')}</table>
    <table class="mini-table cs-prev"><tr><th>품명</th><th>규격</th><th>단위</th><th>수량</th><th>단가</th></tr>${r.items.slice(0, 6).map((it) => `<tr><td>${esc(it.name)}</td><td>${esc(it.spec)}</td><td>${esc(it.unit)}</td><td>${n2(it.qty)}</td><td>${won(it.totalUnit)}</td></tr>`).join('')}</table>`;
}

function mapHtml() {
  const u = ui.upload;
  const sheet = u.sheets[u.sheet];
  const grid = plainGrid(sheet);
  const labels = headerLabels(grid, u.format.row, u.format.lines === 2);
  const opts = (k) => `<option value="">(없음)</option>${labels.map((l, i) => (l ? `<option value="${i}" ${u.format.columns[k] === i ? 'selected' : ''}>${esc(l.slice(0, 30))}</option>` : '')).join('')}`;
  return `<div class="grid2">
      <label class="field"><span>시트</span><select name="sheet" data-cs="sheet">${u.sheets.map((s, i) => `<option value="${i}" ${i === u.sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field"><span>머리글 줄(위에서)</span><input name="row" type="number" min="1" max="30" value="${u.format.row + 1}" data-cs="row"></label>
    </div>
    <label class="check"><input type="checkbox" name="two" data-cs="two" ${u.format.lines === 2 ? 'checked' : ''}><span>머리글이 두 줄(병합: 재료비 → 단가·금액)</span></label>
    <details class="cs-cols" ${u.reused ? '' : 'open'}><summary class="small">열 대응 ${u.reused ? `— 저장한 양식(${esc(u.reusedFrom || '')})으로 읽었습니다` : '확인'}</summary>
      <div class="cs-grid">${FIELDS.map((k) => `<label class="field"><span>${esc(COST_LABEL[k])}</span><select name="col_${k}" data-cs="col">${opts(k)}</select></label>`).join('')}</div>
    </details>
    <div id="cs-preview">${previewHtml(u.result)}</div>`;
}

function rereadUpload() {
  const u = ui.upload;
  u.result = readCost(plainGrid(u.sheets[u.sheet]), u.format);
  const box = $('#cs-map');
  if (box) box.innerHTML = mapHtml();
}

async function startUpload(file) {
  const sheets = await readBook(file);
  if (!sheets.length) throw new Error('시트가 없는 파일입니다.');
  // 저장한 양식부터 맞춰 보고, 없으면 자동으로 찾는다
  let r = null;
  let from = '';
  for (const f of savedFormats()) { const x = readCostBook(sheets, f); if (x?.reused && x.items.length) { r = x; from = f.from; break; } }
  r ||= readCostBook(sheets);
  if (!r) throw new Error('내역서 머리글(품명·단위·단가 또는 금액)을 찾지 못했습니다. 엑셀에서 머리글 줄이 있는 시트를 확인해주세요.');
  const index = sheets.findIndex((s) => s.name === r.format.sheet);
  ui.upload = { file: { name: file.name }, sheets, sheet: Math.max(0, index), format: r.format, result: r, reused: r.reused, reusedFrom: from };
  const v = bimViewerState();
  const admin = isAdmin();
  openModal({
    title: '내역서 올리기 — 열 확인',
    wide: true,
    body: `<form id="f-cost" data-form="cs-save" novalidate>
      <p class="muted small">회사마다 양식이 달라 열 대응을 사람이 확인합니다. 저장하면 이 양식을 기억해서 다음 내역서는 바로 읽습니다. 원본 파일은 저장하지 않습니다.</p>
      <div id="cs-map">${mapHtml()}</div>
      <div class="grid2">
        <label class="field"><span>내역서 이름</span><input name="name" maxlength="100" required value="${esc(file.name.replace(/\.[^.]+$/, '').slice(0, 100))}"></label>
        <label class="field"><span>공종(선택)</span><input name="trade" maxlength="30" placeholder="예: 건축, 마감"></label>
      </div>
      ${admin ? `<label class="check"><input type="checkbox" name="company"><span>회사 공통 내역서(모든 현장에서 단가로 씀)</span></label>
      <label class="check"><input type="checkbox" name="confidential"><span>기밀(실행내역 등) — 운영자만 봅니다</span></label>` : ''}
      <p class="small muted">${esc(v ? '' : '')}단가·금액은 금액 권한이 있는 사람만 봅니다(조회 권한은 못 봄).</p>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" form="f-cost" class="btn primary">${icon('check')}저장</button>`,
  });
}

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'cs-file' && el.files?.[0]) {
    const f = el.files[0];
    el.value = '';
    startUpload(f).catch((err) => toast(err.message, 'warn'));
    return;
  }
  if (el.dataset?.cs && ui.upload && el.closest('#f-cost')) {
    const u = ui.upload;
    const form = el.closest('form');
    if (el.dataset.cs === 'sheet') {
      u.sheet = Number(el.value);
      const h = findCostHeader(plainGrid(u.sheets[u.sheet]));
      u.format = h ? { sheet: u.sheets[u.sheet].name, row: h.row, lines: h.lines, columns: h.columns } : { sheet: u.sheets[u.sheet].name, row: 0, lines: 1, columns: {} };
    } else if (el.dataset.cs === 'row' || el.dataset.cs === 'two') {
      u.format = { ...u.format, row: Math.max(0, Number(form.row.value) - 1), lines: form.two.checked ? 2 : 1 };
    } else {
      const columns = {};
      for (const k of FIELDS) { const x = form[`col_${k}`]?.value; if (x !== '' && x != null) columns[k] = Number(x); }
      u.format = { ...u.format, columns };
    }
    u.reused = false;
    rereadUpload();
    return;
  }
  if (el.id === 'cs-filter') { ui.filter = el.value; viewerRenderTab(); }
  if (el.id === 'cs-threshold') { ui.threshold = Math.max(1, Math.min(100, Number(el.value) || 10)); try { localStorage.setItem('baromap.cost.threshold', String(ui.threshold)); } catch { /* 무시 */ } viewerRenderTab(); }
  if (el.id === 'cs-diff') {
    const v = bimViewerState();
    const other = v?.versions?.find((x) => x.id === el.value);
    if (!other) { ui.diff = null; viewerRenderTab(); return; }
    const box = $('#cs-diff-box');
    if (box) box.innerHTML = '<p class="muted small loading">비교하는 중…</p>';
    Promise.all([modelTakeoff(other), modelTakeoff(v.model)]).then(([a, b]) => { ui.diff = { id: other.id, version: other.version, rows: costDiff(a, b, S.links, S.items) }; viewerRenderTab(); }).catch((err) => toast(err.message, 'warn'));
  }
});

onForm('cs-save', async (f) => {
  const v = bimViewerState();
  const u = ui.upload;
  const r = u.result;
  if (!r.items.length) throw new Error('읽은 항목이 없습니다. 열 대응을 확인해주세요.');
  if (!r.items.every((it) => it.name)) throw new Error('품명 열을 골라주세요.');
  const bad = r.checks.filter((c) => !c.ok).map((c) => c.label);
  const company = isAdmin() && Boolean(f.company);
  const format = { ...u.format, labels: headerLabels(plainGrid(u.sheets[u.sheet]), u.format.row, u.format.lines === 2).slice(0, 40), check: { lines: r.checks.length, bad: bad.slice(0, 20) } };
  await store.cost.createBook(company ? null : v.siteId, { meta: { name: f.name, trade: f.trade || '', fileName: u.file.name, format, confidential: isAdmin() && Boolean(f.confidential) }, items: r.items });
  closeModal(true);
  ui.upload = null;
  toast(`내역서를 저장했습니다(항목 ${r.items.length}개).${bad.length ? ` 합계가 안 맞는 줄 ${bad.length}개는 확인이 필요합니다.` : ''}`);
  ui.filter = 'todo';
  await refresh();
});

// ---------------------------------------------------------------- [단가] 탭

const targetName = (key) => S.targets?.find((t) => t.key === key)?.name || key;
const linkOf = (itemId) => S.links.find((l) => l.itemId === itemId && l.confirmed);

function linkListHtml(edit) {
  const items = [...S.items.values()];
  const st = linkStatus(S.items, S.links, S.targets, S.recs);
  const ai = S.ai || new Map();
  let list;
  if (ui.filter === 'done') list = items.filter((it) => linkOf(it.id));
  else if (ui.filter === 'none') list = items.filter((it) => !linkOf(it.id) && !S.recs.get(it.id)?.length && !ai.get(it.id));
  else if (ui.filter === 'missing') list = null;
  else list = items.filter((it) => !linkOf(it.id) && (S.recs.get(it.id)?.length || ai.get(it.id)));
  const row = (it) => {
    const l = linkOf(it.id);
    if (l) return `<li class="cs-link done"><div><b>${esc(it.name)}</b> <small class="muted">${esc(it.spec)} · ${esc(it.unit)}</small><br><span class="small">→ ${esc(targetName(l.targetKey))}${Number(l.factor) !== 1 ? ` × ${n2(l.factor)}(${esc(l.modelUnit || '')}→${esc(it.unit)})` : ''}</span></div>
      ${edit ? `<button type="button" class="btn sm ghost" data-act="cs-unlink" data-id="${esc(l.id)}">풀기</button>` : ''}</li>`;
    const recs = [...(S.recs.get(it.id) || [])];
    const a = ai.get(it.id);
    if (a && !recs.some((x) => x.key === a.targetKey)) { const t = S.targets.find((x) => x.key === a.targetKey); if (t) recs.push({ ...t, score: a.confidence, why: 'AI 후보' }); }
    const top = recs[0];
    const needF = top && top.units?.length && !top.units.includes(normUnit(it.unit));
    return `<li class="cs-link"><div><b>${esc(it.name)}</b> <small class="muted">${esc(it.spec)} · ${esc(it.unit)} · ${esc(it.path?.[0] || '')}</small>
      ${recs.length && edit ? `<div class="cs-pick"><select id="cs-pick-${esc(it.id)}" aria-label="연결 대상">${recs.map((x) => `<option value="${esc(x.key)}">${esc(x.name)} (${esc(x.why)} ${Math.round(x.score * 100)}%)</option>`).join('')}</select>
        <input id="cs-f-${esc(it.id)}" type="number" step="any" min="0" placeholder="환산 계수" aria-label="환산 계수" ${needF ? 'required' : 'hidden'} title="모델 ${esc((top.units || []).join('·'))} × 계수 = ${esc(it.unit)}">
        <button type="button" class="btn sm" data-act="cs-link-ok" data-id="${esc(it.id)}">${icon('check')}확인</button></div>${needF ? `<p class="small t-warn">단위가 달라(모델 ${esc(top.units.join('·'))} ↔ 내역 ${esc(it.unit)}) 환산 계수를 넣어야 합니다.</p>` : ''}`
        : recs.length ? `<p class="small muted">후보: ${esc(recs[0].name)}</p>` : '<p class="small muted">모델에서 후보를 못 찾았습니다(거푸집·철근처럼 모델에 없는 항목일 수 있습니다).</p>'}</div></li>`;
  };
  return `<p class="small cs-stat">연결됨 <b>${st.linked}</b> · 확인 필요 <b>${st.suggested}</b> · 못 찾음 <b>${st.notFound}</b> · 내역서에 없는 재료 <b>${st.missing.length}</b></p>
    <div class="to-tools"><label class="field"><span class="sr-only">보기</span><select id="cs-filter">
      ${[['todo', '확인 필요'], ['done', '연결됨'], ['none', '못 찾음'], ['missing', '내역서에 없는 재료']].map(([k, l]) => `<option value="${k}" ${ui.filter === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${edit && ui.filter === 'todo' && st.suggested ? `<button type="button" class="btn sm" data-act="cs-link-all">${icon('check')}1순위 모두 확인(단위 같은 것)</button>` : ''}
      ${edit && aiOn() && st.notFound ? `<button type="button" class="btn sm ghost" data-act="cs-ai">AI 후보 받기</button>` : ''}</div>
    ${list ? `<ul class="cs-links">${list.slice(0, 120).map(row).join('') || '<li class="muted small">없습니다.</li>'}</ul>`
      : `<ul class="cs-links">${st.missing.slice(0, 120).map((t) => `<li class="cs-link"><div><b>${esc(t.name)}</b> <small class="muted">${esc((t.units || []).join('·'))}</small></div></li>`).join('') || '<li class="muted small">없습니다.</li>'}</ul>`}`;
}

function summaryHtml() {
  const rows = costRows(costScope(S.t, 'site'), S.links, S.items);
  if (!rows.length) return '<p class="muted small">확인된 연결이 없어 금액을 계산하지 않았습니다.</p>';
  const total = sumAmount(rows);
  const cmp = boqCompare(S.t, S.links, S.items, { threshold: ui.threshold / 100 });
  const v = bimViewerState();
  const others = (v.versions || []).filter((x) => x.id !== v.model.id);
  return `<p class="small">현장 전체 참고 금액 <b class="cs-total">${won(total)}</b> <span class="muted">(${rows.length}개 연결)</span></p>
    <h4>공종별</h4><table class="mini-table cs-trade">${costByTrade(rows).map((x) => `<tr><td>${esc(x.trade)}</td><td>${won(x.amount)}</td></tr>`).join('')}</table>
    <h4>동별</h4><table class="mini-table cs-bd">${costByBuilding(S.t, S.links, S.items).filter((x) => x.amount).map((x) => `<tr><td>${esc(x.name)}</td><td>${won(x.amount)}</td></tr>`).join('')}</table>
    <h4>내역 수량 대 모델 수량</h4>
    <p class="small muted">차이가 큰 것은 노랑입니다. 내역서의 빠진 수량과 모델 오류를 함께 찾는 데 씁니다. 어느 쪽이 맞는지는 판단하지 않습니다.
      <label class="cs-th">기준 <input id="cs-threshold" type="number" min="1" max="100" value="${esc(ui.threshold)}">%</label></p>
    <div class="cs-scroll"><table class="mini-table cs-cmp"><tr><th>품명</th><th>단위</th><th>내역</th><th>모델</th><th>차이</th></tr>${cmp.map((x) => `<tr class="${x.big ? 'cs-big' : ''}"><td>${esc(x.name)}</td><td>${esc(x.unit)}</td><td>${n2(x.boqQty)}</td><td>${n2(x.modelQty)}</td><td>${pct(x.diff)}</td></tr>`).join('')}</table></div>
    ${others.length ? `<h4>버전 금액 증감</h4><label class="field"><span class="sr-only">비교할 버전</span><select id="cs-diff"><option value="">버전과 비교</option>${others.map((m) => `<option value="${esc(m.id)}" ${ui.diff?.id === m.id ? 'selected' : ''}>v${m.version} → 지금</option>`).join('')}</select></label>
      <div id="cs-diff-box">${ui.diff ? (ui.diff.rows.length ? `<table class="mini-table cs-vdiff"><tr><th>품명</th><th>수량 증감</th><th>금액 증감</th></tr>${ui.diff.rows.slice(0, 60).map((x) => `<tr><td>${esc(x.name)}</td><td>${x.qtyDiff > 0 ? '+' : ''}${n2(x.qtyDiff)} ${esc(x.unit)}</td><td class="${x.amountDiff > 0 ? 't-warn' : ''}">${x.amountDiff > 0 ? '+' : ''}${won(x.amountDiff)}</td></tr>`).join('')}</table>
        <p class="small">합계 ${won(ui.diff.rows.reduce((s, x) => s + x.amountDiff, 0))}</p>` : '<p class="small muted">금액이 바뀐 연결이 없습니다.</p>') : ''}</div>` : ''}`;
}

addViewerHook('tabs', {
  key: 'cost',
  title: '단가',
  when: (siteId) => money(siteId) && Boolean(store.cost),
  render(el, v) {
    if (!money(v.siteId)) { el.innerHTML = '<p class="muted small">단가·금액을 볼 권한이 없습니다.</p>'; return; }
    if (S.key !== `${v.siteId}|${v.model.id}` || !S.ready) {
      el.innerHTML = '<p class="muted small loading">내역서와 수량을 불러오는 중…</p>';
      load().then(() => { if (bimViewerState()?.tab === 'cost') viewerRenderTab(); }).catch((err) => { el.innerHTML = `<p class="t-warn small">${esc(err.message)}</p>`; });
      return;
    }
    const edit = canEdit(v.siteId);
    el.innerHTML = `<p class="notice small">${icon('alert')}<span>${esc(MONEY_NOTE)}. 단가는 회사 기밀입니다(화면 캡처·공유 주의).</span></p>
      ${S.error ? `<p class="t-warn small">${esc(S.error)}</p>` : ''}
      <h4>내역서 <small class="muted">${S.books.length}</small></h4>
      <ul class="cs-books">${S.books.map((b) => `<li><div><b>${esc(b.name)}</b> ${!b.siteId ? '<span class="badge info">회사 공통</span>' : ''}${b.confidential ? '<span class="badge warn">기밀</span>' : ''}
          <br><small class="muted">항목 ${b.itemCount}개${b.totalAmount != null ? ` · ${won(b.totalAmount)}` : ''}${b.format?.check?.bad?.length ? ` · <span class="t-warn">합계 안 맞음 ${b.format.check.bad.length}</span>` : b.format?.check?.lines ? ' · 합계 대조 맞음' : ''}</small></div>
          ${edit && (b.siteId || isAdmin()) ? `<button type="button" class="btn sm ghost" data-act="cs-book-del" data-id="${esc(b.id)}" aria-label="${esc(b.name)} 지우기">${icon('trash')}</button>` : ''}</li>`).join('') || '<li class="muted small">아직 없습니다. 회사 공종별 내역서(엑셀)를 올리거나, 재료 카드에서 단가를 직접 넣으세요.</li>'}</ul>
      ${edit ? `<label class="btn sm file-btn">${icon('upload')}내역서 올리기(.xlsx·.xls)<input type="file" id="cs-file" accept=".xlsx,.xls"></label>` : ''}
      ${S.items.size ? `<h4>모델과 잇기</h4>${linkListHtml(edit)}<h4>금액</h4>${summaryHtml()}` : ''}`;
  },
});

// 장면이 바뀌면 미리 불러 둔다
addViewerHook('scene', (v) => { if (v?.model && store.cost) load().then(() => viewerRenderPanel()).catch(() => {}); });

function userFactor(id) {
  const x = $(`#cs-f-${CSS.escape(id)}`);
  if (!x || x.hidden || x.value === '') return null;
  const f = Number(x.value);
  if (!(f > 0)) throw new Error('환산 계수는 0보다 큰 숫자로 넣어주세요.');
  return f;
}
async function confirmLink(it, target, factor) {
  const v = bimViewerState();
  const row = linkRow(v.siteId, it, target, factor);
  const rec = await store.cost.saveLink(row);
  // 회사 공통 사전에 쌓아 다음 현장의 후보로(금액 없음). 권한이 없으면 건너뛴다
  await store.cost.learn([dictRow(rec, it)]).catch(() => 0);
  return rec;
}
onAction('cs-link-ok', async (el) => {
  const it = S.items.get(el.dataset.id);
  const key = $(`#cs-pick-${CSS.escape(el.dataset.id)}`)?.value;
  const t = S.targets.find((x) => x.key === key);
  if (!it || !t) return;
  try {
    await confirmLink(it, t, userFactor(it.id));
    toast(`${it.name} → ${t.name} 연결했습니다.`);
    await refresh();
  } catch (err) { toast(err.message, 'warn'); }
});
onAction('cs-link-all', async (el) => {
  el.disabled = true;
  let n = 0;
  let skip = 0;
  for (const it of S.items.values()) {
    if (linkOf(it.id)) continue;
    const t = S.recs.get(it.id)?.[0];
    if (!t) continue;
    if (t.units?.length && !t.units.includes(normUnit(it.unit))) { skip++; continue; }
    await confirmLink(it, t, 1);
    n++;
  }
  toast(`${n}개를 연결했습니다.${skip ? ` 단위가 다른 ${skip}개는 환산 계수를 넣어 하나씩 확인하세요.` : ''}`);
  await refresh();
});
onAction('cs-unlink', async (el) => {
  await store.cost.removeLink(el.dataset.id);
  toast('연결을 풀었습니다.');
  await refresh();
});
onAction('cs-book-del', async (el) => {
  const b = S.books.find((x) => x.id === el.dataset.id);
  if (!b || !(await confirmDialog(`"${b.name}" 내역서와 그 연결을 지울까요? 되돌릴 수 없습니다.`, { ok: '지우기', danger: true }))) return;
  await store.cost.removeBook(b.id);
  toast('지웠습니다.');
  await refresh();
});
// AI 후보(켜져 있을 때만): 못 찾은 항목의 품명·규격·단위와 모델 대상 이름만 보낸다. 답은 후보이고 사람이 확인한다
async function aiCandidates() {
  const v = bimViewerState();
  const todo = [...S.items.values()].filter((it) => !linkOf(it.id) && !S.recs.get(it.id)?.length);
  const req = costAiRequest(todo, S.targets);
  const r = await store.ai.call('ai-ops', { kind: 'cost_link', siteId: v.siteId, ...req });
  const map = new Map();
  for (const x of r.rows || []) if (todo[x.i]) map.set(todo[x.i].id, x);
  S.ai = map;
  return map.size;
}
onAction('cs-ai', async (el) => {
  el.disabled = true;
  try {
    const n = await aiCandidates();
    toast(n ? `AI 후보 ${n}개를 붙였습니다. 확인하고 연결하세요.` : 'AI가 후보를 찾지 못했습니다.');
    ui.filter = 'todo';
    viewerRenderTab();
  } catch (err) { el.disabled = false; toast(err.message, 'warn'); }
});

// ---------------------------------------------------------------- 재료 카드: 공종·공사 업체·시공 기준·단가·금액(24 지시서 5절)

function tradeOfMaterial(m) {
  return S.t?.total.find((r) => r.materialId === m.id)?.trade || m.trades?.[0] || '';
}
// 골구도 진행: 이 재료에 걸리는 공종의 끝난 세대 수
function progressHtml(m, siteId) {
  const p = store.progress?.cached?.(siteId);
  if (!p?.sheets?.length) return '';
  for (const sh of p.sheets) {
    const i = (sh.trades || []).findIndex((tr) => tradeMaterials(tr).some((k) => materialMatches(m, k)));
    if (i < 0) continue;
    let done = 0;
    let all = 0;
    for (const units of Object.values(p.cells?.[sh.id] || {})) for (const c of Object.values(units || {})) { all++; if ((c?.step || 0) > i) done++; }
    return `<span class="muted"> · 골구도 ${esc(sh.name)} "${esc(sh.trades[i].name)}" 끝난 세대 ${done}${all ? `/${all}` : ''}</span>`;
  }
  return '';
}
function standardsFor(trade, m) {
  const list = (S.standards || []).filter((s) => (trade && s.trade === trade) || (s.materialKeys || []).includes(m.id));
  const kcs = KCS_DEFAULT[trade];
  const items = [];
  if (kcs && !list.some((s) => s.kind === 'kcs' && s.code === kcs[0])) items.push(`<li><a href="${KCS_HOME}" target="_blank" rel="noopener">KCS ${esc(kcs[0])} ${esc(kcs[1])}</a> <span class="badge warn">원문 확인 전</span></li>`);
  for (const s of list) {
    const label = s.kind === 'kcs' ? `KCS ${esc(s.code)} ${esc(s.title)}` : esc(s.title);
    const link = s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${label}</a>` : label;
    const doc = s.docId ? ` <button type="button" class="btn sm ghost" data-act="doc-open" data-id="${esc(s.docId)}" data-page="${esc(s.page || 1)}">${icon('file')}시방서${s.page ? ` ${esc(s.page)}쪽` : ''}</button>` : '';
    items.push(`<li>${link}${s.kind === 'company' ? ' <span class="badge info">회사 기준</span>' : ''}${!s.siteId ? '' : ' <span class="muted">이 현장</span>'}${s.body ? `<br><small class="muted">${esc(s.body.slice(0, 120))}</small>` : ''}${doc}</li>`);
  }
  return items;
}
function companiesFor(trade, buildingId) {
  const names = new Map((S.companies || []).map((c) => [c.id, c.name]));
  const set = (S.trades || []).filter((a) => a.trade === trade && (!a.buildingId || !buildingId || a.buildingId === buildingId));
  const out = set.map((a) => `${esc(names.get(a.companyId) || '협력사')}${a.buildingId ? ` <small class="muted">${esc(a.zone || a.buildingId)}</small>` : ''}${a.from || a.to ? ` <small class="muted">${esc(a.from || '')}~${esc(a.to || '')}</small>` : ''}`);
  if (!out.length) for (const c of (S.companies || []).filter((x) => x.active !== false && (x.trades || []).includes(trade))) out.push(`${esc(c.name)} <small class="muted">협력사 공종</small>`);
  return out;
}
// 이 재료에 걸린 연결(재료 전체, 재료|부위, 고른 외벽 패널의 구역)
function linksFor(m, panelCode) {
  return S.links.filter((l) => l.confirmed && (l.targetKey === m.id || l.targetKey.startsWith(`${m.id}|`) || (panelCode && l.targetKey === `zone:${panelCode}`)));
}

addMaterialSection((ctx, m) => {
  const v = bimViewerState();
  if (!v || !store.cost || !m) return '';
  if (S.key !== `${v.siteId}|${v.model.id}` || !S.ready) { load().then(() => viewerRenderPanel()).catch(() => {}); return '<p class="muted small cs-card">공종·업체·단가 불러오는 중…</p>'; }
  const edit = canEdit(v.siteId);
  const trade = tradeOfMaterial(m);
  const comps = companiesFor(trade, ctx?.building?.id);
  const stds = standardsFor(trade, m);
  let html = `<div class="cs-card"><table class="bv-props">
    <tr><th>공종</th><td>${esc(trade || '-')}${progressHtml(m, v.siteId)}</td></tr>
    <tr><th>공사 업체</th><td>${comps.join(', ') || '<span class="muted">지정 안 됨</span>'}${edit && trade ? ` <button type="button" class="link small" data-act="cs-trade-set" data-trade="${esc(trade)}">지정</button>` : ''}</td></tr>
    <tr><th>시공 기준</th><td>${stds.length ? `<ul class="cs-std">${stds.join('')}</ul>` : '<span class="muted">없음</span>'}${edit ? ` <button type="button" class="link small" data-act="cs-std-add" data-trade="${esc(trade)}" data-mat="${esc(m.id)}">회사 기준 추가</button>` : ''}</td></tr></table>`;
  if (money(v.siteId)) {
    const panel = ctx?.building?.facade?.panels?.find((p) => p.id === v.sel?.[0]);
    const zone = panel && ctx.building.facade.zones.find((z) => z.id === panel.zoneId);
    // 고른 구간에 이 재료가 쓰인 부위(천장·벽 등)에 맞는 연결만(부위 없는 연결은 늘 보인다)
    const parts = new Set(panel ? ['panel'] : v.sel?.[0] && ctx?.type ? (S.t.unitTypes[ctx.type.id]?.items || []).filter((i) => i.elementId === v.sel[0] && i.materialId === m.id).map((i) => i.part) : []);
    const list = linksFor(m, zone?.code).filter((l) => { const p = l.targetKey.split('|')[1]; return !p || !parts.size || parts.has(p); });
    const scopes = [];
    if (panel) { const net = Math.max(0, panel.areaM2 - (panel.openingAreaM2 || 0)); scopes.push(['이 구간', { rows: [{ materialId: m.id, part: 'panel', unit: '㎡', value: net }], zones: zone?.code ? { [zone.code]: net } : {} }]); } else if (v.sel?.[0] && ctx?.type) scopes.push(['이 구간', costScope(S.t, { elementId: v.sel[0], typeId: ctx.type.id })]);
    if (ctx?.type) scopes.push(['이 세대', costScope(S.t, `t:${ctx.type.id}`)]);
    if (ctx?.building) scopes.push(['이 동', costScope(S.t, `b:${ctx.building.id}`)]);
    scopes.push(['현장 전체', costScope(S.t, 'site')]);
    if (list.length) {
      html += `<table class="mini-table cs-price"><tr><th>단가</th><th>재료비</th><th>노무비</th><th>경비</th><th>합계</th></tr>${list.map((l) => { const it = S.items.get(l.itemId); return it ? `<tr><td>${esc(it.name)} <small class="muted">${esc(it.spec)} /${esc(it.unit)} · ${esc(targetName(l.targetKey))} · ${esc(it.source === 'manual' ? '직접 입력' : it.bookName || '')}</small></td><td>${won(it.materialUnit)}</td><td>${won(it.laborUnit)}</td><td>${won(it.expenseUnit)}</td><td>${won(it.totalUnit)}</td></tr>` : ''; }).join('')}</table>
        <table class="mini-table cs-amount to-levels"><tr><th>금액</th>${scopes.map(([n]) => `<th>${n}</th>`).join('')}</tr>${list.map((l) => { const it = S.items.get(l.itemId); return it ? `<tr><td>${esc(it.name)}</td>${scopes.map(([, sc]) => { const r = costRows(sc, [l], S.items)[0]; return `<td>${r ? won(r.amount) : '-'}</td>`; }).join('')}</tr>` : ''; }).join('')}</table>
        <p class="small muted">${esc(MONEY_NOTE)}</p>`;
    } else html += '<p class="small muted">단가 없음(내역서에 연결되지 않음)</p>';
    if (edit) html += `<button type="button" class="btn sm ghost" data-act="cs-manual" data-mat="${esc(m.id)}" data-zone="${esc(zone?.code || '')}">${icon('edit')}단가 직접 입력</button>`;
  }
  return `${html}</div>`;
});

// 단가 직접 입력(내역서 없이): 규격·단위·재료비·노무비·경비 → cost_items(source manual) + 확인된 연결
onAction('cs-manual', (el) => {
  const m = (S.t && [...S.targets].find((t) => t.key === el.dataset.mat)) || null;
  const zone = el.dataset.zone;
  const opts = S.targets.filter((t) => t.key === el.dataset.mat || t.key.startsWith(`${el.dataset.mat}|`) || (zone && t.key === `zone:${zone}`));
  const units = [...new Set(opts.flatMap((t) => t.units || []))];
  openModal({
    title: '단가 직접 입력',
    body: `<form id="f-cs-manual" data-form="cs-manual" novalidate>
      <p class="muted small">내역서가 없을 때 이 재료의 단가를 넣습니다. 이 현장에만 쓰입니다.</p>
      <label class="field"><span>연결할 모델 대상</span><select name="target">${opts.map((t) => `<option value="${esc(t.key)}" ${zone && t.key === `zone:${zone}` ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <div class="grid2"><label class="field"><span>품명</span><input name="name" maxlength="200" required value="${esc(m?.name?.split(' · ')[0] || '')}"></label>
      <label class="field"><span>규격</span><input name="spec" maxlength="200"></label></div>
      <label class="field"><span>단위</span><select name="unit">${(units.length ? units : ['㎡']).map((u) => `<option>${esc(u)}</option>`).join('')}</select></label>
      <div class="grid3"><label class="field"><span>재료비 단가(원)</span><input name="materialUnit" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="field"><span>노무비 단가(원)</span><input name="laborUnit" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="field"><span>경비 단가(원)</span><input name="expenseUnit" type="number" min="0" step="1" inputmode="numeric"></label></div>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" form="f-cs-manual" class="btn primary">${icon('check')}저장</button>`,
  });
});
onForm('cs-manual', async (f) => {
  const v = bimViewerState();
  const t = S.targets.find((x) => x.key === f.target);
  if (!t) throw new Error('연결할 대상을 골라주세요.');
  if ([f.materialUnit, f.laborUnit, f.expenseUnit].every((x) => x === '' || x == null)) throw new Error('단가를 하나 이상 넣어주세요.');
  const { item } = await store.cost.saveManual(v.siteId, { name: f.name, spec: f.spec, unit: f.unit, materialUnit: f.materialUnit, laborUnit: f.laborUnit, expenseUnit: f.expenseUnit });
  // 같은 대상의 예전 직접 입력 연결은 새 것으로 바꾼다
  for (const l of S.links.filter((x) => x.targetKey === t.key && S.items.get(x.itemId)?.source === 'manual')) await store.cost.removeLink(l.id).catch(() => {});
  await store.cost.saveLink({ siteId: v.siteId, targetKind: t.kind, targetKey: t.key, itemId: item.id, itemKey: itemKey(item), factor: 1, modelUnit: '', confirmed: true });
  closeModal(true);
  toast('단가를 저장했습니다.');
  await refresh();
});

// 공사 업체 지정: 공종(+ 동) → 협력사
onAction('cs-trade-set', (el) => {
  const v = bimViewerState();
  const comps = (S.companies || []).filter((c) => c.active !== false);
  const bds = v.ctx?.site?.buildings || [];
  openModal({
    title: `공사 업체 — ${el.dataset.trade}`,
    body: comps.length ? `<form id="f-cs-trade" data-form="cs-trade" novalidate>
      <input type="hidden" name="trade" value="${esc(el.dataset.trade)}">
      <label class="field"><span>협력사</span><select name="companyId" required>${comps.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>동(선택)</span><select name="buildingId"><option value="">모든 동</option>${bds.map((b) => `<option value="${esc(b.id)}" ${v.ctx?.building?.id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <div class="grid2"><label class="field"><span>시작일</span><input name="from" type="date"></label><label class="field"><span>종료일</span><input name="to" type="date"></label></div>
    </form>` : '<p class="muted">협력사가 아직 없습니다. 현장 운영의 [협력사]에서 먼저 넣어주세요.</p>',
    footer: comps.length ? `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" form="f-cs-trade" class="btn primary">${icon('check')}저장</button>` : '<button type="button" class="btn primary" data-act="modal-close">확인</button>',
  });
});
onForm('cs-trade', async (f) => {
  const v = bimViewerState();
  const b = v.ctx?.site?.buildings?.find((x) => x.id === f.buildingId);
  await store.rows('tradeAssignments').save({ siteId: v.siteId, trade: f.trade, companyId: f.companyId, buildingId: f.buildingId || null, zone: b?.name || '', from: f.from, to: f.to });
  closeModal(true);
  toast('공사 업체를 정했습니다.');
  await refresh();
});

// 회사 기준 추가(글·링크). 운영자는 회사 공통으로도 넣는다
onAction('cs-std-add', (el) => {
  openModal({
    title: `시공 기준 추가${el.dataset.trade ? ` — ${el.dataset.trade}` : ''}`,
    body: `<form id="f-cs-std" data-form="cs-std" novalidate>
      <input type="hidden" name="trade" value="${esc(el.dataset.trade)}"><input type="hidden" name="mat" value="${esc(el.dataset.mat)}">
      <label class="field"><span>기준 이름</span><input name="title" maxlength="200" required placeholder="예: 회사 도장 시공 기준 2026"></label>
      <label class="field"><span>링크(선택, https://)</span><input name="url" maxlength="500" inputmode="url"></label>
      <label class="field"><span>내용(선택)</span><textarea name="body" maxlength="4000" rows="4"></textarea></label>
      ${isAdmin() ? '<label class="check"><input type="checkbox" name="company"><span>회사 공통(모든 현장)</span></label>' : ''}
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" form="f-cs-std" class="btn primary">${icon('check')}저장</button>`,
  });
});
onForm('cs-std', async (f) => {
  const v = bimViewerState();
  await store.rows('workStandards').save({ siteId: isAdmin() && f.company ? null : v.siteId, kind: 'company', trade: f.trade, materialKeys: f.trade ? [] : [f.mat], title: f.title, url: f.url, body: f.body });
  closeModal(true);
  toast('시공 기준을 넣었습니다.');
  await refresh();
});
