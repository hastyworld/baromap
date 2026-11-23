// 평면 한 장 분석(벽·개구부·실·기둥·기호) → 단위세대 타입 모델(04 6절), 기준층의 세대 묶기·라인·타입 맞추기(04 5·6절)
// 좌표 m. 순수 함수.
import { extractWalls } from './walls.js';
import { planarFaces, makeSpaces, edgeFaces } from './spaces.js';
import { rasterRooms } from './rooms-raster.js';
import { tidyRoom, wallAxisDeg } from './room-tidy.js';
import { mirrorNames } from './mirror-names.js';
import { dimZones } from './dim-zones.js';
import { roomUse, isRoomName, layerRoomName, SHAFT_NAME } from './rule-read.js';
import { describeOpening } from './openings.js';
import { assignWallCodes, defaultAssembly, finishAssembly, findFinishRow, zonesFor, totalMm } from './finishes.js';
import { hashId, rp, r3 } from './ids.js';
import { boxOf, pointInPolygon, centroid, area as polyArea } from '../cad/geom.js';

// 한 영역에 이름이 둘이어도 실 하나로 묶는 이름: 트인 거실·주방·식당(같은 글자를 가까이 두 번 쓴 것도).
// 거실 둘(옆 세대와 이어짐)·침실·욕실과 섞인 것은 묶지 않는다
const OPEN_PLAN = new Set(['living', 'kitchen']);
// 넓게 트인 실은 r을 이 차례로 키워 다시 채운다(1.05·1.2는 2m 넘는 트임 — 원룸형 두 세대가 넓게 이어진 도면)
const REACHES = [0.45, 0.6, 0.75, 0.9, 1.05, 1.2];
const bare = (s) => String(s || '').replace(/\s+/g, '');
export function mergeableRooms(a, b) {
  if (bare(a.name) === bare(b.name)) return Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) < 2;
  const ua = a.use || roomUse(a.name);
  const ub = b.use || roomUse(b.name);
  return OPEN_PLAN.has(ua) && OPEN_PLAN.has(ub) && !(ua === 'living' && ub === 'living');
}
// 묶은 실의 이름: 거실 먼저, 같은 글자는 한 번("거실·주방/식당")
export function mergedName(list) {
  const sorted = [...list].sort((a, b) => ((a.use || roomUse(a.name)) === 'living' ? 0 : 1) - ((b.use || roomUse(b.name)) === 'living' ? 0 : 1));
  const names = [...new Set(sorted.map((l) => String(l.name).trim()))];
  return { name: names.join('·').slice(0, 40), names, use: sorted[0].use || roomUse(sorted[0].name) };
}

// 벽선으로 닫힌 면에 못 붙은 실 이름(문틈·붙박이장·겹벽으로 면이 안 닫힘, 한 면에 다른 이름 여럿)은
// 이름 위치에서 채워 찾은 실로 보탠다(js/bim/rooms-raster.js). 닫힌 면에서 찾은 이름 있는 실이 우선.
// 채우기는 세대 외곽(외벽·두꺼운 벽·창으로 닫힌 영역, 현관문 폭 틈은 막힌 것) 안에서 하고, 새면 r을 키워 다시 채운다.
function fillRasterSpaces(graph, faces, half, labels, spaces, faceSpace, { maxRoom = 150, typeM2 = 0, extra = [], soft = [], diag = null } = {}) {
  if (!labels.length || !graph.edges.length) return;
  const own = new Set();
  for (const sp of [...spaces]) {
    if (!sp.label) continue;
    const inside = labels.filter((l) => pointInPolygon(l.pos[0], l.pos[1], sp.polygon));
    const many = new Set(inside.map((l) => l.name)).size > 1;
    if (many && sp.areaM2 <= maxRoom && inside.every((a) => inside.every((b) => a === b || mergeableRooms(a, b)))) {
      Object.assign(sp, mergedName(inside), { labels: inside }); // 벽으로 닫힌 트인 거실·주방: 실 하나, 이름 목록
      for (const l of inside) own.add(l);
      continue;
    }
    if (many || sp.areaM2 > maxRoom) {
      spaces.splice(spaces.indexOf(sp), 1); // 이름 여럿·세대보다 큰 면(벽이 빠져 방이 합쳐짐)은 채운 실로 바꾼다
      faceSpace.delete(sp.face);
      continue;
    }
    for (const l of inside) own.add(l);
  }
  const todo = labels.filter((l) => !own.has(l));
  if (!todo.length) return;
  // 벽 범위 밖(같은 시트의 다른 그림)의 창은 격자를 넓혀 칸만 굵게 하므로 뺀다
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const e of graph.edges) for (const p of [e.a, e.b]) { x0 = Math.min(x0, p[0] - 2); x1 = Math.max(x1, p[0] + 2); y0 = Math.min(y0, p[1] - 2); y1 = Math.max(y1, p[1] + 2); }
  const inBox = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const why = diag ? [] : null;
  const glass = extra.filter((e) => inBox(e.a) && inBox(e.b));
  const hard = [...graph.edges, ...glass];
  const softIn = soft.filter((e) => inBox(e.a) && inBox(e.b));
  // 세대 외곽 선: 외벽(바깥 면에 닿은 벽)·두꺼운 벽(세대 경계벽·구조벽)·창. 세대 면적을 알 때만
  const zone = typeM2 ? {
    edges: [...graph.edges.filter((e, i) => e.t >= 0.18 || faces[half[i * 2].face]?.outer || faces[half[i * 2 + 1].face]?.outer), ...glass],
    reach: 0.6, maxArea: typeM2 * 1.5,
  } : null;
  const grid = diag ? {} : null;
  const found = rasterRooms(hard, todo, { maxArea: maxRoom, why, soft: softIn, reaches: REACHES, narrow: [0.3, 0.2], zone, mergeable: mergeableRooms, grid });
  if (diag) Object.assign(diag, { raster: todo.map((l, i) => ({ label: l, why: why[i] || null, reach: found[i]?.reach ?? null, area: found[i]?.area ?? null })), input: { hard, soft: softIn, maxRoom, todo, zone }, zones: grid.zones || 0 });
  const added = [];
  const axisDeg = wallAxisDeg(graph.edges);
  found.forEach((r, i) => {
    // 채우기는 벽 안쪽 넓이로 상한을 따졌고, 돌려받은 실은 벽 중심선까지 넓힌 것이라 그 띠만큼(15%) 여유를 둔다
    if (!r || r.area < 0.5 || r.area > maxRoom * 1.15) return;
    const l = todo[i];
    if (added.some((a) => pointInPolygon(l.pos[0], l.pos[1], a.polygon))) return;
    const nm = r.labels ? mergedName(r.labels) : { name: l.name, use: l.use || roomUse(l.name) };
    // 격자 테두리의 톱니를 벽 방향으로 곧게 펴고 벽 중심선에 붙인다(면적은 채운 칸 넓이 그대로)
    const polygon = tidyRoom(r.polygon, { edges: graph.edges, axisDeg });
    added.push({ face: null, raster: true, ...nm, polygon, areaM2: r.area, label: l, ...(r.labels ? { labels: r.labels } : {}), center: centroid(polygon) });
  });
  // 채운 실과 겹치는 이름 없는 면은 뺀다
  for (const sp of [...spaces]) {
    if (sp.label || !added.some((a) => pointInPolygon(sp.center[0], sp.center[1], a.polygon))) continue;
    spaces.splice(spaces.indexOf(sp), 1);
    faceSpace.delete(sp.face);
  }
  spaces.push(...added);
}

export const COMMON = /계단|승강기|엘리베이터|E\.?V|^홀$|엘리베이터홀|복도|로비|코어|필로티|PIT|샤프트|공용|전실|^(E?PS|AD|TPS|PD|DS|DA)\s*-?\d{0,2}$/i;
const lenOf = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * @param {any} sheet drawing_sheets 행(layerRoles, extracted, sheetNo …)
 * @param {{ items: any[] }} flat 시트 모양(unpackSheet)
 * @param {{ uf: number, schedule: Map<string, any> }} opts
 */
export function analyzePlan(sheet, flat, { uf, schedule = new Map(), diag = null }) {
  const roles = sheet.layerRoles || {};
  const items = flat.items;
  // 레이어 이름이 가구·각주인 블록(수건걸이·열쇠 그림·가구)은 판별이 문·창이라 해도 쓰지 않는다(실제 도서: 벽에 안 붙은 문·창의 대부분)
  const notOpening = (it) => /^(furniture|annotation)$/.test(roles[it.layer] || '');
  const openingKind = (it) => (notOpening(it) ? null : it.tc !== undefined ? (it.tc === 'building' && (it.tp === 'door' || it.tp === 'window') ? it.tp : null) : roles[it.layer] === 'door' || roles[it.layer] === 'window' ? roles[it.layer] : null);
  const inserts = items.filter((it) => it.k === 'insert' && it.box && openingKind(it))
    .map((it) => ({ kind: openingKind(it), box: it.box.map((v) => v * uf), attribs: it.attribs || {}, h: it.h }));
  const { graph, columns, unmatched } = extractWalls(items, roles, uf, { inserts });
  const { faces, half } = planarFaces(graph);
  const data = sheet.extracted?.data || {};
  const M = (p) => [p[0] * uf, p[1] * uf];
  // 샤프트 기호(PS·AD)는 닫힌 칸의 이름으로만 쓴다(닫히지 않은 샤프트에서 채우면 옆 주방을 차지한다)
  const shafts = (data.rooms || []).filter((r) => r.labelPos && SHAFT_NAME.test(String(r.name).trim())).map((r) => ({ name: String(r.name).trim(), pos: M(r.labelPos) }));
  const labels = (data.rooms || []).filter((r) => r.labelPos && !SHAFT_NAME.test(String(r.name).trim())).map((r) => ({ name: r.name, use: r.use, pos: M(r.labelPos), areaText: r.areaText }));
  const { spaces, faceSpace, warnings } = makeSpaces(faces, labels);
  if (/unit_plan|facility_plan/.test(sheet.category || '')) {
    // 세대 평면은 도면명의 세대 면적(59㎡형 등)이 실 하나의 상한 — 옆 세대·복도로 번진 실을 거른다
    const typeM2 = sheet.category === 'unit_plan' ? Number(/(\d{2,3})(?:\.\d+)?\s*[A-Z]{0,2}\s*(?:㎡|m2|M2|형)/.exec(`${sheet.title || ''} ${sheet.refs?.unitTypes?.[0] || ''}`)?.[1] || 0) : 0;
    // 창(바깥 창·발코니 창)·문(문짝과 여닫는 호)은 벽이 아니라 그래프에 없지만 실의 경계다 — 채우기에서 막는 선으로 쓴다.
    // 가구·각주 레이어의 문 모양 선(미닫이·접이문·붙박이장 문)도 채울 때만 막는다(벽까지 되돌릴 때는 지난다). 그 레이어의 창 모양 선은 쓰지 않는다
    // 문의 여닫는 호는 그대로 막으면 작은 실(안여닫이 욕실)을 문짝·호가 잘라 먹는다 → 닫힌 문짝(경첩 → 벽에 가까운 호 끝) 한 줄로 문 자리만 막는다
    const segDist = (p, e) => { const dx = e.b[0] - e.a[0]; const dy = e.b[1] - e.a[1]; const L2 = dx * dx + dy * dy || 1; const k = Math.max(0, Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / L2)); return Math.hypot(p[0] - e.a[0] - dx * k, p[1] - e.a[1] - dy * k); };
    const wallDist = (p) => graph.edges.reduce((m, e) => Math.min(m, segDist(p, e) - e.t / 2), Infinity);
    const glass = [];
    const doors = [];
    for (const it of items) {
      const tp = it.tc !== undefined ? (it.tc === 'building' ? it.tp : null) : roles[it.layer];
      if ((tp !== 'window' && tp !== 'door') || (notOpening(it) && tp !== 'door') || it.k !== 'path' || !it.pts?.length) continue;
      const pts = it.pts.map(M);
      const r = (it.r || 0) * uf;
      if (tp === 'door' && it.src === 'arc' && it.c && r >= 0.4 && r <= 1.3 && pts.length >= 2) {
        const c = M(it.c);
        const [p0, p1] = [pts[0], pts[pts.length - 1]];
        doors.push({ a: c, b: wallDist(p0) <= wallDist(p1) ? p0 : p1, t: 0.05, h: it.h });
        continue;
      }
      const to = tp === 'door' ? doors : glass;
      for (let i = 0; i + 1 < pts.length; i++) to.push({ a: pts[i], b: pts[i + 1], t: 0.05, h: it.h });
      if (it.closed && pts.length > 2) to.push({ a: pts[pts.length - 1], b: pts[0], t: 0.05, h: it.h });
    }
    // 침실 이름이 없는 세대(원룸형)는 거실·주방이 세대의 대부분이라 상한을 0.9배로
    const studio = sheet.category === 'unit_plan' && labels.length > 0 && !labels.some((l) => (l.use || roomUse(l.name)) === 'bedroom');
    fillRasterSpaces(graph, faces, half, labels, spaces, faceSpace, { maxRoom: typeM2 ? Math.max(20, typeM2 * (studio ? 0.9 : 0.75)) : 150, typeM2, extra: glass, soft: doors, diag });
    // 한 시트에 대칭·평행 이동으로 같은 세대가 여럿인데 이름이 한쪽에만 있으면 짝의 이름을 붙인다(js/bim/mirror-names.js)
    // 실 이름 레이어의 사전에 없는 짧은 글자: 이름 없는 닫힌 칸 안에 그 글자 하나만 있으면 그 칸의 이름(채우기에는 쓰지 않는다)
    const hints = [...shafts, ...items.filter((it) => it.k === 'text' && roles[it.layer] === 'room_name' && layerRoomName(it.t) && !isRoomName(it.t) && !SHAFT_NAME.test(String(it.t).trim()))
      .map((it) => ({ name: String(it.t).trim(), pos: M([it.x, it.y]) }))];
    for (const sp of spaces) {
      if (sp.name !== 'unnamed' || sp.raster) continue;
      const inside = [...new Set(hints.filter((h) => pointInPolygon(h.pos[0], h.pos[1], sp.polygon)).map((h) => h.name))];
      if (inside.length === 1) Object.assign(sp, { name: inside[0], use: roomUse(inside[0]), nameFrom: 'layer' });
    }
    if (sheet.category === 'unit_plan') for (const m of mirrorNames(spaces)) Object.assign(m.space, { name: m.from.name, use: m.from.use, nameFrom: 'mirror', ...(m.from.names ? { names: m.from.names } : {}) });
  }
  const tags = (data.tags || []).filter((t) => t.pos).map((t) => ({ code: t.code, kind: t.kind, pos: M(t.pos), rot: t.rot ?? null }));
  const outerFaces = faces.filter((f) => f.outer).sort((a, b) => a.area - b.area);
  const outline = outerFaces.length ? [...outerFaces[0].poly].reverse() : [];
  const edges = graph.edges.map((e, i) => {
    const { left, right } = edgeFaces(half, i);
    const L = lenOf(e.a, e.b);
    const d = [(e.b[0] - e.a[0]) / L, (e.b[1] - e.a[1]) / L];
    const sides = [faceSpace.get(left) || null, faceSpace.get(right) || null];
    const ops = e.openings.map((o) => {
      const s = (o.s0 + o.s1) / 2;
      const center = [e.a[0] + d[0] * s, e.a[1] + d[1] * s];
      const width = o.s1 - o.s0;
      return { ...o, center, width, along: s, ...describeOpening({ kind: o.kind, insert: o.insert, center, width }, tags, schedule, { balcony: sides.some((sp) => sp?.use === 'balcony') }) };
    });
    return { ...e, i, L, left: sides[0], right: sides[1], leftFace: left, rightFace: right, exterior: Boolean(faces[left]?.outer || faces[right]?.outer), ops };
  });
  // 벽 틈에 들어가지 못한 문·창 블록(벽에 안 붙음)
  const usedIns = new Set(graph.edges.flatMap((e) => e.openings.map((o) => o.insert).filter(Boolean)).map((x) => x.h));
  const unhosted = inserts.filter((x) => !usedIns.has(x.h)).map((x) => {
    let code = null;
    for (const v of Object.values(x.attribs || {})) if (/^[A-Z]{1,3}\d/.test(String(v).trim())) { code = String(v).trim(); break; }
    return { kind: x.kind, code, h: x.h, box: { x0: x.box[0] / uf, y0: x.box[1] / uf, x1: x.box[2] / uf, y1: x.box[3] / uf } };
  });
  // 평면 안 확대 상세의 축척 구역(치수 검산용, js/bim/dim-zones.js)
  const dimZ = dimZones(items, uf, { frame: flat.frame || null });
  return { sheet, uf, graph, faces, half, spaces, faceSpace, edges, columns, unmatched, tags, outline, warnings, labels, unitLabels: data.units || [], cores: data.cores || [], unhosted, dims: flat.dims || [], dimZones: dimZ.zones };
}

// 시트 좌표(도면 단위) 상자 — 근거 표시용
const srcBox = (plan, pts) => { const b = boxOf(pts); return { x0: r3(b[0] / plan.uf), y0: r3(b[1] / plan.uf), x1: r3(b[2] / plan.uf), y1: r3(b[3] / plan.uf) }; };
export const source = (plan, pts, method, confidence, extra = {}) => ({ method, sheets: [{ sheetId: plan.sheet.id, sheetNo: plan.sheet.sheetNo || '', bbox: srcBox(plan, pts) }], confidence, ...extra });

/**
 * 벽(변) → 모델 벽. 실내(in) 쪽이 진행 방향 왼쪽이 되게 방향을 맞춘다.
 * T: 좌표 변환(평면 → 타입·동 자기 좌표), codes: assignWallCodes 결과
 */
function wallOf(plan, e, T, codeInfo, catalog, report, ctx) {
  const L = e.left;
  const R = e.right;
  let inLeft = true;
  if (!L && R) inLeft = false;
  else if (L && R && R.use === 'bath' && L.use !== 'bath') inLeft = false;
  const [pa, pb] = inLeft ? [e.a, e.b] : [e.b, e.a];
  const inSp = inLeft ? L : R;
  const outSp = inLeft ? R : L;
  const sheetNo = plan.sheet.sheetNo || plan.sheet.id;
  const id = hashId('w_', sheetNo, e.hs.join(','), rp(e.a), rp(e.b));
  const tMm = Math.round(e.t * 1000);
  let assemblyId = null;
  let method = 'rule';
  let conf = e.conf;
  const code = codeInfo?.code || null;
  if (code && catalog.assemblies.has(`as_${code}`)) {
    assemblyId = `as_${code}`;
    const diff = Math.abs(totalMm(catalog.assemblies.get(assemblyId)) - tMm);
    if (diff > 20) report.thickness.push({ wallId: id, code, drawnMm: tMm, assemblyMm: totalMm(catalog.assemblies.get(assemblyId)), sheetId: plan.sheet.id, box: srcBox(plan, [e.a, e.b]) });
  } else {
    const key = e.exterior ? 'exterior' : (L?.use === 'bath' || R?.use === 'bath') ? 'bath' : e.t < 0.15 ? 'partition' : 'party';
    assemblyId = defaultAssembly(catalog, key);
    method = 'assumed';
    conf = 0.3;
    if (code) report.undefinedCodes.push({ code, wallId: id, sheetId: plan.sheet.id, pos: codeInfo.tagPos, box: srcBox(plan, [codeInfo.tagPos || e.a, codeInfo.tagPos || e.b]) });
    report.assumedWalls.push(id);
  }
  // 모델 형식(schemas.js)에 맞게: 폭 0.1m 안 되는 문·창은 잡선이라 버리고, 벽 두께는 0.01m 이상(실제 도서에서 형식 위반 30건 —
  // 형식에 안 맞는 동 파일은 구조·상세 수정 연산이 모두 거부됐다, 43 지시서 3절)
  const ops = e.ops.filter((o) => o.width >= 0.1).map((o) => {
    const offset = inLeft ? o.along : e.L - o.along;
    const opId = hashId('op_', sheetNo, id, r3(offset), o.kind);
    if (o.typeCode && o.scheduleWidth && Math.abs(o.scheduleWidth - o.width) > 0.05) report.openingSize.push({ openingId: opId, code: o.typeCode, drawnMm: Math.round(o.width * 1000), scheduleMm: Math.round(o.scheduleWidth * 1000), sheetId: plan.sheet.id, box: srcBox(plan, [o.center, o.center]) });
    if (o.typeCode && !o.scheduleWidth && ctx.hasSchedule) report.openingUndefined.push({ openingId: opId, code: o.typeCode, sheetId: plan.sheet.id, box: srcBox(plan, [o.center, o.center]) });
    return {
      id: opId, kind: o.kind, wallId: id, offset: r3(offset), width: r3(o.width), height: o.height, sill: o.sill, typeCode: o.typeCode,
      source: source(plan, [o.center, o.center], o.method, o.typeCode ? 0.85 : 0.6, o.insert?.h ? { handles: [o.insert.h] } : {}),
    };
  });
  const wall = {
    id, path: [rp(T(pa)), rp(T(pb))], thickness: Math.max(0.01, r3(e.t)), height: null, assemblyId, code: code || null, exterior: e.exterior,
    sides: { in: inSp?.id || null, out: outSp?.id || null },
    source: source(plan, [e.a, e.b], method, Math.round(conf * 100) / 100, { handles: e.hs.slice(0, 20) }),
  };
  return { wall, openings: ops };
}

function spaceOf(plan, sp, T, { catalog, rows, typeName, report, kind }) {
  const sheetNo = plan.sheet.sheetNo || plan.sheet.id;
  const id = hashId('sp_', sheetNo, sp.name, rp(sp.center));
  const row = rows ? (findFinishRow(rows, sp.name, typeName) || (sp.names || []).map((n) => findFinishRow(rows, n, typeName)).find(Boolean) || null) : null;
  const src = source(plan, sp.polygon, sp.name === 'unnamed' ? 'rule' : 'rule', sp.name === 'unnamed' ? 0.3 : 0.8);
  let finish = null;
  let zones = [];
  if (row) {
    const fsrc = { method: 'rule', sheets: [{ sheetId: rows.sheetId, sheetNo: rows.sheetNo || '' }], confidence: 0.8 };
    finish = {
      floor: finishAssembly(catalog, 'floor', row.floor, fsrc),
      wall: finishAssembly(catalog, 'wall', row.wall, fsrc),
      ceiling: finishAssembly(catalog, 'ceiling', row.ceiling, fsrc),
      base: row.base ? catalog.mat(row.base) : null,
    };
    zones = zonesFor(sp, row);
  } else if (sp.name !== 'unnamed' && kind !== 'template' && !COMMON.test(sp.name)) {
    report.missingRooms.push({ spaceId: id, name: sp.name, typeName, sheetId: plan.sheet.id, box: srcBox(plan, sp.polygon) });
    if (sp.use === 'bath' || sp.use === 'balcony') zones = ['waterproof']; // 마감표에 없으면 젖는 실은 방수로 가정
    zones = [...new Set([...zones, ...zonesFor(sp, null)])].sort();
  }
  if (sp.name === 'unnamed') report.unnamed.push({ spaceId: id, sheetId: plan.sheet.id, box: srcBox(plan, sp.polygon) });
  if (sp.nameFrom === 'mirror') report.mirrorNamed.push({ spaceId: id, name: sp.name, sheetId: plan.sheet.id, box: srcBox(plan, sp.polygon) });
  if (sp.label?.areaText) {
    const v = parseFloat(String(sp.label.areaText).replace(/[^\d.]/g, ''));
    if (v > 0 && Math.abs(v - sp.areaM2) / v > 0.1) report.areaMismatch.push({ spaceId: id, name: sp.name, drawn: v, computed: sp.areaM2, sheetId: plan.sheet.id, box: srcBox(plan, sp.polygon) });
  }
  return {
    id, name: sp.name, ...(sp.names?.length > 1 ? { names: sp.names } : {}), ...(sp.nameFrom === 'mirror' ? { nameFrom: 'mirror' } : {}), use: sp.use, polygon: sp.polygon.map((p) => rp(T(p))), areaM2: r3(sp.areaM2), finish, zones,
    source: { ...src, ...(row ? {} : sp.name !== 'unnamed' && kind !== 'template' && !COMMON.test(sp.name) ? { finish: 'assumed' } : {}) },
  };
}

export function newReport() {
  return { assumedWalls: [], undefinedCodes: [], thickness: [], openingSize: [], openingUndefined: [], missingRooms: [], unnamed: [], mirrorNamed: [], areaMismatch: [], unhosted: [], unmatchedSegments: 0, unitTypes: [], warnings: [] };
}

/**
 * 단위세대(또는 시설) 평면 → 타입 모델(u-타입id.json). 원점 = 외곽 상자 왼쪽 아래.
 * @param {ReturnType<typeof analyzePlan>} plan
 */
export function buildType(plan, { id, name, kind = 'unit', catalog, finish, report, hasSchedule = false, edgeFilter = null, spaceFilter = null, outline = null, origin = null }) {
  const ol = outline || plan.outline;
  const b = origin ? [origin[0], origin[1]] : boxOf(ol);
  const T = (p) => [p[0] - b[0], p[1] - b[1]];
  const edges = edgeFilter ? plan.edges.filter(edgeFilter) : plan.edges;
  const codes = assignWallCodes(edges, plan.graph.nodes, plan.tags.filter((t) => t.kind === 'wall'));
  const walls = [];
  const openings = [];
  // 실 먼저(벽의 in/out에 실 id가 필요)
  const spaces = (spaceFilter ? plan.spaces.filter(spaceFilter) : plan.spaces).map((sp) => {
    const s = spaceOf(plan, sp, T, { catalog, rows: finish, typeName: name, report, kind });
    sp.id = s.id;
    return s;
  });
  edges.forEach((e, k) => {
    const r = wallOf(plan, e, T, codes.get(k), catalog, report, { hasSchedule });
    walls.push(r.wall);
    openings.push(...r.openings);
  });
  // 기둥 id: 도면번호 + 개체 손잡이. 실제 도서는 도면번호가 비고 손잡이 없는 기둥(해치·블록)이 많아 같은 id가 나왔다 → 뒤에 번호(43 지시서 3절에서 찾음:
  // 파일 안 id가 겹치면 그 파일을 고치는 수정 연산이 모두 거부된다)
  const seenCol = new Map();
  const columns = plan.columns.filter((c) => !spaceFilter || spaces.length).map((c) => {
    let id = hashId('c_', plan.sheet.sheetNo, (c.hs || []).join(','));
    const n = (seenCol.get(id) || 0) + 1;
    seenCol.set(id, n);
    if (n > 1) id = `${id}_${n}`;
    return { id, polygon: c.polygon.map((p) => rp(T(p))), source: source(plan, c.polygon, 'rule', 0.7) };
  });
  report.unmatchedSegments += plan.unmatched.length;
  if (!plan.unhostedReported) { plan.unhostedReported = true; for (const u of plan.unhosted) report.unhosted.push({ ...u, sheetId: plan.sheet.id }); }
  const mainArea = spaces.filter((s) => !['balcony'].includes(s.use) && !s.name.includes('대피공간')).reduce((a, s) => a + s.areaM2, 0);
  return {
    id, name, kind,
    areaM2: r3(mainArea),
    outline: ol.map((p) => rp(T(p))),
    walls: walls.sort((x, y) => x.id.localeCompare(y.id)),
    columns,
    openings: openings.sort((x, y) => x.id.localeCompare(y.id)),
    spaces: spaces.sort((x, y) => x.id.localeCompare(y.id)),
    source: { method: 'rule', sheets: [{ sheetId: plan.sheet.id, sheetNo: plan.sheet.sheetNo || '' }], confidence: 0.8 },
  };
}

// ---------------------------------------------------------------- 기준층: 세대 묶기

class DSU {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); this.p.set(x, r); return r; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p.set(Math.max(ra, rb), Math.min(ra, rb)); }
}

/**
 * 세대 묶기: 공용 실(계단·승강기·홀·복도…)을 빼고, 얇은 벽(180mm 미만)이나 문·창이 있는 벽을 사이에 둔 실끼리 한 세대.
 * 세대간 벽(두껍고 문 없음)·외벽·공용부에서 나뉜다.
 */
export function groupUnits(plan) {
  const isCommon = (sp) => sp && COMMON.test(sp.name);
  const unitFaces = new Set(plan.spaces.filter((sp) => !isCommon(sp)).map((sp) => sp.face));
  const dsu = new DSU();
  for (const f of unitFaces) dsu.find(f);
  for (const e of plan.edges) {
    if (!unitFaces.has(e.leftFace) || !unitFaces.has(e.rightFace)) continue;
    if (e.t < 0.18 || e.ops.length) dsu.union(e.leftFace, e.rightFace);
  }
  const groups = new Map();
  for (const f of unitFaces) {
    const r = dsu.find(f);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(f);
  }
  const out = [];
  for (const faces of groups.values()) {
    const spaces = plan.spaces.filter((sp) => faces.has(sp.face));
    const edges = plan.edges.filter((e) => faces.has(e.leftFace) || faces.has(e.rightFace));
    const area = spaces.reduce((a, s) => a + s.areaM2, 0);
    if (area < 15) continue; // 세대라기엔 작다(샤프트·창고 등)
    const outline = groupOutline(plan, faces);
    out.push({ faces, spaces, edges, area, outline, box: boxOf(edges.flatMap((e) => [e.a, e.b])) });
  }
  out.sort((a, b) => a.box[0] - b.box[0] || a.box[1] - b.box[1]);
  return out;
}

// 묶음의 바깥 경계(한쪽만 묶음 안인 반변들을 이어서)
function groupOutline(plan, faces) {
  const bnd = [];
  plan.half.forEach((h, i) => { if (faces.has(h.face) && !faces.has(plan.half[i ^ 1].face)) bnd.push(h); });
  if (!bnd.length) return [];
  const nexts = new Map(bnd.map((h) => [h.from, h]));
  const loops = [];
  const used = new Set();
  for (const h0 of bnd) {
    if (used.has(h0)) continue;
    const loop = [];
    let h = h0;
    let guard = 0;
    while (h && !used.has(h) && guard++ < bnd.length + 2) { used.add(h); loop.push(plan.graph.nodes[h.from]); h = nexts.get(h.to); }
    loops.push(loop);
  }
  return loops.sort((a, b) => polyArea(b) - polyArea(a))[0];
}

// 세대 라벨(라인·타입 글자) → 묶음
export function labelGroups(plan, groups) {
  const M = (p) => [p[0] * plan.uf, p[1] * plan.uf];
  for (const g of groups) { g.line = null; g.typeLabel = null; }
  for (const u of plan.unitLabels) {
    if (!u.labelPos) continue;
    const p = M(u.labelPos);
    const g = groups.find((x) => x.spaces.some((sp) => pointInPolygon(p[0], p[1], sp.polygon)));
    if (!g) continue;
    if (u.line && !g.line) g.line = String(u.line);
    if (u.unitType && !g.typeLabel) g.typeLabel = u.unitType;
  }
  // 라인 번호가 없으면 서쪽 → 동쪽으로 1, 2, 3…(가정)
  let n = 0;
  for (const g of groups) { n++; if (!g.line) { g.line = String(n); g.lineAssumed = true; } }
  return groups;
}

// ---------------------------------------------------------------- 타입 맞추기(회전 0/90/180/270 × 좌우 대칭)

function samples(segs, step = 0.2) {
  const out = [];
  for (const [a, b] of segs) {
    const L = lenOf(a, b);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
function nnIndex(pts, cell = 0.5) {
  const g = new Map();
  for (const p of pts) {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(p);
  }
  return (q) => {
    let best = Infinity;
    const cx = Math.floor(q[0] / cell);
    const cy = Math.floor(q[1] / cell);
    for (let r = 0; r <= 3 && best > r * cell; r++) {
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        for (const p of g.get(`${x},${y}`) || []) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
      }
    }
    return Math.min(best, 3);
  };
}

export function placeType(rot, mirror, t) {
  const r = (rot * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e9) / 1e9;
  const s = Math.round(Math.sin(r) * 1e9) / 1e9;
  return (p) => { const x = mirror ? -p[0] : p[0]; return [c * x - s * p[1] + t[0], s * x + c * p[1] + t[1]]; };
}

/** 타입 벽 중심선 ↔ 묶음 벽 중심선 비교 → 가장 잘 맞는 배치 { x, y, rotDeg, mirror, score } */
export function matchType(group, type) {
  const gs = samples(group.edges.map((e) => [e.a, e.b]));
  const gnn = nnIndex(gs);
  const gb = boxOf(gs);
  const gc = [(gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2];
  const ts0 = samples(type.walls.map((w) => w.path));
  let best = null;
  for (const mirror of [false, true]) {
    for (const rot of [0, 90, 180, 270]) {
      const f = placeType(rot, mirror, [0, 0]);
      const pts = ts0.map(f);
      const tb = boxOf(pts);
      const t = [gc[0] - (tb[0] + tb[2]) / 2, gc[1] - (tb[1] + tb[3]) / 2];
      const moved = pts.map((p) => [p[0] + t[0], p[1] + t[1]]);
      const tnn = nnIndex(moved);
      const ab = moved.reduce((s, p) => s + gnn(p), 0) / moved.length;
      const ba = gs.reduce((s, p) => s + tnn(p), 0) / gs.length;
      const score = Math.max(ab, ba);
      if (!best || score < best.score - 1e-9) best = { x: r3(t[0]), y: r3(t[1]), rotDeg: rot, mirror, score: r3(score) };
    }
  }
  const typeArea = type.spaces.reduce((a, sp) => a + sp.areaM2, 0);
  const areaDiff = typeArea ? Math.abs(group.area - typeArea) / typeArea : 1;
  return { ...best, areaDiff: r3(areaDiff) };
}
