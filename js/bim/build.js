// 전체 조립(04 11절): 시트 묶음 → BIM JSON(baromap-bim/1) 파일들 + 검증용 기록(report).
// 순서: 카탈로그(마감·벽체·창호) → 세대·시설 타입 → 동(기준층 세대 묶기·타입 맞추기·층 템플릿) → 레벨 → 단지·좌표 맞추기 → 세대 목록·골구도.
// 같은 입력이면 같은 결과(결정적). 화면 코드 없음 — 브라우저 워커와 Node 테스트 공용.
import { createCatalog, findFinishRow } from './finishes.js';
import { analyzePlan, buildType, groupUnits, labelGroups, matchType, newReport, COMMON, source } from './units.js';
import { dimRatio } from './dim-zones.js';
import { buildingLevels, floorNo, levelsForFloors } from './levels.js';
import { analyzeSite } from './site.js';
import { alignOutline, applyTransform } from './align.js';
import { rowLayout, findLabels } from './site-place.js';
import { BIM_SCHEMA, upgradeFiles } from './upgrade.js';
import { applyDetails } from './details.js';
import { gridOf } from './struct-place.js';
import { buildFacade, readElevation, readRoof } from './facade.js';
import { readSiteDetail, heightAt, baseOf } from './site-detail.js';
import { hashId, slug, rp, r3 } from './ids.js';
import { boxOf, centroid, area as polyArea, hull } from '../cad/geom.js';

export { BIM_SCHEMA };
const unitLabel = (floor, line) => (/^\d{1,2}$/.test(line) ? `${floor}${String(line).padStart(2, '0')}` : `${floor}${line}`);
const ufOf = (sheet) => sheet.meta?.unitM || 0.001;
const sortBy = (k) => (a, b) => String(a[k]).localeCompare(String(b[k]), 'ko', { numeric: true });

/**
 * @param {{ siteId: string, sheets: any[], geomBySheet: Map<string, {items:any[]}>, progress?: { buildings: any[] }, setId?: string|null }} input
 * @returns {{ files: Record<string, any>, summary: any, report: any }}
 */
export function buildModel({ siteId, sheets, geomBySheet, progress = { buildings: [] }, setId = null }) {
  const report = newReport();
  Object.assign(report, { facadeUndefined: [], facadeAssumed: [], facadeHeight: [], terrainFlat: false, dimMismatch: [], unitTypeMissing: [], unitTypeUnmatched: [], levelConflicts: [], floors: [], unitsCount: [], align: [], progressProposals: [], usedCodes: [], definedCodes: [], codeSheets: {}, assemblyConflicts: [], sheets: sheets.map((s) => ({ id: s.id, sheetNo: s.sheetNo, title: s.title, category: s.category, status: s.status })) });
  const by = (cat) => sheets.filter((s) => s.category === cat).sort(sortBy('sheetNo'));
  const geom = (s) => geomBySheet.get(s.id);

  // ---- 1. 카탈로그: 벽체 상세·마감표 조립체, 실 마감 행, 창호 일람표
  const catalog = createCatalog();
  const rows = [];
  const schedule = new Map();
  for (const s of [...by('wall_types'), ...by('finish_schedule')]) {
    const d = s.extracted?.data;
    if (!d) continue;
    const method = s.extracted.source === 'ai' ? 'ai' : 'rule';
    for (const a of d.assemblies || []) {
      const id = `as_${a.code}`;
      if (catalog.assemblies.has(id)) { report.assemblyConflicts.push({ code: a.code, sheetId: s.id }); continue; }
      catalog.addAssembly({ id, code: a.code, kind: a.kind, name: a.name, layers: a.layers, source: { method, sheets: [{ sheetId: s.id, sheetNo: s.sheetNo }], confidence: 0.85 } });
      report.definedCodes.push(a.code);
    }
    for (const r of d.rooms || []) rows.push(r);
    if ((d.rooms || []).length) Object.assign(rows, { sheetId: s.id, sheetNo: s.sheetNo });
  }
  for (const s of by('window_schedule')) for (const it of s.extracted?.data?.items || []) if (!schedule.has(it.code)) schedule.set(it.code, { ...it, sheetId: s.id });
  const hasSchedule = schedule.size > 0;
  const finish = rows.length ? rows : null;
  report.noFinishSchedule = !rows.length; // 도서에 실내재료마감표가 없음(실마다 경고하지 않고 한 건으로)

  // ---- 2. 세대 타입·시설 타입
  const types = new Map();
  const typePlans = new Map();
  for (const s of by('unit_plan')) {
    if (!geom(s)) continue;
    const name = s.extracted?.data?.typeName || s.refs?.unitTypes?.[0] || s.title || s.sheetNo;
    const id = `ut_${slug(name)}`;
    if (types.has(id)) continue;
    const plan = analyzePlan(s, geom(s), { uf: ufOf(s), schedule });
    const t = buildType(plan, { id, name, kind: 'unit', catalog, finish, report, hasSchedule });
    collectCodes(plan, report, s);
    types.set(id, t);
    typePlans.set(id, plan);
    report.unitTypes.push({ id, name, sheetId: s.id, walls: t.walls.length, spaces: t.spaces.length });
  }
  for (const s of by('facility_plan')) {
    if (!geom(s)) continue;
    const name = s.refs?.facility || s.title || s.sheetNo;
    const id = `ut_fac_${slug(name)}`;
    const plan = analyzePlan(s, geom(s), { uf: ufOf(s), schedule });
    const t = buildType(plan, { id, name, kind: 'facility', catalog, finish, report, hasSchedule });
    collectCodes(plan, report, s);
    types.set(id, t);
    typePlans.set(id, plan);
  }

  // ---- 3. 단지
  // 배치도로 분류된 시트가 여럿이면(도면번호만 보고 분류된 것 포함) 동 이름 글자가 가장 많은 시트를 쓴다(42 지시서 1절)
  const planNames = [...new Set(by('floor_plan').flatMap((s) => s.refs?.buildings || []))];
  const siteSheets = by('site_plan').filter((s) => geom(s));
  let siteSheet = siteSheets[0] || null;
  if (siteSheets.length > 1) {
    const score = (s) => {
      const hasOutline = Object.values(s.layerRoles || {}).includes('building_outline') ? 1 : 0;
      const hit = planNames.length ? new Set(findLabels(geom(s).items, planNames, ufOf(s)).map((l) => l.name)).size : 0;
      return hit * 10 + hasOutline * 5 + (/배치/.test(s.title || '') ? 3 : 0) + (s.extracted?.data?.buildings?.length ? 1 : 0);
    };
    siteSheet = siteSheets.map((s) => ({ s, v: score(s) })).sort((a, z) => z.v - a.v)[0].s;
  }
  const site = siteSheet ? analyzeSite(siteSheet, geom(siteSheet), { uf: ufOf(siteSheet), names: planNames }) : null;

  // ---- 4. 동: 평면(기준층·1층 등) → 층 템플릿
  const planSheets = by('floor_plan');
  const names = [...new Set([...planSheets.flatMap((s) => s.refs?.buildings || []), ...(site?.footprints || []).map((f) => f.name).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const buildings = [];
  for (const name of names) {
    const fp = site?.footprints.find((f) => f.name === name);
    const facilityType = [...types.values()].find((t) => t.kind === 'facility' && (t.name === name || name.includes(t.name) || t.name.includes(name)));
    const kind = fp?.kind && fp.kind !== 'other' ? fp.kind : /동$/.test(name) ? 'apartment' : facilityType ? 'community' : 'other';
    const id = `bd_${slug(name)}`;
    const mySheets = planSheets.filter((s) => (s.refs?.buildings || []).includes(name) && geom(s));
    const typical = mySheets.find((s) => (s.refs?.floors || []).some((f) => /기준층/.test(f))) || mySheets.find((s) => !(s.refs?.floors || []).length) || mySheets[0] || null;
    const templates = [];
    const frames = []; // 층 템플릿마다 건축 평면의 좌표 틀(구조 평면 기호 맞추기, 43 지시서 3절)
    let outline = null;
    let origin = null;
    let typicalPlan = null;
    if (typical) {
      typicalPlan = analyzePlan(typical, geom(typical), { uf: ufOf(typical), schedule });
      const ob = boxOf(typicalPlan.outline);
      origin = [ob[0], ob[1]];
      outline = typicalPlan.outline.map((p) => rp([p[0] - origin[0], p[1] - origin[1]]));
      templates.push(floorTemplate(typicalPlan, { id: 'ft_typ', name: '기준층', kind: 'typical', origin, types, catalog, report, building: name, hasSchedule }));
      frames.push({ templateId: 'ft_typ', sheetId: typical.id, uf: ufOf(typical), origin, grid: gridOf(geom(typical).items), typical: true });
      collectCodes(typicalPlan, report, typical);
    }
    for (const s of mySheets) {
      if (s === typical) continue;
      const plan = analyzePlan(s, geom(s), { uf: ufOf(s), schedule });
      const shift = typicalPlan ? spaceShift(typicalPlan, plan) : [0, 0];
      const o = origin ? [origin[0] + shift[0], origin[1] + shift[1]] : boxOf(plan.outline);
      const floors = (s.refs?.floors || []).join(',');
      // 템플릿 id: 층 글자(없으면 도면번호). 실제 도서는 둘 다 비거나 같은 시트가 여럿이라 같은 id가 나왔다 → 뒤에 번호
      let ftId = `ft_${slug(floors || s.sheetNo)}`;
      for (let k = 2; templates.some((t) => t.id === ftId); k++) ftId = `ft_${slug(floors || s.sheetNo)}_${k}`;
      templates.push(floorTemplate(plan, { id: ftId, name: floors || s.title, kind: /^1(층|F)/.test(floors) ? 'first' : 'other', floors: s.refs?.floors || [], origin: [o[0], o[1]], types, catalog, report, building: name, hasSchedule }));
      frames.push({ templateId: templates[templates.length - 1].id, sheetId: s.id, uf: ufOf(s), origin: [o[0], o[1]], grid: gridOf(geom(s).items), typical: false });
      collectCodes(plan, report, s);
      if (!outline) outline = plan.outline.map((p) => rp([p[0] - o[0], p[1] - o[1]]));
    }
    if (!templates.length && facilityType) {
      outline = facilityType.outline;
      templates.push({ id: 'ft_1', name: '1층', kind: 'facility', levelIds: [], walls: [], columns: [], openings: [], spaces: [], cores: [], units: [{ id: hashId('ui_', id, facilityType.id), line: null, unitTypeId: facilityType.id, transform: { x: 0, y: 0, rotDeg: 0, mirror: false } }] });
    }
    // 세대 배치 id(도면번호·동·라인 해시)가 템플릿 사이에 겹치면 뒤에 번호(파일 안 id가 겹치면 수정 연산이 거부된다)
    const seenUi = new Set();
    for (const t of templates) for (const u of t.units) { let uid = u.id; for (let k = 2; seenUi.has(uid); k++) uid = `${u.id}_${k}`; u.id = uid; seenUi.add(uid); }
    buildings.push({ id, name, kind, fp, templates, frames, outline, sheets: mySheets });
  }

  // ---- 5. 레벨·층 템플릿 배치·세대 목록·단지 좌표
  const levelSheets = [...by('elevation'), ...by('section')];
  const siteBuildings = [];
  const buildingFiles = {};
  for (const b of buildings) {
    const ex = levelSheets.filter((s) => (s.refs?.buildings || []).includes(b.name) && s.extracted?.data?.levels).map((s) => ({ sheet: s, data: { ...s.extracted.data, _source: s.extracted.source === 'ai' ? 'ai' : 'rule' } }));
    const firstTpl = b.templates.find((t) => t.kind === 'first');
    const pilotisPlan = Boolean(firstTpl && !firstTpl.units.length);
    const L = buildingLevels(ex, { floorsText: b.fp?.floorsText, pilotisPlan });
    for (const c of L.conflicts) report.levelConflicts.push({ building: b.name, ...c });
    const levels = L.levels;
    // 템플릿 → 레벨
    for (const t of b.templates) {
      if (t.kind === 'typical') t.levelIds = levels.filter((l) => l.kind === 'typical' || l.kind === 'top').map((l) => l.id);
      else if (t.kind === 'first') t.levelIds = levels.filter((l) => floorNo(l.name) === 1).map((l) => l.id);
      else if (t.kind === 'facility') t.levelIds = levels.filter((l) => floorNo(l.name) != null).map((l) => l.id);
      else t.levelIds = levelsForFloors(t.floors || [], levels).map((l) => l.id); // 범위·지하·최하층·최상층·지붕(45 지시서 5.1)
    }
    // 1층 평면이 따로 있으면 기준층 템플릿에서 1층을 뺀다
    const typ = b.templates.find((t) => t.kind === 'typical');
    if (typ) typ.levelIds = typ.levelIds.filter((lid) => !b.templates.some((t) => t !== typ && t.levelIds.includes(lid)));
    // 골구도(공정) 동
    const pb = (progress.buildings || []).find((x) => x.name === b.name);
    const units = [];
    if (b.kind === 'apartment') {
      for (const t of b.templates) {
        for (const lid of t.levelIds) {
          const f = floorNo(levels.find((l) => l.id === lid)?.name || '');
          if (f == null) continue;
          for (const inst of t.units) {
            if (!inst.line) continue;
            if (pb) {
              const ln = pb.lines.find((x) => String(x.name) === String(inst.line));
              if (!ln || f < ln.from || f > ln.to) continue;
            }
            // 같은 층·라인이 두 번 나오면(템플릿 둘이 같은 층을 덮을 때) id 뒤에 번호 — 파일 안 id가 겹치면 수정 연산이 거부된다
            let uid = `un_${slug(b.name)}_${unitLabel(f, inst.line)}`;
            for (let k = 2; units.some((u) => u.id === uid); k++) uid = `un_${slug(b.name)}_${unitLabel(f, inst.line)}_${k}`;
            units.push({ id: uid, unitKey: `${f}:${inst.line}`, label: unitLabel(f, inst.line), levelId: lid, line: String(inst.line), unitTypeId: inst.unitTypeId, transform: inst.transform, templateId: t.id });
          }
        }
      }
      const lines = [...new Set((typ?.units || []).map((u) => u.line).filter(Boolean))];
      if (pb) {
        if (pb.lines.length !== lines.length) report.unitsCount.push({ building: b.name, plan: lines.length, progress: pb.lines.length, sheetId: b.sheets[0]?.id });
      } else if (lines.length) {
        const fl = (typ?.levelIds || []).map((lid) => floorNo(levels.find((l) => l.id === lid)?.name || '')).filter((x) => Number.isFinite(x));
        // 층을 하나도 못 찾았으면 제안하지 않는다(화면에 "Infinity~-Infinity층"으로 나오던 문제, 실제 도서 시험 2026-11-09)
        if (fl.length) report.progressProposals.push({ building: b.name, lines: lines.map((ln) => ({ name: ln, from: Math.min(...fl), to: Math.max(...fl) })) });
      }
    }
    // 층수 비교: 배치도 글자 / 입·단면 / 골구도
    const textN = parseInt(/지상\s*(\d+)/.exec(b.fp?.floorsText || '')?.[1] || '0', 10) || null;
    const progressTop = pb ? Math.max(...pb.lines.map((l) => l.to)) : null;
    report.floors.push({ building: b.name, buildingId: b.id, siteText: textN, levels: L.assumed ? null : L.floorsAbove, progressTop, siteSheet: siteSheet ? { sheetId: siteSheet.id, box: b.fp?.source?.sheets?.[0]?.bbox } : null, levelSheets: ex.map((x) => ({ sheetId: x.sheet.id, sheetNo: x.sheet.sheetNo })) });
    // 단지 좌표
    let transform = { x: 0, y: 0, rotDeg: 0 };
    if (b.fp?.labelOnly) {
      // 배치도에 이름 글자만 있는 동: 평면 외곽의 가운데를 글자 자리에, 방향은 주변 선의 주된 방향
      const ob = boxOf(b.outline?.length ? b.outline : [[0, 0]]);
      const c = applyTransform({ x: 0, y: 0, rotDeg: b.fp.deg || 0 }, [(ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2]);
      transform = { x: r3(b.fp.at[0] - c[0]), y: r3(b.fp.at[1] - c[1]), rotDeg: b.fp.deg || 0 };
      b.placed = 'label';
    } else if (b.fp && b.outline?.length) {
      // 외부 참조 묶음에서 얻은 외곽은 볼록 외곽이라 평면 외곽도 볼록 외곽으로 맞춘다
      const a = alignOutline(b.fp.hull ? hull(b.outline) : b.outline, b.fp.polygon);
      b.placed = 'plan';
      transform = { x: a.x, y: a.y, rotDeg: a.rotDeg };
      report.align.push({ building: b.name, buildingId: b.id, iou: a.iou, sheetIds: [b.sheets[0]?.id, siteSheet?.id].filter(Boolean) });
    } else if (b.fp) {
      const c = centroid(b.fp.polygon);
      transform = { x: r3(c[0]), y: r3(c[1]), rotDeg: 0 };
      b.outline = b.fp.polygon.map((p) => rp([p[0] - c[0], p[1] - c[1]]));
      b.placed = 'plan';
    }
    const height = r3(levels.filter((l) => l.kind !== 'basement').reduce((s, l) => s + (l.height || 0), 0));
    const file = `b-${b.id}.json`;
    buildingFiles[b.id] = file;
    const bjson = {
      id: b.id, name: b.name, kind: b.kind, transform, outline: b.outline || [],
      levels, levelSource: L.source,
      floorTemplates: b.templates.map(({ floors, ...t }) => t),
      units: units.sort((x, y) => x.levelId.localeCompare(y.levelId) || x.line.localeCompare(y.line, 'ko', { numeric: true })),
      progressBuildingId: pb?.id || null,
    };
    b.json = bjson;
    siteBuildings.push({
      id: b.id, name: b.name, kind: b.kind, file,
      footprint: b.fp?.polygon || (b.outline || []).map((p) => rp(applyTransform(transform, p))),
      floorsAbove: L.floorsAbove || textN || 1, floorsBelow: levels.filter((l) => l.kind === 'basement').length, height: height || r3((L.floorsAbove || 1) * 2.9),
      progressBuildingId: pb?.id || null,
      source: b.fp?.source || { method: 'assumed', sheets: [], confidence: 0.3 },
      ...(b.placed === 'label' ? { placed: 'label' } : {}),
    });
  }

  // ---- 5-1. 배치도에서 자리를 못 찾은 동은 원점에 겹치지 않게 줄지어 놓는다(42 지시서 1.3)
  const lost = buildings.filter((b) => !b.placed);
  if (lost.length) {
    const placedPts = siteBuildings.filter((sb) => buildings.find((b) => b.id === sb.id)?.placed).flatMap((sb) => sb.footprint || []);
    const ts = rowLayout(lost.map((b) => ({ outline: b.outline || [] })), [...placedPts, ...(site?.boundary || [])]);
    lost.forEach((b, i) => {
      Object.assign(b.json.transform, ts[i]);
      const sb = siteBuildings.find((x) => x.id === b.id);
      sb.footprint = (b.outline || []).map((p) => rp(applyTransform(ts[i], p)));
      sb.placed = 'row';
      b.placed = 'row';
    });
  }
  const placement = { total: buildings.length, plan: buildings.filter((b) => b.placed === 'plan').length, label: buildings.filter((b) => b.placed === 'label').length, row: lost.length };
  report.placement = { ...placement, sheetId: siteSheet?.id || null, rowIds: lost.map((b) => b.id), labelIds: buildings.filter((b) => b.placed === 'label').map((b) => b.id) };

  // ---- 5-2. 단지 확장: 지형·포장·수목·시설물(21 지시서 4절)
  const detail = { terrain: null, pavings: [], trees: [], features: [] };
  for (const s of [...by('landscape'), ...by('landscape_plan'), ...by('civil_plan')]) {
    const flat = geom(s);
    if (!flat) continue;
    const d = readSiteDetail(s, flat, { uf: ufOf(s), origin: site?.origin || [0, 0], tables: s.tables || [], mat: (n) => catalog.mat(n) });
    detail.terrain ||= d.terrain;
    detail.pavings.push(...d.pavings);
    detail.trees.push(...d.trees);
    detail.features.push(...d.features);
  }
  report.terrainFlat = !detail.terrain;
  const siteBase = baseOf(detail.terrain);

  // ---- 5-3. 외피: 외부 마감표 → 입면 재료 구획 → 패널·창호·발코니·지붕(21 지시서 3절)
  const exterior = new Map();
  for (const s of [...by('exterior_finish'), ...by('color_plan')]) for (const it of s.extracted?.data?.items || []) if (!exterior.has(it.code)) exterior.set(it.code, it);
  const typeById = new Map([...types.values()].map((t) => [t.id, t]));
  const northDeg = site?.northDeg ?? 0;
  const elevOf = new Map(); // 동 이름 → 입면 읽은 것
  for (const s of by('elevation')) {
    const b = buildings.find((x) => (s.refs?.buildings || []).includes(x.name));
    const flat = geom(s);
    if (!b || !flat) continue;
    const e = { ...readElevation(s, flat, { rotDeg: b.json.transform.rotDeg, northDeg }), sheet: s };
    if (s.extracted?.data?.facade?.zones?.length) { Object.assign(e, { zones: s.extracted.data.facade.zones, ai: s.extracted.source === 'ai' }); }
    if (!elevOf.has(b.name)) elevOf.set(b.name, []);
    elevOf.get(b.name).push(e);
    // 입면 최고 높이와 단면도 최고 레벨 대조
    const section = by('section').find((x) => (x.refs?.buildings || []).includes(b.name) && x.extracted?.data?.levels?.length);
    if (section && e.topMm != null) {
      const top = Math.max(...section.extracted.data.levels.map((l) => l.elevationMm));
      if (Math.abs(top - e.topMm) > 100) report.facadeHeight.push({ building: b.name, buildingId: b.id, elevationMm: e.topMm, sectionMm: top, sheetIds: [s.id, section.id], sheetNo: s.sheetNo });
    }
  }
  const roofs = new Map();
  for (const s of by('roof_plan')) { const flat = geom(s); if (flat) for (const n of s.refs?.buildings || []) roofs.set(n, readRoof(s, flat)); }
  const sameOutline = (a, b) => a.json.kind === b.json.kind && Math.abs(polyArea(a.json.outline) - polyArea(b.json.outline)) < 0.5;
  for (const b of buildings) {
    // 입면이 없으면 같은 평면의 다른 동 입면을 빌린다
    let elevations = elevOf.get(b.name) || [];
    if (!elevations.length) { const other = buildings.find((x) => x !== b && elevOf.has(x.name) && sameOutline(x, b)); if (other) elevations = elevOf.get(other.name).map((e) => ({ ...e, shared: true })); }
    const borrow = buildings.find((x) => x !== b && roofs.has(x.name) && sameOutline(x, b));
    const out = buildFacade({ building: b.json, types: typeById, elevations, exterior, roof: roofs.get(b.name) || (borrow ? roofs.get(borrow.name) : null), catalog, northDeg, report });
    Object.assign(b.json, out.facade ? { facade: out.facade, balconies: out.balconies, roof: out.roof } : {});
    const sb = siteBuildings.find((x) => x.id === b.id);
    if (sb?.footprint?.length) {
      const c = centroid(sb.footprint);
      const h = heightAt(detail.terrain, c[0], c[1]);
      b.json.baseElevation = h == null ? 0 : r3(h);
      sb.baseElevation = b.json.baseElevation;
    }
  }

  // ---- 6. 파일
  const siteJson = {
    boundary: site?.boundary || [], roads: site?.roads || [], landscape: site?.landscape || [], underground: site?.underground || [],
    buildings: siteBuildings, northDeg: site?.northDeg ?? 0, source: site?.source || null, ...detail, baseElevation: r3(siteBase), placement,
  };
  const files = { 'site.json': siteJson, 'catalog.json': catalog.toJSON() };
  const unitTypeFiles = {};
  for (const t of types.values()) { unitTypeFiles[t.id] = `u-${t.id}.json`; files[`u-${t.id}.json`] = t; }
  for (const b of buildings) files[buildingFiles[b.id]] = b.json;
  const summary = {
    buildings: buildings.length,
    apartments: buildings.filter((b) => b.kind === 'apartment').length,
    units: buildings.reduce((a, b) => a + b.json.units.length, 0),
    unitTypes: [...types.values()].filter((t) => t.kind === 'unit').length,
    facilities: [...types.values()].filter((t) => t.kind === 'facility').length,
    spaces: [...types.values()].reduce((a, t) => a + t.spaces.length, 0),
    walls: [...types.values()].reduce((a, t) => a + t.walls.length, 0),
    wallLengthM: r3([...types.values()].reduce((a, t) => a + t.walls.reduce((s, w) => s + Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]), 0), 0)),
    lowConfidence: report.assumedWalls.length + report.missingRooms.length,
  };
  files['index.json'] = {
    schema: BIM_SCHEMA, siteId, setId, origin: { northDeg: siteJson.northDeg },
    files: { site: 'site.json', catalog: 'catalog.json', buildings: buildingFiles, unitTypes: unitTypeFiles },
    summary,
  };
  report.counts = summary;
  report.usedCodes = [...new Set(report.usedCodes)].sort();
  report.definedCodes = [...new Set(report.definedCodes)].sort();
  // 단면·상세·구조 판독값(38 지시서)은 수정 연산으로 붙인다. 구조 평면 기호는 건축 평면 좌표 틀로 벽·실에(43 지시서 3절)
  report.planFrames = buildings.flatMap((b) => b.frames.map((f) => ({ ...f, buildingId: b.id, building: b.name, file: buildingFiles[b.id] })));
  const out = applyDetails(upgradeFiles(files), sheets, report);
  return { files: out, summary: out['index.json'].summary, report };
}

// 평면에 쓰인 마감·벽체 기호(정의 없는 기호 찾기용)
// 치수 검산(19 5절): 치수 글자와 그려진 길이가 다르면 축척·단위 오류이거나 글자를 고쳐 쓴 것이다
// 평면 안 확대 상세(축척 구역) 안의 치수는 그 구역 축척으로 견주고, 평면 축척을 몰라 배를 모르면 견주지 않는다(41 지시서 2.6)
export function checkDims(plan, report) {
  const zones = plan.dimZones || [];
  const off = (plan.dims || []).filter((d) => {
    if (!(d.lenM > 0)) return false;
    const k = d.at ? dimRatio(zones, [d.at[0] * plan.uf, d.at[1] * plan.uf]) : 1;
    return k != null && Math.abs(d.value - d.lenM * 1000 * k) > Math.max(5, d.value * 0.01);
  });
  if (!off.length) return;
  const ratios = off.map((d) => d.value / (d.lenM * 1000)).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  const same = ratios.filter((r) => Math.abs(r / median - 1) < 0.02).length;
  report.dimMismatch.push({
    sheetId: plan.sheet.id, sheetNo: plan.sheet.sheetNo, count: off.length, total: plan.dims.length,
    ratio: same >= Math.max(2, plan.dims.length / 2) ? Math.round(median * 1000) / 1000 : null,
    samples: off.slice(0, 5).map((d) => ({ value: d.value, drawnMm: Math.round(d.lenM * 1000), box: { x0: d.at[0], y0: d.at[1], x1: d.at[0], y1: d.at[1] } })),
  });
}

function collectCodes(plan, report, sheet) {
  checkDims(plan, report);
  for (const t of plan.tags) {
    if (t.kind !== 'wall' && t.kind !== 'finish') continue;
    report.usedCodes.push(t.code);
    (report.codeSheets[t.code] ||= []).push({ sheetId: sheet.id, sheetNo: sheet.sheetNo, pos: t.pos, uf: plan.uf });
  }
}

// 두 평면을 같은 실 이름(계단실·승강기·홀 등)의 중심으로 맞춘다 → b를 a 좌표로 옮기는 이동량
function spaceShift(a, b) {
  const pairs = [];
  for (const sb of b.spaces) {
    if (sb.name === 'unnamed') continue;
    const same = a.spaces.filter((sa) => sa.name === sb.name);
    if (same.length === 1) pairs.push([same[0].center, sb.center]);
  }
  if (!pairs.length) {
    const ba = boxOf(a.outline);
    const bb = boxOf(b.outline.length ? b.outline : [[0, 0]]);
    return [bb[0] - ba[0], bb[1] - ba[1]];
  }
  const dx = pairs.reduce((s, [p, q]) => s + (q[0] - p[0]), 0) / pairs.length;
  const dy = pairs.reduce((s, [p, q]) => s + (q[1] - p[1]), 0) / pairs.length;
  return [dx, dy];
}

/**
 * 층 평면 → 층 템플릿: 세대 묶기·타입 맞추기(세대 배치) + 공용부(벽·실·코어·기둥)
 */
function floorTemplate(plan, { id, name, kind, floors = [], origin, types, catalog, report, building, hasSchedule }) {
  const groups = labelGroups(plan, groupUnits(plan));
  const unitTypes = [...types.values()].filter((t) => t.kind === 'unit');
  const units = [];
  const unitFaces = new Set();
  for (const g of groups) {
    for (const f of g.faces) unitFaces.add(f);
    const byLabel = g.typeLabel ? unitTypes.find((t) => t.name === g.typeLabel) : null;
    let best = null;
    if (byLabel) best = { type: byLabel, m: matchType(g, byLabel) };
    else {
      for (const t of unitTypes) {
        const m = matchType(g, t);
        if (!best || m.score < best.m.score) best = { type: t, m };
      }
    }
    const box = g.outline?.length ? g.outline : g.edges.flatMap((e) => [e.a, e.b]);
    const ev = source(plan, box, 'rule', 0.7).sheets[0];
    if (g.typeLabel && !byLabel) report.unitTypeMissing.push({ building, line: g.line, label: g.typeLabel, matched: best?.type.name || null, sheetId: plan.sheet.id, sheetNo: plan.sheet.sheetNo, box: ev.bbox });
    if (!best || best.m.score > 0.35 || best.m.areaDiff > 0.03) {
      report.unitTypeUnmatched.push({ building, line: g.line, label: g.typeLabel, score: best?.m.score ?? null, sheetId: plan.sheet.id, box: ev.bbox });
      if (!best) continue;
    }
    units.push({
      id: hashId('ui_', plan.sheet.sheetNo, building, g.line),
      line: g.line,
      unitTypeId: best.type.id,
      typeLabel: g.typeLabel || best.type.name,
      transform: { x: r3(best.m.x - origin[0]), y: r3(best.m.y - origin[1]), rotDeg: best.m.rotDeg, mirror: best.m.mirror },
      match: { score: best.m.score, areaDiff: best.m.areaDiff, byLabel: Boolean(byLabel), lineAssumed: Boolean(g.lineAssumed) },
      source: { method: byLabel ? 'rule' : 'assumed', sheets: [ev], confidence: byLabel ? 0.85 : 0.5 },
    });
  }
  // 공용부: 세대 실에 닿지 않는 벽, 공용 실
  const tpl = buildType(plan, {
    id, name, kind: 'template', catalog, finish: null, report, hasSchedule, origin,
    edgeFilter: (e) => !unitFaces.has(e.leftFace) && !unitFaces.has(e.rightFace),
    spaceFilter: (sp) => !unitFaces.has(sp.face),
  });
  const cores = tpl.spaces.filter((sp) => /계단/.test(sp.name) || /승강기|엘리베이터|E\.?V/i.test(sp.name))
    .map((sp) => ({ id: hashId('cr_', sp.id), kind: /계단/.test(sp.name) ? 'stair' : 'elevator', polygon: sp.polygon, spaceId: sp.id }));
  return { id, name, kind, floors, levelIds: [], walls: tpl.walls, columns: tpl.columns, openings: tpl.openings, spaces: tpl.spaces, cores, units: units.sort((a, b) => a.line.localeCompare(b.line, 'ko', { numeric: true })) };
}

export { COMMON, findFinishRow, polyArea };
