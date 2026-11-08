// 규칙으로 읽기(AI 없이 항상 동작, 03 7절): 시트 요약(digest)에서 AI 추출과 같은 모양의 결과를 만든다.
// 위치는 시트 좌표(AI 결과도 저장할 때 시트 좌표로 바꾼다). 신뢰도는 낮게, method: 'rule'.
import { layerRolesFor } from '../cad/layer-names.js';
import { headerColumns } from '../cad/tables.js';
import { parseComposition } from './materials-ko.js';
import { extractKindFor } from './ai-schemas.js';
import { readSection } from './read-section.js';
import { readDetails } from './read-detail.js';
import { readStructure } from './read-structure.js';

export const ROOM_WORDS = [
  ['거실', 'living'], ['침실', 'bedroom'], ['안방', 'bedroom'], ['주방', 'kitchen'], ['식당', 'kitchen'], ['욕실', 'bath'], ['화장실', 'bath'],
  ['부부욕실', 'bath'], ['발코니', 'balcony'], ['실외기실', 'balcony'], ['드레스룸', 'dress'], ['파우더', 'dress'], ['다용도실', 'utility'],
  ['현관', 'hall'], ['복도', 'hall'], ['홀', 'hall'], ['대피공간', 'other'], ['계단실', 'other'], ['승강기', 'other'], ['필로티', 'other'],
  ['피트니스', 'other'], ['도서관', 'other'], ['관리사무소', 'other'], ['경로당', 'other'], ['어린이집', 'other'], ['라운지', 'other'], ['창고', 'utility'],
  ['ALPHA', 'other'], ['펜트리', 'utility'], ['팬트리', 'utility'],
];
export function roomUse(name) {
  const s = String(name || '');
  for (const [w, u] of ROOM_WORDS) if (s.includes(w)) return u;
  return 'other';
}
export const isRoomName = (s) => {
  const t = String(s || '').trim();
  return t.length <= 12 && ROOM_WORDS.some(([w]) => t.includes(w)) && !/[㎡]|\d{3,}/.test(t);
};

export const WALL_TAG = /^W\d{1,2}[A-Z]?$/;
export const DOOR_TAG = /^(WD|SD|FD|AD|SSD|D)\d{1,2}[A-Z]?$/;
export const WINDOW_TAG = /^(AW|PW|SW|BW|CW|AL|PL|W[A-Z])\d{1,2}[A-Z]?$/;
export const FINISH_TAG = /^(F|C|B)\d{1,2}$/;
export function tagKind(code) {
  const s = String(code || '').trim();
  if (WALL_TAG.test(s)) return 'wall';
  if (DOOR_TAG.test(s)) return 'door';
  if (WINDOW_TAG.test(s)) return 'window';
  if (FINISH_TAG.test(s)) return 'finish';
  return null;
}

const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- 종류별

function levelsFrom(texts) {
  const out = [];
  for (const t of texts) {
    const m = /^(B\d+F?|\d+F|RF|PH|지붕층?|옥탑|지하\s*\d+층|\d+층)\s*(?:(FL|SL|EL|GL)\s*)?([+＋\-−±]?)\s*([\d,]+(?:\.\d+)?)?$/i.exec(t.t.replace(/\s+/g, ' ').trim());
    if (!m || (!m[2] && m[4] == null && !/±/.test(m[3]))) continue;
    const name = m[1].replace(/\s/g, '').toUpperCase().replace(/^(\d+)층$/, '$1F').replace(/^지하(\d+)층$/, 'B$1');
    let e = m[4] ? Number(m[4].replace(/,/g, '')) : 0;
    if (/[-−]/.test(m[3])) e = -e;
    if (!out.some((l) => l.name === name)) out.push({ name, elevationMm: e });
  }
  out.sort((a, b) => a.elevationMm - b.elevationMm);
  const typicalH = (() => {
    const hs = out.slice(0, -1).map((l, i) => out[i + 1].elevationMm - l.elevationMm).filter((h) => h > 0).sort((a, b) => a - b);
    return hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  })();
  const levels = out.map((l, i) => {
    const next = out[i + 1];
    const heightMm = next ? next.elevationMm - l.elevationMm : null;
    let kind = 'typical';
    if (/^B\d/.test(l.name) || l.elevationMm < 0) kind = 'basement';
    else if (/^(RF|PH|지붕|옥탑)/.test(l.name)) kind = 'rooftop';
    else if (i === out.findIndex((x) => x.elevationMm >= 0) && heightMm && typicalH && heightMm >= typicalH * 1.3) kind = 'pilotis';
    return { name: l.name, elevationMm: l.elevationMm, heightMm, kind };
  });
  return levels;
}

function levelExtract(d, sheet) {
  const levels = levelsFrom(d.texts);
  const above = levels.filter((l) => /^\d+F$/.test(l.name)).length;
  const below = levels.filter((l) => l.kind === 'basement').length;
  const top = levels.length ? levels[levels.length - 1].elevationMm : null;
  return {
    building: sheet.refs?.buildings?.[0] || null,
    levels,
    floorsAbove: above || null,
    floorsBelow: below,
    totalHeightMm: top,
    notes: '규칙: 레벨 표기 글자(15F FL+42,200 등)에서 읽음',
  };
}

function sitePlanExtract(d) {
  const labels = d.texts.filter((t) => /^\d{2,4}\s*동$/.test(t.t.trim()) || /(주민\s*공동|커뮤니티|공동시설|관리동|경로당|어린이집|피트니스|상가|근린)/.test(t.t));
  const floorTexts = d.texts.filter((t) => /지상\s*\d+\s*층/.test(t.t));
  const buildings = labels.map((t) => {
    const f = floorTexts.filter((x) => near(x, t) < Math.max(t.size, x.size) * 6).sort((a, b) => near(a, t) - near(b, t))[0];
    const label = t.t.replace(/\s+/g, '').trim();
    return {
      label,
      kind: /동$/.test(label) ? 'apartment' : /상가|근린/.test(label) ? 'commercial' : 'community',
      outlineHandles: null,
      labelPos: [t.x, t.y],
      floorsText: f ? f.t.trim() : null,
      confidence: 0.5,
    };
  });
  return { buildings, roads: [], northDeg: null, boundaryHint: null };
}

function planTags(texts) {
  const tags = [];
  for (const t of texts) {
    const code = t.t.trim();
    const kind = tagKind(code);
    if (kind) tags.push({ code, kind, pos: [t.x, t.y], rot: t.rot ?? 0 });
  }
  return tags;
}

function roomsOf(texts, roles) {
  return texts.filter((t) => (roles[t.layer] === 'room_name' || isRoomName(t.t)) && isRoomName(t.t)).map((t) => ({ name: t.t.trim(), use: roomUse(t.t), labelPos: [t.x, t.y], _size: t.size }));
}

function floorPlanExtract(d, roles) {
  const texts = d.texts;
  const lineTexts = texts.filter((t) => /^(\d{1,2})\s*호(\s*라인)?$/.test(t.t.trim()));
  const typeTexts = texts.filter((t) => /^\d{2,3}[A-Z]{1,2}\d?$/.test(t.t.trim()));
  const units = lineTexts.map((t) => {
    const ty = typeTexts.filter((x) => Math.abs(x.x - t.x) < t.size * 3).sort((a, b) => near(a, t) - near(b, t))[0];
    return { line: /^(\d{1,2})/.exec(t.t.trim())[1], unitType: ty ? ty.t.trim() : null, labelPos: [t.x, t.y] };
  });
  for (const ty of typeTexts) if (!units.some((u) => u.unitType === ty.t.trim() && Math.abs(u.labelPos[0] - ty.x) < ty.size * 3)) units.push({ line: null, unitType: ty.t.trim(), labelPos: [ty.x, ty.y] });
  const cores = texts.filter((t) => /계단/.test(t.t) || /승강기|엘리베이터|^E\.?V$/i.test(t.t.trim())).map((t) => ({ kind: /계단/.test(t.t) ? 'stair' : 'elevator', pos: [t.x, t.y] }));
  return { rooms: roomsOf(texts, roles).map(({ _size, ...r }) => r), units, tags: planTags(texts), cores, notes: '규칙: 실명 사전·기호 패턴으로 읽음' };
}

function unitPlanExtract(d, roles, sheet) {
  const rooms = roomsOf(d.texts, roles).map((r) => {
    const area = d.texts.filter((t) => /^\d+(\.\d+)?\s*(㎡|m2|m²)$/i.test(t.t.trim()) && Math.abs(t.x - r.labelPos[0]) < r._size * 3 && t.y < r.labelPos[1] && r.labelPos[1] - t.y < r._size * 3)
      .sort((a, b) => Math.abs(a.y - r.labelPos[1]) - Math.abs(b.y - r.labelPos[1]))[0];
    const { _size, ...rest } = r;
    return { ...rest, areaText: area ? area.t.trim() : null };
  });
  const areaM = d.texts.map((t) => /전용\s*면적\s*([\d.]+)/.exec(t.t)).find(Boolean);
  const typeName = sheet.refs?.unitTypes?.[0] || (/(\d{2,3}[A-Z]{1,2})/.exec(sheet.title || '') || [])[1] || '';
  return { typeName, areaM2: areaM ? Number(areaM[1]) : null, rooms, tags: planTags(d.texts), waterproofRooms: [], notes: '규칙: 실명 사전·기호 패턴으로 읽음' };
}

function finishExtract(d) {
  const assemblies = [];
  const rooms = [];
  for (const t of d.tables || []) {
    const wall = headerColumns(t.rows, { code: /^기호|^부호|CODE/i, name: /명칭|구분|종류|NAME/i, comp: /구성|상세|재료|LAYER/i, thick: /두께|THK/i });
    if (wall && wall.cols.code != null && wall.cols.comp != null) {
      for (const row of t.rows.slice(wall.row + 1)) {
        const code = (row[wall.cols.code] || '').trim();
        if (!/^[A-Z]{1,3}-?\d{1,3}[A-Z]?$/.test(code)) continue;
        const kind = /^W/.test(code) ? 'wall' : /^F/.test(code) ? 'floor' : /^C/.test(code) ? 'ceiling' : /^R/.test(code) ? 'roof' : 'wall';
        assemblies.push({ code, kind, name: (row[wall.cols.name] || '').trim() || code, layers: parseComposition(row[wall.cols.comp]) });
      }
      continue;
    }
    const fin = headerColumns(t.rows, { room: /^실\s*명|^실$|ROOM/i, types: /타입|TYPE|적용/i, floor: /바닥|FLOOR/i, base: /걸레|BASE/i, wall: /^벽|WALL/i, ceiling: /천장|천정|CEIL/i, wp: /방수|비고|REMARK/i });
    if (fin && fin.cols.room != null && (fin.cols.floor != null || fin.cols.wall != null)) {
      for (const row of t.rows.slice(fin.row + 1)) {
        const name = (row[fin.cols.room] || '').trim();
        if (!name) continue;
        const cell = (k) => (fin.cols[k] != null ? (row[fin.cols[k]] || '').trim() || null : null);
        const types = (cell('types') || '').split(/[,，、·/\s]+/).filter(Boolean);
        const zones = [];
        if (/방수/.test(cell('wp') || '')) zones.push('waterproof');
        rooms.push({ roomName: name, unitTypes: types, floor: cell('floor'), base: cell('base'), wall: cell('wall'), ceiling: cell('ceiling'), zones });
      }
    }
  }
  return { assemblies, rooms, notes: '규칙: 표 머리글(기호·구성 / 실명·바닥·벽·천장)로 읽음' };
}

function windowExtract(d) {
  const items = [];
  for (const t of d.tables || []) {
    const h = headerColumns(t.rows, { code: /^기호|^부호|CODE|^NO/i, kind: /구분|종류|TYPE/i, w: /^폭|너비|^W$|WIDTH/i, h: /높이|^H$|HEIGHT/i, sill: /창대|SILL/i, mat: /재질|재료|MATERIAL/i, count: /수량|개수|QTY/i });
    if (!h || h.cols.code == null || h.cols.w == null) continue;
    for (const row of t.rows.slice(h.row + 1)) {
      const code = (row[h.cols.code] || '').trim();
      const kind = tagKind(code);
      if (kind !== 'door' && kind !== 'window') continue;
      const n = (k) => { const v = h.cols[k] != null ? Number(String(row[h.cols[k]] || '').replace(/[,\s]/g, '')) : NaN; return Number.isFinite(v) && String(row[h.cols[k]] || '').trim() !== '' ? v : null; };
      const kc = h.cols.kind != null ? row[h.cols.kind] : '';
      items.push({ code, kind: /문|DOOR/i.test(kc) ? 'door' : /창|WIN/i.test(kc) ? 'window' : kind, widthMm: n('w'), heightMm: n('h'), sillMm: n('sill'), material: h.cols.mat != null ? (row[h.cols.mat] || '').trim() || null : null, count: n('count') });
    }
  }
  return { items };
}

// 외부 마감표: 기호·재료·색·부위(21 지시서 2절)
function exteriorExtract(d) {
  const items = [];
  for (const t of d.tables || []) {
    const h = headerColumns(t.rows, { code: /^기호|^부호|CODE/i, material: /재료|마감|MATERIAL/i, color: /색상?|COLOR/i, part: /부위|위치/i });
    if (!h || h.cols.code == null || h.cols.material == null) continue;
    for (const row of t.rows.slice(h.row + 1)) {
      const code = String(row[h.cols.code] || '').trim().toUpperCase();
      if (!/^[A-Z]{1,3}-?\d+[A-Z]?$/.test(code)) continue;
      const hex = /#[0-9A-F]{6}/i.exec(String(h.cols.color != null ? row[h.cols.color] : ''))?.[0] || null;
      items.push({ code, material: String(row[h.cols.material] || '').trim(), color: hex, part: h.cols.part != null ? String(row[h.cols.part] || '').trim() : null });
    }
  }
  return { items };
}

/**
 * @param {{ category: string, refs: any, title?: string }} sheet
 * @param {any} digest
 * @returns {{ layerRoles: Record<string,string>, legend: any[], extracted: any|null }}
 */
export function ruleRead(sheet, digest, { layerProfile = {} } = {}) {
  const layerRoles = layerRolesFor(digest.layers || [], layerProfile);
  const kind = extractKindFor(sheet);
  let data = null;
  if (kind === 'LevelExtract') data = levelExtract(digest, sheet);
  else if (kind === 'SitePlanExtract') data = sitePlanExtract(digest);
  else if (kind === 'FloorPlanExtract') data = floorPlanExtract(digest, layerRoles);
  else if (kind === 'UnitPlanExtract') data = unitPlanExtract(digest, layerRoles, sheet);
  else if (kind === 'FinishScheduleExtract') data = finishExtract(digest);
  else if (kind === 'WindowScheduleExtract') data = windowExtract(digest);
  else if (kind === 'ExteriorFinishExtract') data = exteriorExtract(digest);
  else if (kind === 'SectionDetailExtract') data = readSection(digest, sheet);
  else if (kind === 'ConstructionDetailExtract') data = readDetails(digest);
  else if (kind === 'StructureScheduleExtract') data = readStructure(digest);
  return {
    layerRoles,
    legend: (digest.legend || []).map((l) => ({ symbol: l.symbol, meaning: l.text })),
    extracted: data ? { kind, source: 'rule', coords: 'sheet', data } : null,
  };
}
