// 系统垃圾清理：只删白名单里的目录，只在用户点了“扫描 → 勾选 → 确认清理”后才动手。
// 安全底线（写死在代码里，不是界面文案）：
//  - 绝不碰文档、下载、桌面、图片、程序文件、Windows 目录本身、注册表；
//  - 绝不删目录本身，只删里面的文件和空子目录；不跟随符号链接/交接点；
//  - 目标根目录必须足够深（不是盘符根、不是用户主目录），否则整类拒绝；
//  - 正在使用的文件删不掉就记为“已跳过”，不报错、不重试、不强行结束进程；
//  - Windows Update 下载、Delivery Optimization、Prefetch 不在清理范围（删了可能影响更新/启动，
//    且前两项要停服务+管理员权限，普通清理工具不该悄悄做）；
//  - 回收站是单独一类：先扫描 $Recycle.Bin 算大小，清理时走 PowerShell Clear-RecycleBin，清空不可恢复。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export type JunkId = 'user-temp' | 'win-temp' | 'browser-cache' | 'crash-logs' | 'recycle-bin' | 'netpet-logs';
export interface JunkScan { id: JunkId; name: string; desc: string; size: number; files: number; skipped: string[] }
export interface JunkClean { id: JunkId; freed: number; deletedFiles: number; skippedFiles: number; dirsRemoved: number; ok: boolean; error?: string }
export interface ScanOptions {
  rootsOverride?: Partial<Record<JunkId, string[]>>;
  netpetLogsDir?: string;
  /** 单元测试用：跳过“仅 Windows”限制（回收站除外，仍需 Windows）。 */
  allowNonWindows?: boolean;
}

const isWin = process.platform === 'win32';
const env = (k: string) => process.env[k] || '';
const join = (...p: string[]) => path.join(...p);

function chromiumProfiles(userData: string): string[] {
  try { return fs.readdirSync(userData, { withFileTypes: true }).filter((e) => e.isDirectory() && /^(Default|Profile \d+)$/.test(e.name)).map((e) => e.name); }
  catch (_) { return []; }
}
/** 去重（%TEMP% 与 %LOCALAPPDATA%\Temp 通常是同一目录，旧版会算两遍）；路径大小写不敏感。 */
export function uniqRoots(l: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const r of l) { if (!r) continue; const k = path.resolve(r).toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out;
}
function rootsFor(id: JunkId, o: ScanOptions): string[] { return uniqRoots(rootsRaw(id, o)); }
function rootsRaw(id: JunkId, o: ScanOptions): string[] {
  if (o.rootsOverride && o.rootsOverride[id]) return o.rootsOverride[id]!;
  // 环境变量缺失时不要拼出相对路径（如 'Temp'），整类返回空
  if (!o.rootsOverride && isWin && !env('LOCALAPPDATA')) return [];
  const local = env('LOCALAPPDATA'), roaming = env('APPDATA'), temp = env('TEMP') || env('TMP') || join(local, 'Temp');
  const win = env('SystemRoot') || env('windir') || 'C:\\Windows';
  const chrome = join(local, 'Google', 'Chrome', 'User Data');
  const edge = join(local, 'Microsoft', 'Edge', 'User Data');
  const firefox = join(roaming, 'Mozilla', 'Firefox', 'Profiles');
  switch (id) {
    case 'user-temp': return [temp, join(local, 'Temp')];
    case 'win-temp': return [join(win, 'Temp')];
    // 覆盖 Default 和 Profile N 等所有浏览器配置（旧版只处理 Default）
    case 'browser-cache': return [chrome, edge].flatMap((b) => chromiumProfiles(b).flatMap((p) => [join(b, p, 'Cache'), join(b, p, 'Code Cache'), join(b, p, 'GPUCache')]))
      .concat([join(firefox)]); // Firefox 下按 profile 分目录，扫描时只进 */cache2
    // 不再包含 C:\Windows\Logs：里面是 CBS/DISM/WindowsUpdate 等系统日志，违背“不碰 Windows 目录”的承诺
    case 'crash-logs': return [join(local, 'CrashDumps'), join(local, 'Microsoft', 'Windows', 'WER', 'ReportArchive')];
    case 'recycle-bin': return [];
    case 'netpet-logs': return o.netpetLogsDir ? [o.netpetLogsDir] : [];
  }
}

export const CATEGORIES: { id: JunkId; name: string; desc: string }[] = [
  { id: 'user-temp', name: '用户临时文件', desc: '当前用户的 Temp 文件夹里 24 小时以前的临时文件（较新的可能是正在安装的程序要用的，不动）。' },
  { id: 'win-temp', name: 'Windows 临时文件', desc: 'C:\\Windows\\Temp 里 24 小时以前的文件，需要权限时会自动跳过删不掉的文件。' },
  { id: 'browser-cache', name: '浏览器缓存', desc: 'Chrome / Edge / Firefox 的网页缓存。浏览器开着时，被占用的缓存文件会跳过；想清干净请先关浏览器。' },
  { id: 'crash-logs', name: '崩溃转储与错误报告', desc: '程序崩溃转储（.dmp）和 Windows 错误报告存档，不含系统日志。' },
  { id: 'recycle-bin', name: '回收站', desc: '回收站里的全部文件。清空后不可恢复，请确认后再勾选。' },
  { id: 'netpet-logs', name: 'NetPet 旧日志', desc: 'NetPet 自己的日志，只清理 30 天以前的。' }
];
export const CATEGORY_IDS: JunkId[] = CATEGORIES.map((c) => c.id);

/** 根目录必须够深：拒绝盘符根、用户主目录、Windows 目录本身等危险目标。 */
export function isSafeRoot(root: string): boolean {
  if (!root || !path.isAbsolute(root)) return false; // 相对路径（环境变量为空时拼出来的）一律拒绝
  const norm = path.resolve(root);
  const parts = norm.split(path.sep).filter(Boolean);
  if (parts.length < 3) return false; // 如 C:\、C:\Users 不够深
  if (parts.length === 3 && /^users$/i.test(parts[1])) return false; // C:\Users\xxx（任意用户主目录）
  const lower = norm.toLowerCase();
  if (lower === path.resolve(env('SystemRoot') || 'C:\\Windows').toLowerCase()) return false;
  if (lower === path.resolve(env('USERPROFILE') || '').toLowerCase()) return false;
  return true;
}

/** 临时文件只处理 24 小时以前的，避免删掉安装程序刚解压、尚未被占用的文件 */
const AGE_CUTOFF: Partial<Record<JunkId, number>> = { 'user-temp': 864e5, 'win-temp': 864e5 };
const cutoffFor = (id: JunkId) => (id === 'netpet-logs' ? Date.now() - 30 * 864e5 : AGE_CUTOFF[id] ? Date.now() - AGE_CUTOFF[id]! : 0);
async function walk(root: string, out: { size: number; files: number }, depth = 0, cutoffMs = 0): Promise<void> {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    let st: fs.Stats;
    try { st = await fs.promises.lstat(p); } catch (_) { continue; }
    if (st.isSymbolicLink()) continue; // 不跟随链接，防止删到链接目标
    if (st.isDirectory()) { await walk(p, out, depth + 1, cutoffMs); continue; }
    if (st.isFile() && (!cutoffMs || st.mtimeMs < cutoffMs)) { out.size += st.size; out.files++; }
  }
}

async function recycleSize(): Promise<{ size: number; files: number }> {
  const out = { size: 0, files: 0 };
  if (!isWin) return out;
  // 扫描所有存在的盘（旧版只看 C/D/E，而 Clear-RecycleBin 会清空全部盘）
  for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
    const root = `${drive}:\\$Recycle.Bin`;
    try { const st = await fs.promises.stat(root); if (!st.isDirectory()) continue; } catch (_) { continue; }
    await walk(root, out);
  }
  return out;
}

export async function scanJunk(o: ScanOptions = {}): Promise<JunkScan[]> {
  const res: JunkScan[] = [];
  for (const c of CATEGORIES) {
    if (c.id === 'recycle-bin') {
      const r = await recycleSize();
      res.push({ ...c, size: r.size, files: r.files, skipped: isWin ? [] : ['仅支持 Windows'] });
      continue;
    }
    let size = 0, files = 0; const skipped: string[] = [];
    const roots = rootsFor(c.id, o).filter(Boolean);
    for (const root of roots) {
      if (!isSafeRoot(root)) { skipped.push(`已跳过不安全的目录：${root}`); continue; }
      // Firefox：只扫各 profile 下的 cache2，不碰整个 Profiles 目录（见下面的单独重算）
      if (c.id === 'browser-cache' && root.endsWith('Profiles')) continue;
      const out = { size: 0, files: 0 };
      await walk(root, out, 0, cutoffFor(c.id));
      size += out.size; files += out.files;
    }
    // 修正 Firefox 累加：上面 continue 分支里 walk 用了丢弃的 out，这里单独重算
    if (c.id === 'browser-cache') {
      const ff = roots.find((r) => r.endsWith('Profiles'));
      if (ff) {
        let profiles: fs.Dirent[] = [];
        try { profiles = await fs.promises.readdir(ff, { withFileTypes: true }); } catch (_) {}
        for (const p of profiles) {
          if (!p.isDirectory()) continue;
          const out = { size: 0, files: 0 };
          await walk(join(ff, p.name, 'cache2'), out);
          size += out.size; files += out.files;
        }
      }
    }
    // NetPet 日志只算 30 天前的
    if (c.id === 'netpet-logs' && o.netpetLogsDir) {
      size = 0; files = 0;
      const cutoff = Date.now() - 30 * 864e5;
      const walkOld = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 4) return;
        let entries: fs.Dirent[] = [];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
          const p = join(dir, e.name);
          let st: fs.Stats; try { st = await fs.promises.lstat(p); } catch (_) { continue; }
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) { await walkOld(p, depth + 1); continue; }
          if (st.isFile() && st.mtimeMs < cutoff) { size += st.size; files++; }
        }
      };
      await walkOld(o.netpetLogsDir);
    }
    res.push({ ...c, size, files, skipped });
  }
  return res;
}

async function cleanDir(root: string, res: JunkClean, cutoffMs = 0, depth = 0): Promise<void> {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = join(root, e.name);
    let st: fs.Stats;
    try { st = await fs.promises.lstat(p); } catch (_) { res.skippedFiles++; continue; }
    if (st.isSymbolicLink()) { res.skippedFiles++; continue; }
    if (st.isDirectory()) { await cleanDir(p, res, cutoffMs, depth + 1); try { await fs.promises.rmdir(p); res.dirsRemoved++; } catch (_) {} continue; }
    if (!st.isFile()) continue;
    if (cutoffMs && st.mtimeMs >= cutoffMs) { res.skippedFiles++; continue; }
    try { await fs.promises.unlink(p); res.freed += st.size; res.deletedFiles++; } catch (_) { res.skippedFiles++; } // 被占用/无权限：跳过
  }
}

function runPs(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
  });
}

export async function cleanJunk(ids: string[], o: ScanOptions = {}): Promise<JunkClean[]> {
  const wanted = ids.filter((i): i is JunkId => (CATEGORY_IDS as string[]).includes(i));
  const out: JunkClean[] = [];
  for (const id of wanted) {
    const r: JunkClean = { id, freed: 0, deletedFiles: 0, skippedFiles: 0, dirsRemoved: 0, ok: true };
    if (id === 'recycle-bin') {
      if (!isWin) { r.ok = false; r.error = '回收站清理仅支持 Windows'; out.push(r); continue; }
      // 清空前后各量一次：用实际减少量作为释放大小；清不干净如实报告（旧版 SilentlyContinue 永远显示成功）
      const before = await recycleSize();
      try { await runPs(['-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue']); } catch (e: any) { r.ok = false; r.error = String((e && e.message) || e); }
      const after = await recycleSize();
      r.freed = Math.max(0, before.size - after.size); r.deletedFiles = Math.max(0, before.files - after.files); r.skippedFiles = after.files;
      if (r.ok && after.files > 0) { r.ok = false; r.error = `回收站还有 ${after.files} 个文件没能清空（可能被占用或需要管理员权限）`; }
      out.push(r); continue;
    }
    const roots = rootsFor(id, o).filter(Boolean);
    const cutoff = cutoffFor(id);
    for (const root of roots) {
      if (!isSafeRoot(root)) { r.ok = false; r.error = `已拒绝不安全的目录：${root}`; continue; }
      if (id === 'browser-cache' && root.endsWith('Profiles')) {
        let profiles: fs.Dirent[] = [];
        try { profiles = await fs.promises.readdir(root, { withFileTypes: true }); } catch (_) {}
        for (const p of profiles) if (p.isDirectory()) await cleanDir(join(root, p.name, 'cache2'), r);
        continue;
      }
      await cleanDir(root, r, cutoff);
    }
    out.push(r);
  }
  return out;
}
