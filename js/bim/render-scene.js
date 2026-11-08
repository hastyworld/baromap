// 사진 렌더 장면 설정(27 지시서 1·4절): 블렌더 작업자(render.py)가 읽는 JSON. 순수 함수 — 블렌더 없이 만들고 시험한다.
// 좌표는 glb와 같은 Y-위(three.js 화면 좌표)로 준다. 작업자가 블렌더(Z-위)로 바꾼다.
import { sunPosition, kstDate } from './sun.js';
import { PBR_SETS } from './pbr.js';

export const RENDER_PRESETS = {
  draft: { width: 1600, height: 900, samples: 64 },
  final: { width: 3840, height: 2160, samples: 512 },
  panorama: { width: 8192, height: 4096, samples: 384 },
};
export const RENDER_NOTE = (o) => `렌더 이미지 · 모델 v${o.modelVersion}${o.stateDate ? ` · 기준일 ${o.stateDate}` : ''} · 시공 참고용`;

// 0단계 최소판의 재질 8종(27 지시서 1절). 나머지는 가장 가까운 것으로
export const STAGE0_MATERIALS = ['paint', 'granite', 'concrete', 'metal', 'grass', 'asphalt', 'paving', 'ground'];

/** 사람 눈높이 시점 후보: 단지 남쪽 경계 가운데에서 단지 가운데를 본다(1.6m, 수직선 유지) */
export function eyeCamera(site, { base = 0 } = {}) {
  const b = site.boundary?.length ? site.boundary : [[-50, -50], [50, 50]];
  const xs = b.map((p) => p[0]);
  const ys = b.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const y0 = Math.min(...ys) - 6;
  return { kind: 'eye', pos: [cx, 1.6 - base, -y0], target: [cx, 18, -cy], lens: 24, shift: true };
}

/** 조감 시점: 남서쪽 위에서 */
export function aerialCamera(site) {
  const b = site.boundary?.length ? site.boundary : [[-50, -50], [50, 50]];
  const xs = b.map((p) => p[0]);
  const ys = b.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const r = Math.max(w, h);
  return { kind: 'aerial', pos: [cx - r * 0.55, r * 0.55, -(cy - r * 0.75)], target: [cx, 10, -cy], lens: 35, shift: false };
}

/**
 * @param {{ site: any, lat: number, lng: number, day: string, hour: number, camera?: any, quality?: 'draft'|'final'|'panorama',
 *           modelVersion: number, stateDate?: string|null, seed?: number, materials?: string[] }} o
 */
export function renderScene(o) {
  const preset = RENDER_PRESETS[o.quality || 'draft'];
  const sun = sunPosition(kstDate(o.day, o.hour), o.lat, o.lng);
  const mats = o.materials || Object.keys(PBR_SETS);
  return {
    schema: 'baromap-render/1',
    camera: o.camera || aerialCamera(o.site),
    panorama: o.quality === 'panorama',
    sun: { azimuth: Math.round(sun.azimuth * 10) / 10, altitude: Math.round(sun.altitude * 10) / 10, northDeg: o.site.northDeg || 0 },
    sky: { kind: 'physical', turbidity: 2.5 },
    output: { ...preset, format: 'PNG', toneMapping: 'AgX' },
    seed: o.seed ?? 1, // 같은 입력이면 같은 결과
    // glb의 재질 이름 "pbr:<이름>" → 재질 세트(작업자 PC의 assets/pbr/<이름>/)
    materials: Object.fromEntries(mats.map((k) => [k, { id: PBR_SETS[k]?.id || null, sizeM: PBR_SETS[k]?.sizeM || 1, rough: PBR_SETS[k]?.rough ?? 0.8, tint: Boolean(PBR_SETS[k]?.tint) }])),
    glass: { roomsBehind: true, lightsOnRatio: 0.15 },
    bevelMm: 6,
    note: RENDER_NOTE(o),
  };
}
