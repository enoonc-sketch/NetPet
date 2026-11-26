// 1.5.0 网速异常提醒（纯逻辑，不依赖 Electron，可单元测试）。默认关闭。
// 两种情况：
//  - 下载“卡住 / 很慢”：先有一段真正的下载（速度 ≥ 活跃阈值并持续 5 秒，记为“正在下载”），
//    之后速度连续 lowSec 秒低于 lowKB，且这段时间的平均速度仍高于“地板值”（不是下载已经结束、只剩零星后台流量）→ 提醒一次。
//    下载结束后速度会降到几乎为 0，这种情况视为结束，不提醒。
//  - 持续高速：速度连续 highSec 秒 ≥ highMB（0 = 关闭）→ 提醒一次；回落到 80% 以下才会再次计时（防抖）。
// 两类提醒各自有冷却时间（cooldownMin）；muted（勿扰 / 全屏 / 暂停）时只计时、不提醒，也不会在解除后立刻补发。
export interface SpeedAlertCfg { on: boolean; lowKB: number; lowSec: number; highMB: number; highSec: number; cooldownMin: number }
export const SPEED_ALERT_DEFAULT: SpeedAlertCfg = { on: false, lowKB: 50, lowSec: 60, highMB: 0, highSec: 60, cooldownMin: 10 };
export const LOW_KB_CHOICES = [20, 50, 100, 200, 500];
export const LOW_SEC_CHOICES = [30, 60, 120, 300];
export const HIGH_MB_CHOICES = [0, 5, 10, 20, 50, 100];
export const HIGH_SEC_CHOICES = [30, 60, 300, 600];
export const COOLDOWN_CHOICES = [5, 10, 30, 60];
const KB = 1024, MB = 1048576;

/** 校验设置补丁：只接受列表里的值，返回新的完整配置。 */
export function sanitizeSpeedAlert(cur, p) {
  const o = { ...SPEED_ALERT_DEFAULT, ...(cur || {}) };
  if (!p || typeof p !== 'object') return o;
  if (typeof p.on === 'boolean') o.on = p.on;
  if (LOW_KB_CHOICES.includes(p.lowKB)) o.lowKB = p.lowKB;
  if (LOW_SEC_CHOICES.includes(p.lowSec)) o.lowSec = p.lowSec;
  if (HIGH_MB_CHOICES.includes(p.highMB)) o.highMB = p.highMB;
  if (HIGH_SEC_CHOICES.includes(p.highSec)) o.highSec = p.highSec;
  if (COOLDOWN_CHOICES.includes(p.cooldownMin)) o.cooldownMin = p.cooldownMin;
  return o;
}

export class SpeedAlert {
  activeSince; armed; lowSince; lowSum; lowN; highSince; highLatched; lastLow; lastHigh;
  constructor() { this.reset(); this.lastLow = -Infinity; this.lastHigh = -Infinity; }
  reset() { this.activeSince = null; this.armed = false; this.lowSince = null; this.lowSum = 0; this.lowN = 0; this.highSince = null; this.highLatched = false; }
  /** 每秒调用一次。rx：当前下载速度（字节/秒），null = 没有数据（监控关闭 / 暂停）。返回这次要提醒的类型。 */
  update(now, rx, cfg, muted) {
    if (!cfg || !cfg.on || rx == null || !Number.isFinite(rx)) { this.reset(); return []; }
    const out = [];
    const cool = Math.max(1, Number(cfg.cooldownMin) || 10) * 60e3;
    const low = Math.max(1, Number(cfg.lowKB) || 50) * KB;
    const active = Math.max(low * 4, 256 * KB);
    const floor = Math.max(2 * KB, low * 0.2);
    // 1) 记“正在下载”
    if (rx >= active) {
      if (this.activeSince == null) this.activeSince = now;
      if (now - this.activeSince >= 5000) this.armed = true;
      this.lowSince = null; this.lowSum = 0; this.lowN = 0;
    } else this.activeSince = null;
    // 2) 下载后变慢 / 卡住
    if (this.armed && rx < low) {
      if (this.lowSince == null) { this.lowSince = now; this.lowSum = 0; this.lowN = 0; }
      this.lowSum += rx; this.lowN++;
      if (now - this.lowSince >= (Number(cfg.lowSec) || 60) * 1000) {
        const avg = this.lowSum / Math.max(1, this.lowN);
        if (avg >= floor && !muted && now - this.lastLow >= cool) { out.push('low'); this.lastLow = now; }
        // 无论是否提醒，这一段下载都算结束：需要重新出现一段真正的下载才会再次计时
        this.armed = false; this.lowSince = null; this.lowSum = 0; this.lowN = 0;
      }
    } else if (rx >= low) { this.lowSince = null; this.lowSum = 0; this.lowN = 0; }
    // 3) 持续高速
    const hiMB = Number(cfg.highMB) || 0;
    if (hiMB > 0) {
      const hi = hiMB * MB;
      if (rx >= hi) {
        if (this.highSince == null) this.highSince = now;
        if (!this.highLatched && now - this.highSince >= (Number(cfg.highSec) || 60) * 1000) {
          this.highLatched = true;
          if (!muted && now - this.lastHigh >= cool) { out.push('high'); this.lastHigh = now; }
        }
      } else {
        this.highSince = null;
        if (rx < hi * 0.8) this.highLatched = false;
      }
    } else { this.highSince = null; this.highLatched = false; }
    return out;
  }
}
