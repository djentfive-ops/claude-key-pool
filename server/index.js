// OVIS Gate 서버(옛 이름 Claude 키 묶음) — Render 에서 24시간 돈다.
//   · 오비스 서버(및 다른 서버 프로그램)가 Claude·GPT 를 부르는 주소. API 키 칸에는 PROXY_TOKEN 을 넣는다.
//   · 키 고르기·소진 시 넘기기·요금 계산·기록 저장은 전부 여기서. PC 앱은 /admin/... 으로 보고 관리만 한다.
//   · 키·기록은 DATA_DIR(영구 디스크)에 저장 — 재시작·재배포해도 남는다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { KeyPool, testKey, providerOfKey } = require('./lib/proxy-core');
const { createUsageStore } = require('./lib/usage-store');
const pricing = require('./lib/pricing');
const { createKeyStore } = require('./keystore');

const VERSION = require('./package.json').version;
const ENV = process.env;
const PORT = Number(ENV.PORT || 10000);
const DATA_DIR = ENV.DATA_DIR || path.join(__dirname, 'data');
const SECRET = ENV.KEYPOOL_SECRET || '';
const ADMIN_TOKEN = ENV.ADMIN_TOKEN || '';
const PROXY_TOKEN = ENV.PROXY_TOKEN || '';
const UPSTREAM = ENV.UPSTREAM_ANTHROPIC || 'https://api.anthropic.com';
const UPSTREAM_GPT = ENV.UPSTREAM_OPENAI || 'https://api.openai.com';
const PRICES_BASE = ENV.PRICES_BASE || 'https://raw.githubusercontent.com/djentfive-ops/claude-key-pool/main';
const STARTED_AT = Date.now();

for (const [name, v] of [['KEYPOOL_SECRET', SECRET], ['ADMIN_TOKEN', ADMIN_TOKEN], ['PROXY_TOKEN', PROXY_TOKEN]]) {
  if (v.length < 16) { console.error(`[keypool] 환경변수 ${name} 가 없거나 너무 짧습니다(16자 이상). Render 의 Environment 에서 넣어 주세요.`); process.exit(1); }
}

const keystore = createKeyStore(path.join(DATA_DIR, 'keys.json'), SECRET);
const usage = createUsageStore(path.join(DATA_DIR, 'usage.json'), { nameOf: id => keystore.meta().find(m => m.id === id)?.name ?? '삭제된 키' });

// ── 가격표: 디스크에 둔 것 → 업데이트 저장소의 prices.json(6시간마다) ──
const pricesFile = path.join(DATA_DIR, 'prices.json');
try { pricing.applyRemotePrices(JSON.parse(fs.readFileSync(pricesFile, 'utf8'))); } catch {}
usage.reprice(pricing.priceTokens);
async function refreshPrices() {
  try {
    const r = await fetch(`${PRICES_BASE}/prices.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const j = await r.json();
    if (pricing.applyRemotePrices(j)) { fs.writeFileSync(pricesFile, JSON.stringify(j)); usage.reprice(pricing.priceTokens); }
  } catch {}
}

// ── 관리 주소(/admin/...) — PC 앱만 쓴다. ADMIN_TOKEN 이 맞아야 한다 ──
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function readJson(req, limit = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('요청이 너무 큽니다'); chunks.push(c); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const KEY_RE = /sk-[A-Za-z0-9_\-]{20,}/g;
function state() {
  const meta = new Map(keystore.meta().map(m => [m.id, m]));
  return {
    version: VERSION, startedAt: STARTED_AT, pricesAsOf: pricing.PRICES_AS_OF, proxyToken: PROXY_TOKEN,
    keys: pool.snapshot().map(k => ({ ...k, credit: meta.get(k.id)?.credit ?? null, creditState: usage.creditState(k.id, meta.get(k.id)?.credit) })),
    log: usage.recentLog(150), charges: usage.recentCharges(300),
  };
}
async function addKeys({ text, tier, name, skipTest = false }) {
  const found = [...new Set(String(text || '').match(KEY_RE) || [])];
  if (!found.length) return { added: 0, results: [{ ok: false, message: 'sk- 로 시작하는 Claude 또는 GPT 키를 붙여넣어 주세요' }] };
  const results = []; let added = 0;
  for (const [i, key] of found.entries()) {
    const tail = key.slice(-4);
    if (keystore.hasKey(key)) { results.push({ tail, ok: false, message: '이미 서버에 있는 키예요' }); continue; }
    if (/^sk-ant-admin/.test(key)) { results.push({ tail, ok: false, message: '관리자(Admin) 키는 요청에 쓸 수 없어요' }); continue; }
    const provider = providerOfKey(key); const kind = provider === 'gpt' ? 'GPT' : 'Claude';
    const t = skipTest || ENV.SKIP_KEY_TEST ? { ok: true } : await testKey(key, provider === 'gpt' ? UPSTREAM_GPT : UPSTREAM, provider);
    if (!t.ok) { results.push({ tail, ok: false, message: `${kind} 키: ${t.message}` }); continue; }
    keystore.add({ key, provider, tier, name: found.length > 1 && name ? `${name} ${i + 1}` : name });
    added++; results.push({ tail, ok: true, message: `${kind} 키로 서버에 추가함` });
  }
  reloadKeys();
  return { added, results };
}
function csvFor(kind, month) {
  const nameOf = id => keystore.meta().find(m => m.id === id)?.name ?? '삭제된 키';
  return kind === 'charges' ? usage.chargesCsv(nameOf, month) : usage.csv(nameOf, month);
}

async function adminRoute(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/admin/')) return false;
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!eq(auth, ADMIN_TOKEN)) { await new Promise(r => setTimeout(r, 400)); req.resume(); send(res, 401, { error: '관리 토큰이 맞지 않습니다' }); return true; }
  const m = req.method; const p = url.pathname;
  const keyId = (p.match(/^\/admin\/keys\/([\w-]+)/) || [])[1];

  if (m === 'GET' && p === '/admin/state') { send(res, 200, state()); return true; }
  if (m === 'GET' && p === '/admin/report') { send(res, 200, usage.report(keystore.meta())); return true; }
  if (m === 'GET' && p === '/admin/export') { send(res, 200, { exportedAt: Date.now(), names: Object.fromEntries(keystore.meta().map(k => [k.id, k.name])), data: usage._data() }); return true; }
  if (m === 'GET' && p === '/admin/csv') {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
    res.end(csvFor(url.searchParams.get('kind'), url.searchParams.get('month') || null)); return true;
  }
  if (m === 'POST' && p === '/admin/keys') { send(res, 200, await addKeys(await readJson(req))); return true; }
  if (m === 'POST' && p === '/admin/import') {
    // PC 앱이 가진 키를 한꺼번에 서버로(이름·종류·크레딧 설정 포함). 이미 있는 키는 건너뛴다.
    const { keys = [] } = await readJson(req, 2_000_000);
    let added = 0, skipped = 0;
    for (const k of keys) {
      if (!k?.key || !/^sk-/.test(k.key) || keystore.hasKey(k.key)) { skipped++; continue; }
      keystore.add({ key: k.key, tier: k.tier, provider: k.provider || providerOfKey(k.key), name: k.name, credit: k.credit || null }); added++;
    }
    reloadKeys(); send(res, 200, { added, skipped }); return true;
  }
  if (keyId) {
    if (m === 'PATCH' && p === `/admin/keys/${keyId}`) {
      const b = await readJson(req); const patch = {};
      if (typeof b.name === 'string') patch.name = b.name.trim().slice(0, 24) || '이름 없음';
      if (b.tier) patch.tier = b.tier === 'paid' ? 'paid' : 'credit';
      if ('credit' in b) { const a = Number(b.credit?.amount), d = Number(b.credit?.day); patch.credit = a > 0 && d >= 1 && d <= 31 ? { amount: a, day: Math.round(d) } : null; }
      if (!keystore.update(keyId, patch)) { send(res, 404, { error: '키를 찾지 못했습니다' }); return true; }
      if (b.remaining != null && b.remaining !== '' && Number.isFinite(Number(b.remaining))) usage.calibrate(keyId, Number(b.remaining));
      reloadKeys(); send(res, 200, { ok: true }); return true;
    }
    if (m === 'DELETE' && p === `/admin/keys/${keyId}`) { const ok = keystore.remove(keyId); reloadKeys(); send(res, ok ? 200 : 404, { ok }); return true; }
    if (m === 'POST' && p === `/admin/keys/${keyId}/move`) { const b = await readJson(req); keystore.move(keyId, Number(b.dir) < 0 ? -1 : 1); reloadKeys(); send(res, 200, { ok: true }); return true; }
    if (m === 'POST' && p === `/admin/keys/${keyId}/wake`) { pool.wake(keyId); send(res, 200, { ok: true }); return true; }
    if (m === 'DELETE' && p === `/admin/keys/${keyId}/calib`) { usage.clearCalib(keyId); send(res, 200, { ok: true }); return true; }
    if (m === 'POST' && p === `/admin/keys/${keyId}/test`) {
      const k = keystore.keys().find(x => x.id === keyId);
      if (!k) { send(res, 404, { ok: false, message: '키를 찾지 못했습니다' }); return true; }
      const r = await testKey(k.key, k.provider === 'gpt' ? UPSTREAM_GPT : UPSTREAM, k.provider);
      if (r.ok) pool.wake(keyId);
      send(res, 200, r); return true;
    }
  }
  send(res, 404, { error: '없는 관리 주소입니다' });
  return true;
}

// ── 중계 엔진 ──
const pool = new KeyPool({ port: PORT, host: '0.0.0.0', upstream: UPSTREAM, upstreamGpt: UPSTREAM_GPT, serverMode: true, clientToken: PROXY_TOKEN, route: adminRoute });
function reloadKeys() { pool.setKeys(keystore.keys()); }
pool.on('log', e => { keystore.counts(pool.snapshot()); usage.addLog(e); });
pool.on('usage', ({ id, model, cost }) => usage.record({ keyId: id, model, cost }));
pool.on('rest', ({ id, name, kind }) => {
  console.log(`[keypool] ${name} 쉬는 중(${kind})`);
  if (kind === 'exhausted') { const m = keystore.meta().find(k => k.id === id); if (m?.tier === 'credit' && (m.provider === 'claude' || m.credit)) usage.calibrate(id, 0); }
});
pool.on('revived', ({ id }) => { const c = usage.calibOf(id); if (c && c.remaining === 0) usage.clearCalib(id); });

reloadKeys();
pool.start().then(() => {
  const k = keystore.meta();
  console.log(`[keypool] ${VERSION} 켜짐 — 포트 ${PORT}, Claude 키 ${k.filter(x => x.provider === 'claude').length}개, GPT 키 ${k.filter(x => x.provider === 'gpt').length}개, 저장 위치 ${DATA_DIR}`);
});
setTimeout(refreshPrices, 5_000).unref?.();
setInterval(refreshPrices, 6 * 60 * 60_000).unref?.();

// 배포·재시작 때 기록을 마저 쓰고 끈다
function shutdown(sig) {
  console.log(`[keypool] ${sig} — 기록 저장 후 종료`);
  try { usage.flush(); keystore.flush(); } catch {}
  pool.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
