// 키·설정 저장. 키는 윈도우 계정 암호화(DPAPI, Electron safeStorage)로 감싸서 저장한다.
'use strict';
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const file = () => path.join(app.getPath('userData'), 'pool.json');
const DEFAULT = { keys: [], settings: { autoStart: true, trayHintShown: false } };

function seal(key) {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(key).toString('base64');
  return 'raw:' + Buffer.from(key, 'utf8').toString('base64');
}
function unseal(v) {
  if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
  if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  return v;
}

let data = null;
function load() {
  try { data = { ...DEFAULT, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; data.settings = { ...DEFAULT.settings, ...data.settings }; }
  catch { data = structuredClone(DEFAULT); }
  return data;
}
let timer = null;
function save(now = false) {
  const write = () => { fs.mkdirSync(path.dirname(file()), { recursive: true }); const tmp = file() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file()); };
  clearTimeout(timer);
  if (now) write(); else timer = setTimeout(write, 800);
}

/** 앱이 쓰는 형태 [{id,key,tier,name,uses,fails}] */
function keys() {
  return data.keys.map(k => { try { return { id: k.id, key: unseal(k.sealed), tier: k.tier, provider: k.provider || 'claude', name: k.name, uses: k.uses ?? 0, fails: k.fails ?? 0, credit: k.credit ?? null }; } catch { return null; } }).filter(Boolean);
}
function hasKey(key) { return keys().some(k => k.key === key); }
function addKey({ key, tier, name, provider = 'claude' }) {
  const id = crypto.randomUUID();
  const n = data.keys.filter(k => k.tier === tier && (k.provider || 'claude') === provider).length + 1;
  const auto = provider === 'gpt' ? (tier === 'paid' ? `GPT 예비 ${n}` : `GPT ${n}`) : (tier === 'paid' ? `유료 ${n}` : `크레딧 ${n}`);
  data.keys.push({ id, sealed: seal(key), tier, provider, name: name || auto, uses: 0, fails: 0, addedAt: Date.now() });
  save(true); return id;
}
function update(id, patch) { const k = data.keys.find(x => x.id === id); if (k) { Object.assign(k, patch); save(true); } }
function remove(id) { data.keys = data.keys.filter(k => k.id !== id); save(true); }
function move(id, dir) {
  const i = data.keys.findIndex(k => k.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= data.keys.length) return;
  [data.keys[i], data.keys[j]] = [data.keys[j], data.keys[i]]; save(true);
}
function counts(list) { for (const s of list) { const k = data.keys.find(x => x.id === s.id); if (k) { k.uses = s.uses; k.fails = s.fails; } } save(); }
function meta() { return data.keys.map(k => ({ id: k.id, name: k.name, tier: k.tier, provider: k.provider || 'claude', credit: k.credit ?? null })); }
function settings() { return data.settings; }
// 관리 토큰 같은 비밀값 — 키와 같은 방식(윈도우 계정 암호화)으로 감싸서 저장
function setSecret(name, value) { data.secrets = data.secrets || {}; if (value) data.secrets[name] = seal(String(value)); else delete data.secrets[name]; save(true); }
function hasSecret(name) { return Boolean(data.secrets?.[name]); }   // 복호화 없이 있는지만
function getSecret(name) { try { const v = data.secrets?.[name]; return v ? unseal(v) : null; } catch { return null; } }
function setSetting(k, v) { data.settings[k] = v; save(true); }

module.exports = { load, meta, keys, setSecret, getSecret, hasSecret, hasKey, addKey, update, remove, move, counts, settings, setSetting, flush: () => save(true) };
