// 3D 재료(색·투명도·단면). 재료 분류별 색은 js/bim/materials-ko.js와 같은 규칙.
import { CATEGORY_COLOR } from './materials-ko.js';
import { textureFor } from './pbr.js';

export const USE_COLOR = { living: '#F3E3C3', bedroom: '#DCE8F7', kitchen: '#F7E1D2', bath: '#CFE8F2', balcony: '#E3E8DD', dress: '#EDE0F2', utility: '#E5E5E5', hall: '#EFEBE3', other: '#E9E9E9' };
export const ZONE_COLOR = { waterproof: '#2F7FEA', insulation: '#E8C547', soundproof: '#8E6FD8', fireproof: '#E5484D' };
export const ZONE_LABEL = { waterproof: '방수', insulation: '단열', soundproof: '차음', fireproof: '내화' };
export const TYPE_COLORS = ['#7FA7D9', '#86C5A4', '#E3B27A', '#C59AD8', '#E59393', '#8FCAD1'];
export const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
export const BG = () => (dark() ? '#10141c' : '#EEF1F5');

export function colorOf(group, materialsById) {
  const m = group.materialId ? materialsById.get(group.materialId) : null;
  return m?.color || CATEGORY_COLOR[group.category] || '#CCCCCC';
}

/**
 * three.js 재료 만들기(재사용 캐시). opts: { opacity, side, clip(평면 목록), flat }
 */
export function makeMaterials(T) {
  const cache = new Map();
  return {
    get(color, { opacity = 1, double = false, clip = null, depthWrite = true, emissive = null } = {}) {
      const key = `${color}|${opacity}|${double}|${clip ? clip.map((p) => p.name || '').join(',') : ''}|${depthWrite}|${emissive}`;
      if (!cache.has(key)) {
        const m = new T.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, transparent: opacity < 1, opacity, side: double ? T.DoubleSide : T.FrontSide, depthWrite: opacity < 1 ? false : depthWrite });
        if (clip) m.clippingPlanes = clip;
        if (emissive) m.emissive = new T.Color(emissive);
        cache.set(key, m);
      }
      return cache.get(key);
    },
    line(color, opacity = 1) {
      const key = `L|${color}|${opacity}`;
      if (!cache.has(key)) cache.set(key, new T.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
      return cache.get(key);
    },
    real: null, // 실물 보기의 재질 모음(createPbr). 없으면 색만
    /** 재료가 있는 면(외벽·지형·포장): 실물 보기면 재질, 아니면 색 */
    surface(material, color, o = {}) {
      return this.real ? this.real.get(textureFor(material) || 'paint', color, o) : this.get(color, o);
    },
    glass(color) { return this.real ? this.real.glass() : this.get(color); },
    dispose() { for (const m of cache.values()) m.dispose(); cache.clear(); },
  };
}
