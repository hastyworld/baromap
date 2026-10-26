// 바로맵 서비스워커: 앱 설치(PWA)와 오프라인 실행을 위해 화면 파일을 보관한다.
// - 같은 출처의 파일은 "네트워크 먼저, 안 되면 보관본" → 배포하면 다음 실행부터 바로 새 버전
// - 버전이 고정된 CDN 파일(Leaflet·SheetJS·Supabase·글꼴)은 "보관본 먼저"
// - 데이터(Supabase)·지도 타일·카카오 API는 건드리지 않는다
// 화면 파일을 추가·삭제하면 SHELL과 VERSION을 함께 고친다.
const VERSION = 'baromap-0.3.2';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'favicon.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'css/app.css',
  'js/app.js', 'js/ctx.js', 'js/store.js', 'js/store-remote.js', 'js/model.js', 'js/sample.js', 'js/util.js',
  'js/geo.js', 'js/forms.js', 'js/excel.js', 'js/excel-ui.js', 'js/auth-ui.js', 'js/admin-ui.js', 'js/pwa.js', 'js/photos.js',
  'js/map/index.js', 'js/map/base.js', 'js/map/kakao.js', 'js/map/osm.js',
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'baromap-cdn').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') return cache.match('index.html');
    throw new Error('offline');
  }
}

async function cacheFirst(req) {
  const cache = await caches.open('baromap-cdn');
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/download/')) return; // 앱 파일은 보관하지 않는다
    e.respondWith(networkFirst(req));
  } else if (CDN.test(req.url)) {
    e.respondWith(cacheFirst(req));
  }
});
