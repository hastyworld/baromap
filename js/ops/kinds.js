// 현장 운영 표 목록(다른 파일을 import하지 않는다). kind = 화면·저장소 이름, table = DB 표 이름.
//   prefix  id 앞글자   dates  빈 값이면 DB에 null로 넣는 날짜·시각 열   when  from·to로 거르는 날짜 열   parent  siteId 말고 부모로 거르는 열
//   order   목록 순서(열, 내림차순이면 desc)   del  'admin'이면 현장 담당은 못 지운다(이행 증거, 10 지시서 0절)
export const OPS_KINDS = {
  companies: { table: 'companies', prefix: 'co_', order: ['sort'], label: '협력사' },
  notices: { table: 'notices', prefix: 'nt_', order: ['createdAt', 'desc'], dates: ['startsAt', 'endsAt', 'resolvedAt'], label: '알림' },
  projectDocs: { table: 'project_docs', prefix: 'pd_', order: ['createdAt', 'desc'], dates: ['docDate'], label: '문서' },
  dailyReports: { table: 'daily_reports', prefix: 'dr_', order: ['date', 'desc'], when: 'date', del: 'admin', unique: ['siteId', 'date'], dates: ['submittedAt', 'reviewedAt', 'approvedAt'], label: '일보' },
  // v0.8 공정표(26·28 지시서). 활동은 판 하나에 수백 행이라 실시간 발행·변경 기록을 하지 않고 한꺼번에 넣는다(store.schedules)
  schedules: { table: 'schedules', prefix: 'sc_', order: ['version', 'desc'], dates: ['startDate', 'finishDate'], label: '공정표' },
  scheduleActivities: { table: 'schedule_activities', prefix: 'sa_', parent: 'scheduleId', order: ['sort'], dates: ['start', 'finish', 'baseStart', 'baseFinish', 'actualStart', 'actualFinish'], realtime: false, label: '공정 행' },
  // 회사 공종 사전(현장 구분 없음): 사람이 고친 짝을 쌓아 다음 현장에 쓴다
  scheduleDict: { table: 'schedule_dict', prefix: 'sd_', order: ['key'], company: true, label: '공종 사전' },
  // v1.0 내역서·단가(24 지시서). 단가·금액은 회사 기밀: secret이면 기기 안 임시 사본(오프라인 캐시)에 남기지 않는다.
  // siteId가 비어 있으면 회사 공통(내역서·연결 사전·시공 기준)
  costBooks: { table: 'cost_books', prefix: 'cb_', order: ['createdAt', 'desc'], realtime: false, secret: true, label: '내역서' },
  costItems: { table: 'cost_items', prefix: 'ci_', parent: 'bookId', order: ['sort'], realtime: false, secret: true, label: '내역 항목' },
  costLinks: { table: 'cost_links', prefix: 'cl_', order: ['createdAt'], realtime: false, secret: true, label: '내역 연결' },
  tradeAssignments: { table: 'trade_assignments', prefix: 'ta_', order: ['trade'], dates: ['from', 'to'], realtime: false, label: '공종 업체' },
  workStandards: { table: 'work_standards', prefix: 'ws_', order: ['code'], realtime: false, label: '시공 기준' },
  // 공공 정보(30 지시서 1~3절): 필지로 받은 건축인허가·건축물대장 값. 공유 모드에서는 public-data 함수가 넣는다
  publicRecords: { table: 'public_records', prefix: 'pr_', order: ['kind'], dates: ['fetchedAt'], unique: ['siteId', 'kind'], realtime: false, label: '공공 정보' },
};

export const OPS_TABLES = Object.values(OPS_KINDS).filter((k) => k.realtime !== false).map((k) => k.table);
export const kindOfTable = (table) => Object.keys(OPS_KINDS).find((k) => OPS_KINDS[k].table === table);

// 오프라인에서 새로 쓰거나 고칠 수 있는 기록(11 지시서 2-3절). 나머지는 연결돼 있어야 저장한다.
export const OFFLINE_KINDS = new Set(['dailyReports']);

// 저장 공간의 파일 종류별 폴더(경로 두 번째 칸)
export const FILE_FOLDERS = { dailyReports: 'daily' };
