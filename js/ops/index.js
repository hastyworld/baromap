// [운영] 화면 틀: 현장 패널의 [운영] 단추로 여는 전체 화면. 위쪽 탭(일보·안전·이슈·예보)은 각 모듈이 registerOpsTab으로 붙는다.
// 탭 모듈의 mount(el, ctx)는 그 탭을 그리고, 닫을 때 부를 함수를 돌려준다.
import { store, q } from '../ctx.js';
import { $, esc, icon, onAction, fmtDateTime } from '../util.js';
import { alertCount, noticesDialog, refreshNotices } from './notices.js';
import { opsSettingsDialog } from './settings.js';

const WEATHER_MS = 30 * 60000;
const tabs = [];
let ops = null; // { el, siteId, tab, unmount, off, timer, returnFocus }
let pushed = false;

export function registerOpsTab(t) {
  tabs.push(t);
  tabs.sort((a, b) => a.order - b.order);
}

export const opsOpen = () => Boolean(ops);
export const opsSiteId = () => ops?.siteId || null;

function canSettings(siteId) { return store.can('edit', siteId) || store.can('admin'); }

async function paintBand() {
  if (!ops) return;
  const band = $('#ops-net', ops.el);
  const [pending, conflicts] = await Promise.all([store.outbox.pending(), store.outbox.conflicts()]);
  const { offline, lastSync } = store.outbox.status();
  if (!ops) return;
  const parts = [];
  if (offline) parts.push(`<b>오프라인</b>${lastSync ? ` — 마지막 동기화 ${esc(fmtDateTime(lastSync).slice(5))}` : ''}`);
  if (pending.length) parts.push(`올리기 대기 ${pending.length}건`);
  if (conflicts.length) parts.push(`<button type="button" class="link" data-act="ops-conflicts">충돌본 ${conflicts.length}건 고르기</button>`);
  band.hidden = !parts.length;
  band.innerHTML = parts.length ? `${icon('alert')}<span>${parts.join(' · ')}</span>` : '';
}

function paintBell() {
  const n = $('#ops-bell-count', ops?.el);
  if (!n) return;
  const c = alertCount(ops.siteId);
  n.hidden = !c;
  n.textContent = c;
}

function renderShell() {
  const s = q.site(ops.siteId);
  ops.el.innerHTML = `
    <header class="board-head">
      <button type="button" class="icon-btn" data-act="ops-close" aria-label="닫기" title="닫기">${icon('close')}</button>
      <div class="board-title"><b>현장 운영</b><span>${esc(s.name)}</span></div>
      <div class="board-tools">
        <button type="button" class="icon-btn ops-bell" data-act="ops-notices" aria-label="알림" title="알림">${icon('bell')}<span class="count" id="ops-bell-count" hidden></span></button>
        ${canSettings(ops.siteId) ? `<button type="button" class="icon-btn" data-act="ops-settings" aria-label="운영 설정" title="운영 설정">${icon('settings')}</button>` : ''}
      </div>
    </header>
    <div id="ops-net" class="ops-net" role="status" hidden></div>
    ${tabs.length > 1 ? `<nav class="board-tabs ops-tabs" role="tablist" aria-label="운영 메뉴">${tabs.map((t) => `<button type="button" role="tab" aria-selected="${t.id === ops.tab}" class="${t.id === ops.tab ? 'on' : ''}" data-act="ops-tab" data-tab="${esc(t.id)}">${esc(t.label)}</button>`).join('')}</nav>` : ''}
    <div class="ops-body" id="ops-body"></div>`;
  paintBell();
  paintBand();
}

function mountTab() {
  ops.unmount?.();
  const t = tabs.find((x) => x.id === ops.tab) || tabs[0];
  const body = $('#ops-body', ops.el);
  body.innerHTML = '';
  body.scrollTop = 0;
  ops.unmount = t?.mount(body, { siteId: ops.siteId, site: () => q.site(ops?.siteId), paintBand }) || null;
}

async function refreshWeather() {
  if (!ops) return;
  const r = await store.weather.refresh(ops.siteId).catch(() => null);
  if (r?.ok) refreshNotices();
}

/** @param {string} siteId @param {string} [tab] */
export function openOps(siteId, tab) {
  if (!q.site(siteId) || !store.rows) return;
  closeOps({ keepHistory: true });
  const el = document.createElement('div');
  el.id = 'ops';
  el.className = 'ops';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', '현장 운영');
  document.body.append(el);
  document.body.classList.add('board-open');
  ops = { el, siteId, tab: tab || tabs[0]?.id, unmount: null, returnFocus: document.activeElement };
  ops.off = store.subscribe(() => { if (ops) { paintBell(); paintBand(); } });
  if (!pushed) {
    history.pushState({ baromapOps: true }, '');
    pushed = true;
  }
  renderShell();
  mountTab();
  refreshWeather();
  store.ai?.settings?.(siteId).catch(() => {});
  ops.timer = setInterval(refreshWeather, WEATHER_MS);
  el.querySelector('[data-act="ops-close"]')?.focus();
}

export function closeOps({ fromHistory = false, keepHistory = false } = {}) {
  if (!ops) return;
  const o = ops;
  ops = null;
  clearInterval(o.timer);
  o.off?.();
  o.unmount?.();
  o.el.remove();
  document.body.classList.remove('board-open');
  if (keepHistory) return;
  o.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.back();
  pushed = false;
}

window.addEventListener('popstate', () => { if (ops) closeOps({ fromHistory: true }); });

onAction('ops-open', (el) => openOps(el.dataset.site, el.dataset.tab));
onAction('ops-close', () => closeOps());
onAction('ops-tab', (el) => {
  ops.tab = el.dataset.tab;
  renderShell();
  mountTab();
});
onAction('ops-notices', () => noticesDialog(ops.siteId));
onAction('ops-settings', () => opsSettingsDialog(ops.siteId));
