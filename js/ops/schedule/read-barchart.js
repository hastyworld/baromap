// 바차트 엑셀(칠한 칸) 읽기(28 지시서 1절 5, 조사 노트 04 2-2절). 결과는 초안이다 — 사람이 확인한 뒤 판으로 저장한다.
// 1) 머리글에서 시간축(연·월·상중하순 또는 날짜 칸)을 찾아 열마다 날짜 범위를 만든다  2) 행마다 칠한 칸이 이어지는 구간을 찾는다
// 3) 구간 왼쪽 끝 열의 첫날 = 시작, 오른쪽 끝 열의 끝날 = 종료. 정밀도는 칸 폭(월 칸 약 ±15일, 순 칸 약 ±5일).
import { activity, addDays, normBuilding, parseFloorRange, normFloor } from './core.js';
import { cellText } from './xlsx.js';

const MARKS = new Set(['■', '●', '━', '▬', '─', '—', '=', '▶', '◆', 'O', 'o', '○']);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');
const filled = (c) => Boolean(c && ((c.fill && !/^#FFFFFF/i.test(c.fill)) || MARKS.has(cellText(c))));

function spanOf(merges, r, c) {
  const m = merges.find((x) => x.r0 <= r && r <= x.r1 && x.c0 <= c && c <= x.c1);
  return m ? { c0: m.c0, c1: m.c1 } : { c0: c, c1: c };
}

const yearOf = (t) => { const m = /^((?:19|20)\d{2})\s*년?$/.exec(t); return m ? Number(m[1]) : null; };
function monthOf(t) {
  let m = /^((?:19|20)?\d{2})\s*[.\-/년]\s*(\d{1,2})\s*월?$/.exec(t);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { y: m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]), m: Number(m[2]) };
  m = /^(\d{1,2})\s*월$/.exec(t);
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? { y: null, m: Number(m[1]) } : null;
}
const subOf = (t) => ({ 상: 0, 상순: 0, 초: 0, 중: 1, 중순: 1, 하: 2, 하순: 2, 말: 2 })[t.replace(/\s/g, '')];

/**
 * 시간축 찾기 → { cols: Map<열, { from, to }>, rows: 머리글 줄들, first: 첫 시간 열 } 또는 null
 */
export function timeAxis(sheet) {
  const { grid, merges = [] } = sheet;
  const top = Math.min(grid.length, 15);
  let best = null;
  for (let r = 0; r < top; r++) {
    const row = grid[r] || [];
    const months = [];
    const dates = [];
    row.forEach((c, i) => {
      if (c?.t === 'd') dates.push({ c: i, d: c.v });
      const mo = c?.t === 's' ? monthOf(cellText(c)) : null;
      if (mo) months.push({ c: i, ...mo });
    });
    const score = Math.max(months.length, dates.length);
    if (score >= 3 && (!best || score > best.score)) best = { r, months, dates, score };
  }
  if (!best) return null;
  const cols = new Map();
  const r = best.r;
  if (best.dates.length >= best.months.length) {
    const ds = best.dates.sort((a, b) => a.c - b.c);
    const steps = ds.slice(1).map((x, i) => Math.round((Date.parse(x.d) - Date.parse(ds[i].d)) / 864e5)).filter((x) => x > 0).sort((a, b) => a - b);
    const step = steps[Math.floor(steps.length / 2)] || 7;
    ds.forEach((x, i) => cols.set(x.c, { from: x.d, to: addDays(ds[i + 1]?.d || addDays(x.d, step), -1) }));
    return { cols, rows: [r], first: ds[0].c, precision: step };
  }
  // 연도: 위 줄에서 이 열을 덮는(병합) 연도 칸, 없으면 왼쪽으로 가장 가까운 연도 칸, 그래도 없으면 제목의 연도
  const yearAt = (c) => {
    for (let k = r - 1; k >= 0; k--) {
      const row = grid[k] || [];
      for (let i = c; i >= 0; i--) { const y = row[i] ? yearOf(cellText(row[i])) : null; if (y) return y; }
    }
    for (let k = 0; k < r; k++) for (const cell of grid[k] || []) { const m = /((?:19|20)\d{2})/.exec(cellText(cell)); if (m) return Number(m[1]); }
    return null;
  };
  const ms = best.months.sort((a, b) => a.c - b.c);
  let prev = null;
  let precision = 31;
  const used = [r];
  for (let i = 0; i < ms.length; i++) {
    const mo = ms[i];
    let y = mo.y || yearAt(mo.c);
    if (!mo.y && prev && y === prev.y && mo.m < prev.m) y = prev.y + 1; // 연도 칸을 못 찾아 12월 → 1월로 넘어갈 때
    if (!y) return null;
    prev = { y, m: mo.m };
    const sp = spanOf(merges, r, mo.c);
    const c1 = Math.max(sp.c1, (ms[i + 1]?.c ?? sp.c1 + 1) - 1);
    const n = c1 - mo.c + 1;
    const end = lastDay(y, mo.m);
    // 아래 줄에 상·중·하순이 있으면 그 경계를 쓴다
    const sub = grid[r + 1] || [];
    const subs = Array.from({ length: n }, (_, k) => subOf(cellText(sub[mo.c + k])));
    if (subs.every((x) => x != null)) {
      if (!used.includes(r + 1)) used.push(r + 1);
      precision = 10;
      subs.forEach((x, k) => cols.set(mo.c + k, { from: `${y}-${pad(mo.m)}-${pad([1, 11, 21][x])}`, to: `${y}-${pad(mo.m)}-${pad([10, 20, end][x])}` }));
    } else {
      precision = Math.min(precision, Math.ceil(end / n));
      for (let k = 0; k < n; k++) {
        const d0 = Math.floor((end * k) / n) + 1;
        const d1 = Math.floor((end * (k + 1)) / n);
        cols.set(mo.c + k, { from: `${y}-${pad(mo.m)}-${pad(d0)}`, to: `${y}-${pad(mo.m)}-${pad(d1)}` });
      }
    }
  }
  return { cols, rows: used, first: ms[0].c, precision };
}

const LABEL_FIELDS = [['trade', /^공종/], ['building', /^동$/], ['floors', /^층/], ['name', /작업명|공정명|내용|항목/], ['group', /^구분|^대공종|^분류/]];

/**
 * @param {{ sheets: any[] }} book
 * @returns {{ format: 'barchart', draft: true, activities: any[], warnings: string[], precision: number } | null}
 */
export function readBarchart(book) {
  for (const sheet of book.sheets) {
    if (sheet.hidden) continue;
    const axis = timeAxis(sheet);
    if (!axis || axis.cols.size < 6) continue;
    const headerEnd = Math.max(...axis.rows);
    const labelCols = Array.from({ length: axis.first }, (_, i) => i);
    // 왼쪽 머리글 이름(시간축 줄과 그 위)
    const field = {};
    for (const c of labelCols) {
      for (let r = 0; r <= headerEnd; r++) {
        const t = cellText(sheet.grid[r]?.[c]).replace(/\s/g, '');
        const hit = LABEL_FIELDS.find(([, re]) => re.test(t));
        if (hit && !(hit[0] in field)) { field[hit[0]] = c; break; }
      }
    }
    const acts = [];
    const timeCols = [...axis.cols.keys()].sort((a, b) => a - b);
    let group = '';
    for (let r = headerEnd + 1; r < sheet.grid.length; r++) {
      const row = sheet.grid[r] || [];
      const labels = labelCols.map((c) => cellText(row[c]));
      const on = timeCols.filter((c) => filled(row[c]));
      if (!on.length) {
        if (labels.some(Boolean)) group = labels.filter(Boolean).join(' ').slice(0, 100);
        continue;
      }
      // 이어진 구간들
      const spans = [];
      for (const c of on) {
        const last = spans[spans.length - 1];
        if (last && timeCols.indexOf(c) === timeCols.indexOf(last.c1) + 1) last.c1 = c; else spans.push({ c0: c, c1: c });
      }
      const colors = [...new Set(on.map((c) => row[c]?.fill).filter(Boolean))];
      const g = 'group' in field ? cellText(row[field.group]) || group : group;
      if ('group' in field && cellText(row[field.group])) group = cellText(row[field.group]);
      const fl = 'floors' in field ? cellText(row[field.floors]) : '';
      const range = parseFloorRange(fl) || (normFloor(fl) ? { from: normFloor(fl), to: normFloor(fl) } : null);
      const nameParts = labels.filter((x, i) => x && labelCols[i] !== field.group);
      const bld = 'building' in field ? cellText(row[field.building]) : '';
      acts.push(activity({
        name: (nameParts.join(' ') || g || `행 ${r + 1}`).replace(/^(\d{3,4})(\s)/, '$1동$2'),
        wbs: g ? [g] : [],
        building: bld ? normBuilding(bld) : '',
        fromFloor: range?.from, toFloor: range?.to,
        trade: 'trade' in field ? cellText(row[field.trade]) : '',
        start: axis.cols.get(spans[0].c0).from,
        finish: axis.cols.get(spans[spans.length - 1].c1).to,
        source: { sheet: sheet.name, row: r + 1, precisionDays: axis.precision, ...(colors.length ? { color: colors[0] } : {}), ...(spans.length > 1 ? { gaps: spans.length - 1 } : {}), ...(colors.length > 1 ? { colors } : {}) },
      }));
    }
    if (!acts.length) continue;
    const warnings = [`칠한 칸으로 읽은 초안입니다. 날짜 정밀도는 칸 폭(약 ${axis.precision}일)입니다. 막대를 원본과 비교해 확인한 뒤 저장해주세요.`];
    if (acts.some((a) => a.source.colors)) warnings.push('한 행에 색이 두 가지 이상인 곳이 있습니다(계획·실적을 함께 그린 양식일 수 있음). 색을 확인해주세요.');
    if (acts.some((a) => a.source.gaps)) warnings.push('막대가 끊긴 행이 있습니다(동절기 중단 등). 처음과 끝을 기간으로 봤습니다.');
    return { format: 'barchart', draft: true, activities: acts, warnings, precision: axis.precision };
  }
  return null;
}
