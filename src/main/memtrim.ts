// 运行内存清理：调用 Windows 的 EmptyWorkingSet，让程序把暂时不用的内存页交还给系统（与常见“内存整理”工具同一原理）。
// 底线：
//  - 绝不结束任何程序；只“修剪”工作集，程序需要时系统会自动换回来（可能有短暂卡顿）。
//  - 只处理当前用户能打开的进程；系统关键进程、NetPet 自己、前台正在用的程序跳过；用户还可以设置排除列表（1.5.0）。
//  - 自动清理默认关闭；“超阈值”模式需内存持续超过阈值 60 秒才触发；“定期整理”模式（1.5.0）只在空闲时进行。
//    所有自动整理之间至少间隔 10 分钟（与手动整理共用同一个“上次整理时间”）。
//  - 不清理系统“备用列表”（需要管理员 + 特殊权限，且会让后续打开程序变慢）。
// 1.5.0：先列出候选进程，再按规则挑选（后台、足够大、30 分钟内没整理过、不在排除列表、每次最多 30 个、最大的优先），
//        整理后等 5 秒再测“可用内存”，记录真实效果（最近 20 次存到数据库）。
import { execFile } from 'node:child_process';
import os from 'node:os';
import { t } from '../shared/i18n';
const isWin = process.platform === 'win32';

/** 永不修剪的进程（小写，不含 .exe）。 */
export const SKIP = new Set(['system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'fontdrvhost', 'dwm',
  'memcompression', 'memory compression', 'secure system', 'audiodg', 'msmpeng', 'nissrv', 'sgrmbroker', 'explorer', 'netpet', 'electron', 'sing-box', 'taskmgr']);
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

/* ---------- 1.5.0：定期整理 / 目标挑选 / 效果评估（纯逻辑）---------- */
export const MIN_GAP_MS = 10 * 60e3;          // 任意两次自动整理的最小间隔
export const RECENT_MS = 30 * 60e3;           // 30 分钟内整理过的进程跳过
export const SCHED_CHOICES = [30, 60, 120];   // 定期整理间隔（分钟）
export const MAX_TARGETS = 30;                // 每次最多整理的进程数
export const MAX_EXCLUDE = 50;
/** 排除列表：只保留合法的进程名（字母数字、空格、. _ - ( )），统一小写、去掉 .exe、去重，最多 50 个。 */
export function normalizeExclude(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (typeof x !== 'string') continue;
    const n = x.trim().toLowerCase().replace(/\.exe$/, '');
    if (!n || n.length > 64 || !/^[a-z0-9 _.()\-\u4e00-\u9fa5]+$/i.test(n) || out.includes(n)) continue;
    out.push(n);
    if (out.length >= MAX_EXCLUDE) break;
  }
  return out;
}
/** 定期整理是否可以运行。memPct < 60 时没什么可整理的，跳过。 */
export function scheduleEligible(i) {
  if (!i.enabled) return { ok: false, reason: 'off' };
  if (i.now - (i.lastScheduled || 0) < i.intervalMin * 60e3) return { ok: false, reason: 'interval' };
  if (i.now - (i.lastAnyTrim || 0) < MIN_GAP_MS) return { ok: false, reason: 'cooldown' };
  if (!(i.idleSec >= 300 || i.locked)) return { ok: false, reason: 'notIdle' };
  if (i.fullscreen) return { ok: false, reason: 'fullscreen' };
  if (i.focus) return { ok: false, reason: 'focus' };
  if (i.memPct == null || i.memPct < 60) return { ok: false, reason: 'lowMem' };
  return { ok: true, reason: '' };
}
/** 从候选进程里挑出要整理的 PID：跳过系统 / 自身 / 前台（以及前台程序的同名进程）/ 排除列表 / 30 分钟内整理过 / 太小的，按占用从大到小取前 cap 个。 */
export function selectTargets(list, o) {
  const ex = new Set(normalizeExclude(o.exclude || []));
  const fgName = String(o.fgName || '').toLowerCase().replace(/\.exe$/, '');
  const minB = (o.minMB || 30) * 1048576;
  const recent = o.recent || {};
  return (list || []).filter((p) => {
    const n = String(p.name || '').toLowerCase().replace(/\.exe$/, '');
    if (shouldSkip(n, Number(p.pid), o.selfPids || [])) return false;
    if (Number(p.pid) === Number(o.fgPid)) return false;
    if (o.skipFgGroup && fgName && n === fgName) return false;
    if (ex.has(n)) return false;
    if (recent[p.pid] && o.now - recent[p.pid] < RECENT_MS) return false;
    return Number(p.ws) >= minB;
  }).sort((a, b) => Number(b.ws) - Number(a.ws)).slice(0, o.cap || MAX_TARGETS).map((p) => Number(p.pid));
}
/** 最近 3 次“定期整理”都释放不到 100MB → 建议关闭定期整理（频繁整理会增加缺页、反而变慢）。 */
export function ineffectiveTip(runs) {
  const s = (runs || []).filter((r) => r && r.mode === 'scheduled').slice(0, 3);
  return s.length === 3 && s.every((r) => (Number(r.freed) || 0) < 100 * 1048576);
}

/* ---------- PowerShell ---------- */
const FG_TYPE = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class F{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}'`;
const LIST_PS = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
${FG_TYPE}
$fg=0; [void][F]::GetWindowThreadProcessId([F]::GetForegroundWindow(),[ref]$fg)
$fn=''; $fp=Get-Process -Id $fg; if($fp){ $fn=$fp.ProcessName }
ConvertTo-Json -InputObject @{fg=$fg;fn=$fn;p=@(Get-Process | ForEach-Object { @{i=$_.Id;n=$_.ProcessName;w=[double]$_.WorkingSet64} })} -Compress -Depth 3`;
// PID 只来自上一步的整数列表；整次最多 20 秒（EmptyWorkingSet 是同步调用，无法单独给某个进程设超时，用总时限代替）
const TRIM_PS = (ids: number[]) => `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("psapi.dll")]public static extern bool EmptyWorkingSet(IntPtr h);[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(int a,bool i,int p);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);}'
$ids=@(${ids.map((x) => String(Math.trunc(x))).join(',')}); $sw=[Diagnostics.Stopwatch]::StartNew()
$n=0;$f=0;$freed=0;$late=0;$done=@()
foreach($id in $ids){
  if($sw.ElapsedMilliseconds -gt 20000){$late++; continue}
  $p=Get-Process -Id $id; if(!$p){continue}
  $before=$p.WorkingSet64
  $h=[M]::OpenProcess(0x0500,$false,$id)
  if($h -eq [IntPtr]::Zero){$f++;continue}
  if([M]::EmptyWorkingSet($h)){$n++; $done+=$id; $p.Refresh(); $d=$before-$p.WorkingSet64; if($d -gt 0){$freed+=$d}}else{$f++}
  [void][M]::CloseHandle($h)
}
ConvertTo-Json -InputObject @{n=$n;f=$f;freed=[double]$freed;late=$late;done=$done} -Compress`;
const STATUS_PS = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$mc=Get-Process -Name 'Memory Compression' | Select-Object -First 1
$top=@(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 | ForEach-Object { @{n=$_.ProcessName;i=$_.Id;w=[double]$_.WorkingSet64;pm=[double]$_.PrivateMemorySize64} })
ConvertTo-Json -InputObject @{ok=[bool]$m;commit=[double]$m.CommittedBytes;limit=[double]$m.CommitLimit;avail=[double]$m.AvailableBytes;cache=[double]$m.CacheBytes;comp=$(if($mc){[double]$mc.WorkingSet64}else{$null});top=$top} -Compress -Depth 3`;
function ps(script: string, timeout: number): Promise<string | null> {
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (e, o) => res(e ? null : String(o).trim())));
}

export type TrimMode = 'manual' | 'threshold' | 'scheduled';
export interface TrimResult { ok: boolean; trimmed: number; failed: number; wsFreed: number; before: number; after: number; error?: string;
  mode?: TrimMode; at?: number; ms?: number; availBefore?: number; availAfter?: number; freed?: number; candidates?: number; late?: number }
let busy = false;
const recent: Record<number, number> = {};
export const isBusy = () => busy;
/** 整理一次。mode=scheduled 时只挑 ≥ 100MB 的后台进程，并跳过前台程序的同名进程。 */
export async function trim(selfPids: number[], o: { mode?: TrimMode; exclude?: string[] } = {}): Promise<TrimResult> {
  const mode = o.mode || 'manual', t0 = Date.now();
  const before = os.totalmem() - os.freemem(), availBefore = os.freemem();
  const base: TrimResult = { ok: false, trimmed: 0, failed: 0, wsFreed: 0, before, after: before, mode, at: t0, ms: 0, availBefore, availAfter: availBefore, freed: 0, candidates: 0 };
  if (!isWin) return { ...base, error: t('mt.win') };
  if (busy) return { ...base, error: t('mt.busy') };
  busy = true;
  try {
    let l: any = null; try { l = JSON.parse((await ps(LIST_PS, 20000)) || ''); } catch (_) {}
    if (!l) return { ...base, error: t('mt.list') };
    const list = [].concat(l.p || []).map((x: any) => ({ pid: Number(x.i), name: String(x.n || ''), ws: Number(x.w) || 0 }));
    for (const k of Object.keys(recent)) if (t0 - recent[k as any] > RECENT_MS) delete recent[k as any];
    const ids = selectTargets(list, { fgPid: Number(l.fg) || 0, fgName: String(l.fn || ''), selfPids, exclude: o.exclude || [], recent, now: t0,
      minMB: mode === 'scheduled' ? 100 : 30, cap: MAX_TARGETS, skipFgGroup: mode !== 'manual' });
    base.candidates = ids.length;
    if (!ids.length) return { ...base, ok: true, ms: Date.now() - t0 };
    let j: any = null; try { j = JSON.parse((await ps(TRIM_PS(ids), 40000)) || ''); } catch (_) {}
    for (const id of [].concat((j && j.done) || [])) recent[Number(id)] = t0;
    await new Promise((r) => setTimeout(r, 5000)); // 等 5 秒让系统把页面放回可用列表，再测真实效果
    const availAfter = os.freemem(), after = os.totalmem() - availAfter;
    if (!j) return { ...base, after, availAfter, ms: Date.now() - t0, error: t('mt.fail') };
    return { ok: true, trimmed: Number(j.n) || 0, failed: Number(j.f) || 0, wsFreed: Number(j.freed) || 0, before, after, mode, at: t0, ms: Date.now() - t0,
      availBefore, availAfter, freed: availAfter - availBefore, candidates: ids.length, late: Number(j.late) || 0 };
  } finally { busy = false; }
}
/** 只读的内存状态：已提交 / 提交上限、可用、缓存、压缩内存（Memory Compression 进程的占用），以及占用最多的 10 个程序。 */
export async function memStatus() {
  if (!isWin) return { ok: false };
  let j: any = null; try { j = JSON.parse((await ps(STATUS_PS, 20000)) || ''); } catch (_) {}
  if (!j || !j.ok) return { ok: false };
  return { ok: true, commit: Number(j.commit) || 0, limit: Number(j.limit) || 0, avail: Number(j.avail) || 0, cache: Number(j.cache) || 0, comp: j.comp == null ? null : Number(j.comp),
    top: [].concat(j.top || []).map((x: any) => ({ name: String(x.n || ''), pid: Number(x.i) || 0, ws: Number(x.w) || 0, priv: Number(x.pm) || 0 })) };
}
