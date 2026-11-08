// 계산 알림(순수 함수): 저장하지 않고 데이터로 그때그때 계산한다(10 지시서 1절 notices). 단계가 늘면 여기에 규칙을 더한다.
import { leaseStatus } from '../../model.js';

// 숙소 계약 만료(기존 30일 규칙)
export function leaseAlerts(lodgings, today, days = 30) {
  return (lodgings || [])
    .map((l) => ({ l, st: leaseStatus(l.leaseEnd, today, days) }))
    .filter((x) => x.st.level === 'expired' || x.st.level === 'soon')
    .sort((a, b) => a.st.d - b.st.d);
}

const RANK = { danger: 0, warn: 1, info: 2 };
export const byLevel = (a, b) => (RANK[a.level] ?? 3) - (RANK[b.level] ?? 3) || String(a.title).localeCompare(String(b.title), 'ko');

// 지금 유효한 저장 알림: 해결되지 않았고 기간 안
export function activeNotices(list, nowIso) {
  const now = Date.parse(nowIso);
  return (list || []).filter((n) => !n.resolvedAt && (!n.startsAt || Date.parse(n.startsAt) <= now) && (!n.endsAt || Date.parse(n.endsAt) >= now));
}

/**
 * 현장 하나(또는 전체)의 계산 알림 목록.
 * @param {{ lodgings?: any[], siteId?: string|null, today: string, leaseDays?: number }} d
 * @returns {{ id: string, kind: string, level: 'danger'|'warn'|'info', title: string, sub?: string, go?: any }[]}
 */
export function computedAlerts({ lodgings = [], siteId = null, today, leaseDays = 30 }) {
  const out = [];
  const list = siteId ? lodgings.filter((l) => l.siteId === siteId) : lodgings;
  for (const { l, st } of leaseAlerts(list, today, leaseDays)) {
    out.push({
      id: `lease:${l.id}`, kind: 'lease', level: st.level === 'expired' ? 'danger' : 'warn',
      title: st.level === 'expired' ? `${l.name} 계약 만료 ${-st.d}일 지남` : `${l.name} 계약 만료 ${st.d === 0 ? '오늘' : `D-${st.d}`}`,
      sub: `계약 종료 ${l.leaseEnd}`, go: { lodgingId: l.id },
    });
  }
  return out.sort(byLevel);
}
