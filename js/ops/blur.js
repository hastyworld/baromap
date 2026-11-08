// 사진 얼굴 가리기(11 지시서 2-2절): MediaPipe로 얼굴을 찾고, 사람이 상자를 끄고 켜거나 손으로 더 가린 뒤 모자이크를 입힌다.
// 모델은 저장소(vendor/mediapipe), wasm은 CDN → 서비스워커가 보관해 처음 한 번 뒤에는 오프라인에서도 돈다. 못 받으면 손으로 가리기만.
import { $, icon, onAction, openModal, closeModal, toast } from '../util.js';
import { expandBox, mosaicCell, mergeBoxes, panoTiles, tileBoxToImage, dragBox, gridTiles } from './calc/blur.js';

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = new URL('../../vendor/mediapipe/blaze_face_short_range.tflite', import.meta.url).href;

let detector = null;
let loading = null;

async function loadDetector() {
  if (detector) return detector;
  loading ||= (async () => {
    const { FilesetResolver, FaceDetector } = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    detector = await FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.45 });
    return detector;
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

function crop(src, t) {
  const c = document.createElement('canvas');
  c.width = t.w;
  c.height = t.h;
  const g = c.getContext('2d');
  g.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
  // 360° 사진 오른쪽 끝을 넘은 조각은 왼쪽 끝으로 이어 그린다
  if (t.x + t.w > src.width) g.drawImage(src, 0, t.y, t.x + t.w - src.width, t.h, src.width - t.x, 0, t.x + t.w - src.width, t.h);
  return c;
}

const boxesIn = (d, c) => d.detect(c).detections.map((x) => ({ x: x.boundingBox.originX, y: x.boundingBox.originY, w: x.boundingBox.width, h: x.boundingBox.height }));

/**
 * 캔버스에서 얼굴 찾기. 짧은 거리용 모델이라 먼 얼굴은 조각으로 나눠 다시 찾는다.
 * @returns {Promise<{ boxes: {x:number,y:number,w:number,h:number}[], ok: boolean }>} ok가 false면 모델을 못 받은 것(손으로 가리기만)
 */
export async function findFaces(canvas, { pano = false } = {}) {
  let d;
  try { d = await loadDetector(); } catch (err) {
    console.warn('[blur] 얼굴 찾기 모델을 불러오지 못했습니다.', err);
    return { boxes: [], ok: false };
  }
  const { width, height } = canvas;
  const found = pano ? [] : boxesIn(d, canvas);
  const tiles = pano ? panoTiles(width, height) : gridTiles(width, height);
  for (const t of tiles) for (const b of boxesIn(d, crop(canvas, t))) found.push(...tileBoxToImage(b, t, width));
  return { boxes: mergeBoxes(found.map((b) => expandBox(b, width, height))), ok: true };
}

// 상자를 모자이크로 덮는다: 작게 줄였다가 뭉개서 다시 키운다
export function mosaic(canvas, boxes) {
  const g = canvas.getContext('2d');
  for (const b of boxes) {
    if (b.w < 1 || b.h < 1) continue;
    const cell = mosaicCell(b);
    const sw = Math.max(1, Math.round(b.w / cell));
    const sh = Math.max(1, Math.round(b.h / cell));
    const small = document.createElement('canvas');
    small.width = sw;
    small.height = sh;
    small.getContext('2d').drawImage(canvas, b.x, b.y, b.w, b.h, 0, 0, sw, sh);
    g.save();
    g.imageSmoothingEnabled = false;
    g.drawImage(small, 0, 0, sw, sh, b.x, b.y, b.w, b.h);
    g.restore();
  }
}

// ---------------------------------------------------------------- 미리보기(상자 끄고 켜기, 손으로 가리기)

let review = null; // { items: [{ canvas, boxes: [{...box, on}], ok }], i, hand, drag, resolve }

function stage() {
  const it = review.items[review.i];
  const c = $('#fr-canvas');
  if (!c) return;
  const max = Math.min(860, c.parentElement.clientWidth || 640);
  const k = Math.min(1, max / it.canvas.width);
  c.width = Math.round(it.canvas.width * k);
  c.height = Math.round(it.canvas.height * k);
  review.k = k;
  const g = c.getContext('2d');
  g.drawImage(it.canvas, 0, 0, c.width, c.height);
  for (const b of it.boxes) {
    g.lineWidth = 3;
    g.strokeStyle = b.on ? '#E03131' : '#868E96';
    g.setLineDash(b.on ? [] : [6, 5]);
    g.strokeRect(b.x * k, b.y * k, b.w * k, b.h * k);
    if (b.on) { g.fillStyle = 'rgba(224, 49, 49, .28)'; g.fillRect(b.x * k, b.y * k, b.w * k, b.h * k); }
  }
  g.setLineDash([]);
  const on = it.boxes.filter((b) => b.on).length;
  $('#fr-info').textContent = `${review.items.length > 1 ? `사진 ${review.i + 1}/${review.items.length} · ` : ''}${it.ok ? `찾은 얼굴 ${it.boxes.length}개, 가릴 곳 ${on}개` : `얼굴 찾기를 쓸 수 없습니다(인터넷 연결 필요). 가릴 곳 ${on}개`}`;
  $('#fr-hand')?.classList.toggle('on', review.hand);
  const prev = $('#fr-prev');
  if (prev) prev.disabled = review.i === 0;
  const next = $('#fr-next');
  if (next) next.disabled = review.i >= review.items.length - 1;
}

const at = (e) => { const r = e.target.getBoundingClientRect(); return { x: (e.clientX - r.left) / review.k, y: (e.clientY - r.top) / review.k }; };

document.addEventListener('pointerdown', (e) => {
  if (!review || e.target.id !== 'fr-canvas') return;
  const p = at(e);
  if (review.hand) { review.drag = { a: p, b: p }; e.target.setPointerCapture?.(e.pointerId); e.preventDefault(); return; }
  const hit = review.items[review.i].boxes.find((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
  if (hit) { hit.on = !hit.on; stage(); }
});
document.addEventListener('pointermove', (e) => {
  if (!review?.drag) return;
  review.drag.b = at(e);
  stage();
  const it = review.items[review.i];
  const box = dragBox(review.drag.a, review.drag.b, it.canvas.width, it.canvas.height);
  const g = $('#fr-canvas').getContext('2d');
  g.strokeStyle = '#FCC419';
  g.lineWidth = 3;
  g.strokeRect(box.x * review.k, box.y * review.k, box.w * review.k, box.h * review.k);
});
document.addEventListener('pointerup', () => {
  if (!review?.drag) return;
  const it = review.items[review.i];
  const box = dragBox(review.drag.a, review.drag.b, it.canvas.width, it.canvas.height);
  review.drag = null;
  if (box.w > 6 && box.h > 6) it.boxes.push({ ...box, on: true, hand: true });
  stage();
});

/**
 * 사진들을 보여 주고 사람이 고친 뒤 모자이크를 입힌다.
 * @param {HTMLCanvasElement[]} canvases
 * @param {{ pano?: boolean, enabled?: boolean }} o enabled가 false면(현장에서 끔) 찾지 않고 손으로 가리기만
 * @returns {Promise<{ blurred: boolean }[] | null>} 취소하면 null. 캔버스는 그 자리에서 바뀐다
 */
export async function reviewFaces(canvases, { pano = false, enabled = true } = {}) {
  const items = [];
  for (const canvas of canvases) {
    const r = enabled ? await findFaces(canvas, { pano }) : { boxes: [], ok: true };
    items.push({ canvas, boxes: r.boxes.map((b) => ({ ...b, on: true })), ok: r.ok, ran: enabled && r.ok });
  }
  return new Promise((resolve) => {
    review = { items, i: 0, hand: false, drag: null, resolve, k: 1 };
    openModal({
      title: '사진 확인 — 얼굴 가리기',
      wide: true,
      body: `<p class="muted small">빨간 상자는 모자이크로 가립니다. 상자를 누르면 켜고 끕니다. 못 찾은 얼굴은 [손으로 가리기]를 누르고 사각형을 그리세요.${pano ? ' 360° 사진의 위·아래 끝은 못 찾을 수 있습니다.' : ''}</p>
        <div class="fr-stage"><canvas id="fr-canvas" class="fr-canvas"></canvas></div>
        <p class="small fr-info" id="fr-info"></p>
        <div class="fr-tools"><button type="button" class="btn" id="fr-hand" data-act="fr-hand">${icon('edit')}손으로 가리기</button>
          ${items.length > 1 ? `<span class="spacer"></span><button type="button" class="btn" id="fr-prev" data-act="fr-go" data-d="-1">이전</button><button type="button" class="btn" id="fr-next" data-act="fr-go" data-d="1">다음</button>` : ''}</div>`,
      footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="button" class="btn primary" data-act="fr-done">${icon('check')}이대로 올리기</button>`,
      onClose: () => { if (review) { const r = review; review = null; r.resolve(null); } },
    });
    requestAnimationFrame(stage);
  });
}

onAction('fr-hand', () => { review.hand = !review.hand; toast(review.hand ? '사진 위에 사각형을 그리세요.' : '손으로 가리기를 껐습니다.'); stage(); });
onAction('fr-go', (el) => { review.i += Number(el.dataset.d); stage(); });
onAction('fr-done', () => {
  const r = review;
  review = null;
  const out = r.items.map((it) => {
    mosaic(it.canvas, it.boxes.filter((b) => b.on));
    return { blurred: it.ran || it.boxes.some((b) => b.on) };
  });
  closeModal(true);
  r.resolve(out);
});

export const faceReviewState = () => (review ? { i: review.i, boxes: review.items.map((x) => x.boxes.length) } : null);
