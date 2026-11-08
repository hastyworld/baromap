// 도면끼리 좌표 맞추기(04 10절): 동 평면 외곽(동 자기 좌표) ↔ 배치도 동 외곽(단지 좌표).
// 회전 0~359°(1°) → 0.1°로 다듬기, 이동은 넓이 중심 맞추기, 겹침 비율(IoU)은 격자로 센다. 순수 함수.
import { boxOf, pointInPolygon, centroid } from '../cad/geom.js';
import { r3 } from './ids.js';

const rot = (p, deg, c = [0, 0]) => {
  const r = (deg * Math.PI) / 180;
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * Math.cos(r) - y * Math.sin(r), c[1] + x * Math.sin(r) + y * Math.cos(r)];
};

export function iou(A, B, cell) {
  const b = boxOf([...A, ...B]);
  let inA = 0;
  let inB = 0;
  let both = 0;
  const ba = boxOf(A);
  const bbx = boxOf(B);
  for (let x = b[0] + cell / 2; x < b[2]; x += cell) {
    for (let y = b[1] + cell / 2; y < b[3]; y += cell) {
      const a = x >= ba[0] && x <= ba[2] && y >= ba[1] && y <= ba[3] && pointInPolygon(x, y, A);
      const c = x >= bbx[0] && x <= bbx[2] && y >= bbx[1] && y <= bbx[3] && pointInPolygon(x, y, B);
      if (a) inA++;
      if (c) inB++;
      if (a && c) both++;
    }
  }
  const u = inA + inB - both;
  return u ? both / u : 0;
}

/**
 * local: 동 평면 외곽(동 자기 좌표 m), target: 배치도 외곽(단지 좌표 m)
 * @returns {{ x, y, rotDeg, iou }}  단지 = R(rotDeg)·자기 + (x, y)
 */
export function alignOutline(local, target) {
  const cl = centroid(local);
  const ct = centroid(target);
  const tb = boxOf(target);
  const size = Math.max(tb[2] - tb[0], tb[3] - tb[1]);
  const place = (deg) => local.map((p) => { const q = rot(p, deg, cl); return [q[0] - cl[0] + ct[0], q[1] - cl[1] + ct[1]]; });
  const coarse = Math.max(size / 60, 0.25);
  let best = { deg: 0, v: -1 };
  for (let deg = 0; deg < 360; deg++) {
    const v = iou(place(deg), target, coarse);
    if (v > best.v + 1e-9) best = { deg, v };
  }
  const fine = Math.max(size / 160, 0.1);
  let fineBest = { deg: best.deg, v: iou(place(best.deg), target, fine) };
  for (let d = -1; d <= 1.0001; d += 0.1) {
    const deg = best.deg + d;
    const v = iou(place(deg), target, fine);
    if (v > fineBest.v + 1e-9) fineBest = { deg, v };
  }
  const deg = ((Math.round(fineBest.deg * 10) / 10) % 360 + 360) % 360;
  // 단지 = R·(자기 - cl) + ct = R·자기 + (ct - R·cl)
  const rc = rot(cl, deg);
  return { x: r3(ct[0] - rc[0]), y: r3(ct[1] - rc[1]), rotDeg: deg, iou: Math.round(fineBest.v * 1000) / 1000 };
}

export const applyTransform = (t, p) => { const q = rot(p, t.rotDeg); return [q[0] + t.x, q[1] + t.y]; };
