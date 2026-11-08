// 현장 운영(v0.6) 저장소. 브라우저 저장(데모, IndexedDB)과 공유(Supabase)가 같은 비동기 API를 가진다(10 지시서 10절).
//   store.rows(kind)  기록 읽기·쓰기(kind 목록은 js/ops/kinds.js)
//   store.ops         운영 설정(회사 기본값 + 현장 값)      store.files    첨부(비공개 저장 공간)
//   store.weather     현장 날씨                             store.daily    일보 결재
//   store.outbox      오프라인 입력 대기열(공유 모드)
// 권한은 공유 모드에서 DB의 RLS·트리거가 최종 판단한다(supabase/schema.sql). 검증 규칙은 store.js의 validate() 한 곳.
import { validate, newId, clone } from './store.js';
import { OPS_KINDS, OFFLINE_KINDS, FILE_FOLDERS, kindOfTable } from './ops/kinds.js';
import { validateSettings } from './ops/rules.js';
import { createOutbox } from './ops/outbox.js';
import { dailyTransition } from './ops/calc/flow.js';
import { fakeWeather, weatherNotices, kstDate } from './ops/calc/weather.js';
import { scheduleStats } from './ops/schedule/core.js';
import { PUBLIC_SOURCES, FRESH_MS, parsePermit, parseRegister, queryOfPnu } from './ops/calc/public-data.js';

export const OPS_BUCKETS = { files: 'site-files', people: 'site-people-files', docs: 'site-docs', schedules: 'site-schedules' };
const SCHEDULE_MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', xml: 'application/xml', xer: 'text/plain', csv: 'text/csv', pdf: 'application/pdf' };

// 공휴일·현장 휴무 기본값(고칠 수 있다). 제헌절은 2026년부터 다시 공휴일, 대체공휴일 포함
const HOLIDAYS = ['2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01', '2026-05-05', '2026-05-25', '2026-06-03', '2026-07-17', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26', '2026-10-05', '2026-10-09', '2026-12-25',
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-01', '2027-05-01', '2027-05-05', '2027-05-13', '2027-07-17', '2027-08-16', '2027-09-14', '2027-09-15', '2027-09-16', '2027-10-04', '2027-10-11', '2027-12-27'];

export const DEFAULT_OPS = {
  heat: { caution: 31, rest: 33, danger: 35, restEveryMin: 120, restMin: 20 },
  cold: { caution: -10, danger: -15, windChill: true },
  workdays: [1, 2, 3, 4, 5, 6],
  holidays: HOLIDAYS,
  rainStopMm: 5,
  daily: { steps: 1, form: '' },
  languages: ['ko'],
  qrEnabled: false,
  qrTokenHash: '',
  reportLimitPerHour: 30,
  handoverDate: '',
  phrases: null,
  blurFaces: true,
  // 성능 기준값(20 지시서 6절): { window: { 지역: { direct, indirect } } }. 고시 원문을 확인한 값만 넣는다. 비어 있으면 기준 검사를 하지 않는다
  standards: null,
  climateZone: '',
  // 수량 산출 기준(23 지시서 2절). 비어 있으면 기본값으로 계산하고 화면에 "회사 산출 기준 미설정"
  takeoff: null,
  extra: {},
};

// 회사 기본값(global) 위에 현장 값을 얹는다. 현장 줄의 null은 "회사 기본값을 쓴다"
export function mergeSettings(global, site) {
  const out = { ...DEFAULT_OPS };
  for (const src of [global, site]) {
    for (const [k, v] of Object.entries(src || {})) {
      if (v == null || !(k in DEFAULT_OPS)) continue;
      if (src === site && k === 'phrases') continue; // 문구 검수는 회사 공통 값만
      out[k] = v;
    }
  }
  return out;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'text/csv': 'csv' };
const bucketOf = (item, people) => (item?.people || people ? OPS_BUCKETS.people : OPS_BUCKETS.files);
const pathOf = (item) => (typeof item === 'string' ? item : item?.path);
const rand = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const today = (now) => kstDate(now());
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const DOC_MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const docPage = (doc, n) => `${doc.siteId}/${doc.id}/p${n}.png`;
const docText = (doc) => `${doc.siteId}/${doc.id}/text.json`;

// 두 저장 방식이 공유하는 API. be = 저장 방식별로 다른 부분
function buildApi(be) {
  const subs = new Map(); // kind → Set<{ siteId, cb }>
  const fire = (kind, siteId) => {
    for (const s of subs.get(kind) || []) if (!s.siteId || !siteId || s.siteId === siteId) s.cb();
    if (kind === 'notices') be.notify();
  };

  const rows = (kind) => {
    if (!OPS_KINDS[kind]) throw new Error(`알 수 없는 기록 종류: ${kind}`);
    return {
      list: (q = {}) => be.select(kind, q),
      get: (id) => be.one(kind, id),
      async save(row) {
        const clean = validate(kind, row, be.data());
        const rec = await be.put(kind, { id: row.id || newId(kind), ...clean }, row);
        fire(kind, rec.siteId);
        return rec;
      },
      async remove(id) {
        const prev = await be.one(kind, id);
        await be.remove(kind, id, prev);
        fire(kind, prev?.siteId);
      },
      subscribe(siteId, cb) {
        const entry = { siteId, cb };
        if (!subs.has(kind)) subs.set(kind, new Set());
        subs.get(kind).add(entry);
        return () => subs.get(kind).delete(entry);
      },
    };
  };

  async function settings(siteId) {
    const [g, s] = await be.settingsRows(siteId);
    return mergeSettings(g, s);
  }

  async function transition(id, to, note = '') {
    const row = await be.one('dailyReports', id);
    if (!row) throw new Error('일보를 찾을 수 없습니다.');
    const { daily } = await settings(row.siteId);
    const patch = dailyTransition(row, to, { me: be.me(), steps: daily?.steps || 1, note, at: be.now().toISOString() });
    if (!patch.status) return row;
    const rec = await be.patch('dailyReports', id, patch);
    fire('dailyReports', rec.siteId);
    return rec;
  }

  return {
    fire,
    rows,
    ops: {
      settings,
      async saveSettings(id, patch) {
        const rec = await be.putSettings(id, validateSettings(patch));
        be.notify();
        return rec;
      },
      settingsRow: (id) => be.settingsRow(id),
    },
    files: {
      // file: Blob. o: { people, name, thumb, takenAt, blurred }. 돌려주는 값은 기록의 files 칸에 넣는 항목(10 지시서 0절)
      async upload(siteId, kind, recordId, file, o = {}) {
        const mime = file.type || 'application/octet-stream';
        const folder = FILE_FOLDERS[kind] || kind;
        const path = `${siteId}/${folder}/${recordId}/f_${rand()}.${EXT[mime] || 'bin'}`;
        await be.fileUp(bucketOf(null, o.people), path, file, mime);
        return { path, name: String(o.name || file.name || '').slice(0, 200), mime, size: file.size || 0, thumb: o.thumb || '', takenAt: o.takenAt || '', blurred: o.blurred === true, people: o.people === true };
      },
      url: (item, o = {}) => be.fileUrl(bucketOf(item, o.people), pathOf(item)),
      remove: (item, o = {}) => be.fileDel(bucketOf(item, o.people), pathOf(item)),
    },
    // 문서 원본·쪽 그림·쪽 글자(비공개 site-docs, 18 지시서 4절). 쪽 글자는 쪽 번호 순서의 문자열 배열
    docs: {
      async upload(siteId, file, o = {}) {
        const id = o.id || newId('projectDocs');
        const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name || '')?.[1]?.toLowerCase() || 'bin';
        const path = `${siteId}/${id}.${ext}`;
        const mime = file.type || DOC_MIME[ext] || 'application/octet-stream';
        await be.fileUp(OPS_BUCKETS.docs, path, file, mime);
        return rows('projectDocs').save({ id, siteId, setId: o.setId || null, name: file.name || '문서', kind: o.kind || 'unknown', mime, size: file.size || 0, pages: o.pages || 0, path, status: 'uploaded' });
      },
      url: (doc) => be.fileUrl(OPS_BUCKETS.docs, doc.path),
      savePage: (doc, n, blob) => be.fileUp(OPS_BUCKETS.docs, docPage(doc, n), blob, 'image/png'),
      page: (doc, n) => be.fileUrl(OPS_BUCKETS.docs, docPage(doc, n)),
      saveText: (doc, pages) => be.fileUp(OPS_BUCKETS.docs, docText(doc), new Blob([JSON.stringify(pages)], { type: 'application/json' }), 'application/json'),
      async text(doc) { return (await fetch(await be.fileUrl(OPS_BUCKETS.docs, docText(doc)))).json(); },
      async remove(doc) {
        const paths = [doc.path, docText(doc), ...Array.from({ length: doc.pages || 0 }, (_, i) => docPage(doc, i + 1))].filter(Boolean);
        for (const p of paths) await be.fileDel(OPS_BUCKETS.docs, p).catch(() => {});
        await rows('projectDocs').remove(doc.id);
      },
    },
    weather: {
      get: (siteId, q = {}) => be.weatherRows(siteId, q),
      refresh: (siteId) => be.weatherRefresh(siteId, settings),
    },
    daily: {
      submit: (id) => transition(id, 'submitted'),
      review: (id) => transition(id, 'reviewed'),
      approve: (id) => transition(id, 'approved'),
      returnTo: (id, note) => transition(id, 'returned', note),
      recall: (id) => transition(id, 'draft'),
      cancel: (id) => transition(id, 'cancelled'),
    },
    notices: {
      async resolve(id) {
        const rec = await be.patch('notices', id, { resolvedAt: be.now().toISOString(), resolvedBy: be.me()?.id === 'local' ? null : be.me()?.id });
        fire('notices', rec.siteId);
        return rec;
      },
    },
    outbox: be.outbox,
    schedules: scheduleApi(be, rows, fire),
    cost: costApi(be, rows, fire),
    // 공공 정보(30 지시서 1~3절): 공유 모드는 public-data 함수(키는 서버 비밀값), 데모 모드는 녹화 응답을 줄 때만
    publicData: {
      list: (siteId) => rows('publicRecords').list({ siteId }),
      async fetch(siteId, pnu, o = {}) {
        const r = await be.publicFetch(siteId, pnu, o);
        fire('publicRecords', siteId);
        return r;
      },
      /** 데모·화면 시험용: (종류, 응답 이름) → 녹화 응답 본문 */
      useFixtures(loader) { be.publicFixtures = loader; },
    },
  };
}

// 데모 모드의 공공 정보 받기: 녹화 응답(useFixtures)으로 서버와 같은 해석을 한다. 실제 공공 API는 부르지 않는다
async function localPublicFetch(be, rows, siteId, pnu, { force = false, kinds = ['permit', 'register'] } = {}) {
  if (!be.publicFixtures) throw new Error('브라우저 저장(데모) 모드에서는 공공 API를 부르지 않습니다. 공유 모드에서 공공데이터포털 키를 등록하면 가져올 수 있습니다.');
  const q = queryOfPnu(pnu);
  const prev = await rows('publicRecords').list({ siteId });
  const out = [];
  for (const kind of kinds) {
    const old = prev.find((r) => r.kind === kind);
    if (old && !force && old.query?.pnu === q.pnu && be.now().getTime() - Date.parse(old.fetchedAt) < FRESH_MS) { out.push({ ...old, cached: true }); continue; }
    const res = {};
    for (const name of Object.keys(PUBLIC_SOURCES[kind].ops)) res[name] = await be.publicFixtures(kind, name, q);
    const data = kind === 'permit' ? parsePermit(res) : parseRegister(res);
    out.push(await rows('publicRecords').save({ id: old?.id, siteId, kind, query: q, data, source: PUBLIC_SOURCES[kind].label, fetchedAt: be.now().toISOString(), status: data.empty ? 'empty' : 'ok' }));
  }
  return { records: out };
}

// 내역서·단가·연결·공사 업체·시공 기준(24 지시서). 원본 파일은 저장하지 않는다(읽은 항목만). 금액은 AI로 보내지 않는다
function costApi(be, rows, fire) {
  const api = {
    /** 이 현장 내역서 + 회사 공통 내역서(볼 수 있는 것만: 공유 모드에서는 RLS가 거른다) */
    async books(siteId) {
      const all = await be.select('costBooks', {});
      return all.filter((b) => !b.siteId || b.siteId === siteId);
    },
    items: (bookId) => be.select('costItems', { bookId }),
    /** 여러 내역서의 항목(id → 항목) */
    async itemMap(books) {
      const m = new Map();
      for (const b of books) for (const it of await api.items(b.id)) m.set(it.id, { ...it, bookName: b.name });
      return m;
    },
    /**
     * 내역서 저장: 책 한 줄 + 항목 여러 줄(한꺼번에). 같은 양식을 다음에 쓰도록 format을 남긴다
     * @param {string|null} siteId null이면 회사 공통 @param {{ meta: any, items: any[] }} o
     */
    async createBook(siteId, { meta, items }) {
      const id = newId('costBooks');
      const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
      const rec = await rows('costBooks').save({ ...meta, id, siteId: siteId || null, itemCount: items.length, totalAmount: Math.round(total), status: meta?.status || 'active' });
      const clean = items.map((it, i) => ({ id: newId('costItems'), ...validate('costItems', { ...it, bookId: id, siteId: siteId || null, sort: i, source: it.source || 'book' }, be.data()) }));
      await be.bulk('costItems', clean);
      fire('costBooks', siteId);
      return rec;
    },
    async removeBook(id) {
      const b = await be.one('costBooks', id);
      if (!b) return;
      const ids = new Set((await api.items(id)).map((x) => x.id));
      for (const l of await be.select('costLinks', b.siteId ? { siteId: b.siteId } : {})) if (ids.has(l.itemId)) await be.remove('costLinks', l.id, l).catch(() => {});
      await be.removeChildren('costItems', 'bookId', id);
      await rows('costBooks').remove(id);
      fire('costLinks', b.siteId);
    },
    /** 직접 입력(내역서 없이): 현장의 "직접 입력" 책에 항목 하나(source manual) */
    async saveManual(siteId, item) {
      let book = (await be.select('costBooks', { siteId })).find((b) => b.siteId === siteId && b.format?.manual);
      if (!book) book = await rows('costBooks').save({ id: newId('costBooks'), siteId, name: '직접 입력', format: { manual: true }, status: 'active' });
      const old = item.id ? await be.one('costItems', item.id) : null;
      const n = (await api.items(book.id)).length;
      const rec = await rows('costItems').save({ ...(old || {}), ...item, id: item.id || newId('costItems'), bookId: book.id, siteId, source: 'manual', sort: old?.sort ?? n });
      const list = await api.items(book.id);
      await be.patch('costBooks', book.id, { itemCount: list.length, totalAmount: null });
      fire('costBooks', siteId);
      return { book, item: rec };
    },
    links: (siteId) => be.select('costLinks', { siteId }).then((l) => l.filter((x) => x.siteId === siteId)),
    /** 회사 공통 연결 사전(금액 없음, itemKey → 모델 열쇠) */
    dict: () => be.select('costLinks', {}).then((l) => l.filter((x) => !x.siteId)),
    async saveLink(row) {
      const rec = await rows('costLinks').save(row);
      fire('costLinks', rec.siteId);
      return rec;
    },
    async removeLink(id) { await rows('costLinks').remove(id); },
    /** 확인한 연결을 회사 사전에 쌓기(같은 열쇠·대상이 있으면 건너뜀) */
    async learn(entries) {
      const have = new Set((await api.dict()).map((d) => `${d.itemKey}|${d.targetKey}`));
      let n = 0;
      for (const e of entries) {
        if (!e?.itemKey || have.has(`${e.itemKey}|${e.targetKey}`)) continue;
        await rows('costLinks').save({ ...e, siteId: null, itemId: null, confirmed: true });
        have.add(`${e.itemKey}|${e.targetKey}`);
        n++;
      }
      return n;
    },
    trades: (siteId) => be.select('tradeAssignments', { siteId }),
    standards: (siteId) => be.select('workStandards', {}).then((l) => l.filter((x) => !x.siteId || x.siteId === siteId)),
  };
  return api;
}

// 공정표 판(26·28 지시서 5절): 판마다 원본 파일 + 활동 행. 현장마다 활성 판은 하나, 처음 활성으로 만든 판이 기준 공정표
function scheduleApi(be, rows, fire) {
  const statsOf = (acts) => {
    const s = scheduleStats(acts);
    return { rows: s.rows, summary: s.summary, errors: s.errors, linked: s.linked, unlinked: s.unlinked };
  };
  const api = {
    list: (siteId) => rows('schedules').list({ siteId }),
    get: (id) => rows('schedules').get(id),
    activities: (scheduleId) => be.select('scheduleActivities', { scheduleId }),
    /**
     * 새 판(초안) 저장. activities는 짝 짓기까지 끝낸 활동(js/ops/schedule/), file은 원본(선택)
     * @param {string} siteId @param {{ meta: any, activities: any[], file?: Blob & { name?: string } }} o
     */
    async create(siteId, { meta, activities, file }) {
      const list = await be.select('schedules', { siteId });
      const version = Math.max(0, ...list.map((x) => x.version || 0)) + 1;
      const id = newId('schedules');
      let path = null;
      if (file) {
        const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name || '')?.[1]?.toLowerCase() || 'bin';
        path = `${siteId}/${id}.${ext}`;
        await be.fileUp(OPS_BUCKETS.schedules, path, file, SCHEDULE_MIME[ext] || 'application/octet-stream');
      }
      const st = scheduleStats(activities);
      const rec = await rows('schedules').save({
        id, siteId, version, status: 'draft', baseline: false, ...meta, path,
        startDate: st.start || '', finishDate: st.finish || '', stats: { ...(meta?.stats || {}), ...statsOf(activities) },
      });
      const clean = activities.map((a, i) => {
        const src = a.errors?.length ? { ...a.source, errors: a.errors.slice(0, 5) } : a.source;
        return { id: newId('scheduleActivities'), ...validate('scheduleActivities', { ...a, source: src, scheduleId: id, siteId, sort: i, linked: a.linked && !a.errors?.length }, be.data()) };
      });
      await be.bulk('scheduleActivities', clean);
      fire('schedules', siteId);
      return rec;
    },
    /** 짝 고치기(사람 확인). 판의 연결 통계도 다시 센다 */
    async saveActivity(row) {
      const rec = await rows('scheduleActivities').save(row);
      await api.refreshStats(rec.scheduleId);
      return rec;
    },
    async refreshStats(scheduleId) {
      const s = await be.one('schedules', scheduleId);
      if (!s) return null;
      const acts = await api.activities(scheduleId);
      const rec = await be.patch('schedules', scheduleId, { stats: { ...s.stats, ...statsOf(acts.map((a) => ({ ...a, errors: a.source?.errors || [] }))) } });
      fire('schedules', s.siteId);
      return rec;
    },
    /** 활성으로: 같은 현장의 이전 활성 판은 보관, 기준 공정표가 아직 없으면 이 판이 기준(비어 있는 기준 날짜를 채운다) */
    async activate(id) {
      const rec = await be.activateSchedule(id);
      fire('schedules', rec.siteId);
      return rec;
    },
    async archive(id) {
      const rec = await be.patch('schedules', id, { status: 'archived' });
      fire('schedules', rec.siteId);
      return rec;
    },
    async remove(id) {
      const s = await be.one('schedules', id);
      if (!s) return;
      if (s.path) await be.fileDel(OPS_BUCKETS.schedules, s.path).catch(() => {});
      await be.removeChildren('scheduleActivities', 'scheduleId', id);
      await rows('schedules').remove(id);
    },
    fileUrl: (s) => be.fileUrl(OPS_BUCKETS.schedules, s.path),
    // 회사 공종 사전
    dict: {
      list: () => be.select('scheduleDict', {}),
      /** 고친 짝 쌓기: 같은 열쇠가 있으면 공종·구역을 새 값으로, 횟수 +1 */
      async learn(entries, siteId) {
        const have = new Map((await be.select('scheduleDict', {})).map((r) => [r.key, r]));
        let n = 0;
        for (const e of entries) {
          if (!e?.key || !e.trade) continue;
          const old = have.get(e.key);
          if (old && old.trade === e.trade && (old.zone || '') === (e.zone || '')) continue;
          const rec = await rows('scheduleDict').save({ ...(old || {}), key: e.key, trade: e.trade, zone: e.zone || '', siteId: siteId || null, count: (old?.count || 0) + 1 });
          have.set(e.key, rec);
          n++;
        }
        return n;
      },
    },
  };
  return api;
}

const byOrder = (kind) => {
  const [col, dir] = OPS_KINDS[kind].order || ['createdAt'];
  const s = dir === 'desc' ? -1 : 1;
  return (a, b) => s * (typeof a[col] === 'number' ? a[col] - b[col] : String(a[col] ?? '').localeCompare(String(b[col] ?? '')));
};

// ================================================================ 브라우저 저장(데모)

/**
 * @param {{ rowsDb: any, filesDb: any, now: () => Date, notify: () => void, data: () => any, me: () => any }} deps
 */
export function createLocalOps({ rowsDb, filesDb, now, notify, data, me }) {
  let all = null; // 모든 행(메모리 사본). { _k: 종류, ...필드 }
  const urls = new Map();
  const strip = ({ _k, ...r }) => r;
  const load = async () => { all ||= await rowsDb.all(); return all; };
  const stampNow = () => now().toISOString();

  async function write(kind, rec) {
    await load();
    const full = { ...rec, _k: kind };
    try { await rowsDb.put(full); } catch { throw new Error('브라우저 저장 공간이 부족해 저장하지 못했습니다.'); }
    const i = all.findIndex((r) => r.id === rec.id);
    if (i >= 0) all[i] = full; else all.push(full);
    return clone(strip(full));
  }

  const NEW_ROW = { dailyReports: { status: 'draft', signs: {}, returnNote: '' } };

  const be = {
    data, me, notify, now,
    async select(kind, q) {
      const { when, parent } = OPS_KINDS[kind];
      const status = q.status && [].concat(q.status);
      return clone((await load()).filter((r) => r._k === kind
        && (!q.siteId || r.siteId === q.siteId)
        && (!parent || !q[parent] || r[parent] === q[parent])
        && (!q.from || !when || r[when] >= q.from) && (!q.to || !when || r[when] <= q.to)
        && (!status || status.includes(r.status))).map(strip).sort(byOrder(kind)));
    },
    async one(kind, id) {
      const r = (await load()).find((x) => x.id === id && x._k === kind);
      return r ? clone(strip(r)) : null;
    },
    async put(kind, rec) {
      const prev = (await load()).find((x) => x.id === rec.id && x._k === kind);
      const { unique } = OPS_KINDS[kind];
      if (unique && all.some((x) => x._k === kind && x.id !== rec.id && unique.every((c) => x[c] === rec[c]))) throw new Error('같은 날짜의 기록이 이미 있습니다.');
      const stamp = stampNow();
      return write(kind, { ...(prev ? strip(prev) : NEW_ROW[kind] || {}), ...rec, createdAt: prev?.createdAt || stamp, updatedAt: stamp, updatedBy: 'local' });
    },
    async patch(kind, id, patch) {
      const prev = (await load()).find((x) => x.id === id && x._k === kind);
      if (!prev) throw new Error('기록을 찾을 수 없습니다.');
      return write(kind, { ...strip(prev), ...patch, updatedAt: stampNow(), updatedBy: 'local' });
    },
    async remove(kind, id) {
      await load();
      await rowsDb.del([id]);
      all = all.filter((r) => r.id !== id);
    },
    async bulk(kind, recs) {
      const stamp = stampNow();
      for (const r of recs) await write(kind, { ...r, createdAt: stamp, updatedAt: stamp, updatedBy: 'local' });
    },
    async removeChildren(kind, col, id) {
      const gone = (await load()).filter((r) => r._k === kind && r[col] === id).map((r) => r.id);
      if (gone.length) { await rowsDb.del(gone); const set = new Set(gone); all = all.filter((r) => !set.has(r.id)); }
    },
    async activateSchedule(id) {
      const s = (await load()).find((r) => r._k === 'schedules' && r.id === id);
      if (!s) throw new Error('공정표 판을 찾을 수 없습니다.');
      const same = all.filter((r) => r._k === 'schedules' && r.siteId === s.siteId);
      for (const o of same) if (o.id !== id && o.status === 'active') await be.patch('schedules', o.id, { status: 'archived' });
      const baseline = s.baseline || !same.some((o) => o.baseline);
      if (baseline && !s.baseline) {
        for (const a of all.filter((r) => r._k === 'scheduleActivities' && r.scheduleId === id)) {
          if (!a.baseStart || !a.baseFinish) await write('scheduleActivities', { ...strip(a), baseStart: a.baseStart || a.start, baseFinish: a.baseFinish || a.finish });
        }
      }
      return be.patch('schedules', id, { status: 'active', baseline });
    },
    async settingsRows(siteId) {
      const list = await load();
      return [list.find((r) => r._k === 'opsSettings' && r.id === 'set:global'), siteId ? list.find((r) => r._k === 'opsSettings' && r.id === `set:${siteId}`) : null].map((r) => (r ? strip(r) : null));
    },
    async settingsRow(id) {
      const r = (await load()).find((x) => x._k === 'opsSettings' && x.id === `set:${id}`);
      return r ? clone(strip(r)) : null;
    },
    async putSettings(id, patch) {
      const key = `set:${id}`;
      const prev = (await load()).find((r) => r._k === 'opsSettings' && r.id === key);
      return write('opsSettings', { ...(prev ? strip(prev) : {}), ...patch, id: key, updatedAt: stampNow() });
    },
    async fileUp(bucket, path, blob) {
      try { await filesDb.put({ id: `${bucket}/${path}`, blob }); } catch { throw new Error('브라우저 저장 공간이 부족해 파일을 저장하지 못했습니다.'); }
    },
    async fileUrl(bucket, path) {
      const key = `${bucket}/${path}`;
      if (urls.has(key)) return urls.get(key);
      const rec = await filesDb.get(key);
      if (!rec?.blob) throw new Error('파일을 찾지 못했습니다.');
      const url = URL.createObjectURL(rec.blob);
      urls.set(key, url);
      return url;
    },
    async fileDel(bucket, path) {
      const key = `${bucket}/${path}`;
      await filesDb.del([key]);
      if (urls.has(key)) { URL.revokeObjectURL?.(urls.get(key)); urls.delete(key); }
    },
    // 데모 모드는 날짜·위도로 정해지는 가짜 날씨(같은 날이면 같은 값)
    async weatherRows(siteId, { from, to }) {
      const site = (data().sites || []).find((s) => s.id === siteId);
      if (!site) return [];
      const t = today(now);
      return fakeWeather(site.lat, from || t, to || addDays(t, 2), stampNow());
    },
    async weatherRefresh(siteId, settings) {
      const site = (data().sites || []).find((s) => s.id === siteId);
      if (!site) return { ok: false };
      const t = today(now);
      const rows = fakeWeather(site.lat, t, addDays(t, 1), stampNow());
      const add = weatherNotices(rows, await settings(siteId), await api.rows('notices').list({ siteId }), t, siteId);
      for (const n of add) await api.rows('notices').save(n);
      return { ok: true, added: add.length };
    },
    outbox: { pending: async () => [], conflicts: async () => [], flush: async () => ({ files: 0, rows: 0, conflicts: 0, failed: 0 }), resolve: async () => {}, status: () => ({ offline: false, lastSync: null }) },
    publicFixtures: null,
    publicFetch: (siteId, pnu, o) => localPublicFetch(be, api.rows, siteId, pnu, o),
  };

  const api = buildApi(be);
  return {
    ...api,
    // 예시 데이터 넣기
    async seed(list) {
      for (const [kind, rows] of Object.entries(list || {})) for (const r of rows) await write(kind, { createdAt: stampNow(), updatedAt: stampNow(), ...NEW_ROW[kind], ...r });
    },
    // 현장이 없어진 기록과 파일 지우기
    async prune(live) {
      const gone = (await load()).filter((r) => (r.siteId && !live.has(r.siteId) && !OPS_KINDS[r._k]?.company) || (r._k === 'opsSettings' && r.id !== 'set:global' && !live.has(r.id.slice(4))));
      if (gone.length) {
        await rowsDb.del(gone.map((r) => r.id));
        const set = new Set(gone);
        all = all.filter((r) => !set.has(r));
      }
      const files = await filesDb.all();
      const dead = files.filter((f) => !live.has(f.id.split('/')[1])).map((f) => f.id);
      if (dead.length) await filesDb.del(dead);
    },
  };
}

// ================================================================ 공유(Supabase)

/**
 * @param {{ sb: any, notify: () => void, data: () => any, me: () => any, now: () => Date, friendlyError: (e: any) => Error, storageError: (e: any) => Error,
 *   isNetwork: (e: any) => boolean, offline: () => boolean, selectAll: (make: () => any) => Promise<any[]>, cacheDb: any, outboxDb: any, storage?: any }} deps
 */
export function createRemoteOps({ sb, notify, data, me, now, friendlyError, storageError, isNetwork, offline, selectAll, cacheDb, outboxDb, storage }) {
  const SYNC_KEY = 'baromap.ops.lastSync';
  const signed = new Map();
  const fromDb = (kind, row) => {
    const r = { ...row };
    for (const f of OPS_KINDS[kind]?.dates || []) r[f] = r[f] || '';
    return r;
  };
  const toDb = (kind, row) => {
    const r = { ...row };
    for (const f of OPS_KINDS[kind]?.dates || []) if (f in r && !r[f]) r[f] = null;
    return r;
  };
  const q = async (p) => { const { data: d, error } = await p; if (error) throw error; return d; };

  async function sendRow(kind, row) {
    const { table } = OPS_KINDS[kind];
    const { updatedAt, createdAt, updatedBy, ...clean } = row;
    return q(sb.from(table).upsert(toDb(kind, clean), { onConflict: 'id' }).select().single());
  }
  const sendFile = async (bucket, path, blob, mime) => {
    const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: mime, upsert: true, cacheControl: '31536000' });
    if (error) throw error;
  };
  const serverRow = (kind, id) => q(sb.from(OPS_KINDS[kind].table).select('*').eq('id', id).maybeSingle());

  const box = createOutbox({ db: outboxDb, sendRow, sendFile, serverRow, isNetwork, now, onChange: () => { api.fire('dailyReports'); notify(); } });
  let lastSync = null;
  try { lastSync = storage?.getItem(SYNC_KEY) || null; } catch { /* 무시 */ }
  const synced = () => { lastSync = now().toISOString(); try { storage?.setItem(SYNC_KEY, lastSync); } catch { /* 무시 */ } };

  const matches = (kind, r, qr) => {
    const { when, parent } = OPS_KINDS[kind];
    const status = qr.status && [].concat(qr.status);
    return (!qr.siteId || r.siteId === qr.siteId) && (!parent || !qr[parent] || r[parent] === qr[parent])
      && (!qr.from || !when || r[when] >= qr.from) && (!qr.to || !when || r[when] <= qr.to) && (!status || status.includes(r.status));
  };

  // 아직 올라가지 않은 내 기록을 목록 위에 겹친다(화면에는 바로 보이게)
  async function overlay(kind, list, qr) {
    if (!OFFLINE_KINDS.has(kind)) return list;
    const mine = (await box.pendingRows(kind)).filter((r) => matches(kind, r, qr));
    if (!mine.length) return list;
    const ids = new Set(mine.map((r) => r.id));
    return [...list.filter((r) => !ids.has(r.id)), ...mine.map((r) => ({ ...r, _pending: true }))].sort(byOrder(kind));
  }

  const be = {
    data, me, notify, now,
    outbox: {
      pending: () => box.pending(),
      conflicts: () => box.conflicts(),
      resolve: (id, mine) => box.resolve(id, mine),
      async flush() {
        if (offline()) return { files: 0, rows: 0, conflicts: 0, failed: 0, stopped: true };
        const r = await box.flush();
        if (!r.stopped) synced();
        return r;
      },
      status: () => ({ offline: offline(), lastSync }),
    },
    async select(kind, qr) {
      const k = OPS_KINDS[kind];
      const key = `${kind}|${JSON.stringify(qr)}`;
      const make = () => {
        let x = sb.from(k.table).select('*');
        if (qr.siteId) x = x.eq('siteId', qr.siteId);
        if (k.parent && qr[k.parent]) x = x.eq(k.parent, qr[k.parent]);
        if (qr.from && k.when) x = x.gte(k.when, qr.from);
        if (qr.to && k.when) x = x.lte(k.when, qr.to);
        if (qr.status) x = Array.isArray(qr.status) ? x.in('status', qr.status) : x.eq('status', qr.status);
        const [col, dir] = k.order || ['createdAt'];
        return x.order(col, { ascending: dir !== 'desc' });
      };
      let list;
      try {
        list = (await selectAll(make)).map((r) => fromDb(kind, r));
        synced();
        if (!k.secret) cacheDb.put({ id: key, rows: list }).catch(() => {});
      } catch (err) {
        if (!isNetwork(err)) throw friendlyError(err);
        if (k.secret) throw new Error('단가·내역은 인터넷이 연결돼 있을 때만 볼 수 있습니다(기기에 남기지 않습니다).');
        list = (await cacheDb.get(key))?.rows || [];
      }
      return clone(await overlay(kind, list, qr));
    },
    async one(kind, id) {
      try {
        const r = await serverRow(kind, id);
        const mine = OFFLINE_KINDS.has(kind) ? (await box.pendingRows(kind)).find((x) => x.id === id) : null;
        return mine ? { ...mine, _pending: true } : r ? fromDb(kind, r) : null;
      } catch (err) {
        if (!isNetwork(err)) throw friendlyError(err);
        const mine = (await box.pendingRows(kind)).find((x) => x.id === id);
        if (mine) return { ...mine, _pending: true };
        for (const c of await cacheDb.all()) { const hit = c.id.startsWith(`${kind}|`) && c.rows.find((r) => r.id === id); if (hit) return hit; }
        return null;
      }
    },
    async put(kind, rec, input) {
      const queue = async () => {
        await box.addRow(kind, rec, input.updatedAt || null);
        return { ...input, ...rec, _pending: true };
      };
      if (offline()) {
        if (OFFLINE_KINDS.has(kind)) return queue();
        throw new Error('지금은 오프라인이라 저장할 수 없습니다. 인터넷이 연결되면 다시 시도해주세요.');
      }
      try {
        return fromDb(kind, await sendRow(kind, rec));
      } catch (err) {
        if (isNetwork(err) && OFFLINE_KINDS.has(kind)) return queue();
        if (err?.code === '23505') throw new Error('같은 날짜의 기록이 이미 있습니다. 화면을 새로 고쳐주세요.');
        throw friendlyError(err);
      }
    },
    async patch(kind, id, patch) {
      if (offline()) throw new Error('결재는 인터넷이 연결된 뒤에 할 수 있습니다.');
      await box.flush();
      try {
        return fromDb(kind, await q(sb.from(OPS_KINDS[kind].table).update(toDb(kind, patch)).eq('id', id).select().single()));
      } catch (err) { throw friendlyError(err); }
    },
    async remove(kind, id) {
      if (offline()) throw new Error('지금은 오프라인이라 지울 수 없습니다.');
      const gone = await q(sb.from(OPS_KINDS[kind].table).delete().eq('id', id).select('id')).catch((err) => { throw friendlyError(err); });
      if (!gone?.length) throw friendlyError({ code: '42501' });
    },
    // 공정 행처럼 많은 행은 500행씩 한 번에(돌려받지 않는다)
    async bulk(kind, recs) {
      if (offline()) throw new Error('지금은 오프라인이라 저장할 수 없습니다.');
      const { table } = OPS_KINDS[kind];
      for (let i = 0; i < recs.length; i += 500) {
        const { error } = await sb.from(table).insert(recs.slice(i, i + 500).map((r) => toDb(kind, r)));
        if (error) throw friendlyError(error);
      }
    },
    async removeChildren() { /* DB가 함께 지운다(on delete cascade) */ },
    async activateSchedule(id) {
      if (offline()) throw new Error('지금은 오프라인이라 바꿀 수 없습니다.');
      const { data: d, error } = await sb.rpc('activate_schedule', { sid: id });
      if (error) throw friendlyError(error);
      return fromDb('schedules', d);
    },
    async settingsRows(siteId) {
      try {
        const ids = siteId ? ['global', siteId] : ['global'];
        const list = await q(sb.from('ops_settings').select('*').in('id', ids));
        cacheDb.put({ id: `settings|${siteId}`, rows: list }).catch(() => {});
        return [list.find((r) => r.id === 'global') || null, list.find((r) => r.id === siteId) || null];
      } catch {
        // 오프라인이거나 표가 아직 없으면 마지막 값(없으면 기본값)
        const list = (await cacheDb.get(`settings|${siteId}`).catch(() => null))?.rows || [];
        return [list.find((r) => r.id === 'global') || null, list.find((r) => r.id === siteId) || null];
      }
    },
    async settingsRow(id) {
      return q(sb.from('ops_settings').select('*').eq('id', id).maybeSingle()).catch((err) => { throw friendlyError(err); });
    },
    async putSettings(id, patch) {
      if (offline()) throw new Error('지금은 오프라인이라 저장할 수 없습니다.');
      return q(sb.from('ops_settings').upsert({ id, ...patch }, { onConflict: 'id' }).select().single()).catch((err) => { throw friendlyError(err); });
    },
    async fileUp(bucket, path, blob, mime) {
      const queue = () => box.addFile(bucket, path, blob, mime);
      if (offline()) return queue();
      try {
        return await sendFile(bucket, path, blob, mime);
      } catch (err) {
        if (isNetwork(err)) return queue();
        throw storageError(err);
      }
    },
    async fileUrl(bucket, path) {
      const hit = signed.get(path);
      if (hit && hit.until > Date.now()) return hit.url;
      const { data: d, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
      if (error) throw storageError(error);
      signed.set(path, { url: d.signedUrl, until: Date.now() + 50 * 60000 });
      return d.signedUrl;
    },
    async fileDel(bucket, path) {
      await box.dropFile(bucket, path);
      if (offline()) return;
      const { error } = await sb.storage.from(bucket).remove([path]);
      if (error) throw storageError(error);
    },
    async weatherRows(siteId, { from, to }) {
      let x = sb.from('site_weather').select('*').eq('siteId', siteId);
      if (from) x = x.gte('at', `${from}T00:00:00+09:00`);
      if (to) x = x.lte('at', `${to}T23:59:59+09:00`);
      try { return await q(x.order('at').limit(1000)); } catch { return []; }
    },
    async publicFetch(siteId, pnu, o = {}) {
      if (offline()) throw new Error('지금은 오프라인이라 공공 정보를 가져올 수 없습니다.');
      if (be.publicFixtures) return localPublicFetch(be, api.rows, siteId, pnu, o);
      const { data: d, error } = await sb.functions.invoke('public-data', { body: { siteId, pnu, kinds: o.kinds, force: Boolean(o.force) } });
      if (error) {
        let msg = '';
        try { msg = (await error.context?.json?.())?.error || ''; } catch { /* 무시 */ }
        if (!msg && /Failed to send|fetch/i.test(String(error.message))) msg = '공공 정보 기능(Edge Function public-data)이 아직 서버에 준비되지 않았습니다.';
        throw new Error(msg || String(error.message || '공공 정보를 가져오지 못했습니다.'));
      }
      if (d?.error) throw new Error(d.error);
      return d;
    },
    publicFixtures: null,
    // 키가 없거나 함수를 아직 배포하지 않았으면 조용히 손 입력으로 돌아간다
    async weatherRefresh(siteId) {
      if (offline() || !sb.functions) return { ok: false };
      try {
        const { data: d, error } = await sb.functions.invoke('weather', { body: { siteId } });
        return error ? { ok: false, error: error.message } : { ok: true, ...d };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };

  const api = buildApi(be);
  return {
    ...api,
    applyRealtime(table, payload) {
      const kind = kindOfTable(table);
      if (kind) api.fire(kind, (payload.new || payload.old)?.siteId);
      else if (table === 'ops_settings') notify();
    },
    // 인터넷이 돌아오면·앱을 켜면·5분마다 비운다
    start() {
      api.outbox.flush().catch(() => {});
      if (typeof window === 'undefined') return;
      window.addEventListener('online', () => api.outbox.flush().catch(() => {}));
      setInterval(() => api.outbox.flush().catch(() => {}), 5 * 60000);
    },
  };
}
