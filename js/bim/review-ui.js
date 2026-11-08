// AI 수정 요청(07 3절) 화면: [이 부분 수정 요청](정보 패널·검증 목록) → 요청 창(고른 요소·위치·지시·참고 도면·추가 자료) →
// ai-edit 호출 → 수정안 미리보기(이해한 내용·연산마다 이유와 근거 조각·3D 강조·일부만 고르기) → 적용(새 초안 버전) / 답하고 이어서 / 다시 요청 / 거절.
// 3D 보기 오른쪽 패널에 "요청" 탭(이 버전의 수정 요청 목록). AI가 꺼져 있으면(데모·보안 승인 전) 요청만 저장한다.
import { store } from '../ctx.js';
import { addElementAction } from './model-panel.js';
import { setReviewHandler, drawCrop } from './findings-ui.js';
import { addViewerHook, bimViewerState, viewerModelFiles, viewerMarks, viewerFileNames, openBimViewer } from './viewer.js';
import { saveVersion } from './edit.js';
import { applyPatch, describeOp, elementName } from './validate.js';
import { openSheetViewer } from './sheet-viewer.js';
import { parseBlob, sheetsOf } from '../cad/read.js';
import { renderPng } from '../cad/render.js';
import { $, esc, icon, onAction, onForm, openModal, closeModal, toast, confirmDialog, loadScript, fmtDateTime as when } from '../util.js';

const STATUS = { open: '열림', ai_running: 'AI 확인 중', proposed: '수정안 있음', applied: '적용함', rejected: '거절함' };
const BADGE = { open: '', ai_running: 'info', proposed: 'warn', applied: 'ok', rejected: '' };
const XLSX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const canEdit = (v) => Boolean(v) && store.can('edit', v.siteId);
const aiReady = () => Boolean(store.ai?.available); // 데모(브라우저 저장)는 항상 꺼짐

// ---------------------------------------------------------------- 단추·탭

addElementAction((ctx, el) => {
  const v = bimViewerState();
  if (!canEdit(v)) return '';
  const ids = (Array.isArray(el) ? el : [el]).map((e) => e.obj.id);
  return `<button type="button" class="btn sm" data-act="bim-review" data-ids="${esc(ids.join(','))}">${icon('refresh')}이 부분 수정 요청</button>`;
});

// 검증 목록의 [수정 요청]: 그 결과의 요소·문장으로 채워서
setReviewHandler(async ({ finding, model, siteId }) => {
  // 도서 관리의 검증 목록에서 눌렀으면 그 버전 3D를 열고 요청 창을
  if (bimViewerState()?.model.id !== model.id) await openBimViewer(siteId, model.id);
  if (!bimViewerState()?.ctx) return;
  await openRequest({ ids: finding.elementIds || [], text: `검증 결과: ${finding.message}\n→ ` });
});

addViewerHook('tabs', {
  key: 'reviews',
  title: '요청',
  render(el, v) {
    const list = store.bim.cachedReviews(v.model.id);
    if (!list) { el.innerHTML = '<p class="muted small loading">불러오는 중…</p>'; store.bim.reviews(v.model.id).catch(() => {}); return; }
    const sorted = [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    el.innerHTML = `${canEdit(v) ? `<button type="button" class="btn sm" data-act="bim-review" data-ids="">${icon('plus')}새 수정 요청</button>` : ''}
      ${!aiReady() ? '<p class="muted small">AI 수정은 공유 모드에서 운영자가 AI를 켜면 쓸 수 있어요. 지금은 요청만 저장됩니다.</p>' : ''}
      <ul class="rv-list">${sorted.map((r) => `<li><button type="button" data-act="bim-review-open" data-id="${esc(r.id)}">
        <span class="badge ${BADGE[r.status] || ''}">${STATUS[r.status] || r.status}</span>
        <span class="rv-text">${esc(r.instruction.slice(0, 120))}</span>
        <span class="muted small">${esc(when(r.createdAt))}${r.proposal?.ops?.length ? ` · 수정안 ${r.proposal.ops.length}개` : ''}${r.proposal?.questions?.length ? ` · 질문 ${r.proposal.questions.length}` : ''}</span></button></li>`).join('') || '<li class="muted small">이 버전의 수정 요청이 없습니다.</li>'}</ul>`;
    const badge = v.el.querySelector('#bv-reviews-count');
    if (badge) badge.textContent = sorted.filter((r) => r.status === 'proposed').length || '';
  },
});
addViewerHook('chrome', (v) => {
  const list = store.bim.cachedReviews(v.model.id);
  const badge = v.el.querySelector('#bv-reviews-count');
  if (!list && !v.reviewsAsked) { v.reviewsAsked = v.model.id; store.bim.reviews(v.model.id).catch(() => {}); }
  if (badge) badge.textContent = (list || []).filter((r) => r.status === 'proposed').length || '';
});

// ---------------------------------------------------------------- 요청 창

onAction('bim-review', (btn) => openRequest({ ids: (btn.dataset.ids || '').split(',').filter(Boolean) }));

async function openRequest({ ids = [], text = '' } = {}) {
  const v = bimViewerState();
  if (!canEdit(v)) return;
  const files = await viewerModelFiles();
  const names = await viewerFileNames();
  const c = v.ctx;
  const where = [c.building?.name, c.unit?.label ? `${c.unit.label}호` : null, c.type ? `${c.type.name}${c.type.kind === 'facility' ? '' : ' 타입'}` : null].filter(Boolean).join(' · ') || '단지 전체';
  const fileOf = (id) => Object.keys(files).find((k) => k !== 'index.json' && elementName(files, k, id) !== id) || '';
  const chips = ids.map((id) => `<span class="chip">${esc(elementName(files, fileOf(id), id))}</span>`).join('');
  const sheets = v.sheets || [];
  openModal({
    title: '수정 요청',
    wide: true,
    body: `<form id="f-bim-review" data-form="bim-review" data-ids="${esc(ids.join(','))}" novalidate>
      <p class="small"><b>위치</b> ${esc(where)}${ids.length ? ` · <b>고른 요소</b> ${chips}` : ''}</p>
      <label class="field"><span>지시 <em>*</em></span><textarea name="instruction" rows="5" maxlength="4000" required placeholder="예) 84A 욕실 벽이 도배로 되어 있는데 A-601 마감표 보면 타일이야. 다시 확인해서 고쳐줘">${esc(text)}</textarea></label>
      ${sheets.length ? `<details class="rv-sheets"><summary>참고 도면 고르기(선택)</summary><div class="rv-sheet-list">${sheets.map((s) => `<label class="check"><input type="checkbox" name="sh_${esc(s.sheetNo || s.id)}"><span>${esc(s.sheetNo || '-')} ${esc(s.title || '')}</span></label>`).join('')}</div></details>` : ''}
      <label class="field"><span>추가 자료(선택, 10개까지)</span><input type="file" name="files" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.dxf,.xlsx,.xls,.csv,.txt"></label>
      <p class="muted small">PDF·사진은 그대로, 도면(DXF)은 그림과 글자 요약으로, 엑셀은 표 글자로 바꿔 올립니다. ${aiReady() ? 'AI가 관련 도면을 다시 보고 수정안을 냅니다(비용이 듭니다). 적용은 확인 후 직접 합니다.' : '<b>지금은 AI가 꺼져 있어 요청만 저장됩니다.</b>'}</p>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" class="btn primary" form="f-bim-review">${icon('check')}${aiReady() ? 'AI에게 요청' : '요청 저장'}</button>`,
  }).dataset.where = JSON.stringify({ buildingId: c.building?.id || null, level: c.unit?.levelId || null, unitKey: c.unit?.unitKey || null, unitTypeId: c.type?.id || null, file: names.type || names.building || null });
}

// 추가 자료 올리기(형식 바꾸기 포함) → [{ path, name, type, size }]
async function uploadAttachments(siteId, list) {
  const out = [];
  for (const f of list.slice(0, 10)) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'dxf') {
      const { sheets } = sheetsOf(await parseBlob(f), { fileName: f.name });
      for (const [i, s] of sheets.slice(0, 3).entries()) {
        const png = await renderPng(s.flat.items, s.frame);
        const nm = `${f.name}${sheets.length > 1 ? `-${i + 1}` : ''}`;
        out.push({ ...(await store.bim.uploadReviewFile(siteId, new File([png.blob], `${nm}.png`, { type: 'image/png' }))), name: `${nm}.png`, type: 'image/png' });
        const summary = JSON.stringify({ titleBlock: s.titleBlock, texts: s.digest.texts.slice(0, 600).map((t) => t.t), tables: s.digest.tables });
        out.push({ ...(await store.bim.uploadReviewFile(siteId, new File([summary], `${nm}.json`, { type: 'application/json' }))), name: `${nm}.json`, type: 'application/json' });
      }
    } else if (ext === 'xlsx' || ext === 'xls') {
      await loadScript(XLSX_SRC);
      const wb = window.XLSX.read(await f.arrayBuffer());
      const csv = wb.SheetNames.map((n) => `# ${n}\n${window.XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n');
      out.push({ ...(await store.bim.uploadReviewFile(siteId, new File([csv], `${f.name}.csv`, { type: 'text/csv' }))), name: `${f.name}.csv`, type: 'text/csv' });
    } else {
      const type = f.type || (ext === 'pdf' ? 'application/pdf' : 'application/octet-stream');
      out.push({ ...(await store.bim.uploadReviewFile(siteId, f)), name: f.name, type });
    }
  }
  return out.map(({ path, name, type, size }) => ({ path, name, type, size: size || 0 }));
}

onForm('bim-review', async (data, form) => {
  const v = bimViewerState();
  const instruction = String(data.instruction || '').trim();
  if (!instruction) throw new Error('무엇을 어떻게 고칠지 적어주세요.');
  const files = [...(form.querySelector('[name=files]').files || [])];
  if (files.length > 10) throw new Error('추가 자료는 10개까지 올릴 수 있습니다.');
  const sheetNos = Object.keys(data).filter((k) => k.startsWith('sh_') && data[k]).map((k) => k.slice(3));
  const location = JSON.parse($('#modal')?.dataset.where || '{}');
  const attachments = files.length ? await uploadAttachments(v.siteId, files) : [];
  const rv = await store.bim.createReview({
    modelId: v.model.id, elementIds: (form.dataset.ids || '').split(',').filter(Boolean), location, instruction, sheetNos, attachments,
    messages: [{ role: 'user', text: instruction, at: new Date().toISOString() }],
  });
  closeModal(true);
  if (!aiReady()) { toast('수정 요청을 저장했습니다. AI 수정은 공유 모드에서 AI를 켜면 쓸 수 있어요.'); return; }
  await callAi(rv.id, {});
});

async function callAi(reviewId, payload) {
  toast('AI가 관련 도면을 다시 보고 있어요. 1~3분 걸릴 수 있습니다.');
  try {
    const r = await store.ai.call('ai-edit', { reviewId, ...payload });
    const v = bimViewerState();
    if (v) await store.bim.reviews(v.model.id);
    toast(`AI 수정안을 받았습니다${r?.costUsd ? `(비용 $${Number(r.costUsd).toFixed(2)})` : ''}.`);
    openProposal(reviewId);
  } catch (err) {
    const v = bimViewerState();
    if (v) await store.bim.reviews(v.model.id).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------- 수정안 미리보기

onAction('bim-review-open', (btn) => openProposal(btn.dataset.id));

async function openProposal(reviewId) {
  const v = bimViewerState();
  if (!v) return;
  const rv = (store.bim.cachedReviews(v.model.id) || await store.bim.reviews(v.model.id)).find((x) => x.id === reviewId);
  if (!rv) return;
  const files = await viewerModelFiles();
  const p = rv.proposal;
  const edit = canEdit(v) && ['proposed', 'open'].includes(rv.status);
  const sheetById = (id) => (v.sheets || []).find((s) => s.id === id);
  const evBox = (e, key) => {
    const s = e?.sheetId && sheetById(e.sheetId);
    return s ? `<button type="button" class="fd-ev" data-act="rv-sheet" data-sheet="${esc(s.id)}" data-bbox="${esc(JSON.stringify(e.bbox || null))}"><canvas data-rv-crop="${esc(key)}" width="220" height="130"></canvas><span>${esc(s.sheetNo || '도면')}${e.note ? ` · ${esc(e.note)}` : ''}</span></button>` : '';
  };
  const crops = [];
  const opsHtml = (p?.ops || []).map((op, i) => {
    const ev = (op.evidence || []).filter((e) => e.sheetId).slice(0, 2);
    ev.forEach((e, k) => crops.push({ key: `${i}-${k}`, e }));
    return `<li class="rv-op"><label class="check"><input type="checkbox" name="op${i}" ${op.applied === false ? '' : 'checked'} ${edit ? '' : 'disabled'}><span><b>${esc(describeOp(files, op))}</b><br><span class="muted small">${esc(op.reason || '')}</span></span></label>
      ${ev.length ? `<div class="fd-evs">${ev.map((e, k) => evBox(e, `${i}-${k}`)).join('')}</div>` : ''}</li>`;
  }).join('');
  const talk = (rv.messages || []).map((m) => `<li class="${m.role}"><b>${m.role === 'ai' ? 'AI' : '담당자'}</b> ${esc(m.text)}<span class="muted small"> ${esc(when(m.at))}</span></li>`).join('');
  openModal({
    title: `수정 요청 — ${STATUS[rv.status] || rv.status}`,
    wide: true,
    body: `<form id="f-bim-proposal" data-form="bim-proposal" data-id="${esc(rv.id)}" novalidate>
      <details class="rv-talk" ${p ? '' : 'open'}><summary>대화 ${rv.messages?.length || 0}</summary><ul>${talk}</ul></details>
      ${p ? `<h4>AI가 이해한 내용</h4><p class="rv-under">${esc(p.understanding || '')}</p>
        ${p.questions?.length ? `<h4>AI 질문</h4>${p.questions.map((q, i) => `<label class="field"><span>${esc(q)}</span><input name="a${i}" maxlength="2000" ${edit ? '' : 'disabled'} placeholder="답"></label>`).join('')}` : ''}
        ${p.ops?.length ? `<h4>바꿀 것 ${p.ops.length}개 <span class="muted small">— 적용할 것만 고르세요</span></h4><ul class="rv-ops">${opsHtml}</ul>` : `<p class="muted small">${p.incomplete ? '' : '바꿀 것이 없다고 합니다.'}</p>`}` : `<p class="muted small">${rv.status === 'ai_running' ? 'AI가 확인하는 중입니다.' : aiReady() ? '아직 AI 수정안이 없습니다.' : 'AI가 꺼져 있어 요청만 저장되어 있습니다.'}</p>`}
      ${edit && aiReady() ? `<label class="field"><span>다시 요청(덧붙일 지시, 선택)</span><textarea name="followup" rows="2" maxlength="4000" placeholder="예) 욕실2도 같이 봐줘"></textarea></label>` : ''}
    </form>`,
    footer: `${p?.ops?.length ? '<button type="button" class="btn ghost" data-act="rv-mark">3D에 표시</button>' : ''}<span class="spacer"></span>
      ${edit ? '<button type="button" class="btn ghost" data-act="rv-reject">거절</button>' : ''}
      ${edit && aiReady() ? `<button type="button" class="btn" data-act="rv-again">${icon('refresh')}${p?.questions?.length ? '답하고 이어서' : '다시 요청'}</button>` : ''}
      ${edit && p?.ops?.length ? `<button type="submit" class="btn primary" form="f-bim-proposal">${icon('check')}고른 것 적용(새 버전)</button>` : '<button type="button" class="btn ghost" data-act="modal-close">닫기</button>'}`,
  });
  for (const { key, e } of crops) {
    const cv = document.querySelector(`canvas[data-rv-crop="${key}"]`);
    const s = sheetById(e.sheetId);
    if (cv && s) drawCrop(cv, s, e.bbox);
  }
  // 수정안이 바꾸는 요소를 3D에서 바로 강조
  if (p?.ops?.length) markOps(p.ops);
}

function markOps(ops) {
  const marks = new Map();
  for (const op of ops) marks.set(op.id || op.element?.id, op.op === 'remove' ? '#E03131' : op.op === 'add' ? '#2B8A3E' : '#F59F00');
  viewerMarks(marks);
}

const reviewOf = (id) => (store.bim.cachedReviews(bimViewerState()?.model.id) || []).find((x) => x.id === id);
const chosen = (form, p) => p.ops.filter((_, i) => form.querySelector(`[name=op${i}]`)?.checked);

onAction('rv-mark', () => {
  const form = $('#f-bim-proposal');
  const rv = reviewOf(form?.dataset.id);
  if (!rv?.proposal) return;
  markOps(chosen(form, rv.proposal));
  closeModal(true);
  toast('3D에 표시했습니다: 바뀜 노랑 · 추가 초록 · 지움 빨강. [요청] 탭에서 다시 열 수 있어요.');
});
onAction('rv-sheet', (btn) => {
  const s = (bimViewerState()?.sheets || []).find((x) => x.id === btn.dataset.sheet);
  const b = JSON.parse(btn.dataset.bbox || 'null');
  if (s) openSheetViewer(s, { boxes: b ? [[b.x0, b.y0, b.x1, b.y1]] : [] });
});

onForm('bim-proposal', async (data, form) => {
  const v = bimViewerState();
  const rv = reviewOf(form.dataset.id);
  if (!rv?.proposal) return;
  const ops = chosen(form, rv.proposal);
  if (!ops.length) throw new Error('적용할 것을 하나 이상 고르세요.');
  if (v.edits?.ops.length) throw new Error('직접 고치는 중인 내용이 있습니다. 먼저 저장하거나 버리세요.');
  const r = applyPatch(await viewerModelFiles(), ops, { method: 'ai', reviewId: rv.id });
  if (!r.ok) throw new Error(`적용할 수 없습니다(그 사이 모델이 바뀌었을 수 있어요): ${r.errors.slice(0, 3).join(' / ')}`);
  closeModal(true);
  const parent = v.model;
  const m = await saveVersion(r.files, { note: `AI 수정: ${rv.instruction.slice(0, 80)}`, parent });
  const marked = rv.proposal.ops.map((op) => ({ ...op, applied: ops.includes(op) }));
  await store.bim.updateReview(rv.id, { status: 'applied', resultModelId: m.id, proposal: { ...rv.proposal, ops: marked } });
  markOps(ops);
  toast(`수정안 ${ops.length}개를 적용해 v${m.version}(초안)을 만들었습니다. 확인 후 [확정하기]를 누르세요.`);
});

onAction('rv-again', async () => {
  const form = $('#f-bim-proposal');
  const rv = reviewOf(form?.dataset.id);
  if (!rv) return;
  const answers = (rv.proposal?.questions || []).map((q, i) => ({ question: q, answer: String(form.querySelector(`[name=a${i}]`)?.value || '').trim() })).filter((a) => a.answer);
  const followup = String(form.querySelector('[name=followup]')?.value || '').trim();
  if (rv.proposal?.questions?.length && !answers.length && !followup) throw new Error('AI 질문에 답하거나 덧붙일 지시를 적어주세요.');
  // 담당자가 뺀 연산을 기록해 두면 다음 요청 요약에 "담당자가 뺌"으로 들어간다
  if (rv.proposal?.ops?.length) await store.bim.updateReview(rv.id, { proposal: { ...rv.proposal, ops: rv.proposal.ops.map((op, i) => ({ ...op, applied: form.querySelector(`[name=op${i}]`)?.checked !== false })) } });
  closeModal(true);
  await callAi(rv.id, { followup, answers });
});

onAction('rv-reject', async () => {
  const form = $('#f-bim-proposal');
  const rv = reviewOf(form?.dataset.id);
  if (!rv || !(await confirmDialog('이 수정 요청을 거절(닫기)할까요? 기록은 남습니다.', { title: '거절', ok: '거절' }))) return;
  await store.bim.updateReview(rv.id, { status: 'rejected' });
  viewerMarks(null);
  toast('거절로 표시했습니다.');
});

export { openRequest, openProposal };
