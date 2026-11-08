// 현장 "공공 정보" 칸(30 지시서 1~3절): 필지(PNU) → 건축인허가·건축물대장 값(출처·받은 날짜와 함께) → 사람이 확인해서 현장 개요로 옮기기,
// 모델과 대조(동 수·층수·세대수·연면적·높이·대지면적) → 검증 결과(출처 public, "확인 필요"). 공공 API는 서버 함수(public-data)만 부른다.
import { store, state, q, ui } from './ctx.js';
import { $, esc, icon, onAction, onForm, openModal, closeModal, toast, fmtDate, loadScript } from './util.js';
import { pnuFrom, queryOfPnu, publicSummary, overviewText, VALUE_LABEL, PUBLIC_LICENSE, PUBLIC_SOURCES } from './ops/calc/public-data.js';
import { publicChecks } from './bim/public-checks.js';
import { onModelBuilt } from './model-build.js';

const cache = new Map(); // siteId → records | 'loading' | { error }
const SHOWN = ['permitDate', 'startDate', 'approvalDate', 'purpose', 'siteArea', 'buildingArea', 'grossArea', 'coverage', 'far', 'households', 'mainBuildings', 'parking'];
const fmt = (k, v) => (typeof v === 'number' ? `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : /Date$/.test(k) ? fmtDate(v) : esc(v));

async function load(siteId) {
  cache.set(siteId, 'loading');
  try { cache.set(siteId, await store.publicData.list(siteId)); } catch (err) { cache.set(siteId, { error: err.message }); }
  if (state.siteId === siteId) ui.render();
}

export function publicSection(s) {
  if (!store.publicData || !store.can('viewSite', s.id)) return '';
  const edit = store.can('edit', s.id);
  const head = `<div class="sec-head"><h3>공공 정보 <small>건축인허가·건축물대장</small></h3><span class="spacer"></span>
    ${edit ? `<button type="button" class="btn sm" data-act="pub-open" data-site="${esc(s.id)}">${icon('download')}가져오기</button>` : ''}</div>`;
  const c = cache.get(s.id);
  if (c === undefined) { queueMicrotask(() => load(s.id)); return `<section class="sec pub-sec">${head}<p class="muted small loading">불러오는 중…</p></section>`; }
  if (c === 'loading') return `<section class="sec pub-sec">${head}<p class="muted small loading">불러오는 중…</p></section>`;
  if (c.error) return `<section class="sec pub-sec">${head}<p class="muted small">${esc(/schema cache|does not exist|PGRST205/.test(c.error) ? '공공 정보 표가 아직 준비되지 않았습니다(서버 SQL 적용 전).' : c.error)}</p></section>`;
  const sum = publicSummary(c);
  if (sum.empty) {
    const tried = c.length ? `<p class="small muted">${c.map((r) => `${esc(PUBLIC_SOURCES[r.kind]?.label || r.kind)}: 기록 없음(${fmtDate(r.fetchedAt)} 확인)`).join('<br>')}. 신축 전이면 허가 정보가 아직 없을 수 있습니다.</p>` : '';
    return `<section class="sec pub-sec">${head}${tried || `<p class="muted small">주소(지번)로 필지를 찾아 정부 기록(허가 동 수·층수·세대수·연면적 등)을 가져옵니다. 도면에서 읽은 값과 맞춰 보는 데 씁니다.</p>`}</section>`;
  }
  const v = sum.values;
  const rows = SHOWN.filter((k) => v[k]).map((k) => `<tr><th>${esc(VALUE_LABEL[k])}</th><td>${fmt(k, v[k].value)}</td></tr>`).join('');
  const dongs = sum.dongs.filter((d) => d.main);
  const srcs = [...new Set([...Object.values(v), ...sum.dongs].map((x) => `${x.source} · ${fmtDate(x.fetchedAt)} 받음`))];
  return `<section class="sec pub-sec">${head}
    <table class="bv-props pub-vals">${rows}</table>
    ${dongs.length ? `<p class="small"><b>동별</b> ${dongs.map((d) => `${esc(d.name)} ${d.floorsAbove != null ? `지상 ${d.floorsAbove}층` : ''}${d.floorsBelow ? `·지하 ${d.floorsBelow}층` : ''}${d.height ? ` ${d.height}m` : ''}${d.households ? ` ${d.households}세대` : ''}`).join(' / ')}</p>` : ''}
    ${sum.zones.length ? `<p class="small"><b>지역·지구</b> ${sum.zones.map((z) => esc(z.name)).join(', ')}</p>` : ''}
    <p class="small muted pub-src">출처: ${srcs.map(esc).join(', ')}. ${esc(PUBLIC_LICENSE)}. 값은 참고이고, 사람이 확인해서 쓴다.</p>
    ${edit ? `<div class="pub-acts"><button type="button" class="btn sm ghost" data-act="pub-overview" data-site="${esc(s.id)}">${icon('edit')}현장 개요로 옮기기</button>
      <button type="button" class="btn sm ghost" data-act="pub-check" data-site="${esc(s.id)}">${icon('check')}모델과 대조</button></div>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- 가져오기(필지 찾기)

function pnuGuess(siteId) {
  const c = cache.get(siteId);
  const rec = Array.isArray(c) && c.find((r) => r.query?.pnu);
  if (rec) return rec.query.pnu;
  const lp = state.lastPostcode;
  if (lp?.bcode) { try { return pnuFrom(lp.bcode, lp.jibun).pnu; } catch { /* 아래 칸에 직접 */ } }
  return '';
}

onAction('pub-open', (el) => {
  const siteId = el.dataset.site;
  const s = q.site(siteId);
  openModal({
    title: '공공 정보 가져오기',
    body: `<form id="f-pub" data-form="pub-fetch" novalidate>
      <input type="hidden" name="siteId" value="${esc(siteId)}">
      <p class="muted small">필지번호(PNU)로 정부 기록을 가져옵니다: 건축인허가(허가일·대지면적·연면적·세대수·동별 층수·높이·지역지구), 건축물대장(준공된 건물). 지도·지적 원본은 저장하지 않습니다.</p>
      <p class="small">${esc(s?.address || '')}</p>
      <div class="pub-pnu"><label class="field"><span>필지번호(PNU, 19자리)</span><input name="pnu" inputmode="numeric" maxlength="23" value="${esc(pnuGuess(siteId))}" placeholder="예: 4122010100101230004"></label>
        <button type="button" class="btn sm" data-act="pub-postcode">${icon('search')}지번 주소로 찾기</button></div>
      <div id="pub-postcode" class="postcode-box" hidden></div>
      <p class="small muted" id="pub-pnu-note"></p>
      <label class="check"><input type="checkbox" name="force"><span>하루 안에 받았어도 다시 받기</span></label>
    </form>`,
    footer: `<button type="button" class="btn ghost" data-act="modal-close">취소</button><button type="submit" form="f-pub" class="btn primary">${icon('download')}가져오기</button>`,
  });
});

onAction('pub-postcode', async () => {
  const box = $('#pub-postcode');
  if (!box) return;
  if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
  await loadScript('https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js');
  box.hidden = false;
  new window.daum.Postcode({
    oncomplete: (data) => {
      box.hidden = true;
      box.innerHTML = '';
      try {
        const p = pnuFrom(data.bcode, data.jibunAddress || data.autoJibunAddress);
        const f = $('#f-pub');
        if (f) f.pnu.value = p.pnu;
        $('#pub-pnu-note').textContent = `${data.jibunAddress || data.autoJibunAddress} → ${p.pnu}`;
      } catch (err) { $('#pub-pnu-note').textContent = err.message; }
    },
    width: '100%',
    height: '100%',
  }).embed(box);
});

onForm('pub-fetch', async (f) => {
  const pnu = queryOfPnu(f.pnu).pnu;
  const r = await store.publicData.fetch(f.siteId, pnu, { force: Boolean(f.force) });
  closeModal(true);
  await load(f.siteId);
  const got = (r.records || []).filter((x) => x.status === 'ok').map((x) => PUBLIC_SOURCES[x.kind]?.label.replace('국토교통부 건축HUB ', '').replace(' 서비스', ''));
  toast(got.length ? `가져왔습니다: ${got.join(', ')}` : '정부 기록이 없습니다(신축 전이면 허가 정보가 아직 없을 수 있습니다).', got.length ? 'ok' : 'warn');
  const n = await runChecks(f.siteId).catch(() => null);
  if (n) toast(`모델과 대조: 확인 필요 ${n}건(검증 목록)`, 'warn');
});

// ---------------------------------------------------------------- 현장 개요로 옮기기·모델과 대조

onAction('pub-overview', async (el) => {
  const s = q.site(el.dataset.site);
  const c = cache.get(s.id);
  if (!s || !Array.isArray(c)) return;
  const add = overviewText(publicSummary(c));
  const base = String(s.overview || '').replace(/\n?\[공공 정보\][\s\S]*?출처:[^\n]*\n?/, '').trim();
  await store.save('sites', { ...s, overview: `${base ? `${base}\n` : ''}${add}`.slice(0, 5000) });
  toast('현장 개요에 넣었습니다. 내용을 확인해주세요.');
  ui.render();
});

async function latestModel(siteId) {
  if (!store.bim) return null;
  const model = (await store.bim.versions(siteId))[0];
  if (!model) return null;
  const idx = await store.bim.load(model, 'index.json');
  const files = { 'index.json': idx };
  for (const n of ['site.json', ...Object.values(idx.files.buildings || {}), ...Object.values(idx.files.unitTypes || {})]) files[n] = await store.bim.load(model, n);
  return { model, files };
}
/** 최근 모델과 대조해 검증 결과(출처 public)를 새로 쓴다. 돌려주는 값: 확인 필요 건수(모델이 없으면 null) */
export async function runChecks(siteId) {
  if (!store.can('edit', siteId)) return null;
  const got = await latestModel(siteId);
  if (!got) return null;
  const recs = Array.isArray(cache.get(siteId)) ? cache.get(siteId) : await store.publicData.list(siteId);
  const list = publicChecks(got.files, publicSummary(recs));
  await store.bim.saveFindings(got.model.id, list, { source: 'public' });
  return list.length;
}
onAction('pub-check', async (el) => {
  const n = await runChecks(el.dataset.site);
  if (n == null) toast('이 현장에 아직 3D 모델이 없습니다. 도서로 모델을 만든 뒤 대조합니다.', 'warn');
  else toast(n ? `확인 필요 ${n}건을 검증 목록에 넣었습니다(위반 판정이 아닙니다).` : '정부 기록과 모델 값이 맞습니다.', n ? 'warn' : 'ok');
});
// 모델을 새로 만들면 공공 정보가 있을 때 다시 대조한다
onModelBuilt(async ({ siteId }) => { await runChecks(siteId).catch(() => {}); });
