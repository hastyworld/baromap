// 부위 단면 그림(42 지시서 3.3): 고른 부위(벽·바닥·천장)의 층 구성을 축척 그림(SVG)으로. 두께 숫자와 출처를 함께 적는다.
// 순수 함수(글자만 만든다) — 정보 패널(model-panel.js)이 쓴다. 층 구성 계산은 parts.js.
import { stackTag } from './parts.js';
import { kindInfo } from './materials-ko.js';

const escXml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmText = (v) => (v == null ? '-' : String(Math.round(v * 10) / 10));
const MIN = 5; // 얇은 층도 보이게 하는 최소 폭(px)

/**
 * @param {{ name, mm, color, kind, source: { label, assumed } }[]} layers 그리는 순서(벽: 실외·반대쪽 → 실내, 바닥·천장: 위 → 아래)
 * @param {{ orient: 'wall'|'floor'|'ceiling', size?: number }} o
 * @returns {string} SVG 글자
 */
export function sectionSvg(layers, { orient = 'wall', size = 260 } = {}) {
  if (!layers.length) return '';
  const total = layers.reduce((s, l) => s + (l.mm || 0), 0) || 1;
  // 축척: 전체 두께 → size px. 얇은 층은 MIN px로 키우고 나머지를 줄여 합을 맞춘다
  const raw = layers.map((l) => ((l.mm || 0) / total) * size);
  const thin = raw.map((w) => w < MIN);
  const spare = size - thin.filter(Boolean).length * MIN;
  const rest = raw.reduce((s, w, i) => s + (thin[i] ? 0 : w), 0) || 1;
  const px = raw.map((w, i) => (thin[i] ? MIN : (w / rest) * spare));
  const exaggerated = thin.some(Boolean) && layers.length > 1;
  const cross = 96; // 층 방향에 수직인 길이
  const pad = 22;
  const out = [];
  let at = 0;
  const vertical = orient === 'wall'; // 벽: 세로 띠를 가로로 늘어놓는다
  const W = vertical ? size + pad * 2 : cross + 150;
  const H = vertical ? cross + 46 : size + pad;
  layers.forEach((l, i) => {
    const t = px[i];
    const fill = l.color || kindInfo(l.kind).color;
    const dash = l.source?.assumed ? ' stroke-dasharray="4 3"' : '';
    if (vertical) {
      out.push(`<rect x="${(pad + at).toFixed(1)}" y="14" width="${t.toFixed(1)}" height="${cross}" fill="${escXml(fill)}" stroke="#5b6472" stroke-width="0.8"${dash}><title>${escXml(l.name)} ${mmText(l.mm)}mm</title></rect>`);
      out.push(`<text x="${(pad + at + t / 2).toFixed(1)}" y="${14 + cross + (i % 2 ? 26 : 14)}" text-anchor="middle" class="sv-num">${mmText(l.mm)}</text>`);
    } else {
      out.push(`<rect x="8" y="${(8 + at).toFixed(1)}" width="${cross}" height="${t.toFixed(1)}" fill="${escXml(fill)}" stroke="#5b6472" stroke-width="0.8"${dash}><title>${escXml(l.name)} ${mmText(l.mm)}mm</title></rect>`);
      out.push(`<text x="${cross + 16}" y="${(8 + at + Math.max(t / 2 + 4, 9)).toFixed(1)}" class="sv-num">${escXml(l.name)} ${mmText(l.mm)}</text>`);
    }
    at += t;
  });
  if (vertical) out.push(`<text x="${pad}" y="9" class="sv-side">실외·반대쪽</text><text x="${pad + size}" y="9" text-anchor="end" class="sv-side">실내</text>`);
  return `<svg class="bv-section" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escXml(stackTag(layers))}">${out.join('')}</svg>${exaggerated ? '<p class="muted small">얇은 층은 보이도록 조금 크게 그렸습니다(숫자가 실제 두께).</p>' : ''}`;
}

/** 층 구성 표(재료·두께·종류·출처) */
export function stackTable(layers) {
  const total = layers.reduce((s, l) => s + (l.mm || 0), 0);
  return `<table class="bv-layers"><thead><tr><th>#</th><th>재료</th><th>두께</th><th>출처</th></tr></thead><tbody>
    ${layers.map((l, i) => `<tr><td>${i + 1}</td><td><i class="sw" style="background:${escXml(l.color || kindInfo(l.kind).color)}"></i>${escXml(l.name)}<br><span class="muted small">${escXml(kindInfo(l.kind).short || kindInfo(l.kind).label)}</span></td><td>${mmText(l.mm)}</td><td class="${l.source?.assumed ? 't-warn' : 'muted'} small">${escXml(l.source?.label || '')}</td></tr>`).join('')}
    </tbody><tfoot><tr><td></td><td>합계</td><td>${mmText(total)}</td><td></td></tr></tfoot></table>`;
}

/** 부위 카드: 제목 + 꼬리표 + 그림 + 표 */
export function sectionCard(title, stack, orient) {
  if (!stack?.layers?.length) return '';
  return `<div class="bv-part" data-part="${orient}"><h4>${escXml(title)}</h4>
    <p class="bv-tag" data-bv-tag="${orient}">${escXml(stackTag(stack.layers))}</p>
    ${sectionSvg(stack.layers, { orient })}${stackTable(stack.layers)}
    ${stack.assumed ? '<p class="small t-warn">도면에서 이 부위의 구성을 찾지 못해 기본값으로 보여 드립니다(점선).</p>' : stack.layers.some((l) => l.source?.assumed) ? '<p class="small muted">점선 층은 도면에 없어 기본값으로 넣은 것입니다.</p>' : ''}</div>`;
}
