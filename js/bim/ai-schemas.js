// AI 판독 출력 스키마(JSON Schema). 브라우저·Node 테스트·Edge Function(supabase/functions/_shared/lib/에 복사)이 같은 객체를 쓴다.
// Claude 구조화 출력(output_config.format)에는 apiSchema()로 지원하지 않는 제약(최소·최대·길이·개수)을 뺀 사본을 보내고,
// 받은 결과는 원래 스키마로 다시 검사한다(jsonschema.js).
// 위치는 모두 시트 그림 픽셀 좌표(0~2048, 왼쪽 위 원점)로 받고, 저장할 때 시트 좌표로 바꾼다.
import { S } from './jsonschema.js';
import { CLASSES, PARTS } from './triage-core.js';
import { DOC_KINDS } from './doc-core.js';
import { DETAIL_KEY_NAMES } from './detail-keys.js';

export const CATEGORIES = ['site_plan', 'floor_plan', 'unit_plan', 'elevation', 'section', 'facility_plan', 'finish_schedule', 'wall_types', 'window_schedule', 'detail', 'cover_index', 'structure', 'mep', 'landscape', 'roof_plan', 'exterior_finish', 'color_plan', 'civil_plan', 'landscape_plan', 'unknown'];
export const LAYER_ROLES = [
  'wall', 'wall_hatch', 'column', 'slab_edge', 'door', 'window', 'curtain_wall', 'stair', 'elevator',
  'room_name', 'room_area', 'unit_boundary', 'unit_label', 'building_outline', 'building_label',
  'road', 'landscape', 'grid', 'level_mark', 'dimension', 'finish_tag', 'wall_tag', 'door_tag',
  'window_tag', 'insulation', 'masonry', 'waterproof', 'furniture', 'annotation', 'frame', 'ignore',
  'site_boundary', 'underground', // 구현 때 추가: 대지 경계·지하주차장 외곽(04 8절)
  'facade_zone', 'roof_outline', 'penthouse', 'paving', 'tree', 'site_feature', 'spot_level', 'contour', // M16: 입면 재료 구획·지붕·조경·지형
];
export const ROOM_USES = ['living', 'bedroom', 'kitchen', 'bath', 'balcony', 'dress', 'utility', 'hall', 'other'];
export const MATERIAL_CATEGORIES = ['structure', 'masonry', 'insulation', 'plaster', 'board', 'lightweight', 'finish', 'waterproof', 'other'];
export const ZONES = ['waterproof', 'insulation', 'soundproof', 'fireproof'];
export const LEVEL_KINDS = ['basement', 'pilotis', 'typical', 'top', 'rooftop', 'other'];

const PX = S.arr(S.num({ minimum: -100, maximum: 4000 }), { minItems: 2, maxItems: 2 });
const CONF = S.num({ minimum: 0, maximum: 1 });
const NSTR = S.nul(S.str({ maxLength: 200 }));
const NNUM = S.nul(S.num());

export const SheetClassification = S.obj({
  category: S.enm(CATEGORIES),
  sheetNo: NSTR,
  title: NSTR,
  scale: NSTR,
  buildings: S.arr(S.str({ maxLength: 30 }), { maxItems: 100 }),
  unitTypes: S.arr(S.str({ maxLength: 30 }), { maxItems: 100 }),
  floors: S.arr(S.str({ maxLength: 30 }), { maxItems: 100 }),
  facility: NSTR,
  layerRoles: S.arr(S.obj({ layer: S.str({ maxLength: 255 }), role: S.enm(LAYER_ROLES), confidence: CONF }), { maxItems: 500 }),
  legend: S.arr(S.obj({ symbol: S.str({ maxLength: 20 }), meaning: S.str({ maxLength: 500 }) }), { maxItems: 300 }),
  confidence: CONF,
  notes: S.str({ maxLength: 2000 }),
});

// 건물 선 판별(19 3-3절): 무리·낱개 판정과 "버려진 선 확인 필요" 표시
export const SheetTriage = S.obj({
  clusters: S.arr(S.obj({ id: S.str({ maxLength: 20 }), class: S.enm(CLASSES), part: S.nul(S.enm(PARTS)), confidence: CONF, reason: S.str({ maxLength: 200 }) }), { maxItems: 3000 }),
  entities: S.arr(S.obj({ h: S.str({ maxLength: 120 }), class: S.enm(CLASSES), part: S.nul(S.enm(PARTS)), reason: S.str({ maxLength: 200 }) }), { maxItems: 500 }),
  missing: S.arr(S.obj({ box: S.arr(S.num({ minimum: -100, maximum: 4000 }), { minItems: 4, maxItems: 4 }), note: S.str({ maxLength: 200 }) }), { maxItems: 50 }),
});

export const SitePlanExtract = S.obj({
  buildings: S.arr(S.obj({
    label: S.str({ maxLength: 60 }),
    kind: S.enm(['apartment', 'community', 'parking', 'commercial', 'other']),
    outlineHandles: S.nul(S.arr(S.str({ maxLength: 60 }), { maxItems: 50 })),
    labelPos: PX,
    floorsText: NSTR,
    confidence: CONF,
  }), { maxItems: 200 }),
  roads: S.arr(S.obj({ pos: PX, note: S.str({ maxLength: 200 }) }), { maxItems: 100 }),
  northDeg: NNUM,
  boundaryHint: NSTR,
});

export const LevelExtract = S.obj({
  building: NSTR,
  levels: S.arr(S.obj({
    name: S.str({ maxLength: 20 }),
    elevationMm: S.num(),
    heightMm: NNUM,
    kind: S.enm(LEVEL_KINDS),
  }), { maxItems: 200 }),
  floorsAbove: S.nul(S.int({ minimum: 0, maximum: 200 })),
  floorsBelow: S.nul(S.int({ minimum: 0, maximum: 20 })),
  totalHeightMm: NNUM,
  notes: S.str({ maxLength: 2000 }),
});

// rot: 기호 글자의 회전(도, 도면 기준 반시계). 벽 기호는 벽과 같은 방향으로 쓰는 관례 → 같은 방향 벽을 고른다. 모르면 null
const TAG = S.obj({ code: S.str({ maxLength: 20 }), kind: S.enm(['wall', 'door', 'window', 'finish']), pos: PX, rot: S.nul(S.num()) });
const ROOM = S.obj({ name: S.str({ maxLength: 40 }), use: S.enm(ROOM_USES), labelPos: PX });

export const FloorPlanExtract = S.obj({
  rooms: S.arr(ROOM, { maxItems: 2000 }),
  units: S.arr(S.obj({ line: NSTR, unitType: NSTR, labelPos: PX }), { maxItems: 200 }),
  tags: S.arr(TAG, { maxItems: 3000 }),
  cores: S.arr(S.obj({ kind: S.enm(['stair', 'elevator']), pos: PX }), { maxItems: 100 }),
  notes: S.str({ maxLength: 2000 }),
});

export const UnitPlanExtract = S.obj({
  typeName: S.str({ maxLength: 30 }),
  areaM2: NNUM,
  rooms: S.arr(S.obj({ name: S.str({ maxLength: 40 }), use: S.enm(ROOM_USES), labelPos: PX, areaText: NSTR }), { maxItems: 200 }),
  tags: S.arr(TAG, { maxItems: 1000 }),
  waterproofRooms: S.arr(S.str({ maxLength: 40 }), { maxItems: 100 }),
  notes: S.str({ maxLength: 2000 }),
});

export const FinishScheduleExtract = S.obj({
  assemblies: S.arr(S.obj({
    code: S.str({ maxLength: 20 }),
    kind: S.enm(['wall', 'floor', 'ceiling', 'roof', 'column']),
    name: S.str({ maxLength: 200 }),
    layers: S.arr(S.obj({ material: S.str({ maxLength: 100 }), category: S.enm(MATERIAL_CATEGORIES), thicknessMm: NNUM }), { maxItems: 30 }),
  }), { maxItems: 300 }),
  rooms: S.arr(S.obj({
    roomName: S.str({ maxLength: 40 }),
    unitTypes: S.arr(S.str({ maxLength: 30 }), { maxItems: 50 }),
    floor: NSTR, base: NSTR, wall: NSTR, ceiling: NSTR,
    zones: S.arr(S.enm(ZONES), { maxItems: 4 }),
  }), { maxItems: 1000 }),
  notes: S.str({ maxLength: 2000 }),
});

export const WindowScheduleExtract = S.obj({
  items: S.arr(S.obj({
    code: S.str({ maxLength: 20 }),
    kind: S.enm(['door', 'window']),
    widthMm: NNUM, heightMm: NNUM, sillMm: NNUM,
    material: NSTR,
    count: S.nul(S.int({ minimum: 0, maximum: 100000 })),
  }), { maxItems: 500 }),
});

// 도서 대조 검토(05 2절): 규칙으로 못 잡는(그림을 봐야 아는) 모순. 위치는 그 시트 그림의 픽셀 상자 [x0, y0, x1, y1]
export const ReviewFindings = S.obj({
  findings: S.arr(S.obj({
    kind: S.str({ maxLength: 60 }),
    severity: S.enm(['info', 'warn', 'error']),
    message: S.str({ maxLength: 2000 }),
    evidence: S.arr(S.obj({ sheetNo: S.str({ maxLength: 40 }), px: S.arr(S.num(), { minItems: 4, maxItems: 4 }), note: S.str({ maxLength: 300 }) }), { maxItems: 10 }),
    elementHints: S.arr(S.str({ maxLength: 200 }), { maxItems: 20 }),
    confidence: CONF,
  }), { maxItems: 50 }),
});

// ---------------------------------------------------------------- AI 수정 요청(07 3절) 도구 입력 — 모두 strict(필수·additionalProperties:false)
// 수정 연산의 자유로운 값(set 값·추가 요소)은 strict 스키마로 표현할 수 없어 JSON 글자로 받는다(valueJson·elementJson).
const EVID = S.obj({ sheetNo: S.str({ maxLength: 40 }), px: S.arr(S.num(), { minItems: 4, maxItems: 4 }), note: S.str({ maxLength: 300 }) });
export const EDIT_OP = S.obj({
  op: S.enm(['update', 'add', 'remove']),
  file: S.str({ maxLength: 120 }),
  id: S.nul(S.str({ maxLength: 80 })),
  collection: S.nul(S.str({ maxLength: 40 })),
  parentId: S.nul(S.str({ maxLength: 80 })),
  set: S.arr(S.obj({ path: S.str({ maxLength: 80 }), valueJson: S.str({ maxLength: 20000 }) }), { maxItems: 40 }),
  elementJson: S.nul(S.str({ maxLength: 50000 })),
  reason: S.str({ maxLength: 500 }),
  evidence: S.arr(EVID, { maxItems: 5 }),
});
export const EDIT_TOOLS = [
  { name: 'view_sheet', description: '도서 시트 그림을 본다. region을 주면(전체 그림 픽셀 [x0,y0,x1,y1]) 그 부분 확대 조각과 그 안의 글자 목록을 준다. zoom은 1~3(크면 더 작은 조각).',
    schema: S.obj({ sheetNo: S.str({ maxLength: 40 }), region: S.nul(S.arr(S.num(), { minItems: 4, maxItems: 4 })), zoom: S.nul(S.int({ minimum: 1, maximum: 3 })) }) },
  { name: 'search_text', description: '모든 시트 요약에서 글자를 찾는다(예: "W3", "욕실", "AW1"). 결과: 시트 번호·글자·위치(픽셀).',
    schema: S.obj({ query: S.str({ maxLength: 100 }), category: S.nul(S.enm(CATEGORIES)) }) },
  { name: 'get_elements', description: '지금 모델의 요소를 찾는다(최대 200개, 요약). kind: building·level·unit·unit_type·space·wall·opening. 수정 연산의 file·id는 여기서 확인한다.',
    schema: S.obj({ filter: S.obj({ kind: S.nul(S.enm(['building', 'level', 'unit', 'unit_type', 'space', 'wall', 'opening'])), buildingId: S.nul(S.str({ maxLength: 80 })), level: S.nul(S.str({ maxLength: 20 })), unitKey: S.nul(S.str({ maxLength: 20 })), unitTypeId: S.nul(S.str({ maxLength: 80 })), name: S.nul(S.str({ maxLength: 60 })), assemblyCode: S.nul(S.str({ maxLength: 20 })) }) }) },
  { name: 'get_catalog', description: '조립체(벽체 기호·바닥·천장 마감)와 재료 상세. codes를 주면 그 기호만.',
    schema: S.obj({ codes: S.nul(S.arr(S.str({ maxLength: 20 }), { maxItems: 30 })) }) },
  { name: 'read_attachment', description: '담당자가 붙인 추가 자료(PDF·사진·도면 그림·표)를 읽는다. name은 첨부 목록의 이름.',
    schema: S.obj({ name: S.str({ maxLength: 200 }), page: S.nul(S.int({ minimum: 1, maximum: 999 })) }) },
  { name: 'propose_patch', description: '작업을 끝낼 때 반드시 한 번 부른다: 이해한 내용, 수정 연산 목록(근거 포함), 전체 근거, 담당자에게 물을 것. 고칠 것이 없거나 확실하지 않으면 ops는 비우고 questions에 묻는다.',
    schema: S.obj({ understanding: S.str({ maxLength: 3000 }), ops: S.arr(EDIT_OP, { maxItems: 200 }), evidence: S.arr(EVID, { maxItems: 20 }), questions: S.arr(S.str({ maxLength: 500 }), { maxItems: 10 }) }) },
];

/** propose_patch 입력(도구 형식) → 수정 연산(validate.js 형식). 위치는 sheetOf(sheetNo)로 시트 좌표 상자로 바꾼다. */
export function toolOps(input, sheetOf = () => null) {
  const errors = [];
  const ev = (list) => (list || []).map((e) => {
    const s = sheetOf(e.sheetNo);
    if (!s?.frame) return { sheetNo: e.sheetNo, note: e.note };
    const [x0, y1] = pixelToSheet(s.frame, e.px[0], e.px[1]);
    const [x1, y0] = pixelToSheet(s.frame, e.px[2], e.px[3]);
    return { sheetId: s.id, sheetNo: e.sheetNo, bbox: { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) }, note: e.note };
  });
  const ops = (input.ops || []).map((o, i) => {
    const op = { op: o.op, file: o.file, reason: o.reason, evidence: ev(o.evidence) };
    if (o.op !== 'add') op.id = o.id;
    if (o.op === 'update') {
      op.set = {};
      for (const s of o.set || []) {
        try { op.set[s.path] = JSON.parse(s.valueJson); } catch { errors.push(`${i + 1}번 연산: ${s.path}의 valueJson이 JSON이 아닙니다`); }
      }
    }
    if (o.op === 'add') {
      op.collection = o.collection;
      if (o.parentId) op.parentId = o.parentId;
      try { op.element = JSON.parse(o.elementJson || 'null'); } catch { errors.push(`${i + 1}번 연산: elementJson이 JSON이 아닙니다`); }
    }
    return op;
  });
  return { ops, evidence: ev(input.evidence), errors };
}

// 입면 재료 구획(21 지시서 2절). box는 시트 그림의 픽셀 상자 [x0, y0, x1, y1]
export const ElevationFacadeExtract = S.obj({
  building: NSTR,
  side: S.nul(S.enm(['south', 'east', 'north', 'west', 'front', 'back', 'left', 'right'])),
  sideLabel: NSTR,
  zones: S.arr(S.obj({ code: S.str({ maxLength: 20 }), material: NSTR, color: NSTR, fromLevel: NSTR, toLevel: NSTR, box: S.nul(S.arr(S.num(), { minItems: 4, maxItems: 4 })), confidence: CONF })),
  features: S.arr(S.obj({ kind: S.enm(['parapet', 'canopy', 'louver', 'ornament', 'signage']), box: S.nul(S.arr(S.num(), { minItems: 4, maxItems: 4 })), note: NSTR })),
  notes: S.str({ maxLength: 500 }),
});
export const ExteriorFinishExtract = S.obj({
  items: S.arr(S.obj({ code: S.str({ maxLength: 20 }), material: S.str({ maxLength: 120 }), color: NSTR, part: NSTR })),
});

// 문서 읽기(20 지시서). 값이 표에 없으면 null이다. page는 문서의 쪽 번호, box는 쪽 그림의 비율 상자 [x0, y0, x1, y1](0~1)
const BOX01 = S.nul(S.arr(S.num({ minimum: 0, maximum: 1 }), { minItems: 4, maxItems: 4 }));
export const DocClassification = S.obj({
  kind: S.enm(DOC_KINDS),
  title: NSTR,
  revision: NSTR,
  docDate: NSTR,
  confidence: CONF,
  notes: S.str({ maxLength: 500 }),
});
export const DocExtract = S.obj({
  windows: S.arr(S.obj({
    code: S.str({ maxLength: 40 }),
    kind: S.enm(['window', 'door']),
    name: NSTR,
    unitTypes: S.arr(S.str({ maxLength: 40 })),
    rooms: S.arr(S.str({ maxLength: 40 })),
    widthMm: NNUM,
    heightMm: NNUM,
    frameMaterial: NSTR,
    opening: NSTR,
    maker: NSTR,
    glass: NSTR,
    uWindow: NNUM,
    uGlass: NNUM,
    shgc: NNUM,
    airtightValue: NNUM,
    airtightGrade: NSTR,
    watertight: NSTR,
    windPressure: NSTR,
    sound: NSTR,
    efficiencyGrade: NSTR,
    fire: NSTR,
    certNo: NSTR,
    box: BOX01,
    confidence: CONF,
  })),
  materials: S.arr(S.obj({
    name: S.str({ maxLength: 120 }),
    spec: NSTR,
    maker: NSTR,
    perf: S.arr(S.obj({ key: S.str({ maxLength: 40 }), label: S.str({ maxLength: 60 }), value: S.nul({ type: ['number', 'string'] }), unit: NSTR, standard: NSTR })),
    box: BOX01,
    confidence: CONF,
  })),
  finishes: S.arr(S.obj({
    unitType: NSTR,
    room: S.str({ maxLength: 60 }),
    floor: NSTR,
    wall: NSTR,
    ceiling: NSTR,
    base: NSTR,
    option: NSTR,
    box: BOX01,
    confidence: CONF,
  })),
  notes: S.str({ maxLength: 500 }),
});

// 종류별 추출 스키마(없으면 분류만)
// 단면·상세·구조(38 지시서): 단위세대 단면에서 슬래브·천장고·바닥 구성, 시공 상세에서 상세 값, 구조도에서 부재 두께
const FLOOR_LAYER = S.obj({ material: S.str({ maxLength: 40 }), category: S.enm(MATERIAL_CATEGORIES), thicknessMm: NNUM, slab: S.bool() });
const PART_LAYER = S.obj({ material: S.str({ maxLength: 40 }), category: S.enm(MATERIAL_CATEGORIES), thicknessMm: NNUM });
export const SectionDetailExtract = S.obj({
  unitType: NSTR,
  floorHeightMm: NNUM,
  slabMm: NNUM,
  floors: S.arr(S.obj({ rooms: S.arr(S.str({ maxLength: 20 }), { maxItems: 20 }), layers: S.arr(FLOOR_LAYER, { maxItems: 12 }), pos: PX }), { maxItems: 10 }),
  // 천장·벽체 구성(42 지시서 4.3): 천장은 위(천장틀) → 아래(마감), 벽은 실외·반대쪽 → 실내 순서. 도면에 없으면 빈 목록
  ceilings: S.arr(S.obj({ rooms: S.arr(S.str({ maxLength: 20 }), { maxItems: 20 }), layers: S.arr(PART_LAYER, { maxItems: 12 }), pos: PX }), { maxItems: 10 }),
  walls: S.arr(S.obj({ rooms: S.arr(S.str({ maxLength: 20 }), { maxItems: 20 }), layers: S.arr(PART_LAYER, { maxItems: 12 }), pos: PX }), { maxItems: 20 }),
  rooms: S.arr(S.obj({ name: S.str({ maxLength: 40 }), ceilingMm: NNUM, voidMm: NNUM, pos: PX }), { maxItems: 60 }),
  notes: S.str({ maxLength: 2000 }),
});
const SCOPE = S.obj({ typeCodes: S.arr(S.str({ maxLength: 20 }), { maxItems: 30 }), rooms: S.arr(S.str({ maxLength: 20 }), { maxItems: 20 }), zones: S.arr(S.str({ maxLength: 20 }), { maxItems: 10 }) });
export const ConstructionDetailExtract = S.obj({
  details: S.arr(S.obj({
    title: S.str({ maxLength: 80 }),
    key: S.enm(DETAIL_KEY_NAMES),
    value: { type: ['number', 'string'] },
    note: S.str({ maxLength: 120 }),
    appliesTo: SCOPE,
    pos: PX,
  }), { maxItems: 300 }),
  // 층 구성(42 지시서 4.3): 상세에 그려진 바닥·벽·천장의 층 목록. 바닥·천장은 위 → 아래, 벽은 실외·반대쪽 → 실내. 없으면 빈 목록
  compositions: S.arr(S.obj({ part: S.enm(['floor', 'wall', 'ceiling', 'roof']), title: S.str({ maxLength: 80 }), rooms: S.arr(S.str({ maxLength: 20 }), { maxItems: 20 }), layers: S.arr(PART_LAYER, { maxItems: 12 }), pos: PX }), { maxItems: 60 }),
  notes: S.str({ maxLength: 2000 }),
});
// 시방서·회사 기준 요구사항, 기술검토서(39 지시서 4절). 값이 없으면 null로 비운다
export const REQ_OPS = ['>=', '<=', '=', '>', '<'];
export const SpecRequirementExtract = S.obj({
  chapters: S.arr(S.obj({ title: S.str({ maxLength: 80 }), trade: S.str({ maxLength: 20 }) }), { maxItems: 100 }),
  requirements: S.arr(S.obj({
    trade: S.str({ maxLength: 20 }), item: S.str({ maxLength: 80 }), requirement: S.str({ maxLength: 200 }),
    values: S.arr(S.obj({ key: S.enm(DETAIL_KEY_NAMES), op: S.enm(REQ_OPS), value: S.num(), unit: S.str({ maxLength: 20 }), label: S.str({ maxLength: 40 }) }), { maxItems: 10 }),
    appliesTo: SCOPE, kcs: NSTR,
  }), { maxItems: 300 }),
  notes: S.str({ maxLength: 2000 }),
});
export const TechReviewExtract = S.obj({
  kind: S.enm(['excavation', 'crane', 'formwork', 'scaffold', 'other']),
  summaryPages: S.arr(S.int({ minimum: 1, maximum: 2000 }), { maxItems: 50 }),
  values: S.obj({
    method: NSTR, depthM: NNUM, support: NSTR, stages: NNUM, monitoring: NSTR,
    model: NSTR, count: NNUM, heightM: NNUM, foundationM: S.nul(S.arr(S.num(), { maxItems: 3 })), location: NSTR,
    shore: NSTR, spacingMm: NNUM, keepDays: NNUM, type: NSTR, floors: NNUM,
  }),
  conclusion: S.nul(S.obj({ text: S.str({ maxLength: 200 }), page: S.int({ minimum: 1, maximum: 2000 }) })),
  candidates: S.arr(S.obj({ kind: S.enm(['tower_crane', 'hoist', 'other']), note: S.str({ maxLength: 100 }) }), { maxItems: 20 }),
  notes: S.str({ maxLength: 2000 }),
});
export const STRUCT_KINDS = ['wall', 'slab', 'column', 'beam', 'footing', 'other'];
export const StructureScheduleExtract = S.obj({
  // floors: 같은 기호가 층마다 다를 때 층 범위 글자("1~5F", "6F~PH"), 없으면 빈 목록(43 지시서 2절)
  members: S.arr(S.obj({ mark: S.str({ maxLength: 20 }), kind: S.enm(STRUCT_KINDS), thicknessMm: NNUM, sizeMm: S.nul(S.arr(S.num(), { minItems: 2, maxItems: 2 })), floors: S.arr(S.str({ maxLength: 20 }), { maxItems: 10 }), note: S.str({ maxLength: 60 }) }), { maxItems: 300 }),
  planMarks: S.arr(S.obj({ mark: S.str({ maxLength: 20 }), pos: PX }), { maxItems: 3000 }),
  // 구조 평면의 통심 글자(X1·Y1 …)와 자리 — 건축 평면과 좌표를 맞추는 데 쓴다(43 지시서 3절). 없으면 빈 목록
  grid: S.arr(S.obj({ label: S.str({ maxLength: 6 }), pos: PX }), { maxItems: 200 }),
  notes: S.str({ maxLength: 2000 }),
});

export const EXTRACT_FOR = {
  site_plan: 'SitePlanExtract', elevation: 'LevelExtract', section: 'LevelExtract',
  floor_plan: 'FloorPlanExtract', facility_plan: 'FloorPlanExtract', unit_plan: 'UnitPlanExtract',
  finish_schedule: 'FinishScheduleExtract', wall_types: 'FinishScheduleExtract', window_schedule: 'WindowScheduleExtract',
  exterior_finish: 'ExteriorFinishExtract', color_plan: 'ExteriorFinishExtract',
  detail: 'ConstructionDetailExtract', structure: 'StructureScheduleExtract',
};
/** 시트 하나를 무엇으로 읽나: 단위세대 단면(타입만 있고 동이 없음)은 단면 상세, 나머지는 분류별 */
export function extractKindFor(sheet) {
  if (sheet?.category === 'section' && sheet.refs?.unitTypes?.length && !sheet.refs?.buildings?.length) return 'SectionDetailExtract';
  return EXTRACT_FOR[sheet?.category] || null;
}
// 입면은 레벨 말고 재료 구획도 읽는다. 지붕·조경·토목은 도형에서 규칙으로 읽고 분류만 AI가 한다(21 지시서 2·4절)
export const FACADE_FOR = { elevation: 'ElevationFacadeExtract' };
export const SCHEMAS = { SheetClassification, SitePlanExtract, LevelExtract, FloorPlanExtract, UnitPlanExtract, FinishScheduleExtract, WindowScheduleExtract, ReviewFindings, SheetTriage, DocClassification, DocExtract, ElevationFacadeExtract, ExteriorFinishExtract, SectionDetailExtract, ConstructionDetailExtract, StructureScheduleExtract, SpecRequirementExtract, TechReviewExtract };

// 구조화 출력이 받지 않는 제약(최소·최대·길이·개수)을 지운 사본. 결과는 원래 스키마로 다시 검사한다.
const DROP = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'pattern']);
export function apiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(apiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  // ['string', 'null'] 같은 형 묶음은 anyOf로(가장 보수적인 표현)
  if (Array.isArray(schema.type)) {
    const { type, enum: en, ...rest } = schema;
    return { anyOf: type.map((t) => (t === 'null' ? { type: 'null' } : apiSchema({ ...rest, type: t, ...(en ? { enum: en.filter((v) => v !== null) } : {}) }))) };
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP.has(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, apiSchema(s)])) : apiSchema(v);
  }
  return out;
}

// 픽셀 → 시트 좌표: 시트 그림은 시트 범위(frame)를 긴 변 width 픽셀로 그린 것(js/cad/render.js imageInfo와 같은 계산)
export function pixelToSheet(frame, px, py, maxSide = 2048) {
  const w = frame.x1 - frame.x0;
  const h = frame.y1 - frame.y0;
  const s = maxSide / Math.max(w, h);
  return [frame.x0 + px / s, frame.y1 - py / s];
}
export function sheetToPixel(frame, x, y, maxSide = 2048) {
  const s = maxSide / Math.max(frame.x1 - frame.x0, frame.y1 - frame.y0);
  return [(x - frame.x0) * s, (frame.y1 - y) * s];
}

// 추출 결과의 픽셀 위치(labelPos·pos)를 시트 좌표로 바꾼다
export function extractToSheet(data, frame) {
  const conv = (p) => (Array.isArray(p) && p.length === 2 ? pixelToSheet(frame, p[0], p[1]).map((v) => Math.round(v * 100) / 100) : p);
  const box = (b) => { if (!Array.isArray(b) || b.length !== 4) return b; const [x0, y1] = conv([b[0], b[1]]); const [x1, y0] = conv([b[2], b[3]]); return [x0, y0, x1, y1]; };
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = k === 'labelPos' || k === 'pos' ? conv(v) : k === 'box' ? box(v) : walk(v);
    return out;
  };
  return walk(data);
}
