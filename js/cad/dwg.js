// DWG → DXF(19 지시서 6절). 워커 안에서 DWG가 들어올 때만 LibreDWG WASM을 불러 DXF로 바꾼다. 뒤는 DXF와 같다.
// 도면은 PC 밖으로 나가지 않는다. LibreDWG는 GPLv3이고 품질 시험과 법무 판단 전이라 "시험 기능"이다:
// 공개 사이트에서는 켜지 않는다(dwgAllowed). 저장소에 변환기를 넣지 않고 CDN에서 받는다.
// 변환기 두 판(44 지시서 3.6): 먼저 쓰는 판이 실패하면 다른 고정 판으로 한 번 더. 판마다 잘 바꾸는 파일이 다르다
// (회사 도서 한 벌: 0.8.7이 368/396, 실패 28 중 4개를 0.8.2가 살림). 두 판 모두 출시 2주가 넘은 판으로 고정.
const CDN = 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web';
export const DWG_LIBS = [`${CDN}@0.8.7`, `${CDN}@0.8.2`];
export const DWG_LIB = DWG_LIBS[0];
/** 변환기 판 이름(기록용): "0.8.7+0.8.2" */
export const DWG_CONV = DWG_LIBS.map((u) => u.split('@').pop()).join('+');

const MAGIC = /^AC\d{4}/;

export function isDwgBytes(bytes) {
  return MAGIC.test(String.fromCharCode(...bytes.slice(0, 6)));
}

// 이 PC에서 돌리는 바로맵(localhost)이나, 설정에서 켠 곳에서만
export const dwgAllowed = (host, cfg = {}) => cfg.dwgEnabled === true || host === 'localhost' || host === '127.0.0.1';

export class DwgError extends Error {}

export const DWG_HELP = 'DWG를 읽지 못했습니다. AutoCAD에서 "다른 이름으로 저장 → DXF"로 바꿔서 올려주세요. 파일은 그대로 있습니다.';

const loading = new Map(); // 판 주소 → 불러오는 중인 변환기
function loadLib(url = DWG_LIB) {
  if (!loading.has(url)) {
    loading.set(url, (async () => {
      const { LibreDwg } = await import(`${url}/dist/libredwg-web.js`);
      return LibreDwg.create(`${url}/wasm/`);
    })().catch((err) => { loading.delete(url); throw err; }));
  }
  return loading.get(url);
}

/**
 * @param {Blob} blob DWG 파일
 * @param {{ load?: () => Promise<{ dwg_write_dxf: (b: ArrayBuffer) => Uint8Array | null }>, lib?: string }} [o] 시험에서는 변환기를 넣어 준다. lib: 변환기 판 주소
 * @returns {Promise<Blob>} DXF
 */
export async function dwgToDxf(blob, { lib = DWG_LIB, load = () => loadLib(lib) } = {}) {
  let out = null;
  try {
    const conv = await load();
    out = conv.dwg_write_dxf(await blob.arrayBuffer());
  } catch (err) {
    console.warn('[dwg] 변환 실패', err);
  }
  // 변환기(wasm)는 한 번 실패하면 메모리가 망가져 다음 파일도 모두 실패한다(실제 도서 47개 중 8개만 변환된 원인).
  // 실패하면 버리고 다음 파일은 새로 띄운다(도서 한 번에 올리기는 워커째 버린다 — js/cad/dwg-worker.js).
  if (!out?.length) loading.delete(lib);
  if (!out?.length) throw new DwgError(DWG_HELP);
  return new Blob([out], { type: 'application/dxf' });
}
