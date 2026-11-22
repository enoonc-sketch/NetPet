// Windows 轻量网速采集：一个只读的常驻 PowerShell（Get-NetAdapterStatistics，每秒一次），自己算差值。
// 不使用 systeminformation 的网络函数（它们会同步执行外部命令）。只统计物理网卡，避免代理/虚拟网卡导致重复计算。
import { spawn, ChildProcess } from 'node:child_process';
import { log } from './logger';

const SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'", '[Console]::OutputEncoding=[Text.Encoding]::UTF8', '$n=0;$phys=@()', 'while($true){',
  '  if($n % 30 -eq 0){$phys=@(Get-NetAdapter -Physical | ForEach-Object { $_.Name })}', '  $n++',
  '  $a=@(Get-NetAdapterStatistics | ForEach-Object { @{ n=$_.Name; rx=[double]$_.ReceivedBytes; tx=[double]$_.SentBytes } })',
  '  $o=@{ t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); phys=$phys; ifs=$a }',
  '  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()', '  Start-Sleep -Seconds 1', '}'
].join('\n');
const VIRT = /loopback|vethernet|vmware|virtualbox|vbox|hyper-v|\btap\b|\btun\b|wintun|wireguard|tailscale|zerotier|clash|sing-?box|sing-?tun|meta|bluetooth|pseudo|npcap|docker|wsl/i;

let child: ChildProcess | null = null, buf = '', lastStart = 0;
let prev: { t: number; m: Map<string, [number, number]> } | null = null;
let cur: { rx: number; tx: number; at: number } | null = null;

function onLine(line: string) {
  let o: any; try { o = JSON.parse(line); } catch (_) { return; }
  const ifs: any[] = [].concat(o.ifs || []), phys = new Set<string>([].concat(o.phys || []));
  let use = phys.size ? ifs.filter((i) => phys.has(i.n)) : ifs.filter((i) => !VIRT.test(i.n || ''));
  if (!use.length) use = ifs;
  const now = { t: Number(o.t), m: new Map<string, [number, number]>(use.map((i) => [i.n, [i.rx, i.tx]] as [string, [number, number]])) };
  if (prev) {
    const dt = (now.t - prev.t) / 1000;
    if (dt > 0 && dt <= 5) { // 超过 5 秒多半是休眠唤醒，丢弃这一段
      let rx = 0, tx = 0;
      for (const [n, [r, t]] of now.m) { const p = prev.m.get(n); if (!p) continue; if (r - p[0] > 0) rx += r - p[0]; if (t - p[1] > 0) tx += t - p[1]; } // 计数器重置(负值)直接忽略
      cur = { rx: rx / dt, tx: tx / dt, at: Date.now() };
    } else cur = { rx: 0, tx: 0, at: Date.now() };
  }
  prev = now;
}
export function ensure() {
  if (process.platform !== 'win32' || child || Date.now() - lastStart < 10000) return;
  lastStart = Date.now(); prev = null;
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const me = child;
  me.stdout!.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); } });
  me.on('exit', () => { if (child === me) child = null; log('网速采集器已退出'); });
  me.on('error', (e) => { if (child === me) child = null; log('网速采集器启动失败 ' + e.message); });
  log('网速采集器已启动');
}
export function rate(): { rx: number; tx: number } | null { ensure(); return cur && Date.now() - cur.at < 5000 ? { rx: cur.rx, tx: cur.tx } : null; }
export function stop() { if (child) { try { child.kill(); } catch (_) {} child = null; } }
