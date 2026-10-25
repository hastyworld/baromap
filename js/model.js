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
