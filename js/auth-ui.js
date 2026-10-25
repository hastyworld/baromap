// 공유 모드 로그인: 로그인·회원가입·비밀번호 찾기 화면, 승인 대기 화면, 내 계정
import { CFG, store, ROLE_LABEL } from './ctx.js';
import { $, esc, icon, onAction, onForm, openModal, closeModal, toast, showFormError } from './util.js';

const LOGO = `<svg class="auth-logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1F3A68"/><path d="M16 6.5c-4.4 0-8 3.4-8 7.7 0 5.6 8 11.8 8 11.8s8-6.2 8-11.8c0-4.3-3.6-7.7-8-7.7z" fill="#fff"/><path d="M11.8 15.2 16 11.6l4.2 3.6v4.3h-8.4z" fill="#E03131"/></svg>`;
const PROVIDER_LABEL = { azure: 'Microsoft 365 계정으로 로그인', google: 'Google 계정으로 로그인' };

let resolveAuth = null;

function screen(html) {
  let el = $('#auth');
  if (!el) {
    el = document.createElement('div');
    el.id = 'auth';
    document.body.append(el);
  }
  el.hidden = false;
  el.innerHTML = `<div class="auth-card">${LOGO}<h1>${esc(CFG.serviceName)}</h1>${html}</div>
    <p class="auth-foot">건설현장과 직원 숙소를 한 지도에서</p>`;
  document.body.classList.add('auth-open');
  setTimeout(() => el.querySelector('input')?.focus(), 30);
  return el;
}

function hideScreen() {
  const el = $('#auth');
  if (el) el.hidden = true;
  document.body.classList.remove('auth-open');
}

function loginForm(mode = 'login', notice = '') {
  const providers = (CFG.authProviders || []).filter((p) => PROVIDER_LABEL[p]);
  const tabs = `<div class="seg auth-tabs" role="tablist">
    <button type="button" role="tab" class="${mode === 'login' ? 'on' : ''}" data-act="auth-mode" data-mode="login">로그인</button>
    <button type="button" role="tab" class="${mode === 'signup' ? 'on' : ''}" data-act="auth-mode" data-mode="signup">회원가입</button></div>`;
  const note = notice ? `<div class="notice ok">${icon('check')}<span>${notice}</span></div>` : '';
  if (mode === 'reset') {
    return screen(`<p class="muted">가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.</p>${note}
      <form data-form="auth-reset" class="auth-form">
        <label class="field"><span>이메일</span><input name="email" type="email" required autocomplete="email"></label>
        <button type="submit" class="btn primary block">재설정 메일 보내기</button>
      </form>
      <button type="button" class="link" data-act="auth-mode" data-mode="login">${icon('back')}로그인으로</button>`);
  }
  return screen(`${tabs}${note}
    <form data-form="auth-${mode}" class="auth-form">
      ${mode === 'signup' ? '<label class="field"><span>이름</span><input name="name" required maxlength="50" autocomplete="name" placeholder="예) 홍길동"></label>' : ''}
      <label class="field"><span>이메일</span><input name="email" type="email" required autocomplete="email"></label>
      <label class="field"><span>비밀번호</span><input name="password" type="password" required minlength="6" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></label>
      <button type="submit" class="btn primary block">${mode === 'signup' ? '가입하기' : '로그인'}</button>
    </form>
    ${mode === 'login' ? '<button type="button" class="link" data-act="auth-mode" data-mode="reset">비밀번호를 잊으셨나요?</button>' : '<p class="muted small">가입하면 관리자가 승인한 뒤부터 볼 수 있습니다. (첫 가입자는 자동으로 관리자)</p>'}
    ${providers.length ? `<div class="auth-or"><span>또는</span></div>${providers.map((p) => `<button type="button" class="btn block" data-act="auth-provider" data-provider="${p}">${esc(PROVIDER_LABEL[p])}</button>`).join('')}` : ''}`);
}

onAction('auth-mode', (el) => loginForm(el.dataset.mode));
onAction('auth-provider', (el) => store.auth.signInWithProvider(el.dataset.provider));

onForm('auth-login', async (d) => {
  await store.auth.signIn(d.email.trim(), d.password);
  resolveAuth?.();
});

onForm('auth-signup', async (d) => {
  const r = await store.auth.signUp(d.email.trim(), d.password, d.name.trim());
  if (r.needsConfirm) loginForm('login', `<b>${esc(d.email)}</b>로 인증 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요.`);
  else resolveAuth?.();
});

onForm('auth-reset', async (d, form) => {
  await store.auth.resetPassword(d.email.trim());
  form.reset();
  loginForm('reset', '재설정 메일을 보냈습니다. 메일의 링크를 누르면 새 비밀번호를 정할 수 있습니다.');
});

function showLogin() {
  return new Promise((resolve) => {
    resolveAuth = () => {
      resolveAuth = null;
      resolve();
    };
    loginForm('login');
  });
}

function showPending() {
  return new Promise((resolve) => {
    const me = store.me;
    screen(`<div class="pending">
        ${icon('clock')}
        <h2>관리자 승인을 기다리고 있습니다</h2>
        <p class="muted"><b>${esc(me?.email || '')}</b> 계정으로 가입되었습니다.<br>관리자가 권한을 주면 이 화면이 자동으로 바뀝니다.</p>
      </div>
      <button type="button" class="btn block" data-act="auth-logout">로그아웃</button>`);
    const off = store.subscribe(() => {
      if (store.can('view')) {
        off();
        resolve();
      }
    });
  });
}

onAction('auth-logout', async () => {
  await store.auth.signOut();
  location.reload();
});

/**
 * 공유 모드에서 로그인하고 승인된 상태가 될 때까지 기다린다. 끝나면 데이터가 들어 있다.
 */
export async function ensureSignedIn() {
  store.auth.onChange((event) => {
    if (event === 'PASSWORD_RECOVERY') newPasswordDialog();
    if (event === 'SIGNED_OUT') location.reload();
  });
  if (!(await store.auth.user())) await showLogin();
  screen('<p class="muted loading">불러오는 중…</p>');
  try {
    await store.load();
  } catch (err) {
    screen(`<div class="form-error">${icon('alert')}<span>${esc(err.message)}</span></div>
      <button type="button" class="btn primary block" onclick="location.reload()">다시 시도</button>
      <button type="button" class="btn block" data-act="auth-logout">로그아웃</button>`);
    return false;
  }
  if (!store.can('view')) await showPending();
  hideScreen();
  return true;
}

// ---------------------------------------------------------------- 비밀번호 재설정 링크로 들어왔을 때

function newPasswordDialog() {
  openModal({
    title: '새 비밀번호 설정',
    body: `<form id="f-newpw" data-form="new-password">
      <label class="field"><span>새 비밀번호 (6자 이상)</span><input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
    </form>`,
    footer: '<button type="submit" class="btn primary" form="f-newpw">저장</button>',
  });
}

onForm('new-password', async (d) => {
  await store.auth.updatePassword(d.password);
  closeModal(true);
  toast('비밀번호를 바꿨습니다.');
});

// ---------------------------------------------------------------- 내 계정

export function accountDialog() {
  const me = store.me;
  openModal({
    title: '내 계정',
    body: `<form id="f-account" data-form="account">
      <p class="account-head"><span class="avatar">${esc((me.name || me.email).slice(0, 1))}</span>
        <span><b>${esc(me.email)}</b><br><span class="muted small">권한: ${ROLE_LABEL[me.role] || me.role}${me.role === 'manager' ? ` · 담당 현장 ${(me.siteIds || []).length}곳` : ''}</span></span></p>
      <label class="field"><span>이름</span><input name="name" value="${esc(me.name)}" maxlength="50" required></label>
      <label class="field"><span>새 비밀번호 <small class="muted">(바꿀 때만 입력, 6자 이상)</small></span><input name="password" type="password" minlength="6" autocomplete="new-password"></label>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="auth-logout">${icon('back')}로그아웃</button><span class="spacer"></span>
      <button type="button" class="btn ghost" data-act="modal-close">취소</button>
      <button type="submit" class="btn primary" form="f-account">${icon('check')}저장</button>`,
  });
}

onForm('account', async (d, form) => {
  const name = d.name.trim();
  if (!name) return showFormError(form, '이름을 입력해주세요.');
  if (name !== store.me.name) await store.users.update(store.me.id, { name });
  if (d.password) await store.auth.updatePassword(d.password);
  closeModal(true);
  toast('내 계정 정보를 저장했습니다.');
});
