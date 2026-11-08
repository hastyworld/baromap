// 표 복원: 선으로 그린 표(가로선 3개 이상이 같은 폭, 세로선이 같은 높이) → 칸마다 글자.
// 선이 없으면 글자 줄·열 정렬로 복원(행 3개·열 3개 이상, 줄 간격이 고른 것만). 순수 함수.

const near = (a, b, tol) => Math.abs(a - b) <= tol;

function uniq(values, tol) {
  const s = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

// 가로·세로 선분 모으기(시트 좌표 path 항목에서)
export function axisSegments(items) {
  const hs = [];
  const vs = [];
  for (const it of items) {
    if (it.k !== 'path' || it.src === 'arc' || it.src === 'circle' || it.src === 'spline' || it.src === 'ellipse') continue;
    const pts = it.pts;
    const n = it.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!len) continue;
      if (Math.abs(y2 - y1) <= len * 1e-3) hs.push({ y: (y1 + y2) / 2, x0: Math.min(x1, x2), x1: Math.max(x1, x2) });
      else if (Math.abs(x2 - x1) <= len * 1e-3) vs.push({ x: (x1 + x2) / 2, y0: Math.min(y1, y2), y1: Math.max(y1, y2) });
    }
  }
  return { hs, vs };
}

/**
 * @param {any[]} items flatten 결과
 * @param {{ maxTables?: number }} [opts]
 * @returns {{ bbox: number[], rows: string[][], lined: boolean }[]}
 */
export function findTables(items, { maxTables = 20 } = {}) {
  const texts = items.filter((it) => it.k === 'text');
  const { hs, vs } = axisSegments(items);
  const tables = [];
  const usedTexts = new Set();
  // 같은 x 범위를 가진 가로선 묶음
  const groups = [];
  for (const h of hs) {
    const w = h.x1 - h.x0;
    const tol = Math.max(w * 0.005, 1e-6);
    let g = groups.find((x) => near(x.x0, h.x0, tol) && near(x.x1, h.x1, tol));
    if (!g) { g = { x0: h.x0, x1: h.x1, ys: [] }; groups.push(g); }
    g.ys.push(h.y);
  }
  for (const g of groups) {
    const w = g.x1 - g.x0;
    const tol = w * 0.005;
    const ys = uniq(g.ys, tol).reverse(); // 위에서 아래로
    if (ys.length < 3) continue;
    const top = ys[0];
    const bottom = ys[ys.length - 1];
    const h = top - bottom;
    // 표 높이 전체(또는 거의)를 덮는 세로선
    const xs = uniq(vs.filter((v) => v.x >= g.x0 - tol && v.x <= g.x1 + tol && v.y0 <= bottom + h * 0.02 && v.y1 >= top - h * 0.02).map((v) => v.x), tol);
    if (xs.length < 2) continue;
    if (!near(xs[0], g.x0, tol * 4) || !near(xs[xs.length - 1], g.x1, tol * 4)) continue;
    const rows = [];
    for (let r = 0; r + 1 < ys.length; r++) {
      const row = [];
      for (let c = 0; c + 1 < xs.length; c++) {
        const cell = texts.filter((t) => {
          const [cx, cy] = [(t.box[0] + t.box[2]) / 2, (t.box[1] + t.box[3]) / 2];
          return cx > xs[c] && cx < xs[c + 1] && cy < ys[r] && cy > ys[r + 1];
        }).sort((a, b) => b.y - a.y || a.x - b.x);
        for (const t of cell) usedTexts.add(t);
        row.push(cell.map((t) => t.t.replace(/\s+/g, ' ').trim()).join(' '));
      }
      rows.push(row);
    }
    const filled = rows.filter((r) => r.filter(Boolean).length >= 2);
    if (filled.length < 2) continue;
    tables.push({ bbox: [g.x0, bottom, g.x1, top], rows: rows.filter((r) => r.some(Boolean)), lined: true });
  }
  // 선 없는 표: 글자 줄(같은 높이 기준선)과 왼쪽 정렬 열
  const rest = texts.filter((t) => !usedTexts.has(t) && Math.abs(((t.rot || 0) % 360 + 360) % 360) < 1);
  tables.push(...textTables(rest));
  // 큰 표 먼저(행×열)
  tables.sort((a, b) => b.rows.length * (b.rows[0]?.length || 0) - a.rows.length * (a.rows[0]?.length || 0));
  return tables.slice(0, maxTables);
}

function textTables(texts) {
  if (texts.length < 9) return [];
  const out = [];
  const bySize = new Map();
  for (const t of texts) {
    const k = Math.round(t.size * 10) / 10;
    if (!bySize.has(k)) bySize.set(k, []);
    bySize.get(k).push(t);
  }
  for (const [size, list] of bySize) {
    if (list.length < 9) continue;
    // 줄 묶기
    const lines = [];
    for (const t of [...list].sort((a, b) => b.y - a.y)) {
      const ln = lines.find((l) => Math.abs(l.y - t.y) <= size * 0.4);
      if (ln) ln.items.push(t);
      else lines.push({ y: t.y, items: [t] });
    }
    const multi = lines.filter((l) => l.items.length >= 3).sort((a, b) => b.y - a.y);
    // 줄 간격이 고른 연속 줄 묶음
    let run = [];
    const flush = () => {
      if (run.length >= 3) {
        const cols = uniq(run.flatMap((l) => l.items.map((t) => t.box[0])), size * 1.2);
        const shared = cols.filter((x) => run.filter((l) => l.items.some((t) => Math.abs(t.box[0] - x) <= size * 1.2)).length >= Math.ceil(run.length * 0.7));
        if (shared.length >= 3) {
          const rows = run.map((l) => shared.map((x, i) => l.items.filter((t) => t.box[0] >= x - size * 1.2 && (i + 1 >= shared.length || t.box[0] < shared[i + 1] - size * 1.2))
            .sort((a, b) => a.x - b.x).map((t) => t.t.trim()).join(' ')));
          const xs = run.flatMap((l) => l.items.flatMap((t) => [t.box[0], t.box[2]]));
          out.push({ bbox: [Math.min(...xs), run[run.length - 1].y - size, Math.max(...xs), run[0].y + size], rows, lined: false });
        }
      }
      run = [];
    };
    for (const l of multi) {
      if (run.length) {
        const gap = run[run.length - 1].y - l.y;
        const prevGap = run.length >= 2 ? run[run.length - 2].y - run[run.length - 1].y : gap;
        if (gap > size * 4 || Math.abs(gap - prevGap) > size * 0.6) flush();
      }
      run.push(l);
    }
    flush();
  }
  return out;
}

// 표의 머리글 행에서 열 찾기: names = { room: /실명/, floor: /바닥/ … } → { room: 0, floor: 2 … }, 머리글 행 번호
export function headerColumns(rows, names) {
  for (let r = 0; r < Math.min(rows.length, 4); r++) {
    const cols = {};
    let hits = 0;
    rows[r].forEach((cell, i) => {
      for (const [k, re] of Object.entries(names)) if (cols[k] == null && re.test(cell)) { cols[k] = i; hits++; break; }
    });
    if (hits >= 2) return { row: r, cols };
  }
  return null;
}
