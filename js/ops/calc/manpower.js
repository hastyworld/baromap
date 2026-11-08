// 출역 계산(순수 함수): 월 집계, 전자카드 엑셀 합산. 사람 구분 값은 세는 데만 쓰고 결과에 넣지 않는다(09 6절).
import { excelDate } from '../../excel.js';

const norm = (h) => String(h ?? '').replace(/[\s*·・.()[\]（）_-]/g, '').toLowerCase();

// [필드, 머리글 후보]. 양식을 받으면 여기에 추가한다
export const ECARD_COLUMNS = {
  date: ['근무일자', '출근일자', '일자', '날짜', '근로일자', '출역일', '출역일자', '근무일'],
  company: ['업체명', '소속', '회사', '회사명', '협력사', '소속업체', '업체', '소속회사', '하수급인'],
  trade: ['직종', '공종', '직종명', '공종명', '작업공종'],
  person: ['성명', '이름', '근로자명', '카드번호', '전자카드번호', '근로자', '사번'],
};

// 머리글 줄 → { date: 열 번호, company, trade, person } (못 찾은 칸은 -1). 정확히 같은 이름을 먼저 찾고, 없으면 일부가 같은 이름("소속 업체명")
export function findColumns(headers) {
  const cols = { date: -1, company: -1, trade: -1, person: -1 };
  const names = (headers || []).map(norm);
  const used = new Set();
  const take = (key, i) => { cols[key] = i; used.add(i); };
  for (const [key, list] of Object.entries(ECARD_COLUMNS)) {
    const i = list.map((c) => names.indexOf(norm(c))).find((x) => x >= 0);
    if (i != null) take(key, i);
  }
  for (const [key, list] of Object.entries(ECARD_COLUMNS)) {
    if (cols[key] >= 0) continue;
    const i = names.findIndex((n, j) => n && !used.has(j) && list.some((c) => n.includes(norm(c))));
    if (i >= 0) take(key, i);
  }
  return cols;
}

// 표(aoa)의 머리글 줄 찾기: 앞 10줄 중 열을 가장 많이 찾은 줄
export function findHeaderRow(aoa) {
  let best = 0;
  let score = -1;
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const s = Object.values(findColumns(aoa[i])).filter((v) => v >= 0).length;
    if (s > score) { best = i; score = s; }
  }
  return best;
}

// 문자열 해시(메모리 안에서 같은 사람을 가려낼 때만 쓰고 저장하지 않는다)
function hash(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  return ((h2 >>> 0) * 4294967296 + (h1 >>> 0)).toString(36);
}

function toDate(v) {
  const s = String(excelDate(v)).trim();
  const m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const c = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  return c ? `${c[1]}-${c[2]}-${c[3]}` : '';
}

/**
 * 전자카드 표를 날짜 × 협력사 × 직종 인원으로 바꾼다. 같은 날 같은 사람이 두 줄이면 한 명.
 * @param {any[][]} rows 머리글 뒤의 자료 줄
 * @param {{date:number,company:number,trade:number,person:number}} cols
 * @returns {{ days: Record<string, {company:string,trade:string,count:number}[]>, rows: number, skipped: number }}
 */
export function summarizeEcard(rows, cols) {
  const seen = new Set();
  const count = new Map();
  let used = 0;
  let skipped = 0;
  for (const r of rows || []) {
    if (!r || !r.some((v) => v != null && v !== '')) continue;
    const date = toDate(r[cols.date]);
    if (!date) { skipped++; continue; }
    const company = String(r[cols.company] ?? '').trim() || '(업체 미상)';
    const trade = cols.trade >= 0 ? String(r[cols.trade] ?? '').trim() : '';
    const who = cols.person >= 0 ? String(r[cols.person] ?? '').trim() : '';
    used++;
    if (who) {
      const key = `${date}|${hash(who)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const k = `${date}\u0000${company}\u0000${trade}`;
    count.set(k, (count.get(k) || 0) + 1);
  }
  const days = {};
  for (const [k, n] of count) {
    const [date, company, trade] = k.split('\u0000');
    (days[date] ||= []).push({ company, trade, count: n });
  }
  for (const list of Object.values(days)) list.sort((a, b) => a.company.localeCompare(b.company, 'ko') || a.trade.localeCompare(b.trade, 'ko'));
  return { days, rows: used, skipped };
}

// 협력사 이름 잇기: 공백·(주)·주식회사 무시
export const companyKey = (s) => String(s ?? '').replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, '').replace(/[\s()·.,-]/g, '').toLowerCase();
export function matchCompany(name, companies) {
  const k = companyKey(name);
  return (companies || []).find((c) => companyKey(c.name) === k) || null;
}

// 합계 줄 → 일보 출역 줄. 이어진 협력사는 그 이름과 id로
export function toManpower(lines, companies) {
  return (lines || []).map((l) => {
    const c = matchCompany(l.company, companies);
    return { companyId: c?.id || '', company: c?.name || l.company, trade: l.trade, kind: 'partner', count: Math.min(999, l.count), note: '' };
  });
}

// 있는 출역에 더하기·덮어쓰기
export function mergeManpower(prev, incoming, mode) {
  if (mode !== 'add') return incoming.map((x) => ({ ...x }));
  const out = (prev || []).map((x) => ({ ...x }));
  for (const m of incoming) {
    const hit = out.find((x) => companyKey(x.company) === companyKey(m.company) && x.trade === m.trade && x.kind === m.kind);
    if (hit) hit.count = Math.min(999, (Number(hit.count) || 0) + m.count);
    else out.push({ ...m });
  }
  return out;
}

const daysIn = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();

// 월 출역 표: 협력사·공종 줄 × 날짜 칸, 공종별 인·일 합계. ym = '2026-11'
export function monthTable(reports, ym) {
  const days = daysIn(ym);
  const lines = new Map();
  const dayTotal = Array(days).fill(0);
  const tradeTotal = new Map();
  for (const r of reports || []) {
    if (!r.date?.startsWith(ym) || r.status === 'cancelled') continue;
    const d = Number(r.date.slice(8, 10)) - 1;
    for (const m of r.manpower || []) {
      const n = Number(m.count) || 0;
      const key = `${m.company}\u0000${m.trade}`;
      if (!lines.has(key)) lines.set(key, { company: m.company, trade: m.trade, days: Array(days).fill(0), total: 0 });
      const line = lines.get(key);
      line.days[d] += n;
      line.total += n;
      dayTotal[d] += n;
      const t = m.trade || '(공종 미지정)';
      tradeTotal.set(t, (tradeTotal.get(t) || 0) + n);
    }
  }
  const rows = [...lines.values()].sort((a, b) => a.company.localeCompare(b.company, 'ko') || String(a.trade).localeCompare(String(b.trade), 'ko'));
  return { ym, days, rows, dayTotal, total: dayTotal.reduce((a, b) => a + b, 0), trades: [...tradeTotal.entries()].map(([trade, personDays]) => ({ trade, personDays })).sort((a, b) => b.personDays - a.personDays) };
}

// 엑셀로 받을 표
export function monthSheet(t) {
  const head = ['협력사', '공종', ...Array.from({ length: t.days }, (_, i) => `${i + 1}일`), '합계'];
  const rows = t.rows.map((r) => [r.company, r.trade, ...r.days.map((v) => v || ''), r.total]);
  return [head, ...rows, ['합계', '', ...t.dayTotal.map((v) => v || ''), t.total]];
}
