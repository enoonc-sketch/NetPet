// 1.5.0 硬件历史曲线的降采样（纯函数，可单元测试）。
// 输入每分钟一条的 {t, cpu, mem, temp}，按 bucketMs 分桶：cpu/mem/temp 取平均，另外记录桶内 CPU 峰值、温度峰值。
// 空桶不输出（NetPet 没运行的时间段），画图时按 gapMs 断开折线。
export interface HwPoint { t: number; cpu: number | null; mem: number | null; temp: number | null }
export interface HwBucket { t: number; cpu: number | null; cpuMax: number | null; mem: number | null; temp: number | null; tempMax: number | null; n: number }

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
export function bucketize(points, bucketMs) {
  const m = new Map();
  for (const p of points || []) {
    if (!p || !Number.isFinite(Number(p.t))) continue;
    const k = Math.floor(Number(p.t) / bucketMs) * bucketMs;
    let b = m.get(k);
    if (!b) { b = { t: k, cs: 0, cn: 0, cm: null, ms: 0, mn: 0, ts: 0, tn: 0, tm: null, n: 0 }; m.set(k, b); }
    b.n++;
    const c = num(p.cpu), me = num(p.mem), te = num(p.temp);
    if (c != null) { b.cs += c; b.cn++; b.cm = b.cm == null ? c : Math.max(b.cm, c); }
    if (me != null) { b.ms += me; b.mn++; }
    if (te != null) { b.ts += te; b.tn++; b.tm = b.tm == null ? te : Math.max(b.tm, te); }
  }
  return [...m.values()].sort((a, b) => a.t - b.t).map((b) => ({
    t: b.t, cpu: b.cn ? b.cs / b.cn : null, cpuMax: b.cm, mem: b.mn ? b.ms / b.mn : null, temp: b.tn ? b.ts / b.tn : null, tempMax: b.tm, n: b.n
  }));
}
/** 把序列按时间间隔断成多段（间隔 > gapMs 视为断开），用于画折线时不把没运行的时间段连起来。 */
export function splitGaps(list, gapMs) {
  const out = []; let cur = [];
  for (const p of list || []) {
    if (cur.length && p.t - cur[cur.length - 1].t > gapMs) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}
/** 24 小时：原始每分钟数据（超过 1500 点时按 2 分钟合并）；7 天：30 分钟一桶。 */
export function rangeSpec(range) {
  return range === '7d' ? { ms: 7 * 864e5, bucket: 30 * 60e3 } : { ms: 864e5, bucket: 60e3 };
}
