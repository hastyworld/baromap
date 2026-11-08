// 옛 모델 파일을 읽을 때 메모리에서 baromap-bim/2로 올린다(18 1절). 빈 칸만 채우고 기존 칸의 뜻은 바꾸지 않는다.
// 저장된 옛 파일은 그대로 두고, 고쳐서 저장하면 그때 /2가 된다. 몇 번을 돌려도 같은 결과다.
export const BIM_SCHEMA = 'baromap-bim/2';

export function upgradeFile(name, f) {
  if (!f || typeof f !== 'object') return f;
  if (name === 'index.json') return { ...f, schema: BIM_SCHEMA };
  if (name === 'catalog.json') {
    return {
      ...f,
      materials: (f.materials || []).map((m) => ({ spec: null, maker: null, perf: [], render: { textureId: null, tint: null }, ...m })),
      assemblies: f.assemblies || [],
      windowTypes: f.windowTypes || [],
      details: f.details || [], // 시공 상세 값(38 지시서 2절)
      structure: f.structure || [], // 구조 부재(38 지시서 3절)
    };
  }
  if (name === 'site.json') return { id: 'site', terrain: null, pavings: [], trees: [], features: [], ...f };
  if (/^b-.+\.json$/.test(name)) return { baseElevation: 0, facade: { zones: [], panels: [] }, balconies: [], roof: null, ...f };
  return f;
}

export function upgradeFiles(files) {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, upgradeFile(k, v)]));
}
