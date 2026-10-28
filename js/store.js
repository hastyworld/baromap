// 저장소. 화면은 이 모듈만 통해 데이터를 읽고 쓴다.
// 지금은 브라우저(localStorage)에 저장한다. v1.0에서 서버 저장으로 바꿀 때는
// 이 파일 안쪽(load/save/remove/importJson/clear)만 서버 API 호출로 바꾸면 된다. 함수는 이미 비동기다.

import { nextCell } from './model.js';

export const KINDS = { sites: '현장', lodgings: '숙소', residents: '거주자' };

// 기획안 "데이터 구조"의 필드 이름 그대로
export const FIELDS = {
  sites: ['name', 'address', 'lat', 'lng', 'client', 'overview', 'startDate', 'endDate', 'manager', 'phone', 'memo'],
  lodgings: ['siteId', 'name', 'address', 'addressDetail', 'lat', 'lng', 'type', 'capacity', 'leaseEnd', 'memo'],
  residents: ['lodgingId', 'name', 'rank', 'title', 'dept', 'phone', 'moveIn', 'memo'],
};

export const LODGING_TYPES = ['아파트', '오피스텔', '원룸', '빌라', '주택', '기숙사', '숙박업소', '기타'];

const STORAGE_KEY = 'baromap.data.v1';
const PROGRESS_KEY = 'baromap.progress.v1';
const FORMAT = 'baromap-v1';

export class ValidationError extends Error {}
const fail = (msg) => { throw new ValidationError(msg); };

// ---------------------------------------------------------------- 검증 (v1.0 서버에서도 같은 규칙을 쓴다)

const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

function date(v, label) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\.?$/.exec(String(v).trim());
  const iso = m && `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (!iso || Number.isNaN(Date.parse(iso))) fail(`${label}은(는) 2026-03-02 같은 날짜 형식으로 입력해주세요.`);
  return iso;
}

function int(v, label, min, max) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s명]/g, ''));
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label}은(는) ${min}~${max} 사이의 숫자로 입력해주세요.`);
  return n;
}

function coord(v, min, max) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n < min || n > max) {
    fail('위치가 지정되지 않았습니다. 주소를 검색하거나 지도에서 위치를 지정해주세요.');
  }
  return Math.round(n * 1e7) / 1e7;
}

const required = (v, label) => v || fail(`${label}을(를) 입력해주세요.`);

export function validate(kind, input, data) {
  const b = input || {};
  if (kind === 'sites') {
    const d = {
      name: required(str(b.name, 100), '현장명'),
      address: str(b.address, 200),
      lat: coord(b.lat, -90, 90),
      lng: coord(b.lng, -180, 180),
      client: str(b.client, 100),
      overview: str(b.overview, 5000),
      startDate: date(b.startDate, '착공일'),
      endDate: date(b.endDate, '준공 예정일'),
      manager: str(b.manager, 50),
      phone: str(b.phone, 30),
      memo: str(b.memo, 3000),
    };
    if (d.startDate && d.endDate && d.endDate < d.startDate) fail('준공 예정일이 착공일보다 빠릅니다.');
    return d;
  }
  if (kind === 'lodgings') {
    const siteId = str(b.siteId, 40);
    if (!siteId || !data.sites.some((s) => s.id === siteId)) fail('숙소가 속할 현장을 선택해주세요.');
    return {
      siteId,
      name: required(str(b.name, 100), '숙소명'),
      address: str(b.address, 200),
      addressDetail: str(b.addressDetail, 100),
      lat: coord(b.lat, -90, 90),
      lng: coord(b.lng, -180, 180),
      type: str(b.type, 20),
      capacity: int(b.capacity, '정원', 0, 999),
      leaseEnd: date(b.leaseEnd, '계약 종료일'),
      memo: str(b.memo, 3000),
    };
  }
  if (kind === 'residents') {
    const lodgingId = str(b.lodgingId, 40);
    if (!lodgingId || !data.lodgings.some((l) => l.id === lodgingId)) fail('거주할 숙소를 선택해주세요.');
    return {
      lodgingId,
      name: required(str(b.name, 50), '이름'),
      rank: str(b.rank, 30),
      title: str(b.title, 30),
      dept: str(b.dept, 50),
      phone: str(b.phone, 30),
      moveIn: date(b.moveIn, '입주일'),
      memo: str(b.memo, 1000),
    };
  }
  // 현장 360° 사진의 정보(원본 파일은 저장소가 따로 보관). 미리보기(thumb)는 작은 data:image 주소.
  if (kind === 'sitePhotos') {
    const siteId = str(b.siteId, 40);
    if (!siteId || !data.sites.some((s) => s.id === siteId)) fail('사진을 올릴 현장을 선택해주세요.');
    const thumb = b.thumb == null ? '' : String(b.thumb);
    if (thumb && (!/^data:image\/(jpeg|png|webp);base64,/.test(thumb) || thumb.length > 200000)) fail('미리보기 이미지가 올바르지 않습니다.');
    return {
      siteId,
      takenAt: date(b.takenAt, '촬영일'),
      caption: str(b.caption, 100),
      thumb,
      width: int(b.width, '사진 너비', 1, 20000),
      height: int(b.height, '사진 높이', 1, 20000),
    };
  }
  // 골구도의 동: 라인마다 층 범위(시작층~최고층)
  if (kind === 'siteBuildings') {
    const siteId = str(b.siteId, 40);
    if (!siteId || !data.sites.some((s) => s.id === siteId)) fail('동을 만들 현장을 선택해주세요.');
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) fail('라인을 하나 이상 넣어주세요.');
    if (lines.length > 30) fail('라인은 30개까지 넣을 수 있습니다.');
    const seen = new Set();
    const clean = lines.map((ln, i) => {
      const name = str(ln?.name, 10).replace(/호$/, '');
      if (!name) fail(`${i + 1}번째 라인 이름을 입력해주세요.`);
      if (seen.has(name)) fail(`라인 이름 "${name}"이(가) 겹칩니다.`);
      seen.add(name);
      const from = int(ln?.from, `${name}호 라인 시작층`, 1, 99) ?? 1;
      const to = int(ln?.to, `${name}호 라인 최고층`, 1, 99);
      if (to == null) fail(`${name}호 라인의 최고층을 입력해주세요.`);
      if (to < from) fail(`${name}호 라인의 최고층이 시작층보다 낮습니다.`);
      return { name, from, to };
    });
    return { siteId, name: required(str(b.name, 30), '동 이름'), sort: int(b.sort, '순서', -9999, 9999) ?? 0, lines: clean };
  }
  // 공종 시트: 순서대로 진행하는 공종(1번부터)과 색
  if (kind === 'progressSheets') {
    const siteId = str(b.siteId, 40);
    if (!siteId || !data.sites.some((s) => s.id === siteId)) fail('시트를 만들 현장을 선택해주세요.');
    const trades = (Array.isArray(b.trades) ? b.trades : []).filter((t) => str(t?.name, 30));
    if (!trades.length) fail('공종을 하나 이상 넣어주세요.');
    if (trades.length > 40) fail('공종은 시트 하나에 40개까지 넣을 수 있습니다.');
    return {
      siteId,
      name: required(str(b.name, 30), '시트 이름'),
      sort: int(b.sort, '순서', -9999, 9999) ?? 0,
      trades: trades.map((t) => {
        const color = String(t.color || '').trim();
        if (!/^#[0-9a-f]{6}$/i.test(color)) fail(`"${str(t.name, 30)}" 공종의 색이 올바르지 않습니다.`);
        return { name: str(t.name, 30), color: color.toUpperCase() };
      }),
    };
  }
  // 도면에서 만든 3D 모델 정보(모양 데이터는 저장소가 따로 보관)
  if (kind === 'siteModels') {
    const siteId = str(b.siteId, 40);
    if (!siteId || !data.sites.some((s) => s.id === siteId)) fail('모델을 만들 현장을 선택해주세요.');
    const kindV = b.kind === 'unit' ? 'unit' : 'building';
    const h = Number(b.floorHeight ?? 2.9);
    if (!Number.isFinite(h) || h < 2 || h > 10) fail('층고는 2~10m 사이로 입력해주세요.');
    const thumb = b.thumb == null ? '' : String(b.thumb);
    if (thumb && (!/^data:image\/(jpeg|png|webp);base64,/.test(thumb) || thumb.length > 200000)) fail('미리보기 이미지가 올바르지 않습니다.');
    const stats = b.stats && typeof b.stats === 'object' ? b.stats : {};
    if (JSON.stringify(stats).length > 5000) fail('모델 정보가 너무 큽니다.');
    return {
      siteId,
      kind: kindV,
      name: required(str(b.name, 30), '모델 이름'),
      buildingId: str(b.buildingId, 40) || null,
      floors: kindV === 'unit' ? 1 : int(b.floors, '층수', 1, 99) ?? 1,
      floorHeight: Math.round(h * 100) / 100,
      thumb,
      stats,
    };
  }
  throw new Error(`알 수 없는 종류: ${kind}`);
}

// 3D 모양 데이터(dxf.js packGeometry 결과) 확인
export function validateGeometry(g) {
  const ok = g && g.v === 1 && Array.isArray(g.walls) && Array.isArray(g.glass) && Array.isArray(g.solids) && Array.isArray(g.floor);
  if (!ok) fail('3D 모델 데이터가 올바르지 않습니다.');
  if (!g.walls.length && !g.solids.length) fail('벽·기둥으로 세울 선이 없습니다. 벽·기둥 레이어를 골라주세요.');
  const json = JSON.stringify(g);
  if (json.length > 15 * 1024 * 1024) fail('도면 선이 너무 많아 저장할 수 없습니다. 벽·기둥 레이어만 골라주세요.');
  return json;
}

// 골구도 칸 입력 검증: 그 동에 있는 세대인지, 그 시트에 있는 공종 번호인지
// changes: [{ buildingId, unit, step }] → 같은 형태로 돌려준다. date는 작업일(빈 값 허용)
export function validateCells(sheet, buildings, changes, date) {
  if (!sheet) fail('공종 시트를 찾을 수 없습니다.');
  const workDate = date ? (() => { const d = String(date).trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail('작업일은 2026-03-02 같은 형식으로 입력해주세요.'); return d; })() : '';
  const max = sheet.trades.length;
  const out = (changes || []).map((c) => {
    const b = buildings.find((x) => x.id === c.buildingId);
    if (!b) fail('동을 찾을 수 없습니다. 화면을 새로 고쳐주세요.');
    const m = /^(-?\d{1,2}):(.{1,10})$/.exec(String(c.unit || ''));
    const ln = m && b.lines.find((l) => l.name === m[2]);
    if (!ln || Number(m[1]) < ln.from || Number(m[1]) > ln.to) fail(`${b.name}에 없는 세대입니다.`);
    const step = Number(c.step);
    if (!Number.isInteger(step) || step < 0 || step > max) fail(`공종 번호는 0~${max} 사이로 입력해주세요.`);
    return { buildingId: b.id, unit: c.unit, step };
  });
  if (!out.length) fail('세대를 먼저 골라주세요.');
  return { changes: out, date: workDate };
}

// ---------------------------------------------------------------- 저장소

const empty = () => ({ format: FORMAT, sample: false, sites: [], lodgings: [], residents: [] });
const ID_PREFIX = { sites: 's_', lodgings: 'l_', residents: 'r_', sitePhotos: 'p_', siteBuildings: 'b_', progressSheets: 'h_', siteModels: 'm_' };
export const newId = (kind) => `${ID_PREFIX[kind] || 'x_'}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const clone = (x) => JSON.parse(JSON.stringify(x));

// 사진 목록 순서: 최근 촬영일 먼저(날짜 없는 사진은 뒤), 같은 날이면 나중에 올린 것 먼저
export const byTaken = (a, b) => (b.takenAt ? 1 : 0) - (a.takenAt ? 1 : 0)
  || String(b.takenAt || '').localeCompare(String(a.takenAt || ''))
  || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

// ---------------------------------------------------------------- 공정 현황(골구도) 공통

const bySort = (a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name), 'ko', { numeric: true });

// 현장 하나의 공정 현황: { buildings, sheets, cells: { [sheetId]: { [buildingId]: { [unit]: { step, dates, updatedAt } } } } }
export function progressCache(buildings, sheets, rows) {
  const cells = {};
  for (const r of rows) ((cells[r.sheetId] ||= {})[r.buildingId] ||= {})[r.unit] = { step: r.step, dates: r.dates || {}, updatedAt: r.updatedAt };
  return { buildings: [...buildings].sort(bySort), sheets: [...sheets].sort(bySort), cells };
}

// 칸 입력을 저장할 행(올릴 것·지울 것)으로 바꾼다. 같은 값이면 건너뛴다.
export function cellWrites(cache, sheetId, siteId, changes, date) {
  const upserts = [];
  const deletes = [];
  for (const c of changes) {
    const prev = cache.cells[sheetId]?.[c.buildingId]?.[c.unit];
    const next = nextCell(prev, c.step, date);
    if (c.step === 0) {
      if (prev) deletes.push({ buildingId: c.buildingId, unit: c.unit });
    } else if (!prev || prev.step !== next.step || JSON.stringify(prev.dates) !== JSON.stringify(next.dates)) {
      upserts.push({ sheetId, buildingId: c.buildingId, unit: c.unit, siteId, step: next.step, dates: next.dates });
    }
  }
  return { upserts, deletes };
}

export function applyCellWrites(cache, sheetId, { upserts, deletes }, stamp) {
  for (const r of upserts) ((cache.cells[sheetId] ||= {})[r.buildingId] ||= {})[r.unit] = { step: r.step, dates: r.dates, updatedAt: stamp };
  for (const d of deletes) delete cache.cells[sheetId]?.[d.buildingId]?.[d.unit];
}

// ---------------------------------------------------------------- 현장 사진 보관 (브라우저 저장 모드)
// 사진 원본·3D 모양 데이터는 커서 localStorage 대신 IndexedDB에 둔다. IndexedDB가 없으면(Node 테스트) 메모리.

export function memoryPhotoBackend() {
  const m = new Map();
  return {
    async all() { return [...m.values()]; },
    async get(id) { return m.get(id) || null; },
    async put(rec) { m.set(rec.id, rec); },
    async del(ids) { for (const id of ids) m.delete(id); },
  };
}

function idbBackend(dbName, storeName) {
  let opened = null;
  const open = () => (opened ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(storeName, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('브라우저 보관소 오류'));
    });
  };
  return {
    all: () => run('readonly', (s) => s.getAll()),
    get: async (id) => (await run('readonly', (s) => s.get(id))) || null,
    put: (rec) => run('readwrite', (s) => s.put(rec)),
    del: (ids) => run('readwrite', (s) => { for (const id of ids) s.delete(id); }),
  };
}

// 외부 데이터(JSON 파일 등)를 검증해 저장 형태로 바꾼다. 참조가 끊긴 레코드는 오류로 돌려준다.
export function normalizeData(obj, stamp = new Date().toISOString()) {
  if (!obj || typeof obj !== 'object') fail('바로맵 데이터 파일이 아닙니다.');
  for (const k of Object.keys(KINDS)) if (!Array.isArray(obj[k])) fail('바로맵 데이터 파일이 아닙니다. (sites·lodgings·residents 목록이 없음)');
  const out = { ...empty(), sample: Boolean(obj.sample) };
  for (const kind of Object.keys(KINDS)) {
    const seen = new Set();
    for (const [i, rec] of obj[kind].entries()) {
      let clean;
      try {
        clean = validate(kind, rec, out);
      } catch (err) {
        fail(`${KINDS[kind]} ${i + 1}번째 항목: ${err.message}`);
      }
      let id = str(rec.id, 40) || newId(kind);
      if (seen.has(id)) id = newId(kind);
      seen.add(id);
      out[kind].push({ id, ...clean, createdAt: rec.createdAt || stamp, updatedAt: rec.updatedAt || stamp });
    }
  }
  return out;
}

/**
 * 설정에 Supabase 주소·키가 있으면 공유 저장소, 없으면 브라우저 저장소를 연다. 두 저장소는 같은 API를 가진다.
 * @param {{ supabaseUrl?: string, supabaseAnonKey?: string }} cfg
 */
export async function openStore(cfg = {}, opts = {}) {
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    const { createRemoteStore } = await import('./store-remote.js');
    return createRemoteStore({ url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey, ...opts });
  }
  return createStore(opts);
}

/**
 * @param {{ storage?: Storage, now?: () => Date, photoBackend?: ReturnType<typeof memoryPhotoBackend>, modelBackend?: ReturnType<typeof memoryPhotoBackend> }} [opts]
 */
export function createStore({ storage = globalThis.localStorage, now = () => new Date(), photoBackend, modelBackend } = {}) {
  let data = empty();
  const listeners = new Set();
  const photoDb = photoBackend || (globalThis.indexedDB ? idbBackend('baromap-photos', 'photos') : memoryPhotoBackend());
  const photoCache = new Map(); // siteId → 사진 정보 목록(원본 제외)
  const modelDb = modelBackend || (globalThis.indexedDB ? idbBackend('baromap-models', 'models') : memoryPhotoBackend());
  const modelCache = new Map(); // siteId → 3D 모델 정보 목록(모양 데이터 제외)

  const notify = () => { for (const fn of listeners) fn(); };

  function persist() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      throw new Error('브라우저 저장 공간이 부족해 저장하지 못했습니다. 데이터를 파일로 내보낸 뒤 정리해주세요.');
    }
    notify();
  }

  // 공정 현황(골구도)은 따로 보관한다: { buildings: [], sheets: [], cells: [{ sheetId, buildingId, unit, siteId, step, dates }] }
  let prog = null;
  const progCache = new Map(); // siteId → progressCache(...)
  function progData() {
    if (!prog) {
      try { prog = JSON.parse(storage.getItem(PROGRESS_KEY)); } catch { prog = null; }
      if (!prog || !Array.isArray(prog.buildings) || !Array.isArray(prog.sheets) || !Array.isArray(prog.cells)) prog = { buildings: [], sheets: [], cells: [] };
    }
    return prog;
  }
  function progSave(next = prog) {
    prog = next || { buildings: [], sheets: [], cells: [] };
    try {
      storage.setItem(PROGRESS_KEY, JSON.stringify(prog));
    } catch {
      throw new Error('브라우저 저장 공간이 부족해 공정 현황을 저장하지 못했습니다.');
    }
    progCache.clear();
    notify();
  }
  const progSite = (siteId) => {
    if (!progCache.has(siteId)) {
      const p = progData();
      progCache.set(siteId, progressCache(p.buildings.filter((b) => b.siteId === siteId), p.sheets.filter((h) => h.siteId === siteId), p.cells.filter((c) => c.siteId === siteId)));
    }
    return progCache.get(siteId);
  };

  // 현장이 없어진 사진(원본까지)·공정 현황은 지운다(현장 삭제·전체 삭제·파일 가져오기 뒤).
  async function pruneOrphans() {
    const live = new Set(data.sites.map((s) => s.id));
    const p = progData();
    if ([...p.buildings, ...p.sheets, ...p.cells].some((x) => !live.has(x.siteId))) {
      progSave({ buildings: p.buildings.filter((x) => live.has(x.siteId)), sheets: p.sheets.filter((x) => live.has(x.siteId)), cells: p.cells.filter((x) => live.has(x.siteId)) });
    }
    for (const [db, cache] of [[photoDb, photoCache], [modelDb, modelCache]]) {
      try {
        const all = await db.all();
        const gone = all.filter((x) => !live.has(x.siteId)).map((x) => x.id);
        if (gone.length) await db.del(gone);
        for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
      } catch { /* 정리 실패는 다음에 다시 시도된다 */ }
    }
  }

  // 동·공종 시트 저장(새로 만들기·고치기)
  function saveProgressMeta(list, kind, input) {
    const clean = validate(kind, input, data);
    const p = progData();
    const stamp = now().toISOString();
    const items = p[list];
    const i = input.id ? items.findIndex((x) => x.id === input.id) : -1;
    const rec = i >= 0 ? { ...items[i], ...clean, updatedAt: stamp } : { id: newId(kind), ...clean, createdAt: stamp, updatedAt: stamp };
    progSave({ ...p, [list]: i >= 0 ? items.map((x, j) => (j === i ? rec : x)) : [...items, rec] });
    return clone(rec);
  }

  // 예시 데이터에 공정 현황이 있으면 함께 넣는다
  function useSample(sample) {
    data = normalize({ ...sample, sample: true });
    persist();
    if (sample.progress) progSave(clone(sample.progress));
  }

  const normalize = (obj) => normalizeData(obj, now().toISOString());

  const store = {
    KINDS,
    mode: 'local',
    status: 'local',
    // 브라우저 저장 모드는 이 기기 사용자 한 명이므로 모든 작업을 허용한다.
    me: { id: 'local', name: '이 브라우저', email: '', role: 'admin', siteIds: [] },
    can: () => true,
    auth: null,
    users: null,
    audit: null,
    async refresh() {},

    async load({ sampleFactory } = {}) {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          data = normalize(JSON.parse(raw));
          return store.snapshot();
        } catch (err) {
          // 손상된 데이터는 지우지 않고 따로 보관한 뒤 새로 시작한다.
          storage.setItem(`${STORAGE_KEY}.broken.${Date.now()}`, raw);
          console.warn('[store] 저장된 데이터를 읽지 못했습니다.', err);
        }
      }
      if (sampleFactory) useSample(sampleFactory(now()));
      else {
        data = empty();
        persist();
      }
      return store.snapshot();
    },

    snapshot() {
      return clone({ sites: data.sites, lodgings: data.lodgings, residents: data.residents });
    },

    get isSample() {
      return data.sample;
    },

    async save(kind, input) {
      const clean = validate(kind, input, data);
      const stamp = now().toISOString();
      const list = data[kind];
      const i = input.id ? list.findIndex((r) => r.id === input.id) : -1;
      let rec;
      if (i >= 0) {
        rec = { ...list[i], ...clean, updatedAt: stamp };
        list[i] = rec;
      } else {
        rec = { id: newId(kind), ...clean, createdAt: stamp, updatedAt: stamp };
        list.push(rec);
      }
      persist();
      return clone(rec);
    },

    // 현장을 지우면 그 숙소와 거주자, 숙소를 지우면 그 거주자까지 함께 지운다.
    async remove(kind, id) {
      const removed = { sites: 0, lodgings: 0, residents: 0 };
      let siteIds = [];
      let lodgingIds = [];
      if (kind === 'sites') siteIds = [id];
      if (kind === 'lodgings') lodgingIds = [id];
      if (kind === 'residents') {
        const before = data.residents.length;
        data.residents = data.residents.filter((r) => r.id !== id);
        removed.residents = before - data.residents.length;
      }
      if (siteIds.length) {
        lodgingIds = data.lodgings.filter((l) => siteIds.includes(l.siteId)).map((l) => l.id);
        const before = data.sites.length;
        data.sites = data.sites.filter((s) => !siteIds.includes(s.id));
        removed.sites = before - data.sites.length;
      }
      if (lodgingIds.length) {
        const lb = data.lodgings.length;
        data.lodgings = data.lodgings.filter((l) => !lodgingIds.includes(l.id));
        removed.lodgings = lb - data.lodgings.length;
        const rb = data.residents.length;
        data.residents = data.residents.filter((r) => !lodgingIds.includes(r.lodgingId));
        removed.residents = rb - data.residents.length;
      }
      persist();
      if (siteIds.length) await pruneOrphans();
      return removed;
    },

    exportJson() {
      return { format: FORMAT, exportedAt: now().toISOString(), ...store.snapshot() };
    },

    // 파일 전체로 교체한다(검증을 모두 통과해야 반영).
    async importJson(obj) {
      if (obj?.format && obj.format !== FORMAT) fail('다른 형식의 파일입니다. 바로맵에서 내보낸 JSON 파일을 선택해주세요.');
      data = normalize({ ...obj, sample: false });
      persist();
      await pruneOrphans();
      return { sites: data.sites.length, lodgings: data.lodgings.length, residents: data.residents.length };
    },

    async clear() {
      data = empty();
      persist();
      await pruneOrphans();
    },

    async resetSample(sampleFactory) {
      progSave({ buildings: [], sheets: [], cells: [] });
      useSample(sampleFactory(now()));
      await pruneOrphans();
    },

    // 공정 현황(골구도). 브라우저 저장 모드는 바로 읽을 수 있어 load()가 따로 필요 없다.
    progress: {
      cached: (siteId) => clone(progSite(siteId)),
      async load(siteId) { return clone(progSite(siteId)); },

      async saveBuilding(input) { return saveProgressMeta('buildings', 'siteBuildings', input); },
      async saveSheet(input) { return saveProgressMeta('sheets', 'progressSheets', input); },

      async removeBuilding(id) {
        const p = progData();
        progSave({ ...p, buildings: p.buildings.filter((b) => b.id !== id), cells: p.cells.filter((c) => c.buildingId !== id) });
      },
      async removeSheet(id) {
        const p = progData();
        progSave({ ...p, sheets: p.sheets.filter((h) => h.id !== id), cells: p.cells.filter((c) => c.sheetId !== id) });
      },

      // changes: [{ buildingId, unit, step }] — step 0은 지우기. date는 작업일.
      async setCells(sheetId, changes, date) {
        const p = progData();
        const sheet = p.sheets.find((h) => h.id === sheetId);
        const cache = progSite(sheet?.siteId);
        const v = validateCells(sheet, cache.buildings, changes, date);
        const w = cellWrites(cache, sheetId, sheet.siteId, v.changes, v.date);
        if (!w.upserts.length && !w.deletes.length) return 0;
        const stamp = now().toISOString();
        const key = (c) => `${c.sheetId}|${c.buildingId}|${c.unit}`;
        const drop = new Set([...w.upserts, ...w.deletes.map((d) => ({ ...d, sheetId }))].map(key));
        progSave({ ...p, cells: [...p.cells.filter((c) => !drop.has(key(c))), ...w.upserts.map((r) => ({ ...r, updatedAt: stamp }))] });
        return w.upserts.length + w.deletes.length;
      },
    },

    // 도면에서 만든 3D 모델. 목록은 list(), 모양 데이터는 볼 때 geometry()로 읽는다.
    models: {
      cached: (siteId) => (modelCache.has(siteId) ? clone(modelCache.get(siteId)) : undefined),

      async list(siteId) {
        const all = await modelDb.all();
        const list = all.filter((x) => x.siteId === siteId).map(({ geometry, ...m }) => m).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        modelCache.set(siteId, list);
        notify();
        return clone(list);
      },

      // input: { siteId, kind, name, buildingId, floors, floorHeight, thumb, stats, geometry }
      async add(input) {
        const clean = validate('siteModels', input, data);
        validateGeometry(input.geometry);
        const stamp = now().toISOString();
        const rec = { id: newId('siteModels'), ...clean, createdAt: stamp, updatedAt: stamp };
        try {
          await modelDb.put({ ...rec, geometry: input.geometry });
        } catch {
          throw new Error('브라우저 저장 공간이 부족해 3D 모델을 저장하지 못했습니다.');
        }
        modelCache.set(clean.siteId, [...(modelCache.get(clean.siteId) || []), rec]);
        notify();
        return clone(rec);
      },

      async remove(id) {
        await modelDb.del([id]);
        for (const [siteId, list] of modelCache) modelCache.set(siteId, list.filter((m) => m.id !== id));
        notify();
      },

      async geometry(model) {
        const rec = await modelDb.get(model.id);
        if (!rec?.geometry) throw new Error('3D 모델 데이터를 찾지 못했습니다.');
        return rec.geometry;
      },
    },

    // 현장 360° 사진. 목록은 현장을 열 때 list()로 받아 두고, 화면은 cached()로 읽는다.
    photos: {
      cached: (siteId) => (photoCache.has(siteId) ? clone(photoCache.get(siteId)) : undefined),

      async list(siteId) {
        const all = await photoDb.all();
        const list = all.filter((p) => p.siteId === siteId).map(({ blob, ...p }) => p).sort(byTaken);
        photoCache.set(siteId, list);
        notify();
        return clone(list);
      },

      // input: { siteId, file(Blob), thumb, width, height, takenAt, caption }
      async add(input) {
        const clean = validate('sitePhotos', input, data);
        if (!(input.file instanceof Blob)) fail('사진 파일을 선택해주세요.');
        const stamp = now().toISOString();
        const rec = { id: newId('sitePhotos'), ...clean, createdAt: stamp, updatedAt: stamp };
        try {
          await photoDb.put({ ...rec, blob: input.file });
        } catch {
          throw new Error('브라우저 저장 공간이 부족해 사진을 저장하지 못했습니다.');
        }
        photoCache.set(clean.siteId, [...(photoCache.get(clean.siteId) || []), rec].sort(byTaken));
        notify();
        return clone(rec);
      },

      async remove(id) {
        await photoDb.del([id]);
        for (const [siteId, list] of photoCache) photoCache.set(siteId, list.filter((p) => p.id !== id));
        notify();
      },

      // 원본을 볼 주소. 다 보면 URL.revokeObjectURL로 풀어준다.
      async url(photo) {
        const rec = await photoDb.get(photo.id);
        if (!rec?.blob) throw new Error('사진 파일을 찾지 못했습니다.');
        return URL.createObjectURL(rec.blob);
      },
    },

    // 예시 데이터 표시를 끈다(사용자가 자기 데이터를 쓰기 시작했을 때).
    async markReal() {
      if (!data.sample) return;
      data.sample = false;
      persist();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return store;
}
