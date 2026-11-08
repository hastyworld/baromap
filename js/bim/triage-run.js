// 판별 다시 돌리기·색칠 그림(브라우저). 규칙 판별은 시트를 읽을 때 워커가 했고, AI가 레이어 쓰임새를 고친 뒤나 사람이 고친 뒤 여기서 다시 한다.
import { store } from '../ctx.js';
import { unpackSheet } from '../cad/flatten.js';
import { imageInfo, drawItems, FULL_SIDE } from '../cad/render.js';
import { triageSheet, carryHuman, itemVerdict, profileFrom } from '../cad/triage.js';

export const OVERLAY = { keep: '#111111', drop: '#E03131', unknown: '#E6A700' };

// 색칠 그림: 살린 선 검정, 버린 선 빨강, 모름 노랑(19 3-3절)
export async function overlayBlob(flat, t) {
  const info = imageInfo(flat.frame, FULL_SIDE);
  const canvas = new OffscreenCanvas(info.width, info.height);
  const verdicts = flat.items.map((_, i) => itemVerdict(t, flat.items, i));
  const byItem = new Map(flat.items.map((it, i) => [it, verdicts[i]]));
  drawItems(canvas.getContext('2d'), flat.items, info, {
    tint: (it) => {
      const v = byItem.get(it);
      if (!v) return OVERLAY.drop;
      return v.cls === 'building' ? OVERLAY.keep : v.cls === 'unknown' ? OVERLAY.unknown : OVERLAY.drop;
    },
  });
  return canvas.convertToBlob({ type: 'image/png' });
}

// AI가 쓰임새·종류를 고친 뒤: 규칙 판별을 다시 하고 사람 판정은 이어받는다
export async function retriage(sheet, { profile = {} } = {}) {
  const [geom, digest, prev] = await Promise.all([
    store.drawings.sheetAsset(sheet, 'geom'),
    store.drawings.sheetAsset(sheet, 'digest'),
    store.drawings.sheetAsset(sheet, 'triage', { fresh: true }).catch(() => null),
  ]);
  const flat = unpackSheet(geom);
  const next = carryHuman(prev, triageSheet(flat, { layerRoles: sheet.layerRoles, uf: sheet.meta?.unitM || 0.001, tables: digest?.tables || [], category: sheet.category, profile }));
  await store.drawings.saveTriage(sheet, next);
  await store.drawings.saveOverlay(sheet, await overlayBlob(flat, next));
  return next;
}

// 2회째 확인 전에 색칠 그림만 새로
export async function refreshOverlay(sheet) {
  const [geom, t] = await Promise.all([store.drawings.sheetAsset(sheet, 'geom'), store.drawings.sheetAsset(sheet, 'triage', { fresh: true })]);
  if (t) await store.drawings.saveOverlay(sheet, await overlayBlob(unpackSheet(geom), t));
}

// 사람이 고친 판정을 이 현장 기억에 쌓는다(다음 도서의 기본값)
export async function rememberTriage(sheet, t) {
  const sets = store.drawings.cached(sheet.siteId) || await store.drawings.sets(sheet.siteId);
  const set = sets.find((s) => s.id === sheet.setId);
  if (set) await store.drawings.updateSet(set.id, { stats: { ...(set.stats || {}), triageProfile: profileFrom(t, set.stats?.triageProfile || {}) } });
}
