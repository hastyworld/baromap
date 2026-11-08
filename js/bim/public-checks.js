// 도면 판독값 ↔ 정부 기록 대조(30 지시서 3절). 순수 함수. AI 없이 판독 오류를 잡는 가장 싼 방법이다.
// "위반" 판정을 하지 않는다: 어긋나면 "확인 필요"(warn·info)로 남기고, 어느 쪽이 맞는지는 사람이 본다.
import { polyArea } from './takeoff.js';
import { PUBLIC_SOURCES, PUBLIC_FINDING_LABEL } from '../ops/calc/public-data.js';

export { PUBLIC_FINDING_LABEL };
export const PUBLIC_TOLERANCE = { grossArea: 0.1, height: 1.0, siteArea: 0.03 };

const r1 = (v) => Math.round(v * 10) / 10;
const n = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
// 동 이름 맞추기: "101동"·"101"·"제101동" → "101", 그 밖은 공백·"동" 뺀 이름
export const dongKey = (name) => { const s = String(name || '').replace(/\s/g, ''); const m = /(\d{2,4})동?$/.exec(s.replace(/^제/, '')); return m ? m[1] : s.replace(/동$/, ''); };
const PARKING = /주차/;

/** 모델에서 대조할 값: 동(이름·지상·지하 층수·높이·세대), 세대수, 연면적(어림), 대지 경계 면적 */
export function modelPublicValues(files) {
  const idx = files['index.json'];
  const site = files['site.json'] || {};
  const buildings = [];
  let gross = 0;
  for (const bf of Object.values(idx?.files?.buildings || {})) {
    const b = files[bf];
    if (!b) continue;
    const sb = (site.buildings || []).find((x) => x.id === b.id) || {};
    const levels = b.levels || [];
    const above = levels.filter((l) => l.kind !== 'rooftop' && !/^B\d/i.test(l.name));
    const below = levels.filter((l) => /^B\d/i.test(l.name));
    const height = sb.height ?? Math.max(0, ...levels.map((l) => (l.elevation || 0) + (l.height || 0)));
    const area = polyArea(b.outline || []);
    const ph = (b.roof?.penthouses || []).reduce((s, p) => s + polyArea(p.polygon), 0);
    gross += area * (above.length + below.length) + ph;
    buildings.push({ id: b.id, name: b.name, kind: b.kind, key: dongKey(b.name), floorsAbove: sb.floorsAbove ?? above.length, floorsBelow: sb.floorsBelow ?? below.length, height: r1(height), units: (b.units || []).length, source: sb.source || null });
  }
  const underground = (site.underground || []).map((u) => ({ id: u.id, name: u.name || '지하주차장', levels: (u.levels || []).length, area: polyArea(u.polygon || []) }));
  for (const u of underground) gross += u.area * Math.max(1, u.levels);
  return {
    buildings,
    underground,
    units: buildings.reduce((s, b) => s + b.units, 0),
    grossArea: r1(gross),
    siteArea: site.boundary?.length >= 3 ? r1(polyArea(site.boundary)) : null,
    height: buildings.length ? Math.max(...buildings.map((b) => b.height)) : null,
  };
}

/**
 * 정부 기록(publicSummary) ↔ 모델 → bim_findings 항목(source 'public')
 * @param {Record<string, any>} files 모델 파일 @param {ReturnType<import('../ops/calc/public-data.js').publicSummary>} pub @param {Partial<typeof PUBLIC_TOLERANCE>} [tol]
 */
export function publicChecks(files, pub, tol = {}) {
  const T = { ...PUBLIC_TOLERANCE, ...tol };
  const out = [];
  if (!pub || pub.empty) return out; // 기록이 없으면(신축 전·키 없음) 건너뛴다
  const M = modelPublicValues(files);
  const v = pub.values || {};
  const src = (x) => (x ? `${x.source}(${String(x.fetchedAt || '').slice(0, 10)} 받음)` : '');
  const ev = (x, note) => [{ note: `${src(x)}${note ? ` · ${note}` : ''}`.slice(0, 300), source: 'public', kind: x?.kind || '' }];
  const add = (kind, severity, message, evidence, elementIds = []) => out.push({ kind, severity, message: `확인 필요: ${message}`, evidence, elementIds });

  // 동 수와 동별 층수(주건축물만, 지하주차장은 모델의 지하주차장과 맞춘다)
  const dongs = (pub.dongs || []).filter((d) => d.main !== false);
  if (dongs.length) {
    const d0 = dongs[0];
    const pubBld = dongs.filter((d) => !(PARKING.test(d.name) && !d.floorsAbove));
    const pubPark = dongs.filter((d) => PARKING.test(d.name) && !d.floorsAbove);
    const byKey = new Map(M.buildings.map((b) => [b.key, b]));
    const missing = pubBld.filter((d) => !byKey.has(dongKey(d.name)));
    const extra = M.buildings.filter((b) => !pubBld.some((d) => dongKey(d.name) === b.key));
    const parkGap = pubPark.length && !M.underground.length;
    if (missing.length || extra.length || parkGap) {
      const parts = [missing.length ? `정부 기록에만 있는 동: ${missing.map((d) => d.name).join(', ')}` : '', extra.length ? `모델에만 있는 동: ${extra.map((b) => b.name).join(', ')}` : '', parkGap ? '정부 기록의 지하주차장이 모델에 없음' : ''].filter(Boolean);
      add('pub_building_count', 'warn', `동 수가 다릅니다(정부 기록 ${pubBld.length + pubPark.length}개, 모델 ${M.buildings.length + M.underground.length}개). ${parts.join(' / ')}. 도면 묶음에 빠진 동이 있는지, 이름이 다르게 적혔는지 보세요.`, ev(d0), extra.map((b) => b.id));
    }
    for (const d of pubBld) {
      const b = byKey.get(dongKey(d.name));
      if (!b) continue;
      if (d.floorsAbove != null && d.floorsAbove !== b.floorsAbove) add('pub_floors', 'warn', `${b.name} 지상 층수: 정부 기록 ${d.floorsAbove}층, 모델 ${b.floorsAbove}층.`, ev(d, `${d.name} 지상 ${d.floorsAbove}층`), [b.id]);
      if (d.floorsBelow != null && d.floorsBelow > 0 && b.floorsBelow > 0 && d.floorsBelow !== b.floorsBelow) add('pub_floors', 'info', `${b.name} 지하 층수: 정부 기록 ${d.floorsBelow}층, 모델 ${b.floorsBelow}층.`, ev(d), [b.id]);
      if (d.height != null && Math.abs(d.height - b.height) > T.height) add('pub_height', 'warn', `${b.name} 높이: 정부 기록 ${n(d.height)}m, 모델 ${n(b.height)}m(차이 ${n(Math.abs(d.height - b.height))}m). 옥탑 포함 여부와 기준 지반을 확인하세요.`, ev(d), [b.id]);
    }
  }
  // 세대수
  if (v.households && M.units && v.households.value !== M.units) add('pub_units', 'warn', `세대수: 정부 기록 ${v.households.value}세대, 모델 ${M.units}세대.`, ev(v.households));
  // 연면적(어림 계산이라 설정값보다 크게 다를 때만)
  if (v.grossArea && M.grossArea) {
    const d = (M.grossArea - v.grossArea.value) / v.grossArea.value;
    if (Math.abs(d) > T.grossArea) add('pub_gross_area', 'info', `연면적: 정부 기록 ${n(v.grossArea.value)}㎡, 모델 어림 ${n(M.grossArea)}㎡(${d > 0 ? '+' : ''}${Math.round(d * 1000) / 10}%). 모델 값은 외곽 면적 × 층 수의 어림이라 발코니·필로티 산입 기준에 따라 달라집니다.`, ev(v.grossArea));
  }
  // 최고 높이(동별 기록이 없을 때만 전체로)
  if (!dongs.some((d) => d.height != null) && v.height && M.height != null && Math.abs(v.height.value - M.height) > T.height) add('pub_height', 'warn', `최고 높이: 정부 기록 ${n(v.height.value)}m, 모델 ${n(M.height)}m.`, ev(v.height));
  // 대지면적 대 대지 경계 면적
  if (v.siteArea && M.siteArea) {
    const d = (M.siteArea - v.siteArea.value) / v.siteArea.value;
    if (Math.abs(d) > T.siteArea) add('pub_site_area', 'warn', `대지면적: 정부 기록 ${n(v.siteArea.value)}㎡, 배치도 대지 경계 ${n(M.siteArea)}㎡(${d > 0 ? '+' : ''}${Math.round(d * 1000) / 10}%). 대지 경계선이나 도면 축척을 확인하세요.`, ev(v.siteArea));
  }
  return out;
}

export const publicSourceLabel = (kind) => PUBLIC_SOURCES[kind]?.label || kind;
