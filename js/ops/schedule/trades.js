// 공정표 공종 이름 → 바로맵 표준 공종(28 지시서 4절 "규칙"). 회사 사전(schedule_dict)이 이 표보다 먼저다.
// 겹치면 가장 긴 낱말이 이긴다('비계해체' > '비계', '콘크리트포장' > '콘크리트'). zone은 위치가 안 적혀도 정해지는 공종의 구역.
// 표현 단계(3D 모습)는 js/bim/stage-map.js가 이 이름으로 정한다.

export const TRADES = [
  { name: '가설', zone: 'site', words: ['가설', '가설공사', '가설울타리', '가설사무실', '현장사무실', '게이트', '준비공', '공사준비', '착공'] },
  { name: '흙막이', zone: 'underground', words: ['흙막이', 'CIP', 'SCW', 'H-PILE', 'H파일', '어스앵커', '스트러트', '토류벽'] },
  { name: '토공', zone: 'underground', words: ['토공', '터파기', '굴착', '잔토', '되메우기', '토공사'] },
  { name: '기초', zone: '', words: ['기초', '파일', 'PHC', '매트기초', '버림콘크리트', '기초공사'] },
  { name: '골조', zone: '', words: ['골조', 'RC', '철근콘크리트', '구체', '콘크리트', '형틀', '철근', '골조공사', '지하골조', '지상골조'] },
  { name: '양중', zone: 'site', words: ['타워크레인', 'T/C', '호이스트', '양중', '리프트카'] },
  { name: '외부비계', zone: '', words: ['비계', '외부비계', '시스템비계', '비계설치', '낙하물방지망', '방호선반'] },
  { name: '비계해체', zone: '', words: ['비계해체', '비계철거'] },
  { name: '창호', zone: '', words: ['창호', '샤시', '새시', '알루미늄창호', 'PVC창호', '창호공사', '유리공사'] },
  { name: '외부도장', zone: '', words: ['외부도장', '외벽도장', '외장도장', '도장', '도장공사'] },
  { name: '외장', zone: '', words: ['외장', '석공사', '석재', '커튼월', '외벽마감', '외부마감', '외장공사'] },
  { name: '방수', zone: '', words: ['방수', '방수공사'] },
  { name: '내장', zone: '', words: ['내장', '세대마감', '수장', '도배', '마루', '타일', '가구', '내부마감', '내장공사', '내부도장', '실내건축'] },
  { name: '설비', zone: '', words: ['기계설비', '설비', '배관', '위생', '소방설비', '설비공사'] },
  { name: '전기', zone: '', words: ['전기', '통신', '소방전기', '전기공사'] },
  { name: '조경', zone: 'site', words: ['조경', '식재', '수목', '잔디', '조경공사'] },
  { name: '포장', zone: 'site', words: ['포장', '보도블록', '아스팔트', '도로포장', '콘크리트포장', '부대토목', '포장공사'] },
  { name: '준공', zone: 'site', words: ['준공', '사용검사', '준공검사', '입주점검', '준공청소', '사용승인'] },
];
export const TRADE_NAMES = TRADES.map((t) => t.name);

const squash = (s) => String(s ?? '').toUpperCase().replace(/[\s·_()[\]]/g, '');

/** 이름에서 공종 찾기 → { trade, word } 또는 null. extra: 현장 골구도 공종 이름(그대로 같으면 그 이름) */
export function tradeFromText(text, extra = []) {
  const s = squash(text);
  if (!s) return null;
  let best = null;
  for (const name of extra) {
    const w = squash(name);
    if (w.length >= 2 && s.includes(w) && (!best || w.length > best.word.length)) best = { trade: name, word: w };
  }
  for (const t of TRADES) for (const word of t.words) {
    const w = squash(word);
    if (s.includes(w) && (!best || w.length > best.word.length)) best = { trade: t.name, word: w };
  }
  return best;
}

/** 공종 이름이 표준 이름이 아니면 표준으로(파일에 'RC공사'라고 적힌 경우) */
export function canonicalTrade(name, extra = []) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  if (TRADE_NAMES.includes(s) || extra.includes(s)) return s;
  return tradeFromText(s, extra)?.trade || s;
}

export const tradeZone = (trade) => TRADES.find((t) => t.name === trade)?.zone || '';
