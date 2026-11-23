// 문서(20 지시서 7절): 도서 화면의 [문서] 탭. 올리기 → 읽기(엑셀은 규칙·사람 확인, PDF는 AI) → 표 고치기 → 연결 현황 → 모델에 반영(새 버전).
// 값 계산은 doc-core·doc-apply·doc-checks(순수 함수)가 하고 여기는 화면만. 권한의 최종 기준은 DB RLS.
import { store } from './ctx.js';
import { addDrawingsPanel, rerenderDrawings, drawingsState } from './drawings.js';
import { onModelBuilt } from './model-build.js';
import { carryFindings } from './bim/edit.js';
import { readExcel, readPdf, readImage, isExcel, isPdf, isImage, isHwp } from './docs-read.js';
import { DOC_KINDS, DOC_KIND_LABEL, DOC_STATUS_LABEL, EMPTY_EXTRACT, FIELDS_OF, findHeader, guessKind, parseGlass, parseSize, readBook, readRows, tableText } from './bim/doc-core.js';
import { readDocText, readCompanyStd, REVIEW_KINDS } from './bim/doc-spec.js';
import { detailLabel } from './bim/detail-keys.js';
import { docPlan, planOps, linkStatus, showValue } from './bim/doc-apply.js';
import { docChecks } from './bim/doc-checks.js';
import { applyPatch } from './bim/validate.js';
import { $, $$, esc, icon, onAction, openModal, closeModal, toast, confirmDialog, fmtDate } from './util.js';

const narrow = () => matchMedia('(max-width: 760px)').matches;
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const total = (x) => (x ? (x.windows?.length || 0) + (x.materials?.length || 0) + (x.finishes?.length || 0) + (x.requirements?.length || 0) + (x.techReview ? Object.keys(x.techReview.values || {}).length : 0) : 0);

let ds = { siteId: null, list: [], busy: '', unsub: null, loading: false };
let vw = null; // 문서 보기: { el, doc, page, sheets, tab, sel }
let ap = null; // 모델에 반영: { siteId, model, files, docs, choices, links, plan, picked }

// ---------------------------------------------------------------- 목록

async function loadDocs(siteId) {
  if (ds.loading) return;
  ds.loading = true;
  try {
    ds.list = await store.rows('projectDocs').list({ siteId });
    ds.siteId = siteId;
  } catch { ds.list = []; ds.siteId = siteId; }
  ds.loading = false;
  ds.unsub?.();
  ds.unsub = store.rows('projectDocs').subscribe(siteId, () => { store.rows('projectDocs').list({ siteId }).then((l) => { ds.list = l; rerenderDrawings(); }); });
  rerenderDrawings();
}

const docsOf = (setId) => ds.list.filter((d) => d.setId === setId || !d.setId);

function aiOn() { return store.mode === 'remote' && store.ai.available; }

function docRow(d, editable) {
  const n = total(d.extracted);
  const pdfWait = !d.extracted && !isExcel(d.name);
  return `<tr>
    <td><button type="button" class="link" data-act="doc-open" data-id="${esc(d.id)}">${icon('file')}${esc(d.name)}</button>${d.revision ? ` <small class="muted">${esc(d.revision)}</small>` : ''}</td>
    <td>${esc(DOC_KIND_LABEL[d.kind] || d.kind)}</td>
    <td class="num">${d.pages || '-'}</td>
    <td><span class="badge ${d.status === 'error' ? 'crit' : d.status === 'applied' ? 'ok' : d.status === 'read' ? 'info' : 'plain'}">${esc(DOC_STATUS_LABEL[d.status] || d.status)}</span></td>
    <td class="num">${n ? `${n}개` : pdfWait ? `<span class="muted small">${aiOn() ? '' : 'AI를 켜면 읽을 수 있음'}</span>` : '-'}</td>
    <td class="act">${editable && aiOn() && !isExcel(d.name) ? `<button type="button" class="btn sm" data-act="doc-ai" data-id="${esc(d.id)}">${icon('refresh')}AI로 읽기</button>` : ''}
      ${editable ? `<button type="button" class="icon-btn" data-act="doc-del" data-id="${esc(d.id)}" aria-label="${esc(d.name)} 지우기" title="지우기">${icon('trash')}</button>` : ''}</td>
  </tr>`;
}

addDrawingsPanel({
  key: 'docs',
  title: '문서',
  html(dv, { set, editable }) {
    if (ds.siteId !== dv.siteId && !ds.loading) queueMicrotask(() => loadDocs(dv.siteId));
    const list = docsOf(set.id);
    const hasRead = list.some((d) => total(d.extracted));
    return `<div class="board-bar dview-bar">
      ${editable ? (narrow() ? '<span class="muted small">문서 올리기는 노트북(PC)에서 해주세요.</span>' : `<label class="btn sm primary file-btn ${ds.busy ? 'disabled' : ''}">${icon('upload')}문서 올리기<input type="file" id="doc-files" accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.hwp,.hwpx" multiple ${ds.busy ? 'disabled' : ''}></label>`) : ''}
      ${editable && hasRead ? `<button type="button" class="btn sm" data-act="doc-apply-open">${icon('cube')}모델에 반영</button>` : ''}
      ${ds.busy ? `<span class="muted small">${esc(ds.busy)}</span>` : ''}
    </div>
    <div class="board-scroll dview-scroll">
      ${list.length ? `<div class="doc-wrap"><table class="doc-list"><thead><tr><th>문서</th><th>종류</th><th>쪽</th><th>상태</th><th>읽은 항목</th><th></th></tr></thead><tbody>${list.map((d) => docRow(d, editable)).join('')}</tbody></table></div>`
    : `<div class="board-msg">${icon('file')}<p>창호 성능표·유리 사양·자재 성적서·마감재 리스트를 올리면<br>값을 읽어 타입별 세대에 반영합니다.</p></div>`}
      <p class="muted small doc-help">PDF·엑셀·그림을 받습니다. 한글(HWP) 문서는 PDF로 저장해서 올려주세요. 문서에 없는 값은 비워 둡니다.</p>
    </div>`;
  },
});

document.addEventListener('change', (e) => {
  if (e.target?.id === 'doc-files') { addFiles([...e.target.files]); e.target.value = ''; }
});

// 도서 한 번에 올리기(js/book-upload.js)도 문서(PDF·엑셀)·그림을 이 길로 넣는다
export async function addOne(file, siteId, setId) {
  const name = file.name;
  if (isExcel(name)) {
    const sheets = await readExcel(file, name);
    if (guessKind(name, sheets[0]?.grid || []) === 'company_std') {
      const req = readCompanyStd(sheets[0]?.grid || []).requirements;
      const doc = await store.docs.upload(siteId, file, { setId, kind: 'company_std', pages: sheets.length });
      await store.docs.saveText(doc, sheets.map((s) => tableText(s.grid)));
      await store.rows('projectDocs').save({ ...doc, extracted: req.length ? { ...EMPTY_EXTRACT(), source: 'rule', requirements: req } : null, status: req.length ? 'read' : 'uploaded', confidence: req.length ? 0.6 : null, note: req.length ? '' : '공종·항목·기준 머리글을 찾지 못했습니다.' });
      return;
    }
    const r = readBook(name, sheets);
    const doc = await store.docs.upload(siteId, file, { setId, kind: r.kind, pages: sheets.length });
    await store.docs.saveText(doc, sheets.map((s) => tableText(s.grid)));
    await store.rows('projectDocs').save({ ...doc, extracted: r.confident ? r.extracted : null, status: r.confident ? 'read' : 'uploaded', confidence: r.confident ? 0.7 : null, note: r.confident ? '' : '머리글을 찾지 못했습니다. 문서를 열어 열을 골라주세요.' });
    return;
  }
  const doc = await store.docs.upload(siteId, file, { setId, kind: guessKind(name), pages: 1 });
  if (isPdf(name)) {
    const r = await readPdf(file, { onPage: async (n, png) => { ds.busy = `${name} ${n}쪽 그림 만드는 중…`; rerenderDrawings(); await store.docs.savePage(doc, n, png); } });
    await store.docs.saveText(doc, r.texts);
    const scanned = !r.texts.some((t) => t.trim());
    const kind = guessKind(name, r.texts.slice(0, 2).map((t) => [t]));
    const part = scanned ? null : readDocText(kind, r.texts);
    await store.rows('projectDocs').save({ ...doc, kind, pages: r.pages, ...(part ? { extracted: { ...EMPTY_EXTRACT(), source: 'rule', ...part }, status: 'read', confidence: 0.5 } : {}),
      note: `${scanned ? '스캔본입니다(글자 없음). ' : ''}${r.more ? `앞 ${r.pages}쪽만 읽었습니다.` : ''}${part ? '규칙으로 읽었습니다(AI 없이 — 추출률이 낮을 수 있습니다).' : ''}` });
  } else {
    await store.docs.savePage(doc, 1, await readImage(file));
    await store.docs.saveText(doc, ['']);
  }
}

async function addFiles(files) {
  const dv = drawingsState();
  if (!dv?.setId) return;
  let done = 0;
  for (const f of files) {
    if (isHwp(f.name)) { toast(`${f.name}: 한글 문서는 PDF로 저장해서 올려주세요.`, 'warn'); continue; }
    if (!isExcel(f.name) && !isPdf(f.name) && !isImage(f.name)) { toast(`${f.name}: 받지 않는 형식입니다.`, 'warn'); continue; }
    ds.busy = `${f.name} 읽는 중…`;
    rerenderDrawings();
    try { await addOne(f, dv.siteId, dv.setId); done++; } catch (err) { toast(`${f.name}: ${err.message}`, 'crit'); }
  }
  ds.busy = '';
  await loadDocs(dv.siteId);
  await refreshDocFindings(dv.siteId).catch(() => {});
  if (done) toast(`문서 ${done}개를 올렸습니다.`);
}

onAction('doc-del', async (el) => {
  const d = ds.list.find((x) => x.id === el.dataset.id);
  if (!d || !(await confirmDialog(`"${d.name}"을(를) 지울까요?\n이미 모델에 반영한 값은 그대로 남습니다.`, { title: '문서 지우기', ok: '지우기', danger: true }))) return;
  await store.docs.remove(d);
  await loadDocs(d.siteId);
  await refreshDocFindings(d.siteId).catch(() => {});
  toast('문서를 지웠습니다.');
});

onAction('doc-ai', async (el) => {
  const d = ds.list.find((x) => x.id === el.dataset.id);
  if (!d) return;
  ds.busy = `${d.name} AI로 읽는 중…`;
  rerenderDrawings();
  try {
    const job = await store.jobs.create(d.siteId, 'read_doc', { docId: d.id }, { setId: d.setId });
    const r = await store.ai.call('ai-doc', { jobId: job.id });
    for (let i = 0; i < (r.next || []).length; i++) {
      ds.busy = `${d.name} ${i + 1}/${r.next.length}쪽 읽는 중…`;
      rerenderDrawings();
      await store.ai.call('ai-doc', { jobId: r.next[i] }); // 같은 줄을 동시에 고치지 않게 하나씩
    }
    toast(`${d.name}을(를) 읽었습니다. 표를 확인해주세요.`);
  } catch (err) {
    toast(err.message, 'crit');
  }
  ds.busy = '';
  await loadDocs(d.siteId);
  await refreshDocFindings(d.siteId).catch(() => {});
});

// ---------------------------------------------------------------- 도면·문서 대조

async function loadLatest(siteId) {
  const versions = await store.bim.versions(siteId);
  const model = versions[0];
  if (!model) return null;
  const idx = await store.bim.load(model, 'index.json');
  const files = { 'index.json': idx };
  for (const n of ['site.json', 'catalog.json', ...Object.values(idx.files.buildings || {}), ...Object.values(idx.files.unitTypes || {})]) files[n] = await store.bim.load(model, n);
  return { model, files };
}

export async function refreshDocFindings(siteId) {
  if (!store.can('edit', siteId)) return;
  const got = await loadLatest(siteId);
  if (!got) return;
  const [docs, s] = await Promise.all([store.rows('projectDocs').list({ siteId }), store.ops.settings(siteId)]);
  await store.bim.saveFindings(got.model.id, docChecks({ files: got.files, docs, standards: s.standards, climateZone: s.climateZone }), { source: 'doc' });
}
onModelBuilt(async ({ siteId }) => { await refreshDocFindings(siteId).catch(() => {}); });

// ---------------------------------------------------------------- 문서 보기

const W_COLS = [
  ['기호', (w) => w.code, (w, v) => { w.code = v.toUpperCase().replace(/\s/g, ''); }],
  ['적용 타입', (w) => (w.appliesTo?.unitTypes || []).join(', '), (w, v) => { w.appliesTo.unitTypes = v.split(/[,·]\s*/).filter(Boolean); }],
  ['규격', (w) => (w.sizeMm ? `${w.sizeMm.w}×${w.sizeMm.h}` : ''), (w, v) => { w.sizeMm = parseSize(v); }],
  ['유리', (w) => w.glass?.notation || '', (w, v) => { w.glass = parseGlass(v); }],
  ['U 창세트', (w) => w.perf?.uWindow ?? '', (w, v) => { w.perf.uWindow = v === '' ? null : Number(v); }],
  ['U 유리', (w) => w.perf?.uGlass ?? '', (w, v) => { w.perf.uGlass = v === '' ? null : Number(v); }],
  ['기밀', (w) => w.perf?.airtight?.grade || '', (w, v) => { w.perf.airtight = { ...(w.perf.airtight || {}), grade: v || null }; }],
  ['제조사', (w) => w.frame?.maker || '', (w, v) => { w.frame.maker = v || null; }],
];
const M_COLS = [
  ['자재', (m) => m.name, (m, v) => { m.name = v; }],
  ['규격', (m) => m.spec || '', (m, v) => { m.spec = v || null; }],
  ['제조사', (m) => m.maker || '', (m, v) => { m.maker = v || null; }],
  ['성능', (m) => (m.perf || []).map((p) => `${p.label} ${p.value ?? ''}${p.unit ? ` ${p.unit}` : ''}`).join(', '), null],
];
const F_COLS = [
  ['타입', (f) => f.unitType || '', (f, v) => { f.unitType = v || null; }],
  ['실', (f) => f.room, (f, v) => { f.room = v; }],
  ['바닥', (f) => f.floor || '', (f, v) => { f.floor = v || null; }],
  ['벽', (f) => f.wall || '', (f, v) => { f.wall = v || null; }],
  ['천장', (f) => f.ceiling || '', (f, v) => { f.ceiling = v || null; }],
  ['걸레받이', (f) => f.base || '', (f, v) => { f.base = v || null; }],
];
const GROUPS = [['windows', '창호', W_COLS], ['materials', '자재', M_COLS], ['finishes', '마감', F_COLS]];
const BLANK = { windows: () => ({ code: '', kind: 'window', name: null, appliesTo: { unitTypes: [], rooms: [] }, sizeMm: null, frame: { material: null, opening: null, maker: null }, glass: null, perf: { uWindow: null, uGlass: null, shgc: null, airtight: { value: null, unit: null, grade: null } }, page: vw?.page || 1 }), materials: () => ({ name: '', spec: null, maker: null, perf: [], page: vw?.page || 1 }), finishes: () => ({ unitType: null, room: '', floor: null, wall: null, ceiling: null, base: null, option: null, page: vw?.page || 1 }) };

function tableHtml(g, label, cols, items, editable) {
  if (!items.length && !editable) return '';
  return `<h4>${esc(label)} ${items.length}</h4><div class="doc-wrap"><table class="doc-table"><thead><tr>${cols.map(([h]) => `<th>${esc(h)}</th>`).join('')}${editable ? '<th></th>' : ''}</tr></thead><tbody>
    ${items.map((it, i) => `<tr class="${vw.sel === `${g}:${i}` ? 'sel' : ''}" data-doc-row="${g}:${i}">${cols.map(([h, get, set], c) => `<td>${editable && set ? `<input data-doc-cell="${g}:${i}:${c}" value="${esc(get(it) ?? '')}" aria-label="${esc(h)}">` : esc(get(it) ?? '')}</td>`).join('')}
      ${editable ? `<td><button type="button" class="icon-btn" data-act="doc-row-del" data-row="${g}:${i}" aria-label="줄 지우기">${icon('close')}</button></td>` : ''}</tr>`).join('')}
  </tbody></table></div>${editable ? `<button type="button" class="link small" data-act="doc-row-add" data-g="${g}">${icon('plus')}줄 더하기</button>` : ''}`;
}

function columnsHtml() {
  const s = vw.sheets?.[vw.sheet || 0];
  const fields = FIELDS_OF[vw.doc.kind];
  if (!s) return '<p class="muted small">표를 불러오는 중입니다.</p>';
  if (!fields) return '<p class="muted small">이 문서 종류는 표로 읽지 않습니다. 위에서 종류를 골라주세요.</p>';
  const h = vw.map || findHeader(vw.doc.kind, s.grid) || { row: 0, lines: 1, columns: {} };
  vw.map = h;
  const labels = (s.grid[h.row] || []).map((v, c) => `${c + 1}열 ${[v, h.lines === 2 ? s.grid[h.row + 1]?.[c] : ''].filter(Boolean).join(' ')}`.slice(0, 30));
  return `<p class="muted small">AI 없이 읽습니다. 머리글 줄과 칸마다 어느 열인지 맞는지 확인해주세요.</p>
    <div class="grid2">
      <label class="field"><span>머리글 줄</span><input id="doc-hrow" type="number" min="1" value="${h.row + 1}"></label>
      <label class="field"><span>머리글 줄 수</span><select id="doc-hlines"><option value="1" ${h.lines === 1 ? 'selected' : ''}>1줄</option><option value="2" ${h.lines === 2 ? 'selected' : ''}>2줄</option></select></label>
    </div>
    <div class="doc-cols">${fields.map(([key, label]) => `<label class="field"><span>${esc(label)}</span><select data-doc-col="${key}"><option value="">없음</option>${labels.map((l, c) => `<option value="${c}" ${h.columns[key] === c ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`).join('')}</div>
    <button type="button" class="btn primary sm" data-act="doc-reread">${icon('check')}이 열로 읽기</button>`;
}

function pageHtml() {
  const d = vw.doc;
  if (isExcel(d.name)) {
    const s = vw.sheets?.[vw.sheet || 0];
    if (!s) return `<div class="board-msg">${icon('table')}<p>표를 여는 중…</p></div>`;
    const hit = vw.selRow;
    return `<div class="doc-grid"><table>${s.grid.slice(0, 400).map((r, i) => `<tr class="${hit === i + 1 ? 'hit' : ''}"><th>${i + 1}</th>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
  }
  return `<div class="doc-img"><img id="doc-img" alt="${esc(d.name)} ${vw.page}쪽">${vw.box ? `<i class="doc-box" style="left:${vw.box[0] * 100}%;top:${vw.box[1] * 100}%;width:${(vw.box[2] - vw.box[0]) * 100}%;height:${(vw.box[3] - vw.box[1]) * 100}%"></i>` : ''}</div>`;
}

function paintView() {
  if (!vw) return;
  const d = vw.doc;
  const editable = store.can('edit', d.siteId);
  const x = d.extracted || EMPTY_EXTRACT();
  const excel = isExcel(d.name);
  vw.el.innerHTML = `<header class="board-head">
      <button type="button" class="icon-btn" data-act="doc-close" aria-label="닫기" title="닫기">${icon('close')}</button>
      <div class="board-title"><b>${esc(d.name)}</b><span>${esc(DOC_KIND_LABEL[d.kind] || '')}${d.revision ? ` · ${esc(d.revision)}` : ''}${d.docDate ? ` · ${esc(fmtDate(d.docDate))}` : ''} · ${esc(DOC_STATUS_LABEL[d.status] || '')}</span></div>
      <div class="board-tools">${d.path ? `<button type="button" class="icon-btn" data-act="doc-orig" aria-label="원본 받기" title="원본 받기">${icon('download')}</button>` : ''}</div>
    </header>
    <div class="docv-body">
      <section class="docv-page" aria-label="원본">
        ${(excel ? (vw.sheets?.length || 0) : d.pages) > 1 ? `<div class="docv-nav">
          ${excel ? `<select id="doc-sheet" aria-label="시트">${vw.sheets.map((s, i) => `<option value="${i}" ${i === (vw.sheet || 0) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
    : `<button type="button" class="icon-btn" data-act="doc-page" data-d="-1" aria-label="앞 쪽" ${vw.page <= 1 ? 'disabled' : ''}>${icon('back')}</button><span>${vw.page} / ${d.pages}쪽</span><button type="button" class="icon-btn flip" data-act="doc-page" data-d="1" aria-label="다음 쪽" ${vw.page >= d.pages ? 'disabled' : ''}>${icon('back')}</button>`}
        </div>` : ''}
        ${pageHtml()}
      </section>
      <section class="docv-side" aria-label="읽은 값">
        ${editable ? `<div class="grid3 doc-meta">
          <label class="field"><span>종류</span><select id="doc-kind">${DOC_KINDS.map((k) => `<option value="${k}" ${k === d.kind ? 'selected' : ''}>${esc(DOC_KIND_LABEL[k])}</option>`).join('')}</select></label>
          <label class="field"><span>개정</span><input id="doc-rev" maxlength="20" value="${esc(d.revision || '')}"></label>
          <label class="field"><span>작성일</span><input id="doc-date" type="date" value="${esc(d.docDate || '')}"></label>
        </div>` : ''}
        ${excel && editable ? `<div class="seg" role="tablist"><button type="button" role="tab" class="${vw.tab === 'cols' ? '' : 'on'}" data-act="doc-tab" data-tab="table">읽은 표</button><button type="button" role="tab" class="${vw.tab === 'cols' ? 'on' : ''}" data-act="doc-tab" data-tab="cols">열 고르기</button></div>` : ''}
        ${d.note ? `<p class="small t-warn">${esc(d.note)}</p>` : ''}
        ${SPEC_KINDS.has(d.kind) ? specHtml(d, x) : vw.tab === 'cols' ? columnsHtml() : `${!total(x) && !excel ? `<p class="muted small">${store.mode === 'remote' && store.ai.available ? '문서 목록의 [AI로 읽기]로 읽을 수 있습니다.' : 'AI를 켜면 읽을 수 있습니다. 표를 직접 넣어도 됩니다.'}</p>` : ''}
          ${GROUPS.filter(([g]) => x[g].length || (editable && (!FIELDS_OF[d.kind] || FIELDS_OF[d.kind] === fieldsFor(g)))).map(([g, l, c]) => tableHtml(g, l, c, x[g], editable)).join('')}`}
      </section>
    </div>`;
  loadImage();
}
// ---------------------------------------------------------------- 시방서·회사 기준·기술검토서(39 지시서 5절)
const SPEC_KINDS = new Set(['spec', 'company_std', 'tech_review']);
const OP_KO = { '>=': '이상', '<=': '이하', '>': '초과', '<': '미만', '=': '' };
const valueText = (v) => `${v.key === 'other' ? v.label || '숫자' : detailLabel(v.key)} ${v.value.toLocaleString()}${v.unit || ''} ${OP_KO[v.op] || ''}`.trim();
const pageLink = (n) => (n ? `<button type="button" class="link small" data-act="doc-goto" data-page="${n}">${n}쪽</button>` : '');
const REVIEW_LABEL = { method: '공법', depthM: '굴착 깊이(m)', support: '지지 방식', stages: '단수', monitoring: '계측', model: '기종', count: '대수', heightM: '높이(m)', foundationM: '기초 크기(m)', location: '위치', shore: '동바리', spacingMm: '간격(mm)', keepDays: '존치(일)', type: '종류', floors: '존치 층수' };

function specHtml(d, x) {
  const cmp = vw.compare;
  const cmpHtml = `<h4>모델과 대조</h4>${cmp == null ? '<p class="muted small loading">모델을 읽는 중…</p>' : cmp.error ? `<p class="muted small">${esc(cmp.error)}</p>`
    : cmp.list.length ? `<ul class="nt-list">${cmp.list.map((f) => `<li class="nt-item ${f.severity === 'error' ? 'crit' : 'warn'}"><span class="nt-main">${esc(f.message)}</span></li>`).join('')}</ul>` : '<p class="small">모델의 상세 값과 다른 요구사항이 없습니다.</p>'}`;
  if (d.kind === 'tech_review') {
    const t = x.techReview;
    if (!t) return '<p class="muted small">검토 값을 읽지 못했습니다. 글자가 있는 PDF인지 확인하거나 AI를 켜면 읽을 수 있습니다.</p>';
    return `<p class="small"><b>${esc(REVIEW_KINDS[t.kind] || t.kind)}</b> 검토서 · 개요·결론 쪽 ${t.summaryPages.map(pageLink).join(' ')}</p>
      <dl class="kvs">${Object.entries(t.values || {}).map(([k, v]) => `<div><dt>${esc(REVIEW_LABEL[k] || k)}</dt><dd>${esc(Array.isArray(v) ? v.join('×') : v)}</dd></div>`).join('')}</dl>
      ${t.conclusion ? `<p class="small">결론(검토서 문구 그대로): “${esc(t.conclusion.text)}” ${pageLink(t.conclusion.page)}</p>` : '<p class="small t-warn">결론 문구를 찾지 못했습니다.</p>'}
      ${t.candidates?.length ? `<p class="small">가설 배치 후보(사람이 확인해야 확정): ${t.candidates.map((c) => esc(c.note)).join(', ')}</p>` : ''}
      <p class="muted small">안전 여부는 판단하지 않습니다. 흙막이 값은 [모델에 반영]에서 단지 정보로 넣을 수 있습니다.</p>`;
  }
  const req = x.requirements || [];
  return `<p class="muted small">숫자 요구사항 ${req.length}개${x.chapters?.length ? ` · 장 ${x.chapters.length}개` : ''}${x.source === 'rule' ? ' · 규칙으로 읽음(추출률이 낮을 수 있음)' : ''}</p>
    <ul class="dv-list">${req.map((r) => `<li class="dv-row"><div class="dv-main"><b>${esc(r.values.map(valueText).join(', '))}</b><small class="muted">${esc(r.trade || r.item || '')} · ${esc(r.requirement)}</small></div>${pageLink(r.page)}</li>`).join('') || '<li class="muted small">읽은 요구사항이 없습니다.</li>'}</ul>
    ${cmpHtml}`;
}

async function loadCompare() {
  const d = vw?.doc;
  if (!d || !SPEC_KINDS.has(d.kind) || d.kind === 'tech_review') return;
  try {
    const got = await loadLatest(d.siteId);
    if (!vw || vw.doc.id !== d.id) return;
    vw.compare = got ? { list: docChecks({ files: got.files, docs: [vw.doc] }).filter((f) => f.kind === 'spec_value_mismatch') } : { error: '이 현장에 아직 모델이 없습니다.' };
  } catch (err) { if (vw) vw.compare = { error: err.message }; }
  if (vw) paintView();
}
onAction('doc-goto', (el) => { vw.page = Math.max(1, Math.min(vw.doc.pages || 1, Number(el.dataset.page) || 1)); vw.box = null; paintView(); });

const fieldsFor = (g) => FIELDS_OF[{ windows: 'window_performance', materials: 'material_spec', finishes: 'finish_list' }[g]];

async function loadImage() {
  const img = $('#doc-img', vw?.el);
  if (!img) return;
  try { img.src = await store.docs.page(vw.doc, vw.page); } catch { /* 쪽 그림이 없으면 빈 칸 */ }
}

export async function openDocViewer(id, page = 1) {
  const doc = ds.list.find((d) => d.id === id) || await store.rows('projectDocs').get(id);
  if (!doc) { toast('문서를 찾을 수 없습니다.', 'crit'); return; }
  closeDocViewer();
  const el = document.createElement('div');
  el.className = 'board docv';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', doc.name);
  document.body.append(el);
  document.body.classList.add('board-open');
  vw = { el, doc, page: Math.max(1, Number(page) || 1), sheets: null, sheet: 0, tab: 'table', sel: null, box: null, selRow: null, map: null, compare: null };
  paintView();
  loadCompare();
  if (isExcel(doc.name) && doc.path) {
    try {
      const url = await store.docs.url(doc);
      vw.sheets = await readExcel(await (await fetch(url)).blob(), doc.name);
      vw.sheet = Math.max(0, Math.min(vw.sheets.length - 1, vw.page - 1));
      if (!doc.extracted) vw.tab = 'cols';
      paintView();
    } catch (err) { toast(err.message, 'crit'); }
  }
}

function closeDocViewer() {
  if (!vw) return;
  vw.el.remove();
  vw = null;
  if (!document.querySelector('.board, .mview, .sview, .bview')) document.body.classList.remove('board-open');
}

async function saveDoc(patch) {
  const rec = await store.rows('projectDocs').save({ ...vw.doc, ...patch });
  vw.doc = rec;
  ds.list = ds.list.map((d) => (d.id === rec.id ? rec : d));
  return rec;
}

onAction('doc-open', (el) => openDocViewer(el.dataset.id, el.dataset.page));
onAction('doc-close', () => { const siteId = vw?.doc.siteId; closeDocViewer(); rerenderDrawings(); if (siteId) refreshDocFindings(siteId).catch(() => {}); });
onAction('doc-page', (el) => { vw.page = Math.max(1, Math.min(vw.doc.pages, vw.page + Number(el.dataset.d))); vw.box = null; paintView(); });
onAction('doc-tab', (el) => { vw.tab = el.dataset.tab; paintView(); });
onAction('doc-orig', async () => { window.open(await store.docs.url(vw.doc), '_blank', 'noopener'); });
onAction('doc-row-add', async (el) => {
  const x = vw.doc.extracted || { ...EMPTY_EXTRACT(), source: 'manual' };
  x[el.dataset.g].push(BLANK[el.dataset.g]());
  await saveDoc({ extracted: x, status: vw.doc.status === 'uploaded' ? 'read' : vw.doc.status });
  paintView();
});
onAction('doc-row-del', async (el) => {
  const [g, i] = el.dataset.row.split(':');
  vw.doc.extracted[g].splice(Number(i), 1);
  await saveDoc({ extracted: vw.doc.extracted });
  paintView();
});
onAction('doc-reread', async () => {
  const s = vw.sheets?.[vw.sheet || 0];
  if (!s) return;
  const columns = {};
  for (const sel of $$('[data-doc-col]', vw.el)) if (sel.value !== '') columns[sel.dataset.docCol] = Number(sel.value);
  const h = { row: Math.max(0, Number($('#doc-hrow', vw.el).value) - 1), lines: Number($('#doc-hlines', vw.el).value), columns };
  const x = readRows(vw.doc.kind, s.grid, h, { page: (vw.sheet || 0) + 1 });
  x.source = 'manual';
  if (!total(x)) { toast('이 열로는 읽은 값이 없습니다. 기호·실명 열을 확인해주세요.', 'warn'); return; }
  await saveDoc({ extracted: x, status: 'read', note: '' });
  vw.tab = 'table';
  paintView();
  toast(`${total(x)}개를 읽었습니다.`);
});

document.addEventListener('change', async (e) => {
  if (!vw || !vw.el.contains(e.target)) return;
  const t = e.target;
  try {
    if (t.dataset.docCell) {
      const [g, i, c] = t.dataset.docCell.split(':');
      const cols = GROUPS.find((x) => x[0] === g)[2];
      cols[Number(c)][2](vw.doc.extracted[g][Number(i)], t.value.trim());
      await saveDoc({ extracted: vw.doc.extracted });
    } else if (t.id === 'doc-kind') {
      vw.map = null;
      let patch = { kind: t.value };
      if (SPEC_KINDS.has(t.value)) {
        const pages = await store.docs.text(vw.doc).catch(() => []);
        const part = t.value === 'company_std' ? null : readDocText(t.value, pages);
        if (part) patch = { ...patch, extracted: { ...(vw.doc.extracted || EMPTY_EXTRACT()), source: 'rule', ...part }, status: 'read' };
      }
      await saveDoc(patch);
      vw.compare = null;
      paintView();
      loadCompare();
    }
    else if (t.id === 'doc-rev') await saveDoc({ revision: t.value });
    else if (t.id === 'doc-date') await saveDoc({ docDate: t.value });
    else if (t.id === 'doc-sheet') { vw.sheet = Number(t.value); vw.map = null; paintView(); }
    else if (t.id === 'doc-hrow' || t.id === 'doc-hlines') {
      vw.map = { row: Math.max(0, Number($('#doc-hrow', vw.el).value) - 1), lines: Number($('#doc-hlines', vw.el).value), columns: vw.map?.columns || {} };
      paintView();
    }
  } catch (err) { toast(err.message, 'crit'); }
});

// 줄을 누르면 근거 쪽으로
document.addEventListener('click', (e) => {
  const row = e.target.closest?.('[data-doc-row]');
  if (!row || !vw?.el.contains(row) || e.target.closest('button')) return;
  const [g, i] = row.dataset.docRow.split(':');
  const it = vw.doc.extracted?.[g]?.[Number(i)];
  if (!it) return;
  if (vw.sel === row.dataset.docRow) return;
  vw.sel = row.dataset.docRow;
  vw.box = it.box || null;
  vw.selRow = it.row || null;
  if (isExcel(vw.doc.name)) vw.sheet = Math.max(0, (it.page || 1) - 1);
  else if (it.page) vw.page = it.page;
  const keep = e.target.matches?.('input') ? e.target.dataset.docCell : null;
  paintView();
  if (keep) $(`[data-doc-cell="${keep}"]`, vw.el)?.focus();
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && vw && !$('#modal')) { closeDocViewer(); rerenderDrawings(); } });

// ---------------------------------------------------------------- 연결 현황·모델에 반영

const STATUS = { new: ['새로', 'ok'], change: ['바뀜', 'info'], same: ['같음', 'plain'], conflict: ['충돌', 'crit'], kept: ['사람이 고친 값 유지', 'warn'] };
const GROUP_LABEL = { window: '창호', material: '재료', finish: '마감', site: '단지(기술검토서)' };

function applyBody() {
  const { plan } = ap;
  const st = linkStatus(plan);
  const line = (it) => {
    const on = ap.picked.has(it.key);
    const can = it.ops.length > 0;
    return `<li class="ap-item">
      <label class="check"><input type="checkbox" data-ap-pick="${esc(it.key)}" ${on && can ? 'checked' : ''} ${can ? '' : 'disabled'}><span><b>${esc(it.label)}</b> <span class="badge ${STATUS[it.status][1]}">${STATUS[it.status][0]}</span></span></label>
      ${it.changes.length ? `<p class="small muted">${it.changes.slice(0, 6).map((c) => `${esc(c.label)}: ${c.from ? `${esc(c.from)} → ` : ''}${esc(c.to)}`).join(' · ')}${it.changes.length > 6 ? ` 외 ${it.changes.length - 6}칸` : ''}</p>` : ''}
      ${it.conflicts.map((c) => `<label class="field ap-conflict"><span>${esc(c.label)}: 문서마다 다릅니다. 하나를 골라주세요.</span><select data-ap-choice="${esc(c.key)}"><option value="">고르지 않음(비워 둠)</option>${c.values.map((v) => `<option value="${esc(v.docId)}" ${c.chosen === v.docId ? 'selected' : ''}>${esc(v.value)} — ${esc(v.docName)}${v.revision ? ` ${esc(v.revision)}` : ''}${v.docDate ? ` (${esc(v.docDate)})` : ''}</option>`).join('')}</select></label>`).join('')}
    </li>`;
  };
  const mats = ap.files['catalog.json'].materials;
  return `<div class="ap-status">${Object.entries(GROUP_LABEL).map(([g, l]) => `<div><b>${esc(l)}</b><span>연결 ${st[g].linked}</span><span class="${st[g].missing ? 't-warn' : 'muted'}">못 찾음 ${st[g].missing}</span><span class="${st[g].conflict ? 't-crit' : 'muted'}">충돌 ${st[g].conflict}</span></div>`).join('')}</div>
    ${Object.entries(GROUP_LABEL).map(([g, l]) => { const items = plan.items.filter((x) => x.group === g && x.status !== 'same'); return items.length ? `<h4>${esc(l)} ${items.length}</h4><ul class="ap-list">${items.map(line).join('')}</ul>` : ''; }).join('')}
    ${plan.unlinked.length ? `<h4>연결 안 됨 ${plan.unlinked.length}</h4><ul class="ap-list">${plan.unlinked.map((u) => `<li class="ap-item"><span><b>${esc(u.name)}</b> <span class="muted small">${esc(u.why)}</span></span>
      ${u.group === 'material' ? `<select data-ap-link="${esc(u.name)}" aria-label="${esc(u.name)} 연결할 재료"><option value="">연결할 재료 고르기</option>${mats.map((m) => `<option value="${esc(m.id)}" ${ap.links[u.name] === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}</li>`).join('')}</ul>` : ''}
    ${!plan.items.some((x) => x.status !== 'same') && !plan.unlinked.length ? '<p class="muted">모델과 문서가 같습니다. 바꿀 것이 없습니다.</p>' : ''}`;
}

function replan() {
  ap.plan = docPlan(ap.files, ap.docs, { choices: ap.choices, links: ap.links });
  const had = ap.touched;
  ap.picked = new Set(ap.plan.items.filter((x) => (had.has(x.key) ? ap.picked.has(x.key) : x.status === 'new' || x.status === 'change') && x.ops.length).map((x) => x.key));
  const body = $('#ap-body');
  if (body) body.innerHTML = applyBody();
}

onAction('doc-apply-open', async () => {
  const dv = drawingsState();
  if (!dv) return;
  const got = await loadLatest(dv.siteId);
  if (!got) { toast('먼저 도면으로 모델을 만들어주세요.', 'warn'); return; }
  ap = { siteId: dv.siteId, ...got, docs: docsOf(dv.setId), choices: {}, links: {}, plan: null, picked: new Set(), touched: new Set() };
  ap.plan = docPlan(ap.files, ap.docs);
  ap.picked = new Set(ap.plan.items.filter((x) => (x.status === 'new' || x.status === 'change') && x.ops.length).map((x) => x.key));
  openModal({
    title: `문서를 모델에 반영 (v${got.model.version} 기준)`,
    wide: true,
    body: `<p class="muted small">고른 항목으로 새 버전을 만듭니다. 지금 버전은 그대로 남습니다. 값이 문서마다 다르면 자동으로 고르지 않습니다.</p><div id="ap-body">${applyBody()}</div>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">닫기</button><button type="button" class="btn primary" data-act="doc-apply">${icon('check')}고른 항목 반영</button>`,
  });
});

document.addEventListener('change', (e) => {
  if (!ap) return;
  const t = e.target;
  if (t.dataset?.apPick) { ap.touched.add(t.dataset.apPick); if (t.checked) ap.picked.add(t.dataset.apPick); else ap.picked.delete(t.dataset.apPick); }
  else if (t.dataset?.apChoice) { if (t.value) ap.choices[t.dataset.apChoice] = t.value; else delete ap.choices[t.dataset.apChoice]; replan(); }
  else if (t.dataset?.apLink) { if (t.value) ap.links[t.dataset.apLink] = t.value; else delete ap.links[t.dataset.apLink]; replan(); }
});

onAction('doc-apply', async () => {
  const ops = planOps(ap.plan, [...ap.picked]);
  if (!ops.length) { toast('고른 항목이 없습니다.', 'warn'); return; }
  const r = applyPatch(ap.files, ops, { method: 'doc' });
  if (!r.ok) { toast(`반영하지 못했습니다: ${r.errors[0]}`, 'crit'); return; }
  const { siteId, model } = ap;
  const used = new Set(ap.plan.items.filter((x) => ap.picked.has(x.key)).flatMap((x) => x.docIds));
  const m = await store.bim.save(siteId, r.files, { setId: model.setId, parentId: model.id, note: `문서 반영 ${ap.picked.size}건`, summary: r.files['index.json'].summary });
  await carryFindings(model.id, m.id);
  // 도서 화면의 [3D 보기]가 새 버전을 열게 한다
  const set = (store.drawings.cached(siteId) || []).find((x) => x.id === model.setId);
  if (set) await store.drawings.updateSet(set.id, { stats: { ...(set.stats || {}), model: { ...(set.stats?.model || {}), id: m.id, version: m.version } } }).catch(() => {});
  for (const d of ap.docs.filter((x) => used.has(x.id))) await store.rows('projectDocs').save({ ...d, status: 'applied' });
  const n = ap.picked.size;
  ap = null;
  closeModal(true);
  await loadDocs(siteId);
  await refreshDocFindings(siteId).catch(() => {});
  toast(`문서 값 ${n}건을 반영해 모델 v${m.version}을 만들었습니다.`);
});

export { showValue };
