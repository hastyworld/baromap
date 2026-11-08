// 해 위치(22 지시서 2절): 위경도·시각 → 방위(북쪽에서 시계 방향, 도)·고도(도). 순수 함수(NOAA 간이식, 오차 1도 안팎).
// 동 그림자 보기는 시공 계획 참고용이다. 일조권 판단 도구가 아니다.
const RAD = Math.PI / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;

/**
 * @param {Date} date 시각(UTC 기준 순간)
 * @param {number} lat 위도
 * @param {number} lng 경도
 * @returns {{ azimuth: number, altitude: number }}
 */
export function sunPosition(date, lat, lng) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = norm360(280.46 + 0.9856474 * n);
  const g = norm360(357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = norm360(280.46061837 + 360.98564736629 * n);
  const ha = (norm360(gmst + lng) * RAD) - ra;
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { azimuth: norm360(az / RAD), altitude: alt / RAD };
}

/** 모델 좌표(x 동, y 북, z 위)의 해 쪽 단위 벡터. northDeg: 도면 위쪽이 북쪽에서 돈 각 */
export function sunVector({ azimuth, altitude }, northDeg = 0) {
  const a = (azimuth + northDeg) * RAD;
  const h = altitude * RAD;
  return [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
}

/** 한국 시각(날짜 'YYYY-MM-DD', 시 0~24 소수) → Date */
export const kstDate = (day, hour) => new Date(Date.parse(`${day}T00:00:00+09:00`) + hour * 3600000);
