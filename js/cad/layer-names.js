// 레이어 이름 사전(규칙 모드): 한국 건축 도면에서 흔한 레이어 이름 → 쓰임새(LayerRole, js/bim/ai-schemas.js).
// 위에서부터 먼저 맞는 규칙을 쓴다. 실제 도서에서 틀린 것이 나오면 여기에 덧붙인다(08 4절).

export const LAYER_RULES = [
  [/(TTLB|TITLE|도곽|FRAME|BORDER|표제)/i, 'frame'],
  [/(DIM|치수)/i, 'dimension'],
  [/(GRID|그리드|중심선|통심|AXIS|CEN(TER)?L)/i, 'grid'],
  [/(WALL|벽).*(PATT|HATCH|HTCH|해치|PAT)/i, 'wall_hatch'],
  [/(WALL|벽).*(IDEN|TAG|기호|SYM|NO\b)/i, 'wall_tag'],
  [/(DOOR|문).*(IDEN|TAG|기호|NO\b)/i, 'door_tag'],
  [/(GLAZ|WIN|창).*(IDEN|TAG|기호|NO\b)/i, 'window_tag'],
  [/(FINI|FNSH|마감).*(IDEN|TAG|기호)|마감기호/i, 'finish_tag'],
  [/(AREA|ROOM|실).*(IDEN|NAME|명)|^실명|ROOM[-_]?NAME/i, 'room_name'],
  [/(AREA|면적)/i, 'room_area'],
  [/(UNIT|세대|호수).*(IDEN|NO\b|명|라인|BNDY|경계)|세대명|세대경계/i, 'unit_label'],
  [/(BLDG|동).*(IDEN|NAME|명)/i, 'building_label'],
  [/(BLDG|건물|동).*(OTLN|외곽|OUT)/i, 'building_outline'],
  [/(PROP|대지|부지|BNDY|BOUNDARY)/i, 'site_boundary'],
  [/(ELEV|입면).*(PATT|HTCH|MATL|재료)/i, 'facade_zone'],
  [/(ROOF|지붕).*(PH|옥탑)|옥탑/i, 'penthouse'],
  [/(ROOF|지붕).*(OTLN|외곽)/i, 'roof_outline'],
  [/(TOPO|표고|지형).*(SPOT|점)|점표고/i, 'spot_level'],
  [/(TOPO|등고|CONT)/i, 'contour'],
  [/(PAVE|포장)/i, 'paving'],
  [/(^|[-_])(TREE|수목)/i, 'tree'],
  [/(SITE|시설).*(FEAT|시설물)|시설물/i, 'site_feature'],
  [/(ROAD|도로)/i, 'road'],
  [/(PLNT|조경|LAND|식재|녹지)/i, 'landscape'],
  [/(PARK|주차).*(UG|지하)|지하주차/i, 'underground'],
  [/(LEVL|LEVEL|레벨)/i, 'level_mark'],
  [/(CURT|커튼)/i, 'curtain_wall'],
  [/(GLAZ|WIN|창호|유리|^창)/i, 'window'],
  [/(DOOR|^문$|^문[-_ ]|문틀|출입문)/i, 'door'],
  [/(COL|기둥)/i, 'column'],
  [/(STAIR|STRS|계단)/i, 'stair'],
  [/(ELEV|승강기|\bEV\b)/i, 'elevator'],
  [/(INSU|단열)/i, 'insulation'],
  [/(BLOCK|BRICK|조적|블록|벽돌)/i, 'masonry'],
  [/(WTPR|WATER|방수)/i, 'waterproof'],
  [/(FURN|가구|위생|SANI)/i, 'furniture'],
  [/(SLAB|FLOR|슬래브)/i, 'slab_edge'],
  [/(WALL|벽|CONC|콘크리트|PARTITION|경량)/i, 'wall'],
  [/(TEXT|TXT|ANNO|NOTE|문자|글자|SYMB|기호|LEADER|인출|TABL)/i, 'annotation'],
  [/^(0|DEFPOINTS)$/i, 'ignore'],
];

/** @returns {{ role: string, confidence: number }} */
export function guessRole(name) {
  const s = String(name || '');
  for (const [re, role] of LAYER_RULES) if (re.test(s)) return { role, confidence: role === 'ignore' ? 0.5 : 0.6 };
  return { role: 'ignore', confidence: 0.2 };
}

// 시트 요약의 레이어 목록 → { 레이어: 쓰임새 }. 이전 도서에서 확정한 쓰임새(profile)가 있으면 그것을 먼저(08 4절)
export function layerRolesFor(layers, profile = {}) {
  const out = {};
  for (const l of layers || []) {
    const name = typeof l === 'string' ? l : l.name;
    out[name] = profile[name] || guessRole(name).role;
  }
  return out;
}
