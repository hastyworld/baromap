// 단지 확장(21 지시서 4절): 조경·토목 평면에서 지형·포장·수목·시설물을 읽는다. 순수 함수. 좌표는 site.json과 같다(m, 대지 가운데 원점).
//   delaunay()  삼각망(Bowyer-Watson)     heightAt()  지형 높이     readSiteDetail()  시트 → site.json의 새 칸
import { pointInPolygon, boxOf } from '../cad/geom.js';
import { hashId, r3, rp } from './ids.js';

/** 점 목록 → 삼각형 번호 목록 */
export function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return [];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const d = Math.max(x1 - x0, y1 - y0, 1) * 10;
  const P = [...pts, [x0 - d, y0 - d], [x1 + d, y0 - d], [(x0 + x1) / 2, y1 + d]];
  let tris = [{ a: n, b: n + 1, c: n + 2 }];
  const circum = (t) => {
    const [ax, ay] = P[t.a];
    const [bx, by] = P[t.b];
    const [cx, cy] = P[t.c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-9) return null;
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
  };
  for (let i = 0; i < n; i++) {
    const [x, y] = P[i];
    const bad = [];
    const keep = [];
    for (const t of tris) { const c = t.cc ??= circum(t); if (c && Math.hypot(x - c.x, y - c.y) < c.r - 1e-9) bad.push(t); else keep.push(t); }
    const edge = new Map();
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
        const k = u < v ? `${u}|${v}` : `${v}|${u}`;
        edge.set(k, edge.has(k) ? null : [u, v]);
      }
    }
    tris = keep;
    for (const e of edge.values()) if (e) tris.push({ a: e[0], b: e[1], c: i });
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

/** 지형 높이: 삼각망 안이면 평면 보간, 밖이면 가장 가까운 점. 지형이 없으면 null */
export function heightAt(terrain, x, y) {
  if (!terrain?.points?.length) return null;
  const P = terrain.points;
  for (const [i, j, k] of terrain.triangles || []) {
    const [ax, ay, az] = P[i];
    const [bx, by, bz] = P[j];
    const [cx, cy, cz] = P[k];
    const D = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(D) < 1e-12) continue;
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / D;
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / D;
    const w = 1 - u - v;
    if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * az + v * bz + w * cz;
  }
  let best = P[0];
  let bd = Infinity;
  for (const p of P) { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = p; } }
  return best[2];
}

const GL = /^(?:GL|EL|FL)?\s*[+＋]?\s*(\d{1,4}\.\d{1,3})$/i;
const CONTOUR = /^(?:EL|GL)\s*[+＋]?\s*(\d{1,4}(?:\.\d{1,3})?)$/i;

const FEATURE_WORDS = [
  [/놀이|PLAY/i, 'playground'], [/벤치|BENCH/i, 'bench'], [/가로등|보안등|LIGHT/i, 'light'], [/담장|휀스|펜스|FENCE/i, 'fence'],
  [/옹벽|RETAIN/i, 'retaining'], [/경사로|RAMP/i, 'ramp'], [/출입구|ENTRANCE/i, 'entrance'],
];
const featureKind = (s) => FEATURE_WORDS.find(([re]) => re.test(String(s)))?.[1] || null;
const FEATURE_H = { bench: 0.45, light: 4, fence: 1.2, retaining: 1.5, playground: 0.1, ramp: 0.2, entrance: 2.4, other: 1 };

// 범례 표: 기호 → 재료, 수종 → 높이
function legends(tables = []) {
  const paving = new Map();
  const tree = new Map();
  for (const t of tables) {
    const head = (t.rows[0] || []).join(' ');
    if (/기호/.test(head) && /포장|재료/.test(head)) for (const r of t.rows.slice(1)) if (r[0]) paving.set(String(r[0]).trim(), String(r[1] || '').trim());
    if (/수종/.test(head)) for (const r of t.rows.slice(1)) { const m = /H\s*=?\s*(\d+(?:\.\d+)?)/i.exec((r || []).join(' ')); if (r[0]) tree.set(String(r[0]).trim(), m ? Number(m[1]) : null); }
  }
  return { paving, tree };
}

/**
 * @param {any} sheet 조경·토목 시트(layerRoles, sheetNo)
 * @param {{ items: any[] }} flat
 * @param {{ uf: number, origin: number[], tables?: any[], mat: (name: string) => string }} o
 * @returns {{ terrain: any|null, pavings: any[], trees: any[], features: any[] }}
 */
export function readSiteDetail(sheet, flat, { uf, origin, tables = [], mat }) {
  const roles = sheet.layerRoles || {};
  const items = flat.items;
  const L = (x, y) => rp([x * uf - origin[0], y * uf - origin[1]]);
  const src = (it, confidence = 0.6) => ({ method: 'rule', sheets: [{ sheetId: sheet.id, sheetNo: sheet.sheetNo || '' }], confidence, handle: it?.h });
  const texts = items.filter((it) => it.k === 'text');
  const { paving, tree } = legends(tables);

  // 지형: 점표고 + 등고선(글자가 가장 가까운 선의 높이)
  const pts = [];
  for (const t of texts) {
    if (roles[t.layer] !== 'spot_level') continue;
    const m = GL.exec(String(t.t).trim());
    if (m) pts.push([...L(t.x, t.y), Number(m[1])]);
  }
  const lines = items.filter((it) => it.k === 'path' && roles[it.layer] === 'contour');
  const labels = texts.filter((t) => roles[t.layer] === 'contour').map((t) => ({ t, z: Number(CONTOUR.exec(String(t.t).trim())?.[1]) })).filter((x) => Number.isFinite(x.z));
  for (const l of lines) {
    let best = null;
    let bd = Infinity;
    for (const x of labels) for (const p of l.pts) { const d = Math.hypot(p[0] - x.t.x, p[1] - x.t.y); if (d < bd) { bd = d; best = x; } }
    if (best) for (const p of l.pts) pts.push([...L(p[0], p[1]), best.z]);
  }
  const seen = new Set();
  const points = pts.filter((p) => { const k = `${p[0]}|${p[1]}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const terrain = points.length >= 3 ? { points, triangles: delaunay(points), source: src(null) } : null;

  // 포장: 해치 + 안의 범례 기호
  const pavings = [];
  for (const it of items) {
    if (it.k !== 'hatch' || roles[it.layer] !== 'paving') continue;
    for (const loop of it.loops || []) {
      const label = texts.find((t) => pointInPolygon(t.x, t.y, loop));
      const code = String(label?.t || '').trim();
      const name = paving.get(code) || null;
      pavings.push({ id: hashId('pv_', sheet.sheetNo, it.h), polygon: loop.map(([x, y]) => L(x, y)), code: code || null, materialId: name ? mat(name) : null, elevation: null, source: src(it) });
    }
  }

  // 수목: 블록 이름에서 수종, 수량표에서 높이
  const trees = [];
  for (const it of items) {
    if (it.k !== 'insert' || roles[it.layer] !== 'tree') continue;
    const species = String(it.name || '').replace(/^T[-_]/i, '') || null;
    const [x, y] = L(it.x, it.y);
    trees.push({ id: hashId('tr_', sheet.sheetNo, it.h), x, y, species, heightM: tree.get(species) ?? null, source: src(it) });
  }

  // 시설물: 블록 이름, 닫힌 선·선의 안쪽 글자
  const features = [];
  for (const it of items) {
    if (roles[it.layer] !== 'site_feature' || it.depth) continue; // 블록 안의 선은 블록 하나로 센다
    if (it.k === 'insert') {
      const kind = featureKind(it.name) || 'other';
      const [x, y] = L(it.x, it.y);
      features.push({ id: hashId('ft_', sheet.sheetNo, it.h), kind, polygon: [[x, y]], heightM: FEATURE_H[kind], source: src(it) });
    } else if (it.k === 'path' && it.pts.length >= 2) {
      const b = boxOf(it.pts);
      const hit = texts.find((t) => roles[t.layer] === 'site_feature' && (it.closed ? pointInPolygon(t.x, t.y, it.pts) : t.x >= b[0] - 2000 && t.x <= b[2] + 2000 && t.y >= b[1] - 2000 && t.y <= b[3] + 2000));
      const kind = featureKind(hit?.t) || 'other';
      const h = /H\s*=\s*(\d+(?:\.\d+)?)/i.exec(String(hit?.t || ''));
      features.push({ id: hashId('ft_', sheet.sheetNo, it.h), kind, polygon: it.pts.map(([x, y]) => L(x, y)), heightM: h ? Number(h[1]) : FEATURE_H[kind], closed: Boolean(it.closed), source: src(it) });
    }
  }
  return { terrain, pavings, trees, features };
}

// 다각형 삼각형을 지형에 붙이려고 긴 변을 나눈다(드레이프). tri: [[x,y], [x,y], [x,y]]
export function subdivide(tris, maxEdge = 6) {
  const out = [];
  const stack = [...tris];
  let guard = 0;
  while (stack.length && guard++ < 200000) {
    const t = stack.pop();
    const [a, b, c] = t;
    const e = [[a, b, c], [b, c, a], [c, a, b]].map(([p, q, r]) => ({ p, q, r, l: Math.hypot(p[0] - q[0], p[1] - q[1]) })).sort((x, y) => y.l - x.l)[0];
    if (e.l <= maxEdge) { out.push(t); continue; }
    const m = [(e.p[0] + e.q[0]) / 2, (e.p[1] + e.q[1]) / 2];
    stack.push([e.p, m, e.r], [m, e.q, e.r]);
  }
  return out;
}

export const baseOf = (terrain) => (terrain?.points?.length ? Math.min(...terrain.points.map((p) => p[2])) : 0);
export const r3Height = (terrain, x, y) => { const h = heightAt(terrain, x, y); return h == null ? null : r3(h); };
