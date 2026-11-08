// BIM JSON(baromap-bim/2) 모양 — 01 3절, 18 1절. 모델 저장·수정 연산(validate.js)·테스트가 같은 스키마를 쓴다.
import { S, check } from './jsonschema.js';

const PT = S.arr(S.num(), { minItems: 2, maxItems: 2 });
const POLY = S.arr(PT);
const SRC = { type: 'object', required: ['method'], properties: { method: S.enm(['rule', 'ai', 'manual', 'assumed', 'doc']), sheets: S.arr({ type: 'object' }), docs: S.arr({ type: 'object' }), confidence: S.num({ minimum: 0, maximum: 1 }), reviewId: S.str() } };
const T2 = { type: 'object', required: ['x', 'y', 'rotDeg'], properties: { x: S.num(), y: S.num(), rotDeg: S.num(), mirror: S.bool() } };
const ID = (prefix) => S.str({ minLength: prefix.length + 1, maxLength: 80 });

export const WALL = { type: 'object', required: ['id', 'path', 'thickness', 'assemblyId'], properties: { id: ID('w_'), path: S.arr(PT, { minItems: 2, maxItems: 2 }), thickness: S.num({ minimum: 0.01, maximum: 3 }), height: S.nul(S.num()), assemblyId: S.nul(S.str()), code: S.nul(S.str()), exterior: S.bool(), sides: { type: 'object' }, source: SRC } };
export const OPENING = { type: 'object', required: ['id', 'kind', 'wallId', 'offset', 'width', 'height', 'sill'], properties: { id: ID('op_'), kind: S.enm(['door', 'window', 'opening']), wallId: S.str(), offset: S.num({ minimum: 0 }), width: S.num({ minimum: 0.1, maximum: 20 }), height: S.num({ minimum: 0.1, maximum: 20 }), sill: S.num({ minimum: 0, maximum: 20 }), typeCode: S.nul(S.str()), source: SRC } };
export const SPACE = { type: 'object', required: ['id', 'name', 'use', 'polygon'], properties: { id: ID('sp_'), name: S.str({ maxLength: 40 }), use: S.enm(['living', 'bedroom', 'kitchen', 'bath', 'balcony', 'dress', 'utility', 'hall', 'other']), polygon: POLY, areaM2: S.num(), finish: S.nul({ type: 'object' }), ceilingMm: S.nul(S.num({ minimum: 1000, maximum: 20000 })), floorAssemblyId: S.nul(S.str()), zones: S.arr(S.enm(['waterproof', 'insulation', 'soundproof', 'fireproof'])), source: SRC } };
export const COLUMN = { type: 'object', required: ['id', 'polygon'], properties: { id: S.str(), polygon: POLY, assemblyId: S.nul(S.str()) } };

export const UNIT_TYPE = {
  type: 'object', required: ['id', 'name', 'kind', 'outline', 'walls', 'openings', 'spaces'],
  properties: { id: ID('ut_'), name: S.str({ maxLength: 60 }), kind: S.enm(['unit', 'facility']), areaM2: S.num(), section: S.nul({ type: 'object' }), outline: POLY, walls: S.arr(WALL), columns: S.arr(COLUMN), openings: S.arr(OPENING), spaces: S.arr(SPACE), source: SRC },
};

const LEVEL = { type: 'object', required: ['id', 'name', 'elevation', 'height', 'kind'], properties: { id: S.str(), name: S.str({ maxLength: 20 }), elevation: S.num(), height: S.num({ minimum: 0, maximum: 30 }), kind: S.enm(['basement', 'pilotis', 'typical', 'top', 'rooftop', 'other']), slabMm: S.nul(S.num({ minimum: 50, maximum: 2000 })), finishFloorMm: S.nul(S.num()) } };
const INSTANCE = { type: 'object', required: ['id', 'unitTypeId', 'transform'], properties: { id: S.str(), line: S.nul(S.str()), unitTypeId: S.str(), transform: T2 } };
const TEMPLATE = { type: 'object', required: ['id', 'levelIds', 'walls', 'units'], properties: { id: S.str(), name: S.str(), levelIds: S.arr(S.str()), walls: S.arr(WALL), columns: S.arr(COLUMN), openings: S.arr(OPENING), spaces: S.arr(SPACE), cores: S.arr({ type: 'object', required: ['kind', 'polygon'], properties: { kind: S.enm(['stair', 'elevator']), polygon: POLY } }), units: S.arr(INSTANCE) } };

export const BUILDING = {
  type: 'object', required: ['id', 'name', 'transform', 'levels', 'floorTemplates', 'units'],
  properties: {
    id: ID('bd_'), name: S.str({ maxLength: 60 }), kind: S.enm(['apartment', 'community', 'parking', 'commercial', 'other']), transform: T2, outline: POLY,
    levels: S.arr(LEVEL), floorTemplates: S.arr(TEMPLATE),
    units: S.arr({ type: 'object', required: ['id', 'unitKey', 'label', 'levelId', 'unitTypeId', 'transform'], properties: { id: S.str(), unitKey: S.str({ maxLength: 20 }), label: S.str(), levelId: S.str(), line: S.str(), unitTypeId: S.str(), transform: T2 } }),
    progressBuildingId: S.nul(S.str()),
    baseElevation: S.num(), facade: { type: 'object', properties: { zones: S.arr({ type: 'object', required: ['id', 'color'] }), panels: S.arr({ type: 'object', required: ['id', 'side', 'path', 'zoneId', 'areaM2', 'openingAreaM2'] }) } },
    balconies: S.arr({ type: 'object', required: ['id', 'polygon', 'levelIds'] }), roof: S.nul({ type: 'object' }),
  },
};

export const SITE = {
  type: 'object', required: ['boundary', 'buildings'],
  properties: {
    boundary: POLY, roads: S.arr({ type: 'object', required: ['polygon'], properties: { polygon: POLY } }), landscape: S.arr({ type: 'object', required: ['polygon'], properties: { polygon: POLY } }),
    underground: S.arr({ type: 'object', required: ['polygon'], properties: { polygon: POLY } }),
    buildings: S.arr({ type: 'object', required: ['id', 'name', 'kind', 'footprint', 'floorsAbove', 'height', 'file'], properties: { id: S.str(), name: S.str(), kind: S.str(), footprint: POLY, floorsAbove: S.int({ minimum: 0, maximum: 200 }), floorsBelow: S.int({ minimum: 0, maximum: 20 }), height: S.num(), file: S.str(), progressBuildingId: S.nul(S.str()) } }),
    terrain: S.nul({ type: 'object', required: ['points', 'triangles'] }), pavings: S.arr({ type: 'object', required: ['id', 'polygon'] }), trees: S.arr({ type: 'object', required: ['id', 'x', 'y'] }), features: S.arr({ type: 'object', required: ['id', 'kind', 'polygon'] }),
  },
};

const PERF = { type: 'object', required: ['key', 'label'], properties: { key: S.str(), label: S.str(), value: S.nul({ type: ['number', 'string'] }), unit: S.nul(S.str()), standard: S.nul(S.str()) } };
const WINDOW_TYPE = { type: 'object', required: ['id', 'code', 'kind'], properties: { id: ID('wt_'), code: S.str({ maxLength: 40 }), kind: S.enm(['window', 'door']), name: S.nul(S.str()), appliesTo: { type: 'object' }, sizeMm: S.nul({ type: 'object' }), frame: { type: 'object' }, glass: S.nul({ type: 'object' }), perf: { type: 'object' }, source: SRC } };

export const CATALOG = {
  type: 'object', required: ['materials', 'assemblies'],
  properties: {
    materials: S.arr({ type: 'object', required: ['id', 'name', 'category', 'color'], properties: { id: S.str(), name: S.str(), category: S.enm(['structure', 'masonry', 'insulation', 'plaster', 'board', 'lightweight', 'finish', 'waterproof', 'other']), color: S.str(), trades: S.arr(S.str()), spec: S.nul(S.str()), maker: S.nul(S.str()), perf: S.arr(PERF), render: { type: 'object' }, source: SRC } }),
    windowTypes: S.arr(WINDOW_TYPE),
    // 시공 상세 값(키는 detail-keys.js)·구조 부재(38 지시서)
    details: S.arr({ type: 'object', required: ['id', 'key', 'value'], properties: { id: S.str(), key: S.str(), value: { type: ['number', 'string'] }, note: S.str(), title: S.str(), appliesTo: { type: 'object' }, source: SRC } }),
    structure: S.arr({ type: 'object', required: ['id', 'mark', 'kind'], properties: { id: S.str(), mark: S.str({ maxLength: 20 }), kind: S.enm(['wall', 'slab', 'column', 'beam', 'other']), thicknessMm: S.nul(S.num()), sizeMm: S.nul(S.arr(S.num())), note: S.str(), source: SRC } }),
    assemblies: S.arr({ type: 'object', required: ['id', 'kind', 'name', 'layers'], properties: { id: S.str(), code: S.nul(S.str()), kind: S.enm(['wall', 'floor', 'ceiling', 'roof', 'column']), name: S.str(), structure: S.nul({ type: 'object' }), layers: S.arr({ type: 'object', required: ['materialId', 'side'], properties: { materialId: S.str(), thicknessMm: S.nul(S.num({ minimum: 0, maximum: 5000 })), side: S.enm(['core', 'in', 'out']) } }) } }),
  },
};

export const INDEX = {
  type: 'object', required: ['schema', 'files', 'summary'],
  properties: { schema: { enum: ['baromap-bim/1', 'baromap-bim/2'] }, siteId: S.str(), modelId: S.str(), version: S.int(), files: { type: 'object', required: ['site', 'catalog', 'buildings', 'unitTypes'] }, summary: { type: 'object' } },
};

export function schemaForFile(name) {
  if (name === 'index.json') return INDEX;
  if (name === 'site.json') return SITE;
  if (name === 'catalog.json') return CATALOG;
  if (/^b-.+\.json$/.test(name)) return BUILDING;
  if (/^u-.+\.json$/.test(name)) return UNIT_TYPE;
  return null;
}

// 모델 파일 묶음 전체 검사 → 오류 목록(파일 이름: 경로: 문장)
export function checkModelFiles(files) {
  const errors = [];
  for (const [name, obj] of Object.entries(files)) {
    const schema = schemaForFile(name);
    if (!schema) { errors.push(`${name}: 알 수 없는 파일`); continue; }
    for (const e of check(schema, obj, { max: 20 })) errors.push(`${name}: ${e}`);
  }
  const idx = files['index.json'];
  if (idx) {
    for (const f of [...Object.values(idx.files?.buildings || {}), ...Object.values(idx.files?.unitTypes || {})]) if (!files[f]) errors.push(`index.json: 목록의 ${f} 파일이 없습니다`);
  }
  return errors;
}
