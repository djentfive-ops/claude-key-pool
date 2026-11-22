'use strict';
// 같은 키(이 PC ↔ 게이트 서버)의 남은 크레딧을 하나로 맞춘다.
// Anthropic·OpenAI 에는 남은 잔액을 알려 주는 공식 API 가 없어서, 한 번 맞춘 기준 금액에서
// 이 PC 로 쓴 금액과 서버로 쓴 금액을 함께 빼서 보여 준다(같은 키면 두 화면 숫자가 같다).
//
// 기준(anchor): 양쪽이 같은 시작점을 가져야 한다.
//  · 둘 다 "맞춘 값 없음"이고 크레딧 설정(금액·충전일)이 같으면 → 기준 = 이번 주기 충전 금액
//  · 앱이 양쪽에 같은 값을 맞춰 넣었으면(기록 rec) → 기준 = 그 값
// 기준이 어긋나면(처음 서버로 옮김, 한쪽에서 금액을 고침, 크레딧 부족으로 0) 앱이 양쪽을 다시 맞춘다.

/** 종류+끝 4자리로 짝짓기. 같은 조합이 둘 이상이면(구별 불가) 짝짓지 않는다. */
function pairKeys(localKeys, serverKeys) {
  const sig = k => `${k.provider || 'claude'}:${k.tail}`;
  const count = (list) => list.reduce((m, k) => m.set(sig(k), (m.get(sig(k)) || 0) + 1), new Map());
  const lc = count(localKeys), sc = count(serverKeys);
  const pairs = [];
  for (const s of serverKeys) {
    if (!s.tail || sc.get(sig(s)) !== 1 || lc.get(sig(s)) !== 1) continue;
    const l = localKeys.find(k => sig(k) === sig(s));
    pairs.push({ localId: l.id, serverId: s.id });
  }
  return pairs;
}

const sameCredit = (a, b) => Boolean(a?.amount && b?.amount && a.day && b.day && Number(a.amount) === Number(b.amount) && Number(a.day) === Number(b.day));

/**
 * 지금 두 쪽이 같은 기준인지 판단하고, 아니면 무엇을 할지 돌려준다.
 * L, S: creditState(이 PC / 서버). lcredit, scredit: 크레딧 설정. lcal: 이 PC 의 맞춘 값 원본({at, remaining}). rec: 앱이 마지막으로 맞춘 기록.
 * spentS(t) / spentL(t): t 이후 서버 / 이 PC 로 쓴 금액.
 */
function decide({ L, S, lcredit, scredit, lcal, rec, spentS, spentL }) {
  // 크레딧 설정(금액·충전일)이 양쪽에 같아야 같은 주기로 셀 수 있다
  if (!L?.configured || !S?.configured || !sameCredit(lcredit, scredit)) return { kind: 'skip' };
  const Lc = Boolean(L.calibrated), Sc = Boolean(S.calibrated);
  if (!Lc && !Sc) return { kind: 'sync', anchor: L.amount, dropRec: Boolean(rec) };
  if (Lc && Sc && rec && rec.atL === L.calibratedAt && rec.atS === S.calibratedAt) return { kind: 'sync', anchor: rec.value };
  const lNew = Lc && (!rec || rec.atL !== L.calibratedAt);
  const sNew = Sc && (!rec || rec.atS !== S.calibratedAt);
  // 크레딧 부족 응답으로 한쪽이 0 이 됐으면 실제 잔액도 0 — 양쪽 0
  if ((lNew && lcal && lcal.remaining === 0) || (sNew && S.remaining === 0)) return { kind: 'push', value: 0 };
  // 맞춰 둔 뒤 한쪽 값이 지워졌으면(키가 다시 살아남 등) 다른 쪽도 지운다 → 충전 금액 기준으로 돌아감
  if (rec && ((rec.atL != null && !Lc) || (rec.atS != null && !Sc))) return { kind: 'clear' };
  if (lNew && (!sNew || L.calibratedAt >= S.calibratedAt)) return { kind: 'push', value: Math.max(0, L.remaining - spentS(L.calibratedAt)) };
  if (sNew) return { kind: 'push', value: Math.max(0, S.remaining - spentL(S.calibratedAt)) };
  if (Lc && !Sc) return { kind: 'push', value: Math.max(0, L.remaining - spentS(L.calibratedAt)) };
  if (Sc && !Lc) return { kind: 'push', value: Math.max(0, S.remaining - spentL(S.calibratedAt)) };
  return { kind: 'skip' };
}

/** 같은 기준일 때 화면에 보일 합친 상태. own = 지금 보는 쪽, other = 반대쪽 */
function combine(own, other, anchor, now = Date.now()) {
  const remaining = Math.max(0, own.remaining + other.remaining - anchor);
  const dayMs = 86_400_000;
  const dailyRate = (own.dailyRate || 0) + (other.dailyRate || 0);
  const daysToRefill = Math.max(0, (own.nextRefill - now) / dayMs);
  const projectedAtRefill = remaining - dailyRate * daysToRefill;
  const exhaustAt = dailyRate > 0 && projectedAtRefill < 0 ? now + (remaining / dailyRate) * dayMs : null;
  return { ...own, remaining, ratio: Math.max(0, Math.min(1, remaining / own.amount)), dailyRate, projectedAtRefill, exhaustAt,
    calibrated: Boolean(own.calibrated || other.calibrated), calibratedAt: own.calibratedAt || other.calibratedAt || null, shared: true };
}

module.exports = { pairKeys, sameCredit, decide, combine };
