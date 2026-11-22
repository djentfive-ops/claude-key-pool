// 사용량 누적 기록 — 날짜·키·모델별로 합쳐서 저장(요청 내용은 저장하지 않음).
// 남은 크레딧(추정) = 월 크레딧 − 이번 충전 주기 사용액. 실제 값으로 맞추면(보정) 그 시점부터 다시 센다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const pad = n => String(n).padStart(2, '0');
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/** 매달 day 일 0시 기준으로 지금이 속한 충전 주기 [start, next) */
function cycleOf(day, now = Date.now()) {
  const d = new Date(now);
  const at = (y, m) => new Date(y, m, Math.min(day, daysInMonth(y, m)), 0, 0, 0, 0).getTime();
  let start = at(d.getFullYear(), d.getMonth());
  if (start > now) { const p = new Date(d.getFullYear(), d.getMonth() - 1, 1); start = at(p.getFullYear(), p.getMonth()); }
  const s = new Date(start); const n = new Date(s.getFullYear(), s.getMonth() + 1, 1);
  return { start, next: at(n.getFullYear(), n.getMonth()) };
}

const MIRROR_NAME = 'OVIS게이트_사용기록.json';
const OLD_PREFIX = 'Claude키묶음_', NEW_PREFIX = 'OVIS게이트_';   // 1.6.0 이름 바꾸기 — 예전 이름 파일은 새 이름으로 옮긴다(지우지 않음)
const LOG_KEEP = 300;          // 호출 기록(실패 포함)
const CHARGE_KEEP = 3000;      // 건별 요금 기록
const blank = () => ({ days: {}, calib: {}, log: [], charges: [] });
const readJson = f => { try { return { ...blank(), ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return null; } };
const writeAtomic = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f); };

/**
 * file = 이 PC 의 기록(항상 씀, 원본). mirrorDir = 사용자가 고른 폴더(NAS 등) — 같은 내용을 복사해 두고 월별 CSV 도 만든다.
 * NAS 가 잠시 끊겨도 이 PC 기록은 계속 쌓이고, 다시 연결되면 자동으로 맞춰진다.
 */
function createUsageStore(file, { mirrorDir = null, nameOf = id => id } = {}) {
  let data = readJson(file) || blank();
  let mirror = { dir: mirrorDir, ok: null, savedAt: null, error: null };
  let timer = null, csvTimer = null, mirrorBusy = false, mirrorAgain = false;
  const fsp = fs.promises;
  const writeAtomicAsync = async (f, text) => { await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f + '.tmp', text); await fsp.rename(f + '.tmp', f); };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms).unref?.())]);
  const reason = e => (e?.code
    ? '폴더에 저장하지 못했어요(NAS 꺼짐·드라이브 연결 끊김·권한). 이 PC에는 계속 저장되고, 다시 연결되면 자동으로 맞춰요'
    : String(e?.message || e));
  // NAS 쓰기는 비동기 — NAS 가 느리거나 끊겨도 앱(중계)이 멈추지 않는다
  async function writeMirror() {
    if (!mirror.dir) return;
    if (mirrorBusy) { mirrorAgain = true; return; }
    mirrorBusy = true;
    try {
      await withTimeout(writeAtomicAsync(path.join(mirror.dir, MIRROR_NAME), JSON.stringify(data, null, 1)), 20_000);
      mirror = { ...mirror, ok: true, savedAt: Date.now(), error: null };
    } catch (e) { mirror = { ...mirror, ok: false, error: reason(e) }; }
    finally { mirrorBusy = false; onMirror?.(mirror); if (mirrorAgain) { mirrorAgain = false; writeMirror(); } }
  }
  async function writeCsv() {
    if (!mirror.dir || mirror.ok === false) return;
    const m = new Date(); const ym = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
    try { await withTimeout(writeAtomicAsync(path.join(mirror.dir, `OVIS게이트_사용기록_${ym}.csv`), csv(nameOf, ym)), 20_000); } catch {}
    try { await withTimeout(writeAtomicAsync(path.join(mirror.dir, `OVIS게이트_건별요금_${ym}.csv`), chargesCsv(nameOf, ym)), 20_000); } catch {}
  }
  let onMirror = null;
  const save = (now = false) => {
    const write = () => { writeAtomic(file, JSON.stringify(data)); writeMirror(); clearTimeout(csvTimer); csvTimer = setTimeout(writeCsv, 10_000); csvTimer.unref?.(); };
    clearTimeout(timer); if (now) write(); else { timer = setTimeout(write, 1500); timer.unref?.(); }
  };
  // NAS 가 끊겼다 돌아오면 다시 맞춘다
  const retry = setInterval(async () => { if (mirror.dir && mirror.ok === false) { await writeMirror(); if (mirror.ok) writeCsv(); } }, 60_000);
  retry.unref?.();

  /** 폴더 지정. 그 폴더에 이미 기록이 있으면 { conflict } 를 돌려주고, 사용자가 고르면 mode = adopt(불러오기) / overwrite(이 PC 기록으로) 로 다시 부른다 */
  async function setMirror(dir, mode = 'check') {
    if (!dir) { mirror = { dir: null, ok: null, savedAt: null, error: null }; return { ok: true }; }
    try { await withTimeout((async () => { await fsp.mkdir(dir, { recursive: true }); await fsp.access(dir, fs.constants.W_OK); })(), 20_000); }
    catch (e) {
      // 앱이 켜질 때 NAS 가 아직 안 붙어 있으면: 폴더는 기억해 두고 1분마다 다시 시도
      if (mode === 'startup') { mirror = { dir, ok: false, savedAt: null, error: reason(e) }; onMirror?.(mirror); return { ok: false, error: mirror.error }; }
      return { ok: false, error: '이 폴더에 쓸 수 없어요. NAS가 연결돼 있는지, 쓰기 권한이 있는지 확인하세요' };
    }
    // 예전 이름(Claude키묶음_…) 파일 → 새 이름(OVIS게이트_…). 새 이름이 이미 있으면 건드리지 않는다
    try { await withTimeout((async () => { for (const f of await fsp.readdir(dir)) if (f.startsWith(OLD_PREFIX)) {
      const to = path.join(dir, NEW_PREFIX + f.slice(OLD_PREFIX.length));
      if (!fs.existsSync(to)) await fsp.rename(path.join(dir, f), to).catch(() => {});
    } })(), 20_000); } catch {}
    let there = null;
    try { there = { ...blank(), ...JSON.parse(await withTimeout(fsp.readFile(path.join(dir, MIRROR_NAME), 'utf8'), 20_000)) }; } catch {}
    if (there && mode === 'startup') there = null;   // 켜질 때는 이 PC 기록이 원본 — 그대로 이어서 쓴다
    if (there && mode === 'check') {
      const count = d => { let n = 0; for (const ks of Object.values(d.days)) for (const ms of Object.values(ks)) for (const r of Object.values(ms)) n += r.n; return n; };
      return { conflict: { theirs: count(there), ours: count(data), since: Object.keys(there.days).sort()[0] || null } };
    }
    if (there && mode === 'adopt') { data = there; writeAtomic(file, JSON.stringify(data)); }
    mirror = { dir, ok: null, savedAt: null, error: null };
    await writeMirror(); await writeCsv();
    return { ok: mirror.ok !== false, error: mirror.error };
  }

  function addLog(e) {
    data.log.unshift({ at: e.at ?? Date.now(), name: e.name, id: e.id, provider: e.provider, path: e.path, model: e.model, status: e.status, ms: e.ms, usd: e.usd ?? null, tokens: e.tokens ?? null,
      hops: e.hops?.length ? e.hops.map(h => ({ name: h.name, kind: h.kind })) : undefined, note: e.note });
    if (data.log.length > LOG_KEEP) data.log.length = LOG_KEEP;
    // 요금이 나간 호출(응답이 와서 사용량이 잡힌 것)은 따로 오래 남긴다
    if (e.charged || e.usd != null || e.tokens != null) {
      (data.charges ||= []).unshift({ at: e.at ?? Date.now(), id: e.id, name: e.name, provider: e.provider, model: e.model,
        usd: e.usd ?? null, in: e.tokIn ?? null, out: e.tokOut ?? null, read: e.tokRead ?? null, cw: e.tokCw ?? null, approx: e.approx || undefined });
      if (data.charges.length > CHARGE_KEEP) data.charges.length = CHARGE_KEEP;
    }
    save();
  }
  /**
   * 가격을 몰라 '가격 모름'으로 남은 예전 기록을 지금 가격표로 다시 계산한다(새 모델 가격이 들어왔을 때).
   * 날짜별 합계: 그 모델의 요청이 전부 가격 모름이었을 때만(토큰이 따로 남아 있어 정확히 계산 가능).
   * 건별 요금: 요금이 비어 있는 건만. 남은 크레딧 보정값(calib)도 그만큼 반영한다.
   */
  function reprice(priceTokens) {
    let fixed = 0, usdAdded = 0;
    for (const [day, ks] of Object.entries(data.days)) for (const [keyId, ms] of Object.entries(ks)) for (const [model, r] of Object.entries(ms)) {
      if (!r.unpriced || r.unpriced !== r.n) continue;
      const c = priceTokens(model, { input: r.in, read: r.read, cw: r.cw, output: r.out });
      if (c.usd == null) continue;
      r.usd = c.usd; r.unpriced = 0; if (c.approx) r.approx = r.n; fixed += r.n;
    }
    for (const ch of data.charges || []) {
      if (ch.usd != null || ch.in == null || !ch.model) continue;
      const read = ch.read || 0, cw = ch.cw || 0;
      const c = priceTokens(ch.model, { input: Math.max(0, ch.in - read - cw), read, cw, output: ch.out || 0 });
      if (c.usd == null) continue;
      ch.usd = c.usd; if (c.approx) ch.approx = true; usdAdded += c.usd;
      const cal = data.calib[ch.id]; if (cal && ch.at >= cal.at) cal.spentAfter += c.usd;
    }
    if (fixed || usdAdded) save(true);
    return { fixed, usdAdded };
  }
  const recentLog = (n = 40) => data.log.slice(0, n);
  const recentCharges = (n = 200) => (data.charges || []).slice(0, n);
  function chargesCsv(nameOf, monthPrefix) {
    const rows = [['날짜', '시각', '키', '모델', '입력 토큰', '출력 토큰', '그중 캐시 읽기', '요금(USD, 추정)']];
    for (const c of [...(data.charges || [])].sort((a, b) => a.at - b.at)) {   // 시간 순서대로
      const d = new Date(c.at); const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (monthPrefix && !day.startsWith(monthPrefix)) continue;
      rows.push([day, `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, nameOf(c.id) ?? c.name, c.model ?? '', c.in ?? '', c.out ?? '', c.read ?? '', c.usd == null ? '알 수 없음' : c.usd.toFixed(6)]);
    }
    return '\uFEFF' + rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\r\n');
  }

  function record({ keyId, model, cost, at = Date.now() }) {
    const u = cost.usage;
    const day = (data.days[dayKey(at)] ||= {});
    const k = (day[keyId] ||= {});
    const r = (k[model || '알 수 없음'] ||= { n: 0, in: 0, out: 0, read: 0, cw: 0, usd: 0, unpriced: 0 });
    r.n++; r.in += u.input; r.out += u.output; r.read += u.read; r.cw += u.cwTotal;
    if (cost.usd == null) r.unpriced++; else { r.usd += cost.usd; if (cost.approx) r.approx = (r.approx || 0) + 1; }
    const c = data.calib[keyId];
    if (c && at >= c.at && cost.usd != null) c.spentAfter += cost.usd;
    save();
  }

  /** 실제 남은 금액으로 맞춤(사용자가 입력하거나, 크레딧 부족 응답이 오면 0) */
  function calibrate(keyId, remaining, at = Date.now()) { data.calib[keyId] = { at, remaining: Math.max(0, Number(remaining) || 0), spentAfter: 0 }; save(true); }
  function clearCalib(keyId) { if (data.calib[keyId]) { delete data.calib[keyId]; save(true); } }
  function calibOf(keyId) { return data.calib[keyId] || null; }

  function spent(keyId, fromMs, toMs = Infinity) {
    let usd = 0, n = 0;
    const from = dayKey(fromMs), to = toMs === Infinity ? '9999' : dayKey(toMs - 1);
    for (const [d, keys] of Object.entries(data.days)) {
      if (d < from || d > to) continue;
      for (const r of Object.values(keys[keyId] || {})) { usd += r.usd; n += r.n; }
    }
    return { usd, n };
  }

  /** 키 한 개의 크레딧 상태. credit = { amount, day } */
  function creditState(keyId, credit, now = Date.now()) {
    const month = new Date(now); const monthStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
    const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
    const base = { monthUsd: spent(keyId, monthStart).usd, todayUsd: spent(keyId, t0.getTime()).usd };
    if (!credit?.amount || !credit?.day) return { ...base, configured: false };
    const { start, next } = cycleOf(credit.day, now);
    const cycle = spent(keyId, start);
    const c = data.calib[keyId];
    let remaining, calibrated = false;
    if (c && c.at >= start) { remaining = c.remaining - c.spentAfter; calibrated = true; }
    else remaining = credit.amount - cycle.usd;
    // 예상: 이번 주기 하루 평균으로 계속 쓰면 충전일에 얼마가 남는지 / 언제 바닥나는지
    const dayMs = 86_400_000;
    const days = Math.max(1, (now - start) / dayMs);
    const dailyRate = cycle.usd / days;
    const left = Math.max(0, remaining);
    const daysToRefill = Math.max(0, (next - now) / dayMs);
    const atRefill = left - dailyRate * daysToRefill;
    const exhaustAt = dailyRate > 0 && atRefill < 0 ? now + (left / dailyRate) * dayMs : null;
    return { ...base, configured: true, amount: credit.amount, cycleStart: start, nextRefill: next, cycleUsd: cycle.usd, cycleRequests: cycle.n,
      remaining: left, ratio: Math.max(0, Math.min(1, remaining / credit.amount)), calibrated, calibratedAt: calibrated ? c.at : null,
      dailyRate, projectedAtRefill: atRefill, exhaustAt };
  }

  /** 기록 화면용 묶음 */
  function report(keys, { days = 30, now = Date.now() } = {}) {
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const k = dayKey(d.getTime()); const row = { day: k, byKey: {}, total: 0, n: 0 };
      for (const [keyId, models] of Object.entries(data.days[k] || {})) {
        let usd = 0, n = 0; for (const r of Object.values(models)) { usd += r.usd; n += r.n; }
        row.byKey[keyId] = usd; row.total += usd; row.n += n;
      }
      series.push(row);
    }
    const m = new Date(now); const mPrefix = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
    const models = {}; const perKey = {}; const month = { usd: 0, n: 0, in: 0, out: 0, read: 0, cw: 0, unpriced: 0 };
    let today = { usd: 0, n: 0 };
    for (const [d, ks] of Object.entries(data.days)) {
      if (!d.startsWith(mPrefix)) continue;
      for (const [keyId, ms] of Object.entries(ks)) for (const [model, r] of Object.entries(ms)) {
        const x = (models[model] ||= { n: 0, in: 0, out: 0, read: 0, cw: 0, usd: 0, unpriced: 0 });
        const y = (perKey[keyId] ||= { n: 0, in: 0, out: 0, usd: 0 });
        for (const f of ['n', 'in', 'out', 'read', 'cw', 'usd', 'unpriced', 'approx']) { x[f] = (x[f] || 0) + (r[f] || 0); month[f] = (month[f] || 0) + (r[f] || 0); }
        y.n += r.n; y.in += r.in; y.out += r.out; y.usd += r.usd;
        if (d === dayKey(now)) { today.usd += r.usd; today.n += r.n; }
      }
    }
    const allTime = { usd: 0, n: 0, since: Object.keys(data.days).sort()[0] || null };
    for (const ks of Object.values(data.days)) for (const ms of Object.values(ks)) for (const r of Object.values(ms)) { allTime.usd += r.usd; allTime.n += r.n; }
    return { series, models, perKey, month, today, allTime, credit: Object.fromEntries(keys.map(k => [k.id, creditState(k.id, k.credit, now)])) };
  }

  function csv(nameOf, monthPrefix = null) {
    const rows = [['날짜', '키', '모델', '요청 수', '입력 토큰', '출력 토큰', '캐시 읽기 토큰', '캐시 쓰기 토큰', '사용액(USD, 추정)']];
    for (const d of Object.keys(data.days).sort()) if (!monthPrefix || d.startsWith(monthPrefix)) for (const [keyId, ms] of Object.entries(data.days[d]))
      for (const [model, r] of Object.entries(ms)) rows.push([d, nameOf(keyId), model, r.n, r.in, r.out, r.read, r.cw, r.usd.toFixed(4)]);
    return '﻿' + rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\r\n');
  }

  const setNameOf = fn => { nameOf = fn; };
  const onMirrorChange = fn => { onMirror = fn; };
  return { record, calibrate, clearCalib, calibOf, creditState, report, csv, addLog, reprice, recentLog, recentCharges, chargesCsv, setMirror, setNameOf, onMirrorChange,
    mirrorState: () => ({ ...mirror }), flush: () => save(true), flushMirror: () => writeMirror(), _data: () => data };
}

module.exports = { createUsageStore, cycleOf, dayKey };
