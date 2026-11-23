// 부위 → 자재 종류 사전(42 지시서 4.1). materials-ko.js가 다시 내보낸다(import는 materials-ko.js에서).
// 큰 분류(category)는 그대로 두고, 세대에 들어가는 자재를 부위별 종류로 한 번 더 나눈다. 3D [재료] 거르기·단면 꼬리표·성적표가 같이 쓴다.
// 위에서부터 먼저 맞는 규칙. 사전에 없는 자재는 그 부위의 "기타(확인 필요)". 다른 파일을 import하지 않는다.

export const PART_KO = { floor: '바닥', wall: '벽', ceiling: '천장', opening: '창호', etc: '기타' };
export const PARTS = ['floor', 'wall', 'ceiling', 'opening', 'etc'];

export const MATERIAL_KINDS = [
  // 바닥
  { key: 'floor.cushion', part: 'floor', label: '층간소음 완충재', short: '완충재', color: '#F2B84B', re: /완충재|차음재|층간\s*소음/ },
  { key: 'floor.foam', part: 'floor', label: '경량기포콘크리트', short: '경량기포', color: '#D9D2C2', re: /경량\s*기포|기포\s*콘|기포/ },
  { key: 'floor.waterproof', part: 'floor', label: '바닥 방수(욕실·발코니)', short: '방수', color: '#4C9AFF', re: /방수/ },
  { key: 'floor.slab', part: 'floor', label: '구조 슬래브', short: '슬래브', color: '#B9BEC6', re: /슬래브|콘크리트|CONC|\bRC\b/i },
  { key: 'floor.screed', part: 'floor', label: '방바닥 미장(방통) 몰탈', short: '방통', color: '#CDBFA3', re: /방통|방바닥\s*미장|온돌|미장|몰탈|모르타르|MORTAR/i },
  { key: 'floor.base', part: 'floor', label: '걸레받이', short: '걸레받이', color: '#8A6B4E', re: /걸레받이/ },
  { key: 'floor.finish', part: 'floor', label: '바닥 마감(마루·장판·타일·석재)', short: '바닥 마감', color: '#C8A27A', re: /마루|장판|륨|타일|TILE|석재|대리석|인조석|화강석|데코|고무\s*바닥|카펫|에폭시|마감/i },
  // 벽
  { key: 'wall.alc', part: 'wall', label: 'ALC 블록', short: 'ALC', color: '#E3E0D6', re: /ALC|경량\s*기포\s*블록/i },
  { key: 'wall.concrete', part: 'wall', label: '구조벽 콘크리트', short: '콘크리트', color: '#B9BEC6', re: /콘크리트|CONC|\bRC\b/i },
  { key: 'wall.brick', part: 'wall', label: '조적(시멘트벽돌·블록)', short: '조적', color: '#B5654A', re: /벽돌|조적|블록|BLOCK|BRICK/i },
  { key: 'wall.stud', part: 'wall', label: '경량벽체(스터드·런너)', short: '경량벽체', color: '#A9B4C2', re: /스터드|STUD|런너|RUNNER|경량\s*(벽|철골)|건식\s*벽/i },
  { key: 'wall.board', part: 'wall', label: '석고보드', short: '석고보드', color: '#F4F4F0', re: /석고|GYPSUM|G\.?B\b/i },
  { key: 'wall.insulation', part: 'wall', label: '단열재(외단열·내단열)', short: '단열재', color: '#F2E27A', re: /단열|비드법|압출법|EPS|XPS|PF\s*보드|글라스\s*울|그라스울|미네랄\s*울|우레탄\s*폼/i },
  { key: 'wall.waterproof', part: 'wall', label: '벽 방수', short: '방수', color: '#4C9AFF', re: /방수/ },
  { key: 'wall.plaster', part: 'wall', label: '벽 미장', short: '미장', color: '#D8CBB0', re: /미장|몰탈|모르타르|MORTAR/i },
  { key: 'wall.finish', part: 'wall', label: '벽 마감(도배·타일·도장·필름)', short: '벽 마감', color: '#EDE6DA', re: /벽지|도배|타일|TILE|페인트|도장|PAINT|필름|시트지|마감|석재|대리석/i },
  // 천장
  { key: 'ceiling.frame', part: 'ceiling', label: '천장틀(M-BAR·목재)', short: '천장틀', color: '#8F9BAA', re: /천[장정]\s*틀|반자\s*틀|M-?BAR|캐링|각재|목재\s*틀|스터드/i },
  { key: 'ceiling.board', part: 'ceiling', label: '천장 석고보드', short: '석고보드', color: '#F4F4F0', re: /석고|GYPSUM/i },
  { key: 'ceiling.cornice', part: 'ceiling', label: '반자돌림', short: '반자돌림', color: '#D6CFC2', re: /반자\s*돌림|몰딩/ },
  { key: 'ceiling.finish', part: 'ceiling', label: '천장 마감(천장지·도장·SMC)', short: '천장 마감', color: '#F7F3EA', re: /천[장정]\s*지|벽지|도배|페인트|도장|SMC|텍스|천[장정]\s*재|마감/i },
  // 창호
  { key: 'opening.frame', part: 'opening', label: '창틀(PVC·AL)', short: '창틀', color: '#E9EDF2', re: /창틀|PVC|\bAL\b|알루미늄|샤시|새시/i },
  { key: 'opening.glass', part: 'opening', label: '유리', short: '유리', color: '#7FB2F0', re: /유리|GLASS|복층|삼중|로이|LOW-?E/i },
  { key: 'opening.doorFrame', part: 'opening', label: '문틀', short: '문틀', color: '#8A6B4E', re: /문틀/ },
  { key: 'opening.door', part: 'opening', label: '문(방화문·목문·욕실문)', short: '문', color: '#B58A5A', re: /문$|문\(|도어|DOOR|방화문|목문|ABS/i },
  // 기타(선택)
  { key: 'etc.closet', part: 'etc', label: '붙박이장', short: '붙박이장', color: '#C9B79A', re: /붙박이장|신발장|수납장/ },
  { key: 'etc.kitchen', part: 'etc', label: '주방 가구', short: '주방 가구', color: '#C9B79A', re: /주방\s*가구|싱크|상부장|하부장/ },
  { key: 'etc.sanitary', part: 'etc', label: '위생기구', short: '위생기구', color: '#DCE8F7', re: /위생|양변기|세면기|욕조/ },
  { key: 'etc.grille', part: 'etc', label: '실외기실 그릴', short: '그릴', color: '#9AA3AF', re: /그릴|루버|LOUVER/i },
];

const KIND_BY_KEY = new Map(MATERIAL_KINDS.map((k) => [k.key, k]));
export const otherKind = (part) => ({ key: `${part}.other`, part, label: '기타(확인 필요)', short: '기타', color: '#CCCCCC' });
export const kindInfo = (key) => KIND_BY_KEY.get(key) || otherKind(String(key).split('.')[0]);

/** 재료 이름 + 부위 → 자재 종류 키("floor.screed"). 사전에 없으면 "부위.other" */
export function materialKind(name, part) {
  const s = String(name || '');
  for (const k of MATERIAL_KINDS) if (k.part === part && k.re.test(s)) return k.key;
  return `${part}.other`;
}

// 해치 무늬 이름 → 재료 짐작(42 지시서 4.3). 설계사마다 달라 흔한 것만, 모르면 null
const HATCH_RULES = [[/AR-?CONC|CONC/i, '콘크리트'], [/AR-?SAND|SAND|MORTAR/i, '시멘트몰탈'], [/INSUL|BATT/i, '단열재'], [/BRICK|AR-?B\d|AR-?BRSTD/i, '시멘트벽돌'], [/ALC/i, 'ALC 블록'], [/WOOD|AR-?PARQ/i, '마루']];
export function hatchMaterial(pattern) {
  for (const [re, name] of HATCH_RULES) if (re.test(String(pattern || ''))) return name;
  return null;
}
