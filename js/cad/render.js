// 시트 그림: flatten 결과를 캔버스에 그린다(워커의 OffscreenCanvas, 화면의 canvas 공용).
// - 전체 그림: 긴 변 2048px PNG, 흰 바탕, 레이어 색, 선 1px, SOLID 해치는 옅은 채움
// - 조각 그림: 2×2 또는 3×3, 긴 변 1568px(작은 글자 판독용)
// - toPixel / toSheet: 시트 좌표 ↔ 그림 픽셀(AI가 픽셀로 답해도 도면 좌표로 바꿀 수 있게)
import { aciColor, rgbColor } from './geom.js';

export const FULL_SIDE = 2048;
export const TILE_SIDE = 1568;
export const THUMB_SIDE = 400;
export const FONT_STACK = 'Pretendard, "Pretendard Variable", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
const FONT_URL = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/woff2/Pretendard-Regular.woff2';

/** 그림 크기와 배율. region은 시트 좌표의 일부 영역(조각 그림) */
export function imageInfo(frame, maxSide = FULL_SIDE, region = null) {
  const f = region || frame;
  const w = Math.max(f.x1 - f.x0, 1e-9);
  const h = Math.max(f.y1 - f.y0, 1e-9);
  const s = maxSide / Math.max(w, h);
  return { frame: { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 }, width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scale: s };
}
export const toPixel = (info, x, y) => [(x - info.frame.x0) * info.scale, (info.frame.y1 - y) * info.scale];
export const toSheet = (info, px, py) => [info.frame.x0 + px / info.scale, info.frame.y1 - py / info.scale];

// 흰 종이에서 잘 안 보이는 밝은 색(노랑·하늘)은 어둡게
function paperColor(hex, dark) {
  const v = parseInt(hex.slice(1), 16);
  let r = v >> 16;
  let g = (v >> 8) & 255;
  let b = v & 255;
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (dark) {
    if (L < 0.25) { r = 255 - r; g = 255 - g; b = 255 - b; }
  } else if (L > 0.55) {
    const k = 0.55 / L;
    r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k);
  }
  return `rgb(${r},${g},${b})`;
}

function itemColor(it, dark, cache) {
  const key = it.rgb != null ? `r${it.rgb}` : `a${it.color}`;
  let c = cache.get(key);
  if (!c) {
    c = paperColor(it.rgb != null ? rgbColor(it.rgb) : aciColor(Math.abs(it.color ?? 7)), dark);
    cache.set(key, c);
  }
  return c;
}

/**
 * 캔버스에 그리기. view = { frame, scale, width, height } (imageInfo 결과 또는 화면 확대·이동 상태)
 * opts: { dark, hidden: Set<layer>, highlight: [{ box:[x0,y0,x1,y1], color }], lineWidth, only: (it) => bool, tint: (it) => 색|null }
 */
export function drawItems(ctx, items, view, { dark = false, hidden = null, background = true, lineWidth = 1, only = null, tint = null } = {}) {
  const { width, height } = view;
  if (background) {
    ctx.fillStyle = dark ? '#11161f' : '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  const cache = new Map();
  const P = (x, y) => toPixel(view, x, y);
  const visible = (it) => (!hidden || !hidden.has(it.layer)) && (!only || only(it));
  const colorOf = tint ? (it) => tint(it) || itemColor(it, dark, cache) : (it) => itemColor(it, dark, cache);
  // 1) 해치·채움(옅게)
  for (const it of items) {
    if (!visible(it)) continue;
    if (it.k === 'hatch') {
      ctx.globalAlpha = it.solid ? 0.28 : 0.1;
      ctx.fillStyle = colorOf(it);
      ctx.beginPath();
      for (const loop of it.loops) {
        loop.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        ctx.closePath();
      }
      ctx.fill('evenodd');
    } else if (it.k === 'path' && it.fill) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = colorOf(it);
      ctx.beginPath();
      it.pts.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  // 2) 선: 색마다 한 번에
  const byColor = new Map();
  for (const it of items) {
    if (!visible(it)) continue;
    if (it.k === 'path' && it.pts.length) {
      const c = colorOf(it);
      if (!byColor.has(c)) byColor.set(c, []);
      byColor.get(c).push(it);
    } else if (it.k === 'hatch' && !it.solid) {
      const c = colorOf(it);
      if (!byColor.has(c)) byColor.set(c, []);
      for (const loop of it.loops) byColor.get(c).push({ pts: loop, closed: true, hatchEdge: true });
    }
  }
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [c, list] of byColor) {
    ctx.strokeStyle = c;
    ctx.beginPath();
    for (const it of list) {
      if (it.pts.length === 1) {
        const [px, py] = P(it.pts[0][0], it.pts[0][1]);
        ctx.moveTo(px - 1, py); ctx.lineTo(px + 1, py);
        continue;
      }
      it.pts.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      if (it.closed) ctx.closePath();
    }
    ctx.stroke();
  }
  // 3) 글자
  ctx.textBaseline = 'alphabetic';
  for (const it of items) {
    if (it.k !== 'text' || !visible(it)) continue;
    const px = it.size * view.scale;
    if (px < 2) continue;
    const [x, y] = P(it.x, it.y);
    if (x < -width || y < -height || x > width * 2 || y > height * 2) continue;
    ctx.fillStyle = colorOf(it);
    ctx.font = `${px.toFixed(1)}px ${FONT_STACK}`;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((-(it.rot || 0) * Math.PI) / 180);
    const lines = String(it.t).split('\n');
    let dy = 0;
    if (it.kind === 'mtext') {
      const a = it.attach || 1;
      const col = (a - 1) % 3;
      const row = Math.floor((a - 1) / 3);
      ctx.textAlign = col === 0 ? 'left' : col === 1 ? 'center' : 'right';
      const total = px * 1.6 * (lines.length - 1);
      dy = row === 0 ? px : row === 1 ? px / 2 - total / 2 : -total;
    } else {
      const [ha, va] = it.align || [0, 0];
      ctx.textAlign = ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left';
      dy = va === 2 || ha === 4 ? px / 2 : va === 3 ? px : 0;
    }
    lines.forEach((ln, i) => ctx.fillText(ln, 0, dy + i * px * 1.6));
    ctx.restore();
  }
}

export function drawHighlights(ctx, view, boxes, { color = '#E03131', width = 3 } = {}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (const b of boxes) {
    const [x0, y0] = toPixel(view, b[0], b[3]);
    const [x1, y1] = toPixel(view, b[2], b[1]);
    ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- PNG 만들기(OffscreenCanvas가 있는 곳: 브라우저·워커)

export const canRender = () => typeof OffscreenCanvas !== 'undefined';

let fontReady = null;
export function ensureFont() {
  if (fontReady) return fontReady;
  const fonts = globalThis.document?.fonts || globalThis.fonts;
  if (!fonts || typeof FontFace === 'undefined') return (fontReady = Promise.resolve(false));
  fontReady = (async () => {
    try {
      const face = new FontFace('Pretendard', `url(${FONT_URL})`);
      await face.load();
      fonts.add(face);
      return true;
    } catch {
      return false; // 글꼴을 못 받으면 기기 글꼴로 그린다
    }
  })();
  return fontReady;
}

export async function renderPng(items, frame, { maxSide = FULL_SIDE, region = null, dark = false } = {}) {
  const info = imageInfo(frame, maxSide, region);
  const canvas = new OffscreenCanvas(info.width, info.height);
  const ctx = canvas.getContext('2d');
  drawItems(ctx, items, info, { dark });
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, width: info.width, height: info.height, info };
}

// 조각 격자 크기: 전체 그림에서 글자가 작을수록 잘게(중간값 글자 높이 기준)
export function tileGrid(items, frame) {
  const info = imageInfo(frame, FULL_SIDE);
  const sizes = items.filter((it) => it.k === 'text').map((it) => it.size * info.scale).sort((a, b) => a - b);
  const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
  return med < 6 ? 3 : 2;
}

export function tileRegions(frame, n, overlap = 0.04) {
  const w = (frame.x1 - frame.x0) / n;
  const h = (frame.y1 - frame.y0) / n;
  const out = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x0 = frame.x0 + c * w - w * overlap;
      const y1 = frame.y1 - r * h + h * overlap;
      out.push({ n: r * n + c, row: r, col: c, x0: Math.max(frame.x0, x0), y0: Math.max(frame.y0, y1 - h * (1 + 2 * overlap)), x1: Math.min(frame.x1, x0 + w * (1 + 2 * overlap)), y1: Math.min(frame.y1, y1) });
    }
  }
  return out;
}

export async function renderTiles(items, frame, { side = TILE_SIDE } = {}) {
  const n = tileGrid(items, frame);
  const out = [];
  for (const region of tileRegions(frame, n)) {
    const r = await renderPng(items, frame, { maxSide: side, region });
    out.push({ n: region.n, grid: n, region, blob: r.blob, width: r.width, height: r.height });
  }
  return out;
}
