// 실 이름 위치에서 채워 실 찾기(보조): 벽선만으로 방이 닫히지 않는 실제 도면(벽 끝 문틈, 붙박이장, 겹벽)용.
// 1) 벽(변·두께)을 격자에 그린다(문·창 자리도 막힌 것으로 — 문은 실 경계)
// 2) (선택) 세대 외곽: 외벽·세대 경계벽·창으로만 닫힌 영역을 먼저 구한다. 현관문 같은 좁은 틈(2×외곽 reach 미만)은 막힌 것으로 본다.
//    이름의 채우기는 그 이름이 든 외곽 안에서만 한다(복도·코어·옆 세대로 번지지 않게)
// 3) 벽에서 r(문 반 폭) 안의 칸을 막아 문틈·작은 틈을 메운 뒤, 이름 위치에서 채운다(격자 끝에 닿거나 너무 크면 샌 것).
//    새거나 다른 실 이름을 먹으면 r을 단계적으로 키워 다시 채운다(넓은 트임). 묶을 수 있는 이름(거실·주방)이 한 영역이면 실 하나로 묶는다
// 4) 채운 영역들에서 동시에 넓혀(가까운 쪽 차지) r만큼 벽까지 되돌린다 → 칸 묶음 → 테두리 다각형
// 좌표는 m. 순수 함수.

const DP = (pts, tol) => {
  if (pts.length < 4) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1;
    let bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (best >= 0) { keep[best] = true; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
};

// 체스판 근사 거리(칸 수) 두 번 훑기: 막힌 칸(block=1)에서의 거리
function distanceField(block, W, H) {
  const N = W * H;
  const dist = new Float32Array(N).fill(1e9);
  for (let k = 0; k < N; k++) if (block[k]) dist[k] = 0;
  const D2 = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    if (!dist[k]) continue;
    let v = dist[k];
    if (x > 0) v = Math.min(v, dist[k - 1] + 1);
    if (y > 0) {
      v = Math.min(v, dist[k - W] + 1);
      if (x > 0) v = Math.min(v, dist[k - W - 1] + D2);
      if (x + 1 < W) v = Math.min(v, dist[k - W + 1] + D2);
    }
    dist[k] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const k = y * W + x;
    if (!dist[k]) continue;
    let v = dist[k];
    if (x + 1 < W) v = Math.min(v, dist[k + 1] + 1);
    if (y + 1 < H) {
      v = Math.min(v, dist[k + W] + 1);
      if (x + 1 < W) v = Math.min(v, dist[k + W + 1] + D2);
      if (x > 0) v = Math.min(v, dist[k + W - 1] + D2);
    }
    dist[k] = v;
  }
  return dist;
}

/**
 * @param {Array<{a:number[], b:number[], t:number}>} edges 벽 변(중심선·두께)
 * @param {Array<{name:string, pos:number[]}>} labels 찾을 실 이름 위치
 * @param {{ cell?: number, reach?: number, reaches?: number[], narrow?: number[], maxArea?: number, why?: string[]|null, soft?: any[], grid?: any,
 *   zone?: { edges: Array<{a:number[], b:number[], t:number}>, reach?: number, maxArea?: number }|null, mergeable?: ((a:any, b:any) => boolean)|null }} [o]
 *   reaches: 새면 차례로 키워 다시 채울 r(첫 값이 기본), narrow: 이름 둘레에 r만큼 빈 칸이 없을 때(좁은 발코니) 쓸 작은 r,
 *   zone: 세대 외곽 선(외벽·세대 경계벽·창)과 그 틈 메움 r, mergeable: 한 영역의 두 이름을 실 하나로 묶을지
 * @returns {Array<{ label:any, labels?:any[], polygon:number[][], area:number, reach:number }|null>} labels 순서, 못 찾으면(묶여 들어간 이름 포함) null
 */
export function rasterRooms(edges, labels, { cell = 0.05, reach = 0.45, reaches = null, narrow = [], maxArea = 150, why = null, soft = [], grid = null, zone = null, mergeable = null } = {}) {
  if (!edges.length || !labels.length) return labels.map(() => null);
  let mnx = Infinity;
  let mny = Infinity;
  let mxx = -Infinity;
  let mxy = -Infinity;
  for (const e of [...edges, ...(zone?.edges || [])]) for (const p of [e.a, e.b]) {
    if (p[0] < mnx) mnx = p[0];
    if (p[0] > mxx) mxx = p[0];
    if (p[1] < mny) mny = p[1];
    if (p[1] > mxy) mxy = p[1];
  }
  const x0 = mnx - 1;
  const y0 = mny - 1;
  const span = Math.max(mxx + 1 - x0, mxy + 1 - y0);
  const c = Math.max(cell, span / 1600); // 격자 칸은 많아야 1600×1600
  const W = Math.ceil((mxx + 1 - x0) / c) + 1;
  const H = Math.ceil((mxy + 1 - y0) / c) + 1;
  const N = W * H;
  const wall = new Uint8Array(N);
  const softMask = new Uint8Array(N); // 문(문짝·여닫는 호): 채울 때만 막고, 벽까지 다시 넓힐 때는 지난다
  const at = (x, y) => [Math.floor((x - x0) / c), Math.floor((y - y0) / c)];
  // 1) 벽 칠하기: 변을 따라 걸으며 두께 반만큼(최소 4cm) 칠한다
  const wallOff = new Float32Array(N).fill(1e9); // 벽 칸: 가장 가까운 벽 중심선까지 거리(m) — 실을 중심선까지 넓힐 때
  const paint = (e, mask, offs = null) => {
    const dx = e.b[0] - e.a[0];
    const dy = e.b[1] - e.a[1];
    const L = Math.hypot(dx, dy);
    if (!L) return;
    const half = Math.max(0.04, (e.t || 0.1) / 2);
    const steps = Math.ceil(L / (c / 2));
    const hr = Math.ceil(half / c);
    for (let s = 0; s <= steps; s++) {
      const px = e.a[0] + (dx * s) / steps;
      const py = e.a[1] + (dy * s) / steps;
      const [cx, cy] = at(px, py);
      for (let j = -hr; j <= hr; j++) for (let i = -hr; i <= hr; i++) {
        const X = cx + i;
        const Y = cy + j;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        // 칸 중심이 벽 띠 안인가
        const qx = x0 + (X + 0.5) * c - e.a[0];
        const qy = y0 + (Y + 0.5) * c - e.a[1];
        const along = (qx * dx + qy * dy) / L;
        const off = Math.abs(qx * dy - qy * dx) / L;
        if (along >= -half && along <= L + half && off <= half + c / 2) {
          mask[Y * W + X] = 1;
          if (offs && off < offs[Y * W + X]) offs[Y * W + X] = along < 0 || along > L ? Math.max(off, along < 0 ? -along : along - L) : off;
        }
      }
    }
  };
  for (const e of edges) paint(e, wall, wallOff);
  // 겹벽(구조벽 + 조적·마감 벽, 사이 0.3m 미만 빈 띠)은 한 벽으로: 가로·세로로 벽 칸 사이 짧은 빈 칸을 메우고,
  // 두께 방향 벽 칸 줄(0.8m 이하)의 가운데를 그 벽의 중심선으로 본다(실을 중심선까지 넓힐 때)
  const gapMax = Math.round(0.3 / c);
  const runMax = Math.round(0.8 / c);
  for (const [len, cnt, idx] of [[W, H, (i, j) => j * W + i], [H, W, (i, j) => i * W + j]]) {
    for (let j = 0; j < cnt; j++) {
      let last = -1;
      for (let i = 0; i < len; i++) {
        if (!wall[idx(i, j)]) continue;
        if (last >= 0 && i - last - 1 > 0 && i - last - 1 < gapMax) for (let q = last + 1; q < i; q++) wall[idx(q, j)] = 1;
        last = i;
      }
    }
  }
  const comp = new Float32Array(N).fill(1e9);
  for (const [len, cnt, idx] of [[W, H, (i, j) => j * W + i], [H, W, (i, j) => i * W + j]]) {
    for (let j = 0; j < cnt; j++) {
      for (let i = 0; i < len;) {
        if (!wall[idx(i, j)]) { i++; continue; }
        let e = i;
        while (e + 1 < len && wall[idx(e + 1, j)]) e++;
        if (e - i + 1 <= runMax) { const mid = (i + e + 1) / 2; for (let q = i; q <= e; q++) comp[idx(q, j)] = Math.min(comp[idx(q, j)], Math.abs(q + 0.5 - mid) * c); }
        i = e + 1;
      }
    }
  }
  for (let k = 0; k < N; k++) if (wall[k]) wallOff[k] = comp[k] < 1e8 ? comp[k] : Math.min(wallOff[k], 0.3);
  for (const e of soft) paint(e, softMask);
  // 2) 벽까지 거리(칸 수)
  const block = new Uint8Array(N);
  for (let k = 0; k < N; k++) block[k] = wall[k] | softMask[k];
  const dist = distanceField(block, W, H);
  const onEdge = (k) => { const x = k % W; const y = (k - x) / W; return x === 0 || y === 0 || x === W - 1 || y === H - 1; };
  const nbr = (k) => {
    const x = k % W;
    const out = [];
    if (x > 0) out.push(k - 1);
    if (x + 1 < W) out.push(k + 1);
    if (k - W >= 0) out.push(k - W);
    if (k + W < N) out.push(k + W);
    return out;
  };
  const cellAt = (p) => { const [x, y] = at(p[0], p[1]); return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x; };
  // 이름이 벽 가까이 있으면 벽을 넘지 않고 닿는 둘레(반경 2r)에서 가장 넓은 칸으로 옮긴다(문·가구 문 선은 넘는다: 부엌 가구 위에 쓴 이름)
  const seedFor = (k0, d, r, ok, stop = wall, rMove = r) => {
    if (k0 < 0) return -1;
    if (d[k0] > r && ok(k0)) return k0;
    const R = Math.ceil(Math.min(r, rMove) * 2);
    const x0c = k0 % W;
    const y0c = (k0 - x0c) / W;
    const seen = new Set([k0]);
    // 이름 글자가 벽선 위에 걸쳐 있으면 둘레 2칸 안의 빈 칸에서 시작한다
    let front = !stop[k0] ? [k0] : nbr(k0).flatMap((k) => [k, ...nbr(k)]).filter((k) => !stop[k] && !seen.has(k) && seen.add(k));
    let best = -1;
    while (front.length) {
      const next = [];
      for (const k of front) {
        if (d[k] > r && ok(k) && (best < 0 || d[k] > d[best])) best = k;
        for (const nk of nbr(k)) {
          if (seen.has(nk) || stop[nk]) continue;
          const x = nk % W;
          const y = (nk - x) / W;
          if (Math.abs(x - x0c) > R || Math.abs(y - y0c) > R) continue;
          seen.add(nk);
          next.push(nk);
        }
      }
      front = next;
    }
    return best;
  };

  // 3) 세대 외곽(선택): 외곽 선으로만 거리를 재고 zr 넘게 떨어진 칸을 이름에서 채운다 → 외곽 선까지 되돌림
  const zoneOf = zone ? new Int32Array(N).fill(-1) : null; // -1 아직, -2 샌(외곽 없음), 0.. 외곽 번호
  const labelZone = labels.map(() => -1);
  if (zone?.edges?.length) {
    const zw = new Uint8Array(N);
    for (const e of zone.edges) paint(e, zw);
    const zd = distanceField(zw, W, H);
    const zr = (zone.reach ?? 0.6) / c;
    const zMax = zone.maxArea ?? maxArea * 2;
    let nz = 0;
    labels.forEach((l, li) => {
      const s = seedFor(cellAt(l.pos), zd, zr, () => true, zw);
      if (s < 0 || zoneOf[s] === -2) return;
      if (zoneOf[s] >= 0) { labelZone[li] = zoneOf[s]; return; }
      const q = [s];
      zoneOf[s] = nz;
      let open = false;
      for (let h = 0; h < q.length && !open; h++) {
        if (onEdge(q[h])) open = true;
        for (const nk of nbr(q[h])) {
          if (zoneOf[nk] !== -1 || zd[nk] <= zr) continue;
          zoneOf[nk] = nz;
          q.push(nk);
        }
        if (q.length * c * c > zMax) open = true;
      }
      if (open) { for (const k of q) zoneOf[k] = -2; return; }
      labelZone[li] = nz++;
    });
    // 외곽 선까지 되돌리기(외곽마다 동시에, 외곽 r의 1.6배 걸음까지)
    const zg = Math.ceil(zr * 1.6) + 2;
    const st = new Float32Array(N).fill(1e9);
    const qq = [];
    for (let k = 0; k < N; k++) if (zoneOf[k] >= 0) { st[k] = 0; qq.push(k); }
    for (let h = 0; h < qq.length; h++) {
      const k = qq[h];
      if (st[k] + 1 > zg) continue;
      for (const nk of nbr(qq[h])) {
        if (zw[nk] || zoneOf[nk] !== -1 && zoneOf[nk] !== -2 || st[nk] <= st[k] + 1) continue;
        if (zoneOf[nk] === -2 && zd[nk] > zr) continue; // 샌 영역 한가운데로는 넓히지 않는다
        st[nk] = st[k] + 1;
        zoneOf[nk] = zoneOf[k];
        qq.push(nk);
      }
    }
    if (grid) grid.zones = nz;
  }
  // 외곽이 있는 이름은 그 외곽 안에서만, 외곽이 없는 이름은 어느 외곽에도 들어가지 않는다
  const allowedFor = (li) => {
    if (!zoneOf) return () => true;
    const z = labelZone[li];
    return z >= 0 ? (k) => zoneOf[k] === z : (k) => zoneOf[k] < 0;
  };

  // 4) 이름마다 채우기(벽에서 r 넘게 떨어진 칸만). 외곽이 있는 이름 먼저
  const owner = new Int32Array(N).fill(-1);
  // 큰 r로 잡힌 실이 미리 맡아 둔 벽 쪽 띠(그 실 번호+1): 뒤에 작은 r로 채우는 이름이 트임을 지나 이 띠를 먹지 않게 한다. 벽까지 되돌릴 때 주인이 차지
  const halo = new Int32Array(N);
  const minR = labels.map(() => 0); // 섞였던 실이 큰 r로 나뉘면, 그 실과 섞였던 이름도 그 r부터 채운다
  const seeds = labels.map(() => null);
  const rOf = labels.map(() => 0);
  const whyOf = labels.map(() => null);
  const mergedInto = labels.map(() => -1);
  const steps = (reaches?.length ? reaches : [reach]).map((v) => v / c);
  const small = narrow.map((v) => v / c).filter((v) => v < steps[0]);
  const labelCells = labels.map((l) => cellAt(l.pos));
  const canMerge = (a, b) => Boolean(mergeable && mergeable(labels[a], labels[b]));
  const order = labels.map((_, i) => i).sort((a, b) => (labelZone[a] >= 0 ? 0 : 1) - (labelZone[b] >= 0 ? 0 : 1) || a - b);
  const fill = (li, s, r, ok) => {
    const q = [s];
    owner[s] = li;
    let edge = false;
    let big = false;
    for (let h = 0; h < q.length; h++) {
      if (onEdge(q[h])) edge = true;
      for (const nk of nbr(q[h])) {
        if (owner[nk] !== -1 || dist[nk] <= r || !ok(nk) || (halo[nk] && halo[nk] !== li + 1)) continue;
        owner[nk] = li;
        q.push(nk);
      }
      if (q.length * c * c > maxArea) { big = true; break; }
    }
    // 벽까지 되돌린 넓이(어림, 다른 실과 나누기 전)도 상한 안이어야 한다
    const inQ = new Set(q);
    if (!big) {
      const lim = Math.ceil(r * 1.6) + 2;
      const seen = new Map(q.map((k) => [k, 0]));
      const front = [...q];
      for (let h = 0; h < front.length; h++) {
        const d = seen.get(front[h]);
        if (d >= lim) continue;
        for (const nk of nbr(front[h])) {
          if (seen.has(nk) || wall[nk] || owner[nk] !== -1 || !ok(nk) || (halo[nk] && halo[nk] !== li + 1)) continue;
          seen.set(nk, d + 1);
          front.push(nk);
        }
        if (seen.size * c * c > maxArea) { big = true; break; }
      }
    }
    // 이 영역에 든 다른 이름: 묶을 수 없는 이름이 있으면 섞인 것(두 방·두 세대가 이어짐)
    const others = labels.map((_, j) => j).filter((j) => j !== li && mergedInto[j] < 0 && whyOf[j] !== '밖' && labelCells[j] >= 0 && inQ.has(labelCells[j]));
    const apart = others.filter((j) => !canMerge(li, j));
    // 묶을 수 있는 이름끼리도 서로 묶을 수 없으면 섞인 것(주방 하나가 두 세대의 거실을 함께 묶지 않게)
    const mixed = apart.length > 0 || others.some((a, x) => others.some((b, y) => y > x && !canMerge(a, b)));
    return { q, edge, big, mixed, apart };
  };
  const claimHalo = (li, q, r) => {
    const lim = Math.ceil(r - steps[0]) + 2;
    const depth = new Map(q.map((k) => [k, 0]));
    const front = [...q];
    const ok = allowedFor(li);
    for (let h = 0; h < front.length; h++) {
      const d = depth.get(front[h]);
      if (d >= lim) continue;
      for (const nk of nbr(front[h])) {
        if (depth.has(nk) || block[nk] || owner[nk] !== -1 || halo[nk] || !ok(nk)) continue;
        depth.set(nk, d + 1);
        halo[nk] = li + 1;
        front.push(nk);
      }
    }
  };
  const release = (q) => { for (const k of q) owner[k] = -1; };
  for (const li of order) {
    const ok = allowedFor(li);
    const k0 = labelCells[li];
    if (k0 < 0) { whyOf[li] = '밖'; continue; }
    let first = null;
    let last = null;
    let done = false;
    let seeded = false;
    const tryR = [...steps.filter((v) => v >= minR[li]), ...steps.filter((v) => v < minR[li]).reverse(), ...small];
    let noSeed = Infinity;
    for (const r of tryR) {
      const isSmall = r < steps[0];
      if (isSmall && seeded) break; // 작은 r은 시작 칸을 못 잡았을 때만
      if (r >= noSeed) continue; // 시작 칸을 못 잡은 r보다 큰 r은 쓰지 않는다(좁은 실)
      // 큰 r에서도 이름을 옮기는 거리는 처음 r 기준(옆 실로 건너가 시작하지 않게)
      const s = seedFor(k0, dist, r, ok, wall, steps[0]);
      if (s < 0) { noSeed = Math.min(noSeed, r); continue; }
      seeded = true;
      if (owner[s] >= 0 || halo[s]) {
        const j = owner[s] >= 0 ? owner[s] : halo[s] - 1;
        if (canMerge(j, li)) { mergedInto[li] = j; whyOf[li] = '합침'; } else whyOf[li] = '같은 방';
        done = true;
        break;
      }
      if (owner[s] === -2) { whyOf[li] = '샌 영역'; done = true; break; }
      const f = fill(li, s, r, ok);
      if (!f.edge && !f.big && !f.mixed) {
        seeds[li] = f.q;
        rOf[li] = r;
        whyOf[li] = 'ok';
        done = true;
        if (r > steps[0]) {
          claimHalo(li, f.q, r);
          for (const j of first?.apart || []) minR[j] = Math.max(minR[j], r);
        }
        break;
      }
      release(f.q);
      if (!first) first = { ...f, r };
      last = { ...f, r };
    }
    if (done) continue;
    if (!seeded) { whyOf[li] = '벽 가까움'; continue; }
    if (first && !first.edge && !first.big) {
      // 어느 r에서도 이름이 섞여 나뉘지 않으면 처음 영역을 쓴다(묶을 수 없는 이름은 같은 방으로 남는다)
      for (const k of first.q) if (owner[k] === -1) owner[k] = li;
      seeds[li] = first.q.filter((k) => owner[k] === li);
      rOf[li] = first.r;
      whyOf[li] = 'ok';
      continue;
    }
    // 샌 영역은 다른 이름도 못 쓰게(가장 좁힌 마지막 시도의 영역 — 처음 영역을 막으면 같은 트임 건너의 다른 실까지 못 찾는다).
    // 세대 외곽 안의 이름은 외곽이 번짐을 막으므로 막지 않는다(같은 외곽의 다른 이름이 스스로 나뉠 수 있게)
    if (labelZone[li] < 0) for (const k of last.q) if (owner[k] === -1) owner[k] = -2;
    if (grid) (grid.leaks ||= []).push({ li, cells: last.q });
    whyOf[li] = `샘${first.edge ? '(끝)' : ''} ${(first.q.length * c * c).toFixed(0)}㎡`;
  }
  if (why) why.push(...whyOf);
  // 5) 채운 영역에서 동시에 넓혀 벽까지(r의 1.6배 걸음 안, 벽 아닌 칸, 자기 외곽 안)
  // 4칸 이웃 걸음은 대각선에서 덜 가므로 띠 폭(r)의 1.6배까지 넓힌다(좁은 구석·붙박이장 앞까지)
  const growOf = rOf.map((r) => Math.ceil(r * 1.6) + 2);
  const okOf = labels.map((_, i) => allowedFor(i));
  const step = new Float32Array(N).fill(1e9);
  const queue = [];
  seeds.forEach((q) => { if (q) for (const k of q) { step[k] = 0; queue.push(k); } });
  for (let h = 0; h < queue.length; h++) {
    const k = queue[h];
    const li = owner[k];
    if (step[k] + 1 > growOf[li]) continue;
    for (const nk of nbr(k)) {
      if (wall[nk] || step[nk] <= step[k] + 1 || owner[nk] === -2 || !okOf[li](nk)) continue;
      step[nk] = step[k] + 1;
      owner[nk] = li;
      queue.push(nk);
    }
  }
  // 5-1) 막는 선(욕조·부스·문짝)에 갇혀 못 채운 작은 주머니(2㎡ 이하): 한 실에만 닿고 둘레의 1/4 넘게 그 실과 맞닿으면 그 실로
  //      (문 하나로만 이어진 이름 없는 작은 방은 둘레 대부분이 벽이라 붙이지 않는다)
  const count = new Int32Array(labels.length);
  for (let k = 0; k < N; k++) if (owner[k] >= 0) count[owner[k]]++;
  const seenP = new Uint8Array(N);
  for (let k0 = 0; k0 < N; k0++) {
    if (seenP[k0] || wall[k0] || owner[k0] !== -1) continue;
    const pocket = [k0];
    seenP[k0] = 1;
    let open = false;
    let perim = 0;
    const touch = new Map();
    for (let h = 0; h < pocket.length; h++) {
      if (onEdge(pocket[h])) open = true;
      for (const nk of nbr(pocket[h])) {
        if (wall[nk]) { perim++; continue; }
        if (owner[nk] >= 0) { perim++; touch.set(owner[nk], (touch.get(owner[nk]) || 0) + 1); continue; }
        if (owner[nk] === -2) { open = true; continue; }
        if (!seenP[nk]) { seenP[nk] = 1; pocket.push(nk); }
      }
    }
    if (open || touch.size !== 1 || pocket.length * c * c > 2) continue;
    const [li, side] = [...touch][0];
    if (side < perim * 0.25 || pocket.length > count[li] * 0.5 || !pocket.every((k) => okOf[li](k))) continue;
    for (const k of pocket) owner[k] = li;
  }
  // 5-2) 벽 중심선까지(04 6절: 실 면적은 벽 중심선 기준 — 닫힌 면으로 찾은 실과 같게). 벽 칸에서는 중심선에 가까워지는 쪽으로만
  const toLine = [];
  for (let k = 0; k < N; k++) if (owner[k] >= 0 && !wall[k]) for (const nk of nbr(k)) if (wall[nk] && owner[nk] === -1 && wallOff[nk] < 1e8) { owner[nk] = owner[k]; toLine.push(nk); }
  for (let h = 0; h < toLine.length; h++) {
    const k = toLine[h];
    if (wallOff[k] <= c / 2) continue; // 중심선 칸에서 멈춘다(건너편 실 몫)
    for (const nk of nbr(k)) {
      if (!wall[nk] || owner[nk] !== -1 || wallOff[nk] >= wallOff[k]) continue;
      owner[nk] = owner[k];
      toLine.push(nk);
    }
  }
  if (grid) Object.assign(grid, { x0, y0, c, W, H, owner, wall, dist, zoneOf });
  // 6) 칸 묶음 → 테두리(반시계) → 다각형
  return labels.map((l, li) => {
    if (!seeds[li]) return null;
    const cellsOf = [];
    for (let k = 0; k < N; k++) if (owner[k] === li) cellsOf.push(k);
    if (!cellsOf.length) return null;
    const inSet = (x, y) => x >= 0 && y >= 0 && x < W && y < H && owner[y * W + x] === li;
    const next = new Map();
    const key = (x, y) => y * (W + 1) + x;
    for (const k of cellsOf) {
      const x = k % W;
      const y = (k - x) / W;
      if (!inSet(x, y - 1)) next.set(key(x, y), key(x + 1, y)); // 아래 변: 왼→오
      if (!inSet(x + 1, y)) next.set(key(x + 1, y), key(x + 1, y + 1)); // 오른쪽 변: 아래→위
      if (!inSet(x, y + 1)) next.set(key(x + 1, y + 1), key(x, y + 1)); // 위 변: 오→왼
      if (!inSet(x - 1, y)) next.set(key(x, y + 1), key(x, y)); // 왼쪽 변: 위→아래
    }
    // 가장 긴 고리
    const seen = new Set();
    let bestLoop = [];
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const loop = [];
      let cur = start;
      while (!seen.has(cur) && next.has(cur)) { seen.add(cur); loop.push(cur); cur = next.get(cur); }
      if (loop.length > bestLoop.length) bestLoop = loop;
    }
    const pts = bestLoop.map((kk) => { const x = kk % (W + 1); const y = (kk - x) / (W + 1); return [x0 + x * c, y0 + y * c]; });
    // 닫힌 고리는 가장 먼 점에서 둘로 나눠 줄인다(처음=끝인 선분으로는 거리를 잴 수 없다)
    let far = 0;
    pts.forEach((p, i) => { if (Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) > Math.hypot(pts[far][0] - pts[0][0], pts[far][1] - pts[0][1])) far = i; });
    const half1 = DP(pts.slice(0, far + 1), c * 1.2);
    const half2 = DP([...pts.slice(far), pts[0]], c * 1.2);
    const poly = [...half1.slice(0, -1), ...half2.slice(0, -1)].map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
    if (poly.length < 3) return null;
    const merged = labels.filter((_, j) => mergedInto[j] === li);
    return { label: l, ...(merged.length ? { labels: [l, ...merged] } : {}), polygon: poly, area: Math.round(cellsOf.length * c * c * 10000) / 10000, reach: Math.round(rOf[li] * c * 100) / 100 };
  });
}
