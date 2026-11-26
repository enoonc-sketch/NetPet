// 1.5.0 内置任务管理器。这是 NetPet 里唯一可以结束进程的功能，而且每次都必须由用户点击并确认；
// 运行内存整理（memtrim）仍然保证绝不结束任何程序。
//  - 进程列表（不联网）：复用采集进程里的 systeminformation.processes()，只在页面可见时每 2 秒刷新；
//    窗口标题用一次很轻的 Get-Process 读取（10 秒缓存），用来区分“应用 / 后台进程 / Windows 进程”。磁盘 / 网络按进程的读写量拿不到低成本数据，不显示。
//  - 详情：命令行、父进程、路径、文件签名（Get-AuthenticodeSignature，按路径缓存）；未签名且位于用户可写目录的程序标为“值得确认”。
//  - 操作：结束进程（先不带 /F 正常结束，失败再提示强制结束）、结束进程树（/T，二次确认）、设置优先级（只允许 低于正常 / 正常 / 高于正常，绝不设置“实时”）。
//    系统关键进程、杀毒软件进程、NetPet 自己不允许结束。所有操作都写入本地日志。
import { execFile } from 'node:child_process';
import { t } from '../shared/i18n';
const isWin = process.platform === 'win32';
const arr = (x) => (x == null ? [] : [].concat(x));
import { taskkillArgs, validPid, validPriority } from '../shared/procview';

export * from '../shared/procview';
/* ---------- 读取 ---------- */
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
function ps(script: string, timeout = 15000): Promise<string | null> {
  return new Promise((res) => {
    if (!isWin) return res(null);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => res(err ? null : String(out).trim()));
  });
}
let titles: [number, Record<string, string>] = [0, {}], titlesBusy: Promise<any> | null = null;
/** 有窗口标题的进程（10 秒缓存）。 */
export async function windowTitles() {
  if (Date.now() - titles[0] < 10000 || !isWin) return titles[1];
  if (!titlesBusy) titlesBusy = (async () => {
    let j: any = null; try { j = JSON.parse((await ps("@(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{i=$_.Id;t=[string]$_.MainWindowTitle} }) | ConvertTo-Json -Compress")) || '[]'); } catch (_) {}
    const o = {}; for (const x of arr(j)) if (x && x.i) o[String(x.i)] = String(x.t || '');
    titles = [Date.now(), o];
  })().finally(() => { titlesBusy = null; });
  await titlesBusy; return titles[1];
}
const sigCache = new Map<string, { status: string; signer: string }>();
export async function signature(path) {
  if (!path || !isWin) return { status: 'Unknown', signer: '' };
  const k = String(path).toLowerCase();
  if (sigCache.has(k)) return sigCache.get(k);
  let j: any = null;
  try { j = JSON.parse((await ps(`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}')); $s=Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop; @{s=[string]$s.Status;n=[string]$(if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo('SimpleName',$false)}else{''})} | ConvertTo-Json -Compress`, 20000)) || ''); } catch (_) {}
  const r = j ? { status: String(j.s || 'Unknown'), signer: String(j.n || '').slice(0, 200) } : { status: 'Unknown', signer: '' };
  if (sigCache.size > 500) sigCache.clear();
  sigCache.set(k, r); return r;
}
let svcCache: [number, any[]] = [0, []];
export async function services() {
  if (!isWin) return { ok: false, items: [], error: t('pm.err.win') };
  if (Date.now() - svcCache[0] < 30000) return { ok: true, items: svcCache[1] };
  let j: any = null;
  try { j = JSON.parse((await ps("@(Get-Service | ForEach-Object { @{n=[string]$_.Name;d=[string]$_.DisplayName;s=[string]$_.Status;t=[string]$_.StartType} }) | ConvertTo-Json -Compress", 30000)) || ''); } catch (_) {}
  if (!j) return { ok: false, items: [], error: t('pm.err.svc') };
  const items = arr(j).filter((x) => x && x.n).map((x) => ({ name: String(x.n), display: String(x.d || ''), status: String(x.s || ''), start: String(x.t || '') })).sort((a, b) => a.display.localeCompare(b.display));
  svcCache = [Date.now(), items]; return { ok: true, items };
}

/* ---------- 操作 ---------- */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e && e.code === 'EPERM'; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** 结束进程。force=false 时用 taskkill（不带 /F，程序可以保存后退出）；2.5 秒后仍在运行则返回 needForce。 */
export async function kill(pid, o: { force?: boolean; tree?: boolean }) {
  const a = taskkillArgs(pid, o);
  if (!a) return { ok: false, code: 'badPid' };
  if (!isWin) return { ok: false, code: 'notWin' };
  if (!alive(pid)) return { ok: false, code: 'notFound' };
  if (o.force && !o.tree) {
    try { process.kill(pid); } catch (e: any) { return { ok: false, code: e && e.code === 'EPERM' ? 'denied' : e && e.code === 'ESRCH' ? 'notFound' : 'failed' }; }
  } else {
    await new Promise((res) => execFile('taskkill.exe', a, { windowsHide: true, timeout: 15000 }, () => res(null)));
  }
  await wait(o.force ? 800 : 2500);
  if (!alive(pid)) return { ok: true, code: 'ok' };
  return { ok: false, code: o.force ? 'denied' : 'needForce' };
}
export async function setPriority(pid, cls) {
  if (!validPid(pid) || !validPriority(cls)) return { ok: false, code: 'badArg' };
  if (!isWin) return { ok: false, code: 'notWin' };
  const out = await ps(`try{ $p=Get-Process -Id ${pid} -ErrorAction Stop; $p.PriorityClass=[System.Diagnostics.ProcessPriorityClass]::${cls}; 'done' }catch{ $e=$_.Exception; while($e.InnerException){$e=$e.InnerException}; if(($e -is [System.ComponentModel.Win32Exception]) -and $e.NativeErrorCode -eq 5){'denied'}else{'fail:' + $_.Exception.Message} }`);
  if (out && /done\s*$/.test(out)) return { ok: true, code: 'ok' };
  return { ok: false, code: out && /denied\s*$/.test(out) ? 'denied' : 'failed', msg: out ? out.replace(/^[\s\S]*?fail:/, '').slice(0, 200) : '' };
}
