// 외부 참조(XREF) 묶기. 순수 함수(브라우저 워커·Node 공용).
// 실제 도서는 도곽(도면폼)·단위세대·코어를 다른 파일로 두고 시트 파일이 참조만 하는 경우가 많다(공개 아파트 도서에서 확인).
// 참조된 파일을 같은 묶음에서 찾아 블록 내용으로 채운다. 못 찾은 참조는 비어 있는 채로 두고 이름을 알려 준다.
//   AutoCAD처럼 참조 파일의 레이어·블록 이름 앞에 "참조이름|"을 붙여 서로 섞이지 않게 하고,
//   시트 파일에 같은 이름의 레이어 설정(끔·동결)이 있으면 그것을 따른다(동 평면도에서 세대 가구·치수를 끈 경우 등).

/** 참조 이름 → 찾기 열쇠: 경로·확장자를 떼고 소문자, 공백 하나로 */
export function xrefKey(s) {
  const base = String(s || '').replace(/\\/g, '/').split('/').pop().replace(/\.(dwg|dxf)$/i, '');
  return base.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 이 도면이 참조하는 외부 파일들: [{ block, key, path }] */
export function xrefList(dxf) {
  return Object.values(dxf.blocks || {}).filter((b) => b.flags & 4).map((b) => ({ block: b.name, key: xrefKey(b.xrefPath || b.name), path: b.xrefPath || '' }));
}

const MAX_DEPTH = 4;

/**
 * @param {any} dxf 시트 파일(해석 결과, 바뀐다)
 * @param {(key: string) => Promise<any|null>} load 열쇠로 참조 파일 해석 결과를 돌려준다(없으면 null). 같은 열쇠는 같은 결과를 캐시해도 된다.
 * @returns {Promise<{ bound: string[], missing: string[] }>} 채운 참조 이름·못 찾은 참조 이름
 */
export async function bindXrefs(dxf, load, { depth = 0, stack = [] } = {}) {
  const bound = [];
  const missing = [];
  for (const ref of xrefList(dxf)) {
    const block = dxf.blocks[ref.block];
    if (stack.includes(ref.key) || depth >= MAX_DEPTH) { missing.push(ref.block); continue; }
    let src = null;
    try { src = await load(ref.key); } catch { src = null; }
    if (!src) { missing.push(ref.block); continue; }
    if (!src.__xrefBound) {
      src.__xrefBound = true;
      const inner = await bindXrefs(src, load, { depth: depth + 1, stack: [...stack, ref.key] });
      missing.push(...inner.missing.map((n) => `${ref.block}|${n}`));
    }
    mergeInto(dxf, block, src);
    bound.push(ref.block);
  }
  return { bound, missing };
}

function mergeInto(dxf, block, src) {
  const pre = block.name;
  const layer = (name) => (!name || name === '0' || name.startsWith('*') ? name : `${pre}|${name}`);
  const blockName = (name) => (name && !name.startsWith('*') ? `${pre}|${name}` : name);
  // 레이어: 시트 파일에 있으면(참조 레이어 설정) 그대로, 없으면 참조 파일의 설정으로
  for (const [name, l] of Object.entries(src.layers || {})) {
    const n = layer(name);
    if (!dxf.layers[n]) dxf.layers[n] = { ...l, name: n };
  }
  const clone = (e) => {
    const c = { ...e, layer: layer(e.layer) };
    if (e.type === 'insert') c.name = blockName(e.name);
    if (e.attribs) c.attribs = e.attribs.map((a) => ({ ...a, layer: layer(a.layer) }));
    return c;
  };
  // 참조 파일 안의 블록(중첩 참조로 채운 것 포함)
  for (const [name, b] of Object.entries(src.blocks || {})) {
    if (name.startsWith('*')) continue;
    const n = blockName(name);
    if (dxf.blocks[n]) continue;
    dxf.blocks[n] = { ...b, name: n, flags: b.flags & ~4, entities: b.entities.map(clone), attdefs: b.attdefs || [] };
  }
  // 참조 블록 = 참조 파일의 모형 공간, 기준점은 참조 파일의 삽입 기준점($INSBASE)
  block.entities = (src.entities || []).filter((e) => !e.ps).map(clone);
  block.base = src.header?.insbase ? [src.header.insbase[0], src.header.insbase[1]] : [0, 0];
  block.flags &= ~4;
  block.xrefBound = true;
}

/**
 * 참조용 파일 짐작: 묶음으로 올린 파일 중 아무도 참조하지 않는데도 도면(시트)이 아닌 파일.
 * 실제 도서 폴더에는 쓰지 않는 외부 참조 사본("xr 세대-g(2)"처럼 이름 뒤에 번호가 붙은 것 등)이 섞여 있다.
 * 도곽·도면번호·도면명이 하나도 없고(파일 전체 한 장), 파일 이름도 도면번호로 시작하지 않으면 참조용으로 본다.
 */
export function isRefLikeFile(name, sheets) {
  const base = String(name || '').split(/[\\/]/).pop();
  if (/^(xref|xr|x-ref)[\s_-]/i.test(base)) return true;
  if (/^[A-Z]{1,3}\d{0,3}[-_ ]?\d/i.test(base)) return false;
  return sheets.length > 0 && sheets.every((s) => s.method === 'whole' && !s.titleBlock?.title && !s.titleBlock?.sheetNo);
}
