// 운영 설정 화면(11 지시서 2-5절). 현장 담당: 자기 현장 값, 운영자: 회사 기본값까지(폭염·한파 기준 포함). 현장 값의 빈 칸은 회사 값을 쓴다.
import { store, q } from '../ctx.js';
import { $, $$, esc, icon, onAction, onForm, openModal, closeModal, toast, confirmDialog } from '../util.js';
import { LANGS } from './langs.js';

const DAY = ['월', '화', '수', '목', '금', '토', '일'];
const ZONES = ['중부1', '중부2', '남부', '제주'];
let cur = null; // { siteId, scope: 'site'|'global', merged, row, companies }
const sections = []; // 뒤 단계가 설정 칸을 더한다: (cur) => html
export const addSettingsSection = (fn) => sections.push(fn);

const canEditScope = (siteId, scope) => (scope === 'global' ? store.can('admin') : store.can('edit', siteId));

function companyRows(list) {
  if (!list.length) return '<p class="empty">아직 협력사가 없습니다.</p>';
  return `<ul class="set-list">${list.map((c) => `<li class="${c.active ? '' : 'off'}"><span><b>${esc(c.name)}</b><small class="muted"> ${esc((c.trades || []).join(' · '))}${c.active ? '' : ' · 철수'}</small></span>
    <span class="set-act"><button type="button" class="btn sm" data-act="co-edit" data-id="${esc(c.id)}">${icon('edit')}수정</button></span></li>`).join('')}</ul>`;
}

function form() {
  const { merged: m, scope } = cur;
  const global = scope === 'global';
  return `<form id="f-ops" data-form="ops-settings" novalidate>
    ${store.can('admin') ? `<div class="seg ops-seg" role="tablist">
      <button type="button" role="tab" class="${global ? '' : 'on'}" aria-selected="${!global}" data-act="ops-scope" data-scope="site">이 현장</button>
      <button type="button" role="tab" class="${global ? 'on' : ''}" aria-selected="${global}" data-act="ops-scope" data-scope="global">회사 기본값</button></div>` : ''}
    ${global ? '' : `<section class="set-sec"><div class="sec-head"><h3>협력사</h3><span class="spacer"></span><button type="button" class="btn sm" data-act="co-new">${icon('plus')}추가</button></div>
      <div id="co-list">${companyRows(cur.companies)}</div>
      <p class="muted small">개인 연락처는 넣지 않습니다(사무실 대표 전화 정도).</p></section>`}
    <fieldset class="field"><legend>근무 요일</legend><div class="chip-row">${DAY.map((d, i) => `<label class="pick"><input type="checkbox" name="wd" value="${i + 1}" ${m.workdays.includes(i + 1) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div></fieldset>
    <label class="field"><span>휴일·현장 휴무(한 줄에 하나, 2026-12-25)</span><textarea name="holidays" rows="4">${esc(m.holidays.join('\n'))}</textarea></label>
    <div class="grid2">
      <label class="field"><span>우천 기준(mm/일)</span><input name="rainStopMm" type="number" min="0" step="0.5" inputmode="decimal" value="${esc(m.rainStopMm)}"></label>
      <label class="field"><span>일보 결재 단계</span><select name="steps"><option value="1" ${m.daily.steps === 2 ? '' : 'selected'}>1단계(승인)</option><option value="2" ${m.daily.steps === 2 ? 'selected' : ''}>2단계(검토 → 승인)</option></select></label>
    </div>
    <fieldset class="field"><legend>현장 언어(안전 문구·공지)</legend><div class="chip-row">${Object.entries(LANGS).map(([k, v]) => `<label class="pick"><input type="checkbox" name="lang" value="${k}" ${m.languages.includes(k) ? 'checked' : ''}><span>${esc(v)}</span></label>`).join('')}</div></fieldset>
    <label class="check"><input type="checkbox" name="blurFaces" ${m.blurFaces ? 'checked' : ''}><span>사진을 올릴 때 얼굴 가리기(기본)</span></label>
    ${global ? `<h3 class="set-h">폭염·한파 기준</h3>
      <div class="grid3">
        <label class="field"><span>주의(℃)</span><input name="h_caution" type="number" value="${esc(m.heat.caution)}"></label>
        <label class="field"><span>휴식 의무(℃)</span><input name="h_rest" type="number" value="${esc(m.heat.rest)}"></label>
        <label class="field"><span>위험(℃)</span><input name="h_danger" type="number" value="${esc(m.heat.danger)}"></label>
        <label class="field"><span>휴식 간격(분)</span><input name="h_every" type="number" value="${esc(m.heat.restEveryMin)}"></label>
        <label class="field"><span>휴식 시간(분)</span><input name="h_min" type="number" value="${esc(m.heat.restMin)}"></label>
        <span></span>
        <label class="field"><span>한파 주의(℃)</span><input name="c_caution" type="number" value="${esc(m.cold.caution)}"></label>
        <label class="field"><span>한파 위험(℃)</span><input name="c_danger" type="number" value="${esc(m.cold.danger)}"></label>
      </div>
      <p class="muted small">폭염 기준은 법(2025-07-17 시행)을 따릅니다. 법이 바뀌면 여기만 고치면 됩니다. 한파 기준은 회사 기준이며 법정 값이 아닙니다.</p>` : ''}
    <h3 class="set-h">창호 성능 기준(참고)</h3>
    ${global ? `<div class="grid2">${ZONES.map((z) => `<label class="field"><span>${esc(z)} 창 열관류율(외기 직접, W/㎡K)</span><input name="u_${esc(z)}" type="number" min="0" step="0.001" inputmode="decimal" value="${esc(m.standards?.window?.[z]?.direct ?? '')}"></label>`).join('')}</div>
      <p class="muted small">「건축물의 에너지절약설계기준」 현행 고시 별표에서 확인한 값만 넣어주세요. 비어 있으면 기준 검사를 하지 않습니다. 판단은 참고이고 설계자 확인이 필요합니다.</p>`
    : `<label class="field"><span>이 현장의 지역 구분</span><select name="climateZone"><option value="">고르지 않음</option>${ZONES.map((z) => `<option ${m.climateZone === z ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>`}
    ${sections.map((fn) => fn(cur)).join('')}
  </form>`;
}

async function load(siteId, scope) {
  const [merged, companies] = await Promise.all([
    store.ops.settings(scope === 'global' ? null : siteId),
    scope === 'global' ? [] : store.rows('companies').list({ siteId }),
  ]);
  cur = { siteId, scope, merged, companies };
}

async function paint() {
  const editable = canEditScope(cur.siteId, cur.scope);
  openModal({
    title: cur.scope === 'global' ? '운영 설정 — 회사 기본값' : `운영 설정 — ${q.site(cur.siteId)?.name || ''}`,
    wide: true,
    body: form(),
    footer: `<button type="button" class="btn ghost" data-act="modal-close">닫기</button>${editable ? `<button type="submit" class="btn primary" form="f-ops">${icon('check')}저장</button>` : ''}`,
  });
}

export async function opsSettingsDialog(siteId) {
  await load(siteId, store.can('edit', siteId) ? 'site' : 'global');
  await paint();
}

onAction('ops-scope', async (el) => {
  await load(cur.siteId, el.dataset.scope);
  await paint();
});

onForm('ops-settings', async (data, f) => {
  const wd = $$('[name=wd]:checked', f).map((x) => Number(x.value));
  const langs = $$('[name=lang]:checked', f).map((x) => x.value);
  const holidays = data.holidays.split(/[\s,]+/).filter(Boolean);
  const patch = { workdays: wd, holidays, rainStopMm: data.rainStopMm, daily: { steps: Number(data.steps), form: cur.merged.daily.form || '' }, languages: langs.length ? langs : ['ko'], blurFaces: data.blurFaces };
  if (cur.scope === 'global') {
    patch.heat = { caution: data.h_caution, rest: data.h_rest, danger: data.h_danger, restEveryMin: data.h_every, restMin: data.h_min };
    patch.cold = { ...cur.merged.cold, caution: data.c_caution, danger: data.c_danger };
    const window = {};
    for (const z of ZONES) if (data[`u_${z}`] !== '' && data[`u_${z}`] != null) window[z] = { direct: Number(data[`u_${z}`]) };
    patch.standards = Object.keys(window).length ? { window } : null;
  } else {
    patch.climateZone = data.climateZone;
  }
  await store.ops.saveSettings(cur.scope === 'global' ? 'global' : cur.siteId, patch);
  closeModal(true);
  toast('운영 설정을 저장했습니다.');
});

// ---------------------------------------------------------------- 협력사

function companyDialog(rec = null) {
  openModal({
    title: rec ? `${rec.name} 수정` : '협력사 추가',
    body: `<form id="f-co" data-form="company" data-id="${esc(rec?.id || '')}" novalidate>
      <label class="field"><span>이름 <em>*</em></span><input name="name" maxlength="60" value="${esc(rec?.name || '')}" placeholder="예) 가상건설(주)" required></label>
      <label class="field"><span>공종(쉼표로 나누기, 골구도 공종 이름과 같게)</span><input name="trades" value="${esc((rec?.trades || []).join(', '))}" placeholder="철근, 거푸집"></label>
      <label class="field"><span>메모(사무실 대표 전화 정도)</span><input name="memo" maxlength="500" value="${esc(rec?.memo || '')}"></label>
      ${rec ? `<label class="check"><input type="checkbox" name="active" ${rec.active ? 'checked' : ''}><span>현장에 있음(철수했으면 끄기)</span></label>` : ''}
    </form>`,
    footer: `${rec ? `<button type="button" class="btn ghost" data-act="co-del" data-id="${esc(rec.id)}">${icon('trash')}삭제</button><span class="spacer"></span>` : ''}
      <button type="button" class="btn ghost" data-act="co-back">취소</button><button type="submit" class="btn primary" form="f-co">${icon('check')}저장</button>`,
  });
}

onAction('co-new', () => companyDialog());
onAction('co-edit', (el) => companyDialog(cur.companies.find((c) => c.id === el.dataset.id)));
onAction('co-back', async () => { await load(cur.siteId, 'site'); await paint(); });
onAction('co-del', async (el) => {
  const c = cur.companies.find((x) => x.id === el.dataset.id);
  if (!c || !(await confirmDialog(`${c.name}을(를) 목록에서 지울까요?\n지난 일보의 출역 기록은 그대로 남습니다.`, { title: '협력사 삭제', ok: '삭제', danger: true }))) return;
  await store.rows('companies').remove(c.id);
  await load(cur.siteId, 'site');
  await paint();
});
onForm('company', async (data, f) => {
  const rec = cur.companies.find((c) => c.id === f.dataset.id);
  await store.rows('companies').save({
    id: rec?.id, siteId: cur.siteId, name: data.name, trades: data.trades.split(/[,，·]/), memo: data.memo,
    active: rec ? data.active : true, sort: rec?.sort ?? cur.companies.length + 1,
  });
  await load(cur.siteId, 'site');
  await paint();
  toast('협력사를 저장했습니다.');
});
