// 도면 목록을 가볍게(46 지시서 3절, 순수 함수): 많으면 나눠 그리기, 신뢰도를 모르면 표 숨김.

// 200장이 넘으면 처음 60장, 끝에 닿을 때마다 60장씩 더
export const LIST_CHUNK = { over: 200, first: 60, step: 60 };

/** 지금 그릴 장수. limit은 지금까지 그린 장수(처음이면 0) */
export function listLimit(total, limit = 0) {
  if (total <= LIST_CHUNK.over) return total;
  return Math.min(total, Math.max(limit, LIST_CHUNK.first));
}

/** 끝에 닿았을 때 다음 장수 */
export const nextLimit = (total, limit) => Math.min(total, Math.max(limit, LIST_CHUNK.first) + LIST_CHUNK.step);

// 신뢰도 표를 보일지: 사람·AI가 정했거나 규칙 신뢰도 값이 있을 때만(값이 없거나 0인 규칙 분류는 '모름'이라 숨긴다)
export const confKnown = (s) => Boolean(s?.meta?.manual || s?.meta?.source === 'ai' || (Number(s?.confidence) > 0));
