// 宠物状态机：明确触发条件 + 持续时间(防抖) + 优先级 + 最短停留，避免表情频繁抖动。
const PRI = ['WARNING', 'HOT', 'SWEAT', 'TIRED', 'DOWNLOAD', 'UPLOAD', 'HAPPY', 'SLEEP']; // 优先级从高到低，都不满足则 IDLE
const KB = 1024, MB = 1048576;
const RULES = {
  WARNING:  { skip: () => false, enter: (i) => !!i.warning, exit: (i) => !i.warning, holdIn: 0, holdOut: 0 },
  HOT:      { skip: (i) => i.temp == null, enter: (i) => i.temp >= 85, exit: (i) => i.temp < 80, holdIn: 10, holdOut: 10 },
  SWEAT:    { skip: (i) => i.memPct == null, enter: (i) => i.memPct >= i.memAlert, exit: (i) => i.memPct < i.memAlert - 5, holdIn: 10, holdOut: 10 },
  TIRED:    { skip: (i) => i.cpu == null, enter: (i) => i.cpu >= 90, exit: (i) => i.cpu < 75, holdIn: 30, holdOut: 10 },
  DOWNLOAD: { skip: (i) => i.rx == null, enter: (i) => i.rx >= MB && i.rx >= 3 * i.tx, exit: (i) => i.rx < 512 * KB || i.rx < 2 * i.tx, holdIn: 3, holdOut: 5 },
  UPLOAD:   { skip: (i) => i.rx == null, enter: (i) => i.tx >= 512 * KB && i.tx >= 3 * i.rx, exit: (i) => i.tx < 256 * KB || i.tx < 2 * i.rx, holdIn: 3, holdOut: 5 },
  HAPPY:    { skip: (i) => i.rx == null, enter: (i) => i.rx + i.tx >= 200 * KB, exit: (i) => i.rx + i.tx < 100 * KB, holdIn: 3, holdOut: 5 },
  SLEEP:    { skip: (i) => i.rx == null, enter: (i) => i.rx + i.tx < 2 * KB, exit: (i) => i.rx + i.tx >= 4 * KB, holdIn: 60, holdOut: 3 }
};
const MIN_HOLD = 4000;

class PetStateMachine {
  constructor() { this.muted = new Set(); this.reset(0); }
  reset(now) { this.r = {}; for (const k of PRI) this.r[k] = { active: false, since: null }; this.current = 'IDLE'; this.changedAt = now; }
  setMuted(list) { this.muted = new Set(list); this.changedAt = -1e15; } // 用户改了提醒开关，立即生效
  update(now, i) {
    for (const k of PRI) {
      const rule = RULES[k], R = this.r[k];
      if (this.muted.has(k) || rule.skip(i)) { R.active = false; R.since = null; continue; }
      const cond = R.active ? rule.exit(i) : rule.enter(i);
      if (cond) {
        if (R.since == null) R.since = now;
        if (now - R.since >= (R.active ? rule.holdOut : rule.holdIn) * 1000) { R.active = !R.active; R.since = null; }
      } else R.since = null;
    }
    const next = PRI.find((k) => this.r[k].active) || 'IDLE';
    if (next !== this.current && (next === 'WARNING' || now - this.changedAt >= MIN_HOLD)) { this.current = next; this.changedAt = now; }
    return this.current;
  }
}
module.exports = { PetStateMachine, PRI, RULES };
