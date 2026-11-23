// 시공 상세도 읽기(38 지시서 2·4절 규칙): 상세 제목(①, 1/A-801, "… 상세") 단위로 나누고, 지시선 글자와 치수를 상세 값 키에 잇는다. 순수 함수.
// 값이 없으면 넣지 않는다. 적용 범위는 제목의 창호 기호·실 이름·부위에서 정한다.
// 42 지시서 4.3: 머리글 없이 세로로 쌓인 인출선 글자("THK30 완충재" / "경량기포 40" / "T=9.5 석고보드 2겹")는 층 구성(compositions)으로 읽는다.
import { detailFromText } from '../cad/detail-words.js';
import { DETAIL_KEY_NAMES } from './detail-keys.js';
import { material, materialKind } from './materials-ko.js';

const TITLE_RE = /^([①-⑳]|\(\d{1,2}\)|\d{1,2}\s*\/\s*[A-Z]-?\d{2,4}|[A-Z]\))\s*|상세\s*(도)?\s*$|DETAIL\s*$/i;
const WINDOW_CODE = /\b(AW|PW|SW|BW|CW|AL|PL)\d{1,2}[A-Z]?\b/g;
const ROOMS = ['발코니', '계단실', '욕실', '거실', '침실', '현관', '실외기실', '대피공간', '주방'];
const ZONES = [['지붕', 'roof'], ['옥상', 'roof'], ['외벽', 'wall'], ['저층부', 'base'], ['필로티', 'pilotis']];

export function scopeOf(title) {
  const s = String(title || '');
  return {
    typeCodes: [...new Set(s.match(WINDOW_CODE) || [])],
    rooms: ROOMS.filter((r) => s.includes(r)),
    zones: [...new Set(ZONES.filter(([w]) => s.includes(w)).map(([, z]) => z))],
  };
}

// 층 구성이 어느 부위인지: 제목 → 재료로 짐작(완충재·기포·방통·마루 → 바닥, 천장틀·천장지 → 천장, 벽돌·스터드·ALC·벽지 → 벽). 모르면 null(버린다)
// 단열재는 벽·바닥·지붕 어디에나 있어 단서로 쓰지 않는다. 방수 + 단열 + 맨 아래 콘크리트(슬래브)는 지붕(누름콘크리트 구성) — 실제 도서에서 벽으로 잘못 읽었다
const PART_HINT = [['floor', /완충재|기포|방통|마루|장판|걸레받이/], ['ceiling', /천[장정]\s*틀|천[장정]\s*지|천[장정]\s*재|텍스|반자/], ['wall', /벽돌|블록|스터드|ALC|벽지|도배/i]];
export function stackPart(names, title = '', layers = null) {
  if (/지붕|옥상|파라펫|ROOF/i.test(title)) return 'roof';
  if (/바닥/.test(title)) return 'floor';
  if (/천[장정]/.test(title)) return 'ceiling';
  if (/벽/.test(title)) return 'wall';
  const bottom = layers?.at(-1);
  if (bottom?.category === 'structure' && names.some((n) => /방수/.test(n)) && names.some((n) => /단열|압출|비드|EPS|XPS/i.test(n)) && !names.some((n) => PART_HINT[0][1].test(n))) return 'roof';
  for (const [part, re] of PART_HINT) if (names.some((n) => re.test(n))) return part;
  return null;
}

/**
 * 세로로 쌓인 "두께 + 재료" 글자 묶음 → 층 구성. 같은 왼쪽 줄(x)에서 줄 간격이 글자 높이의 3.2배 안으로 이어지고,
 * 두께가 적힌 재료가 3줄 넘게 이어질 때만 받는다(흩어진 주기 글자를 층으로 읽지 않게). 위에서 아래 순서 그대로.
 * @returns {{ layers: { material, category, thicknessMm }[], pos: number[], top: number }[]}
 */
export function readStacks(texts) {
  const cand = texts.map((t) => ({ t, m: material(t.t) })).filter((x) => x.m.name && x.m.category !== 'other' && x.t.t.length <= 30 && !detailFromText(x.t.t));
  const used = new Set();
  const out = [];
  for (const head of [...cand].sort((a, b) => b.t.y - a.t.y)) {
    if (used.has(head)) continue;
    const col = cand.filter((x) => !used.has(x) && x.t.y <= head.t.y && Math.abs(x.t.x - head.t.x) < Math.max(head.t.size, x.t.size) * 1.5).sort((a, b) => b.t.y - a.t.y);
    const run = [];
    let lastY = head.t.y;
    for (const x of col) {
      if (lastY - x.t.y > Math.max(head.t.size, x.t.size) * 3.2) break;
      run.push(x);
      lastY = x.t.y;
    }
    if (run.filter((x) => x.m.thicknessMm != null).length < 3) continue;
    for (const x of run) used.add(x);
    const layers = run.flatMap((x) => Array.from({ length: x.m.plies || 1 }, () => ({ material: /슬래브/.test(x.t.t) ? '콘크리트' : x.m.name, category: /슬래브/.test(x.t.t) ? 'structure' : x.m.category, thicknessMm: x.m.thicknessMm })));
    out.push({ layers, pos: [head.t.x, head.t.y], top: head.t.y });
  }
  return out;
}

/**
 * @param {{ texts: any[], dims?: { value: number|null, p1: number[], p2: number[] }[] }} digest
 * @returns {{ details: { title: string, key: string, value: number|string, note: string, appliesTo: any, pos: number[] }[],
 *   compositions: { part: 'floor'|'wall'|'ceiling'|'roof', title: string, rooms: string[], layers: any[], pos: number[] }[], notes: string }}
 */
export function readDetails(digest) {
  const texts = (digest.texts || []).map((t) => ({ ...t, t: String(t.t).replace(/\s+/g, ' ').trim() })).filter((t) => t.t);
  const titles = texts.filter((t) => TITLE_RE.test(t.t) && !detailFromText(t.t) && t.t.length >= 3 && t.t.length <= 40 && !/^(도면|축척|날짜|공사명)/.test(t.t));
  const titleAbove = (x, y) => titles.filter((t) => t.y > y).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x) || (a.y - y) - (b.y - y))[0] || null;
  const dims = (digest.dims || []).filter((d) => d.value != null);
  const details = [];
  for (const t of texts) {
    if (titles.includes(t)) continue;
    const hit = detailFromText(t.t);
    if (!hit || !DETAIL_KEY_NAMES.includes(hit.key)) continue;
    // 제목: 이 글자보다 위에 있는 제목 중 가로로 가장 가까운 것(상세가 옆으로 늘어선 시트)
    const title = titleAbove(t.x, t.y);
    let value = hit.value;
    if (value == null && hit.key.endsWith('Mm')) {
      // 글자에 숫자가 없으면 가까운 치수
      const d = dims.map((x) => ({ x, d: Math.hypot((x.p1[0] + x.p2[0]) / 2 - t.x, (x.p1[1] + x.p2[1]) / 2 - t.y) })).filter((x) => x.d < t.size * 12).sort((a, b) => a.d - b.d)[0];
      value = d ? Math.round(d.x.value) : null;
    }
    if (value == null || value === '') continue;
    details.push({ title: (title?.t || '').slice(0, 80), key: hit.key, value, note: t.t.slice(0, 120), appliesTo: scopeOf(title?.t || ''), pos: [t.x, t.y] });
  }
  // 층 구성: 제목이 아닌 글자에서 쌓인 묶음을 찾고, 부위를 모르면 버린다
  const compositions = [];
  for (const s of readStacks(texts.filter((t) => !titles.includes(t)))) {
    const title = titleAbove(s.pos[0], s.top)?.t || '';
    const part = stackPart(s.layers.map((l) => l.material), title, s.layers);
    if (!part) continue;
    compositions.push({ part, title: title.slice(0, 80), rooms: scopeOf(title).rooms, layers: s.layers, pos: s.pos });
  }
  return { details, compositions, notes: '규칙: 상세 제목 단위로 지시선 글자(상세 사전)·치수·쌓인 층 구성 글자를 읽음' };
}

// 자재 종류(부위 → 종류) — 성적표에서 "찾은 종류"를 셀 때
export const compositionKinds = (c) => c.layers.map((l) => materialKind(l.material, c.part));
