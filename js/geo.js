// 주소 → 좌표, 좌표 → 주소, 주변 시설 검색, 지도 앱 링크.
// 카카오맵 모드에서는 카카오 SDK services(브라우저에서 바로 호출), 데모 모드에서는 OpenStreetMap Nominatim을 쓴다.

let mode = 'osm';
export const setGeoMode = (m) => { mode = m; };
export const geoMode = () => mode;

const svc = () => window.kakao.maps.services;

function kakaoCall(fn) {
  return new Promise((resolve, reject) => {
    fn((result, status) => {
      if (status === svc().Status.OK) resolve(result);
      else if (status === svc().Status.ZERO_RESULT) resolve([]);
      else reject(new Error('카카오 검색 요청에 실패했습니다.'));
    });
  });
}

// Nominatim 이용 정책: 초당 1회 이하, 대량 사용 금지(데모 전용)
let osmQueue = Promise.resolve();
function nominatim(path, params) {
  const url = new URL(path, 'https://nominatim.openstreetmap.org');
  for (const [k, v] of Object.entries({ format: 'jsonv2', 'accept-language': 'ko', ...params })) url.searchParams.set(k, v);
  const job = osmQueue.then(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('주소 검색 서버가 응답하지 않습니다. 잠시 후 다시 시도하거나 지도에서 직접 지정해주세요.');
    return res.json();
  });
  osmQueue = job.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return job;
}

// "123, 테헤란로, 역삼동, 강남구, 서울, 06234, 대한민국" → "서울 강남구 역삼동 테헤란로 123"
const osmLabel = (s) => String(s).split(',').map((x) => x.trim())
  .filter((x) => x && x !== '대한민국' && !/^\d{5}$/.test(x)).reverse().join(' ');

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const k = `${it.lat.toFixed(4)},${it.lng.toFixed(4)},${it.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** @returns {Promise<{name:string,address:string,jibun:string,lat:number,lng:number}[]>} */
export async function searchAddress(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  if (mode === 'kakao') {
    const geocoder = new (svc().Geocoder)();
    const places = new (svc().Places)();
    const [addr, kw] = await Promise.all([
      kakaoCall((cb) => geocoder.addressSearch(q, cb)).catch(() => []),
      kakaoCall((cb) => places.keywordSearch(q, cb)).catch(() => []),
    ]);
    return dedupe([
      ...addr.map((d) => ({
        name: d.road_address?.building_name || '', address: d.road_address?.address_name || d.address_name,
        jibun: d.address?.address_name || '', lat: Number(d.y), lng: Number(d.x),
      })),
      ...kw.map((d) => ({
        name: d.place_name, address: d.road_address_name || d.address_name, jibun: d.address_name, lat: Number(d.y), lng: Number(d.x),
      })),
    ]).slice(0, 12);
  }
  const rows = await nominatim('/search', { q, countrycodes: 'kr', limit: 8 });
  return dedupe(rows.map((r) => ({
    name: r.name && !/^\d/.test(r.name) ? r.name : '', address: osmLabel(r.display_name), jibun: '', lat: Number(r.lat), lng: Number(r.lon),
  })));
}

export async function reverseGeocode(lat, lng) {
  if (mode === 'kakao') {
    const geocoder = new (svc().Geocoder)();
    const r = await kakaoCall((cb) => geocoder.coord2Address(lng, lat, cb));
    return r[0] ? (r[0].road_address?.address_name || r[0].address?.address_name || '') : '';
  }
  const r = await nominatim('/reverse', { lat, lon: lng, zoom: 18 });
  return r && !r.error ? osmLabel(r.display_name) : '';
}

// 현장 주변 시설(카카오 장소 카테고리 검색). 데모 지도에서는 쓰지 않는다.
export async function nearbyPlaces(lat, lng, code, radius = 2000) {
  if (mode !== 'kakao') return null;
  const places = new (svc().Places)();
  const list = await kakaoCall((cb) => places.categorySearch(code, cb, {
    location: new window.kakao.maps.LatLng(lat, lng), radius, sort: svc().SortBy.DISTANCE,
  }));
  return list.map((d) => ({
    name: d.place_name, address: d.road_address_name || d.address_name, phone: d.phone, url: d.place_url,
    distance: Number(d.distance) || null, lat: Number(d.y), lng: Number(d.x),
  }));
}

// ---------------------------------------------------------------- 지도 앱 링크

const n = (name) => encodeURIComponent(String(name || '위치').replace(/[,/]/g, ' '));

export const links = {
  kakao: (p) => `https://map.kakao.com/link/map/${n(p.name)},${p.lat},${p.lng}`,
  naver: (p) => `https://map.naver.com/p/search/${encodeURIComponent(p.address || p.name)}`,
  google: (p) => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`,
  roadview: (p) => `https://map.kakao.com/link/roadview/${p.lat},${p.lng}`,
  // mode: car | traffic(대중교통) | walk | bicycle
  kakaoRoute: (mode, from, to) => `https://map.kakao.com/link/by/${mode}/${n(from.name)},${from.lat},${from.lng}/${n(to.name)},${to.lat},${to.lng}`,
};
