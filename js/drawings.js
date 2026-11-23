// 도서 관리(전체 화면): 건축도서 묶음을 만들고 DXF를 여러 개(폴더째) 올리면, 워커가 시트(도면 한 장)마다
// 그림·요약·모양을 만들어 저장한다. 시트 격자(썸네일·도면번호·도면명·종류·신뢰도)에서 거르고, 누르면 시트 보기.
// 올리기는 현장 담당·운영자(노트북 권장), 보기는 그 현장을 볼 수 있는 모든 사람.
import { store, q } from './ctx.js';
import { newId } from './store.js';
import { CATEGORY_LABEL, CATEGORIES, structureBundleFlips } from './cad/classify.js';
import { openSheetViewer } from './bim/sheet-viewer.js';
import { dwgAllowed } from './cad/dwg.js';
import { xrefKey } from './cad/xref.js';
import { listLimit, nextLimit, confKnown } from './sheet-list.js';
import { READ_LIMIT_MS, TOO_SLOW } from './cad/book.js';
import { $, esc, icon, onAction, onForm, openModal, closeModal, toast, confirmDialog, fmtDate } from './util.js';

export const SET_STATUS_LABEL = { uploading: '올리는 중', reading: '읽는 중', analyzing: 'AI 판독 중', building: '모델 만드는 중', review: '검토 중', ready: '확정됨', error: '오류' };
const FILE_STATUS_LABEL = { queued: '대기', reading: '읽는 중', done: '읽음', error: '실패' };
const narrow = () => matchMedia('(max-width: 760px)').matches;
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

let dv = null; // { el, siteId, setId, filter, uploads, thumbs, busy }
let pushed = false;
const hooks = []; // 다른 단계(AI 판독·모델)가 도구 막대에 붙이는 단추: (dv) => html
const panels = []; // 시트 말고 다른 내용 탭(문서 등): { key, title, html(dv, { set, editable }) }
export const addDrawingsPanel = (p) => panels.push(p);

// fold: "다른 방법" 아래에 접어 둘 단추(모델 만들기 등, 44 지시서 원칙 7)
export function addDrawingsTool(fn, { fold = false } = {}) { hooks.push({ fn, fold }); }
export const drawingsState = () => dv;
export const rerenderDrawings = () => dv && render();

export async function openDrawings(siteId, setId = null) {
  const s = q.site(siteId);
  if (!s || !store.drawings) return;
  closeDrawings({ keepHistory: true });
  const el = document.createElement('div');
  el.className = 'board dview';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `${s.name} 건축도서`);
  document.body.append(el);
  document.body.classList.add('board-open');
  dv = { el, siteId, setId, filter: { category: '', building: '', unitType: '', q: '' }, limit: 0, uploads: [], thumbs: new Map(), thumbQ: [], thumbWant: new Set(), busy: false, returnFocus: document.activeElement };
  dv.unsub = store.subscribe(() => { if (dv && !dv.painting) schedule(); });
  if (!pushed) { history.pushState({ baromapDrawings: true }, ''); pushed = true; }
  render();
  el.querySelector('[data-act="dv-close"]')?.focus();
  try {
    const sets = await store.drawings.sets(siteId);
    if (!dv) return;
    if (!dv.setId && sets.length) dv.setId = sets[0].id;
    await loadSet();
  } catch (err) {
    if (dv) { dv.error = err.message; render(); }
  }
}

async function loadSet() {
  if (!dv?.setId) { render(); return; }
  const setId = dv.setId;
  await Promise.all([store.drawings.files(setId), store.drawings.sheets(setId)]);
  if (dv?.setId === setId) render();
}

export function closeDrawings({ fromHistory = false, keepHistory = false } = {}) {
  if (!dv) return;
  const v = dv;
  dv = null;
  v.unsub?.();
  v.io?.disconnect();
  v.worker?.terminate();
  v.el.remove();
  if (!document.querySelector('.board, .mview, .sview, .bview')) document.body.classList.remove('board-open');
  if (keepHistory) return;
  v.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.back();
  pushed = false;
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; if (dv) render(); });
}

// ---------------------------------------------------------------- 그리기

function filtered(sheets) {
  const f = dv.filter;
  const needle = f.q.trim().toLowerCase();
  const list = sheets.filter((s) => (!f.category || s.category === f.category)
    && (!f.building || (s.refs?.buildings || []).includes(f.building))
    && (!f.unitType || (s.refs?.unitTypes || []).includes(f.unitType))
    && (!needle || `${s.sheetNo} ${s.title}`.toLowerCase().includes(needle)));
  // 모름이 많은 시트부터 사람이 보게
  return f.sort === 'unknown' ? [...list].sort((a, b) => (b.stats?.triage?.unknown || 0) - (a.stats?.triage?.unknown || 0)) : list;
}

function confBadge(s) {
  if (!confKnown(s)) return ''; // 신뢰도를 모르면('규칙 0%') 경고처럼 보이지 않게 숨긴다
  const src = s.meta?.manual ? '사람' : s.meta?.source === 'ai' ? 'AI' : '규칙';
  const pct = Math.round((s.confidence || 0) * 100);
  const cls = s.meta?.manual ? 'ok' : pct >= 80 ? 'ok' : pct >= 50 ? 'info' : 'warn';
  return `<span class="badge ${cls}" title="분류 근거·신뢰도">${src}${s.meta?.manual ? '' : ` ${pct}%`}</span>`;
}

function render() {
  if (!dv) return;
  dv.painting = true;
  const s = q.site(dv.siteId);
  const editable = store.can('edit', dv.siteId);
  const sets = store.drawings.cached(dv.siteId) || [];
  const set = sets.find((x) => x.id === dv.setId);
  const sheets = (dv.setId && store.drawings.cachedSheets(dv.setId)) || [];
  const files = (dv.setId && store.drawings.cachedFiles(dv.setId)) || [];
  // 많으면 나눠 그리기(46 지시서 3절): 거르기·찾기는 전체, 그리는 것만 처음 60장
  const all = filtered(sheets);
  dv.limit = listLimit(all.length, dv.limit);
  const shown = all.slice(0, dv.limit);
  const keep = dv.top ? 0 : dv.el.querySelector('.dview-scroll')?.scrollTop || 0;
  dv.top = false;
  const opts = (list) => [...new Set(list)].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const blds = opts(sheets.flatMap((x) => x.refs?.buildings || []));
  const types = opts(sheets.flatMap((x) => x.refs?.unitTypes || []));
  const cats = CATEGORIES.filter((c) => sheets.some((x) => x.category === c));
  const reading = dv.uploads.some((u) => ['queued', 'scan', 'hash', 'reading', 'sheets'].includes(u.status));
  const hookArgs = { set, sheets, files, editable };
  const extra = set ? hooks.filter((h) => !h.fold).map((h) => h.fn(dv, hookArgs)).join('') : '';
  const folded = set ? hooks.filter((h) => h.fold).map((h) => h.fn(dv, hookArgs)).join('') : '';
  const panel = set && panels.find((p) => p.key === dv.panel);
  dv.el.innerHTML = `<header class="board-head">
      <button type="button" class="icon-btn" data-act="dv-close" aria-label="닫기" title="닫기">${icon('close')}</button>
      <div class="board-title"><b>건축도서</b><span>${esc(s?.name || '')}${set ? ` · ${esc(set.name)}${set.revision ? ` (${esc(set.revision)})` : ''} · ${SET_STATUS_LABEL[set.status] || ''}` : ''}</span></div>
      <div class="board-tools">
        ${set && editable ? `<button type="button" class="icon-btn" data-act="dv-set-edit" aria-label="묶음 정보 고치기" title="묶음 정보 고치기">${icon('edit')}</button>` : ''}
      </div>
    </header>
    ${sets.length || editable ? `<nav class="board-tabs" role="tablist" aria-label="도서 묶음">
      ${sets.map((x) => `<button type="button" role="tab" class="${x.id === dv.setId ? 'on' : ''}" aria-selected="${x.id === dv.setId}" data-act="dv-set" data-id="${esc(x.id)}">${esc(x.name)}${x.revision ? ` <small>${esc(x.revision)}</small>` : ''}</button>`).join('')}
      ${editable ? `<button type="button" class="tab-add" data-act="dv-set-new">${icon('plus')}새 묶음</button>` : ''}
    </nav>` : ''}
    ${set && panels.length ? `<div class="seg dview-seg" role="tablist" aria-label="도면·문서">
      <button type="button" role="tab" class="${panel ? '' : 'on'}" aria-selected="${!panel}" data-act="dv-panel" data-key="">도면</button>
      ${panels.map((p) => `<button type="button" role="tab" class="${panel === p ? 'on' : ''}" aria-selected="${panel === p}" data-act="dv-panel" data-key="${esc(p.key)}">${esc(p.title)}</button>`).join('')}
    </div>` : ''}
    ${panel ? panel.html(dv, { set, editable }) : `${set ? `<div class="board-bar dview-bar">
      ${editable && !narrow() ? `<details class="more-ways" ${reading ? 'open' : ''}><summary>다른 방법</summary><div class="more-ways-body">
        <label class="btn sm file-btn ${reading ? 'disabled' : ''}">${icon('upload')}DXF 파일 올리기<input type="file" id="dv-files" accept=".dxf,.dwg" multiple ${reading ? 'disabled' : ''}></label>
        <label class="btn sm file-btn ${reading ? 'disabled' : ''}">${icon('file')}폴더째 올리기<input type="file" id="dv-folder" webkitdirectory multiple ${reading ? 'disabled' : ''}></label>
        ${folded}</div></details>` : editable ? folded : ''}
      ${extra}
      <span class="spacer"></span>
      <div class="dview-filters">
        <input type="search" id="dv-q" placeholder="도면번호·도면명" value="${esc(dv.filter.q)}" aria-label="도면번호·도면명으로 찾기">
        <select id="dv-cat" aria-label="종류로 거르기"><option value="">종류 전체</option>${cats.map((c) => `<option value="${c}" ${c === dv.filter.category ? 'selected' : ''}>${esc(CATEGORY_LABEL[c])} (${sheets.filter((x) => x.category === c).length})</option>`).join('')}</select>
        ${blds.length ? `<select id="dv-bld" aria-label="동으로 거르기"><option value="">동 전체</option>${blds.map((b) => `<option ${b === dv.filter.building ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>` : ''}
        ${types.length ? `<select id="dv-type" aria-label="세대 타입으로 거르기"><option value="">타입 전체</option>${types.map((b) => `<option ${b === dv.filter.unitType ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>` : ''}
        ${sheets.some((x) => x.stats?.triage?.unknown) ? `<select id="dv-sort" aria-label="정렬"><option value="">도면번호 순</option><option value="unknown" ${dv.filter.sort === 'unknown' ? 'selected' : ''}>모름 많은 순</option></select>` : ''}
      </div>
    </div>` : ''}
    <div class="board-scroll dview-scroll">
      ${dv.error ? `<div class="board-msg">${icon('alert')}<p>${esc(dv.error)}</p></div>` : ''}
      ${!sets.length ? emptyHtml(editable) : ''}
      ${dv.uploads.length ? uploadsHtml() : ''}
      ${set ? `${sheets.length ? `<p class="dview-count muted small">시트 ${all.length === sheets.length ? `${sheets.length}장` : `${all.length} / ${sheets.length}장`} · 파일 ${files.length}개</p>${bookDetails(set)}
        <div class="sheet-grid">${shown.map(cardHtml).join('')}</div>${shown.length < all.length ? '<div class="sheet-more" aria-hidden="true"></div>' : ''}` : !dv.uploads.length ? `<div class="board-msg">${icon('file')}<p>아직 올린 도면이 없습니다.${editable && !narrow() ? '<br>위의 <b>DXF 파일 올리기</b>로 도서 전체를 한꺼번에 올려주세요.' : ''}</p></div>` : ''}
        ${files.length ? filesHtml(files, editable) : ''}` : ''}
    </div>`}
    <footer class="board-foot">DWG는 AutoCAD에서 <b>다른 이름으로 저장 → DXF</b>로 바꿔서 올려주세요. 원본 도면은 저장하지 않고 시트 그림·요약만 저장합니다.</footer>`;
  dv.painting = false;
  if (keep) { const sc = dv.el.querySelector('.dview-scroll'); if (sc) sc.scrollTop = keep; }
  watchMore();
  loadThumbs(shown);
}

// 거르기·묶음을 바꾸면 처음 60장부터, 맨 위에서
function resetList() { if (dv) { dv.limit = 0; dv.top = true; } }

// 목록 끝 표시가 보이면(조금 앞에서) 60장씩 더 붙인다 — 전체를 다시 그리지 않아 보던 자리 그대로
function watchMore() {
  dv.io?.disconnect();
  const more = dv.el.querySelector('.sheet-more');
  if (!more || typeof IntersectionObserver === 'undefined') return;
  const v = dv;
  v.io = new IntersectionObserver((list) => { if (dv === v && list.some((e) => e.isIntersecting)) growList(); }, { root: dv.el.querySelector('.dview-scroll'), rootMargin: '0px 0px 600px 0px' });
  v.io.observe(more);
}

function growList() {
  const grid = dv.el.querySelector('.sheet-grid');
  const more = dv.el.querySelector('.sheet-more');
  if (!grid || !more) return;
  const all = filtered(store.drawings.cachedSheets(dv.setId) || []);
  const from = grid.children.length;
  dv.limit = nextLimit(all.length, from);
  const add = all.slice(from, dv.limit);
  grid.insertAdjacentHTML('beforeend', add.map(cardHtml).join(''));
  if (dv.limit >= all.length) { dv.io?.disconnect(); more.remove(); } else { dv.io.unobserve(more); dv.io.observe(more); } // 아직 보이면 한 번 더
  loadThumbs(add);
}

// 도서 한 번에 올리기의 숫자(44 지시서 3.10): 화면에 띄우지 않고 접힌 "자세히"에만
const TRADE_KO = { A: '건축', S: '구조', L: '조경', C: '토목', CE: '토공·흙막이', M: '기계설비', F: '소방', E: '전기', T: '통신', '?': '공종 모름' };
function bookDetails(set) {
  const b = set.stats?.book;
  if (!b) return '';
  const c = b.counts || {};
  const trades = Object.entries(b.trades || {}).map(([k, n]) => `${TRADE_KO[k] || k} ${n}`).join(' · ');
  const steps = b.steps || {};
  const sec = (ms) => (ms ? `${Math.round(ms / 1000)}초` : '-');
  return `<details class="dview-book small"><summary>자세히</summary><p class="muted">한 번에 올리기 ${fmtDate(b.at)} · ${Math.round((b.seconds || 0) / 60)}분 · 도면 파일 ${c.drawing ?? '-'}(같은 파일 ${c.dups || 0} 뺌) · 문서 ${c.doc || 0} · 사진 ${c.image || 0} · 찌꺼기 ${c.junk || 0} · 그 밖 ${c.other || 0}${c.nested ? ` · 압축 안 압축 ${c.nested}` : ''}${c.unsafe ? ` · 위험한 경로 ${c.unsafe}` : ''}</p>
    <p class="muted">공종별 파일: ${esc(trades || '-')} · 못 연 파일 ${b.failed || 0} · 회사 PC 필요 ${b.blocked || 0} · 풀기 ${sec(steps.unpack)} · 읽기 ${sec(steps.read)} · 3D ${sec(steps.build)}</p></details>`;
}

function emptyHtml(editable) {
  return `<div class="board-msg">${icon('file')}<p>${editable ? '건축도서 묶음을 만들고 DXF 도면을 올리면<br>도면 한 장마다 그림과 요약을 만들어 정리합니다.' : '아직 올린 건축도서가 없습니다.'}</p>
    ${editable ? `<button type="button" class="btn primary" data-act="dv-set-new">${icon('plus')}도서 묶음 만들기</button>` : ''}</div>`;
}

function uploadsHtml() {
  const active = dv.uploads.some((u) => ['queued', 'scan', 'hash', 'reading', 'sheets'].includes(u.status));
  // 다 읽었으면 한 줄 요약 + 실패한 파일만
  const list = active ? dv.uploads : dv.uploads.filter((u) => u.status === 'error');
  const done = dv.uploads.filter((u) => u.status === 'done');
  const skipped = dv.uploads.filter((u) => u.status === 'skipped').length;
  const xrefs = dv.uploads.filter((u) => u.status === 'xref').length;
  const summary = active ? '' : `<div class="upl-summary">${icon('check')}<span>파일 ${done.length}개를 읽어 시트 ${done.reduce((a, u) => a + u.sheets, 0)}장을 만들었습니다${xrefs ? ` · 외부 참조 파일 ${xrefs}개는 도면에 붙여 읽음` : ''}${skipped ? ` · 건너뜀 ${skipped}` : ''}${list.length ? ` · <b class="t-crit">실패 ${list.length}</b>` : ''}</span><button type="button" class="link small" data-act="dv-uploads-clear">닫기</button></div>`;
  return `${summary}<ul class="upl-list" aria-label="올리는 파일">${list.map((u) => {
    const pct = Math.round((u.pct || 0) * 100);
    const label = { hash: '확인 중', reading: `읽는 중 ${pct}%`, sheets: `시트 만드는 중 ${u.sheets}${u.total ? `/${u.total}` : ''}`, done: `시트 ${u.sheets}장`, skipped: '건너뜀(이미 있는 파일)', error: '실패', queued: '기다리는 중', scan: '외부 참조 확인 중', xref: '외부 참조 파일(도면에 붙여 읽음)' }[u.status] || '';
    return `<li class="upl ${u.status}"><span class="upl-name">${icon(u.status === 'error' ? 'alert' : u.status === 'done' ? 'check' : 'file')}${esc(u.name)} <small class="muted">${fmtSize(u.size)}</small></span>
      <span class="upl-state">${esc(label)}</span>
      ${['reading', 'sheets', 'hash'].includes(u.status) ? `<span class="upl-bar"><span style="width:${u.status === 'sheets' && u.total ? Math.round((u.sheets / u.total) * 100) : pct}%"></span></span>` : ''}
      ${u.error ? `<span class="upl-err">${esc(u.error)}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

function cardHtml(s) {
  const url = dv.thumbs.get(s.id);
  return `<button type="button" class="sheet-card" data-act="dv-sheet" data-id="${esc(s.id)}" aria-label="${esc(`${s.sheetNo} ${s.title}`)} 보기">
    <span class="sheet-thumb" data-thumb="${esc(s.id)}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</span>
    <span class="sheet-info"><b>${esc(s.sheetNo || '번호 없음')}</b><span class="sheet-title">${esc(s.title || '(도면명 없음)')}</span>
      <span class="sheet-badges"><span class="badge plain">${esc(CATEGORY_LABEL[s.category] || '모름')}</span>${confBadge(s)}${s.stats?.triage?.unknown ? `<span class="badge warn" title="건물인지 모르는 개체">모름 ${s.stats.triage.unknown}</span>` : ''}${s.status === 'error' ? '<span class="badge crit">실패</span>' : ''}</span></span>
  </button>`;
}

function filesHtml(files, editable) {
  const failed = files.filter((f) => f.status === 'error').length;
  return `<details class="dview-files" ${failed ? 'open' : ''}><summary>파일 ${files.length}개${failed ? ` · <span class="t-warn">실패 ${failed}</span>` : ''}</summary>
    <ul>${files.map((f) => `<li><span class="f-name">${esc(f.stats?.book?.path || f.name)}</span><span class="muted small">${fmtSize(f.size)} · ${esc(FILE_STATUS_LABEL[f.status] || f.status)}${f.stats?.sheets != null ? ` · 시트 ${f.stats.sheets}장` : ''}${f.stats?.encoding ? ` · ${esc(f.stats.encoding)}` : ''} · ${fmtDate(f.createdAt)}</span>
      ${f.error ? `<span class="upl-err">${esc(f.error)}</span>` : ''}
      ${editable ? `<button type="button" class="icon-btn sm" data-act="dv-file-del" data-id="${esc(f.id)}" aria-label="${esc(f.name)} 지우기" title="이 파일과 시트 지우기">${icon('trash')}</button>` : ''}</li>`).join('')}</ul></details>`;
}

// 썸네일 주소는 그린 카드만, 앞에서부터 묶어서 받는다(공유 모드는 묶음마다 요청 한 번). 첫 묶음은 작게 — 첫 그림이 빨리 뜨게
function loadThumbs(sheets) {
  const v = dv;
  const need = sheets.filter((s) => s.imagePath && !v.thumbs.has(s.id) && !v.thumbWant.has(s.id));
  if (!need.length) return;
  for (const s of need) v.thumbWant.add(s.id);
  v.thumbQ.push(...need);
  if (!v.thumbRun) pumpThumbs(v);
}

async function pumpThumbs(v) {
  v.thumbRun = true;
  let size = 12;
  while (dv === v && v.thumbQ.length) {
    const batch = v.thumbQ.splice(0, size);
    size = 40;
    const urls = await store.drawings.thumbUrls(batch).catch(() => new Map());
    if (dv !== v) return;
    for (const s of batch) {
      const url = urls.get(s.id) || '';
      v.thumbs.set(s.id, url);
      v.thumbWant.delete(s.id);
      const box = url && v.el.querySelector(`[data-thumb="${CSS.escape(s.id)}"]`);
      if (box && !box.firstChild) box.innerHTML = `<img src="${esc(url)}" alt="" loading="lazy">`;
    }
  }
  v.thumbRun = false;
}

// ---------------------------------------------------------------- 묶음 만들기·고치기·지우기

function setDialog(set = null) {
  const now = new Date();
  openModal({
    title: set ? '도서 묶음 정보' : '도서 묶음 만들기',
    body: `<form id="f-dset" data-form="dset" novalidate>
      <label class="field"><span>이름 <em>*</em></span><input name="name" maxlength="60" required value="${esc(set?.name || `건축도서 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)}"></label>
      <label class="field"><span>개정 <small class="muted">(선택)</small></span><input name="revision" maxlength="20" value="${esc(set?.revision || '')}" placeholder="예) R1, 2차 변경"></label>
      <label class="field"><span>메모</span><textarea name="note" maxlength="1000" rows="2">${esc(set?.note || '')}</textarea></label>
      ${set ? `<button type="button" class="link small t-crit" data-act="dv-set-del">${icon('trash')}이 묶음과 시트 모두 지우기</button>` : ''}
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" class="btn primary" form="f-dset">${icon('check')}${set ? '저장' : '만들기'}</button>`,
  }).dataset.setId = set?.id || '';
}

onForm('dset', async (data) => {
  if (!dv) return;
  const id = $('#modal')?.dataset.setId;
  const saved = id ? await store.drawings.updateSet(id, data) : await store.drawings.createSet(dv.siteId, { ...data, status: 'uploading' });
  closeModal(true);
  dv.setId = saved.id;
  await loadSet();
  toast(id ? '묶음 정보를 고쳤습니다.' : '도서 묶음을 만들었습니다. 이제 DXF 도면을 올려주세요.');
});

onAction('dv-set-del', async () => {
  const id = $('#modal')?.dataset.setId;
  if (!id || !dv) return;
  closeModal(false);
  if (!(await confirmDialog('이 도서 묶음과 시트 그림·요약을 모두 지울까요?\n만든 모델 버전은 남습니다.', { title: '도서 묶음 지우기', ok: '지우기', danger: true }))) return;
  await store.drawings.removeSet(id);
  const sets = store.drawings.cached(dv.siteId) || [];
  dv.setId = sets[0]?.id || null;
  await loadSet();
  toast('도서 묶음을 지웠습니다.');
});

// ---------------------------------------------------------------- 올리기(워커로 읽기 → 시트 저장)

export async function sha256File(file) {
  const full = file.size <= 150 * 1024 * 1024;
  const buf = full ? await file.arrayBuffer() : await new Blob([String(file.size), file.slice(0, 4 << 20), file.slice(-(4 << 20))]).arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return `${full ? '' : 'p:'}${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function worker() {
  if (!dv.worker) {
    dv.worker = new Worker(new URL('./cad/worker.js', import.meta.url), { type: 'module' });
    // 워커를 못 불러오면(옛 브라우저 등) 기다리는 파일마다 오류로 끝낸다
    dv.worker.addEventListener('error', (ev) => dv?.worker?.dispatchEvent(new MessageEvent('message', { data: { type: 'error', id: '*', message: `도면 읽기 도구 오류: ${ev.message || '시작하지 못했습니다'}` } })));
  }
  return dv.worker;
}

// 외부 참조 이름만 훑기(한 파일씩)
function scanWithWorker(file) {
  return new Promise((resolve, reject) => {
    const id = newId('reviewFiles');
    const w = worker();
    const onMsg = (ev) => {
      const m = ev.data;
      if (m.id !== id && m.id !== '*') return;
      if (m.type === 'scanned') { w.removeEventListener('message', onMsg); resolve(m.keys || []); }
      else if (m.type === 'error') { w.removeEventListener('message', onMsg); reject(new Error(m.message)); }
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ type: 'scan', id, file, name: file.name });
  });
}

// 워커가 시트를 하나씩 보내면 순서대로 저장한다
function readWithWorker(file, up, fileRec, setId) {
  const v = dv;
  return new Promise((resolve, reject) => {
    const id = newId('reviewFiles');
    const w = worker();
    let chain = Promise.resolve();
    let stats = null;
    // 너무 오래 걸리면(45 지시서 4.2) 워커를 끊고 이 파일만 실패 — 다음 파일은 새 워커로
    const timer = setTimeout(() => {
      w.removeEventListener('message', onMsg);
      if (v?.worker === w) v.worker = null;
      w.terminate();
      chain.finally(() => reject(new Error(TOO_SLOW)));
    }, READ_LIMIT_MS + 30e3);
    const onMsg = (ev) => {
      const m = ev.data;
      if (m.id !== id && m.id !== '*') return;
      if (m.type === 'done' || m.type === 'error') clearTimeout(timer);
      if (m.type === 'progress') {
        if (m.phase === 'read') { up.status = 'reading'; up.pct = m.total ? m.done / m.total : 0; }
        if (m.phase === 'sheets') { up.status = 'sheets'; up.total = m.total; }
        schedule();
      } else if (m.type === 'file') {
        stats = m.stats;
        up.total = stats.sheets;
      } else if (m.type === 'sheet') {
        chain = chain.then(() => saveSheet(setId, fileRec, m)).then(() => { up.sheets++; if (v === dv) schedule(); });
      } else if (m.type === 'done') {
        w.removeEventListener('message', onMsg);
        chain.then(() => resolve(stats), reject);
      } else if (m.type === 'error') {
        w.removeEventListener('message', onMsg);
        chain.finally(() => reject(new Error(m.message)));
      }
    };
    w.addEventListener('message', onMsg);
    const set = (store.drawings.cached(dv?.siteId) || []).find((x) => x.id === setId);
    w.postMessage({ type: 'read', id, file, name: file.name, triageProfile: set?.stats?.triageProfile || {}, deadline: Date.now() + READ_LIMIT_MS });
  });
}

export async function saveSheet(setId, fileRec, m) {
  const id = newId('drawingSheets');
  const s = m.sheet;
  const tb = s.titleBlock || {};
  const digest = { ...m.digest, sheetId: id };
  await store.drawings.saveSheet(setId, {
    id, fileId: fileRec.id, sheetNo: tb.sheetNo || '', title: tb.title || '', scale: tb.scale || '',
    category: s.rule.category, refs: s.rule.refs, frame: s.frame, confidence: s.rule.confidence,
    layerRoles: s.rule.layerRoles || {}, extracted: s.rule.extracted || {},
    status: s.rule.extracted ? 'extracted' : s.rule.category === 'unknown' ? 'read' : 'classified', notes: '',
    stats: { triage: m.triage?.counts || {} },
    meta: { method: s.method, layoutName: s.layoutName, image: m.image, unitM: m.digest?.unitM || 0.001, units: m.digest?.units || '', tiles: m.tiles?.length ? { grid: m.tiles[0].grid, n: m.tiles.length, regions: m.tiles.map((t) => t.region) } : null, source: 'rule', rule: { category: s.rule.category, confidence: s.rule.confidence }, file: fileRec.name, ...(s.rule.profile ? { profile: s.rule.profile } : {}), ...(tb.caption && tb.caption !== tb.title ? { caption: tb.caption } : {}) },
  }, { png: m.png, thumb: m.thumb, tiles: (m.tiles || []).map((t) => ({ n: t.n, blob: t.blob })), digest, geom: m.geom, triage: m.triage });
}

async function readFiles(list) {
  if (!dv?.setId) return;
  const v = dv;
  const setId = v.setId;
  const files = [...list].filter((f) => /\.(dxf|dwg)$/i.test(f.name));
  const skipped = list.length - files.length;
  if (!files.length) { toast(skipped ? 'DXF 파일이 없습니다. AutoCAD에서 DXF로 저장한 파일을 골라주세요.' : '파일을 골라주세요.', 'crit'); return; }
  if (skipped) toast(`도면이 아닌 파일 ${skipped}개는 건너뜁니다.`);
  const ai = await store.ai.settings(v.siteId).catch(() => ({ keepOriginals: false }));
  await store.drawings.updateSet(setId, { status: 'reading' }).catch(() => {});
  const ups = new Map(files.map((file) => [file, { key: `${file.name}|${file.size}|${Math.random()}`, name: file.name, size: file.size, status: 'queued', pct: 0, sheets: 0 }]));
  v.uploads.push(...ups.values());
  schedule();
  // 외부 참조(XREF): 먼저 모든 파일을 훑어 다른 도면이 참조하는 파일(도곽·단위세대·코어 등)을 가려낸다.
  // 그런 파일은 시트로 만들지 않고, 참조하는 도면을 읽을 때 붙여 읽는다.
  const canRead = (f) => !/\.dwg$/i.test(f.name) || dwgAllowed(location.hostname, CFG);
  const referenced = new Set();
  if (files.length > 1) {
    for (const file of files.filter(canRead)) {
      if (dv !== v) return;
      const up = ups.get(file);
      up.status = 'scan';
      schedule();
      const keys = await scanWithWorker(file).catch(() => []);
      for (const k of keys) if (k !== xrefKey(file.name)) referenced.add(k);
      up.status = 'queued';
    }
    worker().postMessage({ type: 'refs', files: files.filter(canRead).map((file) => ({ key: xrefKey(file.name), file, name: file.name })) });
  }
  for (const file of files) {
    if (dv !== v) return;
    const up = ups.get(file);
    up.status = 'hash';
    schedule();
    let rec = null;
    try {
      if (!canRead(file)) throw new Error('DWG는 바로 읽을 수 없어요. AutoCAD에서 "다른 이름으로 저장 → DXF"로 바꿔서 올려주세요.');
      if (referenced.has(xrefKey(file.name))) {
        const sha = await sha256File(file);
        if ((await store.drawings.findBySha(v.siteId, sha)).some((d) => d.setId === setId)) { up.status = 'xref'; schedule(); continue; }
        rec = await store.drawings.addFile(setId, { name: file.name, size: file.size, sha256: sha, status: 'done', stats: { xrefOnly: true, sheets: 0 } }, { original: ai.keepOriginals ? file : null });
        up.status = 'xref';
        schedule();
        continue;
      }
      const sha = await sha256File(file);
      const dup = await store.drawings.findBySha(v.siteId, sha);
      if (dup.length) {
        const sets = store.drawings.cached(v.siteId) || [];
        const where = sets.find((x) => x.id === dup[0].setId)?.name || '다른 묶음';
        const again = await confirmDialog(`"${file.name}"은(는) 이미 올린 파일입니다(${where}).\n다시 읽을까요? 취소하면 건너뜁니다.`, { title: '이미 있는 파일', ok: '다시 읽기' });
        if (!again) { up.status = 'skipped'; schedule(); continue; }
        for (const d of dup.filter((x) => x.setId === setId)) await store.drawings.removeFile(d.id);
      }
      rec = await store.drawings.addFile(setId, { name: file.name, size: file.size, sha256: sha, status: 'reading' }, { original: ai.keepOriginals ? file : null });
      const stats = await readWithWorker(file, up, rec, setId);
      await store.drawings.updateFile(rec.id, { status: 'done', error: '', stats: { ...stats, sheets: up.sheets } });
      up.status = stats?.xrefOnly ? 'xref' : 'done';
    } catch (err) {
      up.status = 'error';
      up.error = err.message;
      if (rec) await store.drawings.updateFile(rec.id, { status: 'error', error: err.message }).catch(() => {});
    }
    schedule();
  }
  worker().postMessage({ type: 'done-batch' });
  if (dv !== v) return;
  const flipped = await structureBundlePass(setId).catch(() => 0);
  await updateSetStats(setId);
  const ok = v.uploads.filter((u) => u.status === 'done');
  const refs = v.uploads.filter((u) => u.status === 'xref').length;
  toast(`도면 ${ok.length}개를 읽어 시트 ${ok.reduce((a, u) => a + u.sheets, 0)}장을 만들었습니다.${refs ? ` 외부 참조 파일 ${refs}개는 도면에 붙여 읽었습니다.` : ''}${flipped ? ` 구조 도면 묶음이라 시트 ${flipped}장을 구조로 읽었습니다.` : ''}`);
}

// 구조 묶음(43 지시서 1절): 묶음 대부분이 구조 도면(도면번호·파일 이름이 S)이면, 공종 글자가 없어 시트 하나로는 못 가른 시트도 구조로 다시 읽는다
// fileIds를 주면 그 파일들의 시트만 묶음으로 본다(도서 한 번에 올리기는 공종 폴더마다, 44 지시서 3.7)
export async function structureBundlePass(setId, { fileIds = null } = {}) {
  const sheets = (await store.drawings.sheets(setId)).filter((s) => !fileIds || fileIds.has(s.fileId));
  const files = new Map((await store.drawings.files(setId)).map((f) => [f.id, f.name]));
  const ids = structureBundleFlips(sheets.map((s) => ({ id: s.id, sheetNo: s.sheetNo, title: s.title, file: files.get(s.fileId) || s.meta?.file || '', category: s.category, manual: Boolean(s.meta?.manual) })));
  if (!ids.length) return 0;
  const { ruleRead } = await import('./bim/rule-read.js');
  let n = 0;
  for (const id of ids) {
    const s = sheets.find((x) => x.id === id);
    const digest = await store.drawings.sheetAsset(s, 'digest').catch(() => null);
    if (!digest) continue;
    const r = ruleRead({ category: 'structure', refs: s.refs, title: s.title }, digest);
    await store.drawings.updateSheet(id, { category: 'structure', extracted: r.extracted || {}, status: r.extracted ? 'extracted' : 'classified', meta: { ...(s.meta || {}), rule: { category: 'structure', confidence: 0.4, bundle: true } } });
    n++;
  }
  return n;
}

export async function updateSetStats(setId, patch = {}, siteId = dv?.siteId) {
  const sheets = await store.drawings.sheets(setId);
  const files = await store.drawings.files(setId);
  const byCategory = {};
  for (const s of sheets) byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  const set = (store.drawings.cached(siteId) || []).find((x) => x.id === setId);
  const { stats: extra = {}, ...rest } = patch;
  await store.drawings.updateSet(setId, {
    status: 'review', ...rest,
    stats: { ...(set?.stats || {}), ...extra, files: files.length, sheets: sheets.length, failed: files.filter((f) => f.status === 'error').length, byCategory },
  });
}

document.addEventListener('change', (e) => {
  if (!dv) return;
  const t = e.target;
  if ((t.id === 'dv-files' || t.id === 'dv-folder') && t.files?.length) {
    const files = [...t.files];
    t.value = '';
    readFiles(files).catch((err) => toast(err.message, 'crit'));
    return;
  }
  if (t.id === 'dv-cat') { dv.filter.category = t.value; resetList(); render(); }
  if (t.id === 'dv-bld') { dv.filter.building = t.value; resetList(); render(); }
  if (t.id === 'dv-type') { dv.filter.unitType = t.value; resetList(); render(); }
  if (t.id === 'dv-sort') { dv.filter.sort = t.value; resetList(); render(); }
});
document.addEventListener('input', (e) => {
  if (!dv || e.target.id !== 'dv-q') return;
  dv.filter.q = e.target.value;
  const pos = e.target.selectionStart;
  resetList();
  render();
  const el = $('#dv-q');
  el?.focus();
  el?.setSelectionRange(pos, pos);
});

onAction('drawings-open', (el) => openDrawings(el.dataset.site));
onAction('dv-close', async () => {
  if (dv?.uploads.some((u) => ['queued', 'scan', 'hash', 'reading', 'sheets'].includes(u.status))
    && !(await confirmDialog('도면을 읽는 중입니다. 닫으면 남은 파일 읽기를 멈춥니다.', { title: '닫기', ok: '닫기' }))) return;
  closeDrawings();
});
onAction('dv-set', async (el) => { if (!dv) return; dv.setId = el.dataset.id; dv.uploads = []; resetList(); render(); await loadSet(); });
onAction('dv-panel', (el) => { if (dv) { dv.panel = el.dataset.key; render(); } });
onAction('dv-set-new', () => setDialog());
onAction('dv-uploads-clear', () => { if (dv) { dv.uploads = []; render(); } });
onAction('dv-set-edit', () => setDialog((store.drawings.cached(dv?.siteId) || []).find((x) => x.id === dv?.setId)));
onAction('dv-sheet', (el) => {
  const s = (store.drawings.cachedSheets(dv?.setId) || []).find((x) => x.id === el.dataset.id);
  if (s) openSheetViewer(s, { onSaved: () => render() });
});
onAction('dv-file-del', async (el) => {
  const f = (store.drawings.cachedFiles(dv?.setId) || []).find((x) => x.id === el.dataset.id);
  if (!f || !(await confirmDialog(`"${f.name}"과(와) 이 파일에서 나온 시트를 지울까요?`, { title: '파일 지우기', ok: '지우기', danger: true }))) return;
  await store.drawings.removeFile(f.id);
  await updateSetStats(dv.setId);
  toast('파일을 지웠습니다.');
});

matchMedia('(max-width: 760px)').addEventListener?.('change', () => { if (dv) render(); }); // 휴대폰 폭이면 보기만
// 도서 화면 위에 연 화면(시트·검증 결과·3D)에서 뒤로 가기를 하면 그 화면만 닫히고 도서 화면은 남는다
const OVER = ['baromapDrawings', 'baromapSheet', 'baromapFindings', 'baromapBim'];
window.addEventListener('popstate', () => { if (dv && !OVER.some((k) => history.state?.[k])) closeDrawings({ fromHistory: true }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dv && !$('#modal') && !document.querySelector('.sview')) closeDrawings(); });
