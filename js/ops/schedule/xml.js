// 작은 XML 읽기(외부 라이브러리 없음, 브라우저·Node 공용). MSPDI 공정표와 xlsx 안의 XML을 읽는 데 쓴다.
// 결과: { name, attrs, children, text }. 이름의 접두어(ns:)는 떼고, 속성 이름은 그대로 둔다.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  }
  return ENT[e] ?? m;
});
export const escapeXml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  // XML 1.0에 넣을 수 없는 제어 문자는 뺀다
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const local = (n) => { const i = n.indexOf(':'); return i < 0 ? n : n.slice(i + 1); };
const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** @param {string} src @returns {{ name: string, attrs: Record<string,string>, children: any[], text: string }} */
export function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += unescapeXml(src.slice(i)); break; }
    if (lt > i) top.text += unescapeXml(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); top.text += src.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') { const e = src.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = local(body.slice(1).trim());
      // 닫는 태그와 짝이 맞는 곳까지 올라간다(깨진 파일도 최대한 읽는다)
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const self = body.endsWith('/');
    const inner = self ? body.slice(0, -1) : body;
    const sp = inner.search(/\s/);
    const name = local(sp < 0 ? inner : inner.slice(0, sp));
    const attrs = {};
    if (sp >= 0) for (const m of inner.slice(sp).matchAll(ATTR)) attrs[m[1]] = unescapeXml(m[3] ?? m[4] ?? '');
    const el = { name, attrs, children: [], text: '' };
    top.children.push(el);
    if (!self) stack.push(el);
  }
  return root.children.find((c) => c.name) || root;
}

export const kids = (el, name) => (el?.children || []).filter((c) => !name || c.name === name);
export const kid = (el, name) => (el?.children || []).find((c) => c.name === name) || null;
/** 자식 요소의 글자(없으면 '') */
export const val = (el, name) => (kid(el, name)?.text ?? '').trim();
/** 경로로 내려가기: path(el, 'Tasks', 'Task') → 마지막 이름의 요소 목록 */
export function path(el, ...names) {
  let cur = [el];
  for (const nm of names) cur = cur.flatMap((c) => kids(c, nm));
  return cur;
}
/** 글자 전부(자식 포함, xlsx 공유 문자열의 서식 조각을 합칠 때) */
export const allText = (el) => (el ? el.text + el.children.map(allText).join('') : '');
