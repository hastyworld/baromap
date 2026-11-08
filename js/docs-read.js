// 브라우저에서 문서 열기(20 지시서 3절). 엑셀 → 시트별 표, PDF → 쪽 그림 + 쪽 글자, 그림 → 쪽 그림 한 장.
// PDF를 읽는 pdf.js는 PDF를 올릴 때만 CDN에서 불러온다.
import { xlsx } from './excel-ui.js';
import { gridOf } from './bim/doc-core.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38';
const PAGE_SIDE = 1568; // 쪽 그림 긴 변(px)
const MAX_PAGES = 300;

export const isExcel = (name) => /\.(xlsx|xls|csv)$/i.test(name);
export const isPdf = (name) => /\.pdf$/i.test(name);
export const isImage = (name) => /\.(png|jpe?g)$/i.test(name);
export const isHwp = (name) => /\.hwpx?$/i.test(name);

/** 엑셀·CSV → [{ name, grid }] */
export async function readExcel(blob, name) {
  const X = await xlsx();
  const buf = await blob.arrayBuffer();
  if (/\.csv$/i.test(name)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('euc-kr').decode(buf); }
    const wb = X.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
    return [{ name: 'CSV', grid: gridOf(wb.Sheets[wb.SheetNames[0]]) }];
  }
  const wb = X.read(buf, { type: 'array' });
  return wb.SheetNames.map((n) => ({ name: n, grid: gridOf(wb.Sheets[n]) }));
}

const toPng = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

// 글자 조각을 줄로 묶는다(같은 높이 = 같은 줄)
function pageText(items) {
  const lines = new Map();
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const y = Math.round(it.transform[5] / 3);
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push(it);
  }
  return [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, l]) => l.sort((a, b) => a.transform[4] - b.transform[4]).map((x) => x.str.trim()).join('\t')).join('\n');
}

/** PDF → { pages, texts, images } (쪽마다 그림을 onPage로 넘긴다) */
export async function readPdf(blob, { onPage = async () => {} } = {}) {
  const lib = await import(`${PDFJS}/build/pdf.min.mjs`);
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
  const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), cMapUrl: `${PDFJS}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS}/standard_fonts/` }).promise;
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  const texts = [];
  for (let n = 1; n <= pages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PAGE_SIDE / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    texts.push(pageText((await page.getTextContent()).items));
    await onPage(n, await toPng(canvas));
    page.cleanup();
  }
  await pdf.destroy();
  return { pages, texts, more: pdf.numPages > MAX_PAGES };
}

/** 그림 → PNG 한 장(긴 변을 줄인다) */
export async function readImage(blob) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, PAGE_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return toPng(canvas);
}
