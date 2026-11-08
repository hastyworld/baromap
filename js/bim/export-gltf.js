// glTF 내보내기(25 지시서 1절): 단지 전체 / 한 동 / 한 세대 타입을 .glb 하나로. three.js GLTFExporter(같은 버전).
// 재질은 질감 없이 이름으로 넘긴다("pbr:<재질 세트>", "glass", "color:#RRGGBB"). 블렌더 작업자가 이름으로 재질을 입힌다(27 지시서).
// 요소 id·재료 이름은 노드의 extras(userData)에. 단가·내역·협력사·수정 기록은 넣지 않는다.
import { textureFor } from './pbr.js';
import { buildSite } from './mesh-site.js';
import { buildFacadeMesh } from './mesh-facade.js';
import { buildBuilding } from './mesh-building.js';
import { buildUnit } from './mesh-unit.js';

const EX = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/';

// 이름 붙은 재질만 만드는 재료 모음(내보내기용)
function namedMats(T) {
  const cache = new Map();
  const make = (name, props) => {
    if (!cache.has(name)) { const m = new T.MeshStandardMaterial(props); m.name = name; cache.set(name, m); }
    return cache.get(name);
  };
  return {
    real: true,
    get: (color, o = {}) => make(`color:${color}`, { color, transparent: (o.opacity ?? 1) < 1, opacity: o.opacity ?? 1, side: o.double ? T.DoubleSide : T.FrontSide }),
    line: (color) => { const k = `line:${color}`; if (!cache.has(k)) cache.set(k, new T.LineBasicMaterial({ color })); return cache.get(k); },
    surface: (material, color, o = {}) => make(`pbr:${textureFor(material) || 'paint'}${color ? `|${color}` : ''}`, { color: color || '#ffffff', side: o.double ? T.DoubleSide : T.FrontSide }),
    glass: () => make('glass', { color: '#3d4e5c', metalness: 0.2, roughness: 0.05 }),
    dispose() { for (const m of cache.values()) m.dispose(); },
  };
}

/**
 * @param {any} T three
 * @param {{ scope: 'site'|'building'|'unit', ctx: any, shells?: Map }} o  ctx = 3D 보기의 장면 정보
 * @returns {Promise<Blob>}
 */
export async function exportGlb(T, { scope, ctx }) {
  const { GLTFExporter } = await import(`${EX}exporters/GLTFExporter.js/+esm`);
  const mats = namedMats(T);
  const root = new T.Group();
  root.name = '바로맵';
  root.rotation.x = -Math.PI / 2; // 모델(z 위) → glTF(y 위)
  let content;
  if (scope === 'site') {
    // 동은 자세한 외피로(멀리 보이는 덩어리는 빼고)
    const shells = new Map([...(ctx.shells || [])].map(([id, s]) => [id, { ...s, detail: () => {
      const g = new T.Group();
      g.name = s.building.name;
      g.userData = { id: s.building.id, kind: 'building' };
      g.add(buildFacadeMesh(T, mats, { ...s, catalog: ctx.catalog }).group);
      const t = s.building.transform;
      g.position.set(t.x, t.y, 0);
      g.rotation.z = (t.rotDeg * Math.PI) / 180;
      const w = new T.Group();
      w.add(g);
      return w;
    } }]));
    content = buildSite(T, mats, { site: ctx.site, shells, catalog: ctx.catalog }, { exportDetail: true }).group;
  } else if (scope === 'building') {
    content = buildBuilding(T, mats, { building: ctx.building, types: ctx.types, catalog: ctx.catalog }, { shell: true }).group;
  } else {
    content = buildUnit(T, mats, { type: ctx.type, catalog: ctx.catalog }, { height: ctx.height, layers: true }).group;
  }
  content.name = scope === 'site' ? '단지' : scope === 'building' ? ctx.building.name : ctx.type.name;
  root.add(content);
  // 선(치수·외곽선)은 렌더에 쓰지 않는다
  const lines = [];
  root.traverse((o) => { if (o.isLine || o.isLineSegments) lines.push(o); });
  for (const l of lines) l.parent.remove(l);
  const out = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });
  root.traverse((o) => o.geometry?.dispose());
  mats.dispose();
  return new Blob([out], { type: 'model/gltf-binary' });
}
