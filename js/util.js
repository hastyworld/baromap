// 공통 도우미: 이스케이프, 포맷, 아이콘, 이벤트 위임, 토스트·대화상자, 파일 입출력
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- 포맷

export const fmtDate = (s) => (s ? s.slice(0, 10).replaceAll('-', '.') : '-');

export function fmtDistance(m) {
  if (m == null) return '-';
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)}m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
}

export function formatPhone(v) {
  const s = String(v || '').replace(/\D/g, '');
  if (s.startsWith('02')) {
    if (s.length === 9) return `${s.slice(0, 2)}-${s.slice(2, 5)}-${s.slice(5)}`;
    if (s.length === 10) return `${s.slice(0, 2)}-${s.slice(2, 6)}-${s.slice(6)}`;
  }
  if (s.length === 10) return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
  if (s.length === 11) return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4)}`;
  return v;
}

export const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

// ---------------------------------------------------------------- 아이콘 (24px 선형)

const ICONS = {
  hardhat: '<path d="M3 17.5h18v2.5H3zM4.5 17.5a7.5 7.5 0 0 1 15 0M9.5 10.5V6.2h5v4.3"/>',
  house: '<path d="M3 11.5 12 4l9 7.5M5.5 10v10h13V10M10 20v-5.5h4V20"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20.5a7 7 0 0 1 14 0"/>',
  users: '<circle cx="9" cy="8" r="3.3"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0M15.5 4.8a3.3 3.3 0 0 1 0 6.4M17.5 14a6 6 0 0 1 3.7 6"/>',
  phone: '<path d="M5.2 3.8h3.6l1.9 4.7-2.4 1.6a11 11 0 0 0 5.6 5.6l1.6-2.4 4.7 1.9v3.6a1.9 1.9 0 0 1-2 1.9A16.5 16.5 0 0 1 3.3 5.8a1.9 1.9 0 0 1 1.9-2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  pin: '<path d="M12 21s-7-6.1-7-11.2a7 7 0 0 1 14 0C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  car: '<path d="M4 16.5V12l1.8-4.6A2 2 0 0 1 7.7 6h8.6a2 2 0 0 1 1.9 1.4L20 12v4.5zM3 12h18M6 16.5V19M18 16.5V19"/>',
  bus: '<rect x="5" y="3" width="14" height="15" rx="2.5"/><path d="M5 11h14M8 18v2.5M16 18v2.5"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="m9 21 2.2-6.5 2.8 2.5V21M11.2 14.5 12.3 9l3.2 3H19M12.3 9 8.5 10.8 7.5 14"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  alert: '<path d="M12 3.5 21.5 20h-19zM12 10v4.5M12 17.2v.3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v6H4V6h6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 16V5M7 9.5l5-5 5 5M4 20h16"/>',
  file: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8zM14 3v5h5M9 13h6M9 17h6"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  map: '<path d="M9 4.5 3 6.5v13l6-2 6 2 6-2v-13l-6 2zM9 4.5v13M15 6.5v13"/>',
  settings: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
  hospital: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
  pill: '<rect x="3.5" y="9" width="17" height="6" rx="3" transform="rotate(-35 12 12)"/><path d="m9.5 8.6 4.9 6.8"/>',
  store: '<path d="M4 9.5 5.5 4h13L20 9.5M4 9.5v10h16v-10M4 9.5h16M9.5 19.5v-5h5v5"/>',
  door: '<path d="M5 21h14M7 21V3.5h10V21M13.5 12.5h.01"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  building: '<path d="M4 21V5.5L12 3v18M12 8.5h8V21M3 21h18M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2"/>',
  cube: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5"/>',
  camera: '<path d="M3.5 8.5h3.5l1.7-2.5h6.6L17 8.5h3.5v11h-17z"/><circle cx="12" cy="13.5" r="3.6"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.7" ry="8.5"/><path d="M3.5 12h17"/>',
  street: '<circle cx="12" cy="4.8" r="2"/><path d="M9.2 21v-6.3H7.6V10a2 2 0 0 1 2-2h4.8a2 2 0 0 1 2 2v4.7h-1.6V21M12 14.7V21"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---------------------------------------------------------------- 이벤트 위임
// <button data-act="name" data-id="3"> → actions.name(el, event)

const actions = {};
const forms = {};
export const onAction = (name, fn) => { actions[name] = fn; };
export const onForm = (name, fn) => { forms[name] = fn; };

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try {
    await fn(el, e);
  } catch (err) {
    toast(err.message, 'crit');
    console.error(err);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = forms[form.dataset.form];
  if (!fn) return;
  const submits = $$(`[type=submit][form="${form.id}"], [type=submit]`, form.closest('.modal') || form);
  submits.forEach((b) => { b.disabled = true; });
  try {
    await fn(formData(form), form);
  } catch (err) {
    showFormError(form, err.message);
  } finally {
    submits.forEach((b) => { b.disabled = false; });
  }
});

document.addEventListener('focusout', (e) => {
  if (e.target.matches?.('input[data-phone]') && e.target.value) e.target.value = formatPhone(e.target.value);
});

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

export function showFormError(form, msg) {
  let box = form.querySelector('.form-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'form-error';
    box.setAttribute('role', 'alert');
    form.prepend(box);
  }
  box.innerHTML = `${icon('alert')}<span>${esc(msg)}</span>`;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------- 토스트·대화상자

export function toast(msg, kind = 'ok') {
  let wrap = $('#toasts');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toasts';
    wrap.setAttribute('role', 'status');
    document.body.append(wrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'ok' ? 'check' : 'alert')}<span>${esc(msg)}</span>`;
  wrap.append(el);
  const life = kind === 'ok' ? 2600 : 5000;
  setTimeout(() => el.classList.add('out'), life);
  setTimeout(() => el.remove(), life + 400);
}

let confirmResolve = null;

// 대화상자는 한 번에 하나. hide()로 잠시 숨겼다가 show()로 다시 띄울 수 있다(지도에서 위치 지정용).
export function openModal({ title, body, footer = '', wide = false, onClose }) {
  closeModal();
  const el = document.createElement('div');
  el.id = 'modal';
  el.innerHTML = `
    <div class="modal-backdrop" data-act="modal-close"></div>
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-head">
        <h2 id="modal-title">${esc(title)}</h2>
        <button type="button" class="icon-btn" data-act="modal-close" aria-label="닫기">${icon('close')}</button>
      </header>
      <div class="modal-body">${body}</div>
      ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
    </div>`;
  el._onClose = onClose;
  el._returnFocus = document.activeElement;
  document.body.append(el);
  document.body.classList.add('modal-open');
  setTimeout(() => el.querySelector('[autofocus], input:not([type=hidden]):not([disabled]), select, textarea')?.focus(), 30);
  return el;
}

export function closeModal(result) {
  const el = $('#modal');
  if (!el) return;
  el._onClose?.(result);
  el.remove();
  document.body.classList.remove('modal-open');
  el._returnFocus?.focus?.();
  if (confirmResolve) {
    const r = confirmResolve;
    confirmResolve = null;
    r(result ?? false);
  }
}

export const hideModal = () => { const m = $('#modal'); if (m) { m.hidden = true; document.body.classList.remove('modal-open'); } };
export const showModal = () => { const m = $('#modal'); if (m) { m.hidden = false; document.body.classList.add('modal-open'); } };

onAction('modal-close', () => closeModal(false));
onAction('modal-ok', () => closeModal(true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modal') && !$('#modal').hidden) closeModal(false);
});

export function confirmDialog(message, { title = '확인', ok = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="confirm-msg">${esc(message).replace(/\n/g, '<br>')}</p>`,
      footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button>
               <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-act="modal-ok" autofocus>${esc(ok)}</button>`,
    });
    confirmResolve = resolve;
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---------------------------------------------------------------- 파일·스크립트

// 바로맵 안드로이드 앱 안에서는 파일 내려받기가 안 된다(웹뷰 제약) → 웹 브라우저 안내
export const isAppView = () => /BaromapApp/.test(navigator.userAgent);
export function appDownloadBlocked() {
  if (!isAppView()) return false;
  toast('앱에서는 파일 내려받기가 안 됩니다. 노트북·휴대폰 브라우저에서 바로맵 주소로 들어가 이용해주세요.', 'warn');
  return true;
}

export function download(filename, content, type = 'application/octet-stream') {
  if (appDownloadBlocked()) return;
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const scripts = {};
export function loadScript(src) {
  scripts[src] ||= new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src, async: true });
    s.onload = resolve;
    s.onerror = () => {
      delete scripts[src];
      reject(new Error(`스크립트를 불러오지 못했습니다: ${new URL(src, location.href).host}`));
    };
    document.head.append(s);
  });
  return scripts[src];
}

export function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
}

export const debounce = (fn, ms = 200) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export function readFileText(file) {
  return file.text();
}
