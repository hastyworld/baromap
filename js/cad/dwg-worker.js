// DWG 변환 전용 워커(44 지시서 3.6): 파일 하나를 정해 준 판의 변환기로 DXF로 바꾼다.
// 변환기(wasm)가 죽거나 실패하면 부르는 쪽(js/book-upload.js)이 이 워커를 버리고 새로 띄운다 — 한 파일 때문에 다음 파일까지 실패하지 않게.
// 메시지: { id, file: Blob, lib } → { id, blob } | { id, error }
import { dwgToDxf } from './dwg.js';

self.onmessage = async (ev) => {
  const { id, file, lib } = ev.data || {};
  try {
    const blob = await dwgToDxf(file, { lib });
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
