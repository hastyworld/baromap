// 문서 → 모델 반영(20 지시서 5절). 문서 값으로 수정 연산을 만든다. 순수 함수(test/bim-docs.test.js).
// 반영 전에 항목별로 바뀌는 곳을 보여 주고 담당자가 고른 것만 적용한다(07 규칙: 수정 연산 → 새 버전).
// 값이 충돌하면 최신을 자동으로 고르지 않는다. 후보를 우선순위(최신 개정 → 일람표·마감표)대로 늘어놓고 사람이 고른다.
// 사람이 직접 넣은 값(source.method = manual)은 사람이 고르기 전에는 덮어쓰지 않는다.
import { material, materialId, CATEGORY_COLOR } from './materials-ko.js';
import { hash } from './ids.js';

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const norm = (s) => String(s ?? '').replace(/[\s·/]/g, '').toLowerCase();
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
function put(o, path, v) { const k = path.split('.'); let x = o; for (let i = 0; i < k.length - 1; i++) { x[k[i]] ??= {}; x = x[k[i]]; } x[k.at(-1)] = v; }
const has = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
const evOf = (doc, it) => ({ docId: doc.id, docName: doc.name, page: it.page ?? null, ...(it.box ? { box: it.box } : {}) });

const WINDOW_PATHS = ['name', 'appliesTo.unitTypes', 'appliesTo.rooms', 'sizeMm', 'frame.material', 'frame.opening', 'frame.maker', 'glass', 'perf.uWindow', 'perf.uGlass', 'perf.shgc',
  'perf.airtight', 'perf.watertight', 'perf.windPressure', 'perf.sound', 'perf.efficiencyGrade', 'perf.fire', 'perf.certNo'];
export const FIELD_LABEL = {
  name: '이름', 'appliesTo.unitTypes': '적용 타입', 'appliesTo.rooms': '위치', sizeMm: '규격', 'frame.material': '창틀 재질', 'frame.opening': '개폐 방식', 'frame.maker': '제조사', glass: '유리 표기',
  'perf.uWindow': '열관류율(창세트)', 'perf.uGlass': '열관류율(유리)', 'perf.shgc': '태양열취득률', 'perf.airtight': '기밀성', 'perf.watertight': '수밀성', 'perf.windPressure': '내풍압', 'perf.sound': '차음',
  'perf.efficiencyGrade': '효율 등급', 'perf.fire': '방화', 'perf.certNo': '인증번호', spec: '규격', maker: '제조사', floor: '바닥', wall: '벽', ceiling: '천장', base: '걸레받이',
};
const GROUP_RANK = { window_performance: 0, window_schedule: 1, glass_spec: 2, finish_list: 0, material_spec: 0, exterior_spec: 1 };

export const showValue = (v) => {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.join(', ');
  if (v.notation) return v.notation;
  if (v.w) return `${v.w}×${v.h}`;
  if ('grade' in v || 'value' in v) return [v.value != null ? `${v.value}${v.unit ? ` ${v.unit}` : ''}` : '', v.grade ? `${v.grade}등급` : ''].filter(Boolean).join(' · ');
  return JSON.stringify(v);
};
const emptyAirtight = (v) => v && typeof v === 'object' && 'grade' in v && v.value == null && v.grade == null;
const cmpKey = (v) => (v?.notation ? String(v.notation).toUpperCase().replace(/\s/g, '') : JSON.stringify(v));

// 최신 개정(개정·작성일이 큰 것) → 문서 종류 순서
function rankDocs(a, b) {
  const d = String(b.doc.docDate || '').localeCompare(String(a.doc.docDate || ''));
  return d || String(b.doc.revision || '').localeCompare(String(a.doc.revision || ''), 'ko', { numeric: true }) || (GROUP_RANK[a.doc.kind] ?? 9) - (GROUP_RANK[b.doc.kind] ?? 9);
}

// 같은 대상의 문서 값들을 칸별로 합친다 → { value(칸별), conflicts, ev }
function merge(cands, paths, choices, keyOf) {
  const value = {};
  const conflicts = [];
  const ev = [];
  for (const path of paths) {
    const vals = cands.map((c) => ({ ...c, v: get(c.it, path) })).filter((c) => has(c.v) && !emptyAirtight(c.v)).sort(rankDocs);
    if (!vals.length) continue;
    if (new Set(vals.map((c) => cmpKey(c.v))).size > 1) {
      const key = keyOf(path);
      const hit = vals.find((c) => c.doc.id === choices[key]);
      conflicts.push({ key, path, label: FIELD_LABEL[path] || path.replace('perfBy.', ''), chosen: hit?.doc.id || null, values: vals.map((c) => ({ docId: c.doc.id, docName: c.doc.name, revision: c.doc.revision || '', docDate: c.doc.docDate || '', page: c.it.page ?? null, value: showValue(c.v) })) });
      if (!hit) continue;
      put(value, path, hit.v);
      ev.push(evOf(hit.doc, hit.it));
    } else {
      put(value, path, vals[0].v);
      for (const c of vals) ev.push(evOf(c.doc, c.it));
    }
  }
  return { value, conflicts, ev: [...new Map(ev.map((e) => [`${e.docId}|${e.page}`, e])).values()] };
}

/** 모델 안 창호 사용 현황: 기호 → { kind, types, openings: [{ file, typeName, id, w, h }] } */
export function modelOpenings(files) {
  const out = new Map();
  const add = (file, typeName, list) => {
    for (const o of list || []) {
      if (!o.typeCode) continue;
      const code = String(o.typeCode).toUpperCase();
      if (!out.has(code)) out.set(code, { code, kind: o.kind, types: new Set(), openings: [] });
      const e = out.get(code);
      e.types.add(typeName);
      e.openings.push({ file, typeName, id: o.id, w: Math.round(o.width * 1000), h: Math.round(o.height * 1000), source: o.source });
    }
  };
  for (const [name, f] of Object.entries(files)) {
    if (name.startsWith('u-')) add(name, f.name, f.openings);
    if (name.startsWith('b-')) for (const t of f.floorTemplates || []) add(name, `${f.name} 공용부`, t.openings);
  }
  return out;
}

const docsWith = (docs, field) => docs.filter((d) => d.extracted?.[field]?.length);

function windowItems(files, docs, choices, out) {
  const cat = files['catalog.json'];
  const used = modelOpenings(files);
  const by = new Map();
  for (const doc of docsWith(docs, 'windows')) for (const it of doc.extracted.windows) { if (!by.has(it.code)) by.set(it.code, []); by.get(it.code).push({ doc, it }); }
  for (const [code, cands] of by) {
    if (!used.has(code)) { out.unlinked.push({ group: 'window', name: code, why: '도면에 없는 기호', docId: cands[0].doc.id, page: cands[0].it.page ?? null }); continue; }
    const key = `window:${code}`;
    const { value, conflicts, ev } = merge(cands, WINDOW_PATHS, choices, (p) => `${key}:${p}`);
    const prev = (cat.windowTypes || []).find((w) => w.code === code);
    const kept = prev?.source?.method === 'manual' && !choices[key];
    const id = `wt_${code}`;
    const set = {};
    for (const p of WINDOW_PATHS) { const v = get(value, p); if (has(v) && !eq(get(prev, p), v)) set[p] = v; }
    const changes = Object.entries(set).map(([p, v]) => ({ label: FIELD_LABEL[p] || p, from: showValue(get(prev, p)), to: showValue(v) }));
    let ops = [];
    if (!kept && !prev) ops = [{ op: 'add', file: 'catalog.json', collection: 'windowTypes', element: { id, code, kind: cands[0].it.kind || used.get(code).kind || 'window', name: null, appliesTo: { unitTypes: [], rooms: [] }, sizeMm: null, frame: { material: null, opening: null, maker: null }, glass: null, perf: {}, ...value, appliesTo: { unitTypes: [], rooms: [], ...value.appliesTo }, frame: { material: null, opening: null, maker: null, ...value.frame }, perf: { ...value.perf } }, reason: `문서 반영: ${code}`, evidence: ev }];
    else if (!kept && changes.length) ops = [{ op: 'update', file: 'catalog.json', id, set, reason: `문서 반영: ${code}`, evidence: ev }];
    const status = kept ? 'kept' : conflicts.some((c) => !c.chosen) ? 'conflict' : prev && !changes.length ? 'same' : prev ? 'change' : 'new';
    out.items.push({ key, group: 'window', label: code, status, changes, conflicts, ops, docIds: [...new Set(cands.map((c) => c.doc.id))] });
  }
}

function findMaterial(cat, name, links) {
  if (links[name]) return cat.materials.find((m) => m.id === links[name]) || null;
  const std = material(name).name;
  return cat.materials.find((m) => m.id === materialId(std)) || cat.materials.find((m) => norm(m.name) === norm(name) || norm(m.name) === norm(std)) || null;
}

function materialItems(files, docs, choices, links, out) {
  const cat = files['catalog.json'];
  const by = new Map();
  for (const doc of docsWith(docs, 'materials')) {
    for (const it of doc.extracted.materials) {
      const m = findMaterial(cat, it.name, links);
      if (!m) { out.unlinked.push({ group: 'material', name: it.name, why: '카탈로그에 없는 재료', docId: doc.id, page: it.page ?? null }); continue; }
      if (!by.has(m.id)) by.set(m.id, { m, cands: [] });
      by.get(m.id).cands.push({ doc, it: { ...it, perfBy: Object.fromEntries(it.perf.map((p) => [p.key, p])) } });
    }
  }
  for (const { m, cands } of by.values()) {
    const key = `material:${m.id}`;
    const keys = [...new Set(cands.flatMap((c) => Object.keys(c.it.perfBy)))];
    const paths = ['spec', 'maker', ...keys.map((k) => `perfBy.${k}`)];
    const { value, conflicts, ev } = merge(cands, paths, choices, (p) => `${key}:${p}`);
    const perf = [...(m.perf || []).filter((p) => !value.perfBy?.[p.key]), ...Object.values(value.perfBy || {})];
    const set = {};
    if (has(value.spec) && value.spec !== m.spec) set.spec = value.spec;
    if (has(value.maker) && value.maker !== m.maker) set.maker = value.maker;
    if (!eq(perf, m.perf || [])) set.perf = perf;
    const kept = m.source?.method === 'manual' && !choices[key];
    const changes = Object.entries(set).map(([p, v]) => ({ label: p === 'perf' ? '성능' : FIELD_LABEL[p], from: p === 'perf' ? `${(m.perf || []).length}개` : showValue(m[p]), to: p === 'perf' ? v.map((x) => `${x.label} ${x.value ?? ''}${x.unit ? ` ${x.unit}` : ''}`).join(', ') : showValue(v) }));
    const ops = !kept && changes.length ? [{ op: 'update', file: 'catalog.json', id: m.id, set, reason: `문서 반영: ${m.name}`, evidence: ev }] : [];
    const status = kept ? 'kept' : conflicts.some((c) => !c.chosen) ? 'conflict' : changes.length ? 'change' : 'same';
    out.items.push({ key, group: 'material', label: m.name, status, changes, conflicts, ops, docIds: [...new Set(cands.map((c) => c.doc.id))] });
  }
}

const newMaterial = (m, id) => ({ op: 'add', file: 'catalog.json', collection: 'materials', element: { id, name: m.name, category: m.category, color: m.color || CATEGORY_COLOR[m.category], trades: m.trades || [], spec: null, maker: null, perf: [], render: { textureId: null, tint: null } }, reason: `문서 반영: 재료 ${m.name}` });

// 표기 하나 → 카탈로그 조립체(없으면 새로 만드는 연산)
function finishTarget(cat, kind, name) {
  const m = material(name);
  const mid = materialId(m.name);
  const ops = cat.materials.some((x) => x.id === mid) ? [] : [newMaterial(m, mid)];
  const hit = cat.assemblies.find((a) => a.kind === kind && a.layers.length === 1 && a.layers[0].materialId === mid);
  if (hit) return { id: hit.id, ops };
  const id = `as_${kind[0]}_${hash(`doc|${m.name}`)}`;
  ops.push({ op: 'add', file: 'catalog.json', collection: 'assemblies', element: { id, code: null, kind, name: m.name, layers: [{ materialId: mid, thicknessMm: m.thicknessMm ?? null, side: 'in' }] }, reason: `문서 반영: ${m.name}` });
  return { id, ops };
}

function finishItems(files, docs, choices, out) {
  const cat = files['catalog.json'];
  const mats = new Map(cat.materials.map((m) => [m.id, m]));
  const asm = new Map(cat.assemblies.map((a) => [a.id, a]));
  const types = Object.entries(files).filter(([k]) => k.startsWith('u-')).map(([file, t]) => ({ file, t }));
  const by = new Map();
  for (const doc of docsWith(docs, 'finishes')) {
    for (const it of doc.extracted.finishes) {
      const targets = types.filter(({ t }) => (it.unitType ? norm(t.name) === norm(it.unitType) : t.kind === 'unit'));
      if (it.unitType && !targets.length) { out.unlinked.push({ group: 'finish', name: `${it.unitType} ${it.room}`, why: '모델에 없는 타입', docId: doc.id, page: it.page ?? null }); continue; }
      let hit = 0;
      for (const { file, t } of targets) {
        const sp = t.spaces.find((s) => norm(s.name) === norm(it.room));
        if (!sp) continue;
        hit++;
        for (const part of ['floor', 'wall', 'ceiling', 'base']) {
          if (!it[part]) continue;
          const key = `finish:${t.name}:${sp.name}:${part}`;
          if (!by.has(key)) by.set(key, { file, t, sp, part, cands: [] });
          by.get(key).cands.push({ doc, it });
        }
      }
      if (!hit) out.unlinked.push({ group: 'finish', name: `${it.unitType || '공통'} ${it.room}`, why: '모델에 없는 실', docId: doc.id, page: it.page ?? null });
    }
  }
  for (const [key, { file, t, sp, part, cands: all }] of by) {
    // 그 타입만 적은 줄이 "전 타입" 줄보다 먼저다
    const own = all.filter((c) => c.it.unitType);
    const cands = own.length ? own : all;
    const { value, conflicts, ev } = merge(cands, [part], choices, () => key);
    const name = value[part];
    const label = `${t.name} ${sp.name} ${FIELD_LABEL[part]}`;
    const docIds = [...new Set(cands.map((c) => c.doc.id))];
    const item = { key, group: 'finish', label, changes: [], conflicts, ops: [], docIds };
    if (!name) { out.items.push({ ...item, status: 'conflict' }); continue; }
    const curId = sp.finish?.[part];
    const curNames = part === 'base' ? [mats.get(curId)?.name] : (asm.get(curId)?.layers || []).map((l) => mats.get(l.materialId)?.name);
    const m = material(name);
    if (curNames.some((n) => n && (norm(n) === norm(m.name) || norm(n) === norm(name)))) { out.items.push({ ...item, status: 'same' }); continue; }
    const from = part === 'base' ? mats.get(curId)?.name || '' : asm.get(curId)?.name || '';
    const kept = sp.source?.method === 'manual' && !choices[key];
    const ops = [];
    let setTo;
    if (part === 'base') {
      setTo = materialId(m.name);
      if (!mats.has(setTo)) ops.push(newMaterial(m, setTo));
    } else {
      const target = finishTarget(cat, part, name);
      setTo = target.id;
      ops.push(...target.ops);
    }
    ops.push({ op: 'update', file, id: sp.id, set: { [`finish.${part}`]: setTo }, reason: `문서 반영: ${label}`, evidence: ev });
    out.items.push({ ...item, status: kept ? 'kept' : 'change', changes: [{ label: FIELD_LABEL[part], from, to: name }], ops: kept ? [] : ops });
  }
}

/**
 * 문서들을 모델에 반영할 계획.
 * @param {Record<string, any>} files 모델 파일
 * @param {any[]} docs project_docs(extracted 있는 것)
 * @param {{ choices?: Record<string, string>, links?: Record<string, string> }} o choices: 충돌 키 → 고른 문서 id, links: 재료 이름 → 재료 id(사람이 연결)
 * @returns {{ items: any[], unlinked: any[] }}
 */
export function docPlan(files, docs, { choices = {}, links = {} } = {}) {
  const out = { items: [], unlinked: [] };
  const list = docs.filter((d) => d.extracted);
  windowItems(files, list, choices, out);
  materialItems(files, list, choices, links, out);
  finishItems(files, list, choices, out);
  techItems(files, list, out);
  return out;
}

// 기술검토서(39 지시서 2절): 흙막이·가시설 값은 단지(site.excavation)에. 크레인은 가설 배치 후보만(사람이 확인해야 확정)
function techItems(files, list, out) {
  for (const doc of list.filter((d) => d.kind === 'tech_review' && d.extracted.techReview)) {
    const t = doc.extracted.techReview;
    if (t.kind === 'excavation' && Object.keys(t.values || {}).length) {
      const now = files['site.json']?.excavation || null;
      const val = { ...t.values, conclusion: t.conclusion?.text || null, docId: doc.id, docName: doc.name, page: t.conclusion?.page ?? t.summaryPages?.[0] ?? null };
      const LBL = { method: '공법', depthM: '굴착 깊이(m)', support: '지지 방식', stages: '단수', monitoring: '계측', conclusion: '결론' };
      const changes = Object.entries(LBL).filter(([k]) => val[k] != null).map(([k, label]) => ({ label, from: now?.[k] != null ? String(now[k]) : '', to: String(val[k]) }));
      out.items.push({ key: `tech:${doc.id}`, group: 'site', label: `흙막이·가시설(${doc.name})`, changes, conflicts: [], status: !now ? 'new' : JSON.stringify(now) === JSON.stringify(val) ? 'same' : 'change',
        ops: [{ op: 'update', file: 'site.json', id: 'site', set: { excavation: val }, reason: '흙막이 검토서', evidence: [{ docId: doc.id, docName: doc.name, page: val.page }] }] });
    }
  }
}

/** 고른 항목의 연산을 한 줄로(같은 재료·조립체를 두 번 추가하지 않는다) */
export function planOps(plan, keys) {
  const pick = new Set(keys);
  const seen = new Set();
  const ops = [];
  for (const it of plan.items) {
    if (!pick.has(it.key)) continue;
    for (const op of it.ops) {
      if (op.op === 'add') {
        if (seen.has(op.element.id)) continue;
        seen.add(op.element.id);
      }
      ops.push(op);
    }
  }
  return ops;
}

/** 연결 현황: 묶음별 연결됨·못 찾음·충돌 수 */
export function linkStatus(plan) {
  const out = { window: { linked: 0, missing: 0, conflict: 0 }, material: { linked: 0, missing: 0, conflict: 0 }, finish: { linked: 0, missing: 0, conflict: 0 }, site: { linked: 0, missing: 0, conflict: 0 } };
  for (const it of plan.items) out[it.group][it.status === 'conflict' ? 'conflict' : 'linked']++;
  for (const u of plan.unlinked) out[u.group].missing++;
  return out;
}
