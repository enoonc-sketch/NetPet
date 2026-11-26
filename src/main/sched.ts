// 1.5.0 “空闲时自动做”的通用判定（纯函数，可单元测试）：磁盘自动整理、定期 Defender 快速扫描共用。
// 条件：已开启；距上次成功 ≥ intervalMs；距上次尝试 ≥ retryMs（失败后不会每 5 分钟重试）；
//       用户空闲 ≥ minIdleSec；接通电源；没有全屏程序；没有在番茄钟专注中。
export interface IdleTaskInput {
  now: number; enabled: boolean; last: number; lastTry: number; intervalMs: number; retryMs?: number;
  idleSec: number; minIdleSec?: number; onAC: boolean; fullscreen: boolean; focus: boolean; busy?: boolean;
}
export function idleTaskEligible(i) {
  if (!i || !i.enabled) return { ok: false, reason: 'off' };
  if (i.busy) return { ok: false, reason: 'busy' };
  if (i.now - (Number(i.last) || 0) < i.intervalMs) return { ok: false, reason: 'interval' };
  if (i.now - (Number(i.lastTry) || 0) < (i.retryMs == null ? 6 * 3600e3 : i.retryMs)) return { ok: false, reason: 'retry' };
  if (!i.onAC) return { ok: false, reason: 'battery' };
  if (i.fullscreen) return { ok: false, reason: 'fullscreen' };
  if (i.focus) return { ok: false, reason: 'focus' };
  if (!(i.idleSec >= (i.minIdleSec == null ? 600 : i.minIdleSec))) return { ok: false, reason: 'notIdle' };
  return { ok: true, reason: '' };
}
export const WEEK_MS = 7 * 864e5;
