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
  // 같은 x 범위를 가진 가로선 묶음. 양 끝 x를 칸으로 나눈 색인으로 찾는다
  // (묶음 전체를 매번 훑으면 선이 많은 시트에서 선 수의 제곱 — 실제 도서 한 시트가 10분 넘게 걸렸다)
  const groups = [];
  const gIndex = new Map();
  for (const h of hs) {
    const w = h.x1 - h.x0;
    const tol = Math.max(w * 0.005, 1e-6);
    // 칸 크기는 2의 거듭제곱(폭이 조금 다른 같은 묶음도 같은 크기 칸에 든다), 이웃 크기 칸까지 본다
    const q = 2 ** Math.ceil(Math.log2(tol * 2));
    let g = null;
    for (const qq of [q / 2, q, q * 2]) {
      const a0 = Math.floor(h.x0 / qq);
      const b0 = Math.floor(h.x1 / qq);
      for (let a = a0 - 1; a <= a0 + 1; a++) {
        for (let b = b0 - 1; b <= b0 + 1; b++) {
          for (const x of gIndex.get(`${qq}|${a}|${b}`) || []) if (near(x.x0, h.x0, tol) && near(x.x1, h.x1, tol) && (!g || x.n < g.n)) g = x;
        }
      }
    }
    if (!g) {
      g = { x0: h.x0, x1: h.x1, ys: [], n: groups.length };
      groups.push(g);
      const k = `${q}|${Math.floor(h.x0 / q)}|${Math.floor(h.x1 / q)}`;
      if (!gIndex.has(k)) gIndex.set(k, []);
      gIndex.get(k).push(g);
    }
    g.ys.push(h.y);
  }
  // 같은 폭의 표가 위아래로 쌓인 시트(실제 도서 마감표 3개): 양 끝 세로선이 끊긴 곳에서 나눈다
  const vByX = [...vs].sort((a, b) => a.x - b.x);
  const vNear = (x, tol) => {
    let lo = 0;
    let hi = vByX.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (vByX[m].x < x - tol) lo = m + 1; else hi = m; }
    const out = [];
    for (let i = lo; i < vByX.length && vByX[i].x <= x + tol; i++) out.push(vByX[i]);
    return out;
  };
  const runs = [];
  for (const g of groups) {
    const tol = (g.x1 - g.x0) * 0.005;
    const ys = uniq(g.ys, tol).reverse();
    if (ys.length < 3) continue; // 줄이 셋 미만이면 표가 아니다(아래에서도 버린다)
    const ends = [vNear(g.x0, tol * 4), vNear(g.x1, tol * 4)];
    const linked = (a, b) => ends.some((list) => list.some((v) => v.y0 <= (a + b) / 2 && v.y1 >= (a + b) / 2));
    let run = [ys[0]];
    for (let i = 1; i <= ys.length; i++) {
      if (i < ys.length && linked(ys[i - 1], ys[i])) { run.push(ys[i]); continue; }
      runs.push({ x0: g.x0, x1: g.x1, ys: run });
      if (i < ys.length) run = [ys[i]];
    }
  }
  const done = []; // 합친 칸 복원으로 이미 읽은 표 범위
  // 표 후보 안의 글자 수(가운데 x로 정렬해 이분 탐색): 글자가 거의 없는 같은 폭 선 묶음(타일·계단 줄)은 표가 아니다
  // (후보마다 선·글자 전체를 훑으면 실제 도서 평면 한 장이 10분 넘게 걸렸다)
  const tByX = texts.map((t) => ({ t, cx: (t.box[0] + t.box[2]) / 2, cy: (t.box[1] + t.box[3]) / 2 })).sort((a, b) => a.cx - b.cx);
  const textsIn = (bx0, by0, bx1, by1, enough) => {
    let lo = 0;
    let hi = tByX.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tByX[m].cx < bx0) lo = m + 1; else hi = m; }
    let n = 0;
    for (let i = lo; i < tByX.length && tByX[i].cx <= bx1; i++) if (tByX[i].cy >= by0 && tByX[i].cy <= by1 && ++n >= enough) break;
    return n;
  };
  for (const g of runs) {
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
    const [cx, cy] = [(g.x0 + g.x1) / 2, (top + bottom) / 2];
    if (done.some((b) => cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3])) continue;
    if (textsIn(g.x0, bottom, g.x1, top, 2) < 2) continue;
    const grid = gridTable([g.x0, bottom, g.x1, top], hs, vs, texts);
    if (grid) {
      for (const t of grid.used) usedTexts.add(t);
      done.push(grid.bbox);
      // 칸으로 나눈 그림(상세도 묶음·창호 입면 카드): 칸 대부분이 합친 칸 복제라 고유 글자가 5%도 안 된다 — 표로 내지 않는다
      // (진짜 표는 15% 넘음. 글자는 요약의 texts에 그대로 있다)
      const cells = grid.rows.length * (grid.rows[0]?.length || 0);
      if (cells > 300 && new Set(grid.rows.flat().filter(Boolean)).size / cells < 0.05) continue;
      if (grid.rows.filter((r) => r.filter(Boolean).length >= 2).length >= 2) tables.push({ bbox: grid.bbox, rows: grid.rows, lined: true });
      continue;
    }
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

// 합친 칸까지 복원(실제 도서 마감표: 두 줄 머리글, 표 왼쪽 묶음 칸, 한 실 안에서 일부 칸만 나눈 선).
// 1) 씨앗 표(같은 폭 가로선 묶음)를 이어진 테두리선 끝까지 넓힌다
// 2) 양 끝이 다른 선에 닿는 선만 칸 경계로 본다(칸 안의 그림·밑줄은 버림)
// 3) 경계선이 없는 이웃 칸은 합친 칸 — 글자를 합친 칸 전체에 복제한다(아래로·옆으로)
// 선이 너무 많으면(도면 위 계단 등) null → 예전 방식으로
function gridTable(seed, hs, vs, texts) {
  let [x0, y0, x1, y1] = seed;
  const tolOf = () => Math.max(x1 - x0, y1 - y0) * 0.003;
  for (let it = 0; it < 6; it++) {
    const W = x1 - x0;
    const H = y1 - y0;
    const tol = tolOf();
    const hBorder = (h) => Math.min(h.x1, x1) - Math.max(h.x0, x0) >= W * 0.6 && h.x1 - h.x0 <= W * 1.5;
    const vBorder = (v) => Math.min(v.y1, y1) - Math.max(v.y0, y0) >= H * 0.6 && v.y1 - v.y0 <= H * 1.5;
    const before = [x0, y0, x1, y1].join();
    const inX = vs.filter((v) => v.x >= x0 - tol && v.x <= x1 + tol);
    const up = inX.filter((v) => v.y0 <= y1 + tol && v.y1 > y1 + tol);
    if (up.length) {
      const reach = Math.max(...up.map((v) => v.y1));
      const c = hs.filter((h) => h.y > y1 + tol && h.y <= reach + tol && hBorder(h)).map((h) => h.y);
      if (c.length) y1 = Math.max(...c);
    }
    const down = inX.filter((v) => v.y1 >= y0 - tol && v.y0 < y0 - tol);
    if (down.length) {
      const reach = Math.min(...down.map((v) => v.y0));
      const c = hs.filter((h) => h.y < y0 - tol && h.y >= reach - tol && hBorder(h)).map((h) => h.y);
      if (c.length) y0 = Math.min(...c);
    }
    const inY = hs.filter((h) => h.y >= y0 - tol && h.y <= y1 + tol);
    const left = inY.filter((h) => h.x1 >= x0 - tol && h.x0 < x0 - tol);
    if (left.length) {
      const reach = Math.min(...left.map((h) => h.x0));
      const c = vs.filter((v) => v.x < x0 - tol && v.x >= reach - tol && vBorder(v)).map((v) => v.x);
      if (c.length) x0 = Math.min(...c);
    }
    const right = inY.filter((h) => h.x0 <= x1 + tol && h.x1 > x1 + tol);
    if (right.length) {
      const reach = Math.max(...right.map((h) => h.x1));
      const c = vs.filter((v) => v.x > x1 + tol && v.x <= reach + tol && vBorder(v)).map((v) => v.x);
      if (c.length) x1 = Math.max(...c);
    }
    if ([x0, y0, x1, y1].join() === before) break;
  }
  const tol = tolOf();
  let H2 = hs.filter((h) => h.y >= y0 - tol && h.y <= y1 + tol && h.x1 > x0 + tol && h.x0 < x1 - tol).map((h) => ({ y: h.y, x0: Math.max(h.x0, x0), x1: Math.min(h.x1, x1) }));
  let V2 = vs.filter((v) => v.x >= x0 - tol && v.x <= x1 + tol && v.y1 > y0 + tol && v.y0 < y1 - tol).map((v) => ({ x: v.x, y0: Math.max(v.y0, y0), y1: Math.min(v.y1, y1) }));
  if (H2.length + V2.length > 3000) return null;
  for (let pass = 0; pass < 2; pass++) {
    V2 = V2.filter((v) => [v.y0, v.y1].every((y) => H2.some((h) => Math.abs(h.y - y) <= tol && v.x >= h.x0 - tol && v.x <= h.x1 + tol)));
    H2 = H2.filter((h) => [h.x0, h.x1].every((x) => V2.some((v) => Math.abs(v.x - x) <= tol && h.y >= v.y0 - tol && h.y <= v.y1 + tol)));
  }
  const X = uniq(V2.map((v) => v.x), tol);
  const Y = uniq(H2.map((h) => h.y), tol).reverse(); // 위에서 아래로
  if (X.length < 2 || Y.length < 3 || X.length > 120 || Y.length > 800) return null;
  const vAt = X.map((x) => V2.filter((v) => Math.abs(v.x - x) <= tol));
  const hAt = Y.map((y) => H2.filter((h) => Math.abs(h.y - y) <= tol));
  const vCov = (ci, y) => vAt[ci].some((v) => y >= v.y0 - tol && y <= v.y1 + tol);
  const hCov = (ri, x) => hAt[ri].some((h) => x >= h.x0 - tol && x <= h.x1 + tol);
  const R = Y.length - 1;
  const C = X.length - 1;
  const parent = Array.from({ length: R * C }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const join = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  for (let r = 0; r < R; r++) {
    const my = (Y[r] + Y[r + 1]) / 2;
    for (let c = 0; c < C; c++) {
      const mx = (X[c] + X[c + 1]) / 2;
      if (c + 1 < C && !vCov(c + 1, my)) join(r * C + c, r * C + c + 1);
      if (r + 1 < R && !hCov(r + 1, mx)) join(r * C + c, (r + 1) * C + c);
    }
  }
  const bucket = new Map();
  const used = [];
  for (const t of texts) {
    const cx = (t.box[0] + t.box[2]) / 2;
    const cy = (t.box[1] + t.box[3]) / 2;
    if (cx <= X[0] || cx >= X[C] || cy >= Y[0] || cy <= Y[R]) continue;
    let c = 0;
    while (c + 1 < C && cx >= X[c + 1]) c++;
    let r = 0;
    while (r + 1 < R && cy <= Y[r + 1]) r++;
    const k = find(r * C + c);
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k).push(t);
    used.push(t);
  }
  const textOf = new Map();
  for (const [k, list] of bucket) textOf.set(k, list.sort((a, b) => b.y - a.y || a.x - b.x).map((t) => t.t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' '));
  let rows = [];
  for (let r = 0; r < R; r++) {
    const row = [];
    for (let c = 0; c < C; c++) row.push(textOf.get(find(r * C + c)) || '');
    if (!row.some(Boolean)) continue;
    if (rows.length && rows[rows.length - 1].join('\u0001') === row.join('\u0001')) continue; // 나눈 줄이 글자를 바꾸지 않음
    rows.push(row);
  }
  const keep = rows.length ? rows[0].map((_, c) => rows.some((row) => row[c])) : [];
  rows = rows.map((row) => row.filter((_, c) => keep[c])); // 겹선 사이 같은 빈 열은 버림
  // 모든 행에서 왼쪽 열과 같은 열은 합친 칸 복제뿐이라 버린다(도면을 칸으로 나눈 상세도 시트에서 열이 100개 넘게 생겼다)
  const dup = rows.length ? rows[0].map((_, c) => c > 0 && rows.every((row) => row[c] === row[c - 1])) : [];
  rows = rows.map((row) => row.filter((_, c) => !dup[c]));
  return { bbox: [x0, y0, x1, y1], rows, used };
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
      const tight = String(cell || '').replace(/\s+/g, ''); // 띄어 쓴 머리글("바   닥")
      for (const [k, re] of Object.entries(names)) if (cols[k] == null && (re.test(cell) || re.test(tight))) { cols[k] = i; hits++; break; }
    });
    if (hits >= 2) return { row: r, cols };
  }
  return null;
}
