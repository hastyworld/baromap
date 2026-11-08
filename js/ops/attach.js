// 첨부(11 지시서 2-1절): 사진은 브라우저에서 줄이고 다시 저장한다. 다시 그리면 EXIF가 빠지므로 촬영 위치(GPS)가 지워진다.
// 촬영 시각은 다시 그리기 전에 읽어 둔다. 미리보기는 webp 320px, 40KB 이내.
import { store } from '../ctx.js';
import { toast } from '../util.js';
import { exifTakenAt } from './calc/exif.js';
import { reviewFaces } from './blur.js';

const MAX_SIDE = 2048;
const JPEG_Q = 0.82;
const THUMB_SIDE = 320;
const THUMB_MAX = 54000; // data URL 길이(≈ 40KB)

let input = null;

// 파일 고르기. 취소하면 빈 배열이 안 올 수도 있어(브라우저마다 다름) 화면은 기다리지 않는다.
export function pickFiles({ accept = 'image/*', multiple = true, capture = false } = {}) {
  return new Promise((resolve) => {
    input?.remove();
    input = Object.assign(document.createElement('input'), { type: 'file', accept, multiple, hidden: true, id: 'ops-file' });
    if (capture) input.setAttribute('capture', 'environment');
    input.addEventListener('change', () => resolve([...input.files]));
    input.addEventListener('cancel', () => resolve([]));
    document.body.append(input);
    input.click();
  });
}

const blobOf = (canvas, type, q) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('사진을 변환하지 못했습니다.'))), type, q);
});

async function decode(file) {
  if (globalThis.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* 아래 방법으로 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 파일 → 줄인 캔버스 + 촬영 시각
export async function imageCanvas(file, maxSide = MAX_SIDE) {
  const head = await file.slice(0, 131072).arrayBuffer();
  const src = await decode(file);
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  src.close?.();
  return { canvas: c, takenAt: exifTakenAt(head) || new Date(file.lastModified || Date.now()).toISOString() };
}

export function thumbOf(canvas) {
  const k = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * k));
  t.height = Math.max(1, Math.round(canvas.height * k));
  const g = t.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, t.width, t.height);
  for (const q of [0.7, 0.55, 0.4, 0.25]) {
    const url = t.toDataURL('image/webp', q);
    if (url.startsWith('data:image/webp') && url.length <= THUMB_MAX) return url;
    const jpg = t.toDataURL('image/jpeg', q);
    if (jpg.length <= THUMB_MAX) return jpg;
  }
  return '';
}

/**
 * 사진 고르기 → 줄이기 → 얼굴 가리기 → 올리기. 돌려주는 값은 기록의 files 칸에 넣는 항목들.
 * @param {{ siteId: string, kind: string, recordId: string, files?: File[], capture?: boolean, people?: boolean, max?: number }} o
 */
export async function addPhotos({ siteId, kind, recordId, files, capture = false, people = false, max = 20 }) {
  const list = (files || await pickFiles({ capture })).filter((f) => /^image\//.test(f.type)).slice(0, max);
  if (!list.length) return [];
  const { blurFaces } = await store.ops.settings(siteId);
  const prepared = [];
  for (const f of list) {
    try {
      prepared.push({ file: f, ...(await imageCanvas(f)) });
    } catch {
      toast(`사진을 읽지 못했습니다: ${f.name}`, 'crit');
    }
  }
  if (!prepared.length) return [];
  const res = await reviewFaces(prepared.map((p) => p.canvas), { enabled: blurFaces });
  if (!res) return [];
  const out = [];
  for (const [i, p] of prepared.entries()) {
    const blob = await blobOf(p.canvas, 'image/jpeg', JPEG_Q);
    out.push(await store.files.upload(siteId, kind, recordId, blob, {
      name: p.file.name.replace(/\.\w+$/, '.jpg'), thumb: thumbOf(p.canvas), takenAt: p.takenAt, blurred: res[i].blurred, people,
    }));
  }
  return out;
}

// PDF·엑셀 등 그대로 올리는 첨부
export async function addDocs({ siteId, kind, recordId, accept = '.pdf,.xlsx,.csv,application/pdf', people = false }) {
  const list = await pickFiles({ accept });
  const out = [];
  for (const f of list) out.push(await store.files.upload(siteId, kind, recordId, f, { name: f.name, takenAt: new Date().toISOString(), people }));
  return out;
}
