// 엑셀(xlsx) 읽기·쓰기(외부 라이브러리 없음, 브라우저·Node 공용). 공정표는 칠한 칸의 색까지 읽어야 해서 xlsx 안의 XML을 직접 읽는다(28 지시서 1절).
//   readXlsx(bytes) → { sheets: [{ name, hidden, grid: 칸[][], merges }] }   칸 = { v, t: 's'|'n'|'d'|'b'|'e', fill: '#RRGGBB'|'theme:N'|null } 또는 null
//   writeXlsx(sheets) → bytes   표준 공정표 양식(드롭다운 포함)과 시험 자료를 만든다
import { openZip, makeZip } from './zip.js';
import { parseXml, kid, kids, path, val, escapeXml } from './xml.js';

export const colName = (c) => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
export function cellRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

const DAY = 864e5;
const EPOCH = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
export const serialToIso = (n, d1904 = false) => new Date((d1904 ? EPOCH_1904 : EPOCH) + Math.floor(n + 1e-9) * DAY).toISOString().slice(0, 10);
export const isoToSerial = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - EPOCH) / DAY);

const DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
export function isDateFormat(id, code) {
  if (DATE_IDS.has(id)) return true;
  if (!code) return false;
  const clean = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[yd]/i.test(clean) || (/m/i.test(clean) && !/[hs]/i.test(clean) && !/0|#/.test(clean));
}

function colorOf(el, theme) {
  if (!el) return null;
  const a = el.attrs;
  if (a.rgb) return `#${a.rgb.slice(-6).toUpperCase()}`;
  if (a.theme != null) return theme[Number(a.theme)] ? theme[Number(a.theme)] + (a.tint && Number(a.tint) ? `~${Number(a.tint).toFixed(2)}` : '') : `theme:${a.theme}`;
  if (a.indexed != null && Number(a.indexed) < 64) return `indexed:${a.indexed}`;
  return null;
}

// 테마 색: 엑셀의 번호 0=lt1, 1=dk1, 2=lt2, 3=dk2, 4~9=accent1~6 (파일 안의 순서는 dk1, lt1, dk2, lt2 …)
function themeColors(xml) {
  if (!xml) return [];
  const scheme = path(parseXml(xml), 'themeElements', 'clrScheme')[0];
  const c = (name) => { const e = kid(scheme, name); const s = kid(e, 'srgbClr') || kid(e, 'sysClr'); const v = s?.attrs.val && s.name === 'srgbClr' ? s.attrs.val : s?.attrs.lastClr; return v ? `#${v.toUpperCase()}` : null; };
  return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(c);
}

/** @param {Uint8Array} bytes */
export async function readXlsx(bytes) {
  const z = openZip(bytes);
  const wbText = await z.text('xl/workbook.xml');
  if (!wbText) throw new Error('엑셀(xlsx) 파일이 아닙니다. 엑셀에서 "Excel 통합 문서(.xlsx)"로 저장해주세요.');
  const wb = parseXml(wbText);
  const d1904 = ['1', 'true'].includes(kid(wb, 'workbookPr')?.attrs.date1904);
  const rels = Object.fromEntries(kids(parseXml((await z.text('xl/_rels/workbook.xml.rels')) || '<x/>'), 'Relationship').map((r) => [r.attrs.Id, r.attrs.Target]));
  const shared = kids(parseXml((await z.text('xl/sharedStrings.xml')) || '<x/>'), 'si').map((si) => {
    const direct = kid(si, 't');
    return direct ? direct.text : kids(si, 'r').map((r) => kid(r, 't')?.text || '').join('');
  });
  const theme = themeColors(await z.text('xl/theme/theme1.xml'));
  const st = parseXml((await z.text('xl/styles.xml')) || '<x/>');
  const fmts = Object.fromEntries(path(st, 'numFmts', 'numFmt').map((f) => [Number(f.attrs.numFmtId), f.attrs.formatCode]));
  const fills = path(st, 'fills', 'fill').map((f) => {
    const p = kid(f, 'patternFill');
    const type = p?.attrs.patternType || 'none';
    if (type === 'none' || type === 'gray125') return null;
    return colorOf(kid(p, 'fgColor'), theme) || colorOf(kid(p, 'bgColor'), theme) || '#000000';
  });
  const xfs = path(st, 'cellXfs', 'xf').map((x) => {
    const id = Number(x.attrs.numFmtId || 0);
    return { date: isDateFormat(id, fmts[id]), fill: fills[Number(x.attrs.fillId || 0)] || null };
  });
  const out = [];
  for (const s of path(wb, 'sheets', 'sheet')) {
    const target = rels[s.attrs['r:id'] || s.attrs.id];
    if (!target) continue;
    const file = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = await z.text(file);
    if (!xml) continue;
    const ws = parseXml(xml);
    const grid = [];
    for (const row of path(ws, 'sheetData', 'row')) {
      let r = Number(row.attrs.r || grid.length + 1) - 1;
      let nextC = 0;
      for (const c of kids(row, 'c')) {
        const ref = c.attrs.r ? cellRef(c.attrs.r) : { r, c: nextC };
        r = ref.r;
        nextC = ref.c + 1;
        const xf = xfs[Number(c.attrs.s || 0)] || { date: false, fill: null };
        const t = c.attrs.t || 'n';
        const raw = val(c, 'v');
        let cell;
        if (t === 's') cell = { v: shared[Number(raw)] ?? '', t: 's' };
        else if (t === 'inlineStr') cell = { v: kids(kid(c, 'is'), 't').map((x) => x.text).join('') || kids(kid(c, 'is'), 'r').map((x) => kid(x, 't')?.text || '').join(''), t: 's' };
        else if (t === 'str') cell = { v: raw, t: 's' };
        else if (t === 'b') cell = { v: raw === '1', t: 'b' };
        else if (t === 'e') cell = { v: raw, t: 'e' };
        else if (raw === '') cell = xf.fill ? { v: null, t: 'z' } : null;
        else if (xf.date) cell = { v: serialToIso(Number(raw), d1904), t: 'd' };
        else cell = { v: Number(raw), t: 'n' };
        if (!cell) continue;
        cell.fill = xf.fill;
        (grid[ref.r] ||= [])[ref.c] = cell;
      }
    }
    for (let i = 0; i < grid.length; i++) grid[i] ||= [];
    const merges = path(ws, 'mergeCells', 'mergeCell').map((m) => {
      const [a, b] = m.attrs.ref.split(':').map(cellRef);
      return a && b ? { r0: a.r, c0: a.c, r1: b.r, c1: b.c } : null;
    }).filter(Boolean);
    out.push({ name: s.attrs.name, hidden: s.attrs.state === 'hidden' || s.attrs.state === 'veryHidden', grid, merges });
  }
  return { sheets: out };
}

/** 칸 → 글자(빈 칸은 '') */
export const cellText = (c) => (c == null || c.v == null ? '' : String(c.v).trim());

// ---------------------------------------------------------------- 쓰기

/**
 * @param {{ name: string, rows: any[][], cols?: number[], validations?: { ref: string, list: string|string[] }[], hidden?: boolean, merges?: string[], freeze?: number }[]} sheets
 *   칸 값: null | 글자 | 숫자 | 참거짓 | { v, t?: 'd', fill?: '#RRGGBB', bold?: boolean }
 */
export async function writeXlsx(sheets) {
  const strings = [];
  const sIndex = new Map();
  const si = (s) => { if (!sIndex.has(s)) { sIndex.set(s, strings.length); strings.push(s); } return sIndex.get(s); };
  const fillList = [];
  const styleKeys = new Map([['||', 0]]);
  const styles = [{ date: false, fill: '', bold: false }];
  const styleOf = (date, fill, bold) => {
    const key = `${date ? 1 : ''}|${fill || ''}|${bold ? 1 : ''}`;
    if (!styleKeys.has(key)) {
      if (fill && !fillList.includes(fill)) fillList.push(fill);
      styleKeys.set(key, styles.length);
      styles.push({ date, fill, bold });
    }
    return styleKeys.get(key);
  };
  const sheetXml = sheets.map((sh) => {
    const rows = sh.rows.map((row, r) => {
      const cells = (row || []).map((raw, c) => {
        if (raw == null || raw === '') return '';
        const o = typeof raw === 'object' && !(raw instanceof Date) ? raw : { v: raw };
        let v = o.v instanceof Date ? o.v.toISOString().slice(0, 10) : o.v;
        const isDate = o.t === 'd' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const s = styleOf(isDate, o.fill, o.bold);
        const ref = `${colName(c)}${r + 1}`;
        const sa = s ? ` s="${s}"` : '';
        if (v == null || v === '') return `<c r="${ref}"${sa}/>`;
        if (isDate) return `<c r="${ref}"${sa}><v>${isoToSerial(v)}</v></c>`;
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
        if (typeof v === 'boolean') return `<c r="${ref}"${sa} t="b"><v>${v ? 1 : 0}</v></c>`;
        return `<c r="${ref}"${sa} t="s"><v>${si(String(v))}</v></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    const cols = sh.cols?.length ? `<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const pane = sh.freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const dv = sh.validations?.length ? `<dataValidations count="${sh.validations.length}">${sh.validations.map((d) => {
      const f = Array.isArray(d.list) ? `"${d.list.join(',').replace(/"/g, '')}"` : d.list;
      return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${d.ref}"><formula1>${escapeXml(f)}</formula1></dataValidation>`;
    }).join('')}</dataValidations>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pane}${cols}<sheetData>${rows}</sheetData>${merges}${dv}</worksheet>`;
  });
  const fillXml = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
    ...fillList.map((f) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${f.replace('#', '').toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`)].join('');
  const xfXml = styles.map((s) => {
    const fillId = s.fill ? fillList.indexOf(s.fill) + 2 : 0;
    return `<xf numFmtId="${s.date ? 164 : 0}" fontId="${s.bold ? 1 : 0}" fillId="${fillId}" borderId="0" xfId="0"${s.date ? ' applyNumberFormat="1"' : ''}${fillId ? ' applyFill="1"' : ''}${s.bold ? ' applyFont="1"' : ''}/>`;
  }).join('');
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts><fills count="${fillList.length + 2}">${fillXml}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${styles.length}">${xfXml}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('')}</sst>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  return makeZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: wbXml },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/sharedStrings.xml', data: sst },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
  ]);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
