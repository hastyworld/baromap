// 직접 고치기·버전·확정(07 1·2·4절). 3D 보기의 정보 패널 [직접 고치기] → 요소별 입력 → 수정 연산이 쌓이고(미리보기),
// [새 버전으로 저장] 때 한 번에 적용해 새 draft 버전을 만든다. 버전 목록·비교(3D 색 표시)·되돌리기·확정.
// 연산 만들기는 edit-ops.js(순수 함수), 적용·검사는 validate.js. 권한은 화면 안내일 뿐, 최종 기준은 DB RLS.
import { store } from '../ctx.js';
import { addElementAction, addOverviewAction, USE_LABEL, findElement } from './model-panel.js';
import { addViewerHook, bimViewerState, viewerModelFiles, viewerPreview, viewerSwitch, viewerFileNames, viewerMarks, viewerSelect, visibleVersions, STATUS_LABEL } from './viewer.js';
import { applyPatch, diffFiles, describeOp, elementName } from './validate.js';
import { wallOps, spaceOps, openingOps, levelOps, unitOps, buildingOps, assemblyOps, removeOp } from './edit-ops.js';
import { ZONE_LABEL } from './materials-3d.js';
import { CATEGORY_LABEL } from './materials-ko.js';
import { $, $$, esc, icon, onAction, onForm, openModal, closeModal, toast, confirmDialog, fmtDateTime as when } from '../util.js';

const EDITABLE = new Set(['wall', 'space', 'opening', 'unit', 'building']);
const KIND_TITLE = { wall: '벽', space: '실', opening: '문·창', unit: '세대', building: '동', level: '층(레벨)', assembly: '조립체 층 구성' };
const MARK = { added: '#2B8A3E', changed: '#F59F00' };
const canEdit = (v) => Boolean(v) && store.can('edit', v.siteId);
const mm = (m) => Math.round(m * 1000);

// ---------------------------------------------------------------- 정보 패널 단추

addElementAction((ctx, el) => {
  const v = bimViewerState();
  if (!canEdit(v) || Array.isArray(el) || !EDITABLE.has(el.kind)) return '';
  return `<button type="button" class="btn sm" data-act="bim-edit" data-kind="${el.kind}" data-id="${esc(el.obj.id)}">${icon('edit')}직접 고치기</button>`;
});

// 동 장면 개요: 층(레벨) 고치기
addOverviewAction((ctx) => {
  const v = bimViewerState();
  if (!canEdit(v) || ctx.level !== 'building') return '';
  const L = [...ctx.building.levels].sort((a, b) => a.elevation - b.elevation);
  return `<details class="bv-levels"><summary>층(레벨) ${L.length}개 — 층고 고치기</summary><ul>${L.map((l) => `<li><span><b>${esc(l.name)}</b> <span class="muted">바닥 ${l.elevation}m · 층고 ${l.height}m</span></span>
    <button type="button" class="btn sm ghost" data-act="bim-edit" data-kind="level" data-id="${esc(l.id)}">고치기</button></li>`).join('')}</ul></details>`;
});

// ---------------------------------------------------------------- 머리 도구(버전·확정)와 "바뀐 것 n개" 줄

addViewerHook('chrome', (v) => {
  const extra = v.el.querySelector('#bv-extra');
  const strip = v.el.querySelector('#bv-edits');
  if (!extra || !strip) return;
  const edit = canEdit(v);
  const draft = v.model.status === 'draft';
  extra.innerHTML = edit ? `<button type="button" class="btn sm" data-act="bim-versions" title="버전 목록·비교·되돌리기">${icon('clock')}<span>버전</span></button>
    ${draft && !v.edits?.ops.length ? `<button type="button" class="btn sm primary" data-act="bim-approve" title="이 버전을 직원들이 보는 확정본으로">${icon('check')}<span>확정하기</span></button>` : ''}` : '';
  const n = v.edits?.ops.length || 0;
  strip.hidden = !n;
  strip.innerHTML = n ? `<span class="bv-edits-n">${icon('edit')}바뀐 것 <b>${n}</b>개 <span class="muted">(아직 저장 안 됨, 3D는 미리보기)</span></span>
    <details class="bv-edits-list"><summary>목록</summary><ol>${v.edits.ops.map((op) => `<li>${esc(describeOp(v.edits.base, op))}</li>`).join('')}</ol></details>
    <span class="spacer"></span>
    <button type="button" class="btn sm ghost" data-act="bim-edit-undo">마지막 것 되돌리기</button>
    <button type="button" class="btn sm ghost" data-act="bim-edit-discard">모두 버리기</button>
    <button type="button" class="btn sm primary" data-act="bim-edit-save">${icon('check')}새 버전으로 저장</button>` : '';
});

// ---------------------------------------------------------------- 연산 쌓기·미리보기

async function currentFiles(v) { return v.preview || (v.edits?.base) || viewerModelFiles(); }

/** 새 연산을 쌓고 미리보기. 틀리면 아무것도 바꾸지 않고 오류(입력 창에 보임) */
export async function addOps(newOps) {
  const v = bimViewerState();
  if (!v) return false;
  if (!newOps.length) { toast('바뀐 것이 없습니다.'); return false; }
  const base = v.edits?.base || await viewerModelFiles();
  const all = [...(v.edits?.ops || []), ...newOps];
  const r = applyPatch(base, all, { method: 'manual' });
  if (!r.ok) throw new Error(`고칠 수 없습니다: ${r.errors.slice(0, 3).join(' / ')}`);
  v.edits = { base, ops: all };
  await viewerPreview(r.files);
  return true;
}

onAction('bim-edit-undo', async () => {
  const v = bimViewerState();
  if (!v?.edits) return;
  const ops = v.edits.ops.slice(0, -1);
  if (!ops.length) { v.edits = null; await viewerPreview(null); return; }
  const r = applyPatch(v.edits.base, ops, { method: 'manual' });
  v.edits.ops = ops;
  await viewerPreview(r.files);
});
onAction('bim-edit-discard', async () => {
  const v = bimViewerState();
  if (!v?.edits || !(await confirmDialog(`바뀐 것 ${v.edits.ops.length}개를 모두 버릴까요?`, { title: '고친 것 버리기', ok: '버리기', danger: true }))) return;
  v.edits = null;
  await viewerPreview(null);
});

// ---------------------------------------------------------------- 새 버전 저장(직접 고치기·AI 수정안 적용·되돌리기 공용)

/** 검증 결과를 새 버전으로 옮긴다(해결·무시 상태도) */
export async function carryFindings(fromId, toId) {
  const prev = store.bim.cachedFindings(fromId) || await store.bim.findings(fromId).catch(() => []);
  for (const source of ['rule', 'ai']) {
    const items = prev.filter((f) => f.source === source);
    if (!items.length) continue;
    const saved = await store.bim.saveFindings(toId, items.map(({ severity, kind, message, evidence, elementIds }) => ({ severity, kind, message, evidence, elementIds })), { source });
    for (const f of saved) {
      const p = items.find((x) => x.kind === f.kind && x.message === f.message && x.status !== 'open');
      if (p) await store.bim.setFinding(f.id, p.status, p.note || '');
    }
  }
}

/** files로 새 draft 버전 저장 → 3D가 그 버전으로 */
export async function saveVersion(files, { note, parent }) {
  const v = bimViewerState();
  const m = await store.bim.save(v.siteId, files, { setId: parent.setId, parentId: parent.id, note, summary: files['index.json']?.summary || {} });
  await carryFindings(parent.id, m.id);
  v.edits = null;
  await viewerSwitch(m.id);
  return m;
}

onAction('bim-edit-save', () => {
  const v = bimViewerState();
  if (!v?.edits) return;
  openModal({
    title: '새 버전으로 저장',
    body: `<form id="f-bim-save" data-form="bim-save" novalidate>
      <p class="small">바뀐 것 <b>${v.edits.ops.length}</b>개를 적용해 <b>새 버전(초안)</b>을 만듭니다. 지금 버전 v${v.model.version}은 그대로 남습니다.</p>
      <label class="field"><span>메모 <em>*</em></span><input name="note" maxlength="200" required placeholder="예) 84A 욕실 벽 마감 타일로(A-601 확인)" autofocus></label>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" class="btn primary" form="f-bim-save">${icon('check')}저장</button>`,
  });
});
onForm('bim-save', async (data) => {
  const v = bimViewerState();
  const note = String(data.note || '').trim();
  if (!note) throw new Error('메모를 적어주세요(무엇을 왜 고쳤는지).');
  const r = applyPatch(v.edits.base, v.edits.ops, { method: 'manual' });
  if (!r.ok) throw new Error(r.errors.slice(0, 3).join(' / '));
  const n = v.edits.ops.length;
  closeModal(true);
  const m = await saveVersion(r.files, { note, parent: v.model });
  toast(`v${m.version}(초안)을 만들었습니다: 바뀐 것 ${n}개. 확인한 뒤 [확정하기]를 누르면 직원들에게 보입니다.`);
});

// ---------------------------------------------------------------- 확정

onAction('bim-approve', async (btn) => {
  const v = bimViewerState();
  if (!v) return;
  const id = btn.dataset.id || v.model.id;
  const m = v.versions.find((x) => x.id === id) || v.model;
  const fs = store.bim.cachedFindings(m.id) || await store.bim.findings(m.id).catch(() => []);
  const errs = fs.filter((f) => f.status === 'open' && f.severity === 'error').length;
  const msg = `${errs ? `열린 검증 오류가 ${errs}개 있습니다. 그래도 ` : ''}v${m.version}을 확정할까요?\n확정하면 직원들 화면에 이 버전이 보이고, 지금 확정본은 '이전 확정'이 됩니다.`;
  if (!(await confirmDialog(msg, { title: '모델 확정', ok: '확정', danger: Boolean(errs) }))) return;
  await store.bim.approve(m.id);
  closeModal(true);
  await viewerSwitch(v.model.id === m.id ? m.id : v.model.id);
  toast(`v${m.version}을 확정했습니다.`);
});

// ---------------------------------------------------------------- 버전 목록·비교·되돌리기

onAction('bim-versions', async () => {
  const v = bimViewerState();
  if (!v) return;
  await store.bim.versions(v.siteId);
  const list = visibleVersions(v.siteId);
  const edit = canEdit(v);
  openModal({
    title: '모델 버전',
    wide: true,
    body: `<ul class="ver-list">${list.map((m) => `<li class="${m.id === v.model.id ? 'cur' : ''}">
        <div class="ver-main"><b>v${m.version}</b> <span class="badge ${m.status === 'approved' ? 'ok' : m.status === 'draft' ? 'warn' : ''}">${STATUS_LABEL[m.status] || m.status}</span>
          ${m.id === v.model.id ? '<span class="muted small">지금 보는 버전</span>' : ''}
          <span class="ver-note">${esc(m.note || '')}</span>
          <span class="muted small">${esc(when(m.createdAt))}${m.approvedAt ? ` · 확정 ${esc(when(m.approvedAt))}` : ''}</span></div>
        <div class="ver-acts">
          ${m.id !== v.model.id ? `<button type="button" class="btn sm ghost" data-act="bim-ver-open" data-id="${esc(m.id)}">보기</button>
            <button type="button" class="btn sm ghost" data-act="bim-ver-diff" data-id="${esc(m.id)}">지금과 비교</button>` : ''}
          ${edit && m.id !== v.model.id ? `<button type="button" class="btn sm ghost" data-act="bim-ver-revert" data-id="${esc(m.id)}">이 버전으로 되돌리기</button>` : ''}
          ${edit && m.status === 'draft' ? `<button type="button" class="btn sm" data-act="bim-approve" data-id="${esc(m.id)}">확정</button>` : ''}
        </div></li>`).join('')}</ul>
      <div id="ver-diff"></div>`,
    footer: '<button type="button" class="btn ghost" data-act="modal-close">닫기</button>',
  });
});

onAction('bim-ver-open', async (btn) => {
  const v = bimViewerState();
  if (v?.edits && !(await confirmDialog('고치는 중인 내용이 있습니다. 버전을 바꾸면 버립니다.', { title: '버전 바꾸기', ok: '버리고 바꾸기', danger: true }))) return;
  if (v) v.edits = null;
  closeModal(true);
  await viewerSwitch(btn.dataset.id);
});

onAction('bim-ver-diff', async (btn) => {
  const v = bimViewerState();
  const other = v.versions.find((x) => x.id === btn.dataset.id);
  const box = $('#ver-diff');
  if (!other || !box) return;
  box.innerHTML = '<p class="muted small loading">비교하는 중…</p>';
  const [a, b] = await Promise.all([viewerModelFiles(other), viewerModelFiles(v.model)]);
  const d = diffFiles(a, b);
  const names = (list, files) => list.slice(0, 40).map((x) => `<li>${esc(elementName(files, x.file, x.id))}</li>`).join('') + (list.length > 40 ? `<li class="muted">… ${list.length - 40}개 더</li>` : '');
  v.diff = { other, d };
  box.innerHTML = `<div class="ver-diff"><h4>v${other.version} → v${v.model.version}(지금)</h4>
    <div class="ver-counts"><span class="add">추가 ${d.added.length}</span><span class="chg">바뀜 ${d.changed.length}</span><span class="del">없어짐 ${d.removed.length}</span></div>
    <div class="ver-cols"><div><h5>추가</h5><ul>${names(d.added, b)}</ul></div><div><h5>바뀜</h5><ul>${names(d.changed, b)}</ul></div><div><h5>없어짐</h5><ul>${names(d.removed, a)}</ul></div></div>
    <button type="button" class="btn sm" data-act="bim-ver-mark">${icon('cube')}3D에 표시(추가 초록 · 바뀜 노랑)</button></div>`;
});

onAction('bim-ver-mark', () => {
  const v = bimViewerState();
  if (!v?.diff) return;
  const marks = new Map();
  for (const x of v.diff.d.added) marks.set(x.id, MARK.added);
  for (const x of v.diff.d.changed) marks.set(x.id, MARK.changed);
  closeModal(true);
  viewerMarks(marks);
  toast(`3D에 표시했습니다: 추가 ${v.diff.d.added.length}(초록) · 바뀜 ${v.diff.d.changed.length}(노랑). 없어진 ${v.diff.d.removed.length}개는 지금 버전에 없어 목록으로만 봅니다.`);
});

onAction('bim-ver-revert', async (btn) => {
  const v = bimViewerState();
  const other = v.versions.find((x) => x.id === btn.dataset.id);
  if (!other || !(await confirmDialog(`v${other.version}의 내용을 복사해 새 초안 버전을 만들까요?\n지금까지의 버전은 모두 그대로 남습니다.`, { title: '이 버전으로 되돌리기', ok: '되돌리기' }))) return;
  const files = await viewerModelFiles(other);
  closeModal(true);
  const m = await saveVersion(files, { note: `v${other.version}로 되돌림`, parent: v.model });
  toast(`v${other.version} 내용으로 v${m.version}(초안)을 만들었습니다.`);
});

// ---------------------------------------------------------------- 요소별 입력 창

const opt = (value, label, cur) => `<option value="${esc(value)}" ${value === cur ? 'selected' : ''}>${esc(label)}</option>`;
const asmOptions = (cat, kind, cur, none = false) => (none ? opt('', '(없음)', cur || '') : '') + cat.assemblies.filter((a) => a.kind === kind).map((a) => opt(a.id, `${a.code ? `${a.code} · ` : ''}${a.name}`, cur)).join('');

onAction('bim-edit', async (btn) => {
  const v = bimViewerState();
  if (!canEdit(v)) return;
  const kind = btn.dataset.kind;
  const id = btn.dataset.id;
  const files = await currentFiles(v);
  const names = await viewerFileNames();
  const cat = files['catalog.json'];
  const ctx = v.ctx;
  let body = '';
  let danger = '';
  let file = '';
  if (kind === 'wall') {
    file = names.type;
    const w = findElement(ctx, id).obj;
    const side = (sid) => ctx.type.spaces.find((s) => s.id === sid)?.name || (w.exterior ? '바깥' : '-');
    body = `<label class="field"><span>벽체 기호(조립체)</span><select name="assemblyId">${asmOptions(cat, 'wall', w.assemblyId)}</select></label>
      <div class="grid2"><label class="field"><span>두께(mm)</span><input name="thicknessMm" type="number" min="10" max="3000" step="1" value="${mm(w.thickness)}"></label>
      <div class="field"><span>조립체 층</span><button type="button" class="btn sm ghost" data-act="bim-edit" data-kind="assembly" data-id="${esc(w.assemblyId || '')}" ${w.assemblyId ? '' : 'disabled'}>${icon('layers')}층 구성 고치기</button></div></div>
      <label class="check"><input type="checkbox" name="flip"><span>실내/실외 쪽 뒤집기 <span class="muted small">(지금 실내 쪽: ${esc(side(w.sides?.in))}, 반대쪽: ${esc(side(w.sides?.out))})</span></span></label>
      ${w.code ? `<label class="check"><input type="checkbox" name="sameCode"><span>같은 기호 <b>${esc(w.code)}</b>의 모든 벽에(모든 타입·층) 기호·두께 적용</span></label>` : ''}`;
    danger = `<button type="button" class="btn ghost danger" data-act="bim-edit-remove" data-file="${esc(file)}" data-id="${esc(id)}">${icon('trash')}이 벽 지우기</button>`;
  } else if (kind === 'space') {
    file = names.type;
    const s = findElement(ctx, id).obj;
    const f = s.finish || {};
    body = `<div class="grid2"><label class="field"><span>실 이름</span><input name="name" maxlength="40" value="${esc(s.name)}" required></label>
      <label class="field"><span>용도</span><select name="use">${Object.entries(USE_LABEL).map(([k, l]) => opt(k, l, s.use)).join('')}</select></label></div>
      <label class="field"><span>바닥 마감</span><select name="floor">${asmOptions(cat, 'floor', f.floor || '', true)}</select></label>
      <label class="field"><span>벽 마감</span><select name="wall">${asmOptions(cat, 'wall', f.wall || '', true)}</select></label>
      <label class="field"><span>천장 마감</span><select name="ceiling">${asmOptions(cat, 'ceiling', f.ceiling || '', true)}</select></label>
      <fieldset class="field"><legend>시공부위</legend><div class="chk-row">${Object.entries(ZONE_LABEL).map(([k, l]) => `<label class="check"><input type="checkbox" name="z_${k}" ${(s.zones || []).includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>`;
  } else if (kind === 'opening') {
    file = names.type;
    const o = findElement(ctx, id).obj;
    body = `<div class="grid2"><label class="field"><span>기호</span><input name="typeCode" maxlength="20" value="${esc(o.typeCode || '')}" placeholder="예) AW1"></label>
      <label class="field"><span>폭(mm)</span><input name="widthMm" type="number" min="100" max="20000" value="${mm(o.width)}"></label>
      <label class="field"><span>높이(mm)</span><input name="heightMm" type="number" min="100" max="20000" value="${mm(o.height)}"></label>
      <label class="field"><span>창대 높이(mm)</span><input name="sillMm" type="number" min="0" max="20000" value="${mm(o.sill)}"></label></div>`;
    danger = `<button type="button" class="btn ghost danger" data-act="bim-edit-remove" data-file="${esc(file)}" data-id="${esc(id)}">${icon('trash')}지우기</button>`;
  } else if (kind === 'unit') {
    file = names.building;
    const u = findElement(ctx, id).obj;
    const types = Object.entries(names.index.files.unitTypes);
    const labels = types.map(([tid, fname]) => [tid, files[fname]?.name || tid]);
    body = `<label class="field"><span>세대 타입</span><select name="unitTypeId">${labels.map(([tid, n]) => opt(tid, n, u.unitTypeId)).join('')}</select></label>
      <div class="grid2"><label class="field"><span>호수</span><input name="label" maxlength="10" value="${esc(u.label)}"></label>
      <label class="field"><span>라인</span><input name="line" maxlength="10" value="${esc(u.line || '')}"></label></div>
      <p class="muted small">라인을 바꾸면 골구도 칸(층:라인)도 바뀝니다.</p>`;
  } else if (kind === 'building') {
    const b = files['site.json'].buildings.find((x) => x.id === id);
    body = `<div class="grid2"><label class="field"><span>이름</span><input name="name" maxlength="60" value="${esc(b.name)}"></label>
      <label class="field"><span>종류</span><select name="kind">${[['apartment', '아파트 동'], ['community', '커뮤니티 시설'], ['parking', '주차장'], ['commercial', '상가'], ['other', '기타']].map(([k, l]) => opt(k, l, b.kind)).join('')}</select></label></div>
      <div class="grid3"><label class="field"><span>동쪽으로(m)</span><input name="dx" type="number" step="0.1" value="0"></label>
      <label class="field"><span>북쪽으로(m)</span><input name="dy" type="number" step="0.1" value="0"></label>
      <label class="field"><span>돌리기(도, 반시계)</span><input name="dRot" type="number" step="0.5" value="0"></label></div>`;
  } else if (kind === 'level') {
    file = names.building;
    const l = ctx.building.levels.find((x) => x.id === id);
    body = `<div class="grid2"><label class="field"><span>층 이름</span><input name="name" maxlength="20" value="${esc(l.name)}"></label>
      <label class="field"><span>층고(m)</span><input name="heightM" type="number" min="0" max="30" step="0.01" value="${l.height}"></label></div>
      <p class="muted small">층고를 바꾸면 위층 바닥 높이와 단지의 동 높이도 같이 바뀝니다.</p>`;
  } else if (kind === 'assembly') {
    const a = cat.assemblies.find((x) => x.id === id);
    if (!a) return;
    body = `<label class="field"><span>이름</span><input name="name" maxlength="80" value="${esc(a.name)}"></label>
      <p class="muted small">순서: 위가 실외 쪽(out) → 구조체(core) → 아래가 실내 쪽(in). 이 조립체를 쓰는 모든 벽·실이 같이 바뀝니다.</p>
      <table class="trade-table asm-table"><thead><tr><th>#</th><th>재료</th><th>두께(mm)</th><th>쪽</th><th></th></tr></thead><tbody id="asm-rows">${a.layers.map((l, i) => asmRow(cat, l, i)).join('')}</tbody></table>
      <button type="button" class="btn sm ghost" data-act="asm-add">${icon('plus')}층 추가</button>`;
  }
  openModal({
    title: `${KIND_TITLE[kind]} 고치기${kind === 'wall' || kind === 'opening' || kind === 'space' ? ` — ${elementName(files, file, id)}` : ''}`,
    wide: kind === 'assembly',
    body: `<form id="f-bim-edit" data-form="bim-edit" data-kind="${kind}" data-id="${esc(id)}" data-file="${esc(file)}" novalidate>${body}</form>`,
    footer: `${danger}<span class="spacer"></span><button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" class="btn primary" form="f-bim-edit">${icon('check')}바꾸기</button>`,
  });
});

function asmRow(cat, l, i) {
  return `<tr><td class="num">${i + 1}</td>
    <td><select name="m${i}" aria-label="재료">${cat.materials.map((m) => opt(m.id, `${m.name} (${CATEGORY_LABEL[m.category] || m.category})`, l.materialId)).join('')}</select></td>
    <td><input name="t${i}" type="number" min="0" max="5000" step="0.5" value="${l.thicknessMm ?? ''}" aria-label="두께" style="width:90px"></td>
    <td><select name="s${i}" aria-label="쪽">${[['out', '실외 쪽'], ['core', '구조'], ['in', '실내 쪽']].map(([k, n]) => opt(k, n, l.side)).join('')}</select></td>
    <td class="row-act"><button type="button" class="icon-btn sm" data-act="asm-up" aria-label="위로" title="위로">${icon('back')}</button><button type="button" class="icon-btn sm" data-act="asm-del" aria-label="빼기" title="빼기">${icon('close')}</button></td></tr>`;
}
const renumberAsm = () => $$('#asm-rows tr').forEach((tr, i) => { tr.querySelector('.num').textContent = i + 1; });
onAction('asm-add', async () => {
  const files = await currentFiles(bimViewerState());
  const n = $$('#asm-rows tr').length;
  $('#asm-rows').insertAdjacentHTML('beforeend', asmRow(files['catalog.json'], { materialId: files['catalog.json'].materials[0].id, thicknessMm: 10, side: 'in' }, n));
});
onAction('asm-del', (el) => { if ($$('#asm-rows tr').length > 1) { el.closest('tr').remove(); renumberAsm(); } });
onAction('asm-up', (el) => { const tr = el.closest('tr'); if (tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling); renumberAsm(); });

onForm('bim-edit', async (data, form) => {
  const v = bimViewerState();
  const { kind, id, file } = form.dataset;
  const files = await currentFiles(v);
  const ctx = v.ctx;
  const num = (k) => Number(data[k]);
  let ops = [];
  if (kind === 'wall') ops = wallOps(files, file, findElement(ctx, id).obj, { assemblyId: data.assemblyId, thicknessMm: num('thicknessMm'), flip: data.flip, sameCode: data.sameCode });
  else if (kind === 'space') ops = spaceOps(file, findElement(ctx, id).obj, { name: data.name, use: data.use, floor: data.floor, wall: data.wall, ceiling: data.ceiling, zones: Object.keys(ZONE_LABEL).filter((z) => data[`z_${z}`]) });
  else if (kind === 'opening') ops = openingOps(file, findElement(ctx, id).obj, { typeCode: data.typeCode, widthMm: num('widthMm'), heightMm: num('heightMm'), sillMm: num('sillMm') });
  else if (kind === 'unit') ops = unitOps(file, findElement(ctx, id).obj, { unitTypeId: data.unitTypeId, label: data.label, line: data.line });
  else if (kind === 'building') ops = buildingOps(files, id, { name: data.name, kind: data.kind, dx: num('dx') || 0, dy: num('dy') || 0, dRot: num('dRot') || 0 });
  else if (kind === 'level') ops = levelOps(files, file, ctx.building.levels.find((x) => x.id === id), { name: data.name, heightM: num('heightM') });
  else if (kind === 'assembly') {
    const a = files['catalog.json'].assemblies.find((x) => x.id === id);
    const layers = $$('#asm-rows tr', form).map((tr) => {
      const [m, t, s] = tr.querySelectorAll('select, input');
      return { materialId: m.value, thicknessMm: t.value === '' ? null : Number(t.value), side: s.value };
    });
    ops = assemblyOps(a, layers, { name: data.name });
  }
  if (await addOps(ops)) {
    closeModal(true);
    toast(`${KIND_TITLE[kind]}: ${ops.length}곳을 바꿨습니다(미리보기). [새 버전으로 저장]을 눌러야 저장됩니다.`);
  }
});

onAction('bim-edit-remove', async (btn) => {
  const v = bimViewerState();
  const files = await currentFiles(v);
  const name = elementName(files, btn.dataset.file, btn.dataset.id);
  if (!(await confirmDialog(`${name}을(를) 지울까요?${btn.dataset.id.startsWith('w_') ? '\n이 벽에 붙은 문·창도 같이 지워집니다.' : ''}\n[새 버전으로 저장] 전까지는 미리보기입니다.`, { title: '지우기', ok: '지우기', danger: true }))) return;
  if (await addOps([removeOp(btn.dataset.file, btn.dataset.id)])) {
    closeModal(true);
    viewerSelect([]);
  }
});

