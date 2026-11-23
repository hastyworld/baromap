// 단위세대 단면(상세) 읽기(38 지시서 1·4절 규칙): 슬래브 두께, 실별 천장고·천장 속, 바닥 구성 층 순서, 층고. 순수 함수.
// 시트 요약(digest)의 글자에서 읽는다. 지시선 글자 목록("강마루 10 / 시멘트몰탈 40 / … / 슬래브 210")은 위에서 아래 순서 그대로 층이 된다.
// 읽지 못한 값은 비운다(추정하지 않는다).
import { material } from './materials-ko.js';

const num = (s) => Number(String(s).replace(/,/g, ''));
const CH_RE = /^(.{0,14}?)\s*(?:C\.?H|반자\s*높이|천장\s*고|천정\s*고)\s*[=:：]?\s*([\d,]{3,6})\s*(?:mm)?$/i;
const VOID_RE = /천장\s*(?:속|내부|공간|깊이)\s*[=:：]?\s*([\d,]{2,5})/;
const FLOOR_H_RE = /층\s*고\s*[=:：]?\s*([\d,]{4,5})/;
const GROUP_RE = /바닥\s*(?:구성|마감\s*구성|상세|단면)\s*(?:\(([^)]*)\))?/;
// 천장·벽체 구성 묶음(42 지시서 4.3): "천장 구성(거실·침실)", "벽체 구성(외벽)" — 바닥과 같은 모양(머리글 아래 "재료 두께" 줄)
const PART_GROUPS = [['ceilings', /천[장정]\s*(?:구성|마감\s*구성|상세)\s*(?:\(([^)]*)\))?/], ['walls', /벽체?\s*(?:구성|마감\s*구성)\s*(?:\(([^)]*)\))?/]];
const SLAB_RE =/(?:콘크리트\s*)?슬래브\s*(?:THK\.?\s*)?([\d,]{2,4})|SLAB\s*(?:THK\.?\s*)?([\d,]{2,4})/i;
const ROOMISH = /거실|침실|안방|주방|식당|욕실|화장실|현관|발코니|드레스룸|다용도실|실외기실|대피공간|복도|팬트리|펜트리/;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * @param {{ texts: { t: string, x: number, y: number, size: number }[] }} digest
 * @param {{ refs?: { unitTypes?: string[] }, title?: string }} sheet
 */
export function readSection(digest, sheet = {}) {
  const texts = (digest.texts || []).map((t) => ({ ...t, t: String(t.t).replace(/\s+/g, ' ').trim() })).filter((t) => t.t);
  const used = new Set();
  // 바닥 구성 묶음: 머리글 아래로 같은 열에 이어지는 "재료 두께" 줄
  const floors = [];
  for (const g of texts.filter((t) => GROUP_RE.test(t.t))) {
    const rooms = (GROUP_RE.exec(g.t)[1] || '').split(/[·,，/、\s]+/).map((x) => x.trim()).filter(Boolean);
    const col = texts.filter((t) => t !== g && t.y < g.y && Math.abs(t.x - g.x) < Math.max(g.size, t.size) * 2.5).sort((a, b) => b.y - a.y);
    const layers = [];
    let lastY = g.y;
    for (const t of col) {
      if (lastY - t.y > Math.max(g.size, t.size) * 3.2) break;
      const m = material(t.t);
      if (m.thicknessMm == null || !m.name || /층\s*고|CH\b/i.test(t.t)) break;
      const slab = SLAB_RE.test(t.t);
      layers.push({ material: slab ? '콘크리트' : m.name, category: slab ? 'structure' : m.category, thicknessMm: m.thicknessMm, slab, pos: [t.x, t.y] });
      used.add(t);
      lastY = t.y;
    }
    if (layers.length) floors.push({ rooms, layers, pos: [g.x, g.y] });
  }
  // 천장·벽체 구성: 같은 방식으로 읽는다(슬래브 구분 없음). 두께 없는 얇은 마감(천장지·도장)도 층으로 받는다
  const partGroups = { ceilings: [], walls: [] };
  for (const [part, re] of PART_GROUPS) {
    for (const g of texts.filter((t) => re.test(t.t) && !GROUP_RE.test(t.t))) {
      const rooms = (re.exec(g.t)[1] || '').split(/[·,，/、\s]+/).map((x) => x.trim()).filter(Boolean);
      const col = texts.filter((t) => t !== g && t.y < g.y && Math.abs(t.x - g.x) < Math.max(g.size, t.size) * 2.5).sort((a, b) => b.y - a.y);
      const layers = [];
      let lastY = g.y;
      for (const t of col) {
        if (lastY - t.y > Math.max(g.size, t.size) * 3.2) break;
        const m = material(t.t);
        if (!m.name || m.category === 'other' || /층\s*고|CH\b|구성/i.test(t.t)) break;
        for (let k = 0; k < (m.plies || 1); k++) layers.push({ material: m.name, category: m.category, thicknessMm: m.thicknessMm });
        used.add(t);
        lastY = t.y;
      }
      if (layers.length) partGroups[part].push({ rooms, layers, pos: [g.x, g.y] });
    }
  }
  // 슬래브: 바닥 구성의 구조체 층, 없으면 "슬래브 210" 글자
  const slabs = floors.flatMap((f) => f.layers.filter((l) => l.slab).map((l) => l.thicknessMm));
  for (const t of texts) if (!used.has(t)) { const m = SLAB_RE.exec(t.t); if (m) slabs.push(num(m[1] || m[2])); }
  const slabMm = slabs.length ? mode(slabs) : null;
  // 천장고: "거실 CH=2,300". 실 이름이 없으면 가까운 실 이름 글자
  const roomLabels = texts.filter((t) => ROOMISH.test(t.t) && t.t.length <= 10 && !CH_RE.test(t.t));
  const rooms = [];
  for (const t of texts) {
    const m = CH_RE.exec(t.t);
    if (!m) continue;
    let name = m[1].trim();
    if (!name || !ROOMISH.test(name)) {
      const near = roomLabels.filter((r) => dist(r, t) < t.size * 8).sort((a, b) => dist(a, t) - dist(b, t))[0];
      name = near ? near.t : '';
    }
    if (!name) continue;
    rooms.push({ name, ceilingMm: num(m[2]), voidMm: null, pos: [t.x, t.y] });
  }
  // 천장 속: 가장 가까운 천장고 글자의 실
  for (const t of texts) {
    const m = VOID_RE.exec(t.t);
    if (!m || !rooms.length) continue;
    const r = rooms.slice().sort((a, b) => Math.hypot(a.pos[0] - t.x, a.pos[1] - t.y) - Math.hypot(b.pos[0] - t.x, b.pos[1] - t.y))[0];
    if (r.voidMm == null) r.voidMm = num(m[1]);
  }
  const fh = texts.map((t) => FLOOR_H_RE.exec(t.t)).find(Boolean);
  return {
    unitType: sheet.refs?.unitTypes?.[0] || (/(\d{2,3}[A-Z]{1,2})/.exec(sheet.title || '') || [])[1] || null,
    floorHeightMm: fh ? num(fh[1]) : null,
    slabMm,
    floors: floors.map((f) => ({ rooms: f.rooms, layers: f.layers.map(({ pos, ...l }) => l), pos: f.pos })),
    ceilings: partGroups.ceilings,
    walls: partGroups.walls,
    rooms,
    notes: '규칙: 바닥·천장·벽체 구성 지시선 글자·CH 표기·층고 글자에서 읽음',
  };
}

function mode(list) {
  const c = new Map();
  for (const v of list) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/** 바닥 구성 중 슬래브를 뺀 두께 합 */
export const floorBuildMm = (layers) => (layers || []).filter((l) => !l.slab).reduce((s, l) => s + (l.thicknessMm || 0), 0);
