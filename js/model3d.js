// 현장 3D 모델: 도면(DXF)의 벽·기둥 선을 세워 한 층을 만들고, 동이면 층수만큼 쌓는다(three.js).
// - 만들기: 도면 파일 → 레이어마다 쓰임새(벽·기둥 / 창호 / 빼기) → 미리보기 → 저장(모양 데이터 + 미리보기 그림)
// - 보기: 돌려 보고 확대, 아래 몇 층까지만 보기, 골구도와 연결된 동이면 층마다 공정 색 입히기
import { store, state, q, ui } from './ctx.js';
import { buildingUnits, inkFor } from './model.js';
import { decodeDxf, parseDxf, dxfLayers, guessLayerRole, extractGeometry, packGeometry, UNIT_LABEL } from './dxf.js';
import { $, $$, esc, icon, onAction, onForm, openModal, closeModal, toast, confirmDialog, debounce } from './util.js';

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
const ORBIT_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm';
const SLAB = 0.2; // 슬래브 두께(m)
const SILL = 0.9; // 창 아래 높이
const HEAD = 2.1; // 창 위 높이

let three = null;
async function loadThree() {
  if (!three) {
    three = Promise.all([import(THREE_URL), import(ORBIT_URL)])
      .then(([T, O]) => ({ T, OrbitControls: O.OrbitControls }))
      .catch(() => { three = null; throw new Error('3D 보기 도구를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.'); });
  }
  return three;
}

const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const WALL = () => (dark() ? '#C9CFD8' : '#DCE1E8');

// ---------------------------------------------------------------- 모양 만들기(평면 x·y, 위로 z)

// 선분 → 세운 벽 면(두 삼각형)
function pushWalls(out, segs, z0, z1) {
  for (let k = 0; k < segs.length; k += 4) {
    const [x1, y1, x2, y2] = [segs[k] / 100, segs[k + 1] / 100, segs[k + 2] / 100, segs[k + 3] / 100];
    out.push(x1, y1, z0, x2, y2, z0, x2, y2, z1, x1, y1, z0, x2, y2, z1, x1, y1, z1);
  }
}

// 닫힌 도형 → 기둥처럼 꽉 찬 덩어리(옆면 + 윗면·아랫면)
function pushPrism(T, out, flat, z0, z1) {
  const pts = [];
  for (let k = 0; k < flat.length; k += 2) pts.push(new T.Vector2(flat[k] / 100, flat[k + 1] / 100));
  if (pts.length < 3) return;
  const side = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % pts.length];
    side.push(a.x * 100, a.y * 100, b.x * 100, b.y * 100);
  }
  pushWalls(out, side, z0, z1);
  for (const [i, j, l] of T.ShapeUtils.triangulateShape(pts, [])) {
    for (const z of [z0, z1]) out.push(pts[i].x, pts[i].y, z, pts[j].x, pts[j].y, z, pts[l].x, pts[l].y, z);
  }
}

function bufferGeometry(T, arr) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(arr, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * 모델 장면 묶음. floors층을 층고 h로 쌓는다. colors[f]가 있으면 그 층 벽을 그 색으로.
 * → { group, floors:[{ walls, slab, glass }], size:{w,d,h} }
 */
function buildModel(T, geom, { floors = 1, floorHeight = 2.9, colors = [], roof = true } = {}) {
  const h = floorHeight;
  const wallArr = [];
  pushWalls(wallArr, geom.walls, SLAB, h);
  for (const s of geom.solids) pushPrism(T, wallArr, s, SLAB, h);
  const wallGeo = bufferGeometry(T, wallArr);
  const slabArr = [];
  pushPrism(T, slabArr, geom.floor, 0, SLAB);
  const slabGeo = slabArr.length ? bufferGeometry(T, slabArr) : null;
  const glassArr = [];
  pushWalls(glassArr, geom.glass, SLAB + SILL, SLAB + Math.min(HEAD, h - SLAB - 0.1));
  const glassGeo = glassArr.length ? bufferGeometry(T, glassArr) : null;

  const group = new T.Group();
  group.rotation.x = -Math.PI / 2; // 평면(x·y, 위 z) → 화면(x·z, 위 y)
  const slabMat = new T.MeshStandardMaterial({ color: dark() ? '#8A93A2' : '#B8C0CC', roughness: 0.9 });
  const glassMat = new T.MeshStandardMaterial({ color: '#7FB2F0', transparent: true, opacity: 0.45, side: T.DoubleSide, roughness: 0.2 });
  const list = [];
  for (let f = 0; f < floors; f++) {
    const wallMat = new T.MeshStandardMaterial({ color: colors[f] || WALL(), side: T.DoubleSide, roughness: 0.85 });
    const walls = new T.Mesh(wallGeo, wallMat);
    walls.position.z = f * h;
    group.add(walls);
    const slab = slabGeo ? new T.Mesh(slabGeo, slabMat) : null;
    if (slab) { slab.position.z = f * h; group.add(slab); }
    const glass = glassGeo ? new T.Mesh(glassGeo, glassMat) : null;
    if (glass) { glass.position.z = f * h; group.add(glass); }
    list.push({ walls, slab, glass });
  }
  // 지붕 슬래브(세대 타입은 안을 보도록 없음)
  if (slabGeo && roof) { const top = new T.Mesh(slabGeo, slabMat); top.position.z = floors * h; group.add(top); list.roof = top; }
  return { group, floors: list, size: { w: geom.size[0], d: geom.size[1], h: floors * h + SLAB } };
}

function disposeGroup(group) {
  const seen = new Set();
  group.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    if (o.material && !seen.has(o.material)) { seen.add(o.material); o.material.dispose(); }
  });
}

function lights(T, scene, r) {
  scene.add(new T.HemisphereLight(0xffffff, 0x8899aa, 1.1));
  const sun = new T.DirectionalLight(0xffffff, 1.5);
  sun.position.set(r, r * 2, r * 0.6);
  scene.add(sun);
}

// 모델 전체가 화면에 들어오게 카메라를 놓는다(세로로 긴 휴대폰 화면이면 더 멀리)
function aim(camera, controls, size, mode = 'iso') {
  const r = Math.max(4, Math.hypot(size.w, size.d, size.h) / 2);
  const cy = size.h / 2;
  const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * (camera.aspect < 1 ? Math.min(2.2, 1 / camera.aspect) : 1);
  if (mode === 'top') camera.position.set(0, cy + dist, 0.001);
  else { const k = dist / Math.hypot(1.5, 1, 1.7); camera.position.set(1.5 * k, cy + k, 1.7 * k); }
  camera.near = r / 100;
  camera.far = r * 30;
  camera.updateProjectionMatrix();
  if (controls) { controls.target.set(0, mode === 'top' ? 0 : cy, 0); controls.update(); } else camera.lookAt(0, cy, 0);
}

// 무대(화면 하나): 렌더러·카메라·조작. stop()으로 정리.
async function stage(el, { background } = {}) {
  const { T, OrbitControls } = await loadThree();
  const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  el.append(renderer.domElement);
  const scene = new T.Scene();
  scene.background = new T.Color(background || (dark() ? '#10141c' : '#EEF1F5'));
  const camera = new T.PerspectiveCamera(45, 1, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  let raf = 0;
  let alive = true;
  const fit = () => {
    const w = el.clientWidth || 300;
    const h = el.clientHeight || 200;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(el);
  fit();
  const loop = () => { if (!alive) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
  loop();
  let model = null;
  return {
    T, scene, camera, controls,
    set(m, mode) {
      if (model) { scene.remove(model.group); disposeGroup(model.group); }
      model = m;
      scene.add(m.group);
      if (!scene.userData.lit) { lights(T, scene, Math.max(m.size.w, m.size.d, 10)); scene.userData.lit = true; }
      if (!scene.userData.grid) {
        const s = Math.ceil(Math.max(m.size.w, m.size.d, 10) * 1.6);
        const grid = new T.GridHelper(s, Math.min(60, s), dark() ? 0x3a4250 : 0xc4cbd6, dark() ? 0x252b36 : 0xdde2e9);
        grid.position.y = -0.01;
        scene.add(grid);
        scene.userData.grid = grid;
      }
      if (mode !== false) aim(camera, controls, m.size, mode || 'iso');
    },
    get model() { return model; },
    stop() {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (model) disposeGroup(model.group);
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}

// 저장할 미리보기 그림(640×320 JPG)
async function snapshot(geom, opts) {
  const { T } = await loadThree();
  const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(640, 320, false);
  const scene = new T.Scene();
  scene.background = new T.Color('#E9EDF2');
  const camera = new T.PerspectiveCamera(40, 2, 0.1, 1000);
  const m = buildModel(T, geom, opts);
  scene.add(m.group);
  lights(T, scene, Math.max(m.size.w, m.size.d, 10));
  aim(camera, null, m.size, 'iso');
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/jpeg', 0.8);
  disposeGroup(m.group);
  renderer.dispose();
  renderer.forceContextLoss?.();
  return url;
}

// ---------------------------------------------------------------- 공정 색(골구도와 연결된 동)

// 층마다 가장 많은 세대가 머문 공종 색. 시작 전(0)이 가장 많으면 색 없음.
function floorColors(siteId, model, sheetId) {
  const p = store.progress?.cached(siteId);
  const b = p?.buildings.find((x) => x.id === model.buildingId);
  const sheet = p?.sheets.find((h) => h.id === sheetId);
  if (!b || !sheet) return [];
  const cells = p.cells[sheet.id]?.[b.id] || {};
  const byFloor = {};
  for (const u of buildingUnits(b)) (byFloor[u.floor] ||= []).push(Math.min(cells[u.key]?.step || 0, sheet.trades.length));
  const out = [];
  for (let f = 1; f <= model.floors; f++) {
    const steps = byFloor[f] || [];
    const count = {};
    for (const s of steps) count[s] = (count[s] || 0) + 1;
    const top = Object.entries(count).sort((a, z) => z[1] - a[1] || z[0] - a[0])[0];
    out.push(top && Number(top[0]) > 0 ? sheet.trades[Number(top[0]) - 1].color : null);
  }
  return out;
}

// ---------------------------------------------------------------- 보기(전체 화면)

let view = null; // { el, siteId, model, stage, geom, sheetId, upTo }
let pushed = false;

export async function openModel(siteId, modelId) {
  const s = q.site(siteId);
  const model = (store.models?.cached(siteId) || []).find((m) => m.id === modelId);
  if (!s || !model) return;
  closeModel({ keepHistory: true });
  const el = document.createElement('div');
  el.id = 'model-view';
  el.className = 'mview';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `${model.name} 3D 모델`);
  const linked = model.kind === 'building' && model.buildingId;
  const p = linked ? store.progress?.cached(siteId) : null;
  const sheets = p?.buildings.some((b) => b.id === model.buildingId) ? p.sheets : [];
  el.innerHTML = `<header class="board-head">
      <button type="button" class="icon-btn" data-act="model-close" aria-label="닫기" title="닫기">${icon('close')}</button>
      <div class="board-title"><b>${esc(model.name)}</b><span>${esc(s.name)} · ${model.kind === 'unit' ? '세대 타입' : `${model.floors}층`} · ${esc(String(model.stats?.size?.join(' × ') || ''))}${model.stats?.size ? 'm' : ''}</span></div>
      ${store.can('edit', siteId) ? `<button type="button" class="icon-btn" data-act="model-del" aria-label="이 모델 지우기" title="이 모델 지우기">${icon('trash')}</button>` : ''}
    </header>
    <div class="mview-stage" id="mview-stage"><p class="viewer-msg" id="mview-msg">3D 모델을 불러오는 중…</p></div>
    <div class="mview-bar">
      ${model.floors > 1 ? `<label class="mview-range"><span id="mview-floors">전체 ${model.floors}층</span>
        <input type="range" id="mview-upto" min="1" max="${model.floors}" value="${model.floors}" aria-label="몇 층까지 볼지"></label>` : ''}
      ${sheets.length ? `<label class="mview-sheet"><span>공정 색</span><select id="mview-sheet"><option value="">끄기</option>${sheets.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('')}</select></label>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn sm" data-act="model-aim" data-mode="top">위에서</button>
      <button type="button" class="btn sm" data-act="model-aim" data-mode="iso">비스듬히</button>
    </div>
    <div class="mview-legend" id="mview-legend" hidden></div>
    <footer class="board-foot">도면의 벽·기둥 선을 세운 단순 모델이에요. 끌어서 돌리고, 두 손가락(휠)으로 확대합니다.${linked && !sheets.length ? ' 골구도 공종 시트를 만들면 층마다 공정 색을 볼 수 있어요.' : ''}</footer>`;
  document.body.append(el);
  document.body.classList.add('board-open');
  view = { el, siteId, model, stage: null, geom: null, sheetId: '', upTo: model.floors, returnFocus: document.activeElement };
  if (!pushed) { history.pushState({ baromapModel: true }, ''); pushed = true; }
  el.querySelector('[data-act="model-close"]').focus();
  const v = view;
  try {
    const [geom, st] = await Promise.all([store.models.geometry(model), stage($('#mview-stage'))]);
    if (view !== v) { st.stop(); return; }
    v.geom = geom;
    v.stage = st;
    redraw(true);
    $('#mview-msg')?.remove();
  } catch (err) {
    const m = $('#mview-msg');
    if (m && view === v) m.textContent = err.message;
  }
}

function redraw(first = false) {
  const v = view;
  if (!v?.stage || !v.geom) return;
  const colors = v.sheetId ? floorColors(v.siteId, v.model, v.sheetId) : [];
  v.stage.set(buildModel(v.stage.T, v.geom, { floors: v.model.floors, floorHeight: Number(v.model.floorHeight), colors, roof: v.model.kind !== 'unit' }), first ? 'iso' : false);
  applyUpTo();
  const legend = $('#mview-legend');
  if (!legend) return;
  const sheet = v.sheetId && store.progress?.cached(v.siteId)?.sheets.find((h) => h.id === v.sheetId);
  legend.hidden = !sheet;
  if (sheet) {
    const used = new Set(colors.filter(Boolean));
    legend.innerHTML = sheet.trades.filter((t) => used.has(t.color)).map((t) => `<span style="--c:${t.color};--i:${inkFor(t.color)}"><b>${sheet.trades.indexOf(t) + 1}</b>${esc(t.name)}</span>`).join('')
      || '<span class="muted small">아직 입력된 공정이 없습니다.</span>';
  }
}

function applyUpTo() {
  const v = view;
  const m = v?.stage?.model;
  if (!m) return;
  m.floors.forEach((f, i) => { const on = i < v.upTo; for (const o of [f.walls, f.slab, f.glass]) if (o) o.visible = on; });
  if (m.floors.roof) m.floors.roof.visible = v.upTo === v.model.floors;
  const label = $('#mview-floors');
  if (label) label.textContent = v.upTo === v.model.floors ? `전체 ${v.model.floors}층` : `1~${v.upTo}층`;
}

export function closeModel({ fromHistory = false, keepHistory = false } = {}) {
  if (!view) return;
  const v = view;
  view = null;
  v.stage?.stop();
  v.el.remove();
  document.body.classList.remove('board-open');
  if (keepHistory) return;
  v.returnFocus?.focus?.();
  if (pushed && !fromHistory) history.back();
  pushed = false;
}

window.addEventListener('popstate', () => { if (view) closeModel({ fromHistory: true }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view && !$('#modal')) closeModel(); }, true);
document.addEventListener('input', (e) => {
  if (!view) return;
  if (e.target.id === 'mview-upto') { view.upTo = Number(e.target.value); applyUpTo(); }
});
document.addEventListener('change', (e) => {
  if (view && e.target.id === 'mview-sheet') { view.sheetId = e.target.value; redraw(); }
});

onAction('model-open', (el) => openModel(state.siteId, el.dataset.id));
onAction('model-close', () => closeModel());
onAction('model-aim', (el) => { if (view?.stage?.model) aim(view.stage.camera, view.stage.controls, view.stage.model.size, el.dataset.mode); });
onAction('model-del', async () => {
  const v = view;
  if (!v) return;
  if (!(await confirmDialog(`"${v.model.name}" 3D 모델을 지울까요?\n도면에서 다시 만들 수 있습니다.`, { title: '3D 모델 지우기', ok: '지우기', danger: true }))) return;
  await store.models.remove(v.model.id);
  toast('3D 모델을 지웠습니다.');
  closeModel();
});

// ---------------------------------------------------------------- 만들기(도면 올리기)

let draft = null; // { siteId, dxf, layers, roles, unit, packed, preview }

export function modelDialog(siteId) {
  const s = q.site(siteId);
  if (!s) return;
  const p = store.progress?.cached(siteId);
  const blds = p?.buildings || [];
  draft = { siteId, dxf: null, layers: [], roles: {}, unit: 0, packed: null, preview: null };
  openModal({
    title: '도면으로 3D 만들기',
    wide: true,
    body: `<form id="f-model" data-form="model" novalidate>
      <p class="muted small photo-site">${icon('hardhat')}${esc(s.name)}</p>
      <div class="seg model-kind" role="radiogroup">
        <label><input type="radio" name="kind" value="building" checked><span>동 <small>기준층 평면을 층수만큼 쌓기</small></span></label>
        <label><input type="radio" name="kind" value="unit"><span>세대 타입 <small>한 층(예: 84A)</small></span></label>
      </div>
      <div class="grid2">
        <label class="field"><span>이름 <em>*</em></span><input name="name" maxlength="30" placeholder="예) 101동, 84A 타입" required></label>
        <label class="field kind-b"><span>골구도 동과 연결 <small class="muted">(층수·공정 색)</small></span>
          <select name="buildingId"><option value="">연결 안 함</option>${blds.map((b) => `<option value="${esc(b.id)}" data-top="${Math.max(...b.lines.map((l) => l.to))}">${esc(b.name)} (최고 ${Math.max(...b.lines.map((l) => l.to))}층)</option>`).join('')}</select></label>
        <label class="field kind-b"><span>층수</span><input name="floors" type="number" min="1" max="99" value="15"></label>
        <label class="field"><span>층고(m)</span><input name="floorHeight" type="number" min="2" max="10" step="0.05" value="2.9"></label>
      </div>
      <label class="file-drop">${icon('upload')}<span>도면 파일 선택 (DXF)</span><input type="file" id="dxf-file" accept=".dxf,.dwg"></label>
      <div id="dxf-box"></div>
      <ul class="steps small muted">
        <li>AutoCAD 도면(DWG)은 <b>다른 이름으로 저장 → DXF</b>로 바꿔서 올려주세요.</li>
        <li>동은 <b>기준층 평면도</b>, 세대 타입은 <b>세대 평면도</b>를 올립니다. 벽·기둥 레이어만 남기면 더 깔끔해요.</li>
        <li>도면 원본은 올리지 않고, 3D로 바꾼 모양만 저장합니다.</li>
      </ul>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button>
      <button type="submit" class="btn primary" form="f-model" id="model-submit" disabled>${icon('check')}만들기</button>`,
    onClose: () => { draft?.preview?.stop(); draft = null; },
  });
}

const roleOpts = (v) => [['wall', '벽·기둥'], ['glass', '창호'], ['skip', '빼기']].map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');

function renderDraft() {
  const box = $('#dxf-box');
  if (!box || !draft?.dxf) return;
  const unitSel = [[0, '자동'], [0.001, 'mm'], [0.01, 'cm'], [1, 'm']].map(([u, l]) => `<option value="${u}" ${u === draft.unit ? 'selected' : ''}>${l}</option>`).join('');
  box.innerHTML = `<div class="dxf-head"><b>${esc(draft.fileName)}</b><span class="muted small" id="dxf-stat"></span>
      <label class="dxf-unit"><span>단위</span><select id="dxf-unit">${unitSel}</select></label></div>
    <div class="dxf-grid">
      <div class="dxf-layers"><table class="mini-table"><thead><tr><th>레이어</th><th>선</th><th>쓰임새</th></tr></thead><tbody>
        ${draft.layers.map((l) => `<tr><td>${esc(l.name)}</td><td>${l.n}</td><td><select data-layer="${esc(l.name)}" class="dxf-role">${roleOpts(draft.roles[l.name])}</select></td></tr>`).join('')}
      </tbody></table></div>
      <div class="dxf-preview" id="dxf-preview"></div>
    </div>`;
  rebuild();
}

const rebuild = debounce(async () => {
  if (!draft?.dxf) return;
  const stat = $('#dxf-stat');
  const submit = $('#model-submit');
  try {
    const g = extractGeometry(draft.dxf, draft.roles, draft.unit || undefined);
    draft.packed = packGeometry(g);
    if (!draft.packed.walls.length && !draft.packed.solids.length) throw new Error('벽·기둥으로 고른 레이어에 선이 없습니다.');
    const w = draft.packed.size;
    if (stat) stat.textContent = `${UNIT_LABEL[g.unit] || ''} · 벽 ${draft.packed.walls.length / 4}개 · 기둥 ${draft.packed.solids.length}개 · 창 ${draft.packed.glass.length / 4}개 · ${w[0]} × ${w[1]}m`;
    if (w[0] > 400 || w[1] > 400) stat.textContent += ' · 크기가 너무 큽니다. 단위를 확인하세요';
    submit.disabled = false;
    const el = $('#dxf-preview');
    if (!el) return;
    if (!draft.preview) draft.preview = await stage(el);
    if (!draft?.preview) return;
    const { floors, floorHeight, roof } = formNums();
    draft.preview.set(buildModel(draft.preview.T, draft.packed, { floors, floorHeight, roof }), draft.previewAimed ? false : 'iso');
    draft.previewAimed = true;
  } catch (err) {
    draft.packed = null;
    if (submit) submit.disabled = true;
    if (stat) stat.innerHTML = `<span class="t-warn">${esc(err.message)}</span>`;
  }
}, 150);

function formNums() {
  const f = $('#f-model');
  const unit = f?.querySelector('[name=kind]:checked')?.value === 'unit';
  return {
    floors: unit ? 1 : Math.max(1, Math.min(99, Number(f?.querySelector('[name=floors]').value) || 1)),
    floorHeight: Math.max(2, Math.min(10, Number(f?.querySelector('[name=floorHeight]').value) || 2.9)),
    roof: !unit,
  };
}

document.addEventListener('change', async (e) => {
  if (!draft) return;
  const t = e.target;
  if (t.id === 'dxf-file' && t.files[0]) {
    const file = t.files[0];
    const box = $('#dxf-box');
    draft.preview?.stop();
    Object.assign(draft, { dxf: null, packed: null, preview: null, previewAimed: false, fileName: file.name });
    $('#model-submit').disabled = true;
    if (/\.dwg$/i.test(file.name)) {
      box.innerHTML = `<div class="form-error">${icon('alert')}<span>DWG는 바로 읽을 수 없어요. AutoCAD에서 <b>다른 이름으로 저장 → DXF</b>로 바꿔서 올려주세요.</span></div>`;
      return;
    }
    box.innerHTML = '<p class="muted small loading">도면을 읽는 중…</p>';
    try {
      const dxf = parseDxf(decodeDxf(await file.arrayBuffer()));
      draft.dxf = dxf;
      draft.layers = dxfLayers(dxf);
      if (!draft.layers.length) throw new Error('도면에서 선을 찾지 못했습니다.');
      draft.roles = Object.fromEntries(draft.layers.map((l) => [l.name, guessLayerRole(l.name)]));
      const nameEl = $('#f-model [name=name]');
      if (!nameEl.value) nameEl.value = file.name.replace(/\.dxf$/i, '').slice(0, 30);
      renderDraft();
    } catch (err) {
      box.innerHTML = `<div class="form-error">${icon('alert')}<span>${esc(err.message)}</span></div>`;
    }
    return;
  }
  if (t.classList?.contains('dxf-role')) { draft.roles[t.dataset.layer] = t.value; rebuild(); return; }
  if (t.id === 'dxf-unit') { draft.unit = Number(t.value); draft.previewAimed = false; rebuild(); return; }
  if (t.closest?.('#f-model')) {
    if (t.name === 'kind') $$('#f-model .kind-b').forEach((x) => { x.hidden = t.value === 'unit'; });
    if (t.name === 'buildingId' && t.value) {
      const opt = t.selectedOptions[0];
      $('#f-model [name=floors]').value = opt.dataset.top;
      const nameEl = $('#f-model [name=name]');
      if (!nameEl.value || nameEl.value === (draft.fileName || '').replace(/\.dxf$/i, '').slice(0, 30)) nameEl.value = opt.textContent.replace(/\s*\(최고 \d+층\)$/, '');
    }
    if (['kind', 'floors', 'floorHeight', 'buildingId'].includes(t.name)) { draft.previewAimed = false; rebuild(); }
  }
});

onForm('model', async (data) => {
  if (!draft?.packed) throw new Error('도면을 먼저 골라주세요.');
  const btn = $('#model-submit');
  if (btn) btn.innerHTML = `${icon('check')}만드는 중…`;
  const { floors, floorHeight, roof } = formNums();
  const kind = data.kind === 'unit' ? 'unit' : 'building';
  try {
    const thumb = await snapshot(draft.packed, { floors, floorHeight, roof });
    const saved = await store.models.add({
      siteId: draft.siteId, kind, name: data.name, buildingId: kind === 'building' ? data.buildingId : '', floors, floorHeight, thumb,
      stats: { size: draft.packed.size, walls: draft.packed.walls.length / 4, solids: draft.packed.solids.length, file: draft.fileName.slice(0, 80) },
      geometry: draft.packed,
    });
    const siteId = draft.siteId;
    closeModal(true);
    toast(`${saved.name} 3D 모델을 만들었습니다.`);
    openModel(siteId, saved.id);
  } finally {
    if (btn) btn.innerHTML = `${icon('check')}만들기`;
  }
});

onAction('model-new', () => modelDialog(state.siteId));

// 현장 패널: 3D 모델 목록 받기
const errors = {};
const loading = new Set();
export async function ensureModels(siteId) {
  if (!store.models || loading.has(siteId)) return;
  loading.add(siteId);
  delete errors[siteId];
  try {
    await store.models.list(siteId);
  } catch (err) {
    errors[siteId] = err.message;
    ui.render();
  } finally {
    loading.delete(siteId);
  }
}
export const modelError = (siteId) => errors[siteId];
