// 상태 흐름(순수 함수). DB 트리거(supabase/schema.sql)와 같은 규칙을 데모 모드·화면 안내에 쓴다. 최종 판단은 공유 모드에서 트리거가 한다.

export const DAILY_STATUS = ['draft', 'submitted', 'reviewed', 'approved', 'returned', 'cancelled'];
export const DAILY_LABEL = { draft: '작성 중', submitted: '제출', reviewed: '검토', approved: '승인', returned: '반려', cancelled: '취소' };

const DAILY_NEXT = {
  draft: ['submitted', 'cancelled'],
  submitted: ['reviewed', 'approved', 'returned', 'draft', 'cancelled'],
  reviewed: ['approved', 'returned', 'cancelled'],
  returned: ['submitted', 'draft', 'cancelled'],
  approved: [],
  cancelled: ['draft'],
};

export class FlowError extends Error {}
const deny = (msg) => { throw new FlowError(msg); };

/**
 * 일보 상태 바꾸기: 바뀔 필드를 돌려준다.
 * @param {any} row 지금 일보
 * @param {'draft'|'submitted'|'reviewed'|'approved'|'returned'|'cancelled'} to
 * @param {{ me: { id: string, role: string, name?: string, email?: string }, steps?: number, note?: string, at?: string }} o
 */
export function dailyTransition(row, to, { me, steps = 1, note = '', at = new Date().toISOString() }) {
  const admin = me?.role === 'admin';
  const from = row.status || 'draft';
  if (from === to) return {};
  if (from === 'approved' && !admin) deny('승인된 일보는 운영자만 고칠 수 있습니다.');
  if (!admin && !DAILY_NEXT[from]?.includes(to)) deny(`${DAILY_LABEL[from]} 상태에서는 ${DAILY_LABEL[to]}(으)로 바꿀 수 없습니다.`);
  if (to === 'approved' && steps >= 2 && from === 'submitted' && !admin) deny('이 현장은 검토를 거쳐야 승인할 수 있습니다.');
  if ((to === 'approved' || to === 'reviewed') && !admin && row.submittedBy === me?.id) deny('제출한 사람이 아닌 다른 담당자가 결재해야 합니다.');
  if (to === 'returned' && !String(note).trim()) deny('반려 사유를 입력해주세요.');
  const who = { name: me?.name || me?.email || '', at };
  const signs = { ...(row.signs || {}) };
  const patch = { status: to, signs };
  if (to === 'submitted') {
    Object.assign(patch, { submittedBy: me?.id, submittedAt: at, returnNote: '' });
    signs.submitted = who;
    delete signs.reviewed;
    delete signs.approved;
  } else if (to === 'reviewed') {
    Object.assign(patch, { reviewedBy: me?.id, reviewedAt: at });
    signs.reviewed = who;
  } else if (to === 'approved') {
    Object.assign(patch, { approvedBy: me?.id, approvedAt: at });
    signs.approved = who;
  } else if (to === 'returned') {
    patch.returnNote = String(note).trim().slice(0, 500);
  }
  return patch;
}

// 이 사람이 지금 누를 수 있는 결재 단추(화면 안내용)
export function dailyActions(row, { me, steps = 1, canEdit = false }) {
  if (!canEdit) return [];
  const admin = me?.role === 'admin';
  const s = row.status || 'draft';
  const mine = row.submittedBy === me?.id;
  if (s === 'draft' || s === 'returned') return ['submit'];
  if (s === 'submitted') {
    if (mine && !admin) return ['recall'];
    return steps >= 2 && !admin ? ['review', 'return'] : ['approve', 'return'];
  }
  if (s === 'reviewed') return mine && !admin ? [] : ['approve', 'return'];
  if (s === 'approved') return admin ? ['reopen'] : [];
  return [];
}
