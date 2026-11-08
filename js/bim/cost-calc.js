// 금액 계산(24 지시서 5·6절): 모델 수량(takeoff.js) × 단가(사람이 확인한 연결). 순수 함수. 화면은 can_view_money일 때만 부른다.
// "모델 수량 기준 참고 금액"이다. 계약·기성 금액이 아니다.
import { normUnit, linkUnit } from './cost-link.js';

export const MONEY_NOTE = '모델 수량 기준 참고 금액, 계약·기성 금액이 아님';
const r0 = (v) => Math.round(v);
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * 수량 범위: { rows: 수량 행(materialId·unit·value), zones?: { 외벽 구역 기호: ㎡ } }
 * scope = 'site' | 'b:동id' | 't:타입id' | { elementId, typeId } (이 구간)
 */
export function costScope(t, scope = 'site') {
  if (scope === 'site') return { rows: t.total, zones: t.zones || {} };
  if (typeof scope === 'string' && scope.startsWith('b:')) { const b = t.buildings[scope.slice(2)]; return { rows: b?.rows || [], zones: b?.zones || {} }; }
  if (typeof scope === 'string' && scope.startsWith('t:')) return { rows: t.unitTypes[scope.slice(2)]?.rows || [], zones: {} };
  if (scope?.panel) return { rows: [], zones: { [scope.panel.code]: scope.panel.value } };
  if (scope?.elementId) return { rows: (t.unitTypes[scope.typeId]?.items || []).filter((i) => i.elementId === scope.elementId), zones: {} };
  return { rows: [], zones: {} };
}

/** 범위에서 대상 열쇠·단위로 수량: 재료(id 또는 id|부위)·창호(op:기호)는 수량 행의 materialId, 외벽 구역(zone:기호)은 구역 면적 */
export function modelQty(sc, targetKey, unit) {
  const u = normUnit(unit);
  if (targetKey.startsWith('zone:')) return u === '㎡' ? r3(sc.zones?.[targetKey.slice(5)] || 0) : 0;
  const [id, part] = targetKey.split('|');
  return r3((sc.rows || []).filter((r) => r.materialId === id && (!part || r.part === part) && normUnit(r.unit) === u).reduce((s, r) => s + r.value, 0));
}

const confirmedLinks = (links) => links.filter((x) => x.confirmed && x.itemId);

/**
 * 확인된 연결마다 금액 행: { targetKey, name, unit, trade, qty(모델 × 환산), unitPrice, amount, source }
 * @param {{ rows: any[], zones?: any }} sc costScope 결과 @param {any[]} links 현장 연결 @param {Map<string, any>} items id → 내역 항목
 */
export function costRows(sc, links, items) {
  const out = [];
  for (const l of confirmedLinks(links)) {
    const it = items.get(l.itemId);
    if (!it || it.totalUnit == null) continue;
    const q = modelQty(sc, l.targetKey, linkUnit(l, it)) * (Number(l.factor) || 1);
    out.push({ linkId: l.id, targetKey: l.targetKey, itemId: it.id, name: it.name, spec: it.spec, unit: it.unit, trade: it.path?.[0] || '', qty: r3(q), unitPrice: it.totalUnit, material: it.materialUnit, labor: it.laborUnit, expense: it.expenseUnit, amount: r0(q * it.totalUnit), source: it.source === 'manual' ? '직접 입력' : it.bookName || '내역서' });
  }
  return out;
}
export const sumAmount = (list) => list.reduce((s, r) => s + r.amount, 0);

/** 공종별 합계 */
export function costByTrade(list) {
  const m = new Map();
  for (const r of list) m.set(r.trade || '공종 없음', (m.get(r.trade || '공종 없음') || 0) + r.amount);
  return [...m.entries()].map(([trade, amount]) => ({ trade, amount })).sort((a, b) => b.amount - a.amount);
}

/** 동별 합계(+ 단지 포장·조경) */
export function costByBuilding(t, links, items) {
  const out = Object.entries(t.buildings).map(([id, b]) => ({ id, name: b.name, amount: sumAmount(costRows(costScope(t, `b:${id}`), links, items)) }));
  const site = sumAmount(costRows({ rows: t.site?.rows || [], zones: {} }, links, items));
  if (site) out.push({ id: 'site', name: '단지(포장·조경)', amount: site });
  return out;
}

/**
 * 내역 수량 대 모델 수량: 확인된 연결의 항목마다 차이(%). 기준(기본 10%)보다 크면 big. 어느 쪽이 맞는지는 판단하지 않는다
 */
export function boqCompare(t, links, items, { threshold = 0.1 } = {}) {
  const sc = costScope(t, 'site');
  const by = new Map();
  for (const l of confirmedLinks(links)) {
    const it = items.get(l.itemId);
    if (!it) continue;
    const e = by.get(it.id) || { itemId: it.id, name: it.name, spec: it.spec, unit: it.unit, boqQty: it.qty, modelQty: 0, targets: [] };
    e.modelQty = r3(e.modelQty + modelQty(sc, l.targetKey, linkUnit(l, it)) * (Number(l.factor) || 1));
    e.targets.push(l.targetKey);
    by.set(it.id, e);
  }
  return [...by.values()].map((e) => {
    const diff = e.boqQty ? (e.modelQty - e.boqQty) / e.boqQty : null;
    return { ...e, diff: diff == null ? null : r3(diff), big: diff != null && Math.abs(diff) > threshold };
  }).sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0));
}

/** 모델 두 버전(a → b)의 금액 증감: 수량 증감 × 단가 */
export function costDiff(a, b, links, items) {
  const A = costScope(a, 'site');
  const B = costScope(b, 'site');
  const out = [];
  for (const l of confirmedLinks(links)) {
    const it = items.get(l.itemId);
    if (!it?.totalUnit) continue;
    const d = (modelQty(B, l.targetKey, linkUnit(l, it)) - modelQty(A, l.targetKey, linkUnit(l, it))) * (Number(l.factor) || 1);
    if (Math.abs(d) >= 0.001) out.push({ name: it.name, unit: it.unit, targetKey: l.targetKey, qtyDiff: r3(d), amountDiff: r0(d * it.totalUnit) });
  }
  return out.sort((x, y) => Math.abs(y.amountDiff) - Math.abs(x.amountDiff));
}

/** 연결 현황: 연결됨(확인) / 추천만(확인 전) / 못 찾음(내역 항목 쪽), 내역서에 없는 재료(모델 쪽) */
export function linkStatus(items, links, targets, recs = new Map()) {
  const done = new Set(confirmedLinks(links).map((l) => l.itemId));
  const hitTargets = new Set(confirmedLinks(links).map((l) => l.targetKey));
  const list = [...items.values()];
  return {
    linked: list.filter((it) => done.has(it.id)).length,
    suggested: list.filter((it) => !done.has(it.id) && recs.get(it.id)?.length).length,
    notFound: list.filter((it) => !done.has(it.id) && !recs.get(it.id)?.length).length,
    missing: targets.filter((t) => !hitTargets.has(t.key)),
  };
}
