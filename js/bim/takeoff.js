// 수량 산출(23 지시서): 모델 → 재료·공종별 수량. 구간(요소) → 세대(타입 1세대) → 동 → 현장 전체. 순수 함수(워커·Node 공용).
// 모델 수량은 참고값이다(적산을 대신하지 않는다). 항목마다 사람이 읽는 식(formula)과 추정(assumed)을 남긴다.
// 개구부 공제·벽 마감 높이·치켜올림·할증은 회사 설정(ops_settings.takeoff)이고, 숫자를 코드에 고정하지 않는다.
//   항목: { elementId, materialId, assemblyId, code, trade, part, unit, value, formula, assumed }
import { slabDepth } from './mesh-calc.js';

export const DEFAULT_TAKEOFF = {
  openingDeduct: { default: 0 }, // 재료 분류별 이 면적(㎡) 이하 개구부는 공제하지 않음. 0 = 모두 공제
  wallFinishHeight: 'ceiling', // ceiling: 천장까지 / slab: 슬래브 밑까지
  waterproofUpturnMm: {}, // 실 쓰임새별(bath·balcony …) 치켜올림. 비우면 도면 상세 값, 그것도 없으면 바닥만
  slabColumnDeduct: true,
  rebarVolumeDeduct: false,
  rebarRatio: 0.015, // 철근 부피 공제를 켰을 때만(연구 값 1~2%, 회사 값으로 바꾼다)
  lossRate: {}, // 재료 분류별 할증률(0.05 = 5%). 비우면 정미 수량
};
export const PART_LABEL = { wall: '벽체', floor: '바닥 마감', floorBuild: '바닥 구성', ceiling: '천장', wallFinish: '벽 마감', base: '걸레받이', waterproof: '방수', window: '창', glass: '유리', door: '문', column: '기둥', slab: '슬래브', panel: '외벽 패널', roof: '지붕', railing: '난간', paving: '포장', tree: '수목', feature: '시설물' };
const FRAME_M = 0.06; // 유리 면적을 낼 때 창틀 폭 가정(27 지시서 기본값) — 추정으로 표시

/** 회사 기본 + 현장 덮어쓰기 → 쓸 기준. isDefault면 화면에 "회사 산출 기준 미설정" */
export function takeoffSettings(global = null, site = null) {
  const out = { ...DEFAULT_TAKEOFF };
  for (const src of [global, site]) for (const [k, v] of Object.entries(src || {})) if (v != null && k in DEFAULT_TAKEOFF) out[k] = typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
  return { ...out, isDefault: !global && !site };
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const f2 = (v) => r2(v).toFixed(2);
const len = (w) => Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]);
export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < (poly || []).length; i++) { const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a / 2);
}
const perim = (poly) => (poly || []).reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0);

function catalogIndex(catalog) {
  return {
    mat: new Map((catalog?.materials || []).map((m) => [m.id, m])),
    asm: new Map((catalog?.assemblies || []).map((a) => [a.id, a])),
    details: catalog?.details || [],
  };
}
const tradeOf = (m) => m?.trades?.[0] || ({ structure: '골조', masonry: '조적', insulation: '단열', plaster: '미장', board: '경량', lightweight: '경량', finish: '마감', waterproof: '방수' }[m?.category] || '기타');
const minDeduct = (st, category) => st.openingDeduct?.[category] ?? st.openingDeduct?.default ?? 0;

/**
 * 세대·시설 타입 1개(또는 층 템플릿)의 수량. H: 층고(m), level: 슬래브 두께를 읽을 레벨
 * @returns {any[]} 항목
 */
export function typeItems(type, catalog, { H = 2.9, level = null, settings = DEFAULT_TAKEOFF } = {}) {
  const st = settings;
  const { mat, asm, details } = catalogIndex(catalog);
  const out = [];
  const push = (o) => { if (o.value > 0) out.push({ ...o, value: r3(o.value) }); };
  const slab = slabDepth(level);
  const slabAssumed = !level?.slabMm;
  const wallH = H - slab;
  const opsBy = new Map();
  for (const o of type.openings || []) { if (!opsBy.has(o.wallId)) opsBy.set(o.wallId, []); opsBy.get(o.wallId).push(o); }
  const wallById = new Map((type.walls || []).map((w) => [w.id, w]));

  // 벽체: 조립체의 마감이 아닌 층(구조·단열·석고·경량·미장·방수)마다 면적, 구조체는 체적도. 세대 경계 벽은 ½(옆 세대와 나눔)
  for (const w of type.walls || []) {
    const a = asm.get(w.assemblyId);
    const L = len(w);
    const shared = !w.exterior && w.sides && !w.sides.out;
    const k = shared ? 0.5 : 1;
    const wallAssumed = w.source?.method === 'assumed' || a?.source?.method === 'assumed' || slabAssumed;
    for (const l of a?.layers || []) {
      const m = mat.get(l.materialId);
      if (!m || m.category === 'finish') continue;
      const ded = (opsBy.get(w.id) || []).filter((o) => o.width * o.height > minDeduct(st, m.category));
      const dA = ded.reduce((s, o) => s + o.width * o.height, 0);
      const area = (L * wallH - dA) * k;
      const f = `벽 ${w.code || ''} 길이 ${f2(L)}m × 높이 ${f2(wallH)}m${dA ? ` − 개구부 ${f2(dA)}㎡` : ''}${shared ? ' × ½(세대 경계)' : ''} = ${f2(area)}㎡`;
      push({ elementId: w.id, materialId: m.id, assemblyId: a.id, code: w.code, trade: tradeOf(m), part: 'wall', unit: '㎡', value: area, formula: f, assumed: wallAssumed });
      if (m.category === 'structure' && l.thicknessMm) push({ elementId: w.id, materialId: m.id, assemblyId: a.id, code: w.code, trade: tradeOf(m), part: 'wall', unit: '㎥', value: area * l.thicknessMm / 1000, formula: `${f} × 두께 ${f2(l.thicknessMm / 1000)}m`, assumed: wallAssumed });
    }
  }
  // 실: 바닥·천장·벽 마감·걸레받이·바닥 구성·방수
  for (const sp of type.spaces || []) {
    const A = sp.areaM2 || polyArea(sp.polygon);
    const bound = (type.walls || []).filter((w) => w.sides && (w.sides.in === sp.id || w.sides.out === sp.id));
    const P = bound.length ? bound.reduce((s, w) => s + len(w), 0) : perim(sp.polygon);
    const ops = bound.flatMap((w) => opsBy.get(w.id) || []);
    const fin = sp.finish || {};
    const lay = (assemblyId, part, value, formula, assumed = false) => {
      const a = asm.get(assemblyId);
      for (const l of a?.layers || []) {
        const m = mat.get(l.materialId);
        if (!m) continue;
        push({ elementId: sp.id, materialId: m.id, assemblyId, code: sp.name, trade: tradeOf(m), part, unit: '㎡', value, formula, assumed });
      }
    };
    if (fin.floor) lay(fin.floor, 'floor', A, `${sp.name} 바닥 ${f2(A)}㎡`);
    if (fin.ceiling) lay(fin.ceiling, 'ceiling', A, `${sp.name} 천장 ${f2(A)}㎡`);
    if (fin.wall) {
      const chRead = sp.ceilingMm ? sp.ceilingMm / 1000 : null;
      const fh = st.wallFinishHeight === 'slab' ? wallH : chRead ?? wallH;
      const ded = ops.filter((o) => o.width * Math.min(o.height, fh) > minDeduct(st, 'finish')).reduce((s, o) => s + o.width * Math.min(o.height, fh), 0);
      const v = P * fh - ded;
      lay(fin.wall, 'wallFinish', v, `${sp.name} 벽 둘레 ${f2(P)}m × 마감 높이 ${f2(fh)}m${st.wallFinishHeight !== 'slab' && !chRead ? '(천장고 없음 → 슬래브 밑까지)' : ''}${ded ? ` − 개구부 ${f2(ded)}㎡` : ''} = ${f2(v)}㎡`, st.wallFinishHeight !== 'slab' && !chRead);
    }
    if (fin.base && mat.get(fin.base)) {
      const doors = ops.filter((o) => o.kind === 'door').reduce((s, o) => s + o.width, 0);
      const m = mat.get(fin.base);
      push({ elementId: sp.id, materialId: m.id, assemblyId: null, code: sp.name, trade: tradeOf(m), part: 'base', unit: 'm', value: P - doors, formula: `${sp.name} 둘레 ${f2(P)}m${doors ? ` − 문 ${f2(doors)}m` : ''} = ${f2(P - doors)}m`, assumed: false });
    }
    // 단면에서 읽은 바닥 구성(38 지시서): 마감·슬래브를 뺀 층(완충재·경량기포·몰탈)
    if (sp.floorAssemblyId) {
      for (const l of asm.get(sp.floorAssemblyId)?.layers || []) {
        const m = mat.get(l.materialId);
        if (!m || l.side === 'core' || m.category === 'finish') continue;
        push({ elementId: sp.id, materialId: m.id, assemblyId: sp.floorAssemblyId, code: sp.name, trade: tradeOf(m), part: 'floorBuild', unit: '㎡', value: A, formula: `${sp.name} 바닥 구성 ${m.name} ${f2(A)}㎡`, assumed: false });
      }
    }
    if (sp.zones?.includes('waterproof')) {
      const set = st.waterproofUpturnMm?.[sp.use];
      const det = details.find((d) => d.key === 'waterproofUpturnMm' && typeof d.value === 'number');
      const up = set ?? det?.value ?? null;
      const v = A + (up ? P * up / 1000 : 0);
      const wp = [...mat.values()].find((m) => m.category === 'waterproof');
      push({ elementId: sp.id, materialId: wp?.id || 'waterproof', assemblyId: null, code: sp.name, trade: '방수', part: 'waterproof', unit: '㎡', value: v,
        formula: `${sp.name} 바닥 ${f2(A)}㎡${up ? ` + 둘레 ${f2(P)}m × 치켜올림 ${f2(up / 1000)}m(${set != null ? '회사 기준' : '도면 상세'})` : ' (치켜올림 높이 없음 → 바닥만)'} = ${f2(v)}㎡`, assumed: up == null });
    }
  }
  // 창·문: 기호별 개소·면적, 유리 면적(창틀 폭 가정)
  for (const o of type.openings || []) {
    const code = o.typeCode || (o.kind === 'door' ? '문' : '창');
    const w = wallById.get(o.wallId);
    const shared = w && !w.exterior && w.sides && !w.sides.out;
    const k = shared ? 0.5 : 1;
    const part = o.kind === 'door' ? 'door' : 'window';
    push({ elementId: o.id, materialId: `op:${code}`, assemblyId: null, code, trade: '창호', part, unit: '개소', value: k, formula: `${code} 1개소${shared ? ' × ½(세대 경계)' : ''}`, assumed: false });
    if (part === 'window') {
      push({ elementId: o.id, materialId: `op:${code}`, assemblyId: null, code, trade: '창호', part, unit: '㎡', value: o.width * o.height * k, formula: `${code} ${f2(o.width)}×${f2(o.height)}m = ${f2(o.width * o.height)}㎡`, assumed: false });
      const g = Math.max(0, o.width - 2 * FRAME_M) * Math.max(0, o.height - 2 * FRAME_M);
      push({ elementId: o.id, materialId: `glass:${code}`, assemblyId: null, code, trade: '유리', part: 'glass', unit: '㎡', value: g * k, formula: `${code} 유리 (${f2(o.width)}−${f2(2 * FRAME_M)})×(${f2(o.height)}−${f2(2 * FRAME_M)})m = ${f2(g)}㎡(창틀 60mm 가정)`, assumed: true });
    }
  }
  for (const c of type.columns || []) {
    const A = polyArea(c.polygon);
    const conc = [...mat.values()].find((m) => m.category === 'structure');
    push({ elementId: c.id, materialId: conc?.id || 'concrete', assemblyId: c.assemblyId || null, code: '기둥', trade: '골조', part: 'column', unit: '㎥', value: A * wallH, formula: `기둥 ${f2(A)}㎡ × 높이 ${f2(wallH)}m = ${f2(A * wallH)}㎥`, assumed: slabAssumed });
  }
  return out;
}

// ---------------------------------------------------------------- 합치기

function addRows(rows, items, mult = 1, extra = {}) {
  for (const it of items) {
    const key = `${it.trade}|${it.materialId}|${it.part}|${it.unit}`;
    const r = rows.get(key) || { key, trade: it.trade, materialId: it.materialId, code: it.code, part: it.part, unit: it.unit, value: 0, assumed: 0, ids: new Set(), formula: it.formula };
    r.value += it.value * mult;
    if (it.assumed) r.assumed += it.value * mult;
    if (it.elementId) r.ids.add(it.elementId);
    for (const id of extra.ids || []) r.ids.add(id);
    rows.set(key, r);
  }
}
// 이미 합친 행끼리 더하기(추정 양도 그대로)
function mergeRows(target, rows) {
  for (const x of rows) {
    const r = target.get(x.key) || { key: x.key, trade: x.trade, materialId: x.materialId, code: x.code, part: x.part, unit: x.unit, value: 0, assumed: 0, ids: new Set(), formula: x.formula };
    r.value += x.value;
    r.assumed += x.assumed;
    for (const id of x.ids || []) r.ids.add(id);
    target.set(x.key, r);
  }
}
const finish = (rows, mat) => [...rows.values()].map((r) => ({ ...r, value: r3(r.value), assumed: r3(r.assumed), ids: [...r.ids].slice(0, 3000), name: mat.get(r.materialId)?.name || (r.materialId.startsWith('op:') || r.materialId.startsWith('glass:') ? `${r.code}${r.materialId.startsWith('glass:') ? ' 유리' : ''}` : r.code || r.materialId) }))
  .sort((a, b) => a.trade.localeCompare(b.trade, 'ko') || a.name.localeCompare(b.name, 'ko') || a.unit.localeCompare(b.unit));
function applyLoss(rows, st, mat) {
  for (const r of rows) {
    const cat = mat.get(r.materialId)?.category;
    let k = 1;
    if (cat === 'structure' && r.unit === '㎥' && st.rebarVolumeDeduct) k *= 1 - (st.rebarRatio || 0);
    const loss = st.lossRate?.[cat];
    if (loss) k *= 1 + loss;
    if (k !== 1) { r.value = r3(r.value * k); r.assumed = r3(r.assumed * k); r.adjusted = k; }
  }
  return rows;
}

/**
 * 모델 전체 수량. 같은 타입·같은 층고는 한 번만 계산해 곱한다(대칭 배치도 같은 수량).
 * @param {Record<string, any>} files 모델 파일
 * @param {any} [settings] takeoffSettings 결과
 */
export function takeoff(files, settings = takeoffSettings()) {
  const st = settings;
  const catalog = files['catalog.json'];
  const { mat } = catalogIndex(catalog);
  const idx = files['index.json'];
  const types = new Map(Object.values(idx?.files?.unitTypes || {}).map((f) => [files[f]?.id, files[f]]).filter(([k]) => k));
  const cache = new Map();
  const itemsOf = (type, level) => {
    const key = `${type.id}|${level?.height}|${level?.slabMm ?? ''}`;
    if (!cache.has(key)) cache.set(key, typeItems(type, catalog, { H: level?.height || 2.9, level, settings: st }));
    return cache.get(key);
  };
  const total = new Map();
  const buildings = {};
  const unitTypes = {};
  for (const bf of Object.values(idx?.files?.buildings || {})) {
    const b = files[bf];
    if (!b) continue;
    const rows = new Map();
    const levels = new Map((b.levels || []).map((l) => [l.id, l]));
    const counts = {};
    // 세대 배치
    for (const u of b.units || []) {
      const t = types.get(u.unitTypeId);
      if (!t) continue;
      counts[t.id] = (counts[t.id] || 0) + 1;
      const items = itemsOf(t, levels.get(u.levelId));
      addRows(rows, items, 1, { ids: [u.id] });
      unitTypes[t.id] ||= { name: t.name, items };
    }
    // 층 템플릿(코어·복도·필로티 등 공용부). 세대 목록이 없는 동(주민공동시설 등)은 템플릿의 배치 × 층
    for (const tpl of b.floorTemplates || []) {
      for (const lid of tpl.levelIds || []) {
        const level = levels.get(lid);
        addRows(rows, itemsOf({ ...tpl, id: `${tpl.id}`, openings: tpl.openings || [], spaces: tpl.spaces || [], walls: tpl.walls || [], columns: tpl.columns || [] }, level));
        if ((b.units || []).length) continue;
        for (const inst of tpl.units || []) {
          const t = types.get(inst.unitTypeId);
          if (!t) continue;
          counts[t.id] = (counts[t.id] || 0) + 1;
          const items = itemsOf(t, level);
          addRows(rows, items, 1, { ids: [inst.id] });
          unitTypes[t.id] ||= { name: t.name, items };
        }
      }
    }
    // 슬래브: 층마다 외곽 면적(기둥 겹침 공제는 설정) × 두께
    const conc = [...mat.values()].find((m) => m.category === 'structure');
    const out = polyArea(b.outline);
    const slabItems = [];
    for (const l of b.levels || []) {
      if (!out || l.kind === 'rooftop' && l.height === 0) continue;
      const tpl = (b.floorTemplates || []).find((t) => t.levelIds?.includes(l.id));
      const colA = st.slabColumnDeduct ? (tpl?.columns || []).reduce((s, c) => s + polyArea(c.polygon), 0) : 0;
      const t = slabDepth(l);
      const v = (out - colA) * t;
      slabItems.push({ elementId: l.id, materialId: conc?.id || 'concrete', assemblyId: null, code: l.name, trade: '골조', part: 'slab', unit: '㎥', value: r3(v), formula: `${l.name} 슬래브 외곽 ${f2(out)}㎡${colA ? ` − 기둥 ${f2(colA)}㎡` : ''} × ${f2(t)}m${l.slabMm ? '' : '(두께 미확인 → 0.20m)'} = ${f2(v)}㎥`, assumed: !l.slabMm });
    }
    addRows(rows, slabItems);
    // 외벽 패널: 구역(재료)별 순면적
    const zones = new Map((b.facade?.zones || []).map((z) => [z.id, z]));
    const panelItems = (b.facade?.panels || []).map((p) => {
      const z = zones.get(p.zoneId);
      const m = mat.get(z?.materialId);
      const v = Math.max(0, p.areaM2 - (p.openingAreaM2 || 0));
      return { elementId: p.id, materialId: m?.id || `zone:${z?.code || p.zoneId}`, assemblyId: z?.assemblyId || null, code: z?.code || '', trade: m ? tradeOf(m) : '외장', part: 'panel', unit: '㎡', value: r3(v), formula: `외벽 패널 ${z?.code || ''} ${f2(p.areaM2)}㎡${p.openingAreaM2 ? ` − 창 ${f2(p.openingAreaM2)}㎡` : ''} = ${f2(v)}㎡`, assumed: p.source?.method === 'assumed' || (p.source?.confidence ?? 1) < 0.5 };
    });
    addRows(rows, panelItems);
    // 외벽 구역 기호별 순면적(내역 연결이 구역으로 걸릴 때, 24 지시서 2절)
    const zoneArea = {};
    for (const p of panelItems) if (p.code) zoneArea[p.code] = r3((zoneArea[p.code] || 0) + p.value);
    // 지붕, 발코니 난간(앞면 길이 가정)
    if (b.roof && out) {
      const ph = (b.roof.penthouses || []).reduce((s, p) => s + polyArea(p.polygon), 0);
      const m = mat.get(b.roof.materialId);
      addRows(rows, [{ elementId: b.id, materialId: m?.id || 'roof', assemblyId: b.roof.assemblyId || null, code: '지붕', trade: m ? tradeOf(m) : '방수', part: 'roof', unit: '㎡', value: r3(out - ph), formula: `지붕 ${f2(out)}㎡ − 옥탑 ${f2(ph)}㎡ = ${f2(out - ph)}㎡`, assumed: false }]);
    }
    const rail = (b.balconies || []).map((bc) => {
      const edges = bc.polygon.map((p, i) => { const q = bc.polygon[(i + 1) % bc.polygon.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]); });
      const front = Math.max(...edges);
      return { elementId: bc.id, materialId: 'railing', assemblyId: null, code: '난간', trade: '금속', part: 'railing', unit: 'm', value: r3(front * (bc.levelIds?.length || 1)), formula: `발코니 앞면 ${f2(front)}m × ${bc.levelIds?.length || 1}개 층 = ${f2(front * (bc.levelIds?.length || 1))}m(가장 긴 변을 난간으로 가정)`, assumed: true };
    });
    addRows(rows, rail);
    const list = applyLoss(finish(rows, mat), st, mat);
    buildings[b.id] = { name: b.name, unitCounts: counts, rows: list, zones: zoneArea };
    mergeRows(total, list);
  }
  // 단지: 포장·수목·시설물
  const site = files['site.json'] || {};
  const siteRows = new Map();
  addRows(siteRows, (site.pavings || []).map((p) => { const m = mat.get(p.materialId); const A = polyArea(p.polygon); return { elementId: p.id, materialId: m?.id || `paving:${p.code}`, assemblyId: null, code: p.code, trade: '포장', part: 'paving', unit: '㎡', value: r3(A), formula: `포장 ${p.code || ''} ${f2(A)}㎡`, assumed: false }; }));
  addRows(siteRows, (site.trees || []).map((t) => ({ elementId: t.id, materialId: `tree:${t.species || '수목'}`, assemblyId: null, code: t.species || '수목', trade: '조경', part: 'tree', unit: '주', value: 1, formula: `${t.species || '수목'} 1주`, assumed: false })));
  addRows(siteRows, (site.features || []).map((f) => ({ elementId: f.id, materialId: `feature:${f.kind}`, assemblyId: null, code: f.kind, trade: '조경', part: 'feature', unit: '개', value: 1, formula: `${f.kind} 1개`, assumed: false })));
  const siteList = finish(siteRows, mat);
  mergeRows(total, siteList);
  const totalList = finish(total, mat);
  const share = (unit) => { const rs = totalList.filter((r) => r.unit === unit); const v = rs.reduce((s, r) => s + r.value, 0); return v ? r3(rs.reduce((s, r) => s + r.assumed, 0) / v) : 0; };
  return {
    settings: st,
    unitTypes: Object.fromEntries(Object.entries(unitTypes).map(([id, t]) => [id, { name: t.name, rows: finish((() => { const m = new Map(); addRows(m, t.items); return m; })(), mat), items: t.items }])),
    buildings,
    site: { rows: siteList },
    total: totalList,
    zones: Object.values(buildings).reduce((z, b) => { for (const [c, v] of Object.entries(b.zones || {})) z[c] = r3((z[c] || 0) + v); return z; }, {}),
    assumedShare: { '㎡': share('㎡'), '㎥': share('㎥') },
  };
}

/** 요약(bim_models.stats.takeoff): 공종·단위별 합계와 추정 비율 */
export function takeoffSummary(t) {
  const by = new Map();
  for (const r of t.total) { const k = `${r.trade}|${r.unit}`; by.set(k, r3((by.get(k) || 0) + r.value)); }
  return { rows: [...by.entries()].map(([k, v]) => { const [trade, unit] = k.split('|'); return { trade, unit, value: v }; }), assumedShare: t.assumedShare, isDefault: Boolean(t.settings?.isDefault) };
}

/** 두 버전 수량 증감: key가 같은 행끼리 */
export function takeoffDiff(a, b) {
  const A = new Map(a.total.map((r) => [r.key, r]));
  const B = new Map(b.total.map((r) => [r.key, r]));
  const out = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(k);
    const y = B.get(k);
    const d = r3((y?.value || 0) - (x?.value || 0));
    if (Math.abs(d) < 0.001) continue;
    const r = y || x;
    out.push({ key: k, trade: r.trade, name: r.name, part: r.part, unit: r.unit, before: x?.value || 0, after: y?.value || 0, diff: d, rate: x?.value ? r3(d / x.value) : null });
  }
  return out.sort((p, q) => Math.abs(q.diff) - Math.abs(p.diff));
}

/** 재료 하나의 네 단계 수량: 이 구간(요소) / 이 세대(타입) / 이 동 / 현장 전체 */
export function materialLevels(t, materialId, { elementId = null, typeId = null, buildingId = null } = {}) {
  const sum = (rows, unit) => r3(rows.filter((r) => r.materialId === materialId && (!unit || r.unit === unit)).reduce((s, r) => s + r.value, 0));
  const units = [...new Set([...t.total, ...(t.unitTypes[typeId]?.rows || [])].filter((r) => r.materialId === materialId).map((r) => r.unit))];
  const items = typeId ? t.unitTypes[typeId]?.items || [] : [];
  return units.map((unit) => ({
    unit,
    element: elementId ? r3(items.filter((i) => i.elementId === elementId && i.materialId === materialId && i.unit === unit).reduce((s, i) => s + i.value, 0)) : null,
    elementFormula: elementId ? items.filter((i) => i.elementId === elementId && i.materialId === materialId && i.unit === unit).map((i) => i.formula) : [],
    unitType: typeId ? sum(t.unitTypes[typeId]?.rows || [], unit) : null,
    building: buildingId ? sum(t.buildings[buildingId]?.rows || [], unit) : null,
    site: sum(t.total, unit),
  }));
}
