// 문·창(04 3절): 벽 틈에서 찾은 개구부에 기호(블록 속성 TYPE 또는 근처 기호 글자)와 크기(창호 일람표, 없으면 기본값)를 붙인다.
import { tagKind } from './rule-read.js';

export const DEFAULT_SIZE = {
  door: { height: 2.1, sill: 0 },
  window: { height: 1.2, sill: 0.9 },
  balconyWindow: { height: 2.2, sill: 0 },
  opening: { height: 2.1, sill: 0 },
};

/**
 * @param {{ kind: string, insert?: any, center: number[], width: number }} op 벽 그래프의 개구부(m)
 * @param {Array<{ code: string, kind: string, pos: number[] }>} tags 문·창 기호 글자(m)
 * @param {Map<string, any>} schedule 창호 일람표 기호 → { widthMm, heightMm, sillMm }
 * @param {{ balcony: boolean }} ctx 한쪽이 발코니인 벽
 */
export function describeOpening(op, tags, schedule, ctx = {}) {
  let typeCode = null;
  const attrs = op.insert?.attribs || {};
  for (const v of Object.values(attrs)) {
    const k = tagKind(v);
    if (k === 'door' || k === 'window') { typeCode = v.trim(); break; }
  }
  if (!typeCode && op.kind !== 'opening') {
    const want = op.kind;
    const near = tags.filter((t) => t.kind === want && Math.hypot(t.pos[0] - op.center[0], t.pos[1] - op.center[1]) < Math.max(1.2, op.width))
      .sort((a, b) => Math.hypot(a.pos[0] - op.center[0], a.pos[1] - op.center[1]) - Math.hypot(b.pos[0] - op.center[0], b.pos[1] - op.center[1]));
    typeCode = near[0]?.code || null;
  }
  const sch = typeCode ? schedule.get(typeCode) : null;
  const def = op.kind === 'window' && ctx.balcony ? DEFAULT_SIZE.balconyWindow : DEFAULT_SIZE[op.kind] || DEFAULT_SIZE.opening;
  const height = sch?.heightMm ? sch.heightMm / 1000 : def.height;
  const sill = sch?.sillMm != null ? sch.sillMm / 1000 : def.sill;
  return {
    typeCode,
    height,
    sill,
    sized: Boolean(sch?.heightMm),
    scheduleWidth: sch?.widthMm ? sch.widthMm / 1000 : null,
    method: sch ? 'rule' : 'assumed',
  };
}
