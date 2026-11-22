// 启动管理：列出开机启动项，并可“禁用 / 重新启用”。
// 做法与 Windows 任务管理器“启动应用”完全一致：只改 Explorer\StartupApproved 下的启用标记，
// 不删除 Run 注册表项、不删除启动文件夹里的快捷方式，随时可以在这里或任务管理器里恢复。
// 安全底线：
//  - 只读来源固定为 5 处（见 SOURCES），写入的注册表路径只能从这张表里选，不接受界面传来的路径；
//  - 要改的项目必须在“当前重新扫描到的列表”里存在，否则拒绝；
//  - 名称以 Base64 传给 PowerShell，不拼接进命令，防注入；
//  - 全机范围（HKLM / 公共启动文件夹）需要管理员权限，这里只显示、不修改，引导到任务管理器。
import { execFile } from 'node:child_process';

const isWin = process.platform === 'win32';
export type StartupScope = 'user' | 'machine';
export interface StartupItem { id: string; src: string; srcName: string; scope: StartupScope; name: string; command: string; enabled: boolean; flagged: boolean; exe: string; canToggle: boolean }

const AP = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
export const SOURCES: Record<string, { name: string; scope: StartupScope; apHive: 'HKCU' | 'HKLM'; apSub: string }> = {
  'hkcu-run': { name: '注册表（当前用户）', scope: 'user', apHive: 'HKCU', apSub: 'Run' },
  'hklm-run': { name: '注册表（所有用户）', scope: 'machine', apHive: 'HKLM', apSub: 'Run' },
  'hklm-run32': { name: '注册表（所有用户，32 位）', scope: 'machine', apHive: 'HKLM', apSub: 'Run32' },
  'user-folder': { name: '启动文件夹（当前用户）', scope: 'user', apHive: 'HKCU', apSub: 'StartupFolder' },
  'common-folder': { name: '启动文件夹（所有用户）', scope: 'machine', apHive: 'HKLM', apSub: 'StartupFolder' }
};

/** 与健康检查同一套“值得看一眼”的规则（只是提示，不代表恶意）。 */
export const FLAG_RE = /\\Temp\\|\\Users\\Public\\|-enc\s|-encodedcommand|wscript|cscript|mshta|\.vbs\b|\.js\b/i;

/** StartupApproved 值：首字节偶数（0x02/0x06）= 启用，奇数（0x03/0x07…）= 禁用；没有这个值 = 启用。 */
export function parseApproved(bytes: number[] | null | undefined): boolean {
  if (!bytes || !bytes.length) return true;
  return (bytes[0] & 1) === 0;
}
/** 生成 12 字节标记：启用 = 02 + 11 个 0；禁用 = 03 00 00 00 + 当前时间 FILETIME（小端），与任务管理器写法一致。 */
export function buildApproved(enabled: boolean, nowMs = Date.now()): number[] {
  if (enabled) return [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let ft = (BigInt(Math.floor(nowMs)) + 11644473600000n) * 10000n;
  const out = [3, 0, 0, 0];
  for (let i = 0; i < 8; i++) { out.push(Number(ft & 0xffn)); ft >>= 8n; }
  return out;
}
/** 从命令行里取出程序路径（带引号取引号内；否则取到第一个 .exe/.bat/.cmd/.lnk 为止；再不行取第一个空格前）。 */
export function extractExe(cmd: string): string {
  const s = String(cmd || '').trim();
  if (!s) return '';
  if (s[0] === '"') { const j = s.indexOf('"', 1); return j > 0 ? s.slice(1, j) : s.slice(1); }
  const m = s.match(/^.*?\.(exe|bat|cmd|lnk|com)\b/i);
  return m ? m[0] : s.split(/\s+/)[0];
}

const LIST_PS = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$out=New-Object System.Collections.ArrayList
function Ap($hive,$sub,$n){ $k="$($hive):\\${AP}\\$sub"; try{ $v=(Get-ItemProperty -LiteralPath $k -Name $n -ErrorAction Stop).$n; if($v){ return [Convert]::ToBase64String([byte[]]$v) } }catch{}; return $null }
function Reg($src,$path,$hive,$sub){ $k=Get-Item -LiteralPath $path; if(!$k){return}; foreach($n in $k.GetValueNames()){ if($n -eq ''){continue}; [void]$out.Add(@{src=$src;name=$n;cmd=[string]$k.GetValue($n);ap=(Ap $hive $sub $n)}) } }
function Fld($src,$dir,$hive,$sub){ if(!$dir -or !(Test-Path -LiteralPath $dir)){return}; foreach($f in Get-ChildItem -LiteralPath $dir -File){ if($f.Name -ieq 'desktop.ini'){continue}; [void]$out.Add(@{src=$src;name=$f.Name;cmd=$f.FullName;ap=(Ap $hive $sub $f.Name)}) } }
Reg 'hkcu-run' 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' 'HKCU' 'Run'
Reg 'hklm-run' 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' 'HKLM' 'Run'
Reg 'hklm-run32' 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run' 'HKLM' 'Run32'
Fld 'user-folder' ([Environment]::GetFolderPath('Startup')) 'HKCU' 'StartupFolder'
Fld 'common-folder' ([Environment]::GetFolderPath('CommonStartup')) 'HKLM' 'StartupFolder'
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
`;

function ps(script: string, timeout = 20000): Promise<string | null> {
  return new Promise((res) => {
    if (!isWin) return res(null);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, out) => res(err ? null : String(out).trim()));
  });
}

export function toItems(raw: any[]): StartupItem[] {
  return (raw || []).filter((x) => x && SOURCES[x.src] && x.name).map((x) => {
    const s = SOURCES[x.src];
    const bytes = x.ap ? [...Buffer.from(String(x.ap), 'base64')] : null;
    const command = String(x.cmd || '');
    return { id: `${x.src}|${x.name}`, src: x.src, srcName: s.name, scope: s.scope, name: String(x.name), command, enabled: parseApproved(bytes),
      flagged: FLAG_RE.test(command), exe: extractExe(command), canToggle: s.scope === 'user' };
  }).sort((a, b) => Number(a.scope === 'machine') - Number(b.scope === 'machine') || a.name.localeCompare(b.name));
}

export async function list(): Promise<{ ok: boolean; items: StartupItem[]; error?: string }> {
  if (!isWin) return { ok: false, items: [], error: '启动管理目前只支持 Windows' };
  const o = await ps(LIST_PS);
  if (o == null) return { ok: false, items: [], error: '读取启动项失败' };
  try { const j = JSON.parse(o || '[]'); return { ok: true, items: toItems(Array.isArray(j) ? j : [j]) }; }
  catch (_) { return { ok: false, items: [], error: '解析启动项失败' }; }
}

export async function setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string; item?: StartupItem }> {
  const cur = await list();
  if (!cur.ok) return { ok: false, error: cur.error };
  const it = cur.items.find((x) => x.id === id);
  if (!it) return { ok: false, error: '没有找到这个启动项（可能已被其他程序删除），请刷新列表。' };
  if (!it.canToggle) return { ok: false, error: '这是对所有用户生效的启动项，修改需要管理员权限。请用任务管理器 → 启动应用 处理。' };
  if (it.enabled === enabled) return { ok: true, item: it };
  const s = SOURCES[it.src];
  const key = `${s.apHive}:\\${AP}\\${s.apSub}`; // 只来自固定表
  const nameB64 = Buffer.from(it.name, 'utf8').toString('base64');
  const bytes = buildApproved(enabled).join(',');
  const script = `$ErrorActionPreference='Stop'
try { $n=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${nameB64}')); $k='${key}'
  if(!(Test-Path -LiteralPath $k)){ New-Item -Path $k -Force | Out-Null }
  New-ItemProperty -LiteralPath $k -Name $n -PropertyType Binary -Value ([byte[]]@(${bytes})) -Force | Out-Null; 'done' } catch { 'fail' }`;
  const r = await ps(script);
  if (r !== 'done') return { ok: false, error: '写入失败（可能被安全软件拦截）。' };
  const after = await list();
  const now = after.items.find((x) => x.id === id);
  return now && now.enabled === enabled ? { ok: true, item: now } : { ok: false, error: '已写入，但重新读取时状态没有变化，请刷新后确认。' };
}
