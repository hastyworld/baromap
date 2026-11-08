// 도면·문서 대조(20 지시서 6절). 규칙 검사에 문서를 더한다. 결정적·무료. 순수 함수.
// 기준값은 코드에 고정하지 않는다(ops_settings.standards). 비어 있으면 기준 검사는 하지 않고, 판단은 참고다.
import { modelOpenings, FIELD_LABEL, showValue } from './doc-apply.js';
import { normGlass } from './doc-core.js';
import { scopeText } from './detail-keys.js';

export const DOC_FINDING_LABEL = {
  doc_window_missing: '성능표 창호 누락', doc_size_mismatch: '창호 규격 차이', doc_glass_mismatch: '유리 표기 차이', doc_finish_mismatch: '마감재 차이',
  doc_type_gap: '타입 정보 없음', perf_below_standard: '성능 기준 초과', doc_value_conflict: '문서끼리 다른 값', spec_value_mismatch: '시방서·기준과 상세 값 차이',
};

const ev = (doc, it, note = '') => ({ docId: doc.id, docName: doc.name, page: it?.page ?? null, ...(it?.box ? { box: it.box } : {}), note });
const evSrc = (src) => (src?.sheets || []).filter((s) => s.sheetId).slice(0, 2).map((s) => ({ sheetId: s.sheetId, bbox: s.bbox || null, note: '' }));
const norm = (s) => String(s ?? '').replace(/[\s·/]/g, '').toLowerCase();

const WINDOW_DOCS = new Set(['window_performance', 'window_schedule', 'glass_spec']);
const COMPARE = ['perf.uWindow', 'perf.uGlass', 'perf.shgc', 'perf.watertight', 'perf.windPressure', 'perf.sound', 'perf.efficiencyGrade', 'perf.fire', 'frame.material', 'frame.opening'];
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

/**
 * @param {{ files: Record<string, any>, docs: any[], standards?: any, climateZone?: string }} input
 * @returns {Array<{ kind, severity, message, evidence, elementIds }>}
 */
export function docChecks({ files, docs, standards = null, climateZone = '' }) {
  const out = [];
  const add = (kind, severity, message, evidence = [], elementIds = []) => out.push({ kind, severity, message, evidence: evidence.slice(0, 50), elementIds: [...new Set(elementIds)].slice(0, 2000) });
  const read = docs.filter((d) => d.extracted);
  const perfDocs = read.filter((d) => WINDOW_DOCS.has(d.kind) && d.extracted.windows?.length);
  const used = modelOpenings(files);
  const by = new Map();
  for (const doc of perfDocs) for (const it of doc.extracted.windows) { if (!by.has(it.code)) by.set(it.code, []); by.get(it.code).push({ doc, it }); }

  if (perfDocs.some((d) => d.kind === 'window_performance' || d.kind === 'window_schedule')) {
    // 창만 본다(문은 성능표 밖인 경우가 많다). 표에 문 기호가 있으면 문도 본다
    const doorsListed = [...by.values()].some((c) => c[0].it.kind === 'door');
    for (const [code, u] of used) {
      if (by.has(code) || (u.kind !== 'window' && !doorsListed)) continue;
      add('doc_window_missing', 'warn', `도면의 창호 기호 ${code}(${u.openings.length}곳)가 성능표에 없습니다.`, u.openings.flatMap((o) => evSrc(o.source)).slice(0, 3), u.openings.map((o) => o.id));
    }
    for (const [code, c] of by) if (!used.has(code)) add('doc_window_missing', 'warn', `성능표의 창호 기호 ${code}가 도면에 없습니다.`, [ev(c[0].doc, c[0].it, code)]);
  }

  for (const [code, cands] of by) {
    const u = used.get(code);
    // 규격: 도면과 문서
    for (const { doc, it } of cands) {
      if (!it.sizeMm || !u) continue;
      const diff = u.openings.filter((o) => Math.abs(o.w - it.sizeMm.w) > 10 || Math.abs(o.h - it.sizeMm.h) > 10);
      if (diff.length) add('doc_size_mismatch', 'error', `${code} 규격이 다릅니다: 문서 ${it.sizeMm.w}×${it.sizeMm.h}mm, 도면 ${[...new Set(diff.map((o) => `${o.w}×${o.h}`))].join('·')}mm(${diff.length}곳).`, [ev(doc, it, `${code} ${it.sizeMm.w}×${it.sizeMm.h}`), ...diff.flatMap((o) => evSrc(o.source)).slice(0, 2)], diff.map((o) => o.id));
    }
    // 유리 표기: 문서끼리
    const glass = cands.filter((c) => c.it.glass?.notation);
    if (new Set(glass.map((c) => normGlass(c.it.glass.notation))).size > 1) add('doc_glass_mismatch', 'error', `${code} 유리 표기가 문서마다 다릅니다: ${glass.map((c) => `${c.doc.name} ${c.it.glass.notation}`).join(', ')}.`, glass.map((c) => ev(c.doc, c.it, c.it.glass.notation)));
    // 그 밖의 값: 문서끼리
    for (const path of COMPARE) {
      const vals = cands.filter((c) => get(c.it, path) != null);
      if (new Set(vals.map((c) => String(get(c.it, path)))).size > 1) add('doc_value_conflict', 'error', `${code} ${FIELD_LABEL[path]} 값이 문서마다 다릅니다: ${vals.map((c) => `${c.doc.name} ${showValue(get(c.it, path))}`).join(', ')}.`, vals.map((c) => ev(c.doc, c.it, showValue(get(c.it, path)))));
    }
    // 적용 타입: 표에 적힌 타입 말고 다른 타입에도 쓰임
    const applies = [...new Set(cands.flatMap((c) => c.it.appliesTo?.unitTypes || []))];
    if (applies.length && u) {
      const gap = [...u.types].filter((t) => !t.includes('공용부') && !applies.some((a) => norm(a) === norm(t)));
      if (gap.length) add('doc_type_gap', 'info', `${code}는 도면에서 ${gap.join(', ')}에도 쓰이는데 문서의 적용 타입(${applies.join(', ')})에 없습니다.`, [ev(cands[0].doc, cands[0].it, code)]);
    }
    // 성능 기준(참고)
    const limit = standards?.window?.[climateZone]?.direct;
    if (limit != null) {
      for (const { doc, it } of cands) {
        const v = it.perf?.uWindow;
        if (v != null && v > limit) add('perf_below_standard', 'warn', `${code} 창세트 열관류율 ${v} W/㎡K가 기준 ${limit} W/㎡K(${climateZone}, 외기 직접)를 넘습니다. 참고값이니 설계자 확인이 필요합니다.`, [ev(doc, it, `${v} W/㎡K`)], u?.openings.map((o) => o.id) || []);
      }
    }
  }

  // 마감: 리스트와 모델(= 마감표) 대조, 타입 빠짐
  const lists = read.filter((d) => d.extracted.finishes?.length);
  if (lists.length) {
    const cat = files['catalog.json'] || { materials: [], assemblies: [] };
    const mats = new Map(cat.materials.map((m) => [m.id, m]));
    const asm = new Map(cat.assemblies.map((a) => [a.id, a]));
    const types = Object.entries(files).filter(([k, t]) => k.startsWith('u-') && t.kind === 'unit').map(([, t]) => t);
    const covered = new Set();
    const seen = new Set();
    for (const doc of lists) {
      for (const it of doc.extracted.finishes) {
        for (const t of types.filter((x) => !it.unitType || norm(x.name) === norm(it.unitType))) {
          if (it.unitType) covered.add(t.name);
          const sp = t.spaces.find((s) => norm(s.name) === norm(it.room));
          if (!sp) continue;
          for (const part of ['floor', 'wall', 'ceiling']) {
            if (!it[part]) continue;
            const names = (asm.get(sp.finish?.[part])?.layers || []).map((l) => mats.get(l.materialId)?.name).filter(Boolean);
            if (!names.length || names.some((n) => norm(it[part]).includes(norm(n)) || norm(n).includes(norm(it[part])))) continue;
            const key = `${t.name}|${sp.name}|${part}`;
            if (seen.has(key)) continue;
            seen.add(key);
            add('doc_finish_mismatch', 'warn', `${t.name} ${sp.name} ${FIELD_LABEL[part]} 마감이 다릅니다: 리스트 ${it[part]}, 마감표 ${names.join('+')}.`, [ev(doc, it, it[part]), ...evSrc(sp.source)], [sp.id]);
          }
        }
      }
    }
    // 공통 줄(타입 없음)만 있으면 모든 타입이 덮인다
    const anyCommon = lists.some((d) => d.extracted.finishes.some((f) => !f.unitType));
    if (!anyCommon) for (const t of types) if (!covered.has(t.name)) add('doc_type_gap', 'info', `${t.name} 타입의 마감 정보가 마감재 리스트에 없습니다.`, [ev(lists[0], null, t.name)]);
  }

  // 시방서·회사 시공기준의 숫자 요구 ↔ 모델 상세 값(39 지시서 3절)
  const details = (files['catalog.json']?.details || []).filter((d) => typeof d.value === 'number');
  const overlap = (a = {}, b = {}) => {
    const has = (o) => ['typeCodes', 'rooms', 'zones'].some((k) => o[k]?.length);
    if (!has(a) || !has(b)) return !has(a) || !has(b) ? true : false;
    return ['typeCodes', 'rooms', 'zones'].some((k) => (a[k] || []).some((x) => (b[k] || []).includes(x)));
  };
  const bad = (op, v, need) => (op === '>=' ? v < need : op === '<=' ? v > need : op === '>' ? v <= need : op === '<' ? v >= need : v !== need);
  const OPK = { '>=': '이상', '<=': '이하', '>': '초과', '<': '미만', '=': '' };
  const seenReq = new Set();
  for (const doc of read.filter((d) => ['spec', 'company_std'].includes(d.kind) && d.extracted.requirements?.length)) {
    for (const rq of doc.extracted.requirements) {
      for (const v of rq.values || []) {
        if (!v.key || v.key === 'other' || v.unit !== 'mm') continue;
        // 요구에 적용 범위가 있으면 그 범위의 상세 값만, 없으면 모두
        const hits = details.filter((d) => d.key === v.key && (!['typeCodes', 'rooms', 'zones'].some((k) => rq.appliesTo?.[k]?.length) || overlap(rq.appliesTo, d.appliesTo)) && bad(v.op, d.value, v.value));
        for (const d of hits) {
          const k = `${doc.id}|${rq.id}|${d.id}`;
          if (seenReq.has(k)) continue;
          seenReq.add(k);
          const scope = scopeText(d.appliesTo);
          add('spec_value_mismatch', 'error', `${doc.kind === 'spec' ? '시방서' : '회사 시공기준'} "${doc.name}" ${rq.page}쪽: ${v.label || v.key} ${v.value.toLocaleString()}mm ${OPK[v.op]}인데 상세도 값은 ${d.value.toLocaleString()}mm입니다${scope ? `(${scope})` : ''}.`,
            [ev(doc, { page: rq.page }, rq.requirement.slice(0, 60)), ...evSrc(d.source)], [d.id]);
        }
      }
    }
  }
  return out;
}
