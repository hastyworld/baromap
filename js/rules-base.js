// 검증에 쓰는 작은 도우미. store.js의 validate()와 js/ops/rules.js가 같이 쓴다(다른 파일을 import하지 않는다).

export class ValidationError extends Error {}
export const fail = (msg) => { throw new ValidationError(msg); };

export const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

export function date(v, label) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\.?$/.exec(String(v).trim());
  const iso = m && `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (!iso || Number.isNaN(Date.parse(iso))) fail(`${label}은(는) 2026-03-02 같은 날짜 형식으로 입력해주세요.`);
  return iso;
}

export function int(v, label, min, max) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s명]/g, ''));
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label}은(는) ${min}~${max} 사이의 숫자로 입력해주세요.`);
  return n;
}

export function coord(v, min, max) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n < min || n > max) {
    fail('위치가 지정되지 않았습니다. 주소를 검색하거나 지도에서 위치를 지정해주세요.');
  }
  return Math.round(n * 1e7) / 1e7;
}

export const required = (v, label) => v || fail(`${label}을(를) 입력해주세요.`);

export const oneOf = (v, list, label, d) => { const s = v == null || v === '' ? d : String(v); if (!list.includes(s)) fail(`${label} 값이 올바르지 않습니다.`); return s; };
export const obj = (v, label, max = 20000) => {
  const o = v == null ? {} : v;
  if (typeof o !== 'object' || Array.isArray(o)) fail(`${label} 형식이 올바르지 않습니다.`);
  if (JSON.stringify(o).length > max) fail(`${label}이(가) 너무 큽니다.`);
  return o;
};
export const arr = (v, label, max = 200) => {
  const a = v == null ? [] : v;
  if (!Array.isArray(a)) fail(`${label} 형식이 올바르지 않습니다.`);
  if (a.length > max) fail(`${label}은(는) ${max}개까지입니다.`);
  return a;
};
export const strs = (v, label, max = 200, len = 80) => arr(v, label, max).map((x) => str(x, len)).filter(Boolean);
export const num01 = (v) => { const n = Number(v ?? 0); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };
export const nonneg = (v) => { const n = Number(v ?? 0); return Number.isFinite(n) && n > 0 ? n : 0; };
export const siteOf = (b, data, label) => {
  const siteId = str(b.siteId ?? data.siteId, 40);
  if (!siteId || !(data.sites || []).some((s) => s.id === siteId)) fail(`${label} 현장을 찾을 수 없습니다.`);
  return siteId;
};

// 소수 허용 숫자: 빈 값은 null
export function dec(v, label, min, max) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || n < min || n > max) fail(`${label}은(는) ${min}~${max} 사이의 숫자로 입력해주세요.`);
  return n;
}
