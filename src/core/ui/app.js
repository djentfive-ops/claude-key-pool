'use strict';
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const pad = n => String(n).padStart(2, '0');
const hhmm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const hhmmss = t => { const d = new Date(t); return `${hhmm(t)}:${pad(d.getSeconds())}`; };
function ago(t) {
  if (!t) return '아직 사용 전';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return '방금 사용';
  if (s < 3600) return `${Math.floor(s / 60)}분 전 사용`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전 사용`;
  return `${Math.floor(s / 86400)}일 전 사용`;
}

const usd = v => v == null ? '—' : v >= 100 ? `$${v.toFixed(0)}` : v >= 0.01 || v === 0 ? `$${v.toFixed(2)}` : v >= 0.0001 ? `$${v.toFixed(4)}` : '$0.0001 미만';
const tok = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(v || 0);
const mdate = t => { const d = new Date(t); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
const SERIES = { light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'] };   // 키 순서대로 고정(밝기별 검증된 단계)
const colorOf = id => { const p = SERIES[S?.dark ? 'dark' : 'light']; return p[Math.max(0, (S?.keys || []).findIndex(k => k.id === id)) % p.length]; };
const level = r => r <= 0.1 ? 'low' : r <= 0.3 ? 'mid' : '';

let S = null;
const strips = new Map();   // id → { root, refs }

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 1800);
}

const STATE_WORD = {
  live: ['송출 중', () => '요청을 보내는 중'],
  ready: ['대기', k => ago(k.lastAt)],
  exhausted: ['크레딧 부족', k => `${hhmm(k.until)}에 다시 시험`],
  rate: ['속도 제한', k => `${hhmmss(k.until)}까지 쉬는 중`],
  auth: ['키 오류', () => '키가 지워졌거나 권한 없음'],
};

// ── 채널 스트립 ──────────────────────────────
function makeStrip(k) {
  const root = el('article', 'strip');
  const housing = el('div', 'housing');
  const lamp = el('div', 'lamp'); lamp.setAttribute('aria-hidden', 'true');
  const word = el('div', 'state-word');
  const sub = el('div', 'state-sub');
  const meter = el('div', 'meter'); meter.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 24; i++) meter.append(el('i'));
  housing.append(lamp, word, sub, meter);

  const body = el('div', 'strip-body');
  const name = el('input', 'name'); name.maxLength = 24; name.setAttribute('aria-label', '키 이름');
  name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = name.dataset.v; name.blur(); } });
  name.addEventListener('blur', async () => { if (name.value.trim() && name.value !== name.dataset.v) { await window.pool.rename(k.id, name.value); toast('이름을 바꿨습니다'); } else name.value = name.dataset.v; });
  const meta = el('div', 'meta');
  const tierBtn = el('button', 'tool'); tierBtn.type = 'button'; tierBtn.style.padding = '0'; tierBtn.title = '눌러서 종류 바꾸기';
  tierBtn.addEventListener('click', async () => {
    const next = strips.get(k.id).tier === 'paid' ? 'credit' : 'paid';
    await window.pool.setTier(k.id, next);
    toast(next === 'paid' ? '예비 키로 바꿨습니다' : '먼저 쓰는 키로 바꿨습니다');
  });
  const tail = el('span');
  meta.append(tierBtn, tail);
  const count = el('div', 'count');
  const uses = el('b'); const usesL = el('span', null, '성공'); const fails = el('span', 'fails');
  count.append(uses, usesL, fails);

  const fuel = el('div', 'fuel');
  const fuelTop = el('div', 'fuel-top'); const fuelLabel = el('span'); const fuelVal = el('b'); fuelTop.append(fuelLabel, fuelVal);
  const fuelBar = el('div', 'fuel-bar'); const fuelFill = el('i'); fuelBar.append(fuelFill);
  const fuelSub = el('div', 'fuel-sub');
  const fuelSet = el('button', 'fuel-set', '남은 크레딧 표시하기'); fuelSet.type = 'button';
  fuelSet.addEventListener('click', () => openCredit(k.id));
  fuel.append(fuelTop, fuelBar, fuelSub, fuelSet);

  const tools = el('div', 'tools');
  const left = el('button', 'tool', '‹'); left.type = 'button'; left.setAttribute('aria-label', '먼저 쓰기'); left.title = '이 키를 먼저 쓰기';
  const right = el('button', 'tool', '›'); right.type = 'button'; right.setAttribute('aria-label', '나중에 쓰기'); right.title = '이 키를 나중에 쓰기';
  const test = el('button', 'tool', '확인'); test.type = 'button'; test.title = '키가 살아 있는지 확인';
  const setBtn = el('button', 'tool', '설정'); setBtn.type = 'button'; setBtn.title = '크레딧 금액·충전일';
  setBtn.addEventListener('click', () => openCredit(k.id));
  const del = el('button', 'tool danger', '삭제'); del.type = 'button';
  left.addEventListener('click', () => window.pool.move(k.id, -1));
  right.addEventListener('click', () => window.pool.move(k.id, 1));
  test.addEventListener('click', async () => {
    test.disabled = true; test.textContent = '확인 중';
    const r = await window.pool.test(k.id);
    test.disabled = false; test.textContent = '확인';
    toast(r.ok ? `${name.dataset.v}: 정상 키입니다` : `${name.dataset.v}: ${r.message}`);
  });
  del.addEventListener('click', async () => {
    if (del.dataset.armed) { await window.pool.remove(k.id); toast('키를 삭제했습니다'); return; }
    del.dataset.armed = '1'; del.textContent = '정말 삭제';
    setTimeout(() => { delete del.dataset.armed; del.textContent = '삭제'; }, 3000);
  });
  tools.append(left, right, test, setBtn, el('span', 'grow'), del);

  body.append(name, meta, count, fuel, tools);
  root.append(housing, body);
  return { root, tier: k.tier, refs: { word, sub, meter, name, tierBtn, tail, uses, fails, left, right, fuelLabel, fuelVal, fuelBar, fuelFill, fuelSub, fuelSet } };
}

function updateStrip(s, k, index, groupLen) {
  const { refs } = s;
  s.tier = k.tier;
  s.root.dataset.state = k.state;
  let [w, subFn] = STATE_WORD[k.state] ?? STATE_WORD.ready;
  if (k.provider === 'gpt' && k.state === 'exhausted') w = '잔액 부족';
  refs.word.textContent = w;
  refs.sub.textContent = subFn(k);
  if (document.activeElement !== refs.name) { refs.name.value = k.name; }
  refs.name.dataset.v = k.name;
  refs.tierBtn.textContent = k.provider === 'gpt' ? (k.tier === 'paid' ? 'GPT 예비 키' : 'GPT 키') : (k.tier === 'paid' ? '유료 예비 키' : '크레딧 키');
  refs.tail.textContent = `끝자리 ${k.tail}`;
  refs.uses.textContent = k.uses.toLocaleString('ko-KR');
  refs.fails.textContent = k.fails ? `넘김 ${k.fails}` : '';
  refs.fails.title = '크레딧 부족·키 오류·속도 제한으로 다음 키에 넘긴 횟수';
  refs.fails.classList.toggle('has', k.fails > 0);
  const cells = refs.meter.children, rec = k.recent, off = 24 - rec.length;
  for (let i = 0; i < 24; i++) cells[i].className = i < off ? '' : rec[i - off] ? 'ok' : 'ng';
  const cs = k.creditState;
  const showGauge = cs?.configured;
  refs.fuelBar.hidden = !showGauge; refs.fuelSet.hidden = !!showGauge || k.tier === 'paid';
  if (showGauge) {
    refs.fuelLabel.textContent = '남은 크레딧';
    refs.fuelVal.textContent = `약 ${usd(cs.remaining)}`;
    refs.fuelFill.style.width = `${Math.round(cs.ratio * 100)}%`;
    refs.fuelFill.className = level(cs.ratio);
    refs.fuelSub.textContent = `${usd(cs.amount)} 중, ${mdate(cs.nextRefill)} 다시 충전`;
  } else {
    refs.fuelLabel.textContent = k.tier === 'paid' ? '이번 달 사용' : '이번 달 사용';
    refs.fuelVal.textContent = usd(cs?.monthUsd ?? 0);
    refs.fuelSub.textContent = k.tier === 'paid' ? '크레딧 키가 다 쉬면 쓰는 키' : '';
  }
  refs.left.disabled = index === 0;
  refs.right.disabled = index === groupLen - 1;
  s.root.setAttribute('aria-label', `${k.name}, ${w}`);
}

function group(title, note, list) {
  const g = el('section', 'group');
  const h = el('h2', 'group-title'); h.append(el('span', null, title), el('span', 'muted', note));
  const row = el('div', 'strips');
  g.append(h, row);
  return { g, row, list };
}

function renderBay() {
  const bay = $('#bay');
  if (!S.keys.length) { renderEmpty(bay); return; }
  if (bay.querySelector('.empty')) { bay.textContent = ''; renderBay.sig = null; }
  const pick = (provider, tier) => S.keys.filter(k => (k.provider || 'claude') === provider && k.tier === tier);
  const lists = [
    ['Claude 크레딧 키', '왼쪽 키부터 다 쓰고 다음 키로 넘어갑니다', '이 키를 먼저 씁니다', pick('claude', 'credit')],
    ['Claude 유료 예비 키', '크레딧 키가 모두 쉬면 씁니다', '크레딧 키가 모두 쉬면 씁니다', pick('claude', 'paid')],
    ['GPT 키', '왼쪽 키부터 다 쓰고 다음 키로 넘어갑니다', 'GPT 요청은 이 키로 갑니다', pick('gpt', 'credit')],
    ['GPT 예비 키', '앞의 GPT 키가 모두 쉬면 씁니다', '앞의 GPT 키가 모두 쉬면 씁니다', pick('gpt', 'paid')],
  ].filter(l => l[3].length);
  // 구조(키 순서·종류)가 같으면 노드를 옮기지 않고 글자만 바꾼다 — 이름 편집 중 포커스가 풀리지 않게
  const sig = lists.flatMap(l => l[3]).map(k => `${k.id}:${k.tier}:${k.provider}`).join('|');
  if (sig === renderBay.sig) {
    for (const l of lists) l[3].forEach((k, i) => updateStrip(strips.get(k.id), k, i, l[3].length));
    return;
  }
  renderBay.sig = sig;
  const groups = lists.map(([title, many, one, list]) => group(title, list.length > 1 ? many : one, list));
  const seen = new Set();
  const frag = document.createDocumentFragment();
  for (const { g, row, list } of groups) {
    list.forEach((k, i) => {
      seen.add(k.id);
      let s = strips.get(k.id);
      if (!s) { s = makeStrip(k); strips.set(k.id, s); }
      updateStrip(s, k, i, list.length);
      row.append(s.root);
    });
    frag.append(g);
  }
  const add = el('button', 'add-strip'); add.type = 'button';
  add.append(el('span', 'plus', '+'), el('span', null, '키 추가'));
  add.addEventListener('click', openSheet);
  const last = groups.at(-1).row; last.append(add);
  for (const id of strips.keys()) if (!seen.has(id)) strips.delete(id);
  const focused = document.activeElement;
  bay.replaceChildren(frag);
  if (focused && bay.contains(focused)) focused.focus();
}

function renderEmpty(bay) {
  if (bay.querySelector('.empty')) return;
  strips.clear();
  const box = el('div', 'empty');
  const housing = el('div', 'housing');
  const lamp = el('div', 'lamp'); housing.append(lamp, el('div', 'state-word', '키 없음'));
  const right = el('div');
  right.append(el('h2', null, 'Claude·GPT API 키를 붙여넣으면 바로 시작해요'));
  right.append(el('p', null, 'Claude 키(sk-ant-…)와 GPT 키(sk-proj-…)를 섞어 넣어도 알아서 나눠요. Claude는 계정마다 claude.ai 결제 설정에서 Console 조직을 연결하고 그 조직에서 만든 키를 넣으세요.'));
  const ta = el('textarea'); ta.rows = 3; ta.placeholder = 'sk-ant-api03-...  또는  sk-proj-...'; ta.spellcheck = false;
  const row = el('div', 'row');
  const go = el('button', 'primary', '추가하기'); go.type = 'button';
  const help = el('button', 'link', '키 만드는 곳 열기'); help.type = 'button';
  help.addEventListener('click', () => window.pool.openExternal('https://platform.claude.com/settings/keys'));
  const res = el('ul', 'results'); res.style.marginTop = '10px';
  go.addEventListener('click', async () => { go.disabled = true; const r = await window.pool.addKeys(ta.value, 'credit', ''); go.disabled = false; showResults(res, r); });
  row.append(go, help);
  right.append(ta, row, res);
  box.append(housing, right);
  bay.replaceChildren(box);
}

function showResults(ul, r) {
  ul.replaceChildren(...r.results.map(x => { const li = el('li', x.ok ? '' : 'ng', `${x.tail ? `끝자리 ${x.tail}: ` : ''}${x.message}`); return li; }));
  if (r.added) toast(`키 ${r.added}개를 추가했습니다`);
}

// ── 최근 요청 ──────────────────────────────
function resultText(e) {
  const hop = e.hops?.length ? `, ${e.hops.map(h => h.name).join('·')}에서 넘어옴` : '';
  if (e.status >= 200 && e.status < 300) return `성공${hop}`;
  if (e.note) return `${e.note}${e.status ? ` (${e.status})` : ''}`;
  if (e.status === 400) return '요청 오류 (400)';
  if (e.status === 529) return 'Anthropic 과부하 (529)';
  return `실패 (${e.status})${hop}`;
}
function renderLog() {
  const ol = $('#log');

  if (!S.log.length) { ol.replaceChildren(el('li', 'log-empty', '아직 이 앱을 거친 요청이 없어요. 프로그램에 앱 주소와 API 키 칸 local 을 넣으면 여기에 쌓입니다.')); ol.firstChild.style.display = 'block'; return; }
  ol.replaceChildren(...S.log.map(e => {
    const li = el('li');
    const ok = e.status >= 200 && e.status < 300;
    li.append(el('span', 't', `${new Date(e.at).getMonth() + 1}/${new Date(e.at).getDate()} ${hhmm(e.at)}`), el('span', `d ${ok ? (e.hops?.length ? 'hop' : '') : 'ng'}`), el('span', 'k', e.name),
      el('span', 'm', e.model || e.path), el('span', 'r', resultText(e)), el('span', 'ms', e.usd != null ? usd(e.usd) : e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}초` : `${e.ms}ms`));
    li.title = `걸린 시간 ${e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}초` : `${e.ms}ms`}${e.tokens != null ? `, 토큰 ${tok(e.tokens)}` : ''}`;
    return li;
  }));
}

// ── 머리·연결 방법 ────────────────────────────
function renderHead() {
  const a = $('#addr');
  a.classList.toggle('on', S.listening); a.classList.toggle('off', !S.listening && !!S.portError);
  $('#addrText').textContent = S.listening ? `켜져 있어요  ${S.address.replace('http://', '')}` : S.portError ? '시작하지 못했어요' : '시작하는 중';
  $('#fBase').textContent = S.address;
  $('#fGpt').textContent = `${S.address}/v1`;
  $('#fPs').textContent = psLine();
  $('#fPsGpt').textContent = psGpt();
  $('#autoStart').checked = !!S.settings.autoStart;
  const b = $('#banner');
  if (S.portError) {
    b.hidden = false;
    const old = S.portError === 'old-version';
    const msg = old ? `예전 배치파일 버전이 뒤에서 ${S.port}번 주소를 쓰고 있어서 이 앱이 시작하지 못했어요.`
      : S.portError === 'in-use' ? `${S.port}번 포트를 다른 프로그램이 쓰고 있어요. 그 프로그램을 끄고 다시 시도하세요.`
      : `시작하지 못했어요: ${S.portError}`;
    const btn = el('button', old ? 'primary' : 'ghost', old ? '예전 버전 끄고 이어받기' : '다시 시도'); btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = old ? '끄는 중' : '다시 시도하는 중';
      S = old ? await window.pool.takeover() : await window.pool.retryPort(); render();
      toast(S.listening ? '이제 이 앱이 주소를 받아요' : '아직 시작하지 못했어요');
    });
    b.replaceChildren(el('span', null, msg), btn);
  } else b.hidden = true;
}
const psLine = () => `$env:ANTHROPIC_BASE_URL="${S.address}"; $env:ANTHROPIC_API_KEY="local"; claude -p "할 일"`;
const psGpt = () => `$env:OPENAI_BASE_URL="${S.address}/v1"; $env:OPENAI_API_KEY="local"`;

function render() { if (!S) return; renderTheme(); renderUpdate(); renderHead(); renderBay(); renderCredit(); renderCharges(); renderStore(); renderLog(); if (!$('#usageView').hidden) refreshUsage(); }

// ── 키 추가 시트 ─────────────────────────────
const sheet = $('#addSheet');
const TIER_HELP = { credit: 'Claude는 Max 월간 크레딧 키, GPT는 평소 쓸 키예요. 여러 개면 왼쪽 키부터 다 쓰고 넘어갑니다(캐시 유지).', paid: '먼저 쓰는 키가 모두 쉬는 중일 때만 씁니다. 자동 충전을 켠 키를 넣으세요.' };
function tierNow() { return sheet.querySelector('input[name=tier]:checked').value; }
function openSheet() { $('#addText').value = ''; $('#addName').value = ''; $('#addResults').replaceChildren(); $('#tierHelp').textContent = TIER_HELP[tierNow()]; sheet.showModal(); $('#addText').focus(); }
sheet.querySelectorAll('input[name=tier]').forEach(r => r.addEventListener('change', () => { $('#tierHelp').textContent = TIER_HELP[tierNow()]; }));
$('#addCancel').addEventListener('click', () => sheet.close());
$('#howKey').addEventListener('click', () => window.pool.openExternal('https://platform.claude.com/settings/keys'));
$('#howKeyGpt').addEventListener('click', () => window.pool.openExternal('https://platform.openai.com/api-keys'));
$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#addSubmit'); btn.disabled = true; btn.textContent = '확인하는 중';
  const r = await window.pool.addKeys($('#addText').value, tierNow(), $('#addName').value.trim());
  btn.disabled = false; btn.textContent = '추가하기';
  showResults($('#addResults'), r);
  if (r.added && r.results.every(x => x.ok)) setTimeout(() => sheet.close(), 700);
});

// ── 복사·설정 ───────────────────────────────
$('#copyAddr').addEventListener('click', async () => { await window.pool.copy(S.address); toast('주소를 복사했습니다'); });
document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
  const v = { base: S.address, gpt: `${S.address}/v1`, key: 'local', ps: psLine(), psgpt: psGpt() }[b.dataset.copy];
  await window.pool.copy(v); toast('복사했습니다');
}));
$('#autoStart').addEventListener('change', async e => { await window.pool.setAutoStart(e.target.checked); toast(e.target.checked ? '윈도우를 켤 때 자동으로 켭니다' : '자동 실행을 껐습니다'); });

window.pool.onState(s => { S = s; render(); });
window.pool.state().then(s => { S = s; render(); });
setInterval(() => { if (S) renderBay(); }, 15000);   // "n분 전" 같은 글자 갱신


// ── 화면 전환 ──────────────────────────────
function showTab(which) {
  const usage = which === 'usage';
  $('#tabKeys').setAttribute('aria-selected', String(!usage));
  $('#tabUsage').setAttribute('aria-selected', String(usage));
  $('#keysView').hidden = usage; $('#usageView').hidden = !usage;
  if (usage) refreshUsage(true);
}
$('#tabKeys').addEventListener('click', () => showTab('keys'));
$('#tabUsage').addEventListener('click', () => showTab('usage'));

// ── 사용 기록 ──────────────────────────────
let R = null, lastReport = 0;
async function refreshUsage(force) {
  if (!force && Date.now() - lastReport < 2000) return;
  lastReport = Date.now();
  R = await window.pool.report();
  renderUsage();
}
function renderUsage() {
  if (!R || !S) return;
  const m = R.month;
  $('#uMonth').textContent = usd(m.usd);
  $('#uMonthNote').textContent = m.unpriced ? `가격을 모르는 모델 요청 ${m.unpriced}건은 빠져 있어요` : '앱이 계산한 추정치';
  $('#uToday').textContent = `${usd(R.today.usd)} (${R.today.n.toLocaleString('ko-KR')}건)`;
  $('#uReq').textContent = `${m.n.toLocaleString('ko-KR')}건`;
  $('#uTok').textContent = `입력 ${tok(m.in + m.read + m.cw)}, 출력 ${tok(m.out)}`;
  $('#uAll').textContent = R.allTime.since ? `${usd(R.allTime.usd)} (${mdate(R.allTime.since + 'T00:00')}부터)` : '$0.00';
  $('#fine').textContent = `이 앱을 거친 요청만 셉니다. 공식 가격표(${S.pricesAsOf} 기준)로 계산한 추정치라 Console 금액과 조금 다를 수 있어요. 정확히 맞추려면 키의 설정에서 실제 남은 금액을 넣으세요.`;
  // 범례
  const ids = S.keys.map(k => k.id);
  $('#legend').replaceChildren(...S.keys.map(k => { const sp = el('span'); const i = el('i'); i.style.background = colorOf(k.id); sp.append(i, el('span', null, k.name)); return sp; }));
  drawChart(R.series, ids);
  // 키 표
  const kt = $('#keyTable');
  const head = el('tr'); ['키', '이번 주기 사용', '남은 크레딧', '다음 충전', '요청'].forEach((h, i) => { const th = el('th', i ? 'num' : '', h); head.append(th); });
  kt.replaceChildren(el('thead'), el('tbody'));
  kt.tHead.append(head);
  for (const k of S.keys) {
    const cs = R.credit[k.id] || {}; const pk = R.perKey[k.id] || { n: 0 };
    const tr = el('tr');
    const name = el('td'); const sw = el('span', 'sw'); sw.style.background = colorOf(k.id); name.append(sw, el('span', null, k.name));
    if (k.tier === 'paid') name.append(el('span', 'muted', '  유료 예비'));
    const rem = el('td', 'num');
    if (cs.configured) { const b = el('span', 'mini'); const i = el('i', level(cs.ratio)); i.style.width = `${Math.round(cs.ratio * 100)}%`; b.append(i); rem.append(b, el('span', null, `약 ${usd(cs.remaining)} / ${usd(cs.amount)}`)); }
    else if (k.tier === 'paid') { rem.classList.add('dim'); rem.textContent = '해당 없음'; }
    else { const btn = el('button', 'link', '설정하기'); btn.type = 'button'; btn.addEventListener('click', () => openCredit(k.id)); rem.append(btn); }
    tr.append(name, el('td', 'num', usd(cs.configured ? cs.cycleUsd : cs.monthUsd)), rem,
      el('td', 'num', cs.configured ? mdate(cs.nextRefill) : '—'), el('td', 'num', `${pk.n.toLocaleString('ko-KR')}건`));
    kt.tBodies[0].append(tr);
  }
  // 모델 표
  const mt = $('#modelTable');
  const mh = el('tr'); ['모델', '요청', '토큰', '캐시 적중', '사용액'].forEach((h, i) => mh.append(el('th', i ? 'num' : '', h)));
  mt.replaceChildren(el('thead'), el('tbody')); mt.tHead.append(mh);
  const rows = Object.entries(R.models).sort((a, b) => b[1].usd - a[1].usd);
  if (!rows.length) { const tr = el('tr'); const td = el('td', 'muted', '이번 달 기록이 아직 없어요'); td.colSpan = 5; tr.append(td); mt.tBodies[0].append(tr); }
  for (const [model, r] of rows) {
    const tr = el('tr'); mt.tBodies[0].append(tr);
    const prompt = r.in + r.read + r.cw;
    const hit = el('td', 'num', prompt ? `${Math.round((r.read / prompt) * 100)}%` : '—');
    hit.title = '입력 중 캐시에서 싸게 읽은 비율. 같은 키를 계속 쓸수록 높아요';
    const price = el('td', 'num', r.unpriced === r.n ? '가격 모름' : `${r.approx ? '≈' : ''}${usd(r.usd)}`);
    if (r.approx) price.title = '가격표에 없는 새 모델이라 같은 계열 최신 가격으로 추정';
    tr.append(el('td', null, model), el('td', 'num', `${r.n.toLocaleString('ko-KR')}건`), el('td', 'num', tok(r.in + r.read + r.cw + r.out)), hit, price);
  }
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function drawChart(series, ids) {
  const box = $('#chart');
  const W = Math.max(300, box.clientWidth - 24), H = Math.max(160, box.clientHeight - 8);
  const total = series.reduce((a, r) => a + r.total, 0);
  if (!total) { box.replaceChildren(el('div', 'chart-empty', '아직 기록이 없어요. 프로그램이 이 앱을 거쳐 Claude를 부르면 하루 단위로 쌓입니다.')); return; }
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, v); return n; };
  const L = 52, Rm = 8, T = 10, B = 24;
  const max = niceMax(Math.max(...series.map(r => r.total)));
  const pw = W - L - Rm, ph = H - T - B;
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': '최근 30일 하루 사용액 막대 그래프' });
  const grid = mk('g', { class: 'grid' }), axis = mk('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const y = T + ph - (ph * i) / 4;
    grid.append(mk('line', { x1: L, x2: W - Rm, y1: y, y2: y }));
    const t = mk('text', { x: L - 8, y: y + 4, 'text-anchor': 'end' }); t.textContent = usd((max * i) / 4).replace('.00', ''); axis.append(t);
  }
  svg.append(grid, axis);
  const step = pw / series.length, bw = Math.max(4, Math.min(22, step * 0.62));
  const bars = mk('g', {});
  series.forEach((r, i) => {
    const x = L + step * i + (step - bw) / 2;
    let y = T + ph;
    const segs = ids.map(id => [id, r.byKey[id] || 0]).filter(([, v]) => v > 0);
    segs.forEach(([id, v], j) => {
      const h = (v / max) * ph; const top = j === segs.length - 1;
      const gap = j > 0 ? 2 : 0;
      const hh = Math.max(0, h - gap);
      if (hh <= 0) { y -= h; return; }
      const rr = top ? Math.min(4, bw / 2, hh) : 0;
      const yTop = y - h;
      // 위쪽만 둥근 막대
      const d = `M${x},${y - gap} L${x},${yTop + rr} Q${x},${yTop} ${x + rr},${yTop} L${x + bw - rr},${yTop} Q${x + bw},${yTop} ${x + bw},${yTop + rr} L${x + bw},${y - gap} Z`;
      bars.append(mk('path', { d, fill: colorOf(id) }));
      y -= h;
    });
    if (i % 5 === (series.length - 1) % 5) {
      const dd = new Date(r.day + 'T00:00'); const t = mk('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = `${dd.getMonth() + 1}/${dd.getDate()}`; axis.append(t);
    }
    const hit = mk('rect', { class: 'hit', x: L + step * i, y: T, width: step, height: ph, rx: 4 });
    hit.addEventListener('mouseenter', ev => showTip(ev, r, ids));
    hit.addEventListener('mousemove', ev => moveTip(ev));
    hit.addEventListener('mouseleave', () => { $('#tip').hidden = true; });
    bars.append(hit);
  });
  svg.append(bars);
  box.replaceChildren(svg);
}
function showTip(ev, r, ids) {
  const tip = $('#tip'); const d = new Date(r.day + 'T00:00');
  const th = el('div', 'th'); th.append(el('span', null, `${d.getMonth() + 1}월 ${d.getDate()}일`), el('b', null, usd(r.total)));
  const rows = ids.filter(id => r.byKey[id] > 0).map(id => { const row = el('div', 'tr'); const i = el('i'); i.style.background = colorOf(id);
    row.append(i, el('span', null, S.keys.find(k => k.id === id)?.name ?? '삭제된 키'), el('b', null, usd(r.byKey[id]))); return row; });
  tip.replaceChildren(th, ...(rows.length ? rows : [el('div', 'tr', '사용 없음')]), el('div', 'tr', `요청 ${r.n}건`));
  tip.hidden = false; moveTip(ev);
}
function moveTip(ev) {
  const tip = $('#tip'); const host = tip.parentElement.getBoundingClientRect();
  let x = ev.clientX - host.left + 14, y = ev.clientY - host.top - 10;
  if (x + tip.offsetWidth > host.width - 8) x = ev.clientX - host.left - tip.offsetWidth - 14;
  tip.style.left = `${x}px`; tip.style.top = `${Math.max(8, y - tip.offsetHeight / 2)}px`;
}
// 그래프 칸 크기가 바뀌면(창 크기·화면 전환) 그 크기에 맞춰 다시 그린다
let chartSize = '';
new ResizeObserver(() => {
  const b = $('#chart'); const sz = `${b.clientWidth}x${b.clientHeight}`;
  if (sz === chartSize || $('#usageView').hidden || !R) return;
  chartSize = sz; drawChart(R.series, S.keys.map(k => k.id));
}).observe($('#chart'));
$('#exportCsv').addEventListener('click', async () => { const r = await window.pool.exportCsv(); if (r.ok) toast('사용 기록을 저장했습니다'); });

// ── 크레딧 설정 ─────────────────────────────
const csheet = $('#creditSheet'); let creditId = null;
for (let d = 1; d <= 31; d++) { const o = el('option', null, `매달 ${d}일`); o.value = d; $('#refillDay').append(o); }
csheet.querySelectorAll('input[name=amt]').forEach(r => r.addEventListener('change', () => { $('#amtCustom').hidden = r.value !== 'custom' || !r.checked; }));
function openCredit(id) {
  const k = S.keys.find(x => x.id === id); if (!k) return;
  creditId = id;
  $('#creditTitle').textContent = `${k.name} 크레딧 설정`;
  const a = k.credit?.amount ?? (k.tier === 'paid' ? 0 : 200);
  const preset = [0, 100, 200].includes(a) ? String(a) : 'custom';
  csheet.querySelector(`input[name=amt][value="${preset}"]`).checked = true;
  $('#amtCustom').hidden = preset !== 'custom'; $('#amtCustom').value = preset === 'custom' ? a : '';
  $('#refillDay').value = k.credit?.day ?? new Date().getDate();
  $('#calibInput').value = '';
  const cs = k.creditState;
  $('#calibNote').textContent = cs?.calibrated ? `${mdate(cs.calibratedAt)}에 실제 금액으로 맞춘 뒤부터 계산하고 있어요.` : 'Console 결제(Billing) 화면의 Promotional credits 금액을 넣으면 그 시점부터 정확하게 이어서 셉니다.';
  csheet.showModal();
}
$('#creditCancel').addEventListener('click', () => csheet.close());
$('#openBilling').addEventListener('click', () => window.pool.openExternal('https://platform.claude.com/settings/billing'));
$('#creditForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = csheet.querySelector('input[name=amt]:checked').value;
  const amount = v === 'custom' ? Number(String($('#amtCustom').value).replace(/[$,\s]/g, '')) : Number(v);
  const remaining = String($('#calibInput').value).replace(/[$,\s]/g, '');
  await window.pool.setCredit(creditId, amount, Number($('#refillDay').value), remaining === '' ? null : Number(remaining));
  csheet.close(); toast('크레딧 설정을 저장했습니다');
  if (!$('#usageView').hidden) refreshUsage(true);
});


// ── 테마 ────────────────────────────────────
const THEME_LABEL = { system: '자동', light: '밝게', dark: '어둡게' };
function renderTheme() {
  document.documentElement.dataset.theme = S.dark ? 'dark' : 'light';
  $('#themeLabel').textContent = THEME_LABEL[S.settings.theme || 'system'];
  $('#themeBtn').title = `화면: ${THEME_LABEL[S.settings.theme || 'system']} (누르면 바뀜)`;
}
$('#themeBtn').addEventListener('click', async () => {
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(S.settings.theme || 'system') + 1) % 3];
  await window.pool.setTheme(next);
  toast(next === 'system' ? '윈도우 설정을 따라갑니다' : next === 'dark' ? '어두운 화면' : '밝은 화면');
});

// ── 업데이트 ──────────────────────────────────
function renderUpdate() {
  const u = S.update;
  const box = $('#upd');
  if (u?.status === 'ready') {
    box.classList.add('show');
    $('#updText').textContent = `새 버전 ${u.version} 준비됨. 쓰지 않을 때 알아서 적용해요${u.notes ? `: ${u.notes}` : ''}`;
  } else box.classList.remove('show');
  const tail = !u ? '' : u.status === 'latest' ? ', 최신 버전' : u.status === 'ready' ? `, ${u.version} 대기 중` : u.status === 'no-channel' ? ', 업데이트 저장소 준비 전' : u.status === 'error' ? ', 업데이트 확인 실패' : '';
  $('#verText').textContent = `버전 ${S.version}${tail}`;
}
$('#updNow').addEventListener('click', () => window.pool.applyUpdate());
$('#checkUpd').addEventListener('click', async () => {
  const b = $('#checkUpd'); b.disabled = true; b.textContent = '확인 중';
  const u = await window.pool.checkUpdate();
  b.disabled = false; b.textContent = '업데이트 확인';
  toast(u?.status === 'ready' ? `새 버전 ${u.version}을 받아 뒀어요` : u?.status === 'latest' ? '최신 버전이에요' : u?.status === 'no-channel' ? '업데이트 저장소가 아직 없어요' : '업데이트를 확인하지 못했어요');
});


// ── 크레딧 현황 (키 상태 화면 왼쪽 아래) ───────────────────
function renderCredit() {
  const list = $('#creditList');
  const keys = S.keys;
  const month = keys.reduce((a, k) => a + (k.creditState?.monthUsd || 0), 0);
  const byProv = p => keys.filter(k => (k.provider || 'claude') === p).reduce((a, k) => a + (k.creditState?.monthUsd || 0), 0);
  const hasGpt = keys.some(k => k.provider === 'gpt');
  $('#creditTotal').textContent = keys.length ? `이번 달 전체 ${usd(month)}${hasGpt ? ` (Claude ${usd(byProv('claude'))}, GPT ${usd(byProv('gpt'))})` : ''}` : '';
  if (!keys.length) { list.replaceChildren(el('div', 'credit-empty', '키를 추가하면 여기서 크레딧이 얼마나 나갔는지 보여요.')); return; }
  list.replaceChildren(...keys.map(k => {
    const cs = k.creditState || {};
    const row = el('div', 'cr');
    const dot = el('i', 'dot'); dot.style.background = colorOf(k.id);
    const nm = el('div', 'nm', k.name);
    nm.append(el('span', null, k.provider === 'gpt' ? (k.tier === 'paid' ? 'GPT 예비' : 'GPT') : (k.tier === 'paid' ? 'Claude 유료 예비' : 'Claude 크레딧')));
    const amt = el('div', 'amt');
    row.append(dot, nm, amt);
    if (cs.configured) {
      amt.append(el('span', null, '남은 약 '), el('b', null, usd(cs.remaining)), el('span', null, `/ ${usd(cs.amount)}`));
      amt.firstChild.style.marginLeft = '0';
      const track = el('div', 'track'); const left = el('div', `left ${level(cs.ratio)}`); left.style.width = `${Math.round(cs.ratio * 100)}%`; track.append(left);
      let text, warn = false;
      const used = `이번 주기 ${usd(cs.cycleUsd)} 사용, 오늘 ${usd(cs.todayUsd)}`;
      if (cs.remaining <= 0) { text = `다 썼어요. ${mdate(cs.nextRefill)}에 다시 충전돼요`; warn = true; }
      else if (cs.exhaustAt) { text = `${used}. 이 속도면 ${mdate(cs.exhaustAt)}쯤 바닥나요 (충전 ${mdate(cs.nextRefill)})`; warn = true; }
      else if (cs.dailyRate > 0) text = `${used}. 이 속도면 충전일(${mdate(cs.nextRefill)})에 약 ${usd(cs.projectedAtRefill)} 남아요`;
      else text = `${used}. 충전일 ${mdate(cs.nextRefill)}`;
      const say = el('div', `say${warn ? ' warn2' : ''}`, text);
      row.append(track, say);
    } else {
      amt.append(el('span', null, '이번 달 '), el('b', null, usd(cs.monthUsd || 0)));
      amt.firstChild.style.marginLeft = '0';
      const say = el('div', 'say', `오늘 ${usd(cs.todayUsd || 0)}. `);
      if (k.tier !== 'paid') { const b = el('button', 'link', '남은 크레딧도 보기'); b.type = 'button'; b.addEventListener('click', () => openCredit(k.id)); say.append(b); }
      row.append(say);
    }
    return row;
  }));
}

// ── 기록 저장 폴더 ──────────────────────────────
const shortPath = p => p.length > 44 ? `${p.slice(0, 16)}…${p.slice(-26)}` : p;
function renderStore() {
  const m = S.mirror || {}; const dir = S.settings.dataDir;
  $('#storePath').textContent = dir ? shortPath(dir) : '이 PC에만 저장 중';
  $('#storePath').title = dir || '';
  $('#pickDir').textContent = dir ? '바꾸기' : '폴더 지정';
  $('#openDir').hidden = !dir; $('#clearDir').hidden = !dir;
  const st = $('#storeState');
  st.className = 'store-state' + (dir ? (m.ok === false ? ' bad' : m.ok ? ' ok' : '') : '');
  st.textContent = !dir ? '' : m.ok === false ? '연결 안 됨' : m.savedAt ? `${hhmm(m.savedAt)} 저장됨` : '확인 중';
  $('#storeNote').textContent = !dir ? 'NAS 폴더를 지정하면 사용 기록과 월별 엑셀(CSV)이 거기에 함께 저장돼요'
    : m.ok === false ? m.error : '사용 기록과 이번 달 엑셀(CSV)을 이 폴더에 계속 저장해요';
}
$('#pickDir').addEventListener('click', async () => {
  const r = await window.pool.chooseDataDir();
  if (r?.canceled) return;
  toast(r?.ok ? '이 폴더에 기록을 저장해요' : (r?.error || '폴더를 지정하지 못했어요'));
});
$('#openDir').addEventListener('click', () => window.pool.openDataDir());
$('#clearDir').addEventListener('click', async () => { await window.pool.clearDataDir(); toast('이제 이 PC에만 저장해요'); });


// ── 크레딧 현황 탭: 건별 요금(기본) / 호출 기록 / 키별 요약 ─────────────
let ctab = 'charges';
document.querySelectorAll('[data-ctab]').forEach(b => b.addEventListener('click', () => {
  ctab = b.dataset.ctab;
  document.querySelectorAll('[data-ctab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  $('#ctabCharges').hidden = ctab !== 'charges'; $('#ctabCalls').hidden = ctab !== 'calls'; $('#ctabSummary').hidden = ctab !== 'summary';
}));
const nameNow = c => S.keys.find(k => k.id === c.id)?.name ?? c.name ?? '삭제된 키';
function renderCharges() {
  const ol = $('#chargeList');
  const list = S.charges || [];
  if (!list.length) {
    ol.replaceChildren(el('li', 'charges-empty', '아직 요금이 나간 호출이 없어요. 프로그램이 이 앱 주소로 Claude·GPT를 부르면 한 건씩 여기에 남아요.'));
    return;
  }
  // 날짜별로 묶고, 날짜 줄에 그날 합계를 붙인다
  const out = []; let curDay = null;
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const dayTotals = {};
  for (const c of list) { const k = dayKey(c.at); dayTotals[k] = (dayTotals[k] || 0) + (c.usd || 0); }
  for (const c of list) {
    const k = dayKey(c.at);
    if (k !== curDay) {
      curDay = k;
      const d = new Date(c.at); const today = dayKey(Date.now()) === k;
      const li = el('li', 'day', today ? '오늘' : `${d.getMonth() + 1}월 ${d.getDate()}일`);
      li.append(el('b', null, usd(dayTotals[k])));
      out.push(li);
    }
    const li = el('li');
    const key = el('span', 'k'); const dot = el('i'); dot.style.background = colorOf(c.id); key.append(dot, el('span', null, nameNow(c)));
    li.append(el('span', 't', hhmmss(c.at)), key, el('span', 'm', c.model || '—'),
      el('span', 'num', c.in == null ? '—' : tok(c.in)), el('span', 'num', c.out == null ? '—' : tok(c.out)),
      el('span', 'num usd', c.usd == null ? '알 수 없음' : `${c.approx ? '≈' : ''}${usd(c.usd)}`));
    if (c.approx) li.title = '아직 가격표에 없는 새 모델이라 같은 계열 최신 가격으로 추정한 요금이에요';
    if (c.read) li.title = `입력 중 ${tok(c.read)}은 캐시에서 싸게 읽음`;
    out.push(li);
  }
  ol.replaceChildren(...out);
}
