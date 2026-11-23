// 건축도서·AI 작업·BIM 모델 저장소. 브라우저 저장(데모, IndexedDB)과 공유(Supabase) 두 가지가 같은 비동기 API를 가진다.
//   store.drawings  도서 묶음·파일·시트(그림·요약·모양)
//   store.jobs      AI·규칙 작업(진행률·토큰·비용)
//   store.bim       모델 버전(JSON 파일 묶음)·검증 결과·수정 요청
//   store.ai        AI 설정·이번 달 사용액·Edge Function 호출(공유 모드만)
// 권한은 공유 모드에서 DB의 RLS가 최종 판단한다(supabase/schema.sql). 검증 규칙은 store.js의 validate() 한 곳.
import { validate, newId, clone } from './store.js';
import { upgradeFile } from './bim/upgrade.js';

export const BUCKETS = { originals: 'site-drawings', sheets: 'site-sheets', bim: 'site-bim', review: 'review-files' };
export const DEFAULT_AI = { enabled: false, keepOriginals: false, monthlyBudgetUsd: 50, model: 'claude-opus-5-5' };

export const sheetPaths = (siteId, setId, sheetId) => {
  const base = `${siteId}/${setId}/${sheetId}`;
  return { png: `${base}.png`, thumb: `${base}.thumb.png`, digest: `${base}.json`, geom: `${base}.geom.json`, geomGz: `${base}.geom.json.gz`, triage: `${base}.triage.json`, overlay: `${base}.triage.png`, tile: (n) => `${base}-t${n}.png` };
};
export const modelFolder = (siteId, modelId) => `${siteId}/${modelId}/`;
export const originalPath = (siteId, setId, fileId) => `${siteId}/${setId}/${fileId}.dxf`;

const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
const byCreatedDesc = (a, b) => -byCreated(a, b);
const sheetOrder = (a, b) => String(a.sheetNo || '~').localeCompare(String(b.sheetNo || '~'), 'ko', { numeric: true }) || byCreated(a, b);

// 부모 키별 목록 캐시(실시간 반영용)
function collection(parentKey, sort = byCreated) {
  const map = new Map();
  return {
    get: (p) => map.get(p),
    set(p, list) { map.set(p, [...list].sort(sort)); return map.get(p); },
    upsert(rec) {
      const list = map.get(rec[parentKey]);
      if (!list) return false;
      const i = list.findIndex((x) => x.id === rec.id);
      if (i >= 0) list[i] = rec; else list.push(rec);
      list.sort(sort);
      return true;
    },
    remove(id) { let hit = false; for (const [p, list] of map) { const n = list.filter((x) => x.id !== id); if (n.length !== list.length) { map.set(p, n); hit = true; } } return hit; },
    find(id) { for (const list of map.values()) { const r = list.find((x) => x.id === id); if (r) return r; } return null; },
    clear() { map.clear(); },
    keys: () => [...map.keys()],
  };
}

function caches() {
  return {
    sets: collection('siteId', byCreatedDesc),
    files: collection('setId'),
    sheets: collection('setId', sheetOrder),
    jobs: collection('setId'),
    models: collection('siteId', (a, b) => b.version - a.version),
    findings: collection('modelId', (a, b) => ({ error: 0, warn: 1, info: 2 }[a.severity] - { error: 0, warn: 1, info: 2 }[b.severity]) || byCreated(a, b)),
    reviews: collection('modelId', byCreatedDesc),
  };
}

const TABLE_CACHE = { drawing_sets: 'sets', drawing_files: 'files', drawing_sheets: 'sheets', analysis_jobs: 'jobs', bim_models: 'models', bim_findings: 'findings', bim_reviews: 'reviews' };
export const BIM_TABLES = Object.keys(TABLE_CACHE);

// 검증 결과를 다시 만들 때: 같은 종류·같은 문장이면 담당자가 정한 상태(해결·무시)를 이어받는다
function carryStatus(prev, next) {
  const key = (f) => `${f.kind}|${f.message}`;
  const kept = new Map(prev.filter((f) => f.status !== 'open').map((f) => [key(f), f]));
  return next.map((f) => { const p = kept.get(key(f)); return p ? { ...f, status: p.status, note: p.note || '' } : f; });
}

const toJsonBlob = (obj) => new Blob([JSON.stringify(obj)], { type: 'application/json' });
// 선 모양을 저장할 때 크기(풀었을 때 바이트)를 시트 통계에 함께 적는다 — 보기에서 선·그림을 고르는 데 쓴다(46 지시서 1.5)
const withGeomBytes = (input, bytes) => ({ ...input, stats: { ...(input.stats || {}), geomBytes: bytes } });

// 선 모양은 gzip으로 줄여 .geom.json.gz에 둔다(46 지시서 2절, 회사 도서 기준 약 9배). 저장 공간의 파일 종류 제한(그림·JSON)을
// 바꾸지 않으려고 종류 표시는 JSON 그대로 두고, 읽을 때 첫 두 바이트(1f 8b)로 gzip인지 알아본다.
export async function gzipJson(blob) {
  if (typeof CompressionStream === 'undefined') return null; // 아주 옛 브라우저: 옛 경로에 그대로
  const z = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return new Blob([z], { type: 'application/json' });
}
export async function blobJson(b) {
  if (typeof b === 'string') return JSON.parse(b);
  const head = new Uint8Array(await b.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) return JSON.parse(await new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).text());
  return JSON.parse(await b.text());
}
// 선 모양 읽기: gzip 경로를 먼저, 없으면 옛 .geom.json(옮기지 않은 기존 시트). 깨진 gzip은 오류 → 보기는 그림으로
async function readGeom(get, P) {
  let blob;
  try { blob = await get(P.geomGz); } catch { blob = await get(P.geom); }
  return blobJson(blob);
}

// ================================================================ 브라우저 저장(데모)

/**
 * @param {{ rowsDb: any, filesDb: any, now: () => Date, notify: () => void, sites: () => any[] }} deps
 */
export function createLocalBim({ rowsDb, filesDb, now, notify, sites }) {
  const C = caches();
  let rows = null; // 모든 행(메모리 사본). { _t: 표 이름, ...필드 }
  const urls = new Map(); // 파일 경로 → object URL
  const data = () => ({ sites: sites() });
  async function all() { rows ||= await rowsDb.all(); return rows; }
  async function put(t, rec) {
    const full = { ...rec, _t: t };
    await all();
    try { await rowsDb.put(full); } catch { throw new Error('브라우저 저장 공간이 부족해 저장하지 못했습니다.'); }
    const i = rows.findIndex((r) => r.id === rec.id);
    if (i >= 0) rows[i] = full; else rows.push(full);
    const c = C[TABLE_CACHE[t]];
    const clean = strip(full);
    c?.upsert(clean);
    notify();
    return clean;
  }
  const strip = ({ _t, ...r }) => r;
  async function del(ids) {
    if (!ids.length) return;
    await all();
    await rowsDb.del(ids);
    const set = new Set(ids);
    rows = rows.filter((r) => !set.has(r.id));
    for (const c of Object.values(C)) for (const id of ids) c.remove(id);
    notify();
  }
  async function list(t, pred) { return (await all()).filter((r) => r._t === t && pred(r)).map(strip); }
  async function putFile(path, blob) {
    try { await filesDb.put({ id: path, blob }); } catch { throw new Error('브라우저 저장 공간이 부족해 도면 그림을 저장하지 못했습니다.'); }
    if (urls.has(path)) { URL.revokeObjectURL?.(urls.get(path)); urls.delete(path); }
  }
  async function delFiles(prefix) {
    const files = await filesDb.all();
    const gone = files.filter((f) => f.id.startsWith(prefix)).map((f) => f.id);
    if (gone.length) await filesDb.del(gone);
    for (const p of gone) if (urls.has(p)) { URL.revokeObjectURL?.(urls.get(p)); urls.delete(p); }
  }
  async function getFile(path) {
    const rec = await filesDb.get(path);
    if (!rec?.blob) throw new Error('도면 파일을 찾지 못했습니다.');
    return rec.blob;
  }
  const stamp = () => now().toISOString();
  const touch = (rec, prev) => ({ ...prev, ...rec, createdAt: prev?.createdAt || stamp(), updatedAt: stamp(), updatedBy: 'local' });

  const drawings = {
    cached: (siteId) => C.sets.get(siteId) && clone(C.sets.get(siteId)),
    cachedFiles: (setId) => C.files.get(setId) && clone(C.files.get(setId)),
    cachedSheets: (setId) => C.sheets.get(setId) && clone(C.sheets.get(setId)),
    async sets(siteId) { const l = C.sets.set(siteId, await list('drawing_sets', (r) => r.siteId === siteId)); notify(); return clone(l); },
    async createSet(siteId, input) {
      const clean = validate('drawingSets', { ...input, siteId }, data());
      if (!C.sets.get(siteId)) await drawings.sets(siteId);
      return clone(await put('drawing_sets', touch({ id: newId('drawingSets'), ...clean })));
    },
    async updateSet(id, patch) {
      const prev = (await all()).find((r) => r.id === id && r._t === 'drawing_sets');
      if (!prev) throw new Error('도서 묶음을 찾을 수 없습니다.');
      const clean = validate('drawingSets', { ...strip(prev), ...patch }, data());
      return clone(await put('drawing_sets', touch({ id, ...clean }, strip(prev))));
    },
    async removeSet(id) {
      const r = await all();
      const set = r.find((x) => x.id === id);
      if (!set) return;
      const ids = r.filter((x) => x.id === id || x.setId === id).map((x) => x.id);
      await del(ids);
      await delFiles(`${set.siteId}/${id}/`);
    },
    async files(setId) { const l = C.files.set(setId, await list('drawing_files', (r) => r.setId === setId)); notify(); return clone(l); },
    async findBySha(siteId, sha256) { return clone((await list('drawing_files', (r) => r.siteId === siteId && r.sha256 === sha256))); },
    async addFile(setId, input, { original } = {}) {
      const set = (await all()).find((r) => r.id === setId && r._t === 'drawing_sets');
      if (!set) throw new Error('도서 묶음을 찾을 수 없습니다.');
      const clean = validate('drawingFiles', { ...input, setId }, data());
      const id = newId('drawingFiles');
      let path = null;
      if (original) { path = originalPath(set.siteId, setId, id); await putFile(path, original); }
      if (!C.files.get(setId)) await drawings.files(setId);
      return clone(await put('drawing_files', touch({ id, siteId: set.siteId, ...clean, path })));
    },
    async updateFile(id, patch) {
      const prev = (await all()).find((r) => r.id === id && r._t === 'drawing_files');
      if (!prev) throw new Error('도면 파일 정보를 찾을 수 없습니다.');
      const clean = validate('drawingFiles', { ...strip(prev), ...patch }, data());
      return clone(await put('drawing_files', touch({ id, siteId: prev.siteId, ...clean, path: prev.path }, strip(prev))));
    },
    async removeFile(id) {
      const r = await all();
      const f = r.find((x) => x.id === id);
      if (!f) return;
      const sheets = r.filter((x) => x._t === 'drawing_sheets' && x.fileId === id);
      for (const s of sheets) await delFiles(`${s.siteId}/${s.setId}/${s.id}`);
      if (f.path) await delFiles(f.path);
      await del([id, ...sheets.map((s) => s.id)]);
    },
    async originalUrl(file) {
      if (!file.path) throw new Error('원본 도면을 보관하지 않았습니다.');
      return URL.createObjectURL(await getFile(file.path));
    },
    async sheets(setId) { const l = C.sheets.set(setId, await list('drawing_sheets', (r) => r.setId === setId)); notify(); return clone(l); },
    // assets: { png, thumb, tiles: [{ n, blob }], digest, geom }
    async saveSheet(setId, input, assets = {}) {
      const set = (await all()).find((r) => r.id === setId && r._t === 'drawing_sets');
      if (!set) throw new Error('도서 묶음을 찾을 수 없습니다.');
      const id = input.id || newId('drawingSheets');
      const P = sheetPaths(set.siteId, setId, id);
      if (assets.png) await putFile(P.png, assets.png);
      if (assets.thumb) await putFile(P.thumb, assets.thumb);
      for (const t of assets.tiles || []) await putFile(P.tile(t.n), t.blob);
      if (assets.digest) await putFile(P.digest, toJsonBlob(assets.digest));
      if (assets.geom) {
        const g = toJsonBlob(assets.geom);
        const z = await gzipJson(g);
        input = withGeomBytes(input, g.size);
        await putFile(z ? P.geomGz : P.geom, z || g);
      }
      if (assets.triage) await putFile(P.triage, toJsonBlob(assets.triage));
      const clean = validate('drawingSheets', { ...input, setId, imagePath: assets.png ? P.png : input.imagePath || '', digestPath: assets.digest ? P.digest : input.digestPath || '' }, { ...data(), siteId: set.siteId });
      const prev = (await all()).find((r) => r.id === id);
      if (!C.sheets.get(setId)) await drawings.sheets(setId);
      return clone(await put('drawing_sheets', touch({ id, siteId: set.siteId, ...clean }, prev && strip(prev))));
    },
    async updateSheet(id, patch) {
      const prev = (await all()).find((r) => r.id === id && r._t === 'drawing_sheets');
      if (!prev) throw new Error('시트를 찾을 수 없습니다.');
      const clean = validate('drawingSheets', { ...strip(prev), ...patch }, { ...data(), siteId: prev.siteId });
      return clone(await put('drawing_sheets', touch({ id, siteId: prev.siteId, ...clean }, strip(prev))));
    },
    // 판별 결과 고치기·다시 저장(19 3-4절). 통계도 함께
    async saveTriage(sheet, triage) {
      const P = sheetPaths(sheet.siteId, sheet.setId, sheet.id);
      await putFile(P.triage, toJsonBlob(triage));
      return drawings.updateSheet(sheet.id, { stats: { ...(sheet.stats || {}), triage: triage.counts, passes: triage.passes || 0 } });
    },
    async saveOverlay(sheet, blob) {
      await putFile(sheetPaths(sheet.siteId, sheet.setId, sheet.id).overlay, blob);
    },
    // kind: 'png' | 'thumb' | 'tile:n' → 그림 주소, 'digest' | 'geom' | 'triage' → JSON(판별이 없는 옛 시트는 null)
    async sheetAsset(sheet, kind) {
      const P = sheetPaths(sheet.siteId, sheet.setId, sheet.id);
      if (kind === 'triage') return filesDb.get(P.triage).then((r) => (r?.blob ? blobJson(r.blob) : null));
      if (kind === 'geom') return readGeom(getFile, P);
      const path = kind === 'png' ? P.png : kind === 'thumb' ? P.thumb : kind === 'digest' ? P.digest : P.tile(Number(String(kind).split(':')[1]));
      const blob = await getFile(path);
      if (kind === 'digest') return blobJson(blob);
      if (kind === 'png-blob') return blob;
      if (!urls.has(path)) urls.set(path, URL.createObjectURL(blob));
      return urls.get(path);
    },
    async sheetBlob(sheet, kind = 'png') {
      const P = sheetPaths(sheet.siteId, sheet.setId, sheet.id);
      return getFile(kind === 'png' ? P.png : kind === 'thumb' ? P.thumb : P.tile(Number(String(kind).split(':')[1])));
    },
    // 작은 그림 주소 여러 장 한 번에(도면 목록). 시트 id → 주소, 없으면 ''
    async thumbUrls(sheets) {
      const out = new Map();
      await Promise.all(sheets.map(async (s) => out.set(s.id, await drawings.sheetAsset(s, 'thumb').catch(() => ''))));
      return out;
    },
  };

  const jobs = {
    cached: (setId) => C.jobs.get(setId) && clone(C.jobs.get(setId)),
    async list(siteId, { setId } = {}) {
      const l = await list('analysis_jobs', (r) => r.siteId === siteId && (!setId || r.setId === setId));
      if (setId) C.jobs.set(setId, l);
      notify();
      return clone(l);
    },
    async create(siteId, kind, target = {}, { setId = null } = {}) {
      const clean = validate('analysisJobs', { siteId, kind, target, setId }, data());
      return clone(await put('analysis_jobs', touch({ id: newId('analysisJobs'), ...clean, status: 'queued', progress: 0, attempts: 0, result: {}, error: '', tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, model: '' })));
    },
    async update(id, patch) {
      const prev = (await all()).find((r) => r.id === id && r._t === 'analysis_jobs');
      if (!prev) throw new Error('작업을 찾을 수 없습니다.');
      const clean = validate('analysisJobPatch', patch, data());
      return clone(await put('analysis_jobs', touch({ ...strip(prev), ...clean }, strip(prev))));
    },
  };

  const parts = new Map(); // 모델 파일 경로 → JSON
  const bim = {
    cachedVersions: (siteId) => C.models.get(siteId) && clone(C.models.get(siteId)),
    cachedFindings: (modelId) => C.findings.get(modelId) && clone(C.findings.get(modelId)),
    cachedReviews: (modelId) => C.reviews.get(modelId) && clone(C.reviews.get(modelId)),
    async versions(siteId) { const l = C.models.set(siteId, await list('bim_models', (r) => r.siteId === siteId)); notify(); return clone(l); },
    // files: { 'index.json': {...}, 'site.json': {...}, 'b-bd_101.json': {...}, … }
    async save(siteId, files, { setId = null, parentId = null, note = '', summary = {} } = {}) {
      if (!sites().some((s) => s.id === siteId)) throw new Error('현장을 찾을 수 없습니다.');
      const versions = await list('bim_models', (r) => r.siteId === siteId);
      const version = Math.max(0, ...versions.map((v) => v.version)) + 1;
      const id = newId('bimModels');
      const folder = modelFolder(siteId, id);
      const clean = validate('bimModels', { siteId, setId, parentId, note, summary, version, files }, data());
      for (const [name, obj] of Object.entries(files)) {
        const body = name === 'index.json' ? { ...obj, modelId: id, version, siteId } : obj;
        await putFile(folder + name, toJsonBlob(body));
        parts.set(folder + name, body);
      }
      if (!C.models.get(siteId)) await bim.versions(siteId);
      const parentStats = parentId ? versions.find((x) => x.id === parentId)?.stats : null;
      return clone(await put('bim_models', touch({ id, ...clean, version, path: folder, status: 'draft', name: `v${version}`, approvedBy: null, approvedAt: null, stats: parentStats?.views ? { views: parentStats.views } : {} })));
    },
    async load(model, name) {
      const path = model.path + name;
      if (!parts.has(path)) parts.set(path, await blobJson(await getFile(path)));
      return upgradeFile(name, clone(parts.get(path)));
    },
    // 저장한 보기(22 지시서 4절)
    async saveViews(modelId, views) {
      const r = await all();
      const m = r.find((x) => x.id === modelId && x._t === 'bim_models');
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      const stats = validate('bimModelStats', { ...(m.stats || {}), views }, data());
      return clone(await put('bim_models', touch({ ...strip(m), stats }, strip(m))));
    },
    // 수량 요약(23 지시서 3절): 공종·단위별 합계와 추정 비율. 원본 수량은 모델 파일에서 언제든 다시 계산한다
    async saveTakeoff(modelId, takeoff) {
      const r = await all();
      const m = r.find((x) => x.id === modelId && x._t === 'bim_models');
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      const stats = validate('bimModelStats', { ...(m.stats || {}), takeoff }, data());
      return clone(await put('bim_models', touch({ ...strip(m), stats }, strip(m))));
    },
    async approve(modelId) {
      const r = await all();
      const m = r.find((x) => x.id === modelId && x._t === 'bim_models');
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      for (const o of r.filter((x) => x._t === 'bim_models' && x.siteId === m.siteId && x.status === 'approved' && x.id !== modelId)) await put('bim_models', touch({ ...strip(o), status: 'superseded' }, strip(o)));
      return clone(await put('bim_models', touch({ ...strip(m), status: 'approved', approvedBy: 'local', approvedAt: stamp() }, strip(m))));
    },
    async remove(modelId) {
      const r = await all();
      const m = r.find((x) => x.id === modelId);
      if (!m) return;
      await del(r.filter((x) => x.id === modelId || x.modelId === modelId).map((x) => x.id));
      await delFiles(m.path);
    },
    async findings(modelId) { const l = C.findings.set(modelId, await list('bim_findings', (r) => r.modelId === modelId)); notify(); return clone(l); },
    // 같은 출처(rule/ai)의 결과를 새로 바꿔 넣는다(해결·무시 상태는 이어받음)
    async saveFindings(modelId, items, { source = 'rule' } = {}) {
      const m = (await all()).find((x) => x.id === modelId && x._t === 'bim_models');
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      const prev = await list('bim_findings', (r) => r.modelId === modelId && r.source === source);
      const clean = carryStatus(prev, items.map((f) => validate('bimFindings', { ...f, source }, data())));
      if (!C.findings.get(modelId)) await bim.findings(modelId);
      await del(prev.map((p) => p.id));
      const out = [];
      for (const f of clean) out.push(await put('bim_findings', touch({ id: newId('bimFindings'), siteId: m.siteId, modelId, setId: m.setId, status: 'open', note: '', resolvedBy: null, ...f })));
      return clone(out);
    },
    async setFinding(id, status, note = '') {
      const prev = (await all()).find((r) => r.id === id && r._t === 'bim_findings');
      if (!prev) throw new Error('검증 결과를 찾을 수 없습니다.');
      const clean = validate('bimFindingStatus', { status, note }, data());
      return clone(await put('bim_findings', touch({ ...strip(prev), ...clean, resolvedBy: clean.status === 'open' ? null : 'local' }, strip(prev))));
    },
    async reviews(modelId) { const l = C.reviews.set(modelId, await list('bim_reviews', (r) => r.modelId === modelId)); notify(); return clone(l); },
    async createReview(input) {
      const m = (await all()).find((x) => x.id === input.modelId && x._t === 'bim_models');
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      const clean = validate('bimReviews', input, data());
      if (!C.reviews.get(m.id)) await bim.reviews(m.id);
      return clone(await put('bim_reviews', touch({ id: newId('bimReviews'), siteId: m.siteId, ...clean, status: 'open', proposal: null, resultModelId: null })));
    },
    async updateReview(id, patch) {
      const prev = (await all()).find((r) => r.id === id && r._t === 'bim_reviews');
      if (!prev) throw new Error('수정 요청을 찾을 수 없습니다.');
      const clean = validate('bimReviewPatch', patch, data());
      return clone(await put('bim_reviews', touch({ ...strip(prev), ...clean }, strip(prev))));
    },
    async uploadReviewFile(siteId, file) {
      const path = `${siteId}/rf/${newId('reviewFiles')}-${String(file.name || 'file').replace(/[^\w.가-힣-]+/g, '_').slice(-80)}`;
      await putFile(path, file);
      return { path, name: file.name || '', type: file.type || '', size: file.size || 0 };
    },
    async reviewFile(path) { return getFile(path); },
  };

  const ai = {
    available: false,
    async settings() { return { ...DEFAULT_AI, scope: 'local' }; },
    async saveSettings() { throw new Error('AI 설정은 공유 모드에서 운영자만 바꿀 수 있습니다.'); },
    async spent() { return 0; },
    async call() { throw new Error('AI 판독은 공유 모드(로그인)에서만 쓸 수 있습니다. 지금은 규칙으로 읽은 결과만 씁니다.'); },
  };

  // 현장이 없어진 도서·모델 정리(현장 삭제·전체 삭제 뒤)
  async function prune(liveSiteIds) {
    try {
      const r = await all();
      const gone = r.filter((x) => x.siteId && !liveSiteIds.has(x.siteId));
      if (!gone.length) return;
      await del(gone.map((x) => x.id));
      for (const siteId of new Set(gone.map((x) => x.siteId))) await delFiles(`${siteId}/`);
    } catch { /* 다음에 다시 정리 */ }
  }

  return { drawings, jobs, bim, ai, prune, _caches: C };
}

// ================================================================ 공유(Supabase)

/**
 * @param {{ sb: any, notify: () => void, data: () => any, guardOnline: () => void, friendlyError: (e: any) => Error, storageError: (e: any) => Error, me: () => any }} deps
 */
export function createRemoteBim({ sb, notify, data, guardOnline, friendlyError, storageError, me }) {
  const C = caches();
  const signed = new Map();
  const parts = new Map();
  const jsonCache = new Map();

  async function q(promise) {
    const { data: d, error } = await promise;
    if (error) throw friendlyError(error);
    return d;
  }
  async function upload(bucket, path, blob, contentType) {
    const up = await sb.storage.from(bucket).upload(path, blob, { contentType, upsert: true, cacheControl: '3600' });
    if (up.error) throw storageError(up.error);
  }
  async function removePrefix(bucket, prefix) {
    try {
      const folder = prefix.replace(/\/$/, '');
      const { data: list } = await sb.storage.from(bucket).list(folder, { limit: 1000 });
      const paths = (list || []).filter((f) => f.name).map((f) => `${folder}/${f.name}`);
      if (paths.length) await sb.storage.from(bucket).remove(paths);
    } catch { /* 남은 파일은 운영자가 정리 */ }
  }
  async function download(bucket, path) {
    const { data: blob, error } = await sb.storage.from(bucket).download(path);
    if (error) throw storageError(error);
    return blob;
  }
  async function signedUrl(bucket, path) {
    const key = `${bucket}/${path}`;
    const hit = signed.get(key);
    if (hit && hit.until > Date.now()) return hit.url;
    const { data: d, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
    if (error) throw storageError(error);
    signed.set(key, { url: d.signedUrl, until: Date.now() + 50 * 60000 });
    return d.signedUrl;
  }

  const one = (t, id) => q(sb.from(t).select('*').eq('id', id).maybeSingle());

  const drawings = {
    cached: (siteId) => C.sets.get(siteId) && clone(C.sets.get(siteId)),
    cachedFiles: (setId) => C.files.get(setId) && clone(C.files.get(setId)),
    cachedSheets: (setId) => C.sheets.get(setId) && clone(C.sheets.get(setId)),
    async sets(siteId) { const l = C.sets.set(siteId, await q(sb.from('drawing_sets').select('*').eq('siteId', siteId))); notify(); return clone(l); },
    async createSet(siteId, input) {
      guardOnline();
      const clean = validate('drawingSets', { ...input, siteId }, data());
      const rec = await q(sb.from('drawing_sets').insert({ id: newId('drawingSets'), ...clean }).select().single());
      if (!C.sets.get(siteId)) await drawings.sets(siteId);
      C.sets.upsert(rec); notify();
      return clone(rec);
    },
    async updateSet(id, patch) {
      guardOnline();
      const prev = C.sets.find(id) || await one('drawing_sets', id);
      const clean = validate('drawingSets', { ...prev, ...patch }, data());
      const { siteId, ...row } = clean;
      const rec = await q(sb.from('drawing_sets').update(row).eq('id', id).select().single());
      C.sets.upsert(rec); notify();
      return clone(rec);
    },
    async removeSet(id) {
      guardOnline();
      const prev = C.sets.find(id) || await one('drawing_sets', id);
      if (!prev) return;
      const gone = await q(sb.from('drawing_sets').delete().eq('id', id).select('id'));
      if (!gone?.length) throw friendlyError({ code: '42501' });
      await removePrefix(BUCKETS.sheets, `${prev.siteId}/${id}/`);
      await removePrefix(BUCKETS.originals, `${prev.siteId}/${id}/`);
      C.sets.remove(id); notify();
    },
    async files(setId) { const l = C.files.set(setId, await q(sb.from('drawing_files').select('*').eq('setId', setId))); notify(); return clone(l); },
    async findBySha(siteId, sha256) { return q(sb.from('drawing_files').select('*').eq('siteId', siteId).eq('sha256', sha256)); },
    async addFile(setId, input, { original } = {}) {
      guardOnline();
      const set = C.sets.find(setId) || await one('drawing_sets', setId);
      if (!set) throw new Error('도서 묶음을 찾을 수 없습니다.');
      const clean = validate('drawingFiles', { ...input, setId }, data());
      const id = newId('drawingFiles');
      let path = null;
      if (original) {
        path = originalPath(set.siteId, setId, id);
        await upload(BUCKETS.originals, path, original, 'application/octet-stream');
      }
      const rec = await q(sb.from('drawing_files').insert({ id, siteId: set.siteId, ...clean, path }).select().single());
      if (!C.files.get(setId)) await drawings.files(setId);
      C.files.upsert(rec); notify();
      return clone(rec);
    },
    async updateFile(id, patch) {
      guardOnline();
      const prev = C.files.find(id) || await one('drawing_files', id);
      const clean = validate('drawingFiles', { ...prev, ...patch }, data());
      const rec = await q(sb.from('drawing_files').update(clean).eq('id', id).select().single());
      C.files.upsert(rec); notify();
      return clone(rec);
    },
    async removeFile(id) {
      guardOnline();
      const prev = C.files.find(id) || await one('drawing_files', id);
      if (!prev) return;
      const sheets = await q(sb.from('drawing_sheets').select('id, siteId, setId').eq('fileId', id));
      await q(sb.from('drawing_files').delete().eq('id', id).select('id'));
      const paths = sheets.flatMap((s) => { const P = sheetPaths(s.siteId, s.setId, s.id); return [P.png, P.thumb, P.digest, P.geom, P.geomGz, P.triage, P.overlay, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map(P.tile)]; });
      try { if (paths.length) await sb.storage.from(BUCKETS.sheets).remove(paths); if (prev.path) await sb.storage.from(BUCKETS.originals).remove([prev.path]); } catch { /* 무시 */ }
      C.files.remove(id);
      for (const s of sheets) C.sheets.remove(s.id);
      notify();
    },
    async originalUrl(file) {
      if (!file.path) throw new Error('원본 도면을 보관하지 않았습니다.');
      return signedUrl(BUCKETS.originals, file.path);
    },
    async sheets(setId) {
      const l = C.sheets.set(setId, await q(sb.from('drawing_sheets').select('*').eq('setId', setId).range(0, 1999)));
      notify();
      return clone(l);
    },
    async saveSheet(setId, input, assets = {}) {
      guardOnline();
      const set = C.sets.find(setId) || await one('drawing_sets', setId);
      if (!set) throw new Error('도서 묶음을 찾을 수 없습니다.');
      const id = input.id || newId('drawingSheets');
      const P = sheetPaths(set.siteId, setId, id);
      const ups = [];
      if (assets.png) ups.push(upload(BUCKETS.sheets, P.png, assets.png, 'image/png'));
      if (assets.thumb) ups.push(upload(BUCKETS.sheets, P.thumb, assets.thumb, 'image/png'));
      for (const t of assets.tiles || []) ups.push(upload(BUCKETS.sheets, P.tile(t.n), t.blob, 'image/png'));
      if (assets.digest) ups.push(upload(BUCKETS.sheets, P.digest, toJsonBlob(assets.digest), 'application/json'));
      if (assets.geom) {
        const g = toJsonBlob(assets.geom);
        const z = await gzipJson(g);
        input = withGeomBytes(input, g.size);
        ups.push(upload(BUCKETS.sheets, z ? P.geomGz : P.geom, z || g, 'application/json'));
      }
      if (assets.triage) ups.push(upload(BUCKETS.sheets, P.triage, toJsonBlob(assets.triage), 'application/json'));
      await Promise.all(ups);
      if (assets.digest) jsonCache.set(P.digest, assets.digest);
      if (assets.geom) jsonCache.set(P.geom, assets.geom);
      if (assets.triage) jsonCache.set(P.triage, assets.triage);
      const clean = validate('drawingSheets', { ...input, setId, imagePath: assets.png ? P.png : input.imagePath || '', digestPath: assets.digest ? P.digest : input.digestPath || '' }, { ...data(), siteId: set.siteId });
      const rec = await q(sb.from('drawing_sheets').upsert({ id, siteId: set.siteId, ...clean }).select().single());
      if (!C.sheets.get(setId)) await drawings.sheets(setId);
      C.sheets.upsert(rec); notify();
      return clone(rec);
    },
    async updateSheet(id, patch) {
      guardOnline();
      const prev = C.sheets.find(id) || await one('drawing_sheets', id);
      if (!prev) throw new Error('시트를 찾을 수 없습니다.');
      const clean = validate('drawingSheets', { ...prev, ...patch }, { ...data(), siteId: prev.siteId });
      const rec = await q(sb.from('drawing_sheets').update(clean).eq('id', id).select().single());
      C.sheets.upsert(rec); notify();
      return clone(rec);
    },
    async saveTriage(sheet, triage) {
      guardOnline();
      const P = sheetPaths(sheet.siteId, sheet.setId, sheet.id);
      await upload(BUCKETS.sheets, P.triage, toJsonBlob(triage), 'application/json');
      jsonCache.set(P.triage, triage);
      return drawings.updateSheet(sheet.id, { stats: { ...(sheet.stats || {}), triage: triage.counts, passes: triage.passes || 0 } });
    },
    async saveOverlay(sheet, blob) {
      guardOnline();
      await upload(BUCKETS.sheets, sheetPaths(sheet.siteId, sheet.setId, sheet.id).overlay, blob, 'image/png');
    },
    async sheetAsset(sheet, kind, { fresh = false } = {}) {
      const P = sheetPaths(sheet.siteId, sheet.setId, sheet.id);
      if (kind === 'triage') {
        if (!fresh && jsonCache.has(P.triage)) return jsonCache.get(P.triage);
        const t = await blobJson(await download(BUCKETS.sheets, P.triage)).catch(() => null); // 판별이 없는 옛 시트
        if (t) jsonCache.set(P.triage, t);
        return t;
      }
      if (kind === 'digest' || kind === 'geom') {
        const path = kind === 'digest' ? P.digest : P.geom;
        if (!jsonCache.has(path)) jsonCache.set(path, kind === 'geom' ? await readGeom((x) => download(BUCKETS.sheets, x), P) : await blobJson(await download(BUCKETS.sheets, path)));
        return jsonCache.get(path);
      }
      const path = kind === 'png' ? P.png : kind === 'thumb' ? P.thumb : P.tile(Number(String(kind).split(':')[1]));
      return signedUrl(BUCKETS.sheets, path);
    },
    async sheetBlob(sheet, kind = 'png') {
      const P = sheetPaths(sheet.siteId, sheet.setId, sheet.id);
      return download(BUCKETS.sheets, kind === 'png' ? P.png : kind === 'thumb' ? P.thumb : P.tile(Number(String(kind).split(':')[1])));
    },
    // 작은 그림 주소 여러 장을 요청 한 번에(createSignedUrls). 시트 id → 주소, 없으면 ''. 받은 주소는 50분 기억
    async thumbUrls(sheets) {
      const out = new Map();
      const want = [];
      for (const s of sheets) {
        const path = sheetPaths(s.siteId, s.setId, s.id).thumb;
        const hit = signed.get(`${BUCKETS.sheets}/${path}`);
        if (hit && hit.until > Date.now()) out.set(s.id, hit.url); else want.push([s.id, path]);
      }
      if (!want.length) return out;
      const api = sb.storage.from(BUCKETS.sheets);
      if (typeof api.createSignedUrls !== 'function') {
        await Promise.all(want.map(async ([id, path]) => out.set(id, await signedUrl(BUCKETS.sheets, path).catch(() => ''))));
        return out;
      }
      const { data: list, error } = await api.createSignedUrls(want.map(([, path]) => path), 3600);
      if (error) throw storageError(error);
      want.forEach(([id, path], i) => {
        const d = (list || [])[i];
        const url = d && !d.error && (d.path == null || d.path === path) ? d.signedUrl : '';
        if (url) signed.set(`${BUCKETS.sheets}/${path}`, { url, until: Date.now() + 50 * 60000 });
        out.set(id, url || '');
      });
      return out;
    },
  };

  const jobs = {
    cached: (setId) => C.jobs.get(setId) && clone(C.jobs.get(setId)),
    async list(siteId, { setId } = {}) {
      let query = sb.from('analysis_jobs').select('*').eq('siteId', siteId);
      if (setId) query = query.eq('setId', setId);
      const l = await q(query.order('createdAt').range(0, 4999));
      if (setId) C.jobs.set(setId, l);
      notify();
      return clone(l);
    },
    async create(siteId, kind, target = {}, { setId = null } = {}) {
      guardOnline();
      const clean = validate('analysisJobs', { siteId, kind, target, setId }, data());
      const rec = await q(sb.from('analysis_jobs').insert({ id: newId('analysisJobs'), ...clean, status: 'queued', progress: 0, attempts: 0 }).select().single());
      C.jobs.upsert(rec); notify();
      return clone(rec);
    },
    async update(id, patch) {
      guardOnline();
      const clean = validate('analysisJobPatch', patch, data());
      const rec = await q(sb.from('analysis_jobs').update(clean).eq('id', id).select().single());
      C.jobs.upsert(rec); notify();
      return clone(rec);
    },
  };

  const bim = {
    cachedVersions: (siteId) => C.models.get(siteId) && clone(C.models.get(siteId)),
    cachedFindings: (modelId) => C.findings.get(modelId) && clone(C.findings.get(modelId)),
    cachedReviews: (modelId) => C.reviews.get(modelId) && clone(C.reviews.get(modelId)),
    async versions(siteId) { const l = C.models.set(siteId, await q(sb.from('bim_models').select('*').eq('siteId', siteId))); notify(); return clone(l); },
    async save(siteId, files, { setId = null, parentId = null, note = '', summary = {} } = {}) {
      guardOnline();
      const clean = validate('bimModels', { siteId, setId, parentId, note, summary, version: 1, files }, data());
      for (let attempt = 0; attempt < 3; attempt++) {
        const last = await q(sb.from('bim_models').select('version').eq('siteId', siteId).order('version', { ascending: false }).limit(1));
        const version = (last?.[0]?.version || 0) + 1;
        const id = newId('bimModels');
        const folder = modelFolder(siteId, id);
        await Promise.all(Object.entries(files).map(([name, obj]) => {
          const body = name === 'index.json' ? { ...obj, modelId: id, version, siteId } : obj;
          parts.set(folder + name, body);
          return upload(BUCKETS.bim, folder + name, toJsonBlob(body), 'application/json');
        }));
        const parent = clean.parentId ? C.models.find(clean.parentId) : null;
        const { data: rec, error } = await sb.from('bim_models').insert({ id, siteId, setId: clean.setId, parentId: clean.parentId, note: clean.note, summary: clean.summary, version, path: folder, ...(parent?.stats?.views ? { stats: { views: parent.stats.views } } : {}) }).select().single();
        if (!error) { if (!C.models.get(siteId)) await bim.versions(siteId); C.models.upsert(rec); notify(); return clone(rec); }
        await removePrefix(BUCKETS.bim, folder);
        if (error.code !== '23505') throw friendlyError(error); // 같은 번호를 다른 사람이 먼저 썼으면 다시
      }
      throw new Error('모델 버전 번호가 겹쳐 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
    },
    async load(model, name) {
      const path = model.path + name;
      if (!parts.has(path)) parts.set(path, await blobJson(await download(BUCKETS.bim, path)));
      return upgradeFile(name, clone(parts.get(path)));
    },
    async saveViews(modelId, views) {
      guardOnline();
      const m = C.models.find(modelId) || await one('bim_models', modelId);
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      const stats = validate('bimModelStats', { ...(m.stats || {}), views }, data());
      const rec = await q(sb.from('bim_models').update({ stats }).eq('id', modelId).select().single());
      C.models.upsert(rec); notify();
      return clone(rec);
    },
    async saveTakeoff(modelId, takeoff) {
      guardOnline();
      const m = C.models.find(modelId) || await one('bim_models', modelId);
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      const stats = validate('bimModelStats', { ...(m.stats || {}), takeoff }, data());
      const rec = await q(sb.from('bim_models').update({ stats }).eq('id', modelId).select().single());
      C.models.upsert(rec); notify();
      return clone(rec);
    },
    async approve(modelId) {
      guardOnline();
      const rec = await q(sb.rpc('approve_bim_model', { mid: modelId }));
      const m = Array.isArray(rec) ? rec[0] : rec;
      await bim.versions(m.siteId);
      return clone(m);
    },
    async remove(modelId) {
      guardOnline();
      const prev = C.models.find(modelId) || await one('bim_models', modelId);
      if (!prev) return;
      await q(sb.from('bim_models').delete().eq('id', modelId).select('id'));
      await removePrefix(BUCKETS.bim, prev.path);
      C.models.remove(modelId); notify();
    },
    async findings(modelId) { const l = C.findings.set(modelId, await q(sb.from('bim_findings').select('*').eq('modelId', modelId).range(0, 4999))); notify(); return clone(l); },
    async saveFindings(modelId, items, { source = 'rule' } = {}) {
      guardOnline();
      const m = C.models.find(modelId) || await one('bim_models', modelId);
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      const prev = await q(sb.from('bim_findings').select('*').eq('modelId', modelId).eq('source', source));
      const clean = carryStatus(prev, items.map((f) => validate('bimFindings', { ...f, source }, data())));
      await q(sb.from('bim_findings').delete().eq('modelId', modelId).eq('source', source).select('id'));
      const rows = clean.map((f) => ({ id: newId('bimFindings'), siteId: m.siteId, modelId, setId: m.setId, status: 'open', note: '', ...f }));
      const out = [];
      for (let i = 0; i < rows.length; i += 500) out.push(...await q(sb.from('bim_findings').insert(rows.slice(i, i + 500)).select()));
      await bim.findings(modelId);
      return clone(out);
    },
    async setFinding(id, status, note = '') {
      guardOnline();
      const clean = validate('bimFindingStatus', { status, note }, data());
      const rec = await q(sb.from('bim_findings').update({ ...clean, resolvedBy: clean.status === 'open' ? null : me()?.id || null }).eq('id', id).select().single());
      C.findings.upsert(rec); notify();
      return clone(rec);
    },
    async reviews(modelId) { const l = C.reviews.set(modelId, await q(sb.from('bim_reviews').select('*').eq('modelId', modelId))); notify(); return clone(l); },
    async createReview(input) {
      guardOnline();
      const m = C.models.find(input.modelId) || await one('bim_models', input.modelId);
      if (!m) throw new Error('모델 버전을 찾을 수 없습니다.');
      const clean = validate('bimReviews', input, data());
      const rec = await q(sb.from('bim_reviews').insert({ id: newId('bimReviews'), siteId: m.siteId, ...clean, status: 'open' }).select().single());
      if (!C.reviews.get(m.id)) await bim.reviews(m.id);
      C.reviews.upsert(rec); notify();
      return clone(rec);
    },
    async updateReview(id, patch) {
      guardOnline();
      const clean = validate('bimReviewPatch', patch, data());
      const rec = await q(sb.from('bim_reviews').update(clean).eq('id', id).select().single());
      C.reviews.upsert(rec); notify();
      return clone(rec);
    },
    async uploadReviewFile(siteId, file) {
      guardOnline();
      const path = `${siteId}/rf/${newId('reviewFiles')}-${String(file.name || 'file').replace(/[^\w.가-힣-]+/g, '_').slice(-80)}`;
      await upload(BUCKETS.review, path, file, file.type || 'application/octet-stream');
      return { path, name: file.name || '', type: file.type || '', size: file.size || 0 };
    },
    async reviewFile(path) { return download(BUCKETS.review, path); },
  };

  let aiCache = null;
  const ai = {
    get available() { return Boolean(aiCache?.enabled); },
    async settings(siteId) {
      const rows = await q(sb.from('ai_settings').select('*').in('id', siteId ? ['global', siteId] : ['global']));
      const site = rows.find((r) => r.id === siteId);
      const g = rows.find((r) => r.id === 'global');
      aiCache = { ...DEFAULT_AI, ...(g || {}), ...(site || {}), monthlyBudgetUsd: Number((site || g || DEFAULT_AI).monthlyBudgetUsd), scope: site ? 'site' : 'global' };
      notify();
      return clone(aiCache);
    },
    async saveSettings(patch, id = 'global') {
      guardOnline();
      const clean = validate('aiSettings', patch, data());
      const rec = await q(sb.from('ai_settings').upsert({ id, ...clean }).select().single());
      aiCache = null;
      return clone(rec);
    },
    async spent(siteId) {
      const v = await q(sb.rpc('ai_spent_this_month', siteId ? { sid: siteId } : {}));
      return Number(v) || 0;
    },
    // Edge Function 호출. 함수가 보낸 오류 문장(error)을 그대로 보여준다.
    async call(kind, body) {
      guardOnline();
      const { data: d, error } = await sb.functions.invoke(kind, { body });
      if (error) {
        let msg = '';
        try { const j = await error.context?.json?.(); msg = j?.error || ''; } catch { /* 무시 */ }
        if (!msg && /Failed to send|fetch/i.test(String(error.message))) msg = 'AI 서버에 연결할 수 없습니다. AI 기능(Edge Function)이 아직 배포되지 않았을 수 있습니다.';
        throw new Error(msg || String(error.message || 'AI 호출에 실패했습니다.'));
      }
      if (d?.error) throw new Error(d.error);
      return d;
    },
  };

  // 실시간 변경 반영(열어 본 묶음·모델만)
  function applyRealtime(table, payload) {
    const c = C[TABLE_CACHE[table]];
    if (!c) return;
    if (payload.eventType === 'DELETE') { if (payload.old?.id && c.remove(payload.old.id)) notify(); return; }
    if (payload.new && c.upsert(payload.new)) notify();
  }

  function reset() { for (const c of Object.values(C)) c.clear(); parts.clear(); jsonCache.clear(); aiCache = null; }

  return { drawings, jobs, bim, ai, applyRealtime, reset, _caches: C };
}
