// 구조도 읽기(38 지시서 3절 규칙): 구조 부재 일람표(기호·부재·두께·크기)와 구조 평면의 부재 기호 위치. 순수 함수.
// 철근 배근·접합 상세는 이번 범위 밖이다.
import { headerColumns } from '../cad/tables.js';

export const MEMBER_MARK = /^(W|SW|S|C|B|G|WB|TG)\d{1,3}[A-Z]?$/;
const KIND_WORDS = [['wall', /벽|WALL/i], ['slab', /슬래브|바닥판|SLAB/i], ['column', /기둥|COL/i], ['beam', /보|거더|GIRDER|BEAM/i]];
const KIND_PREFIX = { W: 'wall', SW: 'wall', S: 'slab', C: 'column', B: 'beam', G: 'beam', WB: 'beam', TG: 'beam' };

export function sizeOf(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const two = /(\d{2,4})[x×X*](\d{2,4})/.exec(s);
  if (two) return { sizeMm: [Number(two[1]), Number(two[2])], thicknessMm: null };
  const one = /(\d{2,4})/.exec(s.replace(/,/g, ''));
  return one ? { sizeMm: null, thicknessMm: Number(one[1]) } : { sizeMm: null, thicknessMm: null };
}

/**
 * @param {{ texts: any[], tables?: { rows: string[][], bbox: number[] }[] }} digest
 * @returns {{ members: { mark: string, kind: string, thicknessMm: number|null, sizeMm: number[]|null, note: string }[], planMarks: { mark: string, pos: number[] }[], notes: string }}
 */
export function readStructure(digest) {
  const members = [];
  const boxes = [];
  for (const t of digest.tables || []) {
    const h = headerColumns(t.rows, { mark: /^기호|^부호|MARK|^NO/i, kind: /^부재|구분|종류|TYPE/i, size: /두께|크기|규격|단면|SIZE|THK/i, note: /비고|REMARK/i });
    if (!h || h.cols.mark == null || h.cols.size == null) continue;
    boxes.push(t.bbox);
    for (const row of t.rows.slice(h.row + 1)) {
      const mark = String(row[h.cols.mark] || '').trim().toUpperCase();
      if (!MEMBER_MARK.test(mark) || members.some((m) => m.mark === mark)) continue;
      const kt = h.cols.kind != null ? String(row[h.cols.kind] || '') : '';
      const kind = KIND_WORDS.find(([, re]) => re.test(kt))?.[0] || KIND_PREFIX[/^[A-Z]+/.exec(mark)[0]] || 'other';
      members.push({ mark, kind, ...sizeOf(row[h.cols.size]), note: h.cols.note != null ? String(row[h.cols.note] || '').trim().slice(0, 60) : '' });
    }
  }
  const inBox = (t) => boxes.some((b) => t.x >= b[0] && t.x <= b[2] && t.y >= b[1] && t.y <= b[3]);
  const planMarks = (digest.texts || []).filter((t) => MEMBER_MARK.test(String(t.t).trim().toUpperCase()) && !inBox(t)).map((t) => ({ mark: String(t.t).trim().toUpperCase(), pos: [t.x, t.y] }));
  return { members, planMarks, notes: '규칙: 구조 부재 일람표 머리글(기호·부재·두께)과 평면의 부재 기호로 읽음' };
}
