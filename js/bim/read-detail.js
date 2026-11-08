// 시공 상세도 읽기(38 지시서 2·4절 규칙): 상세 제목(①, 1/A-801, "… 상세") 단위로 나누고, 지시선 글자와 치수를 상세 값 키에 잇는다. 순수 함수.
// 값이 없으면 넣지 않는다. 적용 범위는 제목의 창호 기호·실 이름·부위에서 정한다.
import { detailFromText } from '../cad/detail-words.js';
import { DETAIL_KEY_NAMES } from './detail-keys.js';

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

/**
 * @param {{ texts: any[], dims?: { value: number|null, p1: number[], p2: number[] }[] }} digest
 * @returns {{ details: { title: string, key: string, value: number|string, note: string, appliesTo: any, pos: number[] }[], notes: string }}
 */
export function readDetails(digest) {
  const texts = (digest.texts || []).map((t) => ({ ...t, t: String(t.t).replace(/\s+/g, ' ').trim() })).filter((t) => t.t);
  const titles = texts.filter((t) => TITLE_RE.test(t.t) && !detailFromText(t.t) && t.t.length >= 3 && t.t.length <= 40 && !/^(도면|축척|날짜|공사명)/.test(t.t));
  const dims = (digest.dims || []).filter((d) => d.value != null);
  const details = [];
  for (const t of texts) {
    if (titles.includes(t)) continue;
    const hit = detailFromText(t.t);
    if (!hit || !DETAIL_KEY_NAMES.includes(hit.key)) continue;
    // 제목: 이 글자보다 위에 있는 제목 중 가로로 가장 가까운 것(상세가 옆으로 늘어선 시트)
    const title = titles.filter((x) => x.y > t.y).sort((a, b) => Math.abs(a.x - t.x) - Math.abs(b.x - t.x) || (a.y - t.y) - (b.y - t.y))[0] || null;
    let value = hit.value;
    if (value == null && hit.key.endsWith('Mm')) {
      // 글자에 숫자가 없으면 가까운 치수
      const d = dims.map((x) => ({ x, d: Math.hypot((x.p1[0] + x.p2[0]) / 2 - t.x, (x.p1[1] + x.p2[1]) / 2 - t.y) })).filter((x) => x.d < t.size * 12).sort((a, b) => a.d - b.d)[0];
      value = d ? Math.round(d.x.value) : null;
    }
    if (value == null || value === '') continue;
    details.push({ title: (title?.t || '').slice(0, 80), key: hit.key, value, note: t.t.slice(0, 120), appliesTo: scopeOf(title?.t || ''), pos: [t.x, t.y] });
  }
  return { details, notes: '규칙: 상세 제목 단위로 지시선 글자(상세 사전)·치수를 읽음' };
}
