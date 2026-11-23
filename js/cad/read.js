// 도면 파일 하나 읽기: 바이트(또는 흘려 읽기) → 해석 → 시트 분리 → 시트마다 펼치기·표제란·요약·저장용 모양.
// 그림(PNG)은 만들지 않는다(worker.js가 render.js로 만든다). 브라우저·Node 공용.
import { decodeBytes, isBinaryDxf, binaryError, encodingFor, unescapeUnicode } from './decode.js';
import { xrefKey } from './xref.js';
import { createDxfParser, brokenError } from './parse.js';
import { findSheets, readTitle, commonTexts, textKey } from './sheets.js';
import { TOO_SLOW } from './book.js';
import { flattenSheet, packSheet } from './flatten.js';
import { makeDigest, UNIT_NAMES } from './digest.js';
import { classifyByRule } from './classify.js';
import { ruleRead, isRoomName } from '../bim/rule-read.js';
import { triageSheet } from './triage.js';
import { planProfile } from '../bim/struct-place.js';

const STREAM_FROM = 32 * 1024 * 1024; // 이보다 큰 파일은 줄 단위로 흘려 읽는다

function checkParsed(dxf) {
  if (!dxf.sections.length) throw new Error('DXF 도면 파일이 아닙니다. AutoCAD에서 DXF로 저장한 파일을 올려주세요.');
  if (dxf.truncated) throw brokenError();
  return dxf;
}

export function parseBytes(bytes) {
  const { text, encoding, fixed } = decodeBytes(bytes);
  const p = createDxfParser();
  p.feed(text);
  const dxf = checkParsed(p.end());
  dxf.encoding = encoding;
  // 깨진 줄만 다시 읽은 수(숫자만 남긴다)
  if (fixed?.cp949Lines) dxf.warnings.push(`글자 ${fixed.cp949Lines}줄을 CP949로 다시 읽음`);
  if (fixed?.badLines) dxf.warnings.push(`읽지 못한 글자 ${fixed.badLines}줄`);
  if (fixed) dxf.decodeFix = fixed;
  return dxf;
}

/**
 * 큰 파일: Blob.stream() + TextDecoderStream. onProgress(읽은 바이트, 전체 바이트)
 * @param {Blob} blob
 */
/**
 * 외부 참조(XREF) 이름만 빨리 훑기(해석하지 않음): 블록 정의(BLOCKS 구역)의 경로 값(그룹 코드 1, ….dwg)을 찾는다.
 * 모든 파일을 먼저 훑어서 "다른 도면이 참조하는 파일"을 알아낸다(그런 파일은 시트로 만들지 않는다).
 * @param {Blob} blob DXF @returns {Promise<string[]>} 참조 열쇠(xrefKey) 목록
 */
export async function scanXrefs(blob) {
  const head = new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer());
  if (isBinaryDxf(head)) return [];
  let enc = encodingFor(head);
  if (enc !== 'utf-8') {
    try { const s = new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 4)); if (/[^\x00-\x7f]/.test(s)) enc = 'utf-8'; } catch { /* 코드페이지 그대로 */ }
  }
  const keys = new Set();
  const re = /\n\s*1\r?\n([^\r\n]{1,300}?\.dwg)\r?\n/gi;
  const dec = new TextDecoder(enc);
  const step = 4 << 20;
  let tail = '';
  for (let at = 0; at < blob.size; at += step) {
    const text = tail + dec.decode(new Uint8Array(await blob.slice(at, at + step).arrayBuffer()), { stream: at + step < blob.size });
    const stop = text.search(/\n\s*2\r?\nENTITIES\r?\n/);
    const part = stop >= 0 ? text.slice(0, stop) : text;
    for (const m of part.matchAll(re)) keys.add(xrefKey(unescapeUnicode(m[1])));
    if (stop >= 0) break;
    tail = text.slice(-700);
  }
  return [...keys];
}

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
// bundle: 'structure'면 공종 글자 없는 시트도 구조로 본다(43 지시서 1절 묶음 판단)
// deadline: 이 시각(ms)을 넘기면 다음 단계로 가지 않고 "너무 오래 걸림"(45 지시서 4.2)
export function sheetsOf(dxf, { fileName = '', layerProfile = {}, triageProfile = {}, bundle = null, deadline = 0 } = {}) {
  const clock = () => { if (deadline && Date.now() > deadline) throw new Error(TOO_SLOW); };
  const found = findSheets(dxf);
  const pre = found.map((s) => { clock(); const flat = flattenSheet(dxf, s); return { s, flat, texts: flat.items.filter((it) => it.k === 'text') }; });
  const common = commonTexts(pre.map((p) => p.texts));
  const sheets = pre.map(({ s, flat, texts }) => {
    clock();
    const titleBlock = fixTitle(readTitle(s, texts, s.titleInsert, { common }), common);
    const digest = makeDigest(flat, { file: fileName, insunits: dxf.header.insunits, layers: dxf.layers, titleBlock });
    clock();
    const rule = classifyByRule({ titleBlock, digest, bundle });
    Object.assign(rule, ruleRead({ category: rule.category, refs: rule.refs, title: titleBlock.title }, digest, { layerProfile }));
    // 구조 평면: 건축 평면과 좌표를 맞출 선 분포(43 지시서 3절). 판독 값이 아니라 도면 모양이라 판독 결과 밖(rule.profile → 시트 meta.profile)에 둔다 — AI 판독으로 바뀌어도 남게
    if (rule.extracted?.kind === 'StructureScheduleExtract' && rule.extracted.data?.planMarks?.length) rule.profile = planProfile(flat.items, rule.layerRoles, digest.unitM);
    clock();
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

// 도면명이 아닌 것 거르기(45 지시서 2.3): 이 파일의 모든 시트에 같은 글자(설계사·공사명), 실 이름 낱말 하나(펌프실·PIT).
// 그러면 큰 제목을 도면명으로 쓴다. 표제란 칸에서 읽은 도면명은 큰 제목이 있을 때만 바꾼다(같은 이름의 시트가 정말 여럿일 수 있다)
const ROOM_ONLY = /^[가-힣A-Z]{1,8}(실|PIT|피트|수조|탱크)$|^PIT$/i;
export function notTitle(t, common) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (common?.has(textKey(s))) return true;
  return !/\s/.test(s) && s.length <= 8 && (isRoomName(s) || ROOM_ONLY.test(s)) && !/(도|표)$/.test(s);
}
function fixTitle(tb, common) {
  const bad = tb.title && notTitle(tb.title, common);
  if (bad && tb.titleFrom !== 'attrib' && (tb.caption || tb.titleFrom === 'zone' || !common.has(textKey(tb.title)))) { tb.title = null; tb.titleFrom = null; }
  if (!tb.title && tb.caption && !notTitle(tb.caption, common)) { tb.title = tb.caption; tb.titleFrom = 'caption'; }
  if (tb.caption && notTitle(tb.caption, common)) tb.caption = null;
  return tb;
}

export function readDxfBytes(bytes, opts = {}) {
  return sheetsOf(parseBytes(bytes), opts);
}
