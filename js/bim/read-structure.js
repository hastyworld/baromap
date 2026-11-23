// 구조도 읽기(38 지시서 3절, 43 지시서 2절). 순수 함수.
//   부재 일람표 세 모양
//   ① 머리글 표: "기호 | 부재 | 두께"가 한 머리글 줄에 있는 표
//   ② 가로형: "부호" 칸이 줄의 첫 칸이고 같은 줄에 기호가 늘어선다. 아래 줄(줄 머리 "두께·크기·층·배근")에서 열마다 값을 가져온다
//   ③ 카드형: 부재마다 칸 하나(기호, 단면 그림, 크기 글자, 배근 글자). 크기 글자는 카드 틀 맞추기(cardTemplate), 나머지는 기호 사이 간격의 중간(가장 가까운 기호)
//   + 구조 평면의 부재 기호 위치. 철근 배근·접합 상세는 범위 밖이다(원문 짧게만 note)
import { headerColumns } from '../cad/tables.js';
import { gridOf } from './struct-place.js';

// 부재 기호 모양: 층 앞붙이(숫자 1~2자리, B1, R, PH) + 영문 1~3자 + 번호 + 끝 글자(A·B). 통심·철근·재료 강도는 markParts()가 뺀다
export const MEMBER_MARK = /^(\d{1,2}|B\d|R|PH)?([A-Z]{1,3})(\d{1,3})([A-Z])?$/;
// 종류 사전(영문 부분). 사전에 없으면 앞의 구역 글자(A·P, 예: AW·PG·APF)를 떼고 다시 찾는다. 그래도 없으면 other
const KIND_OF = {
  W: 'wall', SW: 'wall', CW: 'wall', EW: 'wall', RW: 'wall',
  S: 'slab', PS: 'slab', DS: 'slab',
  C: 'column', TC: 'column', TRC: 'column',
  B: 'beam', G: 'beam', WG: 'beam', LB: 'beam', CB: 'beam', TG: 'beam', TRG: 'beam', WB: 'beam',
  F: 'footing', MF: 'footing', PF: 'footing',
};
const KIND_WORDS = [['wall', /벽|WALL/i], ['slab', /슬래브|바닥판|SLAB/i], ['column', /기둥|COL/i], ['footing', /기초|FOOT|MAT/i], ['beam', /보|거더|GIRDER|BEAM/i]];
const REBAR_DIA = new Set(['6', '8', '10', '13', '16', '19', '22', '25', '29', '32', '35', '38', '41', '51']);
const norm = (t) => String(t ?? '').toUpperCase().replace(/\s+/g, '');

export function kindOfLetters(letters) {
  let s = String(letters || '');
  for (let i = 0; i < 3 && s; i++) {
    if (KIND_OF[s]) return KIND_OF[s];
    if (s.length < 2 || !/^[AP]/.test(s)) break;
    s = s.slice(1);
  }
  return 'other';
}

/** 부재 기호면 { mark, floor, letters, kind }, 아니면 null(통심 X1·Y1, 철근 D10·HD13·SD22, 재료 SD400·SM490, 볼트 M16, 층 B1F·PH·R) */
export function markParts(text) {
  const v = norm(text);
  const g = MEMBER_MARK.exec(v);
  if (!g) return null;
  const [, floor, letters, num, suf] = g;
  if (/^[XY]$/.test(letters)) return null;
  if (/^(S?HD|UHD|D)$/.test(letters)) return null;
  if (letters === 'SD' && REBAR_DIA.has(num)) return null;
  if (/^(SM|SS|SN|SD|SHN|FY|FC|FCK)$/.test(letters) && num.length === 3) return null;
  if (letters === 'M' && num.length === 2) return null;
  if (letters === 'R' || letters === 'PH' || letters === 'THK' || (letters === 'T' && num.length === 3)) return null;
  if (letters === 'B' && suf === 'F' && !floor) return null;
  return { mark: v, floor: floor || null, letters, kind: kindOfLetters(letters) };
}
export const isMemberMark = (text) => Boolean(markParts(text));

// 한 글자에 기호 여럿: "W1, W2", "W1/W1A", 끝에 괄호 설명 "AW1(지하)", 범위 "W1A ~ W3A"(영문·끝 글자가 같고 10개 이하면 펼친다)
export function marksIn(text) {
  const strip = (x) => String(x).replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim();
  const parts = String(text ?? '').split(/[,，/]/).map(strip).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const r = part.split(/\s*[~∼～]\s*/);
    if (r.length === 2) {
      const a = markParts(r[0]);
      const b = markParts(r[1]);
      const na = a && Number(/(\d+)[A-Z]?$/.exec(a.mark)[1]);
      const nb = b && Number(/(\d+)[A-Z]?$/.exec(b.mark)[1]);
      const tail = (p) => p.mark.replace(/^.*?\d+(?=[A-Z]?$)/, '');
      if (!a || !b || a.letters !== b.letters || a.floor !== b.floor || tail(a) !== tail(b) || nb <= na || nb - na > 9) return [];
      for (let n = na; n <= nb; n++) out.push(markParts(`${a.floor || ''}${a.letters}${n}${tail(a)}`));
      continue;
    }
    const p = markParts(part);
    if (!p) return [];
    out.push(p);
  }
  return out.filter(Boolean);
}

const REBAR_IN = /(^|[^A-Z])(\d+-)?(S?HD|UHD|D)\d{1,2}(?!\d)|@\d/;
export const isRebarText = (t) => REBAR_IN.test(norm(t));

export function sizeOf(text) {
  let s = norm(text).replace(/(\d),(?=\d{3})/g, '$1');
  s = s.replace(/(?<![A-Z])(\d+-)?(S?HD|UHD|D)\d{1,2}(?!\d)(@\d+)?/g, ' ').replace(/@\d+/g, ' ');
  // 춤이 변하는 보(헌치): "400X600~900" → [폭, 큰 춤]
  const range = /(\d{2,4})[X×*](\d{2,4})~(\d{2,4})/.exec(s);
  if (range) return { sizeMm: [Number(range[1]), Math.max(Number(range[2]), Number(range[3]))], thicknessMm: null };
  const two = /(\d{2,4})[X×*](\d{2,4})/.exec(s);
  if (two) return { sizeMm: [Number(two[1]), Number(two[2])], thicknessMm: null };
  const one = /(\d{2,4})/.exec(s);
  return one ? { sizeMm: null, thicknessMm: Number(one[1]) } : { sizeMm: null, thicknessMm: null };
}

/** 크기 글자 모양: 'two'(400x600) · 'thk'(THK200, T=250) · 'bare'(200) · null */
export function sizeText(text) {
  const v = norm(text).replace(/(\d),(?=\d{3})/g, '$1').replace(/MM$/, '').replace(/^\((.*)\)$/, '$1');
  if (!v || isRebarText(v)) return null;
  if (/^([A-Z×*]{1,5}[=:])?\d{2,4}[X×*]\d{2,4}(~\d{2,4})?$/.test(v)) return 'two';
  if (/^(THK|T|Ø|∅|D)\.?[=:]?\d{2,4}$/.test(v)) return 'thk';
  if (/^\d{3,4}$/.test(v) && Number(v) >= 80 && Number(v) <= 3000) return 'bare';
  return null;
}

// 층 범위 글자: "1~5F", "B2F~1F", "6F~", "6F~PH", "지하1층~지상2층", "기준층", "PH"
const FL = '(?:B\\d{1,2}|지하\\d{1,2}|지상\\d{1,2}|\\d{1,2}|PH\\d?|R|지붕|옥탑|최상)';
const FLOOR_RANGE = new RegExp(`^${FL}(?:F|층)?[~∼～]${FL}?(?:F|층)?$`);
const FLOOR_ONE = /^(B\d{1,2}F|\d{1,2}F|PH\d?F?|RF|지붕층?|옥탑층?|기준층|최상층|지하\d{1,2}층|\d{1,2}층|기초)$/;
export function floorRange(text) {
  const v = norm(text).replace(/^[([（]|[)\]）]$/g, '').replace(/[∼～]/g, '~');
  return FLOOR_RANGE.test(v) || FLOOR_ONE.test(v) ? v : null;
}

// 일람표만 있는 시트(카드형을 읽는다). 평면이 함께 있으면 표·가로형만 읽고 나머지 기호는 평면 기호다
export function isScheduleSheet(digest, sheet = {}) {
  const title = String(sheet.title || digest.titleBlock?.title || '');
  const name = `${title} ${String(digest.file || '').split(/[\\/]/).pop()}`;
  if (/평면|PLAN/i.test(title)) return false;
  return /일람|리스트|LIST|SCHEDULE/i.test(name);
}

// 평면 기호를 읽는 시트: 일반사항·개요·범례·상세·단면은 주석·그림 속 기호라 평면 위치가 아니다
export function isPlanLike(digest, sheet = {}) {
  const title = String(sheet.title || digest.titleBlock?.title || '');
  const name = title.trim() ? title : String(digest.file || '').split(/[\\/]/).pop();
  if (/평면|PLAN/i.test(name)) return true;
  return !/일반\s*사항|개요|NOTE|범례|LEGEND|상세|DETAIL|단면|SECTION|목록|INDEX/i.test(name);
}

const LABEL = {
  size: /두께|크기|규격|SIZE|THK|THICK|B[X×*]D|D[X×*]B|단면/,
  floor: /층|위치|FLOOR|LEVEL|구간/,
  rebar: /배근|주근|늑근|상부|하부|중앙|단부|STIRRUP|TOP|BOT|HOOP|띠철근|수직|수평|REBAR|철근|전단/,
  note: /비고|REMARK|NOTE/,
};
const HEAD_MARK_WORD = /^(부호|기호|MARK|SYMBOL|구분|부재명|부재기호)$/;
const labelKind = (v) => (LABEL.size.test(v) ? 'size' : LABEL.floor.test(v) ? 'floor' : LABEL.rebar.test(v) ? 'rebar' : LABEL.note.test(v) ? 'note' : 'other');
const sizeScore = (v) => (/B[X×*]D|D[X×*]B|크기|규격|SIZE/.test(v) ? 3 : /두께|THK|THICK/.test(v) ? 2 : 1);
const PREF = { two: 0, thk: 1, bare: 2 };
const noteOf = (list) => list.map((t) => String(t.t).trim()).filter(Boolean).join(' / ').slice(0, 60);

function member(p, extra) {
  return { mark: p.mark, kind: p.kind, thicknessMm: null, sizeMm: null, floors: [], note: '', ...extra };
}
// 크기 글자 → 두께·크기. 벽·슬래브·기초는 한 값(두께), 기둥·보는 두 값(크기). 한 값뿐인 기둥은 지름·정사각으로 두께에 둔다
function sizeFrom(t) {
  if (!t) return {};
  const r = sizeOf(t.t);
  return r.sizeMm || r.thicknessMm ? r : {};
}
const bboxOf = (pts, h) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return [Math.min(...xs) - h, Math.min(...ys) - h, Math.max(...xs) + h, Math.max(...ys) + h].map((v) => Math.round(v * 10) / 10);
};

const BARE_OK = new Set(['wall', 'slab', 'footing', 'other']); // 숫자만 있는 글자를 두께로 받는 종류

/**
 * 카드 틀 맞추기: 같은 시트·같은 종류의 카드는 같은 틀이라, 기호에서 크기 글자까지의 어긋남(글자 높이 단위)이 같다.
 * 기호마다 둘레(글자 높이 40배)의 크기 글자 어긋남을 모아, 그 근처(±3h)에 글자가 있는 기호가 가장 많은 어긋남을 고르고, 기호마다 그 자리(4h 안)의 글자를 쓴다.
 * 이웃 카드의 크기 글자가 더 가까워도 틀이 같으면 제 것을 고른다. THK·가로×세로 글자로 먼저, 없으면 숫자만 있는 글자(벽·슬래브·기초)로.
 * @returns {{ picks: Map<any, any>, strong: Set<string> }} 기호 → 크기 글자, THK·가로×세로로 맞춘 종류
 */
export function cardTemplate(marks, cands, { R = 40 } = {}) {
  const picks = new Map();
  const strong = new Set();
  // 기호마다 둘레 크기 글자의 어긋남. 어긋남 후보마다 "그 근처(±3h)에 글자가 있는 기호 수"를 센다.
  // 1위와 겨루는 다른 어긋남(3h 넘게 떨어진 것)이 같은 수면 틀을 모른다(예: 윗줄 카드의 글자와 제 글자가 같은 수)
  const offsetOf = (group, pool) => {
    const offs = group.map((m) => pool.map((c) => [(c.t.x - m.t.x) / m.h, (c.t.y - m.t.y) / m.h]).filter(([dx, dy]) => Math.hypot(dx, dy) <= R));
    const hits = (o) => offs.map((list) => list.find(([dx, dy]) => Math.abs(dx - o[0]) <= 3 && Math.abs(dy - o[1]) <= 3)).filter(Boolean);
    const all = offs.slice(0, 30).flat().map((o) => ({ o, n: hits(o).length }));
    // 같은 수면 아래쪽(카드는 기호 아래에 쓰는 일이 많다), 그다음 가까운 것
    all.sort((a, b) => b.n - a.n || (a.o[1] <= 0 ? 0 : 1) - (b.o[1] <= 0 ? 0 : 1) || Math.hypot(...a.o) - Math.hypot(...b.o));
    const best = all[0];
    if (!best || best.n < Math.max(2, Math.ceil(group.length / 2))) return null;
    const rival = all.find((x) => Math.abs(x.o[0] - best.o[0]) > 3 || Math.abs(x.o[1] - best.o[1]) > 3);
    if (rival && rival.n >= best.n) return null;
    const hs = hits(best.o);
    return [hs.reduce((a, q) => a + q[0], 0) / hs.length, hs.reduce((a, q) => a + q[1], 0) / hs.length];
  };
  const apply = (group, pool, [ox, oy]) => {
    for (const m of group) {
      if (picks.has(m)) continue;
      const pick = pool.map((c) => ({ c, d: Math.hypot((c.t.x - m.t.x) / m.h - ox, (c.t.y - m.t.y) / m.h - oy) })).filter((x) => x.d <= 4).sort((x, y) => x.d - y.d)[0];
      if (pick) picks.set(m, pick.c.t);
    }
  };
  const strongPool = cands.filter((c) => c.k !== 'bare');
  const barePool = cands.filter((c) => c.k === 'bare');
  // ① 종류마다(카드 모양이 종류마다 다를 수 있다)
  const byKind = new Map();
  for (const m of marks) { if (!byKind.has(m.p.kind)) byKind.set(m.p.kind, []); byKind.get(m.p.kind).push(m); }
  for (const [kind, group] of byKind) {
    if (group.length < 2) continue;
    const o = strongPool.length ? offsetOf(group, strongPool) : null;
    if (o) { apply(group, strongPool, o); strong.add(kind); continue; }
    if (!BARE_OK.has(kind) || !barePool.length) continue;
    const ob = offsetOf(group, barePool);
    if (ob) apply(group, barePool, ob);
  }
  // ② 시트 전체(종류만으로는 기호가 적거나 틀이 갈린 기호): 모든 기호로 THK·가로×세로 글자 틀을 세운다
  const rest = marks.filter((m) => !picks.has(m));
  if (rest.length && marks.length >= 2 && strongPool.length) {
    const o = offsetOf(marks, strongPool);
    if (o) { apply(rest, strongPool, o); for (const m of rest) if (picks.has(m)) strong.add(m.p.kind); }
  }
  return { picks, strong };
}

/**
 * @param {{ texts: any[], tables?: { rows: string[][], bbox: number[] }[], titleBlock?: any, file?: string }} digest
 * @param {{ title?: string }} [sheet]
 * @returns {{ members: { mark: string, kind: string, thicknessMm: number|null, sizeMm: number[]|null, floors: string[], note: string, pos?: number[], bbox?: number[] }[], planMarks: { mark: string, pos: number[] }[], notes: string }}
 */
export function readStructure(digest, sheet = {}) {
  const members = [];
  const keyOf = (m) => `${m.mark}|${(m.floors || []).join(',')}`;
  const add = (m) => {
    const i = members.findIndex((x) => keyOf(x) === keyOf(m));
    if (i < 0) members.push(m);
    else if (!members[i].thicknessMm && !members[i].sizeMm && (m.thicknessMm || m.sizeMm)) members[i] = m; // 값 없는 것보다 값 있는 것
  };
  const boxes = []; // 표·가로형이 차지한 자리(평면 기호·카드에서 뺀다)
  const texts = digest.texts || [];
  const used = new Set();

  // ① 머리글 표
  for (const t of digest.tables || []) {
    const h = headerColumns(t.rows, { mark: /^기호|^부호|MARK|^NO/i, kind: /^부재|구분|종류|TYPE/i, size: /두께|크기|규격|단면|SIZE|THK/i, floor: /층|위치|FLOOR/i, note: /비고|REMARK/i });
    if (!h || h.cols.mark == null || h.cols.size == null) continue;
    boxes.push(t.bbox);
    for (const row of t.rows.slice(h.row + 1)) {
      const p = markParts(row[h.cols.mark]);
      if (!p) continue;
      const kt = h.cols.kind != null ? String(row[h.cols.kind] || '') : '';
      const kind = KIND_WORDS.find(([, re]) => re.test(kt))?.[0] || p.kind;
      const fl = h.cols.floor != null ? floorRange(row[h.cols.floor]) : null;
      add(member({ ...p, kind }, { ...sizeOf(row[h.cols.size]), floors: fl ? [fl] : [], note: h.cols.note != null ? String(row[h.cols.note] || '').trim().slice(0, 60) : '', how: 'table' }));
    }
  }
  const inBox = (t) => boxes.some((b) => t.x >= b[0] && t.x <= b[2] && t.y >= b[1] && t.y <= b[3]);

  // 기호 글자(표 밖)
  const marks = [];
  for (const t of texts) {
    if (inBox(t)) continue;
    for (const p of marksIn(t.t)) marks.push({ t, p, h: t.size || 1 });
  }

  // ② 가로형: "부호" 머리글과 같은 줄 오른쪽에 기호 2개 이상(다음 머리글 전까지)
  const heads = texts.filter((t) => HEAD_MARK_WORD.test(norm(t.t)) && !inBox(t));
  const rows = [];
  for (const hd of heads) {
    const h = hd.size || 1;
    const stop = Math.min(...heads.filter((o) => o !== hd && Math.abs(o.y - hd.y) <= 0.6 * h && o.x > hd.x).map((o) => o.x), Infinity);
    const ms = marks.filter((m) => Math.abs(m.t.y - hd.y) <= 0.6 * h && m.t.x > hd.x && m.t.x < stop).sort((a, b) => a.t.x - b.t.x);
    if (ms.length >= 2) rows.push({ hd, h, ms });
  }
  for (const r of rows) {
    const { hd, h, ms } = r;
    const xs = ms.map((m) => m.t.x);
    const cols = ms.map((m, i) => ({
      m,
      lo: i ? (xs[i - 1] + xs[i]) / 2 : xs[0] - (xs[1] - xs[0]) / 2,
      hi: i < xs.length - 1 ? (xs[i] + xs[i + 1]) / 2 : xs[i] + (xs[i] - xs[i - 1]) / 2,
    }));
    const x1 = cols[cols.length - 1].hi;
    // 아래 끝: 가로로 겹치는 다음 머리줄, 없으면 줄 머리가 끝나는 곳(없으면 글자 높이 40배)
    const nextY = Math.max(...rows.filter((o) => o !== r && o.hd.y < hd.y - h && o.hd.x < x1 && o.ms[o.ms.length - 1].t.x > hd.x).map((o) => o.hd.y + o.h * 0.6), -Infinity);
    const labelXs = [hd.x - 6 * h, cols[0].lo];
    const rawLabels = texts.filter((t) => t !== hd && t.x >= labelXs[0] && t.x < labelXs[1] && t.y < hd.y - 0.6 * h && t.y > nextY && /[가-힣A-Z]/i.test(t.t) && !markParts(t.t));
    // 여러 줄로 쓴 줄 머리는 하나로
    rawLabels.sort((a, b) => b.y - a.y);
    const labels = [];
    for (const t of rawLabels) {
      const last = labels[labels.length - 1];
      if (last && last.y - t.y <= 1.6 * Math.max(h, t.size || 1) && labelKind(norm(t.t)) === 'other') { last.text += ` ${t.t}`; last.ys.push(t.y); continue; }
      labels.push({ y: t.y, ys: [t.y], text: String(t.t) });
    }
    for (const l of labels) { l.y = l.ys.reduce((a, b) => a + b, 0) / l.ys.length; const v = norm(l.text); l.kind = labelKind(v); l.score = l.kind === 'size' ? sizeScore(v) : 0; }
    const yEnd = Number.isFinite(nextY) ? nextY : labels.length ? labels[labels.length - 1].y - 3 * h : hd.y - 40 * h;
    // 줄 머리마다 띠(위·아래 이웃 줄 머리와의 가운데)
    labels.forEach((l, i) => {
      l.top = i ? (labels[i - 1].y + l.y) / 2 : (hd.y + l.y) / 2;
      l.bottom = i < labels.length - 1 ? (l.y + labels[i + 1].y) / 2 : Math.max(yEnd, l.y - (l.top - l.y));
    });
    // 층 줄 머리가 둘 이상이면 층마다 묶음(층 → 크기 → 배근 …)
    const floorIdx = labels.map((l, i) => (l.kind === 'floor' ? i : -1)).filter((i) => i >= 0);
    const groups = floorIdx.length >= 2 ? floorIdx.map((s, k) => labels.slice(k ? s : 0, floorIdx[k + 1] ?? labels.length)) : [labels];
    boxes.push([hd.x - 6 * h, yEnd, x1, hd.y + h]);
    for (const c of cols) {
      used.add(c.m);
      const inCol = texts.filter((t) => t.x >= c.lo && t.x < c.hi && t.y < c.m.t.y - 0.3 * h && t.y > yEnd && t !== c.m.t);
      const inBand = (l) => inCol.filter((t) => t.y <= l.top && t.y > l.bottom);
      for (const g of groups) {
        let val = null;
        let how = 'row';
        for (const l of g.filter((x) => x.kind === 'size').sort((a, b) => b.score - a.score)) {
          val = inBand(l).filter((t) => sizeText(t.t)).sort((a, b) => PREF[sizeText(a.t)] - PREF[sizeText(b.t)] || b.t.y - a.t.y)[0] || null;
          if (val) break;
        }
        // 크기를 못 읽은 크기 줄 글자(예: "폭 X 변단면")는 원문을 비고 앞에 남긴다
        const rawSize = val ? null : g.filter((x) => x.kind === 'size').flatMap(inBand).find((t) => /\d{2,4}\s*[X×*]\s*[가-힣(]/i.test(String(t.t)));
        const floorTexts = g.filter((x) => x.kind === 'floor').flatMap(inBand).map((t) => floorRange(t.t)).filter(Boolean);
        const rebar = g.filter((x) => x.kind === 'rebar').flatMap(inBand).filter((t) => isRebarText(t.t));
        if (!val && groups.length === 1) {
          // 크기 줄 머리가 없거나 비었으면: 열 안에서 두 값·THK 글자(벽·슬래브·기초는 숫자만도) 중 기호에 가장 가까운 것
          const ok = (t) => { const k = sizeText(t.t); return k === 'two' || k === 'thk' || (k === 'bare' && ['wall', 'slab', 'footing'].includes(c.m.p.kind)); };
          val = inCol.filter(ok).sort((a, b) => PREF[sizeText(a.t)] - PREF[sizeText(b.t)] || Math.hypot(a.x - c.m.t.x, a.y - c.m.t.y) - Math.hypot(b.x - c.m.t.x, b.y - c.m.t.y))[0] || null;
          how = 'row-near';
        }
        let floors = [...new Set(floorTexts)];
        if (!floors.length && groups.length === 1) floors = [...new Set(inCol.map((t) => floorRange(t.t)).filter(Boolean))];
        if (floors.length > 1 && groups.length === 1) floors = floors.slice(0, 3);
        if (!val && !rebar.length && groups.length > 1 && !floors.length) continue;
        add(member(c.m.p, { ...sizeFrom(val), floors, note: noteOf([...(rawSize ? [rawSize] : []), ...(rebar.length ? rebar : inCol.filter((t) => isRebarText(t.t)).slice(0, 3))]), pos: [c.m.t.x, c.m.t.y], bbox: bboxOf([c.m.t, ...(val ? [val] : [])], h), how, valueKind: val ? sizeText(val.t) : null }));
      }
    }
  }
  const inUsed = (t) => boxes.some((b) => t.x >= b[0] && t.x <= b[2] && t.y >= b[1] && t.y <= b[3]);

  // ③ 카드형(일람표 시트에서만). 크기 글자는 카드 틀 맞추기(cardTemplate)로, 못 맞춘 기호와 층·배근 글자는 가장 가까운 기호(글자 높이 25배 안)로
  const schedule = isScheduleSheet(digest, sheet);
  const free = marks.filter((m) => !used.has(m) && !inUsed(m.t));
  if (schedule && free.length) {
    const own = new Map(free.map((m) => [m, { size: [], floor: [], rebar: [] }]));
    const sizeCands = [];
    for (const t of texts) {
      if (inUsed(t) || markParts(t.t)) continue;
      const sk = sizeText(t.t);
      const fl = sk ? null : floorRange(t.t);
      const rb = sk || fl ? false : isRebarText(t.t);
      if (!sk && !fl && !rb) continue;
      if (sk) sizeCands.push({ t, k: sk });
      let best = null;
      for (const m of marks) {
        // 아래쪽 글자를 조금 더 가깝게(카드는 기호 아래에 크기를 쓰는 일이 많다)
        const d = Math.hypot(t.x - m.t.x, (t.y - m.t.y) * (t.y > m.t.y ? 1.3 : 1));
        if (!best || d < best.d) best = { m, d };
      }
      if (!best || !own.has(best.m) || best.d > 25 * best.m.h) continue;
      const o = own.get(best.m);
      if (sk) o.size.push({ t, k: sk, d: best.d }); else if (fl) o.floor.push(fl); else o.rebar.push(t);
    }
    const { picks, strong } = cardTemplate(free, sizeCands);
    for (const [m, o] of own) {
      // 틀이 THK·가로×세로 글자로 맞춰진 종류면, 못 맞춘 기호도 숫자만 있는 글자(치수 글자일 때가 많다)는 쓰지 않는다
      const allowBare = BARE_OK.has(m.p.kind) && !strong.has(m.p.kind);
      const near = o.size.filter((x) => x.k !== 'bare' || allowBare).sort((a, b) => PREF[a.k] - PREF[b.k] || a.d - b.d)[0]?.t || null;
      const val = picks.get(m) || near;
      if (!val && !o.rebar.length) continue; // 크기도 배근도 없는 기호는 주석 속 기호
      add(member(m.p, { ...sizeFrom(val), floors: [...new Set(o.floor)].slice(0, 3), note: noteOf(o.rebar.slice(0, 3)), pos: [m.t.x, m.t.y], bbox: bboxOf([m.t, ...(val ? [val] : [])], m.h), how: picks.has(m) ? 'card' : 'card-near', valueKind: val ? sizeText(val.t) : null }));
      used.add(m);
    }
  }

  // 평면 기호: 일람표 시트가 아니고 평면 같은 시트면 표·가로형 밖의 기호(글자 방향 rot은 벽 방향 맞추기에, 통심 글자는 좌표 맞추기에 — 43 지시서 3절)
  const plan = !schedule && isPlanLike(digest, sheet);
  const planMarks = plan ? marks.filter((m) => !used.has(m) && !inUsed(m.t)).map((m) => ({ mark: m.p.mark, pos: [m.t.x, m.t.y], ...(m.t.rot ? { rot: m.t.rot } : {}) })) : [];
  return { members, planMarks, ...(planMarks.length ? { grid: gridOf(texts) } : {}), notes: '규칙: 구조 부재 일람표(머리글 표·가로형·카드형)와 평면의 부재 기호로 읽음' };
}
