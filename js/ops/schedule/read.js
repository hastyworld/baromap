// 공정표 파일 하나 읽기(형식 판별 → 형식별 읽기 → 정리). 순수 함수 + 비동기(xlsx 압축 풀기).
//   readSchedule({ name, bytes }, { pdfPages, tableMap }) → { format, draft, activities, calendar, floors, warnings, needsMapping?, … }
// .mpp는 읽지 않고 XML 저장 안내(28 지시서 1절). .xls·스캔 PDF는 화면이 따로 처리한다.
import { readXlsx } from './xlsx.js';
import { isZip } from './zip.js';
import { readStandard } from './read-standard.js';
import { readTable, csvGrid } from './read-table.js';
import { readBarchart } from './read-barchart.js';
import { readMspdi, isMspdi } from './read-mspdi.js';
import { readXer, isXer, decodeXer } from './read-xer.js';
import { readPdfSchedule } from './read-pdf.js';
import { finalize } from './core.js';

export class ScheduleError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

export const MPP_HELP = 'MS Project 파일(.mpp)은 바로 읽지 못합니다. MS Project에서 [파일] → [다른 이름으로 저장] → 파일 형식 "XML 형식(*.xml)"으로 저장한 뒤 그 파일을 올려 주세요.';
export const ACCEPT = '.xlsx,.xls,.csv,.xml,.xer,.pdf,.mpp';

/** 파일 이름·앞부분으로 형식 짐작: xlsx / xls / csv / mspdi / p6xml / xer / pdf / mpp / unknown */
export function sniff(name, bytes) {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase() || '';
  if (ext === 'mpp' || ext === 'mpt') return 'mpp';
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (isZip(bytes)) return 'xlsx';
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return ext === 'mpp' ? 'mpp' : 'xls'; // OLE(옛 엑셀·mpp)
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4000));
  if (/^﻿?\s*</.test(head) || /^(\xEF\xBB\xBF)?\s*</.test(head)) {
    if (/APIBusinessObjects|primavera/i.test(head)) return 'p6xml';
    return 'mspdi';
  }
  if (/^ERMHDR\t/.test(head.replace(/^\xEF\xBB\xBF/, ''))) return 'xer';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  return ext === 'xer' ? 'xer' : 'unknown';
}

/**
 * @param {{ name: string, bytes: Uint8Array }} file
 * @param {{ pdfPages?: any[], tableMap?: { header: number, map: Record<string, number>, sheet?: string }, grid?: any[][] }} o
 *   pdfPages: 화면이 pdf.js로 꺼낸 글자 조각. grid: .xls를 SheetJS로 읽은 칸 표. tableMap: 사람이 고른 열
 */
export async function readSchedule(file, o = {}) {
  const kind = sniff(file.name, file.bytes);
  let r;
  if (kind === 'mpp') throw new ScheduleError(MPP_HELP, 'mpp');
  if (kind === 'p6xml') throw new ScheduleError('P6 XML은 아직 읽지 못합니다. P6에서 XER로 내보내서 올려 주세요.', 'p6xml');
  if (kind === 'pdf') {
    if (!o.pdfPages) throw new ScheduleError('PDF 글자를 읽지 못했습니다.', 'pdf');
    r = readPdfSchedule(o.pdfPages);
  } else if (kind === 'mspdi') {
    const text = new TextDecoder('utf-8').decode(file.bytes);
    if (!isMspdi(text)) throw new ScheduleError('MS Project XML이 아닌 XML 파일입니다.', 'xml');
    r = readMspdi(text);
  } else if (kind === 'xer') {
    r = readXer(file.bytes);
  } else if (kind === 'csv' || kind === 'xls') {
    const grid = kind === 'csv' ? csvGrid(decodeXer(file.bytes).text) : o.grid;
    if (!grid) throw new ScheduleError('옛 엑셀(.xls)은 이 화면에서 읽지 못했습니다. 엑셀에서 .xlsx로 저장해 주세요.', 'xls');
    const book = { sheets: [{ name: 'Sheet1', grid, merges: [] }] };
    r = readStandard(book) || readTable(grid, o.tableMap || {});
  } else if (kind === 'xlsx') {
    const book = await readXlsx(file.bytes);
    r = readStandard(book);
    if (!r) {
      const sheets = book.sheets.filter((s) => !s.hidden);
      const pick = o.tableMap?.sheet ? sheets.find((s) => s.name === o.tableMap.sheet) : null;
      const tables = (pick ? [pick] : sheets).map((s) => ({ s, t: readTable(s.grid, pick ? o.tableMap : {}) }));
      const ok = tables.find((x) => !x.t.needsMapping && x.t.activities?.length);
      if (ok) r = { ...ok.t, sheet: ok.s.name };
      else {
        r = readBarchart(book);
        if (!r) r = { ...tables[0].t, sheet: tables[0].s.name, sheets: sheets.map((s) => s.name) };
      }
    }
  } else {
    if (/\.xer$/i.test(file.name)) r = readXer(file.bytes);
    else throw new ScheduleError('공정표로 읽을 수 없는 파일입니다. 엑셀(.xlsx), MS Project XML(.xml), Primavera XER(.xer), CSV, PDF를 올려 주세요.', 'unknown');
  }
  if (r.needsMapping) return { ...r, activities: [] };
  return { draft: false, calendar: null, floors: null, ...r, activities: finalize(r.activities) };
}
