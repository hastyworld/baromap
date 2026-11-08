// 도면 파일 하나 읽기: 바이트(또는 흘려 읽기) → 해석 → 시트 분리 → 시트마다 펼치기·표제란·요약·저장용 모양.
// 그림(PNG)은 만들지 않는다(worker.js가 render.js로 만든다). 브라우저·Node 공용.
import { decodeBytes, isBinaryDxf, binaryError, encodingFor } from './decode.js';
import { createDxfParser, brokenError } from './parse.js';
import { findSheets, readTitle } from './sheets.js';
import { flattenSheet, packSheet } from './flatten.js';
import { makeDigest, UNIT_NAMES } from './digest.js';
import { classifyByRule } from './classify.js';
import { ruleRead } from '../bim/rule-read.js';
import { triageSheet } from './triage.js';

const STREAM_FROM = 32 * 1024 * 1024; // 이보다 큰 파일은 줄 단위로 흘려 읽는다

function checkParsed(dxf) {
  if (!dxf.sections.length) throw new Error('DXF 도면 파일이 아닙니다. AutoCAD에서 DXF로 저장한 파일을 올려주세요.');
  if (dxf.truncated) throw brokenError();
  return dxf;
}

export function parseBytes(bytes) {
  const { text, encoding } = decodeBytes(bytes);
  const p = createDxfParser();
  p.feed(text);
  const dxf = checkParsed(p.end());
  dxf.encoding = encoding;
  return dxf;
}

/**
 * 큰 파일: Blob.stream() + TextDecoderStream. onProgress(읽은 바이트, 전체 바이트)
 * @param {Blob} blob
 */
export async function parseBlob(blob, { onProgress } = {}) {
  const head = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
  if (isBinaryDxf(head)) throw binaryError();
  if (blob.size < STREAM_FROM || typeof TextDecoderStream === 'undefined') {
    const dxf = parseBytes(new Uint8Array(await blob.arrayBuffer()));
    onProgress?.(blob.size, blob.size);
    return dxf;
  }
  let enc = encodingFor(head);
  if (enc !== 'utf-8') {
    // 앞부분이 UTF-8로 깨짐 없이 읽히고 한글이 있으면 UTF-8
    try { const s = new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 4)); if (/[^\x00-\x7f]/.test(s)) enc = 'utf-8'; } catch { /* 코드페이지 그대로 */ }
  }
  const p = createDxfParser();
  let done = 0;
  const counter = new TransformStream({ transform(chunk, ctl) { done += chunk.byteLength; onProgress?.(done, blob.size); ctl.enqueue(chunk); } });
  const reader = blob.stream().pipeThrough(counter).pipeThrough(new TextDecoderStream(enc)).getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    p.feed(value);
  }
  const dxf = checkParsed(p.end());
  dxf.encoding = enc;
  return dxf;
}

/**
 * 해석된 도면 → 시트 목록(그림 제외 전부)
 * @returns {{ stats: any, sheets: Array<{ key, method, space, layoutName, frame, titleBlock, rule, flat, digest, geom }> }}
 */
export function sheetsOf(dxf, { fileName = '', layerProfile = {}, triageProfile = {} } = {}) {
  const found = findSheets(dxf);
  const sheets = found.map((s) => {
    const flat = flattenSheet(dxf, s);
    const texts = flat.items.filter((it) => it.k === 'text');
    const titleBlock = readTitle(s, texts, s.titleInsert);
    const digest = makeDigest(flat, { file: fileName, insunits: dxf.header.insunits, layers: dxf.layers, titleBlock });
    const rule = classifyByRule({ titleBlock, digest });
    Object.assign(rule, ruleRead({ category: rule.category, refs: rule.refs, title: titleBlock.title }, digest, { layerProfile }));
    const triage = triageSheet(flat, { layerRoles: rule.layerRoles, uf: digest.unitM, layers: dxf.layers, tables: digest.tables, category: rule.category, profile: triageProfile });
    return { key: s.key, method: s.method, space: s.space, layoutName: s.layoutName, frame: s.frame, titleBlock, rule, flat, digest, geom: packSheet(flat), triage };
  });
  const stats = {
    entities: Object.values(dxf.counts).reduce((a, b) => a + b, 0),
    counts: dxf.counts,
    layers: Object.keys(dxf.layers).length,
    blocks: Object.keys(dxf.blocks).length,
    encoding: dxf.encoding || '',
    acadver: dxf.header.acadver,
    units: UNIT_NAMES[dxf.header.insunits] || 'unitless',
    sheets: sheets.length,
    warnings: [...new Set(dxf.warnings)].slice(0, 20),
  };
  return { stats, sheets };
}

export function readDxfBytes(bytes, opts = {}) {
  return sheetsOf(parseBytes(bytes), opts);
}
