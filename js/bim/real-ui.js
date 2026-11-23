// 실물 보기·측정·자세히 보기 화면(22 지시서). 3D 보기(viewer.js)의 갈고리에 붙는다.
//   도구 막대: [실물 보기] 품질·[사진]·[해·그림자], 단지에서 [걷기]·[보기](저장·둘러보기·동영상)
//   정보 패널 탭 [측정]: 동 간 거리 표·경계까지·대지 면적·엑셀, [두 점 재기]
//   외벽 패널 두 번 누르기 → 다가가서 잘라보기(층 구성을 벌려 보기) → 재료 카드
import { store, q } from '../ctx.js';
import { addViewerHook, bimViewerState, viewerRedraw, viewerLabels, viewerSelect, viewerRenderTab, setViewerToolMode } from './viewer.js';
import { addElementAction, addMaterialSection } from './model-panel.js';
import { createReal, takePhoto, autoQuality, QUALITY_LABEL, PHOTO_NOTE } from './render.js';
import { sunPosition, sunVector, kstDate } from './sun.js';
import { buildingDistances, boundaryDistances, measureRows, area, perimeter, pointDistance } from './measure.js';
import { heightAt, baseOf } from './site-detail.js';
import { textureFor } from './pbr.js';
import { exportGlb } from './export-gltf.js';
import { $, esc, icon, toast, download } from '../util.js';
import { xlsx } from '../excel-ui.js';

const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const mobile = () => matchMedia('(max-width: 760px), (pointer: coarse)').matches;
const EYE = 1.6;
const ui = { day: today(), hour: 14, measure: null, picks: [], walk: null, viewsOpen: false, sunOpen: false, cut: null };

// ---------------------------------------------------------------- 실물 보기

async function realOf(v) {
  if (!v.real) v.real = await createReal(v.stage);
  return v.real;
}

function applySun(v) {
  if (!v.real) return;
  const site = q.site(v.siteId);
  const pos = sunPosition(kstDate(ui.day, ui.hour), site?.lat ?? 37.5, site?.lng ?? 127);
  v.real.setSun(sunVector(pos, v.ctx?.site?.northDeg || 0));
  ui.sunText = `해 높이 ${Math.round(pos.altitude)}° · 방위 ${Math.round(pos.azimuth)}°`;
}

async function toggleReal(v) {
  try {
    const r = await realOf(v);
    if (r.on) { r.disable(); v.opts.real = false; } else {
      r.enable(v.opts.quality === 'auto' || !v.opts.quality ? 'normal' : v.opts.quality);
      v.opts.real = true;
      applySun(v);
      if (!v.opts.quality || v.opts.quality === 'auto') {
        v.opts.quality = 'auto';
        setTimeout(() => { // 2초 동안 재고 고른다
          if (!v.real?.on || v.opts.quality !== 'auto') return;
          const fps = Number(v.stage.renderer.domElement.parentElement?.dataset.fps || 60);
          v.real.setQuality(autoQuality(fps, mobile()));
          viewerRedraw();
        }, 2200);
      }
    }
    viewerRedraw();
  } catch (err) { toast(`실물 보기를 켜지 못했습니다: ${err.message}`, 'crit'); }
}

addViewerHook('bar', (v) => {
  const c = v.ctx;
  const on = v.real?.on;
  const out = [`<button type="button" class="btn sm ${on ? 'on' : ''}" data-real="toggle" aria-pressed="${Boolean(on)}">${icon('camera')}실물 보기</button>`];
  if (on) {
    out.push(`<select id="bv-quality" aria-label="화질">${['auto', 'fast', 'normal', 'good'].map((k) => `<option value="${k}" ${(v.opts.quality || 'auto') === k ? 'selected' : ''}>${QUALITY_LABEL[k]}${k === 'auto' && v.opts.quality === 'auto' ? `(${QUALITY_LABEL[v.real.quality]})` : ''}</option>`).join('')}</select>`);
    out.push(`<details class="bv-pop" ${ui.sunOpen ? 'open' : ''} data-real-pop="sun"><summary class="btn sm">${icon('clock')}해·그림자</summary><div class="bv-pop-body bv-sun">
      <label class="field"><span>날짜</span><input type="date" id="bv-sun-day" value="${esc(ui.day)}"></label>
      <label class="field"><span>시각 <b id="bv-sun-time">${fmtHour(ui.hour)}</b></span><input type="range" id="bv-sun-hour" min="5" max="20" step="0.25" value="${ui.hour}"></label>
      <label class="check"><input type="checkbox" id="bv-overcast" ${v.real.overcast ? 'checked' : ''}><span>흐린 날</span></label>
      <p class="muted small" id="bv-sun-text">${esc(ui.sunText || '')}</p>
      <p class="muted small">시공 계획 참고용입니다. 일조권 판단 도구가 아닙니다.</p></div></details>`);
    out.push(`<button type="button" class="btn sm" data-real="photo">${icon('download')}사진으로 저장</button>`);
  }
  // glTF 내보내기: 운영자·현장 담당(17 지시서 6절)
  if (store.can('edit', v.siteId) && c?.level) out.push(`<button type="button" class="btn sm ghost" data-real="glb" title="블렌더·라이노 등에서 여는 3D 파일(.glb)">${icon('cube')}glTF 내보내기</button>`);
  if (c?.level === 'site') {
    out.push(`<button type="button" class="btn sm ${ui.walk ? 'on' : ''}" data-real="walk" aria-pressed="${Boolean(ui.walk)}">${icon('walk')}걷기</button>`);
    const views = v.model?.stats?.views || [];
    out.push(`<details class="bv-pop" ${ui.viewsOpen ? 'open' : ''} data-real-pop="views"><summary class="btn sm">${icon('target')}보기 ${views.length || ''}</summary><div class="bv-pop-body bv-views">
      ${views.map((w, i) => `<button type="button" class="link" data-real="view" data-i="${i}">${esc(w.name)}</button>`).join('') || '<span class="muted small">저장한 보기가 없습니다.</span>'}
      ${store.can('edit', v.siteId) ? `<div class="row"><input id="bv-view-name" placeholder="예) 조감" maxlength="30" aria-label="보기 이름"><button type="button" class="btn sm" data-real="view-save">${icon('plus')}저장</button></div>` : ''}
      ${views.length > 1 ? `<button type="button" class="btn sm" data-real="tour">${icon('route')}이어서 둘러보기</button>${typeof MediaRecorder !== 'undefined' ? `<button type="button" class="btn sm ghost" data-real="tour-rec">${icon('download')}동영상으로 저장</button>` : ''}` : ''}
    </div></details>`);
  }
  return out.join('');
});
const fmtHour = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- 걷기(사람 눈높이, 지형을 따른다)

function walkStart(v) {
  const { camera, controls, T } = v.stage;
  const site = v.ctx.site;
  const base = baseOf(site.terrain);
  const ground = (x, y) => (heightAt(site.terrain, x, y) ?? base) - base;
  const b = site.boundary?.length ? site.boundary : [[0, 0]];
  const ys = b.map((p) => p[1]);
  const pos = { x: 0, y: Math.min(...ys) + 10, yaw: 0, pitch: 0 };
  const keys = new Set();
  const joy = { x: 0, y: 0 };
  controls.enabled = false;
  const el = document.createElement('div');
  el.className = 'bv-joy';
  el.innerHTML = '<i></i>';
  v.el.querySelector('#bv-stage').append(el);
  const knob = el.firstChild;
  const onJoy = (e) => {
    const r = el.getBoundingClientRect();
    const dx = Math.max(-1, Math.min(1, (e.clientX - r.left - r.width / 2) / (r.width / 2)));
    const dy = Math.max(-1, Math.min(1, (e.clientY - r.top - r.height / 2) / (r.height / 2)));
    Object.assign(joy, { x: dx, y: dy });
    knob.style.transform = `translate(${dx * 28}px, ${dy * 28}px)`;
  };
  const endJoy = () => { Object.assign(joy, { x: 0, y: 0 }); knob.style.transform = ''; };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); onJoy(e); });
  el.addEventListener('pointermove', (e) => { if (e.buttons) onJoy(e); });
  el.addEventListener('pointerup', endJoy);
  el.addEventListener('pointercancel', endJoy);
  const dom = v.stage.renderer.domElement;
  let drag = null;
  const down = (e) => { if (e.target === dom) drag = { x: e.clientX, y: e.clientY }; };
  const move = (e) => { if (!drag || !e.buttons) return; pos.yaw -= (e.clientX - drag.x) * 0.004; pos.pitch = Math.max(-0.9, Math.min(0.9, pos.pitch - (e.clientY - drag.y) * 0.004)); drag = { x: e.clientX, y: e.clientY }; };
  const up = () => { drag = null; };
  const kd = (e) => { if (/^(Arrow|Key[WASDQE])/.test(e.code) && !e.target.closest('input,select,textarea')) { keys.add(e.code); e.preventDefault(); } if (e.key === 'Escape') walkStop(v); };
  const ku = (e) => keys.delete(e.code);
  dom.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - joy.y;
    const turn = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - joy.x;
    pos.yaw += turn * dt * 1.4;
    pos.pitch = Math.max(-0.9, Math.min(0.9, pos.pitch + ((keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0)) * dt));
    const speed = 4.2; // m/s(빠른 걸음)
    pos.x += -Math.sin(pos.yaw) * fwd * speed * dt;
    pos.y += Math.cos(pos.yaw) * fwd * speed * dt;
    const z = ground(pos.x, pos.y) + EYE;
    camera.position.set(pos.x, z, -pos.y);
    const look = new T.Vector3(pos.x - Math.sin(pos.yaw) * Math.cos(pos.pitch), z + Math.sin(pos.pitch), -(pos.y + Math.cos(pos.yaw) * Math.cos(pos.pitch)));
    controls.target.copy(look);
    camera.lookAt(look);
  };
  v.stage.ticks.add(tick);
  camera.near = 0.1;
  camera.updateProjectionMatrix();
  ui.walk = { stop() { v.stage.ticks.delete(tick); el.remove(); dom.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); controls.enabled = true; }, pos };
  toast(mobile() ? '왼쪽 아래 동그라미를 끌어서 걸어요.' : '방향키(또는 W·A·S·D)로 걷고, 끌어서 둘러봐요. Esc로 끝냅니다.');
}
function walkStop(v) { ui.walk?.stop(); ui.walk = null; setViewerToolMode(ui.pickOn); viewerRedraw(); }

// ---------------------------------------------------------------- 보기 저장·둘러보기·동영상

const camNow = (v) => { const { camera, controls } = v.stage; return { pos: camera.position.toArray().map((x) => Math.round(x * 100) / 100), target: controls.target.toArray().map((x) => Math.round(x * 100) / 100) }; };
function flyTo(v, cam, ms = 2200) {
  const { camera, controls, T } = v.stage;
  const p0 = camera.position.clone();
  const c0 = controls.target.clone();
  const p1 = new T.Vector3(...cam.pos);
  const c1 = new T.Vector3(...cam.target);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      camera.position.lerpVectors(p0, p1, e);
      controls.target.lerpVectors(c0, c1, e);
      if (k >= 1) { v.stage.ticks.delete(tick); resolve(); }
    };
    v.stage.ticks.add(tick);
  });
}
async function tour(v, record = false) {
  const views = v.model?.stats?.views || [];
  if (views.length < 2) return;
  let rec = null;
  const chunks = [];
  if (record) {
    const stream = v.stage.renderer.domElement.captureStream(30);
    rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start();
  }
  await flyTo(v, views[0].camera, 300);
  for (const w of views.slice(1)) await flyTo(v, w.camera, 2600);
  if (rec) {
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    download(`바로맵_둘러보기_v${v.model.version}.webm`, new Blob(chunks, { type: 'video/webm' }));
  }
}

// ---------------------------------------------------------------- 측정

const LINE = '#E8590C';
function overlay(v) {
  const { T, root } = v.stage;
  if (v.measureGroup) { root.remove(v.measureGroup); v.measureGroup.traverse((o) => o.geometry?.dispose()); }
  const g = new T.Group();
  const labels = [];
  const site = v.ctx?.site;
  if (v.ctx?.level === 'site' && site && ui.measure) {
    const base = baseOf(site.terrain);
    const z = (x, y) => (heightAt(site.terrain, x, y) ?? base) - base + 1.2;
    const seg = (p, q, text) => {
      g.add(new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(p[0], p[1], z(...p)), new T.Vector3(q[0], q[1], z(...q))]), new T.LineBasicMaterial({ color: LINE, depthTest: false })));
      labels.push({ text, pos: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, z((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) + 1], cls: 'dim' });
    };
    if (ui.measure.pair) seg(ui.measure.pair.p, ui.measure.pair.q, `${ui.measure.pair.minM.toFixed(2)}m`);
    else for (const r of buildingDistances(site).slice(0, 6)) seg(r.p, r.q, `${r.minM.toFixed(1)}m`);
  }
  if (ui.picks.length) {
    const pts = ui.picks.map((p) => new T.Vector3(...p));
    for (const p of pts) { const m = new T.Mesh(new T.SphereGeometry(0.25, 10, 8), new T.MeshBasicMaterial({ color: LINE, depthTest: false })); m.position.copy(p); m.renderOrder = 20; g.add(m); }
    if (pts.length === 2) {
      g.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: LINE, depthTest: false })));
      const [a, b] = ui.picks;
      labels.push({ text: `${pointDistance(a, b).toFixed(2)}m`, pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + 0.6], cls: 'dim' });
    }
  }
  g.renderOrder = 20;
  root.add(g);
  v.measureGroup = g;
  viewerLabels(labels);
}

// 두 점 재기: 누른 곳의 가장 가까운 꼭짓점(0.5m 안)에 붙인다
function pickPoint(v, e) {
  const { T, camera, root } = v.stage;
  const dom = v.stage.renderer.domElement;
  const r = dom.getBoundingClientRect();
  const ray = new T.Raycaster();
  ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObject(v.scene.group, true).find((h) => h.object.isMesh && h.face);
  if (!hit) return null;
  let best = hit.point.clone();
  const pos = hit.object.geometry.attributes.position;
  if (pos && !hit.object.isInstancedMesh) {
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const w = new T.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
      if (w.distanceTo(hit.point) < 0.5 && w.distanceTo(hit.point) < best.distanceTo(hit.point) + 0.5) best = w;
    }
  }
  const m = root.worldToLocal(best.clone());
  return [m.x, m.y, m.z].map((x) => Math.round(x * 1000) / 1000);
}

addViewerHook('tabs', {
  key: 'measure',
  title: '측정',
  render(el, v) {
    const c = v.ctx;
    if (c?.level !== 'site') { el.innerHTML = '<div class="bv-el"><p class="muted small">동 간 거리·경계까지 거리는 단지 화면에서 봅니다. 두 점 재기는 어디서나 됩니다.</p>' + pickHtml() + '</div>'; return; }
    ui.measure ||= {};
    const rows = buildingDistances(c.site);
    const bounds = boundaryDistances(c.site);
    const b = c.site.boundary || [];
    el.innerHTML = `<div class="bv-el">
      <h4>동 간 거리 <small class="muted">모델 좌표로 계산</small></h4>
      <table class="bv-meas"><thead><tr><th>동</th><th>최단</th><th>마주 봄</th><th>높이</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.low ? 'low' : ''} ${ui.measure.i === i ? 'sel' : ''}" data-meas="${i}"><td>${esc(r.nameA)}·${esc(r.nameB)}</td><td>${r.minM.toFixed(2)}m</td><td>${r.facingM != null ? `${r.facingM.toFixed(2)}m` : '-'}</td><td>${r.heightA.toFixed(1)} / ${r.heightB.toFixed(1)}m</td></tr>`).join('')}
      </tbody></table>
      <h4>경계·도로까지</h4>
      <table class="bv-meas"><thead><tr><th>동</th><th>대지 경계</th><th>도로</th></tr></thead><tbody>
      ${bounds.map((r) => `<tr class="${r.low ? 'low' : ''}"><td>${esc(r.name)}</td><td>${r.boundaryM != null ? `${r.boundaryM.toFixed(2)}m` : '-'}</td><td>${r.roadM != null ? `${r.roadM.toFixed(2)}m` : '-'}</td></tr>`).join('')}
      </tbody></table>
      ${b.length > 2 ? `<p class="small">대지 면적 ${Math.round(area(b)).toLocaleString()}㎡ · 둘레 ${perimeter(b).toFixed(1)}m</p>` : ''}
      <p class="muted small">노란 줄은 배치도에서 못 읽어 가정한 값이 섞인 것입니다. 법정 간격 적합 여부는 판단하지 않습니다.</p>
      <div class="bv-acts"><button type="button" class="btn sm" data-real="meas-xlsx">${icon('download')}엑셀로 받기</button></div>
      ${pickHtml()}</div>`;
  },
});
const pickHtml = () => `<h4>두 점 재기</h4><div class="bv-acts"><button type="button" class="btn sm ${ui.pickOn ? 'on' : ''}" data-real="pick" aria-pressed="${Boolean(ui.pickOn)}">${icon('route')}${ui.pickOn ? '재는 중(두 곳을 누르세요)' : '두 점 재기'}</button>${ui.picks.length ? `<button type="button" class="link small" data-real="pick-clear">지우기</button>` : ''}</div>
  ${ui.picks.length === 2 ? `<p class="small" id="bv-pick-out">거리 <b>${pointDistance(ui.picks[0], ui.picks[1]).toFixed(2)}m</b> · 수평 ${Math.hypot(ui.picks[1][0] - ui.picks[0][0], ui.picks[1][1] - ui.picks[0][1]).toFixed(2)}m · 높이 차 ${Math.abs(ui.picks[1][2] - ui.picks[0][2]).toFixed(2)}m</p>` : ''}`;

// ---------------------------------------------------------------- 외벽 패널: 잘라보기와 재료 카드

function wallAssembly(ctx, panel) {
  const cat = ctx.catalog;
  const z = ctx.building.facade.zones.find((x) => x.id === panel.zoneId);
  // 외벽 조립체: 동의 바깥 벽에서 가장 많이 쓰인 것
  const count = new Map();
  for (const t of ctx.types.values()) for (const w of t.walls || []) if (w.exterior && w.assemblyId) count.set(w.assemblyId, (count.get(w.assemblyId) || 0) + 1);
  for (const t of ctx.building.floorTemplates) for (const w of t.walls || []) if (w.exterior && w.assemblyId) count.set(w.assemblyId, (count.get(w.assemblyId) || 0) + 1);
  const asm = cat.assemblies.find((a) => a.id === [...count].sort((a, b) => b[1] - a[1])[0]?.[0]);
  const mats = new Map(cat.materials.map((m) => [m.id, m]));
  const layers = (asm?.layers || []).map((l) => ({ ...l, m: mats.get(l.materialId) }));
  const outer = mats.get(z?.materialId);
  // 바깥 마감은 입면 구획의 재료(벽체 상세의 바깥 층과 다르면 맨 바깥에 더한다)
  if (outer && !layers.some((l) => l.materialId === outer.id)) layers.unshift({ materialId: outer.id, m: outer, thicknessMm: null, side: 'out', zone: true });
  return { asm, layers, zone: z };
}

addElementAction((ctx, el) => {
  if (Array.isArray(el) || el.kind !== 'panel') return '';
  const v = bimViewerState();
  const { asm, layers } = wallAssembly(ctx, el.obj);
  ui.cardLayers = layers;
  return `<div class="bv-cut"><h4>층 구성(바깥 → 안)${asm ? ` <small class="muted">${esc(asm.name)}</small>` : ''}</h4>
    <ol class="bv-cut-list">${layers.map((l) => `<li><i class="sw" style="background:${esc(l.m?.color || '#ccc')}"></i>${esc(l.m?.name || l.materialId)}${l.thicknessMm ? ` <span class="muted">${l.thicknessMm}mm</span>` : l.zone ? ' <span class="muted">입면 마감</span>' : ''}</li>`).join('')}</ol>
    <button type="button" class="btn sm ${v?.cutaway === el.obj.id ? 'on' : ''}" data-real="cut" data-id="${esc(el.obj.id)}">${icon('cut')}${v?.cutaway === el.obj.id ? '잘라보기 끄기' : '잘라보기'}</button></div>`;
});

// 재료 카드 틀: 수량은 takeoff-ui.js(23 지시서), 공종·업체·시공 기준·단가는 24 지시서가 칸을 붙인다

function cutaway(v, panelId) {
  const { T, root } = v.stage;
  if (v.cutGroup) { root.remove(v.cutGroup); v.cutGroup.traverse((o) => o.geometry?.dispose()); v.cutGroup = null; }
  if (!panelId || v.cutaway === panelId) { v.cutaway = null; viewerLabels([]); return; }
  const ctx = v.ctx;
  const p = ctx.building.facade.panels.find((x) => x.id === panelId);
  if (!p) return;
  v.cutaway = panelId;
  const { layers } = wallAssembly(ctx, p);
  const [a, b] = p.path;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const n = [u[1], -u[0]];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const zc = Math.min(p.z1, p.z0 + 4);
  const g = new T.Group();
  const labels = [];
  let off = 1.2;
  layers.forEach((l, i) => {
    const t = Math.max(0.03, (l.thicknessMm || 10) / 1000);
    const geo = new T.BoxGeometry(1.6, t, 1.6);
    const mat = v.mats.real ? v.real.pbr.get(textureFor(l.m) || 'paint', l.m?.color) : new T.MeshStandardMaterial({ color: l.m?.color || '#ccc', roughness: 0.8 });
    const mesh = new T.Mesh(geo, mat);
    const d = off + i * 0.45;
    mesh.position.set(mid[0] + n[0] * d, mid[1] + n[1] * d, zc);
    mesh.rotation.z = Math.atan2(u[1], u[0]);
    g.add(mesh);
    labels.push({ text: `${i + 1}. ${l.m?.name || ''}${l.thicknessMm ? ` ${l.thicknessMm}mm` : ''}`, pos: [mesh.position.x, mesh.position.y, zc + 1], cls: 'dim' });
  });
  root.add(g);
  v.cutGroup = g;
  viewerLabels(labels);
  // 다가가기
  const eye = [mid[0] + n[0] * 9 + u[0] * 5, mid[1] + n[1] * 9 + u[1] * 5, zc + 2.5];
  flyTo(v, { pos: [eye[0], eye[2], -eye[1]], target: [mid[0] + n[0] * 1.5, zc, -(mid[1] + n[1] * 1.5)] }, 900);
}

addViewerHook('drill', (v, id) => {
  if (!String(id).startsWith('fp_') || v.ctx?.level !== 'building') return false;
  viewerSelect([id]);
  cutaway(v, id);
  return true;
});
addViewerHook('scene', (v) => {
  if (v.ctx?.level !== 'building' && v.cutGroup) { v.stage.root.remove(v.cutGroup); v.cutGroup = null; v.cutaway = null; }
  if (ui.measure || ui.picks.length) overlay(v);
  if (ui.walk && v.ctx?.level !== 'site') walkStop(v);
});

// ---------------------------------------------------------------- 단추

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-real],[data-meas]');
  const v = bimViewerState();
  if (!t || !v?.stage || !v.el.contains(t)) return;
  const d = t.dataset;
  try {
    if (d.meas != null) {
      const rows = buildingDistances(v.ctx.site);
      ui.measure = { i: Number(d.meas), pair: rows[Number(d.meas)] };
      overlay(v);
      v.el.querySelectorAll('[data-meas]').forEach((x) => x.classList.toggle('sel', x === t));
      return;
    }
    if (d.real === 'toggle') await toggleReal(v);
    else if (d.real === 'photo') {
      toast('사진을 만드는 중입니다…');
      const blob = await takePhoto(v.stage, v.real, { maxSide: mobile() ? 2048 : 4096, label: `모델 v${v.model.version} · ${ui.day} ${fmtHour(ui.hour)}` });
      v.lastPhoto = blob;
      download(`바로맵_렌더_v${v.model.version}.png`, blob);
      toast('사진을 저장했습니다(렌더·참고용 표기 포함).');
    } else if (d.real === 'walk') { if (ui.walk) walkStop(v); else { walkStart(v); viewerRedraw(); } setViewerToolMode(Boolean(ui.walk) || ui.pickOn); }
    else if (d.real === 'view') { const w = v.model.stats.views[Number(d.i)]; await flyTo(v, w.camera, 900); }
    else if (d.real === 'view-save') {
      const name = ($('#bv-view-name')?.value || '').trim() || `보기 ${(v.model.stats?.views || []).length + 1}`;
      const views = [...(v.model.stats?.views || []).filter((x) => x.name !== name), { name, camera: camNow(v) }].slice(-20);
      v.model = await store.bim.saveViews(v.model.id, views);
      ui.viewsOpen = true;
      viewerRedraw();
      toast(`보기 "${name}"을(를) 저장했습니다.`);
    } else if (d.real === 'tour') await tour(v);
    else if (d.real === 'tour-rec') { toast('둘러보기를 동영상으로 담는 중입니다…'); await tour(v, true); }
    else if (d.real === 'meas-xlsx') {
      const X = await xlsx();
      const t2 = measureRows(v.ctx.site);
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(t2.distances), '동 간 거리');
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(t2.boundaries), '경계까지');
      X.writeFile(wb, `바로맵_측정_v${v.model.version}.xlsx`);
    } else if (d.real === 'pick') { ui.pickOn = !ui.pickOn; if (ui.pickOn) ui.picks = []; setViewerToolMode(Boolean(ui.walk) || ui.pickOn); refreshTab(v); }
    else if (d.real === 'pick-clear') { ui.picks = []; overlay(v); refreshTab(v); }
    else if (d.real === 'cut') cutaway(v, d.id);
    else if (d.real === 'glb') {
      toast('3D 파일을 만드는 중입니다…');
      const scope = v.ctx.level === 'site' ? 'site' : v.ctx.level === 'building' ? 'building' : 'unit';
      const blob = await exportGlb(v.stage.T, { scope, ctx: v.ctx });
      v.lastGlb = blob;
      const name = scope === 'site' ? '단지' : scope === 'building' ? v.ctx.building.name : v.ctx.type.name;
      download(`바로맵_${name}_v${v.model.version}.glb`, blob);
      toast(`${name} 3D 파일(.glb, ${(blob.size / 1048576).toFixed(1)}MB)을 저장했습니다.`);
    }
  } catch (err) { toast(err.message, 'crit'); }
});
const refreshTab = () => viewerRenderTab();

document.addEventListener('pointerup', (e) => {
  const v = bimViewerState();
  if (!ui.pickOn || !v?.stage || e.target !== v.stage.renderer.domElement) return;
  const p = pickPoint(v, e);
  if (!p) return;
  ui.picks = ui.picks.length >= 2 ? [p] : [...ui.picks, p];
  overlay(v);
  refreshTab(v);
}, true);

document.addEventListener('change', (e) => {
  const v = bimViewerState();
  if (!v?.stage || !v.el.contains(e.target)) return;
  const t = e.target;
  if (t.id === 'bv-quality') { v.opts.quality = t.value; v.real.setQuality(t.value === 'auto' ? autoQuality(Number(v.stage.renderer.domElement.parentElement?.dataset.fps || 60), mobile()) : t.value); viewerRedraw(); }
  else if (t.id === 'bv-sun-day') { ui.day = t.value || today(); applySun(v); $('#bv-sun-text').textContent = ui.sunText; }
  else if (t.id === 'bv-overcast') v.real.setOvercast(t.checked);
});
document.addEventListener('input', (e) => {
  const v = bimViewerState();
  if (!v?.stage || e.target.id !== 'bv-sun-hour') return;
  ui.hour = Number(e.target.value);
  $('#bv-sun-time').textContent = fmtHour(ui.hour);
  applySun(v);
  $('#bv-sun-text').textContent = ui.sunText;
});
document.addEventListener('toggle', (e) => {
  const p = e.target?.dataset?.realPop;
  if (p === 'sun') ui.sunOpen = e.target.open;
  if (p === 'views') ui.viewsOpen = e.target.open;
}, true);

export { PHOTO_NOTE };
