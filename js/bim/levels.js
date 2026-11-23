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
  // 층이 더 많이 적힌 시트 먼저(계단·코아 단면처럼 일부 층만 그린 단면이 동 전체 입면을 이기지 않게), 같으면 단면도 먼저
  const floorsOf = (x) => (x.data?.levels || []).filter((l) => /^\d+F$/.test(l.name)).length;
  const ordered = [...extracts].sort((a, b) => floorsOf(b) - floorsOf(a) || (a.sheet.category === 'section' ? 0 : 1) - (b.sheet.category === 'section' ? 0 : 1) || String(a.sheet.sheetNo).localeCompare(String(b.sheet.sheetNo)));
  const conflicts = [];
  const main = ordered.find((x) => x.data?.levels?.length);
  if (main) {
    for (const other of ordered) {
      if (other === main) continue;
      // 글자 높이 차이로 만든 레벨(relative)이 일부 층만이면 지붕 높이 등이 끊어 그린 값이라 견주지 않는다
      if (other.data?.relative && floorsOf(other) < floorsOf(main)) continue;
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
const basementNo = (name) => { const m = /^B(\d+)F?$/i.exec(String(name || '')); return m ? Number(m[1]) : null; };

/**
 * 도면의 층 글자 → 이 동의 레벨들(45 지시서 5.1). "15층"·"15F", 범위 "3~14층"·"3F~14F"(범위의 층 모두),
 * "지하2층"·"B2F", "최하층"(가장 낮은 세대 층 — 필로티 빼고)·"최상층", "지붕"·"옥탑". 기준층은 따로(기준층 템플릿)
 * @param {string[]} floors 시트 refs.floors
 * @param {Array<{ id: string, name: string, kind?: string }>} levels
 */
export function levelsForFloors(floors = [], levels = []) {
  const out = new Set();
  const above = levels.filter((l) => floorNo(l.name) != null);
  const homes = above.filter((l) => l.kind !== 'pilotis');
  const add = (l) => l && out.add(l);
  for (const raw of floors) {
    const f = String(raw || '').replace(/\s+/g, '');
    let m;
    if ((m = /^(\d+)(?:층|F)?~(\d+)(?:층|F)$/i.exec(f))) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      for (const l of above) if (floorNo(l.name) >= a && floorNo(l.name) <= b) add(l);
    } else if ((m = /^(\d+)(?:층|F)$/i.exec(f))) add(above.find((l) => floorNo(l.name) === Number(m[1])));
    else if ((m = /^(?:지하(\d+)층?|B(\d+)F?)$/i.exec(f))) add(levels.find((l) => basementNo(l.name) === Number(m[1] || m[2])));
    else if (/^최상층$/.test(f)) add(above.reduce((a, l) => (!a || floorNo(l.name) > floorNo(a.name) ? l : a), null));
    else if (/^최하층$/.test(f)) add(homes.reduce((a, l) => (!a || floorNo(l.name) < floorNo(a.name) ? l : a), null));
    else if (/^(지붕|지붕층|RF)$/i.test(f)) for (const l of levels) { if (l.kind === 'rooftop' || /^RF$/i.test(l.name)) add(l); }
    else if (/^(옥탑|옥탑층|PH\d*)$/i.test(f)) for (const l of levels) { if (/^PH/i.test(l.name)) add(l); }
  }
  return levels.filter((l) => out.has(l));
}
