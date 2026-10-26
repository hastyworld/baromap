// 화면: 지도 + 정보 패널(현장 개요 / 숙소 상세), 검색, 계약 만료 알림, 메뉴
import { CFG, kakaoKey, store, initStore, state, q, ui, ROLE_LABEL } from './ctx.js';
import { sampleData } from './sample.js';
import { todayStr, siteProgress, leaseStatus, occupancy, distanceM } from './model.js';
import { createMap } from './map/index.js';
import { setGeoMode, geoMode, nearbyPlaces, links } from './geo.js';
import {
  $, esc, icon, fmtDate, fmtDistance, telHref, onAction, toast, confirmDialog, copyText, download, debounce,
  openModal, closeModal,
} from './util.js';
import { siteDialog, lodgingDialog, residentDialog, settingsDialog } from './forms.js';
import { excelDialog, exportExcel } from './excel-ui.js';
import { initPwa, install, canInstall } from './pwa.js';
import { ensureSignedIn, accountDialog } from './auth-ui.js';
import { usersDialog, auditDialog, pendingCount } from './admin-ui.js';
import { photoLabel } from './photos.js';

let map = null;
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const today = () => todayStr();
const SITE_KEY = 'baromap.siteId';
const CAT_ICON = { HP8: 'hospital', PM9: 'pill', CS2: 'store' };
const RANK_ORDER = ['전무', '상무', '이사', '부장', '차장', '과장', '대리', '주임', '사원', '반장', '기능공'];
const byName = (a, b) => a.name.localeCompare(b.name, 'ko');

// ---------------------------------------------------------------- 시작

async function boot() {
  document.title = CFG.serviceName;
  $('#svc-name').textContent = CFG.serviceName;
  initPwa();
  try {
    await initStore();
  } catch (err) {
    document.body.innerHTML = `<div class="fatal">${icon('alert')}<p>바로맵을 시작하지 못했습니다.<br><small>${esc(err.message)}</small></p><button class="btn" onclick="location.reload()">다시 시도</button></div>`;
    return;
  }
  document.body.dataset.mode = store.mode;
  if (store.mode === 'remote') {
    if (!(await ensureSignedIn())) return;
  } else {
    try {
      await store.load({ sampleFactory: sampleData });
    } catch (err) {
      toast(err.message, 'crit');
    }
  }
  startApp();
}

function startApp() {
  state.data = store.snapshot();
  let saved = null;
  try { saved = localStorage.getItem(SITE_KEY); } catch { /* 저장소 차단 */ }
  state.siteId = q.site(saved) ? saved : state.data.sites[0]?.id || null;
  store.subscribe(onDataChange);
  render();
  initMap();
  leaseToastOnce();
}

function onDataChange() {
  // 공유 모드에서 관리자가 내 권한을 승인 대기로 바꾸면 처음 화면으로
  if (store.mode === 'remote' && !store.can('view')) {
    location.reload();
    return;
  }
  state.data = store.snapshot();
  if (state.siteId && !q.site(state.siteId)) {
    state.siteId = state.data.sites[0]?.id || null;
    state.view = 'site';
  }
  if (!state.siteId && state.data.sites.length) state.siteId = state.data.sites[0].id;
  if (state.lodgingId && !q.lodging(state.lodgingId)) {
    state.lodgingId = null;
    state.view = 'site';
  }
  render();
}

async function initMap() {
  try {
    map = await createMap($('#map'), {
      kakaoKey: kakaoKey(),
      onClick: onMapClick,
      onFallback: (msg) => toast(msg, 'warn'),
    });
  } catch (err) {
    $('#map').innerHTML = `<div class="map-error">${icon('alert')}<p>지도를 불러오지 못했습니다.<br><small>${esc(err.message)}</small></p></div>`;
    return;
  }
  setGeoMode(map.kind === 'kakao' ? 'kakao' : 'osm');
  $('#mapwrap').dataset.mode = map.kind;
  const badge = $('#mode-badge');
  badge.hidden = map.kind === 'kakao';
  badge.innerHTML = `${icon('alert')}<span>데모 지도 · 카카오 키를 넣으면 카카오맵으로 바뀝니다</span><button type="button" class="link" data-act="settings">지도 설정</button>`;
  render();
  fitAll();
  if (state.siteId) loadNearby(state.siteId);
  let last = '';
  new ResizeObserver(debounce(() => {
    const el = $('#map');
    const size = `${el.clientWidth}x${el.clientHeight}`;
    if (!el.clientWidth || size === last) return;
    last = size;
    map.relayout();
  }, 120)).observe($('#map'));
}

// ---------------------------------------------------------------- 선택·이동

function selectSite(id, { fit = true } = {}) {
  if (!q.site(id)) return;
  state.siteId = id;
  state.lodgingId = null;
  state.view = 'site';
  state.nearbyShow = false;
  try { localStorage.setItem(SITE_KEY, id); } catch { /* 무시 */ }
  if (isMobile() && state.sheet === 'mini') setSheet('peek');
  render();
  $('#panel-body').scrollTop = 0;
  if (fit) fitAll();
  loadNearby(id);
}

function selectLodging(id, { fit = true } = {}) {
  const l = q.lodging(id);
  if (!l) return;
  state.siteId = l.siteId;
  state.lodgingId = id;
  state.view = 'lodging';
  if (isMobile() && state.sheet === 'mini') setSheet('peek');
  render();
  $('#panel-body').scrollTop = 0;
  if (fit && map) map.fit([l, q.site(l.siteId)].filter(Boolean), pad());
}

function pad() {
  if (isMobile()) {
    const h = $('#panel').getBoundingClientRect().height;
    return { top: 64, right: 36, bottom: h + 24, left: 36 };
  }
  return { top: 100, right: 60, bottom: $('#mode-badge').hidden ? 50 : 80, left: 60 };
}

function fitAll() {
  if (!map) return;
  const s = q.site(state.siteId);
  if (s) map.fit([s, ...q.lodgingsOf(s.id)], pad());
  else if (state.data.sites.length) map.fit(state.data.sites, pad());
}

Object.assign(ui, {
  render,
  selectSite,
  selectLodging,
  syncMap,
  focus: (lat, lng) => map?.focus(lat, lng),
  startPicking,
});

onAction('go-site', () => {
  const s = q.site(state.siteId);
  if (s && map) map.focus(s.lat, s.lng);
});
onAction('fit-all', () => fitAll());
onAction('sel-site', (el) => selectSite(el.dataset.id));
onAction('sel-lodging', (el) => selectLodging(el.dataset.id));
onAction('back-site', () => selectSite(state.siteId, { fit: true }));

document.addEventListener('change', (e) => {
  if (e.target.id === 'site-select') selectSite(e.target.value);
});

// ---------------------------------------------------------------- 지도 마커

function siteMarker(s, { cur, sel }) {
  return `<button type="button" class="mk mk-site${cur ? ' cur' : ' dim'}${sel ? ' sel' : ''}" aria-label="현장 ${esc(s.name)}">
    <span class="mk-pin">${icon('hardhat')}</span><span class="mk-label">${esc(s.name)}</span></button>`;
}

function lodgingMarker(l, o, sel) {
  return `<button type="button" class="mk mk-lodging${sel ? ' sel' : ''}" aria-label="숙소 ${esc(l.name)}, ${o.n}명 거주">
    <span class="mk-pin">${icon('house')}</span><span class="mk-label">${esc(l.name)} · <b class="occ-${o.level}">${o.n}명</b></span></button>`;
}

function syncMap() {
  if (!map) return;
  const site = q.site(state.siteId);
  const items = [];
  for (const s of state.data.sites) {
    const cur = s.id === state.siteId;
    items.push({
      key: `s${s.id}`, lat: s.lat, lng: s.lng, z: cur ? 50 : 20,
      html: siteMarker(s, { cur, sel: cur && state.view === 'site' }),
      onClick: () => { if (!state.picking) selectSite(s.id, { fit: !cur }); },
    });
  }
  const lines = [];
  const circles = [];
  if (site) {
    for (const l of q.lodgingsOf(site.id)) {
      const sel = state.view === 'lodging' && state.lodgingId === l.id;
      const o = occupancy(l.capacity, q.residentsOf(l.id).length);
      items.push({
        key: `l${l.id}`, lat: l.lat, lng: l.lng, z: sel ? 60 : 40,
        html: lodgingMarker(l, o, sel),
        onClick: () => { if (!state.picking) selectLodging(l.id, { fit: false }); },
      });
      lines.push({ path: [[site.lat, site.lng], [l.lat, l.lng]], color: '#1C7ED6', dashed: !sel, weight: sel ? 3 : 2, opacity: sel ? 0.95 : 0.65 });
    }
    const near = nearbyCache(site)?.[state.nearbyCode];
    if (state.nearbyShow && Array.isArray(near)) {
      circles.push({ lat: site.lat, lng: site.lng, radius: CFG.nearbyRadius, color: '#2B8A3E' });
      for (const [i, p] of near.entries()) {
        items.push({
          key: `n${state.nearbyCode}${i}`, lat: p.lat, lng: p.lng, z: 30,
          html: `<a class="mk mk-near" href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="${esc(p.name)}"><span class="mk-pin">${icon(CAT_ICON[state.nearbyCode] || 'pin')}</span><span class="mk-label">${esc(p.name)}</span></a>`,
        });
      }
    }
  }
  if (state.temp) {
    const kind = state.temp.kind === 'sites' ? 'site' : 'lodging';
    items.push({
      key: 'temp', lat: state.temp.lat, lng: state.temp.lng, z: 100,
      html: `<div class="mk mk-temp ${kind}"><span class="mk-pin">${icon(kind === 'site' ? 'hardhat' : 'house')}</span><span class="mk-label">지정한 위치</span></div>`,
    });
  }
  map.setMarkers(items);
  map.setShapes({ lines, circles });
  map.setPicking(Boolean(state.picking));
}

// ---------------------------------------------------------------- 지도에서 위치 지정 (대화상자에서 호출)

function startPicking({ kind, onPick, onCancel }) {
  state.picking = { kind, onPick, onCancel };
  if (isMobile()) setSheet('mini');
  renderPickBanner();
  syncMap();
}

function stopPicking() {
  state.picking = null;
  renderPickBanner();
  syncMap();
}

function renderPickBanner() {
  const el = $('#pick-banner');
  el.hidden = !state.picking;
  if (state.picking) {
    el.innerHTML = `${icon('target')}<span>지도를 눌러 ${state.picking.kind === 'sites' ? '현장' : '숙소'} 위치를 지정하세요</span><button type="button" class="btn sm" data-act="pick-cancel">취소</button>`;
  }
}

function onMapClick(lat, lng) {
  if (!state.picking) return;
  const { onPick } = state.picking;
  stopPicking();
  if (isMobile()) setSheet('peek');
  onPick(lat, lng);
}

onAction('pick-cancel', () => {
  const cancel = state.picking?.onCancel;
  stopPicking();
  if (isMobile()) setSheet('peek');
  cancel?.();
});

// ---------------------------------------------------------------- 패널

function render() {
  renderPanel();
  renderAlertCount();
  renderSampleBar();
  renderSync();
  syncMap();
}

function renderPanel() {
  const body = $('#panel-body');
  if (!state.data.sites.length) body.innerHTML = emptyView();
  else if (state.view === 'lodging' && q.lodging(state.lodgingId)) body.innerHTML = lodgingView(q.lodging(state.lodgingId));
  else body.innerHTML = siteView(q.site(state.siteId) || state.data.sites[0]);
  if (state.flashResident) {
    const row = document.getElementById(`res-${state.flashResident}`);
    state.flashResident = null;
    if (row) {
      row.classList.add('flash');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

function emptyView() {
  if (!store.can('createSite')) {
    return `<div class="empty-view">
      <h2>아직 등록된 현장이 없습니다</h2>
      <p class="muted">관리자가 현장을 등록하면 여기에 바로 나타납니다.</p>
    </div>`;
  }
  const local = store.mode === 'local';
  return `<div class="empty-view">
    <h2>현장을 등록해 시작하세요</h2>
    <p class="muted">현장 → 숙소 → 거주자 순서로 등록합니다. 주소를 고르면 지도에 바로 표시됩니다.</p>
    <div class="stack">
      <button type="button" class="btn primary" data-act="add-site">${icon('plus')}현장 등록</button>
      <button type="button" class="btn" data-act="excel-import">${icon('table')}엑셀로 한 번에 등록</button>
      ${local ? `<button type="button" class="btn ghost" data-act="reset-sample">${icon('refresh')}가상 예시 데이터 불러오기</button>` : ''}
    </div>
    <p class="muted small">${icon('alert')}${local
      ? '지금은 데이터가 이 브라우저에만 저장되는 데모 모드입니다. 모든 사람과 함께 쓰려면 README의 "공유 모드 켜기"를 따라 설정하세요.'
      : '등록한 내용은 승인된 모든 사용자에게 실시간으로 보입니다.'}</p>
  </div>`;
}

function siteSelect() {
  const opts = [...state.data.sites].sort(byName)
    .map((s) => `<option value="${esc(s.id)}" ${s.id === state.siteId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  return `<div class="panel-top">
    <label class="site-select"><span class="sr-only">현장 선택</span>${icon('hardhat')}<select id="site-select">${opts}</select></label>
    ${store.can('createSite') ? `<button type="button" class="btn sm" data-act="add-site" title="현장 추가">${icon('plus')}현장</button>` : ''}
  </div>`;
}

const canEdit = (siteId) => store.can('edit', siteId);

const kv = (label, value) => (value ? `<div class="kv"><dt>${label}</dt><dd>${value}</dd></div>` : '');

function phoneLinks(phone, label = '연락처') {
  if (!phone) return '';
  return `<span class="phone"><a class="tel" href="${telHref(phone)}">${icon('phone')}${esc(phone)}</a>
    <button type="button" class="icon-btn xs" data-act="copy" data-text="${esc(phone)}" aria-label="${label} 복사" title="복사">${icon('copy')}</button></span>`;
}

function openIn(p, { roadview = true } = {}) {
  return `<div class="open-in"><span class="muted small">지도 앱에서 열기</span>
    <a class="chip-link" href="${links.kakao(p)}" target="_blank" rel="noopener">카카오맵</a>
    <a class="chip-link" href="${links.naver(p)}" target="_blank" rel="noopener">네이버지도</a>
    <a class="chip-link" href="${links.google(p)}" target="_blank" rel="noopener">구글지도</a>
    ${roadview ? `<a class="chip-link" href="${links.roadview(p)}" target="_blank" rel="noopener">로드뷰</a>` : ''}</div>`;
}

// ---- 현장 둘러보기: 360° 사진(최근 촬영 크게) + 로드뷰. 사진 목록은 현장을 열 때 받는다.

const photoErrors = {};
const photoLoading = new Set();

async function loadPhotos(siteId) {
  if (!store.photos || photoLoading.has(siteId)) return;
  photoLoading.add(siteId);
  delete photoErrors[siteId];
  try {
    await store.photos.list(siteId);
  } catch (err) {
    photoErrors[siteId] = err.message;
    if (state.siteId === siteId) renderPanel();
  } finally {
    photoLoading.delete(siteId);
  }
}
onAction('photo-retry', () => loadPhotos(state.siteId));

function tourBlock(s) {
  if (!store.photos) return '';
  const photos = store.photos.cached(s.id);
  const err = photoErrors[s.id];
  if (photos === undefined && !err) queueMicrotask(() => loadPhotos(s.id));
  const kakao = geoMode() === 'kakao';
  const editable = canEdit(s.id);
  const list = photos || [];
  if (photos && !list.length && !kakao && !editable) return '';
  const [first, ...rest] = list;
  const hero = first
    ? `<button type="button" class="tour-hero" data-act="photo-open" data-id="${esc(first.id)}" aria-label="360° 사진 보기 ${esc(photoLabel(first))}">
        ${first.thumb ? `<img src="${esc(first.thumb)}" alt="">` : ''}
        <span class="tour-play">${icon('globe')}현장 둘러보기</span>
        <span class="tour-cap">${esc(photoLabel(first))}</span></button>`
    : photos && editable
      ? `<div class="tour-empty">${icon('camera')}<span>360° 사진을 올리면 지도 대신 현장을 그대로 둘러볼 수 있어요.</span></div>`
      : '';
  const strip = rest.length
    ? `<div class="tour-strip">${rest.map((p) => `<button type="button" class="tour-thumb" data-act="photo-open" data-id="${esc(p.id)}" title="${esc(photoLabel(p))}">
        ${p.thumb ? `<img src="${esc(p.thumb)}" alt="">` : ''}<span>${esc(p.takenAt ? fmtDate(p.takenAt) : '날짜 없음')}</span></button>`).join('')}</div>`
    : '';
  let status = '';
  if (err) status = `<span class="t-warn small">${icon('alert')}사진을 불러오지 못했습니다</span><button type="button" class="link small" data-act="photo-retry">다시 시도</button>`;
  else if (!photos) status = '<span class="muted small loading">사진 확인 중…</span>';
  else if (!list.length && !editable) status = '<span class="muted small">아직 360° 사진이 없습니다</span>';
  return `<div class="tour">${hero}${strip}
    <div class="tour-actions">
      ${kakao ? `<button type="button" class="btn sm" data-act="roadview">${icon('street')}로드뷰</button>` : ''}
      ${editable ? `<button type="button" class="btn sm ${first ? '' : 'primary'}" data-act="photo-add">${icon('camera')}360° 사진 올리기</button>` : ''}
      ${status}
    </div>
  </div>`;
}

function progressBlock(s) {
  const p = siteProgress(s, today());
  if (p.state === 'unknown') {
    if (s.endDate) return `<div class="progress"><div class="progress-head"><span>준공 예정 ${fmtDate(s.endDate)}</span>${p.toEnd >= 0 ? `<b>D-${p.toEnd}</b>` : `<b>${-p.toEnd}일 지남</b>`}</div></div>`;
    return '<p class="muted small">착공일과 준공 예정일을 입력하면 공기 경과율이 표시됩니다.</p>';
  }
  const head = {
    before: `<span>착공 전</span><b>착공까지 ${p.toStart}일</b>`,
    ongoing: `<span>공기 경과 <b>${p.pct}%</b></span><b>준공 ${p.toEnd === 0 ? 'D-day' : `D-${p.toEnd}`}</b>`,
    done: `<span>공기 경과 100%</span><b>준공 예정일 ${-p.toEnd}일 지남</b>`,
  }[p.state];
  return `<div class="progress ${p.state}">
    <div class="progress-head">${head}</div>
    <div class="bar" role="img" aria-label="공기 경과 ${p.pct}%"><span style="width:${p.pct}%"></span></div>
    <div class="progress-dates"><span>착공 ${fmtDate(s.startDate)}</span><span>준공 예정 ${fmtDate(s.endDate)}</span></div>
  </div>`;
}

function occBadge(o) {
  if (o.level === 'over') return `<span class="badge crit">${icon('alert')}정원 초과 ${-o.free}명</span>`;
  if (o.level === 'full') return '<span class="badge info">만실</span>';
  if (o.level === 'ok') return `<span class="badge ok">빈자리 ${o.free}</span>`;
  return '';
}

function leaseBadge(leaseEnd, { always = false } = {}) {
  const st = leaseStatus(leaseEnd, today(), CFG.leaseAlertDays);
  if (st.level === 'expired') return `<span class="badge crit">${icon('alert')}계약 만료 ${-st.d}일 지남</span>`;
  if (st.level === 'soon') return `<span class="badge warn">${icon('clock')}계약 ${st.d === 0 ? '오늘 만료' : `만료 D-${st.d}`}</span>`;
  if (always && st.level === 'ok') return `<span class="badge plain">D-${st.d}</span>`;
  return '';
}

function siteView(s) {
  const lodgings = q.lodgingsOf(s.id)
    .map((l) => ({ l, d: distanceM(s, l), o: occupancy(l.capacity, q.residentsOf(l.id).length) }))
    .sort((a, b) => a.d - b.d);
  const people = lodgings.reduce((a, x) => a + x.o.n, 0);
  const cap = lodgings.reduce((a, x) => a + x.o.cap, 0);
  return `${siteSelect()}
    <article class="card site-card">
      <header class="card-head">
        <span class="pin-ic site">${icon('hardhat')}</span>
        <div class="card-title"><h2>${esc(s.name)}</h2><p class="addr">${esc(s.address) || '<span class="muted">주소 미입력</span>'}</p></div>
        <div class="card-actions">
          ${canEdit(s.id) ? `<button type="button" class="icon-btn" data-act="edit-site" data-id="${esc(s.id)}" aria-label="현장 수정" title="수정">${icon('edit')}</button>` : ''}
          ${store.can('deleteSite') ? `<button type="button" class="icon-btn" data-act="del-site" data-id="${esc(s.id)}" aria-label="현장 삭제" title="삭제">${icon('trash')}</button>` : ''}
        </div>
      </header>
      ${tourBlock(s)}
      ${progressBlock(s)}
      <dl class="kvs">
        ${kv('발주처', esc(s.client))}
        ${kv('현장소장', esc(s.manager))}
        ${kv('현장사무실', phoneLinks(s.phone, '현장사무실 연락처'))}
      </dl>
      ${s.overview ? `<div class="text-block"><h3>공사 개요</h3><p>${esc(s.overview)}</p></div>` : ''}
      ${s.memo ? `<div class="text-block memo"><h3>메모</h3><p>${esc(s.memo)}</p></div>` : ''}
      ${openIn(s, { roadview: geoMode() !== 'kakao' })}
    </article>

    <div class="stats">
      <div><span>숙소</span><b>${lodgings.length}<small>곳</small></b></div>
      <div><span>거주</span><b>${people}<small>명</small></b></div>
      <div><span>정원</span><b>${cap || '-'}<small>${cap ? '명' : ''}</small></b></div>
    </div>

    ${nearbySection(s)}

    <section class="sec">
      <div class="sec-head"><h3>숙소 <small>현장에서 가까운 순</small></h3><span class="spacer"></span>
        ${canEdit(s.id) ? `<button type="button" class="btn sm" data-act="add-lodging">${icon('plus')}숙소</button>` : ''}</div>
      ${lodgings.length ? `<div class="cards">${lodgings.map(({ l, d, o }) => `
        <button type="button" class="lodging-item" data-act="sel-lodging" data-id="${esc(l.id)}">
          <span class="pin-ic lodging sm">${icon('house')}</span>
          <span class="li-main">
            <span class="li-title">${esc(l.name)}</span>
            <span class="li-sub">${[l.type, l.addressDetail].filter(Boolean).map(esc).join(' · ') || esc(l.address)}</span>
            <span class="li-meta"><span class="dist">${icon('route')}직선 ${fmtDistance(d)}</span>
              <span class="occ occ-${o.level}">${icon('users')}${o.n}${o.cap ? `/${o.cap}` : ''}명</span>
              ${occBadge(o)}${leaseBadge(l.leaseEnd)}</span>
          </span>
        </button>`).join('')}</div>` : `<p class="empty">아직 등록된 숙소가 없습니다.${canEdit(s.id) ? ' <button type="button" class="link" data-act="add-lodging">숙소 등록</button>' : ''}</p>`}
    </section>`;
}

// ---- 현장 주변 시설 (카카오맵 모드에서만)

function nearbyCache(s) {
  return state.nearby[`${s.id}@${s.lat},${s.lng}`];
}

async function loadNearby(siteId) {
  if (geoMode() !== 'kakao') return;
  const s = q.site(siteId);
  if (!s) return;
  const key = `${s.id}@${s.lat},${s.lng}`;
  const cache = (state.nearby[key] ||= {});
  const todo = CFG.nearbyCategories.filter((c) => !cache[c.code]);
  if (!todo.length) return;
  for (const c of todo) cache[c.code] = 'loading';
  renderPanel();
  await Promise.all(todo.map(async (c) => {
    try {
      cache[c.code] = await nearbyPlaces(s.lat, s.lng, c.code, CFG.nearbyRadius);
    } catch (err) {
      cache[c.code] = { error: err.message };
    }
  }));
  if (state.siteId === siteId && state.view === 'site') renderPanel();
  syncMap();
}

function nearbySection(s) {
  if (geoMode() !== 'kakao') return '';
  const cache = nearbyCache(s) || {};
  const cur = cache[state.nearbyCode];
  const count = (v) => (Array.isArray(v) ? (v.length >= 15 ? '15+' : v.length) : '…');
  let list = '';
  if (cur === 'loading' || !cur) list = '<p class="muted small loading">찾는 중…</p>';
  else if (cur.error) list = `<p class="t-warn small">${esc(cur.error)}</p>`;
  else if (!cur.length) list = '<p class="muted small">반경 안에 없습니다.</p>';
  else {
    list = `<ul class="near-list">${cur.slice(0, 5).map((p) => `<li>
      <a href="${esc(p.url)}" target="_blank" rel="noopener" class="near-name">${esc(p.name)}</a>
      <span class="muted small">${fmtDistance(p.distance)}</span>
      ${p.phone ? `<a class="tel small" href="${telHref(p.phone)}">${icon('phone')}${esc(p.phone)}</a>` : ''}</li>`).join('')}</ul>`;
  }
  return `<section class="sec">
    <div class="sec-head"><h3>현장 주변 시설 <small>반경 ${CFG.nearbyRadius / 1000}km</small></h3><span class="spacer"></span>
      <button type="button" class="btn sm ${state.nearbyShow ? 'on' : 'ghost'}" data-act="nearby-show" aria-pressed="${state.nearbyShow}">${icon('map')}지도에 표시</button></div>
    <div class="seg" role="tablist">${CFG.nearbyCategories.map((c) => `
      <button type="button" role="tab" aria-selected="${c.code === state.nearbyCode}" class="${c.code === state.nearbyCode ? 'on' : ''}" data-act="nearby-cat" data-code="${c.code}">
        ${icon(CAT_ICON[c.code] || 'pin')}${esc(c.label)} <b>${count(cache[c.code])}</b></button>`).join('')}</div>
    ${list}
  </section>`;
}

onAction('nearby-cat', (el) => {
  state.nearbyCode = el.dataset.code;
  renderPanel();
  syncMap();
});
onAction('nearby-show', () => {
  state.nearbyShow = !state.nearbyShow;
  renderPanel();
  syncMap();
  const s = q.site(state.siteId);
  const near = s && nearbyCache(s)?.[state.nearbyCode];
  if (state.nearbyShow && map && Array.isArray(near)) map.fit([s, ...near], pad());
});

// ---- 숙소 상세

function sortResidents(list) {
  const r = (x) => { const i = RANK_ORDER.indexOf(x.rank); return i < 0 ? 99 : i; };
  return [...list].sort((a, b) => r(a) - r(b) || byName(a, b));
}

function lodgingView(l) {
  const s = q.site(l.siteId);
  const people = sortResidents(q.residentsOf(l.id));
  const o = occupancy(l.capacity, people.length);
  const d = s ? distanceM(s, l) : null;
  const pct = o.cap ? Math.min(100, Math.round((o.n / o.cap) * 100)) : 0;
  const route = (mode, label, ic) => (s ? `<a class="btn sm" href="${links.kakaoRoute(mode, l, s)}" target="_blank" rel="noopener">${icon(ic)}${label}</a>` : '');
  return `<div class="panel-top">
      <button type="button" class="back" data-act="back-site">${icon('back')}<span>${esc(s?.name || '현장')}</span></button>
    </div>
    <article class="card lodging-card">
      <header class="card-head">
        <span class="pin-ic lodging">${icon('house')}</span>
        <div class="card-title">
          <h2>${esc(l.name)}</h2>
          <p class="addr">${esc(l.address)}${l.addressDetail ? ` <b>${esc(l.addressDetail)}</b>` : ''}</p>
          <div class="badges">${l.type ? `<span class="badge lodging">${esc(l.type)}</span>` : ''}${occBadge(o)}${leaseBadge(l.leaseEnd)}</div>
        </div>
        ${canEdit(l.siteId) ? `<div class="card-actions">
          <button type="button" class="icon-btn" data-act="edit-lodging" data-id="${esc(l.id)}" aria-label="숙소 수정" title="수정">${icon('edit')}</button>
          <button type="button" class="icon-btn" data-act="del-lodging" data-id="${esc(l.id)}" aria-label="숙소 삭제" title="삭제">${icon('trash')}</button>
        </div>` : ''}
      </header>
      ${s ? `<div class="route-box">
        <div class="route-dist">${icon('route')}<span>현장까지 직선 <b>${fmtDistance(d)}</b></span></div>
        <div class="route-btns">${route('car', '자동차', 'car')}${route('traffic', '대중교통', 'bus')}${route('walk', '도보', 'walk')}</div>
        <p class="muted small">버튼을 누르면 카카오맵 길찾기가 열립니다.</p>
      </div>` : ''}
      <dl class="kvs">
        ${kv('정원', o.cap ? `<span class="occ-line"><span class="bar small ${o.level === 'over' ? 'over' : ''}"><span style="width:${pct}%"></span></span>거주 ${o.n} / 정원 ${o.cap}명</span>` : `거주 ${o.n}명 <span class="muted">(정원 미입력)</span>`)}
        ${kv('계약 종료', l.leaseEnd ? `${fmtDate(l.leaseEnd)} ${leaseBadge(l.leaseEnd, { always: true })}` : '')}
      </dl>
      ${l.memo ? `<div class="text-block memo"><h3>메모</h3><p>${esc(l.memo)}</p></div>` : ''}
      ${openIn(l)}
    </article>

    <section class="sec">
      <div class="sec-head"><h3>거주자 <small>${people.length}명</small></h3><span class="spacer"></span>
        ${canEdit(l.siteId) ? `<button type="button" class="btn sm" data-act="add-resident">${icon('plus')}거주자</button>` : ''}</div>
      ${people.length ? `<ul class="people">${people.map((r) => personRow(r, canEdit(l.siteId))).join('')}</ul>` : `<p class="empty">거주자가 없습니다.${canEdit(l.siteId) ? ' <button type="button" class="link" data-act="add-resident">거주자 등록</button>' : ''}</p>`}
    </section>`;
}

function personRow(r, editable) {
  return `<li class="person" id="res-${esc(r.id)}">
    <div class="avatar" aria-hidden="true">${esc(r.name.slice(0, 1))}</div>
    <div class="person-main">
      <div class="person-name"><b>${esc(r.name)}</b>${r.rank ? `<span class="rank">${esc(r.rank)}</span>` : ''}${r.title ? `<span class="tag">${esc(r.title)}</span>` : ''}</div>
      <div class="person-sub">${[r.dept, r.moveIn ? `입주 ${fmtDate(r.moveIn)}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
      ${phoneLinks(r.phone, `${r.name} 연락처`)}
      ${r.memo ? `<div class="person-memo">${esc(r.memo)}</div>` : ''}
    </div>
    ${editable ? `<div class="person-act">
      <button type="button" class="icon-btn sm" data-act="edit-resident" data-id="${esc(r.id)}" aria-label="${esc(r.name)} 수정" title="수정">${icon('edit')}</button>
      <button type="button" class="icon-btn sm" data-act="del-resident" data-id="${esc(r.id)}" aria-label="${esc(r.name)} 삭제" title="삭제">${icon('trash')}</button>
    </div>` : ''}
  </li>`;
}

onAction('copy', async (el) => {
  await copyText(el.dataset.text);
  toast(`복사했습니다: ${el.dataset.text}`);
});

// ---------------------------------------------------------------- 등록·수정·삭제

onAction('add-site', () => siteDialog());
onAction('edit-site', (el) => siteDialog(q.site(el.dataset.id)));
onAction('add-lodging', () => lodgingDialog(null, { siteId: state.siteId }));
onAction('edit-lodging', (el) => lodgingDialog(q.lodging(el.dataset.id)));
onAction('add-resident', () => residentDialog(null, { lodgingId: state.lodgingId }));
onAction('edit-resident', (el) => residentDialog(q.resident(el.dataset.id)));

onAction('del-site', async (el) => {
  const s = q.site(el.dataset.id);
  const ls = q.lodgingsOf(s.id);
  const rs = ls.reduce((a, l) => a + q.residentsOf(l.id).length, 0);
  const ok = await confirmDialog(`"${s.name}" 현장을 삭제할까요?${ls.length ? `\n이 현장의 숙소 ${ls.length}곳과 거주자 ${rs}명 정보도 함께 지워집니다.` : ''}`, { ok: '삭제', danger: true, title: '현장 삭제' });
  if (!ok) return;
  await store.remove('sites', s.id);
  toast('현장을 삭제했습니다.');
});

onAction('del-lodging', async (el) => {
  const l = q.lodging(el.dataset.id);
  const n = q.residentsOf(l.id).length;
  const ok = await confirmDialog(`"${l.name}" 숙소를 삭제할까요?${n ? `\n거주자 ${n}명 정보도 함께 지워집니다.` : ''}`, { ok: '삭제', danger: true, title: '숙소 삭제' });
  if (!ok) return;
  await store.remove('lodgings', l.id);
  toast('숙소를 삭제했습니다.');
});

onAction('del-resident', async (el) => {
  const r = q.resident(el.dataset.id);
  const ok = await confirmDialog(`${r.name} 님의 거주자 정보를 삭제할까요?\n퇴소·전출한 경우 개인정보 보호를 위해 삭제해주세요.`, { ok: '삭제', danger: true, title: '거주자 삭제' });
  if (!ok) return;
  await store.remove('residents', r.id);
  toast('거주자 정보를 삭제했습니다.');
});

// ---------------------------------------------------------------- 검색 (직원 이름·숙소·현장)

let qItems = [];
let qActive = -1;

function searchItems(text) {
  const t = text.trim().toLowerCase();
  if (!t) return [];
  const has = (...v) => v.some((x) => String(x || '').toLowerCase().includes(t));
  const out = [];
  for (const r of state.data.residents) {
    if (!has(r.name, r.phone, r.dept, r.title)) continue;
    const l = q.lodging(r.lodgingId);
    const s = l && q.site(l.siteId);
    out.push({ kind: 'resident', id: r.id, icon: 'user', title: `${r.name} ${r.rank}`.trim(), sub: [l?.name, s?.name].filter(Boolean).join(' · ') });
  }
  for (const l of state.data.lodgings) {
    if (has(l.name, l.address)) out.push({ kind: 'lodging', id: l.id, icon: 'house', title: l.name, sub: q.site(l.siteId)?.name || '' });
  }
  for (const s of state.data.sites) {
    if (has(s.name, s.address, s.manager, s.client)) out.push({ kind: 'site', id: s.id, icon: 'hardhat', title: s.name, sub: s.address });
  }
  return out.slice(0, 12);
}

function renderSearch() {
  const box = $('#q-results');
  const input = $('#q');
  qItems = searchItems(input.value);
  const open = Boolean(input.value.trim()) && document.activeElement === input;
  box.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  if (!open) return;
  const label = { resident: '직원', lodging: '숙소', site: '현장' };
  box.innerHTML = qItems.length
    ? qItems.map((it, i) => `<button type="button" role="option" class="q-item ${i === qActive ? 'active' : ''}" data-act="q-go" data-i="${i}" aria-selected="${i === qActive}">
        <span class="q-ic ${it.kind}">${icon(it.icon)}</span><span class="q-main"><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></span><span class="q-kind">${label[it.kind]}</span></button>`).join('')
    : '<p class="q-empty">검색 결과가 없습니다.</p>';
}

function goSearch(it) {
  if (!it) return;
  const input = $('#q');
  input.value = '';
  input.blur();
  renderSearch();
  if (it.kind === 'site') selectSite(it.id);
  else if (it.kind === 'lodging') selectLodging(it.id);
  else {
    const r = q.resident(it.id);
    state.flashResident = r.id;
    selectLodging(r.lodgingId);
  }
}

document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  qActive = -1;
  renderSearch();
});
document.addEventListener('focusin', (e) => { if (e.target.id === 'q') renderSearch(); });
document.addEventListener('keydown', (e) => {
  if (e.target.id !== 'q') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!qItems.length) return;
    qActive = (qActive + (e.key === 'ArrowDown' ? 1 : -1) + qItems.length) % qItems.length;
    renderSearch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    goSearch(qItems[qActive >= 0 ? qActive : 0]);
  } else if (e.key === 'Escape') {
    e.target.value = '';
    renderSearch();
  }
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.search')) setTimeout(() => { $('#q-results').hidden = true; $('#q').setAttribute('aria-expanded', 'false'); }, 0);
});
onAction('q-go', (el) => goSearch(qItems[Number(el.dataset.i)]));

// ---------------------------------------------------------------- 계약 만료 알림

function leaseAlerts() {
  return state.data.lodgings
    .map((l) => ({ l, st: leaseStatus(l.leaseEnd, today(), CFG.leaseAlertDays) }))
    .filter((x) => x.st.level === 'expired' || x.st.level === 'soon')
    .sort((a, b) => a.st.d - b.st.d);
}

function renderAlertCount() {
  const n = leaseAlerts().length;
  const el = $('#alert-count');
  el.hidden = !n;
  el.textContent = n;
  el.closest('button').setAttribute('aria-label', n ? `계약 만료 알림 ${n}건` : '계약 만료 알림');
}

onAction('alerts', () => {
  const list = leaseAlerts();
  const row = ({ l, st }) => `<li><button type="button" class="row-btn" data-act="alert-go" data-id="${esc(l.id)}">
      <span><b>${esc(l.name)}</b><small>${esc(q.site(l.siteId)?.name || '')} · 계약 종료 ${fmtDate(l.leaseEnd)} · 거주 ${q.residentsOf(l.id).length}명</small></span>
      ${leaseBadge(l.leaseEnd)}</button></li>`;
  const expired = list.filter((x) => x.st.level === 'expired');
  const soon = list.filter((x) => x.st.level === 'soon');
  openModal({
    title: '계약 만료 알림',
    body: list.length ? `
      ${expired.length ? `<h3 class="list-title crit">이미 만료됨 ${expired.length}곳</h3><ul class="rows">${expired.map(row).join('')}</ul>` : ''}
      ${soon.length ? `<h3 class="list-title warn">${CFG.leaseAlertDays}일 안에 만료 ${soon.length}곳</h3><ul class="rows">${soon.map(row).join('')}</ul>` : ''}
      <p class="muted small">연장·해지 후에는 숙소 정보에서 계약 종료일을 바꿔주세요.</p>`
      : `<p class="empty">${icon('check')}${CFG.leaseAlertDays}일 안에 만료되는 숙소 계약이 없습니다.</p>`,
    footer: '<button type="button" class="btn" data-act="modal-close">닫기</button>',
  });
});

onAction('alert-go', (el) => {
  closeModal();
  selectLodging(el.dataset.id);
});

// 하루에 한 번, 만료됐거나 7일 안에 만료되는 계약이 있으면 알려준다.
function leaseToastOnce() {
  const urgent = leaseAlerts().filter((x) => x.st.d <= 7);
  if (!urgent.length) return;
  try {
    if (localStorage.getItem('baromap.leaseToast') === today()) return;
    localStorage.setItem('baromap.leaseToast', today());
  } catch { /* 무시 */ }
  toast(`계약 만료가 임박했거나 지난 숙소가 ${urgent.length}곳 있습니다. 위쪽 종 아이콘에서 확인하세요.`, 'warn');
}

// ---------------------------------------------------------------- 예시 데이터 안내·메뉴

// 위쪽 안내 띠: 데모 모드의 예시 데이터 안내, 공유 모드의 오프라인 안내
function renderSampleBar() {
  const bar = $('#sample-bar');
  if (store.mode === 'remote') {
    const off = store.status === 'offline';
    bar.hidden = !off;
    bar.dataset.kind = 'offline';
    if (off) {
      const at = store.offlineSince ? new Date(store.offlineSince) : null;
      const time = at ? `${at.getMonth() + 1}.${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '';
      bar.innerHTML = `${icon('alert')}<span><b>오프라인</b> — ${time ? `${time}에 받은 ` : '마지막으로 받은 '}데이터를 보여줍니다. 수정은 연결된 뒤에 할 수 있습니다.</span>
        <button type="button" class="btn sm" data-act="refresh">다시 연결</button>`;
    }
    return;
  }
  bar.hidden = !store.isSample || !state.data.sites.length;
  bar.dataset.kind = 'sample';
  bar.innerHTML = `${icon('alert')}<span>지금 보이는 현장·숙소·거주자는 <b>가상 예시 데이터</b>입니다.</span>
    <button type="button" class="btn sm" data-act="clear-sample">예시 지우고 시작하기</button>`;
}

// 공유 모드 연결 상태 표시
function renderSync() {
  const el = $('#sync');
  if (!el) return;
  el.hidden = store.mode !== 'remote';
  if (el.hidden) return;
  const st = { live: ['live', '실시간'], connecting: ['wait', '연결 중'], offline: ['off', '오프라인'], idle: ['wait', '연결 중'] }[store.status] || ['wait', ''];
  el.className = `sync ${st[0]}`;
  el.innerHTML = `<i></i><span>${st[1]}</span>`;
  el.title = st[0] === 'live' ? '다른 사람이 바꾼 내용이 바로 반영됩니다' : '';
}

onAction('refresh', async () => {
  await store.refresh();
  toast(store.status === 'offline' ? '아직 연결되지 않았습니다.' : '최신 데이터를 받았습니다.', store.status === 'offline' ? 'warn' : 'ok');
});

onAction('clear-sample', async () => {
  const ok = await confirmDialog('가상 예시 데이터를 모두 지우고 빈 상태로 시작할까요?', { ok: '지우고 시작', title: '예시 데이터 지우기' });
  if (!ok) return;
  await store.clear();
  toast('예시 데이터를 지웠습니다. 첫 현장을 등록해 보세요.');
});

// 메뉴 항목은 모드(데모/공유)와 권한에 따라 달라진다.
function menuItems() {
  const remote = store.mode === 'remote';
  const admin = store.can('admin');
  const items = [];
  if (!remote || store.can('editAny')) items.push(['excel-import', 'table', '엑셀로 일괄 등록']);
  items.push(['excel-export', 'download', '엑셀로 내보내기'], null);
  items.push(['json-export', 'file', '데이터 파일 내보내기 (JSON)']);
  if (!remote) items.push(['json-import', 'upload', '데이터 파일 가져오기 (JSON)']);
  else if (admin) items.push(['json-import', 'upload', '데이터 파일 합치기 (JSON)']);
  if (remote) {
    items.push(null);
    if (admin) items.push(['users', 'users', '사용자·권한 관리'], ['audit', 'clock', '수정 기록']);
    items.push(['account', 'user', '내 계정']);
  }
  items.push(null);
  if (canInstall()) items.push(['install', 'download', '앱으로 설치']);
  items.push(['settings', 'settings', '지도 설정 (카카오 키)']);
  if (!remote) items.push(['reset-sample', 'refresh', '가상 예시 데이터 불러오기'], ['clear-all', 'trash', '모든 데이터 지우기']);
  else items.push(['logout', 'back', '로그아웃']);
  return items;
}

function toggleMenu(open) {
  const menu = $('#menu');
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $('#menu-btn').setAttribute('aria-expanded', String(show));
  if (!show) return;
  const me = store.me;
  const head = store.mode === 'remote' && me
    ? `<div class="menu-user"><span class="avatar sm">${esc((me.name || me.email).slice(0, 1))}</span>
        <span><b>${esc(me.name || me.email)}</b><small>${esc(me.email)} · ${ROLE_LABEL[me.role] || ''}</small></span></div><hr>`
    : '';
  const note = store.mode === 'remote'
    ? '모든 사용자와 실시간으로 공유됩니다.'
    : '데모 모드: 데이터는 이 브라우저에만 저장됩니다.';
  menu.innerHTML = `${head}${menuItems().map((m) => (m ? `<button type="button" role="menuitem" class="menu-item" data-act="${m[0]}">${icon(m[1])}<span>${m[2]}</span></button>` : '<hr>')).join('')}
    <p class="menu-note">${icon('alert')}${note}<br>지도: ${map?.kind === 'kakao' ? '카카오맵' : '데모 지도(OpenStreetMap)'}</p>`;
  menu.querySelector('button')?.focus();
  if (store.can('admin') && store.mode === 'remote') {
    pendingCount().then((n) => {
      const item = menu.querySelector('[data-act=users] span');
      if (n && item) item.innerHTML = `사용자·권한 관리 <b class="pill-count">승인 대기 ${n}</b>`;
    });
  }
}

onAction('install', () => install());
onAction('users', () => usersDialog());
onAction('audit', () => auditDialog());
onAction('account', () => accountDialog());
onAction('logout', async () => {
  const ok = await confirmDialog('로그아웃할까요?', { ok: '로그아웃', title: '로그아웃' });
  if (!ok) return;
  await store.auth.signOut();
  location.reload();
});

onAction('menu', () => toggleMenu());
document.addEventListener('click', (e) => {
  if (!$('#menu').hidden && !e.target.closest('.menu-wrap')) toggleMenu(false);
  else if (e.target.closest('.menu-item')) toggleMenu(false);
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#menu').hidden) {
    toggleMenu(false);
    $('#menu-btn').focus();
  }
});

onAction('settings', () => settingsDialog(map?.kind));
onAction('excel-import', () => excelDialog());
onAction('excel-export', () => exportExcel());

onAction('json-export', () => {
  const data = store.exportJson();
  download(`바로맵_데이터_${today()}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('데이터 파일을 내려받았습니다.');
});

onAction('json-import', () => $('#json-file').click());
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'json-file' || !e.target.files[0]) return;
  const file = e.target.files[0];
  e.target.value = '';
  try {
    const obj = JSON.parse(await file.text());
    const ok = store.mode === 'remote'
      ? await confirmDialog(`"${file.name}" 파일의 내용을 공유 데이터에 합칠까요?\n같은 항목은 파일 내용으로 바뀌고, 모든 사용자에게 바로 보입니다.`, { ok: '합치기', danger: true, title: '데이터 파일 합치기' })
      : await confirmDialog(`"${file.name}" 파일로 지금 데이터를 모두 바꿀까요?\n먼저 현재 데이터를 내보내 두는 것을 권장합니다.`, { ok: '바꾸기', danger: true, title: '데이터 가져오기' });
    if (!ok) return;
    const r = await store.importJson(obj);
    toast(`가져왔습니다: 현장 ${r.sites} · 숙소 ${r.lodgings} · 거주자 ${r.residents}`);
    fitAll();
  } catch (err) {
    toast(err instanceof SyntaxError ? 'JSON 파일을 읽지 못했습니다.' : err.message, 'crit');
  }
});

onAction('reset-sample', async () => {
  if (state.data.sites.length) {
    const ok = await confirmDialog('지금 데이터를 모두 지우고 가상 예시 데이터로 바꿀까요?', { ok: '바꾸기', danger: true, title: '예시 데이터 불러오기' });
    if (!ok) return;
  }
  await store.resetSample(sampleData);
  state.siteId = state.data.sites[0]?.id || null;
  state.view = 'site';
  render();
  fitAll();
  if (state.siteId) loadNearby(state.siteId);
});

onAction('clear-all', async () => {
  const ok = await confirmDialog('현장·숙소·거주자 데이터를 모두 지울까요? 되돌릴 수 없습니다.', { ok: '모두 지우기', danger: true, title: '모든 데이터 지우기' });
  if (!ok) return;
  await store.clear();
  toast('모든 데이터를 지웠습니다.');
});

// ---------------------------------------------------------------- 휴대폰 정보 시트

function setSheet(s) {
  state.sheet = s;
  const panel = $('#panel');
  panel.dataset.sheet = s;
  panel.style.removeProperty('height');
}

let drag = null;
let suppressClick = false;
document.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.sheet-handle');
  if (!handle || !isMobile()) return;
  const panel = $('#panel');
  drag = { y: e.clientY, h: panel.getBoundingClientRect().height, moved: false };
  panel.classList.add('dragging');
  handle.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y;
  if (Math.abs(dy) > 5) drag.moved = true;
  const max = $('.layout').clientHeight - 40;
  $('#panel').style.height = `${Math.min(max, Math.max(80, drag.h - dy))}px`;
});
document.addEventListener('pointerup', () => {
  if (!drag) return;
  const panel = $('#panel');
  panel.classList.remove('dragging');
  if (drag.moved) {
    suppressClick = true;
    const ratio = panel.getBoundingClientRect().height / $('.layout').clientHeight;
    setSheet(ratio < 0.28 ? 'mini' : ratio < 0.68 ? 'peek' : 'full');
  }
  drag = null;
});
onAction('sheet-toggle', () => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  setSheet(state.sheet === 'full' ? 'peek' : 'full');
});
matchMedia('(max-width: 760px)').addEventListener('change', () => {
  $('#panel').style.removeProperty('height');
  setTimeout(fitAll, 200);
});

boot();
