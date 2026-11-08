// 시방서·회사 시공기준·기술검토서 읽기(39 지시서). 순수 함수 — AI가 꺼져 있어도 글자 있는 PDF·엑셀에서 기본 읽기를 한다.
//   시방서·회사 기준 → requirements: [{ id, page, trade, item, requirement, values: [{ key, op, value, unit, label }], appliesTo, kcs }]
//   기술검토서      → techReview: { kind, summaryPages, values, conclusion: { text, page }, candidates }
// 숫자 요구의 키는 38 지시서의 상세 키(detail-keys.js)를 같이 쓴다. 모르는 숫자 요구는 key 'other'로 둔다. 안전 판단은 하지 않는다.
import { DETAIL_WORDS } from '../cad/detail-words.js';
import { scopeOf } from './read-detail.js';

export const REQ_OPS = ['>=', '<=', '=', '>', '<'];
// 시방서 장 제목 → 공종(공정표 공종 이름과 맞춘다)
const SPEC_TRADES = [
  ['방수', /방수/], ['단열', /단열/], ['창호', /창호|유리|샤시|새시/], ['외부도장', /도장/], ['내장', /타일|수장|도배|마루|내장/],
  ['골조', /철근|콘크리트|거푸집|골조/], ['조적', /조적|벽돌|블록/], ['미장', /미장/], ['외장', /석공|석재|금속|외장/], ['가설', /가설|비계/],
  ['토공', /토공|흙막이|터파기/], ['조경', /조경|식재/], ['설비', /설비|배관/], ['전기', /전기/], ['지붕', /지붕|옥상/],
];
export const specTrade = (title) => SPEC_TRADES.find(([, re]) => re.test(String(title || '')))?.[0] || '';

const HEADING = /^(?:제\s*)?(\d{1,2})\s*(?:장|\.)\s*([^\d\s.][^\t]{1,40})$/;
const UNIT_NUM = /([\d][\d,]*(?:\.\d+)?)\s*(mm|㎜|cm|m|일|회|%|℃|MPa|N\/㎟|kg\/㎡|W\/㎡K|W\/mK)(?![a-zA-Z])/;
const OP_WORDS = [['>=', /이상/], ['<=', /이하|이내/], ['>', /초과|넘게/], ['<', /미만/]];
const KCS = /KCS\s*(\d{2}\s*\d{2}\s*\d{2})/;

const lines = (page) => String(page || '').split(/\n/).map((l) => l.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);

/** 문장 하나 → 숫자 요구 값들 */
export function requirementValues(sentence) {
  const s = String(sentence || '');
  const out = [];
  let key = 'other';
  let label = '';
  let from = 0;
  for (const [k, re] of DETAIL_WORDS) {
    const m = re.exec(s);
    if (m) { key = k; label = m[0]; from = m.index + m[0].length; break; }
  }
  const rest = s.slice(from);
  const m = UNIT_NUM.exec(rest);
  if (!m) return out;
  let value = Number(m[1].replace(/,/g, ''));
  let unit = m[2] === '㎜' ? 'mm' : m[2];
  if (unit === 'cm') { value *= 10; unit = 'mm'; } else if (unit === 'm' && key.endsWith('Mm')) { value *= 1000; unit = 'mm'; }
  if (key.endsWith('Mm') && unit !== 'mm') key = 'other';
  const after = rest.slice(m.index + m[0].length, m.index + m[0].length + 12);
  const op = OP_WORDS.find(([, re]) => re.test(after))?.[0] || '=';
  if (key === 'other') label = s.slice(0, Math.max(0, from + m.index)).replace(/[은는이가을를의]\s*$/, '').trim().slice(-30);
  out.push({ key, op, value, unit, label: label.slice(0, 40) });
  return out;
}

/**
 * 시방서 글자(쪽마다) → 장 목록과 숫자 요구사항. 숫자가 없는 문장은 요구사항 목록에 넣지 않는다(장 목록만)
 * @param {string[]} pages
 */
export function readSpecPages(pages) {
  const chapters = [];
  const requirements = [];
  let cur = { title: '', trade: '', page: 1 };
  pages.forEach((text, i) => {
    const page = i + 1;
    for (const l of lines(text)) {
      const h = HEADING.exec(l);
      if (h && !UNIT_NUM.test(l)) {
        cur = { title: h[2].trim(), trade: specTrade(h[2]), page };
        if (!chapters.some((c) => c.title === cur.title)) chapters.push({ ...cur });
        continue;
      }
      for (const sentence of l.split(/(?<=다\.)\s+/)) {
        const values = requirementValues(sentence);
        if (!values.length) continue;
        requirements.push({
          id: `rq_${page}_${requirements.length + 1}`, page, trade: cur.trade, item: cur.title,
          requirement: sentence.slice(0, 200), values, appliesTo: scopeOf(sentence), kcs: KCS.exec(sentence)?.[1]?.replace(/\s+/g, ' ') || null,
        });
      }
    }
  });
  return { chapters, requirements };
}

/**
 * 회사 시공기준 엑셀(공종·항목·기준 표) → 요구사항. grid는 doc-core.gridOf 결과(글자 칸)
 */
export function readCompanyStd(grid) {
  let header = -1;
  let cols = null;
  for (let r = 0; r < Math.min(grid.length, 15) && header < 0; r++) {
    const row = grid[r].map((c) => String(c || '').replace(/\s/g, ''));
    const trade = row.findIndex((c) => /^공종|^구분/.test(c));
    const item = row.findIndex((c) => /^항목|^세부/.test(c));
    const std = row.findIndex((c) => /^기준|^내용|^품질기준|^시공기준/.test(c));
    if (std >= 0 && (trade >= 0 || item >= 0)) { header = r; cols = { trade, item, std }; }
  }
  if (header < 0) return { requirements: [] };
  const requirements = [];
  let lastTrade = '';
  for (let r = header + 1; r < grid.length; r++) {
    const row = grid[r];
    const tradeText = cols.trade >= 0 ? String(row[cols.trade] || '').trim() : '';
    if (tradeText) lastTrade = tradeText;
    const item = cols.item >= 0 ? String(row[cols.item] || '').trim() : '';
    const std = String(row[cols.std] || '').trim();
    if (!std) continue;
    const sentence = `${item} ${std}`.trim();
    const values = requirementValues(sentence);
    requirements.push({ id: `rq_${r + 1}`, page: 1, row: r + 1, trade: specTrade(lastTrade) || lastTrade.slice(0, 20), item, requirement: std.slice(0, 200), values, appliesTo: scopeOf(sentence), kcs: KCS.exec(std)?.[1] || null });
  }
  return { requirements };
}

// ---------------------------------------------------------------- 기술검토서

const SUMMARY = /검토\s*결과|결론|검토\s*개요|개\s*요|종합\s*의견|요약/;
const CONCLUSION = /(O\.?K\.?|만족|안전(하|함|한)|적합|이상\s*없)/i;
export const REVIEW_KINDS = { excavation: '흙막이·가시설', crane: '타워크레인', formwork: '거푸집·동바리', scaffold: '비계·갱폼', other: '그 밖' };

function reviewKind(all) {
  if (/흙막이|가시설|버팀보|어스\s*앵커/.test(all)) return 'excavation';
  if (/타워\s*크레인|T\/C/.test(all)) return 'crane';
  if (/동바리|거푸집/.test(all)) return 'formwork';
  if (/비계|갱폼|작업\s*발판/.test(all)) return 'scaffold';
  return 'other';
}
const num = (s) => Number(String(s).replace(/,/g, ''));

/**
 * 기술검토서 글자(쪽마다) → 결론·개요 쪽만 보고 값 뽑기. 계산 과정 쪽은 읽지 않는다
 * @param {string[]} pages
 */
export function readTechReview(pages) {
  const summaryPages = pages.map((t, i) => (SUMMARY.test(t) ? i + 1 : 0)).filter(Boolean);
  const use = summaryPages.length ? summaryPages : [1];
  const text = use.map((n) => lines(pages[n - 1]).join('\n')).join('\n');
  const kind = reviewKind(pages.join(' '));
  const pick = (re, f = (m) => m[1]) => { const m = re.exec(text); return m ? f(m) : null; };
  const values = {};
  const candidates = [];
  if (kind === 'excavation') {
    values.method = pick(/(C\.?I\.?P|S\.?C\.?W|H-?PILE\s*\+?\s*토류판|SHEET\s*PILE|소일\s*시멘트\s*벽체)/i, (m) => m[1].toUpperCase().replace(/\./g, '').replace(/\s+/g, ' '));
    values.depthM = pick(/굴착\s*(?:깊이|심도)\s*[:：=]?\s*([\d.]+)\s*m/i, (m) => num(m[1]));
    values.support = pick(/(버팀보|어스\s*앵커|레이커|스트러트|RAKER|EARTH\s*ANCHOR)/i, (m) => m[1].replace(/\s+/g, ''));
    values.stages = pick(/(\d)\s*단/, (m) => num(m[1]));
    values.monitoring = pick(/계측\s*(?:위치|항목|계획)?\s*[:：]\s*([^\n]{2,80})/);
  } else if (kind === 'crane') {
    values.model = pick(/기\s*종\s*[:：]\s*([^\n,]{2,40})/, (m) => m[1].trim());
    values.count = pick(/(\d+)\s*대/, (m) => num(m[1]));
    values.heightM = pick(/(?:설치\s*)?높이\s*[:：=]?\s*([\d.]+)\s*m/, (m) => num(m[1]));
    values.foundationM = pick(/기초\s*(?:크기|규격)?\s*[:：=]?\s*([\d.]+)\s*[x×]\s*([\d.]+)(?:\s*[x×]\s*([\d.]+))?\s*m/, (m) => m.slice(1).filter(Boolean).map(num));
    const where = pick(/위\s*치\s*[:：]\s*([^\n]{2,80})/);
    values.location = where;
    // 크레인 위치는 사람이 확인해야 가설 배치가 된다(26·29 지시서). 여기서는 후보만
    for (const part of String(where || '').split(/[,·、/]/).map((x) => x.trim()).filter(Boolean)) candidates.push({ kind: 'tower_crane', note: part, confirmed: false });
  } else if (kind === 'formwork') {
    values.shore = pick(/동바리\s*(?:종류|형식)?\s*[:：]\s*([^\n]{2,40})/);
    values.spacingMm = pick(/간격\s*[:：=]?\s*([\d,]+)\s*mm/, (m) => num(m[1]));
    values.keepDays = pick(/존치\s*(?:기간)?\s*[:：=]?\s*(\d+)\s*일/, (m) => num(m[1]));
  } else if (kind === 'scaffold') {
    values.type = pick(/(시스템\s*비계|강관\s*비계|갱폼|작업\s*발판)/, (m) => m[1].replace(/\s+/g, ''));
    values.floors = pick(/존치\s*(?:층수)?\s*[:：=]?\s*(\d+)\s*개?\s*층/, (m) => num(m[1]));
  }
  let conclusion = null;
  for (const n of use) {
    const hit = lines(pages[n - 1]).find((l) => CONCLUSION.test(l) && !/^목\s*차/.test(l));
    if (hit) { conclusion = { text: hit.slice(0, 200), page: n }; break; }
  }
  for (const k of Object.keys(values)) if (values[k] == null) delete values[k];
  return { kind, summaryPages: use, values, conclusion, candidates };
}

/** 문서 종류별로 글자 읽기(AI 없이). 결과는 extracted에 합칠 조각 */
export function readDocText(kind, pages) {
  if (kind === 'spec') { const r = readSpecPages(pages); return { requirements: r.requirements, chapters: r.chapters }; }
  if (kind === 'tech_review') return { techReview: readTechReview(pages) };
  return null;
}
