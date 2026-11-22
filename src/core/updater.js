// 자동 업데이트 — 공개 저장소의 update.json 을 보고 새 판(app-x.y.z.asar, 약 2MB)을 받아 둔다.
// 적용은 "쓰고 있지 않을 때" 앱을 조용히 다시 켜서 한다(bootstrap.js 가 새 판을 고른다).
'use strict';
// .asar 파일을 '파일'로 다루려면 Electron 의 original-fs 를 써야 한다(일반 fs 는 .asar 를 폴더처럼 연다)
let fs; try { fs = require('original-fs'); } catch { fs = require('node:fs'); }
const path = require('node:path');
const crypto = require('node:crypto');

const UPDATE_BASE = process.env.CKP_UPDATE_BASE || 'https://raw.githubusercontent.com/djentfive-ops/claude-key-pool/main';

const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const p = x[i] || 0, q = y[i] || 0; if (p !== q) return p > q ? 1 : -1; }
  return 0;
};

function createUpdater({ dir, currentVersion, onReady, log = () => {} }) {
  let state = { status: 'idle', version: null, notes: null, checkedAt: null, error: null };
  let busy = false;

  async function check() {
    if (busy) return state;
    busy = true;
    try {
      const r = await fetch(`${UPDATE_BASE}/update.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
      if (r.status === 404) { state = { ...state, status: 'no-channel', checkedAt: Date.now(), error: null }; return state; }
      if (!r.ok) throw new Error(`update.json ${r.status}`);
      const m = await r.json();
      if (!m?.version || !m?.file || !/^[\w.\-]+\.asar$/.test(m.file) || !/^[a-f0-9]{64}$/.test(m.sha256 || '')) throw new Error('update.json 형식 오류');
      if (cmp(m.version, currentVersion) <= 0) { state = { status: 'latest', version: currentVersion, notes: null, checkedAt: Date.now(), error: null }; return state; }

      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, m.file);
      const have = fs.existsSync(target) && sha256(fs.readFileSync(target)) === m.sha256;
      if (!have) {
        const a = await fetch(`${UPDATE_BASE}/${m.file}?t=${Date.now()}`, { signal: AbortSignal.timeout(120000), cache: 'no-store' });
        if (!a.ok) throw new Error(`${m.file} ${a.status}`);
        const buf = Buffer.from(await a.arrayBuffer());
        if (sha256(buf) !== m.sha256) throw new Error('받은 파일이 손상됐습니다(지문 불일치)');
        fs.writeFileSync(target + '.part', buf);
        fs.renameSync(target + '.part', target);
      }
      fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ version: m.version, file: m.file, sha256: m.sha256, notes: m.notes || '', at: Date.now() }));
      // 예전 판 정리(현재·새 판만 남김)
      for (const f of fs.readdirSync(dir)) if (/^app-.*\.asar$/.test(f) && f !== m.file && f !== path.basename(global.CKP_APP_ROOT || '')) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
      state = { status: 'ready', version: m.version, notes: m.notes || '', checkedAt: Date.now(), error: null };
      log(`업데이트 ${m.version} 준비됨`);
      onReady?.(state);
      return state;
    } catch (e) {
      state = { ...state, status: 'error', checkedAt: Date.now(), error: String(e?.message || e) };
      return state;
    } finally { busy = false; }
  }

  return { check, get state() { return state; } };
}

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
module.exports = { createUpdater, cmp, UPDATE_BASE };
