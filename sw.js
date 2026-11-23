// 바로맵 서비스워커: 앱 설치(PWA)와 오프라인 실행을 위해 화면 파일을 보관한다.
// - 같은 출처의 파일은 "네트워크 먼저, 안 되면 보관본" → 배포하면 다음 실행부터 바로 새 버전
// - 버전이 고정된 CDN 파일(Leaflet·SheetJS·Supabase·글꼴)은 "보관본 먼저"
// - 데이터(Supabase)·지도 타일·카카오 API는 건드리지 않는다
// 화면 파일을 추가·삭제하면 SHELL과 VERSION을 함께 고친다.
const VERSION = 'baromap-0.8.16';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'favicon.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'css/app.css', 'css/ops.css',
  'js/app.js', 'js/ctx.js', 'js/store.js', 'js/store-remote.js', 'js/model.js', 'js/sample.js', 'js/util.js',
  'js/geo.js', 'js/forms.js', 'js/excel.js', 'js/excel-ui.js', 'js/auth-ui.js', 'js/admin-ui.js', 'js/pwa.js', 'js/photos.js', 'js/progress.js', 'js/model3d.js', 'js/dxf.js',
  'js/map/index.js', 'js/map/base.js', 'js/map/kakao.js', 'js/map/osm.js',
  'js/drawings.js', 'js/sheet-list.js', 'js/book-upload.js', 'js/ai-read.js', 'js/model-build.js', 'js/store-bim.js', 'js/docs-ui.js', 'js/docs-read.js',
  'js/cad/decode.js', 'js/cad/parse.js', 'js/cad/geom.js', 'js/cad/walk.js', 'js/cad/sheets.js', 'js/cad/flatten.js', 'js/cad/tables.js',
  'js/cad/digest.js', 'js/cad/triage.js', 'js/cad/dwg.js', 'js/cad/classify.js', 'js/cad/render.js', 'js/cad/read.js', 'js/cad/worker.js', 'js/cad/layer-names.js', 'js/cad/xref.js', 'js/cad/book.js', 'js/cad/unzip.js', 'js/cad/dwg-worker.js',
  'js/bim/jsonschema.js', 'js/bim/triage-core.js', 'js/bim/triage-run.js', 'js/bim/sheet-viewer.js', 'js/bim/sheet-mode.js', 'js/bim/ai-schemas.js', 'js/bim/materials-ko.js', 'js/bim/rule-read.js', 'js/bim/rooms-raster.js', 'js/bim/mirror-names.js', 'js/bim/dim-zones.js',
  'js/bim/build.js', 'js/bim/build-worker.js', 'js/bim/walls.js', 'js/bim/openings.js', 'js/bim/spaces.js', 'js/bim/units.js', 'js/bim/levels.js',
  'js/bim/site.js', 'js/bim/align.js', 'js/bim/finishes.js', 'js/bim/ids.js', 'js/bim/schemas.js',
  'js/bim/checks.js', 'js/bim/locate.js', 'js/bim/findings-ui.js',
  'js/bim/mesh-calc.js', 'js/bim/materials-3d.js', 'js/bim/mesh-site.js', 'js/bim/mesh-building.js', 'js/bim/mesh-unit.js',
  'js/bim/clip.js', 'js/bim/picking.js', 'js/bim/model-panel.js', 'js/bim/viewer.js', 'js/bim/site-place.js', 'js/bim/room-tidy.js', 'js/bim/material-kinds.js', 'js/bim/parts.js', 'js/bim/section-view.js',
  'js/bim/validate.js', 'js/bim/edit-ops.js', 'js/bim/edit.js', 'js/bim/review-ui.js', 'js/bim/upgrade.js', 'js/bim/doc-core.js', 'js/bim/doc-apply.js', 'js/bim/doc-checks.js', 'js/bim/facade.js', 'js/bim/site-detail.js', 'js/bim/mesh-facade.js', 'js/bim/pbr.js', 'js/bim/sun.js', 'js/bim/measure.js', 'js/bim/render.js', 'js/bim/real-ui.js', 'js/bim/render-scene.js', 'js/bim/export-gltf.js',
  'js/bim/detail-keys.js', 'js/bim/read-section.js', 'js/bim/read-detail.js', 'js/bim/read-structure.js', 'js/bim/struct-place.js', 'js/bim/details.js', 'js/cad/detail-words.js', 'js/bim/doc-spec.js', 'js/bim/takeoff.js', 'js/bim/takeoff-ui.js', 'js/bim/cost-core.js', 'js/bim/cost-link.js', 'js/bim/cost-calc.js', 'js/bim/cost-ui.js', 'js/bim/public-checks.js', 'js/ops/calc/public-data.js', 'js/public-ui.js',
  'js/rules-base.js', 'js/store-ops.js', 'js/sample-ops.js',
  'js/ops/index.js', 'js/ops/kinds.js', 'js/ops/rules.js', 'js/ops/langs.js', 'js/ops/daily.js', 'js/ops/ecard.js', 'js/ops/attach.js', 'js/ops/blur.js', 'js/ops/outbox.js', 'js/ops/notices.js', 'js/ops/print.js', 'js/ops/settings.js', 'js/ops/ai.js',
  'js/ops/schedule-ui.js', 'js/ops/schedule/core.js', 'js/ops/schedule/trades.js', 'js/ops/schedule/match.js', 'js/ops/schedule/xml.js', 'js/ops/schedule/zip.js', 'js/ops/schedule/xlsx.js',
  'js/ops/schedule/read.js', 'js/ops/schedule/read-standard.js', 'js/ops/schedule/read-table.js', 'js/ops/schedule/read-barchart.js', 'js/ops/schedule/read-mspdi.js', 'js/ops/schedule/read-xer.js', 'js/ops/schedule/read-pdf.js', 'js/ops/schedule/template.js', 'js/ops/schedule/compare.js',
  'js/ops/calc/weather.js', 'js/ops/calc/digest.js', 'js/ops/calc/alerts.js', 'js/ops/calc/manpower.js', 'js/ops/calc/flow.js', 'js/ops/calc/blur.js', 'js/ops/calc/exif.js',
  'vendor/mediapipe/blaze_face_short_range.tflite',
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
