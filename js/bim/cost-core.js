// 내역서 읽기(24 지시서 1절). 순수 함수 — 칸 표(글자)를 받는다(브라우저는 SheetJS, 시험은 자체 xlsx 읽기).
// 머리글 두 줄 합치기(병합으로 빈 칸 채우기) → 열 찾기 → 사람이 확인(양식으로 저장해 다음에 재사용) → 공종 제목·항목·소계 구분 → 합계 대조.
// 단가·금액은 회사 기밀이다. 이 모듈의 결과를 AI로 보내지 않는다(cost-link.js의 AI 요청은 품명·규격·단위만).

export const COST_FIELDS = {
  code: [/^코드|^호표|^번호|^NO\.?$/i],
  name: [/품\s*명|공\s*종|명\s*칭|항\s*목|내\s*용/],
  spec: [/규\s*격/],
  unit: [/^단\s*위/],
  qty: [/^수\s*량/],
  materialUnit: [/재료비.*단가/], materialAmt: [/재료비.*금액/],
  laborUnit: [/노무비.*단가/], laborAmt: [/노무비.*금액/],
  expenseUnit: [/경비.*단가/], expenseAmt: [/경비.*금액/],
  totalUnit: [/합계.*단가|^단\s*가$/], amount: [/합계.*금액|^금\s*액$/],
  note: [/비\s*고/],
};
export const COST_LABEL = { code: '코드', name: '품명', spec: '규격', unit: '단위', qty: '수량', materialUnit: '재료비 단가', materialAmt: '재료비 금액', laborUnit: '노무비 단가', laborAmt: '노무비 금액', expenseUnit: '경비 단가', expenseAmt: '경비 금액', totalUnit: '합계 단가', amount: '합계 금액', note: '비고' };

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * 읽은 엑셀 시트(js/ops/schedule/xlsx.js 또는 SheetJS) → 글자·숫자 칸 표. 병합된 칸은 왼쪽 위 값으로 채운다(머리글 두 줄)
 * @param {{ grid: any[][], merges?: { r0: number, c0: number, r1: number, c1: number }[] }} sheet
 */
export function plainGrid(sheet) {
  const g = (sheet.grid || []).map((row) => (row || []).map((c) => (c == null ? '' : typeof c === 'object' ? (c.v ?? '') : c)));
  for (const m of sheet.merges || []) {
    if (m.r0 > 30) continue; // 머리글 근처만
    const v = g[m.r0]?.[m.c0] ?? '';
    for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) { g[r] ||= []; if (g[r][c] === '' || g[r][c] == null) g[r][c] = v; }
  }
  return g;
}
export const num = (v) => { const s = clean(v).replace(/[,₩원\s]/g, ''); if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null; return Number(s); };
const SUBTOTAL = /^(소\s*계|계|합\s*계|총\s*계|누\s*계)$|소\s*계$|합\s*계$|총\s*계$/;

/** 머리글 줄(1줄 또는 2줄)의 칸 이름: 2줄이면 위 줄의 빈 칸을 왼쪽 값으로 채워(병합) "재료비 단가"처럼 합친다 */
export function headerLabels(grid, row, two) {
  const top = (grid[row] || []).map(clean);
  if (!two) return top;
  const bottom = (grid[row + 1] || []).map(clean);
  const width = Math.max(top.length, bottom.length);
  const filled = [];
  let last = '';
  for (let c = 0; c < width; c++) {
    if (top[c]) last = top[c];
    // 아래 줄이 단가·금액이면 위 줄의 병합된 이름을 이어받는다
    filled.push(top[c] || (/^(단가|금액)$/.test(bottom[c] || '') ? last : ''));
  }
  return filled.map((t, c) => clean(`${t} ${bottom[c] && bottom[c] !== t ? bottom[c] : ''}`));
}

function matchColumns(labels) {
  const map = {};
  labels.forEach((l, c) => {
    if (!l) return;
    for (const [k, res] of Object.entries(COST_FIELDS)) if (!(k in map) && res.some((re) => re.test(l))) { map[k] = c; break; }
  });
  return map;
}

/** 머리글 찾기: 앞 20줄에서 1줄·2줄 머리글을 맞춰 보고 가장 많이 맞는 것 */
export function findCostHeader(grid) {
  let best = null;
  for (let r = 0; r < Math.min(20, grid.length); r++) {
    // 두 줄 머리글은 아래 줄이 "단가·금액" 같은 머리글일 때만(첫 자료 줄을 머리글로 먹지 않게)
    const twoOk = (grid[r + 1] || []).some((c) => /^(단\s*가|금\s*액)$/.test(clean(typeof c === 'object' && c ? c.v : c)));
    for (const two of twoOk ? [false, true] : [false]) {
      const columns = matchColumns(headerLabels(grid, r, two));
      const score = Object.keys(columns).length + (two ? 0.5 : 0);
      if ('name' in columns && 'unit' in columns && ('totalUnit' in columns || 'amount' in columns || 'materialUnit' in columns) && (!best || score > best.score)) best = { row: r, lines: two ? 2 : 1, columns, score };
    }
  }
  return best;
}

/** 시트 고르기: 이름이 내역서이거나 머리글이 맞는 시트(원가계산서·집계표·일위대가는 뒤로) */
export function pickCostSheet(sheets) {
  const scored = sheets.map((s, i) => {
    const h = findCostHeader(s.grid);
    const named = /내역/.test(s.name) ? 3 : /집계|원가|일위|단가산출/.test(s.name) ? -2 : 0;
    return { i, h, score: h ? h.score + named : -1 };
  }).filter((x) => x.h).sort((a, b) => b.score - a.score);
  return scored[0] ? { index: scored[0].i, ...scored[0].h } : null;
}

/**
 * 표 → 항목. format = { row, lines, columns }(사람이 확인한 것, 다음 내역서에 재사용)
 * @returns {{ items: any[], headings: string[], checks: { label: string, file: number, computed: number, ok: boolean }[], total: number, fileTotal: number|null }}
 */
export function readCost(grid, format) {
  const { row, lines, columns: C } = format;
  const items = [];
  const checks = [];
  const path = [];
  let section = 0; // 지금 공종의 합(소계 대조)
  let total = 0;
  let fileTotal = null;
  const cell = (r, k) => (k in C ? r[C[k]] : '');
  for (let i = row + lines; i < grid.length; i++) {
    const r = grid[i] || [];
    const name = clean(cell(r, 'name'));
    if (!name) continue;
    const unit = clean(cell(r, 'unit'));
    const qty = num(cell(r, 'qty'));
    const mU = num(cell(r, 'materialUnit'));
    const lU = num(cell(r, 'laborUnit'));
    const eU = num(cell(r, 'expenseUnit'));
    let tU = num(cell(r, 'totalUnit'));
    let amount = num(cell(r, 'amount'));
    if (tU == null && [mU, lU, eU].some((x) => x != null)) tU = (mU || 0) + (lU || 0) + (eU || 0);
    if (amount == null && tU != null && qty != null) amount = Math.round(tU * qty);
    const bare = name.replace(/^[\d.]+\s*/, '').replace(/[\[\]()]/g, '');
    if (SUBTOTAL.test(bare)) {
      // 소계는 공종 합과, 총계는 전체 합과 대조. "합계·계"는 값이 전체 합과 같으면 총계, 아니면 공종 소계로 본다
      const isTotal = /총\s*계|공사비/.test(bare) || (!/소\s*계/.test(bare) && (!path.length || (amount != null && Math.abs(amount - total) <= 1 && Math.abs(amount - section) > 1)));
      if (isTotal) fileTotal = amount;
      else checks.push({ label: `${path.at(-1) || ''} ${bare}`.trim(), file: amount ?? 0, computed: section, ok: amount == null || Math.abs(amount - section) <= 1 });
      section = 0;
      continue;
    }
    // 제목 줄: 단위·수량·단가가 모두 비어 있음
    if (!unit && qty == null && tU == null && amount == null) {
      const level = /^\d+\.\d+/.test(name) ? 2 : 1;
      path.length = level - 1;
      path[level - 1] = name.replace(/^[\d.]+\s*/, '').slice(0, 60);
      section = 0;
      continue;
    }
    const it = { path: path.filter(Boolean), name: name.slice(0, 200), spec: clean(cell(r, 'spec')).slice(0, 200), unit: unit.slice(0, 20), qty, materialUnit: mU, laborUnit: lU, expenseUnit: eU, totalUnit: tU, amount, code: clean(cell(r, 'code')).slice(0, 40), note: clean(cell(r, 'note')).slice(0, 300), row: i + 1 };
    items.push(it);
    section += amount || 0;
    total += amount || 0;
  }
  if (fileTotal != null) checks.push({ label: '총계', file: fileTotal, computed: total, ok: Math.abs(fileTotal - total) <= 1 });
  return { items, headings: [...new Set(items.map((x) => x.path[0]).filter(Boolean))], checks, total, fileTotal };
}

/** 엑셀 묶음 하나 읽기: 시트 고르기 → 머리글 → 항목. 저장한 양식(format)이 있으면 그대로 */
export function readCostBook(sheets, saved = null) {
  const list = sheets.map((s) => ({ name: s.name, grid: s.merges || s.grid?.some((r) => r?.some((c) => c && typeof c === 'object')) ? plainGrid(s) : s.grid }));
  let pick = null;
  if (saved?.columns) {
    // 저장한 양식: 같은 이름의 시트가 없으면 머리글 글자가 같은 시트를 찾는다
    const i = list.findIndex((s) => s.name === saved.sheet && sameHeader(s.grid, saved));
    const j = i >= 0 ? i : list.findIndex((s) => sameHeader(s.grid, saved));
    if (j >= 0) pick = { index: j, row: saved.row, lines: saved.lines, columns: saved.columns, reused: true };
  }
  pick ||= pickCostSheet(list);
  if (!pick || pick.index < 0) return null;
  const sheet = list[pick.index];
  const format = { sheet: sheet.name, row: pick.row, lines: pick.lines, columns: pick.columns, labels: headerLabels(sheet.grid, pick.row, pick.lines === 2).slice(0, 40) };
  return { format, reused: Boolean(pick.reused), sheets: list.map((s) => s.name), ...readCost(sheet.grid, format) };
}

/** 저장한 양식의 머리글과 같은가(열 대응을 다시 확인하지 않고 바로 읽어도 되는가) */
export function sameHeader(grid, saved) {
  if (!saved?.labels?.length) return false;
  const now = headerLabels(grid, saved.row, saved.lines === 2);
  return Object.values(saved.columns).every((c) => (now[c] || '') === (saved.labels[c] || ''));
}

/** 공종(첫 단계 제목)별 합계 */
export function tradeTotals(items) {
  const m = new Map();
  for (const it of items) m.set(it.path?.[0] || '(공종 없음)', (m.get(it.path?.[0] || '(공종 없음)') || 0) + (it.amount || 0));
  return [...m.entries()].map(([trade, amount]) => ({ trade, amount }));
}

/** 사전 열쇠(금액 없음): 품명·규격·단위 */
export const itemKey = (it) => `${clean(it.name).replace(/\s/g, '')}|${clean(it.spec).replace(/\s/g, '')}|${clean(it.unit)}`.slice(0, 200);
