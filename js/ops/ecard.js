// 전자카드 출역 가져오기(11 지시서 3절): 엑셀은 브라우저에서만 읽고, 날짜 × 협력사 × 직종 인원 수만 남긴다.
// 이름·카드번호 열은 같은 사람을 한 번만 세는 데만 쓰고 버린다. 서버로 보내지 않는다.
import { store } from '../ctx.js';
import { xlsx } from '../excel-ui.js';
import { $, esc, icon, onAction, openModal, closeModal, toast } from '../util.js';
import { pickFiles } from './attach.js';
import { findColumns, findHeaderRow, summarizeEcard, matchCompany, toManpower, mergeManpower } from './calc/manpower.js';

let cur = null; // { siteId, fileName, aoa, head, cols, result, onDone }

const COL_LABEL = { date: '날짜', company: '협력사', trade: '직종', person: '사람 구분(세는 데만 씀)' };

function colPicker() {
  const opts = (v) => `<option value="-1">(없음)</option>${cur.aoa[cur.head].map((h, i) => `<option value="${i}" ${i === v ? 'selected' : ''}>${esc(h ?? `${i + 1}번째 열`)}</option>`).join('')}`;
  return `<div class="grid2">${Object.entries(COL_LABEL).map(([k, l]) => `<label class="field"><span>${esc(l)}</span><select data-col="${k}">${opts(cur.cols[k])}</select></label>`).join('')}</div>`;
}

function preview() {
  const { days, rows, skipped } = cur.result;
  const dates = Object.keys(days).sort();
  const names = [...new Set(dates.flatMap((d) => days[d].map((l) => l.company)))];
  const unknown = names.filter((n) => !matchCompany(n, cur.companies));
  const total = (d) => days[d].reduce((a, l) => a + l.count, 0);
  return `<p class="small">${esc(cur.fileName)} · 읽은 줄 ${rows}${skipped ? ` · 날짜를 못 읽은 줄 ${skipped}` : ''} · ${dates.length}일</p>
    ${unknown.length ? `<div class="notice">${icon('alert')}<span>협력사 목록에 없는 이름: ${unknown.map((n) => `<button type="button" class="link" data-act="ec-add-co" data-name="${esc(n)}">${esc(n)} 추가</button>`).join(' ')}</span></div>` : ''}
    <div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>날짜</th><th>협력사·직종</th><th>인원</th></tr></thead><tbody>
    ${dates.map((d) => days[d].map((l, i) => `<tr>${i ? '' : `<td rowspan="${days[d].length}"><b>${esc(d.slice(5))}</b><br><small class="muted">${total(d)}명</small></td>`}<td>${esc(l.company)}${l.trade ? ` · ${esc(l.trade)}` : ''}</td><td class="num">${l.count}</td></tr>`).join('')).join('')}
    </tbody></table></div>
    <p class="muted small">${icon('lock')}이름·카드번호는 저장하지 않습니다. 인원 수만 일보에 들어갑니다.</p>`;
}

function dialog() {
  const missing = cur.cols.date < 0 || cur.cols.company < 0;
  cur.result = missing ? null : summarizeEcard(cur.aoa.slice(cur.head + 1), cur.cols);
  openModal({
    title: '전자카드 출역 가져오기',
    wide: true,
    body: `${missing ? '<p class="t-warn small">날짜·협력사 열을 찾지 못했습니다. 아래에서 골라주세요.</p>' : ''}
      <details ${missing ? 'open' : ''}><summary class="small">열 고르기</summary>${colPicker()}</details>
      <div id="ec-preview">${cur.result ? preview() : ''}</div>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="button" class="btn primary" data-act="ec-apply" ${cur.result ? '' : 'disabled'}>${icon('check')}일보에 넣기</button>`,
  });
}

document.addEventListener('change', (e) => {
  if (!cur || !e.target.dataset?.col) return;
  cur.cols[e.target.dataset.col] = Number(e.target.value);
  dialog();
});

export async function ecardDialog(siteId, onDone) {
  const [file] = await pickFiles({ accept: '.xlsx,.xls,.csv', multiple: false });
  if (!file) return;
  const X = await xlsx();
  const wb = X.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = X.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (!aoa.length) { toast('파일에 표가 없습니다.', 'warn'); return; }
  const head = findHeaderRow(aoa);
  cur = { siteId, fileName: file.name, aoa, head, cols: findColumns(aoa[head]), companies: await store.rows('companies').list({ siteId }), onDone };
  dialog();
}

onAction('ec-add-co', async (el) => {
  await store.rows('companies').save({ siteId: cur.siteId, name: el.dataset.name, sort: cur.companies.length + 1 });
  cur.companies = await store.rows('companies').list({ siteId: cur.siteId });
  $('#ec-preview').innerHTML = preview();
  toast(`${el.dataset.name}을(를) 협력사로 추가했습니다.`);
});

onAction('ec-apply', async () => {
  const { siteId, result } = cur;
  const dates = Object.keys(result.days).sort();
  const existing = await store.rows('dailyReports').list({ siteId, from: dates[0], to: dates.at(-1) });
  const has = existing.filter((r) => dates.includes(r.date));
  const n = has.filter((r) => r.manpower?.length).length;
  if (n) {
    openModal({
      title: '출역이 이미 있습니다',
      body: `<p class="confirm-msg">이미 출역이 들어 있는 일보가 ${n}건 있습니다. 어떻게 할까요?</p>`,
      footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button>
        <button type="button" class="btn" data-act="ec-mode" data-mode="replace">덮어쓰기</button>
        <button type="button" class="btn primary" data-act="ec-mode" data-mode="add">더하기</button>`,
    });
    cur.has = has;
    return;
  }
  await applyDays(has, 'replace');
});

onAction('ec-mode', (el) => applyDays(cur.has, el.dataset.mode));

async function applyDays(has, mode) {
  const { siteId, fileName, result, companies, onDone } = cur;
  const dates = Object.keys(result.days).sort();
  const source = { ecard: { fileName, rows: result.rows, at: new Date().toISOString() } };
  let done = 0;
  for (const date of dates) {
    const prev = has.find((r) => r.date === date);
    if (prev && !['draft', 'returned'].includes(prev.status)) continue; // 제출·승인된 일보는 건드리지 않는다
    const incoming = toManpower(result.days[date], companies);
    await store.rows('dailyReports').save(prev ? { ...prev, manpower: mergeManpower(prev.manpower, incoming, mode), source: { ...prev.source, ...source } } : { siteId, date, manpower: incoming, source });
    done++;
  }
  const skipped = dates.length - done;
  cur = null;
  closeModal(true);
  toast(`${done}일치 출역을 넣었습니다.${skipped ? ` 제출·승인된 ${skipped}일은 그대로 두었습니다.` : ''}`);
  onDone?.();
}
