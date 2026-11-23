// 모델 만들기(도서 관리 화면의 도구): 시트 정보·모양을 모아 워커(js/bim/build-worker.js)에서 BIM 모델을 만들고,
// 새 버전(draft)으로 저장한다. 골구도에 없는 동은 "동 자동 생성 안"을 보여주고 담당자가 확인한 것만 만든다(04 5-4).
import { store } from './ctx.js';
import { addDrawingsTool, drawingsState, rerenderDrawings } from './drawings.js';
import { esc, icon, onAction, onForm, openModal, closeModal, toast } from './util.js';

const NEED_GEOM = new Set(['unit_plan', 'facility_plan', 'floor_plan', 'site_plan', 'elevation', 'roof_plan', 'landscape', 'landscape_plan', 'civil_plan']);
const USE = new Set([...NEED_GEOM, 'section', 'wall_types', 'finish_schedule', 'window_schedule', 'exterior_finish', 'color_plan', 'detail', 'structure']); // 상세·구조는 38 지시서
const afterBuild = []; // 다른 단계(검증·3D 보기)가 붙는다: async ({ siteId, setId, model, result }) => void
export const onModelBuilt = (fn) => afterBuild.push(fn);

let busy = null; // setId

addDrawingsTool((dv, { set, sheets, editable }) => {
  if (!editable || !sheets.length) return '';
  const ready = sheets.some((s) => USE.has(s.category));
  return `<button type="button" class="btn sm ${busy === set.id ? '' : 'primary'}" data-act="model-build" ${busy || !ready ? 'disabled' : ''} title="${ready ? '시트로 단지·동·세대 3D 모델 만들기' : '평면·배치도 시트가 필요합니다'}">${icon('cube')}${busy === set.id ? '모델 만드는 중…' : '모델 만들기'}</button>`;
}, { fold: true });

let worker = null;
let seq = 0;
function runWorker(payload) {
  if (!worker) worker = new Worker(new URL('./bim/build-worker.js', import.meta.url), { type: 'module' });
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const done = () => { worker?.removeEventListener('message', on); worker?.removeEventListener('error', fail); };
    const on = (ev) => {
      if (ev.data?.id !== id) return;
      done();
      if (ev.data.error) reject(new Error(ev.data.error)); else resolve(ev.data.result);
    };
    // 워커를 못 불러오거나 안에서 처리 못 한 오류가 나면 기다리지 않고 알린다
    const fail = (ev) => { done(); worker?.terminate(); worker = null; reject(new Error(`모델 계산 중 오류: ${ev.message || '워커를 시작하지 못했습니다'}`)); };
    worker.addEventListener('message', on);
    worker.addEventListener('error', fail);
    worker.postMessage({ id, ...payload });
  });
}

// skipFileIds: 3D에 넘기지 않는 파일(설비 등 보관만 하는 공종, 44 지시서 2.2)의 시트는 뺀다
export async function buildFromSet(siteId, setId, { skipFileIds = null } = {}) {
  const sheets = (store.drawings.cachedSheets(setId) || await store.drawings.sheets(setId)).filter((s) => USE.has(s.category) && !skipFileIds?.has(s.fileId));
  const geoms = [];
  for (const s of sheets) if (NEED_GEOM.has(s.category)) geoms.push([s.id, await store.drawings.sheetAsset(s, 'geom'), await store.drawings.sheetAsset(s, 'triage', { fresh: true }).catch(() => null)]);
  // 조경 범례 표는 시트 요약에 있다
  for (const s of sheets) if (/landscape|civil/.test(s.category)) s.tables = (await store.drawings.sheetAsset(s, 'digest').catch(() => null))?.tables || [];
  const prog = store.progress ? await store.progress.load(siteId).catch(() => null) : null;
  const progress = { buildings: (prog?.buildings || []).map((b) => ({ id: b.id, name: b.name, lines: b.lines })) };
  const slim = sheets.map(({ id, sheetNo, title, category, refs, layerRoles, extracted, frame, meta, status, tables }) => ({ id, sheetNo, title, category, refs, layerRoles, extracted, frame, meta, status, tables }));
  const drawingFiles = (store.drawings.cachedFiles(setId) || []).map(({ name, status }) => ({ name, status }));
  return runWorker({ siteId, setId, sheets: slim, geoms, progress, drawingFiles });
}

async function saveVersion(siteId, set, result) {
  const versions = await store.bim.versions(siteId);
  const parent = versions[0] || null;
  const model = await store.bim.save(siteId, result.files, { setId: set.id, parentId: parent?.id || null, note: `도서 "${set.name}"에서 만든 초안`, summary: result.summary });
  // 규칙 검사 결과(05)를 이 버전에 붙인다
  if (result.findings) await store.bim.saveFindings(model.id, result.findings, { source: 'rule' });
  for (const fn of afterBuild) await fn({ siteId, setId: set.id, model, result });
  return model;
}

onAction('model-build', async () => {
  const dv = drawingsState();
  if (!dv?.setId || busy) return;
  const set = (store.drawings.cached(dv.siteId) || []).find((x) => x.id === dv.setId);
  busy = set.id;
  rerenderDrawings();
  try {
    await store.drawings.updateSet(set.id, { status: 'building' }).catch(() => {});
    const result = await buildFromSet(dv.siteId, set.id);
    if (result.report.progressProposals.length && store.can('edit', dv.siteId)) {
      pending = { siteId: dv.siteId, set, result };
      proposalDialog(result.report.progressProposals);
      return;
    }
    await finish(dv.siteId, set, result);
  } catch (err) {
    toast(`모델을 만들지 못했습니다: ${err.message}`, 'crit');
    await store.drawings.updateSet(set.id, { status: 'review' }).catch(() => {});
  } finally {
    if (!pending) { busy = null; rerenderDrawings(); }
  }
});

async function finish(siteId, set, result, { quiet = false } = {}) {
  const model = await saveVersion(siteId, set, result);
  const fresh = (store.drawings.cached(siteId) || []).find((x) => x.id === set.id) || set;
  await store.drawings.updateSet(set.id, { status: 'review', stats: { ...(fresh.stats || {}), model: { id: model.id, version: model.version, ...result.summary } } }).catch(() => {});
  if (quiet) return model;
  const s = result.summary;
  const f = result.findings || [];
  const err = f.filter((x) => x.severity === 'error').length;
  const warn = f.filter((x) => x.severity === 'warn').length;
  toast(`모델 v${model.version}을 만들었습니다: 동 ${s.buildings} · 세대 ${s.units} · 타입 ${s.unitTypes} · 실 ${s.spaces} — 검증 오류 ${err} · 경고 ${warn}`);
  return model;
}

// ---------------------------------------------------------------- 골구도 동 자동 생성 "안" → 확인한 것만 만든다

let pending = null;
function proposalDialog(list) {
  openModal({
    title: '골구도 동 만들기(확인)',
    wide: true,
    body: `<form id="f-prog" data-form="prog-proposal" novalidate>
      <p>도면에서 찾은 동이 <b>골구도(공정 현황)</b>에 없습니다. 아래처럼 동을 만들면 세대마다 공정 색을 3D에 칠할 수 있어요.<br><span class="muted small">만들지 않아도 모델은 저장됩니다. 라인·층은 나중에 골구도에서 고칠 수 있습니다.</span></p>
      <ul class="prop-list">${list.map((p, i) => `<li><label class="check"><input type="checkbox" name="b${i}" checked><span><b>${esc(p.building)}</b> — ${p.lines.map((l) => `${esc(l.name)}호 라인 ${l.from}~${l.to}층`).join(', ')}</span></label></li>`).join('')}</ul>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="prog-skip">만들지 않고 모델만 저장</button><button type="submit" class="btn primary" form="f-prog">${icon('check')}골구도 동 만들고 저장</button>`,
    onClose: () => { if (pending) queueMicrotask(() => skipProposals()); },
  });
}

async function skipProposals() {
  const p = pending;
  pending = null;
  if (!p) return;
  try { await finish(p.siteId, p.set, p.result); } catch (err) { toast(err.message, 'crit'); }
  busy = null;
  rerenderDrawings();
}

onAction('prog-skip', () => closeModal(false));
onForm('prog-proposal', async (data) => {
  const p = pending;
  if (!p) return;
  pending = null;
  closeModal(true);
  try {
    const list = p.result.report.progressProposals;
    let made = 0;
    for (let i = 0; i < list.length; i++) {
      if (!data[`b${i}`]) continue;
      await store.progress.saveBuilding({ siteId: p.siteId, name: list[i].building, lines: list[i].lines, sort: i + 1 });
      made++;
    }
    // 골구도 동과 연결된 모델로 다시 만든다
    const result = made ? await buildFromSet(p.siteId, p.set.id) : p.result;
    if (made) toast(`골구도에 동 ${made}개를 만들었습니다.`);
    await finish(p.siteId, p.set, result);
  } catch (err) {
    toast(err.message, 'crit');
  } finally {
    busy = null;
    rerenderDrawings();
  }
});

/**
 * 묻지 않고 만들기(44 지시서 3.8): 도서를 다 읽으면 저절로 부른다. 골구도에 없는 동은 확인 창의 기본값대로 만든다(원칙 4).
 * @returns {Promise<any>} 저장한 모델 버전
 */
export async function buildAndSave(siteId, set, { skipFileIds = null } = {}) {
  await store.drawings.updateSet(set.id, { status: 'building' }).catch(() => {});
  try {
    let result = await buildFromSet(siteId, set.id, { skipFileIds });
    const list = result.report.progressProposals || [];
    if (list.length && store.progress && store.can('edit', siteId)) {
      let made = 0;
      for (let i = 0; i < list.length; i++) {
        try { await store.progress.saveBuilding({ siteId, name: list[i].building, lines: list[i].lines, sort: i + 1 }); made++; } catch { /* 골구도를 못 만들어도 모델은 저장 */ }
      }
      if (made) result = await buildFromSet(siteId, set.id, { skipFileIds });
    }
    return await finish(siteId, set, result, { quiet: true });
  } catch (err) {
    await store.drawings.updateSet(set.id, { status: 'review' }).catch(() => {});
    throw err;
  }
}
