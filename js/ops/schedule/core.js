// 공정표 읽기 공통(28 지시서 3절): 어떤 형식이든 같은 활동 모양으로 바꾼다. 순수 함수(브라우저·Node 공용).
//   activity(o) → 활동 하나   finalize(list) → 요약 행 표시·작업ID 중복 정리·오류   scheduleStats(list) → 행 수·연결 안 됨·기간
// 층 표기는 표준형 하나로: 지하 'B2', 지상 '1'~'99', 옥탑·지붕 'PH'.

export const ZONES = ['site', 'building', 'underground', 'facility', 'unknown'];
export const ZONE_KO = { site: '단지', building: '동', underground: '지하주차장', facility: '부대', unknown: '모름' };
const ZONE_FROM_KO = { 단지: 'site', 대지: 'site', 동: 'building', 지하주차장: 'underground', 주차장: 'underground', 지하: 'underground', 부대: 'facility', 부대시설: 'facility' };
export const SPREADS = ['cycle', 'even', 'qty'];
export const SPREAD_KO = { cycle: '사이클', even: '균등', qty: '수량' };
const SPREAD_FROM_KO = { 사이클: 'cycle', 층사이클: 'cycle', 균등: 'even', 수량: 'qty' };
export const FORMATS = ['standard', 'mspdi', 'xer', 'table', 'barchart', 'pdf'];
export const FORMAT_KO = { standard: '표준 공정표', mspdi: 'MS Project XML', xer: 'Primavera XER', table: '표 엑셀', barchart: '바차트 엑셀', pdf: 'PDF' };
export const REL_TYPES = ['FS', 'SS', 'FF', 'SF'];

export const zoneOf = (v) => {
  const s = String(v ?? '').trim();
  if (ZONES.includes(s)) return s;
  return ZONE_FROM_KO[s.replace(/\s/g, '')] || '';
};
export const spreadOf = (v) => {
  const s = String(v ?? '').trim();
  return SPREADS.includes(s) ? s : SPREAD_FROM_KO[s.replace(/\s/g, '')] || 'cycle';
};

/** '101동', '제101동', '101 동', '101D' → '101'. 숫자 동이 아니면('주민공동시설') 글자 그대로 */
export function normBuilding(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = /^(?:제\s*)?(\d{1,4})\s*(?:동|D|BL)?$/i.exec(s);
  return m ? m[1] : s.slice(0, 30);
}

/** 층 표기 → 표준형. 'B2F', '지하2층', 'B2' → 'B2' / '15층', '15F', '지상15층' → '15' / '옥탑', 'PH', 'RF', '지붕' → 'PH'. 못 읽으면 '' */
export function normFloor(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v < 0 ? `B${-v}` : v === 0 ? '' : String(v);
  const s = String(v ?? '').trim().toUpperCase().replace(/\s/g, '');
  if (!s) return '';
  if (/^(PH|RF|R|옥탑|옥탑층|지붕|지붕층|옥상|PH\d+F?|PH층)$/.test(s)) return 'PH';
  let m = /^(?:B|지하|-)(\d{1,2})(?:F|층)?$/.exec(s);
  if (m) return Number(m[1]) ? `B${Number(m[1])}` : '';
  m = /^(?:지상)?(\d{1,2})(?:F|층)?$/.exec(s);
  if (m) return Number(m[1]) ? String(Number(m[1])) : '';
  return '';
}

/** 층 순서 값: B2 → -2, 1 → 1, 15 → 15, PH → 1000 */
export const floorRank = (f) => (f === 'PH' ? 1000 : f?.[0] === 'B' ? -Number(f.slice(1)) : Number(f) || 0);

const FLOOR_TOKEN = '(?:지하\\s*\\d{1,2}\\s*층?|B\\d{1,2}F?|지상\\s*\\d{1,2}\\s*층?|\\d{1,2}\\s*(?:F|층)|PH|RF|옥탑층?|지붕층?|\\d{1,2})';
const RANGE_RE = new RegExp(`(${FLOOR_TOKEN})\\s*(?:~|-|∼|〜|부터|에서)\\s*(${FLOOR_TOKEN})`, 'i');
const SINGLE_RE = new RegExp(`(?:^|[^\\d가-힣A-Z])(지하\\s*\\d{1,2}\\s*층|B\\d{1,2}F?|지상\\s*\\d{1,2}\\s*층|\\d{1,2}\\s*(?:F|층)|PH|RF|옥탑층?)(?![\\dA-Z])`, 'i');

/** 이름에서 층 범위 찾기: 'B2~15F', '지하2층~지상15층', '2~15층', '1F', 'PH'. 동 번호(101동)는 층으로 보지 않는다 */
export function parseFloorRange(text) {
  const s = String(text ?? '').replace(/\d{3,4}\s*동/g, ' ');
  let m = RANGE_RE.exec(s);
  if (m) {
    // 뒤쪽만 단위가 있으면(2~15F) 앞쪽도 같은 단위로 본다
    let a = normFloor(m[1]);
    const b = normFloor(m[2]);
    if (!a && /^\d{1,2}$/.test(m[1].trim())) a = String(Number(m[1]));
    if (a && b && floorRank(a) <= floorRank(b)) return { from: a, to: b };
  }
  m = SINGLE_RE.exec(s);
  if (m) { const f = normFloor(m[1]); if (f) return { from: f, to: f }; }
  return null;
}

/** 이름에서 동 찾기: '101동', '101~103동', '101,102동', '101·102동' → ['101', …] */
export function parseBuildings(text) {
  const s = String(text ?? '');
  let m = /(\d{3,4})\s*(?:동)?\s*[~∼〜-]\s*(\d{3,4})\s*동/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b >= a && b - a < 40) return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  }
  m = /((?:\d{3,4}\s*(?:동)?\s*[,·、/]\s*)+\d{3,4})\s*동/.exec(s);
  if (m) return [...new Set(m[1].split(/[,·、/]/).map((x) => x.replace(/\D/g, '')).filter(Boolean))];
  const all = [...s.matchAll(/(?:제\s*)?(\d{3,4})\s*동/g)].map((x) => x[1]);
  return [...new Set(all)];
}

// ---------------------------------------------------------------- 날짜

const pad = (n) => String(n).padStart(2, '0');
const okIso = (y, mo, d) => {
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const iso = `${y}-${pad(mo)}-${pad(d)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return t.getUTCDate() === d ? iso : null;
};

/** 날짜 값 → 'YYYY-MM-DD' 또는 null. Date, ISO(시각 포함), '2027.01.04', '27.01.04', '2027/1/4', '2027년 1월 4일', '27-01-04' */
export function isoDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s);
  if (m) return okIso(+m[1], +m[2], +m[3]);
  m = /^(\d{4}|\d{2})\s*[./년-]\s*(\d{1,2})\s*[./월-]\s*(\d{1,2})\s*일?\.?(?:\s*\([^)]*\))?(?:\s+\d{1,2}:\d{2}.*)?$/.exec(s);
  if (m) return okIso(m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]), +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/.exec(s); // 미국식 월/일/연(MS Project 영문판 표)
  if (m) return okIso(+m[3], +m[1], +m[2]);
  return null;
}

export const DAY_MS = 864e5;
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** 요일: 1=월 … 7=일 */
export const weekday = (iso) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };

// ---------------------------------------------------------------- 활동 모양

const s = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const n = (v) => { if (v == null || v === '') return null; const x = Number(String(v).replace(/[,%\s]/g, '')); return Number.isFinite(x) ? x : null; };

/** 활동 하나(빈 값은 기본값). 날짜 칸에 글자가 들어오면 isoDate로 바꿔 본다 */
export function activity(o = {}) {
  return {
    actId: s(o.actId, 60),
    name: s(o.name, 200),
    wbs: (Array.isArray(o.wbs) ? o.wbs : []).map((x) => s(x, 100)).filter(Boolean).slice(0, 12),
    zone: zoneOf(o.zone) || (o.zone === '' || o.zone == null ? '' : 'unknown'),
    building: normBuilding(o.building),
    fromFloor: normFloor(o.fromFloor),
    toFloor: normFloor(o.toFloor ?? o.fromFloor),
    line: s(o.line, 10),
    trade: s(o.trade, 30),
    start: isoDate(o.start),
    finish: isoDate(o.finish),
    baseStart: isoDate(o.baseStart),
    baseFinish: isoDate(o.baseFinish),
    actualStart: isoDate(o.actualStart),
    actualFinish: isoDate(o.actualFinish),
    percent: n(o.percent),
    floorDays: n(o.floorDays),
    spread: spreadOf(o.spread),
    qty: n(o.qty),
    unit: s(o.unit, 20),
    summary: o.summary === true,
    preds: Array.isArray(o.preds) ? o.preds.filter((p) => p?.id).map((p) => ({ id: s(p.id, 60), type: REL_TYPES.includes(p.type) ? p.type : 'FS', lag: n(p.lag) || 0 })).slice(0, 30) : [],
    outdoor: o.outdoor === true,
    linked: o.linked === true,
    source: o.source && typeof o.source === 'object' ? o.source : {},
    outline: Number.isInteger(o.outline) ? o.outline : null, // 개요 수준(요약 행 판단용, 저장하지 않는다)
    errors: Array.isArray(o.errors) ? o.errors : [],
  };
}

/**
 * 읽은 활동 정리: 개요 수준이나 WBS로 하위 행이 있는 요약 행 표시, 작업ID 비면 채우고 겹치면 뒤에 번호, 날짜 오류 표시.
 * @param {any[]} list activity() 결과들
 */
export function finalize(list) {
  const out = list.map((a) => ({ ...a, errors: [...(a.errors || [])] }));
  // 개요 수준: 다음 행이 더 깊으면 요약 행
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    if (a.outline != null && out[i + 1]?.outline != null && out[i + 1].outline > a.outline) a.summary = true;
  }
  // WBS: 다른 행의 WBS가 이 행의 [WBS…, 이름]으로 시작하면 요약 행
  const paths = new Set(out.filter((a) => a.wbs.length).map((a) => a.wbs.join('\u0001')));
  for (const a of out) if (!a.summary && paths.has([...a.wbs, a.name].join('\u0001'))) a.summary = true;
  const seen = new Map();
  out.forEach((a, i) => {
    if (!a.actId) a.actId = `R${String(i + 1).padStart(4, '0')}`;
    const k = a.actId;
    if (seen.has(k)) { const c = seen.get(k) + 1; seen.set(k, c); a.actId = `${k}-${c}`.slice(0, 60); a.errors.push('작업ID가 겹쳐 뒤에 번호를 붙였습니다.'); } else seen.set(k, 1);
    if (!a.name) a.errors.push('작업 이름이 없습니다.');
    if (!a.summary) {
      if (!a.start || !a.finish) { if (!a.errors.some((e) => /날짜/.test(e))) a.errors.push('시작일·종료일을 날짜로 읽지 못했습니다.'); } else if (a.finish < a.start) a.errors.push('종료일이 시작일보다 앞입니다.');
    }
    if (a.fromFloor && a.toFloor && floorRank(a.toFloor) < floorRank(a.fromFloor)) a.errors.push('끝층이 시작층보다 아래입니다.');
    delete a.outline;
  });
  return out;
}

/** 계산에 쓰는 행: 요약 행·오류 행·연결 안 된 행 제외 */
export const usable = (a) => !a.summary && !a.errors?.length && a.start && a.finish;

export function scheduleStats(list) {
  const work = list.filter((a) => !a.summary);
  const dated = work.filter((a) => a.start && a.finish);
  return {
    rows: list.length,
    summary: list.length - work.length,
    errors: work.filter((a) => a.errors?.length).length,
    linked: work.filter((a) => a.linked).length,
    unlinked: work.filter((a) => !a.linked).length,
    start: dated.reduce((m, a) => (!m || a.start < m ? a.start : m), null),
    finish: dated.reduce((m, a) => (!m || a.finish > m ? a.finish : m), null),
  };
}

// ---------------------------------------------------------------- 달력·층설정

/**
 * 근무 달력: 파일 값이 있으면 그것, 없으면 운영 설정.
 * @returns {{ workdays: number[], holidays: string[], stops: { from: string, to: string, trades: string[], note: string }[] }}
 */
export function workCalendar(fileCal, settings) {
  const c = fileCal || {};
  return {
    workdays: c.workdays?.length ? c.workdays : settings?.workdays?.length ? settings.workdays : [1, 2, 3, 4, 5, 6],
    holidays: [...new Set([...(c.holidays || []), ...(c.holidays?.length ? [] : settings?.holidays || [])])].sort(),
    stops: c.stops || [],
  };
}

/** 그날이 작업일인가(공종 이름이 주어지면 그 공종의 중단 기간도 본다) */
export function isWorkday(cal, iso, trade) {
  if (!cal.workdays.includes(weekday(iso))) return false;
  if (cal.holidays.includes(iso)) return false;
  for (const st of cal.stops || []) if (iso >= st.from && iso <= st.to && (!st.trades?.length || (trade && st.trades.includes(trade)))) return false;
  return true;
}

// 층 유형 기본 가중치(29 지시서 1절의 "사이클" 배분, 설계 판단 — 현장에서 고친다)
export const DEFAULT_FLOORS = [
  { name: '지하층', from: 'B9', to: 'B1', weight: 2.0 },
  { name: '1층', from: '1', to: '1', weight: 1.5 },
  { name: '기준층', from: '2', to: '98', weight: 1.0 },
  { name: '옥탑', from: 'PH', to: 'PH', weight: 0.8 },
  { name: '최상층', from: '', to: '', weight: 1.3 }, // 그 동 맨 위 지상층(층 번호가 동마다 달라서 이름으로 찾는다)
];
/** 층설정 표 → 층 하나의 가중치. "최상층" 행은 그 동 맨 위 지상층(topFloor)에 쓴다 */
export function floorWeight(floors, f, topFloor) {
  const list = floors?.length ? floors : DEFAULT_FLOORS;
  const top = list.find((x) => x.name === '최상층');
  if (top && f === topFloor) return Number(top.weight) || 1;
  const r = floorRank(f);
  const hit = list.find((x) => x.name !== '최상층' && x.from && x.to && r >= floorRank(x.from) && r <= floorRank(x.to));
  return hit ? Number(hit.weight) || 1 : 1;
}
