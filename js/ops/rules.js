// 현장 운영 기록의 검증 규칙. store.js의 validate()가 부른다(검증의 입구는 한 곳).
import { fail, str, date, int, dec, oneOf, obj, arr, strs, required, siteOf } from '../rules-base.js';
import { DOC_KINDS, DOC_STATUS } from '../bim/doc-core.js';

const MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'];
const THUMB_MAX = 56000; // webp 40KB의 base64 길이

// 첨부 파일 목록(10 지시서 0절)
export function fileList(v, siteId, label = '첨부', max = 20) {
  return arr(v, label, max).map((f) => {
    const path = str(f?.path, 300);
    if (!path.startsWith(`${siteId}/`)) fail(`${label} 파일 경로가 올바르지 않습니다.`);
    const mime = oneOf(f?.mime, MIME, `${label} 파일 형식`);
    const thumb = f?.thumb == null ? '' : String(f.thumb);
    if (thumb && (!/^data:image\/(jpeg|png|webp);base64,/.test(thumb) || thumb.length > THUMB_MAX)) fail(`${label} 미리보기가 올바르지 않습니다.`);
    return {
      path, name: str(f?.name, 200), mime, size: Math.max(0, Math.round(Number(f?.size) || 0)), thumb,
      takenAt: str(f?.takenAt, 40), blurred: f?.blurred === true, people: f?.people === true,
    };
  });
}

// 날짜·시각(ISO 또는 빈 값)
const stamp = (v, label) => {
  if (v == null || v === '') return null;
  if (Number.isNaN(Date.parse(String(v)))) fail(`${label} 값이 올바르지 않습니다.`);
  return String(v);
};

const line = (l) => ({ trade: str(l?.trade, 30), area: str(l?.area, 60), text: str(l?.text, 300), buildingId: str(l?.buildingId, 40), floors: str(l?.floors, 30) });

const RULES = {
  companies(b, data) {
    return {
      siteId: siteOf(b, data, '협력사를 넣을'),
      name: required(str(b.name, 60), '협력사 이름'),
      trades: strs(b.trades, '공종', 20, 30),
      active: b.active !== false,
      sort: int(b.sort, '순서', -9999, 9999) ?? 0,
      memo: str(b.memo, 500),
    };
  },

  projectDocs(b, data) {
    const size = Number(b.size ?? 0);
    if (!Number.isFinite(size) || size < 0) fail('파일 크기가 올바르지 않습니다.');
    return {
      siteId: siteOf(b, data, '문서를 올릴'),
      setId: str(b.setId, 40) || null,
      name: required(str(b.name, 200), '문서 이름'),
      kind: oneOf(b.kind, DOC_KINDS, '문서 종류', 'unknown'),
      mime: str(b.mime, 120),
      size: Math.round(size),
      pages: int(b.pages, '쪽 수', 0, 5000) ?? 0,
      path: str(b.path, 300) || null,
      revision: str(b.revision, 20),
      docDate: date(b.docDate, '작성일'),
      status: oneOf(b.status, DOC_STATUS, '문서 상태', 'uploaded'),
      extracted: b.extracted == null ? null : obj(b.extracted, '추출 결과', 2000000),
      confidence: b.confidence == null ? null : Math.min(1, Math.max(0, Number(b.confidence) || 0)),
      note: str(b.note, 2000),
    };
  },

  notices(b, data) {
    const body = obj(b.body, '알림 내용', 16000);
    let total = 0;
    for (const [k, v] of Object.entries(body)) {
      if (!/^[a-z]{2,3}$/.test(k) || typeof v !== 'string') fail('알림 내용 형식이 올바르지 않습니다.');
      total += v.length;
    }
    if (total > 8000) fail('알림 내용은 모두 합쳐 8,000자까지입니다.');
    return {
      siteId: siteOf(b, data, '알림을 넣을'),
      kind: oneOf(b.kind, ['heat', 'cold', 'weather', 'manual', 'permit', 'equipment', 'lease', 'issue', 'supply'], '알림 종류', 'manual'),
      level: oneOf(b.level, ['info', 'warn', 'danger'], '알림 수준', 'info'),
      title: required(str(b.title, 100), '알림 제목'),
      body,
      target: obj(b.target ?? { all: true }, '알림 대상', 5000),
      ref: obj(b.ref, '관련 기록', 2000),
      startsAt: stamp(b.startsAt, '시작 시각'),
      endsAt: stamp(b.endsAt, '끝 시각'),
    };
  },

  dailyReports(b, data) {
    const siteId = siteOf(b, data, '일보를 쓸');
    const w = obj(b.weather, '날씨', 2000);
    return {
      siteId,
      date: required(date(b.date, '일보 날짜'), '일보 날짜'),
      weather: {
        min: dec(w.min, '최저 기온', -60, 60), max: dec(w.max, '최고 기온', -60, 60), feelsMax: dec(w.feelsMax, '최고 체감온도', -80, 70),
        rainMm: dec(w.rainMm, '강수량', 0, 2000), windMax: dec(w.windMax, '바람', 0, 100), sky: str(w.sky, 20), note: str(w.note, 200),
      },
      manpower: arr(b.manpower, '출역', 100).map((m) => ({
        companyId: str(m?.companyId, 40), company: str(m?.company, 60), trade: str(m?.trade, 30), kind: m?.kind === 'staff' ? 'staff' : 'partner',
        count: int(m?.count, '인원', 0, 999) ?? 0, note: str(m?.note, 100),
      })),
      equipment: arr(b.equipment, '장비', 50).map((e) => ({
        equipmentId: str(e?.equipmentId, 40), name: str(e?.name, 60), spec: str(e?.spec, 60), count: int(e?.count, '장비 대수', 0, 999) ?? 0, company: str(e?.company, 60),
      })),
      work: arr(b.work, '오늘 작업', 100).map(line),
      progress: arr(b.progress, '공정 요약', 300).map((p) => ({ sheet: str(p?.sheet, 30), building: str(p?.building, 30), trade: str(p?.trade, 30), units: int(p?.units, '세대 수', 0, 100000) ?? 0, range: str(p?.range, 30) })),
      plan: arr(b.plan, '내일 계획', 100).map(line),
      safety: obj(b.safety, '안전 요약', 20000),
      issues: str(b.issues, 2000),
      files: fileList(b.files, siteId, '일보 사진'),
      source: obj(b.source, '가져오기 기록', 2000),
    };
  },
};

// ---------------------------------------------------------------- 공정표(26·28 지시서)

const SC_STATUS = ['draft', 'active', 'archived'];
const SC_FORMATS = ['standard', 'mspdi', 'xer', 'table', 'barchart', 'pdf'];
const ZONES = ['site', 'building', 'underground', 'facility', 'unknown'];
const FLOOR = /^(B\d{1,2}|\d{1,3}|PH)$/;
const floorOf = (v, label) => { const s = str(v, 10); if (s && !FLOOR.test(s)) fail(`${label} '${s}'은(는) B2·1·15·PH 같은 층 표기여야 합니다.`); return s; };

Object.assign(RULES, {
  schedules(b, data) {
    const cal = obj(b.calendar, '달력', 20000);
    return {
      siteId: siteOf(b, data, '공정표를 올릴'),
      name: required(str(b.name, 100), '공정표 이름'),
      version: int(b.version, '판 번호', 1, 9999) ?? 1,
      status: oneOf(b.status, SC_STATUS, '공정표 상태', 'draft'),
      baseline: b.baseline === true,
      format: oneOf(b.format, SC_FORMATS, '공정표 형식', 'standard'),
      fileName: str(b.fileName, 200),
      path: str(b.path, 300) || null,
      startDate: date(b.startDate, '공정 시작일') || '',
      finishDate: date(b.finishDate, '공정 종료일') || '',
      calendar: {
        workdays: arr(cal.workdays, '근무 요일', 7).map((d) => int(d, '근무 요일', 1, 7)),
        holidays: arr(cal.holidays, '휴일', 1500).map((d) => date(d, '휴일')).filter(Boolean),
        stops: arr(cal.stops, '중단 기간', 100).map((s) => ({ from: date(s?.from, '중단 시작'), to: date(s?.to, '중단 끝'), trades: strs(s?.trades, '중단 공종', 20, 30), note: str(s?.note, 100) })).filter((s) => s.from && s.to),
      },
      floors: arr(b.floors, '층설정', 30).map((f) => ({ name: str(f?.name, 30), from: str(f?.from, 10), to: str(f?.to, 10), weight: dec(f?.weight, '층 가중치', 0.01, 10) ?? 1 })),
      stats: obj(b.stats, '통계', 4000),
      note: str(b.note, 1000),
    };
  },

  scheduleActivities(b) {
    const scheduleId = required(str(b.scheduleId, 40), '공정표');
    const d = (v, label) => date(v, label) || '';
    const r = {
      scheduleId,
      siteId: str(b.siteId, 40) || null, // 공유 모드에서는 DB가 공정표의 현장으로 정한다
      sort: int(b.sort, '순서', 0, 100000) ?? 0,
      actId: required(str(b.actId, 60), '작업ID'),
      name: str(b.name, 200),
      wbs: strs(b.wbs, 'WBS', 12, 100),
      zone: b.zone ? oneOf(b.zone, ZONES, '구역') : '',
      building: str(b.building, 30),
      fromFloor: floorOf(b.fromFloor, '시작층'),
      toFloor: floorOf(b.toFloor, '끝층'),
      line: str(b.line, 10),
      trade: str(b.trade, 30),
      start: d(b.start, '시작일'), finish: d(b.finish, '종료일'),
      baseStart: d(b.baseStart, '기준 시작일'), baseFinish: d(b.baseFinish, '기준 종료일'),
      actualStart: d(b.actualStart, '실적 시작일'), actualFinish: d(b.actualFinish, '실적 종료일'),
      percent: dec(b.percent, '진행률', 0, 100),
      floorDays: dec(b.floorDays, '층당일수', 0, 365),
      spread: oneOf(b.spread, ['cycle', 'even', 'qty'], '배분 방식', 'cycle'),
      qty: dec(b.qty, '수량', 0, 1e12),
      unit: str(b.unit, 20),
      preds: arr(b.preds, '선행 작업', 30).map((p) => ({ id: str(p?.id, 60), type: oneOf(p?.type, ['FS', 'SS', 'FF', 'SF'], '관계', 'FS'), lag: dec(p?.lag, '지연일', -3650, 3650) ?? 0 })).filter((p) => p.id),
      outdoor: b.outdoor === true,
      summary: b.summary === true,
      linked: b.linked === true,
      source: obj(b.source, '출처', 4000),
    };
    if (r.start && r.finish && r.finish < r.start) fail(`${r.actId}: 종료일이 시작일보다 앞입니다.`);
    // 연결됨은 위치(구역, 동 구역이면 동)와 공종이 있을 때만
    if (r.linked && !(r.trade && r.zone && r.zone !== 'unknown' && (r.zone !== 'building' || r.building))) r.linked = false;
    return r;
  },

  scheduleDict(b) {
    return {
      key: required(str(b.key, 60), '사전 열쇠'),
      trade: required(str(b.trade, 30), '공종'),
      zone: b.zone ? oneOf(b.zone, ZONES, '구역') : '',
      siteId: str(b.siteId, 40) || null,
      count: int(b.count, '횟수', 0, 1e6) ?? 1,
    };
  },
});

// ---------------------------------------------------------------- 내역서·단가·공사 업체·시공 기준(24 지시서)
const COST_STATUS = ['draft', 'active', 'archived'];
const TARGET_KINDS = ['material', 'assembly', 'windowType', 'facadeZone', 'elementKind'];
const money = (v, label) => dec(v, label, -1e13, 1e13);
// 회사 공통이면 siteId 없음, 있으면 있는 현장이어야 한다
const siteOrNull = (b, data, label) => (b.siteId ? siteOf(b, data, label) : null);

Object.assign(RULES, {
  costBooks(b, data) {
    return {
      siteId: siteOrNull(b, data, '내역서를 올릴'),
      name: required(str(b.name, 100), '내역서 이름'),
      trade: str(b.trade, 30),
      fileName: str(b.fileName, 200),
      path: str(b.path, 300) || null,
      format: obj(b.format, '양식', 8000),
      itemCount: int(b.itemCount, '항목 수', 0, 1e6) ?? 0,
      totalAmount: b.totalAmount == null || b.totalAmount === '' ? null : Math.round(money(b.totalAmount, '합계 금액')),
      confidential: b.confidential === true,
      status: oneOf(b.status, COST_STATUS, '내역서 상태', 'draft'),
      note: str(b.note, 1000),
    };
  },

  costItems(b) {
    const r = {
      bookId: required(str(b.bookId, 40), '내역서'),
      siteId: str(b.siteId, 40) || null, // 공유 모드에서는 DB가 내역서의 현장으로 정한다
      path: strs(b.path, '공종 제목', 10, 60),
      name: required(str(b.name, 200), '품명'),
      spec: str(b.spec, 200),
      unit: str(b.unit, 20),
      qty: dec(b.qty, '수량', -1e12, 1e12),
      materialUnit: money(b.materialUnit, '재료비 단가'),
      laborUnit: money(b.laborUnit, '노무비 단가'),
      expenseUnit: money(b.expenseUnit, '경비 단가'),
      totalUnit: money(b.totalUnit, '합계 단가'),
      amount: money(b.amount, '금액'),
      code: str(b.code, 40),
      source: oneOf(b.source, ['book', 'manual'], '출처', 'book'),
      sort: int(b.sort, '순서', 0, 1e6) ?? 0,
      note: str(b.note, 300),
    };
    if (r.totalUnit == null && [r.materialUnit, r.laborUnit, r.expenseUnit].some((x) => x != null)) r.totalUnit = (r.materialUnit || 0) + (r.laborUnit || 0) + (r.expenseUnit || 0);
    return r;
  },

  costLinks(b, data) {
    const r = {
      siteId: siteOrNull(b, data, '연결할'),
      targetKind: oneOf(b.targetKind, TARGET_KINDS, '연결 대상 종류'),
      targetKey: required(str(b.targetKey, 100), '연결 대상'),
      itemId: str(b.itemId, 40) || null,
      itemKey: str(b.itemKey, 200),
      factor: dec(b.factor, '환산 계수', 1e-9, 1e9) ?? 1,
      modelUnit: str(b.modelUnit, 20),
      confirmed: b.confirmed === true,
      note: str(b.note, 300),
    };
    // 현장 연결은 내역 항목과, 회사 사전(금액 없음)은 품명·규격·단위 열쇠와
    if (r.siteId && !r.itemId) fail('연결할 내역 항목을 골라주세요.');
    if (!r.siteId) { r.itemId = null; if (!r.itemKey) fail('사전 열쇠(품명·규격·단위)가 없습니다.'); }
    return r;
  },

  tradeAssignments(b, data) {
    const r = {
      siteId: siteOf(b, data, '공사 업체를 정할'),
      trade: required(str(b.trade, 30), '공종'),
      companyId: required(str(b.companyId, 40), '협력사'),
      buildingId: str(b.buildingId, 60) || null,
      zone: str(b.zone, 60),
      from: date(b.from, '시작일') || '',
      to: date(b.to, '종료일') || '',
      note: str(b.note, 300),
    };
    if (r.from && r.to && r.to < r.from) fail('종료일이 시작일보다 앞입니다.');
    return r;
  },

  workStandards(b, data) {
    const url = str(b.url, 500);
    if (url && !/^https:\/\//.test(url)) fail('링크는 https://로 시작해야 합니다.');
    return {
      siteId: siteOrNull(b, data, '시공 기준을 넣을'),
      kind: oneOf(b.kind, ['kcs', 'company', 'spec_doc'], '기준 종류', 'company'),
      trade: str(b.trade, 30),
      materialKeys: strs(b.materialKeys, '재료', 50, 100),
      code: str(b.code, 30),
      title: required(str(b.title, 200), '기준 이름'),
      url,
      body: str(b.body, 4000),
      files: arr(b.files, '첨부', 10).map((f) => ({ path: str(f?.path, 300), name: str(f?.name, 200), mime: str(f?.mime, 120), size: Math.max(0, Math.round(Number(f?.size) || 0)) })).filter((f) => f.path),
      docId: str(b.docId, 40) || null,
      page: int(b.page, '쪽', 1, 5000),
    };
  },
});

// 공공 정보(30 지시서 1~3절): 숫자·이름만(지도·지적 원본 없음)
Object.assign(RULES, {
  publicRecords(b, data) {
    return {
      siteId: siteOf(b, data, '공공 정보를 넣을'),
      kind: oneOf(b.kind, ['permit', 'register'], '공공 정보 종류'),
      query: obj(b.query, '필지', 1000),
      data: obj(b.data, '공공 정보', 200000),
      source: str(b.source, 100),
      status: oneOf(b.status, ['ok', 'empty', 'error'], '상태', 'ok'),
      fetchedAt: stamp(b.fetchedAt, '받은 시각') || new Date().toISOString(),
    };
  },
});

export const validateOps = (kind, b, data) => RULES[kind]?.(b, data);

// 운영 설정 고치기(바꾼 칸만). 현장 줄은 null이면 회사 기본값을 쓴다.
export function validateSettings(patch) {
  const b = patch || {};
  const out = {};
  const threshold = (v, label) => {
    const o = obj(v, label, 500);
    const r = {};
    for (const [k, x] of Object.entries(o)) {
      if (typeof x === 'boolean') { r[k] = x; continue; }
      const n = dec(x, label, -80, 1000);
      if (n != null) r[k] = n;
    }
    return r;
  };
  if ('heat' in b) out.heat = b.heat == null ? null : threshold(b.heat, '폭염 기준');
  if ('cold' in b) out.cold = b.cold == null ? null : threshold(b.cold, '한파 기준');
  if ('workdays' in b) {
    out.workdays = b.workdays == null ? null : arr(b.workdays, '근무 요일', 7).map((d) => int(d, '근무 요일', 1, 7));
    if (out.workdays && !out.workdays.length) fail('근무 요일을 하나 이상 골라주세요.');
  }
  if ('holidays' in b) out.holidays = b.holidays == null ? null : [...new Set(arr(b.holidays, '휴일', 200).map((d) => date(d, '휴일')).filter(Boolean))].sort();
  if ('rainStopMm' in b) out.rainStopMm = dec(b.rainStopMm, '우천 기준', 0, 500);
  if ('standards' in b) out.standards = b.standards == null ? null : obj(b.standards, '성능 기준값', 8000);
  if ('climateZone' in b) out.climateZone = str(b.climateZone, 20) || null;
  if ('daily' in b) {
    if (b.daily == null) out.daily = null;
    else {
      const d = obj(b.daily, '일보 서식', 2000);
      out.daily = { steps: Number(d.steps) === 2 ? 2 : 1, form: str(d.form, 60) };
    }
  }
  if ('languages' in b) out.languages = b.languages == null ? null : strs(b.languages, '현장 언어', 20, 10);
  if ('blurFaces' in b) out.blurFaces = b.blurFaces == null ? null : b.blurFaces === true;
  if ('reportLimitPerHour' in b) out.reportLimitPerHour = int(b.reportLimitPerHour, 'QR 신고 시간당 건수', 1, 1000);
  if ('handoverDate' in b) out.handoverDate = date(b.handoverDate, '사용검사일') || null;
  if ('qrEnabled' in b) out.qrEnabled = b.qrEnabled === true;
  if ('phrases' in b) out.phrases = b.phrases == null ? null : obj(b.phrases, '문구 검수', 200000);
  if ('takeoff' in b) {
    if (b.takeoff == null) out.takeoff = null;
    else {
      const t = obj(b.takeoff, '수량 산출 기준', 4000);
      const nums = (o, label, max) => Object.fromEntries(Object.entries(obj(o, label, 2000)).map(([k, v]) => [str(k, 20), dec(v, label, 0, max)]).filter(([k, v]) => k && v != null));
      out.takeoff = {
        ...(t.openingDeduct != null ? { openingDeduct: nums(t.openingDeduct, '개구부 공제 면적', 100) } : {}),
        ...(t.wallFinishHeight != null ? { wallFinishHeight: oneOf(t.wallFinishHeight, ['ceiling', 'slab'], '벽 마감 높이') } : {}),
        ...(t.waterproofUpturnMm != null ? { waterproofUpturnMm: nums(t.waterproofUpturnMm, '방수 치켜올림', 3000) } : {}),
        ...(t.slabColumnDeduct != null ? { slabColumnDeduct: t.slabColumnDeduct === true } : {}),
        ...(t.rebarVolumeDeduct != null ? { rebarVolumeDeduct: t.rebarVolumeDeduct === true } : {}),
        ...(t.rebarRatio != null ? { rebarRatio: dec(t.rebarRatio, '철근 부피 비율', 0, 0.2) } : {}),
        ...(t.lossRate != null ? { lossRate: nums(t.lossRate, '할증률', 1) } : {}),
      };
    }
  }
  if ('extra' in b) out.extra = obj(b.extra, '기타 설정', 20000);
  return out;
}
