// 서버 쪽 키 보관 — 키 값은 KEYPOOL_SECRET 으로 암호화(AES-256-GCM)해서 디스크에 둔다.
// 이름·종류·크레딧 설정·사용 횟수는 그대로 저장한다(관리 화면에 보여줄 정보).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createKeyStore(file, secret) {
  const encKey = crypto.createHash('sha256').update(String(secret)).digest();
  const seal = text => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  };
  const unseal = b64 => {
    const buf = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  };

  let data = { keys: [] };
  try { data = { keys: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let timer = null;
  const save = (now = false) => {
    const write = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1)); fs.renameSync(file + '.tmp', file); };
    clearTimeout(timer);
    if (now) write(); else { timer = setTimeout(write, 1000); timer.unref?.(); }
  };

  /** 중계 엔진에 넘길 모양 [{id,key,tier,provider,name,uses,fails,credit}] — 풀 수 없는 키(비밀값이 바뀐 경우)는 건너뛴다 */
  function keys() {
    const out = [];
    for (const k of data.keys) { try { out.push({ id: k.id, key: unseal(k.sealed), tier: k.tier, provider: k.provider || 'claude', name: k.name, uses: k.uses || 0, fails: k.fails || 0, credit: k.credit || null }); } catch {} }
    return out;
  }
  const meta = () => data.keys.map(k => ({ id: k.id, name: k.name, tier: k.tier, provider: k.provider || 'claude', credit: k.credit || null }));
  const hasKey = key => keys().some(k => k.key === key);

  function add({ key, tier = 'credit', provider = 'claude', name = '', credit = null }) {
    const id = crypto.randomUUID();
    const n = data.keys.filter(k => k.tier === tier && (k.provider || 'claude') === provider).length + 1;
    const auto = provider === 'gpt' ? (tier === 'paid' ? `GPT 예비 ${n}` : `GPT ${n}`) : (tier === 'paid' ? `유료 ${n}` : `크레딧 ${n}`);
    data.keys.push({ id, sealed: seal(key), tier: tier === 'paid' ? 'paid' : 'credit', provider, name: String(name || auto).slice(0, 24), credit, uses: 0, fails: 0, addedAt: Date.now() });
    save(true);
    return id;
  }
  function update(id, patch) { const k = data.keys.find(x => x.id === id); if (!k) return false; Object.assign(k, patch); save(true); return true; }
  function remove(id) { const before = data.keys.length; data.keys = data.keys.filter(k => k.id !== id); save(true); return data.keys.length < before; }
  function move(id, dir) {
    const i = data.keys.findIndex(k => k.id === id); const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= data.keys.length) return false;
    [data.keys[i], data.keys[j]] = [data.keys[j], data.keys[i]]; save(true); return true;
  }
  function counts(snapshot) { for (const s of snapshot) { const k = data.keys.find(x => x.id === s.id); if (k) { k.uses = s.uses; k.fails = s.fails; } } save(); }

  return { keys, meta, hasKey, add, update, remove, move, counts, flush: () => save(true) };
}

module.exports = { createKeyStore };
