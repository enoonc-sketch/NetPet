// 1.3.3 附加功能的纯逻辑（不依赖 Electron，可单元测试）：流量额度、新程序首次联网、久坐/喝水提醒、电池损耗。

/* ---------- 流量额度 ---------- */
/** 返回这次应该提醒的档位（80 / 100），没有新档位返回 0。notified 是本月已提醒过的最高档。 */
export function quotaStep(usedBytes: number, limitGB: number, notified: number): 0 | 80 | 100 {
  if (!(limitGB > 0)) return 0;
  const pct = (usedBytes / (limitGB * 1073741824)) * 100;
  if (pct >= 100 && notified < 100) return 100;
  if (pct >= 80 && notified < 80) return 80;
  return 0;
}

/* ---------- 新程序首次联网 ---------- */
/** 开启后先“学习” learnMs（默认 24 小时）：这段时间里见到的程序都记为已知、不提醒；之后第一次出现的程序才提醒。 */
export class NewProcWatcher {
  known: Set<string>;
  constructor(known: string[] = [], public learnUntil = 0, public cap = 3000) { this.known = new Set(known.map((s) => s.toLowerCase())); }
  /** 返回需要提醒的程序名（原始大小写）。 */
  see(now: number, procs: string[]): string[] {
    const out: string[] = [];
    for (const p of procs) {
      const k = String(p || '').toLowerCase();
      if (!k || /^pid \d+$/.test(k) || this.known.has(k)) continue;
      this.known.add(k);
      if (now >= this.learnUntil) out.push(p);
    }
    if (this.known.size > this.cap) this.known = new Set([...this.known].slice(-this.cap));
    return out;
  }
  list() { return [...this.known]; }
}

/* ---------- 久坐 / 喝水提醒 ---------- */
/** 每类提醒按“实际在用电脑的时间”计时：离开超过 idleResetSec 视为休息过，久坐计时清零；喝水计时暂停。 */
export class Reminder {
  private sat = 0; private drank = 0; private lastNow: number | null = null;
  constructor(public sitMin = 0, public waterMin = 0, public idleResetSec = 300) {}
  /** 每次调用传入当前时间和系统空闲秒数；muted（勿扰/全屏/暂停）时只计时不提醒。返回要提醒的类型。
      1.5.0：muteSit = true（番茄钟专注中）时久坐提醒只计时不提醒，喝水提醒不受影响。 */
  tick(now: number, idleSec: number, muted: boolean, muteSit = false): ('sit' | 'water')[] {
    const dt = this.lastNow == null ? 0 : Math.max(0, Math.min(120e3, now - this.lastNow)); this.lastNow = now;
    if (idleSec >= this.idleResetSec) { this.sat = 0; return []; }
    this.sat += dt; this.drank += dt;
    const out: ('sit' | 'water')[] = [];
    if (this.sitMin > 0 && this.sat >= this.sitMin * 60e3) { if (!muted && !muteSit) out.push('sit'); this.sat = 0; }
    if (this.waterMin > 0 && this.drank >= this.waterMin * 60e3) { if (!muted) out.push('water'); this.drank = 0; }
    return out;
  }
  reset() { this.sat = 0; this.drank = 0; this.lastNow = null; }
}

/* ---------- 电池健康 ---------- */
/** 损耗百分比 = 1 - 满充容量 / 设计容量；数据不可靠时返回 null。 */
export function batteryWear(designMWh: number, fullMWh: number): number | null {
  if (!(designMWh > 0) || !(fullMWh > 0) || fullMWh > designMWh * 1.2) return null;
  return Math.max(0, Math.round((1 - fullMWh / designMWh) * 100));
}
