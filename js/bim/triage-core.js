// 판별 결과 읽기·고치기(브라우저·Node·Edge Function 공용, 다른 파일을 import하지 않는다). 판별 자체는 js/cad/triage.js.
// 판정은 세 층이다: 규칙(rule) < AI(ai) < 사람(human).

export const CLASSES = ['building', 'furnishing', 'hidden', 'text', 'dimension', 'grid', 'annotation', 'table', 'frame', 'unknown'];
export const PARTS = ['wall', 'column', 'door', 'window', 'opening', 'stair', 'core', 'slab_edge', 'facade', 'finish', 'site', 'site_boundary', 'road', 'landscape', 'building_outline', 'underground', 'other'];

export const clusterVerdict = (c) => c.human || c.ai || c.rule;

export function countClasses(t) {
  const out = {};
  for (const c of t.clusters) { const v = clusterVerdict(c); out[v.cls] = (out[v.cls] || 0) + c.n; }
  for (const e of Object.values(t.entities || {})) {
    const v = e.human || e.ai;
    if (!v || !e.from) continue;
    out[e.from] = (out[e.from] || 0) - 1;
    out[v.cls] = (out[v.cls] || 0) + 1;
  }
  return out;
}

// AI 답 적용: 무리·낱개 판정. 사람 판정은 건드리지 않는다. 돌려주는 값은 바뀐 무리 id
export function applyAi(t, answer) {
  const changed = [];
  for (const a of answer.clusters || []) {
    const c = t.clusters.find((x) => x.id === a.id);
    if (!c) continue;
    const before = clusterVerdict(c).cls;
    c.ai = { cls: a.class, part: a.part ?? null, conf: a.confidence, reason: a.reason };
    if (clusterVerdict(c).cls !== before) changed.push(c.id);
  }
  for (const e of answer.entities || []) {
    t.entities[e.h] = { ...(t.entities[e.h] || {}), ai: { cls: e.class, part: e.part ?? null, reason: e.reason } };
  }
  t.missing = answer.missing || [];
  t.passes = (t.passes || 0) + 1;
  t.counts = countClasses(t);
  return changed;
}

// AI에게 보낼 무리 표(글자 내용은 없다). only가 있으면 그 무리만
export const clusterTable = (t, { only = null } = {}) => t.clusters
  .filter((c) => !only || only.has(c.id))
  .map((c) => { const v = clusterVerdict(c); return { id: c.id, layer: c.layer, lt: c.lt, color: c.color, kind: c.kind, block: c.block, n: c.n, lenM: c.lenM, verdict: v.cls, part: v.part || null, conf: v.conf ?? null, box: c.box }; });
