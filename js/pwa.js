// 휴대폰 설치: 안드로이드 앱(APK) 받기, 웹앱(PWA) 설치, 카카오톡 등 앱 안 브라우저 안내
import { $, esc, icon, onAction, openModal, toast } from './util.js';

export const APK_URL = 'download/baromap.apk';
const UA = navigator.userAgent;
let deferred = null; // 크롬·엣지의 웹앱 설치 요청

export const isApp = () => /BaromapApp/.test(UA); // 바로맵 안드로이드 앱 안에서 열림
export const isAndroid = () => /Android/i.test(UA);
export const isIOS = () => /iphone|ipad|ipod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = () => isAndroid() || isIOS();
export const isStandalone = () =>
  isApp() || matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// 카카오톡·네이버 앱 등 앱 안의 브라우저: 설치가 안 되고 로그인이 자주 풀린다.
export function inAppBrowser() {
  if (/KAKAOTALK/i.test(UA)) return '카카오톡';
  if (/NAVER\(inapp|NAVER/i.test(UA)) return '네이버 앱';
  if (/DaumApps/i.test(UA)) return '다음 앱';
  if (/BAND\//i.test(UA)) return '밴드';
  if (/Instagram/i.test(UA)) return '인스타그램';
  if (/FBAN|FBAV/i.test(UA)) return '페이스북';
  if (/ Line\//i.test(UA)) return '라인';
  return null;
}

export function initPwa(onChange) {
  if (!isApp() && 'serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[pwa] 서비스워커 등록 실패', err));
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    onChange?.();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    toast('바로맵을 설치했습니다. 홈 화면의 바로맵 아이콘으로 여세요.');
    renderInstallBar();
  });
  renderInstallBar();
}

// 메뉴에 "앱으로 설치"를 보여줄지(앱·설치된 화면에서는 숨김)
export const canInstall = () => !isStandalone();

// 앱 안 브라우저 → 휴대폰 기본 브라우저로 열기
export function openExternal() {
  const url = location.href;
  if (/KAKAOTALK/i.test(UA)) {
    location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
  } else if (isAndroid()) {
    location.href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`;
  } else {
    openModal({
      title: 'Safari로 열기',
      body: `<p>오른쪽 위(또는 아래)의 <b>⋯ 메뉴</b> → <b>Safari로 열기</b>(또는 '기본 브라우저로 열기')를 눌러주세요.</p>
        <p class="muted small">주소: ${esc(url)}</p>`,
      footer: '<button type="button" class="btn" data-act="modal-close">닫기</button>',
    });
  }
}

const DISMISS_KEY = 'baromap.installBar.dismissed';

// 화면 위 안내 띠: 앱 안 브라우저면 "크롬·사파리로 열기", 휴대폰 브라우저면 "앱으로 설치"
export function renderInstallBar() {
  const bar = $('#install-bar');
  if (!bar) return;
  const inApp = inAppBrowser();
  let html = '';
  if (inApp) {
    html = `${icon('alert')}<span><b>${inApp}</b> 안에서는 설치·로그인 유지가 안 돼요.</span>
      <button type="button" class="btn sm primary" data-act="open-external">${isIOS() ? 'Safari' : '크롬'}으로 열기</button>`;
    bar.dataset.kind = 'warn';
  } else if (isMobile() && !isStandalone()) {
    let dismissed = false;
    try { dismissed = Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < 7 * 864e5; } catch { /* 무시 */ }
    if (!dismissed) {
      html = `${icon('download')}<span>바로맵을 <b>앱으로 설치</b>하면 홈 화면에서 바로 열려요.</span>
        <button type="button" class="btn sm primary" data-act="install">설치</button>
        <button type="button" class="icon-btn xs" data-act="install-bar-close" aria-label="닫기">${icon('close')}</button>`;
      bar.dataset.kind = 'info';
    }
  }
  bar.hidden = !html;
  bar.innerHTML = html;
}

onAction('open-external', () => openExternal());
onAction('install-bar-close', () => {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* 무시 */ }
  renderInstallBar();
});

const apkSteps = `<ol class="steps">
    <li>아래 <b>안드로이드 앱 받기</b>를 누르면 바로맵 앱 파일(약 4MB)을 받습니다.</li>
    <li>다 받으면 알림이나 '다운로드'에서 <b>baromap.apk</b>를 눌러 엽니다.</li>
    <li>"출처를 알 수 없는 앱" 안내가 나오면 <b>설정 → 이 출처 허용</b>을 켜고 돌아와 <b>설치</b>를 누릅니다.</li>
    <li>홈 화면의 <b>바로맵</b> 아이콘으로 엽니다. (처음 한 번만 로그인)</li>
  </ol>`;

export async function install() {
  if (inAppBrowser()) {
    openExternal();
    return;
  }
  const android = isAndroid();
  const ios = isIOS();
  let body;
  if (android) {
    body = `<p><b>안드로이드 앱</b>으로 설치합니다. 웹과 같은 데이터를 보고, 화면은 항상 최신으로 열립니다.</p>${apkSteps}
      ${deferred ? '<p class="muted small">앱 파일 대신 크롬의 웹앱 설치를 쓰려면 아래 <b>웹앱으로 설치</b>를 누르세요.</p>' : ''}`;
  } else if (ios) {
    body = `<ol class="steps">
        <li><b>Safari</b>로 이 페이지를 엽니다. (아이폰은 Safari에서만 설치돼요)</li>
        <li>아래쪽 <b>공유 버튼</b>(네모에 위쪽 화살표)을 누릅니다.</li>
        <li><b>홈 화면에 추가</b> → <b>추가</b>를 누르면 바로맵 아이콘이 생깁니다.</li>
      </ol>
      <p class="muted small">아이폰은 애플 정책상 파일로 앱을 설치할 수 없어 이 방법을 씁니다. 아이콘으로 열면 주소창 없이 앱처럼 열리고, 웹과 같은 데이터를 봅니다.</p>`;
  } else {
    body = `<ol class="steps">
        <li><b>노트북(크롬·엣지)</b>: 주소창 오른쪽 설치 아이콘 ${icon('download')} → 설치${deferred ? ' (또는 아래 <b>웹앱으로 설치</b>)' : ''}</li>
        <li><b>안드로이드 휴대폰</b>: 휴대폰으로 이 주소를 열고 메뉴 → 앱으로 설치 → <b>안드로이드 앱 받기</b></li>
        <li><b>아이폰</b>: Safari로 열고 공유 버튼 → <b>홈 화면에 추가</b></li>
      </ol>
      <p class="muted small">휴대폰에 보낼 주소: <b>${esc(location.origin + location.pathname)}</b></p>`;
  }
  openModal({
    title: '앱으로 설치하기',
    body: `<div class="install-help">${body}</div>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">닫기</button>
      ${deferred ? '<button type="button" class="btn" data-act="pwa-install">웹앱으로 설치</button>' : ''}
      ${android || !ios ? `<a class="btn primary" href="${APK_URL}" download="baromap.apk">${icon('download')}안드로이드 앱 받기</a>` : ''}`,
  });
}

onAction('pwa-install', async () => {
  if (!deferred) return;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  if (outcome === 'accepted') deferred = null;
});
