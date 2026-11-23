// 단면 자르기(06 4절, 42 지시서 3절): 수평(눈높이 1.2m 위를 잘라 위에서 보면 벽 층 구성 띠가 보인다)·수직(끌어서 위치 이동)·
// 상자(6면)·선(위에서 그은 선을 따라 세로로)·벽(누른 벽에 수직).
// three.js material.clippingPlanes. 평면은 화면(world) 좌표: 모델 z(위) = 화면 y, 모델 x = 화면 x, 모델 y = 화면 -z.
// 평면에서 거리(n·p + c)가 음수인 쪽이 잘린다. 자른 면은 mesh-unit.js가 같은 높이에 층 색 띠(cutCaps)를 깔아 채운다(수평만).
export const CUT_Z = 1.2;
export const CUT_LABEL = { '': '없음', h: `수평 ${CUT_Z}m`, v: '수직', box: '상자', line: '선 긋기', wall: '벽 단면' };

export function createClip(T) {
  const named = (p, name) => { p.name = name; return p; };
  const h = named(new T.Plane(new T.Vector3(0, -1, 0), CUT_Z), 'h'); // y > z 쪽을 자른다
  const v = named(new T.Plane(new T.Vector3(-1, 0, 0), 0), 'v'); // x > 위치 쪽을 자른다
  // 상자: 모델 [x0, y0, z0, x1, y1, z1] 안만 남긴다
  const box = [
    named(new T.Plane(new T.Vector3(1, 0, 0), 0), 'bx0'), named(new T.Plane(new T.Vector3(-1, 0, 0), 0), 'bx1'),
    named(new T.Plane(new T.Vector3(0, 0, -1), 0), 'by0'), named(new T.Plane(new T.Vector3(0, 0, 1), 0), 'by1'),
    named(new T.Plane(new T.Vector3(0, 1, 0), 0), 'bz0'), named(new T.Plane(new T.Vector3(0, -1, 0), 0), 'bz1'),
  ];
  const line = named(new T.Plane(new T.Vector3(1, 0, 0), 0), 'line'); // 임의 방향 세로 평면(선 긋기·벽 단면이 같이 쓴다)
  let boxNow = [0, 0, 0, 0, 0, 0];
  const of = (mode) => (mode === 'h' ? [h] : mode === 'v' ? [v] : mode === 'box' ? box : mode === 'line' || mode === 'wall' ? [line] : null);
  return {
    planes: of,
    setV(x) { v.constant = x; },
    get vx() { return v.constant; },
    /** 상자: 모델 좌표 [x0, y0, z0, x1, y1, z1] */
    setBox(b) {
      boxNow = [...b];
      box[0].constant = -b[0]; box[1].constant = b[3];
      box[2].constant = -b[1]; box[3].constant = b[4];
      box[4].constant = -b[2]; box[5].constant = b[5];
    },
    get box() { return boxNow; },
    /** 세로 평면: 모델 점 p를 지나고 모델 방향 n(단위 벡터, xy) 쪽을 남긴다 */
    setLine(p, n) {
      line.normal.set(n[0], 0, -n[1]);
      line.constant = -(p[0] * n[0] + p[1] * n[1]);
    },
    // 잘려 나간 쪽을 눌렀으면 고르지 않는다(광선은 자르기를 모른다). p: 화면(world) 좌표
    keeps(mode, p) { return (of(mode) || []).every((pl) => pl.distanceToPoint(p) >= -1e-3); },
  };
}
