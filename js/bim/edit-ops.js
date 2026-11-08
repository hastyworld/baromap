// 직접 고치기(07 2절) 화면 입력 → 수정 연산(validate.js 형식). 순수 함수라 화면 없이 테스트한다(test/bim-patch.test.js).
import { locateId } from './validate.js';
import { m2Of, m2apply } from './mesh-calc.js';

const REASON = '직접 수정';
const mmOf = (m) => Math.round(m * 1000);
const r3 = (v) => Math.round(v * 1000) / 1000;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 벽: 조립체(기호)·두께·실내/실외 쪽 뒤집기, sameCode면 같은 기호 모든 벽(모든 타입·층 템플릿)에 */
export function wallOps(files, file, wall, { assemblyId = wall.assemblyId, thicknessMm = mmOf(wall.thickness), flip = false, sameCode = false } = {}) {
  const cat = files['catalog.json'];
  const asm = cat.assemblies.find((a) => a.id === assemblyId);
  const set = {};
  if (assemblyId !== wall.assemblyId) { set.assemblyId = assemblyId; set.code = asm?.code ?? null; }
  if (Number(thicknessMm) !== mmOf(wall.thickness)) set.thickness = Number(thicknessMm) / 1000;
  const ops = [];
  if (flip) {
    const [a, b] = wall.path;
    set.path = [b, a];
    set.sides = { in: wall.sides?.out ?? null, out: wall.sides?.in ?? null };
    // 경로가 뒤집히면 문·창 위치(시작점에서 거리)도 반대로
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const owner = locateId(files[file], wall.id)?.owner;
    for (const o of owner?.openings || []) if (o.wallId === wall.id) ops.push({ op: 'update', file, id: o.id, set: { offset: r3(L - o.offset) }, reason: `${REASON}(벽 방향 뒤집기)` });
  }
  if (Object.keys(set).length) ops.unshift({ op: 'update', file, id: wall.id, set, reason: REASON });
  if (sameCode && wall.code) {
    const shared = {};
    if (set.assemblyId) { shared.assemblyId = set.assemblyId; shared.code = set.code; }
    if (set.thickness) shared.thickness = set.thickness;
    if (Object.keys(shared).length) {
      for (const [name, f] of Object.entries(files)) {
        const lists = name.startsWith('u-') ? [f.walls] : name.startsWith('b-') ? f.floorTemplates.map((t) => t.walls) : [];
        for (const list of lists) for (const w of list || []) if (w.code === wall.code && w.id !== wall.id) ops.push({ op: 'update', file: name, id: w.id, set: shared, reason: `${REASON}(같은 기호 ${wall.code} 모든 벽)` });
      }
    }
  }
  return ops;
}

/** 실: 이름·용도·바닥/벽/천장 마감·시공부위 */
export function spaceOps(file, space, { name = space.name, use = space.use, floor, wall, ceiling, zones = space.zones || [] } = {}) {
  const set = {};
  if (name !== space.name) set.name = String(name).trim();
  if (use !== space.use) set.use = use;
  const f = space.finish || {};
  if (floor !== undefined && (floor || null) !== (f.floor || null)) set['finish.floor'] = floor || null;
  if (wall !== undefined && (wall || null) !== (f.wall || null)) set['finish.wall'] = wall || null;
  if (ceiling !== undefined && (ceiling || null) !== (f.ceiling || null)) set['finish.ceiling'] = ceiling || null;
  if (!same([...zones].sort(), [...(space.zones || [])].sort())) set.zones = [...zones];
  return Object.keys(set).length ? [{ op: 'update', file, id: space.id, set, reason: REASON }] : [];
}

/** 문·창: 기호·폭·높이·창대 높이(mm) */
export function openingOps(file, o, { typeCode = o.typeCode, widthMm = mmOf(o.width), heightMm = mmOf(o.height), sillMm = mmOf(o.sill) } = {}) {
  const set = {};
  if ((typeCode || null) !== (o.typeCode || null)) set.typeCode = typeCode ? String(typeCode).trim() : null;
  if (Number(widthMm) !== mmOf(o.width)) set.width = Number(widthMm) / 1000;
  if (Number(heightMm) !== mmOf(o.height)) set.height = Number(heightMm) / 1000;
  if (Number(sillMm) !== mmOf(o.sill)) set.sill = Number(sillMm) / 1000;
  return Object.keys(set).length ? [{ op: 'update', file, id: o.id, set, reason: REASON }] : [];
}

/** 레벨: 이름·층고(m). 층고가 바뀌면 위층 바닥 높이와 단지의 동 높이도 같이 */
export function levelOps(files, file, level, { name = level.name, heightM = level.height } = {}) {
  const b = files[file];
  const ops = [];
  const set = {};
  const h = Number(heightM);
  if (name !== level.name) set.name = String(name).trim();
  const d = r3(h - level.height);
  if (d) set.height = h;
  if (Object.keys(set).length) ops.push({ op: 'update', file, id: level.id, set, reason: REASON });
  if (d) {
    for (const l of b.levels) if (l.elevation > level.elevation) ops.push({ op: 'update', file, id: l.id, set: { elevation: r3(l.elevation + d) }, reason: `${REASON}(${level.name} 층고 ${d > 0 ? '+' : ''}${d}m)` });
    const sb = files['site.json']?.buildings.find((x) => x.id === b.id);
    if (sb) ops.push({ op: 'update', file: 'site.json', id: sb.id, set: { height: r3(sb.height + d) }, reason: `${REASON}(${level.name} 층고)` });
  }
  return ops;
}

/** 세대: 타입·호수·라인(라인이 바뀌면 골구도 키 층:라인도) */
export function unitOps(file, u, { unitTypeId = u.unitTypeId, label = u.label, line = u.line } = {}) {
  const set = {};
  if (unitTypeId !== u.unitTypeId) set.unitTypeId = unitTypeId;
  if (String(label) !== u.label) set.label = String(label).trim();
  if (String(line) !== String(u.line)) { set.line = String(line).trim(); set.unitKey = `${u.unitKey.split(':')[0]}:${set.line}`; }
  return Object.keys(set).length ? [{ op: 'update', file, id: u.id, set, reason: REASON }] : [];
}

/** 동: 이름·종류·옮기기(dx, dy m)·돌리기(도, 동 외곽 가운데 기준) — 단지 배치(site.json)와 동 파일을 같이 */
export function buildingOps(files, buildingId, { name, kind, dx = 0, dy = 0, dRot = 0 } = {}) {
  const sb = files['site.json'].buildings.find((b) => b.id === buildingId);
  if (!sb) return [];
  const bf = files[sb.file];
  const site = {};
  const own = {};
  if (name != null && name !== sb.name) { site.name = String(name).trim(); own.name = site.name; }
  if (kind != null && kind !== sb.kind) { site.kind = kind; own.kind = kind; }
  if (dx || dy || dRot) {
    const n = sb.footprint.length;
    const c = sb.footprint.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
    const R = m2Of({ x: 0, y: 0, rotDeg: dRot });
    const move = (p) => { const q = m2apply(R, [p[0] - c[0], p[1] - c[1]]); return [r3(q[0] + c[0] + Number(dx)), r3(q[1] + c[1] + Number(dy))]; };
    site.footprint = sb.footprint.map(move);
    if (bf?.transform) {
      const t = move([bf.transform.x, bf.transform.y]);
      own.transform = { ...bf.transform, x: t[0], y: t[1], rotDeg: r3(((bf.transform.rotDeg || 0) + Number(dRot)) % 360) };
    }
  }
  const ops = [];
  if (Object.keys(site).length) ops.push({ op: 'update', file: 'site.json', id: sb.id, set: site, reason: REASON });
  if (bf && Object.keys(own).length) ops.push({ op: 'update', file: sb.file, id: bf.id, set: own, reason: REASON });
  return ops;
}

/** 조립체(카탈로그): 층 목록 통째로 [{ materialId, thicknessMm, side }] */
export function assemblyOps(assembly, layers, { name } = {}) {
  const clean = layers.map((l) => ({ materialId: l.materialId, thicknessMm: l.thicknessMm == null || l.thicknessMm === '' ? null : Number(l.thicknessMm), side: l.side }));
  const set = {};
  if (!same(clean, assembly.layers.map((l) => ({ materialId: l.materialId, thicknessMm: l.thicknessMm ?? null, side: l.side })))) set.layers = clean;
  if (name != null && name !== assembly.name) set.name = String(name).trim();
  return Object.keys(set).length ? [{ op: 'update', file: 'catalog.json', id: assembly.id, set, reason: REASON }] : [];
}

export const removeOp = (file, id, reason = REASON) => ({ op: 'remove', file, id, reason });
