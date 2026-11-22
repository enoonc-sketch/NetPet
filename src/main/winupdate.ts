// 系统更新检测（只读，只在用户点击“检查更新”时运行）：
//  1. 本机状态（不联网）：是否有待重启、Windows 版本号、最近一次补丁；
//  2. 可用更新（联网）：调用 Windows 自带的 Windows Update Agent（Microsoft.Update.Session）搜索未安装的更新，
//     与“设置 → Windows 更新 → 检查更新”走同一个通道，由 Windows 自己联系微软服务器，NetPet 不额外上传数据。
// 不下载、不安装、不重启；需要安装时打开系统的 Windows 更新页面，由用户自己操作。
import { execFile } from 'node:child_process';
const isWin = process.platform === 'win32';

export interface UpdItem { title: string; kb: string; severity: string; sizeMB: number; category: string; reboot: boolean }
export interface UpdReport { at: number; ok: boolean; error?: string; os?: string; build?: string; pendingReboot: boolean; rebootReasons: string[];
  lastPatch?: { kb: string; date: string; days: number } | null; items: UpdItem[]; security: number; online: boolean }

/** 解析 WUA 输出（纯函数，可单元测试）。 */
export function parseItems(raw: any): UpdItem[] {
  const l: any[] = raw == null ? [] : [].concat(raw);
  return l.filter((x) => x && x.t).map((x) => {
    const cats = String(x.c || '');
    return { title: String(x.t).slice(0, 300), kb: x.kb ? 'KB' + String(x.kb).replace(/^KB/i, '') : '', severity: String(x.s || ''),
      sizeMB: Math.round((Number(x.z) || 0) / 1048576), category: /security/i.test(cats) || x.s ? '安全更新' : /driver/i.test(cats) ? '驱动' : /definition/i.test(cats) ? '病毒库' : /feature|upgrade/i.test(cats) ? '功能更新' : '其他更新',
      reboot: !!x.r };
  }).sort((a, b) => Number(b.category === '安全更新') - Number(a.category === '安全更新'));
}
/** 状态结论：bad = 有严重/重要安全更新或待重启超过 7 天；warn = 有更新或待重启；ok = 都没有。 */
export function verdict(r: Pick<UpdReport, 'items' | 'pendingReboot' | 'lastPatch'>): 'ok' | 'warn' | 'bad' {
  const crit = r.items.some((i) => /critical|important/i.test(i.severity));
  if (crit) return 'bad';
  if (r.items.length || r.pendingReboot || (r.lastPatch && r.lastPatch.days > 60)) return 'warn';
  return 'ok';
}

const LOCAL_PS = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$rs=@()
if(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'){$rs+='Windows 更新'}
if(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'){$rs+='系统组件'}
$cv=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$h=Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1
@{os=[string]$cv.ProductName;disp=[string]$cv.DisplayVersion;build=("$($cv.CurrentBuild).$($cv.UBR)");rs=$rs;kb=[string]$h.HotFixID;d=$(if($h){$h.InstalledOn.ToString('s')}else{''})} | ConvertTo-Json -Compress`;
const ONLINE_PS = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
try{ $s=(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher(); $r=$s.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
$o=@(); foreach($u in $r.Updates){ $o+=@{t=$u.Title;kb=($u.KBArticleIDs -join ',');s=[string]$u.MsrcSeverity;z=[double]$u.MaxDownloadSize;r=[bool]($u.InstallationBehavior.RebootBehavior -gt 0);c=(($u.Categories|ForEach-Object{$_.Name}) -join ',')} }
ConvertTo-Json -InputObject @{ok=1;items=$o} -Compress -Depth 3 }catch{ ConvertTo-Json -InputObject @{ok=0;err=$_.Exception.Message} -Compress }`;

function ps(script: string, timeout: number): Promise<string | null> {
  return new Promise((res) => {
    if (!isWin) return res(null);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, out) => res(err ? null : String(out).trim()));
  });
}
let running: Promise<UpdReport> | null = null;
export function check(online: boolean): Promise<UpdReport> {
  if (running) return running; // 同一时间只跑一次（WUA 搜索可能要 1~3 分钟）
  running = (async () => {
    const base: UpdReport = { at: Date.now(), ok: false, pendingReboot: false, rebootReasons: [], items: [], security: 0, online, lastPatch: null };
    if (!isWin) return { ...base, error: '系统更新检测只支持 Windows' };
    let l: any = null; try { l = JSON.parse((await ps(LOCAL_PS, 30000)) || ''); } catch (_) {}
    if (l) {
      base.os = `${l.os}${l.disp ? ' ' + l.disp : ''}`; base.build = l.build; base.rebootReasons = [].concat(l.rs || []); base.pendingReboot = base.rebootReasons.length > 0;
      if (l.kb && l.d) base.lastPatch = { kb: l.kb, date: String(l.d).slice(0, 10), days: Math.floor((Date.now() - new Date(l.d).getTime()) / 864e5) };
    }
    if (!online) return { ...base, ok: !!l, error: l ? undefined : '读取本机更新状态失败' };
    let o: any = null; try { o = JSON.parse((await ps(ONLINE_PS, 5 * 60e3)) || ''); } catch (_) {}
    if (!o || !o.ok) return { ...base, ok: !!l, error: '在线检查失败：' + ((o && o.err) || '超时或 Windows 更新服务不可用') + '。可以在 设置 → Windows 更新 里手动检查。' };
    const items = parseItems(o.items);
    return { ...base, ok: true, items, security: items.filter((i) => i.category === '安全更新').length };
  })().finally(() => { setTimeout(() => { running = null; }, 0); });
  return running;
}
