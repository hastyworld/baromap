// 평면 안 부분 상세(확대도)의 치수 구역(41 지시서 2.6): 평면(예: 1/40) 안에 그린 확대 상세(예: 1/10)는 같은 모형 공간에 4배로 그려져
// 그 안의 치수 글자가 그린 길이의 1/4이다. 평면 축척으로 견주면 거짓 불일치가 난다.
// 축척 글자("S=1/10", "SCALE 1:20", "축척 1/5")를 둘러싼 가장 작은 닫힌 네모(상세 테두리, 도곽의 30% 미만)를 구역으로 보고,
// 구역 밖의 축척 글자들로 평면 축척을 정한다. 구역 안 치수는 (구역 축척 ÷ 평면 축척) 배로 견주고, 평면 축척을 모르면 견주지 않는다.
// 좌표: items는 시트 단위, 돌려주는 상자는 m. 순수 함수.
const SCALE = /(?:^|[^\d.])1\s*[/:]\s*(\d{1,3})(?![\d.])/;

/** 글자에서 축척 분모(1/40 → 40). 축척처럼 보이지 않으면 null */
export function scaleDen(text) {
  const t = String(text || '').trim();
  if (!/S\s*=|SCALE|축척|^\s*1\s*[/:]/i.test(t)) return null;
  const m = SCALE.exec(` ${t}`);
  const den = m ? Number(m[1]) : NaN;
  return den >= 1 && den <= 500 ? den : null;
}

const isRect = (pts) => {
  const p = pts.length === 5 && Math.hypot(pts[0][0] - pts[4][0], pts[0][1] - pts[4][1]) < 1e-9 ? pts.slice(0, 4) : pts;
  if (p.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = [p[(i + 1) % 4][0] - p[i][0], p[(i + 1) % 4][1] - p[i][1]];
    const b = [p[(i + 2) % 4][0] - p[(i + 1) % 4][0], p[(i + 2) % 4][1] - p[(i + 1) % 4][1]];
    const la = Math.hypot(...a) || 1;
    const lb = Math.hypot(...b) || 1;
    if (Math.abs((a[0] * b[0] + a[1] * b[1]) / (la * lb)) > 0.02) return false;
  }
  return true;
};

/**
 * @param {any[]} items 시트 모양(text·path)
 * @param {number} uf 도면 단위 → m
 * @param {{ frame?: {x0:number,y0:number,x1:number,y1:number}|null }} [o]
 * @returns {{ mainDen: number|null, zones: Array<{ box: number[], den: number, ratio: number|null }> }}
 */
export function dimZones(items, uf, { frame = null } = {}) {
  const scales = items.filter((it) => it.k === 'text' && scaleDen(it.t)).map((it) => ({ den: scaleDen(it.t), p: [it.x * uf, it.y * uf] }));
  if (!scales.length) return { mainDen: null, zones: [] };
  const fa = frame ? (frame.x1 - frame.x0) * (frame.y1 - frame.y0) * uf * uf : Infinity;
  const rects = items.filter((it) => it.k === 'path' && it.closed && it.pts?.length >= 4 && isRect(it.pts)).map((it) => {
    const xs = it.pts.map((q) => q[0] * uf);
    const ys = it.pts.map((q) => q[1] * uf);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return { box, area: (box[2] - box[0]) * (box[3] - box[1]) };
  }).filter((r) => r.area > 0.5 && r.area < fa * 0.3);
  const zones = [];
  const outside = [];
  for (const s of scales) {
    const r = rects.filter((x) => s.p[0] >= x.box[0] && s.p[0] <= x.box[2] && s.p[1] >= x.box[1] && s.p[1] <= x.box[3]).sort((a, b) => a.area - b.area)[0];
    if (r) zones.push({ box: r.box, den: s.den });
    else outside.push(s.den);
  }
  // 평면 축척: 구역 밖 축척 글자 중 가장 많은 것(같으면 큰 분모 — 표제란의 1/1 같은 쪽수 글자보다 평면 축척이 크다)
  const count = new Map();
  for (const d of outside) if (d > 1) count.set(d, (count.get(d) || 0) + 1);
  const mainDen = [...count].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
  return { mainDen, zones: zones.map((z) => ({ ...z, ratio: mainDen ? z.den / mainDen : null })) };
}

/** 치수 하나: 구역 안이면 그 구역의 배(모르면 null = 견주지 않음), 밖이면 1 */
export function dimRatio(zones, p) {
  const z = zones.filter((x) => p[0] >= x.box[0] && p[0] <= x.box[2] && p[1] >= x.box[1] && p[1] <= x.box[3]).sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
  return z ? z.ratio : 1;
}
