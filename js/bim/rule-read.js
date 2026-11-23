// 규칙으로 읽기(AI 없이 항상 동작, 03 7절): 시트 요약(digest)에서 AI 추출과 같은 모양의 결과를 만든다.
// 위치는 시트 좌표(AI 결과도 저장할 때 시트 좌표로 바꾼다). 신뢰도는 낮게, method: 'rule'.
import { layerRolesFor } from '../cad/layer-names.js';
import { headerColumns } from '../cad/tables.js';
import { parseComposition } from './materials-ko.js';
import { extractKindFor } from './ai-schemas.js';
import { readSection } from './read-section.js';
import { readDetails } from './read-detail.js';
import { readStructure } from './read-structure.js';

export const ROOM_WORDS = [
  ['거실', 'living'], ['침실', 'bedroom'], ['안방', 'bedroom'], ['주방', 'kitchen'], ['식당', 'kitchen'], ['욕실', 'bath'], ['화장실', 'bath'],
  ['부부욕실', 'bath'], ['발코니', 'balcony'], ['실외기실', 'balcony'], ['드레스룸', 'dress'], ['파우더', 'dress'], ['다용도실', 'utility'],
  ['현관', 'hall'], ['복도', 'hall'], ['홀', 'hall'], ['대피공간', 'other'], ['계단실', 'other'], ['승강기', 'other'], ['필로티', 'other'],
  ['피트니스', 'other'], ['도서관', 'other'], ['관리사무소', 'other'], ['경로당', 'other'], ['어린이집', 'other'], ['라운지', 'other'], ['창고', 'utility'],
  ['ALPHA', 'other'], ['펜트리', 'utility'], ['팬트리', 'utility'],
];
// 실 이름 레이어에서만 실 이름으로 받는 작은 실 낱말(다른 레이어의 가구 주기 "수납장" 등과 헷갈리지 않게 사전에는 넣지 않는다)
const MINOR_WORDS = [['수납', 'utility'], ['보일러', 'utility'], ['세탁', 'utility'], ['신발', 'utility'], ['서재', 'bedroom'], ['알파', 'other']];
export function roomUse(name) {
  const s = String(name || '');
  for (const [w, u] of ROOM_WORDS) if (s.includes(w)) return u;
  for (const [w, u] of MINOR_WORDS) if (s.includes(w)) return u;
  return 'other';
}
// 샤프트 기호(PS·AD·EPS·TPS·PD): 이름 없는 칸으로 두지 않고 기호를 이름으로(공용, 마감 없음)
export const SHAFT_NAME = /^(E?PS|AD|TPS|PD|DS|DA)\s*-?\d{0,2}$/i;
// 실 이름 레이어의 짧은 한글 글자(사전에 없는 낱말): 실 이름일 수도, 가구·설비 이름일 수도 있다(실제 도서: 주방·침실 안에 흩어진 3글자).
// 실 이름으로는 받지 않고, 모델을 만들 때 이름 없는 닫힌 칸 안에 하나만 있을 때 그 칸의 이름으로만 쓴다(js/bim/units.js)
export const layerRoomName = (s) => {
  const t = String(s || '').trim();
  return t.length <= 8 && /[가-힣]/.test(t) && !/[㎡]|\d{3,}|[=:;]/.test(t) && !/^[(（].*[)）]$|확장|선택|옵션|기본|면적|평면|단위세대|형$|층$|동$|호$|^\d/.test(t);
};
export const isRoomName = (s) => {
  const t = String(s || '').trim();
  return t.length <= 12 && ROOM_WORDS.some(([w]) => t.includes(w)) && !/[㎡]|\d{3,}/.test(t);
};

export const WALL_TAG = /^W\d{1,2}[A-Z]?$/;
export const DOOR_TAG = /^(WD|SD|FD|AD|SSD|D)\d{1,2}[A-Z]?$/;
export const WINDOW_TAG = /^(AW|PW|SW|BW|CW|AL|PL|W[A-Z])\d{1,2}[A-Z]?$/;
export const FINISH_TAG = /^(F|C|B)\d{1,2}$/;
// 크기형 창호 기호(공공 주택 도서): 한 줄 "10X22FSD" 또는 두 줄(위 "12X11", 아래 "PW"). 앞 두 수가 폭·높이(100mm 단위),
// 끝 글자가 D면 문, W면 창(PW·AW 창, SD·FSD·PD 문)
export const SIZE_TAG = /^(\d{1,2}(?:\.\d)?)X([1-3]?\d(?:\.\d)?)([A-Z]{1,4})(\d{0,2})$/;
const SIZE_BARE = /^(\d{1,2}(?:\.\d)?)\s*[X×x]\s*([1-3]?\d(?:\.\d)?)$/;
export const tagText = (s) => String(s || '').replace(/\s+/g, '').replace(/×/g, 'X').toUpperCase();
export function sizeTag(code) {
  const m = SIZE_TAG.exec(tagText(code));
  if (!m) return null;
  const kind = /D$/.test(m[3]) ? 'door' : /W$/.test(m[3]) ? 'window' : null;
  return kind && { kind, widthMm: Math.round(Number(m[1]) * 100), heightMm: Math.round(Number(m[2]) * 100) };
}

export function tagKind(code) {
  const s = String(code || '').trim();
  if (WALL_TAG.test(s)) return 'wall';
  if (DOOR_TAG.test(s)) return 'door';
  if (WINDOW_TAG.test(s)) return 'window';
  const st = sizeTag(s);
  if (st) return st.kind;
  if (FINISH_TAG.test(s)) return 'finish';
  return null;
}

const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- 종류별

function levelsFrom(texts) {
  const out = [];
  for (const t of texts) {
    const m = /^(B\d+F?|\d+F|RF|PH|지붕층?|옥탑|지하\s*\d+층|\d+층)\s*(?:(FL|SL|EL|GL)\s*)?([+＋\-−±]?)\s*([\d,]+(?:\.\d+)?)?$/i.exec(t.t.replace(/\s+/g, ' ').trim());
    if (!m || (!m[2] && m[4] == null && !/±/.test(m[3]))) continue;
    const name = m[1].replace(/\s/g, '').toUpperCase().replace(/^(\d+)층$/, '$1F').replace(/^지하(\d+)층$/, 'B$1');
    let e = m[4] ? Number(m[4].replace(/,/g, '')) : 0;
    if (/[-−]/.test(m[3])) e = -e;
    if (!out.some((l) => l.name === name)) out.push({ name, elevationMm: e });
  }
  return withKinds(out);
}

// 이름만 쓴 레벨("3층바닥", "지붕 바닥선", "옥탑지붕바닥", "12F")이 세로로 쌓인 입·단면(공개 도서): 가장 많이 쌓인 줄에서
// 1층을 0으로 글자 높이 차이를 mm로 바꾼다. 좌표 단위로 기준층 층고가 2.4~4.5m가 아니면 도면 축척(1/N)·흔한 축척으로 다시 보고,
// 그래도 아니면 쓰지 않는다.
const LEVEL_NAME = /^(?:지하\s*(\d+)\s*층|(\d+)\s*층|(\d+)F|(지붕)\s*층?|(옥탑)\s*(지붕)?|(PIT))\s*(?:바닥\s*선?|SL|FL)?$/i;
function stackedLevels(texts, unitM, scaleText) {
  const cand = texts.filter((t) => LEVEL_NAME.test(String(t.t || '').replace(/\s+/g, ' ').trim()) && Math.abs((((t.rot || 0) % 360) + 360) % 360) < 1);
  const cols = [];
  for (const t of cand) {
    const c = cols.find((x) => Math.abs(x.x - t.x) <= (t.size || 1) * 3);
    if (c) c.items.push(t);
    else cols.push({ x: t.x, items: [t] });
  }
  // 같은 세로줄에 입면도 여러 개가 위아래로 놓인 시트: 간격이 보통의 3배 넘게 벌어지는 곳에서 나눈다
  const runs = cols.flatMap((c) => {
    const it = [...c.items].sort((a, b) => a.y - b.y);
    const gaps = it.slice(1).map((t, i) => t.y - it[i].y).filter((g) => g > 0).sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)] || 0;
    const out = [[]];
    it.forEach((t, i) => { if (i && med && t.y - it[i - 1].y > med * 3) out.push([]); out[out.length - 1].push(t); });
    return out.map((items) => ({ items }));
  });
  const best = runs.sort((a, b) => b.items.length - a.items.length)[0];
  if (!best || best.items.length < 3) return [];
  const nameOf = (s) => {
    const m = LEVEL_NAME.exec(String(s).replace(/\s+/g, ' ').trim());
    if (m[1]) return `B${m[1]}`;
    if (m[2] || m[3]) return `${Number(m[2] || m[3])}F`;
    if (m[5]) return m[6] ? 'PHR' : 'PH';
    if (m[4]) return 'RF';
    return 'PIT';
  };
  const ys = new Map();
  for (const t of best.items) { const n = nameOf(t.t); if (!ys.has(n)) ys.set(n, t.y); }
  const base = ys.get('1F');
  if (base == null) return [];
  const gapsOf = (k) => {
    const e = [...ys.values()].map((y) => (y - base) * k).sort((a, b) => a - b);
    const g = e.slice(1).map((v, i) => v - e[i]).filter((v) => v > 0).sort((a, b) => a - b);
    return g[Math.floor(g.length / 2)] || 0;
  };
  const unit = (unitM || 0.001) * 1000;
  const fromText = Number(/1\s*[/:]\s*(\d{2,4})/.exec(String(scaleText || ''))?.[1] || 0);
  const k = [unit, ...(fromText ? [unit * fromText] : []), ...[50, 100, 150, 200, 250, 300, 400, 500, 600].map((n) => unit * n)]
    .find((x) => { const g = gapsOf(x); return g >= 2400 && g <= 4500; });
  if (!k) return [];
  const list = [...ys].map(([name, y]) => ({ name, elevationMm: Math.round(((y - base) * k) / 10) * 10 }));
  // 중간 층을 생략해 끊어 그린 단면("2층" 바로 위에 "11층")은 높이가 압축돼 있어 버린다
  const nums = list.filter((l) => /^\d+F$/.test(l.name)).map((l) => ({ n: parseInt(l.name, 10), e: l.elevationMm })).sort((a, b) => a.n - b.n);
  const one = nums.slice(1).filter((x, i) => x.n - nums[i].n === 1).map((x, i) => x.e - nums.slice(0, -1).filter((_, j) => nums[j + 1].n - nums[j].n === 1)[i].e);
  const typ = one.sort((a, b) => a - b)[Math.floor(one.length / 2)] || 0;
  for (let i = 1; i < nums.length; i++) {
    const dn = nums[i].n - nums[i - 1].n;
    const de = nums[i].e - nums[i - 1].e;
    if (de <= 0 || (dn > 1 && typ && de < (dn - 0.5) * typ)) return [];
  }
  return list;
}

function withKinds(out) {
  out.sort((a, b) => a.elevationMm - b.elevationMm);
  const typicalH = (() => {
    const hs = out.slice(0, -1).map((l, i) => out[i + 1].elevationMm - l.elevationMm).filter((h) => h > 0).sort((a, b) => a - b);
    return hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  })();
  const levels = out.map((l, i) => {
    const next = out[i + 1];
    const heightMm = next ? next.elevationMm - l.elevationMm : null;
    let kind = 'typical';
    if (/^B\d/.test(l.name) || l.elevationMm < 0) kind = 'basement';
    else if (/^(RF|PH|지붕|옥탑)/.test(l.name)) kind = 'rooftop';
    else if (i === out.findIndex((x) => x.elevationMm >= 0) && heightMm && typicalH && heightMm >= typicalH * 1.3) kind = 'pilotis';
    return { name: l.name, elevationMm: l.elevationMm, heightMm, kind };
  });
  return levels;
}

function levelExtract(d, sheet) {
  let levels = levelsFrom(d.texts);
  let how = '레벨 표기 글자(15F FL+42,200 등)';
  if (levels.length < 2) {
    const st = stackedLevels(d.texts, d.unitM, d.scaleText);
    if (st.length >= 2) { levels = withKinds(st); how = '쌓인 층 이름 글자(3층바닥 등)의 높이 차이'; }
  }
  const relative = how.startsWith('쌓인');
  const above = levels.filter((l) => /^\d+F$/.test(l.name)).length;
  const below = levels.filter((l) => l.kind === 'basement').length;
  const top = levels.length ? levels[levels.length - 1].elevationMm : null;
  return {
    building: sheet.refs?.buildings?.[0] || null,
    levels,
    floorsAbove: above || null,
    floorsBelow: below,
    totalHeightMm: top,
    notes: `규칙: ${how}에서 읽음`,
    ...(relative ? { relative: true } : {}),
  };
}

function sitePlanExtract(d) {
  const labels = d.texts.filter((t) => /^\d{2,4}\s*동$/.test(t.t.trim()) || /(주민\s*공동|커뮤니티|공동시설|관리동|경로당|어린이집|피트니스|상가|근린)/.test(t.t));
  const floorTexts = d.texts.filter((t) => /지상\s*\d+\s*층/.test(t.t));
  const buildings = labels.map((t) => {
    const f = floorTexts.filter((x) => near(x, t) < Math.max(t.size, x.size) * 6).sort((a, b) => near(a, t) - near(b, t))[0];
    const label = t.t.replace(/\s+/g, '').trim();
    return {
      label,
      kind: /동$/.test(label) ? 'apartment' : /상가|근린/.test(label) ? 'commercial' : 'community',
      outlineHandles: null,
      labelPos: [t.x, t.y],
      floorsText: f ? f.t.trim() : null,
      confidence: 0.5,
    };
  });
  return { buildings, roads: [], northDeg: null, boundaryHint: null };
}

function planTags(texts) {
  const tags = [];
  const used = new Set();
  // 두 줄 크기형 기호: "12X11" 바로 아래(또는 같은 줄 오른쪽) 영문 기호
  for (const t of texts) {
    const bare = SIZE_BARE.exec(String(t.t || '').trim());
    if (!bare) continue;
    const s = t.size || 1;
    const letters = texts.filter((u) => u !== t && !used.has(u) && /^[A-Z]{1,4}\d{0,2}$/.test(String(u.t || '').trim()));
    const below = letters.filter((u) => Math.abs(u.x - t.x) < s * 4 && t.y - u.y > s * 0.3 && t.y - u.y < s * 3.2).sort((a, b) => (t.y - a.y) - (t.y - b.y))[0]
      || letters.filter((u) => Math.abs(u.y - t.y) < s * 0.5 && u.x > t.x && u.x - t.x < s * 9).sort((a, b) => a.x - b.x)[0]; // 같은 줄 오른쪽("10X22 FSD")
    if (!below) continue;
    const code = `${bare[1]}X${bare[2]}${below.t.trim()}`;
    const kind = tagKind(code);
    if (!kind) continue;
    used.add(t);
    used.add(below);
    tags.push({ code, kind, pos: [(t.x + below.x) / 2, (t.y + below.y) / 2], rot: t.rot ?? 0 });
  }
  for (const t of texts) {
    if (used.has(t)) continue;
    const raw = String(t.t || '').trim();
    const code = SIZE_TAG.test(tagText(raw)) ? tagText(raw) : raw;
    const kind = tagKind(code);
    if (kind) tags.push({ code, kind, pos: [t.x, t.y], rot: t.rot ?? 0 });
  }
  return tags;
}

function roomsOf(texts, roles) {
  return texts.filter((t) => isRoomName(t.t) || SHAFT_NAME.test(String(t.t || '').trim()))
    .map((t) => ({ name: t.t.trim(), use: roomUse(t.t), labelPos: [t.x, t.y], _size: t.size }));
}

function floorPlanExtract(d, roles) {
  const texts = d.texts;
  const lineTexts = texts.filter((t) => /^(\d{1,2})\s*호(\s*라인)?$/.test(t.t.trim()));
  const typeTexts = texts.filter((t) => /^\d{2,3}[A-Z]{1,2}\d?$/.test(t.t.trim()));
  const units = lineTexts.map((t) => {
    const ty = typeTexts.filter((x) => Math.abs(x.x - t.x) < t.size * 3).sort((a, b) => near(a, t) - near(b, t))[0];
    return { line: /^(\d{1,2})/.exec(t.t.trim())[1], unitType: ty ? ty.t.trim() : null, labelPos: [t.x, t.y] };
  });
  for (const ty of typeTexts) if (!units.some((u) => u.unitType === ty.t.trim() && Math.abs(u.labelPos[0] - ty.x) < ty.size * 3)) units.push({ line: null, unitType: ty.t.trim(), labelPos: [ty.x, ty.y] });
  const cores = texts.filter((t) => /계단/.test(t.t) || /승강기|엘리베이터|^E\.?V$/i.test(t.t.trim())).map((t) => ({ kind: /계단/.test(t.t) ? 'stair' : 'elevator', pos: [t.x, t.y] }));
  return { rooms: roomsOf(texts, roles).map(({ _size, ...r }) => r), units, tags: planTags(texts), cores, notes: '규칙: 실명 사전·기호 패턴으로 읽음' };
}

function unitPlanExtract(d, roles, sheet) {
  const rooms = roomsOf(d.texts, roles).map((r) => {
    const area = d.texts.filter((t) => /^\d+(\.\d+)?\s*(㎡|m2|m²)$/i.test(t.t.trim()) && Math.abs(t.x - r.labelPos[0]) < r._size * 3 && t.y < r.labelPos[1] && r.labelPos[1] - t.y < r._size * 3)
      .sort((a, b) => Math.abs(a.y - r.labelPos[1]) - Math.abs(b.y - r.labelPos[1]))[0];
    const { _size, ...rest } = r;
    return { ...rest, areaText: area ? area.t.trim() : null };
  });
  const areaM = d.texts.map((t) => /전용\s*면적\s*([\d.]+)/.exec(t.t)).find(Boolean);
  const typeName = sheet.refs?.unitTypes?.[0] || (/(\d{2,3}[A-Z]{1,2})/.exec(sheet.title || '') || [])[1] || '';
  return { typeName, areaM2: areaM ? Number(areaM[1]) : null, rooms, tags: planTags(d.texts), waterproofRooms: [], notes: '규칙: 실명 사전·기호 패턴으로 읽음' };
}

function finishExtract(d) {
  const assemblies = [];
  const rooms = [];
  for (const t of d.tables || []) {
    const wall = headerColumns(t.rows, { code: /^기호|^부호|CODE/i, name: /명칭|구분|종류|NAME/i, comp: /구성|상세|재료|LAYER/i, thick: /두께|THK/i });
    if (wall && wall.cols.code != null && wall.cols.comp != null) {
      for (const row of t.rows.slice(wall.row + 1)) {
        const code = (row[wall.cols.code] || '').trim();
        if (!/^[A-Z]{1,3}-?\d{1,3}[A-Z]?$/.test(code)) continue;
        const kind = /^W/.test(code) ? 'wall' : /^F/.test(code) ? 'floor' : /^C/.test(code) ? 'ceiling' : /^R/.test(code) ? 'roof' : 'wall';
        assemblies.push({ code, kind, name: (row[wall.cols.name] || '').trim() || code, layers: parseComposition(row[wall.cols.comp]) });
      }
      continue;
    }
    const fin = finishHeader(t.rows);
    if (fin && fin.cols.room != null && (fin.cols.floor != null || fin.cols.wall != null)) {
      let prev = null;
      for (const row of t.rows.slice(fin.next)) {
        const name = (row[fin.cols.room] || '').replace(/\s+/g, ' ').trim();
        if (!name || name.length > 30 || /^실\s*명$/.test(name)) { prev = null; continue; }
        const cell = (k) => {
          const v = fin.cols[k] != null ? (row[fin.cols[k]] || '').trim() : '';
          const under = fin.under[k] != null ? (row[fin.under[k]] || '').trim() : '';
          return (v && !/^[-–—]$/.test(v) ? v : under && !/^[-–—]$/.test(under) ? under : '') || null;
        };
        const types = (cell('types') || '').split(/[,，、·/\s]+/).filter(Boolean);
        const zones = [];
        if (/방수/.test(cell('wp') || '')) zones.push('waterproof');
        const r = { roomName: name, unitTypes: types, floor: cell('floor'), base: cell('base'), wall: cell('wall'), ceiling: cell('ceiling'), zones };
        // 한 실을 일부 칸만 나눈 줄(벽 아래·위, 최하층 등)은 한 행으로 합친다
        if (prev && prev.roomName === name && prev.unitTypes.join() === types.join()) {
          for (const k of ['floor', 'base', 'wall', 'ceiling']) if (r[k] && !(prev[k] || '').split(' / ').includes(r[k])) prev[k] = prev[k] ? `${prev[k]} / ${r[k]}` : r[k];
          for (const z of zones) if (!prev.zones.includes(z)) prev.zones.push(z);
          continue;
        }
        rooms.push(r);
        prev = r;
      }
    }
  }
  return { assemblies, rooms, notes: '규칙: 표 머리글(기호·구성 / 실명·바닥·벽·천장)로 읽음' };
}

// 마감표 머리글: 한 줄(실명·바닥·벽·천장) 또는 두 줄(바닥 → 바탕·마감·두께). 아랫줄이 있으면 "바닥 마감"처럼 합친 이름으로
// 열을 고르고, 같은 부위에 열이 여럿이면 '마감' 열을 쓴다('바탕'은 마감 칸이 비었을 때만).
const FIN_KEYS = { room: /^실\s*명|^실$|ROOM/i, types: /타입|TYPE|적용/i, base: /걸레|BASE/i, floor: /바닥|FLOOR/i, wall: /^벽|WALL/i, ceiling: /천장|천정|CEIL/i, wp: /방수|비고|REMARK/i };
const FIN_SUB = /^(바탕|마감|두께|높이|재료|재질|규격|걸레받이|FINISH|BASE|THK|H)$/i;
export function finishHeader(rows) {
  const h = headerColumns(rows, FIN_KEYS);
  if (!h) return null;
  const tight = (c) => String(c || '').replace(/\s+/g, '');
  const top = rows[h.row].map(tight);
  const sub = (rows[h.row + 1] || []).map(tight);
  const isSub = sub.filter((c) => FIN_SUB.test(c.replace(/\(.*?\)/g, ''))).length >= 2;
  const labels = top.map((c, i) => (isSub && sub[i] && sub[i] !== c ? `${c} ${sub[i]}` : c));
  const cols = {};
  const under = {}; // 같은 부위의 바탕 열
  const taken = new Set();
  for (const [k, re] of Object.entries(FIN_KEYS)) {
    const cand = labels.map((l, i) => [l, i]).filter(([l, i]) => !taken.has(i) && re.test(l));
    if (!cand.length) continue;
    const pick = cand.find(([l]) => /마감|FINISH/i.test(l)) || cand.find(([l]) => !/바탕|두께|THK|높이|\bH\b/i.test(l)) || cand[0];
    cols[k] = pick[1];
    taken.add(pick[1]);
    if (k === 'room') for (const [, i] of cand) taken.add(i); // 실명 칸이 둘로 나뉜 표(실명 | 위치)
    const b = cand.find(([l]) => /바탕/.test(l));
    if (b && b[1] !== pick[1]) under[k] = b[1];
  }
  return { cols, under, next: h.row + (isSub ? 2 : 1) };
}

function windowExtract(d) {
  const items = [];
  for (const t of d.tables || []) {
    const h = headerColumns(t.rows, { code: /^기호|^부호|CODE|^NO/i, kind: /구분|종류|TYPE/i, w: /^폭|너비|^W$|WIDTH/i, h: /높이|^H$|HEIGHT/i, sill: /창대|SILL/i, mat: /재질|재료|MATERIAL/i, count: /수량|개수|QTY/i });
    if (!h || h.cols.code == null || h.cols.w == null) continue;
    for (const row of t.rows.slice(h.row + 1)) {
      const code = (row[h.cols.code] || '').trim();
      const kind = tagKind(code);
      if (kind !== 'door' && kind !== 'window') continue;
      const n = (k) => { const v = h.cols[k] != null ? Number(String(row[h.cols[k]] || '').replace(/[,\s]/g, '')) : NaN; return Number.isFinite(v) && String(row[h.cols[k]] || '').trim() !== '' ? v : null; };
      const kc = h.cols.kind != null ? row[h.cols.kind] : '';
      items.push({ code, kind: /문|DOOR/i.test(kc) ? 'door' : /창|WIN/i.test(kc) ? 'window' : kind, widthMm: n('w'), heightMm: n('h'), sillMm: n('sill'), material: h.cols.mat != null ? (row[h.cols.mat] || '').trim() || null : null, count: n('count') });
    }
  }
  // 크기형 기호(카드형·가로로 뒤집힌 창호표): 기호의 폭·높이, 근처에 "1200X1100" 같은 치수 글자가 있으면(15% 안) 그 값
  const seen = new Set(items.map((i) => i.code));
  const dimTexts = (d.texts || []).map((t) => ({ t, m: /(\d{3,5})\s*[X×x*]\s*(\d{3,5})/.exec(String(t.t || '')) })).filter((x) => x.m);
  const sizes = (d.texts || []).map((t) => t.size || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const size = sizes[Math.floor(sizes.length / 2)] || 1;
  for (const tag of planTags(d.texts || [])) {
    const st = sizeTag(tag.code);
    if (!st || seen.has(tag.code)) continue;
    seen.add(tag.code);
    let best = null;
    for (const { t, m } of dimTexts) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      const diff = Math.max(Math.abs(w - st.widthMm) / st.widthMm, Math.abs(h - st.heightMm) / st.heightMm);
      const dist = Math.hypot(t.x - tag.pos[0], t.y - tag.pos[1]);
      if (diff <= 0.15 && dist < size * 60 && (!best || diff < best.diff - 1e-9 || (Math.abs(diff - best.diff) < 1e-9 && dist < best.dist))) best = { w, h, diff, dist };
    }
    items.push({ code: tag.code, kind: st.kind, widthMm: best ? best.w : st.widthMm, heightMm: best ? best.h : st.heightMm, sillMm: null, material: null, count: null });
  }
  return { items };
}

// 외부 마감표: 기호·재료·색·부위(21 지시서 2절)
function exteriorExtract(d) {
  const items = [];
  for (const t of d.tables || []) {
    const h = headerColumns(t.rows, { code: /^기호|^부호|CODE/i, material: /재료|마감|MATERIAL/i, color: /색상?|COLOR/i, part: /부위|위치/i });
    if (!h || h.cols.code == null || h.cols.material == null) continue;
    for (const row of t.rows.slice(h.row + 1)) {
      const code = String(row[h.cols.code] || '').trim().toUpperCase();
      if (!/^[A-Z]{1,3}-?\d+[A-Z]?$/.test(code)) continue;
      const hex = /#[0-9A-F]{6}/i.exec(String(h.cols.color != null ? row[h.cols.color] : ''))?.[0] || null;
      items.push({ code, material: String(row[h.cols.material] || '').trim(), color: hex, part: h.cols.part != null ? String(row[h.cols.part] || '').trim() : null });
    }
  }
  return { items };
}

/**
 * @param {{ category: string, refs: any, title?: string }} sheet
 * @param {any} digest
 * @returns {{ layerRoles: Record<string,string>, legend: any[], extracted: any|null }}
 */
export function ruleRead(sheet, digest, { layerProfile = {} } = {}) {
  const layerRoles = layerRolesFor(digest.layers || [], layerProfile);
  const kind = extractKindFor(sheet);
  let data = null;
  if (kind === 'LevelExtract') data = levelExtract(digest, sheet);
  else if (kind === 'SitePlanExtract') data = sitePlanExtract(digest);
  else if (kind === 'FloorPlanExtract') data = floorPlanExtract(digest, layerRoles);
  else if (kind === 'UnitPlanExtract') data = unitPlanExtract(digest, layerRoles, sheet);
  else if (kind === 'FinishScheduleExtract') data = finishExtract(digest);
  else if (kind === 'WindowScheduleExtract') data = windowExtract(digest);
  else if (kind === 'ExteriorFinishExtract') data = exteriorExtract(digest);
  else if (kind === 'SectionDetailExtract') data = readSection(digest, sheet);
  else if (kind === 'ConstructionDetailExtract') data = readDetails(digest);
  else if (kind === 'StructureScheduleExtract') data = readStructure(digest, sheet);
  return {
    layerRoles,
    legend: (digest.legend || []).map((l) => ({ symbol: l.symbol, meaning: l.text })),
    extracted: data ? { kind, source: 'rule', coords: 'sheet', data } : null,
  };
}
