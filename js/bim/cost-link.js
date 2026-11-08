// 내역 항목 ↔ 모델 잇기(24 지시서 2절). 순수 함수. 추천만 하고, 사람이 확인해야 연결된다(confirmed).
// AI 후보 요청에는 품명·규격·단위만 보낸다(단가·금액·수량 없음) — 시험으로 지킨다.
// 모델 쪽 열쇠: 재료 id(모든 부위) · 재료 id|부위(예: 수성페인트|천장) · op:창호 기호 · zone:외벽 구역 기호
import { itemKey } from './cost-core.js';
import { PART_LABEL } from './takeoff.js';

// 내역서 품명 → 모델 재료 이름(같은 뜻의 다른 말)
const SYNONYMS = [
  [/레미콘|콘크리트\s*타설|레디\s*믹스/, '콘크리트'], [/수성\s*페인트|수성\s*도장|도장\s*\(수성\)/, '수성페인트'], [/실크\s*벽지|벽지\s*\(실크\)/, '실크벽지'],
  [/강마루|강화\s*마루/, '강마루'], [/자기질\s*타일/, '자기질타일'], [/도기질\s*타일/, '도기질타일'], [/액체\s*방수/, '액체방수'], [/우레탄\s*(도막\s*)?방수|도막\s*방수/, '우레탄방수'],
  [/방습\s*석고/, '방습석고보드'], [/석고\s*보드|일반\s*석고/, '석고보드'], [/비드법|EPS/i, '단열재(비드법'], [/경량\s*기포/, '경량기포콘크리트'], [/완충재|층간\s*소음/, '완충재'],
  [/시멘트\s*몰탈|몰탈\s*바름|방바닥\s*미장/, '시멘트몰탈'], [/인조석/, '인조석'], [/MDF|걸레받이/i, 'MDF 걸레받이'], [/화강석/, '화강석'], [/보도\s*블록/, '보도블록'], [/고무\s*칩/, '고무칩'], [/경량\s*(철골|스터드)/, '경량스터드'],
  [/흡음\s*텍스|텍스\s*천장/, '흡음텍스'], [/데코\s*타일/, '데코타일'],
];
// 품명·규격에 부위 낱말이 있으면 그 부위 대상에 점수를 더 준다
const PART_HINTS = [[/외벽|외부\s*벽|입면/, ['panel']], [/천장|반자/, ['ceiling']], [/지붕|옥상/, ['roof']], [/걸레받이/, ['base']], [/방바닥|바닥\s*구성|바탕/, ['floorBuild']], [/바닥\s*마감|바닥재/, ['floor']], [/바닥/, ['floor', 'floorBuild']],
  [/벽체|조적/, ['wall']], [/내벽|벽면|벽\s*마감|벽지/, ['wallFinish']], [/슬래브/, ['slab']], [/기둥/, ['column']]];
const OPENING = /(?:^|[^A-Z])((?:AW|PW|SW|BW|CW|AL|PL|WD|SD|FD|AD|SSD)\d{1,2}[A-Z]?)(?![A-Z0-9])/;
const ZONE = /(?:^|[^A-Z])(EX-?\d{1,2})(?![0-9])/i;
const UNIT_EQ = [['㎡', 'm2', 'M2', 'm²', '평방미터'], ['㎥', 'm3', 'M3', 'm³', '루베'], ['m', 'M', '미터'], ['개소', 'EA', 'ea', '개', '조', '틀', 'SET', 'set'], ['주', '본'], ['ton', 'TON', 'Ton', '톤']];
export const normUnit = (u) => { const s = String(u || '').trim(); for (const g of UNIT_EQ) if (g.includes(s)) return g[0]; return s; };
/** 단위 환산 계수(모델 수량 × factor = 내역 수량). 같은 단위면 1, 모르면 null(사람이 넣는다. 예: 내역은 매, 모델은 ㎡) */
export function unitFactor(itemUnit, modelUnit) {
  return normUnit(itemUnit) === normUnit(modelUnit) ? 1 : null;
}

/**
 * 모델 쪽 연결 대상: 재료(+ 여러 부위에 쓰이면 부위별), 창호 기호, 외벽 구역. 각 대상의 단위 목록(units)도 붙인다
 * @param {Record<string, any>} files 모델 파일 @param {any} [t] takeoff 결과(부위·단위를 알려면)
 */
export function costTargets(files, t = null) {
  const cat = files['catalog.json'] || {};
  const rows = t?.total || [];
  const unitsOf = (f) => [...new Set(rows.filter(f).map((r) => r.unit))];
  const out = [];
  for (const m of cat.materials || []) {
    const mine = rows.filter((r) => r.materialId === m.id);
    out.push({ kind: 'material', key: m.id, name: m.name, category: m.category, units: unitsOf((r) => r.materialId === m.id) });
    const parts = [...new Set(mine.map((r) => r.part))];
    if (parts.length > 1) for (const p of parts) out.push({ kind: 'material', key: `${m.id}|${p}`, name: `${m.name} · ${PART_LABEL[p] || p}`, category: m.category, part: p, units: unitsOf((r) => r.materialId === m.id && r.part === p) });
  }
  const codes = new Set();
  for (const [k, f] of Object.entries(files)) if (k.startsWith('u-')) for (const o of f.openings || []) if (o.typeCode) codes.add(String(o.typeCode).toUpperCase());
  for (const r of rows) if (r.materialId.startsWith('op:')) codes.add(r.materialId.slice(3));
  for (const c of [...codes].sort()) out.push({ kind: 'windowType', key: `op:${c}`, name: c, category: 'opening', units: unitsOf((r) => r.materialId === `op:${c}`) });
  // 그 밖의 수량 행(수목·시설물·지붕·난간·유리 등): 이름으로 잇는다
  const seen = new Set(out.map((x) => x.key.split('|')[0]));
  for (const r of rows) {
    if (seen.has(r.materialId) || r.materialId.startsWith('op:')) continue;
    seen.add(r.materialId);
    out.push({ kind: 'elementKind', key: r.materialId, name: r.name, category: r.part, units: unitsOf((x) => x.materialId === r.materialId) });
  }
  for (const [k, b] of Object.entries(files)) {
    if (!k.startsWith('b-')) continue;
    for (const z of b.facade?.zones || []) {
      if (!z.code || out.some((x) => x.key === `zone:${z.code}`)) continue;
      const m = (cat.materials || []).find((x) => x.id === z.materialId);
      out.push({ kind: 'facadeZone', key: `zone:${z.code}`, name: `외벽 ${z.code}${m ? ` ${m.name}` : ''}`, category: 'facade', units: ['㎡'] });
    }
  }
  return out;
}

const bigrams = (s) => { const t = String(s || '').replace(/[\s()·,]/g, ''); const out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
const dice = (a, b) => { const A = bigrams(a); const B = bigrams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size); };
const hintParts = (text) => PART_HINTS.filter(([re]) => re.test(text)).flatMap(([, p]) => p);
const hits = (parts, p) => parts.filter((x) => x === p).length;

/**
 * 항목 하나 → 후보(점수순, 다섯 개까지). 회사 사전 → 창호 기호 → 외벽 구역 기호 → 재료 이름(같은 뜻) → 이름 포함
 * @param {any} item @param {any[]} targets costTargets 결과 @param {Map<string, { targetKind, targetKey, factor }>} dict itemKey → 사전 연결
 */
export function recommend(item, targets, dict = new Map()) {
  const out = [];
  const add = (t, score, why) => {
    if (!t) return;
    const i = out.findIndex((x) => x.key === t.key);
    if (i >= 0) { if (out[i].score < score) out[i] = { ...out[i], score, why }; return; }
    out.push({ ...t, score, why });
  };
  const d = dict.get(itemKey(item));
  if (d) add({ ...(targets.find((t) => t.key === d.targetKey) || { kind: d.targetKind, key: d.targetKey, name: d.targetKey }), factor: d.factor }, 1, '회사 사전');
  const text = `${item.name} ${item.spec || ''}`;
  const op = OPENING.exec(text.toUpperCase());
  if (op) add(targets.find((t) => t.key === `op:${op[1]}`), 0.95, '창호 기호');
  const z = ZONE.exec(text);
  if (z) add(targets.find((t) => t.key === `zone:${z[1].toUpperCase().replace(/^EX(\d)/, 'EX-$1')}`), 0.92, '외벽 구역 기호');
  const parts = hintParts(text);
  const unit = normUnit(item.unit);
  const fit = (t) => (t.part ? 0.03 * hits(parts, t.part) : 0) + (t.units?.length && !t.units.includes(unit) ? -0.1 : 0) + 0.04 * dice(text, t.name);
  for (const [re, name] of SYNONYMS) {
    if (!re.test(text)) continue;
    for (const t of targets.filter((x) => x.kind === 'material' && x.name.startsWith(name))) add(t, 0.78 + fit(t) - (t.part && !parts.includes(t.part) ? 0.05 : 0), '품명');
  }
  const flat = text.replace(/\s/g, '');
  for (const t of targets.filter((x) => (x.kind === 'material' || x.kind === 'elementKind') && !x.part && x.name.length >= 2 && flat.includes(x.name.replace(/\s/g, '')))) add(t, 0.7 + fit(t), '이름이 같음');
  return out.sort((a, b) => b.score - a.score).slice(0, 5).map((x) => ({ ...x, score: Math.round(x.score * 100) / 100 }));
}

/** 사람이 확인한 연결 → 회사 사전 줄(금액 없음) */
export const dictRow = (link, item) => ({ siteId: null, targetKind: link.targetKind, targetKey: link.targetKey, itemId: null, itemKey: itemKey(item), factor: Number(link.factor) || 1, modelUnit: link.modelUnit || '', confirmed: true, note: '' });

/** 회사 사전 줄들 → itemKey로 찾는 표 */
export const dictMap = (rows) => new Map(rows.filter((r) => r.itemKey).map((r) => [r.itemKey, r]));

/** 사람이 고른 후보 → 현장 연결 줄(확인됨). factor는 단위가 다르면 사람이 넣은 값 */
export function linkRow(siteId, item, target, factor = null, modelUnit = null) {
  const u = target.units?.length ? target.units : [];
  const same = !u.length || u.includes(normUnit(item.unit));
  const mu = modelUnit || (same ? '' : u[0]);
  const f = factor ?? (same ? 1 : null);
  if (f == null) throw new Error(`단위가 달라(${item.unit} ↔ ${u.join('·')}) 환산 계수를 넣어야 합니다.`);
  return { siteId, targetKind: target.kind, targetKey: target.key, itemId: item.id, itemKey: itemKey(item), factor: f, modelUnit: mu, confirmed: true, note: '' };
}
/** 연결의 모델 쪽 단위(비어 있으면 내역 단위와 같다) */
export const linkUnit = (link, item) => link.modelUnit || item.unit;

/** AI 후보 요청: 연결 안 된 항목의 품명·규격·단위와 모델 대상 이름만. 단가·금액·수량은 보내지 않는다 */
export function costAiRequest(items, targets) {
  return {
    items: items.slice(0, 300).map((it, i) => ({ i, name: String(it.name || '').slice(0, 200), spec: String(it.spec || '').slice(0, 200), unit: String(it.unit || '').slice(0, 20) })),
    targets: targets.slice(0, 400).map((t) => ({ key: t.key, kind: t.kind, name: t.name })),
  };
}
