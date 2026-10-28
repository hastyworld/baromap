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

// ---------------------------------------------------------------- 공정 현황(골구도)
// 세대 키는 "층:라인"(10층 2호 라인 → "10:2"), 화면에는 호수(1002호)로 보인다.

export const unitKey = (floor, line) => `${floor}:${line}`;

export function unitLabel(floor, line) {
  return /^\d{1,2}$/.test(line) ? `${floor}${line.padStart(2, '0')}` : `${floor}${line}`;
}

// 동의 모든 세대(라인 순서, 아래층부터)
export function buildingUnits(b) {
  const out = [];
  for (const ln of b.lines || []) {
    for (let f = ln.from; f <= ln.to; f++) out.push({ floor: f, line: ln.name, key: unitKey(f, ln.name) });
  }
  return out;
}

// 여러 동을 나란히 그릴 때의 가장 낮은 층·높은 층
export function floorSpan(buildings) {
  let min = Infinity;
  let max = -Infinity;
  for (const b of buildings) for (const ln of b.lines || []) { min = Math.min(min, ln.from); max = Math.max(max, ln.to); }
  return min > max ? { min: 1, max: 1 } : { min, max };
}

// 시트 통계: 공종(1번부터)마다 "그 공종까지 끝난" 세대 수·비율과, 지금 그 공종에 멈춰 있는 세대 수
// cells: { [buildingId]: { [unitKey]: { step } } }
export function sheetStats(sheet, buildings, cells = {}) {
  const n = (sheet?.trades || []).length;
  const done = Array(n).fill(0);
  const at = Array(n + 1).fill(0);
  let total = 0;
  for (const b of buildings) {
    for (const u of buildingUnits(b)) {
      total++;
      const st = Math.min(n, cells[b.id]?.[u.key]?.step || 0);
      at[st]++;
      for (let k = 0; k < st; k++) done[k]++;
    }
  }
  return { total, done, at, pct: done.map((d) => (total ? Math.round((d / total) * 100) : 0)) };
}

// 칸에 공종 번호를 넣으면 그 공종의 작업일을 남기고, 더 뒤 공종의 날짜는 지운다(되돌릴 때).
export function nextCell(prev, step, date) {
  const dates = {};
  for (const [k, v] of Object.entries(prev?.dates || {})) if (Number(k) <= step) dates[k] = v;
  if (step > 0 && date) dates[step] = date;
  return { step, dates };
}

// 배경색 위에서 잘 읽히는 글자색
export function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#111';
  const v = parseInt(m[1], 16);
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(v >> 16) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
  return L > 0.42 ? '#111' : '#fff';
}

// 공종 색(겹치지 않게 차례로). 밝은·어두운 화면 모두에서 구분되는 색.
export const TRADE_COLORS = ['#4C6EF5', '#12B886', '#FAB005', '#F76707', '#E64980', '#7950F2', '#40C057', '#15AABF', '#E03131', '#82C91E', '#BE4BDB', '#868E96'];

// 공종 시트 예시(현장에서 고쳐 쓴다)
export const SHEET_PRESETS = [
  { name: '골조', trades: ['먹매김', '철근', '거푸집', '콘크리트 타설', '양생·해체'] },
  { name: '세대 마감', trades: ['방수', '미장', '타일', '창호', '도장', '도배', '마루', '가구', '입주청소'] },
  { name: '설비·전기', trades: ['배관', '배선', '기구 설치', '시운전'] },
];
