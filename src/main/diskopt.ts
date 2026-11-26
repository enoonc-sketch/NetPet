// 1.5.0 磁盘整理（调用 Windows 自带的 Optimize-Volume，不自带任何整理引擎）。
//  - 分析（不联网，打开页面时）：分区 / 容量 / 介质类型（HDD / SSD / 未知）、上次优化时间（应用程序日志里 Defrag 事件 258）、
//    Windows 自带的“计划优化”任务（ScheduledDefrag）状态；机械硬盘可在管理员权限下读取碎片率（Win32_Volume.DefragAnalysis）。
//  - 立即优化：HDD → Optimize-Volume -Defrag；SSD → 只做 -ReTrim（绝不对固态硬盘做碎片整理）；介质未知 → 跳过并说明原因。
//    需要管理员权限；用电池时不运行；同一时间只运行一个；可以取消（结束 NetPet 发起的优化进程）。
//  - 自动模式默认关闭：在 NetPet 内部按周判断（不创建系统计划任务），只在空闲 ≥ 10 分钟、接通电源、没有全屏、没有番茄钟专注时进行。
import { execFile } from 'node:child_process';
import { t } from '../shared/i18n';
const isWin = process.platform === 'win32';
const arr = (x) => (x == null ? [] : [].concat(x));

export interface VolInfo { letter: string; label: string; fs: string; size: number; free: number; media: string; bus: string; action: string; lastOpt: string } // media: HDD / SSD / unknown；action: defrag / retrim / skip
export interface DiskReport { at: number; ok: boolean; error?: string; admin: boolean; vols: VolInfo[]; task: { exists: boolean; state: string; last: string; next: string; result: number } | null }

/** 介质类型 → 动作。SCM（存储级内存）按 SSD 处理；其他（Unspecified 等）一律跳过。 */
export function normMedia(mt) {
  const s = String(mt == null ? '' : mt).trim().toUpperCase();
  if (s === 'HDD' || s === '3') return 'HDD';
  if (s === 'SSD' || s === '4' || s === 'SCM' || s === '5') return 'SSD';
  return 'unknown';
}
export function actionFor(media) { const m = normMedia(media); return m === 'HDD' ? 'defrag' : m === 'SSD' ? 'retrim' : 'skip'; }
export const validLetter = (l) => typeof l === 'string' && /^[A-Za-z]$/.test(l);

/** 从 Defrag 事件（258 = 优化完成）里取每个盘符最近一次的时间。消息文字随系统语言变化，但都带 “(C:)” 这样的盘符。 */
export function lastOptByLetter(events) {
  const out = {};
  for (const e of arr(events)) {
    if (!e || !e.t) continue;
    const m = String(e.m || '').match(/\(([A-Za-z]):\)/);
    if (!m) continue;
    const L = m[1].toUpperCase();
    if (!out[L] || String(e.t) > out[L]) out[L] = String(e.t);
  }
  return out;
}
export function parseVolumes(raw) {
  const j = raw || {};
  const last = lastOptByLetter(j.ev);
  const vols = arr(j.vols).filter((v) => v && validLetter(String(v.l || ''))).map((v) => {
    const letter = String(v.l).toUpperCase(), media = normMedia(v.mt);
    return { letter, label: String(v.label || '').slice(0, 60), fs: String(v.fs || ''), size: Number(v.size) || 0, free: Number(v.free) || 0, media, bus: String(v.bus || ''),
      action: actionFor(media), lastOpt: last[letter] || '' };
  }).sort((a, b) => a.letter.localeCompare(b.letter));
  const tk = j.task && typeof j.task === 'object' ? { exists: !!j.task.exists, state: String(j.task.state || ''), last: String(j.task.last || ''), next: String(j.task.next || ''), result: Number(j.task.result) || 0 } : null;
  return { admin: !!j.adm, vols, task: tk };
}
/** DefragAnalysis 结果（纯函数）。ReturnValue 非 0 表示失败（常见 5 = 拒绝访问）。 */
export function parseAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, pct: null, recommended: null, rv: -1 };
  const rv = Number(raw.rv);
  if (rv !== 0) return { ok: false, pct: null, recommended: null, rv: Number.isFinite(rv) ? rv : -1 };
  const p = Number(raw.pct);
  return { ok: true, pct: Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : null, recommended: !!raw.rec, rv: 0 };
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const dec = (v) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(v)}'))`;
const ANALYZE_PS = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$adm=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$pds=@(Get-PhysicalDisk)
$vols=@(); foreach($v in @(Get-Volume | Where-Object { $_.DriveLetter -and [string]$_.DriveType -eq 'Fixed' })){
  $mt='Unspecified'; $bt=''
  try { $p=Get-Partition -DriveLetter $v.DriveLetter -ErrorAction Stop | Select-Object -First 1; $pd=$pds | Where-Object { [string]$_.DeviceId -eq [string]$p.DiskNumber } | Select-Object -First 1; if($pd){ $mt=[string]$pd.MediaType; $bt=[string]$pd.BusType } } catch {}
  $vols+=@{l=[string]$v.DriveLetter;label=[string]$v.FileSystemLabel;fs=[string]$v.FileSystemType;size=[double]$v.Size;free=[double]$v.SizeRemaining;mt=$mt;bus=$bt} }
$ev=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Microsoft-Windows-Defrag';Id=258} -MaxEvents 200 | ForEach-Object { @{t=$_.TimeCreated.ToString('s');m=[string]$_.Message} })
$tk=Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\Defrag\\' -TaskName 'ScheduledDefrag'
$ti=$null; if($tk){ $ti=$tk | Get-ScheduledTaskInfo }
$task=@{exists=[bool]$tk;state=[string]$(if($tk){$tk.State}else{''});last=$(if($ti -and $ti.LastRunTime -and $ti.LastRunTime.Year -gt 2000){$ti.LastRunTime.ToString('s')}else{''});next=$(if($ti -and $ti.NextRunTime){$ti.NextRunTime.ToString('s')}else{''});result=[int64]$(if($ti){$ti.LastTaskResult}else{0})}
ConvertTo-Json -InputObject @{ok=1;adm=[bool]$adm;vols=$vols;ev=$ev;task=$task} -Compress -Depth 4`;
const FRAG_PS = (L) => `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
try{ $l=${dec(L)}; $v=Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $l + ":'"); $r=Invoke-CimMethod -InputObject $v -MethodName DefragAnalysis
ConvertTo-Json -InputObject @{rv=[int]$r.ReturnValue;rec=[bool]$r.DefragRecommended;pct=[int]$r.DefragAnalysis.TotalPercentFragmentation} -Compress }catch{ ConvertTo-Json -InputObject @{rv=-1;err=$_.Exception.Message} -Compress }`;
const OPT_PS = (L, action) => `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
try{ $l=${dec(L)}; Optimize-Volume -DriveLetter $l ${action === 'defrag' ? '-Defrag' : '-ReTrim'} -ErrorAction Stop; 'done' }catch{ 'fail:' + $_.Exception.Message }`;

function ps(script: string, timeout: number, keep?: (c: any) => void): Promise<string | null> {
  return new Promise((res) => {
    if (!isWin) return res(null);
    const c = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, out) => res(err ? null : String(out).trim()));
    if (keep) keep(c);
  });
}
let analyzing: Promise<DiskReport> | null = null;
export function analyze(): Promise<DiskReport> {
  if (analyzing) return analyzing;
  analyzing = (async () => {
    const base: DiskReport = { at: Date.now(), ok: false, admin: false, vols: [], task: null };
    if (!isWin) return { ...base, error: t('disk.err.win') };
    let j: any = null; try { j = JSON.parse((await ps(ANALYZE_PS, 60000)) || ''); } catch (_) {}
    if (!j || !j.ok) return { ...base, error: t('disk.err.read') };
    return { ...base, ok: true, ...parseVolumes(j) };
  })().finally(() => { setTimeout(() => { analyzing = null; }, 0); });
  return analyzing;
}
export async function fragmentation(letter) {
  if (!isWin) return { ok: false, pct: null, recommended: null, rv: -1, error: t('disk.err.win') };
  if (!validLetter(letter)) return { ok: false, pct: null, recommended: null, rv: -1, error: t('disk.err.letter') };
  let j: any = null; try { j = JSON.parse((await ps(FRAG_PS(letter.toUpperCase()), 10 * 60e3)) || ''); } catch (_) {}
  const r = parseAnalysis(j);
  return r.ok ? r : { ...r, error: r.rv === 5 ? t('disk.err.admin') : t('disk.err.analyze', { msg: (j && j.err) || ('ReturnValue=' + r.rv) }) };
}

/* ---------- 优化（同一时间一个，可取消）---------- */
export interface OptState { running: { letter: string; action: string; startedAt: number; auto: boolean } | null; last: { letter: string; action: string; ok: boolean; error?: string; at: number; ms: number; auto: boolean; cancelled?: boolean } | null }
const st: OptState = { running: null, last: null };
let child: any = null, cancelled = false;
export const state = () => ({ running: st.running, last: st.last });
export async function optimize(letter, media, o: { admin: boolean; onBattery: boolean; auto?: boolean }) {
  const action = actionFor(media);
  const fail = (error) => ({ ok: false, error });
  if (!isWin) return fail(t('disk.err.win'));
  if (!validLetter(letter)) return fail(t('disk.err.letter'));
  if (action === 'skip') return fail(t('disk.err.unknownMedia'));
  if (st.running) return fail(t('disk.err.busy'));
  if (!o.admin) return fail(t('disk.err.admin'));
  if (o.onBattery) return fail(t('disk.err.battery'));
  const L = letter.toUpperCase(), t0 = Date.now();
  st.running = { letter: L, action, startedAt: t0, auto: !!o.auto }; cancelled = false;
  try {
    // SSD ReTrim 通常几分钟；HDD 碎片整理可能要几个小时
    const out = await ps(OPT_PS(L, action), action === 'defrag' ? 8 * 3600e3 : 60 * 60e3, (c) => { child = c; });
    const ok = !!out && /(^|\n)done\s*$/.test(out);
    const msg = !out ? (cancelled ? t('disk.cancelled') : t('disk.err.timeout')) : ok ? '' : out.replace(/^[\s\S]*?fail:/, '').slice(0, 300);
    st.last = { letter: L, action, ok, error: ok ? undefined : msg, at: Date.now(), ms: Date.now() - t0, auto: !!o.auto, cancelled };
    return ok ? { ok: true, ms: st.last.ms } : fail(msg);
  } finally { st.running = null; child = null; }
}
/** 取消：结束 NetPet 发起的 PowerShell 进程（连同子进程）。Windows 优化服务通常会随之停止，必要时可在系统的优化工具里确认。 */
export function cancel() {
  if (!child) return false;
  cancelled = true;
  const pid = child.pid;
  try { if (isWin && pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {}); else child.kill(); } catch (_) {}
  return true;
}
