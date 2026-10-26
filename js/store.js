// 저장소. 화면은 이 모듈만 통해 데이터를 읽고 쓴다.
// 지금은 브라우저(localStorage)에 저장한다. v1.0에서 서버 저장으로 바꿀 때는
// 이 파일 안쪽(load/save/remove/importJson/clear)만 서버 API 호출로 바꾸면 된다. 함수는 이미 비동기다.

export const KINDS = { sites: '현장', lodgings: '숙소', residents: '거주자' };

// 기획안 "데이터 구조"의 필드 이름 그대로
export const FIELDS = {
  sites: ['name', 'address', 'lat', 'lng', 'client', 'overview', 'startDate', 'endDate', 'manager', 'phone', 'memo'],
  lodgings: ['siteId', 'name', 'address', 'addressDetail', 'lat', 'lng', 'type', 'capacity', 'leaseEnd', 'memo'],
  residents: ['lodgingId', 'name', 'rank', 'title', 'dept', 'phone', 'moveIn', 'memo'],
};

export const LODGING_TYPES = ['아파트', '오피스텔', '원룸', '빌라', '주택', '기숙사', '숙박업소', '기타'];

const STORAGE_KEY = 'baromap.data.v1';
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
  throw new Error(`알 수 없는 종류: ${kind}`);
}

// ---------------------------------------------------------------- 저장소

const empty = () => ({ format: FORMAT, sample: false, sites: [], lodgings: [], residents: [] });
const ID_PREFIX = { sites: 's_', lodgings: 'l_', residents: 'r_', sitePhotos: 'p_' };
export const newId = (kind) => `${ID_PREFIX[kind] || 'x_'}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const clone = (x) => JSON.parse(JSON.stringify(x));

// 사진 목록 순서: 최근 촬영일 먼저(날짜 없는 사진은 뒤), 같은 날이면 나중에 올린 것 먼저
export const byTaken = (a, b) => (b.takenAt ? 1 : 0) - (a.takenAt ? 1 : 0)
  || String(b.takenAt || '').localeCompare(String(a.takenAt || ''))
  || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

// ---------------------------------------------------------------- 현장 사진 보관 (브라우저 저장 모드)
// 사진 원본은 커서 localStorage 대신 IndexedDB에 둔다. IndexedDB가 없으면(Node 테스트) 메모리.

export function memoryPhotoBackend() {
  const m = new Map();
  return {
    async all() { return [...m.values()]; },
    async get(id) { return m.get(id) || null; },
    async put(rec) { m.set(rec.id, rec); },
    async del(ids) { for (const id of ids) m.delete(id); },
  };
}

function idbPhotoBackend() {
  let opened = null;
  const open = () => (opened ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('baromap-photos', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('photos', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const req = fn(tx.objectStore('photos'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('사진 보관소 오류'));
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
 * @param {{ storage?: Storage, now?: () => Date, photoBackend?: ReturnType<typeof memoryPhotoBackend> }} [opts]
 */
export function createStore({ storage = globalThis.localStorage, now = () => new Date(), photoBackend } = {}) {
  let data = empty();
  const listeners = new Set();
  const photoDb = photoBackend || (globalThis.indexedDB ? idbPhotoBackend() : memoryPhotoBackend());
  const photoCache = new Map(); // siteId → 사진 정보 목록(원본 제외)

  const notify = () => { for (const fn of listeners) fn(); };

  function persist() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      throw new Error('브라우저 저장 공간이 부족해 저장하지 못했습니다. 데이터를 파일로 내보낸 뒤 정리해주세요.');
    }
    notify();
  }

  // 현장이 없어진 사진(현장 삭제·전체 삭제·파일 가져오기 뒤)은 원본까지 지운다.
  async function prunePhotos() {
    try {
      const live = new Set(data.sites.map((s) => s.id));
      const all = await photoDb.all();
      const gone = all.filter((p) => !live.has(p.siteId)).map((p) => p.id);
      if (gone.length) await photoDb.del(gone);
      for (const id of photoCache.keys()) if (!live.has(id)) photoCache.delete(id);
    } catch { /* 정리 실패는 다음에 다시 시도된다 */ }
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
      data = sampleFactory ? normalize({ ...sampleFactory(now()), sample: true }) : empty();
      persist();
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
      if (siteIds.length) await prunePhotos();
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
      await prunePhotos();
      return { sites: data.sites.length, lodgings: data.lodgings.length, residents: data.residents.length };
    },

    async clear() {
      data = empty();
      persist();
      await prunePhotos();
    },

    async resetSample(sampleFactory) {
      data = normalize({ ...sampleFactory(now()), sample: true });
      persist();
      await prunePhotos();
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
