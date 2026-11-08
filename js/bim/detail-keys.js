// 시공 상세 값의 키 목록(38 지시서 2절) — 한 곳에 둔다. 모델 catalog.details·AI 스키마(enum)·화면·성적표가 같이 쓴다.
// unit: 'mm' 숫자 / 'text' 글자. 값이 도면에 없으면 상세 값 표에 넣지 않는다(기본값은 화면·렌더에서만, assumed 표시).

export const DETAIL_KEYS = [
  { key: 'windowRevealMm', label: '창호 들어간 깊이', unit: 'mm', group: 'window' },
  { key: 'windowFramePos', label: '창틀 위치', unit: 'text', group: 'window' },
  { key: 'sillHeightMm', label: '창대 높이', unit: 'mm', group: 'window' },
  { key: 'sillProjectionMm', label: '창대 돌출', unit: 'mm', group: 'window' },
  { key: 'curtainBoxMm', label: '커튼박스 깊이', unit: 'mm', group: 'window' },
  { key: 'railingHeightMm', label: '난간 높이', unit: 'mm', group: 'railing' },
  { key: 'railingBarGapMm', label: '난간 살 간격', unit: 'mm', group: 'railing' },
  { key: 'railingType', label: '난간 형식', unit: 'text', group: 'railing' },
  { key: 'parapetMm', label: '파라펫 높이', unit: 'mm', group: 'roof' },
  { key: 'copingMm', label: '두겁 폭', unit: 'mm', group: 'roof' },
  { key: 'roofInsulationMm', label: '지붕 단열 두께', unit: 'mm', group: 'roof' },
  { key: 'roofSlopePct', label: '지붕 물매', unit: 'text', group: 'roof' },
  { key: 'exteriorInsulationMm', label: '외단열 두께', unit: 'mm', group: 'wall' },
  { key: 'interiorInsulationMm', label: '내단열 두께', unit: 'mm', group: 'wall' },
  { key: 'waterproofUpturnMm', label: '방수 치켜올림', unit: 'mm', group: 'wall' },
  { key: 'panelJointMm', label: '줄눈 폭', unit: 'mm', group: 'wall' },
  { key: 'louverType', label: '실외기 루버 형식', unit: 'text', group: 'wall' },
  { key: 'balconyStepMm', label: '발코니 단차', unit: 'mm', group: 'floor' },
  { key: 'doorSillMm', label: '문턱 높이', unit: 'mm', group: 'floor' },
  { key: 'other', label: '기타', unit: 'text', group: 'other' },
];
export const DETAIL_KEY_NAMES = DETAIL_KEYS.map((k) => k.key);
export const detailKey = (key) => DETAIL_KEYS.find((k) => k.key === key) || null;
export const detailLabel = (key) => detailKey(key)?.label || key;

// 적용 부위(appliesTo.zones) 한국어
export const ZONE_KO = { roof: '지붕', wall: '외벽', base: '저층부', pilotis: '필로티' };
export const scopeText = (a = {}) => [...(a.typeCodes || []), ...(a.rooms || []), ...(a.zones || []).map((z) => ZONE_KO[z] || z), ...(a.buildings || [])].join('·');

/** 상세 값 한 줄 → 사람이 읽는 글: "창호 들어간 깊이 150mm (AW1·AW2)" */
export function detailText(d) {
  const k = detailKey(d.key);
  const v = k?.unit === 'mm' && typeof d.value === 'number' ? `${d.value.toLocaleString()}mm` : String(d.value ?? '');
  const scope = scopeText(d.appliesTo);
  return `${d.key === 'other' && d.note ? d.note : detailLabel(d.key)} ${v}${scope ? ` (${scope})` : ''}`;
}
