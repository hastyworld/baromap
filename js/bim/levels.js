// 레벨·층고(04 7절): 입·단면 추출의 레벨 표를 동마다 모은다. 단면도 우선, 시트끼리 50mm 넘게 다르면 충돌.
// 입·단면이 없으면 배치도 층수 글자 × 기본 층고(2.9m, 1층 필로티면 4.5m)로 가정(assumed). 순수 함수.

export const DEFAULT_H = 2.9;
export const PILOTIS_H = 4.5;

const lv = (l) => ({ id: `lv_${l.name}`, name: l.name, elevation: Math.round(l.elevationMm) / 1000, height: l.heightMm != null ? Math.round(l.heightMm) / 1000 : 0, kind: l.kind });

/**
 * @param {Array<{ sheet: any, data: any }>} extracts 이 동의 LevelExtract들
 * @param {{ floorsText?: string|null, pilotisPlan?: boolean }} fallback
 */
export function buildingLevels(extracts, { floorsText = null, pilotisPlan = false } = {}) {
  const ordered = [...extracts].sort((a, b) => (a.sheet.category === 'section' ? 0 : 1) - (b.sheet.category === 'section' ? 0 : 1) || String(a.sheet.sheetNo).localeCompare(String(b.sheet.sheetNo)));
  const conflicts = [];
  const main = ordered.find((x) => x.data?.levels?.length);
  if (main) {
    for (const other of ordered) {
      if (other === main) continue;
      for (const l of other.data?.levels || []) {
        const m = main.data.levels.find((x) => x.name === l.name);
        if (m && Math.abs(m.elevationMm - l.elevationMm) > 50) conflicts.push({ name: l.name, a: { sheetId: main.sheet.id, sheetNo: main.sheet.sheetNo, mm: m.elevationMm }, b: { sheetId: other.sheet.id, sheetNo: other.sheet.sheetNo, mm: l.elevationMm } });
      }
    }
    const levels = main.data.levels.map(lv);
    return { levels, source: { method: main.data._source || 'rule', sheets: ordered.map((x) => ({ sheetId: x.sheet.id, sheetNo: x.sheet.sheetNo })), confidence: 0.8 }, conflicts, assumed: false, floorsAbove: levels.filter((l) => /^\d+F$/.test(l.name)).length };
  }
  const n = parseInt(/지상\s*(\d+)/.exec(floorsText || '')?.[1] || '0', 10);
  if (!n) return { levels: [], source: { method: 'assumed', sheets: [], confidence: 0 }, conflicts, assumed: true, floorsAbove: 0 };
  const levels = [];
  let e = 0;
  for (let f = 1; f <= n; f++) {
    const h = f === 1 && pilotisPlan ? PILOTIS_H : DEFAULT_H;
    levels.push({ id: `lv_${f}F`, name: `${f}F`, elevation: Math.round(e * 1000) / 1000, height: h, kind: f === 1 && pilotisPlan ? 'pilotis' : 'typical' });
    e += h;
  }
  levels.push({ id: 'lv_RF', name: 'RF', elevation: Math.round(e * 1000) / 1000, height: 0, kind: 'rooftop' });
  return { levels, source: { method: 'assumed', sheets: [], confidence: 0.3 }, conflicts, assumed: true, floorsAbove: n };
}

export const floorNo = (name) => { const m = /^(\d+)F$/.exec(name); return m ? Number(m[1]) : null; };
