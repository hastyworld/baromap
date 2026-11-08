// 바로맵 표준 공정표(엑셀) 읽기(28 지시서 2절). 시트: 공정(필수), 달력, 층설정. 가장 정확한 기준.
// 날짜 칸은 실제 엑셀 날짜여야 한다. 글자 날짜는 바꿔 보고, 못 바꾸면 그 행을 오류로 둔다.
import { activity, isoDate, normFloor, ZONE_KO } from './core.js';
import { cellText, serialToIso } from './xlsx.js';

// 머리글 → 필드. 앞에 있을수록 우선
export const STANDARD_COLUMNS = [
  ['actId', ['작업ID', '작업 ID', '작업아이디']],
  ['name', ['작업명', '작업 이름', '이름']],
  ['zone', ['구역']],
  ['building', ['동']],
  ['fromFloor', ['시작층']],
  ['toFloor', ['끝층', '종료층']],
  ['line', ['라인']],
  ['trade', ['공종']],
  ['start', ['시작일']],
  ['finish', ['종료일']],
  ['predIds', ['선행작업ID', '선행작업 ID', '선행작업']],
  ['predType', ['관계']],
  ['predLag', ['지연일']],
  ['floorDays', ['층당일수', '층당 일수']],
  ['spread', ['배분 방식', '배분방식', '배분']],
  ['qty', ['수량']],
  ['unit', ['단위']],
  ['baseStart', ['기준시작', '기준 시작']],
  ['baseFinish', ['기준종료', '기준 종료']],
  ['actualStart', ['실적시작', '실적 시작']],
  ['actualFinish', ['실적종료', '실적 종료']],
  ['percent', ['진행률']],
  ['outdoor', ['바깥공종', '바깥 공종']],
  ['note', ['비고']],
];
export const STANDARD_REQUIRED = ['actId', 'zone', 'building', 'fromFloor', 'toFloor', 'trade', 'start', 'finish'];
const DATE_FIELDS = new Set(['start', 'finish', 'baseStart', 'baseFinish', 'actualStart', 'actualFinish']);

const squash = (s) => String(s ?? '').replace(/\s/g, '');

/** 머리글 줄에서 필드 → 열 번호 */
export function headerMap(row, columns = STANDARD_COLUMNS) {
  const map = {};
  (row || []).forEach((c, i) => {
    const t = squash(cellText(c));
    if (!t) return;
    for (const [field, names] of columns) if (!(field in map) && names.some((n) => squash(n) === t)) { map[field] = i; break; }
  });
  return map;
}

/** 칸 → 날짜. { iso, text: 글자 날짜였나, bad: 못 읽음 } */
export function cellDate(c) {
  if (c == null || c.v == null || c.v === '') return { iso: null };
  if (c.t === 'd') return { iso: c.v };
  if (c.t === 'n' && c.v > 20000 && c.v < 80000) return { iso: serialToIso(c.v), serial: true };
  const iso = isoDate(c.v);
  return iso ? { iso, text: true } : { iso: null, bad: String(c.v) };
}

const yes = (v) => /^(o|y|yes|예|네|true|1|바깥|외부|○|●|v)$/i.test(String(v ?? '').trim());

/** 표준 공정표인가: 작업ID·구역·공종 머리글이 있는 시트 */
export function findStandardSheet(book) {
  for (const sh of book.sheets) {
    if (sh.hidden) continue;
    for (let r = 0; r < Math.min(sh.grid.length, 20); r++) {
      const m = headerMap(sh.grid[r]);
      if ('actId' in m && 'zone' in m && 'trade' in m && 'start' in m) return { sheet: sh, header: r, map: m };
    }
  }
  return null;
}

function readCalendar(sh) {
  if (!sh) return null;
  const cal = { workdays: [], holidays: [], stops: [] };
  const DAYS = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 };
  let header = -1;
  sh.grid.forEach((row, r) => {
    const a = squash(cellText(row?.[0]));
    if (a === '근무요일') cal.workdays = [...cellText(row?.[1])].map((ch) => DAYS[ch]).filter(Boolean);
    if (header < 0 && a === '구분' && /시작/.test(cellText(row?.[1]))) header = r;
  });
  if (header >= 0) {
    for (const row of sh.grid.slice(header + 1)) {
      const kind = squash(cellText(row?.[0]));
      const from = cellDate(row?.[1]).iso;
      if (!kind || !from) continue;
      const to = cellDate(row?.[2]).iso || from;
      const trades = cellText(row?.[3]).split(/[,·/]/).map((x) => x.trim()).filter(Boolean);
      if (/휴일|공휴일|휴무/.test(kind)) {
        for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) cal.holidays.push(d);
      } else if (/중단|동절기|휴지/.test(kind)) cal.stops.push({ from, to, trades, note: cellText(row?.[4]).slice(0, 100) });
    }
  }
  cal.holidays = [...new Set(cal.holidays)].sort();
  return cal.workdays.length || cal.holidays.length || cal.stops.length ? cal : null;
}

function readFloors(sh) {
  if (!sh) return null;
  const out = [];
  let header = -1;
  sh.grid.forEach((row, r) => { if (header < 0 && squash(cellText(row?.[0])) === '구분' && /가중치/.test(row.map(cellText).join(''))) header = r; });
  if (header < 0) return null;
  const m = headerMap(sh.grid[header], [['name', ['구분']], ['from', ['시작층']], ['to', ['끝층']], ['weight', ['가중치']]]);
  for (const row of sh.grid.slice(header + 1)) {
    const name = cellText(row?.[m.name]);
    const w = Number(cellText(row?.[m.weight]));
    if (!name || !Number.isFinite(w) || w <= 0) continue;
    out.push({ name: name.slice(0, 30), from: normFloor(cellText(row?.[m.from])), to: normFloor(cellText(row?.[m.to])), weight: Math.min(10, w) });
  }
  return out.length ? out : null;
}

/**
 * @param {{ sheets: any[] }} book readXlsx 결과
 * @returns {{ format: 'standard', activities: any[], calendar: any, floors: any, warnings: string[] } | null}
 */
export function readStandard(book) {
  const found = findStandardSheet(book);
  if (!found) return null;
  const { sheet, header, map } = found;
  const warnings = [];
  const missing = STANDARD_REQUIRED.filter((f) => !(f in map));
  if (missing.length) warnings.push(`표준 양식의 필수 열이 빠졌습니다: ${missing.join(', ')}`);
  const acts = [];
  for (let r = header + 1; r < sheet.grid.length; r++) {
    const row = sheet.grid[r] || [];
    const get = (f) => (f in map ? row[map[f]] : null);
    const txt = (f) => cellText(get(f));
    if (!txt('actId') && !txt('name') && !txt('trade') && !txt('start')) continue;
    const errors = [];
    const dates = {};
    let textDate = false;
    for (const f of DATE_FIELDS) {
      const d = cellDate(get(f));
      if (d.bad) errors.push(`${f === 'start' ? '시작일' : f === 'finish' ? '종료일' : f} '${d.bad}'을(를) 날짜로 읽지 못했습니다.`);
      if (d.text) textDate = true;
      dates[f] = d.iso;
    }
    const zoneTxt = txt('zone');
    const ids = txt('predIds').split(/[,;\s]+/).filter(Boolean);
    const types = txt('predType').split(/[,;\s]+/).filter(Boolean);
    const lags = txt('predLag').split(/[,;\s]+/).filter(Boolean);
    const building = txt('building');
    const trade = txt('trade');
    const from = txt('fromFloor');
    const to = txt('toFloor');
    const name = txt('name') || [zoneTxt === '동' && building ? `${building}동` : zoneTxt, trade, from && to && from !== to ? `${from}~${to}` : from].filter(Boolean).join(' ');
    if (zoneTxt && !Object.values(ZONE_KO).includes(zoneTxt) && !['단지', '동', '지하주차장', '부대'].includes(zoneTxt)) errors.push(`구역 '${zoneTxt}'은(는) 단지·동·지하주차장·부대 중 하나여야 합니다.`);
    acts.push(activity({
      actId: txt('actId'), name, zone: zoneTxt, building, fromFloor: from, toFloor: to || from, line: txt('line'), trade,
      ...dates,
      percent: txt('percent'), floorDays: txt('floorDays'), spread: txt('spread'), qty: txt('qty'), unit: txt('unit'),
      preds: ids.map((id, i) => ({ id, type: (types[i] || types[0] || 'FS').toUpperCase(), lag: Number(lags[i] || lags[0] || 0) })),
      outdoor: yes(txt('outdoor')),
      errors,
      source: { sheet: sheet.name, row: r + 1, ...(txt('note') ? { note: txt('note').slice(0, 300) } : {}), ...(textDate ? { textDate: true } : {}) },
    }));
  }
  if (acts.some((a) => a.source.textDate)) warnings.push('글자로 적힌 날짜가 있어 날짜로 바꿨습니다. 엑셀 날짜 칸으로 넣으면 더 정확합니다.');
  const find = (re) => book.sheets.find((s) => re.test(s.name));
  return { format: 'standard', activities: acts, calendar: readCalendar(find(/달력/)), floors: readFloors(find(/층\s*설정/)), warnings };
}
