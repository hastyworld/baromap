// 세대 장면(LOD 2): 세대 바닥판(구조 슬래브), 실 바닥(층 구성 겹쳐 그리기)·실명, 벽(조립체 층 상자, 재료별로 합쳐 그리기),
// 문(문틀 + 열린 문짝)·창(창틀 + 유리), 걸레받이, 천장(층 구성), 기둥, 시공부위(방수·단열·차음·내화) 바닥 표시, 수평 단면 띠.
// 모델 좌표(타입 자기 좌표, z 위). 마감 바닥 = z 0 근처(실마다 바닥 구성 두께만큼 슬래브 위).
// 자재 종류(부위 → 종류, materials-ko.js)마다 켜고 끌 수 있게 메시에 kindKey를 붙인다(42 지시서 2·4절).
import { shapeOf, center } from './mesh-site.js';
import { typeWallBoxes, cutCaps, boxCorners, boxTriangles, finishResolver, wallPieces, TRI_PER_BOX } from './mesh-calc.js';
import { USE_COLOR, ZONE_COLOR, ZONE_LABEL, colorOf, dark } from './materials-3d.js';
import { CATEGORY_COLOR, materialKind, kindInfo } from './materials-ko.js';
import { spaceLabel, slabPieces, strayWalls, straySpaces, strayColumns, floorStack, ceilingStack, SMALL_ROOM_M2 } from './parts.js';

const DIM = 0.07; // 흐리게(이 자재만 보기·이 실만 보기에서 나머지)
const LEAF = 0.04; // 문짝 두께
const SWING = (25 * Math.PI) / 180; // 문짝을 열어 그리는 각도
const BASE_H = 0.08; // 걸레받이 높이(상세 값이 없을 때)
const STRAY_COLOR = '#F5C400';

/**
 * opts: { height, layers(층 구성 보기), cutZ(수평 단면 높이|null), clip(three 평면 목록), filter(보일 재료 분류 Set|null),
 *         kinds({ only: 종류 키|null, hidden: Set<종류 키> }|null), zones(시공부위 표시), fade(Set<materialId> 투명하게: 아직 안 한 공종),
 *         stray('hide'|'show': 떠 있는 벽 조각), focus(이 실만 보기: 실 id|null), ceiling(천장 그리기), level(슬래브 두께를 읽을 레벨) }
 */
export function buildUnit(T, mats, { type, catalog }, opts = {}) {
  const { height = 2.7, layers = true, cutZ = null, clip = null, filter = null, kinds = null, zones = false, fade = null, stray = 'hide', focus = null, ceiling = false, level = null } = opts;
  const group = new T.Group();
  const pickables = [];
  const labels = [];
  const materialsById = new Map((catalog.materials || []).map((m) => [m.id, m]));
  const finishOf = finishResolver(type, catalog);
  const strays = strayWalls(type);
  const offSpaces = stray === 'show' ? new Set() : straySpaces(type); // 세대 밖 이름 없는 칸: 기본으로 숨긴다
  const wallById = new Map(type.walls.map((w) => [w.id, w]));
  // 자재 종류 거르기: 숨김이면 그리지 않고, "이 자재만"이면 나머지를 흐리게
  const hidden = (k) => Boolean(kinds?.hidden?.has(k));
  const kindOpacity = (k) => (kinds?.only && kinds.only !== k ? DIM : 1);
  // 이 실만 보기: 그 실의 바닥·천장·둘레 벽만 진하게
  const focusWalls = focus ? new Set(type.walls.filter((w) => w.sides?.in === focus || w.sides?.out === focus).map((w) => w.id)) : null;
  const focusOpacity = (inFocus) => (focus && !inFocus ? DIM : 1);
  const mesh = (geom, color, { opacity = 1, userData = {}, pick = true, double = false, z = 0 } = {}) => {
    const m = new T.Mesh(geom, mats.get(color, { opacity, clip, double: double || Boolean(clip) }));
    if (z) m.position.z = z;
    m.userData = userData;
    group.add(m);
    if (pick && opacity > 0.1) pickables.push(m);
    return m;
  };
  const boxesMesh = (positions, color, o) => {
    if (!positions.length) return null;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return mesh(g, color, o);
  };

  // ---- 바닥: 층 구성. 슬래브 윗면 = -(가장 두꺼운 바닥 구성), 실마다 그 위에 자기 구성만큼 쌓는다(욕실·발코니는 조금 낮다)
  const spaces = type.spaces.filter((sp) => sp.polygon?.length > 2 && !offSpaces.has(sp.id));
  const stacks = new Map(spaces.map((sp) => [sp.id, floorStack(type, catalog, sp, { level })]));
  const maxBuild = layers ? Math.max(0, ...[...stacks.values()].map((s) => s.buildMm)) / 1000 : 0;
  const slabMm = [...stacks.values()][0]?.slabMm || level?.slabMm || 200;
  const slabTop = -maxBuild - 0.001;
  const ext = [Infinity, Infinity, slabTop - slabMm / 1000, -Infinity, -Infinity, height];
  const slabs = slabPieces(type, { skip: offSpaces });
  for (const [x, y] of [...slabs.flat(), ...spaces.flatMap((s) => s.polygon)]) { ext[0] = Math.min(ext[0], x); ext[1] = Math.min(ext[1], y); ext[3] = Math.max(ext[3], x); ext[4] = Math.max(ext[4], y); }
  if (!Number.isFinite(ext[0])) Object.assign(ext, [0, 0, ext[2], 10, 10, height]);

  // 세대 바닥판(구조 슬래브): 이름 없는 칸·실 사이 틈도 바닥이 보인다
  if (!hidden('floor.slab')) {
    for (const poly of slabs) {
      if (poly.length < 3) continue;
      const g = new T.ExtrudeGeometry(shapeOf(T, poly), { depth: slabMm / 1000, bevelEnabled: false });
      mesh(g, dark() ? '#7d8694' : kindInfo('floor.slab').color, { opacity: Math.min(kindOpacity('floor.slab'), focus ? 0.35 : 1), z: slabTop - slabMm / 1000, userData: { kind: 'slab', kindKey: 'floor.slab' }, pick: false });
    }
  }
  const floorTop = new Map();
  for (const sp of spaces) {
    const st = stacks.get(sp.id);
    const top = layers ? slabTop + st.buildMm / 1000 : 0;
    floorTop.set(sp.id, top);
    const fo = focusOpacity(sp.id === focus);
    const zoneColor = zones && sp.zones?.length ? ZONE_COLOR[sp.zones[0]] : null;
    if (layers) {
      // 층마다 두께대로(위 → 아래). 마감 층은 실 용도 색 대신 재료 색
      let z = top;
      for (const l of st.layers) {
        if (l.slab) break;
        const t = Math.max(0.002, (l.mm || 6) / 1000);
        z -= t;
        if (hidden(l.kind)) continue;
        const g = new T.ExtrudeGeometry(shapeOf(T, sp.polygon), { depth: t, bevelEnabled: false });
        const notYet = Boolean(fade && fade.has(l.materialId));
        mesh(g, zoneColor && l === st.layers[0] ? zoneColor : l.color || CATEGORY_COLOR[l.category] || '#ccc', { opacity: Math.min(kindOpacity(l.kind), fo, notYet ? 0.12 : 1), z, userData: { kind: 'space', id: sp.id, part: 'floor', kindKey: l.kind, materialId: l.materialId } });
      }
    } else if (!hidden('floor.finish')) {
      // 한 색 보기: 용도별 옅은 색(다크 화면에서는 어둡게 — 눈부심 줄이기)
      const floor = dark() ? `#${new T.Color(USE_COLOR[sp.use] || '#EEEEEE').lerp(new T.Color('#10141c'), 0.5).getHexString()}` : USE_COLOR[sp.use] || '#EEE';
      mesh(new T.ShapeGeometry(shapeOf(T, sp.polygon)), zoneColor || floor, { opacity: Math.min(zoneColor ? 0.85 : 1, kindOpacity('floor.finish'), fo), double: true, z: 0.002, userData: { kind: 'space', id: sp.id, part: 'floor', kindKey: 'floor.finish' } });
    }
    const c = center(sp.polygon);
    const small = (sp.areaM2 || 0) < SMALL_ROOM_M2;
    labels.push({ text: `${spaceLabel(sp)}${sp.areaM2 ? ` ${sp.areaM2.toFixed(1)}㎡` : ''}${zones && sp.zones?.length ? ` · ${sp.zones.map((z) => ZONE_LABEL[z]).join('·')}` : ''}`, pos: [c[0], c[1], 0.1], cls: `room${small ? ' small' : ''}`, id: sp.id, small, rank: sp.areaM2 || 0 });
  }
  labels.sort((a, b) => b.rank - a.rank); // 큰 실 이름부터 놓는다(겹치면 작은 실 이름이 숨는다)

  // ---- 벽(재료별 합친 상자). 떠 있는 조각은 빼고, [확인 필요 보기]면 노란색으로
  const kindOfWall = (g) => materialKind(materialsById.get(g.materialId)?.name || (g.category === 'structure' ? '콘크리트' : ''), 'wall');
  const drawWalls = (walls, dim) => {
    if (!walls.length) return;
    const openings = type.openings.filter((o) => walls.some((w) => w.id === o.wallId));
    const groups = typeWallBoxes({ ...type, walls, openings }, catalog, { height, mode: layers ? 'layers' : 'solid', finishOf });
    for (const [, gdata] of groups) {
      const kindKey = layers ? kindOfWall(gdata) : 'wall.finish';
      if (layers && hidden(kindKey)) continue;
      const notYet = Boolean(fade && gdata.materialId && fade.has(gdata.materialId));
      // 한 색 보기에서 실내 마감 공종이 아직이면 바탕(미장) 색으로, 층 구성 보기에서는 그 층을 투명하게
      let color = layers ? colorOf(gdata, materialsById) : (materialsById.get(gdata.materialId)?.color || (dark() ? '#C9CFD8' : '#E4E1DA'));
      if (notYet && !layers) color = CATEGORY_COLOR.plaster;
      let opacity = layers ? kindOpacity(kindKey) : 1;
      if (filter && !filter.has(gdata.category)) opacity = 0.08;
      if (notYet && layers) opacity = Math.min(opacity, 0.12);
      if (dim) opacity = Math.min(opacity, DIM);
      boxesMesh(gdata.positions, color, { opacity, userData: { kind: 'wall', ids: gdata.ids, materialId: gdata.materialId, category: gdata.category, kindKey } });
    }
  };
  const good = type.walls.filter((w) => !strays.has(w.id));
  if (focusWalls) { drawWalls(good.filter((w) => focusWalls.has(w.id)), false); drawWalls(good.filter((w) => !focusWalls.has(w.id)), true); } else drawWalls(good, false);
  if (stray === 'show' && strays.size) {
    const pos = [];
    const ids = [];
    for (const w of type.walls) if (strays.has(w.id)) { boxTriangles(boxCorners(w.path[0], w.path[1], 0, Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]), -w.thickness / 2, w.thickness / 2, 0, height), pos); ids.push(w.id); }
    boxesMesh(pos, STRAY_COLOR, { opacity: 0.85, userData: { kind: 'wall', ids, stray: true } });
  }
  if (cutZ != null) {
    for (const [, c] of cutCaps({ ...type, walls: good }, catalog, cutZ, { finishOf })) {
      const kindKey = kindOfWall(c);
      if (hidden(kindKey)) continue;
      const dimmed = (filter && !filter.has(c.category)) || kindOpacity(kindKey) < 1;
      boxesMesh(c.positions, colorOf(c, materialsById), { opacity: dimmed ? 0.1 : 1, pick: false });
    }
  }

  // ---- 문·창(벽 구멍은 벽 상자를 나눠서 이미 뚫려 있다): 문틀 + 열어 그린 문짝(40mm), 창틀 + 반투명 유리
  const parts = { glass: [[], []], frame: [[], []], leaf: [[], []], doorFrame: [[], []] };
  const put = (key, corners, id) => { boxTriangles(corners, parts[key][0]); parts[key][1].push(id); };
  for (const o of type.openings) {
    const w = wallById.get(o.wallId);
    if (!w || strays.has(w.id)) continue;
    const [a, b] = w.path;
    const s0 = o.offset - o.width / 2;
    const s1 = o.offset + o.width / 2;
    const top = Math.min(height, (o.sill || 0) + o.height);
    const z0 = o.sill || 0;
    const d = Math.min(0.1, w.thickness) / 2; // 틀 깊이 반
    const f = 0.05; // 틀 보임 폭
    if (o.kind === 'window') {
      put('frame', boxCorners(a, b, s0, s1, -d, d, z0, z0 + f), o.id);
      put('frame', boxCorners(a, b, s0, s1, -d, d, top - f, top), o.id);
      put('frame', boxCorners(a, b, s0, s0 + f, -d, d, z0 + f, top - f), o.id);
      put('frame', boxCorners(a, b, s1 - f, s1, -d, d, z0 + f, top - f), o.id);
      if (o.width > 1.5) put('frame', boxCorners(a, b, o.offset - f / 2, o.offset + f / 2, -d, d, z0 + f, top - f), o.id); // 가운데 선대
      put('glass', boxCorners(a, b, s0 + f, s1 - f, -0.006, 0.006, z0 + f, top - f), o.id);
    } else if (o.kind === 'door') {
      const t2 = w.thickness / 2 + 0.01;
      put('doorFrame', boxCorners(a, b, s0, s0 + 0.04, -t2, t2, 0, top), o.id);
      put('doorFrame', boxCorners(a, b, s1 - 0.04, s1, -t2, t2, 0, top), o.id);
      put('doorFrame', boxCorners(a, b, s0, s1, -t2, t2, top - 0.04, top), o.id);
      // 문짝: 한쪽 문틀(경첩)에서 실내(in) 쪽으로 열어 그린다. 여닫는 쪽은 도면에서 읽지 않아 가정이다
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      const hinge = [a[0] + dir[0] * (s0 + 0.04), a[1] + dir[1] * (s0 + 0.04)];
      const sw = [dir[0] * Math.cos(SWING) - dir[1] * Math.sin(SWING), dir[0] * Math.sin(SWING) + dir[1] * Math.cos(SWING)];
      const lw = Math.max(0.2, o.width - 0.08);
      put('leaf', boxCorners(hinge, [hinge[0] + sw[0] * lw, hinge[1] + sw[1] * lw], 0, lw, -LEAF / 2, LEAF / 2, 0.005, top - 0.045), o.id);
    }
  }
  const opMesh = (key, kindKey, color, opacity) => {
    if (hidden(kindKey)) return;
    const [pos, ids] = parts[key];
    const inFocus = !focusWalls;
    const o = Math.min(opacity, kindOpacity(kindKey), inFocus ? 1 : 0.35);
    boxesMesh(pos, color, { opacity: o, double: true, userData: { kind: 'opening', ids, kindKey } });
  };
  opMesh('frame', 'opening.frame', dark() ? '#C9CFD8' : '#E9EDF2', 1);
  opMesh('glass', 'opening.glass', '#7FB2F0', 0.42);
  opMesh('doorFrame', 'opening.doorFrame', '#8A6B4E', 1);
  opMesh('leaf', 'opening.door', '#B58A5A', 1);

  // ---- 걸레받이: 마감표에 걸레받이가 있는 실의 둘레 벽 아래(문 자리는 뺀다)
  if (!hidden('floor.base')) {
    const pos = [];
    const opsBy = new Map();
    for (const o of type.openings) if (o.kind !== 'window' || !(o.sill > 0.05)) { if (!opsBy.has(o.wallId)) opsBy.set(o.wallId, []); opsBy.get(o.wallId).push({ ...o, sill: 0, height: 10 }); }
    const based = new Set(spaces.filter((sp) => sp.finish?.base).map((sp) => sp.id));
    for (const w of good) {
      const L = Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]);
      for (const [side, sign] of [['in', 1], ['out', -1]]) {
        if (!based.has(w.sides?.[side])) continue;
        const o0 = sign * (w.thickness / 2);
        const o1 = sign * (w.thickness / 2 + 0.012);
        for (const p of wallPieces(L, BASE_H, opsBy.get(w.id) || [])) boxTriangles(boxCorners(w.path[0], w.path[1], p.s0, p.s1, Math.min(o0, o1), Math.max(o0, o1), 0, BASE_H), pos);
      }
    }
    boxesMesh(pos, kindInfo('floor.base').color, { opacity: Math.min(kindOpacity('floor.base'), focus ? 0.35 : 1), pick: false, userData: { kind: 'base', kindKey: 'floor.base' } });
  }

  const offColumns = stray === 'show' ? new Set() : strayColumns(type);
  for (const c of (type.columns || []).filter((x) => !offColumns.has(x.id))) {
    const g = new T.ExtrudeGeometry(shapeOf(T, c.polygon), { depth: height, bevelEnabled: false });
    mesh(g, '#9AA3AF', { pick: false, opacity: focus ? DIM : 1 });
  }

  // ---- 천장(층 구성: 천장틀 → 판 → 마감). [천장]을 켜거나 천장 자재만 볼 때 그린다. 수평 단면 높이보다 위면 그리지 않는다
  const onlyCeiling = String(kinds?.only || '').startsWith('ceiling.');
  if (ceiling || onlyCeiling) {
    for (const sp of spaces) {
      const st = ceilingStack(type, catalog, sp);
      let z = Math.min(st.ceilingMm / 1000, height - 0.02);
      if (cutZ != null && z > cutZ) continue;
      const fo = focusOpacity(sp.id === focus);
      // 아래(마감)부터 위로 쌓는다
      for (const l of [...st.layers].reverse()) {
        const t = Math.max(0.004, (l.mm || 6) / 1000);
        if (!hidden(l.kind)) {
          const g = new T.ExtrudeGeometry(shapeOf(T, sp.polygon), { depth: Math.min(t, Math.max(0.004, height - z)), bevelEnabled: false });
          mesh(g, l.color || (dark() ? '#8b95a5' : '#E4E7EC'), { opacity: Math.min(onlyCeiling ? kindOpacity(l.kind) : 0.5, fo), z, userData: { kind: 'space', id: sp.id, part: 'ceiling', kindKey: l.kind, materialId: l.materialId } });
        }
        z += t;
      }
    }
  }
  return {
    group, pickables, labels, ext, strays, floorTop,
    idOf(hit) {
      const ud = hit.object.userData || {};
      if (ud.kind === 'space') return ud.id;
      if (ud.ids && hit.faceIndex != null) return ud.ids[Math.floor(hit.faceIndex / TRI_PER_BOX)] || null;
      return null;
    },
    /** 누른 부위: 'floor' | 'ceiling' | 'wall' | 'opening' | null */
    partOf(hit) { const ud = hit?.object?.userData || {}; return ud.part || (ud.kind === 'wall' ? 'wall' : ud.kind === 'opening' ? 'opening' : null); },
    boxesOf(ids) {
      const out = [];
      for (const w of type.walls) if (ids.includes(w.id)) { const [a, b] = w.path; out.push([Math.min(a[0], b[0]) - w.thickness / 2, Math.min(a[1], b[1]) - w.thickness / 2, 0, Math.max(a[0], b[0]) + w.thickness / 2, Math.max(a[1], b[1]) + w.thickness / 2, height]); }
      for (const s of type.spaces) if (ids.includes(s.id)) { const xs = s.polygon.map((p) => p[0]); const ys = s.polygon.map((p) => p[1]); out.push([Math.min(...xs), Math.min(...ys), 0, Math.max(...xs), Math.max(...ys), 0.3]); }
      for (const o of type.openings) if (ids.includes(o.id)) { const w = wallById.get(o.wallId); if (!w) continue; const c = boxCorners(w.path[0], w.path[1], o.offset - o.width / 2, o.offset + o.width / 2, -w.thickness, w.thickness, o.sill, o.sill + o.height); out.push([Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), o.sill, Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1])), o.sill + o.height]); }
      return out;
    },
  };
}
