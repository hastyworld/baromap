// 문서 읽기 공용 계산(20 지시서). 순수 함수 — 브라우저·Node 테스트·Edge Function 공용(npm run functions:sync).
// 엑셀은 병합을 풀어 표로 → 머리글 사전으로 열을 찾아 규칙으로 읽고, PDF·그림은 AI 답을 같은 모양으로 받는다.
// 표에 없는 값은 null이다. 값을 지어내지 않는다.
//   extracted = { source, windows: [...], materials: [...], finishes: [...], notes }

export const DOC_KINDS = ['window_performance', 'window_schedule', 'glass_spec', 'material_spec', 'finish_list', 'exterior_spec', 'spec', 'company_std', 'tech_review', 'other', 'unknown'];
export const DOC_KIND_LABEL = {
  window_performance: '창호 형별 성능표', window_schedule: '창호 일람표', glass_spec: '유리 사양', material_spec: '자재 성능', finish_list: '마감재 리스트',
  exterior_spec: '외부 마감 사양', spec: '시방서', company_std: '회사 시공기준', tech_review: '기술검토서', other: '그 밖', unknown: '종류 모름',
};
export const DOC_STATUS = ['uploaded', 'reading', 'read', 'applied', 'error'];
export const DOC_STATUS_LABEL = { uploaded: '올림', reading: '읽는 중', read: '읽음', applied: '모델에 반영', error: '실패' };
export const EMPTY_EXTRACT = () => ({ source: '', windows: [], materials: [], finishes: [], notes: '' });

const clean = (v) => {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  return !s || /^[-–—/.]+$/.test(s) ? '' : s;
};
const orNull = (v) => clean(v) || null;
export function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(clean(v));
  return m ? Number(m[0].replace(/,/g, '')) : null;
}

// ---------------------------------------------------------------- 유리 표기·규격

const GAS = { A: 'air', AIR: 'air', AR: 'argon', KR: 'krypton' };

/** "5CL+12A+5LE" → { notation, panes: [{ mm, kind }, { gapMm, gas }, …] }. 못 풀면 글자만 둔다 */
export function parseGlass(text) {
  const notation = clean(text);
  if (!notation) return null;
  const parts = notation.replace(/＋/g, '+').split('+').map((s) => s.trim()).filter(Boolean);
  const panes = [];
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)\s*(?:mm|㎜)?\s*([A-Za-z]*)$/i.exec(p);
    if (!m) return { notation, panes: [] };
    const kind = m[2].toUpperCase();
    panes.push(GAS[kind] ? { gapMm: Number(m[1]), gas: GAS[kind] } : { mm: Number(m[1]), kind: kind || null });
  }
  return { notation, panes };
}
export const normGlass = (s) => clean(s).toUpperCase().replace(/＋/g, '+').replace(/\s|MM|㎜/g, '');

/** "2,400 × 2,100", "W2400×H2100" → { w, h } */
export function parseSize(v) {
  const s = clean(v).replace(/,/g, '').replace(/[WwHh]\s*(?=\d)/g, '');
  const m = /(\d{3,5})(?:\.\d+)?\s*(?:mm|㎜)?\s*[×xX*＊]\s*(\d{3,5})/.exec(s);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

const listOf = (v) => {
  const s = clean(v);
  if (!s || /^(전\s*타입|전체|공통|전\s*세대)$/.test(s)) return [];
  return s.split(/[,，·/、]\s*/).map((x) => x.trim()).filter(Boolean);
};

// ---------------------------------------------------------------- 항목 모양(규칙·AI 공용)

export function windowItem(r = {}) {
  const num = (k) => (r[k] == null ? null : toNum(r[k]));
  const size = r.sizeMm?.w ? { w: toNum(r.sizeMm.w), h: toNum(r.sizeMm.h) } : parseSize(r.size) || (r.w && r.h ? { w: toNum(r.w), h: toNum(r.h) } : null);
  const code = clean(r.code).toUpperCase().replace(/\s/g, '');
  const air = r.airtight && typeof r.airtight === 'object' ? r.airtight : { value: null, unit: null, grade: r.airtight ?? null };
  const grade = (v) => orNull(String(v ?? '').replace(/등급/g, ''));
  const perf = r.perf || null;
  return {
    code,
    kind: r.kind === 'door' || /^[A-Z]*D\d*$/.test(code) ? 'door' : 'window',
    name: orNull(r.name),
    appliesTo: { unitTypes: Array.isArray(r.appliesTo?.unitTypes) ? r.appliesTo.unitTypes : listOf(r.unitTypes), rooms: Array.isArray(r.appliesTo?.rooms) ? r.appliesTo.rooms : listOf(r.rooms) },
    sizeMm: size,
    frame: { material: orNull(r.frame?.material ?? r.material), opening: orNull(r.frame?.opening ?? r.opening), maker: orNull(r.frame?.maker ?? r.maker) },
    glass: typeof r.glass === 'string' ? parseGlass(r.glass) : r.glass?.notation ? parseGlass(r.glass.notation) : null,
    perf: {
      uWindow: perf ? (perf.uWindow ?? null) : num('uWindow'),
      uGlass: perf ? (perf.uGlass ?? null) : num('uGlass'),
      shgc: perf ? (perf.shgc ?? null) : num('shgc'),
      airtight: perf?.airtight ?? { value: air.value == null ? null : toNum(air.value), unit: orNull(air.unit), grade: grade(air.grade) },
      watertight: orNull(perf ? perf.watertight : r.watertight),
      windPressure: orNull(perf ? perf.windPressure : r.windPressure),
      sound: orNull(perf ? perf.sound : r.sound),
      efficiencyGrade: grade(perf ? perf.efficiencyGrade : r.efficiencyGrade),
      fire: orNull(perf ? perf.fire : r.fire),
      certNo: orNull(perf ? perf.certNo : r.certNo),
    },
    page: r.page ?? null, row: r.row ?? null, box: r.box ?? null, confidence: r.confidence ?? null,
  };
}

const PERF_KEYS = [['thermalConductivity', '열전도율', 'W/mK'], ['density', '밀도', 'kg/㎥'], ['fireGrade', '방화 등급', null], ['soundGrade', '바닥충격음 등급', null], ['certNo', '인정·인증 번호', null]];

export function materialItem(r = {}) {
  const perf = Array.isArray(r.perf) ? r.perf.filter((p) => p?.key).map((p) => ({ key: String(p.key), label: clean(p.label) || String(p.key), value: p.value ?? null, unit: orNull(p.unit), standard: orNull(p.standard) })) : [];
  for (const [key, label, unit] of PERF_KEYS) {
    const v = clean(r[key]);
    if (!v || perf.some((p) => p.key === key)) continue;
    perf.push({ key, label, value: unit ? toNum(v) : v, unit, standard: null });
  }
  return { name: clean(r.name), spec: orNull(r.spec), maker: orNull(r.maker), perf, page: r.page ?? null, row: r.row ?? null, box: r.box ?? null, confidence: r.confidence ?? null };
}

export function finishItem(r = {}) {
  const t = clean(r.unitType);
  return { unitType: !t || /^(전\s*타입|전체|공통|전\s*세대)$/.test(t) ? null : t, room: clean(r.room), floor: orNull(r.floor), wall: orNull(r.wall), ceiling: orNull(r.ceiling), base: orNull(r.base), option: orNull(r.option), page: r.page ?? null, row: r.row ?? null, box: r.box ?? null, confidence: r.confidence ?? null };
}

// ---------------------------------------------------------------- 엑셀 표

const colNum = (s) => [...s].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
const colName = (n) => { let s = ''; for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

/** SheetJS 시트 → 병합을 푼 글자 표(2차원 배열) */
export function gridOf(ws) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ws?.['!ref'] || '');
  if (!m) return [];
  const [c0, r0, c1, r1] = [colNum(m[1]), Number(m[2]) - 1, colNum(m[3] || m[1]), Number(m[4] || m[2]) - 1];
  const grid = [];
  for (let r = r0; r <= Math.min(r1, r0 + 5000); r++) {
    const row = [];
    for (let c = c0; c <= Math.min(c1, c0 + 200); c++) {
      const cell = ws[`${colName(c)}${r + 1}`];
      row.push(cell ? clean(cell.w ?? cell.v) : '');
    }
    grid.push(row);
  }
  for (const g of ws['!merges'] || []) {
    const v = grid[g.s.r - r0]?.[g.s.c - c0] ?? '';
    for (let r = g.s.r; r <= g.e.r; r++) for (let c = g.s.c; c <= g.e.c; c++) if (grid[r - r0] && c - c0 < grid[r - r0].length) grid[r - r0][c - c0] = v;
  }
  return grid;
}

// [칸, 화면 이름, 머리글 찾기]. 앞줄부터 고르고 한 열은 한 칸만 차지한다. 그래서 좁은 것을 먼저 쓴다
const WINDOW_FIELDS = [
  ['code', '기호', /^(창호\s*)?(기호|번호|부호|형별|형식)$|^type$/i],
  ['uGlass', '열관류율(유리)', /유리.*(열관류|U값|U-?value)|(열관류|U값).*유리/i],
  ['uWindow', '열관류율(창세트)', /열관류|U값|U-?value/i],
  ['shgc', '태양열취득률', /SHGC|태양열\s*취득/i],
  ['airtight', '기밀성', /기밀/],
  ['watertight', '수밀성', /수밀/],
  ['windPressure', '내풍압', /내풍압/],
  ['sound', '차음', /차음|방음/],
  ['efficiencyGrade', '효율 등급', /효율|에너지\s*등급/],
  ['fire', '방화', /방화|갑종|을종|내화/],
  ['certNo', '인증번호', /인증\s*번호|시험\s*번호|성적서/],
  ['glass', '유리 표기', /유리/],
  ['size', '규격', /규격|크기|치수|W\s*[×xX]\s*H/i],
  ['w', '폭', /^(폭|가로|너비|W)(\s*\(mm\))?$|규격.*(폭|W)$/i],
  ['h', '높이', /^(높이|세로|H)(\s*\(mm\))?$|규격.*(높이|H)$/i],
  ['unitTypes', '적용 타입', /적용.*(타입|세대|평형)|^타입$/],
  ['rooms', '위치', /위치|적용\s*실|적용\s*부위|실명/],
  ['material', '창틀 재질', /재질|창틀|프레임/],
  ['opening', '개폐 방식', /개폐|작동/],
  ['maker', '제조사', /제조사|제작사|제조업체|메이커/],
  ['name', '이름', /명칭|창호명|품명/],
];
const FINISH_FIELDS = [
  ['unitType', '타입', /타입|평형/],
  ['room', '실명', /실\s*명|^공간$|^위치$|^실$|^구분$/],
  ['floor', '바닥', /바닥/],
  ['base', '걸레받이', /걸레받이/],
  ['wall', '벽', /^벽|벽\s*마감/],
  ['ceiling', '천장', /천장|천정/],
  ['option', '옵션', /옵션|비고/],
];
const MATERIAL_FIELDS = [
  ['name', '자재명', /자재|재료|품명|명칭/],
  ['spec', '규격', /규격|두께/],
  ['maker', '제조사', /제조사|제작사|제조업체|메이커/],
  ['thermalConductivity', '열전도율', /열전도/],
  ['density', '밀도', /밀도/],
  ['fireGrade', '방화 등급', /방화|난연|불연/],
  ['soundGrade', '바닥충격음 등급', /충격음/],
  ['certNo', '인정·인증 번호', /인정|인증|시험\s*번호|성적서/],
];
export const FIELDS_OF = {
  window_performance: WINDOW_FIELDS, window_schedule: WINDOW_FIELDS, glass_spec: WINDOW_FIELDS,
  finish_list: FINISH_FIELDS, material_spec: MATERIAL_FIELDS, exterior_spec: MATERIAL_FIELDS,
};
const MUST = { window_performance: 'code', window_schedule: 'code', glass_spec: 'code', finish_list: 'room', material_spec: 'name', exterior_spec: 'name' };

function labelsOf(grid, r, two) {
  const a = grid[r] || [];
  const b = two ? grid[r + 1] || [] : [];
  return a.map((v, c) => (b[c] && b[c] !== v ? `${v} ${b[c]}`.trim() : v));
}

function matchColumns(labels, fields) {
  const cols = {};
  const used = new Set();
  for (const [key, , re] of fields) {
    const c = labels.findIndex((l, i) => l && !used.has(i) && re.test(l));
    if (c >= 0) { cols[key] = c; used.add(c); }
  }
  return cols;
}

/** 머리글 찾기: 앞 15줄에서 1줄·2줄 머리글을 맞춰 보고 가장 많이 맞는 곳 → { row, lines, columns, score } | null */
export function findHeader(kind, grid) {
  const fields = FIELDS_OF[kind];
  if (!fields) return null;
  let best = null;
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    for (const lines of [1, 2]) {
      const columns = matchColumns(labelsOf(grid, r, lines === 2), fields);
      const score = Object.keys(columns).length;
      if (MUST[kind] in columns && score >= 2 && (!best || score > best.score)) best = { row: r, lines, columns, score };
    }
  }
  return best;
}

export function guessKind(name, grid = []) {
  const text = `${name} ${grid.slice(0, 12).flat().join(' ')}`;
  if (/마감(재)?\s*(리스트|목록|표)|finish/i.test(text)) return 'finish_list';
  if (/유리/.test(name)) return 'glass_spec';
  if (/성능|형별|열관류/.test(text) && /창|AW|유리/.test(text)) return 'window_performance';
  if (/창호\s*일람/.test(text)) return 'window_schedule';
  if (/외장|외부\s*마감/.test(text)) return 'exterior_spec';
  if (/구조\s*검토|기술\s*검토|검토서|흙막이|가시설|타워\s*크레인|동바리/.test(text)) return 'tech_review';
  if (/시공\s*기준|품질\s*기준|회사\s*기준/.test(text)) return 'company_std';
  if (/시방/.test(text)) return 'spec';
  if (/자재|시험\s*성적|성적서|단열재|인증서|열전도/.test(text)) return 'material_spec';
  return 'unknown';
}

/** 표 한 장 → 항목 목록. columns: { 칸: 열 번호 }. 빈 줄·소계 줄은 건너뛴다 */
export function readRows(kind, grid, { row, lines, columns }, { page = 1 } = {}) {
  const out = EMPTY_EXTRACT();
  const must = columns[MUST[kind]];
  for (let r = row + lines; r < grid.length; r++) {
    const line = grid[r];
    if (!clean(line[must])) continue;
    const raw = { page, row: r + 1 };
    for (const [k, c] of Object.entries(columns)) raw[k] = line[c];
    if (MUST[kind] === 'code') {
      const it = windowItem(raw);
      if (/^[A-Z]{1,4}-?\d{1,3}[A-Z]?$/.test(it.code)) out.windows.push(it);
    } else if (kind === 'finish_list') {
      if (!/^(소계|합계|비고)/.test(clean(raw.room))) out.finishes.push(finishItem(raw));
    } else {
      out.materials.push(materialItem(raw));
    }
  }
  return out;
}

/**
 * 엑셀 문서 읽기(AI 없이).
 * @param {string} name 파일 이름
 * @param {Array<{ name: string, grid: string[][] }>} sheets
 * @param {string} [kind] 사람이 정한 종류
 * @returns {{ kind: string, tables: any[], extracted: any, confident: boolean }}
 */
export function readBook(name, sheets, kind = null) {
  const k = kind || guessKind(name, sheets[0]?.grid || []);
  const tables = [];
  const parts = [];
  sheets.forEach((s, i) => {
    const h = findHeader(k, s.grid);
    if (!h) return;
    tables.push({ sheet: s.name, page: i + 1, ...h });
    parts.push(readRows(k, s.grid, h, { page: i + 1 }));
  });
  const extracted = mergeExtract(parts);
  extracted.source = 'rule';
  const n = extracted.windows.length + extracted.materials.length + extracted.finishes.length;
  return { kind: k, tables, extracted, confident: Boolean(tables.length && n) };
}

// 쪽마다 읽은 결과 합치기. 같은 기호가 여러 쪽에 있으면 빈 칸만 채운다
export function mergeExtract(parts) {
  const out = EMPTY_EXTRACT();
  const fill = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') fill(a[k], v);
      else if (a[k] == null || (Array.isArray(a[k]) && !a[k].length)) a[k] = v;
    }
  };
  for (const p of parts) {
    for (const w of p.windows || []) { const hit = out.windows.find((x) => x.code === w.code); if (hit) fill(hit, w); else out.windows.push(w); }
    for (const m of p.materials || []) { const hit = out.materials.find((x) => x.name === m.name); if (hit) fill(hit, m); else out.materials.push(m); }
    out.finishes.push(...(p.finishes || []));
    // 시방서 요구사항·기술검토서(39 지시서): 있을 때만 칸을 만든다
    if (p.requirements?.length) out.requirements = [...(out.requirements || []), ...p.requirements.filter((r) => !(out.requirements || []).some((x) => x.id === r.id))];
    if (p.chapters?.length) out.chapters = [...(out.chapters || []), ...p.chapters];
    if (p.techReview && !out.techReview) out.techReview = p.techReview;
    if (p.notes) out.notes = [out.notes, p.notes].filter(Boolean).join(' ');
  }
  return out;
}

/** 쪽 글자 묶음(AI에 함께 보낸다). 엑셀은 시트마다 탭으로 나눈 글자 */
export const tableText = (grid) => grid.filter((r) => r.some(Boolean)).map((r) => r.join('\t')).join('\n');
