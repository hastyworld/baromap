// 큰 zip 읽기(44 지시서 3.3) — 외부 라이브러리 없이 Blob 조각만 읽는다. 1.8GB zip도 목록(중앙 디렉터리)만 메모리에 올리고,
// 항목은 하나씩 꺼낸다(무압축은 원본 Blob 조각 그대로, deflate는 DecompressionStream('deflate-raw')). 브라우저·Node 20+ 공용.
// zip64(4GB·65535개 넘는 압축), UTF-8 표시·유니코드 경로 칸(0x7075)·cp949 이름(js/cad/book.js decodeName), 경로 안전(safePath).
import { decodeName, safePath, entryKind } from './book.js';

export class ZipError extends Error {}

const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));
async function bytesAt(blob, start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); }

/** 앞 4바이트가 zip 머리인지 */
export async function looksZip(blob) {
  if (!blob || blob.size < 22) return false;
  const b = await bytesAt(blob, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);
}

/**
 * zip 목록
 * @param {Blob} blob
 * @returns {Promise<{ name: string, path: string|null, size: number, csize: number, crc: number, method: number, offset: number, dir: boolean, encrypted: boolean }[]>}
 *   path가 null이면 위험한 경로(.. 또는 절대 경로)라 건너뛸 항목
 */
export async function listZip(blob) {
  const tailLen = Math.min(blob.size, 22 + 65535 + 20);
  const tail = await bytesAt(blob, blob.size - tailLen, blob.size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tv, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new ZipError('압축 파일이 아니거나 깨졌습니다.');
  let count = u16(tv, e + 10);
  let cdSize = u32(tv, e + 12);
  let cdOff = u32(tv, e + 16);
  // zip64: 끝 레코드 바로 앞의 zip64 위치표 → zip64 끝 레코드
  if (e >= 20 && u32(tv, e - 20) === 0x07064b50) {
    const at = u64(tv, e - 20 + 8);
    const z = await bytesAt(blob, at, at + 56);
    const zv = new DataView(z.buffer);
    if (u32(zv, 0) === 0x06064b50) { count = u64(zv, 32); cdSize = u64(zv, 40); cdOff = u64(zv, 48); }
  }
  const cd = await bytesAt(blob, cdOff, cdOff + cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length && u32(dv, p) === 0x02014b50; k++) {
    const flags = u16(dv, p + 8);
    const method = u16(dv, p + 10);
    const crc = u32(dv, p + 16);
    let csize = u32(dv, p + 20);
    let size = u32(dv, p + 24);
    const nlen = u16(dv, p + 28);
    const xlen = u16(dv, p + 30);
    const clen = u16(dv, p + 32);
    let offset = u32(dv, p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
    let unicode = null;
    // 추가 칸: zip64(0x0001: 원래 크기·압축 크기·위치 중 0xFFFFFFFF인 것만 차례로), 유니코드 경로(0x7075)
    for (let x = p + 46 + nlen; x + 4 <= p + 46 + nlen + xlen;) {
      const id = u16(dv, x);
      const len = u16(dv, x + 2);
      let q = x + 4;
      if (id === 0x0001) {
        if (size === 0xffffffff) { size = u64(dv, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(dv, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(dv, q); q += 8; }
      } else if (id === 0x7075 && len > 5) unicode = cd.subarray(x + 4 + 5, x + 4 + len);
      x += 4 + len;
    }
    const name = decodeName(nameBytes, { utf8: Boolean(flags & 0x0800), unicode });
    const dir = name.endsWith('/') || name.endsWith('\\');
    out.push({ name, path: dir ? null : safePath(name), size, csize, crc, method, offset, dir, encrypted: Boolean(flags & 1) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/**
 * 항목 하나 꺼내기
 * @param {Blob} blob zip @param {{ offset: number, csize: number, size: number, method: number, encrypted: boolean, path?: string|null, name: string }} entry
 * @returns {Promise<Blob>}
 */
export async function entryBlob(blob, entry) {
  if (entry.encrypted) throw new ZipError('암호가 걸린 압축입니다.');
  const head = await bytesAt(blob, entry.offset, entry.offset + 30);
  const hv = new DataView(head.buffer);
  if (u32(hv, 0) !== 0x04034b50) throw new ZipError('압축 항목이 깨졌습니다.');
  const start = entry.offset + 30 + u16(hv, 26) + u16(hv, 28);
  const raw = blob.slice(start, start + entry.csize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new ZipError('지원하지 않는 압축 방식입니다(다시 압축해 주세요).');
  const out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  if (entry.size && out.size !== entry.size) throw new ZipError('압축 항목이 깨졌습니다(크기가 다름).');
  return out;
}

/**
 * 놓은 것(파일·zip) → 도서 파일 목록. zip은 풀고, zip 안의 zip은 한 단계만 더 푼다(그 안의 zip은 목록에만 남긴다).
 * 바깥 zip 항목의 경로는 zip이 있던 폴더 기준(드라이브가 나눠 준 zip 여러 개가 같은 폴더 구조로 합쳐지게),
 * 안쪽 zip 항목은 "안쪽 zip 이름(.zip 뗌)/항목"(그 zip이 들어 있던 공종 폴더를 이어받게).
 * 항목은 꺼내지 않고 open()으로 필요할 때 꺼낸다(메모리에 한꺼번에 올리지 않는다). src는 워커로 넘겨 워커가 꺼내게 할 수 있다(openSrc).
 * backed: 꺼내도 원본 파일 조각 그대로(무압축 항목·낱개 파일)라 메모리를 쓰지 않는다. crc: zip 목록의 CRC-32(같은 파일 짐작)
 * @param {{ path: string, blob: Blob }[]} items
 * @returns {Promise<{ files: { path: string, size: number, crc: number|null, inner: boolean, nested?: boolean, backed: boolean, src: { blob?: Blob, zip?: Blob, entry?: any }, open: () => Promise<Blob> }[], skipped: { unsafe: number, nested: number, broken: number, encrypted: number } }>}
 */
const ENTRY_KEYS = ['name', 'size', 'csize', 'crc', 'method', 'offset', 'encrypted'];
function item(path, zip, e, inner, nested = false) {
  const entry = Object.fromEntries(ENTRY_KEYS.map((k) => [k, e[k]]));
  const src = { zip, entry };
  return { path, size: e.size, crc: e.crc, inner, ...(nested ? { nested: true } : {}), backed: e.method === 0, src, open: () => openSrc(src) };
}

/** 원본 자리(src) → Blob: 낱개 파일이면 그대로, zip 항목이면 꺼낸다(워커 안에서도 쓴다) */
export const openSrc = (src) => (src.blob ? Promise.resolve(src.blob) : entryBlob(src.zip, src.entry));

export async function expandBook(items) {
  const files = [];
  const skipped = { unsafe: 0, nested: 0, broken: 0, encrypted: 0 };
  async function addZip(blob, prefix, depth) {
    let list;
    try { list = await listZip(blob); } catch { skipped.broken++; return; }
    for (const e of list) {
      if (e.dir) continue;
      if (!e.path) { skipped.unsafe++; continue; }
      if (e.encrypted) { skipped.encrypted++; continue; }
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      if (entryKind(path) === 'archive') {
        if (depth >= 1) { skipped.nested++; files.push(item(path, blob, e, true, true)); continue; }
        let inner = null;
        try { inner = await entryBlob(blob, e); } catch { skipped.broken++; continue; }
        await addZip(inner, path.replace(/\.zip$/i, ''), depth + 1);
        continue;
      }
      files.push(item(path, blob, e, depth > 0));
    }
  }
  for (const it of items) {
    const path = safePath(it.path) || safePath(it.blob?.name) || 'file';
    if (entryKind(path) === 'archive') {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      await addZip(it.blob, dir, 0);
    } else files.push({ path, size: it.blob.size, crc: null, inner: false, backed: true, src: { blob: it.blob }, open: async () => it.blob });
  }
  return { files, skipped };
}
