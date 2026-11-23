// 도면(DXF) 바이트 → 글자. 화면과 무관한 순수 함수(브라우저·워커·Node 공용).
// - 2007 이후(AC1021~) DXF는 UTF-8, 그 전 한글 도면은 보통 CP949(헤더 $DWGCODEPAGE = ANSI_949)
// - 옛 형식의 유니코드 표기(\U+BCBD)는 글자로 바꾼다
// - 바이너리 DXF는 읽지 않는다(ASCII DXF로 다시 저장 안내)

export const BINARY_SENTINEL = 'AutoCAD Binary DXF';

// $DWGCODEPAGE → TextDecoder 이름(WHATWG). euc-kr은 실제로 CP949(확장 완성형)까지 읽는다.
const CODEPAGES = {
  ANSI_949: 'euc-kr', ANSI_1361: 'euc-kr', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258',
  ANSI_874: 'windows-874', DOS437: 'ibm866', DOS850: 'windows-1252',
};

export function isBinaryDxf(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 18) return false;
  for (let i = 0; i < 18; i++) if (b[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  return true;
}

export const binaryError = () => new Error('바이너리 DXF는 읽을 수 없습니다. AutoCAD에서 "다른 이름으로 저장 → DXF(ASCII)"로 다시 저장해서 올려주세요.');

// 파일 앞부분(헤더)에서 버전·코드페이지를 읽는다.
export function sniffHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 1 << 18)));
  const val = (name) => {
    const m = new RegExp(`\\${name}\\s*\\r?\\n\\s*\\d+\\s*\\r?\\n([^\\r\\n]*)`).exec(head);
    return m ? m[1].trim() : '';
  };
  return { acadver: val('$ACADVER'), codepage: val('$DWGCODEPAGE').toUpperCase() };
}

// 헤더 판이 2007 이후(AC1021+)인지: 이 판은 글자가 UTF-8이다
export function utf8Version(bytes) {
  const ver = parseInt(sniffHeader(bytes).acadver.replace(/^AC/, ''), 10);
  return ver >= 1021;
}

// 스트리밍으로 읽을 때 쓸 글자 해독기 이름(파일 앞부분만 보고 정한다). 2007 이후는 UTF-8(깨진 바이트는 그 자리만 대체 문자 — 파일 전체를 CP949로 읽지 않는다)
export function encodingFor(bytes) {
  const { acadver, codepage } = sniffHeader(bytes);
  const ver = parseInt(acadver.replace(/^AC/, ''), 10);
  if (ver >= 1021) return 'utf-8';
  return CODEPAGES[codepage] || 'euc-kr';
}

export const unescapeUnicode = (s) => s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

// UTF-8로 맞는지(바이트 범위 [s, e)): 줄마다 TextDecoder를 만들지 않으려고 직접 센다
function validUtf8(b, s, e) {
  for (let i = s; i < e;) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    const n = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    if (n < 0 || i + n >= e) return false;
    for (let k = 1; k <= n; k++) if ((b[i + k] & 0xc0) !== 0x80) return false;
    i += n + 1;
  }
  return true;
}

/**
 * 2007 이후 형식(UTF-8이 맞는 판)인데 몇 바이트가 깨진 파일: 파일 전체를 CP949로 다시 읽지 않고(한글이 모두 깨진다),
 * 깨진 줄만 CP949로 다시 읽어 본다. 그래도 안 되면 그 줄만 대체 문자로 둔다(45 지시서 3절)
 * @returns {{ text: string, cp949Lines: number, badLines: number }}
 */
export function decodeUtf8Lines(bytes) {
  const utf8 = new TextDecoder('utf-8');
  const cp949 = new TextDecoder('euc-kr', { fatal: true });
  const parts = [];
  let good = 0; // 아직 내보내지 않은 맞는 구간의 시작
  let cp949Lines = 0;
  let badLines = 0;
  for (let ls = 0; ls < bytes.length;) {
    let le = bytes.indexOf(0x0a, ls);
    le = le < 0 ? bytes.length : le + 1;
    let high = false;
    for (let i = ls; i < le; i++) if (bytes[i] >= 0x80) { high = true; break; }
    if (high && !validUtf8(bytes, ls, le)) {
      if (ls > good) parts.push(utf8.decode(bytes.subarray(good, ls)));
      const line = bytes.subarray(ls, le);
      try { parts.push(cp949.decode(line)); cp949Lines++; } catch { parts.push(utf8.decode(line)); badLines++; }
      good = le;
    }
    ls = le;
  }
  if (good < bytes.length) parts.push(utf8.decode(bytes.subarray(good)));
  return { text: parts.join(''), cp949Lines, badLines };
}

/**
 * 파일 바이트 → 글자. UTF-8로 깨짐 없이 읽히면 UTF-8(영문만 있는 파일 포함), 아니면 헤더의 코드페이지(없으면 CP949).
 * 2007 이후 형식은 UTF-8이 맞으므로 깨진 줄만 다시 읽는다(fixed: { cp949Lines, badLines }).
 * @returns {{ text: string, encoding: string, fixed?: { cp949Lines: number, badLines: number } }}
 */
export function decodeBytes(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (isBinaryDxf(bytes)) throw binaryError();
  let text;
  let encoding = 'utf-8';
  let fixed = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    encoding = encodingFor(bytes);
    if (encoding === 'utf-8' && utf8Version(bytes)) {
      const r = decodeUtf8Lines(bytes);
      text = r.text;
      fixed = { cp949Lines: r.cp949Lines, badLines: r.badLines };
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return { text: unescapeUnicode(text), encoding, fixed };
    }
    // 한국 도면은 헤더가 영문(1252)이거나 비어 있어도 실제 내용은 CP949인 경우가 많다 → CP949로 깨짐 없이 읽히면 CP949
    if (encoding === 'utf-8' || encoding === 'windows-1252') {
      try {
        text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes);
        encoding = 'euc-kr';
      } catch {
        if (encoding === 'utf-8') encoding = 'euc-kr';
      }
    }
    text ??= new TextDecoder(encoding).decode(bytes);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text: unescapeUnicode(text), encoding };
}

// 기존 v0.4 API(글자만 돌려줌)
export function decodeDxf(buf) {
  return decodeBytes(buf).text;
}

// TEXT 특수 기호: %%c 지름, %%d 도, %%p 플러스마이너스, %%u·%%o 밑줄·윗줄(표시만이라 지움), %%nnn 문자 코드
export function cleanText(s) {
  return String(s ?? '')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/%%%/g, '%');
}

/**
 * MTEXT 서식 코드 제거: \P 줄바꿈, \~ 빈칸, {} 묶음, \f…; 글꼴, \H…; 높이, \W…; 폭, \Q…; 기울기, \T…; 자간, \A…; 정렬,
 * \C…; \c…; 색, \p…; 문단, \L\l\O\o\K\k 밑줄 등, \S위^아래; 겹침 글자 → 위/아래, \\ \{ \} 글자 그대로
 */
export function cleanMtext(s) {
  let t = cleanText(s);
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') { out += ch; continue; }
    const n = t[i + 1];
    if (n === undefined) break;
    if (n === 'P' || n === 'X') { out += '\n'; i++; continue; }
    if (n === '~') { out += ' '; i++; continue; }
    if (n === '\\' || n === '{' || n === '}') { out += n; i++; continue; }
    if ('LlOoKkNn'.includes(n)) { i++; continue; }
    if (n === 'S') {
      const end = t.indexOf(';', i + 2);
      const body = end < 0 ? t.slice(i + 2) : t.slice(i + 2, end);
      out += body.replace(/[\^#]/, '/').replace(/\^/g, '');
      i = end < 0 ? t.length : end;
      continue;
    }
    if ('fFHWQTACcpa'.includes(n)) {
      const end = t.indexOf(';', i + 2);
      i = end < 0 ? t.length : end;
      continue;
    }
    out += n;
    i++;
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}
