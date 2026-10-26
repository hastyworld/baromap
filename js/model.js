// 화면과 무관한 계산(날짜·공기 경과·정원·거리). 브라우저와 Node 테스트에서 같이 쓴다.

export function todayStr(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// dateStr까지 남은 날(오늘=0, 지났으면 음수). 날짜가 없으면 null.
export function daysUntil(dateStr, today = todayStr()) {
  if (!dateStr) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 864e5);
}

// 공기 경과율과 준공 D-day
export function siteProgress(site, today = todayStr()) {
  const { startDate, endDate } = site;
  const toEnd = daysUntil(endDate, today);
  const fromStart = startDate ? -daysUntil(startDate, today) : null;
  if (!startDate || !endDate) return { state: 'unknown', pct: null, toEnd, fromStart };
  const total = daysUntil(endDate, startDate);
  if (fromStart < 0) return { state: 'before', pct: 0, toEnd, toStart: -fromStart, total };
  if (toEnd < 0) return { state: 'done', pct: 100, toEnd, total };
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((fromStart / total) * 100))) : 100;
  return { state: 'ongoing', pct, toEnd, elapsed: fromStart, total };
}

// 계약 만료: expired(지남) / soon(alertDays 이내) / ok
export function leaseStatus(leaseEnd, today = todayStr(), alertDays = 30) {
  const d = daysUntil(leaseEnd, today);
  if (d == null) return { d: null, level: null };
  if (d < 0) return { d, level: 'expired' };
  if (d <= alertDays) return { d, level: 'soon' };
  return { d, level: 'ok' };
}

// 정원 대비 거주 인원: over(초과) / full(만실) / ok(여유) / none(정원 미입력)
export function occupancy(capacity, count) {
  const cap = Number(capacity) || 0;
  if (!cap) return { n: count, cap: 0, level: 'none', free: null };
  if (count > cap) return { n: count, cap, level: 'over', free: cap - count };
  if (count === cap) return { n: count, cap, level: 'full', free: 0 };
  return { n: count, cap, level: 'ok', free: cap - count };
}

// 두 좌표 사이 직선거리(m)
export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// a에서 b를 바라보는 방향(도). 정북 0°, 시계 방향. 로드뷰가 현장 쪽을 보게 할 때 쓴다.
export function bearingDeg(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

// 사진 가로:세로 비율로 둘러볼 수 있는 범위(도)를 정한다.
// 2:1이면 360° 카메라 사진(사방), 그보다 길면 휴대폰 파노라마(좌우로 최대 360°), 짧으면 일반 사진.
export function panoView(width, height) {
  const r = width > 0 && height > 0 ? width / height : 2;
  if (r >= 1.9 && r <= 2.1) return { kind: 'sphere', haov: 360, vaov: 180 };
  if (r > 2.1) {
    const haov = Math.min(360, Math.round(r * 60));
    return { kind: 'pano', haov, vaov: Math.round(haov / r) };
  }
  if (r >= 1) return { kind: 'photo', haov: Math.round(55 * r), vaov: 55 };
  return { kind: 'photo', haov: 50, vaov: Math.round(50 / r) };
}

export const PANO_LABEL = { sphere: '360° 사진', pano: '파노라마', photo: '일반 사진' };
