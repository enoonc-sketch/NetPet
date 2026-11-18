// 系统信息采集进程：所有 systeminformation 调用都在这里执行。
// 该库在 Windows 上会同步执行外部命令（netstat/netsh 等），如果放在主进程里会卡死整个程序；放在这里，最多只影响采集进程本身，主进程可以超时后直接重启它。
import * as si from 'systeminformation';
const port = (process as any).parentPort;
const FN: Record<string, () => Promise<any>> = {
  networkStats: () => si.networkStats('*'), networkConnections: () => si.networkConnections(), networkInterfaces: () => si.networkInterfaces(),
  currentLoad: () => si.currentLoad(), cpuTemperature: () => si.cpuTemperature(), fsSize: () => si.fsSize(), graphics: () => si.graphics(),
  battery: () => si.battery(), processes: () => si.processes()
};
port.on('message', async (e: any) => {
  const { id, fn } = e.data || {};
  if (fn === 'release') { try { (si as any).powerShellRelease(); } catch (_) {} port.postMessage({ id, data: true }); setTimeout(() => process.exit(0), 100); return; }
  const f = FN[fn];
  if (!f) return port.postMessage({ id, error: 'unknown fn' });
  try { port.postMessage({ id, data: await f() }); } catch (err: any) { port.postMessage({ id, error: String((err && err.message) || err) }); }
});
