// 시트 요약(digest JSON): AI가 그림과 함께 읽을 글자·레이어 통계·표·범례. 순수 함수.
// 최대 약 300KB. 넘으면 글자 목록을 중요도순(큰 글자 먼저)으로 자르고 truncated: true.
import { area, boxOf, unionBox } from './geom.js';
import { findTables } from './tables.js';
import { S } from '../bim/jsonschema.js';

// 요약 JSON 모양(테스트·AI 입력 확인용)
const PT = S.arr(S.num(), { minItems: 2, maxItems: 2 });
export const DIGEST_SCHEMA = {
  type: 'object',
  required: ['schema', 'sheetId', 'file', 'frame', 'units', 'scaleText', 'titleBlock', 'layers', 'texts', 'dims', 'blocks', 'hatches', 'tables', 'legend', 'gridLines', 'stats', 'truncated'],
  properties: {
    schema: { const: 'baromap-digest/1' },
    sheetId: S.str(), file: S.str(),
    frame: S.obj({ x0: S.num(), y0: S.num(), x1: S.num(), y1: S.num() }),
    units: S.str(), unitM: S.num(), scaleText: S.nul(S.str()),
    titleBlock: S.obj({ sheetNo: S.nul(S.str()), title: S.nul(S.str()) }),
    layers: S.arr({ type: 'object', required: ['name', 'color', 'counts'], properties: { name: S.str(), color: S.num(), counts: { type: 'object', additionalProperties: S.int() }, hidden: S.bool() }, additionalProperties: false }),
    texts: S.arr({ type: 'object', required: ['h', 't', 'x', 'y', 'size', 'rot', 'layer'], properties: { h: S.str(), t: S.str(), x: S.num(), y: S.num(), size: S.num(), rot: S.num(), layer: S.str(), tag: S.str() }, additionalProperties: false }),
    dims: S.arr(S.obj({ h: S.str(), value: S.nul(S.num()), text: S.str(), p1: PT, p2: PT, layer: S.str() })),
    blocks: S.arr(S.obj({ name: S.str(), count: S.int(), layers: S.arr(S.str()), attribs: { type: 'object', additionalProperties: S.arr(S.str()) } })),
    hatches: S.arr({ type: 'object', required: ['pattern', 'layer', 'count', 'areaM2'], properties: { pattern: S.str(), layer: S.str(), count: S.int(), areaM2: S.num(), solid: S.bool() }, additionalProperties: false }),
    tables: S.arr(S.obj({ bbox: S.arr(S.num(), { minItems: 4, maxItems: 4 }), rows: S.arr(S.arr(S.str())), lined: S.bool() })),
    legend: S.arr(S.obj({ symbol: S.str(), text: S.str() })),
    gridLines: S.arr({ type: 'object', required: ['label'], properties: { label: S.str(), x: S.num(), y: S.num() }, additionalProperties: false }),
    stats: { type: 'object', required: ['entities', 'textCount'], properties: { entities: S.int(), textCount: S.int(), dimCount: S.int(), textsKept: S.int() }, additionalProperties: false },
    truncated: S.bool(),
  },
  additionalProperties: false,
};

// 범례 기호(W1·F2·AW3·WD1…). 도면번호(A-101)와 헷갈리지 않게 붙임표 뒤는 두 자리까지
export const LEGEND_SYMBOL = /^[A-Z]{1,3}\d{1,3}[A-Z]?$|^[A-Z]{1,3}-\d{1,2}[A-Z]?$/;
export const UNIT_NAMES = { 0: 'unitless', 1: 'inch', 2: 'feet', 4: 'mm', 5: 'cm', 6: 'm' };
export const UNIT_M = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };

const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;

// 단위: $INSUNITS가 있으면 그대로, 없으면 시트 크기로 짐작(건물 도면이 수십~수백 m라고 보고).
// $INSUNITS가 m·cm인데 그 단위로 도곽이 5km를 넘으면 mm로 그린 파일이다(실제 도서: m로 적힌 mm 도면 — 33km 시트로 읽혀 판별이 수십 분·메모리 부족)
export function unitFactor(insunits, frame) {
  const span = frame ? Math.max(frame.x1 - frame.x0, frame.y1 - frame.y0) : 0;
  if (UNIT_M[insunits]) return span * UNIT_M[insunits] > 5000 && span * 0.001 <= 5000 ? 0.001 : UNIT_M[insunits];
  if (span > 20000) return 0.001;
  if (span > 2000) return 0.01;
  return 1;
}

const SRC_NAME = { line: 'line', poly: 'lwpolyline', arc: 'arc', circle: 'circle', ellipse: 'ellipse', spline: 'spline', solid: 'solid', leader: 'leader', point: 'point', image: 'image', wipeout: 'wipeout', dim: 'dimension' };

/**
 * @param {{ items: any[], frame: any }} flat flattenSheet 결과
 * @param {{ sheetId?: string, file?: string, insunits?: number, layers?: Record<string, any>, titleBlock?: any, scaleText?: string|null, maxBytes?: number }} info
 */
export function makeDigest(flat, { sheetId = '', file = '', insunits = 0, layers = {}, titleBlock = {}, scaleText = null, maxBytes = 300000 } = {}) {
  const { items, frame } = flat;
  const uf = unitFactor(insunits, frame);
  const prec = uf >= 0.01 ? r1 : r0; // m·cm 도면은 소수 한 자리
  const layerStats = new Map();
  const bump = (layer, kind) => {
    if (!layerStats.has(layer)) layerStats.set(layer, {});
    const c = layerStats.get(layer);
    c[kind] = (c[kind] || 0) + 1;
  };
  const texts = [];
  const dims = [];
  const blocks = new Map();
  const hatches = new Map();
  for (const it of items) {
    if (it.k === 'path') bump(it.layer, SRC_NAME[it.src] || it.src);
    else if (it.k === 'hatch') {
      bump(it.layer, 'hatch');
      const key = `${it.pattern}|${it.layer}`;
      const hh = hatches.get(key) || { pattern: it.pattern || '', layer: it.layer, count: 0, areaM2: 0, solid: it.solid };
      hh.count++;
      hh.areaM2 += it.loops.reduce((s, l) => s + area(l), 0) * uf * uf;
      hatches.set(key, hh);
    } else if (it.k === 'text') {
      bump(it.layer, it.kind);
      texts.push({ h: it.h, t: it.t, x: prec(it.x), y: prec(it.y), size: prec(it.size), rot: Math.round(((it.rot % 360) + 360) % 360), layer: it.layer, ...(it.tag ? { tag: it.tag } : {}) });
    } else if (it.k === 'insert') {
      bump(it.layer, 'insert');
      if (it.table) continue;
      const b = blocks.get(it.name) || { name: it.name, count: 0, layers: new Set(), attribs: {} };
      b.count++;
      b.layers.add(it.layer);
      for (const [tag, v] of Object.entries(it.attribs || {})) {
        const set = (b.attribs[tag] ||= new Set());
        if (set.size < 60) set.add(v);
      }
      blocks.set(it.name, b);
    } else if (it.k === 'dim') {
      bump(it.layer, 'dimension');
      dims.push({ h: it.h, value: it.value == null ? null : prec(it.value), text: it.text || '', p1: it.p1.map(prec), p2: it.p2.map(prec), layer: it.layer });
    }
  }
  const tables = findTables(items).map((t) => ({ bbox: t.bbox.map(prec), rows: t.rows, lined: t.lined }));
  // 범례: 표의 첫 칸이 기호(W1·F2·AW3…)인 행 + "W1 : 설명" 한 줄 글자
  const legend = [];
  const seen = new Set();
  for (const t of tables) {
    for (const row of t.rows) {
      const sym = (row[0] || '').trim();
      const rest = row.slice(1).filter(Boolean);
      if (LEGEND_SYMBOL.test(sym) && rest.length && !seen.has(sym)) { seen.add(sym); legend.push({ symbol: sym, text: rest.join(' | ') }); }
    }
  }
  for (const t of texts) {
    const m = /^([A-Z]{1,3}-?\d{1,3}[A-Z]?)\s*[:：=]\s*(.{2,})$/.exec(t.t.trim());
    if (m && LEGEND_SYMBOL.test(m[1]) && !seen.has(m[1])) { seen.add(m[1]); legend.push({ symbol: m[1], text: m[2].trim() }); }
  }
  const gridLines = [];
  for (const t of texts) {
    const m = /^([XY])(\d{1,2}[A-Z]?)$/i.exec(t.t.trim());
    if (m) gridLines.push(m[1].toUpperCase() === 'X' ? { label: t.t.trim().toUpperCase(), x: t.x } : { label: t.t.trim().toUpperCase(), y: t.y });
  }
  const digest = {
    schema: 'baromap-digest/1',
    sheetId, file,
    frame: { x0: prec(frame.x0), y0: prec(frame.y0), x1: prec(frame.x1), y1: prec(frame.y1) },
    units: UNIT_NAMES[insunits] || 'unitless',
    unitM: uf,
    scaleText: scaleText ?? titleBlock?.scale ?? null,
    titleBlock: { sheetNo: titleBlock?.sheetNo ?? null, title: titleBlock?.title ?? null },
    layers: [...layerStats].map(([name, counts]) => ({ name, color: layers[name]?.color ?? 7, counts, ...(layers[name]?.off || layers[name]?.frozen ? { hidden: true } : {}) }))
      .sort((a, b) => sum(b.counts) - sum(a.counts)),
    texts,
    dims: dims.slice(0, 3000),
    blocks: [...blocks.values()].map((b) => ({ name: b.name, count: b.count, layers: [...b.layers], attribs: Object.fromEntries(Object.entries(b.attribs).map(([k, s]) => [k, [...s]])) }))
      .sort((a, b) => b.count - a.count),
    hatches: [...hatches.values()].map((h) => ({ ...h, areaM2: Math.round(h.areaM2 * 100) / 100 })).sort((a, b) => b.count - a.count),
    tables,
    legend,
    gridLines,
    stats: { entities: items.length, textCount: texts.length, dimCount: dims.length },
    truncated: false,
  };
  return fitSize(digest, maxBytes);
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const byteLength = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length * 3);

// 크기 제한: 글자를 중요도(큰 글자·짧은 기호) 순으로 남기고 나머지를 버린다
function fitSize(digest, maxBytes) {
  let json = JSON.stringify(digest);
  if (byteLength(json) <= maxBytes) return digest;
  digest.truncated = true;
  const ranked = [...digest.texts].sort((a, b) => b.size - a.size || a.t.length - b.t.length);
  digest.dims = digest.dims.slice(0, 300);
  for (const t of digest.tables) if (t.rows.length > 200) t.rows = t.rows.slice(0, 200);
  let lo = 0;
  let hi = ranked.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const keep = new Set(ranked.slice(0, mid));
    const trial = JSON.stringify({ ...digest, texts: digest.texts.filter((t) => keep.has(t)) });
    if (byteLength(trial) <= maxBytes) lo = mid; else hi = mid - 1;
  }
  const keep = new Set(ranked.slice(0, lo));
  digest.texts = digest.texts.filter((t) => keep.has(t));
  digest.stats.textsKept = digest.texts.length;
  json = JSON.stringify(digest);
  if (byteLength(json) > maxBytes) digest.blocks = digest.blocks.slice(0, 50);
  return digest;
}

// 개체 위치 색인 { 핸들 경로: [x0, y0, x1, y1] } — 근거 상자 그리기용(시트 좌표)
export function buildIndex(items) {
  const idx = {};
  for (const it of items) {
    if (!it.h) continue;
    const b = it.box || (it.pts ? boxOf(it.pts) : it.loops ? boxOf(it.loops.flat()) : it.p1 ? boxOf([it.p1, it.p2, it.tp]) : null);
    if (!b) continue;
    idx[it.h] = idx[it.h] ? unionBox(idx[it.h], b) : b;
  }
  for (const k of Object.keys(idx)) idx[k] = idx[k].map(r1);
  return idx;
}
