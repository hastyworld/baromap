// 규칙으로 시트 분류(AI 없이 항상 동작): 표제란 도면명 키워드 → 없으면 도면번호 체계. 순수 함수.
// 결과는 신뢰도를 낮게 두고(method: 'rule') AI 판독이 있으면 덮어쓴다.

export const CATEGORIES = ['site_plan', 'floor_plan', 'unit_plan', 'elevation', 'section', 'facility_plan', 'finish_schedule', 'wall_types', 'window_schedule', 'detail', 'cover_index', 'structure', 'mep', 'landscape', 'unknown'];
export const CATEGORY_LABEL = {
  site_plan: '배치도', floor_plan: '평면도', unit_plan: '단위세대', elevation: '입면도', section: '단면도', facility_plan: '커뮤니티 평면',
  finish_schedule: '마감표', wall_types: '벽체 상세', window_schedule: '창호도', detail: '상세도', cover_index: '표지·목록',
  structure: '구조', mep: '설비·전기', landscape: '조경', unknown: '모름',
  roof_plan: '지붕 평면', exterior_finish: '외부 마감표', color_plan: '색채계획도', civil_plan: '토목·정지', landscape_plan: '조경 평면',
};

// 순서가 중요하다(위에서 먼저 맞는 것)
const KEYWORDS = [
  ['cover_index', /표지|도면\s*목록|도서\s*목록|INDEX|COVER/i],
  // 단위세대 단면·창호 시공 상세는 평면·창호 일람보다 먼저(38 지시서)
  ['section', /세대\s*단면|단면\s*상세|UNIT\s*SECTION/i],
  ['detail', /창호\s*(시공|설치|단면)?\s*상세/],
  ['site_plan', /배치도|SITE\s*PLAN/i],
  ['unit_plan', /단위\s*세대|세대\s*평면|세대\s*타입|UNIT\s*PLAN/i],
  ['landscape', /조경|식재|LANDSCAPE|PLANTING/i],
  ['civil_plan', /토목|정지\s*계획|GRADING/i],
  ['roof_plan', /(지붕|옥상|옥탑)\s*(층\s*)?평면|ROOF\s*PLAN/i],
  ['exterior_finish', /외부\s*마감|외장\s*재료|입면\s*재료|EXTERIOR\s*FINISH/i],
  ['color_plan', /색채\s*계획|COLOR\s*PLAN/i],
  ['facility_plan', /(주민\s*공동|커뮤니티|부대\s*복리|근린|관리동|경로당|어린이집|피트니스|보육|COMMUNITY|AMENITY).*(평면|PLAN)/i],
  ['wall_types', /벽체.*(상세|구성|일람|타입)|WALL\s*TYPE/i],
  ['finish_schedule', /마감\s*표|재료\s*마감|마감\s*일람|FINISH(ING)?\s*SCHEDULE/i],
  ['window_schedule', /창호\s*(일람|도|표|상세)|창호도|WINDOW|DOOR\s*SCHEDULE/i],
  ['elevation', /입면|정면도|배면도|측면도|ELEVATION/i],
  ['section', /단면도|단면\s*상세|SECTION/i],
  ['structure', /구조\s*(평면|도|일반)|STRUCT/i],
  ['mep', /설비|전기|기계|소방|통신|위생|MEP|ELEC|MECH|PLUMB/i],
  ['floor_plan', /평면도|평면|PLAN/i],
  ['detail', /상세|DETAIL/i],
];

// 한국 도서 관례(설계사마다 다를 수 있어 신뢰도를 더 낮게)
function byNumber(no) {
  const m = /^([A-Z]{1,3})-?(\d)(\d{1,3})/.exec(String(no || '').toUpperCase());
  if (!m) return null;
  const [, prefix, d] = m;
  if (prefix.startsWith('S')) return 'structure';
  if (/^(M|E|P|FP|T)$/.test(prefix)) return 'mep';
  if (prefix === 'L' || prefix === 'LA') return 'landscape';
  if (!prefix.startsWith('A')) return null;
  return { 0: 'site_plan', 1: 'floor_plan', 2: 'elevation', 3: 'section', 4: 'unit_plan', 5: 'detail', 6: 'finish_schedule' }[d] || null;
}

export function refsFromTitle(title, category) {
  const s = String(title || '');
  const buildings = [...new Set([...s.matchAll(/(\d{2,4})\s*동/g)].map((m) => `${m[1]}동`))];
  const unitTypes = [...new Set([...s.matchAll(/(?:^|[^\dA-Z])(\d{2,3}[A-Z]{1,2}\d?)(?![A-Z\d])/g)].map((m) => m[1]))];
  const floors = [];
  if (/기준층/.test(s)) floors.push('기준층');
  for (const m of s.matchAll(/(지하\s*\d+|\d+(?:\s*~\s*\d+)?)\s*층/g)) if (!/동$/.test(m[0])) floors.push(`${m[1].replace(/\s/g, '')}층`);
  for (const m of s.matchAll(/\b(B?\d{1,2}F(?:\s*~\s*\d{1,2}F)?|RF|PH)\b/g)) floors.push(m[1]);
  if (/최상층|옥탑|지붕/.test(s)) floors.push(s.match(/최상층|옥탑|지붕/)[0]);
  let facility = null;
  if (category === 'facility_plan') facility = s.replace(/\s*(\d+\s*층|지하\s*\d+\s*층)?\s*(평면도|평면|PLAN).*$/i, '').trim() || null;
  return { buildings, unitTypes, floors: [...new Set(floors)], facility };
}

/**
 * @param {{ titleBlock: { sheetNo?: string|null, title?: string|null }, digest?: any }} sheet
 */
export function classifyByRule({ titleBlock = {}, digest = null } = {}) {
  const title = titleBlock.title || '';
  let category = null;
  let confidence = 0;
  for (const [cat, re] of KEYWORDS) if (re.test(title)) { category = cat; confidence = 0.7; break; }
  if (!category) {
    const c = byNumber(titleBlock.sheetNo);
    if (c) { category = c; confidence = 0.4; }
  }
  if (!category && digest) {
    // 표제란이 없으면 많이 쓰인 해치·레이어로 짐작
    const layers = (digest.layers || []).map((l) => l.name).join(' ');
    if (/L-PLNT|조경/.test(layers)) { category = 'landscape'; confidence = 0.3; }
  }
  category ||= 'unknown';
  return { category, confidence, refs: refsFromTitle(title, category), method: 'rule' };
}
