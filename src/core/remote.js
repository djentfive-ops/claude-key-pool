// 게이트 서버 연결 — PC 앱이 Render 의 OVIS Gate 서버를 보고 관리한다(관리 토큰 사용).
// 서버는 PC 가 꺼져 있어도 혼자 돈다. 앱은 켜져 있을 때 상태를 받아오고, 바꾼 내용을 보내고, 서버 기록을 NAS 폴더에도 맞춰 둔다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const pad = n => String(n).padStart(2, '0');
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms); t.unref?.(); })]);
async function writeAtomic(f, text) {
  await fs.promises.mkdir(path.dirname(f), { recursive: true });
  await fs.promises.writeFile(f + '.tmp', text);
  await fs.promises.rename(f + '.tmp', f);
}

function friendly(e) {
  if (e?.code === 401) return '관리 토큰이 맞지 않아요';
  if (e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT') return '서버가 응답하지 않아요';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(String(e?.message) + String(e?.cause?.code))) return '서버에 연결할 수 없어요(주소 확인 또는 인터넷 연결)';
  return String(e?.message || e);
}

/**
 * getConfig(): { url, token } | null
 * onChange(): 화면 갱신 요청 / notify(title, body) / mirrorDir(): NAS 폴더(없으면 null)
 */
function createRemote({ getConfig, onChange, notify, mirrorDir }) {
  let st = { connected: false, error: null, at: 0, data: null, nasAt: null, nasError: null };
  let prev = new Map();
  let polling = false;

  async function api(method, p, body, { raw = false, timeout = 20000, config = null } = {}) {
    const c = config || getConfig();
    if (!c) throw new Error('서버가 연결되지 않았어요');
    const r = await fetch(c.url + p, {
      method, signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${c.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) throw Object.assign(new Error('관리 토큰이 맞지 않아요'), { code: 401 });
    if (!r.ok) { let msg = `서버 응답 ${r.status}`; try { msg = (await r.json()).error || msg; } catch {} throw new Error(msg); }
    return raw ? r.text() : r.json();
  }

  // 서버 키가 쉬게 되면(앱이 켜져 있을 때만) 알림
  function detect(d) {
    const now = new Map((d.keys || []).map(k => [k.id, k]));
    for (const [id, k] of now) {
      const before = prev.get(id);
      if (!before || before.state === k.state) continue;
      if (k.state === 'exhausted' && before.state !== 'exhausted') notify(`[서버] ${k.name} 키가 쉬는 중이에요`, '크레딧이 떨어졌거나 사용 한도에 닿아 서버가 다음 키로 넘겼어요.');
      if (k.state === 'auth' && before.state !== 'auth') notify(`[서버] ${k.name} 키를 쓸 수 없어요`, '키가 지워졌거나 권한이 없습니다. 앱에서 서버 키를 확인하세요.');
    }
    prev = now;
  }

  async function poll() {
    if (polling) return st;
    if (!getConfig()) { st = { connected: false, error: null, at: 0, data: null, nasAt: null, nasError: null }; return st; }
    polling = true;
    try {
      const d = await api('GET', '/admin/state', null, { timeout: 15000 });
      detect(d);
      st = { ...st, connected: true, error: null, at: Date.now(), data: d };
    } catch (e) {
      st = { ...st, connected: false, error: friendly(e) };
    } finally { polling = false; onChange(); }
    return st;
  }

  /** 서버 기록을 NAS 폴더에도 — JSON(전체) + 이번 달 엑셀 2개(날짜별·건별) */
  async function syncNas() {
    const dir = mirrorDir();
    if (!dir || !getConfig()) return;
    try {
      const ex = await api('GET', '/admin/export', null, { timeout: 30000 });
      const m = new Date(); const ym = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
      const [daily, charges] = await Promise.all([
        api('GET', `/admin/csv?kind=daily&month=${ym}`, null, { raw: true, timeout: 30000 }),
        api('GET', `/admin/csv?kind=charges&month=${ym}`, null, { raw: true, timeout: 30000 }),
      ]);
      await withTimeout(writeAtomic(path.join(dir, 'OVIS게이트_서버_사용기록.json'), JSON.stringify(ex, null, 1)), 20000);
      await withTimeout(writeAtomic(path.join(dir, `OVIS게이트_서버_사용기록_${ym}.csv`), daily), 20000);
      await withTimeout(writeAtomic(path.join(dir, `OVIS게이트_서버_건별요금_${ym}.csv`), charges), 20000);
      st = { ...st, nasAt: Date.now(), nasError: null };
    } catch (e) {
      st = { ...st, nasError: e?.code ? '폴더에 저장하지 못했어요(NAS 연결 확인)' : friendly(e) };
    }
    onChange();
  }

  const reset = () => { st = { connected: false, error: null, at: 0, data: null, nasAt: null, nasError: null }; prev = new Map(); };
  return { api, poll, syncNas, reset, friendly, state: () => st };
}

module.exports = { createRemote };
