// AI로 읽기(도서 관리 화면의 도구): 시트마다 analysis_jobs(classify_sheet)를 만들고 Edge Function ai-sheet를 3개씩 부른다.
// 분류가 끝나면 함수가 extract_sheet 작업을 만들고, 이 화면이 이어서 부른다. 창을 닫았다 열어도 남은 작업을 이어 한다.
// 비용은 작업마다 기록되고(analysis_jobs.costUsd) 이 화면에 합계로 보인다. AI 설정(켜기·예산)은 운영자만.
import { store } from './ctx.js';
import { addDrawingsTool, drawingsState, rerenderDrawings } from './drawings.js';
import { esc, icon, onAction, onForm, openModal, closeModal, toast, confirmDialog } from './util.js';
import { retriage, refreshOverlay } from './bim/triage-run.js';

const CONCURRENCY = 3;
const STALE_MS = 10 * 60 * 1000;
const running = new Map(); // setId → { active: Set<jobId>, stop: boolean }
let settings = null; // 현재 현장 AI 설정(공유 모드)
let settingsFor = null;

const isStale = (j) => j.status === 'running' && Date.now() - Date.parse(j.startedAt || j.updatedAt || 0) > STALE_MS;
const todo = (j) => j.status === 'queued' || isStale(j);

async function loadSettings(siteId) {
  if (store.mode !== 'remote') return null;
  if (settingsFor === siteId && settings) return settings;
  settingsFor = siteId;
  settings = await store.ai.settings(siteId).catch(() => null);
  rerenderDrawings();
  return settings;
}

function jobStats(setId) {
  const jobs = store.jobs.cached(setId) || [];
  const ai = jobs.filter((j) => j.kind === 'classify_sheet' || j.kind === 'extract_sheet' || j.kind === 'triage_sheet');
  return {
    jobs: ai,
    done: ai.filter((j) => j.status === 'done').length,
    failed: ai.filter((j) => j.status === 'error'),
    pending: ai.filter(todo).length,
    active: ai.filter((j) => j.status === 'running' && !isStale(j)).length,
    cost: jobs.reduce((a, j) => a + Number(j.costUsd || 0), 0),
  };
}

// 도서 관리 도구 막대에 붙는 단추·상태
addDrawingsTool((dv, { set, editable }) => {
  if (store.mode !== 'remote') return '<span class="badge plain" title="AI 판독은 공유 모드(로그인)에서 씁니다">규칙으로 읽음</span>';
  if (settingsFor !== dv.siteId) queueMicrotask(() => loadSettings(dv.siteId));
  if (store.jobs.cached(set.id) === undefined && !dv.jobsLoading) {
    dv.jobsLoading = true;
    queueMicrotask(() => store.jobs.list(dv.siteId, { setId: set.id }).catch(() => {}).finally(() => { dv.jobsLoading = false; }));
  }
  const st = jobStats(set.id);
  const run = running.get(set.id);
  const on = settings?.enabled;
  const busy = Boolean(run && !run.stop);
  const parts = [];
  if (editable) {
    if (!on) parts.push(`<button type="button" class="btn sm" data-act="ai-off-info" title="AI가 꺼져 있습니다">${icon('lock')}AI 꺼짐</button>`);
    else if (busy) parts.push(`<button type="button" class="btn sm" data-act="ai-stop">${icon('close')}AI 멈추기</button>`);
    else parts.push(`<button type="button" class="btn sm primary" data-act="ai-run">${icon('refresh')}${st.pending ? `AI 판독 이어서(${st.pending})` : 'AI로 읽기'}</button>`);
    if (on && !busy && st.failed.length) parts.push(`<button type="button" class="btn sm" data-act="ai-retry">${icon('alert')}실패 ${st.failed.length}건 다시</button>`);
  }
  if (st.jobs.length) {
    const total = st.jobs.length;
    parts.push(`<span class="badge ${st.failed.length ? 'warn' : busy ? 'info' : 'ok'}" title="AI 판독 작업">AI ${st.done}/${total}${busy ? ' 진행 중' : ''}</span>`);
  }
  if (st.cost > 0) parts.push(`<span class="badge plain" title="이 묶음의 AI 비용 합계">AI 비용 $${st.cost.toFixed(2)}</span>`);
  if (store.can('admin')) parts.push(`<button type="button" class="icon-btn sm" data-act="ai-settings" aria-label="AI 설정" title="AI 설정(운영자)">${icon('settings')}</button>`);
  return parts.join('');
});

// ---------------------------------------------------------------- 작업 큐

async function ensureJobs(siteId, setId, { retry = false } = {}) {
  const sheets = store.drawings.cachedSheets(setId) || [];
  const jobs = await store.jobs.list(siteId, { setId });
  const byKey = new Map();
  for (const j of jobs) if (j.target?.sheetId) byKey.set(`${j.kind}|${j.target.sheetId}`, j);
  let made = 0;
  for (const s of sheets) {
    const j = byKey.get(`classify_sheet|${s.id}`);
    if (!j) { await store.jobs.create(siteId, 'classify_sheet', { sheetId: s.id }, { setId }); made++; } else if (retry && j.status === 'error') { await store.jobs.update(j.id, { status: 'queued', error: '' }); made++; }
    const x = byKey.get(`extract_sheet|${s.id}`);
    if (retry && x?.status === 'error') { await store.jobs.update(x.id, { status: 'queued', error: '' }); made++; }
  }
  return made;
}

// 시트 판별 잇기: 분류가 끝나면 쓰임새가 바뀌었으니 규칙 판별을 다시 하고, AI 판별은 바뀐 곳이 있으면 2회째까지
async function afterJob(siteId, setId, j, r) {
  const sheetId = j.target?.sheetId;
  const sheets = await store.drawings.sheets(setId);
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet) return;
  if (j.kind === 'classify_sheet') {
    const sets = store.drawings.cached(siteId) || [];
    await retriage(sheet, { profile: sets.find((s) => s.id === setId)?.stats?.triageProfile || {} });
    await store.jobs.create(siteId, 'triage_sheet', { sheetId, pass: 1 }, { setId });
  } else if (j.kind === 'triage_sheet' && r?.next) {
    await refreshOverlay(sheet);
    await store.jobs.create(siteId, 'triage_sheet', { sheetId, ...r.next }, { setId });
  }
}

async function pump(siteId, setId) {
  if (running.has(setId)) return;
  const run = { active: new Set(), stop: false };
  running.set(setId, run);
  rerenderDrawings();
  let fatal = null;
  try {
    for (;;) {
      if (run.stop || fatal) break;
      const jobs = store.jobs.cached(setId) || [];
      // 분류 먼저, 그다음 추출
      const next = jobs.filter((j) => todo(j) && !run.active.has(j.id)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'classify_sheet' ? -1 : b.kind === 'classify_sheet' ? 1 : a.kind === 'extract_sheet' ? 1 : -1));
      if (!next.length && !run.active.size) break;
      while (run.active.size < CONCURRENCY && next.length && !fatal) {
        const j = next.shift();
        run.active.add(j.id);
        store.ai.call('ai-sheet', { jobId: j.id })
          .then((r) => afterJob(siteId, setId, j, r))
          .catch((err) => {
            // 권한·꺼짐·예산·키 문제는 모든 작업에 같으므로 멈춘다(작업은 대기 상태로 남는다)
            if (/권한|꺼져|예산|키\(|배포되지|로그인/.test(err.message)) fatal = err;
          })
          .finally(async () => {
            run.active.delete(j.id);
            await store.jobs.list(siteId, { setId }).catch(() => {});
            await store.drawings.sheets(setId).catch(() => {});
            rerenderDrawings();
          });
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    while (run.active.size) await new Promise((r) => setTimeout(r, 500));
  } finally {
    running.delete(setId);
    rerenderDrawings();
  }
  if (fatal) { toast(fatal.message, 'crit'); return; }
  const st = jobStats(setId);
  if (!run.stop) toast(st.failed.length ? `AI 판독을 마쳤습니다. 실패 ${st.failed.length}건은 다시 시도할 수 있어요.` : `AI 판독을 마쳤습니다. 이 묶음 AI 비용 $${st.cost.toFixed(2)}`);
}

onAction('ai-run', async () => {
  const dv = drawingsState();
  if (!dv?.setId) return;
  const s = await loadSettings(dv.siteId);
  if (!s?.enabled) return;
  const sheets = store.drawings.cachedSheets(dv.setId) || [];
  const st = jobStats(dv.setId);
  if (!st.pending) {
    const spent = await store.ai.spent(s.scope === 'site' ? dv.siteId : null).catch(() => 0);
    const est = sheets.length * 0.25;
    if (!(await confirmDialog(`도면 ${sheets.length}장을 AI(Claude)로 읽습니다.\n예상 비용은 약 $${est.toFixed(0)} 이하입니다(이번 달 사용 $${spent.toFixed(2)} / 예산 $${s.monthlyBudgetUsd}).\n도면 그림과 글자가 외부 AI 서비스로 전송됩니다.`, { title: 'AI로 읽기', ok: '시작' }))) return;
  }
  await ensureJobs(dv.siteId, dv.setId);
  await store.drawings.updateSet(dv.setId, { status: 'analyzing' }).catch(() => {});
  await pump(dv.siteId, dv.setId);
  await store.drawings.updateSet(dv.setId, { status: 'review' }).catch(() => {});
});
onAction('ai-retry', async () => {
  const dv = drawingsState();
  if (!dv?.setId) return;
  await ensureJobs(dv.siteId, dv.setId, { retry: true });
  await pump(dv.siteId, dv.setId);
});
onAction('ai-stop', () => {
  const dv = drawingsState();
  const run = dv && running.get(dv.setId);
  if (run) { run.stop = true; toast('지금 읽고 있는 시트까지만 마치고 멈춥니다.'); }
});
onAction('ai-off-info', () => {
  openModal({
    title: 'AI 판독이 꺼져 있습니다',
    body: `<p>도면 그림과 글자를 외부 AI(Anthropic Claude)로 보내 읽는 기능입니다. <b>회사 보안 승인 전에는 꺼 둡니다.</b></p>
      <p class="muted small">지금은 규칙으로 읽은 결과(도면명·레이어 이름·표)를 씁니다. 승인되면 운영자가 [AI 설정]에서 켭니다.</p>`,
    footer: '<button type="button" class="btn primary" data-act="modal-close">확인</button>',
  });
});

// ---------------------------------------------------------------- AI 설정(운영자)

onAction('ai-settings', async () => {
  const dv = drawingsState();
  if (!dv || !store.can('admin')) return;
  const s = await store.ai.settings(null);
  const spent = await store.ai.spent(null).catch(() => 0);
  openModal({
    title: 'AI 설정(전체 현장)',
    body: `<form id="f-ai" data-form="ai-settings" novalidate>
      <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}><span><b>AI 판독 켜기</b><br><small class="muted">도면 그림·글자를 외부 AI(Anthropic Claude API)로 보냅니다. 회사 보안 승인 후에만 켜세요.</small></span></label>
      <label class="check"><input type="checkbox" name="keepOriginals" ${s.keepOriginals ? 'checked' : ''}><span><b>원본 DXF 보관</b><br><small class="muted">켜면 올린 도면 원본도 비공개 저장소에 둡니다(나중에 다시 읽기용).</small></span></label>
      <label class="field"><span>한 달 예산(달러)</span><input name="monthlyBudgetUsd" type="number" min="0" max="100000" step="1" value="${esc(String(s.monthlyBudgetUsd))}"></label>
      <p class="muted small">이번 달 사용: <b>$${spent.toFixed(2)}</b> · 모델: ${esc(s.model)} (바꾸는 것은 대표님 결정)</p>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" class="btn primary" form="f-ai">${icon('check')}저장</button>`,
  });
});

onForm('ai-settings', async (data) => {
  if (data.enabled && !(await confirmDialog('AI 판독을 켭니다. 회사 보안 승인을 받았나요?\n켜면 도면 정보가 외부 AI 서비스로 전송됩니다.', { title: 'AI 켜기', ok: '승인받았음, 켜기' }))) return;
  await store.ai.saveSettings({ enabled: Boolean(data.enabled), keepOriginals: Boolean(data.keepOriginals), monthlyBudgetUsd: Number(data.monthlyBudgetUsd) }, 'global');
  settings = null;
  settingsFor = null;
  closeModal(true);
  toast('AI 설정을 저장했습니다.');
  rerenderDrawings();
});

export const aiRunning = (setId) => running.has(setId);
