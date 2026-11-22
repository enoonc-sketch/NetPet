// 运行内存清理：调用 Windows 的 EmptyWorkingSet，让程序把暂时不用的内存页交还给系统（与常见“内存整理”工具同一原理）。
// 底线：
//  - 绝不结束任何程序；只“修剪”工作集，程序需要时系统会自动换回来（可能有短暂卡顿）。
//  - 只处理当前用户能打开的进程；系统关键进程、NetPet 自己、前台正在用的程序（可选）跳过。
//  - 自动清理默认关闭；开启后需内存持续超过阈值 60 秒才触发，两次之间至少间隔 10 分钟。
//  - 不清理系统“备用列表”（需要管理员 + 特殊权限，且会让后续打开程序变慢）。
import { execFile } from 'node:child_process';
import os from 'node:os';
const isWin = process.platform === 'win32';

/** 永不修剪的进程（小写，不含 .exe）。 */
export const SKIP = new Set(['system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'fontdrvhost', 'dwm',
  'memcompression', 'secure system', 'audiodg', 'msmpeng', 'nissrv', 'sgrmbroker', 'explorer', 'netpet', 'electron', 'sing-box', 'taskmgr']);
export function shouldSkip(name: string, pid: number, selfPids: number[]): boolean {
  const n = String(name || '').toLowerCase().replace(/\.exe$/, '');
  return !n || pid <= 4 || selfPids.includes(pid) || SKIP.has(n);
}

/** 自动触发判定：持续 sustainMs 超阈值才触发，触发后冷却 cooldownMs（纯逻辑，可单元测试）。 */
export class AutoTrigger {
  private since: number | null = null; private last = -Infinity;
  constructor(public sustainMs = 60e3, public cooldownMs = 10 * 60e3) {}
  update(now: number, memPct: number | null, threshold: number): boolean {
    if (memPct == null || memPct < threshold) { this.since = null; return false; }
    if (this.since == null) this.since = now;
    if (now - this.since < this.sustainMs || now - this.last < this.cooldownMs) return false;
    this.last = now; this.since = null; return true;
  }
  reset() { this.since = null; }
}

const PS = (skip: string, minMB: number) => `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("psapi.dll")]public static extern bool EmptyWorkingSet(IntPtr h);[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(int a,bool i,int p);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}'
$skip=@(${skip}); $fg=0; [void][M]::GetWindowThreadProcessId([M]::GetForegroundWindow(),[ref]$fg)
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$n=0;$f=0;$freed=0
foreach($p in Get-Process){
  $nm=$p.ProcessName.ToLower(); if($p.Id -le 4 -or $skip -contains $nm -or $p.Id -eq $fg){continue}
  if($p.WorkingSet64 -lt ${minMB}MB){continue}
  $before=$p.WorkingSet64
  $h=[M]::OpenProcess(0x0500,$false,$p.Id)
  if($h -eq [IntPtr]::Zero){$f++;continue}
  if([M]::EmptyWorkingSet($h)){$n++; $p.Refresh(); $d=$before-$p.WorkingSet64; if($d -gt 0){$freed+=$d}}else{$f++}
  [void][M]::CloseHandle($h)
}
@{n=$n;f=$f;freed=[double]$freed} | ConvertTo-Json -Compress`;

export interface TrimResult { ok: boolean; trimmed: number; failed: number; wsFreed: number; before: number; after: number; error?: string }
let busy = false;
export async function trim(selfPids: number[]): Promise<TrimResult> {
  const before = os.totalmem() - os.freemem();
  const base = { ok: false, trimmed: 0, failed: 0, wsFreed: 0, before, after: before };
  if (!isWin) return { ...base, error: '运行内存清理只支持 Windows' };
  if (busy) return { ...base, error: '正在清理中' };
  busy = true;
  try {
    const skip = [...SKIP].map((s) => `'${s.replace(/'/g, '')}'`).join(',');
    const out: string | null = await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS(skip, 30), 'utf16le').toString('base64')],
      { timeout: 60000, windowsHide: true, encoding: 'utf8' }, (e, o) => res(e ? null : String(o).trim())));
    let j: any = null; try { j = JSON.parse(out || ''); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500)); // 等系统把页面放回可用列表
    const after = os.totalmem() - os.freemem();
    if (!j) return { ...base, after, error: '清理失败（可能被安全软件拦截）' };
    return { ok: true, trimmed: Number(j.n) || 0, failed: Number(j.f) || 0, wsFreed: Number(j.freed) || 0, before, after };
  } finally { busy = false; }
}
