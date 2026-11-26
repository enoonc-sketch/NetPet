// 1.5.0 病毒查杀：只调用 Windows 自带的 Microsoft Defender，不自带任何杀毒引擎；
// 绝不关闭 / 修改 Defender 的设置、排除项或实时保护；不删除、不隔离、不放行任何威胁（处理交给“Windows 安全中心 · 保护历史记录”）。
//  - 状态（不联网）：Get-MpComputerStatus + Windows 安全中心登记的第三方杀毒软件。第三方杀毒在工作时 Defender 通常处于被动模式，NetPet 不发起扫描。
//  - 扫描：快速 / 全盘 / 自定义（路径只能由主进程的文件对话框选择）/ 离线扫描（会重启电脑，强确认）。同一时间只运行一个；
//    “停止等待”只是不再等结果，Defender 可能会在后台继续扫描。没有 *-Mp* 命令时改用 MpCmdRun.exe。
//  - 更新病毒库（联网，只在点击时）：由 Defender 自己联系微软更新服务器。
import { execFile } from 'node:child_process';
import { t } from '../shared/i18n';
const isWin = process.platform === 'win32';
const arr = (x) => (x == null ? [] : [].concat(x));

/** Windows 安全中心 productState：第 2 个字节的高 4 位为 1 表示“已开启”（0x10 / 0x11），0x00 / 0x01 关闭，0x20 暂停。 */
export const avActive = (st) => Number.isFinite(Number(st)) && ((Number(st) >> 12) & 0xf) === 1;
export const isDefenderName = (n) => /windows defender|microsoft defender|windows 安全|windows security/i.test(String(n || ''));
const iso = (s) => (/^\d{4}-\d{2}-\d{2}T/.test(String(s || '')) ? String(s) : '');
export interface DefStatus { ok: boolean; error?: string; cmdlets: boolean; serviceOn: boolean | null; avOn: boolean | null; rtp: boolean | null; mode: string; passive: boolean;
  sigVersion: string; sigTime: string; sigAgeDays: number | null; lastQuick: string; lastFull: string; thirdParty: { name: string; active: boolean }[]; thirdActive: boolean; canScan: boolean }
export function parseStatus(raw, now = Date.now()) {
  const j = raw || {};
  const third = arr(j.av).filter((x) => x && x.n && !isDefenderName(x.n)).map((x) => ({ name: String(x.n).slice(0, 100), active: avActive(x.st) }));
  const thirdActive = third.some((x) => x.active);
  const ok = !!j.ok;
  const sigTime = iso(j.sigt);
  const age = sigTime ? (now - new Date(sigTime).getTime()) / 864e5 : null;
  const mode = String(j.mode || '');
  const passive = /passive|edr|sxs/i.test(mode) || (ok && j.ave === false && thirdActive);
  return { ok, cmdlets: !!j.cmd, serviceOn: ok ? !!j.am : null, avOn: ok ? !!j.ave : null, rtp: ok ? !!j.rtp : null, mode, passive,
    sigVersion: String(j.sigv || ''), sigTime, sigAgeDays: age == null || !Number.isFinite(age) ? null : Math.max(0, Math.floor(age)), lastQuick: iso(j.qs), lastFull: iso(j.fs),
    thirdParty: third, thirdActive, canScan: ok && !thirdActive && !passive };
}
/** 威胁严重程度（SeverityID）与状态（ThreatStatusID）。界面文字在 i18n 里：def.sev.* / def.st.*。 */
export const SEVERITY = { 1: 'low', 2: 'moderate', 4: 'high', 5: 'severe' };
export const sevKey = (id) => SEVERITY[Number(id)] || 'unknown';
export const STATUS = { 0: 'unknown', 1: 'detected', 2: 'cleaned', 3: 'quarantined', 4: 'removed', 5: 'allowed', 6: 'blocked', 102: 'quarantineFailed', 103: 'removeFailed', 104: 'allowFailed', 105: 'abandoned', 107: 'blockFailed' };
export const statusKey = (id) => STATUS[Number(id)] || 'unknown';
export interface Threat { id: string; name: string; severity: string; status: string; time: string; paths: string[]; process: string; active: boolean; ok: boolean }
export function parseThreats(raw) {
  return arr(raw).filter((x) => x && (x.id || x.n)).map((x) => ({
    id: String(x.id || ''), name: String(x.n || '').slice(0, 200) || '?', severity: sevKey(x.sev), status: statusKey(x.st), time: iso(x.t),
    paths: arr(x.r).map((r) => String(r || '').replace(/^[a-z]+:_/i, '').slice(0, 400)).filter(Boolean).slice(0, 20), process: String(x.p || '').slice(0, 200), active: !!x.act, ok: !!x.ok
  })).sort((a, b) => (b.time > a.time ? 1 : b.time < a.time ? -1 : 0));
}
/** 扫描完成后新出现的检测（检测时间不早于扫描开始前 1 分钟）。 */
export const newDetections = (list, since) => (list || []).filter((x) => x.time && new Date(x.time).getTime() >= since - 60e3);

/* ---------- 扫描状态机（纯逻辑）---------- */
export const SCAN_TYPES = ['quick', 'full', 'custom', 'offline'];
export class ScanMachine {
  state; type; startedAt; endedAt; error; gen; path;
  constructor() { this.state = 'idle'; this.type = null; this.startedAt = null; this.endedAt = null; this.error = ''; this.gen = 0; this.path = ''; }
  /** 开始；正在扫描时返回 0（拒绝），否则返回这次的代号。 */
  start(type, now, path = '') {
    if (this.state === 'running' || !SCAN_TYPES.includes(type)) return 0;
    this.gen++; this.state = 'running'; this.type = type; this.startedAt = now; this.endedAt = null; this.error = ''; this.path = path; return this.gen;
  }
  /** 只接受“当前这一次”的结果；停止等待之后迟到的结果会被忽略。 */
  finish(gen, ok, error, now) {
    if (gen !== this.gen || this.state !== 'running') return false;
    this.state = ok ? 'done' : 'error'; this.error = ok ? '' : String(error || ''); this.endedAt = now; return true;
  }
  cancel(now) { if (this.state !== 'running') return false; this.state = 'cancelled'; this.endedAt = now; this.gen++; return true; }
  view(now) { return { state: this.state, type: this.type, startedAt: this.startedAt, endedAt: this.endedAt, error: this.error, elapsedMs: this.startedAt ? (this.endedAt || now) - this.startedAt : 0, path: this.path }; }
}

/* ---------- PowerShell ---------- */
const STATUS_PS = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$s=Get-MpComputerStatus
$av=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { @{n=[string]$_.displayName;st=[int64]$_.productState} })
$o=@{ok=[bool]$s;cmd=[bool](Get-Command Start-MpScan -ErrorAction SilentlyContinue);av=$av}
if($s){ $o.am=[bool]$s.AMServiceEnabled; $o.ave=[bool]$s.AntivirusEnabled; $o.rtp=[bool]$s.RealTimeProtectionEnabled; $o.mode=[string]$s.AMRunningMode; $o.sigv=[string]$s.AntivirusSignatureVersion
  $o.sigt=$(if($s.AntivirusSignatureLastUpdated){$s.AntivirusSignatureLastUpdated.ToString('s')}else{''}); $o.qs=$(if($s.QuickScanEndTime){$s.QuickScanEndTime.ToString('s')}else{''}); $o.fs=$(if($s.FullScanEndTime){$s.FullScanEndTime.ToString('s')}else{''}) }
ConvertTo-Json -InputObject $o -Compress -Depth 3`;
const THREATS_PS = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$th=@{}; foreach($x in @(Get-MpThreat)){ $th[[string]$x.ThreatID]=$x }
$o=@(foreach($d in @(Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 100)){ $x=$th[[string]$d.ThreatID]
  @{id=[string]$d.ThreatID;n=[string]$(if($x){$x.ThreatName}else{''});sev=[int]$(if($x){$x.SeverityID}else{0});st=[int]$d.ThreatStatusID;ok=[bool]$d.ActionSuccess;t=$(if($d.InitialDetectionTime){$d.InitialDetectionTime.ToString('s')}else{''});r=@($d.Resources | ForEach-Object {[string]$_});p=[string]$d.ProcessName;act=[bool]$(if($x){$x.IsActive}else{$false})} })
ConvertTo-Json -InputObject @{ok=1;items=$o} -Compress -Depth 4`;
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
/** 生成扫描 / 更新命令。路径只走 Base64，不拼接到命令里。 */
export function scanScript(type, path = '') {
  const P = `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'))`;
  const cmd = type === 'quick' ? 'Start-MpScan -ScanType QuickScan' : type === 'full' ? 'Start-MpScan -ScanType FullScan' : type === 'custom' ? `Start-MpScan -ScanType CustomScan -ScanPath (${P})`
    : type === 'offline' ? 'Start-MpWDOScan' : 'Update-MpSignature';
  const fb = type === 'quick' ? "-Scan -ScanType 1" : type === 'full' ? "-Scan -ScanType 2" : type === 'custom' ? `-Scan -ScanType 3 -File (${P})` : type === 'update' ? '-SignatureUpdate' : '';
  const probe = type === 'update' ? 'Update-MpSignature' : type === 'offline' ? 'Start-MpWDOScan' : 'Start-MpScan';
  return `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
try{ if(Get-Command ${probe} -ErrorAction SilentlyContinue){ ${cmd} } else { ${fb ? `$m=Join-Path $env:ProgramFiles 'Windows Defender\\MpCmdRun.exe'; & $m ${fb} | Out-Null; if($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2){ throw ('MpCmdRun exit ' + $LASTEXITCODE) }` : "throw 'cmdlet not found'"} }; 'done' }catch{ 'fail:' + $_.Exception.Message }`;
}
/** 把 Defender 的英文错误变成看得懂的提示。 */
export function friendlyError(msg) {
  const s = String(msg || '');
  if (/0x80070005|access is denied|拒绝访问|0x800106ba/i.test(s)) return t('def.err.denied');
  if (/0x80508023|not found|cmdlet/i.test(s)) return t('def.err.missing');
  if (/0x8050800c|0x80240022|network|网络/i.test(s)) return t('def.err.net');
  return t('def.err.other', { msg: s.slice(0, 200) || 'unknown' });
}
let child: any = null;
function ps(script: string, timeout: number): Promise<string | null> {
  return new Promise((res) => {
    if (!isWin) return res(null);
    const c = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => { if (child === c) child = null; res(err && !out ? null : String(out || '').trim()); });
    child = c;
  });
}
const quick = (script, timeout) => new Promise<string | null>((res) => {
  if (!isWin) return res(null);
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => res(err ? null : String(out).trim()));
});
export async function readStatus(): Promise<DefStatus> {
  if (!isWin) return { ...parseStatus(null), error: t('def.err.win') };
  let j: any = null; try { j = JSON.parse((await quick(STATUS_PS, 30000)) || ''); } catch (_) {}
  const r = parseStatus(j);
  return j ? r : { ...r, error: t('def.err.status') };
}
export async function readThreats() {
  if (!isWin) return { ok: false, items: [] };
  let j: any = null; try { j = JSON.parse((await quick(THREATS_PS, 30000)) || ''); } catch (_) {}
  return j && j.ok ? { ok: true, items: parseThreats(j.items) } : { ok: false, items: [], error: t('def.err.threats') };
}
export const machine = new ScanMachine();
let updating = false;
/** 开始扫描（不等待结束，结果通过 onDone 回调）。返回 false 表示已有扫描在进行。 */
export function startScan(type, path, onDone: (ok: boolean, err: string, startedAt: number) => void) {
  if (!isWin) return { ok: false, error: t('def.err.win') };
  if (type === 'custom' && !path) return { ok: false, error: t('def.err.path') };
  const now = Date.now(), gen = machine.start(type, now, type === 'custom' ? path : '');
  if (!gen) return { ok: false, error: t('def.err.busy') };
  const timeout = type === 'full' ? 12 * 3600e3 : type === 'custom' ? 6 * 3600e3 : 2 * 3600e3;
  ps(scanScript(type, path), timeout).then((out) => {
    const ok = !!out && /(^|\n)done\s*$/.test(out);
    const err = ok ? '' : friendlyError(out ? out.replace(/^[\s\S]*?fail:/, '') : 'timeout');
    if (machine.finish(gen, ok, err, Date.now())) onDone(ok, err, now);
  });
  return { ok: true };
}
/** 停止等待：结束 NetPet 发起的 PowerShell（Defender 自己的扫描可能继续在后台进行）。 */
export function stopWaiting() {
  const r = machine.cancel(Date.now());
  if (child) { try { child.kill(); } catch (_) {} child = null; }
  return r;
}
export async function updateSignatures() {
  if (!isWin) return { ok: false, error: t('def.err.win') };
  if (updating) return { ok: false, error: t('def.err.busy') };
  updating = true;
  try {
    const out = await quick(scanScript('update'), 10 * 60e3);
    const ok = !!out && /(^|\n)done\s*$/.test(out);
    return ok ? { ok: true } : { ok: false, error: friendlyError(out ? out.replace(/^[\s\S]*?fail:/, '') : 'timeout') };
  } finally { updating = false; }
}
export const isUpdating = () => updating;
