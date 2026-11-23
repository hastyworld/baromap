// 도서 한 벌 한 번에 올리기(44 지시서 3절). 현장 패널의 큰 칸(또는 3D 화면 위)에 zip 여러 개·폴더·도면 파일을 놓으면
// 풀기 → 같은 파일 빼기 → AutoCAD 파일 바꾸기(회사 PC에서만) → 공종 폴더마다 외부 참조·읽기·구조 묶음 → 3D 만들기 → 3D 열기까지
// 누를 것 없이 간다. 설비 등 "보관만" 공종은 3D가 열린 뒤 이어서 읽어 도면 목록에만 둔다.
// 원칙(44 맨 앞): 화면 글은 한 문장·전문 용어 없음, 묻지 않고 처리(같은 파일은 조용히 건너뜀 → 다시 놓으면 이어서),
// 기다림은 한 줄(누르면 펼침), 사람이 할 일이 있을 때만 끝 줄 하나.
import { store, state, CFG, ui } from './ctx.js';
import { entryKind, planBook, pickUnique, bookName, READ_LIMIT_MS, TOO_SLOW } from './cad/book.js';
import { expandBook } from './cad/unzip.js';
import { dwgAllowed, DWG_LIBS, DWG_CONV } from './cad/dwg.js';
import { xrefKey } from './cad/xref.js';
import { sha256File, saveSheet, structureBundlePass, updateSetStats, openDrawings, drawingsState } from './drawings.js';
import { buildAndSave } from './model-build.js';
import { openBimViewer, closeBimViewer, bimViewerState } from './bim/viewer.js';
import { addOne as addDocFile, refreshDocFindings } from './docs-ui.js';
import { $, esc, icon, onAction } from './util.js';

export const BOOK_ACCEPT = '.zip,.dwg,.dxf,.pdf,.xlsx,.xls,.jpg,.jpeg,.png,.baromap';
const base = (p) => String(p).split('/').pop();
const STOP = Symbol('stop');

let job = null; // 지금 도는 일(한 번에 하나): { siteId, t0, phase, units, stop, open, counts, … }
let notice = null; // 끝 줄: { siteId, text, items: [{ path, why }], fix, act }
const queue = []; // 도는 중에 더 놓은 것

export const bookBusy = (siteId) => Boolean(job && (!siteId || job.siteId === siteId));

// ---------------------------------------------------------------- 놓는 칸(현장 패널)

/** 현장 패널의 큰 칸: 할 일은 "파일 놓기" 하나(원칙 1). 휴대폰은 눌러서 고른다 */
export function bookDropHtml(siteId) {
  if (bookBusy(siteId)) return '';
  // 휴대폰 폭이면 "눌러서 고르세요"(CSS로 바꿔 보인다 — 화면 폭이 바뀌어도 맞게)
  return `<label class="book-drop" data-book-drop="${esc(siteId)}">${icon('upload')}<b><span class="on-wide">도면 파일을 여기에 놓으세요</span><span class="on-narrow">눌러서 도면 파일을 고르세요</span></b>
    <input type="file" class="book-input" data-site="${esc(siteId)}" multiple accept="${BOOK_ACCEPT}" aria-label="도면 파일 고르기"></label>`;
}

/** 3D가 이미 있을 때 "다른 방법" 안에서 도면을 더하는 단추(휴대폰은 끌어다 놓을 수 없어서) */
export function bookAddHtml(siteId) {
  return `<label class="btn sm file-btn">${icon('upload')}도면 더하기<input type="file" class="book-input" data-site="${esc(siteId)}" multiple accept="${BOOK_ACCEPT}"></label>`;
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t.classList?.contains('book-input') || !t.files?.length) return;
  const items = [...t.files].map((f) => ({ path: f.webkitRelativePath || f.name, blob: f }));
  t.value = '';
  startBook(t.dataset.site, items);
});

// 끌어다 놓기: 큰 칸, 현장 패널, 3D 화면(새 도면 더하기)
function dropSite(e) {
  if (!e.dataTransfer?.types?.includes('Files')) return null;
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return null;
  const zone = t.closest('[data-book-drop]');
  if (zone) return zone.dataset.bookDrop;
  if (t.closest('.bview')) return bimViewerState()?.siteId || null;
  if (t.closest('.dview')) return drawingsState()?.siteId || null;
  if (t.closest('#panel') && state.siteId && state.view !== 'lodging' && !document.querySelector('.board, .bview, .mview, .sview')) return state.siteId;
  return null;
}
document.addEventListener('dragover', (e) => {
  const siteId = dropSite(e);
  if (!siteId || !store.can('edit', siteId)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.querySelector(`[data-book-drop="${CSS.escape(siteId)}"]`)?.classList.add('over');
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !(e.relatedTarget instanceof Element) || !e.relatedTarget.closest('[data-book-drop]')) for (const z of document.querySelectorAll('.book-drop.over')) z.classList.remove('over'); });
document.addEventListener('drop', async (e) => {
  const siteId = dropSite(e);
  for (const z of document.querySelectorAll('.book-drop.over')) z.classList.remove('over');
  if (!siteId || !store.can('edit', siteId)) return;
  e.preventDefault();
  // 폴더는 항목(entry)으로 걸어 들어간다. 항목은 놓은 순간에만 꺼낼 수 있어 먼저 모은다
  const entries = [...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const loose = entries.length ? [] : [...e.dataTransfer.files].map((f) => ({ path: f.name, blob: f }));
  const items = entries.length ? await walkEntries(entries) : loose;
  if (items.length) startBook(siteId, items);
});

async function walkEntries(entries) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) { out.push({ path: prefix + entry.name, blob: await new Promise((r, j) => entry.file(r, j)) }); return; }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((r, j) => reader.readEntries(r, j));
      if (!batch.length) break;
      for (const c of batch) await walk(c, `${prefix}${entry.name}/`);
    }
  };
  for (const en of entries) await walk(en, '').catch(() => {});
  return out;
}

// ---------------------------------------------------------------- 시작·끝

/**
 * 놓은 것으로 도서를 읽어 3D까지(누를 것 없음)
 * @param {string} siteId @param {{ path: string, blob: Blob }[]} items
 */
export async function startBook(siteId, items) {
  if (!siteId || !store.drawings || !store.can('edit', siteId) || !items.length) return;
  if (job) { queue.push({ siteId, items }); return; }
  notice = null;
  job = { siteId, t0: performance.now(), phase: 'unpack', units: { total: 0, done: 0 }, stop: false, open: false, counts: {}, steps: {}, files: 0, filesDone: 0 };
  const j = job;
  holdScreen(true);
  paint();
  ui.render();
  try {
    await run(j, items);
  } catch (err) {
    if (err !== STOP) {
      console.error('[도서]', err);
      notice = { siteId, text: '도면을 다 읽지 못했어요', items: [{ path: '', why: err?.message || String(err) }], fix: '같은 파일을 다시 놓으면 이어서 읽어요.' };
    }
  } finally {
    killWorkers();
    job = null;
    holdScreen(false);
    paint();
    ui.render();
    const next = queue.shift();
    if (next) startBook(next.siteId, next.items);
  }
}

// 화면 꺼짐 막기(되면), 탭을 닫으려 하면 브라우저 기본 "나가시겠어요?"만
let lock = null;
async function wake() { try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; } }
function holdScreen(on) {
  if (on) { wake(); window.addEventListener('beforeunload', beforeUnload); document.addEventListener('visibilitychange', rewake); return; }
  window.removeEventListener('beforeunload', beforeUnload);
  document.removeEventListener('visibilitychange', rewake);
  lock?.release?.().catch(() => {});
  lock = null;
}
function rewake() { if (job && document.visibilityState === 'visible') wake(); }
function beforeUnload(e) { if (job) { e.preventDefault(); e.returnValue = ''; } }

// ---------------------------------------------------------------- 일의 흐름

const meta = (f) => ({ path: f.path.slice(-300), trade: f.trade, group: f.group.slice(-200), model: f.model, kind: f.dwg ? 'dwg' : 'dxf', inner: f.inner });
const weight = (f) => (f.dwg ? f.size * 7 : f.size); // 바꾸기(DWG)는 읽기보다 무겁다 — 남은 시간 어림용

async function run(j, items) {
  const siteId = j.siteId;
  const bundles = items.filter((it) => entryKind(it.path) === 'bundle');
  for (const b of bundles) await openBundle(j, b.blob);
  const rest = items.filter((it) => entryKind(it.path) !== 'bundle');
  if (!rest.length) return;

  // 1. 풀기(목록만 — 항목은 필요할 때 꺼낸다)
  const t1 = performance.now();
  const { files, skipped } = await expandBook(rest);
  const plan = planBook(files);
  for (const f of plan.files.filter((x) => x.kind === 'bundle')) await openBundle(j, await f.open());
  const drawings = plan.files.filter((f) => f.kind === 'drawing').map((f) => ({ ...f, name: base(f.path), dwg: /\.dwg$/i.test(f.path) }));
  const docs = plan.files.filter((f) => f.kind === 'doc' || f.kind === 'image');
  if (!drawings.length && !docs.length) return;

  // 2. 같은 파일: 크기(+zip의 CRC)가 같은 것만 내용 해시로 확인한다 → 하나만 남기고 조용히 뺀다
  const bySize = new Map();
  for (const f of drawings) { const k = `${f.size}:${f.crc ?? ''}`; if (!bySize.has(k)) bySize.set(k, []); bySize.get(k).push(f); }
  for (const list of bySize.values()) if (list.length > 1) for (const f of list) { checkStop(j); f.sha = await sha256File(await f.open()); }
  const { keep, dups } = pickUnique(drawings.map((f) => ({ ...f, sha: f.sha || `u:${f.path}` })));
  j.counts = { ...plan.counts, dups: dups.length, ...skipped };
  j.files = keep.length;
  j.units.total = keep.reduce((a, f) => a + weight(f), 0) || 1;
  j.steps.unpack = Math.round(performance.now() - t1);

  // 3. 도서 묶음: zip(폴더) 이름으로 저절로. 같은 이름 묶음이 있으면 이어서 쓴다
  // 도면 낱개만 놓았으면(다시 저장한 파일 등) 이 현장의 가장 최근 도서에 이어 넣는다
  const loose = rest.every((it) => !String(it.path).includes('/') && entryKind(it.path) !== 'archive');
  const set = await ensureSet(siteId, bookName(rest.map((it) => it.path)), { latest: loose });
  j.setId = set.id;
  const prev = new Map((await store.drawings.files(set.id)).map((r) => [r.sha256, r]));
  const ai = await store.ai.settings(siteId).catch(() => ({ keepOriginals: false }));
  j.keepOriginals = Boolean(ai.keepOriginals);
  j.prev = prev;
  j.problems = [];
  j.newSheets = 0;

  // 4. 공종 폴더마다(3D에 쓰는 묶음 먼저). 외부 참조·구조 묶음은 폴더마다 따로 본다(같은 이름의 참조가 공종마다 판이 다를 수 있다)
  const groups = new Map();
  for (const f of keep) { if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push({ ...f, sha: f.sha.startsWith('u:') ? '' : f.sha }); }
  const ordered = [...groups.entries()].map(([key, list]) => ({ key, list, model: list.some((f) => f.model) })).sort((a, b) => Number(b.model) - Number(a.model));
  j.phase = 'read';
  paint();
  const tRead = performance.now();
  for (const g of ordered.filter((x) => x.model)) await readGroup(j, set, g);
  j.steps.read = Math.round(performance.now() - tRead);

  // 5. 3D 만들기 → 열기(누를 것 없음)
  await updateSetStats(set.id, {}, siteId);
  await buildAndOpen(j, set);

  // 6. 보관만 하는 공종(설비 등)은 3D가 열린 뒤 이어서 읽는다(도면 목록에서 볼 수 있게, 3D에는 안 넘김)
  const archive = ordered.filter((x) => !x.model);
  if (archive.length) {
    j.phase = 'archive';
    paint();
    for (const g of archive) await readGroup(j, set, g);
  }
  // 7. 문서·그림(PDF·엑셀·사진): 문서 칸으로
  // 이미 넣은 문서(내용 해시)는 건너뛴다 — 다시 놓아도 두 번 들어가지 않게
  const docShas = new Set(((store.drawings.cached(siteId) || []).find((x) => x.id === set.id)?.stats?.book?.docs) || []);
  if (docs.length && store.docs) {
    j.phase = 'docs';
    paint();
    for (const d of docs) {
      checkStop(j);
      try {
        const blob = await d.open();
        const sha = (await sha256File(blob)).slice(0, 24);
        if (docShas.has(sha)) continue;
        await addDocFile(new File([blob], base(d.path)), siteId, set.id);
        docShas.add(sha);
      } catch (err) { console.warn('[도서] 문서', err); }
    }
    await refreshDocFindings(siteId).catch(() => {});
  }
  // 8. 기록(도면 목록의 접힌 "자세히"와 운영자용): 숫자만. 화면에는 띄우지 않는다(3.10)
  const trades = {};
  for (const f of keep) trades[f.trade || '?'] = (trades[f.trade || '?'] || 0) + 1;
  const fresh = (store.drawings.cached(siteId) || []).find((x) => x.id === set.id) || set;
  await store.drawings.updateSet(set.id, { stats: { ...(fresh.stats || {}), book: {
    at: new Date().toISOString(), seconds: Math.round((performance.now() - j.t0) / 1000), counts: j.counts, trades,
    failed: j.problems.filter((p) => p.kind === 'failed').length, blocked: j.problems.filter((p) => p.kind === 'blocked').length, steps: j.steps, conv: DWG_CONV,
    docs: [...docShas].slice(-200),
  } } }).catch(() => {});
  await dxfCache.clear();
  finishNotice(j);
}

function checkStop(j) { if (j.stop || job !== j) throw STOP; }

async function ensureSet(siteId, name, { latest = false } = {}) {
  const sets = await store.drawings.sets(siteId);
  const recent = latest ? [...sets].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] : null;
  const same = recent || sets.find((s) => s.name === name);
  if (same) { await store.drawings.updateSet(same.id, { status: 'reading' }).catch(() => {}); return same; }
  return store.drawings.createSet(siteId, { name, status: 'reading', note: '' });
}

// 공종 폴더 하나: 준비(해시·이어 읽기 판단·바꾸기·외부 참조 훑기) → 읽기 → 구조 묶음
async function readGroup(j, set, g) {
  const ready = [];
  const kept = []; // 이미 읽은 파일: 다시 읽지 않지만 새로 읽는 도면의 외부 참조로는 쓴다
  const referenced = new Set();
  for (const f of g.list) {
    checkStop(j);
    const blob = await f.open();
    f.sha ||= await sha256File(blob);
    const before = j.prev.get(f.sha);
    // 이미 읽은 파일은 조용히 건너뛴다(다시 놓으면 이어서). 같은 판으로 못 바꾼 파일도 다시 하지 않는다
    if (before?.status === 'done') {
      const dxf = f.dwg ? await dxfCache.get(f.sha) : null;
      if (!f.dwg || dxf) kept.push({ ...f, src: dxf ? { blob: dxf } : f.src, dxfName: f.name.replace(/\.dwg$/i, '.dxf') });
      advance(j, f, 1);
      continue;
    }
    if (before?.status === 'error' && before.stats?.book?.fail === 'dwg' && before.stats.book.conv === DWG_CONV) { j.problems.push({ kind: 'failed', path: f.path }); advance(j, f, 1); continue; }
    if (before) { await store.drawings.removeFile(before.id).catch(() => {}); j.prev.delete(f.sha); }
    // 다시 저장한 파일: 같은 이름(확장자만 다를 수 있음)으로 실패했던 기록은 지운다
    const stem = f.name.replace(/\.(dwg|dxf)$/i, '').toLowerCase();
    for (const r of [...j.prev.values()]) {
      if (r.status === 'error' && String(r.name).replace(/\.(dwg|dxf)$/i, '').toLowerCase() === stem) { await store.drawings.removeFile(r.id).catch(() => {}); j.prev.delete(r.sha256); }
    }
    if (f.dwg) {
      if (!dwgAllowed(location.hostname, CFG)) { await fileFailed(j, set, f, 'blocked'); continue; }
      let dxf = await dxfCache.get(f.sha);
      if (!dxf) {
        j.phase = j.open ? 'archive' : 'convert';
        paint();
        const out = await convertDwg(j, blob);
        if (!out) { await fileFailed(j, set, f, 'dwg'); continue; }
        dxf = await dxfCache.put(f.sha, out);
      }
      j.phase = j.open ? 'archive' : 'read';
      f.src = { blob: dxf };
      f.dxfName = f.name.replace(/\.dwg$/i, '.dxf');
      advance(j, f, 2 / 7);
    } else {
      // 무압축 항목·낱개 파일은 원본 조각 그대로, 압축 항목은 워커가 꺼낸다(본 화면이 큰 도면을 쥐지 않게)
      f.dxfName = f.name;
    }
    f.original = j.keepOriginals ? blob : null; // 원본 보관을 켰을 때만 쥔다
    ready.push(f);
  }
  if (!ready.length) return;
  if (ready.length > 1) {
    for (const f of ready) {
      checkStop(j);
      const keys = await callCad(j, { type: 'scan', src: f.src, name: f.dxfName }, 'scanned').then((m) => m.keys || []).catch(() => []);
      for (const k of keys) if (k !== xrefKey(f.name)) referenced.add(k);
    }
  }
  setRefs([...ready, ...kept].map((f) => ({ key: xrefKey(f.name), src: f.src, name: f.dxfName })));
  const recs = new Set();
  for (const f of ready) {
    checkStop(j);
    const original = f.original;
    if (referenced.has(xrefKey(f.name))) {
      // 다른 도면이 참조하는 파일(도곽·단위세대 등)은 시트로 만들지 않고, 참조하는 도면을 읽을 때 붙여 읽는다
      const rec = await store.drawings.addFile(set.id, { name: f.name.slice(0, 200), size: f.size, sha256: f.sha, status: 'done', stats: { xrefOnly: true, sheets: 0, book: meta(f) } }, { original });
      recs.add(rec.id);
      advance(j, f, 1);
      continue;
    }
    const rec = await store.drawings.addFile(set.id, { name: f.name.slice(0, 200), size: f.size, sha256: f.sha, status: 'reading', stats: { book: meta(f) } }, { original });
    recs.add(rec.id);
    try {
      const { stats, sheets } = await readOne(j, set, f, rec);
      await store.drawings.updateFile(rec.id, { status: 'done', error: '', stats: { ...stats, sheets, book: meta(f) } });
      j.newSheets += sheets;
    } catch (err) {
      if (err === STOP) throw err;
      j.problems.push({ kind: 'failed', path: f.path });
      await store.drawings.updateFile(rec.id, { status: 'error', error: String(err?.message || err).slice(0, 300), stats: { book: { ...meta(f), fail: 'read' } } }).catch(() => {});
    }
    advance(j, f, 1);
    f.original = null;
  }
  setRefs(null);
  await structureBundlePass(set.id, { fileIds: recs }).catch(() => 0);
}

async function fileFailed(j, set, f, why) {
  j.problems.push({ kind: why === 'blocked' ? 'blocked' : 'failed', path: f.path });
  await store.drawings.addFile(set.id, { name: f.name.slice(0, 200), size: f.size, sha256: f.sha, status: 'error', error: why === 'blocked' ? '회사 PC에서 열어야 하는 파일' : 'AutoCAD에서 열어 다시 저장해 주세요', stats: { book: { ...meta(f), fail: why, conv: DWG_CONV } } }).catch(() => {});
  advance(j, f, 1);
}

// 진행(남은 시간 어림): 파일 무게만큼, 읽기 중에는 워커가 알려 주는 만큼
function advance(j, f, part) {
  const w = weight(f);
  const done = Math.min(1, (f.part || 0) + part);
  j.units.done += (done - (f.part || 0)) * w;
  f.part = done;
  if (done >= 1) j.filesDone++;
  paint();
}

// ---------------------------------------------------------------- 3D 만들기·열기

async function buildAndOpen(j, set) {
  const siteId = j.siteId;
  const files = await store.drawings.files(set.id);
  const skip = new Set(files.filter((r) => r.stats?.book && r.stats.book.model === false).map((r) => r.id));
  const fresh = (store.drawings.cached(siteId) || []).find((x) => x.id === set.id) || set;
  const had = fresh.stats?.model?.id;
  const versions = await store.bim.versions(siteId).catch(() => []);
  let modelId = had && !j.newSheets && versions.some((m) => m.id === had) ? had : null;
  if (!modelId) {
    j.phase = 'build';
    paint();
    const t = performance.now();
    try {
      const model = await buildAndSave(siteId, fresh, { skipFileIds: skip });
      modelId = model.id;
    } catch (err) {
      console.warn('[도서] 3D 만들기', err);
      const big = /memory|메모리|allocation|out of|워커/i.test(String(err?.message || err));
      notice = big
        ? { siteId, text: '도면이 많아 회사 PC에서 마무리할게요', items: [], fix: '' }
        : { siteId, text: '3D로 만들 평면도를 찾지 못했어요', items: [], act: 'book-open-list', actLabel: '도면 보기', setId: set.id };
      j.steps.build = Math.round(performance.now() - t);
      return;
    }
    j.steps.build = Math.round(performance.now() - t);
  }
  checkStop(j);
  j.open = true;
  if (bimViewerState()) closeBimViewer({ keepHistory: true });
  await openBimViewer(siteId, modelId);
  paint();
}

// 회사 PC 도구(real:book)가 만든 3D 묶음(.baromap: gzip JSON) → 새 초안 버전(운영자·현장 담당만, 44 지시서 4.6)
async function openBundle(j, blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const stream = head[0] === 0x1f && head[1] === 0x8b ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob.stream();
  const data = JSON.parse(await new Response(stream).text());
  if (data?.format !== 'baromap-3d/1' || !data.files?.['index.json']) throw new Error('3D 파일이 아닙니다.');
  const versions = await store.bim.versions(j.siteId);
  const parent = [...versions].sort((a, b) => b.version - a.version)[0] || null;
  const model = await store.bim.save(j.siteId, data.files, { setId: null, parentId: parent?.id || null, note: `회사 PC에서 만든 3D${data.name ? ` "${String(data.name).slice(0, 40)}"` : ''}`, summary: data.summary || {} });
  if (data.findings?.length) await store.bim.saveFindings(model.id, data.findings, { source: 'rule' });
  j.open = true;
  if (bimViewerState()) closeBimViewer({ keepHistory: true });
  await openBimViewer(j.siteId, model.id);
}

// ---------------------------------------------------------------- 끝 줄(할 일이 있을 때만)

function finishNotice(j) {
  if (notice) { paint(); return; }
  const failed = j.problems.filter((p) => p.kind === 'failed');
  const blocked = j.problems.filter((p) => p.kind === 'blocked');
  if (failed.length) notice = { siteId: j.siteId, text: `도면 ${failed.length + blocked.length}장은 열지 못했어요`, items: [...failed, ...blocked], fix: 'AutoCAD에서 열어 다시 저장해 주세요. 다시 저장한 파일을 같은 칸에 놓으면 그것만 이어서 읽어요.' };
  else if (blocked.length) notice = { siteId: j.siteId, text: `도면 ${blocked.length}장은 회사 PC에서 열어야 해요`, items: blocked, fix: '회사 PC에서 바로맵을 열고 같은 파일을 놓으면 이어서 읽어요.' };
  paint();
}

onAction('book-notice-close', () => { notice = null; paint(); });
onAction('book-notice-more', () => { if (notice) { notice.open = !notice.open; paint(); } });
onAction('book-open-list', () => { const n = notice; notice = null; paint(); if (n?.siteId) openDrawings(n.siteId, n.setId || null); });
onAction('book-stop', () => { if (!job) return; job.stop = true; killWorkers(); paint(); });
onAction('book-more', () => { if (job) { job.more = !job.more; paint(); } });

// ---------------------------------------------------------------- 기다림 한 줄(화면 맨 아래, 3D 위에도 보이게)

const PHASE = { unpack: '압축 풀기', convert: 'AutoCAD 파일 바꾸기', read: '도면 읽기', build: '3D 만들기', archive: '나머지 도면 정리', docs: '문서 정리' };
function etaText(j) {
  const el = (performance.now() - j.t0) / 1000;
  const pct = j.units.done / j.units.total;
  if (j.phase === 'build') return '';
  if (el < 8 || pct < 0.02) return '';
  const left = (el / pct) * (1 - pct) * (j.open ? 1 : 1.1);
  return left < 60 ? '곧 끝나요' : `약 ${Math.ceil(left / 60)}분 남음`;
}
function headline(j) {
  if (j.stop) return '멈추는 중이에요';
  if (j.phase === 'build') return '3D를 만들고 있어요';
  const eta = etaText(j);
  const what = j.open ? '나머지 도면을 정리하고 있어요' : '도면을 읽고 있어요';
  return eta ? `${what} · ${eta}` : what;
}

let painted = 0;
function paint() {
  const now = performance.now();
  if (job && now - painted < 250 && job.phase !== 'build') { schedulePaint(); return; }
  painted = now;
  let el = $('#book-line');
  if (!job && !notice) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'book-line'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.append(el); }
  if (job) {
    const pct = job.phase === 'build' ? 100 : Math.round((job.units.done / job.units.total) * 100);
    const c = job.counts || {};
    el.className = `book-line run${job.more ? ' more' : ''}`;
    el.innerHTML = `<button type="button" class="book-line-main" data-act="book-more" aria-expanded="${Boolean(job.more)}"><span class="book-line-text">${esc(headline(job))}</span>
        <span class="book-bar${job.phase === 'build' ? ' busy' : ''}"><span style="width:${Math.max(3, pct)}%"></span></span></button>
      <button type="button" class="link small book-stop" data-act="book-stop">멈추기</button>
      ${job.more ? `<p class="book-line-more muted small">${esc(PHASE[job.phase] || '')} · 도면 ${job.filesDone}/${job.files || '-'}${c.dups ? ` · 같은 파일 ${c.dups}` : ''}${c.junk ? ` · 찌꺼기 ${c.junk}` : ''}${c.doc || c.image ? ` · 문서·사진 ${(c.doc || 0) + (c.image || 0)}` : ''}</p>` : ''}`;
    return;
  }
  el.className = `book-line note${notice.open ? ' more' : ''}`;
  el.innerHTML = `<span class="book-line-text">${icon('alert')}${esc(notice.text)}</span>
    ${notice.items?.length ? `<button type="button" class="link" data-act="book-notice-more" aria-expanded="${Boolean(notice.open)}">보기</button>` : ''}
    ${notice.act ? `<button type="button" class="link" data-act="${esc(notice.act)}">${esc(notice.actLabel || '보기')}</button>` : ''}
    <button type="button" class="icon-btn sm" data-act="book-notice-close" aria-label="닫기">${icon('close')}</button>
    ${notice.open ? `<div class="book-line-list">${notice.fix ? `<p class="small">${esc(notice.fix)}</p>` : ''}<ul>${notice.items.map((x) => `<li class="small">${esc(x.path || x.why || '')}</li>`).join('')}</ul></div>` : ''}`;
}
let paintTimer = 0;
function schedulePaint() { if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = 0; paint(); }, 260); }

// ---------------------------------------------------------------- 워커(읽기·바꾸기)

let cad = null;
let cadSeq = 0;
// 기다리는 워커 답: 멈추면(워커를 버리면) 답이 오지 않으므로 모두 STOP으로 끝낸다
const waiting = new Set();
const wait = (fn) => new Promise((resolve, reject) => {
  const w = { reject };
  waiting.add(w);
  fn((v) => { waiting.delete(w); resolve(v); }, (e) => { waiting.delete(w); reject(e); });
});
let cadRefs = null; // 지금 공종 폴더의 참조 목록: 워커를 새로 띄우면 다시 넣는다
function cadWorker() {
  if (!cad) {
    const w = new Worker(new URL('./cad/worker.js', import.meta.url), { type: 'module' });
    w.calls = new Set();
    // 워커가 죽으면(시작 실패·메모리 등) 기다리던 부름을 모두 실패로 끝내고 버린다 — 다음 부름은 새 워커로
    w.addEventListener('error', (ev) => {
      if (cad === w) cad = null;
      w.terminate();
      for (const c of [...w.calls]) { w.calls.delete(c); c(new Error(ev.message || '도면 읽기 도구가 멈췄습니다')); }
    });
    if (cadRefs) w.postMessage({ type: 'refs', files: cadRefs });
    cad = w;
  }
  return cad;
}
function setRefs(files) { cadRefs = files; cadWorker().postMessage(files ? { type: 'refs', files } : { type: 'done-batch' }); }
// 한 번 부르고 답 하나 기다리기(훑기). 워커가 죽으면 버리고 다음은 새로
function callCad(j, msg, want) {
  const id = `b${++cadSeq}`;
  const w = cadWorker();
  return wait((resolve, reject) => {
    const done = () => { w.removeEventListener('message', on); w.calls.delete(fail); };
    const on = (ev) => { const m = ev.data; if (m.id !== id) return; if (m.type === want) { done(); resolve(m); } else if (m.type === 'error') { done(); reject(new Error(m.message)); } };
    const fail = (err) => { done(); reject(err); };
    w.addEventListener('message', on);
    w.calls.add(fail);
    w.postMessage({ ...msg, id });
  });
}
function dropCad() { cad?.terminate(); cad = null; cadRefs = null; }

// 워커를 끊는다(너무 오래 걸린 파일): 이 워커를 기다리던 부름은 모두 실패, 다음 부름은 새 워커(참조 목록을 다시 넣음)
function abandonCad(w, err) {
  if (cad === w) cad = null;
  w.terminate();
  for (const c of [...w.calls]) { w.calls.delete(c); c(err); }
}

// 파일 하나 읽기: 워커가 시트를 하나씩 보내면 순서대로 저장(drawings.js와 같은 저장). 한도(READ_LIMIT_MS)를 넘기면 그 파일만 실패
function readOne(j, set, f, rec) {
  const id = `r${++cadSeq}`;
  const w = cadWorker();
  return wait((resolve, reject) => {
    let chain = Promise.resolve();
    let stats = null;
    let sheets = 0;
    const timer = setTimeout(() => abandonCad(w, new Error(TOO_SLOW)), READ_LIMIT_MS + 30e3);
    const done = () => { clearTimeout(timer); w.removeEventListener('message', on); w.calls.delete(fail); };
    const on = (ev) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress' && m.phase === 'read' && m.total) { const p = (m.done / m.total) * 0.6; if (p > (f.readPart || 0)) { advance(j, f, (p - (f.readPart || 0)) * (f.dwg ? 5 / 7 : 1)); f.readPart = p; } }
      else if (m.type === 'file') stats = m.stats;
      else if (m.type === 'sheet') chain = chain.then(() => saveSheet(set.id, rec, m)).then(() => { sheets++; });
      else if (m.type === 'done') { done(); chain.then(() => resolve({ stats: stats || {}, sheets }), reject); }
      else if (m.type === 'error') { done(); chain.finally(() => reject(new Error(m.message))); }
    };
    // 워커가 죽으면(메모리 등) 이 파일만 실패 — 다음 파일은 새 워커(참조 목록을 다시 넣음)로 이어서 읽는다
    const fail = (err) => { done(); reject(err); };
    w.addEventListener('message', on);
    w.calls.add(fail);
    w.postMessage({ type: 'read', id, src: f.src, name: f.dxfName, triageProfile: set.stats?.triageProfile || {}, deadline: Date.now() + READ_LIMIT_MS });
  });
}

// AutoCAD 파일 바꾸기: 판마다 워커 하나, 실패하거나 죽으면 그 워커를 버리고 다른 판(새 워커)으로 한 번 더
const dwgWorkers = new Map();
function dwgWorker(lib) {
  if (!dwgWorkers.has(lib)) dwgWorkers.set(lib, new Worker(new URL('./cad/dwg-worker.js', import.meta.url), { type: 'module' }));
  return dwgWorkers.get(lib);
}
function dropDwg(lib) { dwgWorkers.get(lib)?.terminate(); dwgWorkers.delete(lib); }
const convTimeout = (size) => Math.min(15 * 60e3, Math.max(120e3, (size / 1048576) * 20e3));

async function convertDwg(j, blob) {
  for (const lib of DWG_LIBS) {
    checkStop(j);
    const w = dwgWorker(lib);
    const id = `d${++cadSeq}`;
    const r = await wait((resolve) => {
      const timer = setTimeout(() => { done(); resolve({ error: 'timeout' }); }, convTimeout(blob.size));
      const done = () => { clearTimeout(timer); w.removeEventListener('message', on); w.removeEventListener('error', fail); };
      const on = (ev) => { if (ev.data?.id !== id) return; done(); resolve(ev.data); };
      const fail = (ev) => { done(); resolve({ error: ev.message || 'crash' }); };
      w.addEventListener('message', on);
      w.addEventListener('error', fail);
      w.postMessage({ id, file: blob, lib });
    });
    if (r.blob?.size) return r.blob;
    dropDwg(lib); // wasm이 망가졌을 수 있다: 이 판의 다음 파일은 새 워커로
  }
  return null;
}

function killWorkers() {
  dropCad();
  for (const lib of [...dwgWorkers.keys()]) dropDwg(lib);
  for (const w of [...waiting]) { waiting.delete(w); w.reject(STOP); }
}

// ---------------------------------------------------------------- 바꾼 도면 보관(디스크: 브라우저 전용 저장 공간, 없으면 메모리)
// 큰 도서는 바꾼 도면만 수 GB라 메모리에 쥘 수 없다. 내용 해시를 열쇠로 두어, 탭이 닫혀도 다시 놓으면 바꾸기를 건너뛴다.

const dxfCache = {
  dir: undefined,
  mem: new Map(),
  key: (sha) => `${String(sha).replace(/[^a-z0-9]/gi, '_')}.dxf`,
  async root() {
    if (this.dir === undefined) {
      try { this.dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('book-dxf', { create: true }); } catch { this.dir = null; }
    }
    return this.dir;
  },
  async get(sha) {
    const d = await this.root();
    if (d) { try { const f = await (await d.getFileHandle(this.key(sha))).getFile(); return f.size ? f : null; } catch { return null; } }
    return this.mem.get(sha) || null;
  },
  async put(sha, blob) {
    const d = await this.root();
    if (d) {
      try {
        const h = await d.getFileHandle(this.key(sha), { create: true });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        return await h.getFile();
      } catch { /* 공간이 모자라면 메모리 */ }
    }
    this.mem.set(sha, blob);
    return blob;
  },
  async clear() {
    this.mem.clear();
    const d = await this.root();
    if (!d) return;
    try { for await (const [name] of d.entries()) await d.removeEntry(name).catch(() => {}); } catch { /* 무시 */ }
  },
};

// 화면 확인 스크립트(tools/ui-check/book.mjs)가 진행을 읽는다
export const bookState = () => (job ? { phase: job.phase, done: job.units.done, total: job.units.total, files: job.files, filesDone: job.filesDone, open: job.open, setId: job.setId, steps: { ...job.steps } } : null);
export const bookNotice = () => notice;
