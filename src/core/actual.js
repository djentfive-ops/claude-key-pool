'use strict';
// 실제 사용액 자동 연동 — 공식 비용 보고서로 "이번 주기에 실제로 쓴 금액"을 읽는다.
// 남은 잔액을 주는 공식 API 는 Anthropic·OpenAI 둘 다 없어서, 남은 금액 = 이번 주기 크레딧 − 실제 사용액 으로 계산한다.
//  · Anthropic: GET /v1/organizations/cost_report — 하루 단위(UTC), 금액은 센트 단위 문자열, 보통 5분 안에 반영
//    관리자 키(sk-ant-admin…)나 워크스페이스에 묶이지 않은 키로 읽을 수 있다(일반 워크스페이스 키는 거절됨)
//  · OpenAI:    GET /v1/organization/costs — 하루 단위, amount.value 는 달러. 관리자 키(sk-admin-…) 필요

const DAY = 86_400_000;
/** ms 이후(같거나 큰) 가장 가까운 UTC 0시 */
function utcCeil(ms) {
  const d = new Date(ms);
  const m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return m === ms ? ms : m + DAY;
}
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function getJson(url, headers, timeout = 20_000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  let body = null;
  try { body = await r.json(); } catch { /* 본문 없음 */ }
  return { status: r.status, body };
}

/** [fromMs, toMs) 동안의 Anthropic 조직 비용(달러) */
async function claudeCost({ base, key, fromMs, toMs }) {
  let usd = 0, page = null;
  for (let i = 0; i < 8; i++) {
    const q = new URLSearchParams({ starting_at: iso(fromMs), ending_at: iso(toMs), bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const { status, body } = await getJson(`${base}/v1/organizations/cost_report?${q}`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
    if (status !== 200) return { ok: false, status, message: body?.error?.message ? String(body.error.message).slice(0, 160) : null };
    for (const b of body?.data || []) for (const r of b.results || []) { const v = Number(r.amount); if (Number.isFinite(v)) usd += v / 100; }   // 센트 → 달러
    if (!body?.has_more || !body?.next_page) return { ok: true, usd };
    page = body.next_page;
  }
  return { ok: true, usd };
}

/** [fromMs, toMs) 동안의 OpenAI 조직 비용(달러) */
async function openaiCost({ base, key, fromMs, toMs }) {
  let usd = 0, page = null;
  for (let i = 0; i < 8; i++) {
    const q = new URLSearchParams({ start_time: String(Math.floor(fromMs / 1000)), end_time: String(Math.floor(toMs / 1000)), bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const { status, body } = await getJson(`${base}/v1/organization/costs?${q}`, { authorization: `Bearer ${key}` });
    if (status !== 200) return { ok: false, status, message: body?.error?.message ? String(body.error.message).slice(0, 160) : null };
    for (const b of body?.data || []) for (const r of b.results || []) { const v = Number(r.amount?.value); if (Number.isFinite(v)) usd += v; }
    if (!body?.has_more || !body?.next_page) return { ok: true, usd };
    page = body.next_page;
  }
  return { ok: true, usd };
}

/** 거절(키 종류가 안 맞음) — 다시 시도해도 같은 결과 */
const denied = status => status === 401 || status === 403 || status === 404;

/** 관리자 키 모양 확인(앞부분만) */
function adminKeyKind(key) {
  const k = String(key || '').trim();
  if (/^sk-ant-admin/.test(k)) return 'claude';
  if (/^sk-admin-/.test(k)) return 'gpt';
  return null;
}

/** 두 날(1~31) 사이의 달력상 거리(월말을 넘는 경우 포함, 대략) */
const dayGap = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 31 - d); };

module.exports = { utcCeil, claudeCost, openaiCost, denied, adminKeyKind, dayGap, DAY };
