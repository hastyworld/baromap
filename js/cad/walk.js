// 블록 풀기: 중첩 8단계까지, 블록 안 레이어 "0"은 끼워 넣은 레이어를 따르고(색 BYBLOCK도 같은 방식),
// MINSERT 배열은 칸마다 펼친다. 치수(DIMENSION)는 그림 블록을 함께 푼다.
// 개체마다 fn(개체, 변환 행렬, ctx)을 부른다. ctx.path = "삽입핸들/개체핸들" 경로.
import { ID, FLIP, mul, insertMatrix } from './geom.js';

const OCS = new Set(['circle', 'arc', 'poly', 'text', 'attrib', 'attdef', 'hatch', 'solid', 'insert', 'dim']);

/**
 * @param {any} dxf parse 결과
 * @param {any[]} entities 풀 개체 목록(최상위)
 * @param {(e: any, m: number[], ctx: any) => (void|boolean)} fn insert에서 false를 돌려주면 그 안으로 들어가지 않는다
 * @param {{ matrix?: number[], maxDepth?: number, layer?: string|null, color?: number|null, path?: string }} [opts]
 */
export function walk(dxf, entities, fn, { matrix = ID, maxDepth = 8, layer = null, color = null, path = '', top = null } = {}) {
  const layers = dxf.layers || {};
  const resolveColor = (e, effLayer, inherit) => {
    if (e.color === 0) return inherit ?? 7; // BYBLOCK
    if (e.color === 256 || e.color == null) return layers[effLayer]?.color ?? 7; // BYLAYER
    return e.color;
  };
  const visit = (list, m, inheritLayer, inheritColor, prefix, depth, topEnt) => {
    for (const e of list) {
      const effLayer = e.layer === '0' && inheritLayer ? inheritLayer : e.layer;
      const effColor = resolveColor(e, effLayer, inheritColor);
      const pathHere = prefix ? `${prefix}/${e.h}` : e.h;
      const t = topEnt || e;
      const me = e.ext < 0 && OCS.has(e.type) && e.type !== 'insert' ? mul(m, FLIP) : m;
      const ctx = { layer: effLayer, color: effColor, path: pathHere, depth, top: t, rgb: e.rgb ?? null };
      if (e.type === 'insert') {
        const go = fn(e, m, ctx);
        const b = dxf.blocks?.[e.name];
        if (go === false || !b) continue;
        if (depth >= maxDepth) { dxf.warnings?.push(`블록이 너무 깊이 겹쳐 있어 ${maxDepth}단계까지만 풀었습니다: ${e.name}`); continue; }
        for (let r = 0; r < (e.rows || 1); r++) {
          for (let c = 0; c < (e.cols || 1); c++) {
            const im = mul(m, insertMatrix(e, b.base, [c * (e.dc || 0), r * (e.dr || 0)]));
            const p = e.rows > 1 || e.cols > 1 ? `${pathHere}#${r}.${c}` : pathHere;
            visit(b.entities, im, effLayer, effColor, p, depth + 1, t);
          }
        }
        for (const a of e.attribs || []) {
          if (a.hidden) continue;
          const al = a.layer === '0' ? effLayer : a.layer;
          const am = a.ext < 0 ? mul(m, FLIP) : m;
          fn(a, am, { layer: al, color: resolveColor(a, al, effColor), path: `${pathHere}/${a.h}`, depth, top: t, insert: e, rgb: a.rgb ?? null });
        }
        continue;
      }
      if (e.type === 'dim') {
        fn(e, me, ctx);
        const b = dxf.blocks?.[e.block];
        if (b && depth < maxDepth) visit(b.entities, m, effLayer, effColor, pathHere, depth + 1, t);
        continue;
      }
      fn(e, me, ctx);
    }
  };
  visit(entities, matrix, layer, color, path, 0, top);
}

// 레이어별 개체 수(풀어서)
export function layerCounts(dxf, entities = dxf.entities) {
  const out = {};
  walk(dxf, entities, (e, m, ctx) => {
    if (e.type === 'insert') return;
    const c = (out[ctx.layer] ||= {});
    c[e.type] = (c[e.type] || 0) + 1;
  });
  return out;
}
