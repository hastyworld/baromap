// 수정 연산(01 4절): 배열 번호 대신 요소 id로 가리키는 update / add / remove. 직접 고치기(07 2절)와 AI 수정(ai-edit)이 같은 형식을 쓰고,
// 브라우저와 Edge Function이 같은 파일을 쓴다(npm run functions:sync). 적용은 전부 아니면 전무, 원본은 바꾸지 않는다.
//   { op: 'update', file, id, set: { 'finish.wall': 'as_…' }, reason, evidence? }
//   { op: 'add', file, collection: 'openings', parentId?, element: { id, … }, reason }
//   { op: 'remove', file, id, reason }
import { checkModelFiles } from './schemas.js';

export const OPS = ['update', 'add', 'remove'];
const BAD_KEY = new Set(['__proto__', 'constructor', 'prototype']);
const LOCKED = new Set(['id', 'source']); // 직접 바꿀 수 없는 칸(출처는 적용할 때 자동으로)
const clone = (x) => JSON.parse(JSON.stringify(x));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 파일 안에서 id로 요소 찾기 → { obj, list, index, owner } (owner: 그 배열을 가진 객체) */
export function locateId(root, id) {
  if (root?.id === id) return { obj: root, list: null, index: -1, owner: null }; // 파일 자체(동·세대 타입)
  let hit = null;
  const visit = (node, owner) => {
    if (hit) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && !hit; i++) {
        const v = node[i];
        if (!v || typeof v !== 'object') continue;
        if (v.id === id) { hit = { obj: v, list: node, index: i, owner }; return; }
        visit(v, owner);
      }
      return;
    }
    if (isObj(node)) for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, node);
  };
  visit(root, null);
  return hit;
}

/** 파일 안의 id 가진 객체 전부 → Map(id → 객체) */
export function idsOf(root) {
  const out = new Map();
  if (typeof root?.id === 'string') out.set(root.id, root);
  const visit = (node) => {
    if (Array.isArray(node)) { for (const v of node) { if (v && typeof v === 'object') { if (typeof v.id === 'string') out.set(v.id, v); visit(v); } } return; }
    if (isObj(node)) for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  visit(root);
  return out;
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObj(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  if (value === undefined) delete o[keys.at(-1)]; else o[keys.at(-1)] = value;
}

// 연산 하나의 모양 검사(파일·id가 있는지는 적용하면서)
function opShape(op, i) {
  const at = `${i + 1}번 연산`;
  if (!isObj(op)) return `${at}: 객체가 아닙니다`;
  if (!OPS.includes(op.op)) return `${at}: op는 update·add·remove 중 하나여야 합니다`;
  if (typeof op.file !== 'string' || !op.file) return `${at}: file이 없습니다`;
  if (op.op === 'update') {
    if (typeof op.id !== 'string' || !op.id) return `${at}: id가 없습니다`;
    if (!isObj(op.set) || !Object.keys(op.set).length) return `${at}: set(바꿀 값)이 없습니다`;
    for (const p of Object.keys(op.set)) {
      const keys = p.split('.');
      if (keys.some((k) => !k || BAD_KEY.has(k))) return `${at}: 쓸 수 없는 칸 이름 "${p}"`;
      if (LOCKED.has(keys[0])) return `${at}: "${keys[0]}"는 바꿀 수 없습니다`;
    }
  }
  if (op.op === 'remove' && (typeof op.id !== 'string' || !op.id)) return `${at}: id가 없습니다`;
  if (op.op === 'add') {
    if (typeof op.collection !== 'string' || !op.collection || BAD_KEY.has(op.collection)) return `${at}: collection이 없습니다`;
    if (!isObj(op.element) || typeof op.element.id !== 'string' || !op.element.id) return `${at}: 추가할 요소(element.id)가 없습니다`;
  }
  return null;
}

// 모델 안 참조가 맞는지(조립체·재료·벽·타입·레벨)
export function checkRefs(files) {
  const errors = [];
  const idx = files['index.json'];
  const cat = files['catalog.json'] || { materials: [], assemblies: [] };
  const asm = new Set(cat.assemblies.map((a) => a.id));
  const mats = new Set(cat.materials.map((m) => m.id));
  for (const a of cat.assemblies) for (const l of a.layers || []) if (!mats.has(l.materialId)) errors.push(`catalog.json: 조립체 ${a.name || a.id}의 재료 ${l.materialId}가 없습니다`);
  const typeIds = new Set(Object.keys(idx?.files?.unitTypes || {}));
  const container = (name, c) => {
    const walls = new Set((c.walls || []).map((w) => w.id));
    for (const w of c.walls || []) if (w.assemblyId && !asm.has(w.assemblyId)) errors.push(`${name}: 벽 ${w.code || w.id}의 조립체 ${w.assemblyId}가 없습니다`);
    for (const o of c.openings || []) if (!walls.has(o.wallId)) errors.push(`${name}: 문·창 ${o.typeCode || o.id}가 붙은 벽 ${o.wallId}가 없습니다`);
    for (const s of c.spaces || []) for (const k of ['floor', 'wall', 'ceiling']) if (s.finish?.[k] && !asm.has(s.finish[k])) errors.push(`${name}: 실 ${s.name}의 ${k} 마감 ${s.finish[k]}가 없습니다`);
  };
  for (const [name, f] of Object.entries(files)) {
    if (name.startsWith('u-')) container(name, f);
    if (name.startsWith('b-')) {
      const levels = new Set((f.levels || []).map((l) => l.id));
      for (const t of f.floorTemplates || []) {
        container(name, t);
        for (const l of t.levelIds || []) if (!levels.has(l)) errors.push(`${name}: 층 템플릿 ${t.name || t.id}의 레벨 ${l}이 없습니다`);
        for (const u of t.units || []) if (!typeIds.has(u.unitTypeId)) errors.push(`${name}: 배치의 세대 타입 ${u.unitTypeId}가 없습니다`);
      }
      for (const u of f.units || []) {
        if (!levels.has(u.levelId)) errors.push(`${name}: ${u.label}호의 층 ${u.levelId}이 없습니다`);
        if (!typeIds.has(u.unitTypeId)) errors.push(`${name}: ${u.label}호의 세대 타입 ${u.unitTypeId}가 없습니다`);
      }
    }
  }
  return errors;
}

/** 모델 요약(index.json summary) 다시 세기 — build.js와 같은 항목 */
export function summaryOf(files) {
  const site = files['site.json'] || { buildings: [] };
  const types = Object.entries(files).filter(([k]) => k.startsWith('u-')).map(([, v]) => v);
  const bld = Object.entries(files).filter(([k]) => k.startsWith('b-')).map(([, v]) => v);
  const len = (w) => Math.hypot(w.path[1][0] - w.path[0][0], w.path[1][1] - w.path[0][1]);
  const low = (x) => x.source?.method === 'assumed';
  return {
    buildings: site.buildings.length,
    apartments: site.buildings.filter((b) => b.kind === 'apartment').length,
    units: bld.reduce((a, b) => a + (b.units?.length || 0), 0),
    unitTypes: types.filter((t) => t.kind === 'unit').length,
    facilities: types.filter((t) => t.kind === 'facility').length,
    spaces: types.reduce((a, t) => a + t.spaces.length, 0),
    walls: types.reduce((a, t) => a + t.walls.length, 0),
    wallLengthM: Math.round(types.reduce((a, t) => a + t.walls.reduce((s, w) => s + len(w), 0), 0) * 1000) / 1000,
    lowConfidence: types.reduce((a, t) => a + t.walls.filter(low).length + t.spaces.filter(low).length, 0),
  };
}

/**
 * 수정 연산 적용. 원본은 그대로, 하나라도 틀리면 아무것도 적용하지 않는다.
 * @param {Record<string, any>} files 모델 파일 묶음
 * @param {any[]} ops
 * @param {{ method?: 'manual'|'ai'|'doc', reviewId?: string|null }} opts
 * @returns {{ ok: boolean, files: Record<string, any>|null, errors: string[], touched: string[], removed: string[], added: string[] }}
 */
// keepSource: 조립 중 판독값을 붙일 때처럼 고친 요소의 출처·신뢰도를 바꾸지 않는다(새 요소는 자기 출처를 가진다)
export function applyPatch(files, ops, { method = 'manual', reviewId = null, keepSource = false } = {}) {
  const errors = [];
  if (!Array.isArray(ops) || !ops.length) return { ok: false, files: null, errors: ['적용할 수정이 없습니다'], touched: [], removed: [], added: [] };
  ops.forEach((op, i) => { const e = opShape(op, i); if (e) errors.push(e); });
  if (errors.length) return { ok: false, files: null, errors, touched: [], removed: [], added: [] };
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k] = v; // 바꾸는 파일만 복사
  const copied = new Set();
  const fileOf = (name) => { if (!copied.has(name)) { out[name] = clone(out[name]); copied.add(name); } return out[name]; };
  const touched = new Set();
  const removed = new Set();
  const added = new Set();
  const mark = (obj, op) => {
    if (!isObj(obj) || keepSource) return;
    const src = isObj(obj.source) ? obj.source : {};
    const sheets = (op.evidence || []).filter((e) => e?.sheetId).map((e) => ({ sheetId: e.sheetId, sheetNo: e.sheetNo || '', ...(e.bbox ? { bbox: e.bbox } : {}) }));
    const docs = (op.evidence || []).filter((e) => e?.docId).map((e) => ({ docId: e.docId, docName: e.docName || '', page: e.page ?? null, ...(e.box ? { box: e.box } : {}) }));
    obj.source = { ...src, method, confidence: method === 'manual' ? 1 : Math.max(src.confidence ?? 0, 0.8), ...(sheets.length ? { sheets } : {}), ...(docs.length ? { docs } : {}), ...(reviewId ? { reviewId } : {}) };
  };
  ops.forEach((op, i) => {
    const at = `${i + 1}번 연산`;
    if (!files[op.file]) { errors.push(`${at}: 파일 ${op.file}이 모델에 없습니다`); return; }
    if (op.file === 'index.json') { errors.push(`${at}: index.json은 고칠 수 없습니다`); return; }
    const root = fileOf(op.file);
    if (op.op === 'update') {
      const hit = locateId(root, op.id);
      if (!hit) { errors.push(`${at}: ${op.file}에 id ${op.id}가 없습니다`); return; }
      for (const [p, v] of Object.entries(op.set)) setPath(hit.obj, p, v == null ? v : clone(v));
      if (!op.file.startsWith('catalog') || 'source' in hit.obj || op.evidence?.some((e) => e?.docId)) mark(hit.obj, op);
      touched.add(op.id);
    } else if (op.op === 'remove') {
      const hit = locateId(root, op.id);
      if (!hit) { errors.push(`${at}: ${op.file}에 id ${op.id}가 없습니다`); return; }
      if (!hit.list) { errors.push(`${at}: 파일 전체(${op.id})는 지울 수 없습니다`); return; }
      hit.list.splice(hit.index, 1);
      removed.add(op.id);
      // 벽을 지우면 그 벽의 문·창도 지운다
      if (Array.isArray(hit.owner?.openings)) {
        for (let k = hit.owner.openings.length - 1; k >= 0; k--) if (hit.owner.openings[k].wallId === op.id) { removed.add(hit.owner.openings[k].id); hit.owner.openings.splice(k, 1); }
      }
    } else {
      let owner = root;
      if (op.parentId) {
        const hit = locateId(root, op.parentId);
        if (!hit) { errors.push(`${at}: ${op.file}에 부모 id ${op.parentId}가 없습니다`); return; }
        owner = hit.obj;
      }
      if (!Array.isArray(owner[op.collection])) { errors.push(`${at}: ${op.collection} 목록이 없습니다`); return; }
      if (locateId(root, op.element.id)) { errors.push(`${at}: id ${op.element.id}가 이미 있습니다`); return; }
      const el = clone(op.element);
      if (!op.file.startsWith('catalog') || op.evidence?.some((e) => e?.docId)) mark(el, op);
      owner[op.collection].push(el);
      added.add(el.id);
    }
  });
  if (!errors.length) {
    // 같은 파일 안 id 겹침
    for (const name of copied) {
      const seen = new Set();
      const visit = (node) => {
        if (Array.isArray(node)) { for (const v of node) if (v && typeof v === 'object') { if (typeof v.id === 'string') { if (seen.has(v.id)) errors.push(`${name}: id ${v.id}가 두 번 있습니다`); seen.add(v.id); } visit(v); } return; }
        if (isObj(node)) for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
      };
      visit(out[name]);
    }
    const sub = Object.fromEntries([...copied].map((n) => [n, out[n]]));
    errors.push(...checkModelFiles(sub), ...checkRefs(out));
  }
  if (errors.length) return { ok: false, files: null, errors: [...new Set(errors)].slice(0, 30), touched: [], removed: [], added: [] };
  if (out['index.json']) out['index.json'] = { ...out['index.json'], summary: summaryOf(out) };
  return { ok: true, files: out, errors: [], touched: [...touched], removed: [...removed], added: [...added] };
}

// 비교할 때 자식 요소 목록은 빼고(따로 추가·삭제로 센다) 자기 값만
function ownKey(obj) {
  return JSON.stringify(obj, function (k, v) {
    if (k === '' || !v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.length && v.every((x) => x && typeof x === 'object' && typeof x.id === 'string') ? undefined : v;
    return v;
  });
}

/** 두 버전 비교(index.json 제외) → { added, removed, changed: [{ id, file }] } */
export function diffFiles(a, b) {
  const all = (files) => {
    const m = new Map();
    for (const [name, f] of Object.entries(files)) if (name !== 'index.json') for (const [id, o] of idsOf(f)) m.set(`${name}|${id}`, { id, file: name, key: ownKey(o) });
    return m;
  };
  const A = all(a);
  const B = all(b);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of B) { const p = A.get(k); if (!p) added.push({ id: v.id, file: v.file }); else if (p.key !== v.key) changed.push({ id: v.id, file: v.file }); }
  for (const [k, v] of A) if (!B.has(k)) removed.push({ id: v.id, file: v.file });
  return { added, removed, changed };
}

// ---------------------------------------------------------------- 사람이 읽는 연산 설명(수정안 미리보기·대화 요약)

const ZONE_KO = { waterproof: '방수', insulation: '단열', soundproof: '차음', fireproof: '내화' };
const PATH_LABEL = { 'finish.floor': '바닥 마감', 'finish.wall': '벽 마감', 'finish.ceiling': '천장 마감', assemblyId: '벽체 조립체', code: '기호', thickness: '두께', name: '이름', use: '용도', zones: '시공부위', width: '폭', height: '높이', sill: '창대 높이', typeCode: '기호', layers: '층 구성', unitTypeId: '세대 타입', label: '호수', line: '라인', elevation: '바닥 높이', path: '위치', sides: '실내·실외 쪽', kind: '종류', transform: '배치', footprint: '외곽', floorsAbove: '지상 층수' };

export function elementName(files, file, id) {
  const f = files[file];
  const o = f && locateId(f, id)?.obj;
  if (!o) return id;
  const owner = f.name ? `${f.name} ` : '';
  if (id.startsWith('w_')) return `${owner}벽 ${o.code || ''}`.trim();
  if (id.startsWith('op_')) return `${owner}${o.kind === 'window' ? '창' : '문'} ${o.typeCode || ''}`.trim();
  if (id.startsWith('sp_')) return `${owner}${o.name}`;
  if (id.startsWith('un_')) return `${f.name} ${o.label}호`;
  if (id.startsWith('lv_')) return `${f.name} ${o.name}`;
  if (file === 'catalog.json') return o.name || o.code || id;
  return o.name || o.label || id;
}

export function describeOp(files, op) {
  const asm = new Map((files['catalog.json']?.assemblies || []).map((a) => [a.id, a.name]));
  const show = (v) => (typeof v === 'string' && asm.has(v) ? asm.get(v) : Array.isArray(v) ? (v.every((x) => typeof x !== 'object') ? v.map((x) => ZONE_KO[x] || x).join(', ') || '(없음)' : `${v.length}개`) : v && typeof v === 'object' ? '…' : String(v));
  if (op.op === 'remove') return `${elementName(files, op.file, op.id)} 지우기`;
  if (op.op === 'add') return `${op.element?.name || op.element?.typeCode || op.element?.code || op.element?.id} 추가(${op.collection})`;
  const label = (p) => (p === 'height' && String(op.id).startsWith('lv_') ? '층고' : PATH_LABEL[p] || p);
  const sets = Object.entries(op.set || {}).map(([p, v]) => `${label(p)} → ${show(v)}`).join(', ');
  return `${elementName(files, op.file, op.id)}: ${sets}`;
}
