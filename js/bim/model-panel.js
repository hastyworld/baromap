// 요소 정보 패널(06 6절): 종류·이름·치수·조립체 층 구성 표·근거 도면 조각·판독 방법과 신뢰도·관련 검증 결과.
// 아무것도 고르지 않았으면 장면 개요와 목록(동·타입·실)을 보여 이동 단추로 쓴다. 화면 그리기는 viewer.js가 한다.
import { wallLayers, finishResolver } from './mesh-calc.js';
import { CATEGORY_LABEL } from './materials-ko.js';
import { ZONE_LABEL } from './materials-3d.js';
import { KIND_LABEL } from './checks.js';
import { SIDE_LABEL } from './facade.js';
import { esc, icon } from '../util.js';

export const METHOD_LABEL = { rule: '규칙 판독', ai: 'AI 판독', assumed: '추정(기본값)', manual: '직접 입력', doc: '문서 판독' };
export const USE_LABEL = { living: '거실', bedroom: '침실', kitchen: '주방', bath: '욕실', balcony: '발코니', dress: '드레스룸', utility: '다용도실', hall: '현관·복도', other: '기타' };
const OPENING_LABEL = { door: '문', window: '창', opening: '개구부' };
const SEV_LABEL = { error: '오류', warn: '경고', info: '정보' };
const GAS_KO = { argon: '아르곤', krypton: '크립톤' };
const LOW = 0.6;

const actions = []; // 07(직접 고치기·수정 요청)이 단추를 붙인다: (ctx, el | els[]) => html
export const addElementAction = (fn) => actions.push(fn);
const overview = []; // 07: 아무것도 고르지 않았을 때 장면 개요 아래(층 고치기 등): (ctx) => html
export const addOverviewAction = (fn) => overview.push(fn);
const materialSections = []; // 재료 카드에 붙는 칸(22 지시서 6절: 공종·업체·시공 기준·단가·수량은 23·24 지시서): (ctx, material) => html
export const addMaterialSection = (fn) => materialSections.push(fn);

const m2 = (poly) => { let a = 0; for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2); };
const mm = (m) => `${Math.round(m * 1000).toLocaleString()}`;
const row = (k, v) => (v == null || v === '' ? '' : `<tr><th>${esc(k)}</th><td>${v}</td></tr>`);

/** 장면(ctx)에서 id로 요소 찾기 → { kind, obj } */
export function findElement(ctx, id) {
  if (ctx.level === 'site') {
    const b = ctx.site.buildings.find((x) => x.id === id);
    return b ? { kind: 'building', obj: b } : null;
  }
  if (ctx.level === 'building') {
    const p = ctx.building.facade?.panels?.find((x) => x.id === id);
    if (p) return { kind: 'panel', obj: p };
    const u = ctx.building.units.find((x) => x.id === id);
    if (u) return { kind: 'unit', obj: u };
    for (const t of ctx.building.floorTemplates) { const f = t.units.find((x) => x.id === id); if (f) return { kind: 'facility', obj: f }; }
    return null;
  }
  const t = ctx.type;
  for (const [kind, list] of [['wall', t.walls], ['opening', t.openings], ['space', t.spaces], ['column', t.columns || []]]) {
    const o = list.find((x) => x.id === id);
    if (o) return { kind, obj: o };
  }
  return null;
}

function sourceHtml(src, ctx) {
  if (!src) return '';
  const conf = src.confidence ?? null;
  const low = conf != null && conf < LOW;
  const sheets = (src.sheets || []).map((s) => ({ ...s, sheet: ctx.sheets.find((x) => x.id === s.sheetId) })).filter((s) => s.sheet);
  const crop = sheets[0];
  return `<div class="bv-src">
    <p class="small"><span class="badge ${low ? 'warn' : 'info'}">${esc(METHOD_LABEL[src.method] || src.method || '')}</span>
      ${conf != null ? `<span class="${low ? 't-warn' : 'muted'}">신뢰도 ${Math.round(conf * 100)}%${low ? ' · 확인 필요' : ''}</span>` : ''}
      ${sheets.length ? `<span class="muted">· 근거 ${sheets.map((s) => esc(s.sheet.sheetNo || s.sheetNo || '도면')).join(', ')}</span>` : ''}</p>
    ${crop ? `<button type="button" class="bv-crop" data-bv-sheet="${esc(crop.sheetId)}" data-bbox="${esc(crop.bbox ? JSON.stringify(crop.bbox) : '')}" title="도면 크게 보기">
      <canvas data-bv-crop="${esc(crop.sheetId)}" data-bbox="${esc(crop.bbox ? JSON.stringify(crop.bbox) : '')}" width="300" height="160"></canvas>
      <span>${icon('expand')}${esc(crop.sheet.sheetNo || '')} ${esc(crop.sheet.title || '')} 크게 보기</span></button>` : (src.method === 'assumed' ? '<p class="muted small">도면에서 찾지 못해 기본값으로 넣었습니다.</p>' : '')}
  </div>`;
}

// 문서 근거 단추(20 지시서 7절)
const docLinks = (src) => (src?.docs || []).slice(0, 3).map((d) => `<button type="button" class="btn sm ghost" data-act="doc-open" data-id="${esc(d.docId)}" data-page="${esc(d.page ?? 1)}">${icon('file')}${esc(d.docName || '근거 문서')}${d.page ? ` ${esc(d.page)}쪽` : ''}</button>`).join('');

// 창호 카드: 유리 구성과 성능. 값이 없는 칸은 보이지 않는다
function windowCard(w) {
  const p = w.perf || {};
  const air = p.airtight || {};
  const panes = (w.glass?.panes || []).map((x) => (x.gapMm != null ? `공기층 ${x.gapMm}mm${x.gas && x.gas !== 'air' ? `(${GAS_KO[x.gas] || x.gas})` : ''}` : `유리 ${x.mm}mm${x.kind ? ` ${esc(x.kind)}` : ''}`));
  const rows2 = row('적용 타입', esc((w.appliesTo?.unitTypes || []).join(', '))) + row('규격', w.sizeMm ? `${w.sizeMm.w.toLocaleString()} × ${w.sizeMm.h.toLocaleString()}mm` : '') + row('창틀', esc([w.frame?.material, w.frame?.opening].filter(Boolean).join(' · '))) + row('제조사', esc(w.frame?.maker || ''))
    + row('유리', esc(w.glass?.notation || '')) + row('열관류율(창세트)', p.uWindow != null ? `${p.uWindow} W/㎡K` : '') + row('열관류율(유리)', p.uGlass != null ? `${p.uGlass} W/㎡K` : '') + row('태양열취득률', p.shgc ?? '')
    + row('기밀성', [air.value != null ? `${air.value} ${esc(air.unit || '')}` : '', air.grade ? `${esc(air.grade)}등급` : ''].filter(Boolean).join(' · ')) + row('수밀성', esc(p.watertight || '')) + row('내풍압', esc(p.windPressure || '')) + row('차음', esc(p.sound || ''))
    + row('효율 등급', p.efficiencyGrade ? `${esc(p.efficiencyGrade)}등급` : '') + row('방화', esc(p.fire || '')) + row('인증번호', esc(p.certNo || ''));
  return `<h4>창호 성능</h4><table class="bv-props">${rows2}</table>${panes.length ? `<p class="small muted">유리 구성: ${panes.join(' + ')}</p>` : ''}${docLinks(w.source) ? `<div class="bv-acts">${docLinks(w.source)}</div>` : ''}`;
}

// 재료 카드: 규격·제조사·성능 목록
function materialCards(list, ctx = null) {
  const shown = [...new Map(list.filter((m) => m && (m.spec || m.maker || m.perf?.length || materialSections.length)).map((m) => [m.id, m])).values()];
  if (!shown.length) return '';
  return `<h4>재료</h4>${shown.map((m) => `<div class="bv-mat"><p class="small"><i class="sw" style="background:${esc(m.color || '#ccc')}"></i><b>${esc(m.name)}</b>${m.spec ? ` ${esc(m.spec)}` : ''}${m.maker ? ` <span class="muted">${esc(m.maker)}</span>` : ''}</p>
    ${m.perf?.length ? `<ul class="bv-perf">${m.perf.map((p) => `<li>${esc(p.label)} <b>${esc(p.value ?? '-')}</b>${p.unit ? ` ${esc(p.unit)}` : ''}${p.standard ? ` <span class="muted">${esc(p.standard)}</span>` : ''}</li>`).join('')}</ul>` : ''}${docLinks(m.source) ? `<div class="bv-acts">${docLinks(m.source)}</div>` : ''}${materialSections.map((fn) => fn(ctx, m)).join('')}</div>`).join('')}`;
}

function findingsHtml(ctx, ids) {
  const list = (ctx.findings || []).filter((f) => f.status === 'open' && (f.elementIds || []).some((x) => ids.includes(x)));
  if (!list.length) return '';
  return `<h4>관련 검증 결과 ${list.length}</h4><ul class="bv-flist">${list.slice(0, 8).map((f) => `<li><button type="button" class="link" data-bv-finding="${esc(f.id)}"><span class="badge ${f.severity === 'error' ? 'crit' : f.severity === 'warn' ? 'warn' : 'info'}">${SEV_LABEL[f.severity]}</span> ${esc(KIND_LABEL[f.kind] || f.kind)} — ${esc(f.message)}</button></li>`).join('')}</ul>`;
}

// 벽 층 구성 표(06 4절): 순서·재료·두께·쪽, 합계, 도면 두께와 차이
export function layerTable(wall, ctx) {
  const mats = new Map((ctx.catalog.materials || []).map((m) => [m.id, m]));
  const asm = (ctx.catalog.assemblies || []).find((a) => a.id === wall.assemblyId);
  const fin = finishResolver(ctx.type, ctx.catalog)(wall);
  const L = wallLayers(wall, asm, mats, { finishIn: fin.in, finishOut: fin.out });
  const side = { out: '실외 쪽', core: '구조', in: '실내 쪽' };
  const asmTotal = (asm?.layers || []).reduce((s, l) => s + (l.thicknessMm || 0), 0);
  const drawn = Math.round(wall.thickness * 1000);
  const diff = asmTotal ? drawn - Math.round(asmTotal) : 0;
  return `<table class="bv-layers"><thead><tr><th>#</th><th>재료</th><th>두께</th><th>쪽</th></tr></thead><tbody>
    ${L.map((l, i) => { const m = mats.get(l.materialId); return `<tr><td>${i + 1}</td><td><i class="sw" style="background:${esc(m?.color || '#ccc')}"></i>${esc(m?.name || CATEGORY_LABEL[l.category] || l.category)}</td><td>${mm(l.o1 - l.o0)}</td><td>${side[l.side] || ''}</td></tr>`; }).join('')}
    </tbody><tfoot><tr><td></td><td>합계(그림)</td><td>${mm(L.at(-1).o1 - L[0].o0)}</td><td></td></tr></tfoot></table>
    <p class="small ${Math.abs(diff) > 20 ? 't-warn' : 'muted'}">도면 두께 ${drawn.toLocaleString()}mm${asmTotal ? ` · 조립체 ${Math.round(asmTotal).toLocaleString()}mm${diff ? ` (차이 ${diff > 0 ? '+' : ''}${diff}mm, 구조체로 맞춤)` : ''}` : ''}</p>`;
}

function assemblyName(ctx, id) { return (ctx.catalog.assemblies || []).find((a) => a.id === id)?.name || ''; }
function spaceName(ctx, id) { return ctx.type?.spaces.find((s) => s.id === id)?.name || ''; }

/** 고른 요소 하나의 정보 */
function oneHtml(ctx, el) {
  const { kind, obj: o } = el;
  let title = '';
  let rows = '';
  let extra = '';
  let go = '';
  if (kind === 'building') {
    title = `${o.name} <small>${o.kind === 'community' ? '커뮤니티 시설' : o.kind === 'apartment' ? '아파트 동' : '건물'}</small>`;
    rows = row('지상', o.floorsAbove ? `${o.floorsAbove}층` : '') + row('지하', o.floorsBelow ? `${o.floorsBelow}층` : '') + row('높이', o.height ? `${o.height.toFixed(1)}m` : '') + row('바닥 면적', o.footprint ? `${m2(o.footprint).toFixed(0)}㎡` : '')
      + row('골구도', o.progressBuildingId ? '연결됨' : (o.kind === 'apartment' ? '<span class="muted">연결 안 됨</span>' : ''));
    go = `<button type="button" class="btn sm primary" data-bv-go="building" data-id="${esc(o.id)}">${icon('building')}${o.kind === 'community' ? '시설 안 보기' : '동 보기'}</button>`;
  } else if (kind === 'unit' || kind === 'facility') {
    const t = ctx.types.get(o.unitTypeId);
    const lv = ctx.building.levels.find((l) => l.id === o.levelId);
    title = kind === 'unit' ? `${esc(o.label)}호 <small>${esc(t?.name || '')}</small>` : esc(t?.name || '시설');
    rows = row('층', lv ? esc(lv.name) : '') + row('라인', o.line ? `${esc(o.line)}호 라인` : '') + row('타입', t ? `${esc(t.name)}${t.areaM2 ? ` · ${t.areaM2.toFixed(1)}㎡` : ''}` : '')
      + row('배치', o.transform?.mirror ? '좌우 대칭' : '') + row('공정', ctx.progressOf?.(o) || '');
    go = `<button type="button" class="btn sm primary" data-bv-go="unit" data-id="${esc(o.id)}">${icon('house')}세대 안 보기</button>`;
  } else if (kind === 'space') {
    title = `${esc(o.name)} <small>${esc(USE_LABEL[o.use] || '')}</small>`;
    const f = o.finish || {};
    rows = row('면적', o.areaM2 ? `${o.areaM2.toFixed(2)}㎡` : '') + row('바닥', esc(assemblyName(ctx, f.floor))) + row('벽', esc(assemblyName(ctx, f.wall))) + row('천장', esc(assemblyName(ctx, f.ceiling)))
      + row('시공부위', (o.zones || []).map((z) => `<span class="badge info">${ZONE_LABEL[z]}</span>`).join(' '));
    const mats = new Map((ctx.catalog.materials || []).map((m) => [m.id, m]));
    const asms = (ctx.catalog.assemblies || []).filter((a) => [f.floor, f.wall, f.ceiling].includes(a.id));
    extra = materialCards(asms.flatMap((a) => a.layers.map((l) => mats.get(l.materialId))), ctx);
  } else if (kind === 'wall') {
    title = `벽 ${o.code ? esc(o.code) : ''} <small>${o.exterior ? '외벽' : '내벽'}</small>`;
    const [a, b] = o.path;
    rows = row('길이', `${mm(Math.hypot(b[0] - a[0], b[1] - a[1]))}mm`) + row('두께', `${mm(o.thickness)}mm`) + row('조립체', esc(assemblyName(ctx, o.assemblyId)))
      + row('실내 쪽', esc(spaceName(ctx, o.sides?.in))) + row('반대쪽', esc(spaceName(ctx, o.sides?.out)) || (o.exterior ? '바깥' : ''));
    const mats = new Map((ctx.catalog.materials || []).map((m) => [m.id, m]));
    const asm = (ctx.catalog.assemblies || []).find((a) => a.id === o.assemblyId);
    extra = `<h4>층 구성</h4>${layerTable(o, ctx)}${materialCards((asm?.layers || []).map((l) => mats.get(l.materialId)), ctx)}`;
  } else if (kind === 'opening') {
    title = `${OPENING_LABEL[o.kind] || '개구부'} ${o.typeCode ? esc(o.typeCode) : ''}`;
    rows = row('크기', `${mm(o.width)} × ${mm(o.height)}mm`) + row('창대 높이', o.kind === 'window' ? `${mm(o.sill)}mm` : '');
    const wt = o.typeCode && (ctx.catalog.windowTypes || []).find((w) => w.code === String(o.typeCode).toUpperCase());
    if (wt) extra = windowCard(wt);
  } else if (kind === 'panel') {
    const z = ctx.building.facade.zones.find((x) => x.id === o.zoneId);
    const mat = (ctx.catalog.materials || []).find((m) => m.id === z?.materialId);
    const level = (id) => ctx.building.levels.find((l) => l.id === id)?.name || '';
    title = `외벽 ${SIDE_LABEL[o.side] || ''} <small>${esc(level(o.fromLevel))}~${esc(level(o.toLevel))}</small>`;
    rows = row('재료', `${z?.color ? `<i class="sw" style="background:${esc(z.color)}"></i>` : ''}${esc(mat?.name || '')}`) + row('구획 기호', esc(z?.code || '')) + row('면적', `${o.areaM2.toLocaleString()}㎡`) + row('창호 면적', `${o.openingAreaM2.toLocaleString()}㎡`)
      + row('벽 면적', `${(Math.round((o.areaM2 - o.openingAreaM2) * 100) / 100).toLocaleString()}㎡`);
    if (ctx.building.facade.assumedSides?.includes(o.side)) extra = '<p class="small t-warn">이 방향의 입면도가 없어 다른 면의 재료로 가정했습니다.</p>';
    extra += materialCards([mat], ctx);
  } else if (kind === 'column') {
    title = '기둥';
    rows = row('단면', o.polygon ? `${m2(o.polygon).toFixed(2)}㎡` : '');
  }
  // 세대(층마다 펼친 것)는 근거가 층 템플릿 배치에 있다
  const src = o.source || (kind === 'unit' ? ctx.building.floorTemplates.find((t) => t.id === o.templateId)?.units.find((x) => x.line === o.line)?.source : null);
  const more = actions.map((fn) => fn(ctx, el)).join('');
  return `<div class="bv-el"><h3>${title}</h3><table class="bv-props">${rows}</table>${extra}
    ${go || more ? `<div class="bv-acts">${go}${more}</div>` : ''}
    ${sourceHtml(src, ctx)}${findingsHtml(ctx, [o.id])}</div>`;
}

/** 여러 개 골랐을 때: 종류별 개수와 목록 */
function manyHtml(ctx, els) {
  const by = {};
  for (const e of els) (by[e.kind] ||= []).push(e.obj);
  const name = (k, o) => (k === 'unit' ? `${o.label}호` : o.name || o.code || o.typeCode || o.id);
  const label = { building: '동', unit: '세대', facility: '시설', space: '실', wall: '벽', opening: '문·창', column: '기둥' };
  return `<div class="bv-el"><h3>${els.length}개 골랐어요</h3>
    ${Object.entries(by).map(([k, l]) => `<p class="small"><b>${label[k] || k} ${l.length}</b> — ${l.slice(0, 12).map((o) => esc(name(k, o))).join(', ')}${l.length > 12 ? ' …' : ''}</p>`).join('')}
    ${actions.length ? `<div class="bv-acts">${actions.map((fn) => fn(ctx, els)).join('')}</div>` : ''}
    ${findingsHtml(ctx, els.map((e) => e.obj.id))}</div>`;
}

/** 아무것도 고르지 않았을 때: 장면 개요 + 목록 */
function overviewHtml(ctx) {
  if (ctx.level === 'site') {
    const s = ctx.summary || {};
    return `<div class="bv-el"><h3>단지</h3><p class="small muted">동 ${s.apartments ?? '-'} · 세대 ${s.units ?? '-'} · 타입 ${s.unitTypes ?? '-'} · 시설 ${s.facilities ?? 0}</p>
      <ul class="bv-list">${ctx.site.buildings.map((b) => `<li><button type="button" data-bv-go="building" data-id="${esc(b.id)}">${icon(b.kind === 'community' ? 'users' : 'building')}<b>${esc(b.name)}</b><span class="muted">${b.kind === 'apartment' ? `${b.floorsAbove}층` : '시설'}</span></button></li>`).join('')}</ul>
      <p class="muted small">동을 두 번 누르면 들어갑니다. 끌어서 돌리고, 두 손가락(휠)으로 확대해요.</p></div>`;
  }
  if (ctx.level === 'building') {
    const b = ctx.building;
    const count = new Map();
    for (const u of b.units) count.set(u.unitTypeId, (count.get(u.unitTypeId) || 0) + 1);
    const floors = b.levels.filter((l) => l.height > 0 && !['rooftop', 'underground'].includes(l.kind)).length;
    return `<div class="bv-el"><h3>${esc(b.name)}</h3><p class="small muted">층 ${floors} · 세대 ${b.units.length}</p>
      <h4>세대 타입</h4><ul class="bv-list">${[...count].map(([tid, n]) => { const t = ctx.types.get(tid); return `<li><button type="button" data-bv-go="type" data-id="${esc(tid)}">${icon('house')}<b>${esc(t?.name || tid)}</b><span class="muted">${n}세대${t?.areaM2 ? ` · ${t.areaM2.toFixed(0)}㎡` : ''}</span></button></li>`; }).join('') || '<li class="muted small">세대가 없습니다.</li>'}</ul>
      <p class="muted small">세대를 두 번 누르면 안으로 들어갑니다.</p></div>`;
  }
  const t = ctx.type;
  const wallLen = t.walls.reduce((s, w) => s + Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]), 0);
  return `<div class="bv-el"><h3>${esc(t.name)} <small>${t.kind === 'facility' ? '시설' : '세대 타입'}</small></h3>
    <p class="small muted">${t.areaM2 ? `${t.areaM2.toFixed(1)}㎡ · ` : ''}실 ${t.spaces.length} · 벽 ${t.walls.length}(${wallLen.toFixed(1)}m) · 문·창 ${t.openings.length}</p>
    ${ctx.progressOf && ctx.unit ? `<p class="small">공정: ${ctx.progressOf(ctx.unit) || '시작 전'}</p>` : ''}
    <ul class="bv-list">${t.spaces.map((s) => `<li><button type="button" data-bv-pick="${esc(s.id)}"><b>${esc(s.name)}</b><span class="muted">${s.areaM2 ? `${s.areaM2.toFixed(1)}㎡` : ''}${s.zones?.length ? ` · ${s.zones.map((z) => ZONE_LABEL[z]).join('·')}` : ''}</span></button></li>`).join('')}</ul>
    <p class="muted small">벽을 누르면 층 구성(재료·두께)을 볼 수 있어요. [마감 층]·[단면]으로 속을 봅니다.</p></div>`;
}

/**
 * @param {{ level, site, building?, type?, unit?, types: Map, catalog, sheets, findings, summary, progressOf? }} ctx
 * @param {string[]} ids 고른 요소
 */
export function panelHtml(ctx, ids) {
  const els = ids.map((id) => findElement(ctx, id)).filter(Boolean);
  if (!els.length) return overviewHtml(ctx) + overview.map((fn) => fn(ctx)).join('');
  return els.length === 1 ? oneHtml(ctx, els[0]) : manyHtml(ctx, els);
}
