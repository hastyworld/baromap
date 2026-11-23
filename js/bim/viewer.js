// BIM 3D 보기(06): 단지 → 동 → 세대(벽 마감 층까지). 전체 화면, 이동 표시줄, 카메라 [위에서][비스듬히][정면],
// 동: 층 자르기·이 층만 / 세대: 마감 층·단면(수평·수직)·재료 거르기·시공부위 / 공정 색(골구도 세대 단위),
// 요소 선택 → 정보 패널(층 구성 표·근거 도면 조각·관련 검증) · 검증 결과 탭. 모델 파일은 장면마다 필요한 것만 받는다.
import { store, state, q } from '../ctx.js';
import { loadThree } from '../model3d.js';
import { addDrawingsTool } from '../drawings.js';
import { buildingUnits, inkFor } from '../model.js';
import { makeMaterials, BG, dark } from './materials-3d.js';
import { CATEGORY_COLOR, PART_KO, PARTS } from './materials-ko.js';
import { unitKinds, kindQty, floorStack, ceilingStack, wallStack, stackTag, spaceLabel, structureOf, structTag } from './parts.js';
import { buildSite } from './mesh-site.js';
import { buildBuilding } from './mesh-building.js';
import { buildFacadeMesh, lodDistance, shellColor } from './mesh-facade.js';
import { buildUnit } from './mesh-unit.js';
import { doneMaterials } from './mesh-calc.js';
import { createClip, CUT_Z, CUT_LABEL } from './clip.js';
import { createPicker } from './picking.js';
import { panelHtml, findElement } from './model-panel.js';
import { createFindingsPanel, drawCrop } from './findings-ui.js';
import { openSheetViewer } from './sheet-viewer.js';
import { $, esc, icon, onAction, toast, confirmDialog } from '../util.js';

export const STATUS_LABEL = { draft: '초안', approved: '확정', superseded: '이전 확정' };
const FLY_MS = 600;
const SLAB = 0.2;

export function webgl2() {
  try { return Boolean(document.createElement('canvas').getContext('webgl2')); } catch { return false; }
}

// 볼 수 있는 버전: 현장 담당·운영자는 전부, 그 밖에는 확정된 것만(새것부터)
export function visibleVersions(siteId) {
  const all = [...(store.bim?.cachedVersions(siteId) || [])].sort((a, b) => b.version - a.version);
  return store.can('edit', siteId) ? all : all.filter((m) => m.status === 'approved');
}

// ---------------------------------------------------------------- 현장 패널(맨 위 큰 그림·단추)

const asked = new Set();
/** 현장 패널: 확정된 BIM이 있으면 단지 3D를 맨 위에. → { hero, chip } (버전 목록은 처음 한 번 받는다) */
export function bimTour(siteId) {
  if (!store.bim) return {};
  if (!store.bim.cachedVersions(siteId)) {
    if (!asked.has(siteId)) { asked.add(siteId); queueMicrotask(() => store.bim.versions(siteId).catch(() => {})); }
    return {};
  }
  const list = visibleVersions(siteId);
  const ok = list.find((m) => m.status === 'approved');
  const top = list[0];
  // 3D가 있으면 큰 [3D 보기]가 먼저(44 지시서 3.1): 확정본, 없으면(현장 담당·운영자) 최신 초안
  const lead = ok || top;
  const sum = (m) => `동 ${m.summary?.apartments ?? '-'} · 세대 ${m.summary?.units ?? '-'}`;
  const hero = lead ? `<button type="button" class="tour-hero bim" data-act="bim-open" data-site="${esc(siteId)}" data-id="${esc(lead.id)}" aria-label="3D 보기">
      <span class="tour-bim" aria-hidden="true">${icon('building')}${icon('building')}${icon('building')}</span>
      <span class="tour-play">${icon('cube')}3D 보기</span>
      <span class="tour-cap">${lead === ok ? '확정' : '초안'} v${lead.version} · ${sum(lead)}</span></button>` : '';
  const chip = top && top !== lead ? `<button type="button" class="btn sm" data-act="bim-open" data-site="${esc(siteId)}" data-id="${esc(top.id)}">${icon('cube')}3D(초안 v${top.version})</button>` : '';
  return { hero, chip };
}

// 도서 관리 도구 막대: 이 묶음으로 만든 최신 모델 [3D 보기]
addDrawingsTool((dv, { set }) => {
  const mid = set.stats?.model?.id;
  return mid ? `<button type="button" class="btn sm" data-act="bim-open" data-site="${esc(dv.siteId)}" data-id="${esc(mid)}">${icon('cube')}3D 보기</button>` : '';
});

// ---------------------------------------------------------------- 무대(렌더러·카메라·조작)

function disposeGroup(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
}

async function makeStage(host, onFrame) {
  const ticks = new Set(); // 매 장면마다 부르는 것(걷기·카메라 이동)
  let renderFn = null; // 실물 보기(후처리)가 바꿔 끼운다
  const { T, OrbitControls } = await loadThree();
  const renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.localClippingEnabled = true;
  host.prepend(renderer.domElement);
  const scene = new T.Scene();
  scene.background = new T.Color(BG());
  const camera = new T.PerspectiveCamera(45, 1, 0.1, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  const hemi = new T.HemisphereLight(0xffffff, 0x8899aa, 1.15);
  scene.add(hemi);
  const sun = new T.DirectionalLight(0xffffff, 1.35);
  sun.position.set(80, 160, 60);
  scene.add(sun, sun.target);
  const root = new T.Group();
  root.rotation.x = -Math.PI / 2; // 모델(x 동, y 북, z 위) → 화면(x, 위 y, 남 z)
  root.updateMatrixWorld(true);
  scene.add(root);
  const fit = () => {
    const w = host.clientWidth || 300;
    const h = host.clientHeight || 200;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(host);
  fit();
  let tw = null;
  let raf = 0;
  let alive = true;
  let frames = 0;
  let calls = 0;
  let tris = 0;
  let t0 = performance.now();
  const loop = (now) => {
    if (!alive) return;
    if (tw) {
      const k = Math.min(1, (now - tw.t0) / FLY_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      camera.position.lerpVectors(tw.p0, tw.p1, e);
      controls.target.lerpVectors(tw.c0, tw.c1, e);
      if (k >= 1) tw = null;
    }
    for (const fn of ticks) fn(now);
    if (controls.enabled) controls.update();
    if (renderFn) renderFn(); else renderer.render(scene, camera);
    onFrame?.();
    frames++;
    calls = Math.max(calls, renderer.info.render.calls);
    tris = Math.max(tris, renderer.info.render.triangles);
    if (now - t0 > 1000) {
      // 성능 확인용(1초 동안 평균 fps, 한 화면 그리기 호출·삼각형 최댓값)
      host.dataset.fps = String(Math.round((frames * 1000) / (now - t0)));
      host.dataset.calls = String(calls);
      host.dataset.tris = String(tris);
      frames = 0;
      calls = 0;
      tris = 0;
      t0 = now;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return {
    T, renderer, scene, camera, controls, root, hemi, sun, ticks,
    setRender(fn) { renderFn = fn; },
    fly(pos, target, instant = false) {
      if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) { camera.position.copy(pos); controls.target.copy(target); tw = null; controls.update(); return; }
      tw = { t0: performance.now(), p0: camera.position.clone(), p1: pos, c0: controls.target.clone(), c1: target };
    },
    stop() {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeGroup(root);
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}

// ---------------------------------------------------------------- 보기 상태

let bv = null; // { el, siteId, model, versions, files, preview, marks, cur, ctx, sel, tab, opts, stage, mats, clip, scene, labels, … }
let pushed = false;
// 07(직접 고치기·수정 요청·버전)이 붙는 자리: chrome(bv) → 머리 도구·바뀐 것 줄, tabs { key, title, render(el, bv) } → 오른쪽 패널 탭
const hooks = { chrome: [], tabs: [], bar: [], scene: [], drill: [] };
export const addViewerHook = (kind, fn) => hooks[kind].push(fn);
// 탭은 when(siteId)이 거짓이면 그리지 않는다(예: 단가 탭은 금액 권한이 있을 때만. 막는 것은 RLS)
const tabsFor = (siteId) => hooks.tabs.filter((h) => !h.when || h.when(siteId));

function baseFile(name) {
  const v = bv;
  const key = `${v.model.id}/${name}`;
  if (!v.files.has(key)) v.files.set(key, store.bim.load(v.model, name).catch((err) => { v.files.delete(key); throw err; }));
  return v.files.get(key);
}
// 고치는 중이면(미리보기) 고친 파일을 보여 준다
async function file(name) {
  if (bv.preview && name in bv.preview) return bv.preview[name];
  return baseFile(name);
}
const indexJson = () => file('index.json');
async function buildingJson(id) { const idx = await indexJson(); const n = idx.files.buildings[id]; if (!n) throw new Error('동 파일이 모델에 없습니다.'); return file(n); }
async function typeJson(id) { const idx = await indexJson(); const n = idx.files.unitTypes[id]; if (!n) throw new Error('세대 타입 파일이 모델에 없습니다.'); return file(n); }

// 동 장면에 필요한 타입(세대 칸 외곽)
async function typesOf(building) {
  const ids = new Set(building.units.map((u) => u.unitTypeId));
  for (const t of building.floorTemplates) for (const u of t.units) ids.add(u.unitTypeId);
  const out = new Map();
  for (const id of ids) out.set(id, await typeJson(id).catch(() => null));
  for (const [k, t] of out) if (!t) out.delete(k);
  return out;
}

const levelsOf = (b) => [...b.levels].sort((x, y) => x.elevation - y.elevation);
const facilitiesOf = (b) => b.floorTemplates.flatMap((t) => t.units.filter((u) => !u.line).map((u) => ({ ...u, levelId: t.levelIds[0], templateId: t.id })));

export async function openBimViewer(siteId, modelId = null) {
  const s = q.site(siteId);
  if (!s || !store.bim) return;
  if (!store.bim.cachedVersions(siteId)) await store.bim.versions(siteId).catch(() => {});
  const versions = visibleVersions(siteId);
  const model = versions.find((m) => m.id === modelId) || versions.find((m) => m.status === 'approved') || versions[0];
  if (!model) { toast('볼 수 있는 3D 모델이 없습니다.', 'warn'); return; }
  closeBimViewer({ keepHistory: true });
  const el = document.createElement('div');
  el.className = 'bview';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `${s.name} 단지 3D`);
  // 글 없이 눌러 보며 알기(44 지시서 5절): 위에는 큰 [뒤로]와 지금 위치("단지 › 101동 › 84A"), 아래에는 [단면]과 [더 보기]뿐.
  // 나머지(버전·확정·정보·재료·실물 보기·측정 …)는 [더 보기] 안에. 처음 열 때 글 띠·도움말을 띄우지 않는다
  el.innerHTML = `<header class="board-head bv-head">
      <button type="button" class="btn bv-back" data-bv="back">${icon('back')}<span>뒤로</span></button>
      <nav class="bv-crumbs" id="bv-crumbs" aria-label="지금 위치"></nav>
      <span class="bv-note" id="bv-note" hidden></span>
      <button type="button" class="icon-btn" data-bv="close" aria-label="닫기" title="닫기" hidden>${icon('close')}</button>
    </header>
    <div class="bv-main">
      <div class="bv-stage mview-stage" id="bv-stage"><div class="bv-labels" id="bv-labels" aria-hidden="true"></div><p class="viewer-msg" id="bv-msg">3D를 불러오는 중…</p></div>
      <aside class="bv-panel" id="bv-panel" aria-label="정보">
        <div class="bv-tabs" role="tablist">
          <button type="button" role="tab" data-bv-tab="info" aria-selected="true">정보</button>
          <button type="button" role="tab" data-bv-tab="findings" aria-selected="false">검증 <b id="bv-fcount"></b></button>
          ${tabsFor(siteId).map((h) => `<button type="button" role="tab" data-bv-tab="${h.key}" aria-selected="false">${esc(h.title)} <b id="bv-${h.key}-count"></b></button>`).join('')}
        </div>
        <div class="bv-pane" id="bv-info" role="tabpanel"></div>
        <div class="bv-pane" id="bv-findings" role="tabpanel" hidden></div>
        ${tabsFor(siteId).map((h) => `<div class="bv-pane" id="bv-${h.key}" role="tabpanel" hidden></div>`).join('')}
      </aside>
    </div>
    <div class="bv-edits" id="bv-edits" hidden></div>
    <div class="bv-bar mview-bar" id="bv-bar"></div>
    <div class="bv-more" id="bv-more" hidden>
      <div class="bv-more-head"><b>${esc(s.name)}</b> <span class="muted small" id="bv-sub"></span></div>
      <div class="bv-more-row"><span id="bv-verbox"></span><span class="bv-extra" id="bv-extra"></span>
        <button type="button" class="btn sm bv-panel-btn" data-bv="panel" aria-pressed="false" aria-controls="bv-panel">${icon('table')}<span>정보</span></button></div>
      <div class="bv-more-tools" id="bv-more-tools"></div>
    </div>
    <div class="mview-legend" id="bv-legend" hidden></div>`;
  document.body.append(el);
  document.body.classList.add('board-open');
  bv = {
    el, siteId, model, versions, files: new Map(), preview: null, marks: null, cur: { level: 'site' }, ctx: null, sel: [], tab: 'info', sheets: [], labels: [], labelKey: '',
    stack: [{ level: 'site' }], hov: null, hoverPick: null, moreOpen: false,
    opts: { upTo: Infinity, only: null, layers: false, cut: '', cutV: 50, filter: null, kinds: null, zones: false, sheetId: '', shell: true, ceiling: false, stray: false, focus: null, partCut: true, box: [0, 100, 0, 100, 0, 100] }, part: null, hoverId: null, lineDraw: null, returnFocus: document.activeElement,
  };
  if (!pushed) { history.pushState({ baromapBim: true }, ''); pushed = true; }
  el.querySelector('[data-bv="back"]').focus();
  bindEvents(el);
  bv.unsub = store.subscribe(refreshSoon);
  const v = bv;
  if (!webgl2()) { $('#bv-msg').textContent = '이 기기에서는 3D를 볼 수 없어요.'; return; }
  try {
    const [stage] = await Promise.all([makeStage($('#bv-stage'), () => bv === v && updateLabels()), indexJson(), store.progress?.load(siteId).catch(() => null), loadSide(v)]);
    if (bv !== v) { stage.stop(); return; }
    v.stage = stage;
    v.mats = makeMaterials(stage.T);
    v.clip = createClip(stage.T);
    v.picker = createPicker(stage.T, {
      camera: stage.camera, dom: stage.renderer.domElement,
      objects: () => bv?.scene?.pickables || [],
      idOf: (hit) => bv?.scene?.idOf(hit) || null,
      keeps: (p) => bv?.ctx?.level !== 'unit' || bv.clip.keeps(bv.opts.cut, p),
      onPick,
    });
    // 누를 수 있는 것은 손을 대면 밝아진다(44 지시서 5.2). 작은 실 이름표도 마우스를 올렸을 때만(42 지시서 2.3)
    let hoverAt = 0;
    const dom = stage.renderer.domElement;
    dom.addEventListener('pointermove', (e) => {
      if (bv !== v || e.pointerType === 'touch' || e.buttons || v.lineDraw || performance.now() - hoverAt < 60) return;
      hoverAt = performance.now();
      const id = v.picker.hitAt(e.clientX, e.clientY).id;
      setHover(hoverTarget(id));
      if (v.ctx?.level === 'unit' && id !== v.hoverId) { v.hoverId = id; v.labelKey = ''; }
    });
    dom.addEventListener('pointerleave', () => { if (bv === v) setHover(null); });
    dom.addEventListener('pointerdown', (e) => {
      if (bv !== v || e.pointerType !== 'touch') return;
      setHover(hoverTarget(v.picker.hitAt(e.clientX, e.clientY).id));
      clearTimeout(v.hovTimer);
      v.hovTimer = setTimeout(() => { if (bv === v) setHover(null); }, 700);
    });
    await show({ level: 'site' });
    if (bv === v && v.ctx?.level === 'unit' && !v.ctx.building) openPanel(true); // 동 없는 모델: 타입 목록이 보이게
    $('#bv-msg')?.remove();
    if (bv === v) flashHint(v);
  } catch (err) {
    const m = $('#bv-msg');
    if (m && bv === v) m.textContent = `3D 모델을 열지 못했습니다: ${err.message}`;
  }
}

// 도면 시트(근거 조각)·검증 결과
async function loadSide(v) {
  const setId = v.model.setId;
  v.sheets = setId ? (store.drawings?.cachedSheets(setId) || await store.drawings?.sheets(setId).catch(() => []) || []) : [];
  if (!store.bim.cachedFindings(v.model.id)) await store.bim.findings(v.model.id).catch(() => {});
}

export function closeBimViewer({ fromHistory = false, keepHistory = false } = {}) {
  if (!bv) return;
  const v = bv;
  bv = null;
  v.unsub?.();
  v.picker?.dispose();
  v.fpanel?.destroy();
  v.stage?.stop();
  v.mats?.dispose();
  clearTimeout(v.hovTimer);
  v.el.remove();
  if (!document.querySelector('.board, .mview, .sview, .fview')) document.body.classList.remove('board-open');
  if (keepHistory) return;
  v.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.go(-v.stack.length); // 단계마다 쌓은 기록 + 처음 하나
  pushed = false;
}

// ---------------------------------------------------------------- 장면

/** cur: { level: 'site' } | { level: 'building', buildingId, levelId? } | { level: 'unit', buildingId(동 없는 모델은 null), typeId, unitId? } */
async function sceneCtx(cur) {
  const idx = await indexJson();
  const [site, catalog] = await Promise.all([file(idx.files.site), file(idx.files.catalog)]);
  const base = { level: cur.level, site, catalog, summary: idx.summary, types: new Map(), sheets: bv.sheets, findings: store.bim.cachedFindings(bv.model.id) || [], progressOf };
  if (cur.level === 'site') {
    // 동 외피는 멀리서 덩어리, 가까이서 패널·창호(21 지시서 5절). 동 파일을 미리 읽는다
    const shells = new Map();
    await Promise.all(site.buildings.map(async (b) => {
      const building = await buildingJson(b.id).catch(() => null);
      if (!building?.facade?.panels?.length) return;
      const types = await typesOf(building);
      const xs = building.outline.map((p) => p[0]);
      shells.set(b.id, { building, types, color: shellColor(building), lod: lodDistance(Math.max(...xs) - Math.min(...xs)) });
    }));
    return { ...base, shells };
  }
  if (cur.level === 'unit' && !cur.buildingId) {
    // 동 없이 타입만(배치도·동 평면 없이 세대 도면만 올린 묶음): 높이는 보통 층고, 패널에 타입 목록
    const type = await typeJson(cur.typeId);
    const allTypes = new Map(await Promise.all(Object.keys(idx.files.unitTypes || {}).map(async (id) => [id, await typeJson(id)])));
    return { ...base, building: null, type, unit: null, floorLevel: null, height: Math.max(2.2, 2.9 - SLAB), types: new Map([[type.id, type]]), allTypes };
  }
  const building = await buildingJson(cur.buildingId);
  if (cur.level === 'building') return { ...base, building, types: await typesOf(building) };
  const type = await typeJson(cur.typeId);
  const unit = cur.unitId ? building.units.find((u) => u.id === cur.unitId) || facilitiesOf(building).find((u) => u.id === cur.unitId) || null : null;
  // 세대 높이 = 그 층 층고 - 슬래브(타입만 볼 때는 그 타입이 있는 첫 층)
  const lid = unit?.levelId || building.units.find((u) => u.unitTypeId === type.id)?.levelId || facilitiesOf(building).find((u) => u.unitTypeId === type.id)?.levelId;
  const lv = building.levels.find((l) => l.id === lid);
  const height = Math.max(2.2, (lv?.height || 2.9) - SLAB);
  return { ...base, building, type, unit, floorLevel: lv || null, height, types: new Map([[type.id, type]]) };
}

// 동이 0개인 모델은 단지 대신 첫 세대 타입을 연다(타입 목록은 정보 패널에)
async function typesOnlyFirst() {
  const idx = await indexJson();
  const site = await file(idx.files.site);
  return site.buildings.length ? null : Object.keys(idx.files.unitTypes || {})[0] || null;
}

async function show(cur, { aim = true, keepSel = false } = {}) {
  const v = bv;
  if (!v?.stage) return;
  if (cur.level === 'site') {
    const first = await typesOnlyFirst();
    if (first) cur = { level: 'unit', buildingId: null, typeId: first, unitId: null };
  }
  if (cur.level === 'building') {
    v.opts.only = cur.levelId || null;
    v.opts.upTo = Infinity;
  }
  let ctx;
  try { ctx = await sceneCtx(cur); } catch (err) {
    if (cur.level === 'site') throw err;
    cur = { level: 'site' }; // 고치거나 버전을 바꿔 그 동·타입이 없어졌으면 단지로
    ctx = await sceneCtx(cur);
  }
  if (bv !== v) return;
  if (cur.level === 'building' && cur.levelId) v.opts.upTo = levelsOf(ctx.building).findIndex((l) => l.id === cur.levelId);
  const same = v.cur?.level === cur.level && v.cur?.typeId === cur.typeId;
  v.cur = cur;
  v.ctx = ctx;
  if (!keepSel) v.sel = [];
  if (!same || !keepSel) { v.part = null; v.opts.focus = null; if (v.opts.cut === 'wall' || v.opts.cut === 'line') v.opts.cut = ''; v.lineDraw = null; }
  if (!same) v.opts.kinds = null;
  draw();
  if (aim) aimAt('iso');
  renderChrome();
}

function draw() {
  const v = bv;
  const { T, root } = v.stage;
  const c = v.ctx;
  if (v.scene) { clearHighlight(); root.remove(v.scene.group); disposeGroup(v.scene.group); }
  v.hov = null;
  v.hoverPick = null;
  let sc;
  // 실물 보기: 품질이 빠름이 아니면 재질(PBR)로 그린다
  v.mats.real = v.real?.on && v.real.quality !== 'fast' ? v.real.pbr : null;
  if (c.level === 'site') {
    // 동 자기 좌표 → 단지 좌표로 옮겨 그린다
    const shells = new Map([...c.shells].map(([id, s]) => [id, { ...s, detail: () => { const g = new T.Group(); g.add(buildFacadeMesh(T, v.mats, { ...s, catalog: c.catalog }).group); const t = s.building.transform; const w = new T.Group(); g.position.set(t.x, t.y, 0); g.rotation.z = (t.rotDeg * Math.PI) / 180; w.add(g); return w; } }]));
    sc = buildSite(T, v.mats, { site: c.site, shells, catalog: c.catalog }, { colors: siteColors() });
  } else if (c.level === 'building') sc = buildBuilding(T, v.mats, { building: c.building, types: c.types, catalog: c.catalog }, { upTo: v.opts.upTo, only: v.opts.only, unitColor: unitColorFn(), shell: v.opts.shell && !v.opts.sheetId });
  else {
    if (v.opts.cut === 'v') { const [x0, , , x1] = typeExt(c.type); v.clip.setV(x0 + ((x1 - x0) * v.opts.cutV) / 100); }
    // 단면을 자르면 속(바닥·벽 층 구성)이 보여야 하므로 층 구성으로 그린다
    const cutting = Boolean(v.opts.cut);
    sc = buildUnit(T, v.mats, { type: c.type, catalog: c.catalog }, {
      height: c.height, layers: v.opts.layers || cutting || Boolean(v.opts.kinds) || Boolean(v.filterOpen), cutZ: v.opts.cut === 'h' ? CUT_Z : null, clip: v.clip.planes(v.opts.cut),
      filter: v.opts.filter, kinds: v.opts.kinds, zones: v.opts.zones, fade: fadeSet(), stray: v.opts.stray ? 'show' : 'hide', focus: v.opts.focus,
      ceiling: v.opts.ceiling || v.part?.part === 'ceiling', level: c.floorLevel,
    });
    if (v.opts.cut === 'box') applyBox(sc.ext);
  }
  v.scene = sc;
  root.add(sc.group);
  v.extraLabels = partLabels();
  setLabels([...v.extraLabels, ...sc.labels]); // 누른 부위 꼬리표가 먼저(겹치면 뒤의 실 이름표를 숨긴다)
  highlight();
  renderLegend();
  v.real?.prepare(sc.group, sc.ext);
  for (const fn of hooks.scene) fn(v, sc);
}

// 상자 단면: 막대 6개(0~100%)를 장면 크기에 맞춰 모델 좌표로
function applyBox(e = bv.scene?.ext) {
  if (!e) return;
  const b = bv.opts.box;
  const at = (lo, hi, pct) => lo + ((hi - lo) * pct) / 100;
  const pad = 0.05;
  bv.clip.setBox([at(e[0] - pad, e[3] + pad, b[0]), at(e[1] - pad, e[4] + pad, b[2]), at(e[2] - pad, e[5] + pad, b[4]), at(e[0] - pad, e[3] + pad, b[1]), at(e[1] - pad, e[4] + pad, b[3]), at(e[2] - pad, e[5] + pad, b[5])]);
}

// 부위 단면 꼬리표(3D 위 글자): 누른 벽·바닥·천장의 층 구성
function partLabels() {
  const v = bv;
  const p = v.part;
  const c = v.ctx;
  if (!p || c.level !== 'unit') return [];
  if (p.part === 'wall') {
    const w = c.type.walls.find((x) => x.id === p.id);
    if (!w) return [];
    // 구조 부재(43 지시서 3절)는 같은 꼬리표의 둘째 줄: "구조 W1 200 (S-101)"
    const st = structTag(structureOf(w, c.catalog));
    return [{ text: stackTag(wallStack(w, c.type, c.catalog).layers), ...(st ? { sub: st } : {}), pos: [p.at[0], p.at[1], 1.5], cls: 'tag', id: w.id }];
  }
  const sp = c.type.spaces.find((x) => x.id === p.id);
  if (!sp) return [];
  const cx = sp.polygon.reduce((s, q) => s + q[0], 0) / sp.polygon.length;
  const cy = sp.polygon.reduce((s, q) => s + q[1], 0) / sp.polygon.length;
  if (p.part === 'ceiling') { const st = ceilingStack(c.type, c.catalog, sp); return [{ text: `천장: ${stackTag(st.layers)}`, pos: [cx, cy, st.ceilingMm / 1000], cls: 'tag', id: sp.id }]; }
  return [{ text: `바닥: ${stackTag(floorStack(c.type, c.catalog, sp, { level: c.floorLevel }).layers)}`, pos: [cx, cy, 0.45], cls: 'tag', id: sp.id }];
}

function typeExt(t) {
  const xs = t.outline.map((p) => p[0]);
  const ys = t.outline.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), 0, Math.max(...xs), Math.max(...ys), 3];
}

// 카메라: 장면에 맞춰 0.6초 동안 옮긴다
function aimAt(mode = 'iso', instant = false) {
  const v = bv;
  const { T, camera, root } = v.stage;
  let e = v.scene?.ext || [-10, -10, 0, 10, 10, 3];
  if (!e.every(Number.isFinite)) e = [-10, -10, 0, 10, 10, 3];
  const c = new T.Vector3((e[0] + e[3]) / 2, (e[1] + e[4]) / 2, (e[2] + e[5]) / 2).applyMatrix4(root.matrixWorld);
  const r = Math.max(2, Math.hypot(e[3] - e[0], e[4] - e[1], e[5] - e[2]) / 2);
  const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * (camera.aspect < 1 ? Math.min(2.2, 1 / camera.aspect) : 1);
  const unit = v.ctx.level === 'unit';
  // 세대: 위에서 45° 비스듬히, 세대가 화면을 채우게. 동: 긴 면이 정면으로. 단지: 배치 전체
  const wide = e[3] - e[0] >= e[4] - e[1];
  const iso = unit ? [0.6, 1, 0.8] : v.ctx.level === 'building' ? (wide ? [0.45, 0.6, 1] : [1, 0.6, 0.45]) : [1, 0.85, 1.25];
  const dir = { top: [0, 1, 0.0001], iso, front: v.ctx.level === 'building' && !wide ? [1, 0.22, 0] : [0, 0.22, 1] }[mode] || iso;
  const d = new T.Vector3(...dir).normalize().multiplyScalar(dist * (unit && mode === 'iso' ? 0.82 : 1));
  camera.near = Math.max(0.05, r / 300);
  camera.far = dist + r * 40;
  camera.updateProjectionMatrix();
  v.stage.fly(c.clone().add(d), c, instant);
}

// ---------------------------------------------------------------- 라벨(HTML, 화면에 겹치면 숨김)

function setLabels(list) {
  const box = $('#bv-labels');
  if (!box) return;
  box.innerHTML = list.map((l) => `<span class="bv-label ${l.cls || ''}">${esc(l.text)}${l.sub ? `<span class="bv-tag-sub">${esc(l.sub)}</span>` : ''}</span>`).join('');
  const els = [...box.children];
  bv.labels = list.map((l, i) => ({ ...l, el: els[i], w: els[i].offsetWidth, h: els[i].offsetHeight }));
  bv.labelKey = '';
  markLabels();
}
function markLabels() { for (const l of bv.labels) l.el.classList.toggle('sel', Boolean(l.id) && bv.sel.includes(l.id)); }

function updateLabels() {
  const v = bv;
  if (!v?.stage || !v.labels.length) return;
  const { T, camera, root } = v.stage;
  const box = $('#bv-labels');
  const key = `${camera.matrixWorld.elements.map((x) => x.toFixed(3)).join()}|${box.clientWidth}x${box.clientHeight}|${v.labels.length}|${v.hoverId || ''}|${v.sel.join()}`;
  if (key === v.labelKey) return;
  v.labelKey = key;
  const W = box.clientWidth;
  const H = box.clientHeight;
  const p = v.tmpV || (v.tmpV = new T.Vector3());
  const placed = [];
  for (const l of v.labels) {
    p.set(l.pos[0], l.pos[1], l.pos[2]).applyMatrix4(root.matrixWorld).project(camera);
    const x = ((p.x + 1) / 2) * W;
    const y = ((1 - p.y) / 2) * H;
    const r = [x - l.w / 2, y - l.h / 2, x + l.w / 2, y + l.h / 2];
    // 층 구성 꼬리표는 화면 안으로 밀어 넣는다(휴대폰 폭에서 잘리지 않게)
    if (l.cls === 'tag' && p.z <= 1 && p.z >= -1) { const dx = Math.max(4 - r[0], Math.min(0, W - 4 - r[2])); r[0] += dx; r[2] += dx; }
    const quiet = l.small && !(l.id && (v.sel.includes(l.id) || v.hoverId === l.id));
    const off = quiet || p.z > 1 || p.z < -1 || r[2] < 0 || r[0] > W || r[3] < 0 || r[1] > H;
    const hit = !off && placed.some((o) => r[0] < o[2] + 2 && r[2] > o[0] - 2 && r[1] < o[3] + 1 && r[3] > o[1] - 1);
    l.el.hidden = off || hit;
    if (!l.el.hidden) { placed.push(r); l.el.style.transform = `translate(${Math.round(r[0])}px, ${Math.round(r[1])}px)`; }
  }
}

// ---------------------------------------------------------------- 공정 색(골구도)

const progressNow = () => store.progress?.cached(bv.siteId) || null;
const sheetNow = () => (bv.opts.sheetId && progressNow()?.sheets.find((h) => h.id === bv.opts.sheetId)) || null;
const linked = () => (bv.ctx?.site.buildings || []).some((b) => b.progressBuildingId) && (progressNow()?.sheets.length || 0) > 0;

function stepOf(pbId, unitKey) {
  const sh = sheetNow();
  if (!sh || !pbId || !unitKey) return null;
  return Math.min(progressNow().cells[sh.id]?.[pbId]?.[unitKey]?.step || 0, sh.trades.length);
}
function progressOf(unit) {
  const sh = sheetNow();
  const pb = bv.ctx?.building?.progressBuildingId;
  if (!sh || !pb || !unit?.unitKey) return '';
  const s = stepOf(pb, unit.unitKey);
  return s ? `<b style="color:${esc(sh.trades[s - 1].color)}">■</b> ${s} ${esc(sh.trades[s - 1].name)}까지` : '시작 전';
}
const NOT_STARTED = () => (dark() ? '#3a4150' : '#E2E6EC');
function unitColorFn() {
  const sh = sheetNow();
  const pb = bv.ctx.building?.progressBuildingId;
  if (!sh || !pb) return null;
  return (u) => { if (!u.unitKey) return null; const s = stepOf(pb, u.unitKey); return s ? sh.trades[s - 1].color : NOT_STARTED(); };
}
// 단지: 동마다 가장 많은 세대가 머문 공종 색
function siteColors() {
  const out = new Map();
  const sh = sheetNow();
  const p = progressNow();
  if (!sh || !p) return out;
  for (const b of bv.ctx.site.buildings) {
    const pb = p.buildings.find((x) => x.id === b.progressBuildingId);
    if (!pb) continue;
    const count = new Map();
    for (const u of buildingUnits(pb)) { const s = stepOf(pb.id, u.key); count.set(s, (count.get(s) || 0) + 1); }
    const [top] = [...count].sort((a, z) => z[1] - a[1] || z[0] - a[0]);
    out.set(b.id, top && top[0] > 0 ? sh.trades[top[0] - 1].color : NOT_STARTED());
  }
  return out;
}
// 세대: 끝난 공종의 재료는 진하게, 아직인 공종의 재료는 투명(06 5절)
function fadeSet() {
  const sh = sheetNow();
  const c = bv.ctx;
  const pb = c.building?.progressBuildingId;
  if (!sh || !pb || !c.unit?.unitKey) return null;
  const { done, covered } = doneMaterials(sh.trades, stepOf(pb, c.unit.unitKey), c.catalog.materials || []);
  return new Set([...covered].filter((id) => !done.has(id)));
}

// ---------------------------------------------------------------- 선택

function onPick(id, { add, double, hit, x, y }) {
  if (!bv?.ctx) return;
  if (bv.lineDraw) { linePoint(x, y); return; }
  if (bv.toolMode) return; // 두 점 재기·걷기 중에는 누름을 그 도구가 쓴다(들어가지 않음)
  if (!id) {
    // 빈 곳을 누르면 고른 것과 부위 단면(이 실만 보기·벽 단면)을 푼다 — 부위는 한 단계라 기록으로 뒤로
    const hadPart = bv.part || bv.opts.focus || bv.opts.cut === 'wall';
    if (hadPart && !add) { partBack(); if (bv.sel.length) select([]); return; }
    if (!add && bv.sel.length) select([]);
    return;
  }
  // 한 번 누르면 한 단계 들어간다(44 지시서 5.3): 단지 → 동 → 세대 → 부위
  const lvl = bv.ctx.level;
  if (!add && lvl === 'site' && bv.ctx.site.buildings.some((b) => b.id === id)) { hintDone(); drill(id); return; }
  if (!add && lvl === 'building') {
    const u = unitAt(id);
    if (u) { hintDone(); go({ level: 'unit', buildingId: bv.ctx.building.id, typeId: u.unitTypeId, unitId: u.id }); return; }
  }
  if (double && id) { drill(id); return; }
  if (bv.ctx.level === 'unit' && !add && bv.opts.partCut && pickPart(id, hit)) return;
  if (add) select(bv.sel.includes(id) ? bv.sel.filter((x) => x !== id) : [...bv.sel, id]);
  else select([id]);
}

// 부위 단면 풀기
function clearPart() {
  bv.part = null;
  bv.opts.focus = null;
  if (bv.opts.cut === 'wall') bv.opts.cut = '';
}

// 세대에서 부위를 눌렀을 때(42 지시서 3.2). 처리했으면 true
function pickPart(id, hit) {
  const v = bv;
  const c = v.ctx;
  const part = v.scene.partOf?.(hit);
  const T = v.stage.T;
  if (part === 'floor' || part === 'ceiling') {
    // 실: 그 실만 남기고 나머지는 흐리게 + 바닥(또는 천장) 구성 꼬리표
    v.part = { part, id };
    v.opts.focus = id;
    if (v.opts.cut === 'wall') v.opts.cut = '';
  } else if (part === 'wall') {
    const w = c.type.walls.find((q) => q.id === id);
    if (!w || v.scene.strays?.has(id)) return false;
    // 누른 자리(모델 좌표)에서 벽에 수직인 평면으로 자른다. 카메라 쪽 반을 잘라 잘린 면이 보이게
    const p = hit.point.clone().applyMatrix4(new T.Matrix4().copy(v.stage.root.matrixWorld).invert());
    const L = Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]) || 1;
    let n = [(w.path[1][0] - w.path[0][0]) / L, (w.path[1][1] - w.path[0][1]) / L];
    const cam = v.stage.camera.position.clone().applyMatrix4(new T.Matrix4().copy(v.stage.root.matrixWorld).invert());
    if ((cam.x - p.x) * n[0] + (cam.y - p.y) * n[1] > 0) n = [-n[0], -n[1]];
    v.clip.setLine([p.x, p.y], n);
    v.part = { part: 'wall', id, at: [p.x, p.y] };
    v.opts.focus = null;
    v.opts.cut = 'wall';
  } else return false;
  // 부위는 세대 다음 단계: 휴대폰 뒤로 가기로 풀리게 기록을 하나 쌓는다(부위를 바꿔 누를 때는 쌓지 않음)
  if (!v.stack.at(-1)?.part) { v.stack.push({ ...v.cur, part: true }); history.pushState({ baromapBim: true, bimDepth: v.stack.length - 1 }, ''); }
  v.sel = [id];
  draw();
  markLabels();
  if (v.tab !== 'info') setTab('info');
  renderBar();
  renderPanel();
  openPanel(true);
  return true;
}

// 부위 단면 끄기: 기록이 있으면 뒤로(뒤로 가기와 같은 길), 없으면 바로
function partBack() {
  if (bv.stack.at(-1)?.part) { history.back(); return; }
  clearPart();
  draw();
  renderBar();
  renderPanel();
}

// 위에서 보기에서 선을 그어 수직 단면 위치 정하기(42 지시서 3.4): 두 점을 누르면 그 선을 따라 세로로 자른다
function startLine() {
  const v = bv;
  clearPart();
  v.opts.cut = '';
  v.lineDraw = { pts: [] };
  draw();
  aimAt('top');
  renderBar();
  toast('위에서 본 화면에서 단면을 자를 선의 시작점과 끝점을 차례로 누르세요.', 'info');
}
function linePoint(x, y) {
  const v = bv;
  const T = v.stage.T;
  const hit = v.picker.planeAt(x, y, v.groundPlane || (v.groundPlane = new T.Plane(new T.Vector3(0, 1, 0), 0)));
  if (!hit) return;
  const p = [hit.x, -hit.z];
  v.lineDraw.pts.push(p);
  if (v.lineDraw.pts.length < 2) { viewerLabels([{ text: '시작점', pos: [p[0], p[1], 0.05], cls: 'tag' }]); return; }
  const [a, b] = v.lineDraw.pts;
  v.lineDraw = null;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 0.2) { toast('두 점이 너무 가깝습니다. 다시 그어 주세요.', 'warn'); renderBar(); return; }
  // 선의 왼쪽(a→b 진행 방향 기준)을 남기고, 잘린 면을 오른쪽에서 본다
  const n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  v.clip.setLine(a, n);
  v.opts.cut = 'line';
  draw();
  renderBar();
  const e = v.scene.ext;
  const c = new T.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (e[2] + e[5]) / 2).applyMatrix4(v.stage.root.matrixWorld);
  const r = Math.max(4, Math.hypot(e[3] - e[0], e[4] - e[1]) * 0.9);
  const eye = new T.Vector3((a[0] + b[0]) / 2 - n[0] * r, (a[1] + b[1]) / 2 - n[1] * r, e[5] + r * 0.35).applyMatrix4(v.stage.root.matrixWorld);
  v.stage.fly(eye, c);
}

function select(ids, { fromFinding = false } = {}) {
  bv.sel = ids;
  highlight();
  markLabels();
  if (!fromFinding && bv.tab !== 'info') setTab('info');
  renderPanel();
  if (ids.length && !fromFinding) openPanel(true);
}

function clearHighlight() {
  const v = bv;
  if (!v.hl) return;
  v.hl.parent?.remove(v.hl);
  v.hl.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  v.hl = null;
}
function highlight() {
  const v = bv;
  const { T } = v.stage;
  clearHighlight();
  if ((!v.sel.length && !v.marks?.size) || !v.scene) return;
  const g = new T.Group();
  const add = (ids, color, pad) => {
    for (const b of v.scene.boxesOf(ids)) {
      const h = new T.Box3Helper(new T.Box3(new T.Vector3(b[0] - pad, b[1] - pad, b[2] - 0.01), new T.Vector3(b[3] + pad, b[4] + pad, b[5] + 0.01)), color);
      h.material.depthTest = false;
      h.material.transparent = true;
      h.renderOrder = 10;
      g.add(h);
    }
  };
  // 표시(버전 비교·수정안): 색별로 묶어서
  const byColor = new Map();
  for (const [id, c] of v.marks || []) { if (!byColor.has(c)) byColor.set(c, []); byColor.get(c).push(id); }
  for (const [c, ids] of byColor) add(ids, new T.Color(c), 0.06);
  add(v.sel, 0xF76707, 0.03);
  v.hl = g;
  v.scene.group.add(g);
}

async function drill(id) {
  const c = bv.ctx;
  for (const fn of hooks.drill) if (fn(bv, id)) return;
  try {
    if (c.level === 'site') await goBuilding(id);
    else if (c.level === 'building') {
      const u = c.building.units.find((x) => x.id === id) || facilitiesOf(c.building).find((x) => x.id === id);
      if (u) await go({ level: 'unit', buildingId: c.building.id, typeId: u.unitTypeId, unitId: u.id });
    }
  } catch (err) { toast(err.message, 'crit'); }
}

// 커뮤니티(시설 하나)는 바로 시설 평면으로
async function goBuilding(id) {
  const b = await buildingJson(id);
  const fac = facilitiesOf(b);
  if (b.kind !== 'apartment' && !b.units.length && new Set(fac.map((f) => f.unitTypeId)).size === 1) await go({ level: 'unit', buildingId: id, typeId: fac[0].unitTypeId, unitId: fac[0].id });
  else await go({ level: 'building', buildingId: id });
}

// ---------------------------------------------------------------- 단계 이동(뒤로 가기와 맞춤, 44 지시서 5.3)
// 들어갈 때마다 브라우저 기록을 하나 쌓아, 휴대폰 뒤로 가기·[뒤로]·이동 표시줄이 모두 한 단계씩 같은 길로 돌아온다

const sameScene = (a = {}, b = {}) => a.level === b.level && (a.buildingId || null) === (b.buildingId || null) && (a.typeId || null) === (b.typeId || null)
  && (a.unitId || null) === (b.unitId || null) && (a.levelId || null) === (b.levelId || null);

async function go(cur) {
  const v = bv;
  if (!v) return;
  const top = v.stack.at(-1);
  if (sameScene(cur, v.cur) && !top?.part) { await show(cur); return; }
  // 부위 단계에서 다른 곳으로 가면 부위 기록 자리를 새 단계로 쓴다(기록 수는 그대로), 아니면 하나 쌓는다
  if (top?.part) v.stack[v.stack.length - 1] = cur;
  else { v.stack.push(cur); history.pushState({ baromapBim: true, bimDepth: v.stack.length - 1 }, ''); }
  openPanel(false); // 새 단계는 정보 칸 없이(고르면 열린다)
  await show(cur);
}

function goBack() {
  if (!bv) return;
  if (bv.stack.length > 1) history.back(); else closeBimViewer();
}

// 기록이 돌아왔을 때(뒤로 가기·[뒤로]·이동 표시줄): 그 단계로
async function onBimPop(depth) {
  const v = bv;
  if (!v || depth >= v.stack.length - 1) return;
  v.stack.length = depth + 1;
  const target = v.stack[depth];
  if (v.part || v.opts.focus || v.opts.cut === 'wall') clearPart();
  if (v.ctx?.building || v.ctx?.level !== 'unit') openPanel(false); // 동 없는 모델의 타입 목록은 그대로
  if (sameScene(target, v.cur)) { v.sel = []; draw(); renderChrome(); return; }
  try { await show(target); } catch (err) { toast(err.message, 'crit'); }
}

// 동 화면에서 누른 것 → 들어갈 세대: 세대 칸, 외피 패널이면 그 패널 뒤(같은 높이, 가장 가까운) 세대
function unitAt(id) {
  const c = bv.ctx;
  const b = c.building;
  const u = b.units.find((x) => x.id === id) || facilitiesOf(b).find((x) => x.id === id);
  if (u) return u;
  const p = (b.facade?.panels || []).find((x) => x.id === id);
  if (!p?.path?.length) return null;
  const z = (p.z0 + p.z1) / 2;
  const mx = (p.path[0][0] + p.path.at(-1)[0]) / 2;
  const my = (p.path[0][1] + p.path.at(-1)[1]) / 2;
  const lv = new Set(b.levels.filter((l) => l.elevation <= z && z < l.elevation + Math.max(l.height, 0.1)).map((l) => l.id));
  let best = null;
  let bd = Infinity;
  for (const x of b.units) {
    if (!lv.has(x.levelId)) continue;
    const [bx] = bv.scene.boxesOf([x.id]);
    if (!bx) continue;
    const d = Math.hypot(Math.max(bx[0] - mx, 0, mx - bx[3]), Math.max(bx[1] - my, 0, my - bx[4]));
    if (d < bd) { bd = d; best = x; }
  }
  return best;
}

// ---------------------------------------------------------------- 손대면 밝아지기 · 처음 한 번 깜빡임(44 지시서 5.1·5.2)

// 손을 댄 것 → 밝힐 것(누를 수 없는 것은 null): 동 화면의 외피 패널은 그 뒤 세대
function hoverTarget(id) {
  const v = bv;
  if (!id || !v?.ctx || !v.scene) return null;
  if (v.ctx.level === 'building') return unitAt(id)?.id || null;
  if (v.ctx.level === 'unit' && v.scene.strays?.has(id)) return null;
  return id;
}

function glowBoxes(v, ids, strength = 1) {
  const { T } = v.stage;
  const g = new T.Group();
  for (const b of v.scene.boxesOf(ids)) {
    const sz = [Math.max(0.05, b[3] - b[0]) + 0.06, Math.max(0.05, b[4] - b[1]) + 0.06, Math.max(0.06, b[5] - b[2]) + 0.06];
    const m = new T.Mesh(new T.BoxGeometry(...sz), new T.MeshBasicMaterial({ color: new T.Color(0x3d5a8a).multiplyScalar(strength), transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
    m.position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    m.renderOrder = 9;
    m.raycast = () => {}; // 밝힘 상자는 누름을 가로채지 않는다
    g.add(m);
  }
  v.scene.group.add(g);
  return g;
}
function dropGlow(g) { if (!g) return; g.parent?.remove(g); g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); }

function setHover(id) {
  const v = bv;
  if (!v?.stage || id === v.hoverPick) return;
  dropGlow(v.hov);
  v.hov = null;
  v.hoverPick = id;
  v.stage.renderer.domElement.style.cursor = id ? 'pointer' : '';
  if (id && v.scene) v.hov = glowBoxes(v, [id]);
}

// 처음 한 번만(이 기기에서 한 번 눌러 들어가면 다시 안 함): 가장 큰 동이 1.6초 동안 살짝 밝아졌다 돌아온다
const HINT_KEY = 'baromap.3dHint';
const hintSeen = () => { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return true; } };
function hintDone() { try { localStorage.setItem(HINT_KEY, '1'); } catch { /* 저장 못 해도 괜찮다 */ } }
function flashHint(v) {
  if (hintSeen() || v.ctx?.level !== 'site' || !v.scene) return;
  const area = (poly) => Math.abs(poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  const list = (v.ctx.site.buildings || []).filter((b) => b.footprint?.length > 2);
  const big = [...list].sort((a, b) => (b.kind === 'apartment') - (a.kind === 'apartment') || area(b.footprint) - area(a.footprint))[0];
  if (!big) return;
  const scene = v.scene;
  const g = glowBoxes(v, [big.id], 0);
  v.flashing = big.id;
  const t0 = performance.now();
  const DUR = 1600;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tick = (now) => {
    const k = (now - t0) / DUR;
    if (k >= 1 || bv !== v || v.scene !== scene) { v.stage?.ticks.delete(tick); dropGlow(g); v.flashing = null; return; }
    const a = still ? 1 : Math.sin(Math.PI * k);
    g.traverse((o) => { if (o.material?.color) o.material.color.setHex(0x3d5a8a).multiplyScalar(1.6 * a); });
  };
  v.stage.ticks.add(tick);
}

// 검증 결과 → 그 요소가 있는 장면으로 가서 강조
async function focusFinding(f) {
  const ids = f.elementIds || [];
  if (!ids.length || !bv?.ctx) return;
  try {
    if (!ids.some((id) => findElement(bv.ctx, id))) {
      const cur = await locate(ids);
      if (!cur) return;
      await go(cur);
    }
    select(ids.filter((id) => findElement(bv.ctx, id)), { fromFinding: true });
    aimSel();
  } catch (err) { toast(err.message, 'crit'); }
}
function aimSel() {
  const v = bv;
  const boxes = v.scene.boxesOf(v.sel);
  if (!boxes.length) return;
  const e = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.min(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])), Math.max(...boxes.map((b) => b[4])), Math.max(...boxes.map((b) => b[5]))];
  const keep = v.scene.ext;
  v.scene.ext = [e[0] - 3, e[1] - 3, e[2], e[3] + 3, e[4] + 3, e[5]];
  aimAt('iso');
  v.scene.ext = keep;
}

async function locate(ids) {
  const idx = await indexJson();
  const site = await file(idx.files.site);
  if (ids.some((id) => site.buildings.some((b) => b.id === id))) return { level: 'site' };
  const bids = Object.keys(idx.files.buildings);
  for (const tid of Object.keys(idx.files.unitTypes)) {
    const t = await typeJson(tid);
    if (!ids.some((id) => [...t.walls, ...t.openings, ...t.spaces, ...(t.columns || [])].some((x) => x.id === id))) continue;
    for (const bid of bids) {
      const b = await buildingJson(bid);
      const u = b.units.find((x) => x.unitTypeId === tid) || facilitiesOf(b).find((x) => x.unitTypeId === tid);
      if (u) return { level: 'unit', buildingId: bid, typeId: tid, unitId: b.units.includes(u) ? null : u.id };
    }
    return { level: 'unit', buildingId: null, typeId: tid, unitId: null }; // 어느 동에도 없는 타입(동 없는 모델)
  }
  for (const bid of bids) {
    const b = await buildingJson(bid);
    if (ids.some((id) => b.units.some((u) => u.id === id) || b.floorTemplates.some((t) => [...t.walls, ...t.openings, ...t.spaces, ...t.units].some((x) => x.id === id)))) return { level: 'building', buildingId: bid };
  }
  return null;
}

// ---------------------------------------------------------------- 화면(머리·이동 표시줄·도구 막대·패널·범례)

function renderChrome() {
  const v = bv;
  const m = v.model;
  $('#bv-sub').textContent = `v${m.version} · ${STATUS_LABEL[m.status] || ''}${m.note ? ` · ${m.note}` : ''}${v.preview ? ' · 고치는 중(미리보기)' : ''}`;
  const vers = v.versions;
  $('#bv-verbox').innerHTML = vers.length > 1 ? `<select id="bv-ver" class="bv-ver" aria-label="모델 버전">${vers.map((x) => `<option value="${esc(x.id)}" ${x.id === m.id ? 'selected' : ''}>v${x.version} ${STATUS_LABEL[x.status] || ''}</option>`).join('')}</select>` : '';
  for (const fn of hooks.chrome) fn(v);
  $('#bv-crumbs').innerHTML = crumbs().map((c, i, a) => (i === a.length - 1 ? `<b aria-current="page">${esc(c.label)}</b>` : `<button type="button" class="link" data-bv-crumb="${i}">${esc(c.label)}</button><span aria-hidden="true">›</span>`)).join('');
  v.el.querySelector('[data-bv="back"]')?.setAttribute('aria-label', v.stack.length > 1 ? '한 단계 뒤로' : '3D 닫기');
  renderBar();
  renderPanel();
  renderNote();
  const open = (store.bim.cachedFindings(m.id) || []).filter((f) => f.status === 'open').length;
  $('#bv-fcount').textContent = open ? String(open) : '';
}

// 단지 화면 위 알림 띠(42 지시서 1.3): 배치도에서 동 위치를 못 찾아 줄지어 놓았을 때, 동 외곽이 겹칠 때
function renderNote() {
  const el = $('#bv-note');
  if (!el) return;
  const c = bv.ctx;
  const out = [];
  if (c.level === 'site') {
    const pl = c.site.placement;
    if (pl?.row) out.push(`${icon('alert')}<span>배치도에서 동 위치를 찾지 못해 ${pl.row === pl.total ? '' : `${pl.row}개 동을 `}줄지어 놓았습니다. 실제 위치가 아닙니다.</span>`);
    else if (pl?.label) out.push(`${icon('alert')}<span>동 ${pl.label}개는 배치도의 이름 글자 자리에 놓았습니다. 위치와 방향을 확인해주세요.</span>`);
    const over = (store.bim.cachedFindings(bv.model.id) || []).filter((f) => f.kind === 'site.overlap' && f.status === 'open');
    if (over.length) out.push(`${icon('alert')}<span>동 외곽이 겹친 곳이 ${over.length}곳 있습니다.</span> <button type="button" class="link" data-bv-finding="${esc(over[0].id)}">검증에서 보기</button>`);
  }
  // 처음 열 때 글 띠를 띄우지 않는다(44 지시서 5.1): 확인할 것이 있으면 작은 표시만, 누르면 글이 나온다
  el.hidden = !out.length;
  el.innerHTML = out.length ? `<details class="bv-pop bv-notes"><summary class="btn sm" aria-label="확인할 것 ${out.length}개">${icon('alert')}<b>${out.length}</b></summary><div class="bv-pop-body">${out.map((x) => `<p>${x}</p>`).join('')}</div></details>` : '';
}

function crumbs() {
  const c = bv.ctx;
  if (c.level === 'unit' && !c.building) return [{ label: '세대 타입', cur: { level: 'site' } }, { label: `${c.type.name}${c.type.kind === 'facility' ? '' : ' 타입'}`, cur: bv.cur }];
  const out = [{ label: '단지', cur: { level: 'site' } }];
  if (c.level === 'site') return out;
  const b = c.building;
  const community = c.level === 'unit' && b.kind !== 'apartment' && !b.units.length;
  out.push({ label: b.name, cur: { level: 'building', buildingId: b.id } });
  if (community) return out;
  if (c.level === 'building') {
    if (bv.opts.only) out.push({ label: `${levelsOf(b).find((l) => l.id === bv.opts.only)?.name || ''} 층만`, cur: bv.cur });
    return out;
  }
  if (c.unit?.levelId) out.push({ label: levelsOf(b).find((l) => l.id === c.unit.levelId)?.name || '', cur: { level: 'building', buildingId: b.id, levelId: c.unit.levelId } });
  out.push({ label: c.unit?.label ? `${c.unit.label}호(${c.type.name})` : `${c.type.name}${c.type.kind === 'facility' ? '' : ' 타입'}`, cur: bv.cur });
  return out;
}

function floorsLabel() {
  const L = levelsOf(bv.ctx.building);
  const i = Math.min(bv.opts.upTo, L.length - 1);
  if (bv.opts.only) return `${L.find((l) => l.id === bv.opts.only)?.name || ''}만`;
  return i >= L.length - 1 ? `전체 ${L.filter((l) => l.height > 0 && !['rooftop', 'underground'].includes(l.kind)).length}층` : `${L[0].name}~${L[i].name}`;
}

// 세대의 자재 종류(부위 → 종류): 색 견본·수량·출처 수(42 지시서 4.4)
function kindRows() {
  const c = bv.ctx;
  return unitKinds(c.type, c.catalog, { height: c.height, level: c.floorLevel });
}
function kindsPop() {
  const o = bv.opts;
  const rows = kindRows();
  const k = o.kinds;
  const count = k?.only ? '1종만' : k?.hidden?.size ? `${rows.length - k.hidden.size}/${rows.length}` : '전체';
  const body = PARTS.map((part) => {
    const list = rows.filter((r) => r.part === part);
    if (!list.length) return '';
    return `<div class="bv-kgroup"><b>${PART_KO[part]}</b>${list.map((r) => `<div class="bv-krow${k?.only === r.key ? ' only' : ''}">
        <label class="check"><input type="checkbox" data-bv-kind="${esc(r.key)}" ${k?.hidden?.has(r.key) ? '' : 'checked'} aria-label="${esc(r.label)} 보기"><span><i class="sw" style="background:${esc(r.color)}"></i>${esc(r.label)}</span></label>
        <span class="muted small">${esc(kindQty(r))} · ${r.assumed ? '<span class="t-warn">기본값</span>' : `출처 ${r.sources}`}</span>
        <button type="button" class="link small" data-bv-kind-only="${esc(r.key)}" aria-pressed="${k?.only === r.key}">${k?.only === r.key ? '모두 보기' : '이것만'}</button></div>`).join('')}</div>`;
  }).join('');
  return `<details class="bv-pop bv-kinds" id="bv-filter" ${bv.filterOpen ? 'open' : ''}><summary class="btn sm ${k ? 'on' : ''}">${icon('filter')}재료 ${count}</summary>
      <div class="bv-pop-body">${body}<p class="muted small">수량은 그림에서 낸 어림값입니다. 정확한 수량은 [수량] 탭을 보세요.</p>
      <button type="button" class="link small" data-bv="filter-clear">모두 보기</button></div></details>`;
}

// 도구 줄(44 지시서 5.4): 처음 보이는 것은 [단면]과 [더 보기]뿐. 나머지(마감 층·재료·실물 보기·측정·보는 방향 …)는 [더 보기] 안에
function renderBar() {
  const v = bv;
  const c = v.ctx;
  const o = v.opts;
  const main = [];
  const more = [];
  const tg = (key, label, ic) => `<button type="button" class="btn sm ${o[key] ? 'on' : ''}" data-bv-toggle="${key}" aria-pressed="${Boolean(o[key])}">${icon(ic)}${label}</button>`;
  const cutPop = (on, body) => `<details class="bv-pop bv-cut" id="bv-cutpop" ${v.cutOpen ? 'open' : ''}><summary class="btn ${on ? 'on' : ''}">${icon('cut')}<span>단면</span></summary><div class="bv-pop-body">${body}</div></details>`;
  if (c.level === 'building') {
    const L = levelsOf(c.building);
    main.push(cutPop(Boolean(o.only) || o.upTo < L.length - 1, `<label class="mview-range"><span id="bv-floors">${esc(floorsLabel())}</span><input type="range" id="bv-upto" min="0" max="${L.length - 1}" value="${Math.min(o.upTo, L.length - 1)}" aria-label="몇 층까지 볼지"></label>
      <button type="button" class="btn sm ${o.only ? 'on' : ''}" data-bv="only" aria-pressed="${Boolean(o.only)}">${o.only ? '전체 층' : '이 층만'}</button>`));
    if (c.building.facade?.panels?.length && !o.sheetId) more.push(tg('shell', '외피', 'building'));
  }
  if (c.level === 'unit') {
    const cuts = ['', 'h', 'v', 'box', 'line', ...(o.cut === 'wall' ? ['wall'] : [])];
    const names = ['왼쪽', '오른쪽', '앞', '뒤', '아래', '위'];
    main.push(cutPop(Boolean(o.cut) || Boolean(v.lineDraw), `<label class="mview-sheet"><span>자르기</span><select id="bv-cut" aria-label="단면 자르기">${cuts.map((k) => `<option value="${k}" ${(v.lineDraw ? 'line' : o.cut) === k ? 'selected' : ''}>${CUT_LABEL[k]}</option>`).join('')}</select></label>
      ${o.cut === 'v' ? `<label class="mview-range"><span>위치</span><input type="range" id="bv-cutv" min="0" max="100" value="${o.cutV}" aria-label="수직 단면 위치"></label>` : ''}
      ${o.cut === 'box' ? `<div class="bv-boxes">${names.map((nm, i) => `<label class="mview-range"><span>${nm}</span><input type="range" data-bv-box="${i}" min="0" max="100" value="${o.box[i]}" aria-label="단면 상자 ${nm} 면"></label>`).join('')}
        <button type="button" class="link small" data-bv="box-reset">처음으로</button></div>` : ''}
      ${tg('partCut', '눌러서 단면', 'cut')}`));
    if (v.lineDraw) main.push('<span class="bv-hint">선의 두 점을 누르세요</span>');
    if (v.part || o.focus || o.cut === 'wall') main.push(`<button type="button" class="btn sm on" data-bv="part-clear">${v.part?.part === 'wall' ? '벽 단면' : '이 실만 보기'} 끄기 ✕</button>`);
    more.push(tg('layers', '마감 층', 'layers'), tg('ceiling', '천장', 'layers'), kindsPop(), tg('zones', '시공부위', 'alert'));
    if (v.scene?.strays?.size) more.push(`<button type="button" class="btn sm ${o.stray ? 'on' : ''}" data-bv-toggle="stray" aria-pressed="${Boolean(o.stray)}" title="벽에 이어지지 않은 선 조각(각주·지시선일 수 있음)">${icon('alert')}확인 필요 보기 ${v.scene.strays.size}</button>`);
  }
  if (linked()) {
    const p = progressNow();
    more.push(`<label class="mview-sheet"><span>공정 색</span><select id="bv-sheet"><option value="">끄기</option>${p.sheets.map((h) => `<option value="${esc(h.id)}" ${o.sheetId === h.id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select></label>`);
  }
  for (const fn of hooks.bar) more.push(fn(v));
  more.push(`<span class="bv-aims"><span class="muted small">보는 방향</span>${[['top', '위에서'], ['iso', '비스듬히'], ['front', '정면']].map(([k, l]) => `<button type="button" class="btn sm" data-bv-aim="${k}">${l}</button>`).join('')}</span>`);
  $('#bv-bar').innerHTML = `${main.join('')}<span class="spacer"></span><button type="button" class="btn bv-more-btn ${v.moreOpen ? 'on' : ''}" data-bv="more" aria-expanded="${Boolean(v.moreOpen)}" aria-controls="bv-more">${icon('more')}<span>더 보기</span></button>`;
  $('#bv-more-tools').innerHTML = more.join('');
}

function setMore(on) {
  bv.moreOpen = on;
  const m = $('#bv-more');
  if (m) m.hidden = !on;
  const b = bv.el.querySelector('[data-bv="more"]');
  b?.classList.toggle('on', on);
  b?.setAttribute('aria-expanded', String(on));
}

// 이동 표시줄을 누르면: 지나온 단계면 기록으로 뒤로(뒤로 가기와 같은 길), 아니면 그 단계로 들어간다
function crumbGo(i) {
  const target = crumbs()[i]?.cur;
  if (!target) return;
  const st = bv.stack;
  let k = -1;
  for (let j = st.length - 1; j >= 0; j--) if (!st[j].part && sameScene(st[j], target)) { k = j; break; }
  if (k >= 0 && k < st.length - 1) history.go(k - (st.length - 1));
  else go(target);
}

function renderLegend() {
  const el = $('#bv-legend');
  if (!el) return;
  const c = bv.ctx;
  const sh = sheetNow();
  const parts = [];
  if (sh && c.level !== 'unit') {
    parts.push(...sh.trades.map((t, i) => `<span style="--c:${t.color};--i:${inkFor(t.color)}"><b>${i + 1}</b>${esc(t.name)}</span>`));
  } else if (sh && c.level === 'unit' && c.unit?.unitKey) {
    parts.push(`<span class="muted small">공정: ${progressOf(c.unit) || '시작 전'} — 끝난 공종의 재료 층은 진하게, 아직인 층은 투명하게 보입니다.</span>`);
  }
  if (c.level === 'unit' && (bv.opts.layers || bv.opts.cut === 'h')) {
    const mats = new Map((c.catalog.materials || []).map((m) => [m.id, m]));
    const used = new Set();
    for (const ch of bv.scene.group.children) if (ch.userData?.kind === 'wall' && ch.userData.materialId) used.add(ch.userData.materialId);
    parts.push(...[...used].map((id) => mats.get(id)).filter(Boolean).map((m) => `<span class="mat"><i class="sw" style="background:${esc(m.color || CATEGORY_COLOR[m.category])}"></i>${esc(m.name)}</span>`));
  }
  el.hidden = !parts.length;
  el.innerHTML = parts.join('');
}

function panelCtx() { return { ...bv.ctx, part: bv.part, findings: store.bim.cachedFindings(bv.model.id) || [] }; }

function renderPanel() {
  const info = $('#bv-info');
  if (!info || !bv.ctx) return;
  info.innerHTML = panelHtml(panelCtx(), bv.sel);
  for (const cv of info.querySelectorAll('canvas[data-bv-crop]')) {
    const sh = bv.sheets.find((s) => s.id === cv.dataset.bvCrop);
    if (sh) drawCrop(cv, sh, cv.dataset.bbox ? JSON.parse(cv.dataset.bbox) : null);
  }
}

function setTab(tab) {
  bv.tab = tab;
  for (const b of bv.el.querySelectorAll('[data-bv-tab]')) b.setAttribute('aria-selected', String(b.dataset.bvTab === tab));
  for (const p of bv.el.querySelectorAll('.bv-pane')) p.hidden = p.id !== `bv-${tab}`;
  const h = hooks.tabs.find((x) => x.key === tab);
  if (h) h.render($(`#bv-${tab}`), bv);
  if (tab === 'findings' && !bv.fpanel) bv.fpanel = createFindingsPanel($('#bv-findings'), { siteId: bv.siteId, model: bv.model, compact: true, onSelect: focusFinding });
}

function openPanel(on) {
  bv.el.classList.toggle('panel-open', on);
  bv.el.querySelector('[data-bv="panel"]')?.setAttribute('aria-pressed', String(on));
}

// ---------------------------------------------------------------- 이벤트

function bindEvents(el) {
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-bv],[data-bv-toggle],[data-bv-aim],[data-bv-crumb],[data-bv-go],[data-bv-pick],[data-bv-tab],[data-bv-finding],[data-bv-sheet],[data-bv-kind-only],[data-bv-part]');
    if (!t || !bv) return;
    const d = t.dataset;
    try {
      if (d.bv === 'close') closeBimViewer();
      else if (d.bv === 'back') goBack();
      else if (d.bv === 'more') setMore(!bv.moreOpen);
      else if (d.bv === 'panel') { openPanel(!bv.el.classList.contains('panel-open')); setMore(false); }
      else if (d.bv === 'only') {
        const L = levelsOf(bv.ctx.building);
        bv.opts.only = bv.opts.only ? null : L[Math.min(bv.opts.upTo, L.length - 1)].id;
        bv.cur = { ...bv.cur, levelId: bv.opts.only };
        draw();
        renderChrome();
      } else if (d.bv === 'filter-clear') { bv.opts.filter = null; bv.opts.kinds = null; draw(); renderBar(); }
      else if (d.bv === 'part-clear') partBack();
      else if (d.bv === 'box-reset') { bv.opts.box = [0, 100, 0, 100, 0, 100]; applyBox(); renderBar(); }
      else if (d.bvKindOnly) {
        const k = bv.opts.kinds || { only: null, hidden: new Set() };
        k.only = k.only === d.bvKindOnly ? null : d.bvKindOnly;
        bv.opts.kinds = k.only || k.hidden.size ? k : null;
        draw();
        renderBar();
      }
      else if (d.bvPart) { if (bv.part) { bv.part = { ...bv.part, part: d.bvPart }; draw(); renderPanel(); } }
      else if (d.bvToggle) { bv.opts[d.bvToggle] = !bv.opts[d.bvToggle]; draw(); renderBar(); }
      else if (d.bvAim) aimAt(d.bvAim);
      else if (d.bvCrumb != null) crumbGo(Number(d.bvCrumb));
      else if (d.bvGo === 'building') await goBuilding(d.id);
      else if (d.bvGo === 'unit') await drill(d.id);
      else if (d.bvGo === 'type') await go({ level: 'unit', buildingId: bv.ctx.building?.id || null, typeId: d.id, unitId: null });
      else if (d.bvPick) select([d.bvPick]);
      else if (d.bvTab) setTab(d.bvTab);
      else if (d.bvFinding) { setTab('findings'); bv.fpanel.select(d.bvFinding); const f = (store.bim.cachedFindings(bv.model.id) || []).find((x) => x.id === d.bvFinding); if (f) focusFinding(f); }
      else if (d.bvSheet) {
        const sh = bv.sheets.find((s) => s.id === d.bvSheet);
        const b = d.bbox ? JSON.parse(d.bbox) : null;
        if (sh) openSheetViewer(sh, { boxes: b ? [[b.x0, b.y0, b.x1, b.y1]] : [] });
      }
    } catch (err) { toast(err.message, 'crit'); }
  });
  el.addEventListener('input', (e) => {
    if (!bv?.ctx) return;
    const t = e.target;
    if (t.id === 'bv-upto') {
      bv.opts.upTo = Number(t.value);
      if (bv.opts.only) { bv.opts.only = levelsOf(bv.ctx.building)[bv.opts.upTo].id; bv.cur = { ...bv.cur, levelId: bv.opts.only }; }
      draw();
      $('#bv-floors').textContent = floorsLabel();
    } else if (t.id === 'bv-cutv') {
      bv.opts.cutV = Number(t.value);
      const [x0, , , x1] = typeExt(bv.ctx.type);
      bv.clip.setV(x0 + ((x1 - x0) * bv.opts.cutV) / 100);
    } else if (t.dataset.bvBox != null) {
      // 상자 단면: 마주 보는 면끼리 엇갈리지 않게(2% 띄움)
      const i = Number(t.dataset.bvBox);
      const b = bv.opts.box;
      b[i] = Number(t.value);
      const j = i ^ 1;
      if (i % 2 === 0 && b[i] > b[j] - 2) b[i] = b[j] - 2;
      if (i % 2 === 1 && b[i] < b[j] + 2) b[i] = b[j] + 2;
      if (String(b[i]) !== t.value) t.value = b[i];
      applyBox();
    }
  });
  el.addEventListener('change', async (e) => {
    if (!bv?.ctx) return;
    const t = e.target;
    if (t.id === 'bv-cut') {
      if (t.value === 'line') { startLine(); return; }
      bv.lineDraw = null;
      if (bv.part?.part === 'wall') bv.part = null;
      bv.opts.cut = t.value;
      draw();
      renderBar();
    } else if (t.dataset.bvKind) {
      const k = bv.opts.kinds || { only: null, hidden: new Set() };
      if (t.checked) k.hidden.delete(t.dataset.bvKind); else k.hidden.add(t.dataset.bvKind);
      bv.opts.kinds = k.only || k.hidden.size ? k : null;
      draw();
      renderBar();
    }
    else if (t.id === 'bv-sheet') { bv.opts.sheetId = t.value; draw(); renderPanel(); }
    else if (t.dataset.bvCat) {
      const f = new Set(bv.opts.filter || []);
      if (t.checked) f.add(t.dataset.bvCat); else f.delete(t.dataset.bvCat);
      bv.opts.filter = f.size ? f : null;
      draw();
      renderBar();
    } else if (t.id === 'bv-ver') {
      if (bv.preview && !(await confirmDialog('고치는 중인 내용이 있습니다. 버전을 바꾸면 버립니다.', { title: '버전 바꾸기', ok: '버리고 바꾸기', danger: true }))) { renderChrome(); return; }
      bv.edits = null;
      await viewerSwitch(t.value);
    }
  });
  // 재료 목록을 열면 층 구성으로 그려 자재가 보이게 한다
  el.addEventListener('toggle', (e) => {
    if (e.target.id === 'bv-cutpop' && bv) bv.cutOpen = e.target.open;
    if (e.target.id === 'bv-filter' && bv && bv.filterOpen !== e.target.open) { bv.filterOpen = e.target.open; if (bv.ctx?.level === 'unit' && bv.stage) draw(); }
  }, true);
  // 재료 목록·단면·[더 보기] 밖을 누르면 닫는다
  el.addEventListener('pointerdown', (e) => {
    const p = el.querySelector('#bv-filter[open]');
    if (p && !p.contains(e.target)) p.open = false;
    const c = el.querySelector('#bv-cutpop[open]');
    if (c && !c.contains(e.target) && e.target.closest?.('.bv-stage')) c.open = false;
    if (bv?.moreOpen && !e.target.closest?.('#bv-more, [data-bv="more"]')) setMore(false);
  });
}

onAction('bim-open', (el) => openBimViewer(el.dataset.site || state.siteId, el.dataset.id || null));
// 뒤로 가기: 3D 안의 단계 기록이면 그 단계로(한 단계 뒤로), 3D 밖으로 나가면 닫기
window.addEventListener('popstate', () => {
  if (!bv) return;
  const st = history.state;
  if (st?.baromapBim) { onBimPop(st.bimDepth || 0); return; }
  if (!st?.baromapSheet) closeBimViewer({ fromHistory: true });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bv && !$('#modal') && !document.querySelector('.sview')) closeBimViewer(); });
// 라이트·다크가 바뀌면 다시 그린다(색을 그릴 때 정한다)
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (!bv?.stage || !bv.ctx) return;
  bv.mats.dispose();
  bv.mats = makeMaterials(bv.stage.T);
  bv.stage.scene.background = new bv.stage.T.Color(BG());
  draw();
});
// 공정·검증 결과가 바뀌면(다른 사람 입력 포함) 공정 색·패널을 다시(한 화면 그림에 한 번)
let soon = 0;
function refreshSoon() {
  if (soon || !bv?.ctx) return;
  soon = requestAnimationFrame(() => {
    soon = 0;
    if (!bv?.ctx || !bv.stage) return;
    if (sheetNow()) draw();
    const open = (store.bim.cachedFindings(bv.model.id) || []).filter((f) => f.status === 'open').length;
    $('#bv-fcount').textContent = open ? String(open) : '';
    if (!bv.el.querySelector('#bv-info')?.contains(document.activeElement)) renderPanel();
    for (const fn of hooks.chrome) fn(bv);
    const h = hooks.tabs.find((x) => x.key === bv.tab);
    if (h && !$(`#bv-${h.key}`)?.contains(document.activeElement)) h.render($(`#bv-${h.key}`), bv);
  });
}
export const bimViewerOpen = () => Boolean(bv);
/** 다른 도구(두 점 재기·걷기)가 누름을 쓰는 동안 켠다: 눌러도 단계 이동·고르기를 하지 않는다 */
export const setViewerToolMode = (on) => { if (bv) bv.toolMode = Boolean(on); };

// ---------------------------------------------------------------- 07(고치기·버전)에서 쓰는 것

/** 한 버전의 모델 파일 전부(고치기 전 원본) */
export async function viewerModelFiles(model = bv.model) {
  const load = (name) => (model.id === bv.model.id ? baseFile(name) : store.bim.load(model, name));
  const idx = await load('index.json');
  const names = ['index.json', idx.files.site, idx.files.catalog, ...Object.values(idx.files.buildings), ...Object.values(idx.files.unitTypes)];
  return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await load(n)])));
}
/** 고친 파일로 미리보기(null이면 원본으로) */
export async function viewerPreview(files) {
  if (!bv) return;
  bv.preview = files;
  await show(bv.cur, { aim: false, keepSel: true });
}
/** 3D에 색 상자 표시: Map(id → 색) | null */
export function viewerMarks(marks) {
  if (!bv?.scene) return;
  bv.marks = marks && marks.size ? marks : null;
  highlight();
}
/** 다른 버전으로(새 버전 저장·되돌리기·확정 뒤) — 같은 장면을 유지하고, 없으면 단지로 */
export async function viewerSwitch(modelId) {
  const v = bv;
  if (!v) return;
  await store.bim.versions(v.siteId);
  v.versions = visibleVersions(v.siteId);
  const m = v.versions.find((x) => x.id === modelId);
  if (!m) { renderChrome(); return; }
  v.model = m;
  v.preview = null;
  v.marks = null;
  v.fpanel?.destroy();
  v.fpanel = null;
  $('#bv-findings').innerHTML = '';
  if (v.tab === 'findings') setTab('info');
  await loadSide(v);
  await show(v.cur, { aim: false });
}
/** 지금 장면의 파일 이름: { type, building, index } */
export async function viewerFileNames() {
  const idx = await baseFile('index.json');
  const c = bv.ctx;
  return { type: c.type ? idx.files.unitTypes[c.type.id] : null, building: c.building ? idx.files.buildings[c.building.id] : null, index: idx };
}
export const viewerSelect = (ids) => bv && select(ids);
export const viewerRedraw = () => { if (bv?.stage && bv.ctx) { draw(); renderBar(); } };
// 장면 위에 덧그린 것(측정·잘라보기)의 글자
export const viewerLabels = (extra) => { if (!bv?.scene) return; bv.extraLabels = extra; setLabels([...partLabels(), ...bv.scene.labels, ...extra]); };
export const viewerRenderPanel = () => { if (bv?.ctx) renderPanel(); };
export const viewerRenderTab = () => { const h = bv && hooks.tabs.find((x) => x.key === bv.tab); if (h) h.render($(`#bv-${bv.tab}`), bv); };
export const viewerRenderChrome = () => bv && renderChrome();
// 화면 확인 스크립트(tools/ui-check)·07 수정 화면이 지금 장면을 읽는다
export const bimViewerState = () => bv;
