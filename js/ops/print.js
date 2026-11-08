// 출력: 인쇄용 내용을 #print-root에 넣고 브라우저 인쇄(PDF 저장 포함)를 연다. 화면 나머지는 css/ops.css의 @media print가 숨긴다.
import { esc, isAppView, toast } from '../util.js';

let root = null;

export function setPrintHtml(html) {
  root ||= Object.assign(document.createElement('div'), { id: 'print-root' });
  if (!root.isConnected) document.body.append(root);
  root.innerHTML = html;
  return root;
}

export function printHtml(html) {
  setPrintHtml(html);
  if (isAppView()) {
    toast('앱에서는 인쇄가 안 됩니다. 노트북·휴대폰 브라우저에서 바로맵 주소로 들어가 인쇄해주세요.', 'warn');
    return;
  }
  // 사진이 다 그려진 뒤 인쇄한다
  const imgs = [...root.querySelectorAll('img')].filter((i) => !i.complete);
  Promise.all(imgs.map((i) => new Promise((r) => { i.onload = r; i.onerror = r; }))).then(() => window.print());
}

// 결재란: [{ label, name, at }]
export const signBox = (list) => `<table class="pr-sign"><tr>${list.map((s) => `<th>${esc(s.label)}</th>`).join('')}</tr>
  <tr>${list.map((s) => `<td><b>${esc(s.name || '')}</b><small>${esc(s.at || '')}</small></td>`).join('')}</tr></table>`;

// 표: head = 머리글, rows = 줄
export const prTable = (head, rows, cls = '') => `<table class="pr-table ${cls}"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}" class="pr-empty">없음</td></tr>`}</tbody></table>`;
