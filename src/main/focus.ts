// 1.5.0 番茄钟（纯逻辑，不依赖 Electron，可单元测试）。
// 阶段：idle（未开始）→ focus（专注）→ break（休息）→ idle。可以暂停 / 继续 / 重置 / 跳过当前阶段。
// 计时以“结束时刻”为准（不是每秒减 1），电脑卡顿或休眠唤醒后也不会走偏。
export const FOCUS_MIN_CHOICES = [15, 20, 25, 30, 45, 50, 60];
export const BREAK_MIN_CHOICES = [3, 5, 10, 15];
export interface FocusCfg { focusMin: number; breakMin: number }
export const FOCUS_DEFAULT: FocusCfg = { focusMin: 25, breakMin: 5 };
export interface FocusView { phase: 'idle' | 'focus' | 'break'; running: boolean; remainMs: number; endsAt: number | null; totalMs: number }

export function sanitizeFocus(cur, p) {
  const o = { ...FOCUS_DEFAULT, ...(cur || {}) };
  if (p && FOCUS_MIN_CHOICES.includes(p.focusMin)) o.focusMin = p.focusMin;
  if (p && BREAK_MIN_CHOICES.includes(p.breakMin)) o.breakMin = p.breakMin;
  return o;
}

export class FocusTimer {
  cfg; phase; running; remainMs; endsAt; startedAt;
  constructor(cfg) { this.cfg = { ...FOCUS_DEFAULT, ...(cfg || {}) }; this.reset(); }
  setCfg(cfg) { this.cfg = { ...FOCUS_DEFAULT, ...(cfg || {}) }; if (this.phase === 'idle') this.remainMs = this.cfg.focusMin * 60e3; }
  total() { return (this.phase === 'break' ? this.cfg.breakMin : this.cfg.focusMin) * 60e3; }
  reset() { this.phase = 'idle'; this.running = false; this.endsAt = null; this.startedAt = null; this.remainMs = this.cfg.focusMin * 60e3; }
  /** 开始或继续。idle 时开始一轮专注。 */
  start(now) {
    if (this.running) return false;
    if (this.phase === 'idle') { this.phase = 'focus'; this.remainMs = this.cfg.focusMin * 60e3; this.startedAt = now; }
    this.running = true; this.endsAt = now + this.remainMs; return true;
  }
  pause(now) {
    if (!this.running) return false;
    this.remainMs = Math.max(0, this.endsAt - now); this.running = false; this.endsAt = null; return true;
  }
  /** 跳过当前阶段：专注 → 休息（不计入完成数），休息 → 结束。 */
  skip(now) {
    if (this.phase === 'focus') { this.phase = 'break'; this.remainMs = this.cfg.breakMin * 60e3; this.running = true; this.endsAt = now + this.remainMs; return true; }
    if (this.phase === 'break') { this.reset(); return true; }
    return false;
  }
  /** 每秒调用。到点时返回事件：focusDone（完成一轮专注，自动进入休息）/ breakDone（休息结束，回到 idle）。 */
  tick(now) {
    if (!this.running || this.endsAt == null || now < this.endsAt) return null;
    if (this.phase === 'focus') {
      const minutes = this.cfg.focusMin;
      this.phase = 'break'; this.remainMs = this.cfg.breakMin * 60e3; this.endsAt = now + this.remainMs; this.running = true;
      return { type: 'focusDone', minutes };
    }
    this.reset();
    return { type: 'breakDone', minutes: 0 };
  }
  /** 专注阶段且正在计时（用于“专注期间不弹久坐提醒”、宠物显示专注状态）。 */
  focusing() { return this.phase === 'focus' && this.running; }
  view(now) {
    const remain = this.running && this.endsAt != null ? Math.max(0, this.endsAt - now) : this.remainMs;
    return { phase: this.phase, running: this.running, remainMs: remain, endsAt: this.running ? this.endsAt : null, totalMs: this.total() };
  }
}
/** mm:ss */
export function mmss(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
