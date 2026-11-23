// 건물 선 가려내기(19 지시서): 시트의 개체마다 건물인지 판별한다. 치수·통심선·각주·표·도곽은 걷어내고 건물 선만 남긴다.
// 레이어 이름은 맨 마지막 참고다. 레이어가 벽이어도 모양이 치수면 치수다. 순수 함수(워커·Node 공용).
//
// 판정은 세 층이다: 규칙(rule) < AI(ai) < 사람(human). 따로 저장해 어느 쪽이 정했는지 보이고, 다시 분석해도 사람 판정은 남는다.
// 개체는 "무리"로 묶는다. 같은 (레이어·선 종류·색·개체 종류·블록·모양·규칙 판정)이면 한 무리고, AI·사람은 무리 단위로 고친다.
import { boxOf } from './geom.js';
import { CLASSES, PARTS, clusterVerdict, countClasses, applyAi, clusterTable } from '../bim/triage-core.js';

export { CLASSES, PARTS, clusterVerdict, countClasses, applyAi, clusterTable };
export const CLASS_LABEL = { building: '건물', furnishing: '가구·기구', hidden: '숨은선', text: '글자', dimension: '치수', grid: '통심선', annotation: '각주·기호', table: '표', frame: '도곽', unknown: '모름' };
export const WHY_LABEL = {
  block_title: '도곽 블록', block_door: '문 블록(호 또는 이름)', block_window: '창 블록(평행선 또는 이름)', block_column: '기둥 블록', block_mark: '기호 블록(방위표·단면 기호 등)',
  block_furn: '가구·위생기구 블록', block_small: '작은 기호 블록', dim: '치수 개체', leader: '인출선 개체', text: '글자 개체',
  frame_line: '도곽 테두리', frame_zone: '표제란 영역', table: '표 격자', lt_center: '중심선 선 종류', lt_hidden: '숨은선 선 종류', grid_bubble: '끝에 번호 원이 붙은 긴 선',
  dim_exploded: '폭발된 치수(나란한 보조선·눈금·숫자)', leader_shape: '글자로 이어지는 꺾인 선', wall_pair: '평행 이중선이 벽처럼 이어짐', wall_hatch: '벽 두께의 해치',
  point: '점 개체', layer: '레이어 이름', none: '규칙으로 정하지 못함', memory: '이 현장의 이전 판정',
};

const PLAN = new Set(['floor_plan', 'unit_plan', 'facility_plan']);
const TITLE_NAME = /도곽|TITLE|BORDER|FORM|FRAME|SHEET/i;
const TITLE_TAG = /^(DWG_?NO|SHEET_?NO|TITLE|SCALE|PROJECT|도면\s*번호|도면\s*명|축척)$/i;
const TITLE_LABEL = /^(도면\s*번호|도면\s*명|축척|공사명|날짜|일자|PROJECT|TITLE|SCALE|DATE|DWG\.?\s*NO\.?)$/i;
const NAME_DOOR = /DOOR|^문|[-_]문|^S?D\d|^WD|^FD/i;
const NAME_WINDOW = /WIN|GLAZ|창호|^창|^AW|^PW/i;
const NAME_COLUMN = /COL|기둥/i;
const NAME_MARK = /NORTH|방위|SECT|단면|ELEV|입면|LEVEL|레벨|DETAIL|상세|MARK|SYMB|기호|REV|구름|CLOUD|BUBBLE|TAG/i;
const NAME_FURN = /SOFA|BED|TOILET|^WC|BATH|SINK|LAV|TUB|^CAR|FURN|가구|위생|변기|욕조|세면|싱크|소파|침대|책상|식탁|주차|차량/i;
const LT_CENTER = /CENTER|PHANTOM|DASHDOT|CHAIN|DIVIDE|일점|이점/i;
const LT_HIDDEN = /HIDDEN|DASHED|DOT|숨은|파선/i;
const NUMBER = /^[\d,]+(\.\d+)?(\s*mm)?$/i;
const BUBBLE_TEXT = /^[A-Z가-힣]{0,2}-?\d{0,3}[A-Z]?$/;

const ROLE_MAP = {
  wall: ['building', 'wall'], wall_hatch: ['building', 'wall'], column: ['building', 'column'], door: ['building', 'door'], window: ['building', 'window'], curtain_wall: ['building', 'window'],
  stair: ['building', 'stair'], elevator: ['building', 'core'], slab_edge: ['building', 'slab_edge'], insulation: ['building', 'finish'], masonry: ['building', 'finish'], waterproof: ['building', 'finish'],
  building_outline: ['building', 'building_outline'], site_boundary: ['building', 'site_boundary'], road: ['building', 'road'], landscape: ['building', 'landscape'], underground: ['building', 'underground'],
  furniture: ['furnishing', null], grid: ['grid', null], dimension: ['dimension', null], frame: ['frame', null],
  annotation: ['annotation', null], wall_tag: ['annotation', null], door_tag: ['annotation', null], window_tag: ['annotation', null], finish_tag: ['annotation', null],
  room_name: ['annotation', null], room_area: ['annotation', null], unit_label: ['annotation', null], building_label: ['annotation', null], level_mark: ['annotation', null], unit_boundary: ['annotation', null],
};
const WALLISH = new Set(['wall', 'wall_hatch', 'ignore', undefined]);

const hypot = Math.hypot;
const parents = (h) => {
  const parts = String(h).replace(/#\d+\.\d+/g, '').split('/');
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
};
const normH = (h) => String(h).replace(/#\d+\.\d+/g, '');

// 곧은 선분 목록(호·원·곡선은 제외)
function segmentsOf(it) {
  if (it.k !== 'path' || !it.pts || it.pts.length < 2) return [];
  if (['arc', 'circle', 'ellipse', 'spline'].includes(it.src)) return [];
  const out = [];
  const n = it.closed ? it.pts.length : it.pts.length - 1;
  for (let i = 0; i < n; i++) out.push([it.pts[i], it.pts[(i + 1) % it.pts.length]]);
  return out;
}

// 칸으로 나눈 찾기(선분이 많아도 가까운 것만 본다). 선분은 실제로 지나는 칸에만 넣는다
// (상자 칸 전체에 넣으면 긴 대각선이 칸을 잔뜩 차지하고, 그래서 따로 둔 "긴 선" 목록을 찾을 때마다 복사해 큰 시트에서 판별이 수십 분 걸렸다)
function spatial(segs, cell) {
  const g = new Map();
  const key = (x, y) => x * 1000003 + y; // 숫자 열쇠(문자열보다 빠르다)
  const long = [];
  segs.forEach((s, i) => {
    const L = hypot(s.bx - s.ax, s.by - s.ay);
    const n = Math.ceil(L / (cell / 4));
    if (n > 200000) { long.push(i); return; } // 50km 넘는 선(좌표 오류)만 따로
    let last = null;
    for (let k = 0; k <= n; k++) {
      const t = n ? k / n : 0;
      const kk = key(Math.floor((s.ax + (s.bx - s.ax) * t) / cell), Math.floor((s.ay + (s.by - s.ay) * t) / cell));
      if (kk === last) continue;
      last = kk;
      const list = g.get(kk);
      if (!list) g.set(kk, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    }
  });
  return {
    near(x, y, r) {
      const out = new Set(long);
      for (let cx = Math.floor((x - r) / cell); cx <= Math.floor((x + r) / cell); cx++) {
        for (let cy = Math.floor((y - r) / cell); cy <= Math.floor((y + r) / cell); cy++) {
          for (const i of g.get(key(cx, cy)) || []) out.add(i);
        }
      }
      return out;
    },
    // 선분 a→b를 따라 폭 r인 띠 안의 칸들(긴 치수선 둘레만 볼 때 — 정사각형보다 훨씬 적다). 선이 cap개를 넘으면 null(빽빽한 곳은 건너뛴다)
    strip(ax, ay, bx, by, r, cap = Infinity) {
      const out = new Set(long);
      const seen = new Set();
      const L = hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(L / cell));
      const k = Math.ceil(r / cell);
      for (let s = 0; s <= n; s++) {
        const px = Math.floor((ax + ((bx - ax) * s) / n) / cell);
        const py = Math.floor((ay + ((by - ay) * s) / n) / cell);
        for (let cx = px - k; cx <= px + k; cx++) for (let cy = py - k; cy <= py + k; cy++) {
          const kk = key(cx, cy);
          if (seen.has(kk)) continue;
          seen.add(kk);
          const list = g.get(kk);
          if (!list) continue;
          if (out.size + list.length > cap) return null;
          for (const i of list) out.add(i);
        }
      }
      return out;
    },
  };
}

const distPointSeg = (x, y, s) => {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / (dx * dx + dy * dy || 1)));
  return hypot(x - (s.ax + dx * t), y - (s.ay + dy * t));
};
const endDist = (x, y, s) => Math.min(hypot(x - s.ax, y - s.ay), hypot(x - s.bx, y - s.by));

// ---------------------------------------------------------------- 블록 한 덩어리 판정

function isTitleInsert(it) {
  if (TITLE_NAME.test(it.name || '')) return true;
  return Object.keys(it.attribs || {}).some((k) => TITLE_TAG.test(k.trim()));
}

function parallelLines(items, kids) {
  const dirs = new Map();
  for (const j of kids) {
    for (const [a, b] of segmentsOf(items[j])) {
      const L = hypot(b[0] - a[0], b[1] - a[1]);
      if (!L) continue;
      const k = Math.round(((Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI) % Math.PI) / (Math.PI / 90));
      dirs.set(k, (dirs.get(k) || 0) + 1);
    }
  }
  return Math.max(0, ...dirs.values());
}

// null이면 덩어리가 아니라 그릇(세대 블록 등): 안의 개체를 하나씩 본다
function classifyBlock(it, items, kids, uf) {
  if (isTitleInsert(it)) return ['frame', null, 0.95, 'block_title'];
  if (!kids.length) return null;
  const name = it.name || '';
  const box = it.box;
  const w = box ? (box[2] - box[0]) * uf : 0;
  const h = box ? (box[3] - box[1]) * uf : 0;
  const big = Math.max(w, h);
  const small = Math.min(w, h);
  if (kids.some((j) => items[j].k === 'insert') && big > 3) return null;
  if (big > 12) return null;
  if (NAME_COLUMN.test(name)) return ['building', 'column', 0.9, 'block_column'];
  if (NAME_MARK.test(name)) return ['annotation', null, 0.9, 'block_mark'];
  if (NAME_FURN.test(name)) return ['furnishing', null, 0.85, 'block_furn'];
  const arc = (it.arcR || 0) * uf;
  if (NAME_DOOR.test(name) || (arc >= 0.4 && arc <= 2.5 && big <= 3.2)) return ['building', 'door', 0.85, 'block_door'];
  if (NAME_WINDOW.test(name) || (parallelLines(items, kids) >= 3 && big >= 0.3 && big <= 7 && small > 0 && big / small >= 1.8)) return ['building', 'window', 0.8, 'block_window'];
  const closed = kids.filter((j) => items[j].k === 'path' && items[j].closed && items[j].pts.length <= 8);
  const hatch = kids.some((j) => items[j].k === 'hatch');
  if (closed.length && (hatch || closed.length === kids.length) && big <= 1.6 && big / (small || 1) <= 2.5) return ['building', 'column', 0.7, 'block_column'];
  const texts = kids.filter((j) => items[j].k === 'text');
  if (texts.length && kids.some((j) => items[j].src === 'circle') && big <= 8) return ['annotation', null, 0.7, 'block_mark'];
  if (big < 0.25) return ['annotation', null, 0.6, 'block_small'];
  if (big <= 6) return ['furnishing', null, 0.5, 'block_furn'];
  return null;
}

// ---------------------------------------------------------------- 도곽·표

function frameRule(items, res, frame, uf, set) {
  if (!frame) return;
  const W = frame.x1 - frame.x0;
  const H = frame.y1 - frame.y0;
  const band = Math.min(W, H) * 0.03;
  const onSide = (x, y) => {
    const s = [];
    if (Math.abs(x - frame.x0) <= band) s.push('l');
    if (Math.abs(x - frame.x1) <= band) s.push('r');
    if (Math.abs(y - frame.y0) <= band) s.push('b');
    if (Math.abs(y - frame.y1) <= band) s.push('t');
    return s;
  };
  items.forEach((it, i) => {
    if (res[i] || it.k !== 'path') return;
    const pts = it.pts;
    if (!pts?.length) return;
    if (pts.length >= 4 && it.closed) {
      const b = boxOf(pts);
      if (Math.abs(b[0] - frame.x0) <= band && Math.abs(b[2] - frame.x1) <= band && Math.abs(b[1] - frame.y0) <= band && Math.abs(b[3] - frame.y1) <= band) set(i, 'frame', null, 0.9, 'frame_line');
      return;
    }
    if (pts.length === 2) {
      const a = onSide(pts[0][0], pts[0][1]);
      const b = onSide(pts[1][0], pts[1][1]);
      const L = hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      if (a.some((s) => b.includes(s)) && L >= Math.min(W, H) * 0.25) set(i, 'frame', null, 0.8, 'frame_line');
    }
  });
  // 표제란 영역: 라벨 글자가 세로로 쌓인 곳에서 도곽 모서리까지(가로로 늘어선 것은 표의 머리글이다)
  const found = items.filter((it) => it.k === 'text' && TITLE_LABEL.test(String(it.t).trim()));
  const labels = found.map((a) => found.filter((b) => Math.abs(b.x - a.x) <= (a.size || 1) * 2)).sort((p, q) => q.length - p.length)[0] || [];
  if (labels.length < 2) return;
  const size = Math.max(...labels.map((t) => t.size || 0));
  const x0 = Math.min(...labels.map((t) => t.x)) - size * 3;
  const y1 = Math.max(...labels.map((t) => t.y)) + size * 4;
  const zone = [x0, frame.y0 - band, frame.x1 + band, y1];
  items.forEach((it, i) => {
    if (res[i] || it.k !== 'path' || !it.pts?.length) return;
    const b = boxOf(it.pts);
    if (b[0] >= zone[0] && b[1] >= zone[1] && b[2] <= zone[2] && b[3] <= zone[3]) set(i, 'frame', null, 0.8, 'frame_zone');
  });
}

function tableRule(items, res, tables, category, set) {
  if (PLAN.has(category)) return; // 평면은 벽이 표처럼 보일 수 있다
  for (const t of tables || []) {
    if (!t.lined || !t.bbox) continue;
    const [x0, y0, x1, y1] = t.bbox;
    const tol = Math.max(x1 - x0, y1 - y0) * 0.01;
    items.forEach((it, i) => {
      if (res[i] || it.k !== 'path' || !it.pts?.length) return;
      const b = boxOf(it.pts);
      if (b[0] >= x0 - tol && b[1] >= y0 - tol && b[2] <= x1 + tol && b[3] <= y1 + tol) set(i, 'table', null, 0.9, 'table');
    });
  }
}

// ---------------------------------------------------------------- 통심선·폭발된 치수·인출선

function gridRule(items, res, segs, idx, uf, set) {
  const texts = items.filter((it) => it.k === 'text');
  items.forEach((it, i) => {
    if (res[i] || it.src !== 'circle' || !it.c) return;
    const r = it.r * uf;
    if (r < 0.05 || r > 2) return;
    const label = texts.find((t) => hypot(t.x - it.c[0], t.y - it.c[1]) <= it.r * 0.9 && BUBBLE_TEXT.test(String(t.t).trim()) && String(t.t).trim().length <= 5);
    if (!label) return;
    const cx = it.c[0] * uf;
    const cy = it.c[1] * uf;
    let hit = false;
    for (const j of idx.near(cx, cy, r * 2)) {
      const s = segs[j];
      if (res[s.i] || endDist(cx, cy, s) > r * 1.6 || s.L < r * 4) continue;
      set(s.i, 'grid', null, 0.9, 'grid_bubble');
      hit = true;
    }
    if (hit) set(i, 'grid', null, 0.9, 'grid_bubble');
  });
}

// 폭발된 치수의 그린 길이: 치수선(같은 직선 위 토막들)에서 글자 양쪽의 가장 가까운 보조선·눈금 사이 거리.
// 글자 자리에서 끊긴 치수선은 토막 하나가 숫자보다 짧고, 여러 치수가 한 줄로 이어진 연속 치수는 선 하나가 숫자보다 길다
// — 토막·선 하나의 길이로 견주면 거짓 불일치가 났다(실제 도서 세대 평면 시트당 1~5건). 양쪽 끝을 못 찾으면 null
function dimSpan(s, x, y, size, segs, idx, res, chars, valueM) {
  const ux = (s.bx - s.ax) / s.L;
  const uy = (s.by - s.ay) / s.L;
  const off = (px, py) => (px - s.ax) * -uy + (py - s.ay) * ux;
  const tOf = (px, py) => (px - s.ax) * ux + (py - s.ay) * uy;
  const tx = tOf(x, y);
  const pieces = [[0, s.L]];
  const stops = [];
  // 치수선을 따라 숫자 길이 안팎의 좁은 띠만 본다(정사각형으로 훑으면 숫자가 많은 큰 시트에서 매우 느리다)
  const R = Math.min(s.L, Math.max(valueM, 0.3) * 1.3) + size * 6;
  const cx = s.ax + ux * tx;
  const cy = s.ay + uy * tx;
  const near = idx.strip(cx - ux * R, cy - uy * R, cx + ux * R, cy + uy * R, size * 3, 3000);
  if (!near) return null; // 선이 아주 빽빽한 곳(해치·가구 위)을 지나는 치수선은 재지 않는다(시간)
  for (const j of near) {
    const e = segs[j];
    if (e === s || !e.L || (res[e.i] && res[e.i].why !== 'block_small')) continue;
    const dot = Math.abs(((e.bx - e.ax) * ux + (e.by - e.ay) * uy) / e.L);
    const oa = off(e.ax, e.ay);
    const ob = off(e.bx, e.by);
    if (dot > 0.999) {
      if (Math.abs(oa) < size * 0.3 && Math.abs(ob) < size * 0.3) { const ta = tOf(e.ax, e.ay); const tb = tOf(e.bx, e.by); pieces.push([Math.min(ta, tb), Math.max(ta, tb)]); }
      continue;
    }
    if (dot > 0.95) continue;
    let t = null;
    if (oa * ob <= 0) { const k = oa / (oa - ob || 1); t = tOf(e.ax + (e.bx - e.ax) * k, e.ay + (e.by - e.ay) * k); } // 축을 가로지름
    else if (Math.abs(oa) <= size * 1.2 || Math.abs(ob) <= size * 1.2) t = Math.abs(oa) < Math.abs(ob) ? tOf(e.ax, e.ay) : tOf(e.bx, e.by); // 끝이 축에 닿음
    if (t != null) stops.push(t);
  }
  // 글자 자리를 지나는 토막 묶음(사이 틈은 글자 폭까지)
  pieces.sort((a, b) => a[0] - b[0]);
  const gap = size * (chars + 2);
  const chains = [];
  for (const p of pieces) { const last = chains[chains.length - 1]; if (last && p[0] <= last[1] + gap) last[1] = Math.max(last[1], p[1]); else chains.push([...p]); }
  const ch = chains.find((c) => tx >= c[0] - gap && tx <= c[1] + gap);
  if (!ch) return null;
  const tol = size * 0.5;
  const left = stops.filter((t) => t < tx - tol && t >= ch[0] - tol).sort((a, b) => b - a)[0];
  const right = stops.filter((t) => t > tx + tol && t <= ch[1] + tol).sort((a, b) => a - b)[0];
  return left != null && right != null ? right - left : null;
}

function explodedDims(items, res, segs, idx, uf, set, dims, inDim = new Set()) {
  // 치수(DIMENSION) 블록 안의 숫자는 이미 치수다 — 다시 짝지으면 엉뚱한 긴 선(벽)과 붙어 거짓 불일치가 났다(실제 도서 시트당 80개)
  const texts = items.map((it, i) => ({ it, i })).filter(({ it, i }) => it.k === 'text' && !inDim.has(i) && NUMBER.test(String(it.t).trim()));
  const found = [];
  for (const { it, i } of texts) {
    const x = it.x * uf;
    const y = it.y * uf;
    const size = (it.size || 0) * uf || 0.2;
    const value = Number(String(it.t).replace(/[,\smM]/g, ''));
    // 글자와 나란한 가까운 선들. 여러 줄 치수에서는 가장 가까운 선이 다른 줄일 수 있어(실제 도서: 숫자 아래 0.12m 줄이 아니라 위 0.20m 줄이 짝),
    // 보조선 사이 길이가 숫자와 맞는 선을 먼저 고르고, 없으면 가장 가까운 선
    const cands = [];
    for (const j of idx.near(x, y, size * 3)) {
      const s = segs[j];
      if (res[s.i] && res[s.i].why !== 'block_small') continue;
      const d = distPointSeg(x, y, s);
      if (d > size * 2.2) continue;
      const ang = ((Math.atan2(s.by - s.ay, s.bx - s.ax) * 180) / Math.PI + 360) % 180;
      const rot = (((it.rot || 0) % 180) + 180) % 180;
      if (Math.min(Math.abs(ang - rot), 180 - Math.abs(ang - rot)) > 3) continue;
      cands.push({ s, d });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => a.d - b.d);
    const near1 = (m) => value > 0 && Math.abs(m * 1000 - value) <= Math.max(2, value * 0.01);
    let best = cands[0];
    let span = null;
    if (!near1(best.s.L)) {
      for (const c of cands.slice(0, 3)) {
        if (near1(c.s.L)) { best = c; span = null; break; }
        const sp = dimSpan(c.s, x, y, size, segs, idx, res, String(it.t).trim().length, value / 1000);
        if (c === cands[0]) span = sp;
        if (sp != null && near1(sp)) { best = c; span = sp; break; }
      }
    }
    const { s } = best;
    const ux = (s.bx - s.ax) / s.L;
    const uy = (s.by - s.ay) / s.L;
    // 양 끝의 보조선(수직)과 눈금(짧은 빗금·화살표)
    const ext = [];
    let ticks = 0;
    for (const [px, py] of [[s.ax, s.ay], [s.bx, s.by]]) {
      for (const j of idx.near(px, py, size * 2)) {
        const e = segs[j];
        if (e === s || (res[e.i] && res[e.i].why !== 'block_small')) continue;
        if (distPointSeg(px, py, e) > size * 1.2) continue;
        const dot = Math.abs(((e.bx - e.ax) * ux + (e.by - e.ay) * uy) / (e.L || 1));
        if (dot < 0.1) ext.push(e);
        else if (e.L <= size * 3 && dot < 0.95) { ticks++; ext.push(e); }
      }
    }
    const lenM = span != null && span > 0 ? span : s.L;
    const match = value > 0 && (Math.abs(s.L * 1000 - value) <= Math.max(2, value * 0.01) || Math.abs(lenM * 1000 - value) <= Math.max(2, value * 0.01));
    // 선이 숫자보다 길면 글자가 선 가운데쯤(20~80%)에 있어야 치수다 — 긴 벽 끝의 숫자 글자는 치수가 아니다
    // (글자 자리에서 둘로 끊긴 치수선은 선이 숫자보다 짧아 이 검사를 하지 않는다)
    const along = ((x - s.ax) * ux + (y - s.ay) * uy) / (s.L || 1);
    if (!match && value < s.L * 1000 && (along < 0.2 || along > 0.8)) continue;
    // 선 길이의 1/5도 안 되는 숫자(기울기 0.47, 줄눈 15 옆 17m 선)는 다른 글자다(치수선 토막은 숫자보다 짧을 수 있어 반대쪽은 안 본다)
    if (!match && (value <= 0 || value / (s.L * 1000) < 0.2)) continue;
    const solids = items.reduce((n, a, j) => {
      if (a.src !== 'solid' || !a.pts?.length) return n;
      const [ax, ay] = [a.pts[0][0] * uf, a.pts[0][1] * uf];
      return endDist(ax, ay, s) <= size * 2 ? n + 1 : n;
    }, 0);
    if (!(ext.length >= 1 || ticks || solids || match)) continue;
    found.push({ s, ext, text: i, lenM: Math.abs(s.L * 1000 - value) <= Math.max(2, value * 0.01) ? s.L : lenM });
  }
  for (const f of found) {
    const value = Number(String(items[f.text].t).replace(/[,\smM]/g, ''));
    if (value > 0) dims.push({ h: items[f.text].h, value, lenM: Math.round(f.lenM * 1000) / 1000, at: [items[f.text].x, items[f.text].y] });
    set(f.s.i, 'dimension', null, 0.85, 'dim_exploded', true);
    set(f.text, 'dimension', null, 0.85, 'dim_exploded', true);
    for (const e of f.ext) set(e.i, 'dimension', null, 0.8, 'dim_exploded', true);
  }
  // 치수선 양 끝의 화살표(작은 블록·SOLID)
  const lines = found.map((f) => f.s);
  if (!lines.length) return;
  items.forEach((it, i) => {
    const small = res[i]?.why === 'block_small';
    if (!small && !(it.src === 'solid' && !res[i])) return;
    const p = it.box ? [(it.box[0] + it.box[2]) / 2, (it.box[1] + it.box[3]) / 2] : it.pts?.[0];
    if (p && lines.some((s) => endDist(p[0] * uf, p[1] * uf, s) <= 0.4)) set(i, 'dimension', null, 0.8, 'dim_exploded', true);
  });
}

// 인출선은 열린 짧은 선이다(닫힌 도형은 아니다)
const openLine = (it) => !it.closed && (it.pts?.length || 0) <= 4;

function leaderRule(items, res, segs, idx, uf, set, wallish) {
  const isAxis = (s) => Math.abs(s.bx - s.ax) < s.L * 0.02 || Math.abs(s.by - s.ay) < s.L * 0.02;
  items.forEach((it) => {
    if (it.k !== 'text' || NUMBER.test(String(it.t).trim())) return;
    const size = (it.size || 0) * uf || 0.2;
    const box = it.box ? it.box.map((v) => v * uf) : [it.x * uf, it.y * uf, it.x * uf, it.y * uf];
    const near = (x, y) => x >= box[0] - size * 2 && x <= box[2] + size * 2 && y >= box[1] - size * 2 && y <= box[3] + size * 2;
    for (const j of idx.near((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, Math.max(box[2] - box[0], box[3] - box[1]) + size * 3)) {
      const s = segs[j];
      if (res[s.i] || !openLine(items[s.i])) continue;
      const end = near(s.ax, s.ay) ? [s.bx, s.by] : near(s.bx, s.by) ? [s.ax, s.ay] : null;
      if (!end) continue;
      if (!isAxis(s)) { if (!wallish.has(s.i)) set(s.i, 'annotation', null, 0.7, 'leader_shape'); continue; }
      for (const k of idx.near(end[0], end[1], 0.05)) {
        const e = segs[k];
        if (e === s || res[e.i] || !openLine(items[e.i]) || isAxis(e) || endDist(end[0], end[1], e) > 0.02) continue;
        // 인출선의 빗금은 끝이 허공에 떠 있다. 벽 끝은 다른 선에 닿는다
        const far = hypot(e.ax - end[0], e.ay - end[1]) > hypot(e.bx - end[0], e.by - end[1]) ? [e.ax, e.ay] : [e.bx, e.by];
        if (wallish.has(e.i) && [...idx.near(far[0], far[1], 0.05)].some((m) => segs[m] !== e && endDist(far[0], far[1], segs[m]) <= 0.02)) continue;
        set(s.i, 'annotation', null, 0.75, 'leader_shape');
        set(e.i, 'annotation', null, 0.75, 'leader_shape');
      }
    }
  });
}

// ---------------------------------------------------------------- 벽다움: 평행 이중선이 그물처럼 이어짐

function wallRule(items, res, segs, uf, roles, set) {
  const MIN_T = 0.05;
  const MAX_T = 0.6;
  const JOIN = 0.35; // 벽 끝은 상대 벽 두께의 절반 안에 닿는다
  const groups = new Map(); // 각도 → 줄
  for (const s of segs) {
    if (res[s.i] || s.L < 0.02 || !WALLISH.has(roles[items[s.i].layer])) continue;
    let a = Math.atan2(s.by - s.ay, s.bx - s.ax);
    if (a < 0) a += Math.PI;
    if (a >= Math.PI - 1e-9) a -= Math.PI;
    const k = Math.round(a / (Math.PI / 720)) % 720;
    if (!groups.has(k)) groups.set(k, []);
    const ux = Math.cos(k * (Math.PI / 720));
    const uy = Math.sin(k * (Math.PI / 720));
    const t0 = s.ax * ux + s.ay * uy;
    const t1 = s.bx * ux + s.by * uy;
    groups.get(k).push({ s, off: -s.ax * uy + s.ay * ux, t0: Math.min(t0, t1), t1: Math.max(t0, t1) });
  }
  const runs = [];
  for (const [ang, list] of groups) {
    list.sort((a, b) => a.off - b.off);
    let line = [];
    const flush = () => {
      line.sort((a, b) => a.t0 - b.t0);
      let run = null;
      for (const x of line) {
        if (run && x.t0 <= run.t1 + 0.01) { run.t1 = Math.max(run.t1, x.t1); run.m.push(x); } else { run = { ang, off: x.off, t0: x.t0, t1: x.t1, m: [x], cover: [] }; runs.push(run); }
      }
      line = [];
    };
    for (const x of list) {
      if (line.length && x.off - line[0].off > 0.004) flush();
      line.push(x);
    }
    flush();
  }
  // 같은 방향끼리 평행 짝
  const byAng = new Map();
  runs.forEach((r, i) => { r.i = i; if (!byAng.has(r.ang)) byAng.set(r.ang, []); byAng.get(r.ang).push(r); });
  const parent = runs.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const join = (a, b) => { parent[find(a)] = find(b); };
  // 같은 평면을 한 줄로 여러 번 놓은 큰 시트(실제 도서: 개체 44만)에서 모든 짝을 견주면 판별이 수십 분 걸렸다 —
  // 줄 방향으로 칸(TC m)을 나눠 겹칠 수 있는 것끼리만 견준다(45 지시서 4.1). 결과(짝·덮인 구간)는 예전과 같다
  const TC = 2;
  const firstAt = (arr, v) => { let lo = 0; let hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].off < v) lo = m + 1; else hi = m; } return lo; };
  for (const list of byAng.values()) {
    list.sort((a, b) => a.off - b.off);
    const cells = new Map();
    for (const r of list) {
      for (let c = Math.floor(r.t0 / TC); c <= Math.floor(r.t1 / TC); c++) {
        let arr = cells.get(c);
        if (!arr) cells.set(c, (arr = []));
        arr.push(r); // list가 off 순이라 칸 안도 off 순
      }
    }
    for (const r of list) {
      const seen = new Set();
      for (let c = Math.floor(r.t0 / TC); c <= Math.floor(r.t1 / TC); c++) {
        const arr = cells.get(c);
        if (!arr) continue;
        for (let m = firstAt(arr, r.off + MIN_T); m < arr.length && arr[m].off - r.off <= MAX_T; m++) {
          const q = arr[m];
          if (seen.has(q)) continue;
          seen.add(q);
          const lo = Math.max(r.t0, q.t0);
          const hi = Math.min(r.t1, q.t1);
          if (hi - lo < Math.max(0.15, 0.3 * Math.min(r.t1 - r.t0, q.t1 - q.t0))) continue;
          r.cover.push([lo, hi]);
          q.cover.push([lo, hi]);
          join(r.i, q.i);
        }
      }
    }
    // 문·창 틈으로 끊긴 같은 벽(같은 줄, 틈 4m 이하): 줄마다 t 순서로, 지금까지 가장 멀리 간 토막과 견준다(모든 짝과 같은 결과)
    for (let i = 0; i < list.length;) {
      let j = i;
      while (j + 1 < list.length && list[j + 1].off - list[i].off < 0.004) j++;
      if (j > i) {
        const same = list.slice(i, j + 1).sort((a, b) => a.t0 - b.t0);
        let top = same[0];
        for (let k = 1; k < same.length; k++) {
          if (same[k].t0 - top.t1 <= 4) join(top.i, same[k].i);
          if (same[k].t1 > top.t1) top = same[k];
        }
      }
      i = j + 1;
    }
  }
  // 모서리로 이어진 벽끼리 그물로: 끝점이 다른 줄의 끝점 가까이
  const ends = [];
  const unit = (r) => [Math.cos(r.ang * (Math.PI / 720)), Math.sin(r.ang * (Math.PI / 720))];
  for (const r of runs) {
    if (!r.cover.length) continue;
    const [ux, uy] = unit(r);
    for (const t of [r.t0, r.t1]) ends.push({ r, x: t * ux - r.off * uy, y: t * uy + r.off * ux });
  }
  const cell = new Map();
  const nk = (cx, cy) => cx * 1000003 + cy; // 숫자 열쇠(문자열보다 빠르다)
  for (const e of ends) { const k = nk(Math.floor(e.x / 0.7), Math.floor(e.y / 0.7)); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(e); }
  for (const e of ends) {
    const ex = Math.floor(e.x / 0.7);
    const ey = Math.floor(e.y / 0.7);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const f of cell.get(nk(ex + dx, ey + dy)) || []) {
        if (f.r !== e.r && hypot(f.x - e.x, f.y - e.y) <= JOIN) join(e.r.i, f.r.i);
      }
    }
  }
  // 짧은 벽이 긴 벽 몸통에 T자로 붙는 곳
  const body = new Map();
  const bk = (x, y) => nk(Math.floor(x / 2), Math.floor(y / 2));
  for (const r of runs) {
    if (!r.cover.length) continue;
    const [ux, uy] = unit(r);
    for (let t = r.t0; ; t += 1) {
      const u = Math.min(t, r.t1);
      const k = bk(u * ux - r.off * uy, u * uy + r.off * ux);
      if (!body.has(k)) body.set(k, new Set());
      body.get(k).add(r);
      if (t >= r.t1) break;
    }
  }
  for (const e of ends) {
    const ex = Math.floor(e.x / 2);
    const ey = Math.floor(e.y / 2);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const r of body.get(nk(ex + dx, ey + dy)) || []) {
        if (r === e.r || r.ang === e.r.ang) continue;
        const [ux, uy] = unit(r);
        const t = e.x * ux + e.y * uy;
        const off = -e.x * uy + e.y * ux;
        if (t >= r.t0 - JOIN && t <= r.t1 + JOIN && Math.abs(off - r.off) <= JOIN) join(e.r.i, r.i);
      }
    }
  }
  const size = new Map();
  for (const r of runs) if (r.cover.length) size.set(find(r.i), (size.get(find(r.i)) || 0) + (r.t1 - r.t0));
  const paired = new Map(); // 개체 → [이중선 길이, 전체 길이]
  for (const r of runs) {
    const ok = r.cover.length && (size.get(find(r.i)) || 0) >= 3;
    for (const x of r.m) {
      const c = paired.get(x.s.i) || [0, 0];
      const L = x.t1 - x.t0;
      c[1] += L;
      if (ok) {
        let cov = 0;
        for (const [lo, hi] of r.cover) cov = Math.max(cov, Math.max(0, Math.min(x.t1, hi) - Math.max(x.t0, lo)));
        c[0] += Math.max(cov, r.cover.some(([lo, hi]) => lo <= x.t0 && hi >= x.t1) ? L : 0);
      }
      paired.set(x.s.i, c);
    }
  }
  for (const [i, [yes, all]] of paired) if (all && yes / all >= 0.5) set(i, 'building', 'wall', 0.75, 'wall_pair');
  // 벽 두께의 해치
  items.forEach((it, i) => {
    if (res[i] || it.k !== 'hatch' || !WALLISH.has(roles[it.layer])) return;
    for (const loop of it.loops || []) {
      if (loop.length < 3) continue;
      const b = boxOf(loop);
      const w = (b[2] - b[0]) * uf;
      const h = (b[3] - b[1]) * uf;
      const t = Math.min(w, h);
      if (t >= MIN_T && t <= MAX_T && Math.max(w, h) >= 0.2) { set(i, 'building', 'wall', 0.75, 'wall_hatch'); return; }
      const diag = Math.max(w, h);
      if (t > MAX_T && diag > 0.3 && /CONC|ANSI3/i.test(it.pattern || '')) { set(i, 'building', 'wall', 0.55, 'wall_hatch'); return; }
    }
  });
}

// ---------------------------------------------------------------- 전체

const signature = (it, paired, uf) => {
  if (it.k === 'text') return NUMBER.test(String(it.t).trim()) ? 'num' : 'txt';
  if (it.k === 'hatch') return `hatch:${it.pattern || ''}`;
  if (it.k === 'insert') return 'ins';
  if (it.k === 'dim') return 'dim';
  const pts = it.pts || [];
  if (['arc', 'circle', 'ellipse', 'spline'].includes(it.src)) return it.src;
  let L = 0;
  for (let i = 0; i + 1 < pts.length; i++) L += hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  const bucket = L * uf > 0 ? Math.round(Math.log2(L * uf)) : -9;
  const a = pts.length >= 2 ? Math.abs(Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])) : 0;
  const dir = pts.length > 2 ? 'p' : Math.min(a, Math.PI - a) < 0.02 ? 'h' : Math.abs(a - Math.PI / 2) < 0.02 ? 'v' : 'd';
  return `${dir}${bucket}${it.closed ? 'c' : ''}${paired ? 'w' : ''}`;
};

const itemLength = (it, uf) => {
  const pts = it.pts || [];
  let L = 0;
  for (let i = 0; i + 1 < pts.length; i++) L += hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L * uf;
};

/**
 * 시트 판별. flat = flattenSheet·unpackSheet 결과.
 * @param {{ items: any[], frame: any }} flat
 * @param {{ layerRoles?: Record<string,string>, uf?: number, layers?: Record<string,any>, tables?: any[], category?: string, profile?: Record<string,{cls:string,part?:string|null}> }} [o]
 * @returns {{ v: number, clusters: any[], of: number[], entities: Record<string,any>, missing: any[], passes: number, counts: Record<string,number> }}
 */
export function triageSheet(flat, { layerRoles = {}, uf = 0.001, layers = {}, tables = [], category = 'unknown', profile = {} } = {}) {
  const { items, frame } = flat;
  const res = new Array(items.length).fill(null);
  const skip = new Set();
  const set = (i, cls, part, conf, why, force = false) => { if (!res[i] || force) res[i] = { cls, part: part ?? null, conf, why }; };

  // 1. 블록·치수는 덩어리로
  const owners = new Map();
  items.forEach((it, i) => { if (it.k === 'insert' || it.k === 'dim') owners.set(normH(it.h), i); });
  const kids = new Map();
  items.forEach((it, i) => {
    for (const p of parents(it.h)) if (owners.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(i); }
  });
  const decided = new Map();
  for (const [h, i] of owners) {
    const it = items[i];
    if (it.k === 'dim') { decided.set(h, ['dimension', null, 0.99, 'dim']); set(i, 'dimension', null, 0.99, 'dim'); continue; }
    const r = classifyBlock(it, items, kids.get(h) || [], uf);
    if (r) { decided.set(h, r); set(i, ...r); } else skip.add(i);
  }
  items.forEach((it, i) => {
    if (it.k === 'text') { set(i, 'text', null, 0.99, 'text'); return; }
    if (it.k === 'insert' || it.k === 'dim') return;
    for (const p of parents(it.h)) {
      const r = decided.get(p);
      if (r) { set(i, ...r); return; }
    }
    if (it.src === 'leader') set(i, 'annotation', null, 0.95, 'leader');
    else if (it.src === 'point') set(i, 'annotation', null, 0.6, 'point');
  });
  // 2. 도곽·표
  frameRule(items, res, frame, uf, set);
  tableRule(items, res, tables, category, set);
  // 3. 선 종류
  const ltOf = (it) => { const t = it.lt && !/^BY/i.test(it.lt) ? it.lt : layers[it.layer]?.lt || ''; return /^CONTINUOUS$/i.test(t) ? '' : t; };
  items.forEach((it, i) => {
    if (res[i] || (it.k !== 'path' && it.k !== 'hatch')) return;
    const lt = ltOf(it);
    if (LT_CENTER.test(lt)) set(i, 'grid', null, 0.8, 'lt_center');
    else if (LT_HIDDEN.test(lt) && layerRoles[it.layer] !== 'underground') set(i, 'hidden', null, 0.8, 'lt_hidden'); // 지하 외곽은 숨은선으로 그린다
  });
  // 4. 모양: 통심선 → 폭발된 치수 → 인출선 → 벽
  const segs = [];
  items.forEach((it, i) => {
    for (const [a, b] of segmentsOf(it)) {
      const [ax, ay, bx, by] = [a[0] * uf, a[1] * uf, b[0] * uf, b[1] * uf];
      const L = hypot(bx - ax, by - ay);
      if (L > 0) segs.push({ i, ax, ay, bx, by, L });
    }
  });
  const idx = spatial(segs, 1);
  gridRule(items, res, segs, idx, uf, set);
  // 길이 치수(회전·정렬)만 견준다 — 각도·지름·반지름 치수 값(0.47 라디안 등)을 길이와 견주면 거짓 불일치가 쏟아졌다
  const dimLen = (it) => (it.dir ? Math.abs((it.p2[0] - it.p1[0]) * it.dir[0] + (it.p2[1] - it.p1[1]) * it.dir[1]) : hypot(it.p2[0] - it.p1[0], it.p2[1] - it.p1[1]));
  const dims = items.filter((it) => it.k === 'dim' && it.value > 0 && (it.dtype || 0) <= 1).map((it) => ({ h: it.h, value: it.text && /^[\d,.]+$/.test(it.text) ? Number(it.text.replace(/,/g, '')) : it.value, lenM: Math.round(dimLen(it) * uf * 1000) / 1000, at: it.tp }));
  const inDim = new Set();
  for (const [h, i] of owners) if (items[i].k === 'dim') for (const j of kids.get(h) || []) inDim.add(j);
  explodedDims(items, res, segs, idx, uf, set, dims, inDim);
  // 벽 후보를 먼저 알아 둔다: 기울여 그린 건물은 벽이 모두 빗금이라 인출선으로 오해받고,
  // 인출선의 수평 부분은 벽 면과 우연히 나란할 수 있다. 빗금이 벽 후보가 아닐 때만 인출선이다
  const wallish = new Set();
  if (PLAN.has(category)) wallRule(items, res, segs, uf, layerRoles, (i) => wallish.add(i));
  leaderRule(items, res, segs, idx, uf, set, wallish);
  if (PLAN.has(category)) wallRule(items, res, segs, uf, layerRoles, set);
  // 5. 레이어 쓰임새, 그래도 모르면 unknown
  items.forEach((it, i) => {
    if (res[i] || skip.has(i)) return;
    const m = ROLE_MAP[layerRoles[it.layer]];
    if (m) set(i, m[0], m[1], 0.5, 'layer');
    else set(i, 'unknown', null, 0.1, 'none');
  });
  // 6. 무리 만들기
  const clusters = [];
  const byKey = new Map();
  const of = new Array(items.length).fill(-1);
  items.forEach((it, i) => {
    if (skip.has(i)) return;
    const r = res[i];
    const block = (parents(it.h).map((p) => owners.get(p)).filter((j) => j != null).map((j) => items[j].name).filter(Boolean).at(-1)) || (it.k === 'insert' ? it.name : '') || '';
    const key = [it.layer, ltOf(it), it.rgb ?? it.color ?? '', it.k === 'path' ? it.src : it.k, block, signature(it, r.why === 'wall_pair', uf), r.cls, r.part || ''].join('|');
    let c = byKey.get(key);
    if (c == null) {
      c = clusters.length;
      byKey.set(key, c);
      clusters.push({ id: `c${c}`, key, layer: it.layer, lt: ltOf(it), color: it.color ?? null, kind: it.k === 'path' ? it.src : it.k, block, n: 0, lenM: 0, box: null, rule: { cls: r.cls, part: r.part, conf: r.conf, why: r.why }, ai: null, human: null });
    }
    const cl = clusters[c];
    cl.n++;
    cl.lenM += itemLength(it, uf);
    const b = it.box || (it.pts?.length ? boxOf(it.pts) : it.loops?.length ? boxOf(it.loops.flat()) : null);
    if (b) cl.box = cl.box ? [Math.min(cl.box[0], b[0]), Math.min(cl.box[1], b[1]), Math.max(cl.box[2], b[2]), Math.max(cl.box[3], b[3])] : [...b];
    of[i] = c;
  });
  for (const c of clusters) {
    c.lenM = Math.round(c.lenM * 100) / 100;
    if (profile[c.key]) c.human = { cls: profile[c.key].cls, part: profile[c.key].part ?? null, by: 'memory' };
  }
  const out = { v: 1, clusters, of, entities: {}, missing: [], passes: 0, counts: {}, dims };
  out.counts = countClasses(out);
  return out;
}

// ---------------------------------------------------------------- 판정 읽기·고치기

export function itemVerdict(t, items, i) {
  const c = t.of[i] >= 0 ? t.clusters[t.of[i]] : null;
  if (!c) return null;
  const e = t.entities[items[i].h];
  return e?.human || e?.ai || clusterVerdict(c);
}

/** 시트 모양에 판정을 붙인 새 항목 목록(모델 생성이 읽는다). 판정 파일이 시트와 안 맞으면 그대로 돌려준다(옛 시트는 레이어로 읽는다) */
export function applyTriage(flat, t) {
  if (!t || t.of?.length !== flat.items.length) return flat;
  const items = flat.items.map((it, i) => {
    const v = itemVerdict(t, flat.items, i);
    return v ? { ...it, tc: v.cls, tp: v.part ?? null } : { ...it, tc: null, tp: null };
  });
  return { ...flat, items, dims: t.dims || [] };
}

// 무리 고치기(사람). 같은 무리에 한꺼번에
export function setCluster(t, id, cls, part = null) {
  const c = t.clusters.find((x) => x.id === id);
  if (!c) return t;
  c.human = { cls, part, by: 'human' };
  t.counts = countClasses(t);
  return t;
}

// 다시 분석해도 사람 판정은 남긴다: 같은 무리 키면 이어받는다
export function carryHuman(prev, next) {
  if (!prev) return next;
  const kept = new Map(prev.clusters.filter((c) => c.human).map((c) => [c.key, c.human]));
  for (const c of next.clusters) if (kept.has(c.key)) c.human = kept.get(c.key);
  next.counts = countClasses(next);
  return next;
}

// 현장 기억: 사람이 고친 무리(좌표 없는 키) → 다음 도서의 기본값
export function profileFrom(t, prev = {}) {
  const out = { ...prev };
  for (const c of t.clusters) if (c.human?.by === 'human') out[c.key] = { cls: c.human.cls, part: c.human.part ?? null };
  return out;
}

// 판별이 끝나도 모르는 개체 수
export const unknownCount = (t) => t?.counts?.unknown || 0;
