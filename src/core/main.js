'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, Notification, nativeImage, dialog, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { KeyPool, testKey, providerOfKey } = require('./proxy-core');
const { createUsageStore } = require('./usage-store');
const { createRemote } = require('./remote');
const pairs = require('./pairs');
const actual = require('./actual');
const pricing = require('./pricing');
const { createUpdater } = require('./updater');
const APP_VERSION = require('./package.json').version;

// 시험·미리보기용 스위치(평소엔 비어 있음)
const ENV = process.env;
if (ENV.CKP_USERDATA && !global.CKP_APP_ROOT) app.setPath('userData', ENV.CKP_USERDATA);
const store = require('./store');
const PORT = Number(ENV.CKP_PORT || 4100);
const UPSTREAM = ENV.CKP_UPSTREAM || 'https://api.anthropic.com';
const UPSTREAM_GPT = ENV.CKP_UPSTREAM_GPT || 'https://api.openai.com';
const ADDRESS = `http://127.0.0.1:${PORT}`;
const startHidden = process.argv.includes('--hidden');
// 처리 못 한 오류: 끄는 중(업데이트·종료)에는 조용히 넘기고, 평소에는 오류 기록 파일에 남긴다(앱은 계속 돈다)
process.on('uncaughtException', e => {
  if (quitting) return;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), `${new Date().toISOString()} ${e && e.stack || e}\n`); } catch {}
});

const gotLock = app.requestSingleInstanceLock();   // 이미 켜져 있으면 새로 켜지 않고 기존 창을 띄운다
if (!gotLock) app.quit();
const AUMID = 'studio.ovis.claudekeypool';   // 바꾸지 않는다 — 알림·바로 가기가 이 값으로 앱을 알아본다
app.setAppUserModelId(AUMID);

// 1.6.0 이름 바꾸기: 화면에 보이는 이름만 'OVIS Gate'. 저장 폴더(%APPDATA%\\Claude 키 묶음)·설치 폴더·자동 시작 이름은 그대로 둔다(키·기록이 끊기지 않게).
const OLD_NAME = 'Claude 키 묶음', NEW_NAME = 'OVIS Gate';
function renameShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const dirs = [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
  for (const dir of dirs) {
    try {
      const oldLnk = path.join(dir, `${OLD_NAME}.lnk`), newLnk = path.join(dir, `${NEW_NAME}.lnk`);
      if (!fs.existsSync(oldLnk)) continue;
      let link = {};
      try { link = shell.readShortcutLink(oldLnk); } catch {}
      if (!fs.existsSync(newLnk) && !shell.writeShortcutLink(newLnk, 'create', { target: link.target || process.execPath, cwd: link.cwd || path.dirname(process.execPath),
        icon: link.icon || process.execPath, iconIndex: link.iconIndex || 0, appUserModelId: AUMID, description: NEW_NAME })) continue;
      fs.unlinkSync(oldLnk);
    } catch {}
  }
  // 프로그램 추가/제거 목록에 보이는 이름 — 설치 항목이 있을 때만 고친다
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ClaudeKeyPool';
  const { execFile } = require('node:child_process');
  execFile('reg', ['query', key, '/v', 'DisplayName'], { windowsHide: true }, (err, out) => {
    if (err || String(out).includes(NEW_NAME)) return;
    execFile('reg', ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', NEW_NAME, '/f'], { windowsHide: true }, () => {});
  });
}

let win = null, tray = null, quitting = false, portError = null;
/** 창이 살아 있는지(업데이트로 꺼지는 중에는 창이 먼저 닫힌다) */
const alive = () => Boolean(win) && !win.isDestroyed();
const pool = new KeyPool({ port: PORT, upstream: UPSTREAM, upstreamGpt: UPSTREAM_GPT });
let usage = null;   // app 준비 뒤 userData 경로가 정해지면 연다
let updater = null;
const THEME = { light: { plate: '#E3E6EA', ink: '#1A2233' }, dark: { plate: '#161A21', ink: '#E6E9EF' } };
const isDark = () => nativeTheme.shouldUseDarkColors;
function applyTheme(setSource = true) {
  if (setSource) nativeTheme.themeSource = store.settings().theme || 'system';
  const t = THEME[isDark() ? 'dark' : 'light'];
  if (win && !win.isDestroyed()) { try { win.setTitleBarOverlay({ color: t.plate, symbolColor: t.ink, height: 52 }); } catch {} win.setBackgroundColor(t.plate); }
}
const asset = f => path.join(__dirname, 'assets', f);

function state() {
  const meta = new Map(store.meta().map(m => [m.id, m]));
  const keys = pool.snapshot().map(k => ({ ...k, credit: meta.get(k.id)?.credit ?? null, creditState: usage ? usage.creditState(k.id, meta.get(k.id)?.credit) : null }));
  const out = { listening: pool.listening, portError, port: PORT, address: ADDRESS, keys, log: usage ? usage.recentLog(150) : pool.log.slice(0, 40), charges: usage ? usage.recentCharges(300) : [],
    mirror: usage ? usage.mirrorState() : null,
    settings: { ...store.settings() }, version: APP_VERSION, pricesAsOf: pricing.PRICES_AS_OF, dark: isDark(), update: updater?.state ?? null };
  // 서버 연결 — "서버"를 고르면 키·기록 화면이 서버 것으로 바뀐다(이 PC 의 중계는 그대로 계속 돈다)
  const cfg = serverCfg();
  const rs = remote.state();
  out.server = cfg ? { url: cfg.url, connected: rs.connected, error: rs.error, at: rs.at, proxyToken: rs.data?.proxyToken ?? null, version: rs.data?.version ?? null, nasAt: rs.nasAt, nasError: rs.nasError } : null;
  out.source = viaServer() ? 'server' : 'local';
  if (out.source === 'server') {
    out.keys = rs.data?.keys ?? []; out.log = rs.data?.log ?? []; out.charges = rs.data?.charges ?? [];
    if (rs.data?.pricesAsOf) out.pricesAsOf = rs.data.pricesAsOf;
  }
  // 같은 키(이 PC ↔ 서버)는 두 곳 사용액을 합쳐 남은 크레딧을 보여 준다 — 어느 화면에서 봐도 같은 숫자
  out.keys = out.keys.map(k => { const sig = sigOf(k.provider, k.tail); const a = actualState.get(sig); return { ...k, ...(a ? { actual: a } : {}), hasAdmin: store.hasSecret(adminName(sig)) }; });
  const synced = pairStates().filter(p => p.d.kind === 'sync');
  if (synced.length) {
    const server = out.source === 'server';
    const by = new Map(synced.map(p => [server ? p.serverId : p.localId, p]));
    out.keys = out.keys.map(k => { const p = by.get(k.id); return p ? { ...k, creditState: server ? pairs.combine(p.S, p.L, p.d.anchor) : pairs.combine(p.L, p.S, p.d.anchor) } : k; });
  }
  return out;
}
let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; if (quitting || !alive()) return; win.webContents.send('state', state()); updateTray(); }, 120);
}
pool.on('change', push);
pool.on('log', e => { store.counts(pool.snapshot()); usage?.addLog(e); push(); });

function notify(title, body) { if (Notification.isSupported()) new Notification({ title, body, icon: asset('icon.png'), silent: true }).show(); }

// ── 게이트 서버 연결 ─────────────────────────────
function serverCfg() {
  const s = store.settings();
  const token = s.serverUrl ? store.getSecret('serverToken') : null;
  return s.serverUrl && token ? { url: s.serverUrl, token } : null;
}
const viaServer = () => Boolean(serverCfg()) && store.settings().source === 'server';
const remote = createRemote({ getConfig: serverCfg, onChange: () => push(), notify, mirrorDir: () => store.settings().dataDir || null });
const toast = msg => { if (alive()) win.webContents.send('toast', msg); };
/** 서버로 보내는 관리 동작 — 실패하면 화면에 한 줄로 알린다 */
async function onServer(fn, fallback) {
  try { const r = await fn(); await remote.poll(); return r; }
  catch (e) { toast(`서버에 반영하지 못했어요: ${remote.friendly(e)}`); return fallback; }
}
// ── 같은 키 잔액 맞추기(이 PC ↔ 서버) ─────────────
function currentPairs() {
  const rs = remote.state(), sk = rs.data?.keys;
  if (!serverCfg() || !rs.connected || !Array.isArray(sk) || !usage) return [];
  const local = pool.snapshot().map(k => ({ id: k.id, provider: k.provider || 'claude', tail: k.tail }));   // 복호화 없이(중계가 이미 들고 있는 끝 4자리)
  return pairs.pairKeys(local, sk);
}
const sumSince = (list, id, t) => (list || []).reduce((a, c) => a + (c.id === id && c.at >= t && c.usd != null ? c.usd : 0), 0);
function pairStates() {
  const ps = currentPairs();
  if (!ps.length) return [];
  const sk = new Map((remote.state().data?.keys || []).map(k => [k.id, k]));
  const meta = new Map(store.meta().map(m => [m.id, m]));
  const recs = store.settings().pairSync || {};
  const localCharges = usage.recentCharges(3000), serverCharges = remote.state().data?.charges || [];
  return ps.map(p => {
    const lcredit = meta.get(p.localId)?.credit, scredit = sk.get(p.serverId)?.credit;
    const L = usage.creditState(p.localId, lcredit), S = sk.get(p.serverId)?.creditState;
    const d = pairs.decide({ L, S, lcredit, scredit, lcal: usage.calibOf(p.localId), rec: recs[p.serverId],
      spentS: t => sumSince(serverCharges, p.serverId, t), spentL: t => sumSince(localCharges, p.localId, t) });
    return { ...p, L, S, d };
  });
}
const pairOf = ({ localId, serverId }) => currentPairs().find(p => (localId && p.localId === localId) || (serverId && p.serverId === serverId)) || null;
/** 지금 뒤에 받은 서버 상태(다른 읽기가 진행 중이면 끝나길 기다렸다가 한 번 더) */
async function freshPoll(since) {
  for (let i = 0; i < 4; i++) { const st = await remote.poll(); if (st?.at >= since) return st; await new Promise(r => setTimeout(r, 700)); }
  return remote.state();
}
let pairSyncing = false;
let anchorChain = Promise.resolve();
/** 남은 금액을 바꾸는 작업은 한 번에 하나씩 */
function withLock(fn) { const run = anchorChain.then(fn, fn); anchorChain = run.catch(() => {}); return run; }
const pairTried = new Map();
/** 기준이 어긋난 짝을 다시 맞춘다(처음 서버로 옮겼을 때, 한쪽에서 금액을 고쳤을 때, 크레딧 부족으로 0 이 됐을 때) */
let pairAgain = false;
async function syncPairs() {
  if (!usage) return;
  if (pairSyncing) { pairAgain = true; return; }   // 진행 중이면 끝난 뒤 한 번 더
  pairSyncing = true;
  return withLock(() => syncPairsNow());
}
async function syncPairsNow() {
  try {
    const recs = { ...(store.settings().pairSync || {}) };
    let changed = false;
    for (const ps of pairStates()) {
      const { d } = ps;
      if (d.kind === 'sync') { if (d.dropRec && recs[ps.serverId]) { delete recs[ps.serverId]; changed = true; } continue; }
      if (d.kind === 'skip') continue;
      if (Date.now() - (pairTried.get(ps.serverId) || 0) < 20_000) continue;
      pairTried.set(ps.serverId, Date.now());
      try {
        if (d.kind === 'clear') {
          const r0 = recs[ps.serverId];
          if (r0 && r0.value === 0) learnRefill({ localId: ps.localId, serverId: ps.serverId, zeroAt: r0.atL });
          if (ps.L.calibrated) usage.clearCalib(ps.localId);
          if (ps.S.calibrated) await remote.api('DELETE', `/admin/keys/${ps.serverId}/calib`);
          delete recs[ps.serverId]; changed = true;
          await remote.poll();
        } else if (d.kind === 'push') {
          const value = Math.round(d.value * 10000) / 10000;
          await remote.api('PATCH', `/admin/keys/${ps.serverId}`, { remaining: value });
          usage.calibrate(ps.localId, value);
          const fresh = await freshPoll(Date.now());
          const s = (fresh?.data?.keys || []).find(k => k.id === ps.serverId);
          recs[ps.serverId] = { localId: ps.localId, value, atL: usage.calibOf(ps.localId)?.at ?? null, atS: s?.creditState?.calibratedAt ?? null };
          changed = true;
        }
      } catch {}
    }
    if (remote.state().connected) {   // 없어진 짝의 기록은 정리
      const live = new Set(currentPairs().map(p => p.serverId));
      for (const id of Object.keys(recs)) if (!live.has(id)) { delete recs[id]; changed = true; }
    }
    if (changed) store.setSetting('pairSync', recs);
  } finally { pairSyncing = false; push(); if (pairAgain) { pairAgain = false; setTimeout(() => syncPairs(), 0); } }
}
// ── 실제 사용액 자동 연동(공식 비용 보고서) ─────────
// 지금 키로 먼저 읽어 보고(워크스페이스에 묶이지 않은 키면 됨), 안 되는 계정만 관리자 키를 받는다.
// 남은 금액 = 이번 주기 크레딧 − 실제 사용액. 충전일 0시~그다음 UTC 0시(한국 9시) 사이는 보고서가 하루 단위라 게이트 기록으로 채운다.
const sigOf = (provider, tail) => `${provider || 'claude'}:${tail}`;
const adminName = sig => `admin:${sig}`;
const actualState = new Map();   // sig → { ok, via, cycleCost, remaining, checkedAt, error, needAdmin }
let actualBusy = false, lastActual = 0, actualAgain = false;
function actualTargets() {
  const out = new Map();
  const meta = new Map(store.meta().map(m => [m.id, m]));
  for (const k of pool.snapshot()) {
    const m = meta.get(k.id);
    if (!m?.credit?.amount || !m?.credit?.day) continue;
    const sig = sigOf(k.provider, k.tail);
    out.set(sig, { sig, provider: k.provider || 'claude', name: m.name, localId: k.id, credit: m.credit });
  }
  const rs = remote.state();
  if (serverCfg() && rs.connected) for (const k of rs.data?.keys || []) {
    if (!k.credit?.amount || !k.credit?.day) continue;
    const sig = sigOf(k.provider, k.tail);
    const e = out.get(sig) || { sig, provider: k.provider || 'claude', name: k.name, credit: k.credit };
    e.serverId = k.id; out.set(sig, e);
  }
  return [...out.values()];
}
function actualCred(e) {
  const admin = store.getSecret(adminName(e.sig));
  if (admin) return { key: admin, via: 'admin' };
  if ((store.settings().actualProbe || {})[e.sig] === 'denied' || !e.localId) return null;
  const k = store.keys().find(x => x.id === e.localId);
  return k ? { key: k.key, via: 'key' } : null;
}
const gateSpend = (e, from, to) => {
  const inRange = (list, id) => (list || []).reduce((a, c) => a + (c.id === id && c.at >= from && c.at < to && c.usd != null ? c.usd : 0), 0);
  return (e.localId ? inRange(usage.recentCharges(3000), e.localId) : 0) + (e.serverId ? inRange(remote.state().data?.charges, e.serverId) : 0);
};
/** 두 곳(이 PC·서버)의 남은 금액을 같은 값으로 맞춘다 */
async function anchorKey(e, value) {
  value = Math.round(value * 10000) / 10000;
  if (e.localId) usage.calibrate(e.localId, value);
  if (!e.serverId || !serverCfg() || !remote.state().connected) return;
  try { await remote.api('PATCH', `/admin/keys/${e.serverId}`, { remaining: value }); } catch { return; }
  const fresh = await freshPoll(Date.now());
  const sk = (fresh?.data?.keys || []).find(k => k.id === e.serverId);
  if (e.localId) {
    const recs = { ...(store.settings().pairSync || {}) };
    recs[e.serverId] = { localId: e.localId, value, atL: usage.calibOf(e.localId)?.at ?? null, atS: sk?.creditState?.calibratedAt ?? null };
    store.setSetting('pairSync', recs);
  }
}
async function readActual(e, cred, now = Date.now()) {
  const cs = e.localId ? usage.creditState(e.localId, e.credit) : (remote.state().data?.keys || []).find(k => k.id === e.serverId)?.creditState;
  if (!cs?.configured) return null;
  const A = actual.utcCeil(cs.cycleStart);
  let res = { ok: true, usd: 0 };
  if (now > A) res = await (e.provider === 'gpt' ? actual.openaiCost : actual.claudeCost)({ base: e.provider === 'gpt' ? UPSTREAM_GPT : UPSTREAM, key: cred.key, fromMs: A, toMs: actual.utcCeil(now + 1) });
  if (!res.ok) return res;
  const cycleCost = res.usd + gateSpend(e, cs.cycleStart, Math.min(A, now));
  return { ok: true, cycleCost, remaining: Math.max(0, e.credit.amount - cycleCost) };
}
async function refreshActual(force = false) {
  if (!usage || quitting) return;
  if (actualBusy) { if (force) actualAgain = true; return; }   // 진행 중이면 끝난 뒤 한 번 더
  if (!force && Date.now() - lastActual < 10 * 60_000) return;
  actualBusy = true; lastActual = Date.now();
  return withLock(() => refreshActualNow());
}
async function refreshActualNow() {
  try {
    for (const e of actualTargets()) {
      const cred = actualCred(e);
      const prev = actualState.get(e.sig) || {};
      if (!cred) { actualState.set(e.sig, { ...prev, ok: false, via: null, needAdmin: true }); continue; }
      let r;
      try { r = await readActual(e, cred); } catch { r = { ok: false, status: 0 }; }
      if (!r) continue;
      const now = Date.now();
      if (!r.ok) {
        const no = actual.denied(r.status);
        if (no && cred.via === 'key') store.setSetting('actualProbe', { ...(store.settings().actualProbe || {}), [e.sig]: 'denied' });
        actualState.set(e.sig, { ...prev, ok: false, via: cred.via, checkedAt: now, needAdmin: no,
          error: no ? (cred.via === 'admin' ? '관리자 키로 비용 보고서를 읽지 못했어요(키가 틀렸거나 다른 조직의 키)' : null) : '비용 보고서를 잠시 읽지 못했어요(다음에 다시 시도)' });
        continue;
      }
      await anchorKey(e, r.remaining);
      if (cred.via === 'key') store.setSetting('actualProbe', { ...(store.settings().actualProbe || {}), [e.sig]: 'ok' });
      actualState.set(e.sig, { ok: true, via: cred.via, cycleCost: r.cycleCost, remaining: r.remaining, checkedAt: now, needAdmin: false, error: null });
    }
  } finally { actualBusy = false; push(); if (actualAgain) { actualAgain = false; setTimeout(() => refreshActual(true), 0); } }
}
setInterval(() => refreshActual(), 60_000).unref?.();

// ── 충전일 스스로 알아내기 ──
// 크레딧이 바닥나(0) 12시간 넘게 멈췄던 키가 다시 되면 그날을 충전일로 본다(하루 이틀 차이는 무시 — 잡음 방지).
function learnRefill({ localId, serverId, zeroAt }) {
  if (!zeroAt || Date.now() - zeroAt < 12 * 3_600_000) return;
  const today = new Date().getDate();
  const m = localId ? store.meta().find(k => k.id === localId) : null;
  const sk = serverId ? (remote.state().data?.keys || []).find(k => k.id === serverId) : null;
  const credit = m?.credit || sk?.credit;
  if (!credit?.amount || !credit?.day || actual.dayGap(credit.day, today) < 2) return;
  const next = { amount: credit.amount, day: today };
  if (localId) { store.update(localId, { credit: next }); reloadKeys(); }
  if (serverId) remote.api('PATCH', `/admin/keys/${serverId}`, { credit: next }).catch(() => {});
  notify(`${m?.name || sk?.name || '키'} 충전일을 매달 ${today}일로 바꿨어요`, `크레딧이 바닥났다가 오늘 다시 들어왔어요(전에는 ${credit.day}일). 아니라면 키 설정에서 고칠 수 있어요.`);
}

let lastPoll = 0, lastNas = 0;
setInterval(() => {
  if (quitting || !serverCfg()) return;
  const fast = viaServer() && alive() && win.isVisible();
  if (fast || Date.now() - lastPoll > 60_000) { lastPoll = Date.now(); remote.poll().then(() => syncPairs()).catch(() => {}); }
  if (store.settings().dataDir && Date.now() - lastNas > 10 * 60_000) { lastNas = Date.now(); remote.syncNas(); }
}, 4000).unref?.();
pool.on('usage', ({ id, model, cost }) => { usage?.record({ keyId: id, model, cost }); lowCreditCheck(id); push(); });
pool.on('revived', ({ id }) => {
  const c = usage?.calibOf(id);
  if (c && c.remaining === 0) { learnRefill({ localId: id, serverId: pairOf({ localId: id })?.serverId, zeroAt: c.at }); usage.clearCalib(id); }
  refreshActual(true);   // 다시 살아났으면 실제 사용액도 바로 다시 읽는다
});
const lowWarned = new Map();
function lowCreditCheck(id) {
  const m = store.meta().find(k => k.id === id);
  if (!m?.credit || !usage) return;
  const p = pairStates().find(x => x.localId === id && x.d.kind === 'sync');
  const cs = p ? pairs.combine(p.L, p.S, p.d.anchor) : usage.creditState(id, m.credit);
  if (!cs.configured || cs.ratio > 0.1) return;
  if (lowWarned.get(id) === cs.cycleStart) return;
  lowWarned.set(id, cs.cycleStart);
  notify(`${m.name} 크레딧이 10% 아래예요`, `남은 크레딧 약 $${cs.remaining.toFixed(2)}. 다 쓰면 자동으로 다음 키로 넘어갑니다.`);
}
pool.on('rest', ({ id, name, kind, minutes }) => {
  if (kind === 'exhausted' && usage) { const m = store.meta().find(k => k.id === id); if (m?.tier === 'credit' && (m.provider === 'claude' || m.credit)) usage.calibrate(id, 0); }
  if (kind === 'exhausted') notify(`${name} 키가 쉬는 중이에요`, `크레딧이 떨어졌거나 사용 한도에 닿았어요. 다음 키로 넘겼고, ${minutes}분 뒤 다시 시험합니다.`);
  if (kind === 'auth') notify(`${name} 키를 쓸 수 없어요`, '키가 지워졌거나 권한이 없습니다. 앱에서 키를 확인하세요.');
});
let lastAllDown = 0;
pool.on('allDown', ({ provider } = {}) => {
  if (Date.now() - lastAllDown < 10 * 60_000) return;
  lastAllDown = Date.now();
  const kind = provider === 'gpt' ? 'GPT' : 'Claude';
  notify(`쓸 수 있는 ${kind} 키가 없어요`, `${kind} 키가 모두 쉬는 중이라 요청이 실패했습니다. 예비 키를 추가하면 끊기지 않아요.`);
});

function reloadKeys() { pool.setKeys(store.keys()); push(); }

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 820, minWidth: 900, minHeight: 680, show: false,
    title: 'OVIS Gate', backgroundColor: THEME[isDark() ? 'dark' : 'light'].plate, icon: asset('icon.png'),
    titleBarStyle: 'hidden', titleBarOverlay: { color: THEME[isDark() ? 'dark' : 'light'].plate, symbolColor: THEME[isDark() ? 'dark' : 'light'].ink, height: 52 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden || ENV.CKP_SCREENSHOT) win.show(); });
  win.webContents.once('did-finish-load', markHealthy);
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!store.settings().trayHintShown) {
      store.setSetting('trayHintShown', true);
      notify('OVIS Gate는 계속 켜져 있어요', '오른쪽 아래 트레이 아이콘에서 다시 열거나 끌 수 있습니다.');
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}

function showWindow() { if (!alive()) createWindow(); win.show(); win.focus(); }

function updateTray() {
  if (!tray) return;
  const snap = pool.snapshot();
  const ready = snap.filter(k => k.state === 'ready' || k.state === 'live').length;
  tray.setToolTip(portError ? 'OVIS Gate — 시작하지 못함' : `OVIS Gate — 키 ${snap.length}개 중 ${ready}개 사용 가능`);
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: showWindow },
    { label: '주소 복사', click: () => clipboard.writeText(ADDRESS) },
    { type: 'separator' },
    { label: '끄기', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
  updateTray();
}

function applyAutoStart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: Boolean(store.settings().autoStart), args: ['--hidden'], name: 'ClaudeKeyPool' });
}

// ── 화면에서 오는 요청 ─────────────────────────────
const KEY_RE = ENV.CKP_ALLOW_ANY_KEY ? /sk-[A-Za-z0-9_\-]{2,}/g : /sk-[A-Za-z0-9_\-]{20,}/g;   // Claude: sk-ant-… / GPT: sk-proj-…, sk-svcacct-…, sk-…
ipcMain.handle('state', () => state());
ipcMain.handle('add-keys', async (_e, { text, tier, name }) => {
  if (viaServer()) return onServer(() => remote.api('POST', '/admin/keys', { text, tier, name }), { added: 0, results: [{ ok: false, message: '서버에 연결할 수 없어요' }] });
  const found = [...new Set(String(text || '').match(KEY_RE) || [])];
  if (!found.length) return { added: 0, results: [{ ok: false, message: 'sk- 로 시작하는 Claude 또는 GPT 키를 붙여넣어 주세요' }] };
  const results = [];
  let added = 0;
  for (const [i, key] of found.entries()) {
    const tail = key.slice(-4);
    if (store.hasKey(key)) { results.push({ tail, ok: false, message: '이미 등록된 키입니다' }); continue; }
    if (/^sk-ant-admin/.test(key)) { results.push({ tail, ok: false, message: '관리자(Admin) 키는 요청에 쓸 수 없어요. 일반 API 키를 넣어 주세요' }); continue; }
    const provider = providerOfKey(key);
    const kind = provider === 'gpt' ? 'GPT' : 'Claude';
    const t = ENV.CKP_SKIP_TEST ? { ok: true, message: '정상 키입니다' } : await testKey(key, provider === 'gpt' ? UPSTREAM_GPT : UPSTREAM, provider);
    const offline = !t.ok && t.message.startsWith('인터넷');
    if (!t.ok && !offline) { results.push({ tail, ok: false, message: `${kind} 키: ${t.message}` }); continue; }
    store.addKey({ key, provider, tier: tier === 'paid' ? 'paid' : 'credit', name: found.length > 1 && name ? `${name} ${i + 1}` : name });
    added++;
    results.push({ tail, ok: true, message: offline ? `${kind} 키로 추가함 — 인터넷이 안 돼 확인은 못 했어요` : `${kind} 키로 추가함` });
  }
  reloadKeys();
  return { added, results };
});
ipcMain.handle('rename', (_e, { id, name }) => { if (viaServer()) return onServer(() => remote.api('PATCH', `/admin/keys/${id}`, { name })); store.update(id, { name: String(name).trim().slice(0, 24) || '이름 없음' }); reloadKeys(); });
ipcMain.handle('set-tier', (_e, { id, tier }) => { if (viaServer()) return onServer(() => remote.api('PATCH', `/admin/keys/${id}`, { tier })); store.update(id, { tier: tier === 'paid' ? 'paid' : 'credit' }); reloadKeys(); });
ipcMain.handle('move', (_e, { id, dir }) => { if (viaServer()) return onServer(() => remote.api('POST', `/admin/keys/${id}/move`, { dir })); store.move(id, dir < 0 ? -1 : 1); reloadKeys(); });
ipcMain.handle('remove', (_e, { id }) => { if (viaServer()) return onServer(() => remote.api('DELETE', `/admin/keys/${id}`)); store.remove(id); reloadKeys(); });
ipcMain.handle('wake', (_e, { id }) => { if (viaServer()) return onServer(() => remote.api('POST', `/admin/keys/${id}/wake`)); pool.wake(id); });
ipcMain.handle('test', async (_e, { id }) => {
  if (viaServer()) return onServer(() => remote.api('POST', `/admin/keys/${id}/test`, null, { timeout: 30000 }), { ok: false, message: '서버에 연결할 수 없어요' });
  const k = store.keys().find(x => x.id === id);
  if (!k) return { ok: false, message: '키를 찾지 못했습니다' };
  const r = await testKey(k.key, k.provider === 'gpt' ? UPSTREAM_GPT : UPSTREAM, k.provider);
  if (r.ok) pool.wake(id);
  return r;
});
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('set-autostart', (_e, on) => { store.setSetting('autoStart', Boolean(on)); applyAutoStart(); push(); });
ipcMain.handle('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('set-credit', async (_e, { id, amount, day, remaining }) => {
  const a = Number(amount), d = Number(day);
  const credit = a > 0 && d >= 1 && d <= 31 ? { amount: a, day: Math.round(d) } : null;
  const hasRemaining = remaining !== '' && remaining != null && Number.isFinite(Number(remaining));
  // 같은 키가 이 PC 와 서버에 다 있으면 크레딧 설정(금액·충전일)은 양쪽에 같이 넣는다. 남은 금액은 syncPairs 가 양쪽을 맞춘다
  if (viaServer()) {
    const pair = pairOf({ serverId: id });
    const r = await onServer(() => remote.api('PATCH', `/admin/keys/${id}`, { credit: { amount, day }, remaining }));
    if (pair) { store.update(pair.localId, { credit }); reloadKeys(); }
    await syncPairs();
    refreshActual(true);
    return r;
  }
  const pair = pairOf({ localId: id });
  store.update(id, { credit });
  if (hasRemaining) usage.calibrate(id, Number(remaining));
  reloadKeys();
  if (pair) await onServer(() => remote.api('PATCH', `/admin/keys/${pair.serverId}`, { credit: { amount, day } }));
  await syncPairs();
  refreshActual(true);
});
/** 화면의 키(이 PC 또는 서버) → 종류·끝자리 */
function viewKey(id) {
  const list = viaServer() ? (remote.state().data?.keys || []) : pool.snapshot();
  const k = list.find(x => x.id === id);
  return k ? { sig: sigOf(k.provider, k.tail), provider: k.provider || 'claude' } : null;
}
ipcMain.handle('set-admin-key', async (_e, { id, key }) => {
  const vk = viewKey(id); if (!vk) return { ok: false, error: '키를 찾지 못했어요' };
  const k = String(key || '').trim();
  const kind = actual.adminKeyKind(k);
  if (!kind) return { ok: false, error: vk.provider === 'gpt' ? 'OpenAI 관리자 키는 sk-admin- 으로 시작해요' : 'Claude 관리자 키는 sk-ant-admin 으로 시작해요' };
  if (kind !== vk.provider) return { ok: false, error: kind === 'gpt' ? '이건 OpenAI 관리자 키예요. Claude 키에는 Claude 관리자 키(sk-ant-admin…)를 넣어 주세요' : '이건 Claude 관리자 키예요. GPT 키에는 OpenAI 관리자 키(sk-admin-…)를 넣어 주세요' };
  const e = actualTargets().find(t => t.sig === vk.sig);
  if (!e) return { ok: false, error: '먼저 매달 받는 크레딧과 충전일을 저장해 주세요' };
  let r; try { r = await readActual(e, { key: k, via: 'admin' }); } catch { r = { ok: false, status: 0 }; }
  if (!r?.ok) return { ok: false, error: actual.denied(r?.status) ? '이 관리자 키로 비용 보고서를 읽지 못했어요. 키를 만든 계정(조직)이 이 키와 같은지 확인해 주세요' : '비용 보고서에 연결하지 못했어요. 잠시 뒤 다시 해 주세요' };
  store.setSecret(adminName(vk.sig), k);
  await withLock(() => anchorKey(e, r.remaining));
  actualState.set(vk.sig, { ok: true, via: 'admin', cycleCost: r.cycleCost, remaining: r.remaining, checkedAt: Date.now(), needAdmin: false, error: null });
  push();
  return { ok: true, cycleCost: r.cycleCost, remaining: r.remaining };
});
ipcMain.handle('clear-admin-key', async (_e, { id }) => {
  const vk = viewKey(id); if (!vk) return { ok: false };
  store.setSecret(adminName(vk.sig), null);
  actualState.delete(vk.sig);
  const probe = { ...(store.settings().actualProbe || {}) }; delete probe[vk.sig]; store.setSetting('actualProbe', probe);
  refreshActual(true); push();
  return { ok: true };
});
ipcMain.handle('refresh-actual', async () => { await refreshActual(true); return true; });
ipcMain.handle('clear-calib', async (_e, { id }) => {
  const pair = pairOf(viaServer() ? { serverId: id } : { localId: id });
  if (viaServer() || pair) await onServer(() => remote.api('DELETE', `/admin/keys/${pair ? pair.serverId : id}/calib`));
  if (!viaServer() || pair) usage.clearCalib(pair ? pair.localId : id);
  if (pair) { const recs = { ...(store.settings().pairSync || {}) }; delete recs[pair.serverId]; store.setSetting('pairSync', recs); }
  push();
});
ipcMain.handle('report', () => viaServer() ? onServer(() => remote.api('GET', '/admin/report'), null) : usage.report(store.meta()));
ipcMain.handle('export-csv', async () => {
  const names = new Map(store.meta().map(m => [m.id, m.name]));
  const d = new Date(); const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const r = await dialog.showSaveDialog(win, { title: '사용 기록 내보내기', defaultPath: path.join(app.getPath('documents'), `OVIS게이트-사용기록-${stamp}.csv`), filters: [{ name: 'CSV (엑셀)', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  if (viaServer()) {
    const text = await onServer(() => remote.api('GET', '/admin/csv?kind=daily', null, { raw: true, timeout: 30000 }), null);
    if (text == null) return { ok: false };
    fs.writeFileSync(r.filePath, text);
  } else fs.writeFileSync(r.filePath, usage.csv(id => names.get(id) ?? '삭제된 키'));
  shell.showItemInFolder(r.filePath);
  return { ok: true, path: r.filePath };
});
ipcMain.handle('server-connect', async (_e, { url, token }) => {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//.test(u)) u = 'https://' + u;
  if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u)) return { ok: false, error: '주소는 https://로 시작하는 Render 주소여야 해요(예: https://claude-keypool.onrender.com)' };
  const t = String(token || '').trim();
  if (t.length < 16) return { ok: false, error: '관리 토큰(ADMIN_TOKEN)을 붙여넣어 주세요' };
  try { await remote.api('GET', '/admin/state', null, { config: { url: u, token: t }, timeout: 20000 }); }
  catch (e) { return { ok: false, error: remote.friendly(e) }; }
  store.setSetting('serverUrl', u); store.setSecret('serverToken', t); store.setSetting('source', 'server');
  remote.reset(); await remote.poll(); remote.syncNas(); syncPairs().then(() => refreshActual(true)); push();
  return { ok: true };
});
ipcMain.handle('server-disconnect', () => { store.setSetting('serverUrl', null); store.setSecret('serverToken', null); store.setSetting('source', 'local'); remote.reset(); push(); });
ipcMain.handle('set-source', async (_e, src) => { store.setSetting('source', src === 'server' ? 'server' : 'local'); if (src === 'server') await remote.poll(); push(); });
ipcMain.handle('server-import-local', async () => {
  const keys = store.keys().map(k => ({ key: k.key, tier: k.tier, provider: k.provider, name: k.name, credit: k.credit }));
  if (!keys.length) return { ok: false, error: '이 PC에 등록된 키가 없어요' };
  const r = await onServer(() => remote.api('POST', '/admin/import', { keys }, { timeout: 30000 }), null);
  if (r) await syncPairs();   // 옮긴 키의 남은 금액도 이 PC 값으로 맞춘다
  return r ? { ok: true, ...r } : { ok: false, error: '서버에 연결할 수 없어요' };
});
ipcMain.handle('server-sync-nas', async () => { await remote.syncNas(); return remote.state(); });
ipcMain.handle('set-theme', (_e, theme) => { store.setSetting('theme', ['light', 'dark'].includes(theme) ? theme : 'system'); applyTheme(); push(); });
ipcMain.handle('check-update', async () => { await updater?.check(); push(); return updater?.state; });
ipcMain.handle('apply-update', () => applyUpdate(true));
ipcMain.handle('choose-data-dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: '사용 기록을 저장할 폴더(NAS 등) 고르기', properties: ['openDirectory', 'createDirectory'],
    defaultPath: store.settings().dataDir || app.getPath('documents') });
  if (r.canceled || !r.filePaths?.[0]) return { canceled: true };
  const dir = r.filePaths[0];
  let res = await usage.setMirror(dir, 'check');
  if (res.conflict) {
    const c = res.conflict;
    const pick = await dialog.showMessageBox(win, { type: 'question', title: '이 폴더에 이미 기록이 있어요',
      message: '이 폴더에 이미 OVIS Gate 사용 기록이 있어요.',
      detail: `폴더의 기록: 요청 ${c.theirs.toLocaleString('ko-KR')}건${c.since ? ` (${c.since}부터)` : ''}\n이 PC의 기록: 요청 ${c.ours.toLocaleString('ko-KR')}건\n\n다른 PC나 다시 설치하기 전 기록이라면 "불러오기"를 고르세요.`,
      buttons: ['폴더의 기록 불러오기', '이 PC 기록으로 덮어쓰기', '취소'], defaultId: 0, cancelId: 2, noLink: true });
    if (pick.response === 2) return { canceled: true };
    res = await usage.setMirror(dir, pick.response === 0 ? 'adopt' : 'overwrite');
  } else if (res.ok !== false) res = await usage.setMirror(dir, 'overwrite');
  if (res.ok === false) return { ok: false, error: res.error };
  store.setSetting('dataDir', dir); push();
  return { ok: true, dir };
});
ipcMain.handle('clear-data-dir', async () => { await usage.setMirror(null); store.setSetting('dataDir', null); push(); });
ipcMain.handle('open-data-dir', () => { const d = store.settings().dataDir; if (d) shell.openPath(d); });
ipcMain.handle('takeover', async () => {
  // 예전 배치파일 버전(node claude-pool-proxy.mjs)을 끄고, 윈도우 시작 시 자동 실행도 지운 뒤 다시 켠다
  const { execFile } = require('node:child_process');
  const cmd = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*claude-pool-proxy*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; " +
    "Remove-Item \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\ClaudePoolProxy.lnk\" -ErrorAction SilentlyContinue";
  await new Promise(r => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 15000 }, () => r()));
  await new Promise(r => setTimeout(r, 1200));
  await startPool();
  return state();
});
ipcMain.handle('retry-port', async () => { await startPool(); return state(); });

// ── 자동 업데이트 ─────────────────────────────
const updatesDir = () => path.join(app.getPath('userData'), 'updates');
function markHealthy() {
  // 이 판이 제대로 켜졌다 → 부팅 실패 카운터를 지운다
  let ofs; try { ofs = require('original-fs'); } catch { ofs = fs; }
  if (global.CKP_APP_ROOT && global.CKP_APP_ROOT !== global.CKP_BUNDLED_ROOT) { try { ofs.unlinkSync(path.join(updatesDir(), 'booting.json')); } catch {} }
  const cur = (() => { try { return JSON.parse(ofs.readFileSync(path.join(updatesDir(), 'just-updated.json'), 'utf8')); } catch { return null; } })();
  if (cur && cur.version === APP_VERSION) {
    try { ofs.unlinkSync(path.join(updatesDir(), 'just-updated.json')); } catch {}
    notify(`${APP_VERSION} 버전으로 업데이트했어요`, cur.notes || '새 기능이 적용됐습니다.');
  }
}
let lastActivity = Date.now();
pool.on('log', () => { lastActivity = Date.now(); });
function applyUpdate(force = false) {
  const st = updater?.state;
  if (st?.status !== 'ready') return false;
  const busy = pool.snapshot().some(k => k.state === 'live');
  const idle = Date.now() - lastActivity > 60_000;
  const away = !alive() || !win.isVisible() || !win.isFocused();
  if (!force && (busy || !idle || !away)) return false;
  let ofs; try { ofs = require('original-fs'); } catch { ofs = fs; }
  try { ofs.writeFileSync(path.join(updatesDir(), 'just-updated.json'), JSON.stringify({ version: st.version, notes: st.notes })); } catch {}
  const args = process.argv.slice(1).filter(a => a !== '--hidden');
  if (!alive() || !win.isVisible()) args.push('--hidden');
  quitting = true; store.flush(); usage?.flush();
  app.relaunch({ args });
  app.exit(0);
  return true;
}
// ── 가격표 — 업데이트 저장소의 prices.json(있으면)으로 새 모델 가격을 앱 업데이트 없이 반영 ──
const pricesFile = () => path.join(app.getPath('userData'), 'prices.json');
function loadCachedPrices() { try { pricing.applyRemotePrices(JSON.parse(fs.readFileSync(pricesFile(), 'utf8'))); } catch {} }
async function refreshPrices() {
  try {
    const base = require('./updater').UPDATE_BASE;
    const r = await fetch(`${base}/prices.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (pricing.applyRemotePrices(j)) {
      fs.writeFileSync(pricesFile(), JSON.stringify(j));
      const rp = usage?.reprice(pricing.priceTokens);
      if (rp && (rp.fixed || rp.usdAdded)) push();
    }
  } catch {}
}
function startUpdater() {
  if (!ENV.CKP_NO_UPDATE) { setTimeout(refreshPrices, 15_000); setInterval(refreshPrices, 6 * 60 * 60_000); }
  if (ENV.CKP_NO_UPDATE) return;
  updater = createUpdater({ dir: updatesDir(), currentVersion: APP_VERSION, onReady: () => push() });
  setTimeout(() => updater.check().then(push), ENV.CKP_UPDATE_FIRST_MS ? Number(ENV.CKP_UPDATE_FIRST_MS) : 20_000);
  setInterval(() => updater.check().then(push), 6 * 60 * 60_000);
  setInterval(() => applyUpdate(false), 60_000);   // 쓰지 않을 때(1분 넘게 요청 없음 + 창을 보고 있지 않음) 조용히 적용
}

// 미리보기 화면용 가짜 기록(CKP_SEED_USAGE 가 있을 때만)
function seedDemoUsage() {
  const metas = store.meta(); let x = 7;
  const rnd = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  const credits = { credit: [{ amount: 200, day: 21 }, { amount: 100, day: 3 }] };
  metas.filter(m => m.tier === 'credit' && m.provider === 'claude').forEach((m, i) => store.update(m.id, { credit: credits.credit[i] ?? null }));
  for (let d = 29; d >= 0; d--) {
    const at = Date.now() - d * 86400000;
    metas.forEach((m, i) => {
      const busy = m.tier === 'paid' ? (d < 4 ? 0.6 : 0) : 1 - i * 0.35;
      const n = Math.round(rnd() * 22 * busy * (d % 7 === 0 || d % 7 === 6 ? 0.3 : 1));
      for (let k = 0; k < n; k++) {
        const gpt = m.provider === 'gpt';
        const model = gpt ? (rnd() < 0.7 ? 'gpt-6-luna' : 'gpt-6.1-sol') : rnd() < 0.7 ? 'claude-haiku-5-5' : rnd() < 0.8 ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
        const u = gpt ? { prompt_tokens: Math.round(4000 + rnd() * 30000), completion_tokens: Math.round(300 + rnd() * 3000), prompt_tokens_details: { cached_tokens: Math.round(rnd() * 3000) } }
          : { input_tokens: Math.round(4000 + rnd() * 30000), output_tokens: Math.round(300 + rnd() * 3000), cache_read_input_tokens: Math.round(rnd() * 20000) };
        const P = require('./pricing');
        const cost = gpt ? P.costOfGpt(model, u) : P.costOf(model, u);
        usage.record({ keyId: m.id, model, cost, at });
        if (d <= 1) usage.addLog({ at: at - Math.round(rnd() * 8 * 3600000), name: m.name, id: m.id, provider: m.provider, path: gpt ? '/v1/chat/completions' : '/v1/messages', model, status: 200, ms: 800,
          usd: cost.usd, tokens: cost.usage.input + cost.usage.read + cost.usage.output, tokIn: cost.usage.input + cost.usage.read, tokOut: cost.usage.output, tokRead: cost.usage.read, charged: true });
      }
    });
  }
}

async function startPool() {
  try { await pool.start(); portError = null; }
  catch (e) {
    portError = e?.code === 'EADDRINUSE' ? 'in-use' : (e?.message || 'unknown');
    if (portError === 'in-use') {
      // 누가 쓰고 있나? 예전 배치파일 버전이면 상태 페이지에 이 제목이 있다
      try { const t = await (await fetch(`${ADDRESS}/_pool`, { signal: AbortSignal.timeout(2500) })).text(); if (t.includes('Claude 키 묶음 — 상태')) portError = 'old-version'; } catch {}
    }
  }
  push();
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; store.flush(); usage?.flush(); });
app.on('window-all-closed', e => e.preventDefault?.());

app.whenReady().then(async () => {
  if (!gotLock) return;
  renameShortcuts();   // 1.6.0: 바로 가기·설치 목록 이름을 OVIS Gate 로
  store.load();
  if (ENV.CKP_DATADIR) store.setSetting('dataDir', ENV.CKP_DATADIR);   // 시험용
  usage = createUsageStore(path.join(app.getPath('userData'), 'usage.json'), { nameOf: id => store.meta().find(m => m.id === id)?.name ?? '삭제된 키' });
  usage.onMirrorChange(() => push());
  loadCachedPrices();
  const rp = usage.reprice(pricing.priceTokens);   // 새 가격표로 '가격 모름' 기록 다시 계산
  if (rp.fixed || rp.usdAdded) console.log(`[prices] 예전 기록 ${rp.fixed}건 다시 계산, 건별 요금 +$${rp.usdAdded.toFixed(4)}`);
  if (store.settings().dataDir) usage.setMirror(store.settings().dataDir, 'startup').then(push);
  if (ENV.CKP_SEED) for (const line of ENV.CKP_SEED.split(';')) { const [tier, name, key, provider = 'claude'] = line.split('|'); if (!store.hasKey(key)) store.addKey({ tier, name, key, provider }); }
  if (ENV.CKP_SEED_USAGE) seedDemoUsage();
  reloadKeys();
  await startPool();
  applyTheme();
  if (serverCfg()) { remote.poll().then(() => syncPairs()).then(() => refreshActual(true)).catch(() => {}); setTimeout(() => remote.syncNas(), 8000); }
  else setTimeout(() => refreshActual(true), 5000);
  createWindow();
  createTray();
  applyAutoStart();
  startUpdater();
  nativeTheme.on('updated', () => { applyTheme(false); push(); });
  if (ENV.CKP_SCREENSHOT) {
    const delay = Number(ENV.CKP_SCREENSHOT_DELAY || 2500);
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (ENV.CKP_SCREENSHOT_JS) await win.webContents.executeJavaScript(ENV.CKP_SCREENSHOT_JS).catch(() => {});
      await new Promise(r => setTimeout(r, 600));
      if (ENV.CKP_STATE_DUMP) {   // 시험용: 두 화면(이 PC / 서버) 상태를 파일로
        try { const src = store.settings().source; const dump = {}; for (const v of ['local', 'server']) { store.setSetting('source', v); dump[v] = state(); } store.setSetting('source', src); fs.writeFileSync(ENV.CKP_STATE_DUMP, JSON.stringify(dump)); }
        catch (e) { fs.writeFileSync(ENV.CKP_STATE_DUMP, JSON.stringify({ error: String(e && e.stack || e) })); }
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(ENV.CKP_SCREENSHOT, img.toPNG());
      quitting = true; app.exit(0);
    }, delay));
  }
});
