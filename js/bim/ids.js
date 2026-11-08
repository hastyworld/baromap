// 요소 id: 같은 근거(도면번호 + 개체 핸들)면 다시 만들어도 같은 id → 버전이 바뀌어도 요소를 따라갈 수 있다.

export function hash(str) {
  // FNV-1a 두 번(다른 씨앗) → 64비트를 36진수로
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(36).padStart(7, '0') + h2.toString(36).padStart(7, '0').slice(0, 4);
}

export const hashId = (prefix, ...parts) => `${prefix}${hash(parts.flat().map((p) => String(p ?? '')).join('|'))}`;

// 사람이 읽는 이름을 id에 쓸 수 있게(84A → 84A, 101동 → 101)
export function slug(name) {
  const s = String(name || '').replace(/동$/, '').replace(/[^\w가-힣-]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[\w-]{1,24}$/.test(s) ? s : hash(name).slice(0, 8);
}

export const r3 = (v) => Math.round(v * 1000) / 1000;
export const rp = (p) => [r3(p[0]), r3(p[1])];
