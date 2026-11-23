// 시트(도면 한 장) 찾기와 표제란 읽기. 순수 함수.
// 찾는 순서: ① 배치 공간(Layout 탭마다 한 장) ② 도곽(표제란) 블록 ②' 이름·속성 없이 여러 번 삽입한 도곽 블록(격자 시트, 45 지시서 1절)
//   ③ A판 비율의 큰 직사각형(도곽을 하나도 못 찾았을 때만) ④ 파일 전체 한 장(멀리 떨어진 개체는 빼고)
import { ID, apply, insertMatrix, entityPaths, textCorners, emptyBox, grow, boxOk, unionBox, boxTransform, boxCenter, inBox, boxContains, toFrame, FLIP, mul } from './geom.js';

const TITLE_NAME = /도곽|도면\s*폼|도면\s*양식|TITLE|BORDER|FORM|FRAME|SHEET/i;
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
  // "A1:1/150 A3:1/300"처럼 종이 크기가 붙은 축척은 첫 종이 크기의 값("A1:"의 1을 축척으로 읽지 않게)
  const m = SCALE_RE.exec(String(s || '').replace(/\bA\d\s*[:：]\s*/gi, ' '));
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
 * 그림 아래 큰 제목(caption)도 따로 읽는다(45 지시서 2.2). titleFrom: 'attrib'|'label'|'zone' — 도면명을 어디서 읽었는지
 * texts: [{ t, x, y, size }] 시트 좌표. common: 이 파일의 모든 시트에 같은 글자(설계사·공사명 등, 도면명 후보에서 뺀다)
 */
export function readTitle(sheet, texts, titleInsert = null, { common = null } = {}) {
  const out = fromAttribs(titleInsert);
  out.titleFrom = out.title ? 'attrib' : null;
  out.caption = readCaption(sheet, texts);
  if (out.sheetNo) out.sheetNo = normSheetNo(out.sheetNo) || out.sheetNo;
  const f = sheet.frame;
  const w = f.x1 - f.x0;
  const h = f.y1 - f.y0;
  // 한국 도곽은 표제란이 오른쪽 세로 띠(전체 높이)인 경우가 많다 → 오른쪽 아래 영역과 오른쪽 띠를 함께 본다
  const zone = texts.filter((t) => t.x >= f.x0 + w * 0.6 && t.y <= f.y0 + h * 0.25);
  const band = sheet.method === 'whole' ? [] : texts.filter((t) => t.x >= f.x0 + w * 0.82);
  const pool = zone.length ? zone : texts;
  // ① 칸 이름("도면번호", "SHEET NO.", "도면명", "SUBJECT TITLE")에 붙은 값
  // 칸 이름이 오른쪽 띠·아래 영역에 없으면(도곽을 90° 돌려 놓아 표제란이 왼쪽 아래에 온 경우 등) 시트 전체에서 찾는다
  const near = [...new Set([...band, ...zone])];
  const hasLabels = (list) => list.some((t) => LABEL_NO.test(t.t.trim()) || LABEL_TITLE.test(t.t.trim()));
  const labeled = sheet.method === 'whole' ? {} : fromLabels(hasLabels(near) ? near : texts, h);
  if (!out.sheetNo && labeled.sheetNo) out.sheetNo = labeled.sheetNo;
  if (!out.title && labeled.title) { out.title = labeled.title; out.titleFrom = 'label'; }
  // 칸 이름이 있는데 값을 못 읽었으면 짐작하지 않는다(문·창 기호 "PD800", "WD700"을 도면번호로 잡던 문제)
  const hasNoLabel = (sheet.method === 'whole' ? [] : texts).some((t) => LABEL_NO.test(t.t.trim()));
  if (!out.sheetNo && !hasNoLabel) out.sheetNo = pool.map((t) => (/-/.test(t.t) || t.size >= h * 0.004 ? normSheetNo(t.t) : null)).find(Boolean) || null;
  if (!out.scale) {
    // 오른쪽 아래 → 오른쪽 띠(표제란 칸) → 그 밖
    for (const t of [...pool, ...band, ...(pool === texts ? [] : texts)]) { const s = normScale(t.t); if (s) { out.scale = s; break; } }
  }
  // 도곽·표제란이 없는 시트(파일 전체)는 도면번호를 찾은 경우에만 도면명을 짐작한다
  if (!out.title && (sheet.method !== 'whole' || out.sheetNo)) {
    const cand = zone.filter((t) => {
      const s = t.t.trim();
      return s && !normSheetNo(s) && !normScale(s) && !LABEL_WORDS.test(s) && !LABEL_ANY.test(s) && !/^\d{4}[-.]\s*\d{1,2}[-.]/.test(s) && /[가-힣A-Za-z]{2}/.test(s) && !common?.has(textKey(s));
    }).sort((a, b) => b.size - a.size);
    out.title = cand[0]?.t.trim() || null;
    if (out.title) out.titleFrom = 'zone';
  }
  return out;
}

export const textKey = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

/** 한 파일의 모든 시트(2장 이상)에 있는 글자: 설계사 이름·공사명·로고처럼 도면명이 아닌 것(45 지시서 2.3) */
export function commonTexts(textLists) {
  if (textLists.length < 2) return new Set();
  let common = null;
  for (const list of textLists) {
    const keys = new Set(list.map((t) => textKey(t.t)).filter((k) => k.length >= 2));
    common = common ? new Set([...common].filter((k) => keys.has(k))) : keys;
    if (!common.size) break;
  }
  return common || new Set();
}

// 큰 제목(45 지시서 2.2): 시트 아래쪽 1/4에서 가장 큰 글자 줄(오른쪽 표제란 띠 빼고).
// 바로 아래에 "SCALE : 1/150"이 있으면 더 믿고, 없으면 시트 글자 중간 크기의 1.5배 이상일 때만. 통째로 읽은 시트는 SCALE이 있을 때만
const CAPTION_SCALE = /SCALE\s*[:：=]|^S\s*=\s*1\s*[/:]/i;
export function readCaption(sheet, texts) {
  const f = sheet.frame;
  const w = f.x1 - f.x0;
  const h = f.y1 - f.y0;
  if (!(w > 0 && h > 0) || !texts.length) return null;
  const ok = (s) => s && s.length <= 80 && /[가-힣A-Za-z]{2}/.test(s) && !normSheetNo(s) && !normScale(s) && !CAPTION_SCALE.test(s) && !LABEL_ANY.test(s) && !LABEL_WORDS.test(s);
  const low = texts.filter((t) => t.y >= f.y0 && t.y <= f.y0 + h * 0.25 && t.x >= f.x0 && t.x < f.x0 + w * 0.82 && ok(String(t.t).trim()));
  if (!low.length) return null;
  const scales = texts.filter((t) => CAPTION_SCALE.test(String(t.t).trim()));
  const withScale = (t) => scales.some((sc) => sc.y < t.y && t.y - sc.y < t.size * 4 && Math.abs(sc.x - t.x) < t.size * 25);
  const best = low.map((t) => ({ t, k: t.size * (withScale(t) ? 2 : 1) })).sort((a, b) => b.k - a.k)[0].t;
  if (!withScale(best)) {
    if (sheet.method === 'whole') return null;
    const sizes = texts.map((t) => t.size).sort((a, b) => a - b);
    if (best.size < (sizes[Math.floor(sizes.length / 2)] || 0) * 1.5) return null;
  }
  return String(best.t).trim().replace(/\s+/g, ' ');
}

// 도면번호를 네모 칸에 한 글자씩 쓴 경우: "M" "1" "0" "1" → "M-101"(붙임표가 칸 사이 선이라 글자가 없으면 글자와 숫자 사이에 넣는다)
export function joinCharCells(pieces) {
  const cs = (pieces || []).map((p) => String(p ?? '').trim().toUpperCase());
  if (cs.length < 3 || cs.some((c) => c.length !== 1 || !/[A-Z0-9-]/.test(c))) return null;
  const s = cs.join('');
  if (s.includes('-')) return normSheetNo(s);
  const m = /^([A-Z]{1,3})(\d{2,4}[A-Z]?)$/.exec(s);
  return m ? normSheetNo(`${m[1]}-${m[2]}`) : null;
}

// 도면번호 표기 맞추기: "A- 111" → "A-111", "A  - 951" → "A-951", "A-910-001", "A20-001", "A- 933(1)" → "A-933(1)"
const SHEET_NO_LOOSE = /^([A-Z]{1,3}\d{0,3})-(\d{1,4}[A-Z]?(?:-\d{1,4}[A-Z]?)?)(\(\d{1,2}\))?$/;
export function normSheetNo(s) {
  const raw = String(s || '').trim().toUpperCase().replace(/[‐–—]/g, '-');
  // 도곽에 "A", "20", "002"처럼 칸마다 따로 쓴 경우(사이 붙임표는 도곽 선) → "A20-002"
  const parts = /^([A-Z]{1,3})\s*(\d{1,3})\s+(\d{2,4}[A-Z]?)$/.exec(raw);
  if (parts) return `${parts[1]}${parts[2]}-${parts[3]}`;
  const t = raw.replace(/\s+/g, '');
  if (t.length > 16) return null;
  if (SHEET_NO.test(t)) return t;
  const m = SHEET_NO_LOOSE.exec(t);
  return m ? `${m[1]}-${m[2]}${m[3] || ''}` : null;
}

const LABEL_NO = /^(도\s*면\s*번\s*호|SHEET\s*NO\.?|DWG\.?\s*NO\.?|DRAWING\s*NO\.?|도면\s*번호\s*\/?\s*(SHEET|DWG)\.?\s*NO\.?)$/i;
const LABEL_TITLE = /^(도\s*면\s*명|도\s*면\s*이\s*름|SUBJECT\s*TITLE|DWG\.?\s*TITLE|DRAWING\s*TITLE|SHEET\s*TITLE|TITLE)$/i;
// 표제란의 다른 칸 이름(값이 여기서 끝난다)
const LABEL_ANY = /^(도\s*면\s*번\s*호|도\s*면\s*명|축\s*척|일\s*자|날\s*짜|설\s*계|검\s*토|심\s*사|승\s*인|작\s*성|제\s*도|공\s*사\s*명|설\s*계\s*명|주\s*기|비\s*고|SCALE|DATE|DRAWN|CHECK(ED)?|APPROVE[D]?|SUBMIT|DESIGN(ED)?|PROJECT(\s*TITLE)?|NOTE[S]?|REVISION|SHEET\s*NO\.?|DWG\.?\s*NO\.?|SUBJECT\s*TITLE|TITLE|.*(검토자|작업자|책임자|사무소\s*명|건축사)$)$/i;

/** 칸 이름 글자에서 값 읽기: 같은 줄 오른쪽에 값이 있으면 그것, 없으면 아래 줄(여러 줄 도면명은 이어 붙인다) */
function fromLabels(texts0, h) {
  const out = { sheetNo: null, title: null };
  // 글자 방향으로 돌려 읽기: 칸 이름 글자가 90°·270° 돌아가 있으면(세로로 놓은 도곽) 좌표를 같은 만큼 되돌린다
  const lab0 = texts0.find((t) => LABEL_NO.test(t.t.trim()) || LABEL_TITLE.test(t.t.trim()));
  const rot = (((lab0?.rot || 0) % 360) + 360) % 360;
  let texts = texts0;
  if (lab0 && Math.min(rot, 360 - rot) > 2) {
    const a = (-rot * Math.PI) / 180;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    texts = texts0.map((t) => ({ ...t, x: t.x * c - t.y * sn, y: t.x * sn + t.y * c }));
  }
  const isLabel = (s) => LABEL_ANY.test(s) || LABEL_NO.test(s) || LABEL_TITLE.test(s);
  const values = texts.filter((t) => t.t.trim() && !isLabel(t.t.trim()));
  const labelRows = texts.filter((t) => isLabel(t.t.trim()));
  const read = (re, accept) => {
    for (const lab of texts.filter((t) => re.test(t.t.trim())).sort((a, b) => a.x - b.x)) {
      const sz = Math.max(lab.size, h * 0.002);
      // 같은 줄 오른쪽(가까운 것부터) — 영문 칸 이름("SHEET NO.")은 건너뛴다
      const row = values.filter((t) => Math.abs(t.y - lab.y) < sz * 0.8 && t.x > lab.x && t.x - lab.x < sz * 40).sort((a, b) => a.x - b.x);
      const sameRow = row.map((t) => accept(t.t)).find(Boolean);
      if (sameRow) return sameRow;
      // 아래 줄: 이 칸 이름보다 아래, 다음 칸 이름 줄보다 위
      const nextLabelY = Math.max(...labelRows.filter((t) => t.y < lab.y - sz * 0.8 && Math.abs(t.x - lab.x) < sz * 12).map((t) => t.y), -Infinity);
      const below = values.filter((t) => t.y < lab.y - sz * 0.5 && t.y > nextLabelY + sz * 0.3 && t.y > lab.y - sz * 9 && t.x > lab.x - sz * 4)
        // 같은 줄(높이 차이가 글자 반 크기 안)은 왼쪽부터: "A", "20", "002"처럼 칸마다 따로 쓴 도면번호
        .sort((a, b) => (Math.abs(a.y - b.y) < Math.max(a.size, b.size) * 0.5 ? a.x - b.x : b.y - a.y));
      const lines = [];
      for (const t of below) {
        const prev = lines[lines.length - 1];
        if (prev && prev.y - t.y > Math.max(prev.size, t.size) * 3) break;
        if (prev && t.size < lines[0].size * 0.7) break;
        lines.push(t);
      }
      const v = accept(lines.map((t) => t.t.trim()).join(' '), lines);
      if (v) return v;
    }
    return null;
  };
  // 칸마다 따로 쓴 조각이 높낮이가 조금씩 달라도 읽는 방향(왼쪽→오른쪽) 순서로 한 번 더 붙여 본다
  out.sheetNo = read(LABEL_NO, (s, lines) => joinCharCells([...(lines || [])].sort((a, b) => a.x - b.x).map((t) => t.t))
    || normSheetNo(s)
    || normSheetNo([...(lines || [])].sort((a, b) => a.x - b.x).map((t) => t.t.trim()).join(' '))
    || (lines || []).map((t) => normSheetNo(t.t)).find(Boolean) || null);
  out.title = read(LABEL_TITLE, (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    return v && !normSheetNo(v) && !normScale(v) && /[가-힣A-Za-z]{2}/.test(v) && v.length <= 60 ? v : null;
  });
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

// 네 변을 따로 그린 테두리: 축에 나란한 긴 선들의 상자가 네 변 모두 선으로 덮이면(변 길이의 90% 이상)
function linesBorder(ents) {
  const hs = [];
  const vs = [];
  for (const e of ents) {
    if (e.type !== 'line') continue;
    const [[x1, y1], [x2, y2]] = [e.a || e.p1 || [], e.b || e.p2 || []];
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    if (Math.abs(y1 - y2) < 1e-6 * (Math.abs(x1 - x2) + 1)) hs.push([Math.min(x1, x2), Math.max(x1, x2), y1]);
    else if (Math.abs(x1 - x2) < 1e-6 * (Math.abs(y1 - y2) + 1)) vs.push([Math.min(y1, y2), Math.max(y1, y2), x1]);
  }
  if (hs.length < 2 || vs.length < 2) return null;
  const x0 = Math.min(...hs.map((h) => h[0]));
  const x1 = Math.max(...hs.map((h) => h[1]));
  const y0 = Math.min(...vs.map((v) => v[0]));
  const y1 = Math.max(...vs.map((v) => v[1]));
  const tol = (x1 - x0 + y1 - y0) * 1e-3;
  const cover = (list, at, lo, hi) => list.filter((l) => Math.abs(l[2] - at) < tol).reduce((a, l) => a + Math.max(0, Math.min(hi, l[1]) - Math.max(lo, l[0])), 0) >= (hi - lo) * 0.9;
  return x1 > x0 && y1 > y0 && cover(hs, y0, x0, x1) && cover(hs, y1, x0, x1) && cover(vs, x0, y0, y1) && cover(vs, x1, y0, y1) ? [x0, y0, x1, y1] : null;
}

/**
 * 블록의 테두리(블록 좌표): 가장 큰 축 정렬 사각형(닫힌 4점 선, 없으면 네 변 선)이 블록 개체의 90% 이상을 품을 때.
 * 블록 안에 멀리 떨어진 개체가 있어도 테두리로 잡으므로 삽입 상자가 수천 배로 커지지 않는다(45 지시서 1.2)
 */
export function blockBorder(dxf, name) {
  dxf._border ||= {};
  if (name in dxf._border) return dxf._border[name];
  dxf._border[name] = null;
  const ents = (dxf.blocks?.[name]?.entities || []).filter((e) => e.type !== 'attdef');
  let best = null;
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  for (const e of ents) { const r = rectOf(e); if (r && (!best || area(r) > area(best))) best = r; }
  const lb = linesBorder(ents);
  if (lb && (!best || area(lb) > area(best))) best = lb;
  if (!best || ents.length < 4) return null;
  const pad = (best[2] - best[0]) * 0.01;
  let inside = 0;
  let counted = 0;
  for (const e of ents) {
    const b = e.type === 'insert' ? null : entityBox(dxf, e); // 안쪽 블록(로고 등)은 세지 않는다
    if (!b) continue;
    counted++;
    const [cx, cy] = boxCenter(b);
    if (cx >= best[0] - pad && cx <= best[2] + pad && cy >= best[1] - pad && cy <= best[3] + pad) inside++;
  }
  // 90% 이상, 또는 개체가 적은 블록이면 바깥 개체가 둘 이하(멀리 떨어진 점 한두 개)
  dxf._border[name] = counted && (inside / counted >= 0.9 || (inside >= 3 && counted - inside <= 2)) ? best : null;
  return dxf._border[name];
}

// 도곽 삽입의 시트 범위: 블록 테두리가 있으면 그것을 옮긴 상자, 없으면 개체 상자
function frameBoxOf(dxf, e, box) {
  const b = dxf.blocks?.[e.name];
  const border = b && (e.rows || 1) === 1 && (e.cols || 1) === 1 ? blockBorder(dxf, e.name) : null;
  return border ? boxTransform(insertMatrix(e, b.base), border) : box;
}

// 개체 중심의 분위수(1~99%) 상자: 멀리 떨어진 개체 몇 개 때문에 틀이 커지지 않게(45 지시서 1.5). 개체가 적으면 null
function coreBox(boxes) {
  const cs = boxes.filter(Boolean).map(boxCenter);
  if (cs.length < 20) return null;
  // 양쪽 끝에서 적어도 하나씩은 뺀다(개체가 적어도 멀리 떨어진 것 하나는 빠지게)
  const lo = Math.max(1, Math.floor(cs.length * 0.01));
  const xs = cs.map((c) => c[0]).sort((a, b) => a - b);
  const ys = cs.map((c) => c[1]).sort((a, b) => a - b);
  const r = [xs[lo], ys[lo], xs[cs.length - 1 - lo], ys[cs.length - 1 - lo]];
  const gx = (r[2] - r[0]) * 0.1 || 1;
  const gy = (r[3] - r[1]) * 0.1 || 1;
  return [r[0] - gx, r[1] - gy, r[2] + gx, r[3] + gy];
}
const areaOf = (b) => (b[2] - b[0]) * (b[3] - b[1]);

// 멀리 떨어진 개체를 뺀 모형 공간 범위: 분위수 상자 안에 중심이 있는 개체들의 상자. 바깥 개체 때문에 범위가 4배 넘게 커질 때만 쓴다
function robustExtent(modelBoxes, extent) {
  const core = coreBox(modelBoxes.map((x) => x.box));
  if (!core || !boxOk(extent)) return extent;
  let r = emptyBox();
  for (const { box } of modelBoxes) if (box && inBox(core, ...boxCenter(box))) r = unionBox(r, box);
  if (!boxOk(r)) return extent;
  // 안쪽 개체 하나가 아주 길어도(구성선 등) 분위수 상자의 두 배까지만
  const cw = core[2] - core[0];
  const ch = core[3] - core[1];
  r = [Math.max(r[0], core[0] - cw / 2), Math.max(r[1], core[1] - ch / 2), Math.min(r[2], core[2] + cw / 2), Math.min(r[3], core[3] + ch / 2)];
  return areaOf(extent) > areaOf(r) * 4 ? r : extent;
}

function layoutBlockName(dxf, lay) {
  const rec = dxf.blockRecords?.[lay.blockRecord];
  if (rec?.name) return rec.name;
  // 배치 공간 블록 연결이 없으면 이름 순서로 짐작
  return null;
}

/**
 * @returns {Array<{ key: string, method: 'layout'|'titleblock'|'frame'|'rect'|'whole', space: 'model'|'paper', layoutName: string|null,
 *   frame: {x0,y0,x1,y1}, titleInsert: any|null, entities: any[], viewports: any[] }>}
 */
export function findSheets(dxf) {
  const sheets = [];
  const model = dxf.entities.filter((e) => !e.ps);
  const modelBoxes = boxesOf(dxf, model);
  const countIn = (b, self) => modelBoxes.filter((x) => x.box && x.e !== self && inBox(b, ...boxCenter(x.box))).length;

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
  const core = robustExtent(modelBoxes, extent); // 멀리 떨어진 개체 몇 개가 범위를 부풀리지 않게
  const extArea = boxOk(core) ? areaOf(core) : 0;
  const frames = [];
  // 도곽은 서로 크기가 비슷하다: 가장 큰 도곽의 1/5보다 작은 "도곽 이름 블록"(범례·작은 표제 등)은 뺀다.
  // (예전에는 모형 공간 전체의 2%를 기준으로 했는데, 한 파일에 시트 수십 장을 펼쳐 둔 실제 도서에서 도곽이 모두 빠졌다)
  const titled = modelBoxes.filter(({ e, box }) => box && isTitleInsert(dxf, e)).map(({ e, box }) => { const b = frameBoxOf(dxf, e, box); return { e, box: b, a: areaOf(b) }; });
  const maxA = Math.max(0, ...titled.map((t) => t.a));
  for (const { e, box, a } of titled) {
    if (a < maxA * 0.2 || (extArea && a < extArea * 0.0005)) continue;
    if (!ratioOk(box[2] - box[0], box[3] - box[1]) && extArea && a < extArea * 0.02) continue; // A판 비율이 아니면 예전 기준
    frames.push({ box, title: e, method: 'titleblock' });
  }
  // ②' 이름·속성 없는 도곽: 같은 블록을 2번 이상 삽입했고, 블록에 테두리가 있고, 삽입마다 A판 비율이며 안에 개체가 충분한 것.
  // 축척이 다른 시트(크기가 다른 삽입)도 같은 블록이면 같은 무리다
  const byName = new Map();
  for (const { e } of modelBoxes) {
    if (e.type !== 'insert' || (e.rows || 1) > 1 || (e.cols || 1) > 1 || frames.some((f) => f.title === e)) continue;
    if (!byName.has(e.name)) byName.set(e.name, []);
    byName.get(e.name).push(e);
  }
  const repeated = [];
  for (const [name, list] of byName) {
    if (list.length < 2 || !blockBorder(dxf, name)) continue;
    for (const e of list) {
      const box = frameBoxOf(dxf, e, null);
      if (!box || !ratioOk(box[2] - box[0], box[3] - box[1]) || countIn(box, e) < 20) continue;
      repeated.push({ box, title: e, method: 'frame' });
    }
  }
  // 다른 도곽 안에 든 것(상세 칸 표 등)과 가장 큰 도곽의 1/5보다 짧은 것은 뺀다
  const side = (b) => Math.max(b[2] - b[0], b[3] - b[1]);
  const maxSide = Math.max(0, ...[...frames, ...repeated].map((f) => side(f.box)));
  for (const r of repeated) {
    if (side(r.box) < maxSide * 0.2) continue;
    if ([...frames, ...repeated].some((o) => o !== r && boxContains(o.box, r.box, side(r.box) * 0.01) && !boxContains(r.box, o.box))) continue;
    frames.push(r);
  }
  // ③ A판 비율 큰 직사각형: 도곽을 하나도 못 찾았을 때만, 가장 큰 사각형의 절반보다 큰 것만(일람표의 작은 칸이 시트가 되지 않게)
  if (!frames.length) {
    const rects = [];
    for (const { e } of modelBoxes) {
      const r = rectOf(e);
      if (!r || !ratioOk(r[2] - r[0], r[3] - r[1])) continue;
      if (countIn(r, e) >= 20) rects.push({ box: r, title: null, method: 'rect' });
    }
    const maxRect = Math.max(0, ...rects.map((r) => side(r.box)));
    for (const r of rects) {
      if (side(r.box) <= maxRect * 0.5) continue;
      if (!rects.some((o) => o !== r && boxContains(o.box, r.box) && !boxContains(r.box, o.box))) frames.push(r);
    }
  }
  // 읽는 순서: 줄(세로로 절반 넘게 겹치는 시트끼리) 위에서 아래로, 줄 안에서 왼쪽부터
  const rows = [];
  for (const f of [...frames].sort((a, b) => b.box[3] - a.box[3])) {
    const h = f.box[3] - f.box[1];
    const row = rows.find((r) => r.some((o) => Math.min(o.box[3], f.box[3]) - Math.max(o.box[1], f.box[1]) > Math.min(h, o.box[3] - o.box[1]) * 0.5));
    if (row) row.push(f); else rows.push([f]);
  }
  frames.splice(0, frames.length, ...rows.flatMap((r) => r.sort((a, b) => a.box[0] - b.box[0])));
  const used = new Set();
  const parts = frames.map(() => []);
  frames.forEach((f, i) => {
    for (const { e, box } of modelBoxes) {
      if (used.has(e)) continue;
      const c = box ? boxCenter(box) : null;
      if (e === f.title || (c && inBox(f.box, c[0], c[1]))) { parts[i].push(e); used.add(e); }
    }
  });
  // 도곽 밖으로 삐져나온 삽입(외부 참조 평면 등): 삽입 기준점이 든 시트, 없으면 가장 많이 겹치는 시트(45 지시서 1.4)
  if (frames.length) {
    for (const { e, box } of modelBoxes) {
      if (used.has(e) || e.type !== 'insert' || !box) continue;
      let i = frames.findIndex((f) => e.at && inBox(f.box, e.at[0], e.at[1]));
      if (i < 0) {
        let best = 0;
        frames.forEach((f, k) => {
          const ov = Math.max(0, Math.min(f.box[2], box[2]) - Math.max(f.box[0], box[0])) * Math.max(0, Math.min(f.box[3], box[3]) - Math.max(f.box[1], box[1]));
          if (ov > best) { best = ov; i = k; }
        });
      }
      if (i >= 0) { parts[i].push(e); used.add(e); }
    }
  }
  frames.forEach((f, i) => {
    sheets.push({ key: `${f.method}:${i}`, method: f.method, space: 'model', layoutName: null, frame: toFrame(f.box), titleInsert: f.title, entities: parts[i], viewports: [] });
  });

  // ④ 아무것도 못 찾으면 모형 공간 전체 = 한 장(틀은 멀리 떨어진 개체를 뺀 범위)
  if (!sheets.length && boxOk(extent)) {
    sheets.push({ key: 'whole:0', method: 'whole', space: 'model', layoutName: null, frame: toFrame(core), titleInsert: null, entities: model, viewports: [] });
  }
  return sheets;
}

// 배치 공간 뷰포트: 모형 좌표 → 종이 좌표 행렬과 모형 범위. 뷰 중심(vc)은 보는 점(tg)에서 잰 값이라 모형 중심 = tg + vc
const viewCenter = (v) => [(v.tg?.[0] || 0) + v.vc[0], (v.tg?.[1] || 0) + v.vc[1]];
export function viewportMatrix(v) {
  const s = v.hgt / v.vh;
  const [cx, cy] = viewCenter(v);
  return [s, 0, 0, s, v.c[0] - cx * s, v.c[1] - cy * s];
}
export function viewportModelBox(v) {
  const s = v.vh / v.hgt;
  const [cx, cy] = viewCenter(v);
  return [cx - (v.w / 2) * s, cy - (v.hgt / 2) * s, cx + (v.w / 2) * s, cy + (v.hgt / 2) * s];
}
export function viewportPaperBox(v) {
  return [v.c[0] - v.w / 2, v.c[1] - v.hgt / 2, v.c[0] + v.w / 2, v.c[1] + v.hgt / 2];
}

export { mul, ID };
