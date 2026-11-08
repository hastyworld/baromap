// Primavera P6 XER 읽기(28 지시서 1절 3). 탭으로 나눈 글자 파일: %T 표 이름, %F 열 이름, %R 행.
// 인코딩: UTF-8로 깨짐 없이 읽히면 UTF-8, 아니면 CP949(한글 P6). 동·층·공종은 활동 코드 → WBS → 이름 순으로 찾는다.
import { activity, addDays } from './core.js';

/** 바이트 → { text, encoding } (BOM → UTF-8 엄격 → CP949) */
export function decodeXer(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('euc-kr').decode(b), encoding: 'cp949' };
  }
}

export const isXer = (text) => /^ERMHDR\t/.test(text.slice(0, 200)) || /\n%T\tTASK\b/.test(text);

/** XER 글자 → { 표 이름: [{ 열: 값 }] } */
export function parseXerTables(text) {
  const tables = {};
  let cur = null;
  let fields = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('%T\t')) { cur = line.slice(3).trim(); tables[cur] = []; fields = []; } else if (line.startsWith('%F\t')) fields = line.slice(3).split('\t'); else if (line.startsWith('%R\t') && cur) {
      const vals = line.slice(3).split('\t');
      tables[cur].push(Object.fromEntries(fields.map((f, i) => [f, vals[i] ?? ''])));
    }
  }
  return tables;
}

// clndr_data의 쉬는 날: (0||Exceptions()( (0||0(d|46388)()) … ). d는 1899-12-30부터 센 날
function calendarOf(row) {
  if (!row?.clndr_data) return null;
  const data = row.clndr_data;
  const holidays = [...data.matchAll(/\(d\|(\d{5})\)\s*\(\s*\)/g)].map((m) => addDays('1899-12-30', Number(m[1])));
  const workdays = [];
  const dow = /DaysOfWeek\(\)\(([\s\S]*?)\)\)\s*\(0\|\|[A-Z]/i.exec(data)?.[1] || '';
  // (0||1()( 시간 )) 꼴: 1=일 … 7=토. 시간 칸이 비면 쉬는 요일
  for (const m of dow.matchAll(/\(0\|\|([1-7])\(\)\(([^]*?)\)\)/g)) if (/s\|/.test(m[2])) workdays.push(Number(m[1]) === 1 ? 7 : Number(m[1]) - 1);
  return { workdays: workdays.sort((a, b) => a - b), holidays: [...new Set(holidays)].sort(), stops: [] };
}

const REL = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };

/**
 * @param {Uint8Array} bytes
 * @returns {{ format: 'xer', activities: any[], calendar: any, encoding: string, warnings: string[], name: string }}
 */
export function readXer(bytes) {
  const { text, encoding } = decodeXer(bytes);
  if (!isXer(text)) throw new Error('Primavera XER 파일이 아닙니다. P6에서 "내보내기 → Primavera PM(XER)"로 저장해주세요.');
  const T = parseXerTables(text);
  const proj = (T.PROJECT || [])[0] || {};
  const wbs = new Map((T.PROJWBS || []).map((w) => [w.wbs_id, w]));
  const wbsPath = (id) => {
    const out = [];
    for (let w = wbs.get(id), k = 0; w && k < 20; w = wbs.get(w.parent_wbs_id), k++) if (w.proj_node_flag !== 'Y') out.unshift(w.wbs_name || w.wbs_short_name);
    return out.filter(Boolean);
  };
  // 활동 코드(동·층·공종 등)
  const typeName = new Map((T.ACTVTYPE || []).map((t) => [t.actv_code_type_id, t.actv_code_type]));
  const codeName = new Map((T.ACTVCODE || []).map((c) => [c.actv_code_id, c.short_name || c.actv_code_name]));
  const codes = new Map();
  for (const ta of T.TASKACTV || []) {
    const k = typeName.get(ta.actv_code_type_id);
    if (!k) continue;
    if (!codes.has(ta.task_id)) codes.set(ta.task_id, {});
    codes.get(ta.task_id)[k.trim()] = codeName.get(ta.actv_code_id) || '';
  }
  const byId = new Map((T.TASK || []).map((t) => [t.task_id, t]));
  const preds = new Map();
  for (const p of T.TASKPRED || []) {
    const pt = byId.get(p.pred_task_id);
    if (!pt) continue;
    if (!preds.has(p.task_id)) preds.set(p.task_id, []);
    preds.get(p.task_id).push({ id: pt.task_code, type: REL[p.pred_type] || 'FS', lag: Math.round(((Number(p.lag_hr_cnt) || 0) / 8) * 10) / 10 });
  }
  const pick = (c, names) => { for (const n of names) if (c?.[n]) return c[n]; return ''; };
  const acts = (T.TASK || []).filter((t) => t.task_type !== 'TT_WBS').map((t) => {
    const c = codes.get(t.task_id);
    const floors = pick(c, ['층', '층범위', 'Floor']);
    const [f0, f1] = floors.split(/[~-]/).map((x) => x.trim());
    return activity({
      actId: t.task_code || t.task_id,
      name: t.task_name,
      wbs: wbsPath(t.wbs_id),
      building: pick(c, ['동', 'Building']),
      zone: pick(c, ['구역', 'Zone']),
      fromFloor: f0 || '', toFloor: f1 || f0 || '',
      trade: pick(c, ['공종', 'Trade']),
      start: t.target_start_date || t.early_start_date,
      finish: t.target_end_date || t.early_end_date,
      actualStart: t.act_start_date, actualFinish: t.act_end_date,
      percent: t.phys_complete_pct || null,
      preds: preds.get(t.task_id) || [],
      source: { taskId: t.task_id, type: t.task_type },
    });
  });
  const clndr = (T.CALENDAR || []).find((c) => c.clndr_id === proj.clndr_id) || (T.CALENDAR || []).find((c) => c.default_flag === 'Y') || (T.CALENDAR || [])[0];
  const warnings = [];
  if (!acts.length) warnings.push('XER 안에 작업(TASK)이 없습니다.');
  return { format: 'xer', name: proj.proj_short_name || '', activities: acts, calendar: calendarOf(clndr), encoding, warnings };
}
