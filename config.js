// 바로맵 설정. 이 파일만 고치면 됩니다.
window.BAROMAP_CONFIG = {
  // ---- 지도
  // 카카오 JavaScript 키 (https://developers.kakao.com → 내 애플리케이션 → 앱 키)
  // 비워 두면 OpenStreetMap 데모 지도로 동작합니다.
  // 브라우저에 노출되는 키이므로, 카카오 콘솔에 사용할 도메인을 꼭 등록하세요.
  kakaoJsKey: '1880c6f1d3e34ffe7b00e3a148e33467',

  // ---- 공유 저장 (모든 사용자가 같은 데이터를 실시간으로 봄)
  // Supabase 프로젝트 → Project Settings → API 의 Project URL 과 anon public 키.
  // 비워 두면 데이터가 이 브라우저에만 저장되는 데모 모드로 동작합니다.
  // anon 키는 공개용 키입니다. 데이터는 로그인·권한(supabase/schema.sql의 RLS)으로 보호됩니다.
  supabaseUrl: 'https://qmliumbwcjxxduasyxsn.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtbGl1bWJ3Y2p4eGR1YXN5eHNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5MjAzNTksImV4cCI6MjEwODQ5NjM1OX0.GKysJPhn2qsZQqXiiypghHcQeCYTwjZRAPmbgjKFc0w',

  // 이메일 로그인 외에 켤 로그인 방식. 회사 Microsoft 365 계정: ['azure'] (Supabase에서 Azure 공급자를 켠 경우)
  authProviders: [],

  // ---- 화면
  serviceName: '바로맵',

  // 현장 주변 시설 검색 반경(m)과 종류 (카카오 장소 카테고리 코드)
  nearbyRadius: 2000,
  nearbyCategories: [
    { code: 'HP8', label: '병원' },
    { code: 'PM9', label: '약국' },
    { code: 'CS2', label: '편의점' },
  ],

  // 계약 만료 알림 기준(일)
  leaseAlertDays: 30,
};
