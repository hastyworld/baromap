// 공공 데이터 해석(30 지시서 1·2절). 순수 함수 — 브라우저와 Edge Function(public-data)이 같이 쓴다(npm run functions:sync).
// 건축HUB 건축인허가·건축물대장(공공데이터포털, 이용허락 "제한 없음", 출처 표시). 크롤링하지 않는다. 키는 Edge Function 비밀값에만.
// 응답 필드 이름은 공식 페이지에 없어(활용가이드 첨부 문서에만 있음) 알려진 이름과 다른 이름을 함께 받는다. 키 등록 뒤 실제 응답으로 확인한다.

export const PUBLIC_SOURCES = {
  permit: {
    label: '국토교통부 건축HUB 건축인허가 정보 서비스',
    base: 'https://apis.data.go.kr/1613000/ArchPmsHubService',
    ops: { basis: 'getApBasisOulnInfo', dong: 'getApDongOulnInfo', jiji: 'getApJijiguInfo' },
    page: 'https://www.data.go.kr/data/15136267/openapi.do',
  },
  register: {
    label: '국토교통부 건축HUB 건축물대장정보 서비스',
    base: 'https://apis.data.go.kr/1613000/BldRgstHubService',
    ops: { recap: 'getBrRecapTitleInfo', title: 'getBrTitleInfo' },
    page: 'https://www.data.go.kr/data/15134735/openapi.do',
  },
};
// 정부 기록 대조 결과 종류(30 지시서 3절, js/bim/public-checks.js)
export const PUBLIC_FINDING_LABEL = {
  pub_building_count: '동 수(정부 기록)', pub_floors: '동별 층수(정부 기록)', pub_units: '세대수(정부 기록)',
  pub_gross_area: '연면적(정부 기록)', pub_height: '최고 높이(정부 기록)', pub_site_area: '대지면적(정부 기록)',
};
export const PUBLIC_LICENSE = '공공데이터포털(data.go.kr) 제공, 이용허락범위 제한 없음';
export const FRESH_MS = 24 * 3600 * 1000; // 하루 한 번 갱신

// ---------------------------------------------------------------- 필지(PNU)

/** 지번 글자 → { mountain, bun, ji }: "고덕동 123-4", "산 12-3", "123" */
export function parseJibun(text) {
  const s = String(text || '').trim();
  const m = /(?:^|\s)(산\s*)?(\d{1,4})(?:\s*-\s*(\d{1,4}))?(?:\s*번지)?\s*$/.exec(s);
  if (!m) return null;
  return { mountain: Boolean(m[1]), bun: Number(m[2]), ji: Number(m[3] || 0) };
}

/**
 * 법정동코드(10자리) + 지번 → 공공 API 요청값과 PNU(19자리)
 * @param {string} bcode 우편번호 서비스의 bcode(법정동코드) @param {string} jibun 지번 주소 또는 "123-4"
 */
export function pnuFrom(bcode, jibun) {
  const code = String(bcode || '').replace(/\D/g, '');
  if (code.length !== 10) throw new Error('법정동코드(10자리)를 찾지 못했습니다. 주소를 우편번호 찾기로 다시 골라주세요.');
  const j = parseJibun(jibun);
  if (!j || !j.bun) throw new Error('지번(번·지)을 찾지 못했습니다. 지번 주소로 골라주세요(예: 123-4).');
  const pad = (n) => String(n).padStart(4, '0');
  return { pnu: `${code}${j.mountain ? 2 : 1}${pad(j.bun)}${pad(j.ji)}`, sigunguCd: code.slice(0, 5), bjdongCd: code.slice(5), platGbCd: j.mountain ? '1' : '0', bun: pad(j.bun), ji: pad(j.ji) };
}
/** PNU(19자리) → 요청값 */
export function queryOfPnu(pnu) {
  const p = String(pnu || '').replace(/\D/g, '');
  if (p.length !== 19) throw new Error('필지번호(PNU)는 19자리 숫자입니다.');
  return { pnu: p, sigunguCd: p.slice(0, 5), bjdongCd: p.slice(5, 10), platGbCd: p[10] === '2' ? '1' : '0', bun: p.slice(11, 15), ji: p.slice(15, 19) };
}

// ---------------------------------------------------------------- 응답

/** 공공데이터포털 응답 머리: { code, msg }. XML 오류(인증키 등)도 읽는다 */
export function resultOf(body) {
  if (typeof body === 'string') {
    const tag = (names) => { for (const n of names) { const m = new RegExp(`<${n}>([^<]*)<`).exec(body); if (m?.[1]) return m[1]; } return ''; };
    const code = tag(['returnReasonCode', 'resultCode']);
    const msg = tag(['returnAuthMsg', 'resultMsg', 'errMsg']);
    return { code: code || 'XML', msg: msg || '응답을 읽지 못했습니다' };
  }
  const h = body?.response?.header || body?.header || {};
  return { code: String(h.resultCode ?? ''), msg: String(h.resultMsg ?? '') };
}
/** 항목 목록(item이 하나면 객체, 없으면 빈 글자로 오는 경우까지) */
export function itemsOf(body) {
  const items = body?.response?.body?.items ?? body?.body?.items;
  const it = items?.item ?? items;
  if (!it || typeof it !== 'object') return [];
  return Array.isArray(it) ? it : [it];
}
export const totalOf = (body) => Number(body?.response?.body?.totalCount ?? itemsOf(body).length) || 0;

const pick = (o, names) => { for (const n of names) if (o?.[n] != null && String(o[n]).trim() !== '') return o[n]; return null; };
const num = (o, names) => { const v = pick(o, names); if (v == null) return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const text = (o, names, max = 100) => { const v = pick(o, names); return v == null ? '' : String(v).trim().slice(0, max); };
const day = (o, names) => { const v = String(pick(o, names) ?? '').replace(/\D/g, ''); return v.length === 8 && v !== '00000000' ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : ''; };
const pos = (n) => (n != null && n > 0 ? n : null);

const F = {
  address: ['platPlc', 'newPlatPlc'], name: ['bldNm'], purpose: ['mainPurpsCdNm', 'mainPurpsNm'],
  siteArea: ['platArea'], buildingArea: ['archArea'], grossArea: ['totArea'], coverage: ['bcRat'], far: ['vlRat'],
  households: ['hhldCnt'], hoCnt: ['hoCnt'], families: ['fmlyCnt'], mainBuildings: ['mainBldCnt'], subBuildings: ['atchBldCnt'], parking: ['totPkngCnt', 'pkngCnt'],
  permitDate: ['archPmsDay', 'pmsDay'], startDate: ['realStcnsDay', 'stcnsDay', 'stcnsSchedDay'], approvalDate: ['useAprDay'],
  dongName: ['dongNm', 'dongNo'], floorsAbove: ['grndFlrCnt'], floorsBelow: ['ugrndFlrCnt'], height: ['heit', 'height'], mainAtch: ['mainAtchGbCdNm', 'mainAtchGbNm'],
  zoneName: ['jijiguCdNm', 'jijiguNm'], zoneKind: ['jijiguGbCdNm', 'jijiguGbNm'], zoneCode: ['jijiguCd'],
};

function summaryOf(o) {
  return {
    address: text(o, F.address, 200), name: text(o, F.name), purpose: text(o, F.purpose, 60),
    siteArea: pos(num(o, F.siteArea)), buildingArea: pos(num(o, F.buildingArea)), grossArea: pos(num(o, F.grossArea)), coverage: pos(num(o, F.coverage)), far: pos(num(o, F.far)),
    households: pos(num(o, F.households)), mainBuildings: pos(num(o, F.mainBuildings)), subBuildings: pos(num(o, F.subBuildings)), parking: pos(num(o, F.parking)),
    permitDate: day(o, F.permitDate), startDate: day(o, F.startDate), approvalDate: day(o, F.approvalDate),
  };
}
function dongOf(o) {
  return { name: text(o, F.dongName, 40) || text(o, F.name, 40), purpose: text(o, F.purpose, 60), main: !/부속/.test(text(o, F.mainAtch, 20)), floorsAbove: num(o, F.floorsAbove), floorsBelow: num(o, F.floorsBelow), height: pos(num(o, F.height)), grossArea: pos(num(o, F.grossArea)), buildingArea: pos(num(o, F.buildingArea)), households: pos(num(o, F.households)) };
}
const zoneOf = (o) => ({ name: text(o, F.zoneName, 60), kind: text(o, F.zoneKind, 30), code: text(o, F.zoneCode, 20) });

/** 건축인허가 세 응답(기본개요·동별개요·지역지구) → 한 기록. 같은 대지에 허가가 여럿이면 가장 최근 허가 */
export function parsePermit({ basis, dong, jiji }) {
  const list = itemsOf(basis).map((o) => ({ o, s: summaryOf(o) })).sort((a, b) => (b.s.permitDate || '').localeCompare(a.s.permitDate || ''));
  const summary = list[0]?.s || null;
  const dongs = itemsOf(dong).map(dongOf).filter((d) => d.name);
  const zones = itemsOf(jiji).map(zoneOf).filter((z) => z.name);
  return { kind: 'permit', empty: !summary && !dongs.length, summary, dongs, zones, permits: list.length };
}

/** 건축물대장(총괄표제부·표제부) → 한 기록. 신축 현장은 대장이 없을 수 있다(empty) */
export function parseRegister({ recap, title }) {
  const r = itemsOf(recap).map(summaryOf)[0] || null;
  const titles = itemsOf(title);
  const dongs = titles.map(dongOf).filter((d) => d.name);
  const summary = r || (titles[0] ? { ...summaryOf(titles[0]), grossArea: dongs.reduce((s, d) => s + (d.grossArea || 0), 0) || null } : null);
  return { kind: 'register', empty: !summary && !dongs.length, summary, dongs, zones: [] };
}

export const VALUE_LABEL = {
  address: '대지 위치', name: '건물 이름', purpose: '주용도', siteArea: '대지면적(㎡)', buildingArea: '건축면적(㎡)', grossArea: '연면적(㎡)', coverage: '건폐율(%)', far: '용적률(%)',
  households: '세대수', mainBuildings: '주건축물 수', subBuildings: '부속건축물 수', parking: '주차 대수', permitDate: '허가일', startDate: '착공일', approvalDate: '사용승인일',
};

/**
 * 받은 기록들 → 화면·대조에 쓸 값(값마다 출처와 받은 날짜). 신축은 인허가 값, 없으면 대장 값
 * @param {any[]} records public_records 줄들({ kind, data, fetchedAt, source })
 */
export function publicSummary(records) {
  const by = (k) => records.find((r) => r.kind === k && r.data && !r.data.empty);
  const order = [by('permit'), by('register')].filter(Boolean);
  const values = {};
  for (const key of Object.keys(VALUE_LABEL)) {
    for (const r of order) {
      const v = r.data.summary?.[key];
      if (v != null && v !== '') { values[key] = { value: v, source: PUBLIC_SOURCES[r.kind].label, kind: r.kind, fetchedAt: r.fetchedAt }; break; }
    }
  }
  const dongRec = order.find((r) => r.data.dongs?.length);
  const zoneRec = order.find((r) => r.data.zones?.length);
  return {
    values,
    dongs: dongRec ? dongRec.data.dongs.map((d) => ({ ...d, source: PUBLIC_SOURCES[dongRec.kind].label, kind: dongRec.kind, fetchedAt: dongRec.fetchedAt })) : [],
    zones: zoneRec ? zoneRec.data.zones : [],
    empty: !order.length,
    kinds: order.map((r) => r.kind),
  };
}

/** 현장 개요로 옮길 글(사람이 확인하고 누른다) */
export function overviewText(sum) {
  const v = sum.values;
  const line = (k, unit = '') => (v[k] ? `${VALUE_LABEL[k].replace(/\(.+\)/, '')} ${typeof v[k].value === 'number' ? v[k].value.toLocaleString() : v[k].value}${unit}` : '');
  const parts = [line('siteArea', '㎡'), line('grossArea', '㎡'), line('coverage', '%'), line('far', '%'), line('households', '세대'), sum.dongs.length ? `동 ${sum.dongs.filter((d) => d.main).length}개` : '', line('permitDate'), line('purpose')].filter(Boolean);
  const zones = sum.zones.map((z) => z.name).filter(Boolean);
  const src = [...new Set(Object.values(v).map((x) => `${x.source}(${String(x.fetchedAt || '').slice(0, 10)} 받음)`))];
  return `[공공 정보] ${parts.join(', ')}${zones.length ? `\n지역·지구: ${zones.join(', ')}` : ''}\n출처: ${src.join(', ')}`;
}
