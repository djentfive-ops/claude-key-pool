// 시작 파일 — 설치본에 든 앱(core/)과 자동 업데이트로 받은 앱(userData/updates/*.asar) 중 새것을 골라 켠다.
// 새 판이 두 번 연속 제대로 못 켜지면 설치본으로 되돌아간다.
'use strict';
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
if (process.env.CKP_USERDATA) app.setPath('userData', process.env.CKP_USERDATA);

const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const p = x[i] || 0, q = y[i] || 0; if (p !== q) return p > q ? 1 : -1; }
  return 0;
};
function choose() {
  const bundled = path.join(__dirname, 'core');
  try {
    const dir = path.join(app.getPath('userData'), 'updates');
    const cur = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
    const bundledVer = JSON.parse(fs.readFileSync(path.join(bundled, 'package.json'), 'utf8')).version;
    const file = path.join(dir, path.basename(String(cur.file)));
    if (cmp(cur.version, bundledVer) <= 0 || !fs.existsSync(file)) return bundled;
    const guardFile = path.join(dir, 'booting.json');
    let g = {}; try { g = JSON.parse(fs.readFileSync(guardFile, 'utf8')); } catch {}
    if (g.version === 'broken' && g.file === cur.file) return bundled;           // 시작부터 깨졌던 판
    const tries = g.version === cur.version ? (g.tries || 0) : 0;
    if (tries >= 2) return bundled;                       // 두 번 연속 실패한 판 → 설치본으로
    fs.writeFileSync(guardFile, JSON.stringify({ version: cur.version, tries: tries + 1 }));
    return file;
  } catch { return bundled; }
}
global.CKP_BUNDLED_ROOT = path.join(__dirname, 'core');
global.CKP_APP_ROOT = choose();
try {
  require(path.join(global.CKP_APP_ROOT, 'main.js'));
} catch (e) {
  if (global.CKP_APP_ROOT === global.CKP_BUNDLED_ROOT) throw e;
  // 받은 새 판이 시작부터 깨져 있으면 바로 설치본으로 켠다(다음부터도 건너뜀)
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'updates', 'booting.json'), JSON.stringify({ version: 'broken', file: path.basename(global.CKP_APP_ROOT), tries: 99, error: String(e && e.message) })); } catch {}
  console.error('[update] 새 판을 켜지 못해 설치본으로 돌아갑니다:', e && e.message);
  global.CKP_APP_ROOT = global.CKP_BUNDLED_ROOT;
  require(path.join(global.CKP_BUNDLED_ROOT, 'main.js'));
}
