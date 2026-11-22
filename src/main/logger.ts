// 本地日志：%APPDATA%\NetPet\logs\netpet.log。超过 1MB 换新文件，旧文件按时间命名，最多保留 5 个；
// 30 天以前的可在“系统清理 → NetPet 旧日志”里清理。只记录启动步骤、错误和卡顿，不记录任何监控数据。
import fs from 'node:fs';
import path from 'node:path';
let file = '', dirRef = '', n = 0;
const MAX = 1_000_000, KEEP = 5;
function rotate() {
  try {
    if (fs.statSync(file).size <= MAX) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, path.join(dirRef, `netpet-${stamp}.log`));
    const old = fs.readdirSync(dirRef).filter((f) => /^netpet-.*\.log$/.test(f) || f === 'netpet.log.old').sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP))) { try { fs.unlinkSync(path.join(dirRef, f)); } catch (_) {} }
  } catch (_) {}
}
export function initLog(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); dirRef = dir; file = path.join(dir, 'netpet.log'); rotate(); } catch (_) {}
}
export function log(msg: string) {
  if (!file) return;
  try { fs.appendFileSync(file, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
  if (++n % 200 === 0) rotate(); // 常驻运行时也检查大小（旧版只在启动时换文件）
}
