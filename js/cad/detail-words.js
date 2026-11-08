// 시공 상세도 글자 → 상세 값 키 사전(38 지시서 4절 규칙). 앞에 있을수록 먼저 본다(긴 말이 앞).
// 현장에서 다른 표현이 나오면 여기에 더한다. 키 목록은 js/bim/detail-keys.js.

export const DETAIL_WORDS = [
  ['windowRevealMm', /창호?\s*(들어간|설치)\s*깊이|창\s*깊이|REVEAL/i],
  ['windowFramePos', /창틀\s*위치|창호\s*위치/],
  ['sillProjectionMm', /창대\s*(돌출|내밀기)/],
  ['sillHeightMm', /창대\s*높이|창\s*하단\s*높이/],
  ['curtainBoxMm', /커튼\s*박스/],
  ['railingBarGapMm', /난간\s*살\s*(간격|사이)|살\s*간격/],
  ['railingType', /난간\s*(형식|종류)/],
  ['railingHeightMm', /난간\s*높이|난간\s*H/],
  ['parapetMm', /파라펫\s*높이|파라펫\s*H/],
  ['copingMm', /두겁\s*(폭|너비)/],
  ['roofInsulationMm', /지붕\s*단열/],
  ['roofSlopePct', /물매|구배/],
  ['exteriorInsulationMm', /외단열/],
  ['interiorInsulationMm', /내단열/],
  ['waterproofUpturnMm', /방수\s*(치켜\s*올림|턱|立上|올림)/],
  ['panelJointMm', /줄눈\s*(폭|너비)/],
  ['louverType', /루버\s*(형식|종류)?/],
  ['balconyStepMm', /발코니\s*단차|단차/],
  ['doorSillMm', /문턱\s*높이|문턱/],
];

/** 글자 하나 → { key, value, rest } 또는 null. "난간 높이 1,200" → { key: 'railingHeightMm', value: 1200 } */
export function detailFromText(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  for (const [key, re] of DETAIL_WORDS) {
    const m = re.exec(s);
    if (!m) continue;
    const rest = s.slice(m.index + m[0].length).replace(/^[\s:=：]+/, '').replace(/^(?:(?:두께|높이|폭|너비|간격|깊이|H|THK\.?)\s*[:=：]?\s*)+/i, '');
    const num = /^([\d,]+(?:\.\d+)?)\s*(mm|㎜)?/i.exec(rest) || /([\d,]+(?:\.\d+)?)\s*(mm|㎜)\s*$/i.exec(s);
    if (key.endsWith('Mm')) {
      if (!num) return { key, value: null, rest };
      return { key, value: Number(num[1].replace(/,/g, '')), rest };
    }
    return { key, value: rest.slice(0, 40) || null, rest };
  }
  return null;
}
