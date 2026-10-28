// 관리자 화면: 사용자·권한 관리(승인, 현장 담당 배정), 수정 기록
import { store, state, q, ROLE_LABEL } from './ctx.js';
import { esc, icon, onAction, openModal, toast } from './util.js';

const FIELD_LABEL = {
  name: '이름', address: '주소', lat: '위치', lng: '위치', client: '발주처', overview: '공사 개요', startDate: '착공일', endDate: '준공 예정일',
  manager: '현장소장', phone: '연락처', memo: '메모', siteId: '현장', addressDetail: '동·호수', type: '유형', capacity: '정원',
  leaseEnd: '계약 종료일', lodgingId: '숙소', rank: '직급', title: '직책', dept: '소속·공종', moveIn: '입주일',
};
const TABLE_LABEL = { sites: '현장', lodgings: '숙소', residents: '거주자', site_photos: '현장 사진' };
const ACTION_LABEL = { insert: '등록', update: '수정', delete: '삭제' };

const SITE_ROLES = ['manager', 'viewer']; // 현장을 배정받는 권한

let users = [];

export async function pendingCount() {
  if (!store.can('admin')) return 0;
  try {
    users = await store.users.list();
    return users.filter((u) => u.role === 'pending').length;
  } catch {
    return 0;
  }
}

function userRow(u) {
  const self = u.id === store.me.id;
  const sites = [...state.data.sites].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return `<li class="user-row ${u.role === 'pending' ? 'pending' : ''}" data-uid="${esc(u.id)}">
    <div class="user-head">
      <span class="avatar sm">${esc((u.name || u.email).slice(0, 1))}</span>
      <span class="user-main"><b>${esc(u.name || '(이름 없음)')}</b>${self ? ' <span class="badge">나</span>' : ''}<small>${esc(u.email)}</small></span>
      <select class="role-select" aria-label="${esc(u.email)} 권한" ${self ? 'disabled title="자기 권한은 바꿀 수 없습니다"' : ''}>
        ${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <div class="user-sites" ${SITE_ROLES.includes(u.role) ? '' : 'hidden'}>
      <span class="muted small">배정 현장 · 현장 담당은 이 현장들의 숙소·거주자를 등록·수정, 조회는 보기만 합니다</span>
      <div class="site-checks">${sites.map((s) => `<label class="check"><input type="checkbox" value="${esc(s.id)}" ${(u.siteIds || []).includes(s.id) ? 'checked' : ''}>${esc(s.name)}</label>`).join('') || '<span class="muted small">등록된 현장이 없습니다.</span>'}</div>
    </div>
    ${self ? '' : `<div class="user-actions"><button type="button" class="btn sm primary" data-act="user-save" data-uid="${esc(u.id)}">${icon('check')}저장</button></div>`}
  </li>`;
}

function renderUsers(box) {
  const order = { pending: 0, admin: 1, supervisor: 2, manager: 3, viewer: 4 };
  const list = [...users].sort((a, b) => order[a.role] - order[b.role] || String(a.createdAt).localeCompare(String(b.createdAt)));
  const pending = list.filter((u) => u.role === 'pending').length;
  box.innerHTML = `${pending ? `<div class="notice warn">${icon('alert')}<span>승인을 기다리는 사용자가 ${pending}명 있습니다. 권한을 고르고 저장하세요.</span></div>` : ''}
    <ul class="user-list">${list.map(userRow).join('')}</ul>`;
}

export async function usersDialog() {
  const m = openModal({
    title: '사용자·권한 관리',
    wide: true,
    body: `<ul class="role-help small">
        <li><b>운영자</b>: 모든 현장 등록·수정·삭제, 사용자 권한 관리, 수정 기록 열람</li>
        <li><b>관리자</b>: 모든 현장의 개요·숙소·공정 현황 보기. <b>거주자 명단·연락처는 볼 수 없음</b>(인원 수만)</li>
        <li><b>현장 담당</b>: 배정된 현장의 모든 것(개요·숙소·거주자·공정) 보기와 등록·수정</li>
        <li><b>조회</b>: 배정된 현장의 모든 것 보기만</li>
        <li>현장 개요(이름·주소·공기·연락처)는 누구나 모든 현장을 봅니다 · <b>승인 대기</b>: 아무것도 볼 수 없음(접근 차단에도 사용)</li>
      </ul>
      <div id="users-box"><p class="muted loading">불러오는 중…</p></div>`,
    footer: '<button type="button" class="btn" data-act="modal-close">닫기</button>',
  });
  try {
    users = await store.users.list();
    renderUsers(m.querySelector('#users-box'));
  } catch (err) {
    m.querySelector('#users-box').innerHTML = `<p class="t-warn">${esc(err.message)}</p>`;
  }
}

document.addEventListener('change', (e) => {
  if (!e.target.classList?.contains('role-select')) return;
  const row = e.target.closest('.user-row');
  row.querySelector('.user-sites').hidden = !SITE_ROLES.includes(e.target.value);
});

onAction('user-save', async (el) => {
  const row = el.closest('.user-row');
  const role = row.querySelector('.role-select').value;
  const siteIds = SITE_ROLES.includes(role) ? [...row.querySelectorAll('.site-checks input:checked')].map((c) => c.value) : [];
  if (SITE_ROLES.includes(role) && !siteIds.length) {
    toast(`${ROLE_LABEL[role]}은(는) 배정 현장을 하나 이상 골라야 합니다.`, 'warn');
    return;
  }
  const saved = await store.users.update(el.dataset.uid, { role, siteIds });
  users = users.map((u) => (u.id === saved.id ? saved : u));
  renderUsers(row.closest('#users-box'));
  toast(`${saved.name || saved.email}: ${ROLE_LABEL[saved.role]}${siteIds.length ? ` (현장 ${siteIds.length}곳)` : ''}`);
});

// ---------------------------------------------------------------- 수정 기록

let auditRows = [];

function fmtTime(s) {
  const d = new Date(s);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describe(r) {
  if (r.action !== 'update' || !r.changes) return '';
  const keys = [...new Set(Object.keys(r.changes).map((k) => FIELD_LABEL[k] || k))];
  return keys.join(', ');
}

function recordContext(r) {
  if (r.tableName === 'lodgings') return q.site(q.lodging(r.recordId)?.siteId)?.name || '';
  if (r.tableName === 'residents') return q.lodging(q.resident(r.recordId)?.lodgingId)?.name || '';
  return '';
}

function renderAudit(box, hasMore) {
  box.innerHTML = auditRows.length
    ? `<ul class="audit">${auditRows.map((r) => `<li>
        <span class="audit-time">${fmtTime(r.at)}</span>
        <span class="badge ${r.action === 'delete' ? 'crit' : r.action === 'insert' ? 'ok' : ''}">${TABLE_LABEL[r.tableName] || r.tableName} ${ACTION_LABEL[r.action] || r.action}</span>
        <span class="audit-text"><b>${esc(r.recordName || r.recordId)}</b>${recordContext(r) ? ` <small class="muted">${esc(recordContext(r))}</small>` : ''}${describe(r) ? `<small> · ${esc(describe(r))}</small>` : ''}</span>
        <span class="audit-user muted small">${esc(r.userEmail || '시스템')}</span></li>`).join('')}</ul>
      ${hasMore ? '<button type="button" class="btn sm ghost" data-act="audit-more">더 보기</button>' : ''}`
    : '<p class="empty">아직 수정 기록이 없습니다.</p>';
}

export async function auditDialog() {
  const m = openModal({
    title: '수정 기록',
    wide: true,
    body: '<p class="muted small">누가 언제 무엇을 바꿨는지 남습니다. 거주자 연락처·메모는 값 대신 "변경됨"만 기록합니다.</p><div id="audit-box"><p class="muted loading">불러오는 중…</p></div>',
    footer: '<button type="button" class="btn" data-act="modal-close">닫기</button>',
  });
  try {
    auditRows = await store.audit.list({ limit: 100 });
    renderAudit(m.querySelector('#audit-box'), auditRows.length === 100);
  } catch (err) {
    m.querySelector('#audit-box').innerHTML = `<p class="t-warn">${esc(err.message)}</p>`;
  }
}

onAction('audit-more', async (el) => {
  const box = el.closest('#audit-box');
  const more = await store.audit.list({ limit: 100, before: auditRows[auditRows.length - 1].id });
  auditRows = [...auditRows, ...more];
  renderAudit(box, more.length === 100);
});
