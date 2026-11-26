// 1.5.0 驱动更新检查（只读）。参照 winupdate.ts：
//  1. 本机驱动（不联网，打开页面时自动读取）：Win32_PnPSignedDriver 列出设备 / 类别 / 提供商 / 版本 / 日期 / 是否签名；
//     Win32_PnPEntity 里 ConfigManagerErrorCode ≠ 0 的是“有问题的设备”，并给出常见错误码的中文解释；
//     未签名驱动、日期很旧（默认 > 5 年）的驱动只做提示，不代表一定有问题。
//  2. 可用的驱动更新（联网，只在用户点击时）：调用 Windows 自带的 Windows Update Agent 搜索 "IsInstalled=0 and Type='Driver'"，
//     由 Windows 自己联系微软服务器，NetPet 不额外上传数据。
// 不下载、不安装、不卸载任何驱动；需要更新时打开“Windows 更新 · 可选更新”或“设备管理器”由用户自己操作。
import { execFile } from 'node:child_process';
import { t } from '../shared/i18n';
const isWin = process.platform === 'win32';
const arr = (x) => (x == null ? [] : [].concat(x));

export interface DriverItem { name: string; cls: string; provider: string; version: string; date: string; signed: boolean | null; id: string; ageYears: number | null; old: boolean; inbox: boolean }
export interface ProblemDevice { name: string; cls: string; code: number; id: string; known: boolean }
export interface DriverReport { at: number; ok: boolean; error?: string; drivers: DriverItem[]; problems: ProblemDevice[]; unsigned: number; old: number }
export interface DrvUpdate { title: string; cls: string; manufacturer: string; model: string; date: string; sizeMB: number }
export interface DrvOnline { at: number; ok: boolean; error?: string; items: DrvUpdate[] }

/** 常见的设备管理器错误码（ConfigManagerErrorCode）。界面文字在 i18n 里：drv.cm.<code>。 */
export const CM_CODES = [1, 3, 10, 12, 14, 18, 19, 21, 22, 24, 28, 29, 31, 32, 33, 34, 35, 37, 38, 39, 40, 41, 43, 44, 45, 47, 48, 49, 52];
export const isKnownCode = (c) => CM_CODES.includes(Number(c));
/** 22 = 被用户禁用、45 = 设备当前没连接：只是提示，不算故障。 */
export const cmSeverity = (c) => (Number(c) === 22 || Number(c) === 45 ? 'info' : 'bad');

/** 驱动日期 YYYY-MM-DD 到 now 的年数；读不到返回 null。 */
export function ageYears(date, now = Date.now()) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t0 = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  if (!Number.isFinite(t0) || t0 > now + 864e5) return null;
  return (now - t0) / (365.25 * 864e5);
}
/** 微软系统自带的通用驱动日期固定为 2006-06-21（占位日期），不能据此判为“很旧”。 */
export const isInboxPlaceholder = (provider, date) => /microsoft/i.test(String(provider || '')) && /^2006-06-21/.test(String(date || ''));
export function ageFlag(date, provider, now = Date.now(), years = 5) {
  if (isInboxPlaceholder(provider, date)) return false;
  const a = ageYears(date, now);
  return a != null && a > years;
}
/** 解析本机驱动列表（纯函数）。按“问题优先、再按名称”排序由界面决定，这里按名称排序。 */
export function parseDrivers(raw, now = Date.now()) {
  return arr(raw).filter((x) => x && x.n).map((x) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(x.d || '')) ? String(x.d) : '';
    const provider = String(x.p || '').slice(0, 120);
    const a = ageYears(date, now);
    return { name: String(x.n).slice(0, 200), cls: String(x.c || '').slice(0, 60), provider, version: String(x.v || '').slice(0, 60), date,
      signed: typeof x.s === 'boolean' ? x.s : null, id: String(x.id || '').slice(0, 300), ageYears: a == null ? null : Math.round(a * 10) / 10,
      old: ageFlag(date, provider, now), inbox: isInboxPlaceholder(provider, date) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
export function parseProblems(raw) {
  return arr(raw).filter((x) => x && Number(x.code) > 0).map((x) => ({ name: String(x.n || x.id || '?').slice(0, 200), cls: String(x.c || '').slice(0, 60), code: Number(x.code), id: String(x.id || '').slice(0, 300), known: isKnownCode(x.code) }));
}
/** 解析 WUA 搜索结果（纯函数）。 */
export function parseWuaDrivers(raw) {
  return arr(raw).filter((x) => x && x.t).map((x) => ({
    title: String(x.t).slice(0, 300), cls: String(x.c || '').slice(0, 60), manufacturer: String(x.m || '').slice(0, 120), model: String(x.mdl || '').slice(0, 200),
    date: /^\d{4}-\d{2}-\d{2}/.test(String(x.v || '')) ? String(x.v).slice(0, 10) : '', sizeMB: Math.round(((Number(x.z) || 0) / 1048576) * 10) / 10
  }));
}

const LOCAL_PS = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$d=@(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName } | ForEach-Object { @{n=[string]$_.DeviceName;c=[string]$_.DeviceClass;p=[string]$_.DriverProviderName;v=[string]$_.DriverVersion;d=$(if($_.DriverDate){([datetime]$_.DriverDate).ToString('yyyy-MM-dd')}else{''});s=[bool]$_.IsSigned;id=[string]$_.DeviceID} })
$e=@(Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -ne $null -and $_.ConfigManagerErrorCode -ne 0 } | ForEach-Object { @{n=[string]$_.Name;c=[string]$_.PNPClass;code=[int]$_.ConfigManagerErrorCode;id=[string]$_.DeviceID} })
ConvertTo-Json -InputObject @{ok=1;drivers=$d;problems=$e} -Compress -Depth 3`;
const ONLINE_PS = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
try{ $s=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher(); $r=$s.Search("IsInstalled=0 and Type='Driver'")
$o=@(); foreach($u in $r.Updates){ $v=''; try{ $v=([datetime]$u.DriverVerDate).ToString('yyyy-MM-dd') }catch{}
$o+=@{t=[string]$u.Title;c=[string]$u.DriverClass;m=[string]$u.DriverManufacturer;mdl=[string]$u.DriverModel;v=$v;z=[double]$u.MaxDownloadSize} }
ConvertTo-Json -InputObject @{ok=1;items=$o} -Compress -Depth 3 }catch{ ConvertTo-Json -InputObject @{ok=0;err=$_.Exception.Message} -Compress }`;

const kids = new Set<any>();
function ps(script: string, timeout: number): Promise<string | null> {
  return new Promise((res) => {
    if (!isWin) return res(null);
    const c = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, out) => { kids.delete(c); res(err ? null : String(out).trim()); });
    kids.add(c);
  });
}
export const killAll = () => { for (const c of kids) { try { c.kill(); } catch (_) {} } kids.clear(); };

let localRun: Promise<DriverReport> | null = null, onlineRun: Promise<DrvOnline> | null = null;
/** 本机驱动列表（同一时间只跑一次，超时 90 秒）。 */
export function scanLocal(): Promise<DriverReport> {
  if (localRun) return localRun;
  localRun = (async () => {
    const base: DriverReport = { at: Date.now(), ok: false, drivers: [], problems: [], unsigned: 0, old: 0 };
    if (!isWin) return { ...base, error: t('drv.err.win') };
    let j: any = null; try { j = JSON.parse((await ps(LOCAL_PS, 90000)) || ''); } catch (_) {}
    if (!j || !j.ok) return { ...base, error: t('drv.err.local') };
    const drivers = parseDrivers(j.drivers), problems = parseProblems(j.problems);
    return { ...base, ok: true, drivers, problems, unsigned: drivers.filter((d) => d.signed === false).length, old: drivers.filter((d) => d.old).length };
  })().finally(() => { setTimeout(() => { localRun = null; }, 0); });
  return localRun;
}
/** 在线搜索可用驱动更新（只在用户点击时；同一时间只跑一次，超时 5 分钟）。 */
export function checkOnline(): Promise<DrvOnline> {
  if (onlineRun) return onlineRun;
  onlineRun = (async () => {
    const base: DrvOnline = { at: Date.now(), ok: false, items: [] };
    if (!isWin) return { ...base, error: t('drv.err.win') };
    let o: any = null; try { o = JSON.parse((await ps(ONLINE_PS, 5 * 60e3)) || ''); } catch (_) {}
    if (!o || !o.ok) return { ...base, error: t('drv.err.online', { msg: (o && o.err) || t('drv.err.timeout') }) };
    return { ...base, ok: true, items: parseWuaDrivers(o.items) };
  })().finally(() => { setTimeout(() => { onlineRun = null; }, 0); });
  return onlineRun;
}
