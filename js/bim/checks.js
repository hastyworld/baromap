// 규칙 검사(05 1절): 모델·조립 기록(report)·시트로 도서 전체의 모순·누락을 찾는다. 결정적·무료. 순수 함수.
// 결과: { kind, severity, message(한국어 한 문장: 무엇이·어디서·얼마나), evidence:[{sheetId, bbox, note}], elementIds }
// 같은 kind·같은 대상은 한 건으로 묶는다.
import { boxOf, pointInPolygon } from '../cad/geom.js';
import { DOC_FINDING_LABEL } from './doc-checks.js';
import { PUBLIC_FINDING_LABEL } from '../ops/calc/public-data.js';

export const SEVERITY = { error: 0, warn: 1, info: 2 };
export const KIND_LABEL = {
  'floors.mismatch': '층수 불일치', 'levels.conflict': '레벨 충돌', 'units.count': '세대 수', 'unittype.missing': '타입 도면 없음', 'unittype.unmatched': '타입 안 맞음',
  'finish.code.undefined': '정의 없는 기호', 'finish.code.unused': '안 쓰인 기호', 'finish.room.missing': '마감표에 없는 실', 'finish.assumed': '가정한 마감',
  'wall.thickness': '벽 두께', 'wall.unmatched': '벽 못 만든 선', 'opening.host': '벽에 안 붙은 문·창', 'opening.code.undefined': '일람표에 없는 창호', 'opening.size': '창호 크기',
  'space.unnamed': '이름 없는 실', 'space.area': '면적 차이', 'align.low': '배치 맞춤', 'site.overlap': '동 겹침', 'sheet.unclassified': '종류 모름', 'sheet.failed': '읽기 실패',
  'waterproof.missing': '방수 누락', dim_mismatch: '치수 불일치', ...DOC_FINDING_LABEL,
  'level.stack': '층고 검산', 'struct.slab': '슬래브 두께 불일치', 'struct.wall': '구조 벽 두께 불일치', 'struct.missing': '일람표에 없는 구조 기호',
  'facade.code.undefined': '외부 마감표에 없는 기호', 'facade.height': '최고 높이 차이', 'facade.assumed': '가정한 외관', 'site.terrain': '지형 없음',
  ...PUBLIC_FINDING_LABEL,
};

const box = (b) => (b ? { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } : null);
const ev = (sheetId, bbox, note = '') => ({ sheetId, bbox: box(bbox), note });
const ptBox = (p, uf, r = 600) => ({ x0: p[0] / uf - r, y0: p[1] / uf - r, x1: p[0] / uf + r, y1: p[1] / uf + r });
const groupBy = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };

/**
 * @param {{ files: Record<string, any>, report: any, sheets: any[], progress?: any, files_?: any[] }} input
 * @returns {Array<{ kind, severity, message, evidence, elementIds }>}
 */
export function runChecks({ files, report, sheets = [], drawingFiles = [] }) {
  const out = [];
  const add = (kind, severity, message, evidence = [], elementIds = []) => out.push({ kind, severity, message, evidence: evidence.filter((e) => e.sheetId).slice(0, 50), elementIds: [...new Set(elementIds)].slice(0, 2000) });
  const site = files['site.json'] || { buildings: [] };
  const types = Object.entries(files).filter(([k]) => k.startsWith('u-')).map(([, v]) => v);

  // 층수: 배치도 글자 / 입·단면 / 골구도 최고층 중 서로 다름
  for (const f of report.floors || []) {
    const vals = [['배치도', f.siteText], ['입·단면', f.levels], ['골구도', f.progressTop]].filter(([, v]) => v != null);
    if (new Set(vals.map(([, v]) => v)).size > 1) {
      const evid = [];
      if (f.siteSheet?.sheetId) evid.push(ev(f.siteSheet.sheetId, f.siteSheet.box, `배치도 ${f.siteText}층`));
      for (const s of f.levelSheets || []) evid.push(ev(s.sheetId, null, `${s.sheetNo} 레벨 ${f.levels}층`));
      add('floors.mismatch', 'error', `${f.building} 층수가 도면마다 다릅니다: ${vals.map(([k, v]) => `${k} ${v}층`).join(', ')}.`, evid, [f.buildingId]);
    }
  }
  for (const [b, list] of groupBy(report.levelConflicts || [], (x) => x.building)) {
    add('levels.conflict', 'error', `${b} 레벨 높이가 시트마다 다릅니다(${list.slice(0, 5).map((c) => `${c.name}: ${c.a.sheetNo} ${c.a.mm.toLocaleString()} / ${c.b.sheetNo} ${c.b.mm.toLocaleString()}mm`).join(', ')}${list.length > 5 ? ` 외 ${list.length - 5}건` : ''}).`,
      list.flatMap((c) => [ev(c.a.sheetId, null, c.name), ev(c.b.sheetId, null, c.name)]));
  }
  for (const u of report.unitsCount || []) add('units.count', 'warn', `${u.building} 기준층 세대 수(${u.plan}세대)가 골구도 라인 수(${u.progress}라인)와 다릅니다.`, [ev(u.sheetId, null)]);
  for (const [label, list] of groupBy(report.unitTypeMissing || [], (x) => x.label)) {
    add('unittype.missing', 'error', `평면에 쓰인 세대 타입 "${label}"의 단위세대 도면이 없습니다(${list.map((x) => `${x.building} ${x.line}호`).join(', ')}). 모양이 비슷한 ${list[0].matched || '다른 타입'}으로 임시 배치했습니다.`,
      list.map((x) => ev(x.sheetId, x.box, `${x.building} ${x.line}호 ${label}`)));
  }
  for (const x of report.unitTypeUnmatched || []) add('unittype.unmatched', 'warn', `${x.building} ${x.line}호 세대 모양이 어느 타입과도 잘 맞지 않습니다(차이 ${x.score ?? '?'}m).`, [ev(x.sheetId, x.box)]);

  // 기호: 평면에 쓰였는데 벽체 상세·마감표에 없음 / 정의했는데 안 쓰임
  const defined = new Set(report.definedCodes || []);
  for (const code of report.usedCodes || []) {
    if (defined.has(code)) continue;
    const where = report.codeSheets?.[code] || [];
    const walls = (report.undefinedCodes || []).filter((x) => x.code === code).map((x) => x.wallId);
    add('finish.code.undefined', 'error', `평면에 쓰인 기호 ${code}가 벽체 상세·마감표에 정의되어 있지 않습니다(${[...new Set(where.map((w) => w.sheetNo))].join(', ')}). 해당 벽은 기본값으로 가정했습니다.`,
      where.map((w) => ev(w.sheetId, ptBox(w.pos, w.uf), `기호 ${code}`)), walls);
  }
  const used = new Set(report.usedCodes || []);
  const cat = files['catalog.json'] || { assemblies: [] };
  for (const a of cat.assemblies.filter((x) => x.code && !used.has(x.code))) add('finish.code.unused', 'info', `${a.code}(${a.name})는 정의되어 있지만 평면 어디에도 쓰이지 않았습니다.`, (a.source?.sheets || []).map((s) => ev(s.sheetId, null)));
  for (const [key, list] of groupBy(report.missingRooms || [], (x) => `${x.typeName}|${x.name}`)) {
    const [t, n] = key.split('|');
    add('finish.room.missing', 'warn', `${t} ${n}의 마감이 실내재료마감표에 없습니다(실명 맞춤 실패). 마감은 비워 두고 젖는 실은 방수로 가정했습니다.`, list.map((x) => ev(x.sheetId, x.box, n)), list.map((x) => x.spaceId));
  }
  if ((report.assumedWalls || []).length) {
    const n = report.assumedWalls.length;
    add('finish.assumed', 'warn', `벽체 기호가 없는 벽 ${n}개는 위치(외벽·세대간·칸막이·욕실)로 마감 층 구성을 가정했습니다. 맞는지 확인해주세요.`, [], report.assumedWalls);
  }
  for (const [code, list] of groupBy(report.thickness || [], (x) => x.code)) {
    const t = list[0];
    add('wall.thickness', 'warn', `${code} 벽 ${list.length}개: 벽체 상세 두께 ${t.assemblyMm}mm와 도면 두께 ${[...new Set(list.map((x) => x.drawnMm))].join('·')}mm가 20mm 넘게 다릅니다.`, list.map((x) => ev(x.sheetId, x.box, code)), list.map((x) => x.wallId));
  }
  for (const d of report.dimMismatch || []) {
    const evid = d.samples.map((x) => ev(d.sheetId, x.box, `치수 ${x.value.toLocaleString()} / 그린 길이 ${x.drawnMm.toLocaleString()}mm`));
    if (d.ratio) add('dim_mismatch', 'error', `${d.sheetNo || '평면'} 치수 ${d.total}개 중 ${d.count}개가 그린 길이의 ${d.ratio}배입니다. 축척이나 단위가 잘못 읽혔을 수 있습니다.`, evid);
    else add('dim_mismatch', 'warn', `${d.sheetNo || '평면'} 치수 ${d.count}개가 그린 길이와 다릅니다(예: 치수 ${d.samples[0].value.toLocaleString()} / 그린 길이 ${d.samples[0].drawnMm.toLocaleString()}mm).`, evid);
  }
  if (report.unmatchedSegments > 0) add('wall.unmatched', 'info', `벽 레이어의 선 ${report.unmatchedSegments}개는 짝을 찾지 못해 벽으로 만들지 않았습니다(외톨이 선).`);
  for (const [code, list] of groupBy(report.unhosted || [], (x) => x.code || x.kind)) add('opening.host', 'warn', `${code} ${list.length}개가 벽에 붙지 않았습니다(벽 틈이 없는 곳의 문·창 블록).`, list.map((x) => ev(x.sheetId, x.box, code)));
  for (const [code, list] of groupBy(report.openingUndefined || [], (x) => x.code)) add('opening.code.undefined', 'warn', `창호 기호 ${code}(${list.length}곳)가 창호 일람표에 없습니다.`, list.map((x) => ev(x.sheetId, x.box, code)), list.map((x) => x.openingId));
  for (const [code, list] of groupBy(report.openingSize || [], (x) => x.code)) {
    const t = list[0];
    add('opening.size', 'warn', `${code} ${list.length}곳: 창호 일람표 폭 ${t.scheduleMm.toLocaleString()}mm와 평면 블록 폭 ${[...new Set(list.map((x) => x.drawnMm))].map((v) => v.toLocaleString()).join('·')}mm가 다릅니다.`, list.map((x) => ev(x.sheetId, x.box, code)), list.map((x) => x.openingId));
  }
  if ((report.unnamed || []).length) add('space.unnamed', 'info', `이름 없는 실 ${report.unnamed.length}개(실명 글자가 없는 칸).`, report.unnamed.map((x) => ev(x.sheetId, x.box)), report.unnamed.map((x) => x.spaceId));
  for (const x of report.areaMismatch || []) add('space.area', 'warn', `${x.name} 계산 면적 ${x.computed.toFixed(2)}㎡가 도면 표기 ${x.drawn}㎡와 10% 넘게 다릅니다.`, [ev(x.sheetId, x.box, x.name)], [x.spaceId]);
  for (const a of (report.align || []).filter((x) => x.iou < 0.85)) add('align.low', 'warn', `${a.building} 평면과 배치도 외곽이 잘 맞지 않습니다(겹침 ${Math.round(a.iou * 100)}%). 위치를 확인해주세요.`, a.sheetIds.map((id) => ev(id, null)), [a.buildingId]);

  // 동 외곽끼리 겹침(격자로 겹친 넓이)
  const B = site.buildings;
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) {
      const a = B[i].footprint;
      const b = B[j].footprint;
      if (!a?.length || !b?.length) continue;
      const ba = boxOf(a);
      const bb = boxOf(b);
      const x0 = Math.max(ba[0], bb[0]);
      const y0 = Math.max(ba[1], bb[1]);
      const x1 = Math.min(ba[2], bb[2]);
      const y1 = Math.min(ba[3], bb[3]);
      if (x0 >= x1 || y0 >= y1) continue;
      let n = 0;
      for (let x = x0 + 0.25; x < x1; x += 0.5) for (let y = y0 + 0.25; y < y1; y += 0.5) if (pointInPolygon(x, y, a) && pointInPolygon(x, y, b)) n++;
      if (n * 0.25 > 1) add('site.overlap', 'error', `${B[i].name}와 ${B[j].name}의 외곽이 약 ${(n * 0.25).toFixed(0)}㎡ 겹칩니다.`, (B[i].source?.sheets || []).map((s) => ev(s.sheetId, s.bbox)), [B[i].id, B[j].id]);
    }
  }
  // 외관(21 지시서)
  for (const [code, list] of groupBy(report.facadeUndefined || [], (x) => x.code)) add('facade.code.undefined', 'error', `입면의 재료 기호 ${code}가 외부 마감표에 없습니다(${[...new Set(list.map((x) => x.building))].join(', ')}). 해당 외벽은 기본값으로 그렸습니다.`, list.map((x) => ev(x.sheetId, null, code)));
  for (const h of report.facadeHeight || []) add('facade.height', 'error', `${h.building} 입면의 최고 높이 ${h.elevationMm.toLocaleString()}mm가 단면도 ${h.sectionMm.toLocaleString()}mm와 다릅니다.`, h.sheetIds.map((id) => ev(id, null)), [h.buildingId]);
  for (const a of report.facadeAssumed || []) add('facade.assumed', 'warn', a.shared ? `${a.building}은 입면도가 없어 같은 평면의 다른 동 입면으로 외벽을 만들었습니다.` : `${a.building}은 입면도가 없어 외벽을 기본값으로 만들었습니다. 재료·색은 실제와 다릅니다.`, [], [a.buildingId]);
  if (report.terrainFlat) add('site.terrain', 'info', '점표고·등고선이 없어 단지를 평지로 그렸습니다.');
  const unk = sheets.filter((s) => s.category === 'unknown');
  if (unk.length) add('sheet.unclassified', 'info', `종류를 모르는 시트 ${unk.length}장: ${unk.map((s) => s.sheetNo || s.title || '번호 없음').join(', ')}.`, unk.map((s) => ev(s.id, s.frame)));
  const failed = sheets.filter((s) => s.status === 'error');
  const failedFiles = drawingFiles.filter((f) => f.status === 'error');
  if (failed.length || failedFiles.length) add('sheet.failed', 'warn', `읽기·AI 판독에 실패한 시트 ${failed.length}장, 파일 ${failedFiles.length}개가 있습니다${failedFiles.length ? `(${failedFiles.map((f) => f.name).join(', ')})` : ''}.`, failed.map((s) => ev(s.id, null)));

  // 방수: 욕실·발코니인데 방수 부위 표시 없음(마감표에 있는 실만 — 없는 실은 finish.room.missing)
  for (const t of types) {
    for (const sp of t.spaces) {
      if (!['bath', 'balcony'].includes(sp.use) || sp.zones?.includes('waterproof') || sp.source?.finish === 'assumed') continue;
      if (!sp.finish) continue;
      add('waterproof.missing', 'warn', `${t.name} ${sp.name}(${sp.use === 'bath' ? '욕실' : '발코니'})에 방수 표시가 없습니다(실내재료마감표 확인).`, (sp.source?.sheets || []).map((s) => ev(s.sheetId, s.bbox, sp.name)), [sp.id]);
    }
  }
  checkSections({ files, report, types, add });
  return out.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.kind.localeCompare(b.kind));
}

const STACK_TOL = 10; // mm
const mm = (v) => Math.round(v).toLocaleString();

// 단면·상세·구조(38 지시서 3·5절): 층고 검산, 단면·구조 슬래브 두께, 건축·구조 벽 두께, 일람표에 없는 구조 기호
function checkSections({ files, report, types, add }) {
  const cat = files['catalog.json'] || {};
  const members = cat.structure || [];
  const slabs = members.filter((m) => m.kind === 'slab' && m.thicknessMm);
  for (const t of types) {
    const sec = t.section;
    if (!sec) continue;
    const evid = [ev(sec.sheetId, null, t.name)];
    // 천장고 + 바닥 구성 + 슬래브 + 천장 속 = 층고
    if (sec.floorHeightMm && sec.slabMm) {
      for (const r of sec.rooms || []) {
        if (!r.ceilingMm) continue;
        const sp = (t.spaces || []).find((x) => x.name === r.name);
        const fl = sec.floors.find((x) => x.assemblyId === sp?.floorAssemblyId) || sec.floors.find((x) => x.rooms.some((w) => r.name.includes(w)));
        if (!fl) continue;
        const sum = r.ceilingMm + fl.buildMm + sec.slabMm + (r.voidMm ?? 0);
        if (r.voidMm != null && Math.abs(sum - sec.floorHeightMm) > STACK_TOL) {
          add('level.stack', 'warn', `${t.name} ${r.name}: 천장고 ${mm(r.ceilingMm)} + 바닥 ${mm(fl.buildMm)} + 슬래브 ${mm(sec.slabMm)} + 천장 속 ${mm(r.voidMm)} = ${mm(sum)}mm가 층고 ${mm(sec.floorHeightMm)}mm와 다릅니다.`, evid, sp ? [sp.id] : []);
        } else if (r.voidMm == null && sum > sec.floorHeightMm + STACK_TOL) {
          add('level.stack', 'warn', `${t.name} ${r.name}: 천장고 ${mm(r.ceilingMm)} + 바닥 ${mm(fl.buildMm)} + 슬래브 ${mm(sec.slabMm)} = ${mm(sum)}mm가 층고 ${mm(sec.floorHeightMm)}mm보다 큽니다.`, evid, sp ? [sp.id] : []);
        }
      }
    }
    if (sec.slabMm && slabs.length && !slabs.some((m) => m.thicknessMm === sec.slabMm)) {
      add('struct.slab', 'error', `${t.name} 단면의 슬래브 두께 ${mm(sec.slabMm)}mm가 구조 부재 일람표(${slabs.map((m) => `${m.mark} ${mm(m.thicknessMm)}`).join(', ')})와 다릅니다.`,
        [...evid, ...slabs.flatMap((m) => (m.source?.sheets || []).map((x) => ev(x.sheetId, null, m.mark)))]);
    }
  }
  for (const w of report.details?.structWall || []) {
    add('struct.wall', 'warn', `벽체 ${w.code || w.assemblyId}의 구조체 두께 ${mm(w.coreMm)}mm가 구조 부재 일람표의 벽(${w.structure.join(', ')})에 없습니다.`);
  }
  const known = new Set(members.map((m) => m.mark));
  for (const [mark, list] of groupBy((report.details?.structureMarks || []).filter((p) => !known.has(p.mark)), (p) => p.mark)) {
    add('struct.missing', 'warn', `구조 평면의 기호 ${mark}(${list.length}곳)가 구조 부재 일람표에 없습니다.`, list.map((p) => ev(p.sheetId, { x0: p.pos[0] - 600, y0: p.pos[1] - 600, x1: p.pos[0] + 600, y1: p.pos[1] + 600 }, mark)));
  }
}

export function countBySeverity(list) {
  const c = { error: 0, warn: 0, info: 0 };
  for (const f of list) if (f.status !== 'ignored' && f.status !== 'resolved') c[f.severity]++;
  return c;
}

