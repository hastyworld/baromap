// 공정표 판 비교(28 지시서 5절): 늘어난 공기, 바뀐 행 수, 준공 예정일 차이. 순수 함수.
import { daysBetween, scheduleStats } from './core.js';

// 작업ID로 짝을 짓되, 두 판의 작업ID가 거의 겹치지 않으면(바차트·PDF처럼 ID가 없는 판) 위치·공종으로 짝을 짓는다
const byPlace = (a) => `${a.trade}|${a.zone}|${a.building}|${a.fromFloor}|${a.toFloor}`;
function keyFn(older, newer) {
  const ids = new Set(older.map((a) => a.actId));
  const hit = newer.filter((a) => ids.has(a.actId)).length;
  return hit >= Math.min(older.length, newer.length) * 0.3 ? (a) => a.actId : byPlace;
}
const same = (a, b) => a.start === b.start && a.finish === b.finish && a.trade === b.trade && a.building === b.building && a.fromFloor === b.fromFloor && a.toFloor === b.toFloor;

/**
 * @param {any[]} older 이전 판 활동 @param {any[]} newer 새 판 활동
 * @returns {{ startDays: number|null, finishDays: number|null, durationDays: number|null, changed: number, added: number, removed: number, moved: { actId: string, name: string, days: number }[] }}
 */
export function compareSchedules(older, newer) {
  const a = scheduleStats(older);
  const b = scheduleStats(newer);
  const oldWork = older.filter((x) => !x.summary);
  const newWork = newer.filter((x) => !x.summary);
  const key = keyFn(oldWork, newWork);
  const oldMap = new Map(oldWork.map((x) => [key(x), x]));
  const newMap = new Map(newWork.map((x) => [key(x), x]));
  let changed = 0;
  const moved = [];
  for (const [k, n] of newMap) {
    const o = oldMap.get(k);
    if (!o) continue;
    if (!same(o, n)) changed++;
    if (o.finish && n.finish && o.finish !== n.finish) moved.push({ actId: k, name: n.name, days: daysBetween(o.finish, n.finish) });
  }
  const dur = (s) => (s.start && s.finish ? daysBetween(s.start, s.finish) : null);
  return {
    startDays: a.start && b.start ? daysBetween(a.start, b.start) : null,
    finishDays: a.finish && b.finish ? daysBetween(a.finish, b.finish) : null,
    durationDays: dur(a) != null && dur(b) != null ? dur(b) - dur(a) : null,
    changed,
    added: [...newMap.keys()].filter((k) => !oldMap.has(k)).length,
    removed: [...oldMap.keys()].filter((k) => !newMap.has(k)).length,
    moved: moved.sort((x, y) => Math.abs(y.days) - Math.abs(x.days)).slice(0, 20),
  };
}
