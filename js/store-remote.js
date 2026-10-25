// 공유 저장소(Supabase). store.js의 브라우저 저장소와 같은 API를 가진다.
// - 로그인한 사용자만 읽고, 권한(관리자/현장 담당/조회)은 DB의 RLS 정책이 최종 판단한다(supabase/schema.sql).
// - 다른 사람이 고친 내용은 실시간(Realtime)으로 들어와 화면이 바로 바뀐다.
// - 인터넷이 끊기면 마지막으로 받은 데이터를 읽기 전용으로 보여준다.
import { validate, normalizeData, newId, clone, KINDS } from './store.js';

const SUPABASE_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
const CACHE_KEY = 'baromap.remote.cache.v1';
const TABLES = Object.keys(KINDS);
const DATE_FIELDS = { sites: ['startDate', 'endDate'], lodgings: ['leaseEnd'], residents: ['moveIn'] };
const ROLE_RANK = { pending: 0, viewer: 1, manager: 2, admin: 3 };

// DB의 null 날짜 ↔ 화면의 빈 문자열
function fromDb(kind, row) {
  const r = { ...row };
  for (const f of DATE_FIELDS[kind]) r[f] = r[f] || '';
  return r;
}
function toDb(kind, clean) {
  const r = { ...clean };
  for (const f of DATE_FIELDS[kind]) if (!r[f]) r[f] = null;
  return r;
}

export function friendlyError(error) {
  const msg = String(error?.message || error || '');
  const code = error?.code;
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
    return new Error(/관리자/.test(msg) ? msg : '이 작업을 할 권한이 없습니다. 관리자에게 이 현장의 담당 권한을 요청하세요.');
  }
  if (code === 'PGRST116') return new Error('권한이 없거나 이미 다른 사람이 지운 항목입니다. 화면을 새로 고쳐 확인해주세요.');
  if (code === '23503') return new Error('연결된 현장 또는 숙소가 없습니다. 다른 사람이 지웠을 수 있으니 화면을 새로 고쳐주세요.');
  if (code === '23514' || code === '22P02' || code === '22007') return new Error('입력값이 허용 범위를 벗어났습니다. 내용을 확인해주세요.');
  if (/Failed to fetch|NetworkError|network|fetch failed/i.test(msg)) return new Error('서버에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.');
  return new Error(msg ? `처리 중 오류가 발생했습니다: ${msg}` : '처리 중 오류가 발생했습니다.');
}

function authError(error) {
  const msg = String(error?.message || error || '');
  if (/Invalid login credentials/i.test(msg)) return new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
  if (/Email not confirmed/i.test(msg)) return new Error('이메일 인증이 아직 안 됐습니다. 받은 메일의 인증 링크를 눌러주세요.');
  if (/already registered|already been registered/i.test(msg)) return new Error('이미 가입된 이메일입니다. 로그인하거나 비밀번호 찾기를 이용하세요.');
  if (/at least 6 characters|Password should be/i.test(msg)) return new Error('비밀번호는 6자 이상이어야 합니다.');
  if (/rate limit|too many/i.test(msg)) return new Error('요청이 너무 많습니다. 잠시 후 다시 시도해주세요.');
  if (/provider is not enabled|Unsupported provider/i.test(msg)) return new Error('이 로그인 방식이 아직 켜져 있지 않습니다. 관리자에게 문의하세요.');
  return friendlyError(error);
}

const isNetwork = (err) => /Failed to fetch|NetworkError|network|fetch failed|연결할 수 없습니다/i.test(String(err?.message || err));

/**
 * @param {{ url?: string, anonKey?: string, client?: any, storage?: Storage, now?: () => Date, redirectTo?: string }} opts
 */
export async function createRemoteStore({ url, anonKey, client, storage = globalThis.localStorage, now = () => new Date(), redirectTo } = {}) {
  const sb = client || (await import(SUPABASE_SRC)).createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const back = redirectTo || (typeof location !== 'undefined' ? location.origin + location.pathname : undefined);

  let data = { sites: [], lodgings: [], residents: [] };
  let me = null;
  let status = 'idle'; // idle | connecting | live | offline
  let offlineSince = null;
  let lastFetch = 0;
  let dbChannel = null;
  let meChannel = null;
  const listeners = new Set();

  let queued = false;
  function notify() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const fn of listeners) fn();
    });
  }
  function setStatus(s) {
    if (status === s) return;
    status = s;
    notify();
  }

  function cacheWrite() {
    try {
      storage.setItem(CACHE_KEY, JSON.stringify({ user: me?.id, me, at: now().toISOString(), data }));
    } catch { /* 저장 공간 부족 등은 무시: 캐시는 보조 수단 */ }
  }
  function cacheRead(userId) {
    try {
      const c = JSON.parse(storage.getItem(CACHE_KEY));
      return c && c.user === userId ? c : null;
    } catch {
      return null;
    }
  }

  async function sessionUser() {
    const { data: d } = await sb.auth.getSession();
    return d?.session?.user || null;
  }

  async function loadProfile(user) {
    const { data: p, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) throw error;
    me = p ? { ...p, siteIds: p.siteIds || [] } : { id: user.id, email: user.email || '', name: '', role: 'pending', siteIds: [] };
  }

  async function fetchAll() {
    const results = await Promise.all(TABLES.map((t) => sb.from(t).select('*')));
    const next = {};
    results.forEach((res, i) => {
      if (res.error) throw res.error;
      next[TABLES[i]] = res.data.map((row) => fromDb(TABLES[i], row))
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    });
    data = next;
    lastFetch = Date.now();
    offlineSince = null;
    cacheWrite();
  }

  function removeLocal(kind, id) {
    const removed = { sites: 0, lodgings: 0, residents: 0 };
    let lodgingIds = [];
    if (kind === 'residents') {
      const n = data.residents.length;
      data.residents = data.residents.filter((r) => r.id !== id);
      removed.residents = n - data.residents.length;
      return removed;
    }
    if (kind === 'sites') {
      const n = data.sites.length;
      data.sites = data.sites.filter((s) => s.id !== id);
      removed.sites = n - data.sites.length;
      lodgingIds = data.lodgings.filter((l) => l.siteId === id).map((l) => l.id);
    } else {
      lodgingIds = [id];
    }
    const ln = data.lodgings.length;
    data.lodgings = data.lodgings.filter((l) => !lodgingIds.includes(l.id));
    removed.lodgings = ln - data.lodgings.length;
    const rn = data.residents.length;
    data.residents = data.residents.filter((r) => !lodgingIds.includes(r.lodgingId));
    removed.residents = rn - data.residents.length;
    return removed;
  }

  // 지우기 전에 함께 지워질 개수를 센다(메모리 사본으로 계산).
  function countCascade(kind, id) {
    const saved = clone(data);
    const removed = removeLocal(kind, id);
    data = saved;
    return removed;
  }

  // 실시간 변경 반영(내가 저장한 것도 다시 들어오지만 같은 내용이라 문제없다)
  function apply(kind, payload) {
    if (payload.eventType === 'DELETE') {
      const id = payload.old?.id;
      if (!id) return;
      removeLocal(kind, id);
    } else if (payload.new) {
      const rec = fromDb(kind, payload.new);
      const list = data[kind];
      const i = list.findIndex((x) => x.id === rec.id);
      if (i >= 0) list[i] = rec;
      else list.push(rec);
    }
    cacheWrite();
    notify();
  }

  async function subscribeRealtime() {
    if (dbChannel) sb.removeChannel(dbChannel);
    setStatus('connecting');
    // 실시간 연결이 로그인 사용자 권한으로 열리도록 토큰을 먼저 넘긴다(공개 키로 열리면 RLS 때문에 변경 알림이 걸러짐).
    try {
      const { data: d } = await sb.auth.getSession();
      if (d?.session && sb.realtime?.setAuth) await sb.realtime.setAuth(d.session.access_token);
    } catch { /* 토큰 갱신 실패는 연결 상태로 드러난다 */ }
    dbChannel = sb.channel('baromap-db');
    for (const t of TABLES) {
      dbChannel.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => apply(t, p));
    }
    let first = true;
    dbChannel.subscribe((s) => {
      if (s === 'SUBSCRIBED') {
        // 처음 연결될 때와 끊겼다 다시 연결될 때, 그 사이 놓친 변경이 없도록 한 번 더 받는다.
        const missed = first || status === 'offline';
        first = false;
        setStatus('live');
        if (missed) store.refresh();
      } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
        if (status === 'live' || status === 'connecting') offlineSince = offlineSince || now().toISOString();
        setStatus('offline');
      }
    });
  }

  // 관리자가 내 권한을 바꾸면 바로 반영(승인 대기 → 승인 등)
  function subscribeMe() {
    if (meChannel) sb.removeChannel(meChannel);
    meChannel = sb.channel('baromap-me')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${me.id}` }, async (p) => {
        const wasMember = ROLE_RANK[me?.role] >= 1;
        me = { ...me, ...p.new, siteIds: p.new.siteIds || [] };
        const isMember = ROLE_RANK[me.role] >= 1;
        if (isMember && !wasMember) {
          await fetchAll().catch(() => {});
          subscribeRealtime();
        }
        if (!isMember) data = { sites: [], lodgings: [], residents: [] };
        cacheWrite();
        notify();
      })
      .subscribe();
  }

  function guardOnline() {
    if (status === 'offline') throw new Error('지금은 오프라인이라 저장할 수 없습니다. 인터넷이 연결되면 다시 시도해주세요.');
  }

  const store = {
    KINDS,
    mode: 'remote',
    get me() { return me; },
    get status() { return status; },
    get offlineSince() { return offlineSince; },
    get isSample() { return false; },

    can(action, siteId) {
      const role = me?.role;
      if (action === 'view') return ROLE_RANK[role] >= 1;
      if (action === 'edit') return role === 'admin' || (role === 'manager' && (me.siteIds || []).includes(siteId));
      if (action === 'editAny') return role === 'admin' || (role === 'manager' && (me.siteIds || []).length > 0);
      if (['admin', 'createSite', 'deleteSite', 'import'].includes(action)) return role === 'admin';
      return false;
    },

    auth: {
      async user() { return sessionUser(); },
      async signIn(email, password) {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw authError(error);
      },
      async signUp(email, password, name) {
        const { data: d, error } = await sb.auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: back } });
        if (error) throw authError(error);
        return { needsConfirm: !d?.session };
      },
      async signInWithProvider(provider) {
        const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: back, scopes: provider === 'azure' ? 'email' : undefined } });
        if (error) throw authError(error);
      },
      async resetPassword(email) {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: back });
        if (error) throw authError(error);
      },
      async updatePassword(password) {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw authError(error);
      },
      async signOut() {
        try { storage.removeItem(CACHE_KEY); } catch { /* 무시 */ }
        await sb.auth.signOut();
      },
      onChange(fn) {
        return sb.auth.onAuthStateChange((event, session) => fn(event, session)).data?.subscription;
      },
    },

    // 로그인 정보·권한을 읽고, 승인된 사용자면 전체 데이터를 받아 실시간 구독을 시작한다.
    async load() {
      const user = await sessionUser();
      if (!user) {
        me = null;
        return store.snapshot();
      }
      try {
        await loadProfile(user);
      } catch (err) {
        const cached = isNetwork(err) && cacheRead(user.id);
        if (!cached) throw friendlyError(err);
        me = cached.me;
        data = cached.data;
        offlineSince = cached.at;
        setStatus('offline');
        return store.snapshot();
      }
      subscribeMe();
      if (!store.can('view')) return store.snapshot();
      try {
        await fetchAll();
        await subscribeRealtime();
      } catch (err) {
        const cached = isNetwork(err) && cacheRead(user.id);
        if (!cached) throw friendlyError(err);
        data = cached.data;
        offlineSince = cached.at;
        setStatus('offline');
      }
      if (typeof window !== 'undefined' && !store._watching) {
        store._watching = true;
        window.addEventListener('online', () => store.refresh());
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && Date.now() - lastFetch > 60000) store.refresh();
        });
      }
      return store.snapshot();
    },

    // 놓친 변경이 있을 수 있을 때(재연결·앱 복귀) 전체를 다시 받는다.
    async refresh() {
      if (!me || !store.can('view')) return;
      try {
        await fetchAll();
        if (status === 'offline' && !dbChannel) subscribeRealtime();
        notify();
      } catch {
        setStatus('offline');
      }
    },

    snapshot() {
      return clone(data);
    },

    async save(kind, input) {
      guardOnline();
      const clean = validate(kind, input, data);
      const row = toDb(kind, clean);
      const exists = Boolean(input.id) && data[kind].some((x) => x.id === input.id);
      const query = exists
        ? sb.from(kind).update(row).eq('id', input.id)
        : sb.from(kind).insert({ id: input.id || newId(kind), ...row });
      const { data: saved, error } = await query.select().single();
      if (error) throw friendlyError(error);
      apply(kind, { eventType: exists ? 'UPDATE' : 'INSERT', new: saved });
      return clone(fromDb(kind, saved));
    },

    async remove(kind, id) {
      guardOnline();
      const counts = countCascade(kind, id);
      const { data: gone, error } = await sb.from(kind).delete().eq('id', id).select('id');
      if (error) throw friendlyError(error);
      if (!gone?.length) throw friendlyError({ code: '42501' });
      removeLocal(kind, id);
      cacheWrite();
      notify();
      return counts;
    },

    exportJson() {
      return { format: 'baromap-v1', exportedAt: now().toISOString(), ...store.snapshot() };
    },

    // 공유 모드에서는 파일 내용을 서버에 "합친다"(같은 id는 덮어쓰기). 관리자만.
    async importJson(obj) {
      guardOnline();
      if (!store.can('import')) throw new Error('데이터 파일 가져오기는 관리자만 할 수 있습니다.');
      const clean = normalizeData({ ...obj, sample: false }, now().toISOString());
      for (const t of TABLES) {
        const rows = clean[t].map(({ updatedAt, updatedBy, ...r }) => toDb(t, r));
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await sb.from(t).upsert(rows.slice(i, i + 500));
          if (error) throw friendlyError(error);
        }
      }
      await fetchAll();
      notify();
      return { sites: clean.sites.length, lodgings: clean.lodgings.length, residents: clean.residents.length };
    },

    async clear() {
      throw new Error('공유 모드에서는 전체 삭제를 지원하지 않습니다. 현장 단위로 지워주세요.');
    },

    async resetSample() {
      throw new Error('공유 모드에서는 예시 데이터를 넣을 수 없습니다.');
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    users: {
      async list() {
        const { data: d, error } = await sb.from('profiles').select('*').order('createdAt');
        if (error) throw friendlyError(error);
        return d;
      },
      async update(id, patch) {
        const { data: d, error } = await sb.from('profiles').update(patch).eq('id', id).select().single();
        if (error) throw friendlyError(error);
        if (id === me?.id) {
          me = { ...me, ...d };
          notify();
        }
        return d;
      },
    },

    audit: {
      async list({ limit = 100, before } = {}) {
        let query = sb.from('audit_logs').select('*').order('id', { ascending: false }).limit(limit);
        if (before) query = query.lt('id', before);
        const { data: d, error } = await query;
        if (error) throw friendlyError(error);
        return d;
      },
    },
  };
  return store;
}
