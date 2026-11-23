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
  // 개요·면적 산출·집계표·위치도·조감도도 "표지·목록·개요"로 모은다(모델에는 쓰지 않음)
  ['cover_index', /건축\s*개요|건설\s*개요|설계\s*개요|동별\s*개요|면적\s*(산출|표)|구적|집계표|위치도|조감도|투시도|토지\s*이용\s*계획|이미지/],
  // 설비 계통 낱말(배관·난방·위생·환기·소화 …)이 있으면 "단위세대 … 배관 평면도"라도 설비(45 지시서 6절). 건축 평면으로 읽으면 배관이 벽이 된다
  ['mep', /배관|난방|급수|급탕|오배수|위생\s*설비|환기\s*(설비|덕트)|덕트|가스\s*(설비|배관)|냉매|스프링클러|소화\s*(설비|배관)|소방\s*설비|기계\s*설비|전기\s*설비|전등|전열|약전|통신\s*설비/],
  // 부분 평면 상세·천장(천정)틀·전개도·계단 상세는 상세도(평면도보다 먼저)
  ['detail', /평면\s*상세도|부분\s*(평면\s*)?상세|천[장정]\s*틀|천[장정]\s*(평면|도)|전개도|주방\s*가구|신발장|욕실\s*상세|잡\s*상세|시공\s*한계|걸레받이|반자\s*돌림|방수\s*,?\s*단열|결로\s*(방지)?\s*평면|MC\s*중심선|중심선도/],
  // 단위세대 단면·창호 시공 상세는 평면·창호 일람보다 먼저(38 지시서)
  // "단위세대 부분단면도"를 세대 평면으로 읽어 세대 모양을 단면에서 만든 일이 있었다(공개 도서)
  ['section', /세대\s*(주\s*)?단면|주\s*단면도|부분\s*단면|(?<!평)단면\s*상세|UNIT\s*SECTION/i],
  ['detail', /창호\s*(시공|설치|단면)?\s*상세|평\s*단면\s*상세/],
  // 창호 일람표·창호도·형별 성능표는 "단위세대 창호일람표"처럼 단위세대가 붙어도 창호도
  ['window_schedule', /창호\s*(일람|표)|창호도|형별\s*성능/],
  ['site_plan', /배치도|SITE\s*PLAN/i],
  ['unit_plan', /단위\s*세대|세대\s*평면|세대\s*타입|UNIT\s*PLAN/i],
  ['landscape', /조경|식재|LANDSCAPE|PLANTING/i],
  ['civil_plan', /토목|정지\s*계획|GRADING/i],
  ['roof_plan', /(지붕|옥상|옥탑)\s*(층\s*)?평면|ROOF\s*PLAN/i],
  ['exterior_finish', /외부\s*마감|외장\s*재료|입면\s*재료|EXTERIOR\s*FINISH/i],
  ['color_plan', /색채\s*계획|COLOR\s*PLAN/i],
  ['facility_plan', /(주민\s*공동|커뮤니티|부대\s*복리|근린|관리동|경로당|어린이집|피트니스|보육|COMMUNITY|AMENITY).*(평면|PLAN)/i],
  // 기둥·보·슬래브·기초 일람표는 구조뿐이다(벽체 일람표는 건축 벽 종류표일 수 있어 아래 공종 글자로 가른다, 43 지시서 1절)
  ['structure', /(기둥|슬래브|기초|거더|(^|[^가-힣])보(?![가-힣])|보\s*일람|COLUMN|BEAM|GIRDER|SLAB|FOOTING).*(일람|리스트|LIST|SCHEDULE)/i],
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

// 동 번호: "101동", "101,102동"(여러 동), "101~103동"(범위, 20개까지)
function buildingRefs(s) {
  const out = [];
  for (const m of s.matchAll(/((?:\d{2,4}\s*[,，·~]\s*)*\d{2,4})\s*동/g)) {
    const parts = m[1].split(/\s*[,，·]\s*/);
    for (const p of parts) {
      const r = /^(\d{2,4})\s*~\s*(\d{2,4})$/.exec(p);
      if (r && Number(r[2]) > Number(r[1]) && Number(r[2]) - Number(r[1]) <= 20) for (let n = Number(r[1]); n <= Number(r[2]); n++) out.push(`${n}동`);
      else for (const n of p.split(/\s*~\s*/)) if (n) out.push(`${n}동`);
    }
  }
  return [...new Set(out)];
}

export function refsFromTitle(title, category) {
  const s = String(title || '');
  const buildings = buildingRefs(s);
  const unitTypes = [...new Set([...s.matchAll(/(?:^|[^\dA-Z])(\d{2,3}[A-Z]{1,2}\d?)(?![A-Z\d])/g)].map((m) => m[1]))];
  // "84㎡형", "84형", "(확장형)·(기본형)"(45 지시서 2.4): 타입과 기본형·확장형을 따로 잡는다
  const variant = /확장형/.test(s) ? '(확장형)' : /기본형/.test(s) ? '(기본형)' : '';
  for (const m of s.matchAll(/(?:^|[^\d.])(\d{2,3})(?:\.\d+)?\s*(?:㎡|m²|M2|m2)?\s*형/g)) unitTypes.push(`${m[1]}형${variant}`);
  const floors = [];
  if (/기준층/.test(s)) floors.push('기준층');
  for (const m of s.matchAll(/(지하\s*\d+|\d+(?:\s*~\s*\d+)?)\s*층/g)) if (!/동$/.test(m[0])) floors.push(`${m[1].replace(/\s/g, '')}층`);
  // "지하3층~지하1층": 범위 사이 층도(45 지시서 5.1)
  for (const m of s.matchAll(/지하\s*(\d+)\s*층?\s*~\s*지하\s*(\d+)\s*층/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    for (let k = Math.max(a, b) - 1; k > Math.min(a, b); k--) floors.push(`지하${k}층`);
  }
  for (const m of s.matchAll(/\b(B?\d{1,2}F(?:\s*~\s*\d{1,2}F)?|RF|PH)\b/g)) floors.push(m[1]);
  for (const m of s.matchAll(/최하층|최상층|옥탑|지붕/g)) floors.push(m[0]);
  let facility = null;
  if (category === 'facility_plan') facility = s.replace(/\s*(\d+\s*층|지하\s*\d+\s*층)?\s*(평면도|평면|PLAN).*$/i, '').trim() || null;
  return { buildings, unitTypes: [...new Set(unitTypes)], floors: [...new Set(floors)], facility };
}

// 도면명과 큰 제목의 대상을 합친다(45 지시서 2.2: 동·층·타입 찾기는 둘 다에서)
function mergeRefs(a, b) {
  const u = (x, y) => [...new Set([...(x || []), ...(y || [])])];
  return { buildings: u(a.buildings, b.buildings), unitTypes: u(a.unitTypes, b.unitTypes), floors: u(a.floors, b.floors), facility: a.facility || b.facility || null };
}

/**
 * @param {{ titleBlock: { sheetNo?: string|null, title?: string|null }, digest?: any }} sheet
 */
// 파일 이름에서 도면 종류(실제 도서는 "A-702 발코니상세도.dwg"처럼 파일 이름이 종류를 말해 주는 경우가 많다)
export function categoryFromFileName(name) {
  const s = String(name || '').replace(/\.(dxf|dwg)$/i, '').replace(/_?(수정|교체|최종)\d*|\[[^\]]*\]|\d{6,8}/g, ' ');
  for (const [cat, re] of KEYWORDS) if (re.test(s)) return cat;
  return null;
}

// 도면명에 도면 종류 낱말(…도, …표)이 없으면 "단위세대", "101동"처럼 무엇을 그린 것인지만 말하는 것이다
const TYPE_WORD = /(평면|입면|단면|배치|상세|정면|배면|측면|전개|구조|창호|마감|일람|목록|개요|계획|산출)\s*(도|표)|도면|PLAN|ELEVATION|SECTION|DETAIL|SCHEDULE/i;

// ---- 구조 도면 가르기(43 지시서 1절). 순수 함수
// 공종 글자: 도면번호·파일 이름 맨 앞(A 건축, S 구조, M 기계, E 전기, L 조경, C 토목 …). "B1F"·"SITE" 같은 것은 공종이 아니다
const TRADE = /^(A|AR|S|ST|M[AHPGDCER]?|E|EL|P|FP|L|LA|C|CV|T|ID)\s*-?\s*\d/;
// 설비 공종 글자(기계는 MA·MH·MP·MG처럼 세부 계통 글자를 붙인다). 이 글자의 평면은 건축 평면이 아니라 설비 평면이다
const MEP_TRADE = /^(M[AHPGDCER]?|E|EL|P|FP|T)$/;
const PLAN_LIKE = new Set(['floor_plan', 'unit_plan', 'roof_plan', 'site_plan', 'facility_plan', 'unknown']);
const baseName = (f) => String(f || '').split(/[\\/]/).pop().trim();
export function tradeOf(v) {
  const m = TRADE.exec(String(v || '').trim().toUpperCase());
  return m ? m[1] : null;
}
// 배근 글자(HD13, D10, 4-HD22, SHD16@200 …): 철근 지름만(10~35). 문 기호 WD10·SD1 같은 것은 앞 글자가 붙어 있어 안 맞는다
export const REBAR_TEXT = /(^|[^A-Z])(S?HD|D)(10|13|16|19|22|25|29|32|35)(?!\d)/;
export function rebarCount(texts = []) {
  let n = 0;
  for (const t of texts) if (REBAR_TEXT.test(String(t?.t ?? t ?? '').toUpperCase().replace(/\s+/g, ''))) n++;
  return n;
}
/** 배근 글자가 빽빽한 시트(10개 이상이고 글자의 5% 이상): 구조 일람표·배근도. 건축 벽 종류표에는 철근 지름 글자가 거의 없다 */
export const rebarDense = (texts = []) => { const r = rebarCount(texts); return r >= 10 && r / Math.max(1, texts.length) >= 0.05; };

/**
 * 이 시트가 구조 도면인지(공종 글자가 우선, 없으면 배근 글자 밀도). 다른 공종 글자(A·M …)가 있으면 구조가 아니다
 * @returns {'sheetNo'|'file'|'rebar'|null}
 */
export function structureSignal({ sheetNo = '', fileName = '', texts = [] } = {}) {
  const no = tradeOf(sheetNo);
  if (no) return no[0] === 'S' ? 'sheetNo' : null;
  const f = tradeOf(baseName(fileName));
  if (f) return f[0] === 'S' ? 'file' : null;
  return rebarDense(texts) ? 'rebar' : null;
}

/**
 * 묶음 판단: 공종 글자가 있는 시트의 60% 이상이 S면 구조 묶음. 공종 글자가 하나도 없으면 "구조일반사항·구조평면" 시트가 있을 때.
 * @param {{ sheetNo?: string, file?: string, title?: string }[]} list
 */
export function isStructureBundle(list = []) {
  let s = 0;
  let other = 0;
  for (const x of list) {
    const t = tradeOf(x.sheetNo) || tradeOf(baseName(x.file));
    if (!t) continue;
    if (t[0] === 'S') s++; else other++;
  }
  if (s + other) return s / (s + other) >= 0.6;
  return list.some((x) => /구조\s*일반\s*사항|구조\s*평면/.test(x.title || ''));
}

/**
 * 구조 묶음이면, 공종 글자가 없어 시트 하나로는 못 가른 시트(표지·목록·구조·사람이 고친 것 빼고)를 구조로 바꿀 목록
 * @param {{ id: string, sheetNo?: string, file?: string, title?: string, category: string, manual?: boolean }[]} list
 * @returns {string[]} id 목록
 */
export function structureBundleFlips(list = []) {
  if (!isStructureBundle(list)) return [];
  return list.filter((x) => !x.manual && !['structure', 'cover_index'].includes(x.category) && !tradeOf(x.sheetNo) && !tradeOf(baseName(x.file))).map((x) => x.id);
}

// 구조 문맥(도면번호·파일 이름이 S, 또는 구조 묶음)에서는 표지·목록 말고 모두 구조다: 건축 평면·단면·상세 판독에 구조 도면이 섞이지 않게.
// 배근 글자 밀도로만 정해진 시트는 일람표·벽 종류·상세·모름일 때만 바꾼다(건축 평면은 그대로)
const REBAR_FLIP = new Set(['wall_types', 'detail', 'section', 'unknown']);

export function classifyByRule({ titleBlock = {}, digest = null, bundle = null } = {}) {
  const title = titleBlock.title || '';
  const caption = titleBlock.caption && titleBlock.caption !== title ? titleBlock.caption : '';
  let category = null;
  let confidence = 0;
  for (const [cat, re] of KEYWORDS) if (re.test(title)) { category = cat; confidence = 0.7; break; }
  // 도면명으로 못 정했거나 큰 제목이 설비를 말하면 큰 제목으로
  for (const [cat, re] of KEYWORDS) if (caption && re.test(caption)) { if (!category || (cat === 'mep' && PLAN_LIKE.has(category))) { category = cat; confidence = 0.6; } break; }
  // 파일 이름: 도면명으로 못 정했거나, 도면명에 종류 낱말이 없을 때
  const byFile = categoryFromFileName(digest?.file);
  if (byFile && (!category || (!TYPE_WORD.test(title) && byFile !== category))) { category = byFile; confidence = 0.5; }
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
  // 설비 공종 글자(M·MH·E …)의 평면은 설비
  if (PLAN_LIKE.has(category) && MEP_TRADE.test(tradeOf(titleBlock.sheetNo) || '')) { category = 'mep'; confidence = Math.max(confidence, 0.5); }
  if (category !== 'structure' && category !== 'cover_index') {
    let sig = structureSignal({ sheetNo: titleBlock.sheetNo, fileName: digest?.file, texts: digest?.texts || [] });
    if (!sig && bundle === 'structure' && !tradeOf(titleBlock.sheetNo) && !tradeOf(baseName(digest?.file))) sig = 'bundle';
    if (sig && (sig !== 'rebar' || REBAR_FLIP.has(category))) { category = 'structure'; confidence = Math.min(Math.max(confidence, 0.4), 0.6); }
  }
  return { category, confidence, refs: caption ? mergeRefs(refsFromTitle(title, category), refsFromTitle(caption, category)) : refsFromTitle(title, category), method: 'rule' };
}
