// 바로맵 표준 공정표 양식 만들기(28 지시서 2절). 그 현장의 동·공종 목록을 "목록" 시트(숨김)에 넣고 드롭다운으로 건다.
// 시트: 안내 / 공정 / 달력 / 층설정 / 목록. writeXlsx로 바로 파일이 된다(브라우저·Node 공용).
import { STANDARD_COLUMNS } from './read-standard.js';
import { TRADE_NAMES } from './trades.js';
import { DEFAULT_FLOORS } from './core.js';

const HEAD_FILL = '#DDE7F7';
const NEED_FILL = '#F8D9A8';
const NEED = new Set(['actId', 'zone', 'building', 'fromFloor', 'toFloor', 'trade', 'start', 'finish']);
const H = (v, need) => ({ v, bold: true, fill: need ? NEED_FILL : HEAD_FILL });

/**
 * @param {{ siteName?: string, buildings?: string[], trades?: string[], floors?: string[], holidays?: string[], example?: any[] }} o
 *   buildings: '101' 같은 동 번호. trades: 골구도 공종(없으면 표준 공종). example: 예시 행(활동 모양)
 */
export function standardTemplate(o = {}) {
  const trades = [...new Set([...(o.trades || []), ...TRADE_NAMES])];
  const buildings = o.buildings?.length ? o.buildings : ['101', '102'];
  const floors = o.floors?.length ? o.floors : ['B2', 'B1', ...Array.from({ length: 30 }, (_, i) => String(i + 1)), 'PH'];
  const cols = STANDARD_COLUMNS.map(([f, names]) => H(names[0], NEED.has(f)));
  const idx = Object.fromEntries(STANDARD_COLUMNS.map(([f], i) => [f, i]));
  const L = (k) => String.fromCharCode(65 + idx[k]);
  const rows = [cols];
  for (const a of o.example || []) {
    const r = [];
    r[idx.actId] = a.actId; r[idx.name] = a.name; r[idx.zone] = { site: '단지', building: '동', underground: '지하주차장', facility: '부대' }[a.zone] || '';
    r[idx.building] = a.building; r[idx.fromFloor] = a.fromFloor; r[idx.toFloor] = a.toFloor; r[idx.line] = a.line; r[idx.trade] = a.trade;
    r[idx.start] = a.start ? { v: a.start, t: 'd' } : null; r[idx.finish] = a.finish ? { v: a.finish, t: 'd' } : null;
    r[idx.predIds] = (a.preds || []).map((p) => p.id).join(','); r[idx.predType] = (a.preds || []).map((p) => p.type).join(',');
    r[idx.predLag] = (a.preds || []).some((p) => p.lag) ? (a.preds || []).map((p) => p.lag).join(',') : null;
    r[idx.floorDays] = a.floorDays; r[idx.spread] = a.spread && a.spread !== 'cycle' ? { even: '균등', qty: '수량' }[a.spread] : null;
    r[idx.qty] = a.qty; r[idx.unit] = a.unit; r[idx.outdoor] = a.outdoor ? 'O' : null; r[idx.note] = a.note || null;
    rows.push(r);
  }
  const N = 2000;
  const list = (col, n) => `'목록'!$${col}$2:$${col}$${n + 1}`;
  const listRows = [['구역', '동', '층', '공종', '배분', '관계', '바깥공종']];
  const zones = ['단지', '동', '지하주차장', '부대'];
  const spreads = ['사이클', '균등', '수량'];
  const rels = ['FS', 'SS', 'FF', 'SF'];
  const max = Math.max(zones.length, buildings.length, floors.length, trades.length);
  for (let i = 0; i < max; i++) listRows.push([zones[i] || null, buildings[i] || null, floors[i] || null, trades[i] || null, spreads[i] || null, rels[i] || null, i === 0 ? 'O' : null]);
  const guide = [
    [{ v: '바로맵 표준 공정표', bold: true }],
    [o.siteName ? `현장: ${o.siteName}` : '현장 이름을 비워 두어도 됩니다.'],
    [],
    ['쓰는 법'],
    ['1. [공정] 시트에 한 줄에 공정 하나씩 적습니다. 주황색 머리글은 꼭 채웁니다.'],
    ['2. 구역은 단지·동·지하주차장·부대 중에서 고릅니다. 동은 숫자만(101). 구역이 동이 아니면 동은 비웁니다.'],
    ['3. 층은 지하 B2·B1, 지상 1·2…, 옥탑·지붕은 PH로 적습니다. 한 줄이 여러 층이면 시작층~끝층(예: 1 ~ PH).'],
    ['4. 시작일·종료일은 글자가 아닌 엑셀 날짜로 넣습니다(예: 2027-03-02).'],
    ['5. 공종은 목록에서 고릅니다. 목록은 이 현장 골구도의 공종과 바로맵 표준 공종입니다.'],
    ['6. 층당일수를 적으면 그 값으로 층을 나눕니다. 비우면 [층설정]의 가중치로 나눕니다(사이클).'],
    ['7. 비 오면 못 하는 공종은 바깥공종에 O를 적습니다.'],
    ['8. [달력]에 휴일과 동절기 중단 기간을 적습니다. 비우면 바로맵 운영 설정의 근무 요일·휴일을 씁니다.'],
    [],
    ['요약 행(하위 공정을 묶는 줄)은 넣지 않습니다. 같은 기간을 두 번 세게 됩니다.'],
  ];
  const cal = [
    ['근무 요일', '월화수목금토'],
    [],
    [H('구분'), H('시작일'), H('종료일'), H('공종(비우면 전체)'), H('비고')],
    ...(o.holidays || []).map((d) => ['휴일', { v: d, t: 'd' }, null, null, null]),
  ];
  const floorRows = [[H('구분'), H('시작층'), H('끝층'), H('가중치'), H('비고')],
    ...DEFAULT_FLOORS.map((f) => [f.name, f.from || null, f.to || null, f.weight, f.name === '최상층' ? '그 동 맨 위 지상층' : f.name === '기준층' ? '기준층 사이클 = 1' : null])];
  return [
    { name: '안내', rows: guide, cols: [100] },
    {
      name: '공정', rows, freeze: 1, cols: STANDARD_COLUMNS.map(([f]) => (f === 'name' ? 28 : f === 'note' ? 24 : ['start', 'finish', 'baseStart', 'baseFinish', 'actualStart', 'actualFinish'].includes(f) ? 12 : 10)),
      validations: [
        { ref: `${L('zone')}2:${L('zone')}${N}`, list: list('A', zones.length) },
        { ref: `${L('building')}2:${L('building')}${N}`, list: list('B', buildings.length) },
        { ref: `${L('fromFloor')}2:${L('toFloor')}${N}`, list: list('C', floors.length) },
        { ref: `${L('trade')}2:${L('trade')}${N}`, list: list('D', trades.length) },
        { ref: `${L('spread')}2:${L('spread')}${N}`, list: list('E', spreads.length) },
        { ref: `${L('predType')}2:${L('predType')}${N}`, list: list('F', rels.length) },
        { ref: `${L('outdoor')}2:${L('outdoor')}${N}`, list: list('G', 1) },
      ],
    },
    { name: '달력', rows: cal, cols: [12, 12, 12, 20, 24] },
    { name: '층설정', rows: floorRows, cols: [12, 8, 8, 8, 24] },
    { name: '목록', rows: listRows, hidden: true },
  ];
}
