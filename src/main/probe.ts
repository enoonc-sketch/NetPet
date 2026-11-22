// 可选的真实联网检测（隐私页开关，默认关闭）。
// 只请求 Windows 自带联网检测（NCSI）使用的同一个地址：http://www.msftconnecttest.com/connecttest.txt，
// 期望返回固定文本 "Microsoft Connect Test"。不带任何本机数据、不带 Cookie；Windows 自己本来也会定期请求它。
// 能区分“连着路由器但上不了网”和“需要网页登录的 Wi-Fi（被劫持返回登录页）”。
import http from 'node:http';

export const PROBE_URL = 'http://www.msftconnecttest.com/connecttest.txt';
export const PROBE_EXPECT = 'Microsoft Connect Test';
export type ProbeResult = 'ok' | 'portal' | 'fail';

/** 判断一次响应（纯函数，可单元测试）。 */
export function judge(status: number | null, body: string): ProbeResult {
  if (status == null) return 'fail';
  if (status === 200 && body.trim() === PROBE_EXPECT) return 'ok';
  return 'portal'; // 能连上但内容不对：多半是酒店/机场 Wi-Fi 的登录页
}

/** 防抖：连续 2 次相同结果才改变状态（null = 还没有结论）。 */
export class ProbeState {
  value: ProbeResult | null = null; private pend: ProbeResult | null = null; private n = 0;
  push(r: ProbeResult): boolean {
    if (r === this.value) { this.pend = null; this.n = 0; return false; }
    if (this.value === null) { this.value = r; return true; } // 第一次直接给结论
    if (this.pend !== r) { this.pend = r; this.n = 1; return false; }
    if (++this.n >= 2) { this.value = r; this.pend = null; this.n = 0; return true; }
    return false;
  }
  reset() { this.value = null; this.pend = null; this.n = 0; }
}

export function probeOnce(timeoutMs = 5000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let done = false; const fin = (r: ProbeResult) => { if (!done) { done = true; resolve(r); } };
    try {
      const req = http.get(PROBE_URL, { timeout: timeoutMs, headers: { 'User-Agent': 'NetPet', 'Cache-Control': 'no-cache' } }, (res) => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 1024) body += c; });
        res.on('end', () => fin(judge(res.statusCode ?? null, body)));
        res.on('error', () => fin('fail'));
      });
      req.on('timeout', () => { req.destroy(); fin('fail'); });
      req.on('error', () => fin('fail'));
    } catch (_) { fin('fail'); }
  });
}
