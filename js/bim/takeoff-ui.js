// 수량 화면(23 지시서 4절): 3D 보기 옆 [수량] 탭(공종 → 재료 나무, 동·타입 거르기, 식 펼치기, 3D 강조, 엑셀, 버전 증감),
// 재료 카드의 네 단계 수량(이 구간 / 이 세대 / 이 동 / 현장 전체), 회사 산출 기준 고치기. 계산은 js/bim/takeoff.js(순수 함수).
import { store } from '../ctx.js';
import { $, esc, icon, onAction, onForm, openModal, closeModal, toast } from '../util.js';
import { writeSheets } from '../excel-ui.js';
import { addViewerHook, bimViewerState, viewerModelFiles, viewerSelect, viewerRenderTab } from './viewer.js';
import { addMaterialSection } from './model-panel.js';
import { takeoff, takeoffSettings, takeoffSummary, takeoffDiff, materialLevels, PART_LABEL, DEFAULT_TAKEOFF } from './takeoff.js';

const cache = new Map(); // modelId → Promise<takeoff>
const ready = new Map(); // modelId → takeoff
const ui = { scope: 'site', open: null, diff: null };
const n2 = (v) => (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
const pct = (v) => `${Math.round(v * 1000) / 10}%`;

async function settingsFor(siteId) {
  const [g, s] = await Promise.all([store.ops?.settingsRow?.('global').catch(() => null), store.ops?.settingsRow?.(siteId).catch(() => null)]);
  return takeoffSettings(g?.takeoff || null, s?.takeoff || null);
}

/** 이 모델 버전의 수량(한 번 계산해 둔다). 편집 권한이 있으면 요약을 모델 통계에 남긴다 */
export function modelTakeoff(model = bimViewerState()?.model) {
  const v = bimViewerState();
  if (!v || !model) return Promise.resolve(null);
  if (!cache.has(model.id)) {
    cache.set(model.id, (async () => {
      const t = takeoff(await viewerModelFiles(model), await settingsFor(v.siteId));
      ready.set(model.id, t);
      if (store.can('edit', v.siteId) && model.id === v.model.id) {
        const sum = takeoffSummary(t);
        if (JSON.stringify(model.stats?.takeoff || null) !== JSON.stringify(sum)) store.bim.saveTakeoff?.(model.id, sum).catch(() => {});
      }
      return t;
    })().catch((err) => { cache.delete(model.id); throw err; }));
  }
  return cache.get(model.id);
}
const forget = () => { cache.clear(); ready.clear(); };

function rowsFor(t) {
  if (ui.scope.startsWith('b:')) return t.buildings[ui.scope.slice(2)]?.rows || [];
  if (ui.scope.startsWith('t:')) return t.unitTypes[ui.scope.slice(2)]?.rows || [];
  if (ui.scope === 'site-only') return t.site.rows;
  return t.total;
}
const scopeName = (t) => (ui.scope.startsWith('b:') ? t.buildings[ui.scope.slice(2)]?.name : ui.scope.startsWith('t:') ? `${t.unitTypes[ui.scope.slice(2)]?.name} 1세대` : ui.scope === 'site-only' ? '단지(포장·조경)' : '현장 전체');

function tableHtml(t) {
  const rows = rowsFor(t);
  const trades = [...new Set(rows.map((r) => r.trade))];
  return trades.map((tr) => {
    const list = rows.filter((r) => r.trade === tr);
    return `<details class="to-trade" open><summary><b>${esc(tr)}</b> <span class="muted small">${list.length}</span></summary>
      <ul class="to-rows">${list.map((r) => `<li class="${ui.open === r.key ? 'on' : ''}"><button type="button" class="to-row" data-act="to-row" data-key="${esc(r.key)}">
        <span class="to-name">${esc(r.name)} <small class="muted">${esc(PART_LABEL[r.part] || r.part)}</small></span>
        <span class="to-val">${n2(r.value)} ${esc(r.unit)}${r.assumed ? ` <small class="t-warn">추정 ${pct(r.assumed / (r.value || 1))}</small>` : ''}</span></button>
        ${ui.open === r.key ? `<div class="to-more"><p class="small">예: ${esc(r.formula || '')}</p>${r.adjusted ? `<p class="small muted">산출 기준 반영 ×${r.adjusted}</p>` : ''}
          <button type="button" class="btn sm" data-act="to-show" data-key="${esc(r.key)}">${icon('cube')}3D에서 보기(${r.ids.length})</button></div>` : ''}</li>`).join('')}</ul></details>`;
  }).join('') || '<p class="muted small">이 범위에 수량이 없습니다.</p>';
}

function diffHtml(d, other) {
  if (!d) return '';
  return `<h4>v${other.version} → 지금 증감 <small class="muted">${d.length}행</small></h4>
    <table class="mini-table to-diff"><tr><th>재료</th><th>전</th><th>지금</th><th>증감</th></tr>${d.slice(0, 80).map((x) => `<tr><td>${esc(x.name)} <small class="muted">${esc(PART_LABEL[x.part] || '')}</small></td><td>${n2(x.before)}</td><td>${n2(x.after)}</td><td class="${x.diff > 0 ? 't-warn' : ''}">${x.diff > 0 ? '+' : ''}${n2(x.diff)} ${esc(x.unit)}${x.rate != null ? ` (${x.diff > 0 ? '+' : ''}${pct(x.rate)})` : ''}</td></tr>`).join('')}</table>`;
}

addViewerHook('tabs', {
  key: 'takeoff',
  title: '수량',
  render(el, v) {
    const t = ready.get(v.model.id);
    if (!t) {
      el.innerHTML = '<p class="muted small loading">수량을 계산하는 중…</p>';
      modelTakeoff(v.model).then(() => { if (bimViewerState()?.tab === 'takeoff') viewerRenderTab(); }).catch((err) => { el.innerHTML = `<p class="t-warn small">${esc(err.message)}</p>`; });
      return;
    }
    const edit = store.can('edit', v.siteId);
    const others = (v.versions || []).filter((x) => x.id !== v.model.id);
    el.innerHTML = `${t.settings.isDefault ? `<p class="notice warn small">${icon('alert')}<span>회사 산출 기준 미설정 — 기본값(개구부 모두 공제, 벽 마감은 천장까지)으로 계산했습니다.${edit ? ' <button type="button" class="link" data-act="to-settings">산출 기준</button>' : ''}</span></p>` : `<p class="muted small">회사 산출 기준으로 계산 ${edit ? '<button type="button" class="link small" data-act="to-settings">산출 기준</button>' : ''}</p>`}
      <p class="small">추정 요소에서 나온 수량: 면적의 <b>${pct(t.assumedShare['㎡'])}</b>, 체적의 <b>${pct(t.assumedShare['㎥'])}</b>. 모델 수량은 참고값입니다(적산을 대신하지 않음).</p>
      <div class="to-tools">
        <label class="field"><span class="sr-only">범위</span><select id="to-scope">
          <option value="site" ${ui.scope === 'site' ? 'selected' : ''}>현장 전체</option>
          ${Object.entries(t.buildings).map(([id, b]) => `<option value="b:${esc(id)}" ${ui.scope === `b:${id}` ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
          ${Object.entries(t.unitTypes).map(([id, u]) => `<option value="t:${esc(id)}" ${ui.scope === `t:${id}` ? 'selected' : ''}>${esc(u.name)} 1세대</option>`).join('')}
          <option value="site-only" ${ui.scope === 'site-only' ? 'selected' : ''}>단지(포장·조경)</option>
        </select></label>
        <button type="button" class="btn sm" data-act="to-xlsx">${icon('download')}엑셀</button>
        ${others.length ? `<label class="field"><span class="sr-only">비교할 버전</span><select id="to-diff"><option value="">버전과 비교</option>${others.map((m) => `<option value="${esc(m.id)}" ${ui.diff?.id === m.id ? 'selected' : ''}>v${m.version}</option>`).join('')}</select></label>` : ''}
      </div>
      <div id="to-diff-box">${ui.diff?.rows ? diffHtml(ui.diff.rows, ui.diff.model) : ''}</div>
      <div class="to-list">${tableHtml(t)}</div>`;
  },
});

// 장면이 바뀌면 수량을 미리 계산해 둔다(재료 카드가 바로 쓰게)
addViewerHook('scene', (v) => { if (v?.model) modelTakeoff(v.model).catch(() => {}); });

// 재료 카드: 이 구간 / 이 세대 / 이 동 / 현장 전체(23 지시서 4절)
addMaterialSection((ctx, m) => {
  const v = bimViewerState();
  const t = v && ready.get(v.model.id);
  if (!t) return '<p class="muted small">수량 계산 중…</p>';
  const lv = materialLevels(t, m.id, { elementId: v.sel?.[0] || null, typeId: ctx?.type?.id || null, buildingId: ctx?.building?.id || null });
  if (!lv.length) return '';
  // 외벽 패널은 세대 항목이 아니라 동에서 센다: 이 구간 = 패널 순면적(창 공제)
  const panel = ctx?.level === 'building' && ctx.building?.facade?.panels?.find((p) => p.id === v.sel?.[0]);
  if (panel) for (const x of lv) if (x.unit === '㎡') { const net = Math.round(Math.max(0, panel.areaM2 - (panel.openingAreaM2 || 0)) * 1000) / 1000; x.element = net; x.elementFormula = [`외벽 패널 ${panel.areaM2}㎡${panel.openingAreaM2 ? ` − 창 ${panel.openingAreaM2}㎡` : ''} = ${net}㎡`]; }
  return `<table class="mini-table to-levels"><tr><th>수량</th><th>이 구간</th><th>이 세대</th><th>이 동</th><th>현장 전체</th></tr>${lv.map((x) => `<tr><td>${esc(x.unit)}</td><td>${x.element != null ? n2(x.element) : '-'}</td><td>${x.unitType != null ? n2(x.unitType) : '-'}</td><td>${x.building != null ? n2(x.building) : '-'}</td><td>${n2(x.site)}</td></tr>`).join('')}</table>
    ${lv.some((x) => x.elementFormula.length) ? `<details class="small"><summary>식 보기</summary><ul class="to-formula">${lv.flatMap((x) => x.elementFormula).slice(0, 8).map((f) => `<li>${esc(f)}</li>`).join('')}</ul></details>` : ''}`;
});

onAction('to-row', (el) => { ui.open = ui.open === el.dataset.key ? null : el.dataset.key; viewerRenderTab(); });
onAction('to-show', async (el) => {
  const t = await modelTakeoff();
  const r = rowsFor(t).find((x) => x.key === el.dataset.key);
  if (!r) return;
  viewerSelect(r.ids);
  toast(`${r.name} ${PART_LABEL[r.part] || ''}: 요소 ${r.ids.length}개를 3D에 표시했습니다(지금 장면에 있는 것만 보입니다).`);
});
onAction('to-xlsx', async () => {
  const v = bimViewerState();
  const t = await modelTakeoff();
  const sheet = (name, rows) => ({ name, rows: [['공종', '재료', '부위', '단위', '수량', '그중 추정', '식(예)'], ...rows.map((r) => [r.trade, r.name, PART_LABEL[r.part] || r.part, r.unit, r.value, r.assumed, r.formula || ''])] });
  await writeSheets(`바로맵_수량_v${v.model.version}.xlsx`, [
    sheet('현장 전체', t.total),
    ...Object.values(t.buildings).map((b) => sheet(b.name.slice(0, 28), b.rows)),
    ...Object.values(t.unitTypes).map((u) => sheet(`${u.name} 1세대`.slice(0, 28), u.rows)),
    { name: '산출 기준', rows: [['항목', '값'], ['회사 기준', t.settings.isDefault ? '미설정(기본값)' : '설정됨'], ['벽 마감 높이', t.settings.wallFinishHeight === 'slab' ? '슬래브 밑까지' : '천장까지'], ['개구부 공제 최소 면적(㎡)', JSON.stringify(t.settings.openingDeduct)], ['방수 치켜올림(mm)', JSON.stringify(t.settings.waterproofUpturnMm)], ['슬래브 기둥 공제', t.settings.slabColumnDeduct ? '함' : '안 함'], ['철근 부피 공제', t.settings.rebarVolumeDeduct ? `함(${t.settings.rebarRatio})` : '안 함'], ['할증률', JSON.stringify(t.settings.lossRate)], ['추정 비율(면적·체적)', `${pct(t.assumedShare['㎡'])} · ${pct(t.assumedShare['㎥'])}`]] },
  ]);
});
onAction('to-settings', async () => {
  const v = bimViewerState();
  const row = await store.ops.settingsRow(v.siteId).catch(() => null);
  const s = { ...DEFAULT_TAKEOFF, ...(row?.takeoff || {}) };
  openModal({
    title: '수량 산출 기준(이 현장)',
    body: `<form id="f-to" data-form="to-settings" novalidate>
      <p class="muted small">회사 적산 기준서를 받으면 이 값을 맞춥니다. 비워 두면 기본값입니다. 운영자는 [운영 설정]의 회사 값으로 모든 현장에 쓸 수 있습니다.</p>
      <label class="field"><span>이 면적 이하 개구부는 공제하지 않음(㎡)</span><input name="minArea" type="number" min="0" step="0.1" value="${esc(s.openingDeduct?.default ?? 0)}"></label>
      <label class="field"><span>벽 마감 높이</span><select name="wallFinishHeight"><option value="ceiling" ${s.wallFinishHeight !== 'slab' ? 'selected' : ''}>천장까지</option><option value="slab" ${s.wallFinishHeight === 'slab' ? 'selected' : ''}>슬래브 밑까지</option></select></label>
      <div class="grid2"><label class="field"><span>욕실 방수 치켜올림(mm)</span><input name="upBath" type="number" min="0" value="${esc(s.waterproofUpturnMm?.bath ?? '')}"></label>
      <label class="field"><span>발코니 방수 치켜올림(mm)</span><input name="upBalcony" type="number" min="0" value="${esc(s.waterproofUpturnMm?.balcony ?? '')}"></label></div>
      <label class="check"><input type="checkbox" name="slabColumnDeduct" ${s.slabColumnDeduct ? 'checked' : ''}><span>슬래브에서 기둥 겹침 공제</span></label>
      <label class="check"><input type="checkbox" name="rebarVolumeDeduct" ${s.rebarVolumeDeduct ? 'checked' : ''}><span>콘크리트에서 철근 부피 공제(비율 ${esc(s.rebarRatio)})</span></label>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" form="f-to" class="btn primary">${icon('check')}저장하고 다시 계산</button>`,
  });
});
onForm('to-settings', async (f) => {
  const v = bimViewerState();
  const num = (x) => (String(x ?? '').trim() === '' ? undefined : Number(x));
  const up = Object.fromEntries([['bath', num(f.upBath)], ['balcony', num(f.upBalcony)]].filter(([, x]) => x != null));
  await store.ops.saveSettings(v.siteId, { takeoff: { openingDeduct: { default: num(f.minArea) ?? 0 }, wallFinishHeight: f.wallFinishHeight, waterproofUpturnMm: up, slabColumnDeduct: Boolean(f.slabColumnDeduct), rebarVolumeDeduct: Boolean(f.rebarVolumeDeduct) } });
  closeModal(true);
  forget();
  ui.diff = null;
  toast('산출 기준을 저장했습니다. 수량을 다시 계산합니다.');
  viewerRenderTab();
});

document.addEventListener('change', async (e) => {
  const v = bimViewerState();
  if (!v) return;
  if (e.target.id === 'to-scope') { ui.scope = e.target.value; ui.open = null; viewerRenderTab(); }
  if (e.target.id === 'to-diff') {
    const other = v.versions.find((x) => x.id === e.target.value);
    if (!other) { ui.diff = null; viewerRenderTab(); return; }
    const box = $('#to-diff-box');
    if (box) box.innerHTML = '<p class="muted small loading">비교하는 중…</p>';
    const [a, b] = await Promise.all([modelTakeoff(other), modelTakeoff(v.model)]);
    ui.diff = { id: other.id, model: other, rows: takeoffDiff(a, b) };
    viewerRenderTab();
  }
});
