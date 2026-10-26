// 현장 둘러보기: 360° 사진 올리기·보기(Pannellum)와 카카오 로드뷰. 지도 대신 현장만 화면 가득 보여준다.
import { store, state, q } from './ctx.js';
import { todayStr, panoView, PANO_LABEL, bearingDeg, distanceM } from './model.js';
import { $, esc, icon, fmtDate, fmtDistance, onAction, onForm, openModal, closeModal, toast, confirmDialog, loadScript, loadCss } from './util.js';

const PANNELLUM = 'https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/';
const MAX_SIDE = 4096; // 휴대폰에서도 열리는 크기(대부분의 기기가 4096px까지 그린다)
const ROADVIEW_RADIUS = 300; // 현장에서 이 거리(m) 안의 로드뷰를 찾는다

const KO = {
  loadButtonLabel: '눌러서<br>사진 보기',
  loadingLabel: '불러오는 중…',
  bylineLabel: '',
  noPanoramaError: '사진이 없습니다.',
  fileAccessError: '사진 파일을 불러오지 못했습니다.',
  malformedURLError: '사진 주소가 올바르지 않습니다.',
  iOS8WebGLError: '이 기기에서는 360° 보기를 지원하지 않습니다.',
  genericWebGLError: '이 브라우저에서는 360° 보기를 지원하지 않습니다.',
  textureSizeError: '사진이 이 기기에서 보기에는 너무 큽니다.',
  unknownError: '사진을 표시하지 못했습니다.',
};

export const photoLabel = (p) => [p.takenAt ? fmtDate(p.takenAt) : '날짜 없음', p.caption].filter(Boolean).join(' · ');

// ---------------------------------------------------------------- 사진 줄이기 (올리기 전)

async function decode(file) {
  try {
    return await createImageBitmap(file);
  } catch { /* 예전 Safari 등은 아래 방법으로 */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('사진을 읽지 못했습니다. JPG 사진인지 확인해주세요.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function draw(src, w, h, crop) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const [sx, sy, sw, sh] = crop || [0, 0, src.width, src.height];
  g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return c;
}

const toJpeg = (canvas, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('사진을 변환하지 못했습니다.'))), 'image/jpeg', quality);
});

// 원본은 긴 변 4096px JPG로, 미리보기는 가운데를 2:1로 잘라 640×320으로 만든다.
async function preparePhoto(file) {
  let src;
  try {
    src = await decode(file);
    const W = src.width;
    const H = src.height;
    if (!W || !H) throw new Error('사진 크기를 알 수 없습니다.');
    const scale = Math.min(1, MAX_SIDE / Math.max(W, H));
    const width = Math.max(1, Math.round(W * scale));
    const height = Math.max(1, Math.round(H * scale));
    const blob = await toJpeg(draw(src, width, height), 0.85);
    let cw = W;
    let ch = W / 2;
    if (ch > H) { ch = H; cw = H * 2; }
    const thumb = draw(src, 640, 320, [(W - cw) / 2, (H - ch) / 2, cw, ch]).toDataURL('image/jpeg', 0.72);
    return { file: blob, thumb, width, height };
  } catch (err) {
    if (/사진/.test(err.message)) throw err;
    throw new Error('사진이 너무 커서 이 기기에서 처리하지 못했습니다. 노트북에서 올려주세요.');
  } finally {
    src?.close?.();
  }
}

// ---------------------------------------------------------------- 올리기 대화상자

let pending = null; // { siteId, prepared }

export function photoAddDialog(siteId) {
  const s = q.site(siteId);
  if (!s) return;
  pending = { siteId, prepared: null };
  openModal({
    title: '360° 현장 사진 올리기',
    body: `<form id="f-photo" data-form="photo" novalidate>
      <p class="muted small photo-site">${icon('hardhat')}${esc(s.name)}</p>
      <label class="file-drop">${icon('upload')}<span>사진 선택</span><input type="file" id="photo-file" accept="image/*"></label>
      <div id="photo-preview" class="photo-preview" hidden></div>
      <div class="grid2">
        <label class="field"><span>촬영일</span><input name="takenAt" type="date" value="${todayStr()}"></label>
        <label class="field"><span>설명</span><input name="caption" maxlength="100" placeholder="예) 정문 앞, 3층 슬래브"></label>
      </div>
      <ul class="steps small muted">
        <li><b>360° 카메라 사진</b>(가로:세로 2:1)은 위아래까지 사방을, <b>휴대폰 파노라마</b>는 좌우로 둘러볼 수 있어요.</li>
        <li>큰 사진은 자동으로 줄여서 올립니다(긴 변 4096px).</li>
        <li>사람 얼굴이나 차량 번호가 크게 찍히지 않게 주의해주세요.</li>
      </ul>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button>
      <button type="submit" class="btn primary" form="f-photo" id="photo-submit" disabled>${icon('upload')}올리기</button>`,
    onClose: () => { pending = null; },
  });
}

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'photo-file' || !pending) return;
  const file = e.target.files[0];
  const box = $('#photo-preview');
  const submit = $('#photo-submit');
  pending.prepared = null;
  submit.disabled = true;
  if (!file) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = '<p class="muted small loading">사진을 확인하는 중…</p>';
  const mine = pending;
  try {
    const prepared = await preparePhoto(file);
    if (pending !== mine) return;
    mine.prepared = prepared;
    const v = panoView(prepared.width, prepared.height);
    const hint = { sphere: '사방을 둘러볼 수 있어요', pano: `좌우 ${v.haov}°를 둘러볼 수 있어요`, photo: '360° 사진이 아니라 조금만 둘러볼 수 있어요' }[v.kind];
    box.innerHTML = `<img src="${prepared.thumb}" alt="">
      <div><b>${PANO_LABEL[v.kind]}</b><p class="muted small">${hint}<br>${prepared.width}×${prepared.height} · ${(prepared.file.size / 1048576).toFixed(1)}MB</p></div>`;
    if (file.lastModified) $('#f-photo [name=takenAt]').value = todayStr(new Date(file.lastModified));
    submit.disabled = false;
  } catch (err) {
    box.innerHTML = `<div class="form-error">${icon('alert')}<span>${esc(err.message)}</span></div>`;
  }
});

onForm('photo', async (data) => {
  if (!pending?.prepared) throw new Error('사진을 선택해주세요.');
  const btn = $('#photo-submit');
  if (btn) btn.innerHTML = `${icon('upload')}올리는 중…`;
  try {
    await store.photos.add({ siteId: pending.siteId, ...pending.prepared, takenAt: data.takenAt, caption: data.caption });
  } finally {
    if (btn) btn.innerHTML = `${icon('upload')}올리기`;
  }
  closeModal(true);
  toast('360° 사진을 올렸습니다.');
});

// ---------------------------------------------------------------- 전체 화면 보기 (사진·로드뷰 공통)

let view = null; // { el, kind, siteId, photoId, pano, blobUrl, observer, token }
let pushed = false;

function openViewer({ title, sub = '', actions = '' }) {
  closeViewer({ keepHistory: true });
  const el = document.createElement('div');
  el.id = 'viewer';
  el.className = 'viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="viewer-stage" id="viewer-stage"></div>
    <header class="viewer-head">
      <div class="viewer-title"><b>${esc(title)}</b><span id="viewer-sub">${esc(sub)}</span></div>
      <div class="viewer-actions">${actions}
        <button type="button" class="viewer-btn" data-act="viewer-close" aria-label="닫기" title="닫기">${icon('close')}</button></div>
    </header>
    <p class="viewer-msg" id="viewer-msg" hidden></p>
    <nav class="viewer-dates" id="viewer-dates" aria-label="촬영일" hidden></nav>`;
  document.body.append(el);
  document.body.classList.add('viewer-open');
  view = { el, token: 0, returnFocus: document.activeElement };
  // 휴대폰 "뒤로" 버튼으로 닫히도록 기록을 하나 쌓는다.
  if (!pushed) {
    history.pushState({ baromapViewer: true }, '');
    pushed = true;
  }
  el.querySelector('[data-act="viewer-close"]').focus();
  return view;
}

function teardown(v) {
  v.token++;
  try { v.pano?.destroy(); } catch { /* 무시 */ }
  v.pano = null;
  if (v.blobUrl) URL.revokeObjectURL(v.blobUrl);
  v.blobUrl = null;
}

// keepHistory: 다른 보기로 바로 바꿀 때(쌓아 둔 기록을 그대로 쓴다)
export function closeViewer({ fromHistory = false, keepHistory = false } = {}) {
  if (!view) return;
  const v = view;
  view = null;
  teardown(v);
  v.observer?.disconnect();
  v.el.remove();
  document.body.classList.remove('viewer-open');
  if (keepHistory) return;
  v.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.back();
  pushed = false;
}

const message = (text) => {
  const m = $('#viewer-msg');
  if (!m) return;
  m.hidden = !text;
  m.textContent = text || '';
};

window.addEventListener('popstate', () => { if (view) closeViewer({ fromHistory: true }); });
// 캡처 단계: 확인 창(#modal)이 위에 떠 있으면 Esc는 그 창만 닫는다(util.js가 처리).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view && !$('#modal')) closeViewer();
}, true);
onAction('viewer-close', () => closeViewer());

// ---- 360° 사진

async function loadPannellum() {
  loadCss(`${PANNELLUM}pannellum.css`);
  await loadScript(`${PANNELLUM}pannellum.js`);
  if (!window.pannellum) throw new Error('360° 보기 도구를 불러오지 못했습니다.');
}

function renderDates(list, currentId) {
  const nav = $('#viewer-dates');
  if (!nav) return;
  nav.hidden = list.length < 2;
  nav.innerHTML = list.map((p) => `<button type="button" class="${p.id === currentId ? 'on' : ''}" data-act="photo-go" data-id="${esc(p.id)}"
    aria-pressed="${p.id === currentId}">${esc(p.takenAt ? fmtDate(p.takenAt) : '날짜 없음')}${p.caption ? ` · ${esc(p.caption)}` : ''}</button>`).join('');
  nav.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

async function showPhoto(photo) {
  const v = view;
  if (!v) return;
  teardown(v);
  const token = v.token;
  v.photoId = photo.id;
  const g = panoView(photo.width, photo.height);
  $('#viewer-sub').textContent = `${photoLabel(photo)} · ${PANO_LABEL[g.kind]}`;
  renderDates(store.photos.cached(v.siteId) || [photo], photo.id);
  message('사진을 불러오는 중…');
  try {
    const [, url] = await Promise.all([loadPannellum(), store.photos.url(photo)]);
    if (view !== v || v.token !== token) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      return;
    }
    if (url.startsWith('blob:')) v.blobUrl = url;
    // 위아래(·좌우)가 잘린 사진은 찍힌 범위 밖(검은 배경)이 보이지 않게 움직일 수 있는 범위를 막는다.
    // 처음 화면은 사진 높이가 화면에 꽉 차는 배율(fit)로 연다(Pannellum은 확대·축소할 때만 제한을 다시 계산).
    const partial = g.kind !== 'sphere';
    const stage = $('#viewer-stage');
    const fit = partial
      ? (360 / Math.PI) * Math.atan(Math.tan((g.vaov / 360) * Math.PI) * (stage.clientWidth / Math.max(1, stage.clientHeight)))
      : 120;
    const range = partial ? {
      minPitch: -g.vaov / 2,
      maxPitch: g.vaov / 2,
      ...(g.haov < 360 ? { minYaw: -g.haov / 2, maxYaw: g.haov / 2 } : {}),
    } : {};
    v.pano = window.pannellum.viewer(stage, {
      type: 'equirectangular',
      panorama: url,
      autoLoad: true,
      haov: g.haov,
      vaov: g.vaov,
      ...range,
      avoidShowingBackground: partial,
      hfov: Math.min(100, g.haov, fit),
      minHfov: Math.max(10, Math.min(30, fit / 2)),
      maxHfov: Math.min(120, g.haov),
      showFullscreenCtrl: false,
      compass: false,
      strings: KO,
    });
    v.pano.on('load', () => { if (view === v) message(''); });
    v.pano.on('error', (err) => { if (view === v) message(typeof err === 'string' ? err.replace(/<[^>]+>/g, ' ') : KO.unknownError); });
  } catch (err) {
    if (view === v) message(err.message);
  }
}

export function openPhoto(siteId, photoId) {
  const s = q.site(siteId);
  const list = store.photos?.cached(siteId) || [];
  const photo = list.find((p) => p.id === photoId) || list[0];
  if (!s || !photo) return;
  const canDelete = store.can('edit', siteId);
  const v = openViewer({
    title: s.name,
    actions: canDelete ? `<button type="button" class="viewer-btn" data-act="photo-del" aria-label="이 사진 지우기" title="이 사진 지우기">${icon('trash')}</button>` : '',
  });
  v.kind = 'photo';
  v.siteId = siteId;
  showPhoto(photo);
}

onAction('photo-open', (el) => openPhoto(state.siteId, el.dataset.id));
onAction('photo-add', () => photoAddDialog(state.siteId));
onAction('photo-go', (el) => {
  const p = (store.photos.cached(view?.siteId) || []).find((x) => x.id === el.dataset.id);
  if (p && p.id !== view?.photoId) showPhoto(p);
});
onAction('photo-del', async () => {
  const v = view;
  if (!v?.photoId) return;
  const list = store.photos.cached(v.siteId) || [];
  const photo = list.find((p) => p.id === v.photoId);
  if (!photo) return;
  if (!(await confirmDialog(`${photoLabel(photo)} 사진을 지울까요?\n지운 사진은 되살릴 수 없습니다.`, { title: '사진 지우기', ok: '지우기', danger: true }))) return;
  await store.photos.remove(photo.id);
  toast('사진을 지웠습니다.');
  const rest = store.photos.cached(v.siteId) || [];
  if (view !== v) return;
  if (rest.length) showPhoto(rest[0]);
  else closeViewer();
});

// ---- 카카오 로드뷰

export function openRoadview(siteId) {
  const s = q.site(siteId);
  const k = window.kakao?.maps;
  if (!s) return;
  if (!k?.Roadview) {
    toast('로드뷰는 카카오맵에서만 볼 수 있습니다.', 'warn');
    return;
  }
  const v = openViewer({ title: s.name, sub: '카카오 로드뷰 · 찍은 시기에 따라 공사 전 모습일 수 있어요' });
  v.kind = 'roadview';
  const stage = $('#viewer-stage');
  const rv = new k.Roadview(stage);
  const pos = new k.LatLng(s.lat, s.lng);
  message('로드뷰를 찾는 중…');
  new k.RoadviewClient().getNearestPanoId(pos, ROADVIEW_RADIUS, (panoId) => {
    if (view !== v) return;
    if (!panoId) {
      message(`현장 ${ROADVIEW_RADIUS}m 안에 로드뷰 사진이 없습니다.`);
      return;
    }
    k.event.addListener(rv, 'init', () => {
      if (view !== v) return;
      message('');
      const p = rv.getPosition();
      const from = { lat: p.getLat(), lng: p.getLng() };
      rv.setViewpoint({ pan: bearingDeg(from, s), tilt: 0, zoom: 0 }); // 현장 쪽을 바라보게
      $('#viewer-sub').textContent = `카카오 로드뷰 · 현장에서 약 ${fmtDistance(distanceM(from, s))} 떨어진 곳 · 찍은 시기에 따라 공사 전 모습일 수 있어요`;
    });
    rv.setPanoId(panoId, pos);
  });
  v.observer = new ResizeObserver(() => rv.relayout());
  v.observer.observe(stage);
}

onAction('roadview', () => openRoadview(state.siteId));
