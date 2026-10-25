// 처음 실행 시 보여주는 가상 예시 데이터. 실존 인물·연락처가 아니다(연락처는 개통되지 않는 010-0000 대역).
import { todayStr } from './model.js';

export function sampleData(now = new Date()) {
  const day = (offset) => todayStr(new Date(now.getTime() + offset * 864e5));

  const sites = [
    {
      id: 's_ptk', name: '평택 고덕 지원시설 신축공사', address: '경기도 평택시 고덕면 여염리 일원', lat: 37.0233, lng: 127.0478,
      client: '고덕산단개발(주)', startDate: day(-420), endDate: day(310), manager: '정태호 부장', phone: '031-000-1200',
      overview: '지하 2층 / 지상 7층 업무지원동 2개동\n연면적 48,200㎡ · 철골철근콘크리트조\n주요 공정: 골조 완료, 외장·설비 공사 진행 중',
      memo: '출입: 남측 2번 게이트, 07:00 TBM',
    },
    {
      id: 's_sjg', name: '세종 6-4생활권 공동주택 신축공사', address: '세종특별자치시 해밀동 일원', lat: 36.529, lng: 127.27,
      client: '세종도시주택공사', startDate: day(-600), endDate: day(140), manager: '오성민 부장', phone: '044-000-3400',
      overview: '공동주택 12개동 1,086세대 (지하 2층 / 지상 25층)\n주요 공정: 마감·조경, 입주 전 점검 준비', memo: '',
    },
    {
      id: 's_bsn', name: '부산 에코델타시티 C블록 공동주택', address: '부산광역시 강서구 강동동 일원', lat: 35.1305, lng: 128.925,
      client: '에코델타개발(주)', startDate: day(35), endDate: day(1100), manager: '한동욱 차장', phone: '051-000-5600',
      overview: '착공 준비 중 (가설사무실 설치, 측량)\n선발대 3명 상주, 착공 후 15명 추가 투입 예정', memo: '숙소 추가 확보 필요',
    },
  ];

  const lodgings = [
    { id: 'l_pt1', siteId: 's_ptk', name: '고덕 센트럴오피스텔', address: '경기도 평택시 고덕동 일원', addressDetail: '1203호', lat: 37.0455, lng: 127.0472, type: '오피스텔', capacity: 3, leaseEnd: day(18), memo: '도어락 비밀번호는 공무 담당에게 문의' },
    { id: 'l_pt2', siteId: 's_ptk', name: '서정동 그린아파트', address: '경기도 평택시 서정동 일원', addressDetail: '104동 802호', lat: 37.059, lng: 127.056, type: '아파트', capacity: 4, leaseEnd: day(165), memo: '' },
    { id: 'l_pt3', siteId: 's_ptk', name: '지산동 원룸 A동', address: '경기도 평택시 지산동 일원', addressDetail: '201·202호', lat: 37.079, lng: 127.059, type: '원룸', capacity: 2, leaseEnd: day(275), memo: '원룸 2실 일괄 계약' },
    { id: 'l_pt4', siteId: 's_ptk', name: '평택역 비즈니스텔', address: '경기도 평택시 평택동 일원', addressDetail: '', lat: 36.991, lng: 127.086, type: '숙박업소', capacity: 2, leaseEnd: day(50), memo: '월 단위 장기투숙' },
    { id: 'l_pt5', siteId: 's_ptk', name: '안중 협력사 숙소', address: '경기도 평택시 안중읍 일원', addressDetail: '', lat: 36.987, lng: 126.929, type: '주택', capacity: 3, leaseEnd: day(-5), memo: '계약 만료 — 연장 협의 중' },
    { id: 'l_sj1', siteId: 's_sjg', name: '해밀마을 아파트 3단지', address: '세종특별자치시 해밀동 일원', addressDetail: '305동 1101호', lat: 36.526, lng: 127.265, type: '아파트', capacity: 4, leaseEnd: day(230), memo: '' },
    { id: 'l_sj2', siteId: 's_sjg', name: '고운동 스테이 오피스텔', address: '세종특별자치시 고운동 일원', addressDetail: '715호', lat: 36.515, lng: 127.234, type: '오피스텔', capacity: 2, leaseEnd: day(27), memo: '' },
    { id: 'l_sj3', siteId: 's_sjg', name: '조치원 원룸', address: '세종특별자치시 조치원읍 일원', addressDetail: '302호', lat: 36.603, lng: 127.298, type: '원룸', capacity: 1, leaseEnd: day(410), memo: '현장까지 차량 필수' },
    { id: 'l_bs1', siteId: 's_bsn', name: '명지 오션오피스텔', address: '부산광역시 강서구 명지동 일원', addressDetail: '1508호', lat: 35.092, lng: 128.905, type: '오피스텔', capacity: 3, leaseEnd: day(345), memo: '선발대 숙소' },
  ];

  // [이름, 직급, 직책, 소속·공종, 숙소]
  const people = [
    ['정태호', '부장', '현장소장', '건축', 'l_pt2'],
    ['이준혁', '과장', '공무팀장', '공무', 'l_pt2'],
    ['김도윤', '과장', '공사팀장', '건축', 'l_pt2'],
    ['박서연', '대리', '공무', '공무', 'l_pt1'],
    ['최민재', '대리', '공사', '건축', 'l_pt1'],
    ['강하준', '주임', '안전관리자', '안전', 'l_pt1'],
    ['조은우', '사원', '품질관리자', '품질', 'l_pt3'],
    ['윤지호', '사원', '공사', '기계설비', 'l_pt3'],
    ['임시우', '대리', '공사', '전기', 'l_pt4'],
    ['한유진', '차장', '공사팀장', '토목', 'l_pt4'],
    ['송현우', '반장', '반장', '협력사(골조)', 'l_pt5'],
    ['오승민', '기능공', '', '협력사(골조)', 'l_pt5'],
    ['신동현', '기능공', '', '협력사(골조)', 'l_pt5'],
    ['노은서', '사원', '공무', '공무', 'l_pt5'],
    ['오성민', '부장', '현장소장', '건축', 'l_sj1'],
    ['황지민', '과장', '공무팀장', '공무', 'l_sj1'],
    ['문서준', '대리', '공사', '건축', 'l_sj1'],
    ['양하은', '주임', '안전관리자', '안전', 'l_sj2'],
    ['배준서', '사원', '품질관리자', '품질', 'l_sj2'],
    ['권태윤', '대리', '공사', '조경', 'l_sj3'],
    ['한동욱', '차장', '현장소장', '건축', 'l_bs1'],
    ['유재원', '대리', '공무', '공무', 'l_bs1'],
    ['서지훈', '사원', '공사', '측량', 'l_bs1'],
  ];
  const residents = people.map(([name, rank, title, dept, lodgingId], i) => ({
    id: `r_${String(i + 1).padStart(2, '0')}`,
    lodgingId, name, rank, title, dept,
    phone: `010-0000-${String(1001 + i)}`,
    moveIn: day(-((i * 37) % 300) - 10),
    memo: '',
  }));

  return { sites, lodgings, residents };
}
