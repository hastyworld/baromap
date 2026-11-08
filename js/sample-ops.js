// 현장 운영 가상 예시 기록(데모 모드). 협력사 이름은 가상, 사람은 인원 수만. day(n): 오늘에서 n일 뒤 날짜
const SITE = 's_sjg'; // 세종 6-4생활권 공동주택(가상 골구도가 있는 현장)

const COMPANIES = [
  { id: 'co_s1', name: '가상건설(주)', trades: ['철근', '거푸집'], sort: 1, memo: '사무실 대표 전화 044-000-1100' },
  { id: 'co_s2', name: '나무골조(주)', trades: ['콘크리트 타설', '양생·해체'], sort: 2, memo: '' },
  { id: 'co_s3', name: '바다방수(주)', trades: ['방수', '미장'], sort: 3, memo: '' },
  { id: 'co_s4', name: '하늘타일', trades: ['타일'], sort: 4, memo: '' },
  { id: 'co_s5', name: '구름창호(주)', trades: ['창호'], sort: 5, memo: '' },
];

const crew = (d, base) => [
  { companyId: 'co_s1', company: '가상건설(주)', trade: '철근', kind: 'partner', count: base + (d % 3), note: '' },
  { companyId: 'co_s1', company: '가상건설(주)', trade: '거푸집', kind: 'partner', count: base + 4 - (d % 2), note: '' },
  { companyId: 'co_s3', company: '바다방수(주)', trade: '방수', kind: 'partner', count: 6 + (d % 2), note: '' },
  { companyId: 'co_s4', company: '하늘타일', trade: '타일', kind: 'partner', count: 5, note: '' },
  { companyId: '', company: '직영', trade: '공무·공사', kind: 'staff', count: 9, note: '' },
];

const EQUIP = [
  { equipmentId: '', name: '타워크레인', spec: '10톤', count: 2, company: '가상건설(주)' },
  { equipmentId: '', name: '굴착기', spec: '0.6㎥', count: 1, company: '나무골조(주)' },
];

export function sampleOps(day) {
  // 근무일(일요일 제외) 지난 8일치 일보. 오늘은 비워 둔다([오늘 일보 쓰기] 시험용)
  const reports = [];
  for (let i = 1, n = 0; n < 8; i++) {
    const date = day(-i);
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
    n++;
    const approved = n > 2;
    reports.push({
      id: `dr_s${n}`, siteId: SITE, date,
      weather: { min: 5 + (n % 3), max: 14 + (n % 4), feelsMax: 13 + (n % 4), rainMm: 0, windMax: 3, sky: n % 3 ? '맑음' : '구름 많음', note: '' },
      manpower: crew(n, 12), equipment: EQUIP,
      work: [{ trade: '철근', area: '103동 10층', text: `철근 103동 ${8 + (n % 3)}층 6세대`, buildingId: 'b_s103', floors: '' }, { trade: '방수', area: '101동 3~5층', text: '방수 101동 3~5층 12세대', buildingId: 'b_s101', floors: '3~5층' }],
      progress: [], plan: [{ trade: '철근', area: '103동', text: '103동 다음 층 철근 배근', buildingId: 'b_s103', floors: '' }],
      safety: { accidents: 0, text: '' }, issues: '', files: [],
      status: approved ? 'approved' : n === 1 ? 'draft' : 'submitted',
      signs: n === 1 ? {} : { submitted: { name: '문서준', at: `${date}T08:40:00Z` }, ...(approved ? { approved: { name: '오성민', at: `${date}T09:10:00Z` } } : {}) },
      submittedBy: n === 1 ? null : 'sample', submittedAt: n === 1 ? '' : `${date}T08:40:00Z`, approvedBy: approved ? 'sample2' : null, approvedAt: approved ? `${date}T09:10:00Z` : '',
      returnNote: '', source: {},
    });
  }
  return {
    companies: COMPANIES.map((c) => ({ ...c, siteId: SITE, active: true })).concat([{ id: 'co_p1', siteId: 's_ptk', name: '가상설비(주)', trades: ['배관'], active: true, sort: 1, memo: '' }, { id: 'co_p2', siteId: 's_ptk', name: '나무전기', trades: ['배선'], active: true, sort: 2, memo: '' }, { id: 'co_p3', siteId: 's_ptk', name: '가상외장(주)', trades: ['외장'], active: true, sort: 3, memo: '' }]),
    dailyReports: reports.concat(Array.from({ length: 5 }, (_, i) => ({
      id: `dr_p${i + 1}`, siteId: 's_ptk', date: day(-(i + 1)), weather: {}, manpower: [{ companyId: 'co_p1', company: '가상설비(주)', trade: '배관', kind: 'partner', count: 8, note: '' }], equipment: [], work: [], progress: [], plan: [], safety: { accidents: 0, text: '' }, issues: '', files: [], status: 'approved', signs: {}, returnNote: '', source: {},
    }))),
  };
}
