// 요소 찾기(05 2절): AI가 말로 가리킨 위치("101동 10층 1호 거실 남측 창")를 모델 요소 id로 바꾼다. 못 찾으면 빈 목록.
// 브라우저·Edge Function 공용(supabase/functions/_shared/lib/에 복사). 의존: ids.js만.
import { slug } from './ids.js';

const ROOMS = ['거실', '침실1', '침실2', '침실3', '침실4', '안방', '주방/식당', '주방', '식당', '욕실1', '욕실2', '욕실', '화장실', '드레스룸', '파우더룸', '발코니', '실외기실', '대피공간', '현관', '복도', '다용도실', '팬트리', '계단실', '승강기', '홀'];
const unitLabel = (floor, line) => (/^\d{1,2}$/.test(line) ? `${floor}${String(line).padStart(2, '0')}` : `${floor}${line}`);

export function parseHint(hint) {
  const s = String(hint || '');
  const out = {};
  const b = /(\d{2,4})\s*동(?![측쪽])/.exec(s);
  if (b) out.building = `${b[1]}동`;
  const ho = /(\d{1,3})(\d{2})\s*호/.exec(s); // 1001호 → 10층 1호
  if (ho && !/층/.test(s)) { out.floor = Number(ho[1]); out.line = String(Number(ho[2])); }
  const fl = /(\d{1,3})\s*(?:층|F\b)/i.exec(s);
  if (fl) out.floor = Number(fl[1]);
  const ln = /(?:^|\s)(\d{1,2})\s*호(?:\s*라인)?/.exec(s);
  if (ln && !out.line) out.line = String(Number(ln[1]));
  const ty = /(?:^|[^\dA-Z])(\d{2,3}[A-Z]{1,2})(?![A-Z\d])/.exec(s);
  if (ty) out.unitType = ty[1];
  out.room = ROOMS.find((r) => s.includes(r)) || null;
  if (/창/.test(s)) out.kind = 'window';
  else if (/문/.test(s)) out.kind = 'door';
  else if (/벽/.test(s)) out.kind = 'wall';
  const d = /(남|북|동|서)\s*(측|쪽)/.exec(s);
  if (d) out.dir = { 남: [0, -1], 북: [0, 1], 동: [1, 0], 서: [-1, 0] }[d[1]];
  if (/주민\s*공동|커뮤니티|공동시설/.test(s)) out.facility = true;
  return out;
}

/**
 * @param {Record<string, any>} files 모델 파일 묶음
 * @param {string} hint
 * @returns {string[]} 요소 id(가장 구체적인 것)
 */
export function locate(files, hint) {
  const h = parseHint(hint);
  const site = files['site.json'] || { buildings: [] };
  const types = Object.entries(files).filter(([k]) => k.startsWith('u-')).map(([, v]) => v);
  const bInfo = h.building ? site.buildings.find((b) => b.name === h.building) : h.facility ? site.buildings.find((b) => b.kind === 'community') : null;
  const bjson = bInfo ? files[bInfo.file] : null;
  let unit = null;
  if (bjson && h.floor != null && h.line) unit = bjson.units.find((u) => u.label === unitLabel(h.floor, h.line)) || null;
  let type = h.unitType ? types.find((t) => t.name === h.unitType) : null;
  if (!type && unit) type = types.find((t) => t.id === unit.unitTypeId);
  if (!type && bInfo?.kind === 'community') type = types.find((t) => t.kind === 'facility');
  let mirror = Boolean(unit?.transform?.mirror);
  if (type && h.room) {
    const sp = type.spaces.find((x) => x.name === h.room) || type.spaces.find((x) => x.name.startsWith(h.room));
    if (sp) {
      if (!h.kind) return [sp.id];
      const walls = type.walls.filter((w) => w.sides?.in === sp.id || w.sides?.out === sp.id);
      const c = sp.polygon.reduce((a, p) => [a[0] + p[0] / sp.polygon.length, a[1] + p[1] / sp.polygon.length], [0, 0]);
      const facing = (w) => {
        if (!h.dir) return true;
        const m = [(w.path[0][0] + w.path[1][0]) / 2 - c[0], (w.path[0][1] + w.path[1][1]) / 2 - c[1]];
        const dx = mirror ? -h.dir[0] : h.dir[0];
        const L = Math.hypot(...m) || 1;
        return (m[0] * dx + m[1] * h.dir[1]) / L > 0.7;
      };
      const ws = walls.filter(facing);
      if (h.kind === 'wall') return ws.map((w) => w.id);
      const ids = new Set(ws.map((w) => w.id));
      const ops = type.openings.filter((o) => ids.has(o.wallId) && o.kind === h.kind);
      if (ops.length) return ops.map((o) => o.id);
      return [sp.id];
    }
  }
  if (unit) return [unit.id];
  if (type && !bInfo) return [type.id];
  if (bInfo) return [bInfo.id];
  return [];
}

export { slug };
