// MS Project XML(MSPDI) 읽기(28 지시서 1절 2). .mpp는 직접 읽지 않는다 — "다른 이름으로 저장 → XML"로 받는다.
// Task: UID·ID·Name·WBS·OutlineLevel·Summary·Start·Finish·ActualStart·ActualFinish·PercentComplete·PredecessorLink·Baseline(0번)
// 달력: 기본 달력의 WeekDays(근무 요일)와 Exceptions(쉬는 날)
import { parseXml, kid, kids, path, val } from './xml.js';
import { activity, addDays } from './core.js';

const REL = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' };

export const isMspdi = (text) => /<Project[\s>][\s\S]{0,2000}(schemas\.microsoft\.com\/project|<Tasks>|<SaveVersion>)/.test(text.slice(0, 20000));

function calendarOf(proj) {
  const cals = path(proj, 'Calendars', 'Calendar');
  const uid = val(proj, 'CalendarUID');
  const base = cals.find((c) => val(c, 'UID') === uid) || cals.find((c) => val(c, 'IsBaseCalendar') === '1') || cals[0];
  if (!base) return null;
  const cal = { workdays: [], holidays: [], stops: [] };
  const DAY = { 1: 7, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 }; // MSPDI 1=일 … 7=토 → 1=월 … 7=일
  const range = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d); return out; };
  for (const wd of path(base, 'WeekDays', 'WeekDay')) {
    const t = Number(val(wd, 'DayType'));
    if (t >= 1 && t <= 7) { if (val(wd, 'DayWorking') === '1') cal.workdays.push(DAY[t]); } else if (t === 0 && val(wd, 'DayWorking') === '0') {
      // 옛 형식의 쉬는 날
      const tp = kid(wd, 'TimePeriod');
      const from = val(tp, 'FromDate').slice(0, 10);
      const to = val(tp, 'ToDate').slice(0, 10);
      if (from) cal.holidays.push(...range(from, to || from));
    }
  }
  for (const ex of path(base, 'Exceptions', 'Exception')) {
    if (val(ex, 'DayWorking') === '1') continue;
    const tp = kid(ex, 'TimePeriod');
    const from = val(tp, 'FromDate').slice(0, 10);
    const to = val(tp, 'ToDate').slice(0, 10);
    if (from) cal.holidays.push(...range(from, to || from));
  }
  cal.workdays.sort((a, b) => a - b);
  cal.holidays = [...new Set(cal.holidays)].sort();
  return cal;
}

/**
 * @param {string} text XML 글자
 * @returns {{ format: 'mspdi', activities: any[], calendar: any, warnings: string[], name: string }}
 */
export function readMspdi(text) {
  const proj = parseXml(text);
  if (proj.name !== 'Project') throw new Error('MS Project XML 파일이 아닙니다. MS Project에서 "다른 이름으로 저장 → XML 형식"으로 저장해주세요.');
  const tasks = path(proj, 'Tasks', 'Task');
  const byUid = new Map(tasks.map((t) => [val(t, 'UID'), t]));
  const acts = [];
  const stack = [];
  for (const t of tasks) {
    const uid = val(t, 'UID');
    if (uid === '0' || val(t, 'IsNull') === '1') continue; // 0번은 프로젝트 요약
    const level = Number(val(t, 'OutlineLevel')) || 1;
    const name = val(t, 'Name');
    if (!name) continue;
    stack.length = level - 1;
    const base = kids(t, 'Baseline').find((b) => val(b, 'Number') === '0');
    const preds = kids(t, 'PredecessorLink').map((p) => {
      const pt = byUid.get(val(p, 'PredecessorUID'));
      const lag = Number(val(p, 'LinkLag')) || 0; // 1/10분 단위 → 8시간 근무일
      return pt ? { id: val(pt, 'ID') || val(pt, 'UID'), type: REL[val(p, 'Type')] || 'FS', lag: Math.round((lag / 4800) * 10) / 10 } : null;
    }).filter(Boolean);
    acts.push(activity({
      actId: val(t, 'ID') || uid,
      name,
      wbs: stack.filter(Boolean),
      start: val(t, 'Start'), finish: val(t, 'Finish'),
      actualStart: val(t, 'ActualStart'), actualFinish: val(t, 'ActualFinish'),
      baseStart: base ? val(base, 'Start') : null, baseFinish: base ? val(base, 'Finish') : null,
      percent: val(t, 'PercentComplete') || null,
      summary: val(t, 'Summary') === '1',
      outline: level,
      preds,
      source: { uid, wbsCode: val(t, 'WBS') || val(t, 'OutlineNumber') },
    }));
    stack[level - 1] = name;
  }
  return { format: 'mspdi', name: val(proj, 'Title') || val(proj, 'Name'), activities: acts, calendar: calendarOf(proj), warnings: [] };
}
