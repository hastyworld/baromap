// 얼굴 가리기 계산(순수 함수): 상자 넓히기, 모자이크 크기, 360° 사진 조각 좌표. 화면·MediaPipe는 js/ops/blur.js.

// 찾은 얼굴 상자를 넓혀(기본 30%) 사진 안으로 자른다. box: { x, y, w, h } (픽셀)
export function expandBox(box, width, height, ratio = 0.3) {
  const dx = (box.w * ratio) / 2;
  const dy = (box.h * ratio) / 2;
  const x0 = Math.max(0, Math.floor(box.x - dx));
  const y0 = Math.max(0, Math.floor(box.y - dy));
  const x1 = Math.min(width, Math.ceil(box.x + box.w + dx));
  const y1 = Math.min(height, Math.ceil(box.y + box.h + dy));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

// 모자이크 칸 크기 = 상자 폭 / 8(너무 작으면 알아볼 수 있어 최소 4px)
export const mosaicCell = (box) => Math.max(4, Math.round(box.w / 8));

// 상자를 칸으로 나눈 목록(그리기·시험용). 끝 칸은 상자 안으로 자른다
export function mosaicCells(box, cell = mosaicCell(box)) {
  const out = [];
  for (let y = box.y; y < box.y + box.h; y += cell) {
    for (let x = box.x; x < box.x + box.w; x += cell) {
      out.push({ x, y, w: Math.min(cell, box.x + box.w - x), h: Math.min(cell, box.y + box.h - y) });
    }
  }
  return out;
}

// 겹치는 상자 합치기(겹친 면적이 작은 쪽의 절반 이상이면 같은 얼굴)
const overlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
export function mergeBoxes(boxes) {
  const out = [];
  for (const b of boxes) {
    const hit = out.find((o) => overlap(o, b) >= 0.5 * Math.min(o.w * o.h, b.w * b.h));
    if (!hit) { out.push({ ...b }); continue; }
    const x = Math.min(hit.x, b.x);
    const y = Math.min(hit.y, b.y);
    hit.w = Math.max(hit.x + hit.w, b.x + b.w) - x;
    hit.h = Math.max(hit.y + hit.h, b.y + b.h) - y;
    hit.x = x;
    hit.y = y;
  }
  return out;
}

// 먼 얼굴은 모델이 놓치므로 사진을 겹치는 격자로 나눠 다시 찾는다. 사진이 조각보다 작으면 나누지 않는다
export function gridTiles(width, height, tile = 640, overlapRatio = 0.25) {
  if (Math.max(width, height) <= tile) return [];
  const step = Math.round(tile * (1 - overlapRatio));
  const axis = (n) => {
    const out = [];
    for (let v = 0; v + tile < n; v += step) out.push(v);
    out.push(Math.max(0, n - tile));
    return out;
  };
  return axis(height).flatMap((y) => axis(width).map((x) => ({ x, y, w: Math.min(tile, width), h: Math.min(tile, height) })));
}

// 360° 사진: 적도 부근 띠를 가로 n조각(겹치게)으로 나눈다. x + w는 사진 폭을 넘을 수 있다(왼쪽으로 이어짐)
export function panoTiles(width, height, n = 8, overlapRatio = 0.25, band = 0.6) {
  const w = Math.round(width / n);
  const tw = Math.round(w * (1 + overlapRatio));
  const h = Math.round(height * band);
  const y = Math.round((height - h) / 2);
  return Array.from({ length: n }, (_, i) => ({ x: i * w, y, w: tw, h }));
}

// 조각 안 상자 → 사진 좌표로 되돌림. 오른쪽 끝을 넘으면 왼쪽으로 돌아와 두 상자로 나눈다
export function tileBoxToImage(box, tile, width) {
  const x = (tile.x + box.x) % width;
  const y = tile.y + box.y;
  if (x + box.w <= width) return [{ x, y, w: box.w, h: box.h }];
  const first = width - x;
  return [{ x, y, w: first, h: box.h }, { x: 0, y, w: box.w - first, h: box.h }];
}

// 손가락으로 그린 사각형(시작·끝 점) → 상자
export function dragBox(a, b, width, height) {
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(width, Math.max(a.x, b.x));
  const y1 = Math.min(height, Math.max(a.y, b.y));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
