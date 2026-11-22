// 공식 가격표(USD / 100만 토큰) — platform.claude.com/docs/en/about-claude/pricing 기준. 2026-11-22 갱신(Fable·Mythos 5.2 추가).
// 표에 없는 새 버전은 같은 계열의 최신 가격으로 '추정'하고, 업데이트 저장소의 prices.json 으로 앱 업데이트 없이 덮어쓸 수 있다.
// Anthropic 은 남은 크레딧을 API 로 알려주지 않는다 → 응답에 실린 토큰 사용량 × 이 가격으로 앱이 직접 계산한다(추정치).
'use strict';

const P = (input, cw5, read, output) => ({ input, cw5, cw1h: input * 2, read, output });
const TABLE = {
  'fable-5.2': P(8, 10, 0.20, 40), 'mythos-5.2': P(8, 10, 0.20, 40),
  'fable-5.1': P(10, 12.5, 0.25, 50), 'mythos-5.1': P(10, 12.5, 0.25, 50),
  'fable-5': P(10, 12.5, 1, 50), 'mythos-5': P(10, 12.5, 1, 50),
  'opus-5.5': P(4, 5, 0.2, 20), 'opus-5': P(5, 6.25, 0.5, 25),
  'opus-4.8': P(5, 6.25, 0.5, 25), 'opus-4.7': P(5, 6.25, 0.5, 25), 'opus-4.6': P(5, 6.25, 0.5, 25), 'opus-4.5': P(5, 6.25, 0.5, 25),
  'opus-4.1': P(15, 18.75, 1.5, 75), 'opus-4': P(15, 18.75, 1.5, 75),
  'sonnet-5.5': P(2, 2.5, 0.1, 10), 'sonnet-5': P(2, 2.5, 0.2, 10),
  'sonnet-4.6': P(3, 3.75, 0.3, 15), 'sonnet-4.5': P(3, 3.75, 0.3, 15), 'sonnet-4': P(3, 3.75, 0.3, 15),
  'haiku-5.5': P(0.10, 0.125, 0.01, 0.50), 'haiku-4.5': P(1, 1.25, 0.1, 5), 'haiku-3.5': P(0.8, 1, 0.08, 4),
};
const HAIKU55_LONG = P(0.50, 0.625, 0.05, 2.50);   // 프롬프트(입력+캐시) 10만 토큰 초과
let PRICES_AS_OF = '2026-11-22';

/** 'claude-sonnet-4-5-20250929' → 'sonnet-4.5' / 'claude-3-5-haiku-20241022' → 'haiku-3.5' */
function familyOf(model) {
  const m = String(model || '').toLowerCase();
  let r = m.match(/(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/);
  if (r) return r[3] ? `${r[1]}-${r[2]}.${r[3]}` : `${r[1]}-${r[2]}`;
  r = m.match(/claude-(\d)-(\d)-(opus|sonnet|haiku)/);
  if (r) return `${r[3]}-${r[1]}.${r[2]}`;
  return null;
}

/** 응답 usage 를 하나의 모양으로. 없는 칸은 0. */
function normUsage(u = {}) {
  const n = v => (Number.isFinite(v) && v > 0 ? v : 0);
  const cw = n(u.cache_creation_input_tokens);
  const cw1h = n(u.cache_creation?.ephemeral_1h_input_tokens);
  const cw5 = u.cache_creation ? n(u.cache_creation.ephemeral_5m_input_tokens) : cw;
  return { input: n(u.input_tokens), output: n(u.output_tokens), read: n(u.cache_read_input_tokens), cw5, cw1h: cw1h || 0, cwTotal: Math.max(cw, cw5 + cw1h) };
}

/** 사용량 → 달러. 모르는 모델이면 usd = null */
const ver = s => s.split(/[.-]/).map(Number);
const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
/** 표에 없는 버전(예: fable-5.3)이면 같은 계열에서 가장 최신 버전 가격으로 추정 */
function claudePrice(fam) {
  if (!fam) return null;
  if (TABLE[fam]) return { p: TABLE[fam], approx: false };
  const name = fam.split('-')[0];
  let best = null;
  for (const k of Object.keys(TABLE)) if (k.startsWith(name + '-') && (!best || newer(k.slice(name.length + 1), best.slice(name.length + 1)))) best = k;
  return best ? { p: TABLE[best], approx: true, basis: best } : null;
}
function costOf(model, usage) {
  const u = normUsage(usage);
  const fam = familyOf(model);
  const hit = claudePrice(fam);
  let p = hit?.p;
  if (fam === 'haiku-5.5' && u.input + u.read + u.cwTotal > 100_000) p = HAIKU55_LONG;
  if (!p) return { usd: null, family: fam, usage: u };
  const usd = (u.input * p.input + u.cw5 * p.cw5 + u.cw1h * p.cw1h + u.read * p.read + u.output * p.output) / 1e6;
  return { usd, family: fam, usage: u, approx: Boolean(hit?.approx) };
}

// ── GPT(OpenAI) — developers.openai.com/api/docs/pricing 기준(2026-11-22 갱신). 예전 모델은 공개 자료 기준 근사치.
const G = (input, cached, output) => ({ input, cached, output });
const GPT_TABLE = [
  ['gpt-6.2-astra', G(8, 0.40, 40)], ['gpt-6.2-sol', G(2, 0.10, 10)],   // 2026-11-17 출시, OpenAI 공식 가격표 2026-11-22 확인
  ['gpt-6-astra', G(10, 1, 50)], ['gpt-6.1-sol', G(2, 0.10, 10)], ['gpt-6.1-terra', G(1, 0.05, 5)], ['gpt-6-luna', G(0.10, 0.01, 0.50)],
  ['gpt-6-rosalind', G(15, 1.5, 75)], ['gpt-6-astra-law', G(10, 1, 50)], ['gpt-5.6-sol', G(4, 0.4, 20)], ['gpt-5.6-cyber', G(12.5, 1.25, 75)],
  ['chat-latest', G(5, 0.5, 30)], ['gpt-5.3-codex', G(1.75, 0.175, 14)],
  ['gpt-5.5', G(5, 0.5, 30)], ['gpt-5.4-mini', G(0.75, 0.075, 4.5)], ['gpt-5.4-nano', G(0.2, 0.02, 1.25)], ['gpt-5.4', G(2.5, 0.25, 15)],
  ['gpt-4.1-nano', G(0.1, 0.025, 0.4)], ['gpt-4.1-mini', G(0.4, 0.1, 1.6)], ['gpt-4.1', G(2, 0.5, 8)],
  ['gpt-4o-mini', G(0.15, 0.075, 0.6)], ['gpt-4o', G(2.5, 1.25, 10)],
  ['text-embedding-3-small', G(0.02, 0.02, 0)], ['text-embedding-3-large', G(0.13, 0.13, 0)],
].sort((a, b) => b[0].length - a[0].length);   // 긴 이름부터 맞춘다(gpt-4.1-mini 가 gpt-4.1 로 잡히지 않게)
const GPT_LONG = { 'gpt-6-luna': { threshold: 272_000, p: G(0.20, 0.02, 0.75) } };

/** GPT 응답 usage(chat: prompt/completion, responses: input/output, 캐시는 *_details.cached_tokens) → 공통 모양 */
function normGptUsage(u = {}) {
  const n = v => (Number.isFinite(v) && v > 0 ? v : 0);
  const prompt = n(u.prompt_tokens ?? u.input_tokens);
  const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
  const output = n(u.completion_tokens ?? u.output_tokens);
  return { input: Math.max(0, prompt - cached), output, read: cached, cw5: 0, cw1h: 0, cwTotal: 0 };
}
function gptPrice(model, promptTokens) {
  const m = String(model || '').toLowerCase();
  let hit = GPT_TABLE.find(([id]) => m === id || m.startsWith(id + '-'));   // 'gpt-6.1-sol-2026-10-01' → gpt-6.1-sol
  let approx = false;
  if (!hit) {
    // 표에 없는 새 버전(예: gpt-6.3-sol) → 같은 이름(sol·astra·terra·luna…)의 가장 최신 버전 가격으로 추정
    const r = m.match(/^gpt-(\d+(?:\.\d+)?)-([a-z]+)/);
    if (r) {
      let best = null;
      for (const row of GPT_TABLE) { const q = row[0].match(/^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/); if (q && q[2] === r[2] && (!best || newer(q[1], best.v))) best = { v: q[1], row }; }
      if (best) { hit = best.row; approx = true; }
    }
  }
  if (!hit) return null;
  const long = !approx && GPT_LONG[hit[0]];
  return { p: long && promptTokens > long.threshold ? long.p : hit[1], approx };
}
function costOfGpt(model, usage) {
  const u = normGptUsage(usage);
  const hit = gptPrice(model, u.input + u.read);
  if (!hit) return { usd: null, family: null, usage: u };
  const p = hit.p;
  return { usd: (u.input * p.input + u.read * p.cached + u.output * p.output) / 1e6, family: model, usage: u, approx: hit.approx };
}

// ── 업데이트 저장소의 prices.json 으로 덮어쓰기(앱 업데이트 없이 새 모델 가격 반영) ──
// 형식: { "asOf": "2026-12-01", "claude": { "fable-5.3": [input, cw5, read, output] }, "gpt": { "gpt-6.3-sol": [input, cached, output] } }
function applyRemotePrices(j) {
  if (!j || typeof j !== 'object') return false;
  let n = 0;
  for (const [k, v] of Object.entries(j.claude || {})) if (/^[a-z]+-\d+(\.\d+)?$/.test(k) && Array.isArray(v) && v.length === 4 && v.every(x => Number.isFinite(x) && x >= 0)) { TABLE[k] = P(...v); n++; }
  for (const [k, v] of Object.entries(j.gpt || {})) if (/^[a-z0-9.\-]+$/.test(k) && Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(x) && x >= 0)) {
    const i = GPT_TABLE.findIndex(r => r[0] === k); const row = [k, G(...v)];
    if (i >= 0) GPT_TABLE[i] = row; else GPT_TABLE.push(row); n++;
  }
  GPT_TABLE.sort((a, b) => b[0].length - a[0].length);
  if (n && typeof j.asOf === 'string' && j.asOf > PRICES_AS_OF) PRICES_AS_OF = j.asOf;
  return n > 0;
}
const isGptModel = m => /^(gpt-|chat-latest|text-embedding|o\d)/i.test(String(m || ''));
/** 토큰 수만 남은 예전 기록을 다시 계산할 때 쓴다(입력·캐시읽기·캐시쓰기·출력) */
function priceTokens(model, { input = 0, read = 0, cw = 0, output = 0 }) {
  if (isGptModel(model)) return costOfGpt(model, { prompt_tokens: input + read, completion_tokens: output, prompt_tokens_details: { cached_tokens: read } });
  return costOf(model, { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: cw, output_tokens: output });
}

module.exports = { costOf, costOfGpt, familyOf, normUsage, normGptUsage, applyRemotePrices, priceTokens, isGptModel, get PRICES_AS_OF() { return PRICES_AS_OF; } };
