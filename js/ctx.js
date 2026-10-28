// 화면 모듈들이 함께 쓰는 설정·저장소·상태. app.js가 시작할 때 채운다.
import { openStore } from './store.js';

const DEFAULTS = {
  kakaoJsKey: '',
  serviceName: '바로맵',
  supabaseUrl: '',
  supabaseAnonKey: '',
  authProviders: [],
  nearbyRadius: 2000,
  nearbyCategories: [{ code: 'HP8', label: '병원' }, { code: 'PM9', label: '약국' }, { code: 'CS2', label: '편의점' }],
  leaseAlertDays: 30,
};

export const CFG = { ...DEFAULTS, ...(window.BAROMAP_CONFIG || {}) };

// 화면의 [지도 설정]에서 넣은 키가 config.js보다 우선한다(비어 있으면 config.js 키).
export const KEY_STORAGE = 'baromap.kakaoKey';
export function kakaoKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || CFG.kakaoJsKey;
  } catch {
    return CFG.kakaoJsKey;
  }
}

// 공유(Supabase) 또는 브라우저 저장소. initStore() 뒤에 쓴다.
export let store = null;
export async function initStore() {
  store = await openStore(CFG);
  return store;
}

// DB의 권한 값 → 화면 이름. admin은 "운영자", supervisor는 "관리자"(모든 현장 현황, 거주자 정보는 못 봄)
export const ROLE_LABEL = { pending: '승인 대기', viewer: '조회', manager: '현장 담당', supervisor: '관리자', admin: '운영자' };

export const state = {
  data: { sites: [], lodgings: [], residents: [] },
  siteId: null,
  lodgingId: null,
  view: 'site', // site | lodging
  sheet: 'peek', // 휴대폰 정보 시트: mini | peek | full
  nearby: {}, // siteId → { [code]: items | 'loading' | { error } }
  nearbyCode: 'HP8',
  nearbyShow: false,
  temp: null, // 대화상자에서 고른 위치 { lat, lng, kind }
  picking: null, // 지도에서 위치 지정 중 { kind, onPick }
  flashResident: null,
};

export const q = {
  site: (id) => state.data.sites.find((s) => s.id === id),
  lodging: (id) => state.data.lodgings.find((l) => l.id === id),
  resident: (id) => state.data.residents.find((r) => r.id === id),
  lodgingsOf: (siteId) => state.data.lodgings.filter((l) => l.siteId === siteId),
  residentsOf: (lodgingId) => state.data.residents.filter((r) => r.lodgingId === lodgingId),
  // 거주 인원 수: 거주자를 볼 수 있으면 실제 명단으로, 아니면(관리자) 서버가 준 숫자로
  residentCount(lodgingId) {
    const l = q.lodging(lodgingId);
    if (!l || store.can('viewResidents', l.siteId)) return q.residentsOf(lodgingId).length;
    return state.data.counts?.[lodgingId] ?? 0;
  },
};

// app.js가 채워 넣는 화면 함수(모듈 간 순환 참조를 피하기 위함)
export const ui = {
  render() {},
  selectSite(_id, _opts) {},
  selectLodging(_id, _opts) {},
  syncMap() {},
  focus(_lat, _lng) {},
  startPicking(_opts) {},
};
