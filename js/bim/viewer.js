// BIM 3D 보기(06): 단지 → 동 → 세대(벽 마감 층까지). 전체 화면, 이동 표시줄, 카메라 [위에서][비스듬히][정면],
// 동: 층 자르기·이 층만 / 세대: 마감 층·단면(수평·수직)·재료 거르기·시공부위 / 공정 색(골구도 세대 단위),
// 요소 선택 → 정보 패널(층 구성 표·근거 도면 조각·관련 검증) · 검증 결과 탭. 모델 파일은 장면마다 필요한 것만 받는다.
import { store, state, q } from '../ctx.js';
import { loadThree } from '../model3d.js';
import { addDrawingsTool } from '../drawings.js';
import { buildingUnits, inkFor } from '../model.js';
import { makeMaterials, BG, dark } from './materials-3d.js';
import { CATEGORY_LABEL, CATEGORY_COLOR } from './materials-ko.js';
import { buildSite } from './mesh-site.js';
import { buildBuilding } from './mesh-building.js';
import { buildFacadeMesh, lodDistance, shellColor } from './mesh-facade.js';
import { buildUnit } from './mesh-unit.js';
import { doneMaterials } from './mesh-calc.js';
import { createClip, CUT_Z } from './clip.js';
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
  const sum = (m) => `동 ${m.summary?.apartments ?? '-'} · 세대 ${m.summary?.units ?? '-'}`;
  const hero = ok ? `<button type="button" class="tour-hero bim" data-act="bim-open" data-site="${esc(siteId)}" data-id="${esc(ok.id)}" aria-label="단지 3D로 보기">
      <span class="tour-bim" aria-hidden="true">${icon('building')}${icon('building')}${icon('building')}</span>
      <span class="tour-play">${icon('cube')}단지 3D</span>
      <span class="tour-cap">확정 v${ok.version} · ${sum(ok)}</span></button>` : '';
  const chip = top && top !== ok ? `<button type="button" class="btn sm" data-act="bim-open" data-site="${esc(siteId)}" data-id="${esc(top.id)}">${icon('cube')}단지 3D(초안 v${top.version})</button>` : '';
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
  el.innerHTML = `<header class="board-head">
      <button type="button" class="icon-btn" data-bv="close" aria-label="닫기" title="닫기">${icon('close')}</button>
      <div class="board-title"><b>${esc(s.name)} 3D</b><span id="bv-sub"></span></div>
      <div class="board-tools">
        <span id="bv-verbox"></span><span class="bv-extra" id="bv-extra"></span>
        <button type="button" class="btn sm bv-panel-btn" data-bv="panel" aria-pressed="false" aria-controls="bv-panel">${icon('table')}<span>정보</span></button>
      </div>
    </header>
    <nav class="bv-crumbs" id="bv-crumbs" aria-label="이동 표시줄"></nav>
    <div class="bv-main">
      <div class="bv-stage mview-stage" id="bv-stage"><div class="bv-labels" id="bv-labels" aria-hidden="true"></div><p class="viewer-msg" id="bv-msg">3D 모델을 불러오는 중…</p></div>
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
    <div class="mview-legend" id="bv-legend" hidden></div>`;
  document.body.append(el);
  document.body.classList.add('board-open');
  bv = {
    el, siteId, model, versions, files: new Map(), preview: null, marks: null, cur: { level: 'site' }, ctx: null, sel: [], tab: 'info', sheets: [], labels: [], labelKey: '',
    opts: { upTo: Infinity, only: null, layers: false, cut: '', cutV: 50, filter: null, zones: false, sheetId: '', shell: true }, returnFocus: document.activeElement,
  };
  if (!pushed) { history.pushState({ baromapBim: true }, ''); pushed = true; }
  el.querySelector('[data-bv="close"]').focus();
  bindEvents(el);
  bv.unsub = store.subscribe(refreshSoon);
  const v = bv;
  if (!webgl2()) { $('#bv-msg').textContent = '이 기기에서는 3D를 볼 수 없습니다(WebGL2를 지원하지 않는 브라우저).'; return; }
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
    await show({ level: 'site' });
    $('#bv-msg')?.remove();
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
  v.el.remove();
  if (!document.querySelector('.board, .mview, .sview, .fview')) document.body.classList.remove('board-open');
  if (keepHistory) return;
  v.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.back();
  pushed = false;
}

// ---------------------------------------------------------------- 장면

/** cur: { level: 'site' } | { level: 'building', buildingId, levelId? } | { level: 'unit', buildingId, typeId, unitId? } */
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
  const building = await buildingJson(cur.buildingId);
  if (cur.level === 'building') return { ...base, building, types: await typesOf(building) };
  const type = await typeJson(cur.typeId);
  const unit = cur.unitId ? building.units.find((u) => u.id === cur.unitId) || facilitiesOf(building).find((u) => u.id === cur.unitId) || null : null;
  // 세대 높이 = 그 층 층고 - 슬래브(타입만 볼 때는 그 타입이 있는 첫 층)
  const lid = unit?.levelId || building.units.find((u) => u.unitTypeId === type.id)?.levelId || facilitiesOf(building).find((u) => u.unitTypeId === type.id)?.levelId;
  const lv = building.levels.find((l) => l.id === lid);
  const height = Math.max(2.2, (lv?.height || 2.9) - SLAB);
  return { ...base, building, type, unit, height, types: new Map([[type.id, type]]) };
}

async function show(cur, { aim = true, keepSel = false } = {}) {
  const v = bv;
  if (!v?.stage) return;
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
  v.cur = cur;
  v.ctx = ctx;
  if (!keepSel) v.sel = [];
  draw();
  if (aim) aimAt('iso');
  renderChrome();
}

function draw() {
  const v = bv;
  const { T, root } = v.stage;
  const c = v.ctx;
  if (v.scene) { clearHighlight(); root.remove(v.scene.group); disposeGroup(v.scene.group); }
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
    sc = buildUnit(T, v.mats, { type: c.type, catalog: c.catalog }, {
      height: c.height, layers: v.opts.layers, cutZ: v.opts.cut === 'h' ? CUT_Z : null, clip: v.clip.planes(v.opts.cut),
      filter: v.opts.filter, zones: v.opts.zones, fade: fadeSet(),
    });
  }
  v.scene = sc;
  root.add(sc.group);
  v.extraLabels = [];
  setLabels(sc.labels);
  highlight();
  renderLegend();
  v.real?.prepare(sc.group, sc.ext);
  for (const fn of hooks.scene) fn(v, sc);
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
  const dir = { top: [0, 1, 0.0001], iso: unit ? [0.8, 1.35, 1.05] : [1, 0.85, 1.25], front: [0, 0.22, 1] }[mode] || [1, 0.85, 1.25];
  const d = new T.Vector3(...dir).normalize().multiplyScalar(dist);
  camera.near = Math.max(0.05, r / 300);
  camera.far = dist + r * 40;
  camera.updateProjectionMatrix();
  v.stage.fly(c.clone().add(d), c, instant);
}

// ---------------------------------------------------------------- 라벨(HTML, 화면에 겹치면 숨김)

function setLabels(list) {
  const box = $('#bv-labels');
  if (!box) return;
  box.innerHTML = list.map((l) => `<span class="bv-label ${l.cls || ''}">${esc(l.text)}</span>`).join('');
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
  const key = `${camera.matrixWorld.elements.map((x) => x.toFixed(3)).join()}|${box.clientWidth}x${box.clientHeight}|${v.labels.length}`;
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
    const off = p.z > 1 || p.z < -1 || r[2] < 0 || r[0] > W || r[3] < 0 || r[1] > H;
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

function onPick(id, { add, double }) {
  if (!bv?.ctx) return;
  if (double && id) { drill(id); return; }
  if (!id) { if (!add && bv.sel.length) select([]); return; }
  if (add) select(bv.sel.includes(id) ? bv.sel.filter((x) => x !== id) : [...bv.sel, id]);
  else select([id]);
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
      if (u) await show({ level: 'unit', buildingId: c.building.id, typeId: u.unitTypeId, unitId: u.id });
    }
  } catch (err) { toast(err.message, 'crit'); }
}

// 커뮤니티(시설 하나)는 바로 시설 평면으로
async function goBuilding(id) {
  const b = await buildingJson(id);
  const fac = facilitiesOf(b);
  if (b.kind !== 'apartment' && !b.units.length && new Set(fac.map((f) => f.unitTypeId)).size === 1) await show({ level: 'unit', buildingId: id, typeId: fac[0].unitTypeId, unitId: fac[0].id });
  else await show({ level: 'building', buildingId: id });
}

// 검증 결과 → 그 요소가 있는 장면으로 가서 강조
async function focusFinding(f) {
  const ids = f.elementIds || [];
  if (!ids.length || !bv?.ctx) return;
  try {
    if (!ids.some((id) => findElement(bv.ctx, id))) {
      const cur = await locate(ids);
      if (!cur) return;
      await show(cur);
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
  $('#bv-sub').textContent = `모델 v${m.version} · ${STATUS_LABEL[m.status] || ''}${m.note ? ` · ${m.note}` : ''}${v.preview ? ' · 고치는 중(미리보기)' : ''}`;
  const vers = v.versions;
  $('#bv-verbox').innerHTML = vers.length > 1 ? `<select id="bv-ver" class="bv-ver" aria-label="모델 버전">${vers.map((x) => `<option value="${esc(x.id)}" ${x.id === m.id ? 'selected' : ''}>v${x.version} ${STATUS_LABEL[x.status] || ''}</option>`).join('')}</select>` : '';
  for (const fn of hooks.chrome) fn(v);
  $('#bv-crumbs').innerHTML = crumbs().map((c, i, a) => (i === a.length - 1 ? `<b aria-current="page">${esc(c.label)}</b>` : `<button type="button" class="link" data-bv-crumb="${i}">${esc(c.label)}</button><span aria-hidden="true">›</span>`)).join('');
  renderBar();
  renderPanel();
  const open = (store.bim.cachedFindings(m.id) || []).filter((f) => f.status === 'open').length;
  $('#bv-fcount').textContent = open ? String(open) : '';
}

function crumbs() {
  const c = bv.ctx;
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

function wallCategories() {
  const c = bv.ctx;
  const mats = new Map((c.catalog.materials || []).map((m) => [m.id, m]));
  const asm = new Map((c.catalog.assemblies || []).map((a) => [a.id, a]));
  const cats = new Set();
  for (const w of c.type.walls) for (const l of asm.get(w.assemblyId)?.layers || []) cats.add(mats.get(l.materialId)?.category || 'other');
  return [...cats];
}

function renderBar() {
  const v = bv;
  const c = v.ctx;
  const o = v.opts;
  const out = [];
  const tg = (key, label, ic) => `<button type="button" class="btn sm ${o[key] ? 'on' : ''}" data-bv-toggle="${key}" aria-pressed="${Boolean(o[key])}">${icon(ic)}${label}</button>`;
  if (c.level === 'building') {
    const L = levelsOf(c.building);
    out.push(`<label class="mview-range"><span id="bv-floors">${esc(floorsLabel())}</span><input type="range" id="bv-upto" min="0" max="${L.length - 1}" value="${Math.min(o.upTo, L.length - 1)}" aria-label="몇 층까지 볼지"></label>`);
    out.push(`<button type="button" class="btn sm ${o.only ? 'on' : ''}" data-bv="only" aria-pressed="${Boolean(o.only)}">${o.only ? '전체 층' : '이 층만'}</button>`);
    if (c.building.facade?.panels?.length && !o.sheetId) out.push(tg('shell', '외피', 'building'));
  }
  if (c.level === 'unit') {
    out.push(tg('layers', '마감 층', 'layers'));
    out.push(`<label class="mview-sheet"><span>${icon('cut')}단면</span><select id="bv-cut" aria-label="단면 자르기">${[['', '없음'], ['h', `수평 ${CUT_Z}m`], ['v', '수직']].map(([k, l]) => `<option value="${k}" ${o.cut === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`);
    if (o.cut === 'v') out.push(`<label class="mview-range"><span>위치</span><input type="range" id="bv-cutv" min="0" max="100" value="${o.cutV}" aria-label="수직 단면 위치"></label>`);
    const cats = wallCategories();
    out.push(`<details class="bv-pop" id="bv-filter" ${v.filterOpen ? 'open' : ''}><summary class="btn sm ${o.filter ? 'on' : ''}">${icon('filter')}재료 ${o.filter ? `${o.filter.size}` : '전체'}</summary>
      <div class="bv-pop-body">${cats.map((k) => `<label class="check"><input type="checkbox" data-bv-cat="${esc(k)}" ${o.filter?.has(k) ? 'checked' : ''}><span><i class="sw" style="background:${CATEGORY_COLOR[k] || '#ccc'}"></i>${esc(CATEGORY_LABEL[k] || k)}</span></label>`).join('')}
      <button type="button" class="link small" data-bv="filter-clear">모두 보기</button></div></details>`);
    out.push(tg('zones', '시공부위', 'alert'));
  }
  if (linked()) {
    const p = progressNow();
    out.push(`<label class="mview-sheet"><span>공정 색</span><select id="bv-sheet"><option value="">끄기</option>${p.sheets.map((h) => `<option value="${esc(h.id)}" ${o.sheetId === h.id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select></label>`);
  }
  for (const fn of hooks.bar) out.push(fn(v));
  out.push('<span class="spacer"></span>');
  out.push([['top', '위에서'], ['iso', '비스듬히'], ['front', '정면']].map(([k, l]) => `<button type="button" class="btn sm" data-bv-aim="${k}">${l}</button>`).join(''));
  $('#bv-bar').innerHTML = out.join('');
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

function panelCtx() { return { ...bv.ctx, findings: store.bim.cachedFindings(bv.model.id) || [] }; }

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
    const t = e.target.closest('[data-bv],[data-bv-toggle],[data-bv-aim],[data-bv-crumb],[data-bv-go],[data-bv-pick],[data-bv-tab],[data-bv-finding],[data-bv-sheet]');
    if (!t || !bv) return;
    const d = t.dataset;
    try {
      if (d.bv === 'close') closeBimViewer();
      else if (d.bv === 'panel') openPanel(!bv.el.classList.contains('panel-open'));
      else if (d.bv === 'only') {
        const L = levelsOf(bv.ctx.building);
        bv.opts.only = bv.opts.only ? null : L[Math.min(bv.opts.upTo, L.length - 1)].id;
        bv.cur = { ...bv.cur, levelId: bv.opts.only };
        draw();
        renderChrome();
      } else if (d.bv === 'filter-clear') { bv.opts.filter = null; draw(); renderBar(); }
      else if (d.bvToggle) { bv.opts[d.bvToggle] = !bv.opts[d.bvToggle]; draw(); renderBar(); }
      else if (d.bvAim) aimAt(d.bvAim);
      else if (d.bvCrumb != null) await show(crumbs()[Number(d.bvCrumb)].cur);
      else if (d.bvGo === 'building') await goBuilding(d.id);
      else if (d.bvGo === 'unit') await drill(d.id);
      else if (d.bvGo === 'type') await show({ level: 'unit', buildingId: bv.ctx.building.id, typeId: d.id, unitId: null });
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
    }
  });
  el.addEventListener('change', async (e) => {
    if (!bv?.ctx) return;
    const t = e.target;
    if (t.id === 'bv-cut') { bv.opts.cut = t.value; draw(); renderBar(); }
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
  el.addEventListener('toggle', (e) => { if (e.target.id === 'bv-filter' && bv) bv.filterOpen = e.target.open; }, true);
}

onAction('bim-open', (el) => openBimViewer(el.dataset.site || state.siteId, el.dataset.id || null));
window.addEventListener('popstate', () => { if (bv && !history.state?.baromapBim && !history.state?.baromapSheet) closeBimViewer({ fromHistory: true }); });
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
export const viewerLabels = (extra) => { if (!bv?.scene) return; bv.extraLabels = extra; setLabels([...bv.scene.labels, ...extra]); };
export const viewerRenderPanel = () => { if (bv?.ctx) renderPanel(); };
export const viewerRenderTab = () => { const h = bv && hooks.tabs.find((x) => x.key === bv.tab); if (h) h.render($(`#bv-${bv.tab}`), bv); };
export const viewerRenderChrome = () => bv && renderChrome();
// 화면 확인 스크립트(tools/ui-check)·07 수정 화면이 지금 장면을 읽는다
export const bimViewerState = () => bv;
