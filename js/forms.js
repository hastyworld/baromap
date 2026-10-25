// 입력 대화상자: 현장·숙소·거주자, 지도 설정. 위치는 주소 검색 / 우편번호 / 지도에서 직접 지정.
import { CFG, KEY_STORAGE, kakaoKey, store, state, q, ui } from './ctx.js';
import { LODGING_TYPES } from './store.js';
import { searchAddress, reverseGeocode } from './geo.js';
import { todayStr } from './model.js';
import {
  $, esc, icon, onAction, onForm, openModal, closeModal, hideModal, showModal, toast, loadScript, showFormError,
} from './util.js';

const RANKS = ['사원', '주임', '대리', '과장', '차장', '부장', '이사', '상무', '전무', '반장', '기능공'];
const TITLES = ['현장소장', '공사팀장', '공무팀장', '공무', '공사', '안전관리자', '품질관리자', '보건관리자', '반장'];
const DEPTS = ['건축', '토목', '기계설비', '전기', '공무', '안전', '품질', '조경', '측량', '협력사'];

const v = (x) => esc(x ?? '');
const field = (label, inner, cls = '') => `<label class="field ${cls}"><span>${label}</span>${inner}</label>`;

// 자주 쓰는 값: 기본 목록 + 이미 입력된 값(많이 쓴 순)
function suggestions(key, base) {
  const count = new Map();
  for (const r of state.data.residents) if (r[key]) count.set(r[key], (count.get(r[key]) || 0) + 1);
  const used = [...count].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return [...new Set([...used, ...base])];
}
const datalist = (id, items) => `<datalist id="${id}">${items.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;

// ---------------------------------------------------------------- 위치 입력(주소 검색·우편번호·지도 지정)

let loc = null; // { kind, results }

function locationFields(rec, kind) {
  const has = rec?.lat != null && rec?.lng != null && rec.lat !== '';
  return `
    <div class="field">
      <span>주소 <em>*</em></span>
      <div class="addr-row">
        <input name="address" id="f-addr" value="${v(rec?.address)}" placeholder="도로명·지번·건물명" autocomplete="off">
        <button type="button" class="btn" data-act="addr-search">${icon('search')}검색</button>
      </div>
      <div class="addr-tools">
        <button type="button" class="link" data-act="postcode">${icon('search')}우편번호로 찾기</button>
        <button type="button" class="link" data-act="pick-map" data-kind="${kind}">${icon('target')}지도에서 지정</button>
      </div>
      <div id="loc-status" class="loc-status">${locStatus(has ? rec : null)}</div>
      <div id="addr-results" class="addr-results" hidden></div>
      <div id="postcode-box" class="postcode-box" hidden></div>
    </div>
    <input type="hidden" name="lat" value="${has ? rec.lat : ''}"><input type="hidden" name="lng" value="${has ? rec.lng : ''}">`;
}

function locStatus(p) {
  return p
    ? `<span class="t-ok">${icon('check')}위치 지정됨 <small>(${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)})</small></span>`
    : `<span class="t-warn">${icon('target')}위치 미지정 — 주소를 검색하거나 지도에서 지정하세요</span>`;
}

function setLoc(lat, lng, address) {
  const form = $('#modal form');
  if (!form) return;
  form.elements.lat.value = Math.round(lat * 1e7) / 1e7;
  form.elements.lng.value = Math.round(lng * 1e7) / 1e7;
  if (address != null) form.elements.address.value = address;
  $('#loc-status').innerHTML = locStatus({ lat, lng });
  state.temp = { lat, lng, kind: loc?.kind };
  ui.syncMap();
  ui.focus(lat, lng);
}

async function runAddrSearch(query) {
  const box = $('#addr-results');
  const qtext = (query ?? $('#f-addr').value).trim();
  if (!qtext) {
    toast('검색할 주소나 건물명을 입력하세요.', 'warn');
    return;
  }
  box.hidden = false;
  box.innerHTML = '<p class="muted small loading">찾는 중…</p>';
  try {
    loc.results = await searchAddress(qtext);
  } catch (err) {
    box.innerHTML = `<p class="t-warn small">${esc(err.message)}</p>`;
    return;
  }
  if (loc.results.length === 1) {
    pickResult(0);
    return;
  }
  box.innerHTML = loc.results.length
    ? loc.results.map((r, i) => `<button type="button" class="addr-item" data-act="addr-pick" data-i="${i}">
        ${r.name ? `<b>${esc(r.name)}</b>` : ''}<span>${esc(r.address)}</span>${r.jibun && r.jibun !== r.address ? `<small>지번 ${esc(r.jibun)}</small>` : ''}</button>`).join('')
    : '<p class="muted small">찾지 못했습니다. 다른 이름으로 검색하거나 [지도에서 지정]을 눌러 직접 지정해주세요.</p>';
}

function pickResult(i) {
  const r = loc.results[i];
  const box = $('#addr-results');
  box.hidden = true;
  box.innerHTML = '';
  const form = $('#modal form');
  if (r.name && form.elements.name && !form.elements.name.value) form.elements.name.value = r.name;
  setLoc(r.lat, r.lng, r.address);
}

onAction('addr-search', () => runAddrSearch());
onAction('addr-pick', (el) => pickResult(Number(el.dataset.i)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'f-addr') {
    e.preventDefault();
    runAddrSearch();
  }
});

// 카카오(다음) 우편번호 서비스: 대화상자 안에 펼쳐서 쓴다. 고른 주소는 좌표로 바꿔 지도 중심을 옮긴다.
onAction('postcode', async () => {
  const box = $('#postcode-box');
  if (!box.hidden) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  await loadScript('https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js');
  box.hidden = false;
  new window.daum.Postcode({
    oncomplete: (data) => {
      const addr = data.roadAddress || data.jibunAddress || data.address;
      box.hidden = true;
      box.innerHTML = '';
      $('#f-addr').value = addr;
      runAddrSearch(addr);
    },
    width: '100%',
    height: '100%',
  }).embed(box);
});

onAction('pick-map', (el) => {
  hideModal();
  ui.startPicking({
    kind: el.dataset.kind,
    onPick: async (lat, lng) => {
      showModal();
      setLoc(lat, lng);
      try {
        const addr = await reverseGeocode(lat, lng);
        if (addr) $('#f-addr').value = addr;
      } catch { /* 주소 변환 실패: 좌표는 지정됨 */ }
    },
    onCancel: () => showModal(),
  });
});

// 임시 핀은 위치를 새로 고른 뒤에만 보인다(수정할 때 기존 핀과 겹치지 않도록).
function openForm(kind, title, body) {
  loc = { kind, results: [] };
  state.temp = null;
  openModal({
    title,
    wide: true,
    body,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button>
      <button type="submit" class="btn primary" form="f-${kind}">${icon('check')}저장</button>`,
    onClose: () => {
      loc = null;
      state.temp = null;
      ui.syncMap();
    },
  });
}

// objLabel: 조사까지 붙인 대상 (예: '현장을', '숙소를')
async function saveForm(kind, data, form, objLabel) {
  const id = form.dataset.id || undefined;
  const saved = await store.save(kind, { ...data, id });
  closeModal(true);
  toast(`${objLabel} ${id ? '수정' : '등록'}했습니다.`);
  return saved;
}

// ---------------------------------------------------------------- 현장

export function siteDialog(rec = null) {
  openForm('sites', rec ? '현장 수정' : '현장 등록', `
    <form id="f-sites" data-form="sites" data-id="${v(rec?.id)}" novalidate>
      ${field('현장명 <em>*</em>', `<input name="name" value="${v(rec?.name)}" required maxlength="100" placeholder="예) 평택 고덕 OO 신축공사" autofocus>`)}
      ${locationFields(rec, 'sites')}
      <div class="grid2">
        ${field('발주처', `<input name="client" value="${v(rec?.client)}" maxlength="100">`)}
        ${field('현장소장', `<input name="manager" value="${v(rec?.manager)}" maxlength="50" placeholder="예) 홍길동 부장">`)}
        ${field('착공일', `<input name="startDate" type="date" value="${v(rec?.startDate)}">`)}
        ${field('준공 예정일', `<input name="endDate" type="date" value="${v(rec?.endDate)}">`)}
        ${field('현장사무실 연락처', `<input name="phone" value="${v(rec?.phone)}" data-phone inputmode="tel" placeholder="031-000-0000">`)}
      </div>
      ${field('공사 개요', `<textarea name="overview" rows="4" maxlength="5000" placeholder="규모, 구조, 주요 공정 등">${v(rec?.overview)}</textarea>`)}
      ${field('메모', `<textarea name="memo" rows="2" maxlength="3000" placeholder="출입 방법, 특이사항 등">${v(rec?.memo)}</textarea>`)}
    </form>`);
}

onForm('sites', async (data, form) => {
  const saved = await saveForm('sites', data, form, '현장을');
  ui.selectSite(saved.id);
});

// ---------------------------------------------------------------- 숙소

export function lodgingDialog(rec = null, preset = {}) {
  if (!state.data.sites.length) {
    toast('먼저 현장을 등록해주세요.', 'warn');
    return;
  }
  const r = { ...preset, ...(rec || {}) };
  // 공유 모드에서는 수정 권한이 있는 현장만 고를 수 있다.
  const editable = state.data.sites.filter((s) => store.can('edit', s.id));
  if (!editable.length) {
    toast('숙소를 등록할 수 있는 현장이 없습니다. 관리자에게 현장 담당 권한을 요청하세요.', 'warn');
    return;
  }
  const siteOpts = [...editable].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    .map((s) => `<option value="${esc(s.id)}" ${s.id === r.siteId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const types = LODGING_TYPES.includes(r.type) || !r.type ? LODGING_TYPES : [r.type, ...LODGING_TYPES];
  openForm('lodgings', rec ? '숙소 수정' : '숙소 등록', `
    <form id="f-lodgings" data-form="lodgings" data-id="${v(rec?.id)}" novalidate>
      <div class="grid2">
        ${field('현장 <em>*</em>', `<select name="siteId">${siteOpts}</select>`)}
        ${field('숙소명 <em>*</em>', `<input name="name" value="${v(r.name)}" required maxlength="100" placeholder="예) 고덕 OO오피스텔" autofocus>`)}
      </div>
      ${locationFields(rec, 'lodgings')}
      <div class="grid2">
        ${field('동·호수', `<input name="addressDetail" value="${v(r.addressDetail)}" maxlength="100" placeholder="예) 104동 802호">`)}
        ${field('유형', `<select name="type"><option value="">선택</option>${types.map((t) => `<option ${t === r.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`)}
        ${field('정원(명)', `<input name="capacity" type="number" min="0" max="999" inputmode="numeric" value="${v(r.capacity)}">`)}
        ${field('계약 종료일', `<input name="leaseEnd" type="date" value="${v(r.leaseEnd)}">`)}
      </div>
      ${field('메모', `<textarea name="memo" rows="2" maxlength="3000" placeholder="출입 방법, 관리인 연락처 등">${v(r.memo)}</textarea>`)}
    </form>`);
}

onForm('lodgings', async (data, form) => {
  const saved = await saveForm('lodgings', data, form, '숙소를');
  ui.selectLodging(saved.id);
});

// ---------------------------------------------------------------- 거주자

export function residentDialog(rec = null, preset = {}) {
  if (!state.data.lodgings.length) {
    toast('먼저 숙소를 등록해주세요.', 'warn');
    return;
  }
  const r = { moveIn: rec ? '' : todayStr(), ...preset, ...(rec || {}) };
  const groups = state.data.sites.filter((s) => store.can('edit', s.id)).sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((s) => {
    const ls = q.lodgingsOf(s.id);
    if (!ls.length) return '';
    return `<optgroup label="${esc(s.name)}">${ls.map((l) => `<option value="${esc(l.id)}" ${l.id === r.lodgingId ? 'selected' : ''}>${esc(l.name)} (${q.residentsOf(l.id).length}${l.capacity ? `/${l.capacity}` : ''}명)</option>`).join('')}</optgroup>`;
  }).join('');
  if (!groups) {
    toast('거주자를 등록할 수 있는 숙소가 없습니다. 관리자에게 현장 담당 권한을 요청하세요.', 'warn');
    return;
  }
  openModal({
    title: rec ? `${rec.name} 님 정보 수정` : '거주자 등록',
    wide: true,
    body: `<form id="f-residents" data-form="residents" data-id="${v(rec?.id)}" novalidate>
      ${field('숙소 <em>*</em>', `<select name="lodgingId">${groups}</select>`)}
      <div class="grid3">
        ${field('이름 <em>*</em>', `<input name="name" value="${v(r.name)}" required maxlength="50" autofocus>`)}
        ${field('직급', `<input name="rank" value="${v(r.rank)}" list="dl-rank" maxlength="30" placeholder="예) 대리">`)}
        ${field('직책', `<input name="title" value="${v(r.title)}" list="dl-title" maxlength="30" placeholder="예) 공무">`)}
        ${field('소속·공종', `<input name="dept" value="${v(r.dept)}" list="dl-dept" maxlength="50" placeholder="예) 건축">`)}
        ${field('연락처', `<input name="phone" value="${v(r.phone)}" data-phone inputmode="tel" placeholder="010-0000-0000">`)}
        ${field('입주일', `<input name="moveIn" type="date" value="${v(r.moveIn)}">`)}
      </div>
      ${field('메모', `<input name="memo" value="${v(r.memo)}" maxlength="1000">`)}
      <p class="muted small">${icon('alert')}업무에 필요한 정보만 입력하세요. 주민등록번호 같은 식별번호는 입력하지 않습니다.</p>
      ${datalist('dl-rank', suggestions('rank', RANKS))}${datalist('dl-title', suggestions('title', TITLES))}${datalist('dl-dept', suggestions('dept', DEPTS))}
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button>
      <button type="submit" class="btn primary" form="f-residents">${icon('check')}저장</button>`,
  });
}

onForm('residents', async (data, form) => {
  const id = form.dataset.id || undefined;
  const saved = await store.save('residents', { ...data, id });
  closeModal(true);
  toast(id ? `${saved.name} 님 정보를 수정했습니다.` : `${saved.name} 님을 등록했습니다.`);
  state.flashResident = saved.id;
  ui.selectLodging(saved.lodgingId, { fit: false });
});

// ---------------------------------------------------------------- 지도 설정 (카카오 키)

export function settingsDialog(kind) {
  let override = null;
  try { override = localStorage.getItem(KEY_STORAGE); } catch { /* 무시 */ }
  openModal({
    title: '지도 설정',
    body: `<form id="f-settings" data-form="settings">
      <p>지금 지도: <b>${kind === 'kakao' ? '카카오맵' : '데모 지도 (OpenStreetMap)'}</b></p>
      ${field('카카오 JavaScript 키', `<input name="key" value="${v(kakaoKey())}" placeholder="비워 두면 config.js의 키 사용 (없으면 데모 지도)" autocomplete="off" spellcheck="false">`)}
      <ol class="steps small">
        <li><a href="https://developers.kakao.com/console/app" target="_blank" rel="noopener">카카오 개발자 콘솔</a> → 내 애플리케이션 → 앱 키에서 <b>JavaScript 키</b>를 복사합니다.</li>
        <li>같은 앱의 JavaScript SDK 도메인에 지금 주소 <code>${esc(location.origin)}</code>를 등록합니다.</li>
        <li>콘솔에 카카오맵 사용 설정이 있다면 켭니다. 저장하면 페이지를 새로 불러옵니다.</li>
      </ol>
      <p class="muted small">이 키는 이 브라우저에만 저장됩니다. 모든 사용자에게 적용하려면 <code>config.js</code>의 <code>kakaoJsKey</code>에 넣으세요.${override != null && CFG.kakaoJsKey !== override ? ' (지금은 화면에서 넣은 키가 config.js보다 우선합니다)' : ''}</p>
    </form>`,
    footer: `${override != null ? '<button type="button" class="btn ghost" data-act="key-reset">config.js 키로 되돌리기</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn ghost" data-act="modal-close">취소</button>
      <button type="submit" class="btn primary" form="f-settings">${icon('check')}저장하고 새로 불러오기</button>`,
  });
}

onForm('settings', async (data, form) => {
  const key = String(data.key || '').trim();
  if (key && !/^[0-9a-f]{32}$/i.test(key)) {
    showFormError(form, 'JavaScript 키는 영문·숫자 32자리입니다. 다시 확인해주세요.');
    return;
  }
  // 비워서 저장하면 이 브라우저 설정을 지우고 config.js의 키를 쓴다.
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* 무시 */ }
  location.reload();
});

onAction('key-reset', () => {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* 무시 */ }
  location.reload();
});
