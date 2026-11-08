// 알림: 종 아이콘의 숫자와 목록. 출처는 저장된 알림(notices, 실시간)과 계산 알림(js/ops/calc/alerts.js).
// danger 수준의 저장 알림은 화면 맨 위 띠로(닫아도 앱을 다시 열면 그날 안에는 또 보인다).
import { CFG, store, state, q, ui } from '../ctx.js';
import { todayStr } from '../model.js';
import { $, esc, icon, onAction, onForm, openModal, closeModal, toast } from '../util.js';
import { computedAlerts, activeNotices, byLevel } from './calc/alerts.js';

let saved = []; // 볼 수 있는 현장의 저장 알림
const closed = new Set(); // 이번에 닫은 띠
const extra = []; // 단계별 계산 알림을 더한다: ({ siteId, today }) => 알림 목록
let dialogSite = undefined;

export const addAlertSource = (fn) => extra.push(fn);

const nowIso = () => new Date().toISOString();
const level = { danger: 'crit', warn: 'warn', info: 'info' };

export async function refreshNotices() {
  try {
    saved = await store.rows('notices').list({});
  } catch {
    saved = [];
  }
  renderNoticeBar();
  ui.render();
  if (dialogSite !== undefined && $('#notice-list')) paintList();
}

const liveSaved = (siteId) => activeNotices(saved, nowIso()).filter((n) => !siteId || n.siteId === siteId);

// 현장을 볼 수 있는 숙소만 계산 알림에 넣는다(배정 안 된 현장은 숙소 자체를 못 받는다)
const computed = (siteId) => [
  ...computedAlerts({ lodgings: state.data.lodgings, siteId, today: todayStr(), leaseDays: CFG.leaseAlertDays }),
  ...extra.flatMap((fn) => fn({ siteId, today: todayStr() })),
];

export const alertCount = (siteId = null) => computed(siteId).length + liveSaved(siteId).length;

export function renderNoticeBar() {
  const bar = $('#notice-bar');
  if (!bar) return;
  const n = liveSaved(null).filter((x) => x.level === 'danger' && !closed.has(x.id)).sort(byLevel)[0];
  bar.hidden = !n;
  if (!n) return;
  bar.innerHTML = `${icon('alert')}<span><b>${esc(n.title)}</b> ${esc(q.site(n.siteId)?.name || '')}</span>
    <button type="button" class="btn sm" data-act="notices">자세히</button>
    <button type="button" class="icon-btn sm" data-act="notice-bar-close" data-id="${esc(n.id)}" aria-label="닫기">${icon('close')}</button>`;
}

const canPost = (siteId) => store.can('edit', siteId);

function paintList() {
  const siteId = dialogSite;
  const site = (id) => (siteId ? '' : q.site(id)?.name || '');
  const stored = liveSaved(siteId).sort(byLevel).map((n) => `<li class="nt-item ${level[n.level]}">
      <span class="nt-ic">${icon(n.kind === 'manual' ? 'bell' : 'alert')}</span>
      <span class="nt-main"><b>${esc(n.title)}</b><small>${esc([site(n.siteId), n.body?.ko || Object.values(n.body || {})[0] || ''].filter(Boolean).join(' · '))}</small></span>
      ${canPost(n.siteId) ? `<button type="button" class="btn sm ghost" data-act="notice-done" data-id="${esc(n.id)}">확인함</button>` : ''}</li>`);
  const calc = computed(siteId).map((a) => `<li class="nt-item ${level[a.level]}">
      <button type="button" class="row-btn" data-act="alert-go" data-id="${esc(a.go?.lodgingId || '')}" ${a.go?.lodgingId ? '' : 'disabled'}>
      <span class="nt-ic">${icon(a.kind === 'lease' ? 'house' : 'alert')}</span>
      <span class="nt-main"><b>${esc(a.title)}</b><small>${esc(a.sub || '')}</small></span></button></li>`);
  const all = [...stored, ...calc];
  $('#notice-list').innerHTML = all.length ? `<ul class="rows nt-list">${all.join('')}</ul>` : `<p class="empty">${icon('check')}지금 확인할 알림이 없습니다.</p>`;
}

// siteId가 없으면 모든 현장
export function noticesDialog(siteId = null) {
  dialogSite = siteId;
  openModal({
    title: '알림',
    wide: true,
    body: '<div id="notice-list"></div><p class="muted small">계약을 연장·해지한 뒤에는 숙소 정보에서 계약 종료일을 바꿔주세요.</p>',
    footer: `${siteId && canPost(siteId) ? `<button type="button" class="btn" data-act="notice-new">${icon('plus')}공지 쓰기</button><span class="spacer"></span>` : ''}
      <button type="button" class="btn" data-act="modal-close">닫기</button>`,
    onClose: () => { dialogSite = undefined; },
  });
  paintList();
  refreshNotices();
}

function noticeForm(siteId) {
  openModal({
    title: '공지 쓰기',
    body: `<form id="f-notice" data-form="notice" data-site="${esc(siteId)}" novalidate>
      <label class="field"><span>제목 <em>*</em></span><input name="title" maxlength="100" required></label>
      <label class="field"><span>내용</span><textarea name="body" rows="4" maxlength="2000"></textarea></label>
      <label class="field"><span>수준</span><select name="level"><option value="info">안내</option><option value="warn">주의</option><option value="danger">위험(맨 위 띠)</option></select></label>
      <label class="field"><span>끝나는 날</span><input name="ends" type="date"></label>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" class="btn primary" form="f-notice">${icon('check')}올리기</button>`,
  });
}

onAction('notices', () => noticesDialog(null));
onAction('notice-new', () => noticeForm(dialogSite));
onForm('notice', async (data, form) => {
  await store.rows('notices').save({
    siteId: form.dataset.site, kind: 'manual', level: data.level, title: data.title, body: { ko: data.body },
    endsAt: data.ends ? `${data.ends}T23:59:59+09:00` : null,
  });
  closeModal(true);
  toast('공지를 올렸습니다.');
  refreshNotices();
});
onAction('notice-done', async (el) => {
  const n = saved.find((x) => x.id === el.dataset.id);
  if (!n) return;
  await store.notices.resolve(n.id);
  refreshNotices();
});
onAction('notice-bar-close', (el) => { closed.add(el.dataset.id); renderNoticeBar(); });
onAction('alert-go', (el) => {
  closeModal();
  if (el.dataset.id) ui.selectLodging(el.dataset.id);
});

export function initNotices() {
  store.rows('notices').subscribe(null, refreshNotices);
  refreshNotices();
}

