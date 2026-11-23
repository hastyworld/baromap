// 마감(04 9절): 카탈로그(재료·조립체), 벽에 조립체 붙이기(벽체 기호 → 가장 가까운 벽 → 같은 직선으로 전파),
// 기호 없는 벽 기본값(assumed), 실 마감(마감표), 시공부위(방수·단열·차음·내화). 순수 함수.
import { material, materialId, parseComposition, CATEGORY_COLOR } from './materials-ko.js';
import { hash } from './ids.js';

const CORE = new Set(['structure', 'lightweight', 'masonry']);
const DEFAULT_THK = { finish: 10, board: 9.5, plaster: 15, waterproof: 2, insulation: 50, structure: 150, masonry: 100, lightweight: 65, other: 10 };

// 층 목록(바깥→구조체→실내 순서) → side 붙이기
export function withSides(layers) {
  const ci = layers.findIndex((l) => CORE.has(l.category));
  return layers.map((l, i) => ({ ...l, side: ci < 0 ? 'in' : i < ci ? 'out' : i === ci ? 'core' : 'in' }));
}

export function createCatalog() {
  const materials = new Map();
  const assemblies = new Map();
  const mat = (name, category) => {
    const m = material(name);
    const cat = category || m.category;
    const id = materialId(m.name);
    if (!materials.has(id)) materials.set(id, { id, name: m.name, category: cat, color: m.color || CATEGORY_COLOR[cat], trades: m.trades });
    return id;
  };
  return {
    materials, assemblies, mat,
    addAssembly({ id, code = null, kind, name, layers, source }) {
      const ls = withSides(layers).map((l) => ({ materialId: mat(l.material, l.category), thicknessMm: l.thicknessMm ?? null, side: l.side }));
      const rec = { id, code, kind, name, layers: ls, source };
      assemblies.set(id, rec);
      return rec;
    },
    toJSON() {
      return {
        materials: [...materials.values()].sort((a, b) => a.id.localeCompare(b.id)),
        assemblies: [...assemblies.values()].sort((a, b) => a.id.localeCompare(b.id)),
      };
    },
  };
}

export const totalMm = (asm) => asm.layers.reduce((s, l) => s + (l.thicknessMm ?? 0), 0);

// 기호 없는 벽 기본값(04 9-4)
export const DEFAULTS = {
  exterior: { name: '(가정) 외벽 콘크리트 + 단열 + 석고보드 + 도배', layers: '콘크리트 200 + 비드법단열재 100 + 석고보드 9.5 + 실크벽지 0.5' },
  party: { name: '(가정) 세대간벽 콘크리트 + 석고보드 + 도배', layers: '실크벽지 0.5 + 석고보드 9.5 + 콘크리트 200 + 석고보드 9.5 + 실크벽지 0.5' },
  partition: { name: '(가정) 경량벽체 스터드 + 석고보드 2겹 + 도배', layers: '실크벽지 0.5 + 석고보드 9.5 + 경량스터드 65 + 석고보드 9.5 + 실크벽지 0.5' },
  bath: { name: '(가정) 욕실벽 콘크리트 + 방수 + 타일', layers: '콘크리트 150 + 액체방수 2 + 도기질타일 8' },
  masonry: { name: '(가정) 조적벽 블록 + 미장 + 도배', layers: '실크벽지 0.5 + 시멘트몰탈 18 + 시멘트벽돌 90 + 시멘트몰탈 18 + 실크벽지 0.5' },
};

export function defaultAssembly(catalog, key) {
  const id = `as_def_${key}`;
  if (!catalog.assemblies.has(id)) {
    const d = DEFAULTS[key];
    catalog.addAssembly({ id, kind: 'wall', name: d.name, layers: parseComposition(d.layers), source: { method: 'assumed', sheets: [], confidence: 0.3 } });
  }
  return id;
}

// 마감 글자(“석고보드 9.5 + 수성페인트”) → 마감 조립체(같은 글자면 같은 id)
export function finishAssembly(catalog, kind, text, source) {
  if (!text) return null;
  const id = `as_${kind[0]}_${hash(`${kind}|${text}`).slice(0, 8)}`;
  if (!catalog.assemblies.has(id)) {
    const layers = parseComposition(text).map((l) => ({ ...l, thicknessMm: l.thicknessMm ?? DEFAULT_THK[l.category] ?? 10, category: l.category === 'other' ? 'finish' : l.category }));
    catalog.addAssembly({ id, kind, name: text, layers: layers.map((l) => ({ ...l })), source });
    // 마감 조립체는 구조체 없이 전부 '실내' 쪽
    catalog.assemblies.get(id).layers.forEach((l) => { l.side = 'in'; });
  }
  return id;
}

/**
 * 마감표 행 찾기: 실명 + 타입(또는 시설 이름). 공백·괄호 차이는 무시.
 * 실제 도서는 한 행에 실을 묶어 쓴다("보육실,유희실,교사실", "주방/식당", "욕실(17㎡,18㎡)") — 정확히 같은 이름이 없으면
 * 괄호 속을 뺀 이름·쉼표/빗금으로 나눈 이름으로 찾는다.
 * rows: FinishScheduleExtract.rooms
 */
export function findFinishRow(rows, roomName, typeName) {
  const norm = (s) => String(s || '').replace(/[\s()（）]/g, '');
  const name = norm(roomName);
  const parts = (s) => {
    const bare = String(s || '').replace(/[(（][^)）]*[)）]/g, '');
    return [norm(bare), ...bare.split(/[,，、·/]/).map(norm)].filter(Boolean);
  };
  let candidates = rows.filter((r) => norm(r.roomName) === name);
  if (!candidates.length) candidates = rows.filter((r) => parts(r.roomName).includes(name) || parts(r.roomName).includes(parts(roomName)[0]));
  if (!candidates.length) return null;
  const t = norm(typeName);
  return candidates.find((r) => r.unitTypes.some((u) => norm(u) === t))
    || candidates.find((r) => !r.unitTypes.length || r.unitTypes.some((u) => /공통|전체|ALL/i.test(u)))
    || null;
}

// 벽에 기호 붙이기: 기호 위치에서 가장 가까운 벽(1.2m 이내) → 같은 직선·같은 두께로 이어진 벽에 전파(다른 기호를 만날 때까지)
export function assignWallCodes(edges, nodes, tags) {
  const code = new Map(); // edge index → { code, tagged }
  const dist = (p, e) => {
    const [ax, ay] = e.a;
    const [bx, by] = e.b;
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2));
    return Math.hypot(p[0] - (ax + dx * t), p[1] - (ay + dy * t));
  };
  // 글자 방향과 벽 방향이 같은가(180° 차이는 같은 방향). 회전을 모르면 방향은 따지지 않는다
  const sameDir = (t, e) => {
    if (t.rot == null) return true;
    const a = (Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180) / Math.PI;
    const d = (((a - t.rot) % 180) + 180) % 180;
    return d < 15 || d > 165;
  };
  for (const t of tags) {
    let best = -1;
    let bd = 1.2;
    edges.forEach((e, i) => { if (!sameDir(t, e)) return; const d = dist(t.pos, e) - e.t / 2; if (d < bd) { bd = d; best = i; } });
    if (best < 0) edges.forEach((e, i) => { const d = dist(t.pos, e) - e.t / 2; if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && !code.has(best)) code.set(best, { code: t.code, tagged: true, tagPos: t.pos });
  }
  // 전파
  const byNode = new Map();
  edges.forEach((e, i) => { for (const n of [e.u, e.v]) { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(i); } });
  const dir = (e) => { const d = [e.b[0] - e.a[0], e.b[1] - e.a[1]]; const l = Math.hypot(...d) || 1; return [d[0] / l, d[1] / l]; };
  const queue = [...code.keys()];
  while (queue.length) {
    const i = queue.shift();
    const e = edges[i];
    const c = code.get(i);
    for (const n of [e.u, e.v]) {
      for (const j of byNode.get(n) || []) {
        if (j === i || code.has(j)) continue;
        const f = edges[j];
        const cr = Math.abs(dir(e)[0] * dir(f)[1] - dir(e)[1] * dir(f)[0]);
        if (cr > Math.sin(Math.PI / 180) || Math.abs(e.t - f.t) > 0.012) continue;
        code.set(j, { code: c.code, tagged: false });
        queue.push(j);
      }
    }
  }
  return code;
}

export function zonesFor(space, row) {
  const z = new Set(row?.zones || []);
  if (space.name.includes('대피공간')) z.add('fireproof');
  return [...z].sort();
}
