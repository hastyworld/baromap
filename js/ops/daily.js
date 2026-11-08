// 작업일보(11 지시서 1절): 달력·목록·월 출역 집계, 일보 쓰기(칸을 나갈 때마다 자동 저장), 결재, 인쇄·엑셀.
// 날씨는 자동, 출역·장비는 어제 복사, 오늘 작업은 골구도에서 바뀐 칸을 제안한다. 근로자 개인은 저장하지 않는다(인원 수만).
import { store, q } from '../ctx.js';
import { todayStr } from '../model.js';
import { newId } from '../store.js';
import { $, esc, icon, onAction, openModal, closeModal, toast, confirmDialog, fmtDate, fmtDateTime } from '../util.js';
import { writeSheets } from '../excel-ui.js';
import { registerOpsTab } from './index.js';
import { addPhotos } from './attach.js';
import { ecardDialog } from './ecard.js';
import { printHtml, signBox, prTable } from './print.js';
import { dailySummary } from './calc/weather.js';
import { DAILY_LABEL, dailyActions } from './calc/flow.js';
import { progressChanges, progressSnapshot, suggestWork, copyLines, planFromWork, totalCount, mainWork, previousReport } from './calc/digest.js';
import { monthTable, monthSheet } from './calc/manpower.js';
import { aiDailyDraftButton } from './ai.js';

const STATUS_CLS = { draft: 'plain', submitted: 'info', reviewed: 'info', approved: 'ok', returned: 'crit', cancelled: 'plain' };
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const SAVE_DELAY = 700;
const dayOfWeek = (d) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()];
const blank = (siteId, date) => ({ id: newId('dailyReports'), siteId, date, status: 'draft', weather: {}, manpower: [], equipment: [], work: [], progress: [], plan: [], safety: { accidents: 0, text: '' }, issues: '', files: [], signs: {}, returnNote: '', source: {} });

let V = null; // 탭 상태 { el, ctx, ym, reports, companies, settings, edit, off }
const extraSafety = []; // M9가 안전 요약을 더한다: (row) => html
export const addDailySafety = (fn) => extraSafety.push(fn);
const beforeApprove = []; // 승인 직전에 스냅샷을 굳힌다: async (row) => patch
export const addBeforeApprove = (fn) => beforeApprove.push(fn);
const afterApprove = []; // 승인 뒤 할 일(예보 기록 등): async (row) => void
export const addAfterApprove = (fn) => afterApprove.push(fn);

const canEdit = () => store.can('edit', V.ctx.siteId);
const editing = () => V?.edit;
const steps = () => V.settings?.daily?.steps || 1;
const isAdmin = () => store.me?.role === 'admin';
// 작성 중·반려만 고친다(운영자는 언제나)
const writable = (r) => canEdit() && (isAdmin() || ['draft', 'returned'].includes(r.status || 'draft'));

async function load() {
  const { siteId } = V.ctx;
  const [y, m] = V.ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const [reports, companies, settings] = await Promise.all([
    store.rows('dailyReports').list({ siteId, from: `${V.ym}-01`, to: `${V.ym}-${String(last).padStart(2, '0')}` }),
    store.rows('companies').list({ siteId }),
    store.ops.settings(siteId),
  ]);
  if (!V) return;
  Object.assign(V, { reports, companies: companies.filter((c) => c.active), settings });
  if (!V.edit) renderList();
}

// ---------------------------------------------------------------- 목록·달력

function calendar() {
  const [y, m] = V.ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = todayStr();
  const by = new Map(V.reports.map((r) => [r.date, r]));
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<span></span>');
  for (let d = 1; d <= days; d++) {
    const date = `${V.ym}-${String(d).padStart(2, '0')}`;
    const r = by.get(date);
    const future = date > today;
    cells.push(`<button type="button" class="cal-day${date === today ? ' today' : ''}" data-act="dy-open" data-date="${date}" ${future || (!r && !canEdit()) ? 'disabled' : ''}
      aria-label="${d}일${r ? ` ${DAILY_LABEL[r.status]}` : ''}"><span>${d}</span>${r ? `<i class="dot ${r.status}"></i>` : '<i></i>'}</button>`);
  }
  return `<div class="cal">
    <div class="cal-head"><button type="button" class="icon-btn" data-act="dy-month" data-d="-1" aria-label="이전 달">${icon('back')}</button>
      <b>${y}년 ${m}월</b>
      <button type="button" class="icon-btn flip" data-act="dy-month" data-d="1" aria-label="다음 달" ${V.ym >= today.slice(0, 7) ? 'disabled' : ''}>${icon('back')}</button></div>
    <div class="cal-grid cal-dow">${DOW.map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>
    <p class="cal-legend small muted"><i class="dot draft"></i>작성 중 <i class="dot submitted"></i>제출 <i class="dot approved"></i>승인 <i class="dot returned"></i>반려</p>
  </div>`;
}

function monthBlock() {
  const t = monthTable(V.reports, V.ym);
  if (!t.total) return '';
  return `<details class="ops-sec"><summary>${icon('table')}월 출역 집계 <small class="muted">${t.total.toLocaleString()}인·일</small></summary>
    <div class="ops-table-wrap"><table class="ops-table sticky"><thead><tr><th>협력사</th><th>공종</th>${Array.from({ length: t.days }, (_, i) => `<th class="num">${i + 1}</th>`).join('')}<th class="num">합계</th></tr></thead>
    <tbody>${t.rows.map((r) => `<tr><td>${esc(r.company)}</td><td>${esc(r.trade)}</td>${r.days.map((v) => `<td class="num">${v || ''}</td>`).join('')}<td class="num"><b>${r.total}</b></td></tr>`).join('')}</tbody></table></div>
    <p class="small"><b>공종별 인·일</b> ${t.trades.map((x) => `${esc(x.trade)} ${x.personDays}`).join(' · ')}</p>
    <button type="button" class="btn" data-act="dy-month-xlsx">${icon('download')}엑셀로 받기</button></details>`;
}

function renderList() {
  const today = todayStr();
  const rows = V.reports.filter((r) => r.status !== 'cancelled');
  V.el.innerHTML = `<div class="ops-pad">
    ${canEdit() ? `<div class="ops-actions"><button type="button" class="btn primary big" data-act="dy-open" data-date="${today}">${icon('edit')}오늘 일보 쓰기</button>
      <button type="button" class="btn big" data-act="dy-ecard">${icon('upload')}전자카드 출역 가져오기</button></div>` : ''}
    ${calendar()}
    <ul class="dy-list">${rows.map((r) => `<li><button type="button" class="dy-row" data-act="dy-open" data-date="${r.date}">
        <span class="dy-date"><b>${esc(r.date.slice(8))}</b><small>${dayOfWeek(r.date)}</small></span>
        <span class="dy-main"><b>${totalCount(r)}명</b> <span class="muted">${esc(mainWork(r) || '작업 내용 없음')}</span></span>
        <span class="badge ${STATUS_CLS[r.status]}">${DAILY_LABEL[r.status]}${r._pending ? ' · 대기' : ''}</span></button></li>`).join('') || `<li class="empty">${V.ym}의 일보가 없습니다.</li>`}</ul>
    ${monthBlock()}
  </div>`;
}

onAction('dy-month', (el) => {
  const [y, m] = V.ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + Number(el.dataset.d), 1));
  V.ym = d.toISOString().slice(0, 7);
  load();
});
onAction('dy-ecard', () => ecardDialog(V.ctx.siteId, () => load()));
onAction('dy-month-xlsx', async () => {
  await writeSheets(`바로맵_출역_${V.ym}.xlsx`, [{ name: `${V.ym} 출역`, rows: monthSheet(monthTable(V.reports, V.ym)) }]);
});

// ---------------------------------------------------------------- 일보 쓰기

async function openEdit(date) {
  const { siteId } = V.ctx;
  let r = V.reports.find((x) => x.date === date);
  if (!r) {
    const [found] = await store.rows('dailyReports').list({ siteId, from: date, to: date });
    r = found || null;
  }
  if (!r && !canEdit()) return;
  const row = r ? { ...blank(siteId, date), ...r } : blank(siteId, date);
  V.edit = { row, dirty: false, saving: false, timer: 0, prev: null, suggest: [], offRow: null };
  renderEdit();
  await Promise.all([fillAuto(), loadPrev()]);
  if (V?.edit?.row.id === row.id) renderEdit();
}

async function loadPrev() {
  const e = V.edit;
  const from = new Date(Date.parse(`${e.row.date}T00:00:00Z`) - 14 * 864e5).toISOString().slice(0, 10);
  const list = await store.rows('dailyReports').list({ siteId: V.ctx.siteId, from, to: e.row.date });
  e.prev = previousReport(list, e.row.date);
}

// 날씨·공정 요약 자동 채움. 고친 값은 덮지 않는다
async function fillAuto() {
  const e = V.edit;
  const { siteId } = V.ctx;
  const { date } = e.row;
  const w = writable(e.row);
  if (w && e.row.weather?.max == null) {
    const s = dailySummary(await store.weather.get(siteId, { from: date, to: date }), date);
    if (s) e.row.weather = { ...e.row.weather, min: s.min, max: s.max, feelsMax: s.feelsMax, rainMm: s.rainMm, windMax: s.windMax, sky: s.sky };
  }
  let cache = store.progress.cached(siteId);
  if (cache === undefined) cache = await store.progress.load(siteId).catch(() => null);
  const ch = progressChanges(cache, date);
  e.suggest = suggestWork(ch);
  if (w) e.row.progress = progressSnapshot(ch);
}

const num = (v) => (v == null ? '' : esc(v));

function weatherSec(r, w) {
  const x = r.weather || {};
  const f = (k, label, unit = '') => `<label class="ops-f"><span>${label}</span><input data-bind="weather.${k}" type="number" inputmode="decimal" step="0.1" value="${num(x[k])}" ${w ? '' : 'disabled'}>${unit ? `<i>${unit}</i>` : ''}</label>`;
  return `<div class="ops-grid">${f('min', '최저', '℃')}${f('max', '최고', '℃')}${f('feelsMax', '최고 체감', '℃')}${f('rainMm', '강수량', 'mm')}${f('windMax', '바람', 'm/s')}
    <label class="ops-f"><span>하늘</span><input data-bind="weather.sky" value="${esc(x.sky || '')}" ${w ? '' : 'disabled'}></label></div>`;
}

function stepper(bind, value, w) {
  return `<span class="stepper"><button type="button" data-act="dy-step" data-bind="${bind}" data-d="-1" aria-label="하나 줄이기" ${w ? '' : 'disabled'}>−</button>
    <input data-bind="${bind}" type="number" inputmode="numeric" min="0" max="999" value="${num(value ?? 0)}" aria-label="수" ${w ? '' : 'disabled'}>
    <button type="button" data-act="dy-step" data-bind="${bind}" data-d="1" aria-label="하나 늘리기" ${w ? '' : 'disabled'}>+</button></span>`;
}

function companySelect(m, i, w) {
  const known = V.companies.some((c) => c.name === m.company);
  const opts = [['직영', '직영'], ...V.companies.map((c) => [c.name, c.name]), ...(m.company && !known && m.company !== '직영' ? [[m.company, m.company]] : [])];
  return `<select data-co="${i}" aria-label="협력사" ${w ? '' : 'disabled'}><option value="">협력사 고르기</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === m.company ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}

const tradesOf = (name) => V.companies.find((c) => c.name === name)?.trades || [];

function manpowerSec(r, w) {
  return `${w ? `<div class="ops-chips"><button type="button" class="btn" data-act="dy-copy" data-f="manpower" ${V.edit.prev?.manpower?.length ? '' : 'disabled'}>${icon('copy')}어제 복사</button>
      <button type="button" class="btn" data-act="dy-add" data-f="manpower">${icon('plus')}줄 추가</button></div>` : ''}
    ${r.manpower.map((m, i) => `<div class="mp-row">
      ${companySelect(m, i, w)}
      <input data-bind="manpower.${i}.trade" list="dl-tr-${i}" value="${esc(m.trade)}" placeholder="공종" aria-label="공종" ${w ? '' : 'disabled'}>
      <datalist id="dl-tr-${i}">${tradesOf(m.company).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      ${stepper(`manpower.${i}.count`, m.count, w)}
      ${w ? `<button type="button" class="icon-btn sm" data-act="dy-del" data-f="manpower" data-i="${i}" aria-label="이 줄 빼기">${icon('close')}</button>` : ''}
    </div>`).join('') || '<p class="muted small">출역을 넣어주세요.</p>'}`;
}

function equipmentSec(r, w) {
  return `${w ? `<div class="ops-chips"><button type="button" class="btn" data-act="dy-copy" data-f="equipment" ${V.edit.prev?.equipment?.length ? '' : 'disabled'}>${icon('copy')}어제 복사</button>
      <button type="button" class="btn" data-act="dy-add" data-f="equipment">${icon('plus')}줄 추가</button></div>` : ''}
    ${r.equipment.map((m, i) => `<div class="mp-row">
      <input data-bind="equipment.${i}.name" value="${esc(m.name)}" placeholder="장비명" aria-label="장비명" ${w ? '' : 'disabled'}>
      <input data-bind="equipment.${i}.spec" value="${esc(m.spec)}" placeholder="규격" aria-label="규격" ${w ? '' : 'disabled'}>
      ${stepper(`equipment.${i}.count`, m.count, w)}
      ${w ? `<button type="button" class="icon-btn sm" data-act="dy-del" data-f="equipment" data-i="${i}" aria-label="이 줄 빼기">${icon('close')}</button>` : ''}
    </div>`).join('') || '<p class="muted small">장비가 없으면 비워 두세요.</p>'}`;
}

const lineRow = (f, l, i, w) => `<div class="wk-row">
    <input data-bind="${f}.${i}.text" value="${esc(l.text)}" placeholder="내용" aria-label="내용" ${w ? '' : 'disabled'}>
    ${w ? `<button type="button" class="icon-btn sm" data-act="dy-del" data-f="${f}" data-i="${i}" aria-label="이 줄 빼기">${icon('close')}</button>` : ''}</div>`;

function workSec(r, w) {
  const e = V.edit;
  const chk = e.suggest.map((s, i) => {
    const on = r.work.some((x) => x.text === s.text);
    return `<label class="check sug"><input type="checkbox" data-sug="${i}" ${on ? 'checked' : ''} ${w ? '' : 'disabled'}><span>${esc(s.text)}</span></label>`;
  }).join('');
  return `${chk ? `<div class="sug-box"><p class="small muted">${icon('building')}골구도에서 오늘 바뀐 칸 — 체크하면 들어갑니다</p>${chk}</div>` : ''}
    ${r.work.map((l, i) => lineRow('work', l, i, w)).join('')}
    ${w ? `<div class="ops-chips"><button type="button" class="btn" data-act="dy-add" data-f="work">${icon('plus')}작업 줄 추가</button>${aiDailyDraftButton(V.ctx.siteId)}</div>` : ''}`;
}

function progressSec(r) {
  if (!r.progress?.length) return '<p class="muted small">이 날짜에 바뀐 골구도 칸이 없습니다.</p>';
  return `<ul class="plain small">${r.progress.map((p) => `<li>${esc(p.sheet)} · ${esc(p.building)} ${esc(p.range)} <b>${esc(p.trade)}</b> ${p.units}세대</li>`).join('')}</ul>`;
}

function safetySec(r, w) {
  const s = r.safety || {};
  return `${extraSafety.map((fn) => fn(r)).join('')}
    <label class="check"><input type="checkbox" data-bind="safety.none" ${s.accidents ? '' : 'checked'} ${w ? '' : 'disabled'}><span>사고 없음</span></label>
    <label class="ops-f wide"><span>안전 메모</span><input data-bind="safety.text" value="${esc(s.text || '')}" maxlength="500" ${w ? '' : 'disabled'}></label>`;
}

function photosSec(r, w) {
  return `<div class="ph-grid">${(r.files || []).map((f, i) => `<figure>
      <button type="button" class="ph" data-act="dy-photo" data-i="${i}" aria-label="사진 크게 보기">${f.thumb ? `<img src="${esc(f.thumb)}" alt="">` : icon('file')}</button>
      ${w ? `<button type="button" class="ph-x" data-act="dy-photo-del" data-i="${i}" aria-label="사진 빼기">${icon('close')}</button>` : ''}</figure>`).join('')}
    ${w ? `<button type="button" class="ph add" data-act="dy-photo-add" aria-label="사진 추가">${icon('camera')}<span>사진</span></button>` : ''}</div>
    ${r.files?.length ? '' : w ? '' : '<p class="muted small">사진이 없습니다.</p>'}`;
}

function planSec(r, w) {
  return `${w ? `<div class="ops-chips"><button type="button" class="btn" data-act="dy-plan-copy" ${r.work.length ? '' : 'disabled'}>${icon('copy')}오늘 작업 복사</button>
      <button type="button" class="btn" data-act="dy-add" data-f="plan">${icon('plus')}줄 추가</button></div>` : ''}
    ${r.plan.map((l, i) => lineRow('plan', l, i, w)).join('')}`;
}

const sec = (id, ic, title, sub, body, open = true) => `<details class="ops-sec" id="dy-${id}" ${open ? 'open' : ''}><summary>${icon(ic)}${title}${sub ? ` <small class="muted">${sub}</small>` : ''}</summary>${body}</details>`;

const ACT_BTN = {
  submit: `<button type="button" class="btn primary big" data-act="dy-go" data-to="submit">${icon('check')}제출</button>`,
  recall: '<button type="button" class="btn big" data-act="dy-go" data-to="recall">회수</button>',
  review: `<button type="button" class="btn primary big" data-act="dy-go" data-to="review">${icon('check')}검토</button>`,
  approve: `<button type="button" class="btn primary big" data-act="dy-go" data-to="approve">${icon('check')}승인</button>`,
  return: '<button type="button" class="btn big" data-act="dy-return">반려</button>',
  reopen: '<button type="button" class="btn big" data-act="dy-go" data-to="recall">다시 열기</button>',
};

function renderEdit() {
  const e = V.edit;
  const r = e.row;
  const w = writable(r);
  const openState = new Map([...V.el.querySelectorAll('details.ops-sec[id]')].map((d) => [d.id, d.open]));
  const y = V.el.querySelector('.ops-pad')?.scrollTop;
  const acts = dailyActions(r, { me: store.me, steps: steps(), canEdit: canEdit() });
  const sign = r.signs || {};
  V.el.innerHTML = `<div class="ops-pad dy-edit">
    <div class="dy-top">
      <button type="button" class="btn" data-act="dy-back">${icon('back')}목록</button>
      <div class="dy-title"><b>${fmtDate(r.date)} (${dayOfWeek(r.date)})</b>
        <span class="badge ${STATUS_CLS[r.status || 'draft']}">${DAILY_LABEL[r.status || 'draft']}</span></div>
      <span class="small muted" id="dy-saved" role="status"></span>
    </div>
    ${r.status === 'returned' && r.returnNote ? `<div class="notice crit">${icon('alert')}<span>반려 사유: ${esc(r.returnNote)}</span></div>` : ''}
    ${sec('weather', 'clock', '날씨', r.weather?.sky || '', weatherSec(r, w))}
    ${sec('manpower', 'users', '출역', `${totalCount(r)}명`, manpowerSec(r, w))}
    ${sec('equipment', 'car', '장비', r.equipment.length ? `${r.equipment.length}종` : '', equipmentSec(r, w))}
    ${sec('work', 'hardhat', '오늘 작업', '', workSec(r, w))}
    ${sec('progress', 'table', '공정 요약', '', progressSec(r), Boolean(r.progress?.length))}
    ${sec('safety', 'alert', '안전', '', safetySec(r, w))}
    ${sec('files', 'camera', '사진', r.files?.length ? `${r.files.length}장` : '', photosSec(r, w))}
    ${sec('plan', 'calendar', '내일 계획', '', planSec(r, w))}
    ${sec('issues', 'file', '특이사항', '', `<textarea class="ops-ta" data-bind="issues" rows="3" maxlength="2000" ${w ? '' : 'disabled'}>${esc(r.issues || '')}</textarea>`)}
    ${Object.keys(sign).length ? `<p class="small muted dy-signs">${['submitted', 'reviewed', 'approved'].filter((k) => sign[k]).map((k) => `${{ submitted: '제출', reviewed: '검토', approved: '승인' }[k]} ${esc(sign[k].name)} ${esc(fmtDateTime(sign[k].at).slice(5))}`).join(' · ')}</p>` : ''}
    <div class="dy-foot"><button type="button" class="btn" data-act="dy-print">${icon('file')}인쇄</button>
      <button type="button" class="btn" data-act="dy-xlsx">${icon('download')}엑셀</button><span class="spacer"></span>
      ${acts.map((a) => ACT_BTN[a]).join('')}</div>
  </div>`;
  for (const [id, open] of openState) { const d = V.el.querySelector(`#${id}`); if (d) d.open = open; }
  const pad = V.el.querySelector('.ops-pad');
  if (y) pad.scrollTop = y;
}

function paintSaved(text, bad = false) {
  const el = $('#dy-saved', V?.el);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('t-warn', bad);
}

function touch() {
  const e = V.edit;
  e.dirty = true;
  paintSaved('저장 중…');
  clearTimeout(e.timer);
  e.timer = setTimeout(() => saveNow(), SAVE_DELAY);
}

async function saveNow() {
  const e = V?.edit;
  if (!e) return;
  clearTimeout(e.timer);
  if (!e.dirty) return;
  if (e.saving) { await e.saving; return saveNow(); }
  e.dirty = false;
  e.saving = store.rows('dailyReports').save(e.row).then((saved) => {
    Object.assign(e.row, { updatedAt: saved.updatedAt, createdAt: saved.createdAt, status: saved.status || e.row.status, _pending: saved._pending });
    const i = V?.reports.findIndex((x) => x.id === saved.id);
    if (i >= 0) V.reports[i] = { ...e.row };
    else if (V && e.row.date.startsWith(V.ym)) V.reports.unshift({ ...e.row });
    paintSaved(saved._pending ? '이 기기에 저장(연결되면 올라감)' : '저장됨');
  }).catch((err) => {
    e.dirty = true;
    paintSaved(err.message, true);
  }).finally(() => { e.saving = false; });
  await e.saving;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)] = value;
}
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

document.addEventListener('change', (e) => {
  const ed = editing();
  const t = e.target;
  if (!ed || !V.el.contains(t)) return;
  if (t.dataset.bind) {
    if (t.dataset.bind === 'safety.none') ed.row.safety = { ...ed.row.safety, accidents: t.checked ? 0 : 1 };
    else setPath(ed.row, t.dataset.bind, t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value);
    touch();
    if (/\.count$/.test(t.dataset.bind)) paintTotal();
  } else if (t.dataset.co != null) {
    const m = ed.row.manpower[Number(t.dataset.co)];
    m.company = t.value;
    m.kind = t.value === '직영' ? 'staff' : 'partner';
    m.companyId = V.companies.find((c) => c.name === t.value)?.id || '';
    if (!m.trade) m.trade = tradesOf(t.value)[0] || '';
    touch();
    renderEdit();
  } else if (t.dataset.sug != null) {
    const s = ed.suggest[Number(t.dataset.sug)];
    if (t.checked) ed.row.work.push({ ...s });
    else ed.row.work = ed.row.work.filter((x) => x.text !== s.text);
    touch();
    renderEdit();
  }
});

function paintTotal() {
  const s = V.el.querySelector('#dy-manpower summary small');
  if (s) s.textContent = `${totalCount(V.edit.row)}명`;
}

async function leaveEdit() {
  await saveNow();
  if (!V) return;
  V.edit = null;
  load();
}

function openBlank(f) {
  if (f === 'manpower') return { companyId: '', company: '', trade: '', kind: 'partner', count: 0, note: '' };
  if (f === 'equipment') return { equipmentId: '', name: '', spec: '', count: 1, company: '' };
  return { trade: '', area: '', text: '', buildingId: '', floors: '' };
}

onAction('dy-open', (el) => openEdit(el.dataset.date));
onAction('dy-back', () => leaveEdit());
onAction('dy-add', (el) => {
  const { row } = V.edit;
  row[el.dataset.f].push(openBlank(el.dataset.f));
  renderEdit();
  V.el.querySelector(`#dy-${el.dataset.f === 'plan' ? 'plan' : el.dataset.f} .mp-row:last-of-type select, #dy-${el.dataset.f} .wk-row:last-of-type input`)?.focus();
});
onAction('dy-del', (el) => {
  V.edit.row[el.dataset.f].splice(Number(el.dataset.i), 1);
  touch();
  renderEdit();
});
onAction('dy-copy', (el) => {
  const { row, prev } = V.edit;
  row[el.dataset.f] = copyLines(prev?.[el.dataset.f]);
  touch();
  renderEdit();
  toast(`${fmtDate(prev.date)} 일보에서 복사했습니다.`);
});
onAction('dy-plan-copy', () => {
  const { row } = V.edit;
  row.plan = planFromWork(row.work);
  touch();
  renderEdit();
});
onAction('dy-step', (el) => {
  const { row } = V.edit;
  const v = Math.max(0, Math.min(999, (Number(getPath(row, el.dataset.bind)) || 0) + Number(el.dataset.d)));
  setPath(row, el.dataset.bind, v);
  const input = el.parentElement.querySelector('input');
  input.value = v;
  paintTotal();
  touch();
});

onAction('dy-photo-add', async () => {
  const e = V.edit;
  const room = 20 - e.row.files.length;
  if (room <= 0) { toast('사진은 20장까지 넣을 수 있습니다.', 'warn'); return; }
  const items = await addPhotos({ siteId: V.ctx.siteId, kind: 'dailyReports', recordId: e.row.id, max: room });
  if (!items.length || !V?.edit) return;
  e.row.files.push(...items);
  touch();
  renderEdit();
});
onAction('dy-photo-del', async (el) => {
  const { row } = V.edit;
  const [f] = row.files.splice(Number(el.dataset.i), 1);
  touch();
  renderEdit();
  await store.files.remove(f).catch(() => {});
});
onAction('dy-photo', async (el) => {
  const f = V.edit.row.files[Number(el.dataset.i)];
  let url = f.thumb;
  try { url = await store.files.url(f); } catch { /* 오프라인이면 미리보기로 */ }
  openModal({ title: f.name || '사진', wide: true, body: `<img class="ph-big" src="${esc(url)}" alt="">`, footer: '<button type="button" class="btn" data-act="modal-close">닫기</button>' });
});

// AI 초안(켜져 있을 때만 단추가 보인다). 사진은 얼굴을 가린 작은 미리보기만 보낸다
onAction('dy-ai-draft', () => {
  openModal({
    title: 'AI 일보 초안',
    body: `<p class="muted small">오늘 한 일을 말하듯 적으세요. 휴대폰 키보드의 음성 입력을 써도 됩니다. 사진 미리보기와 공정 요약을 함께 보내 초안을 만듭니다.</p>
      <label class="field"><span>메모</span><textarea id="dy-ai-memo" rows="5" maxlength="4000" autofocus></textarea></label>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="button" class="btn primary" data-act="dy-ai-go">${icon('check')}초안 만들기</button>`,
  });
});
onAction('dy-ai-go', async (el) => {
  const { row } = V.edit;
  el.disabled = true;
  el.textContent = '만드는 중…';
  try {
    const r = await store.ai.call('ai-ops', {
      kind: 'daily_draft', siteId: V.ctx.siteId, date: row.date, memo: $('#dy-ai-memo').value,
      images: row.files.map((f) => f.thumb).filter(Boolean).slice(0, 10), changes: row.progress, manpower: row.manpower,
    });
    closeModal(true);
    const empty = { buildingId: '', floors: '' };
    row.work.push(...r.work.filter((w) => !row.work.some((x) => x.text === w.text)).map((w) => ({ ...empty, ...w })));
    row.plan.push(...r.plan.map((w) => ({ ...empty, ...w })));
    if (r.issues && !row.issues) row.issues = r.issues;
    touch();
    renderEdit();
    if (r.notes?.length) toast(`확인할 것: ${r.notes.join(' / ')}`, 'warn');
  } catch (err) {
    el.disabled = false;
    el.textContent = '초안 만들기';
    toast(err.message, 'crit');
  }
});

// 결재. 승인·제출 전에 고친 내용을 먼저 저장한다
async function go(action, note) {
  const e = V.edit;
  await saveNow();
  if (e.row._pending) await store.outbox.flush();
  let rec;
  if (action === 'submit') {
    if (!e.row.createdAt) { e.dirty = true; await saveNow(); }
    rec = await store.daily.submit(e.row.id);
  } else if (action === 'review') rec = await store.daily.review(e.row.id);
  else if (action === 'approve') {
    for (const fn of beforeApprove) {
      const patch = await fn(e.row);
      if (patch) { Object.assign(e.row, patch); e.dirty = true; }
    }
    await saveNow();
    rec = await store.daily.approve(e.row.id);
    for (const fn of afterApprove) await fn(rec).catch((err) => console.warn('[daily] 승인 뒤 작업 실패', err));
  } else if (action === 'return') rec = await store.daily.returnTo(e.row.id, note);
  else rec = await store.daily.recall(e.row.id);
  Object.assign(e.row, rec);
  renderEdit();
  toast({ submit: '제출했습니다.', review: '검토했습니다.', approve: '승인했습니다.', return: '반려했습니다.', recall: '작성 중으로 되돌렸습니다.' }[action]);
}
onAction('dy-go', async (el) => {
  const to = el.dataset.to;
  if (to === 'submit' && !totalCount(V.edit.row) && !(await confirmDialog('출역이 비어 있습니다. 그래도 제출할까요?', { title: '일보 제출', ok: '제출' }))) return;
  await go(to);
});
onAction('dy-return', () => {
  openModal({
    title: '일보 반려',
    body: '<label class="field"><span>반려 사유 <em>*</em></span><textarea id="dy-note" rows="3" maxlength="500" autofocus></textarea></label>',
    footer: '<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="button" class="btn danger" data-act="dy-return-ok">반려</button>',
  });
});
onAction('dy-return-ok', async () => {
  const note = $('#dy-note').value;
  if (!note.trim()) { toast('반려 사유를 입력해주세요.', 'warn'); return; }
  closeModal(true);
  await go('return', note);
});

// ---------------------------------------------------------------- 인쇄·엑셀

const weatherText = (w = {}) => [w.sky, w.min != null || w.max != null ? `${w.min ?? '-'} ~ ${w.max ?? '-'}℃` : '', w.feelsMax != null ? `최고 체감 ${w.feelsMax}℃` : '', w.rainMm ? `강수 ${w.rainMm}mm` : '', w.windMax != null ? `바람 ${w.windMax}m/s` : ''].filter(Boolean).join(' · ');
const signTime = (s) => (s?.at ? fmtDateTime(s.at).slice(5) : '');

async function dailyHtml(r) {
  const s = q.site(r.siteId);
  const sign = r.signs || {};
  const list = [{ label: '작성', name: sign.submitted?.name, at: signTime(sign.submitted) }];
  if (steps() >= 2 || sign.reviewed) list.push({ label: '검토', name: sign.reviewed?.name, at: signTime(sign.reviewed) });
  list.push({ label: '승인', name: sign.approved?.name, at: signTime(sign.approved) });
  const pics = (r.files || []).filter((f) => f.mime?.startsWith('image/'));
  const urls = await Promise.all(pics.map((f) => store.files.url(f).catch(() => f.thumb)));
  return `<article class="pr-doc">
    <header class="pr-head"><div><h1>작업일보</h1><p>${esc(s?.name || '')}</p><p><b>${fmtDate(r.date)} (${dayOfWeek(r.date)})</b></p><p>${esc(weatherText(r.weather))}</p></div>${signBox(list)}</header>
    <h2>출역 <small>합계 ${totalCount(r)}명</small></h2>${prTable(['협력사', '공종', '구분', '인원'], r.manpower.map((m) => [m.company, m.trade, m.kind === 'staff' ? '직영' : '협력', m.count]))}
    <h2>장비</h2>${prTable(['장비', '규격', '대수'], r.equipment.map((m) => [m.name, m.spec, m.count]))}
    <h2>오늘 작업</h2>${prTable(['내용'], r.work.map((w) => [w.text || `${w.trade} ${w.area}`]))}
    ${r.progress?.length ? `<h2>공정 요약</h2>${prTable(['시트', '동·층', '공종', '세대'], r.progress.map((p) => [p.sheet, `${p.building} ${p.range}`, p.trade, p.units]))}` : ''}
    <h2>안전</h2><p>${r.safety?.accidents ? '사고 있음' : '사고 없음'}${r.safety?.text ? ` — ${esc(r.safety.text)}` : ''}</p>
    <h2>내일 계획</h2>${prTable(['내용'], r.plan.map((w) => [w.text || `${w.trade} ${w.area}`]))}
    ${r.issues ? `<h2>특이사항</h2><p class="pr-text">${esc(r.issues)}</p>` : ''}
    ${urls.length ? `<h2>사진</h2><div class="pr-photos">${urls.map((u) => `<img src="${esc(u)}" alt="">`).join('')}</div>` : ''}
  </article>`;
}

function dailySheet(r) {
  return [
    ['작업일보', q.site(r.siteId)?.name || '', r.date, DAILY_LABEL[r.status || 'draft']],
    ['날씨', weatherText(r.weather)], [],
    ['협력사', '공종', '구분', '인원'], ...r.manpower.map((m) => [m.company, m.trade, m.kind === 'staff' ? '직영' : '협력', m.count]), ['합계', '', '', totalCount(r)], [],
    ['장비', '규격', '대수'], ...r.equipment.map((m) => [m.name, m.spec, m.count]), [],
    ['오늘 작업'], ...r.work.map((w) => [w.text]), [],
    ['내일 계획'], ...r.plan.map((w) => [w.text]), [],
    ['안전', r.safety?.accidents ? '사고 있음' : '사고 없음', r.safety?.text || ''],
    ['특이사항', r.issues || ''],
  ];
}

onAction('dy-print', async () => { await saveNow(); printHtml(await dailyHtml(V.edit.row)); });
onAction('dy-xlsx', async () => {
  const r = V.edit.row;
  await writeSheets(`바로맵_일보_${r.date}.xlsx`, [{ name: r.date, rows: dailySheet(r) }]);
});

// ---------------------------------------------------------------- 탭

registerOpsTab({
  id: 'daily',
  label: '일보',
  order: 10,
  mount(el, ctx) {
    V = { el, ctx, ym: todayStr().slice(0, 7), reports: [], companies: [], settings: null, edit: null };
    el.innerHTML = '<p class="muted small loading ops-pad">불러오는 중…</p>';
    const off = store.rows('dailyReports').subscribe(ctx.siteId, async () => {
      if (!V) return;
      const e = V.edit;
      // 다른 사람이 결재하면 바로 바뀐다. 내가 고치는 중이면 덮지 않는다
      if (e && !e.dirty && !e.saving) {
        const fresh = await store.rows('dailyReports').get(e.row.id);
        if (V?.edit === e && fresh && (fresh.status !== e.row.status || fresh.updatedAt !== e.row.updatedAt)) { Object.assign(e.row, fresh); renderEdit(); }
      } else if (!e) load();
    });
    load().catch((err) => { el.innerHTML = `<p class="t-warn ops-pad">${icon('alert')}${esc(err.message)}</p>`; });
    return () => {
      saveNow();
      off();
      V = null;
    };
  },
});

export { dailyHtml };
