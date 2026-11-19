// 全屏应用检测（可选功能，需用户在隐私设置里开启）：只读调用 Windows 自带的 SHQueryUserNotificationState，
// 判断“有全屏程序/游戏/演示”，不读取任何窗口内容。使用一个常驻 PowerShell 子进程，关闭功能或退出软件时一定会结束。
//
// 取值按微软官方 QUERY_USER_NOTIFICATION_STATE（1 起编号，见 learn.microsoft.com：
// QUNS_NOT_PRESENT=1, QUNS_BUSY=2, QUNS_RUNNING_D3D_FULL_SCREEN=3, QUNS_PRESENTATION_MODE=4,
// QUNS_ACCEPTS_NOTIFICATIONS=5, QUNS_QUIET_TIME=6, QUNS_APP=7）。
// 其中 2（有全屏应用/演示设置）、3（独占全屏 Direct3D）、4（演示模式）才算全屏；
// 5 是“正常桌面、可以收通知”，绝不能算隐藏。
// 旧版的问题不在取值，而在没有防抖、子进程死掉后也不重启：最后一次“隐藏”会一直卡住，宠物就再也不出现。
import { spawn } from 'node:child_process';

/** 只有这三个值代表全屏/演示；5（正常桌面）等一律不隐藏。 */
export function isFullscreenState(n: number): boolean { return n === 2 || n === 3 || n === 4; }

let child: any = null, buf = '';
let wanted = false, cbRef: ((hidden: boolean) => void) | null = null;
let restartTimer: any = null, lastHidden = false, pendingHidden: boolean | null = null, pendingN = 0;

const SCRIPT = 'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class Q{[DllImport("shell32.dll")]public static extern int SHQueryUserNotificationState(out int s);}\';while($true){$s=0;[void][Q]::SHQueryUserNotificationState([ref]$s);[Console]::Out.WriteLine($s);[Console]::Out.Flush();Start-Sleep -Seconds 3}';

function spawnChild() {
  if (process.platform !== 'win32' || child || !wanted) return;
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', (d: any) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const n = Number(buf.slice(0, i).trim()); buf = buf.slice(i + 1);
      if (!Number.isFinite(n)) continue;
      // 防抖：连续 2 次（约 6 秒）读到同一状态才翻转，避免切全屏/切回来的瞬间宠物闪一下。
      const hidden = isFullscreenState(n);
      if (hidden === lastHidden) { pendingHidden = null; pendingN = 0; continue; }
      if (pendingHidden !== hidden) { pendingHidden = hidden; pendingN = 1; continue; }
      if (++pendingN >= 2) { lastHidden = hidden; pendingHidden = null; pendingN = 0; if (cbRef) cbRef(hidden); }
    }
  });
  const dead = () => {
    child = null;
    if (!wanted) return;
    // 子进程意外退出：不要把上一次的“隐藏”卡住——先恢复显示，再 5 秒后自动重启检测。
    if (lastHidden) { lastHidden = false; pendingHidden = null; pendingN = 0; if (cbRef) cbRef(false); }
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(spawnChild, 5000);
  };
  child.on('exit', dead);
  child.on('error', dead);
}

function start(cb: (hidden: boolean) => void) {
  wanted = true; cbRef = cb;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  spawnChild();
}
function stop() {
  wanted = false; cbRef = null;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  lastHidden = false; pendingHidden = null; pendingN = 0;
  if (child) { try { child.kill(); } catch (_) {} child = null; }
}
export { start, stop };
