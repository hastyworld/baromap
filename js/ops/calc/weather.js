// 날씨 계산(브라우저·Edge Function·Node 공용, 순수 함수): 기상청 격자 변환, 체감온도, 단기예보 응답 읽기, 일보 날씨 요약, 데모 가짜 날씨.
// Edge Function은 npm run functions:sync로 복사된 _shared/lib/weather.js를 쓴다. 다른 파일을 import하지 않는다.

// ---------------------------------------------------------------- 위경도 → 기상청 격자(LCC, 기상청 공개 변환식)

const RE = 6371.00877; // 지구 반경(km)
const GRID = 5.0; // 격자 간격(km)
const SLAT1 = 30.0;
const SLAT2 = 60.0;
const OLON = 126.0;
const OLAT = 38.0;
const XO = 43;
const YO = 136;

export function latLngToGrid(lat, lng) {
  const rad = Math.PI / 180;
  const re = RE / GRID;
  const q = (v) => Math.tan(Math.PI * 0.25 + v * 0.5);
  const s1 = SLAT1 * rad;
  const s2 = SLAT2 * rad;
  const sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(q(s2) / q(s1));
  const sf = (q(s1) ** sn * Math.cos(s1)) / sn;
  const ro = (re * sf) / q(OLAT * rad) ** sn;
  const ra = (re * sf) / q(lat * rad) ** sn;
  let theta = lng * rad - OLON * rad;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

// ---------------------------------------------------------------- 체감온도(기상청 식, 2022-06-02 개정 여름철 식)

// 습구온도(Stull 2011): 기온(℃)·상대습도(%)
export function wetBulb(t, rh) {
  return t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(t + rh) - Math.atan(rh - 1.676331)
    + 0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) - 4.686035;
}

export function summerFeels(t, rh) {
  const tw = wetBulb(t, rh);
  return -0.2442 + 0.55399 * tw + 0.45535 * t - 0.0022 * tw * tw + 0.00278 * tw * t + 3.0;
}

// 겨울철: 기온 10℃ 이하이고 풍속 1.3m/s 이상일 때만 바람냉각(그 밖에는 기온 그대로)
export function windChill(t, wsd) {
  if (t > 10 || wsd < 1.3) return t;
  const v = (wsd * 3.6) ** 0.16;
  return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * v * t;
}

const round1 = (n) => Math.round(n * 10) / 10;

// month: 1~12. 습도나 풍속을 모르면 기온을 돌려준다
export function feelsLike({ t, rh, wsd }, month) {
  if (t == null || !Number.isFinite(Number(t))) return null;
  const summer = month >= 5 && month <= 9;
  if (summer) return rh == null ? round1(t) : round1(summerFeels(Number(t), Number(rh)));
  return wsd == null ? round1(t) : round1(windChill(Number(t), Number(wsd)));
}

// ---------------------------------------------------------------- 기상청 단기예보 조회서비스

const KST = 9 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');
export const kstParts = (d) => {
  const k = new Date(new Date(d).getTime() + KST);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth() + 1, d: k.getUTCDate(), h: k.getUTCHours(), mi: k.getUTCMinutes() };
};
export const kstDate = (d) => { const p = kstParts(d); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const ymd = (p) => `${p.y}${pad(p.m)}${pad(p.d)}`;
const iso = (date, hhmm) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00+09:00`;

// 지금 받을 수 있는 가장 최근 발표 시각. 단기예보는 02·05·…·23시 발표 후 약 10분, 초단기실황은 매시 40분 이후
export function baseTimes(now = new Date()) {
  const n = kstParts(now);
  const hours = [2, 5, 8, 11, 14, 17, 20, 23];
  const mins = n.h * 60 + n.mi;
  const hit = [...hours].reverse().find((h) => h * 60 + 10 <= mins);
  const vilage = hit == null
    ? { base_date: ymd(kstParts(new Date(new Date(now).getTime() - 864e5))), base_time: '2300' }
    : { base_date: ymd(n), base_time: `${pad(hit)}00` };
  const back = n.mi >= 40 ? new Date(now) : new Date(new Date(now).getTime() - 3600e3);
  const b = kstParts(back);
  return { vilage, ncst: { base_date: ymd(b), base_time: `${pad(b.h)}00` } };
}

// 강수량 글자: '강수없음', '1mm 미만', '1.0mm', '30.0~50.0mm', '50.0mm 이상'
export function parseRain(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '강수없음' || s === '-' || s === 'null') return 0;
  if (/미만/.test(s)) return 0.5;
  const nums = s.match(/\d+(\.\d+)?/g)?.map(Number) || [];
  if (!nums.length) return 0;
  return nums.length > 1 ? (nums[0] + nums[1]) / 2 : nums[0];
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const INVALID = (n) => n == null || n <= -900 || n >= 900; // 기상청 결측값 -998 등

function row(at, kind, data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) if (v != null) out[k] = v;
  const feels = feelsLike(out, kstParts(at).m);
  if (feels != null) out.feels = feels;
  return { at, kind, data: out };
}

// getVilageFcst 응답의 item 배열 → 시간별 예보 행
export function parseVilage(items) {
  const by = new Map();
  for (const it of items || []) {
    const key = `${it.fcstDate}${it.fcstTime}`;
    if (!by.has(key)) by.set(key, { date: it.fcstDate, time: it.fcstTime, v: {} });
    by.get(key).v[it.category] = it.fcstValue;
  }
  return [...by.values()].map(({ date, time, v }) => {
    const n = (k) => { const x = num(v[k]); return INVALID(x) ? null : x; };
    return row(iso(date, time), 'fcst', { t: n('TMP'), rh: n('REH'), wsd: n('WSD'), pty: n('PTY'), sky: n('SKY'), pcp: v.PCP == null ? null : parseRain(v.PCP), pop: n('POP') });
  }).filter((r) => r.data.t != null).sort((a, b) => a.at.localeCompare(b.at));
}

// getUltraSrtNcst 응답의 item 배열 → 실황 행 하나
export function parseNcst(items) {
  if (!items?.length) return [];
  const v = {};
  for (const it of items) v[it.category] = it.obsrValue;
  const n = (k) => { const x = num(v[k]); return INVALID(x) ? null : x; };
  const r = row(iso(items[0].baseDate, items[0].baseTime), 'obs', { t: n('T1H'), rh: n('REH'), wsd: n('WSD'), pty: n('PTY'), pcp: v.RN1 == null ? null : parseRain(v.RN1) });
  return r.data.t == null ? [] : [r];
}

// ---------------------------------------------------------------- 일보 날씨 요약

export const SKY_LABEL = { 1: '맑음', 3: '구름 많음', 4: '흐림' };
export const PTY_LABEL = { 1: '비', 2: '비/눈', 3: '눈', 4: '소나기', 5: '빗방울', 6: '빗방울/눈날림', 7: '눈날림' };

const topValue = (a) => { const m = new Map(); for (const v of a) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]; };

// rows: site_weather 행들. 같은 시각이면 실황을 쓴다. date(현지 날짜) 하루 요약. 자료가 없으면 null
export function dailySummary(rows, date) {
  const hours = new Map();
  for (const r of rows || []) {
    if (kstDate(r.at) !== date) continue;
    const key = new Date(r.at).getTime();
    if (!hours.has(key) || r.kind === 'obs') hours.set(key, r.data || {});
  }
  const list = [...hours.values()];
  if (!list.length) return null;
  const vals = (k) => list.map((d) => d[k]).filter((v) => v != null);
  const t = vals('t');
  const feels = vals('feels');
  const wind = vals('wsd');
  const pty = vals('pty').filter((v) => v > 0);
  return {
    min: t.length ? round1(Math.min(...t)) : null,
    max: t.length ? round1(Math.max(...t)) : null,
    feelsMax: feels.length ? round1(Math.max(...feels)) : null,
    feelsMin: feels.length ? round1(Math.min(...feels)) : null,
    rainMm: round1(vals('pcp').reduce((a, b) => a + b, 0)),
    windMax: wind.length ? round1(Math.max(...wind)) : null,
    sky: pty.length ? PTY_LABEL[topValue(pty)] || '비' : SKY_LABEL[topValue(vals('sky'))] || '',
  };
}

// 폭염·한파 단계: 설정의 기준 { caution, rest, danger } / { caution, danger }
// 돌려주는 값: { kind: 'heat'|'cold', step: 'caution'|'rest'|'danger', level: 'info'|'warn'|'danger', limit } 또는 null
export function heatStep(feels, heat = {}) {
  if (feels == null) return null;
  if (feels >= heat.danger) return { kind: 'heat', step: 'danger', level: 'danger', limit: heat.danger };
  if (feels >= heat.rest) return { kind: 'heat', step: 'rest', level: 'warn', limit: heat.rest };
  if (feels >= heat.caution) return { kind: 'heat', step: 'caution', level: 'info', limit: heat.caution };
  return null;
}
export function coldStep(feels, cold = {}) {
  if (feels == null) return null;
  if (feels <= cold.danger) return { kind: 'cold', step: 'danger', level: 'danger', limit: cold.danger };
  if (feels <= cold.caution) return { kind: 'cold', step: 'caution', level: 'warn', limit: cold.caution };
  return null;
}

const STEP_TEXT = {
  'heat:caution': (s) => [`체감온도 ${s.limit}℃ 이상 예상 — 폭염 주의`, '물·그늘을 챙기고 바깥 작업 시간을 줄이세요.'],
  'heat:rest': (s, h) => [`체감온도 ${s.limit}℃ 이상 예상 — 휴식 의무`, `${(h.restEveryMin || 120) / 60}시간마다 ${h.restMin || 20}분 이상 쉬어야 합니다.`],
  'heat:danger': (s) => [`체감온도 ${s.limit}℃ 이상 예상 — 폭염 위험`, '바깥 작업 중지·시간 조정을 검토하세요.'],
  'cold:caution': (s) => [`체감온도 ${s.limit}℃ 이하 예상 — 한파 주의`, '따뜻한 옷·물·쉴 곳을 챙기세요.'],
  'cold:danger': (s) => [`체감온도 ${s.limit}℃ 이하 예상 — 한파 위험`, '바깥 작업을 줄이고 작업 시작을 늦추는 것을 검토하세요.'],
};

// 데모 모드용: DB의 put_weather가 넣는 날씨 알림과 같은 규칙. 오늘·내일에 대해 하루·단계당 한 번, 이미 같은 날 같거나 높은 단계가 있으면 넣지 않는다.
const RANK = { caution: 1, rest: 2, danger: 3 };
export function weatherNotices(rows, settings, existing, today, siteId) {
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const out = [];
  for (const day of [today, tomorrow]) {
    const s = dailySummary(rows, day);
    if (!s) continue;
    for (const st of [heatStep(s.feelsMax, settings.heat), coldStep(s.feelsMin, settings.cold)]) {
      if (!st) continue;
      const seen = (existing || []).filter((n) => n.kind === st.kind && n.ref?.day === day);
      if (seen.some((n) => RANK[n.ref?.step] >= RANK[st.step])) continue;
      const [title, body] = STEP_TEXT[`${st.kind}:${st.step}`](st, settings.heat || {});
      out.push({ siteId, kind: st.kind, level: st.level, title, body: { ko: body }, target: { all: true }, ref: { day, step: st.step }, startsAt: `${day}T00:00:00+09:00`, endsAt: `${day}T23:59:59+09:00` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 데모 모드 가짜 날씨(같은 날짜·위도면 언제나 같은 값)

const MONTH_MEAN = [-2, 0, 6, 12.5, 18, 23, 26, 26.5, 21.5, 15, 7, 0];
const MONTH_RH = [60, 58, 58, 58, 62, 68, 78, 76, 70, 64, 62, 60];

function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

function fakeHour(lat, date, hour) {
  const month = Number(date.slice(5, 7));
  const n = hash01(date);
  const base = MONTH_MEAN[month - 1] + (37 - lat) * 0.6 + (n - 0.42) * 9;
  const t = round1(base + 5 * Math.cos(((hour - 14) / 12) * Math.PI));
  const rainy = hash01(`${date}r`) < 0.16;
  const rh = Math.max(25, Math.min(98, Math.round(MONTH_RH[month - 1] + (rainy ? 18 : 0) + 8 * Math.cos(((hour - 5) / 12) * Math.PI))));
  const wsd = round1(0.8 + hash01(`${date}w${hour >> 2}`) * 4.2);
  const pty = rainy && hour >= 7 && hour <= 18 ? (t <= 0 ? 3 : 1) : 0;
  const pcp = pty ? round1(0.4 + hash01(`${date}p${hour}`) * 2.4) : 0;
  return { t, rh, wsd, pty, sky: rainy ? 4 : n < 0.5 ? 1 : 3, pcp, pop: rainy ? 70 : 10 };
}

// from~to(날짜) 사이 시간별 행. nowIso 이전은 실황, 이후는 예보
export function fakeWeather(lat, from, to, nowIso = new Date().toISOString()) {
  const out = [];
  const now = Date.parse(nowIso);
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 864e5) {
    const date = new Date(d).toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      const at = `${date}T${pad(h)}:00:00+09:00`;
      out.push(row(at, Date.parse(at) <= now ? 'obs' : 'fcst', fakeHour(lat, date, h)));
    }
  }
  return out;
}
