// DWG → DXF(19 지시서 6절). 워커 안에서 DWG가 들어올 때만 LibreDWG WASM을 불러 DXF로 바꾼다. 뒤는 DXF와 같다.
// 도면은 PC 밖으로 나가지 않는다. LibreDWG는 GPLv3이고 품질 시험과 법무 판단 전이라 "시험 기능"이다:
// 공개 사이트에서는 켜지 않는다(dwgAllowed). 저장소에 변환기를 넣지 않고 CDN에서 받는다.
export const DWG_LIB = 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.8.2';

const MAGIC = /^AC\d{4}/;

export function isDwgBytes(bytes) {
  return MAGIC.test(String.fromCharCode(...bytes.slice(0, 6)));
}

// 이 PC에서 돌리는 바로맵(localhost)이나, 설정에서 켠 곳에서만
export const dwgAllowed = (host, cfg = {}) => cfg.dwgEnabled === true || host === 'localhost' || host === '127.0.0.1';

export class DwgError extends Error {}

export const DWG_HELP = 'DWG를 읽지 못했습니다. AutoCAD에서 "다른 이름으로 저장 → DXF"로 바꿔서 올려주세요. 파일은 그대로 있습니다.';

let loading = null;
async function loadLib() {
  loading ||= (async () => {
    const { LibreDwg } = await import(`${DWG_LIB}/dist/libredwg-web.js`);
    return LibreDwg.create(`${DWG_LIB}/wasm/`);
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

/**
 * @param {Blob} blob DWG 파일
 * @param {{ load?: () => Promise<{ dwg_write_dxf: (b: ArrayBuffer) => Uint8Array | null }> }} [o] 시험에서는 변환기를 넣어 준다
 * @returns {Promise<Blob>} DXF
 */
export async function dwgToDxf(blob, { load = loadLib } = {}) {
  let out = null;
  try {
    const lib = await load();
    out = lib.dwg_write_dxf(await blob.arrayBuffer());
  } catch (err) {
    console.warn('[dwg] 변환 실패', err);
  }
  if (!out?.length) throw new DwgError(DWG_HELP);
  return new Blob([out], { type: 'application/dxf' });
}
