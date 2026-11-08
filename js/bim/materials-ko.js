// 재료 사전: 한국 도면의 재료 이름 → 분류(category)·정규화한 이름·색·골구도 공종 열쇠(trades).
// "THK100 비드법단열재 2종1호" → { name: '단열재(비드법 2종)', category: 'insulation', thicknessMm: 100 }

const RULES = [
  // [이름 패턴, 분류, 정규화 이름(없으면 원래 이름), 공종]
  [/경량\s*기포|기포\s*콘크리트|기포\s*콘/i, 'plaster', '경량기포콘크리트', ['미장']], // 바닥 채움층(구조체 아님)
  [/완충재|차음재|층간\s*소음/i, 'insulation', '완충재', ['단열']],
  [/철근\s*콘크리트|콘크리트|CONC|RC\b/i, 'structure', '콘크리트', ['골조']],
  [/경량\s*(철골|스터드)|스터드|STUD|런너|M-?BAR/i, 'lightweight', '경량스터드', ['경량']],
  [/ALC|시멘트\s*벽돌|벽돌|조적|블록|BLOCK/i, 'masonry', null, ['조적']],
  [/비드법|EPS/i, 'insulation', '단열재(비드법)', ['단열']],
  [/압출법|XPS/i, 'insulation', '단열재(압출법)', ['단열']],
  [/글라스\s*울|그라스울|미네랄\s*울|PF\s*보드|우레탄|단열/i, 'insulation', null, ['단열']],
  [/방습\s*석고|방수\s*석고|방화\s*석고|석고\s*보드|GYPSUM|G\.?B\b/i, 'board', null, ['경량', '석고보드']],
  [/액체\s*방수|도막\s*방수|시트\s*방수|우레탄\s*방수|방수/i, 'waterproof', null, ['방수']],
  [/미장|몰탈|모르타르|MORTAR/i, 'plaster', null, ['미장']],
  [/도기질\s*타일|자기질\s*타일|타일|TILE/i, 'finish', null, ['타일']],
  [/실크\s*벽지|합지\s*벽지|벽지|도배/i, 'finish', null, ['도배']],
  [/페인트|도장|PAINT/i, 'finish', null, ['도장']],
  [/강마루|강화마루|마루|데코\s*타일|장판|고무\s*바닥|인조석|대리석|석재/i, 'finish', null, ['마루', '바닥']],
  [/MDF|걸레받이/i, 'finish', null, ['걸레받이']],
  [/흡음\s*텍스|텍스|천장재/i, 'finish', null, ['천장']],
];

export const CATEGORY_COLOR = {
  structure: '#B9BEC6', masonry: '#B5654A', insulation: '#F2E27A', plaster: '#D8CBB0', board: '#F4F4F0',
  lightweight: '#A9B4C2', finish: '#EDE6DA', waterproof: '#4C9AFF', other: '#CCCCCC',
};
export const CATEGORY_LABEL = {
  structure: '구조체', masonry: '조적(블록·벽돌)', insulation: '단열재', plaster: '미장', board: '석고보드',
  lightweight: '경량 스터드', finish: '마감', waterproof: '방수', other: '기타',
};
// 마감 중 따로 보이게 할 색(타일·도배·마루)
const FINISH_COLOR = [[/타일/, '#CFE3EC'], [/벽지|도배/, '#EDE6DA'], [/마루|데코/, '#C8A27A'], [/페인트|도장/, '#F7F3EA'], [/인조석|석재|대리석/, '#D9D5CC']];

/**
 * 재료 이름 하나(두께가 섞여 있어도 됨) → { name, category, thicknessMm, color, trades }
 */
export function material(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  let thicknessMm = null;
  const t = /(?:THK|T|두께)?\s*(\d+(?:\.\d+)?)\s*(?:mm|㎜|T)?\s*$/i.exec(s) || /^(?:THK|T)\s*(\d+(?:\.\d+)?)\s*/i.exec(s);
  if (t) {
    thicknessMm = Number(t[1]);
    s = s.replace(t[0], '').trim();
  }
  s = s.replace(/\s*\d+\s*종\s*\d*\s*호?/, (m) => ` ${m.trim()}`).replace(/\s+/g, ' ').trim();
  let category = 'other';
  let name = s;
  let trades = [];
  for (const [re, cat, norm, tr] of RULES) {
    if (re.test(s)) {
      category = cat;
      trades = tr;
      if (norm) {
        const grade = /(\d)\s*종/.exec(s);
        name = norm === '단열재(비드법)' && grade ? `단열재(비드법 ${grade[1]}종)` : norm;
      }
      break;
    }
  }
  let color = CATEGORY_COLOR[category];
  if (category === 'finish') for (const [re, c] of FINISH_COLOR) if (re.test(name)) { color = c; break; }
  return { name: name || String(raw || '').trim(), category, thicknessMm, color, trades };
}

/** "콘크리트 200 + 비드법단열재 2종 100 + 석고보드 9.5 + 실크벽지 0.5" → 층 목록(순서 그대로) */
export function parseComposition(text) {
  return String(text || '').split(/\s*[+＋,/]\s*|\s*→\s*/).map((x) => x.trim()).filter(Boolean).map((part) => {
    const m = material(part);
    return { material: m.name, category: m.category, thicknessMm: m.thicknessMm };
  });
}

// 이름이 같은 재료에 같은 id를 붙인다(카탈로그)
export function materialId(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `mt_${h.toString(36)}`;
}
