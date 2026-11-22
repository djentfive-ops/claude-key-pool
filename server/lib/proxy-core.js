// 키 묶음 프록시 엔진 — 앱 안에서 돈다. 화면(UI)은 이벤트로 상태를 받는다.
// 규칙: 크레딧 키를 앞 순서부터 하나씩 끝까지(캐시 유지) → 소진·한도·키 오류·과속이면 그 키를 쉬게 하고 같은 요청을 다음 키로 → 크레딧이 다 쉬면 유료 키.
// 요청 내용은 기록하지 않는다(모델 이름·결과·걸린 시간만).
'use strict';
const http = require('node:http');
const { Readable, Transform } = require('node:stream');
const { costOf, costOfGpt } = require('./pricing');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const COOLDOWN_MS = { exhausted: 30 * 60_000, auth: 60 * 60_000, rateDefault: 30_000, rateMax: 10 * 60_000 };
const KEY_UNUSABLE_400 = /credit balance|usage limit|spend limit/i;
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'x-api-key', 'authorization', 'accept-encoding',
  'keep-alive', 'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'upgrade', 'expect', 'openai-organization', 'openai-project']);

// 어느 쪽 요청인가 — 주소 하나로 Claude·GPT 를 같이 받는다.
//   /openai/... 로 오면 GPT(접두어 떼고 전달) · OpenAI 전용 경로면 GPT · /v1/messages 면 Claude
//   /v1/models 처럼 양쪽에 다 있는 경로는 헤더로 가른다(Anthropic SDK 는 anthropic-version·x-api-key 를 보낸다)
const GPT_PATH = /^\/v1\/(chat\/completions|completions|responses|embeddings|moderations|audio|images|realtime|assistants|threads|vector_stores|fine_tuning|batches|uploads|evals|conversations|containers)(\/|$)/;
function routeOf(req) {
  const url = req.url || '/';
  const p = url.split('?')[0];
  if (p === '/openai' || p.startsWith('/openai/')) return { provider: 'gpt', url: url.slice(7) || '/' };
  if (GPT_PATH.test(p)) return { provider: 'gpt', url };
  if (/^\/v1\/(messages|complete)(\/|$)/.test(p)) return { provider: 'claude', url };
  if (req.headers['anthropic-version'] || req.headers['x-api-key']) return { provider: 'claude', url };
  if (req.headers['authorization']) return { provider: 'gpt', url };
  return { provider: 'claude', url };
}
const GPT_METERED = /^\/v1\/(chat\/completions|responses|completions|embeddings)\/?$/;
const CLAUDE_METERED = /^\/v1\/messages\/?$/;
const OPENAI_UNUSABLE = /insufficient_quota|billing|hard[_ ]limit|quota/i;
function gptResetMs(h) {
  // OpenAI: retry-after(초) 또는 x-ratelimit-reset-requests/tokens ('1s', '6m0s', '250ms')
  const ra = retryAfterMs(h.get('retry-after'));
  if (ra != null) return ra;
  const parse = v => { if (!v) return null; let ms = 0; const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g; let m, ok = false;
    while ((m = re.exec(v))) { ok = true; ms += Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]; } return ok ? ms : null; };
  const a = parse(h.get('x-ratelimit-reset-requests')), b = parse(h.get('x-ratelimit-reset-tokens'));
  const v = Math.max(a ?? 0, b ?? 0);
  return v ? Math.min(v, COOLDOWN_MS.rateMax) : null;
}
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

function retryAfterMs(v) {
  if (v == null) return null;
  const sec = Number(v);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, COOLDOWN_MS.rateMax);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), COOLDOWN_MS.rateMax) : null;
}

async function judge(res, provider = 'claude') {
  const status = res.status;
  const ra = res.headers.get('retry-after');
  if (status < 400) return { kind: 'ok' };
  if (provider === 'gpt') {
    if (status === 401 || status === 403) return { kind: 'auth' };
    if (status === 429 || status === 400 || status === 402) {
      const text = await res.text();
      let code = '', msg = '';
      try { const e = JSON.parse(text)?.error; code = String(e?.code ?? e?.type ?? ''); msg = String(e?.message ?? ''); } catch {}
      if (status === 402 || OPENAI_UNUSABLE.test(code) || (status !== 400 && OPENAI_UNUSABLE.test(msg)) || (status === 400 && /billing|hard limit/i.test(msg)))
        return { kind: 'exhausted', text };
      if (status === 429) return { kind: 'rate', waitMs: gptResetMs(res.headers) ?? COOLDOWN_MS.rateDefault, text };
      return { kind: 'final', text };
    }
    return { kind: 'final' };
  }
  if (status === 402) return { kind: 'exhausted' };
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (status === 429) return ra == null ? { kind: 'exhausted' } : { kind: 'rate', waitMs: retryAfterMs(ra) ?? COOLDOWN_MS.rateDefault };
  if (status === 400) {
    const text = await res.text();
    let unusable = false;
    try {
      const e = JSON.parse(text)?.error;
      unusable = e?.type === 'invalid_request_error' && KEY_UNUSABLE_400.test(String(e?.message ?? ''));
    } catch {}
    return { kind: unusable ? 'exhausted' : 'final', text };
  }
  return { kind: 'final' };
}

// 응답에서 토큰 사용량만 뽑는다(내용은 보지 않음). SSE 는 message_start / message_delta 의 usage, JSON 은 본문 usage.
function usageTap(contentType, provider = 'claude') {
  const isSse = /event-stream/.test(contentType || '');
  const out = { usage: {}, model: null };
  const merge = u => { if (!u) return; for (const [k, v] of Object.entries(u)) {
    if (typeof v === 'number') out.usage[k] = Math.max(out.usage[k] || 0, v);
    else if (v && typeof v === 'object') { out.usage[k] ||= {}; for (const [a, b] of Object.entries(v)) if (typeof b === 'number') out.usage[k][a] = Math.max(out.usage[k][a] || 0, b); }
  } };
  let buf = '', size = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      if (isSse) {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:') || !line.includes('usage')) continue;
          try {
            const d = JSON.parse(line.slice(5));
            if (d.message) { merge(d.message.usage); out.model ||= d.message.model; }        // Claude message_start
            if (d.response) { merge(d.response.usage); out.model ||= d.response.model; }    // GPT responses: response.completed
            merge(d.usage); if (provider === 'gpt' && d.model) out.model ||= d.model;        // Claude message_delta · GPT chat 마지막 조각
          } catch {}
        }
      } else if (size < 8_000_000) { buf += chunk.toString('utf8'); size += chunk.length; }
      cb(null, chunk);
    },
    flush(cb) {
      if (!isSse) { try { const j = JSON.parse(buf); merge(j.usage); out.model = j.model || null; } catch {} }
      buf = ''; cb();
    },
  });
  t.result = out;
  return t;
}

class KeyPool extends EventEmitter {
  /**
   * serverMode: 클라우드(Render)에서 돌 때 — 상태 페이지(/_pool.json)와 주소 안내를 숨기고 /healthz 를 연다.
   * clientToken: 정하면 요청의 API 키 칸(x-api-key 또는 Bearer)이 이 값과 같아야만 중계한다(오비스 서버 전용 접속 토큰).
   * route: (req, res) => Promise<boolean> — 관리용 주소(/admin/...)를 먼저 처리할 기회. true 를 돌려주면 중계하지 않는다.
   */
  constructor({ port = 4100, host = '127.0.0.1', upstream = 'https://api.anthropic.com', upstreamGpt = 'https://api.openai.com', serverMode = false, clientToken = null, route = null } = {}) {
    super();
    this.port = port; this.host = host; this.upstream = upstream.replace(/\/+$/, ''); this.upstreamGpt = upstreamGpt.replace(/\/+$/, '');
    this.serverMode = serverMode; this.clientToken = clientToken || null; this.route = route;
    this.slots = []; this.cursor = 0; this.server = null; this.listening = false; this.log = [];
  }

  tokenOk(req) {
    if (!this.clientToken) return true;
    const h = req.headers;
    const got = String(h['x-api-key'] || String(h.authorization || '').replace(/^Bearer\s+/i, ''));
    const a = Buffer.from(got), b = Buffer.from(this.clientToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** keys: [{id, key, tier:'credit'|'paid', name, uses, fails}] — 순서 = 우선순위. 쉬는 상태는 같은 id 면 이어받는다. */
  setKeys(keys) {
    const old = new Map(this.slots.map(s => [s.id, s]));
    this.slots = keys.map(k => {
      const o = old.get(k.id);
      return { id: k.id, key: k.key, tier: k.tier, provider: k.provider || 'claude', name: k.name, uses: k.uses ?? o?.uses ?? 0, fails: k.fails ?? o?.fails ?? 0,
        until: o?.until ?? 0, reason: o?.reason ?? null, busy: o?.busy ?? 0, lastAt: o?.lastAt ?? 0, recent: o?.recent ?? [] };
    });
    this.changed();
  }

  changed() { this.emit('change'); }

  // 한 키를 다 쓸 때까지 계속 쓴다(앞 순서부터). 프롬프트 캐시는 계정(조직)마다 따로라서,
  // 요청마다 키를 바꾸면 캐시가 매번 깨져 비용이 늘어난다 — 바꾸는 건 그 키가 쉬어야 할 때뿐.
  order(provider = 'claude') {
    const t = Date.now();
    const mine = this.slots.filter(s => s.provider === provider);
    const ready = mine.filter(s => s.until <= t);
    const queue = [...ready.filter(s => s.tier === 'credit'), ...ready.filter(s => s.tier === 'paid')];
    if (queue.length) return queue;
    const soonest = [...mine].sort((a, b) => a.until - b.until)[0];
    return soonest ? [soonest] : [];
  }

  rest(slot, kind, waitMs) {
    const ms = kind === 'rate' ? waitMs : COOLDOWN_MS[kind];
    const wasReady = slot.until <= Date.now();
    slot.until = Date.now() + ms;
    slot.reason = kind;
    if (wasReady) this.emit('rest', { id: slot.id, name: slot.name, kind, minutes: Math.max(1, Math.round(ms / 60_000)) });
  }

  /** 지금 쉬는 키를 바로 다시 쓸 수 있게(사용자가 "다시 시도"를 눌렀을 때). */
  wake(id) {
    const s = this.slots.find(x => x.id === id);
    if (s) { s.until = 0; s.reason = null; this.changed(); }
  }

  record(slot, ok) {
    if (!slot) return;
    slot.recent.push(ok ? 1 : 0);
    if (slot.recent.length > 24) slot.recent.shift();
    slot.lastAt = Date.now();
  }

  pushLog(entry) {
    this.log.unshift({ at: Date.now(), ...entry });
    if (this.log.length > 80) this.log.pop();
    this.emit('log', this.log[0]);
  }

  snapshot() {
    const t = Date.now();
    return this.slots.map(s => ({
      id: s.id, name: s.name, tier: s.tier, provider: s.provider, tail: s.key.slice(-4),
      state: s.busy > 0 ? 'live' : s.until > t ? (s.reason ?? 'exhausted') : 'ready',
      until: s.until > t ? s.until : null, uses: s.uses, fails: s.fails, recent: s.recent.slice(), lastAt: s.lastAt,
    }));
  }

  async handle(req, res) {
    const started = Date.now();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    let model = null;
    if (body) { try { model = JSON.parse(body.toString('utf8')).model ?? null; } catch {} }
    const route = routeOf(req);
    const provider = route.provider;
    const path = route.url.split('?')[0];
    const label = provider === 'gpt' ? 'GPT' : 'Claude';

    if (!this.slots.some(s => s.provider === provider)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      const message = `Claude 키 묶음: 등록된 ${label} 키가 없습니다`;
      res.end(JSON.stringify(provider === 'gpt' ? { error: { message, type: 'server_error', code: 'no_keys' } } : { type: 'error', error: { type: 'api_error', message } }));
      this.pushLog({ name: '—', provider, path, model, status: 503, ms: 0, note: `${label} 키 없음` });
      return;
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k.toLowerCase())) headers[k] = v;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    let last = null; const hops = [];
    const base = provider === 'gpt' ? this.upstreamGpt : this.upstream;
    for (const slot of this.order(provider)) {
      slot.busy++; this.changed();
      let up, v;
      try {
        const auth = provider === 'gpt' ? { authorization: `Bearer ${slot.key}` } : { 'x-api-key': slot.key };
        up = await fetch(base + route.url, { method: req.method, headers: { ...headers, ...auth }, body, signal: abort.signal, redirect: 'manual' });
        v = await judge(up, provider);
      } catch (e) {
        slot.busy--; this.changed();
        throw e;
      }
      if (v.kind === 'ok' || v.kind === 'final') {
        const out = {};
        up.headers.forEach((val, k) => { if (!DROP_RES.has(k)) out[k] = val; });
        res.writeHead(up.status, out);
        const metered = v.kind === 'ok' && req.method === 'POST' && (provider === 'gpt' ? GPT_METERED : CLAUDE_METERED).test(path);
        const tap = metered ? usageTap(up.headers.get('content-type'), provider) : null;
        let finished = false;
        const done = () => {
          if (finished) return; finished = true;
          slot.busy = Math.max(0, slot.busy - 1);
          let cost = null;
          if (v.kind === 'ok') {
            const wasResting = slot.reason === 'exhausted';
            slot.uses++; slot.reason = null;
            if (wasResting) this.emit('revived', { id: slot.id });
          }
          if (tap && Object.keys(tap.result.usage).length) {
            const m = tap.result.model || model;
            cost = provider === 'gpt' ? costOfGpt(m, tap.result.usage) : costOf(m, tap.result.usage);
            this.emit('usage', { id: slot.id, model: m, cost });
          }
          this.record(slot, v.kind === 'ok');
          this.pushLog({ name: slot.name, id: slot.id, provider, path, model: tap?.result.model || model, status: up.status, ms: Date.now() - started, hops, usd: cost?.usd ?? null,
            tokens: cost ? cost.usage.input + cost.usage.read + cost.usage.cwTotal + cost.usage.output : null,
            tokIn: cost ? cost.usage.input + cost.usage.read + cost.usage.cwTotal : null, tokOut: cost ? cost.usage.output : null,
            tokRead: cost ? cost.usage.read : null, tokCw: cost ? cost.usage.cwTotal : null, approx: Boolean(cost?.approx), charged: Boolean(tap) && v.kind === 'ok' });
          this.changed();
        };
        if (v.text != null) { res.end(v.text); done(); return; }
        if (!up.body) { res.end(); done(); return; }
        const stream = Readable.fromWeb(up.body);
        stream.on('error', () => res.destroy());
        res.on('close', done);
        if (tap) { tap.on('end', done); stream.pipe(tap).pipe(res); }
        else stream.pipe(res);
        return;
      }
      slot.busy--; slot.fails++; this.record(slot, false);
      const text = v.text ?? await up.text().catch(() => '');
      last = { status: up.status, headers: up.headers, text };
      hops.push({ name: slot.name, kind: v.kind });
      this.rest(slot, v.kind, v.waitMs);
      this.changed();
    }
    const out = {};
    last?.headers?.forEach((val, k) => { if (!DROP_RES.has(k)) out[k] = val; });
    res.writeHead(last?.status ?? 503, out);
    res.end(last?.text ?? '');
    this.pushLog({ name: hops.at(-1)?.name ?? '—', provider, path, model, status: last?.status ?? 503, ms: Date.now() - started, hops, note: '쓸 수 있는 키 없음' });
    this.emit('allDown', { provider });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const h = req.headers;
        if (this.serverMode && req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('ok');
        }
        if (this.route) {
          try { if (await this.route(req, res)) return; }
          catch (e) { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e?.message || e) })); } return; }
        }
        // 브라우저로 주소를 열었을 때 — Anthropic/OpenAI 로 보내지 않고 안내만 보여준다
        if (!this.serverMode && req.method === 'GET' && /text\/html/.test(h.accept || '') && !h['x-api-key'] && !h.authorization && !h['anthropic-version']) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(`<!doctype html><meta charset="utf-8"><title>Claude 키 묶음</title><body style="font-family:system-ui,sans-serif;padding:40px;max-width:560px;line-height:1.6;color:#1A2233">
<h2 style="margin:0 0 8px">Claude 키 묶음이 켜져 있어요</h2><p>이 주소는 <b>프로그램이 쓰는 주소</b>예요. 브라우저로 열 곳은 아니에요.<br>키 상태와 크레딧 현황은 <b>Claude 키 묶음 앱 창</b>에서 보세요(작업 표시줄 오른쪽 아래 아이콘).</p>
<p style="color:#667085">Claude 프로그램: http://${this.host}:${this.port} &nbsp; GPT 프로그램: http://${this.host}:${this.port}/v1 &nbsp; API 키 칸: local</p></body>`);
        }
        if (!this.serverMode && req.method === 'GET' && req.url === '/_pool.json') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(this.snapshot()));
        }
        if (!this.tokenOk(req)) {
          // 접속 토큰이 틀림 — 진짜 키를 쓰지 않고 바로 거절(오비스 서버 설정 실수를 기록으로 남김)
          const r = routeOf(req);
          this.pushLog({ name: '—', provider: r.provider, path: r.url.split('?')[0], model: null, status: 401, ms: 0, note: '접속 토큰이 틀림' });
          req.resume();
          res.writeHead(401, { 'content-type': 'application/json' });
          const message = 'Claude 키 묶음 서버: 접속 토큰이 맞지 않습니다';
          return res.end(JSON.stringify(r.provider === 'gpt' ? { error: { message, type: 'invalid_request_error', code: 'invalid_api_key' } } : { type: 'error', error: { type: 'authentication_error', message } }));
        }
        this.handle(req, res).catch(e => {
          if (e?.name === 'AbortError') return;
          this.pushLog({ name: '—', path: (req.url || '/').split('?')[0], model: null, status: 502, ms: 0, note: '인터넷 연결 실패' });
          if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Claude 키 묶음: Anthropic 서버에 연결하지 못했습니다' } })); }
          else res.destroy();
        });
      });
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => { this.listening = true; this.changed(); resolve(); });
    });
  }

  stop() { return new Promise(r => { if (!this.server) return r(); this.server.close(() => r()); this.listening = false; }); }
}

/** 키가 살아 있는지 확인(무료 호출: 모델 목록). 크레딧 잔액은 API로 알 수 없다. */
async function testKey(key, upstream = 'https://api.anthropic.com', provider = 'claude') {
  try {
    const headers = provider === 'gpt' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const r = await fetch(upstream.replace(/\/+$/, '') + (provider === 'gpt' ? '/v1/models' : '/v1/models?limit=1'), { headers, signal: AbortSignal.timeout(15000) });
    await r.body?.cancel?.().catch?.(() => {});
    if (r.ok) return { ok: true, message: '정상 키입니다' };
    if (r.status === 401) return { ok: false, message: '키가 올바르지 않습니다. 복사할 때 잘렸는지 확인하세요' };
    if (r.status === 403) return { ok: false, message: '이 키는 권한이 없습니다' };
    return { ok: false, message: `Anthropic 응답 ${r.status} — 잠시 뒤 다시 확인하세요` };
  } catch {
    return { ok: false, message: '인터넷 연결을 확인하세요' };
  }
}

/** 키 모양으로 종류 판단: sk-ant- = Claude, 그 밖의 sk- = GPT */
const providerOfKey = key => (/^sk-ant-/.test(key) ? 'claude' : 'gpt');

module.exports = { KeyPool, testKey, providerOfKey, routeOf, COOLDOWN_MS };
