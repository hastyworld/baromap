// 도면 읽기 워커(Web Worker, type: module): 파일 받기 → 진행률 → 시트마다 그림(PNG)·조각·미리보기·요약·모양을 돌려준다.
// 메시지: { type: 'read', id, file: Blob, name }
//   → { type: 'progress', id, phase: 'hash'|'read'|'sheets', done, total }
//   → { type: 'file', id, sha256, stats }
//   → { type: 'sheet', id, index, sheet: { key, method, frame, titleBlock, rule, layoutName }, png, thumb, tiles: [{ n, grid, region, blob }], digest, geom, image: { width, height } }
//   → { type: 'done', id, sheets } / { type: 'error', id, message }
import { parseBlob, sheetsOf } from './read.js';
import { dwgToDxf } from './dwg.js';
import { renderPng, renderTiles, ensureFont, canRender, THUMB_SIDE } from './render.js';

const post = (msg) => self.postMessage(msg);

async function sha256(blob) {
  // 150MB까지는 전체, 그보다 크면 앞·뒤 4MB + 크기(같은 파일 다시 올리기 감지용)
  const full = blob.size <= 150 * 1024 * 1024;
  const buf = full ? await blob.arrayBuffer() : await new Blob([String(blob.size), blob.slice(0, 4 << 20), blob.slice(-(4 << 20))]).arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return `${full ? '' : 'p:'}${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function read({ id, file, name, triageProfile = {} }) {
  post({ type: 'progress', id, phase: 'hash', done: 0, total: file.size });
  const hash = await sha256(file);
  const src = /\.dwg$/i.test(name) ? await dwgToDxf(file) : file; // DWG는 DXF로 바꾼 뒤 같은 길로
  const dxf = await parseBlob(src, { onProgress: (done, total) => post({ type: 'progress', id, phase: 'read', done, total }) });
  const { stats, sheets } = sheetsOf(dxf, { fileName: name, triageProfile });
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
  if (msg?.type !== 'read') return;
  read(msg).catch((err) => post({ type: 'error', id: msg.id, message: err?.message || String(err) }));
};
