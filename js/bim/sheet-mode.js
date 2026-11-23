// 도면 보기 방식 고르기와 그림 보기 계산(순수 함수, 46 지시서 1절).
// 선 모양(.geom.json)이 없거나 너무 크면 저장해 둔 그림(PNG·조각 그림)으로 대신 보여 준다.
// 시트 좌표(도면 단위, y 위로)와 그림 픽셀은 시트 범위(frame)로 잇는다 — 그림은 frame에 꼭 맞게 그려져 있다(cad/render.js).

// 선 보기 한도(풀었을 때 바이트). 휴대폰은 작게, PC는 브라우저가 멈추지 않을 만큼
export const GEOM_LIMIT = { mobile: 8 * 1024 * 1024, pc: 60 * 1024 * 1024 };

// 시트 행에서 선 모양 정보: geomBytes > 0이면 있음(크기), 0이면 없음, 값이 없으면 모름(옛 시트)
export function geomInfo(sheet) {
  const n = sheet?.stats?.geomBytes;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return { hasGeom: null, geomBytes: null };
  return { hasGeom: n > 0, geomBytes: n || 0 };
}

/**
 * 'vector'(선으로 그리기) 또는 'image'(그림으로 보기)
 * @param {{ hasGeom: boolean|null, geomBytes: number|null, mobile: boolean }} o hasGeom이 null이면 모름
 */
export function sheetViewMode({ hasGeom, geomBytes, mobile }) {
  if (hasGeom === false) return 'image';
  if (hasGeom == null || geomBytes == null) return mobile ? 'image' : 'vector'; // 크기를 모르는 옛 시트
  return geomBytes > (mobile ? GEOM_LIMIT.mobile : GEOM_LIMIT.pc) ? 'image' : 'vector';
}

// PC에서 크기 때문에 그림으로 연 경우에만 [선으로 보기]를 둔다
export const canAskVector = ({ hasGeom, geomBytes, mobile }) => !mobile && hasGeom === true && geomBytes > GEOM_LIMIT.pc;

const okFrame = (f) => f && [f.x0, f.y0, f.x1, f.y1].every(Number.isFinite) && f.x1 > f.x0 && f.y1 > f.y0;

// 그림이 덮는 시트 범위: 시트 행의 frame, 없으면 그림 크기(픽셀을 도면 단위로)
export function imageFrame(sheet, width, height) {
  if (okFrame(sheet?.frame)) return { x0: sheet.frame.x0, y0: sheet.frame.y0, x1: sheet.frame.x1, y1: sheet.frame.y1 };
  const w = width || sheet?.meta?.image?.width || 0;
  const h = height || sheet?.meta?.image?.height || 0;
  return w > 0 && h > 0 ? { x0: 0, y0: 0, x1: w, y1: h } : null;
}

/**
 * 그림 한 장(시트 범위 F를 덮는 w×h 픽셀)을 화면 view({ frame, scale })에 그릴 때의 원본·대상 사각형.
 * 보이는 부분만 잘라 그린다(크게 확대해도 좌표가 터지지 않게). 안 보이면 null
 */
export function imageRects(view, F, w, h) {
  const vf = view.frame;
  const x0 = Math.max(F.x0, vf.x0);
  const x1 = Math.min(F.x1, vf.x1);
  const y0 = Math.max(F.y0, vf.y0);
  const y1 = Math.min(F.y1, vf.y1);
  if (!(x1 > x0 && y1 > y0)) return null;
  const kx = w / (F.x1 - F.x0);
  const ky = h / (F.y1 - F.y0);
  return {
    s: [(x0 - F.x0) * kx, (F.y1 - y1) * ky, (x1 - x0) * kx, (y1 - y0) * ky],
    d: [(x0 - vf.x0) * view.scale, (vf.y1 - y1) * view.scale, (x1 - x0) * view.scale, (y1 - y0) * view.scale],
  };
}

const meets = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * 확대해서 전체 그림이 흐려지면(화면 픽셀이 그림 픽셀보다 촘촘하면) 보이는 조각 그림 번호들
 * @param {{ frame, scale }} view scale = 화면 픽셀/도면 단위
 * @param {{ regions?: { n: number, x0: number, y0: number, x1: number, y1: number }[] }|null} tiles 시트 meta.tiles
 * @param {{ x0: number, x1: number }} F 전체 그림의 시트 범위
 * @param {number} fullWidth 전체 그림 폭(픽셀)
 */
export function tilesInView(view, tiles, F, fullWidth) {
  if (!tiles?.regions?.length || !(fullWidth > 0)) return [];
  const fullScale = fullWidth / (F.x1 - F.x0);
  if (view.scale <= fullScale * 1.15) return [];
  return tiles.regions.filter((r) => r && meets(r, view.frame)).map((r) => r.n);
}
