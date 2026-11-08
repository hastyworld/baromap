// 일보 자동 요약(순수 함수): 골구도에서 그날 찍힌 칸을 공종·동·층으로 묶어 "철근 101동 5~7층 12세대" 같은 줄로 만든다.
import { buildingUnits } from '../../model.js';

export const floorRange = (a, b) => (a === b ? `${a}층` : `${a}~${b}층`);

// cache: store.progress.cached(siteId). 돌려주는 값: [{ sheetId, sheet, buildingId, building, step, trade, units, from, to, range }]
export function progressChanges(cache, date) {
  const out = [];
  if (!cache || !date) return out;
  for (const sheet of cache.sheets || []) {
    for (const b of cache.buildings || []) {
      const cells = cache.cells?.[sheet.id]?.[b.id];
      if (!cells) continue;
      const byStep = new Map();
      for (const u of buildingUnits(b)) {
        for (const [step, d] of Object.entries(cells[u.key]?.dates || {})) {
          if (d !== date) continue;
          if (!byStep.has(step)) byStep.set(step, []);
          byStep.get(step).push(u.floor);
        }
      }
      for (const [step, floors] of byStep) {
        const trade = sheet.trades?.[Number(step) - 1];
        if (!trade) continue;
        const from = Math.min(...floors);
        const to = Math.max(...floors);
        out.push({ sheetId: sheet.id, sheet: sheet.name, buildingId: b.id, building: b.name, step: Number(step), trade: trade.name, units: floors.length, from, to, range: floorRange(from, to) });
      }
    }
  }
  return out.sort((a, b) => a.sheet.localeCompare(b.sheet, 'ko') || a.step - b.step || a.building.localeCompare(b.building, 'ko', { numeric: true }));
}

// 일보 공정 요약 칸에 넣을 값(스냅샷)
export const progressSnapshot = (changes) => changes.map(({ sheet, building, trade, units, range }) => ({ sheet, building, trade, units, range }));

// 오늘 작업 줄 제안
export function suggestWork(changes) {
  return changes.map((c) => ({
    trade: c.trade,
    area: `${c.building} ${c.range}`,
    text: `${c.trade} ${c.building} ${c.range} ${c.units}세대`,
    buildingId: c.buildingId,
    floors: c.range,
  }));
}

// 이미 들어간 줄은 빼고 제안한다
export const newSuggestions = (suggested, work) => suggested.filter((s) => !(work || []).some((w) => w.text === s.text));

// 어제 복사: 그 일보의 줄을 새 날짜에 쓸 수 있게 깊이 복사한다
export const copyLines = (lines) => JSON.parse(JSON.stringify(lines || []));

// 오늘 작업 → 내일 계획(고쳐 쓰는 출발점)
export const planFromWork = (work) => (work || []).map(({ trade, area, text, buildingId, floors }) => ({ trade, area, text, buildingId, floors }));

export const totalCount = (r) => (r?.manpower || []).reduce((a, m) => a + (Number(m.count) || 0), 0);

// 목록에 보일 주요 작업 한 줄
export function mainWork(r) {
  const w = r?.work || [];
  if (!w.length) return '';
  const first = w[0].text || `${w[0].trade || ''} ${w[0].area || ''}`.trim();
  return w.length > 1 ? `${first} 외 ${w.length - 1}건` : first;
}

// 가장 최근에 쓴 일보(date보다 앞). "어제 복사"는 어제가 휴일이면 그 앞날 것을 쓴다.
export const previousReport = (reports, date) => [...(reports || [])].filter((r) => r.date < date && r.status !== 'cancelled').sort((a, b) => b.date.localeCompare(a.date))[0] || null;
