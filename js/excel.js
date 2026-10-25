// 엑셀 일괄 등록·내보내기의 변환 규칙 (화면과 무관, Node 테스트 가능).
// 엑셀 파일 하나에 [현장]·[숙소]·[거주자] 시트를 두고, 이름으로 서로 연결한다.

// [머리글, 필드, 필수]
export const SHEETS = {
  sites: {
    name: '현장',
    columns: [['현장명*', 'name', true], ['주소*', 'address', true], ['발주처', 'client'], ['착공일', 'startDate'], ['준공 예정일', 'endDate'],
      ['현장소장', 'manager'], ['현장사무실', 'phone'], ['공사 개요', 'overview'], ['메모', 'memo'], ['위도', 'lat'], ['경도', 'lng']],
    aliases: { 현장: 'name', 공사명: 'name', 현장사무실연락처: 'phone', 연락처: 'phone', 준공일: 'endDate', 개요: 'overview', 비고: 'memo' },
    example: ['평택 고덕 OO 신축공사', '경기도 평택시 고덕면 ○○로 100', '(주)발주처', '2025-08-01', '2027-08-31', '홍길동 부장', '031-000-0000', '지하 2층/지상 7층', '', '', ''],
  },
  lodgings: {
    name: '숙소',
    columns: [['현장명*', 'siteName', true], ['숙소명*', 'name', true], ['주소*', 'address', true], ['동·호수', 'addressDetail'], ['유형', 'type'],
      ['정원', 'capacity'], ['계약 종료일', 'leaseEnd'], ['메모', 'memo'], ['위도', 'lat'], ['경도', 'lng']],
    aliases: { 현장: 'siteName', 숙소: 'name', 상세주소: 'addressDetail', 계약종료: 'leaseEnd', 계약만료일: 'leaseEnd', 비고: 'memo' },
    example: ['평택 고덕 OO 신축공사', '고덕 OO오피스텔', '경기도 평택시 고덕동 ○○로 12', '1203호', '오피스텔', 3, '2026-12-31', '', '', ''],
  },
  residents: {
    name: '거주자',
    columns: [['현장명*', 'siteName', true], ['숙소명*', 'lodgingName', true], ['이름*', 'name', true], ['직급', 'rank'], ['직책', 'title'],
      ['소속·공종', 'dept'], ['연락처', 'phone'], ['입주일', 'moveIn'], ['메모', 'memo']],
    aliases: { 현장: 'siteName', 숙소: 'lodgingName', 성명: 'name', 소속: 'dept', 공종: 'dept', 휴대폰: 'phone', 전화번호: 'phone', 비고: 'memo' },
    example: ['평택 고덕 OO 신축공사', '고덕 OO오피스텔', '홍길동', '대리', '공무', '건축', '010-0000-0000', '2026-03-02', ''],
  },
};

const norm = (h) => String(h ?? '').replace(/[\s*·・.()[\]（）]/g, '').toLowerCase();
const cell = (v) => (v == null ? '' : String(v).trim());

// 엑셀 날짜 칸은 일련번호(1900년 기준 일수)로 들어온다. 시간대 영향 없이 날짜로 바꾼다.
const DATE_KEYS = new Set(['startDate', 'endDate', 'leaseEnd', 'moveIn']);
function excelDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = cell(v);
  const n = typeof v === 'number' ? v : /^\d{5}(\.\d+)?$/.test(s) ? Number(s) : NaN;
  // 라이브러리가 쓴 날짜는 시간대 때문에 46082.9999처럼 들어올 수 있어 살짝 올려서 자른다.
  if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n + 0.01) * 864e5).toISOString().slice(0, 10);
  return s;
}

function phone(v) {
  let s = cell(v);
  const d = s.replace(/\D/g, '');
  if (/^\d+$/.test(s) && (d.length === 9 || d.length === 10) && !d.startsWith('0')) s = `0${d}`; // 엑셀이 앞자리 0을 지운 경우
  const x = s.replace(/\D/g, '');
  if (x.length === 11) return `${x.slice(0, 3)}-${x.slice(3, 7)}-${x.slice(7)}`;
  if (x.length === 10) return x.startsWith('02') ? `${x.slice(0, 2)}-${x.slice(2, 6)}-${x.slice(6)}` : `${x.slice(0, 3)}-${x.slice(3, 6)}-${x.slice(6)}`;
  return s;
}

function keyMap(kind) {
  const def = SHEETS[kind];
  const m = new Map();
  for (const [label, key] of def.columns) m.set(norm(label), key);
  for (const [label, key] of Object.entries(def.aliases)) m.set(norm(label), key);
  return m;
}

// 머리글만 보고 어떤 시트인지 고른다(CSV처럼 시트 이름이 없을 때).
export function detectKind(header) {
  const keys = header.map(norm);
  if (keys.includes('이름') || keys.includes('성명')) return 'residents';
  if (keys.includes('숙소명')) return 'lodgings';
  return 'sites';
}

/**
 * 2차원 배열(첫 줄 머리글) → 레코드 목록
 * @returns {{ records: object[], unknown: string[], missing: string[] }}
 */
export function parseSheet(kind, rows) {
  const def = SHEETS[kind];
  const map = keyMap(kind);
  const header = (rows[0] || []).map(cell);
  const keys = header.map((h) => map.get(norm(h)) || null);
  const unknown = header.filter((h, i) => h && !keys[i]);
  const missing = def.columns.filter(([, key, req]) => req && !keys.includes(key)).map(([label]) => label.replace('*', ''));
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (!row.some((c) => cell(c))) continue;
    const rec = { __row: i + 1 };
    keys.forEach((k, j) => {
      if (!k) return;
      rec[k] = k === 'phone' ? phone(row[j]) : DATE_KEYS.has(k) ? excelDate(row[j]) : cell(row[j]);
    });
    records.push(rec);
  }
  return { records, unknown, missing };
}

/**
 * 시트 이름 → 2차원 배열 묶음을 종류별로 나눈다.
 * @param {Record<string, any[][]>} sheets
 */
export function parseWorkbook(sheets) {
  const out = { sites: null, lodgings: null, residents: null };
  const names = Object.keys(sheets);
  for (const name of names) {
    const rows = sheets[name];
    if (!rows?.length) continue;
    let kind = Object.keys(SHEETS).find((k) => norm(SHEETS[k].name) === norm(name));
    if (!kind) kind = detectKind(rows[0] || []);
    if (out[kind]) continue;
    out[kind] = { sheet: name, ...parseSheet(kind, rows) };
  }
  return out;
}

const header = (kind) => SHEETS[kind].columns.map(([label]) => label);

export function templateRows() {
  return Object.fromEntries(Object.keys(SHEETS).map((k) => [k, [header(k), SHEETS[k].example]]));
}

export function exportRows(data) {
  const site = (id) => data.sites.find((s) => s.id === id);
  const lodging = (id) => data.lodgings.find((l) => l.id === id);
  const pick = (kind, rec, extra = {}) => SHEETS[kind].columns.map(([, key]) => extra[key] ?? rec[key] ?? '');
  return {
    sites: [header('sites'), ...data.sites.map((s) => pick('sites', s))],
    lodgings: [header('lodgings'), ...data.lodgings.map((l) => pick('lodgings', l, { siteName: site(l.siteId)?.name }))],
    residents: [header('residents'), ...data.residents.map((r) => {
      const l = lodging(r.lodgingId);
      return pick('residents', r, { lodgingName: l?.name, siteName: l && site(l.siteId)?.name });
    })],
  };
}

const fields = (rec, drop = []) => Object.fromEntries(Object.entries(rec)
  .filter(([k, v]) => !k.startsWith('__') && !drop.includes(k) && v !== '' && v != null));

/**
 * 현장 → 숙소 → 거주자 순서로 저장한다. 같은 이름이 있으면 고치고(빈 칸은 기존 값 유지), 없으면 새로 만든다.
 * @param {{ snapshot: () => any, save: (kind: string, rec: object) => Promise<any> }} store
 * @param {{ geocode: (address: string) => Promise<{lat:number,lng:number}|null>, onProgress?: (done:number, total:number) => void }} opts
 */
export async function runImport(store, parsed, { geocode, onProgress } = {}) {
  const result = { sites: { added: 0, updated: 0 }, lodgings: { added: 0, updated: 0 }, residents: { added: 0, updated: 0 }, errors: [] };
  const list = (k) => parsed[k]?.records || [];
  const total = list('sites').length + list('lodgings').length + list('residents').length;
  let done = 0;
  const same = (a, b) => cell(a).toLowerCase() === cell(b).toLowerCase();

  async function coords(rec, existing) {
    if (rec.lat && rec.lng && Number.isFinite(Number(rec.lat)) && Number.isFinite(Number(rec.lng))) return { lat: Number(rec.lat), lng: Number(rec.lng) };
    if (existing && (!rec.address || rec.address === existing.address)) return { lat: existing.lat, lng: existing.lng };
    if (!rec.address) return null;
    return geocode ? geocode(rec.address) : null;
  }

  async function step(kind, rec, fn) {
    try {
      const updated = await fn();
      result[kind][updated ? 'updated' : 'added']++;
    } catch (err) {
      result.errors.push({ sheet: SHEETS[kind].name, row: rec.__row, message: err.message });
    }
    onProgress?.(++done, total);
  }

  for (const rec of list('sites')) {
    await step('sites', rec, async () => {
      const data = store.snapshot();
      const existing = data.sites.find((s) => same(s.name, rec.name));
      const c = await coords(rec, existing);
      if (!c) throw new Error(`주소로 위치를 찾지 못했습니다: ${rec.address || '(주소 없음)'} — 위도·경도 칸을 채우거나 화면에서 직접 등록해주세요.`);
      await store.save('sites', { ...(existing || {}), ...fields(rec, ['lat', 'lng']), ...c, id: existing?.id });
      return Boolean(existing);
    });
  }

  for (const rec of list('lodgings')) {
    await step('lodgings', rec, async () => {
      const data = store.snapshot();
      const site = data.sites.find((s) => same(s.name, rec.siteName));
      if (!site) throw new Error(`현장 "${rec.siteName || ''}"을(를) 찾을 수 없습니다. [현장] 시트나 화면에서 먼저 등록해주세요.`);
      const existing = data.lodgings.find((l) => l.siteId === site.id && same(l.name, rec.name));
      const c = await coords(rec, existing);
      if (!c) throw new Error(`주소로 위치를 찾지 못했습니다: ${rec.address || '(주소 없음)'}`);
      await store.save('lodgings', { ...(existing || {}), ...fields(rec, ['lat', 'lng', 'siteName']), ...c, siteId: site.id, id: existing?.id });
      return Boolean(existing);
    });
  }

  for (const rec of list('residents')) {
    await step('residents', rec, async () => {
      const data = store.snapshot();
      const site = data.sites.find((s) => same(s.name, rec.siteName));
      if (!site) throw new Error(`현장 "${rec.siteName || ''}"을(를) 찾을 수 없습니다.`);
      const lodging = data.lodgings.find((l) => l.siteId === site.id && same(l.name, rec.lodgingName));
      if (!lodging) throw new Error(`"${site.name}" 현장에 숙소 "${rec.lodgingName || ''}"이(가) 없습니다.`);
      const existing = data.residents.find((r) => r.lodgingId === lodging.id && same(r.name, rec.name)
        && (!rec.phone || !r.phone || r.phone === rec.phone));
      await store.save('residents', { ...(existing || {}), ...fields(rec, ['siteName', 'lodgingName']), lodgingId: lodging.id, id: existing?.id });
      return Boolean(existing);
    });
  }

  return result;
}
