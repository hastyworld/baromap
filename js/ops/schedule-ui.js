// 운영 → [예보] 탭의 [공정표](28 지시서 6절): 올리기, 판 목록, 표 보기(거르기), 간단 바차트, 연결 현황, 짝 고치기, 양식 내려받기, MS Project 저장 안내.
// 읽기·짝 짓기는 js/ops/schedule/의 순수 함수, 저장은 store.schedules. 공정표는 월별 진척(29 지시서)의 입력이다.
import { store, q } from '../ctx.js';
import { $, esc, icon, onAction, openModal, closeModal, toast, confirmDialog, fmtDate, download } from '../util.js';
import { xlsx } from '../excel-ui.js';
import { registerOpsTab } from './index.js';
import { aiOn } from './ai.js';
import { readSchedule, ScheduleError, MPP_HELP, ACCEPT, sniff } from './schedule/read.js';
import { matchActivities, modelIndex, dictMap, learnEntry, aiMatchRequest, applyAiMatch, acceptSuggest } from './schedule/match.js';
import { standardTemplate } from './schedule/template.js';
import { writeXlsx, XLSX_MIME } from './schedule/xlsx.js';
import { compareSchedules } from './schedule/compare.js';
import { FORMAT_KO, ZONE_KO, scheduleStats, daysBetween } from './schedule/core.js';
import { TRADE_NAMES } from './schedule/trades.js';
import { TABLE_LABELS } from './schedule/read-table.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38';
const STATUS = { active: ['활성', 'ok'], draft: ['초안', ''], archived: ['보관', ''] };
const SHOW = 300;
const FILTERS = [['all', '전체'], ['unlinked', '연결 안 됨'], ['errors', '오류'], ['summary', '요약 행']];

let V = null; // { el, ctx, list, sc, acts, filter, text, more, mctx, pending }
const canEdit = () => store.can('edit', V.ctx.siteId);
const errs = (a) => a.errors || a.source?.errors || [];

// ---------------------------------------------------------------- 짝 짓기 재료(모델·골구도·사전)

async function matchCtx() {
  if (V.mctx) return V.mctx;
  const { siteId } = V.ctx;
  let site = null;
  try {
    const versions = (await store.bim?.versions(siteId)) || [];
    const m = versions.find((x) => x.status === 'approved') || versions[0];
    if (m) site = await store.bim.load(m, 'site.json');
  } catch { /* 모델이 없거나 볼 수 없으면 이름 규칙만 */ }
  const prog = store.progress?.cached(siteId) || (await store.progress?.load(siteId).then(() => store.progress.cached(siteId)).catch(() => null));
  const siteTrades = [...new Set((prog?.sheets || []).flatMap((s) => s.trades.map((t) => t.name)))];
  const dict = dictMap(await store.schedules.dict.list().catch(() => []));
  const index = modelIndex({ site, buildings: prog?.buildings || [] });
  V.mctx = { index, dict, siteTrades, hasModel: Boolean(site) };
  return V.mctx;
}

// ---------------------------------------------------------------- 목록

async function loadList() {
  V.list = await store.schedules.list(V.ctx.siteId);
  if (!V) return;
  if (V.sc) {
    V.sc = V.list.find((s) => s.id === V.sc.id) || null;
    if (!V.sc) V.acts = null;
  }
  render();
}

const badge = (s) => {
  const [t, c] = STATUS[s.status] || STATUS.draft;
  return `<span class="badge ${c}">${t}</span>${s.baseline ? '<span class="badge info">기준</span>' : ''}${s.stats?.draft ? '<span class="badge warn">초안 판독</span>' : ''}`;
};
const period = (s) => (s.startDate && s.finishDate ? `${fmtDate(s.startDate)} ~ ${fmtDate(s.finishDate)}` : '기간 없음');

function renderList() {
  const active = V.list.find((s) => s.status === 'active');
  const ed = canEdit();
  V.el.innerHTML = `<div class="ops-pad">
    <div class="sc-title"><h2>공정표</h2><span class="muted small">월별 진척(4D)의 기준이 됩니다</span></div>
    ${active?.stats?.unlinked ? `<p class="notice crit">${icon('alert')}<span>활성 공정표(v${active.version})에 모델과 <b>연결 안 된 행 ${active.stats.unlinked}개</b>가 있습니다. <button type="button" class="link" data-act="sc-open" data-id="${esc(active.id)}" data-filter="unlinked">고치기</button></span></p>` : ''}
    <div class="ops-actions">
      ${ed ? `<button type="button" class="btn big primary" data-act="sc-upload">${icon('upload')}공정표 올리기</button>` : ''}
      <button type="button" class="btn big" data-act="sc-template">${icon('download')}표준 양식 받기</button>
      <button type="button" class="btn big ghost" data-act="sc-mpp-help">${icon('file')}MS Project 저장 안내</button>
    </div>
    <input type="file" id="sc-file" accept="${ACCEPT}" hidden>
    <ul class="dy-list sc-list">${V.list.map((s) => `<li><button type="button" class="dy-row" data-act="sc-open" data-id="${esc(s.id)}">
      <span class="sc-ver">v${s.version}</span>
      <span class="dy-main"><b>${esc(s.name)}</b><small class="muted"> · ${esc(FORMAT_KO[s.format] || s.format)} · ${period(s)} · 행 ${(s.stats?.rows ?? 0) - (s.stats?.summary ?? 0)}${s.stats?.unlinked ? ` · 연결 안 됨 ${s.stats.unlinked}` : ''}</small></span>
      <span class="sc-badges">${badge(s)}</span></button></li>`).join('')
      || `<li class="empty">아직 공정표가 없습니다.<br>${ed ? '표준 양식을 받아 채우거나, MS Project XML·P6 XER·엑셀·PDF를 올려 주세요.' : '현장 담당이 올리면 여기에 보입니다.'}</li>`}</ul>
    <p class="muted small">받는 형식: 바로맵 표준 공정표(가장 정확) · MS Project XML · Primavera XER · 표 엑셀·CSV · 바차트 엑셀(초안) · PDF(초안). MS Project 파일(.mpp)은 XML로 저장해서 올립니다.</p>
  </div>`;
}

// ---------------------------------------------------------------- 판 보기

async function openSchedule(id, filter) {
  V.sc = V.list.find((s) => s.id === id);
  V.filter = filter || 'all';
  V.text = '';
  V.more = false;
  V.el.innerHTML = '<p class="muted small loading ops-pad">불러오는 중…</p>';
  V.acts = await store.schedules.activities(id);
  V.base = null;
  const base = V.list.find((s) => s.baseline && s.id !== id) || V.list.find((s) => s.status === 'active' && s.id !== id);
  if (base) V.base = { sc: base, cmp: compareSchedules(await store.schedules.activities(base.id), V.acts) };
  if (V) render();
}

function bar(a, t0, span) {
  if (!a.start || !a.finish || a.summary) return '<span class="sc-track"></span>';
  const l = (daysBetween(t0, a.start) / span) * 100;
  const w = Math.max(0.6, ((daysBetween(a.start, a.finish) + 1) / span) * 100);
  const cls = !a.linked ? 'off' : a.outdoor ? 'out' : '';
  return `<span class="sc-track"><i class="${cls}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"></i></span>`;
}

const where = (a) => {
  if (!a.zone) return '<span class="t-warn">위치 없음</span>';
  const b = a.zone === 'building' ? `${a.building}동` : a.zone === 'facility' ? a.building : ZONE_KO[a.zone];
  const f = a.fromFloor ? ` ${a.fromFloor === a.toFloor ? a.fromFloor : `${a.fromFloor}~${a.toFloor}`}${/^\d/.test(a.toFloor) ? '층' : ''}` : '';
  return esc(`${b}${f}`);
};

function yearTicks(t0, t1, span) {
  const out = [];
  for (let y = Number(t0.slice(0, 4)) + 1; y <= Number(t1.slice(0, 4)); y++) out.push(`<span style="left:${((daysBetween(t0, `${y}-01-01`) / span) * 100).toFixed(2)}%">${y}</span>`);
  return `<div class="sc-axis"><span style="left:0">${t0.slice(0, 7).replace('-', '.')}</span>${out.join('')}</div>`;
}

function renderDetail() {
  const sc = V.sc;
  const ed = canEdit();
  const acts = V.acts || [];
  const st = scheduleStats(acts.map((a) => ({ ...a, errors: errs(a) })));
  const pick = { all: () => true, unlinked: (a) => !a.summary && !a.linked, errors: (a) => errs(a).length, summary: (a) => a.summary }[V.filter];
  const t = V.text.trim().toLowerCase();
  const shown = acts.filter((a) => pick(a) && (!t || `${a.actId} ${a.name} ${a.trade} ${a.building}`.toLowerCase().includes(t)));
  const t0 = sc.startDate || st.start || '2027-01-01';
  const t1 = sc.finishDate || st.finish || '2027-12-31';
  const span = Math.max(1, daysBetween(t0, t1) + 1);
  const count = { all: acts.length, unlinked: st.unlinked, errors: st.errors, summary: st.summary };
  const sug = acts.filter((a) => a.suggest).length;
  const c = V.base?.cmp;
  V.el.innerHTML = `<div class="ops-pad sc-pad">
    <div class="dy-top"><button type="button" class="btn" data-act="sc-back">${icon('back')}목록</button>
      <div class="dy-title"><b>v${sc.version} ${esc(sc.name)}</b>${badge(sc)}</div></div>
    <p class="muted small">${esc(FORMAT_KO[sc.format] || sc.format)}${sc.fileName ? ` · ${esc(sc.fileName)}` : ''} · ${period(sc)}${sc.stats?.precisionDays ? ` · 날짜 정밀도 약 ${sc.stats.precisionDays}일` : ''}</p>
    ${sc.stats?.draft ? `<p class="notice warn">${icon('alert')}<span>바차트·PDF에서 읽은 <b>초안</b>입니다. 원본과 막대를 비교해 날짜·위치를 확인한 뒤 활성으로 만드세요.</span></p>` : ''}
    <div class="sc-stats">
      <span><b>${st.linked}</b> 연결</span><span class="${st.unlinked ? 'crit' : ''}"><b>${st.unlinked}</b> 연결 안 됨</span>
      <span class="${st.errors ? 'warn' : ''}"><b>${st.errors}</b> 오류</span><span><b>${st.summary}</b> 요약 행(계산 제외)</span>
    </div>
    ${c ? `<p class="small sc-cmp">${V.base.sc.baseline ? '기준 공정표' : '활성 판'}(v${V.base.sc.version}) 대비: 준공 ${c.finishDays > 0 ? `<b class="t-warn">${c.finishDays}일 늦음</b>` : c.finishDays < 0 ? `${-c.finishDays}일 빠름` : '같음'} · 공기 ${c.durationDays >= 0 ? '+' : ''}${c.durationDays ?? 0}일 · 바뀐 행 ${c.changed} · 새 행 ${c.added} · 빠진 행 ${c.removed}</p>` : ''}
    <div class="ops-actions">
      ${ed && sc.status !== 'active' ? `<button type="button" class="btn primary" data-act="sc-activate">${icon('check')}활성으로${V.list.some((s) => s.baseline) ? '' : '(기준 공정표)'}</button>` : ''}
      ${ed && st.unlinked && aiOn() ? `<button type="button" class="btn" data-act="sc-ai">${icon('edit')}AI 짝 제안</button>` : ''}
      ${ed && sug ? `<button type="button" class="btn" data-act="sc-accept-all">${icon('check')}AI 제안 ${sug}개 모두 받기</button>` : ''}
      ${sc.path ? `<button type="button" class="btn" data-act="sc-file-get">${icon('download')}원본 받기</button>` : ''}
      ${ed ? `<button type="button" class="btn ghost" data-act="sc-delete">${icon('trash')}지우기</button>` : ''}
    </div>
    <div class="seg sc-seg" role="tablist">${FILTERS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${V.filter === k}" class="${V.filter === k ? 'on' : ''}" data-act="sc-filter" data-f="${k}">${l} <b>${count[k]}</b></button>`).join('')}</div>
    <label class="field sc-search"><span class="sr-only">찾기</span><input type="search" id="sc-q" placeholder="작업ID·이름·공종·동으로 찾기" value="${esc(V.text)}"></label>
    <div class="sc-gantt">
      ${yearTicks(t0, t1, span)}
      <ul class="sc-rows">${shown.slice(0, V.more ? 5000 : SHOW).map((a) => {
        const e = errs(a);
        const tag = ed && !a.summary ? 'button type="button"' : 'div';
        return `<li class="${a.summary ? 'sum' : !a.linked ? 'off' : ''}"><${tag} class="sc-row" ${ed && !a.summary ? `data-act="sc-edit" data-id="${esc(a.id)}"` : ''}>
          <span class="sc-name"><small>${esc(a.actId)}</small> ${esc(a.name)}</span>
          <span class="sc-meta">${a.summary ? '요약 행' : `${where(a)} · ${a.trade ? esc(a.trade) : '<span class="t-warn">공종 없음</span>'}`} · ${fmtDate(a.start)}~${fmtDate(a.finish).slice(a.start?.slice(0, 4) === a.finish?.slice(0, 4) ? 5 : 0)}${e.length ? ` · <span class="t-warn">${esc(e[0])}</span>` : ''}${a.source?.warnings?.length ? ` · <span class="muted">${esc(a.source.warnings[0])}</span>` : ''}</span>
          ${a.suggest ? `<span class="sc-sug">AI 제안: ${esc(ZONE_KO[a.suggest.zone] || '')} ${esc(a.suggest.building)} ${esc(a.suggest.trade)}</span>` : ''}
          ${bar(a, t0, span)}</${tag.split(' ')[0]}></li>`;
      }).join('') || '<li class="empty">조건에 맞는 행이 없습니다.</li>'}</ul>
      ${shown.length > SHOW && !V.more ? `<button type="button" class="btn sm" data-act="sc-more">${shown.length - SHOW}행 더 보기</button>` : ''}
    </div>
  </div>`;
  $('#sc-q', V.el)?.addEventListener('input', (ev) => { V.text = ev.target.value; clearTimeout(V.qt); V.qt = setTimeout(() => { const pos = ev.target.selectionStart; renderDetail(); const i = $('#sc-q', V.el); i?.focus(); i?.setSelectionRange(pos, pos); }, 250); });
}

function render() {
  if (!V) return;
  if (V.sc && V.acts) renderDetail(); else renderList();
}

// ---------------------------------------------------------------- 올리기

async function pdfItems(bytes) {
  const lib = await import(`${PDFJS}/build/pdf.min.mjs`);
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
  const doc = await lib.getDocument({ data: bytes.slice(), cMapUrl: `${PDFJS}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS}/standard_fonts/` }).promise;
  const pages = [];
  for (let n = 1; n <= Math.min(doc.numPages, 60); n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ w: vp.width, h: vp.height, items: tc.items.filter((i) => i.str?.trim()).map((i) => ({ str: i.str, x: i.transform[4], y: vp.height - i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]) })) });
    page.cleanup();
  }
  await doc.destroy();
  if (!pages.some((p) => p.items.length)) throw new ScheduleError('PDF에 글자가 없습니다(스캔한 그림 PDF). 스캔 PDF 판독은 회사 보안 승인 뒤 AI로 합니다. 지금은 엑셀이나 MS Project XML로 받아 주세요.', 'scan');
  return pages;
}

// 옛 엑셀(.xls)은 SheetJS로 칸 표를 만든다(색은 못 읽는다)
async function xlsGrid(bytes) {
  const X = await xlsx();
  const wb = X.read(bytes, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }).map((row) => row.map((v) => (v == null || v === '' ? null : v instanceof Date ? { v: v.toISOString().slice(0, 10), t: 'd' } : typeof v === 'number' ? { v, t: 'n' } : { v: String(v), t: 's' })));
}

function mppHelp(extra = '') {
  openModal({
    title: 'MS Project 파일 저장 안내',
    body: `${extra ? `<p class="notice warn">${icon('alert')}<span>${esc(extra)}</span></p>` : ''}
      <ol class="sc-steps">
        <li>MS Project에서 공정표 파일(.mpp)을 엽니다.</li>
        <li>[파일] → <b>[다른 이름으로 저장]</b>을 누릅니다.</li>
        <li>파일 형식에서 <b>"XML 형식(*.xml)"</b>을 고릅니다.</li>
        <li>저장한 .xml 파일을 바로맵 [공정표 올리기]로 올립니다.</li>
      </ol>
      <div class="sc-shot" aria-hidden="true"><div class="sc-shot-bar">다른 이름으로 저장</div>
        <div class="sc-shot-row"><span>파일 이름</span><i>바로마을 공정표</i></div>
        <div class="sc-shot-row"><span>파일 형식</span><i class="on">XML 형식(*.xml) ▾</i></div>
        <div class="sc-shot-btn">저장</div></div>
      <p class="muted small">Primavera P6는 [내보내기] → "Primavera PM(XER)"로 저장해서 올리면 됩니다. 엑셀로 만든 공정표는 [표준 양식 받기]의 양식에 옮기면 가장 정확합니다.</p>`,
    footer: '<button type="button" class="btn primary" data-act="modal-close">확인</button>',
  });
}

async function readFile(file, tableMap) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(file.name, bytes);
  if (kind === 'mpp') throw new ScheduleError(MPP_HELP, 'mpp');
  const o = { tableMap };
  if (kind === 'pdf') o.pdfPages = await pdfItems(bytes);
  if (kind === 'xls') o.grid = await xlsGrid(bytes);
  return readSchedule({ name: file.name, bytes }, o);
}

function mapDialog(file, r) {
  const opts = (sel) => `<option value="">(없음)</option>${r.headers.map((h, i) => (h ? `<option value="${i}" ${String(sel) === String(i) ? 'selected' : ''}>${esc(h)}</option>` : '')).join('')}`;
  const fields = ['name', 'start', 'finish', 'actId', 'building', 'floors', 'trade', 'outline'];
  openModal({
    title: '열 고르기',
    body: `<p class="muted small">표의 머리글을 알아보지 못했습니다. 각 칸이 어느 열인지 골라 주세요. <b>작업 이름·시작일·종료일</b>은 꼭 필요합니다.</p>
      ${r.sheets?.length > 1 ? `<label class="field"><span>시트</span><select id="sc-map-sheet">${r.sheets.map((s) => `<option ${s === r.sheet ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span>머리글 줄 번호</span><input id="sc-map-header" type="number" min="1" max="30" value="${r.header + 1}"></label>
      <div class="grid3">${fields.map((f) => `<label class="field"><span>${esc(TABLE_LABELS[f])}${['name', 'start', 'finish'].includes(f) ? '<em>*</em>' : ''}</span><select data-map="${f}">${opts(r.map[f])}</select></label>`).join('')}</div>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="button" class="btn primary" data-act="sc-map-go">${icon('check')}이 열로 읽기</button>`,
    wide: true,
  });
  V.pending = { file };
}

async function previewDialog(file, r) {
  const ctx = await matchCtx();
  const matched = matchActivities(r.activities, ctx);
  const st = scheduleStats(matched);
  V.pending = { file, r, matched };
  const unl = matched.filter((a) => !a.summary && !a.linked);
  const bad = matched.filter((a) => a.errors?.length);
  const warns = [...(r.warnings || []), ...(!ctx.hasModel ? ['이 현장에 3D 모델이 아직 없어 이름만으로 동·층을 풀었습니다. 모델을 만든 뒤 다시 짝을 맞출 수 있습니다.'] : [])];
  openModal({
    title: '공정표 확인',
    body: `<p><b>${esc(file.name)}</b> · ${esc(FORMAT_KO[r.format] || r.format)}${r.encoding ? ` · 글자 ${r.encoding.toUpperCase()}` : ''}${r.draft ? ' · <span class="badge warn">초안</span>' : ''}</p>
      <div class="sc-stats"><span><b>${st.rows - st.summary}</b> 공정 행</span><span><b>${st.linked}</b> 연결</span><span class="${st.unlinked ? 'crit' : ''}"><b>${st.unlinked}</b> 연결 안 됨</span><span class="${st.errors ? 'warn' : ''}"><b>${st.errors}</b> 오류</span><span><b>${st.summary}</b> 요약 행</span></div>
      <p class="small">기간 ${fmtDate(st.start)} ~ ${fmtDate(st.finish)}${r.calendar ? ` · 휴일 ${r.calendar.holidays.length}일${r.calendar.stops?.length ? ` · 중단 ${r.calendar.stops.length}건` : ''}` : ' · 달력은 운영 설정을 씀'}</p>
      ${warns.map((w) => `<p class="notice warn">${icon('alert')}<span>${esc(w)}</span></p>`).join('')}
      ${unl.length ? `<p class="small"><b>연결 안 됨</b>(지우지 않고 남깁니다. 저장한 뒤 눌러서 고칠 수 있어요): ${unl.slice(0, 8).map((a) => esc(a.name)).join(', ')}${unl.length > 8 ? ` 외 ${unl.length - 8}개` : ''}</p>` : ''}
      ${bad.length ? `<p class="small t-warn">오류 ${bad.length}행: ${bad.slice(0, 5).map((a) => esc(`${a.actId} ${a.errors[0]}`)).join(' / ')}</p>` : ''}
      <label class="field"><span>판 이름</span><input id="sc-name" maxlength="100" value="${esc((r.name || file.name.replace(/\.[^.]+$/, '')).slice(0, 100))}"></label>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="button" class="btn primary" data-act="sc-save">${icon('check')}${r.draft ? '초안으로 ' : ''}저장</button>`,
    wide: true,
  });
}

async function startUpload(file, tableMap) {
  try {
    const r = await readFile(file, tableMap);
    if (r.needsMapping) return mapDialog(file, r);
    if (!r.activities.length) throw new ScheduleError(r.warnings?.[0] || '공정 행을 찾지 못했습니다.', 'empty');
    await previewDialog(file, r);
  } catch (err) {
    if (err.code === 'mpp') { mppHelp('MS Project 파일(.mpp)은 바로 읽지 못합니다. 아래처럼 XML로 저장해 올려 주세요.'); return; }
    toast(err.message, 'warn');
  }
}

// ---------------------------------------------------------------- 짝 고치기

function editDialog(a) {
  const { index, siteTrades } = V.mctx || { index: modelIndex(), siteTrades: [] };
  const blds = [...index.buildings.keys()];
  const facs = index.facilities.map((f) => f.name);
  const trades = [...new Set([...siteTrades, ...TRADE_NAMES])];
  openModal({
    title: '짝 고치기',
    body: `<p><small class="muted">${esc(a.actId)}</small> <b>${esc(a.name)}</b><br><span class="muted small">${fmtDate(a.start)} ~ ${fmtDate(a.finish)}${a.wbs?.length ? ` · ${esc(a.wbs.join(' > '))}` : ''}</span></p>
      <div class="grid3">
        <label class="field"><span>구역</span><select id="sc-e-zone">${[['', '위치 없음'], ...Object.entries(ZONE_KO).filter(([k]) => k !== 'unknown')].map(([k, l]) => `<option value="${k}" ${a.zone === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="field"><span>동·시설</span><input id="sc-e-bld" list="sc-e-blds" maxlength="30" value="${esc(a.building)}"><datalist id="sc-e-blds">${[...blds, ...facs].map((b) => `<option value="${esc(b)}">`).join('')}</datalist></label>
        <label class="field"><span>공종</span><input id="sc-e-trade" list="sc-e-trades" maxlength="30" value="${esc(a.trade)}"><datalist id="sc-e-trades">${trades.map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label>
        <label class="field"><span>시작층</span><input id="sc-e-f0" maxlength="5" placeholder="B2·1·PH" value="${esc(a.fromFloor)}"></label>
        <label class="field"><span>끝층</span><input id="sc-e-f1" maxlength="5" placeholder="15·PH" value="${esc(a.toFloor)}"></label>
      </div>
      <p class="muted small">고친 공종·구역은 회사 공종 사전에 쌓여 다음 공정표부터 먼저 쓰입니다.</p>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="button" class="btn primary" data-act="sc-e-save" data-id="${esc(a.id)}">${icon('check')}저장</button>`,
    wide: true,
  });
}

async function saveFix(a, patch, how = 'human') {
  const row = { ...a, ...patch, source: { ...a.source, match: how } };
  delete row.suggest;
  row.linked = Boolean(row.trade && row.zone && (row.zone !== 'building' || row.building));
  const rec = await store.schedules.saveActivity(row);
  const e = learnEntry(rec);
  if (e) await store.schedules.dict.learn([e], V.ctx.siteId).catch(() => 0);
  return rec;
}

// ---------------------------------------------------------------- 단추

onAction('sc-upload', () => $('#sc-file', V?.el)?.click());
onAction('sc-open', (el) => openSchedule(el.dataset.id, el.dataset.filter));
onAction('sc-back', () => { V.sc = null; V.acts = null; loadList(); });
onAction('sc-filter', (el) => { V.filter = el.dataset.f; V.more = false; renderDetail(); });
onAction('sc-more', () => { V.more = true; renderDetail(); });
onAction('sc-mpp-help', () => mppHelp());
onAction('sc-template', async () => {
  try {
    const { index, siteTrades } = await matchCtx();
    const settings = await store.ops.settings(V.ctx.siteId).catch(() => null);
    const site = q.site(V.ctx.siteId);
    const sheets = standardTemplate({ siteName: site?.name, buildings: [...index.buildings.keys()], trades: siteTrades, holidays: settings?.holidays || [] });
    download(`바로맵_표준공정표_${(site?.name || '현장').slice(0, 30)}.xlsx`, new Blob([await writeXlsx(sheets)], { type: XLSX_MIME }));
  } catch (err) { toast(err.message, 'warn'); }
});
onAction('sc-map-go', () => {
  const map = {};
  document.querySelectorAll('[data-map]').forEach((s) => { if (s.value !== '') map[s.dataset.map] = Number(s.value); });
  if (!['name', 'start', 'finish'].every((f) => f in map)) { toast('작업 이름·시작일·종료일 열을 골라 주세요.', 'warn'); return; }
  const header = Math.max(0, Number($('#sc-map-header')?.value || 1) - 1);
  const sheet = $('#sc-map-sheet')?.value;
  const { file } = V.pending;
  closeModal();
  startUpload(file, { header, map, sheet });
});
onAction('sc-save', async (el) => {
  const p = V.pending;
  if (!p?.r) return;
  el.disabled = true;
  try {
    const name = $('#sc-name')?.value.trim() || p.file.name;
    const sc = await store.schedules.create(V.ctx.siteId, {
      meta: { name, format: p.r.format, fileName: p.file.name.slice(0, 200), calendar: p.r.calendar || {}, floors: p.r.floors || [], note: p.r.draft ? '초안 판독 — 사람 확인 필요' : '', stats: { draft: Boolean(p.r.draft), encoding: p.r.encoding || '', precisionDays: p.r.precision || null } },
      activities: p.matched,
      file: p.file,
    });
    closeModal();
    toast(`공정표 v${sc.version}을 초안으로 저장했습니다.`);
    V.pending = null;
    await loadList();
    await openSchedule(sc.id, sc.stats?.unlinked ? 'unlinked' : 'all');
  } catch (err) {
    el.disabled = false;
    toast(err.message, 'warn');
  }
});
onAction('sc-edit', async (el) => { await matchCtx(); editDialog(V.acts.find((a) => a.id === el.dataset.id)); });
onAction('sc-e-save', async (el) => {
  const a = V.acts.find((x) => x.id === el.dataset.id);
  const up = (s) => s.trim().toUpperCase().replace(/층|F$/g, '');
  try {
    const rec = await saveFix(a, { zone: $('#sc-e-zone').value, building: $('#sc-e-bld').value.trim().replace(/동$/, ''), trade: $('#sc-e-trade').value.trim(), fromFloor: up($('#sc-e-f0').value), toFloor: up($('#sc-e-f1').value || $('#sc-e-f0').value) });
    closeModal();
    Object.assign(a, rec);
    V.sc = await store.schedules.get(V.sc.id);
    renderDetail();
    toast(rec.linked ? '연결했습니다.' : '저장했습니다. 아직 연결 안 됨입니다(구역·공종 필요).');
  } catch (err) { toast(err.message, 'warn'); }
});
onAction('sc-activate', async () => {
  const first = !V.list.some((s) => s.baseline);
  const ok = await confirmDialog(`v${V.sc.version}을 활성 공정표로 만들까요?${first ? '\n처음 활성으로 만드는 판이라 기준 공정표가 됩니다.' : '\n지금 활성인 판은 보관으로 바뀝니다.'}`, { ok: '활성으로' });
  if (!ok) return;
  try {
    V.sc = await store.schedules.activate(V.sc.id);
    toast('활성 공정표로 만들었습니다.');
    await loadList();
  } catch (err) { toast(err.message, 'warn'); }
});
onAction('sc-delete', async () => {
  if (!(await confirmDialog(`v${V.sc.version} 공정표를 지울까요? 되돌릴 수 없습니다.`, { ok: '지우기', danger: true }))) return;
  try {
    await store.schedules.remove(V.sc.id);
    V.sc = null;
    V.acts = null;
    toast('지웠습니다.');
    await loadList();
  } catch (err) { toast(err.message, 'warn'); }
});
onAction('sc-file-get', async () => {
  try { window.open(await store.schedules.fileUrl(V.sc), '_blank', 'noopener'); } catch (err) { toast(err.message, 'warn'); }
});
// AI 짝 제안(켜져 있을 때만): 행 이름·WBS만 보낸다(금액·날짜 없음, 26 지시서 6절). 답은 제안으로만 붙고 사람이 받는다
onAction('sc-ai', async (el) => {
  el.disabled = true;
  try {
    const { index, siteTrades } = await matchCtx();
    const payload = aiMatchRequest(V.acts, { buildings: [...index.buildings.keys(), ...index.facilities.map((f) => f.name)], trades: [...new Set([...siteTrades, ...TRADE_NAMES])] });
    const r = await store.ai.call('ai-ops', { kind: 'schedule_match', siteId: V.ctx.siteId, ...payload });
    V.acts = applyAiMatch(V.acts, r);
    const n = V.acts.filter((a) => a.suggest).length;
    toast(n ? `AI 제안 ${n}개를 붙였습니다. 확인하고 받으세요.` : 'AI가 제안할 짝을 찾지 못했습니다.');
    V.filter = 'unlinked';
    renderDetail();
  } catch (err) { el.disabled = false; toast(err.message, 'warn'); }
});
onAction('sc-accept-all', async () => {
  let n = 0;
  for (const a of V.acts.filter((x) => x.suggest)) {
    const s = acceptSuggest(a);
    Object.assign(a, await saveFix(a, { zone: s.zone, building: s.building, fromFloor: s.fromFloor, toFloor: s.toFloor, trade: s.trade }, 'ai'));
    delete a.suggest;
    n++;
  }
  V.sc = await store.schedules.get(V.sc.id);
  renderDetail();
  toast(`${n}개를 받았습니다.`);
});

// ---------------------------------------------------------------- 탭

registerOpsTab({
  id: 'forecast',
  label: '예보',
  order: 40,
  mount(el, ctx) {
    if (!store.schedules) { el.innerHTML = '<p class="muted ops-pad">이 저장 방식에서는 공정표를 쓸 수 없습니다.</p>'; return null; }
    V = { el, ctx, list: [], sc: null, acts: null, filter: 'all', text: '', more: false, mctx: null, pending: null };
    el.innerHTML = '<p class="muted small loading ops-pad">불러오는 중…</p>';
    el.addEventListener('change', (ev) => {
      if (ev.target.id !== 'sc-file' || !ev.target.files?.[0]) return;
      const file = ev.target.files[0];
      ev.target.value = '';
      startUpload(file);
    });
    const off = store.rows('schedules').subscribe(ctx.siteId, () => { if (V && !V.sc) loadList(); });
    loadList().catch((err) => { el.innerHTML = `<p class="t-warn ops-pad">${icon('alert')}${esc(err.message)}</p>`; });
    return () => { off(); V = null; };
  },
});

export const scheduleView = () => V; // 화면 확인 스크립트용
