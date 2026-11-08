// 시트(도면 한 장) 찾기와 표제란 읽기. 순수 함수.
// 찾는 순서: ① 배치 공간(Layout 탭마다 한 장) ② 도곽(표제란) 블록 ③ A판 비율의 큰 직사각형 ④ 파일 전체 한 장
import { ID, apply, insertMatrix, entityPaths, textCorners, emptyBox, grow, boxOk, unionBox, boxTransform, boxCenter, inBox, boxContains, toFrame, FLIP, mul } from './geom.js';

const TITLE_NAME = /도곽|TITLE|BORDER|FORM|FRAME|SHEET/i;
const TITLE_TAG = /도면\s*번호|도면\s*명|DWG|SCALE|축척/i;
export const SHEET_NO = /^[A-Z]{1,3}-?\d{2,4}[A-Z]?$/;
const SCALE_RE = /(1\s*[/:]\s*[\d,]+)|S\s*=\s*(1\s*[:/]\s*[\d,]+)|\b(NONE|N\.?\s?S\.?)\b/i;
const LABEL_WORDS = /^(도면\s*명|도면\s*번호|축척|날짜|일자|공사명|PROJECT|TITLE|SCALE|DATE|DWG\.?\s*NO\.?|설계|감리|검토|승인|작성|도면\s*목록)$/i;

// ---------------------------------------------------------------- 개체 경계 상자(최상위 개체 기준, 캐시)

export function blockExtent(dxf, name, depth = 0) {
  dxf._ext ||= {};
  if (name in dxf._ext) return dxf._ext[name];
  dxf._ext[name] = null; // 순환 방지
  const b = dxf.blocks?.[name];
  let box = emptyBox();
  if (b && depth < 8) {
    for (const e of b.entities) {
      const eb = entityBox(dxf, e, depth + 1);
      if (eb) box = unionBox(box, eb);
    }
  }
  dxf._ext[name] = boxOk(box) ? box : null;
  return dxf._ext[name];
}

export function entityBox(dxf, e, depth = 0) {
  if (e.type === 'insert') {
    const b = dxf.blocks?.[e.name];
    const ext = blockExtent(dxf, e.name, depth);
    let box = emptyBox();
    if (ext && b) {
      box = unionBox(box, boxTransform(insertMatrix(e, b.base), ext));
      if ((e.rows || 1) > 1 || (e.cols || 1) > 1) {
        box = unionBox(box, boxTransform(insertMatrix(e, b.base, [(e.cols - 1) * (e.dc || 0), (e.rows - 1) * (e.dr || 0)]), ext));
      }
    }
    for (const a of e.attribs || []) if (!a.hidden && a.t) for (const [x, y] of textCorners(a)) grow(box, x, y);
    return boxOk(box) ? box : null;
  }
  if (e.type === 'dim') {
    const ext = e.block ? blockExtent(dxf, e.block, depth) : null;
    if (ext) return ext;
    const box = emptyBox();
    for (const [x, y] of [e.p1, e.p2, e.tp, e.dp]) if (x || y) grow(box, x, y);
    return boxOk(box) ? box : null;
  }
  if (e.type === 'text' || e.type === 'mtext' || e.type === 'attrib' || e.type === 'attdef') {
    if (!e.t && e.type !== 'attdef') return null;
    const box = emptyBox();
    const m = e.ext < 0 ? FLIP : ID;
    for (const [x, y] of textCorners(e)) { const [X, Y] = apply(m, x, y); grow(box, X, Y); }
    return box;
  }
  if (e.type === 'viewport' || e.type === 'other') return null;
  const box = emptyBox();
  const m = e.ext < 0 ? FLIP : ID;
  for (const p of entityPaths(e)) for (const [x, y] of p.pts) { const [X, Y] = apply(m, x, y); grow(box, X, Y); }
  return boxOk(box) ? box : null;
}

function boxesOf(dxf, list) {
  return list.map((e) => ({ e, box: entityBox(dxf, e) }));
}

// ---------------------------------------------------------------- 표제란 읽기

export function normScale(s) {
  const m = SCALE_RE.exec(String(s || ''));
  if (!m) return null;
  if (m[3]) return 'NONE';
  const v = (m[1] || m[2]).replace(/\s/g, '').replace(':', '/').replace(/,/g, '');
  return v;
}

export function isTitleInsert(dxf, e) {
  if (e.type !== 'insert') return false;
  if (TITLE_NAME.test(e.name)) return true;
  if ((e.attribs || []).some((a) => TITLE_TAG.test(a.tag))) return true;
  return (dxf.blocks?.[e.name]?.attdefs || []).some((a) => TITLE_TAG.test(a.tag));
}

// 속성(ATTRIB)의 태그로 도면번호·도면명·축척
function fromAttribs(ins) {
  const out = { sheetNo: null, title: null, scale: null };
  for (const a of ins?.attribs || []) {
    const tag = a.tag.trim();
    const v = String(a.t || '').trim();
    if (!v) continue;
    if (/^(DWG_?NO|DWGNO|SHEET_?NO|DRAWING_?NO|도면\s*번호|NO)$/i.test(tag)) out.sheetNo ||= v;
    else if (/^(TITLE|DWG_?NAME|DWG_?TITLE|도면\s*명|NAME)$/i.test(tag)) out.title ||= v;
    else if (/^(SCALE|축척|S)$/i.test(tag)) out.scale ||= normScale(v) || v;
  }
  return out;
}

/**
 * 표제란 읽기: 도곽 블록 속성 → 없으면 도곽 오른쪽 아래 영역 글자(도면번호 패턴·축척·가장 큰 글자).
 * texts: [{ t, x, y, size }] 시트 좌표
 */
export function readTitle(sheet, texts, titleInsert = null) {
  const out = fromAttribs(titleInsert);
  const f = sheet.frame;
  const w = f.x1 - f.x0;
  const h = f.y1 - f.y0;
  const zone = texts.filter((t) => t.x >= f.x0 + w * 0.6 && t.y <= f.y0 + h * 0.25);
  const pool = zone.length ? zone : texts;
  if (!out.sheetNo) out.sheetNo = pool.find((t) => SHEET_NO.test(t.t.trim()))?.t.trim() || null;
  if (!out.scale) {
    for (const t of pool) { const s = normScale(t.t); if (s) { out.scale = s; break; } }
  }
  // 도곽·표제란이 없는 시트(파일 전체)는 도면번호를 찾은 경우에만 도면명을 짐작한다
  if (!out.title && (sheet.method !== 'whole' || out.sheetNo)) {
    const cand = zone.filter((t) => {
      const s = t.t.trim();
      return s && !SHEET_NO.test(s) && !normScale(s) && !LABEL_WORDS.test(s) && !/^\d{4}[-.]\d{1,2}[-.]\d{1,2}$/.test(s);
    }).sort((a, b) => b.size - a.size);
    out.title = cand[0]?.t.trim() || null;
  }
  return out;
}

// ---------------------------------------------------------------- 시트 찾기

const ratioOk = (w, h) => {
  const r = Math.max(w, h) / Math.min(w, h);
  return Math.abs(r / Math.SQRT2 - 1) <= 0.03;
};

function rectOf(e) {
  if (e.type !== 'poly' || !e.closed || e.pts.length !== 4 || e.pts.some((p) => p[2])) return null;
  const xs = e.pts.map((p) => p[0]);
  const ys = e.pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const tol = (x1 - x0 + y1 - y0) * 1e-4;
  const axis = e.pts.every((p) => (Math.abs(p[0] - x0) < tol || Math.abs(p[0] - x1) < tol) && (Math.abs(p[1] - y0) < tol || Math.abs(p[1] - y1) < tol));
  return axis ? [x0, y0, x1, y1] : null;
}

function layoutBlockName(dxf, lay) {
  const rec = dxf.blockRecords?.[lay.blockRecord];
  if (rec?.name) return rec.name;
  // 배치 공간 블록 연결이 없으면 이름 순서로 짐작
  return null;
}

/**
 * @returns {Array<{ key: string, method: 'layout'|'titleblock'|'rect'|'whole', space: 'model'|'paper', layoutName: string|null,
 *   frame: {x0,y0,x1,y1}, titleInsert: any|null, entities: any[], viewports: any[] }>}
 */
export function findSheets(dxf) {
  const sheets = [];
  const model = dxf.entities.filter((e) => !e.ps);
  const modelBoxes = boxesOf(dxf, model);

  // ① 배치 공간
  const layouts = [...(dxf.layouts || [])].filter((l) => l.name && l.name.toLowerCase() !== 'model').sort((a, b) => a.order - b.order);
  for (const lay of layouts) {
    const bname = layoutBlockName(dxf, lay);
    let ents = [];
    if (bname && /^\*paper_space$/i.test(bname)) ents = dxf.entities.filter((e) => e.ps).concat(dxf.blocks?.[bname]?.entities || []);
    else if (bname) ents = dxf.blocks?.[bname]?.entities || [];
    const viewports = ents.filter((e) => e.type === 'viewport' && e.id !== 1 && e.w > 0 && e.hgt > 0 && e.vh > 0);
    const drawn = ents.filter((e) => e.type !== 'viewport');
    if (!drawn.length && !viewports.length) continue;
    const boxes = boxesOf(dxf, drawn);
    const title = drawn.find((e) => isTitleInsert(dxf, e));
    let frame = title ? entityBox(dxf, title) : null;
    if (!frame) {
      frame = emptyBox();
      for (const { box } of boxes) if (box) frame = unionBox(frame, box);
      for (const v of viewports) frame = unionBox(frame, [v.c[0] - v.w / 2, v.c[1] - v.hgt / 2, v.c[0] + v.w / 2, v.c[1] + v.hgt / 2]);
    }
    if (!boxOk(frame)) continue;
    sheets.push({ key: `layout:${lay.name}`, method: 'layout', space: 'paper', layoutName: lay.name, frame: toFrame(frame), titleInsert: title || null, entities: drawn, viewports, modelEntities: model });
  }

  // ② 모형 공간의 도곽 블록
  let extent = emptyBox();
  for (const { box } of modelBoxes) if (box) extent = unionBox(extent, box);
  const extArea = boxOk(extent) ? (extent[2] - extent[0]) * (extent[3] - extent[1]) : 0;
  const frames = [];
  for (const { e, box } of modelBoxes) {
    if (!box || !isTitleInsert(dxf, e)) continue;
    const a = (box[2] - box[0]) * (box[3] - box[1]);
    if (extArea && a < extArea * 0.02) continue;
    frames.push({ box, title: e, method: 'titleblock' });
  }
  // ③ A판 비율 큰 직사각형(도곽 블록이 차지하지 않은 곳만)
  const rects = [];
  for (const { e, box } of modelBoxes) {
    const r = rectOf(e);
    if (!r || !ratioOk(r[2] - r[0], r[3] - r[1])) continue;
    if (frames.some((f) => boxContains(f.box, r, (r[2] - r[0]) * 0.01))) continue;
    const inside = modelBoxes.filter((x) => x.box && x.e !== e && inBox(r, ...boxCenter(x.box))).length;
    if (inside >= 20) rects.push({ box: r, title: null, method: 'rect' });
  }
  for (const r of rects) if (!rects.some((o) => o !== r && boxContains(o.box, r.box) && !boxContains(r.box, o.box))) frames.push(r);
  frames.sort((a, b) => a.box[0] - b.box[0] || b.box[1] - a.box[1]);
  const used = new Set();
  frames.forEach((f, i) => {
    const ents = [];
    for (const { e, box } of modelBoxes) {
      if (used.has(e)) continue;
      const c = box ? boxCenter(box) : null;
      if (e === f.title || (c && inBox(f.box, c[0], c[1]))) { ents.push(e); used.add(e); }
    }
    sheets.push({ key: `${f.method}:${i}`, method: f.method, space: 'model', layoutName: null, frame: toFrame(f.box), titleInsert: f.title, entities: ents, viewports: [] });
  });

  // ④ 아무것도 못 찾으면 모형 공간 전체 = 한 장
  if (!sheets.length && boxOk(extent)) {
    sheets.push({ key: 'whole:0', method: 'whole', space: 'model', layoutName: null, frame: toFrame(extent), titleInsert: null, entities: model, viewports: [] });
  }
  return sheets;
}

// 배치 공간 뷰포트: 모형 좌표 → 종이 좌표 행렬과 모형 범위
export function viewportMatrix(v) {
  const s = v.hgt / v.vh;
  return [s, 0, 0, s, v.c[0] - v.vc[0] * s, v.c[1] - v.vc[1] * s];
}
export function viewportModelBox(v) {
  const s = v.vh / v.hgt;
  return [v.vc[0] - (v.w / 2) * s, v.vc[1] - (v.hgt / 2) * s, v.vc[0] + (v.w / 2) * s, v.vc[1] + (v.hgt / 2) * s];
}
export function viewportPaperBox(v) {
  return [v.c[0] - v.w / 2, v.c[1] - v.hgt / 2, v.c[0] + v.w / 2, v.c[1] + v.hgt / 2];
}

export { mul, ID };
