// 세대 부위별 계산(42 지시서 2~4절): 순수 함수(three.js 없이 Node 시험). 3D 그리기·정보 패널·성적표가 같이 쓴다.
//   spaceLabel()   이름 없는 실의 화면 글자            slabPolygon()  세대 바닥판 외곽
//   strayWalls()   떠 있는 벽 조각(확인 필요)           floorStack()·ceilingStack()·wallStack()  부위의 층 구성(근거 순서: 상세 → 마감표 → 기본값)
//   stackTag()     "콘크리트 200 · 단열재 100 · 석고보드 9.5×2 · 실크벽지"      unitKinds()  세대에 든 자재 종류 목록(수량·출처)
// 기본값은 모델에 저장하지 않는다(38 지시서: 값이 없으면 넣지 않는다). 여기서 계산해 화면에만 "기본값"으로 보인다.
import { material, materialId, materialKind, kindInfo, PARTS } from './materials-ko.js';
import { wallLayers, finishResolver, wallPieces } from './mesh-calc.js';
import { hull, pointInPolygon, centroid, area as polyArea } from '../cad/geom.js';

export const SMALL_ROOM_M2 = 1.5; // 이보다 작은 실의 이름표는 고르거나 마우스를 올렸을 때만
export const spaceLabel = (sp) => (!sp?.name || sp.name === 'unnamed' ? '이름 없는 실' : sp.name);
export const DEFAULT_SLAB_MM = 210;
export const DEFAULT_CEILING_MM = 2300;

const WET = (sp) => sp.use === 'bath';
const OUTSIDE_ROOM = (sp) => sp.use === 'balcony' || /발코니|실외기실|대피공간|다용도실/.test(sp.name || '');
const SHAFT = (sp) => /^(E?PS|AD|TPS|PD|DS|DA)\s*-?\d{0,2}$/i.test(String(sp.name || '').trim());

// ---------------------------------------------------------------- 출처

/** 조립체·실 출처 → { label: '상세 A-302' | '마감표 A-601' | '벽체 상세 A-501' | '기본값' | '직접 입력', assumed, sheetId } */
export function sourceOf(assembly) {
  const s = assembly?.source || {};
  const sh = (s.sheets || [])[0] || {};
  const no = sh.sheetNo || '';
  const id = String(assembly?.id || '');
  if (!assembly || s.method === 'assumed') return { label: '기본값', assumed: true, sheetId: null };
  if (s.method === 'manual') return { label: '직접 입력', assumed: false, sheetId: sh.sheetId || null };
  if (s.method === 'doc') return { label: `문서${s.docs?.[0]?.docName ? ` ${s.docs[0].docName}` : ''}`, assumed: false, sheetId: null };
  const what = /^as_(fl|cl|dt)_/.test(id) ? '상세' : /^as_[fwc]_/.test(id) ? '마감표' : assembly.kind === 'wall' ? '벽체 상세' : '도면';
  return { label: `${what}${no ? ` ${no}` : ''}`, assumed: false, sheetId: sh.sheetId || null };
}
const ASSUMED = { label: '기본값', assumed: true, sheetId: null };

// ---------------------------------------------------------------- 층 구성

const mmText = (v) => (v == null ? '' : String(Math.round(v * 10) / 10));
function layerOf(name, mm, part, source, extra = {}) {
  const m = material(name);
  return { name: m.name, materialId: extra.materialId || materialId(m.name), category: extra.category || m.category, color: extra.color || m.color, mm: mm ?? m.thicknessMm ?? null, kind: extra.kind || materialKind(m.name, part), source, ...(extra.slab ? { slab: true } : {}), ...(extra.side ? { side: extra.side } : {}) };
}
const fromAssembly = (asm, mats, part) => {
  const src = sourceOf(asm);
  return (asm?.layers || []).map((l) => {
    const m = mats.get(l.materialId);
    const slab = part === 'floor' && l.side === 'core';
    return layerOf(m?.name || '재료', l.thicknessMm, part, src, { materialId: l.materialId, category: m?.category, color: m?.color, slab, kind: slab ? 'floor.slab' : undefined });
  });
};
const index = (catalog) => ({ mats: new Map((catalog?.materials || []).map((m) => [m.id, m])), asm: new Map((catalog?.assemblies || []).map((a) => [a.id, a])) });

// 기본 바닥 구성(도면에 없을 때만, 위 → 아래). 표준바닥구조(완충재 + 경량기포 + 방통)를 따른 흔한 값
const FLOOR_DEFAULT = {
  dry: ['방통 몰탈 40', '경량기포콘크리트 40', '완충재 30'],
  wet: ['시멘트몰탈 40', '액체방수 2'],
  outside: ['시멘트몰탈 30', '액체방수 2'],
  shaft: [],
};
const FLOOR_FINISH_DEFAULT = { living: '강마루 8', bedroom: '강마루 8', kitchen: '강마루 8', dress: '강마루 8', bath: '자기질타일 10', balcony: '자기질타일 10', hall: '타일 10', utility: '타일 10', other: '바닥 마감 10' };

/**
 * 실 바닥의 층 구성(위 → 아래, 마지막이 구조 슬래브).
 * 근거 순서: 1) 단면·부분 상세의 바닥 구성(space.floorAssemblyId)  2) 마감표의 바닥 마감 + 기본 바탕  3) 기본값
 * @returns {{ layers: any[], buildMm: number, slabMm: number, assumed: boolean }}
 */
export function floorStack(type, catalog, space, { level = null } = {}) {
  const { mats, asm } = index(catalog);
  const detail = asm.get(space.floorAssemblyId);
  let layers = [];
  if (detail?.layers?.length) layers = fromAssembly(detail, mats, 'floor');
  else if (!SHAFT(space)) {
    const fin = asm.get(space.finish?.floor);
    const top = fin?.layers?.length ? fromAssembly(fin, mats, 'floor') : [layerOf(FLOOR_FINISH_DEFAULT[space.use] || FLOOR_FINISH_DEFAULT.other, null, 'floor', ASSUMED, { kind: 'floor.finish' })];
    // 마감표의 마감이 몰탈 한 가지(실외기실 "시멘트몰탈")면 그것이 바탕까지다
    const onlyScreed = top.length === 1 && top[0].kind === 'floor.screed';
    const group = WET(space) ? 'wet' : OUTSIDE_ROOM(space) ? 'outside' : 'dry';
    const under = (onlyScreed ? FLOOR_DEFAULT[group].filter((n) => !/몰탈/.test(n)) : FLOOR_DEFAULT[group]).map((n) => layerOf(n, null, 'floor', ASSUMED));
    layers = [...top, ...under];
    // 방수 부위인데 방수 층이 없으면 바탕 아래에 방수(가정)
    if ((space.zones || []).includes('waterproof') && !layers.some((l) => l.kind === 'floor.waterproof')) layers.push(layerOf('액체방수 2', null, 'floor', ASSUMED));
  }
  let slab = layers.find((l) => l.slab);
  if (!slab) {
    // 슬래브 두께: 실에 붙은 구조 평면 슬래브(43 지시서 3절) → 레벨(구조 평면·단면) → 세대 단면 → 기본값
    const st = space.structure?.thicknessMm ? space.structure : level?.slabMm && level.slabSource ? { ...level.slabSource, thicknessMm: level.slabMm } : null;
    const mm = st?.thicknessMm || level?.slabMm || type?.section?.slabMm || null;
    const src = st ? { label: `구조 ${st.sheetNo || ''}`.trim(), assumed: false, sheetId: st.sheetId || null }
      : mm ? { label: type?.section?.sheetNo ? `단면 ${type.section.sheetNo}` : '단면', assumed: false, sheetId: type?.section?.sheetId || null } : ASSUMED;
    slab = layerOf('콘크리트', mm || DEFAULT_SLAB_MM, 'floor', src, { slab: true, kind: 'floor.slab' });
    layers.push(slab);
  }
  layers = [...layers.filter((l) => !l.slab), slab];
  const buildMm = layers.filter((l) => !l.slab).reduce((s, l) => s + (l.mm || 0), 0);
  return { layers, buildMm, slabMm: slab.mm, assumed: layers.every((l) => l.source.assumed) };
}

/**
 * 실 천장의 층 구성(위 → 아래: 천장틀 → 판 → 마감).
 * 근거 순서: 1) 상세의 천장 구성(space.ceilingAssemblyId)  2) 마감표의 천장 마감(+ 판이 있으면 천장틀 가정)  3) 기본값
 * @returns {{ layers: any[], ceilingMm: number, ceilingAssumed: boolean, assumed: boolean }}
 */
export function ceilingStack(type, catalog, space) {
  const { mats, asm } = index(catalog);
  const detail = asm.get(space.ceilingAssemblyId);
  let layers = [];
  if (detail?.layers?.length) layers = fromAssembly(detail, mats, 'ceiling');
  else if (!SHAFT(space)) {
    const fin = asm.get(space.finish?.ceiling);
    if (fin?.layers?.length) {
      layers = fromAssembly(fin, mats, 'ceiling');
      // 판(석고보드·텍스)을 다는 천장인데 틀이 없으면 천장틀(가정). 도장만이면 슬래브 밑 직접 마감
      if (layers.some((l) => l.kind === 'ceiling.board' || /텍스|SMC/.test(l.name)) && !layers.some((l) => l.kind === 'ceiling.frame')) layers.unshift(layerOf('천장틀(M-BAR) 38', null, 'ceiling', ASSUMED));
    } else if (OUTSIDE_ROOM(space)) layers = [layerOf('수성페인트', null, 'ceiling', ASSUMED)];
    else layers = [layerOf('천장틀(M-BAR) 38', null, 'ceiling', ASSUMED), layerOf(WET(space) ? '방습석고보드 9.5' : '석고보드 9.5', null, 'ceiling', ASSUMED), layerOf(WET(space) ? '수성페인트' : '천장지', null, 'ceiling', ASSUMED)];
  }
  return { layers, ceilingMm: space.ceilingMm || DEFAULT_CEILING_MM, ceilingAssumed: !space.ceilingMm, assumed: layers.every((l) => l.source.assumed) };
}

/** 벽의 층 구성(실외·반대쪽 → 구조 → 실내 쪽). 실 마감이 있으면 그쪽 겉 층은 실 마감(마감표) */
export function wallStack(wall, type, catalog) {
  const { mats, asm } = index(catalog);
  const a = asm.get(wall.assemblyId);
  const fin = finishResolver(type, catalog)(wall);
  const src = sourceOf(a);
  const spaces = new Map((type.spaces || []).map((s) => [s.id, s]));
  const finSrc = (side) => sourceOf(asm.get(spaces.get(wall.sides?.[side])?.finish?.wall));
  const L = wallLayers(wall, a, mats, { finishIn: fin.in, finishOut: fin.out });
  const raw = new Map((a?.layers || []).map((l) => [l.materialId, l.thicknessMm]));
  const layers = L.map((l, i) => {
    const m = mats.get(l.materialId);
    const swapped = (i === L.length - 1 && fin.in && l.materialId === fin.in.materialId && !raw.has(l.materialId)) || (i === 0 && fin.out && l.materialId === fin.out.materialId && !raw.has(l.materialId));
    // 두께: 조립체에 적힌 값, 조립체가 없는 벽의 구조체는 도면 두께
    const mm = raw.get(l.materialId) ?? (l.side === 'core' ? Math.round((l.o1 - l.o0) * 10000) / 10 : null);
    return layerOf(m?.name || (l.category === 'structure' ? '콘크리트' : '재료'), mm, 'wall', swapped ? finSrc(i === 0 ? 'out' : 'in') : src, { materialId: l.materialId || undefined, category: l.category, color: m?.color, side: l.side });
  });
  return { layers, thicknessMm: Math.round(wall.thickness * 1000), assumed: src.assumed };
}

/** 벽의 구조 부재: 벽에 붙은 것(구조 평면 기호, 43 지시서 3절) → 없으면 벽체 조립체에 붙은 것(같은 두께 기호가 하나뿐일 때, 38 지시서) */
export function structureOf(wall, catalog) {
  if (wall?.structure?.mark) return { ...wall.structure, by: 'wall' };
  const a = (catalog?.assemblies || []).find((x) => x.id === wall?.assemblyId);
  return a?.structure?.mark ? { ...a.structure, by: 'assembly' } : null;
}
/** 구조 꼬리표: "구조 W1 200 (S-101)" */
export function structTag(st) {
  if (!st?.mark) return '';
  return `구조 ${st.mark}${st.thicknessMm ? ` ${mmText(st.thicknessMm)}` : ''}${st.sheetNo ? ` (${st.sheetNo})` : ''}`;
}

const THIN = /페인트|도장|벽지|도배|천[장정]s*지|필름/; // 얇은 마감은 두께를 적지 않는다
/** 층 구성 꼬리표: "콘크리트 200 · 단열재(비드법 2종) 100 · 석고보드 9.5×2 · 실크벽지". 1mm 안 되는 마감은 두께를 적지 않는다 */
export function stackTag(layers) {
  const out = [];
  for (const l of layers) {
    const last = out[out.length - 1];
    if (last && last.name === l.name && last.mm === l.mm) { last.n++; continue; }
    out.push({ name: l.name, mm: l.mm, n: 1 });
  }
  return out.map((l) => `${l.name}${l.mm != null && l.mm >= 1 && !THIN.test(l.name) ? ` ${mmText(l.mm)}` : ''}${l.n > 1 ? `×${l.n}` : ''}`).join(' · ');
}

// ---------------------------------------------------------------- 세대 바닥판·떠 있는 벽

const centerOf = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
const grow = (poly, d) => { const c = centerOf(poly); return poly.map((p) => { const L = Math.hypot(p[0] - c[0], p[1] - c[1]) || 1; return [p[0] + ((p[0] - c[0]) / L) * d, p[1] + ((p[1] - c[1]) / L) * d]; }); };

/** 세대가 차지하는 자리(실들의 볼록 외곽). 이름 있는 실이 있으면 그것만(도면 밖 잔선이 만든 이름 없는 칸을 빼려고) */
export function unitEnvelope(type) {
  const named = (type.spaces || []).filter((s) => s.name !== 'unnamed' && s.polygon?.length > 2);
  const use = named.length ? named : (type.spaces || []).filter((s) => s.polygon?.length > 2);
  const pts = use.flatMap((s) => s.polygon);
  return pts.length >= 3 ? hull(pts) : (type.outline || []);
}

// 다각형을 바깥으로 d만큼 넓히기(꼭짓점마다 두 변 법선의 이음, 뾰족한 모서리는 4d까지만). 가로세로 실에 맞는 간단한 방법
export function offsetPolygon(poly, d) {
  const n = poly.length;
  if (n < 3) return poly;
  let s = 0;
  for (let i = 0; i < n; i++) { const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % n]; s += x1 * y2 - x2 * y1; }
  const sign = s >= 0 ? 1 : -1; // 반시계(+)면 바깥 법선 = (dy, -dx)
  const normal = (a, b) => { const dx = b[0] - a[0]; const dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return [(sign * dy) / L, (-sign * dx) / L]; };
  return poly.map((p, i) => {
    const n1 = normal(poly[(i - 1 + n) % n], p);
    const n2 = normal(p, poly[(i + 1) % n]);
    const k = Math.max(0.25, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + ((n1[0] + n2[0]) / k) * d, p[1] + ((n1[1] + n2[1]) / k) * d];
  });
}

/**
 * 세대 바닥판(구조 슬래브) 조각들: 세대 외곽이 실 넓이 합과 비슷하면 외곽 하나,
 * 아니면(한 시트의 두 세대·잔선이 외곽을 키웠거나 외곽이 없으면) 실마다 벽 밑까지(0.15m) 넓힌 조각 — 볼록 외곽은 바깥으로 쐐기가 생겨 쓰지 않는다
 */
export function slabPieces(type, { skip = straySpaces(type) } = {}) {
  const ol = type.outline || [];
  const spaces = (type.spaces || []).filter((sp) => sp.polygon?.length > 2 && !skip.has(sp.id));
  const sum = spaces.reduce((s, sp) => s + polyArea(sp.polygon), 0);
  if (ol.length >= 3 && (!sum || (polyArea(ol) >= sum * 0.85 && polyArea(ol) <= sum * 1.8))) return [ol];
  return spaces.length ? spaces.map((sp) => offsetPolygon(sp.polygon, 0.15)) : ol.length >= 3 ? [ol] : [];
}
/** 바닥판 외곽 하나(조각이 여럿이면 실들의 볼록 외곽 — 범위 계산용) */
export function slabPolygon(type) {
  const p = slabPieces(type);
  return p.length === 1 ? p[0] : unitEnvelope(type);
}

/**
 * 떠 있는 벽 조각(각주·지시선·난간 표시 선이 벽 짝으로 남은 것) → Map(벽 id → 'outside' | 'diagonal').
 *   outside: 세대 자리 밖에 있으면서 실에 닿지 않고, 실에 닿은 벽과 이어지지도 않는 조각
 *   outside: (낱개) 실에 닿지 않는 벽인데 양 끝이 다 세대 자리 밖인 것(본 건물 벽에 이어진 지시선)
 *   diagonal: 벽 방향(가로세로)이 아닌 사선의 짧은 조각(1m 미만)이고 양쪽이 실이 아닌 것, 또는 실에 닿지 않는 사선인데 한쪽 끝이 세대 자리 밖인 것
 * 실이 하나도 없으면 가리지 않는다(판단할 기준이 없다).
 */
/** 세대 밖 이름 없는 칸(떠 있는 조각이 둘러싼 칸): 이름 없는 실인데 가운데가 세대 자리 밖. 이름 있는 실이 없으면 가리지 않는다 */
export function straySpaces(type) {
  const named = (type.spaces || []).filter((s) => s.name !== 'unnamed' && s.polygon?.length > 2);
  if (!named.length) return new Set();
  const env = grow(unitEnvelope(type), 0.3);
  return new Set((type.spaces || []).filter((s) => s.name === 'unnamed' && s.polygon?.length > 2 && !pointInPolygon(...centroid(s.polygon), env)).map((s) => s.id));
}

/** 세대 밖 기둥(옆 코어·주차장 기둥 그림): 가운데가 세대 자리 밖. 이름 있는 실이 없으면 가리지 않는다 */
export function strayColumns(type) {
  const named = (type.spaces || []).filter((s) => s.name !== 'unnamed' && s.polygon?.length > 2);
  if (!named.length) return new Set();
  const env = grow(unitEnvelope(type), 0.3);
  return new Set((type.columns || []).filter((c) => c.polygon?.length > 2 && !pointInPolygon(...centroid(c.polygon), env)).map((c) => c.id));
}

export function strayWalls(type) {
  const out = new Map();
  const walls = type.walls || [];
  if (!(type.spaces || []).length || !walls.length) return out;
  const offSpaces = straySpaces(type);
  const realSide = (id) => Boolean(id) && !offSpaces.has(id);
  const key = (p) => `${Math.round(p[0] * 100)}|${Math.round(p[1] * 100)}`;
  const parent = new Map();
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  for (const w of walls) for (const p of w.path) { const k = key(p); if (!parent.has(k)) parent.set(k, k); }
  for (const w of walls) { const a = find(key(w.path[0])); const b = find(key(w.path[1])); if (a !== b) parent.set(a, b); }
  const comps = new Map();
  for (const w of walls) { const r = find(key(w.path[0])); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(w); }
  const env = grow(unitEnvelope(type), 0.3);
  const inEnv = (p) => env.length >= 3 && pointInPolygon(p[0], p[1], env);
  for (const list of comps.values()) {
    if (list.some((w) => realSide(w.sides?.in) || realSide(w.sides?.out))) continue;
    if (list.every((w) => w.path.every((p) => !inEnv(p)))) for (const w of list) out.set(w.id, 'outside');
  }
  // 벽의 주된 방향(길이 가중, 90° 주기)
  const bins = new Float64Array(90);
  const ang = (w) => (((Math.atan2(w.path[1][1] - w.path[0][1], w.path[1][0] - w.path[0][0]) * 180) / Math.PI) % 90 + 90) % 90;
  const len = (w) => Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]);
  for (const w of walls) bins[Math.round(ang(w)) % 90] += len(w);
  let axis = 0;
  for (let i = 1; i < 90; i++) if (bins[i] > bins[axis]) axis = i;
  for (const w of walls) {
    if (out.has(w.id)) continue;
    const bare = !realSide(w.sides?.in) && !realSide(w.sides?.out);
    const outside = w.path.filter((p) => !inEnv(p)).length;
    if (bare && outside === 2) { out.set(w.id, 'outside'); continue; }
    let d = Math.abs(ang(w) - axis);
    d = Math.min(d, 90 - d);
    if (d > 10 && ((len(w) < 1 && !(w.sides?.in && w.sides?.out)) || (bare && outside >= 1))) out.set(w.id, 'diagonal');
  }
  return out;
}

// ---------------------------------------------------------------- 세대 자재 종류 목록

const perimeter = (poly) => poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0);
const r2 = (v) => Math.round(v * 100) / 100;
const VOLUME_KINDS = new Set(['floor.slab', 'floor.foam', 'floor.screed', 'wall.concrete']);

/**
 * 세대(타입 1세대)에 든 자재 종류: 부위 → 종류, 색·수량·출처 수.
 * 수량은 그림에서 낸 어림값이다(벽 = 길이 × 높이 - 개구부, 바닥·천장 = 실 넓이). 적산·M18 수량 산출 화면([수량] 탭)이 기준이다.
 * @returns {{ key, part, label, color, areaM2, volumeM3, lengthM, count, sources: number, assumed: boolean, materials: string[] }[]}
 */
export function unitKinds(type, catalog, { height = 2.7, level = null, hide = null } = {}) {
  const by = new Map();
  const add = (key, { area = 0, volume = 0, length = 0, count = 0, source = ASSUMED, name = '' }) => {
    if (!by.has(key)) { const k = kindInfo(key); by.set(key, { key, part: k.part, label: k.label, short: k.short, color: k.color, areaM2: 0, volumeM3: 0, lengthM: 0, count: 0, src: new Set(), real: false, materials: new Set() }); }
    const e = by.get(key);
    e.areaM2 += area; e.volumeM3 += volume; e.lengthM += length; e.count += count;
    if (!source.assumed) { e.real = true; e.src.add(source.sheetId || source.label); }
    if (name) e.materials.add(name);
  };
  const layerAdd = (l, area) => add(l.kind, { area, volume: l.mm ? (area * l.mm) / 1000 : 0, source: l.source, name: l.name });
  const stray = hide || strayWalls(type);
  const offSpaces = straySpaces(type);
  for (const sp of type.spaces || []) {
    if (!(sp.polygon?.length > 2) || offSpaces.has(sp.id)) continue;
    const a = sp.areaM2 || polyArea(sp.polygon);
    for (const l of floorStack(type, catalog, sp, { level }).layers) layerAdd(l, a);
    for (const l of ceilingStack(type, catalog, sp).layers) layerAdd(l, a);
    if (sp.finish?.base) {
      const m = (catalog.materials || []).find((x) => x.id === sp.finish.base);
      add('floor.base', { length: perimeter(sp.polygon), source: { label: '마감표', assumed: false, sheetId: 'schedule' }, name: m?.name || '걸레받이' });
    }
  }
  const opsBy = new Map();
  for (const o of type.openings || []) { if (!opsBy.has(o.wallId)) opsBy.set(o.wallId, []); opsBy.get(o.wallId).push(o); }
  for (const w of type.walls || []) {
    if (stray.has(w.id)) continue;
    const L = Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]);
    const area = wallPieces(L, height, opsBy.get(w.id) || []).reduce((s, p) => s + (p.s1 - p.s0) * (p.z1 - p.z0), 0);
    for (const l of wallStack(w, type, catalog).layers) layerAdd(l, area);
  }
  const wt = new Map((catalog.windowTypes || []).map((x) => [String(x.code).toUpperCase(), x]));
  for (const o of type.openings || []) {
    if (stray.has(o.wallId)) continue;
    const t = wt.get(String(o.typeCode || '').toUpperCase());
    const src = t ? sourceOf({ id: 'wt', kind: 'window', source: t.source }) : o.typeCode && o.source?.method !== 'assumed' ? { label: '창호 일람표', assumed: false, sheetId: 'window' } : ASSUMED;
    if (o.kind === 'window') {
      add('opening.frame', { count: 1, length: 2 * (o.width + o.height), source: src, name: t?.frame?.material || '창틀' });
      add('opening.glass', { count: 1, area: Math.max(0, o.width - 0.12) * Math.max(0, o.height - 0.12), source: src, name: t?.glass?.notation || '유리' });
    } else if (o.kind === 'door') {
      add('opening.door', { count: 1, area: o.width * o.height, source: src, name: o.typeCode || '문' });
      add('opening.doorFrame', { count: 1, length: o.width + 2 * o.height, source: src, name: '문틀' });
    }
  }
  const order = (k) => PARTS.indexOf(k.part) * 100 + (k.key.endsWith('.other') ? 99 : 0);
  return [...by.values()].map(({ src, real, materials, ...e }) => ({ ...e, areaM2: r2(e.areaM2), volumeM3: r2(e.volumeM3), lengthM: r2(e.lengthM), sources: src.size, assumed: !real, materials: [...materials] }))
    .sort((a, b) => order(a) - order(b));
}

/** 자재 종류 한 줄의 수량 글자: "12.3㎡ · 2.58㎥" / "4개" / "31.2m" */
export function kindQty(k) {
  if (k.part === 'opening') return `${k.count}개${k.key === 'opening.glass' ? ` · ${k.areaM2.toFixed(1)}㎡` : ''}`;
  if (k.key === 'floor.base') return `${k.lengthM.toFixed(1)}m`;
  return `${k.areaM2.toFixed(1)}㎡${VOLUME_KINDS.has(k.key) && k.volumeM3 ? ` · ${k.volumeM3.toFixed(2)}㎥` : ''}`;
}
