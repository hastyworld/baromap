// 공종·위치 짝 짓기(28 지시서 4절): 공정 행 하나를 "구역 + 층 범위 + 라인(선택) + 공종"으로 푼다. 순수 함수.
// 순서: 파일에 적힌 값 → 회사 사전 → 이름 규칙 → (켜져 있으면) AI 제안 → 사람 확인. 못 붙은 행은 지우지 않고 linked=false로 남긴다.
import { normBuilding, normFloor, floorRank, parseFloorRange, parseBuildings, zoneOf } from './core.js';
import { tradeFromText, canonicalTrade, tradeZone } from './trades.js';

const FACILITY_WORDS = ['주민공동시설', '커뮤니티', '부대시설', '관리동', '경비실', '근린생활시설', '근생', '어린이집', '경로당'];
const UNDER_WORDS = ['지하주차장', '주차장', '지하층'];
const SITE_WORDS = ['단지', '부지', '대지', '단지전체', '외부공간'];

/**
 * 모델(BIM site.json) 또는 골구도 동 목록 → 짝 짓기용 색인.
 * @param {{ site?: any, buildings?: { name: string }[] }} o
 * @returns {{ buildings: Map<string, { id: string, name: string, kind: string, floors: string[] }>, facilities: { id: string, name: string, floors: string[] }[], underground: boolean, has: boolean }}
 */
export function modelIndex({ site = null, buildings = [] } = {}) {
  const map = new Map();
  const facilities = [];
  const floorsOf = (above, below) => [...Array.from({ length: below || 0 }, (_, i) => `B${(below || 0) - i}`), ...Array.from({ length: above || 0 }, (_, i) => String(i + 1)), 'PH'];
  for (const b of site?.buildings || []) {
    const entry = { id: b.id, name: b.name, kind: b.kind, floors: floorsOf(b.floorsAbove, b.floorsBelow) };
    if (b.kind === 'apartment' || /^\d{3,4}\s*동$/.test(b.name)) map.set(normBuilding(b.name), entry);
    else facilities.push(entry);
  }
  for (const b of buildings) {
    const k = normBuilding(b.name);
    if (!map.has(k) && /^\d{1,4}$/.test(k)) {
      const top = Math.max(0, ...(b.lines || []).map((l) => Number(l.to) || 0));
      map.set(k, { id: b.id, name: b.name, kind: 'apartment', floors: top ? floorsOf(top, 0) : [] });
    }
  }
  return { buildings: map, facilities, underground: Boolean(site?.underground?.length), has: Boolean(map.size || facilities.length) };
}

/** 사전 열쇠: 이름에서 동·층·숫자·기호를 뺀 글자('101동 지상골조 2~15F' → '지상골조') */
export function tradeKey(name) {
  return String(name ?? '')
    .replace(/(?:제\s*)?\d{3,4}\s*(?:~\s*\d{3,4}\s*)?동/g, '')
    .replace(/(?:지하|지상|B)?\s*\d{1,2}\s*(?:F|층)?\s*(?:~|-)\s*(?:지하|지상|B)?\s*\d{1,2}\s*(?:F|층)?/gi, '')
    .replace(/(?:지하|지상|B)\s*\d{1,2}\s*(?:F|층)?|\d{1,2}\s*(?:F|층)|PH|RF|옥탑층?/gi, '')
    .replace(/[\d\s~\-·,./()[\]_#]+/g, '')
    .toUpperCase()
    .slice(0, 60);
}

const has = (text, words) => words.some((w) => text.replace(/\s/g, '').includes(w));

/**
 * 활동 하나 짝 짓기 → 고친 활동(여러 동이면 여러 개).
 * @param {any} a activity()
 * @param {{ index?: ReturnType<typeof modelIndex>, dict?: Map<string, { trade?: string, zone?: string }>, siteTrades?: string[] }} ctx
 */
export function matchOne(a, ctx = {}) {
  const index = ctx.index || modelIndex();
  const extra = ctx.siteTrades || [];
  const warnings = [];
  const text = [a.name, ...(a.wbs || [])].join(' ');
  let method = 'rule';
  let zone = zoneOf(a.zone);
  // 동 칸에 '102~103', '101,102'처럼 여러 동이 적혀도 펼친다
  const listed = a.building ? parseBuildings(/동/.test(a.building) ? a.building : `${a.building}동`) : [];
  let buildings = a.building ? (listed.length > 1 ? listed : [normBuilding(a.building)]) : [];
  let from = a.fromFloor ? normFloor(a.fromFloor) : '';
  let to = a.toFloor ? normFloor(a.toFloor) : from;
  let trade = a.trade ? canonicalTrade(a.trade, extra) : '';
  const fromFile = Boolean(a.zone || a.trade);
  if (fromFile) method = 'file';
  if (a.trade && trade !== a.trade) warnings.push(`공종 '${a.trade}'을(를) '${trade}'(으)로 읽었습니다.`);

  // 회사 사전
  const hit = ctx.dict?.get(tradeKey(a.name));
  if (hit && (!trade || !zone)) {
    if (!trade && hit.trade) trade = hit.trade;
    if (!zone && hit.zone) zone = hit.zone;
    method = fromFile ? 'file' : 'dict';
  }
  // 이름 규칙
  if (!trade) trade = tradeFromText(a.name, extra)?.trade || tradeFromText(text, extra)?.trade || '';
  if (!buildings.length) buildings = parseBuildings(a.name).length ? parseBuildings(a.name) : parseBuildings(text);
  if (!from) {
    const r = parseFloorRange(a.name);
    if (r) { from = r.from; to = r.to; }
  }
  let facility = null;
  if (!zone) {
    if (buildings.length) zone = 'building';
    else if (has(text, UNDER_WORDS)) zone = 'underground';
    else if (has(text, FACILITY_WORDS) || index.facilities.some((f) => text.includes(f.name))) zone = 'facility';
    else if (has(text, SITE_WORDS)) zone = 'site';
    else if (tradeZone(trade)) zone = tradeZone(trade);
  }
  if (zone === 'facility') {
    facility = index.facilities.find((f) => text.includes(f.name) || (a.building && f.name === a.building)) || (index.facilities.length === 1 ? index.facilities[0] : null);
    buildings = facility ? [facility.name] : buildings.filter((b) => !/^\d+$/.test(b));
  }
  if (zone !== 'building' && zone !== 'facility') buildings = [];

  const out = (buildings.length ? buildings : ['']).map((b) => {
    const w = [...warnings];
    let f0 = from;
    let f1 = to || from;
    const m = zone === 'building' ? index.buildings.get(b) : zone === 'facility' ? facility || index.facilities.find((x) => x.name === b) : null;
    if (zone === 'building' && b && index.has && !m) w.push(`모델에 없는 동(${b}동)입니다.`);
    if (m?.floors?.length) {
      if (!f0) { f0 = m.floors[0]; f1 = m.floors[m.floors.length - 1]; if (zone === 'building') w.push('층 범위가 없어 동 전체로 봤습니다.'); }
      const top = Math.max(...m.floors.filter((x) => x !== 'PH').map(floorRank));
      if (f1 && f1 !== 'PH' && floorRank(f1) > top) w.push(`끝층(${f1})이 그 동 최고층(${top}층)보다 높습니다.`);
    }
    const linked = Boolean(trade && zone && zone !== 'unknown' && (zone !== 'building' || b));
    return {
      ...a,
      actId: buildings.length > 1 ? `${a.actId}-${b}`.slice(0, 60) : a.actId,
      zone: zone || '',
      building: b,
      fromFloor: f0,
      toFloor: f1,
      trade,
      linked,
      source: { ...a.source, match: method, ...(buildings.length > 1 ? { expandedFrom: a.actId } : {}), ...(w.length ? { warnings: w } : {}) },
    };
  });
  return out;
}

/**
 * 활동 목록 짝 짓기. 요약 행은 그대로 두고(계산에서 빠짐), 여러 동 행은 펼친다.
 * @returns {any[]}
 */
export function matchActivities(list, ctx = {}) {
  return list.flatMap((a) => (a.summary ? [{ ...a, linked: false }] : matchOne(a, ctx)));
}

/** 사람이 고친 짝 → 사전 항목(다음 현장에도 쓴다) */
export function learnEntry(a) {
  const key = tradeKey(a.name);
  if (!key || !a.trade) return null;
  return { key, trade: a.trade, zone: a.zone && a.zone !== 'building' ? a.zone : '' };
}

/** 사전 행 목록 → Map */
export const dictMap = (rows) => new Map((rows || []).filter((r) => r.key).map((r) => [r.key, { trade: r.trade, zone: r.zone }]));

// ---------------------------------------------------------------- AI 제안(켜져 있을 때만, 28 지시서 4절 3)

/** AI에 보내는 내용: 연결 안 된 행의 이름·WBS만. 금액·날짜·수량은 보내지 않는다(26 지시서 6절) */
export function aiMatchRequest(list, { buildings = [], trades = [] } = {}) {
  const rows = list.map((a, i) => ({ i, a })).filter(({ a }) => !a.summary && !a.linked).slice(0, 400)
    .map(({ i, a }) => ({ i, name: a.name, wbs: (a.wbs || []).slice(0, 6) }));
  return { buildings: buildings.slice(0, 100), trades: trades.slice(0, 100), rows };
}

/** AI 답 → 제안(suggest)만 붙인다. 사람이 받기 전에는 linked가 바뀌지 않는다 */
export function applyAiMatch(list, answer) {
  const out = list.map((a) => ({ ...a }));
  for (const r of answer?.rows || []) {
    const a = out[r.i];
    if (!a || a.linked || a.summary) continue;
    const zone = zoneOf(r.zone);
    if (!zone || !r.trade) continue;
    a.suggest = { zone, building: normBuilding(r.building || ''), fromFloor: normFloor(r.fromFloor || ''), toFloor: normFloor(r.toFloor || r.fromFloor || ''), trade: String(r.trade).slice(0, 30), confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)) };
  }
  return out;
}

/** 제안 받기(사람이 누름) */
export function acceptSuggest(a) {
  if (!a.suggest) return a;
  const { confidence, ...s } = a.suggest;
  const { suggest, ...rest } = a;
  const linked = Boolean(s.trade && s.zone && (s.zone !== 'building' || s.building));
  return { ...rest, ...s, linked, source: { ...rest.source, match: 'ai', aiConfidence: confidence } };
}
