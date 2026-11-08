// JPEG EXIF에서 촬영 시각 읽기(순수 함수). 위치(GPS)는 읽지 않는다 — 사진을 다시 그리면 EXIF가 통째로 빠진다(11 2-1절).

const DATE_TAGS = [0x9003, 0x9004, 0x0132]; // DateTimeOriginal, DateTimeDigitized, DateTime

function readIfd(view, base, off, little, out) {
  const n = view.getUint16(base + off, little);
  let exifPtr = null;
  for (let i = 0; i < n; i++) {
    const p = base + off + 2 + i * 12;
    if (p + 12 > view.byteLength) break;
    const tag = view.getUint16(p, little);
    if (tag === 0x8769) exifPtr = view.getUint32(p + 8, little);
    if (!DATE_TAGS.includes(tag) || out[tag]) continue;
    const count = view.getUint32(p + 4, little);
    const at = count > 4 ? base + view.getUint32(p + 8, little) : p + 8;
    let s = '';
    for (let k = 0; k < count - 1 && at + k < view.byteLength; k++) s += String.fromCharCode(view.getUint8(at + k));
    out[tag] = s;
  }
  return exifPtr;
}

/**
 * @param {ArrayBuffer} buf JPEG 파일 앞부분(128KB면 충분)
 * @returns {string} '2026-11-01T09:12:00+09:00' 또는 ''
 */
export function exifTakenAt(buf) {
  try {
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xffd8) return '';
    let p = 2;
    while (p + 4 < view.byteLength) {
      const marker = view.getUint16(p);
      const size = view.getUint16(p + 2);
      if (marker === 0xffe1 && view.getUint32(p + 4) === 0x45786966) {
        const base = p + 10;
        const little = view.getUint16(base) === 0x4949;
        const out = {};
        const exif = readIfd(view, base, view.getUint32(base + 4, little), little, out);
        if (exif) readIfd(view, base, exif, little, out);
        const raw = DATE_TAGS.map((t) => out[t]).find(Boolean) || '';
        const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw);
        return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00` : '';
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      p += 2 + size;
    }
  } catch { /* 깨진 파일이면 시각 없이 쓴다 */ }
  return '';
}
