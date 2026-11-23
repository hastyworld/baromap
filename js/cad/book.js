// 도서 한 벌 정리(44 지시서 2절). 순수 함수 — 브라우저(놓는 칸, js/book-upload.js)와 도구(tools/real/book.mjs)가 함께 쓴다.
// 파일 종류(도면·문서·그림·압축·찌꺼기), 공종(폴더 이름 → 없으면 도면번호 앞 글자), 3D에 쓰는 공종, 같은 파일 고르기,
// 압축 안 이름(UTF-8 표시가 없으면 cp949), 경로 안전(.. 과 절대 경로는 건너뜀), 도서 이름.
import { tradeOf } from './classify.js';

// 파일 하나 읽기 한도(45 지시서 4.2): 넘으면 그 파일은 "너무 오래 걸림"으로 넘기고 다음 파일로(앱은 워커를 끊고, 도구는 단계마다 시계를 본다)
export const READ_LIMIT_MS = 10 * 60e3;
export const TOO_SLOW = '너무 오래 걸림';

// ---------------------------------------------------------------- 파일 종류

const JUNK_EXT = /\.(bak|dwl2?|log|err|tmp|sv\$|ac\$|dwk|ds_store)$/i;
const JUNK_NAME = /^(thumbs\.db|desktop\.ini|\.ds_store)$|^~\$|^\._/i;

/**
 * @param {string} path 경로 또는 이름
 * @returns {'drawing'|'doc'|'image'|'archive'|'bundle'|'junk'|'other'}
 */
export function entryKind(path) {
  const p = String(path || '').replace(/\\/g, '/');
  const base = p.split('/').pop() || '';
  if (/(^|\/)__MACOSX\//i.test(p) || JUNK_NAME.test(base) || JUNK_EXT.test(base)) return 'junk';
  if (/\.(dwg|dxf)$/i.test(base)) return 'drawing';
  if (/\.(pdf|xlsx|xls)$/i.test(base)) return 'doc';
  if (/\.(jpe?g|png)$/i.test(base)) return 'image';
  if (/\.zip$/i.test(base)) return 'archive';
  if (/\.baromap$/i.test(base)) return 'bundle'; // 회사 PC 도구가 만든 3D 묶음(4절 6)
  return 'other';
}

// ---------------------------------------------------------------- 공종

/** 공종 사전: 3D에 쓰는 것(model)과 보관만 하는 것. 화면에 공종 스위치를 두지 않는다(44 지시서 2.2) */
export const TRADES = {
  A: { label: '건축', model: true },
  S: { label: '구조', model: true },
  L: { label: '조경', model: true },
  C: { label: '토목', model: true },
  CE: { label: '토공·흙막이', model: false },
  M: { label: '기계설비', model: false },
  F: { label: '소방', model: false },
  E: { label: '전기', model: false },
  T: { label: '통신', model: false },
};

// 폴더 이름 낱말 → 공종. 순서가 중요하다: 설비 낱말이 건축보다 먼저("건축설비"는 설비), 흙막이가 토목보다 먼저
const FOLDER_WORDS = [
  ['CE', /토공|흙막이|가시설|EARTH\s*WORK|RETAINING/i],
  ['F', /소방|FIRE/i],
  ['E', /전기|ELEC/i],
  ['T', /통신|TELECOM|(^|[^A-Z])ICT([^A-Z]|$)/i],
  ['M', /기계|설비|위생|공조|음식물|MECH|HVAC|PLUMB|(^|[^A-Z])MEP([^A-Z]|$)/i],
  ['S', /구조|STRUC/i],
  ['L', /조경|LANDSCAPE/i],
  ['C', /토목|CIVIL/i],
  ['A', /건축|특화|인테리어|ARCH|INTERIOR/i],
];
// 도면번호 앞 글자(classify.js tradeOf) → 공종
const FROM_NUMBER = { A: 'A', AR: 'A', ID: 'A', S: 'S', ST: 'S', M: 'M', ME: 'M', P: 'M', E: 'E', EL: 'E', FP: 'F', L: 'L', LA: 'L', C: 'C', CV: 'C', T: 'T' };

const NUMBERED = /^\s*[([]?\s*\d{1,3}\s*[.)\]_-]/;
const segName = (s) => String(s || '').replace(/\.zip$/i, '');

/** 폴더 이름 하나 → 공종(앞 번호 "01." 은 무시) */
export function tradeOfFolder(name) {
  const s = segName(name).replace(NUMBERED, '').trim();
  if (!s) return null;
  for (const [code, re] of FOLDER_WORDS) if (re.test(s)) return code;
  return null;
}

/**
 * 경로 → 공종. 폴더 이름이 먼저, 없으면 파일 이름의 도면번호 앞 글자, 둘 다 없으면 null.
 * 여러 폴더가 공종 낱말을 가지면: 번호 붙은 폴더("03. 기계설비")가 먼저, 같으면 얕은 쪽.
 * 도서 전체를 보고 정한 공종 폴더 깊이(depth)가 있으면 그 깊이의 폴더가 먼저다("OO 건축도서/기계/…"에서 맨 위 "건축도서"를 공종으로 보지 않게).
 * @param {string} path @param {{ depth?: number|null }} [o]
 * @returns {{ trade: string|null, group: string, from: 'folder'|'file'|null }} group: 공종을 정한 폴더까지의 경로(외부 참조·구조 묶음을 이 단위로 본다)
 */
export function tradeOfPath(path, { depth = null } = {}) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const folders = parts.slice(0, -1);
  // 공종 폴더 깊이를 알면 그보다 얕은 폴더(도서 이름 폴더)는 보지 않는다
  const hits = folders.map((f, i) => ({ i, code: tradeOfFolder(f), numbered: NUMBERED.test(segName(f)) })).filter((h) => h.code && (depth == null || h.i >= depth));
  let hit = null;
  if (depth != null) hit = hits.find((h) => h.i === depth) || null;
  if (!hit && hits.length) hit = [...hits].sort((a, b) => (a.numbered === b.numbered ? a.i - b.i : a.numbered ? -1 : 1))[0];
  if (hit) return { trade: hit.code, group: folders.slice(0, hit.i + 1).join('/'), from: 'folder' };
  const t = tradeOf(parts[parts.length - 1] || '');
  if (t && FROM_NUMBER[t]) return { trade: FROM_NUMBER[t], group: '', from: 'file' };
  return { trade: null, group: '', from: null };
}

/**
 * 도서 전체에서 공종 폴더가 있는 깊이: 서로 다른 공종 낱말이 둘 이상 나오는 가장 얕은 깊이(없으면 null)
 * @param {string[]} paths
 */
export function tradeDepth(paths) {
  const at = new Map(); // 깊이 → 공종 모음
  for (const p of paths) {
    const folders = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1);
    folders.forEach((f, i) => { const c = tradeOfFolder(f); if (c) { if (!at.has(i)) at.set(i, new Set()); at.get(i).add(c); } });
  }
  const deep = [...at.keys()].sort((a, b) => a - b).find((d) => at.get(d).size >= 2);
  return deep ?? null;
}

/** 이 공종의 도면을 3D 만들기에 넘기나: 모르는 공종(null)은 넘긴다(지금처럼) */
export const forModel = (trade) => trade == null || Boolean(TRADES[trade]?.model);

// ---------------------------------------------------------------- 압축 안 이름·경로

/** 경로 안전: 역슬래시를 / 로, 앞뒤 / 와 "./" 를 떼고, ".."·절대 경로(/, C:)·빈 이름이면 null */
export function safePath(name) {
  const s = String(name ?? '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s)) return null;
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..')) return null;
  return parts.join('/');
}

let ASCII = null;
/**
 * zip 항목 이름 바이트 → 글자. UTF-8 표시(일반 목적 비트 11)나 유니코드 경로 추가 칸(0x7075)이 있으면 UTF-8,
 * 없으면 먼저 UTF-8로 읽어 보고(맥·7zip은 표시 없이 UTF-8로 쓴다) 깨지면 cp949(euc-kr)
 * @param {Uint8Array} bytes @param {{ utf8?: boolean, unicode?: Uint8Array|null }} [o]
 */
export function decodeName(bytes, { utf8 = false, unicode = null } = {}) {
  if (unicode?.length) return new TextDecoder().decode(unicode);
  if (utf8) return new TextDecoder().decode(bytes);
  ASCII ||= /^[\x00-\x7f]*$/;
  const raw = String.fromCharCode(...bytes.subarray(0, 4096));
  if (ASCII.test(raw)) return raw;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* cp949 */ }
  return new TextDecoder('euc-kr').decode(bytes);
}

// ---------------------------------------------------------------- 같은 파일·도서 이름

/**
 * 같은 내용(sha256)이면 하나만: 바깥(압축 안 압축이 아닌 것)이 먼저, 같으면 짧은 경로, 같으면 이름 순
 * @template {{ path: string, sha: string, inner?: boolean }} T
 * @param {T[]} items
 * @returns {{ keep: T[], dups: T[] }}
 */
export function pickUnique(items) {
  const order = [...items].sort((a, b) => (Boolean(a.inner) - Boolean(b.inner)) || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set();
  const keep = [];
  const dups = [];
  for (const it of order) {
    if (it.sha && seen.has(it.sha)) { dups.push(it); continue; }
    if (it.sha) seen.add(it.sha);
    keep.push(it);
  }
  return { keep: items.filter((x) => keep.includes(x)), dups };
}

/** 놓은 zip·폴더 이름들 → 도서 묶음 이름(드라이브가 붙인 날짜·번호를 뗀다, 60자까지) */
export function bookName(names = []) {
  const clean = (n) => String(n || '').split(/[\\/]/).filter(Boolean).pop()?.replace(/\.(zip|dwg|dxf)$/i, '')
    .replace(/-\d{8}T\d{6}Z(-\d{1,3})?$/i, '').replace(/[\s_-]*(\(\d+\)|part\s*\d+|\d{3})$/i, '').trim() || '';
  const first = names.map(clean).find(Boolean);
  return (first || '도면').slice(0, 60);
}

// ---------------------------------------------------------------- 도서 계획

/**
 * 놓은 파일 목록 → 종류별 셈·공종·묶음(외부 참조·구조 묶음을 보는 단위)
 * @param {{ path: string, size?: number, inner?: boolean }[]} entries
 * @returns {{ depth: number|null, counts: Record<string, number>, files: { path: string, kind: string, trade: string|null, group: string, model: boolean, inner: boolean }[] }}
 */
export function planBook(entries) {
  const depth = tradeDepth(entries.map((e) => e.path));
  const counts = { drawing: 0, doc: 0, image: 0, archive: 0, bundle: 0, junk: 0, other: 0 };
  const files = entries.map((e) => {
    const kind = entryKind(e.path);
    counts[kind]++;
    const t = tradeOfPath(e.path, { depth });
    return { ...e, path: e.path, kind, trade: t.trade, group: t.group, model: forModel(t.trade), inner: Boolean(e.inner) };
  });
  return { depth, counts, files };
}
