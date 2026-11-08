// 단면·상세·구조 판독값 → 모델(38 지시서 5절). 값은 모두 수정 연산(validate.js)으로 넣는다: 조립에서 쓰고, 사람이 고칠 때도 같은 연산이다.
//   레벨 slabMm · 실 ceilingMm·floorAssemblyId · 세대 타입 section · 카탈로그 바닥 조립체·details·structure · 벽 조립체 structure
// 값이 없으면 넣지 않는다(기본값은 화면·렌더에서만). 순수 함수.
import { applyPatch } from './validate.js';
import { material, materialId } from './materials-ko.js';
import { floorBuildMm } from './read-section.js';
import { slug } from './ids.js';

const box = (p, r = 400) => (p ? { x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r } : null);
const ev = (s, pos) => ({ sheetId: s.id, sheetNo: s.sheetNo || '', ...(pos ? { bbox: box(pos) } : {}) });
const src = (s, pos, conf = 0.8) => ({ method: s.extracted?.source === 'ai' ? 'ai' : 'rule', sheets: [ev(s, pos)], confidence: conf });
const kindOf = (s) => s.extracted?.kind;

/**
 * @param {Record<string, any>} files 모델 파일(upgrade 뒤)
 * @param {any[]} sheets 판독이 끝난 시트(extracted)
 * @returns {{ ops: any[], report: { sections: any[], details: number, members: number, structureMarks: any[], structWall: any[], sectionUnmatched: string[] } }}
 */
// force: 사람이 고친 시트를 다시 넣을 때 — 있는 값도 새 값으로 바꾸고, 그 시트에서 온 상세 값은 지우고 다시 넣는다
export function detailOps(files, sheets, { force = false } = {}) {
  const ops = [];
  const report = { sections: [], details: 0, members: 0, structureMarks: [], structWall: [], sectionUnmatched: [] };
  const cat = files['catalog.json'] || { materials: [], assemblies: [] };
  const mats = new Set((cat.materials || []).map((m) => m.id));
  const asms = new Set((cat.assemblies || []).map((a) => a.id));
  const addMat = (name, category) => {
    const m = material(name);
    const id = materialId(m.name);
    if (!mats.has(id)) {
      ops.push({ op: 'add', file: 'catalog.json', collection: 'materials', element: { id, name: m.name, category: m.category === 'other' ? category || 'other' : m.category, color: m.color, trades: m.trades, spec: null, maker: null, perf: [], render: { textureId: null, tint: null } }, reason: '단면 바닥 구성 재료' });
      mats.add(id);
    }
    return id;
  };
  const typeFiles = Object.entries(files).filter(([k]) => k.startsWith('u-'));

  // ---- 단위세대 단면: 바닥 조립체, 실 천장고·바닥 조립체, 세대 타입 단면 요약, 그 타입이 있는 층의 슬래브 두께
  for (const s of sheets.filter((x) => kindOf(x) === 'SectionDetailExtract')) {
    const d = s.extracted.data || {};
    const hit = typeFiles.find(([, t]) => t.kind === 'unit' && (t.name === d.unitType || t.id === `ut_${slug(d.unitType || '')}`));
    if (!hit) { report.sectionUnmatched.push(d.unitType || s.sheetNo); continue; }
    const [file, type] = hit;
    const floors = (d.floors || []).map((f, i) => {
      const id = `as_fl_${type.id.replace(/^ut_/, '')}_${i + 1}`;
      const name = `${type.name} 바닥(${(f.rooms || []).join('·') || i + 1})`;
      const layers = (f.layers || []).map((l) => ({ materialId: addMat(l.material, l.category), thicknessMm: l.thicknessMm ?? null, side: l.slab ? 'core' : 'in' }));
      if (!asms.has(id)) {
        ops.push({ op: 'add', file: 'catalog.json', collection: 'assemblies', element: { id, code: null, kind: 'floor', name, layers, source: src(s, f.pos) }, reason: '단면 바닥 구성' });
        asms.add(id);
      } else if (force) ops.push({ op: 'update', file: 'catalog.json', id, set: { name, layers }, reason: '단면 바닥 구성 고침' });
      return { rooms: f.rooms || [], assemblyId: id, buildMm: floorBuildMm(f.layers) };
    });
    for (const sp of type.spaces || []) {
      const set = {};
      const r = (d.rooms || []).find((x) => x.name === sp.name);
      if (r?.ceilingMm) set.ceilingMm = r.ceilingMm;
      const f = floors.find((x) => x.rooms.some((w) => w && sp.name.includes(w)));
      if (f) set.floorAssemblyId = f.assemblyId;
      if (Object.keys(set).length) ops.push({ op: 'update', file, id: sp.id, set, reason: '단면 천장고·바닥 구성', evidence: [ev(s, r?.pos)] });
    }
    const section = {
      sheetId: s.id, sheetNo: s.sheetNo || '', floorHeightMm: d.floorHeightMm ?? null, slabMm: d.slabMm ?? null,
      floors, rooms: (d.rooms || []).map((r) => ({ name: r.name, ceilingMm: r.ceilingMm ?? null, voidMm: r.voidMm ?? null })),
    };
    ops.push({ op: 'update', file, id: type.id, set: { section }, reason: '단위세대 단면', evidence: [ev(s)] });
    if (d.slabMm) {
      for (const [bf, b] of Object.entries(files).filter(([k]) => k.startsWith('b-'))) {
        const levelIds = new Set((b.units || []).filter((u) => u.unitTypeId === type.id).map((u) => u.levelId));
        for (const l of b.levels || []) if (levelIds.has(l.id) && (l.slabMm == null || (force && l.slabMm !== d.slabMm))) ops.push({ op: 'update', file: bf, id: l.id, set: { slabMm: d.slabMm }, reason: `단면 슬래브(${type.name})`, evidence: [ev(s)] });
      }
    }
    report.sections.push({ unitType: type.name, sheetId: s.id, sheetNo: s.sheetNo, rooms: section.rooms.length, floors: floors.length });
  }

  // ---- 시공 상세 값
  const have = new Set((cat.details || []).map((x) => x.id));
  let n = have.size;
  for (const s of sheets.filter((x) => kindOf(x) === 'ConstructionDetailExtract')) {
    if (force) for (const old of (cat.details || []).filter((x) => x.source?.sheets?.[0]?.sheetId === s.id)) ops.push({ op: 'remove', file: 'catalog.json', id: old.id, reason: '상세 값 다시 넣기' });
    for (const d of s.extracted.data?.details || []) {
      let id;
      do { id = `dt_${String(++n).padStart(3, '0')}`; } while (have.has(id));
      have.add(id);
      ops.push({ op: 'add', file: 'catalog.json', collection: 'details', element: { id, key: d.key, value: d.value, note: d.note || '', title: d.title || '', appliesTo: d.appliesTo || {}, source: src(s, d.pos) }, reason: '시공 상세 값' });
      report.details++;
    }
  }

  // ---- 구조 부재 일람표 + 평면 기호, 벽 조립체의 구조 두께
  const members = [];
  for (const s of sheets.filter((x) => kindOf(x) === 'StructureScheduleExtract')) {
    const d = s.extracted.data || {};
    for (const m of d.members || []) {
      if (members.some((x) => x.mark === m.mark)) continue;
      const el = { id: `sm_${slug(m.mark)}`, mark: m.mark, kind: m.kind, thicknessMm: m.thicknessMm ?? null, sizeMm: m.sizeMm ?? null, note: m.note || '', source: src(s) };
      members.push({ ...el, sheet: s });
      if (!(cat.structure || []).some((x) => x.id === el.id)) ops.push({ op: 'add', file: 'catalog.json', collection: 'structure', element: el, reason: '구조 부재 일람표' });
      else if (force) ops.push({ op: 'update', file: 'catalog.json', id: el.id, set: { kind: el.kind, thicknessMm: el.thicknessMm, sizeMm: el.sizeMm, note: el.note }, reason: '구조 부재 고침' });
      report.members++;
    }
    for (const p of d.planMarks || []) report.structureMarks.push({ mark: p.mark, sheetId: s.id, sheetNo: s.sheetNo, pos: p.pos });
  }
  const walls = members.filter((m) => m.kind === 'wall' && m.thicknessMm);
  if (walls.length) {
    const catOf = new Map((cat.materials || []).map((m) => [m.id, m.category]));
    for (const a of (cat.assemblies || []).filter((x) => x.kind === 'wall')) {
      const core = (a.layers || []).find((l) => l.side === 'core' && catOf.get(l.materialId) === 'structure');
      if (!core?.thicknessMm) continue;
      const hit = walls.filter((m) => m.thicknessMm === core.thicknessMm);
      if (hit.length === 1) ops.push({ op: 'update', file: 'catalog.json', id: a.id, set: { structure: { mark: hit[0].mark, thicknessMm: hit[0].thicknessMm, sheetId: hit[0].sheet.id, sheetNo: hit[0].sheet.sheetNo || '' } }, reason: '구조 벽 두께', evidence: [ev(hit[0].sheet)] });
      else if (!hit.length) report.structWall.push({ code: a.code, assemblyId: a.id, coreMm: core.thicknessMm, structure: walls.map((m) => `${m.mark} ${m.thicknessMm}`) });
    }
  }
  return { ops, report };
}

/** 사람이 [상세 값]에서 고친 시트 하나 → 새 버전을 만들 수정 연산 */
export const sheetDetailOps = (files, sheet) => detailOps(files, [sheet], { force: true }).ops;

/** 조립 끝에 붙이기: 연산을 만들고 적용. 실패하면 원래 파일 그대로(기록에 오류) */
export function applyDetails(files, sheets, report) {
  const { ops, report: r } = detailOps(files, sheets);
  Object.assign(report, { details: r });
  if (!ops.length) return files;
  const res = applyPatch(files, ops, { method: 'rule', keepSource: true });
  if (!res.ok) { report.details.errors = res.errors; return files; }
  return res.files;
}
