// 本地日志：%APPDATA%\NetPet\logs\netpet.log（超过 1MB 自动换新文件）。只记录启动步骤、错误和卡顿，不记录任何监控数据。
import fs from 'node:fs';
import path from 'node:path';
let file = '';
export function initLog(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); file = path.join(dir, 'netpet.log'); if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + '.old'); } catch (_) {}
}
export function log(msg: string) { if (!file) return; try { fs.appendFileSync(file, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {} }
