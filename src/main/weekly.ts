// 1.5.0 每周使用小结（纯逻辑，可单元测试）。默认开启，完全在本机生成，不联网。
// 规则：新的一周（周一 0 点起，本地时间）里 NetPet 第一次检测到用户在用电脑时，生成“上一周（周一 0 点 ~ 本周一 0 点）”的小结；
// 每周只生成一次（记住已生成的周起始日期）。周一没开机的话，在本周第一次使用时补生成。
import { localDay } from '../shared/report';

/** t 所在那一周的周一 0 点（本地时间）。 */
export function weekStart(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}
/** 上一周的范围 [start, end)，key = 上周一的日期 YYYY-MM-DD。 */
export function lastWeekRange(now) {
  const end = weekStart(now);
  const s = new Date(end); s.setDate(s.getDate() - 7);
  const start = s.getTime();
  const last = new Date(end); last.setDate(last.getDate() - 1);
  return { start, end, key: localDay(start), fromDay: localDay(start), toDay: localDay(last.getTime()) };
}
/** 是否需要生成：开启 + 上周的小结还没生成过。 */
export function shouldGenerate(now, lastKey, enabled) {
  if (!enabled) return false;
  return lastWeekRange(now).key !== lastKey;
}
export interface WeeklyInput {
  range: { start: number; end: number; key: string; fromDay: string; toDay: string };
  days: { day: string; rx: number; tx: number }[];
  health: { t: number; score: number | null }[];
  counters: Record<string, number>;
  cpuPeak: number | null;
}
/** 汇总成一份小结。days 只计入范围内的日期；日均按 7 天算。 */
export function buildSummary(i, now = Date.now()) {
  const inR = (i.days || []).filter((d) => d && d.day >= i.range.fromDay && d.day <= i.range.toDay);
  let rx = 0, tx = 0, peak = null;
  for (const d of inR) {
    const a = Math.max(0, Number(d.rx) || 0), b = Math.max(0, Number(d.tx) || 0);
    rx += a; tx += b;
    if (a + b > 0 && (!peak || a + b > peak.bytes)) peak = { day: d.day, bytes: a + b };
  }
  const hs = (i.health || []).filter((h) => h && h.t >= i.range.start && h.t < i.range.end && h.score != null);
  const scores = hs.map((h) => Number(h.score));
  const c = i.counters || {};
  const n = (k) => Math.max(0, Math.round(Number(c[k]) || 0));
  const cpu = i.cpuPeak == null || !Number.isFinite(Number(i.cpuPeak)) ? null : Math.round(Number(i.cpuPeak));
  return {
    week: i.range.key, from: i.range.fromDay, to: i.range.toDay, generatedAt: now,
    traffic: { rx, tx, total: rx + tx, avg: (rx + tx) / 7, peak, activeDays: inR.filter((d) => d.rx + d.tx > 0).length },
    health: { runs: hs.length, last: scores.length ? scores[scores.length - 1] : null, min: scores.length ? Math.min(...scores) : null },
    reminders: n('remind'), focus: { sessions: n('focus'), minutes: n('focusMin') }, cpuPeak: cpu,
    empty: rx + tx === 0 && hs.length === 0 && n('remind') === 0 && n('focus') === 0 && cpu == null
  };
}
