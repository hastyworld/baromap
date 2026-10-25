// 앱 설치(PWA): 서비스워커 등록, 설치 버튼, 아이폰 설치 안내
import { icon, openModal, toast } from './util.js';

let deferred = null; // 크롬·엣지·안드로이드의 설치 요청

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function initPwa(onChange) {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[pwa] 서비스워커 등록 실패', err));
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    onChange?.();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    toast('바로맵을 앱으로 설치했습니다.');
    onChange?.();
  });
}

// 메뉴에 "앱으로 설치"를 보여줄지(이미 앱으로 열려 있으면 숨김). 설치 요청이 없는 브라우저는 안내를 띄운다.
export const canInstall = () => !isStandalone();

export async function install() {
  if (deferred) {
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') deferred = null;
    return;
  }
  const ios = isIOS();
  openModal({
    title: '앱으로 설치하기',
    body: `<div class="install-help">
      ${ios ? `<ol class="steps">
          <li><b>Safari</b>로 이 페이지를 엽니다. (다른 브라우저에서는 설치할 수 없습니다)</li>
          <li>아래쪽 <b>공유 버튼</b>(네모에 위쪽 화살표)을 누릅니다.</li>
          <li><b>홈 화면에 추가</b>를 누르면 바로맵 아이콘이 생깁니다.</li>
        </ol>` : `<ol class="steps">
          <li><b>노트북(크롬·엣지)</b>: 주소창 오른쪽의 설치 아이콘 ${icon('download')} 또는 메뉴 ⋮ → <b>앱 설치</b>(엣지: 앱 → 이 사이트를 앱으로 설치).</li>
          <li><b>안드로이드(크롬·삼성 인터넷)</b>: 메뉴 ⋮ → <b>홈 화면에 추가</b> 또는 <b>앱 설치</b>.</li>
          <li><b>아이폰</b>: Safari 공유 버튼 → <b>홈 화면에 추가</b>.</li>
        </ol>`}
      <p class="muted small">설치하면 바탕화면·홈 화면 아이콘으로 바로 열리고, 주소창 없이 앱처럼 보입니다. 내용은 웹과 같고 항상 최신 버전으로 열립니다.</p>
    </div>`,
    footer: '<button type="button" class="btn" data-act="modal-close">닫기</button>',
  });
}
