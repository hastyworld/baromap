// 도면 읽기 워커(Web Worker, type: module): 파일 받기 → 진행률 → 시트마다 그림(PNG)·조각·미리보기·요약·모양을 돌려준다.
// 메시지: { type: 'scan', id, file, name } → { type: 'scanned', id, keys } (외부 참조 이름만 훑기)
//         { type: 'refs', files: [{ key, file | src, name }] } (이번 묶음의 참조 후보 파일들, src는 zip 항목 자리)
//         { type: 'read', id, file: Blob, name }
//   → { type: 'progress', id, phase: 'hash'|'read'|'sheets', done, total }
//   → { type: 'file', id, sha256, stats }
//   → { type: 'sheet', id, index, sheet: { key, method, frame, titleBlock, rule, layoutName }, png, thumb, tiles: [{ n, grid, region, blob }], digest, geom, image: { width, height } }
//   → { type: 'done', id, sheets } / { type: 'error', id, message }
import { parseBlob, sheetsOf, scanXrefs } from './read.js';
import { dwgToDxf, DWG_LIBS } from './dwg.js';
import { bindXrefs, isRefLikeFile } from './xref.js';
import { openSrc } from './unzip.js';
import { renderPng, renderTiles, ensureFont, canRender, THUMB_SIDE } from './render.js';

const post = (msg) => self.postMessage(msg);

async function sha256(blob) {
  // 150MB까지는 전체, 그보다 크면 앞·뒤 4MB + 크기(같은 파일 다시 올리기 감지용)
  const full = blob.size <= 150 * 1024 * 1024;
  const buf = full ? await blob.arrayBuffer() : await new Blob([String(blob.size), blob.slice(0, 4 << 20), blob.slice(-(4 << 20))]).arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return `${full ? '' : 'p:'}${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// DWG는 DXF로 바꾼 뒤 같은 길로. 바꾼 결과는 이번 묶음 동안 기억한다(훑기·참조·읽기에서 한 번만 바꾸게, 400MB까지)
const converted = new Map();
let convertedBytes = 0;
async function toDxf(file, name) {
  if (!/\.dwg$/i.test(name)) return file;
  const k = `${name}|${file.size}`;
  if (converted.has(k)) return converted.get(k);
  // 변환기 두 판: 먼저 쓰는 판이 못 바꾸면 다른 판으로 한 번 더(44 지시서 3.6)
  let out = null;
  for (const lib of DWG_LIBS) {
    try { out = await dwgToDxf(file, { lib }); break; } catch (err) { if (lib === DWG_LIBS[DWG_LIBS.length - 1]) throw err; }
  }
  if (out.size < 120e6) {
    while (convertedBytes + out.size > 400e6 && converted.size) { const [k0, b0] = converted.entries().next().value; converted.delete(k0); convertedBytes -= b0.size; }
    converted.set(k, out);
    convertedBytes += out.size;
  }
  return out;
}

// 외부 참조: 이번 묶음의 파일을 열쇠로 찾아 해석(원본 100MB어치까지 기억 — 해석하면 8~10배로 커진다)
let refs = new Map();
const parsed = new Map();
let parsedBytes = 0;
async function loadRef(key) {
  const r = refs.get(key);
  if (!r) return null;
  if (parsed.has(key)) return parsed.get(key);
  const file = r.file || await openSrc(r.src);
  const dxf = await parseBlob(await toDxf(file, r.name));
  const size = file.size;
  while (parsedBytes + size > 100e6 && parsed.size) { const [k0] = parsed.keys(); parsedBytes -= parsed.get(k0).__size || 0; parsed.delete(k0); }
  dxf.__size = size;
  parsed.set(key, dxf);
  parsedBytes += size;
  return dxf;
}

// 파일은 Blob(file)이나 원본 자리(src: zip 항목 — 워커가 꺼낸다, 44 지시서 3.3)로 받는다
async function scan({ id, file, src, name }) {
  file ||= await openSrc(src);
  const keys = await scanXrefs(await toDxf(file, name));
  post({ type: 'scanned', id, keys });
}

async function read({ id, file, src, name, triageProfile = {}, deadline = 0 }) {
  file ||= await openSrc(src);
  post({ type: 'progress', id, phase: 'hash', done: 0, total: file.size });
  const hash = await sha256(file);
  const dxfBlob = await toDxf(file, name);
  const dxf = await parseBlob(dxfBlob, { onProgress: (done, total) => post({ type: 'progress', id, phase: 'read', done, total }) });
  const xref = await bindXrefs(dxf, loadRef);
  const parts = sheetsOf(dxf, { fileName: name, triageProfile, deadline });
  const { stats } = parts;
  let { sheets } = parts;
  stats.xref = { bound: xref.bound.length, missing: xref.missing.slice(0, 50) };
  // 묶음으로 올렸는데 도곽·도면번호·도면명이 없는 참조용 파일은 시트로 만들지 않는다
  if (refs.size > 1 && isRefLikeFile(name, sheets)) { stats.xrefOnly = true; stats.sheets = 0; sheets = []; }
  post({ type: 'file', id, sha256: hash, stats });
  if (canRender()) await ensureFont();
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    post({ type: 'progress', id, phase: 'sheets', done: i, total: sheets.length });
    let png = null;
    let thumb = null;
    let tiles = [];
    let image = null;
    if (canRender()) {
      const full = await renderPng(s.flat.items, s.frame);
      png = full.blob;
      image = { width: full.width, height: full.height };
      thumb = (await renderPng(s.flat.items, s.frame, { maxSide: THUMB_SIDE })).blob;
      tiles = await renderTiles(s.flat.items, s.frame);
    }
    post({
      type: 'sheet', id, index: i,
      sheet: { key: s.key, method: s.method, space: s.space, layoutName: s.layoutName, frame: s.frame, titleBlock: s.titleBlock, rule: s.rule },
      png, thumb, tiles, image, digest: s.digest, geom: s.geom, triage: s.triage,
    });
  }
  post({ type: 'done', id, sheets: sheets.length });
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg?.type === 'refs') {
    refs = new Map((msg.files || []).map((f) => [f.key, f]));
    parsed.clear();
    parsedBytes = 0;
    return;
  }
  if (msg?.type === 'done-batch') { converted.clear(); convertedBytes = 0; parsed.clear(); parsedBytes = 0; refs = new Map(); return; }
  const run = msg?.type === 'read' ? read : msg?.type === 'scan' ? scan : null;
  if (!run) return;
  run(msg).catch((err) => post({ type: 'error', id: msg.id, message: err?.message || String(err) }));
};
