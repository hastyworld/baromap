// 작은 zip 읽기·쓰기(xlsx용, 외부 라이브러리 없음). 압축 풀기·하기는 브라우저·Node에 있는 DecompressionStream / CompressionStream('deflate-raw').

let CRC = null;
function crc32(bytes) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const inflate = (b) => pipe(b, new DecompressionStream('deflate-raw'));
const deflate = (b) => pipe(b, new CompressionStream('deflate-raw'));

export const isZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * zip 바이트 → { names, read(name) → Uint8Array|null, text(name) → string|null }
 * @param {Uint8Array} bytes
 */
export function openZip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('엑셀(xlsx) 파일이 아니거나 깨졌습니다.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    entries.set(name.replace(/^\/+/, ''), { method, csize, off });
    p += 46 + nlen + xlen + clen;
  }
  const cache = new Map();
  async function read(name) {
    const e = entries.get(name);
    if (!e) return null;
    if (cache.has(name)) return cache.get(name);
    const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
    const raw = b.subarray(start, start + e.csize);
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = await inflate(raw);
    else throw new Error('지원하지 않는 압축 방식입니다. 엑셀에서 다시 저장해주세요.');
    cache.set(name, out);
    return out;
  }
  return {
    names: [...entries.keys()],
    read,
    async text(name) { const r = await read(name); return r ? dec.decode(r) : null; },
  };
}

/**
 * [{ name, data: Uint8Array|string }] → zip 바이트(압축)
 */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    const comp = await deflate(data);
    const crc = crc32(data);
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 8, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
    h.setUint32(14, crc, true); h.setUint32(18, comp.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); head.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 8, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true); c.setUint32(20, comp.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true); cen.set(name, 46);
    parts.push(head, comp);
    central.push(cen);
    offset += head.length + comp.length;
  }
  const size = central.reduce((a, x) => a + x.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, x) => a + x.length, 0));
  let p = 0;
  for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}
