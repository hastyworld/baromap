// 엑셀 일괄 등록 대화상자와 내보내기 (SheetJS를 필요할 때만 불러온다)
import { store, state } from './ctx.js';
import { SHEETS, parseWorkbook, templateRows, exportRows, runImport } from './excel.js';
import { searchAddress, geoMode } from './geo.js';
import { todayStr } from './model.js';
import { $, esc, icon, onAction, openModal, toast, loadScript, appDownloadBlocked } from './util.js';

const XLSX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

async function xlsx() {
  await loadScript(XLSX_SRC);
  return window.XLSX;
}

async function writeBook(filename, rowsByKind) {
  if (appDownloadBlocked()) return;
  const X = await xlsx();
  const wb = X.utils.book_new();
  for (const [kind, rows] of Object.entries(rowsByKind)) {
    const ws = X.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map((_, i) => ({ wch: Math.min(40, Math.max(8, ...rows.slice(0, 80).map((r) => String(r[i] ?? '').length * 1.7))) }));
    X.utils.book_append_sheet(wb, ws, SHEETS[kind].name);
  }
  X.writeFile(wb, filename);
}

export async function exportExcel() {
  try {
    await writeBook(`바로맵_${todayStr()}.xlsx`, exportRows(state.data));
    toast('엑셀 파일로 내보냈습니다.');
  } catch (err) {
    toast(err.message, 'crit');
  }
}

// .xlsx/.xls는 시트별로, .csv(UTF-8·EUC-KR)는 시트 하나로 읽는다.
async function readBook(file) {
  const X = await xlsx();
  const buf = await file.arrayBuffer();
  let wb;
  if (/\.(csv|tsv|txt)$/i.test(file.name)) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('euc-kr').decode(buf); // 엑셀 기본 "CSV(쉼표로 분리)" 저장 형식
    }
    wb = X.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
    wb.SheetNames = [''];
    wb.Sheets[''] = wb.Sheets[Object.keys(wb.Sheets)[0]];
  } else {
    wb = X.read(buf, { type: 'array' });
  }
  // 원래 값 그대로 읽는다: 날짜는 일련번호, 숫자는 숫자 → excel.js에서 변환
  const sheets = {};
  for (const name of wb.SheetNames) {
    sheets[name] = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true });
  }
  return sheets;
}

let parsed = null;

export function excelDialog() {
  parsed = null;
  openModal({
    title: '엑셀로 일괄 등록',
    wide: true,
    body: `<div class="excel">
      <p>엑셀 파일 하나에 <b>[현장]·[숙소]·[거주자]</b> 시트를 나눠 적어 올리면 한 번에 등록됩니다. 시트끼리는 <b>현장명·숙소명</b>으로 연결됩니다.</p>
      <ul class="steps small">
        ${store.mode === 'remote' ? '<li><b>공유 모드</b>: 등록한 내용은 모든 사용자에게 바로 보입니다. 권한이 있는 현장만 등록되고(새 현장은 운영자만), 나머지 행은 결과에 표시됩니다.</li>' : ''}
        <li>같은 이름이 이미 있으면 내용을 고치고, 빈 칸은 기존 값을 그대로 둡니다.</li>
        <li>주소는 자동으로 지도 좌표로 바뀝니다${geoMode() === 'kakao' ? '' : ' (데모 지도에서는 1초에 1건씩 변환되어 느리고, 못 찾는 주소가 많을 수 있습니다)'}. 못 찾으면 위도·경도 칸을 채우세요.</li>
        <li>날짜는 2026-03-02 형식, 거주자 정보는 업무에 필요한 항목만 적어주세요.</li>
      </ul>
      <div class="btn-row">
        <button type="button" class="btn" data-act="excel-template">${icon('download')}빈 양식 내려받기</button>
        <button type="button" class="btn ghost" data-act="excel-export">${icon('table')}지금 데이터를 엑셀로</button>
      </div>
      <label class="file-drop">${icon('upload')}<span>작성한 파일 선택 (.xlsx, .csv)</span><input type="file" id="excel-file" accept=".xlsx,.xls,.csv"></label>
      <div id="excel-preview"></div>
    </div>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">닫기</button>
      <button type="button" class="btn primary" id="excel-run" data-act="excel-run" disabled>${icon('upload')}등록하기</button>`,
  });
}

onAction('excel-template', async () => {
  await writeBook('바로맵_일괄등록_양식.xlsx', templateRows());
});

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'excel-file' || !e.target.files[0]) return;
  const box = $('#excel-preview');
  const run = $('#excel-run');
  box.innerHTML = '<p class="muted loading">파일을 읽는 중…</p>';
  try {
    parsed = parseWorkbook(await readBook(e.target.files[0]));
    const parts = Object.keys(SHEETS).filter((k) => parsed[k]);
    if (!parts.length) throw new Error('읽을 수 있는 시트가 없습니다. 양식의 머리글(현장명·숙소명·이름 등)을 확인해주세요.');
    const problems = parts.flatMap((k) => (parsed[k].missing.length ? [`[${SHEETS[k].name}] 필수 머리글 없음: ${parsed[k].missing.join(', ')}`] : []));
    box.innerHTML = `<table class="mini-table"><thead><tr><th>시트</th><th>행 수</th><th>인식 못 한 열</th></tr></thead><tbody>
      ${parts.map((k) => `<tr><td>${SHEETS[k].name}</td><td>${parsed[k].records.length}</td><td>${parsed[k].unknown.map(esc).join(', ') || '-'}</td></tr>`).join('')}
      </tbody></table>
      ${problems.length ? `<div class="form-error">${icon('alert')}<span>${problems.map(esc).join('<br>')}</span></div>` : ''}`;
    run.disabled = Boolean(problems.length) || !parts.some((k) => parsed[k].records.length);
  } catch (err) {
    parsed = null;
    run.disabled = true;
    box.innerHTML = `<div class="form-error">${icon('alert')}<span>${esc(err.message)}</span></div>`;
  }
});

onAction('excel-run', async (el) => {
  if (!parsed) return;
  el.disabled = true;
  const box = $('#excel-preview');
  box.innerHTML = '<p class="progress-text">등록 중… <b id="excel-prog">0</b></p>';
  const geocode = async (address) => (await searchAddress(address))[0] || null;
  const r = await runImport(store, parsed, {
    geocode,
    onProgress: (done, total) => { const p = $('#excel-prog'); if (p) p.textContent = `${done} / ${total}`; },
  });
  parsed = null;
  const sum = (k, label) => (r[k].added || r[k].updated ? `${label} 신규 ${r[k].added} · 수정 ${r[k].updated}` : '');
  box.innerHTML = `<div class="notice ${r.errors.length ? 'warn' : 'ok'}">${icon(r.errors.length ? 'alert' : 'check')}
      <span>${[sum('sites', '현장'), sum('lodgings', '숙소'), sum('residents', '거주자')].filter(Boolean).join('<br>') || '등록된 항목이 없습니다.'}</span></div>
    ${r.errors.length ? `<p class="t-warn small">등록하지 못한 행 ${r.errors.length}개</p><ul class="errors">${r.errors.map((x) => `<li>[${x.sheet}] ${x.row}행: ${esc(x.message)}</li>`).join('')}</ul>` : ''}`;
  toast('엑셀 일괄 등록을 마쳤습니다.');
});
