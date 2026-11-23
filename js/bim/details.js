// 단면·상세·구조 판독값 → 모델(38 지시서 5절). 값은 모두 수정 연산(validate.js)으로 넣는다: 조립에서 쓰고, 사람이 고칠 때도 같은 연산이다.
//   레벨 slabMm · 실 ceilingMm·floorAssemblyId·ceilingAssemblyId · 기호 없는 벽의 assemblyId(상세 벽체 구성) · 세대 타입 section · 카탈로그 바닥 조립체·details·structure · 벽 조립체 structure
// 값이 없으면 넣지 않는다(기본값은 화면·렌더에서만). 순수 함수.
import { applyPatch } from './validate.js';
import { material, materialId } from './materials-ko.js';
import { floorBuildMm } from './read-section.js';
import { slug } from './ids.js';
import { markParts } from './read-structure.js';
import { templateParts, placeStructPlan } from './struct-place.js';

const box = (p, r = 400) => (p ? { x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r } : null);
const ev = (s, pos) => ({ sheetId: s.id, sheetNo: s.sheetNo || '', ...(pos ? { bbox: box(pos) } : {}) });
const src = (s, pos, conf = 0.8) => ({ method: s.extracted?.source === 'ai' ? 'ai' : 'rule', sheets: [ev(s, pos)], confidence: conf });
const kindOf = (s) => s.extracted?.kind;
const CORE = new Set(['structure', 'lightweight', 'masonry']); // 벽의 구조(심) 층

/**
 * @param {Record<string, any>} files 모델 파일(upgrade 뒤)
 * @param {any[]} sheets 판독이 끝난 시트(extracted)
 * @returns {{ ops: any[], report: { sections: any[], details: number, members: number, structureMarks: any[], structWall: any[], sectionUnmatched: string[] } }}
 */
// force: 사람이 고친 시트를 다시 넣을 때 — 있는 값도 새 값으로 바꾸고, 그 시트에서 온 상세 값은 지우고 다시 넣는다
// frames: 동 층 템플릿마다 건축 평면 좌표 틀(build.js의 report.planFrames). 있으면 구조 평면 기호를 벽·실에 붙인다(43 지시서 3절)
export function detailOps(files, sheets, { force = false, frames = null } = {}) {
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
  const given = new Set(); // 이번에 바닥·천장 구성을 받은 실("실id|칸")

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
    // 천장·벽체 구성(42 지시서 4.2·4.3): 조립체로 넣고, 천장은 실에, 벽은 기호 없는 벽(기본값으로 가정한 벽)에 붙인다
    const partAsm = (list, kind, prefix, label) => (list || []).map((c, i) => {
      const id = `as_${prefix}_${type.id.replace(/^ut_/, '')}_${i + 1}`;
      const name = `${type.name} ${label}(${(c.rooms || []).join('·') || i + 1})`;
      const ci = kind === 'wall' ? (c.layers || []).findIndex((l) => CORE.has(l.category)) : -1;
      const layers = (c.layers || []).map((l, k) => ({ materialId: addMat(l.material, l.category), thicknessMm: l.thicknessMm ?? null, side: ci < 0 ? 'in' : k < ci ? 'out' : k === ci ? 'core' : 'in' }));
      if (!asms.has(id)) {
        ops.push({ op: 'add', file: 'catalog.json', collection: 'assemblies', element: { id, code: null, kind, name, layers, source: src(s, c.pos) }, reason: `상세 ${label} 구성` });
        asms.add(id);
      } else if (force) ops.push({ op: 'update', file: 'catalog.json', id, set: { name, layers }, reason: `상세 ${label} 구성 고침` });
      return { rooms: c.rooms || [], assemblyId: id, pos: c.pos };
    });
    const ceilings = partAsm(d.ceilings, 'ceiling', 'cl', '천장');
    const wallComps = partAsm(d.walls, 'wall', 'wd', '벽');
    for (const sp of type.spaces || []) {
      const set = {};
      const r = (d.rooms || []).find((x) => x.name === sp.name);
      if (r?.ceilingMm) set.ceilingMm = r.ceilingMm;
      const f = floors.find((x) => x.rooms.some((w) => w && sp.name.includes(w)));
      if (f) set.floorAssemblyId = f.assemblyId;
      const c = ceilings.find((x) => x.rooms.some((w) => w && sp.name.includes(w)));
      if (c) set.ceilingAssemblyId = c.assemblyId;
      for (const k of Object.keys(set)) given.add(`${sp.id}|${k}`);
      if (Object.keys(set).length) ops.push({ op: 'update', file, id: sp.id, set, reason: '단면 천장고·바닥·천장 구성', evidence: [ev(s, r?.pos)] });
    }
    // 벽: 평면의 벽체 기호가 우선이다. 기호가 없어 기본값으로 가정한 벽만, 그 벽에 닿은 실 이름 → 부위 말(외벽·세대간·칸막이) 순서로 맞춘다
    let wallApplied = 0;
    if (wallComps.length) {
      const nameOf = new Map((type.spaces || []).map((sp) => [sp.id, sp.name]));
      for (const w of type.walls || []) {
        if (!/^as_def_/.test(w.assemblyId || '') && !(force && /^as_wd_/.test(w.assemblyId || ''))) continue;
        const near = [nameOf.get(w.sides?.in), nameOf.get(w.sides?.out)].filter(Boolean);
        const byRoom = wallComps.find((x) => x.rooms.some((k) => k && near.some((n) => n.includes(k))));
        const word = w.exterior ? /외벽|외기/ : w.thickness >= 0.18 ? /세대\s*간|세대\s*경계/ : /칸막이|경량|내벽/;
        const hit = byRoom || wallComps.find((x) => x.rooms.some((k) => word.test(k)));
        if (!hit || hit.assemblyId === w.assemblyId) continue;
        ops.push({ op: 'update', file, id: w.id, set: { assemblyId: hit.assemblyId }, reason: '상세 벽체 구성(기호 없는 벽)', evidence: [ev(s, hit.pos)] });
        wallApplied++;
      }
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
    report.sections.push({ unitType: type.name, sheetId: s.id, sheetNo: s.sheetNo, rooms: section.rooms.length, floors: floors.length, ceilings: ceilings.length, walls: wallComps.length, wallApplied });
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
    // 층 구성(42 지시서 4.3): 카탈로그 조립체로 넣고, 제목에 실 이름이 있으면 그 실의 바닥·천장에 붙인다(단면에서 이미 받은 실은 그대로)
    (s.extracted.data?.compositions || []).forEach((c, i) => {
      const id = `as_dt_${slug(s.sheetNo || s.id)}_${i + 1}`;
      const ci = (c.layers || []).findIndex((l) => (c.part === 'wall' ? CORE.has(l.category) : l.category === 'structure'));
      const layers = (c.layers || []).map((l, k) => ({ materialId: addMat(l.material, l.category), thicknessMm: l.thicknessMm ?? null, side: c.part === 'wall' ? (ci < 0 ? 'in' : k < ci ? 'out' : k === ci ? 'core' : 'in') : k === ci ? 'core' : 'in' }));
      const name = `${c.title || '부분 상세'} ${{ floor: '바닥', wall: '벽', ceiling: '천장', roof: '지붕' }[c.part]} 구성`.slice(0, 80);
      if (!asms.has(id)) { ops.push({ op: 'add', file: 'catalog.json', collection: 'assemblies', element: { id, code: null, kind: c.part, name, layers, source: src(s, c.pos) }, reason: '상세 층 구성' }); asms.add(id); }
      else if (force) ops.push({ op: 'update', file: 'catalog.json', id, set: { name, layers }, reason: '상세 층 구성 고침' });
      report.compositions = (report.compositions || 0) + 1;
      const key = c.part === 'floor' ? 'floorAssemblyId' : c.part === 'ceiling' ? 'ceilingAssemblyId' : null;
      if (!key || !(c.rooms || []).length) return;
      for (const [file, type] of typeFiles) {
        for (const sp of type.spaces || []) {
          if (sp[key] || given.has(`${sp.id}|${key}`) || !c.rooms.some((w) => w && sp.name.includes(w))) continue;
          given.add(`${sp.id}|${key}`);
          ops.push({ op: 'update', file, id: sp.id, set: { [key]: id }, reason: '상세 층 구성', evidence: [ev(s, c.pos)] });
        }
      }
    });
  }

  // ---- 구조 부재 일람표 + 평면 기호, 벽 조립체의 구조 두께
  // 같은 기호라도 층 범위(floors)·일람표 시트의 동(buildings)이 다르면 다른 부재다(43 지시서 2절)
  const members = [];
  const ids = new Set((cat.structure || []).map((x) => x.id));
  const taken = new Map(); // id → 열쇠(이번 판독)
  for (const s of sheets.filter((x) => kindOf(x) === 'StructureScheduleExtract')) {
    const d = s.extracted.data || {};
    const buildings = s.refs?.buildings || [];
    for (const m of d.members || []) {
      const floors = m.floors || [];
      const key = [m.mark, buildings.join(','), floors.join(',')].join('|');
      if (members.some((x) => x.key === key)) continue;
      let id = `sm_${slug(floors.length || buildings.length ? [m.mark, ...buildings, ...floors].join('_') : m.mark)}`;
      for (let k = 2; taken.has(id) && taken.get(id) !== key; k++) id = `sm_${slug(m.mark)}_${k}`;
      taken.set(id, key);
      const bbox = m.bbox ? { x0: m.bbox[0], y0: m.bbox[1], x1: m.bbox[2], y1: m.bbox[3] } : m.pos ? box(m.pos) : null;
      const source = { method: s.extracted?.source === 'ai' ? 'ai' : 'rule', sheets: [{ sheetId: s.id, sheetNo: s.sheetNo || '', ...(bbox ? { bbox } : {}) }], confidence: 0.8 };
      const el = { id, mark: m.mark, kind: m.kind, thicknessMm: m.thicknessMm ?? null, sizeMm: m.sizeMm ?? null, floors, buildings, note: m.note || '', source };
      members.push({ ...el, key, sheet: s });
      if (!ids.has(el.id)) ops.push({ op: 'add', file: 'catalog.json', collection: 'structure', element: el, reason: '구조 부재 일람표' });
      else if (force) ops.push({ op: 'update', file: 'catalog.json', id: el.id, set: { kind: el.kind, thicknessMm: el.thicknessMm, sizeMm: el.sizeMm, floors, buildings, note: el.note }, reason: '구조 부재 고침' });
      ids.add(el.id);
      report.members++;
    }
    for (const p of d.planMarks || []) report.structureMarks.push({ mark: p.mark, sheetId: s.id, sheetNo: s.sheetNo, pos: p.pos, buildings: s.refs?.buildings || [] });
  }
  const walls = members.filter((m) => m.kind === 'wall' && m.thicknessMm);
  if (walls.length) {
    const catOf = new Map((cat.materials || []).map((m) => [m.id, m.category]));
    for (const a of (cat.assemblies || []).filter((x) => x.kind === 'wall')) {
      const core = (a.layers || []).find((l) => l.side === 'core' && catOf.get(l.materialId) === 'structure');
      if (!core?.thicknessMm) continue;
      // 같은 두께의 벽 기호가 하나뿐일 때(층·동마다 같은 기호가 여러 번 나와도 기호로 센다)
      const hit = [...new Map(walls.filter((m) => m.thicknessMm === core.thicknessMm).map((m) => [m.mark, m])).values()];
      if (hit.length === 1) ops.push({ op: 'update', file: 'catalog.json', id: a.id, set: { structure: { mark: hit[0].mark, thicknessMm: hit[0].thicknessMm, sheetId: hit[0].sheet.id, sheetNo: hit[0].sheet.sheetNo || '' } }, reason: '구조 벽 두께', evidence: [ev(hit[0].sheet)] });
      else if (!hit.length) report.structWall.push({ code: a.code, assemblyId: a.id, coreMm: core.thicknessMm, structure: [...new Set(walls.map((m) => `${m.mark} ${m.thicknessMm}`))] });
    }
  }
  // ---- 구조 평면 기호 → 건축 벽·실·레벨(43 지시서 3절). 건축 평면 좌표 틀(frames, 모델 만들기가 준다)이 있을 때만
  //   벽: wall.structure = { mark, thicknessMm, sheetId, sheetNo } (세대 타입 벽은 같은 타입 세대가 함께 쓴다)
  //   슬래브: 실 space.structure, 그 층 템플릿 레벨의 slabMm(비어 있을 때) + slabSource
  //   못 맞춘 구조 평면은 위의 벽 조립체 단위 짝만 남는다(report.structPlace에 method null)
  if (frames?.length) {
    const typesById = new Map(typeFiles.map(([file, t]) => [t.id, { file, type: t }]));
    const catOf = new Map((cat.materials || []).map((m) => [m.id, m.category]));
    // 건축 벽체의 구조체 두께. 기호가 없어 기본값으로 가정한 조립체(as_def_…, 출처 assumed)는 견주지 않는다
    const coreMm = (assemblyId) => {
      const a = (cat.assemblies || []).find((x) => x.id === assemblyId);
      if (!a || /^as_def_/.test(a.id) || a.source?.method === 'assumed') return null;
      return a.layers?.find((l) => l.side === 'core' && catOf.get(l.materialId) === 'structure')?.thicknessMm ?? null;
    };
    const known = [...members, ...(cat.structure || []).filter((x) => !members.some((m) => m.id === x.id))];
    // 기호 → 부재(그 동 일람표 먼저, 다음 동 표시 없는 것). 두께·크기 있는 것을 먼저
    const memberFor = (mark, building) => {
      const list = known.filter((m) => m.mark === mark);
      const scoped = list.filter((m) => (m.buildings || []).includes(building));
      const free = list.filter((m) => !(m.buildings || []).length);
      return [...scoped, ...free, ...list].find((m) => m.thicknessMm != null) || scoped[0] || free[0] || list[0] || null;
    };
    const kindOfMark = (mark) => known.find((m) => m.mark === mark)?.kind || markParts(mark)?.kind || 'other';
    const given = new Map(); // "파일|id" → 기호
    const levelDone = new Set();
    report.structPlace = [];
    report.structWallMismatch = [];
    report.structConflicts = 0;
    for (const s of sheets.filter((x) => kindOf(x) === 'StructureScheduleExtract' && (x.extracted.data?.planMarks || []).length)) {
      const d = s.extracted.data;
      const names = s.refs?.buildings || [];
      const cand = frames.filter((f) => files[f.file] && (!names.length || names.includes(f.building)))
        .map((f) => ({ ...f, parts: templateParts(files[f.file], f.templateId, typesById, f.file) }));
      const placed = cand.length ? placeStructPlan({ marks: d.planMarks, uf: s.meta?.unitM || 0.001, grid: d.grid || [], profile: s.meta?.profile || d.profile || null }, cand, kindOfMark) : null;
      const rec = { sheetId: s.id, sheetNo: s.sheetNo || '', building: placed?.frame.building || names[0] || null, method: placed?.method || null, contrast: placed?.contrast ?? null, marks: d.planMarks.length, walls: placed?.match.walls.length || 0, wallMarks: placed?.match.wallMarks || 0, slabs: placed?.match.slabs.length || 0, slabMarks: placed?.match.slabMarks || 0 };
      report.structPlace.push(rec);
      if (!placed) continue;
      const building = placed.frame.building;
      const posOf = (h) => d.planMarks.find((p) => p.mark === h.mark)?.pos;
      for (const h of placed.match.walls) {
        const key = `${h.wall.file}|${h.wall.id}`;
        if (given.has(key)) { if (given.get(key) !== h.mark) report.structConflicts++; continue; }
        given.set(key, h.mark);
        if (h.wall.el.structure && !force) continue;
        const mem = memberFor(h.mark, building);
        const structure = { mark: h.mark, thicknessMm: mem?.thicknessMm ?? null, sheetId: s.id, sheetNo: s.sheetNo || '' };
        ops.push({ op: 'update', file: h.wall.file, id: h.wall.id, set: { structure }, reason: '구조 평면 벽 기호', evidence: [ev(s, posOf(h))] });
        // 건축 벽(벽체 조립체)의 구조체 두께와 구조 두께가 다르면 검산 결과로
        const core = coreMm(h.wall.el.assemblyId);
        if (structure.thicknessMm && core && core !== structure.thicknessMm) report.structWallMismatch.push({ mark: h.mark, structMm: structure.thicknessMm, coreMm: core, code: h.wall.el.code || null, file: h.wall.file, wallId: h.wall.id, sheetId: s.id, pos: posOf(h) });
      }
      const tpl = (files[placed.frame.file]?.floorTemplates || []).find((t) => t.id === placed.frame.templateId);
      for (const h of placed.match.slabs) {
        const mem = memberFor(h.mark, building);
        const key = `${h.space.file}|${h.space.id}`;
        if (!given.has(key)) {
          given.set(key, h.mark);
          if (!h.space.el.structure || force) ops.push({ op: 'update', file: h.space.file, id: h.space.id, set: { structure: { mark: h.mark, thicknessMm: mem?.thicknessMm ?? null, sheetId: s.id, sheetNo: s.sheetNo || '' } }, reason: '구조 평면 슬래브 기호', evidence: [ev(s, posOf(h))] });
        } else if (given.get(key) !== h.mark) report.structConflicts++;
        if (!mem?.thicknessMm) continue;
        for (const l of files[placed.frame.file].levels || []) {
          if (!(tpl?.levelIds || []).includes(l.id) || levelDone.has(`${placed.frame.file}|${l.id}`)) continue;
          levelDone.add(`${placed.frame.file}|${l.id}`);
          // 단면 슬래브가 이미 있거나 이번에 들어가면 그대로(단면·구조가 다르면 struct.slab 검증이 알린다)
          if ((l.slabMm != null || ops.some((o) => o.file === placed.frame.file && o.id === l.id && o.set && 'slabMm' in o.set)) && !force) continue;
          ops.push({ op: 'update', file: placed.frame.file, id: l.id, set: { slabMm: mem.thicknessMm, slabSource: { mark: h.mark, sheetId: s.id, sheetNo: s.sheetNo || '' } }, reason: `구조 평면 슬래브(${h.mark})`, evidence: [ev(s, posOf(h))] });
        }
      }
    }
  }
  return { ops, report };
}

/** 사람이 [상세 값]에서 고친 시트 하나 → 새 버전을 만들 수정 연산 */
export const sheetDetailOps = (files, sheet) => detailOps(files, [sheet], { force: true }).ops;

/** 조립 끝에 붙이기: 연산을 만들고 적용. 실패하면 원래 파일 그대로(기록에 오류) */
export function applyDetails(files, sheets, report) {
  const { ops, report: r } = detailOps(files, sheets, { frames: report.planFrames || null });
  Object.assign(report, { details: r });
  if (!ops.length) return files;
  const res = applyPatch(files, ops, { method: 'rule', keepSource: true });
  if (res.ok) return res.files;
  // 한꺼번에 안 되면 카탈로그(부재·조립체) 먼저, 그다음 파일마다 따로: 한 파일 문제로 판독값이 모두 사라지지 않게(실제 도서: 동 파일의 겹친 id)
  report.details.errors = res.errors.slice(0, 20);
  let out = files;
  const groups = new Map();
  for (const op of ops) { const k = op.file === 'catalog.json' ? '' : op.file; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(op); }
  report.details.failedFiles = [];
  for (const [file, list] of [...groups].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : 0))) {
    const r2 = applyPatch(out, list, { method: 'rule', keepSource: true });
    if (r2.ok) out = r2.files; else report.details.failedFiles.push({ file: file || 'catalog.json', ops: list.length, error: r2.errors[0] || '' });
  }
  return out;
}
