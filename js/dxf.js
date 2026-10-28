// 도면(DXF) 읽기: 레이어별로 벽·기둥·창호 선을 뽑아 3D 모델 재료(미터 단위 선분·닫힌 도형)로 바꾼다.
// AutoCAD에서 "다른 이름으로 저장 → DXF"로 저장한 ASCII DXF를 읽는다(DWG는 DXF로 바꿔서 올린다).
// 화면과 무관한 순수 계산이라 Node 테스트에서도 쓴다.

const UNIT_M = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 }; // $INSUNITS → 미터
export const UNIT_LABEL = { 0.001: 'mm', 0.01: 'cm', 1: 'm', 0.0254: 'inch', 0.3048: 'feet' };
export const LIMITS = { segs: 120000, solids: 20000 };

// 파일 바이트 → 글자. 2007 이후 DXF는 UTF-8, 그 전 한글 도면은 CP949(EUC-KR)인 경우가 많다.
export function decodeDxf(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (String.fromCharCode(...bytes.slice(0, 18)) === 'AutoCAD Binary DXF') {
    throw new Error('바이너리 DXF는 읽을 수 없습니다. AutoCAD에서 ASCII 형식 DXF로 다시 저장해주세요.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('euc-kr').decode(bytes);
  }
  // 옛 형식의 유니코드 표기(\U+BCBD)를 글자로
  return text.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ---------------------------------------------------------------- 읽기

function pairs(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (Number.isNaN(code)) continue;
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

// 한 개체의 그룹 코드 목록 → 바로맵이 쓰는 모양
function toEntity(type, kv, vertices) {
  const get = (c, d) => { const hit = kv.find(([k]) => k === c); return hit ? hit[1] : d; };
  const layer = get(8, '0');
  const flip = num(get(230, 1), 1) < 0; // 뒤집힌(대칭 복사된) 개체
  const fx = (x) => (flip ? -x : x);
  if (type === 'LINE') return { type: 'line', layer, a: [num(get(10)), num(get(20))], b: [num(get(11)), num(get(21))] };
  if (type === 'ARC' || type === 'CIRCLE') {
    const c = [fx(num(get(10))), num(get(20))];
    const r = num(get(40));
    if (type === 'CIRCLE') return { type: 'circle', layer, c, r };
    let a0 = num(get(50));
    let a1 = num(get(51), 360);
    if (flip) [a0, a1] = [180 - a1, 180 - a0];
    return { type: 'arc', layer, c, r, a0, a1 };
  }
  if (type === 'LWPOLYLINE') {
    const pts = [];
    for (const [k, v] of kv) {
      if (k === 10) pts.push([fx(num(v)), 0, 0]);
      else if (k === 20 && pts.length) pts[pts.length - 1][1] = num(v);
      else if (k === 42 && pts.length) pts[pts.length - 1][2] = flip ? -num(v) : num(v);
    }
    return { type: 'poly', layer, pts, closed: (num(get(70)) & 1) === 1 };
  }
  if (type === 'POLYLINE') {
    if (num(get(70)) & (16 | 64)) return null; // 3D 메시·폴리페이스는 건너뜀
    return { type: 'poly', layer, pts: vertices.map((v) => [fx(v.x), v.y, flip ? -v.bulge : v.bulge]), closed: (num(get(70)) & 1) === 1 };
  }
  if (type === 'INSERT') {
    return { type: 'insert', layer, name: get(2, ''), at: [num(get(10)), num(get(20))], sx: num(get(41), 1), sy: num(get(42), 1), rot: num(get(50)), flip };
  }
  return { type: 'other', layer };
}

// 0 코드로 시작하는 개체를 end(ENDSEC/ENDBLK)까지 읽는다. POLYLINE은 뒤따르는 VERTEX·SEQEND를 묶는다.
function readEntities(p, i, end) {
  const list = [];
  while (i < p.length) {
    const [code, type] = p[i];
    if (code !== 0) { i++; continue; }
    if (type === end || type === 'ENDSEC') return { list, i };
    const kv = [];
    i++;
    while (i < p.length && p[i][0] !== 0) kv.push(p[i++]);
    let vertices = [];
    if (type === 'POLYLINE') {
      while (i < p.length && p[i][0] === 0 && p[i][1] === 'VERTEX') {
        const v = { x: 0, y: 0, bulge: 0 };
        i++;
        while (i < p.length && p[i][0] !== 0) {
          const [k, val] = p[i++];
          if (k === 10) v.x = num(val);
          else if (k === 20) v.y = num(val);
          else if (k === 42) v.bulge = num(val);
        }
        vertices.push(v);
      }
      if (i < p.length && p[i][1] === 'SEQEND') { i++; while (i < p.length && p[i][0] !== 0) i++; }
    }
    const e = toEntity(type, kv, vertices);
    if (e) list.push(e);
  }
  return { list, i };
}

export function parseDxf(text) {
  const p = pairs(text);
  const dxf = { insunits: 0, blocks: {}, entities: [] };
  let i = 0;
  let found = false;
  while (i < p.length) {
    if (!(p[i][0] === 0 && p[i][1] === 'SECTION')) { i++; continue; }
    found = true;
    const name = p[i + 1]?.[1];
    i += 2;
    if (name === 'HEADER') {
      while (i < p.length && !(p[i][0] === 0 && p[i][1] === 'ENDSEC')) {
        if (p[i][0] === 9 && p[i][1] === '$INSUNITS') dxf.insunits = num(p[i + 1]?.[1]);
        i++;
      }
    } else if (name === 'BLOCKS') {
      while (i < p.length && !(p[i][0] === 0 && p[i][1] === 'ENDSEC')) {
        if (p[i][0] === 0 && p[i][1] === 'BLOCK') {
          const head = [];
          i++;
          while (i < p.length && p[i][0] !== 0) head.push(p[i++]);
          const get = (c, d) => { const hit = head.find(([k]) => k === c); return hit ? hit[1] : d; };
          const r = readEntities(p, i, 'ENDBLK');
          dxf.blocks[get(2, '')] = { base: [num(get(10)), num(get(20))], entities: r.list };
          i = r.i + 1;
        } else i++;
      }
    } else if (name === 'ENTITIES') {
      const r = readEntities(p, i, 'ENDSEC');
      dxf.entities = r.list;
      i = r.i;
    } else {
      while (i < p.length && !(p[i][0] === 0 && p[i][1] === 'ENDSEC')) i++;
    }
  }
  if (!found) throw new Error('DXF 도면 파일이 아닙니다. AutoCAD에서 DXF로 저장한 파일을 올려주세요.');
  return dxf;
}

// ---------------------------------------------------------------- 2D 변환(블록 끼워 넣기)

const ID = [1, 0, 0, 1, 0, 0]; // x' = a x + c y + e, y' = b x + d y + f
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function insertMatrix(e, base) {
  const r = (e.rot * Math.PI) / 180;
  const [cs, sn] = [Math.cos(r), Math.sin(r)];
  // 이동(삽입점) · 회전 · 배율 · 기준점 빼기. 뒤집힌 개체는 마지막에 x를 뒤집는다.
  const m = [cs * e.sx, sn * e.sx, -sn * e.sy, cs * e.sy, e.at[0], e.at[1]];
  const w = e.flip ? [-m[0], m[1], -m[2], m[3], -m[4], m[5]] : m;
  return mul(w, [1, 0, 0, 1, -base[0], -base[1]]);
}

// 호를 짧은 선으로(10°마다)
function arcPoints(c, r, a0, a1) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 360;
  const n = Math.max(2, Math.ceil(sweep / 10));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = ((a0 + (sweep * k) / n) * Math.PI) / 180;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

// 폴리선(볼록 bulge 포함) → 점 목록
function polyPoints(pts, closed) {
  const out = [];
  const n = pts.length;
  for (let k = 0; k < n; k++) {
    const [x1, y1, b] = pts[k];
    out.push([x1, y1]);
    if (!b || (k === n - 1 && !closed)) continue;
    const [x2, y2] = pts[(k + 1) % n];
    const th = 4 * Math.atan(b);
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (!d) continue;
    const r = d / (2 * Math.sin(th / 2));
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2)) * Math.sign(b) * (Math.abs(th) > Math.PI ? -1 : 1);
    const cx = mx - (h * (y2 - y1)) / d;
    const cy = my + (h * (x2 - x1)) / d;
    const a0 = (Math.atan2(y1 - cy, x1 - cx) * 180) / Math.PI;
    const a1 = (Math.atan2(y2 - cy, x2 - cx) * 180) / Math.PI;
    const arc = b > 0 ? arcPoints([cx, cy], Math.abs(r), a0, a1) : arcPoints([cx, cy], Math.abs(r), a1, a0).reverse();
    out.push(...arc.slice(1, -1));
  }
  return out;
}

// 블록을 모두 풀어서 개체마다 fn(개체, 변환, 실제 레이어)을 부른다. 블록 안 레이어 "0"은 끼워 넣은 레이어를 따른다.
function walk(dxf, fn) {
  const visit = (ents, m, inherit, depth) => {
    for (const e of ents) {
      const layer = e.layer === '0' && inherit ? inherit : e.layer;
      if (e.type === 'insert') {
        const b = dxf.blocks[e.name];
        if (b && depth < 8) visit(b.entities, mul(m, insertMatrix(e, b.base)), layer, depth + 1);
        continue;
      }
      fn(e, m, layer);
    }
  };
  visit(dxf.entities, ID, null, 0);
}

// 레이어별 그릴 수 있는 개체 수(선·폴리선·호·원)
export function dxfLayers(dxf) {
  const count = {};
  walk(dxf, (e, m, layer) => { if (e.type !== 'other') count[layer] = (count[layer] || 0) + 1; });
  return Object.entries(count).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
}

// 레이어 이름으로 쓰임새 추측: 벽·기둥(wall) / 창호(glass) / 빼기(skip)
export function guessLayerRole(name) {
  const s = String(name).toUpperCase();
  if (/WIN|GLAS|창호|유리|창문|^창|CURTAIN/.test(s)) return 'glass';
  if (/DOOR|문|TEXT|TXT|글자|문자|DIM|치수|HATCH|해치|FURN|가구|SYM|기호|GRID|중심|CEN|AXIS|ELEV|입면|PAT|TITLE|도곽|DEFPOINTS|VIEWPORT|ROOM|실명|NOTE|LEADER|인출/.test(s)) return 'skip';
  if (/WALL|벽|CON|COL|기둥|STR|구조|CORE|코어|SLAB|슬래브|^S-|^A-W|PARA|난간|LIN|경량/.test(s)) return 'wall';
  return 'skip';
}

// ---------------------------------------------------------------- 3D 재료로

// 단위: $INSUNITS가 있으면 그대로, 없으면 크기로 추측(건물 한 층이 수십 m라고 보고)
export function guessUnit(dxf, span) {
  if (UNIT_M[dxf.insunits]) return UNIT_M[dxf.insunits];
  if (span > 2000) return 0.001;
  if (span > 200) return 0.01;
  return 1;
}

const area = (pts) => { let a = 0; for (let k = 0; k < pts.length; k++) { const [x1, y1] = pts[k]; const [x2, y2] = pts[(k + 1) % pts.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; };
const perim = (pts) => { let s = 0; for (let k = 0; k < pts.length; k++) { const [x1, y1] = pts[k]; const [x2, y2] = pts[(k + 1) % pts.length]; s += Math.hypot(x2 - x1, y2 - y1); } return s; };

/**
 * 고른 레이어의 선을 미터 단위 3D 재료로 바꾼다.
 * roles: { 레이어이름: 'wall' | 'glass' | 'skip' }, unit: 1단위가 몇 m인지(없으면 추측)
 * → { walls:[x1,y1,x2,y2,…], glass:[…], solids:[[x,y,…],…], unit, size:[가로,세로] } (가운데가 0,0)
 */
export function extractGeometry(dxf, roles, unit) {
  const walls = [];
  const glass = [];
  const solids = [];
  const pushSeg = (arr, a, b) => { arr.push(a[0], a[1], b[0], b[1]); };
  walk(dxf, (e, m, layer) => {
    const role = roles[layer];
    if (role !== 'wall' && role !== 'glass') return;
    const out = role === 'glass' ? glass : walls;
    const line = (pts, closed) => {
      const t = pts.map(([x, y]) => apply(m, x, y));
      for (let k = 0; k + 1 < t.length; k++) pushSeg(out, t[k], t[k + 1]);
      if (closed && t.length > 2) pushSeg(out, t[t.length - 1], t[0]);
      return t;
    };
    if (e.type === 'line') line([e.a, e.b], false);
    else if (e.type === 'arc') line(arcPoints(e.c, e.r, e.a0, e.a1), false);
    else if (e.type === 'circle' || (e.type === 'poly' && e.closed && e.pts.length > 2)) {
      const pts = e.type === 'circle' ? arcPoints(e.c, e.r, 0, 360).slice(0, -1) : polyPoints(e.pts, true);
      const t = pts.map(([x, y]) => apply(m, x, y));
      if (role === 'wall') solids.push({ pts: t });
      else line(pts, true);
    } else if (e.type === 'poly') line(polyPoints(e.pts, false), false);
  });
  // 크기를 보고 단위를 정한 뒤 미터로, 가운데를 0,0으로
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const arr of [walls, glass]) for (let k = 0; k < arr.length; k += 2) grow(arr[k], arr[k + 1]);
  for (const s of solids) for (const [x, y] of s.pts) grow(x, y);
  if (minX > maxX) return { walls: [], glass: [], solids: [], unit: unit || 1, size: [0, 0] };
  const u = unit || guessUnit(dxf, Math.max(maxX - minX, maxY - minY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const toM = (arr) => {
    const out = [];
    for (let k = 0; k < arr.length; k += 4) {
      const [x1, y1, x2, y2] = [(arr[k] - cx) * u, (arr[k + 1] - cy) * u, (arr[k + 2] - cx) * u, (arr[k + 3] - cy) * u];
      if (Math.hypot(x2 - x1, y2 - y1) >= 0.02) out.push(x1, y1, x2, y2);
    }
    return out;
  };
  const solidM = [];
  const wallM = toM(walls);
  for (const s of solids) {
    const pts = s.pts.map(([x, y]) => [(x - cx) * u, (y - cy) * u]);
    const a = area(pts);
    // 얇거나 작은 닫힌 도형(벽체·기둥)은 꽉 찬 덩어리로, 큰 도형(방·외곽선)은 테두리 벽으로
    if (a > 0.0004 && a < 30 && a / perim(pts) < 0.35) solidM.push(pts.flat());
    else for (let k = 0; k < pts.length; k++) { const p1 = pts[k]; const p2 = pts[(k + 1) % pts.length]; wallM.push(p1[0], p1[1], p2[0], p2[1]); }
  }
  return { walls: wallM, glass: toM(glass), solids: solidM, unit: u, size: [(maxX - minX) * u, (maxY - minY) * u] };
}

// 볼록 껍질(바닥 슬래브 모양)
export function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop(); lower.push(pt); }
  const upper = [];
  for (const pt of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop(); upper.push(pt); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// 저장용으로 작게: cm 정수, 바닥 모양(볼록 껍질) 포함
export function packGeometry(g) {
  const cm = (arr) => arr.map((v) => Math.round(v * 100));
  const pts = [];
  for (let k = 0; k < g.walls.length; k += 2) pts.push([g.walls[k], g.walls[k + 1]]);
  for (const s of g.solids) for (let k = 0; k < s.length; k += 2) pts.push([s[k], s[k + 1]]);
  if (g.walls.length / 4 > LIMITS.segs || g.solids.length > LIMITS.solids) {
    throw new Error('도면 선이 너무 많습니다. 벽·기둥 레이어만 고르거나 도면을 한 동(한 세대)씩 나눠 올려주세요.');
  }
  return {
    v: 1,
    walls: cm(g.walls),
    glass: cm(g.glass),
    solids: g.solids.map(cm),
    floor: cm(hull(pts).flat()),
    size: g.size.map((v) => Math.round(v * 100) / 100),
  };
}
