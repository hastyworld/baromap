// 재료 → 재질 세트(22 지시서 1절). 연결 규칙은 순수 함수(test/bim-pbr.test.js), 질감 불러오기는 three.js가 있을 때만.
// 재질은 assets/pbr/<이름>/{color,normal,rough}.webp(CC0, 출처 SOURCES.md). 질감은 실제 치수로 반복한다(모델 좌표가 m).
// 사람이 재료의 render.textureId로 바꿀 수 있고, 색(입면·색채계획도에서 읽은 값)은 틴트로 입힌다.

export const PBR_SETS = {
  concrete: { id: 'Concrete034', sizeM: 2, label: '콘크리트', rough: 0.9 },
  paint: { id: 'PaintedPlaster017', sizeM: 2, label: '수성페인트·미장', rough: 0.85, tint: true },
  granite: { id: 'Granite002A', sizeM: 1, label: '화강석', rough: 0.7 },
  brick: { id: 'Bricks106A', sizeM: 1.2, label: '벽돌', rough: 0.85 },
  tile: { id: 'Tiles139', sizeM: 1.2, label: '타일', rough: 0.4 },
  asphalt: { id: 'Asphalt031', sizeM: 4, label: '아스팔트', rough: 0.95 },
  paving: { id: 'PavingStones138', sizeM: 2, label: '보도블록', rough: 0.9, tint: true },
  grass: { id: 'Grass004', sizeM: 2, label: '잔디', rough: 1 },
  ground: { id: 'Ground037', sizeM: 3, label: '흙', rough: 1, tint: true },
  wood: { id: 'WoodFloor043', sizeM: 2, label: '마루·목재', rough: 0.6 },
  metal: { id: 'MetalPlates006', sizeM: 2, label: '금속패널', rough: 0.45, metal: 0.6, tint: true },
  marble: { id: 'Marble012', sizeM: 1, label: '대리석·인조석', rough: 0.3 },
};

// 위에서부터 먼저 맞는 것
const RULES = [
  [/화강석|석재|버너|석판/, 'granite'], [/대리석|인조석|테라조/, 'marble'], [/벽돌|조적|BRICK/i, 'brick'], [/타일|TILE/i, 'tile'],
  [/아스팔트|도로|차도/, 'asphalt'], [/보도블록|블록\s*포장|포장|고무칩|투수/, 'paving'], [/잔디|녹지|식재|조경/, 'grass'], [/흙|토사|지형|마사/, 'ground'],
  [/마루|목재|데크|WOOD/i, 'wood'], [/금속|알루미늄|AL\b|패널|난간|징크|METAL/i, 'metal'],
  [/콘크리트|노출|CONC|우레탄|방수/i, 'concrete'], [/페인트|도장|미장|스터코|외벽|PAINT/i, 'paint'],
];
const BY_CATEGORY = { structure: 'concrete', masonry: 'brick', plaster: 'paint', finish: 'paint', waterproof: 'concrete', other: 'paint' };

/** 재료(카탈로그 항목 또는 이름) → 재질 세트 이름(없으면 null) */
export function textureFor(m) {
  if (!m) return null;
  if (m.render?.textureId && PBR_SETS[m.render.textureId]) return m.render.textureId;
  const name = typeof m === 'string' ? m : m.name || '';
  for (const [re, key] of RULES) if (re.test(name)) return key;
  return typeof m === 'string' ? null : BY_CATEGORY[m.category] || null;
}

/** 한 장이 덮는 실제 크기(m) → 반복 비율 */
export const repeatOf = (key) => 1 / (PBR_SETS[key]?.sizeM || 1);

/** 벽 면 UV: 변을 따라 간 거리 s와 높이 z(m)를 그대로 쓴다 */
export const wallUv = (s, z) => [s, z];

export const pbrUrl = (key, map) => `assets/pbr/${key}/${map}.webp`;

/**
 * three.js 재질 만들기(보기 화면). 같은 세트·색은 한 번만 만든다.
 * @param {any} T three
 * @param {{ anisotropy?: number, base?: string }} o
 */
export function createPbr(T, { anisotropy = 4, base = '' } = {}) {
  const loader = new T.TextureLoader();
  const tex = new Map();
  const mats = new Map();
  const load = (key, map) => {
    const id = `${key}/${map}`;
    if (!tex.has(id)) {
      const t = loader.load(base + pbrUrl(key, map));
      t.wrapS = T.RepeatWrapping;
      t.wrapT = T.RepeatWrapping;
      t.anisotropy = anisotropy;
      if (map === 'color') t.colorSpace = T.SRGBColorSpace;
      t.repeat.set(repeatOf(key), repeatOf(key));
      tex.set(id, t);
    }
    return tex.get(id);
  };
  return {
    /** 재질: key(세트), color(틴트) */
    get(key, color = null, { double = false } = {}) {
      const set = PBR_SETS[key];
      const id = `${key}|${color}|${double}`;
      if (!mats.has(id)) {
        const m = new T.MeshStandardMaterial({
          map: set ? load(key, 'color') : null,
          normalMap: set ? load(key, 'normal') : null,
          roughnessMap: set ? load(key, 'rough') : null,
          roughness: set?.rough ?? 0.8,
          metalness: set?.metal ?? 0,
          color: new T.Color(set?.tint && color ? color : '#ffffff'),
          side: double ? T.DoubleSide : T.FrontSide,
          envMapIntensity: 0.3,
        });
        if (!set && color) m.color = new T.Color(color);
        mats.set(id, m);
      }
      return mats.get(id);
    },
    glass() {
      if (!mats.has('glass')) mats.set('glass', new T.MeshPhysicalMaterial({ color: '#3d4e5c', metalness: 0.2, roughness: 0.04, reflectivity: 0.7, clearcoat: 1, envMapIntensity: 0.9 }));
      return mats.get('glass');
    },
    dispose() { for (const t of tex.values()) t.dispose(); for (const m of mats.values()) m.dispose(); tex.clear(); mats.clear(); },
  };
}
