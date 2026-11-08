// 벡터 PDF 공정표 읽기(28 지시서 1절 6). 가장 믿기 어려워서 곧바로 계산에 쓰지 않고 초안으로 만든다 — 사람이 확인한 뒤 저장.
// 입력은 pdf.js가 꺼낸 글자 조각(쪽마다 { items: [{ str, x, y, w, h }] }, y는 위에서 아래). 표 머리글(작업명·시작·종료)을 찾아
// 열 위치를 정하고, 날짜가 있는 줄을 공정 행으로 읽는다. 막대만 있고 날짜 글자가 없는 PDF는 아직 읽지 못한다(AI·사람 몫).
import { activity, isoDate } from './core.js';

const HEAD = {
  actId: /^(작업\s*ID|ID|번호|코드|Activity\s*ID)$/i,
  name: /^(작업명|작업\s*이름|공종명|공정명|내용|Task\s*Name|Name|Activity\s*Name)$/i,
  start: /^(시작|시작일|착수|착수일|Start)$/i,
  finish: /^(종료|종료일|완료|완료일|Finish|End)$/i,
};
const DATE_RE = /(\d{4}|\d{2})[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}/;

/** 글자 조각 → 줄(같은 높이끼리, 왼쪽부터) */
export function pdfLines(items) {
  const list = items.filter((i) => i.str && i.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of list) {
    const tol = Math.max(2, (it.h || 8) * 0.45);
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.y - b.y);
}

/**
 * @param {{ items: { str: string, x: number, y: number, w: number, h: number }[] }[]} pages
 * @returns {{ format: 'pdf', draft: true, activities: any[], warnings: string[] }}
 */
export function readPdfSchedule(pages) {
  const acts = [];
  const warnings = ['PDF에서 읽은 초안입니다. 원본과 비교해 확인한 뒤 저장해주세요.'];
  let cols = null;
  pages.forEach((page, pi) => {
    for (const line of pdfLines(page.items || [])) {
      const head = {};
      for (const it of line.items) for (const [f, re] of Object.entries(HEAD)) if (!(f in head) && re.test(it.str.trim())) head[f] = it.x;
      if ('name' in head && 'start' in head && 'finish' in head) {
        // 머리글 가운데 위치(머리글이 가운데 정렬이든 왼쪽 정렬이든 가장 가까운 머리글로 보낸다)
        cols = Object.entries(head).map(([f]) => { const it = line.items.find((i) => HEAD[f].test(i.str.trim())); return { f, c: it.x + (it.w || 0) / 2 }; });
        continue;
      }
      const texts = line.items.map((i) => i.str.trim());
      const dates = texts.map((t) => (DATE_RE.test(t) ? isoDate(DATE_RE.exec(t)[0].replace(/\s/g, '')) : null));
      if (dates.filter(Boolean).length < 2) continue;
      let row = {};
      if (cols) {
        const near = (it, fields) => fields.map((f) => cols.find((c) => c.f === f)).filter(Boolean)
          .sort((a, b) => Math.abs(a.c - (it.x + (it.w || 0) / 2)) - Math.abs(b.c - (it.x + (it.w || 0) / 2)))[0]?.f;
        line.items.forEach((it, i) => {
          const t = it.str.trim();
          // 날짜는 시작·종료 열로, 나머지는 작업ID(공백 없는 짧은 기호일 때)나 작업명으로
          let f = dates[i] ? near(it, ['start', 'finish']) : /^[A-Za-z0-9][\w.-]{0,30}$/.test(t) && !row.actId ? near(it, ['actId', 'name']) : 'name';
          if (dates[i] && row[f]) f = f === 'start' ? 'finish' : f;
          row[f] = row[f] ? `${row[f]} ${t}` : t;
        });
      } else {
        const ds = dates.filter(Boolean);
        row = { name: texts.filter((t, i) => !dates[i]).join(' '), start: ds[0], finish: ds[1] };
      }
      const start = isoDate(row.start && DATE_RE.exec(row.start)?.[0]) || dates.find(Boolean);
      const finish = isoDate(row.finish && DATE_RE.exec(row.finish)?.[0]) || dates.filter(Boolean)[1];
      const name = String(row.name || '').trim();
      if (!name) continue;
      acts.push(activity({ actId: row.actId || '', name, start, finish, source: { page: pi + 1, y: Math.round(line.y) } }));
    }
  });
  if (!acts.length) warnings.push('날짜가 적힌 공정 행을 찾지 못했습니다. 막대만 그린 PDF는 아직 읽지 못합니다. 엑셀이나 MS Project XML로 받아 주세요.');
  return { format: 'pdf', draft: true, activities: acts, warnings };
}
