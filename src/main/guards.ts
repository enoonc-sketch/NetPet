// 纯函数小工具（不依赖 Electron，可单元测试）
/** 有可用的 IPv4（非 169.254）或全局 IPv6（非 fe80 / ::1）就算在线。参数形如 os.networkInterfaces() 的返回值。 */
export function hasUsableAddress(ifaces: Record<string, any[] | undefined>): boolean {
  return Object.values(ifaces).some((l) => (l || []).some((a: any) => !a.internal && (
    (a.family === 'IPv4' || a.family === 4) ? !String(a.address).startsWith('169.254.') : !/^(fe80|::1$)/i.test(String(a.address)))));
}
/** 滑动时间窗口计数：windowMs 内最多 max 次。 */
export class RateBudget {
  private times: number[] = [];
  constructor(private max: number, private windowMs: number) {}
  left(now = Date.now()) { this.times = this.times.filter((x) => now - x < this.windowMs); return this.times.length < this.max; }
  use(now = Date.now()) { this.times.push(now); }
}
/** 按真实间隔换算本次采样的字节数，间隔夹在 [0,5] 秒；首次按 1 秒。 */
export function sampleSeconds(now: number, last: number): number { return last ? Math.min(5, Math.max(0, (now - last) / 1000)) : 1; }
