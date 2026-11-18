// 全屏应用检测（可选功能，需用户在隐私设置里开启）：只读调用 Windows 自带的 SHQueryUserNotificationState，
// 判断“有全屏程序/游戏/演示”，不读取任何窗口内容。使用一个常驻 PowerShell 子进程，关闭功能或退出软件时一定会结束。
const { spawn } = require('child_process');
let child = null, buf = '';
const SCRIPT = 'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class Q{[DllImport("shell32.dll")]public static extern int SHQueryUserNotificationState(out int s);}\';while($true){$s=0;[void][Q]::SHQueryUserNotificationState([ref]$s);[Console]::Out.WriteLine($s);[Console]::Out.Flush();Start-Sleep -Seconds 3}';
function start(cb) {
  if (process.platform !== 'win32' || child) return;
  child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const n = Number(buf.slice(0, i).trim()); buf = buf.slice(i + 1); if (n) cb([2, 3, 4].includes(n)); } });
  child.on('exit', () => { child = null; });
  child.on('error', () => { child = null; });
}
function stop() { if (child) { try { child.kill(); } catch (_) {} child = null; } }
module.exports = { start, stop };
