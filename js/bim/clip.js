// 단면 자르기(06 4절): 수평(눈높이 1.2m 위를 잘라 위에서 보면 벽 층 구성 띠가 보인다)·수직(끌어서 위치 이동).
// three.js material.clippingPlanes. 평면은 화면(world) 좌표: 모델 z(위) = 화면 y, 모델 x = 화면 x.
// 자른 면은 mesh-unit.js가 같은 높이에 층 색 띠(cutCaps)를 깔아 채운다(수평만).
export const CUT_Z = 1.2;

export function createClip(T) {
  const h = new T.Plane(new T.Vector3(0, -1, 0), CUT_Z); // y > z 쪽을 자른다
  h.name = 'h';
  const v = new T.Plane(new T.Vector3(-1, 0, 0), 0); // x > 위치 쪽을 자른다
  v.name = 'v';
  return {
    planes: (mode) => (mode === 'h' ? [h] : mode === 'v' ? [v] : null),
    setV(x) { v.constant = x; },
    get vx() { return v.constant; },
    // 잘려 나간 쪽을 눌렀으면 고르지 않는다(광선은 자르기를 모른다)
    keeps(mode, p) { return mode === 'h' ? p.y <= h.constant + 1e-3 : mode === 'v' ? p.x <= v.constant + 1e-3 : true; },
  };
}
