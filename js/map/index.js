// 지도 고르기: 카카오 키가 있으면 카카오맵, 없거나 실패하면 데모 지도(OpenStreetMap).
// 네이버지도·구글맵을 추가할 때는 같은 메서드를 갖춘 파일을 이 폴더에 만들고 여기서 고르면 된다.
import { KakaoMap, loadKakao } from './kakao.js';
import { OsmMap, loadLeaflet } from './osm.js';

/**
 * @param {HTMLElement} el
 * @param {{ kakaoKey?: string, onClick?: (lat:number, lng:number) => void, onFallback?: (msg:string) => void }} opts
 */
export async function createMap(el, opts) {
  if (opts.kakaoKey) {
    try {
      await loadKakao(opts.kakaoKey);
      return new KakaoMap(el, opts);
    } catch (err) {
      console.warn('[map] 카카오 지도 로딩 실패', err);
      opts.onFallback?.('카카오 지도를 불러오지 못해 데모 지도로 표시합니다. JavaScript 키와 카카오 콘솔의 도메인 등록을 확인해주세요.');
    }
  }
  await loadLeaflet();
  return new OsmMap(el, opts);
}
