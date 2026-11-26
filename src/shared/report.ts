// 流量日报 / 周报（1.4.0）：把数据库里按天累计的网卡总流量补齐成连续的 N 天，并算合计、日均和最高的一天。
// 纯函数，不依赖 Electron，可单元测试。日期一律用本地时间的 YYYY-MM-DD（与 db.ts 的 day() 一致）。
export interface DayTraffic { day: string; rx: number; tx: number }
export interface TrafficReport { days: DayTraffic[]; total: { rx: number; tx: number }; avg: number; peak: { day: string; bytes: number } | null; activeDays: number }

export const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** 从 now 所在的那天往前取 n 天（含今天），没有数据的日子补 0，按日期从早到晚排列。 */
export function fillDays(rows: DayTraffic[], n: number, now = Date.now()): DayTraffic[] {
  const m = new Map<string, DayTraffic>();
  for (const r of rows || []) if (r && typeof r.day === 'string') m.set(r.day, { day: r.day, rx: Math.max(0, Number(r.rx) || 0), tx: Math.max(0, Number(r.tx) || 0) });
  const out: DayTraffic[] = [];
  const base = new Date(now); base.setHours(12, 0, 0, 0); // 取中午，避免夏令时切换时少一天或多一天
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base); d.setDate(base.getDate() - i);
    const k = localDay(d.getTime());
    out.push(m.get(k) || { day: k, rx: 0, tx: 0 });
  }
  return out;
}

/** 合计、日均（按整段天数平均）、流量最多的一天（全为 0 时为 null）、有流量的天数。 */
export function summarize(days: DayTraffic[]): TrafficReport {
  let rx = 0, tx = 0, peak: { day: string; bytes: number } | null = null, active = 0;
  for (const d of days) {
    rx += d.rx; tx += d.tx;
    const b = d.rx + d.tx;
    if (b > 0) active++;
    if (b > 0 && (!peak || b > peak.bytes)) peak = { day: d.day, bytes: b };
  }
  return { days, total: { rx, tx }, avg: days.length ? (rx + tx) / days.length : 0, peak, activeDays: active };
}
