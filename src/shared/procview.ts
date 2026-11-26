// 1.5.0 任务管理器的纯逻辑（主进程和界面共用，不依赖 Node / Electron，可单元测试）：
// 受保护进程判断、PID / 优先级校验、taskkill 参数、分类、分组、搜索排序、“值得确认”标记。
const arr = (x) => (x == null ? [] : [].concat(x));
/** 不允许结束的进程（小写、不带 .exe）。 */
export const PROTECTED_SYSTEM = ['system', 'idle', 'system idle process', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'fontdrvhost',
  'memory compression', 'secure system', 'sgrmbroker'];
export const PROTECTED_AV = ['msmpeng', 'nissrv', 'mpdefendercoreservice', 'securityhealthservice', 'securityhealthsystray', 'mssense', 'smartscreen',
  'avp', 'avpui', 'avgsvc', 'avastsvc', 'afwserv', 'ekrn', 'egui', 'mcshield', 'mfemms', 'bdagent', 'vsserv', 'bdservicehost', 'ccsvchst', 'nortonsecurity', 'sophoshealth',
  '360tray', '360sd', '360rp', 'zhudongfangyu', 'hipsdaemon', 'hipstray', 'usysdiag', 'qqpcrtp', 'qqpctray', 'kxetray', 'kxescore'];
/** 进程名统一成小写、去掉目录和 .exe。 */
export function normName(name) {
  let s = String(name || '').trim().replace(/^"+|"+$/g, '');
  s = s.split(/[\\/]/).pop() || '';
  return s.toLowerCase().replace(/\.exe$/, '').trim();
}
/** 不能结束的原因：'self'（NetPet 自己）/ 'system' / 'av' / null（可以结束）。 */
export function protectedReason(name, pid, selfPids) {
  if ((selfPids || []).includes(Number(pid))) return 'self';
  const n = normName(name);
  if (Number(pid) <= 4) return 'system';
  if (n === 'netpet' || n === 'electron') return 'self';
  if (PROTECTED_SYSTEM.includes(n)) return 'system';
  if (PROTECTED_AV.includes(n)) return 'av';
  return null;
}
export const validPid = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 0x7fffffff;
export const PRIORITIES = ['BelowNormal', 'Normal', 'AboveNormal'];
export const validPriority = (p) => PRIORITIES.includes(p);
/** taskkill 参数：正常结束 /PID n；/T 结束整棵进程树；/F 强制。 */
export function taskkillArgs(pid, o: { force?: boolean; tree?: boolean } = {}) {
  if (!validPid(pid)) return null;
  const a = ['/PID', String(pid)];
  if (o.tree) a.push('/T');
  if (o.force) a.push('/F');
  return a;
}
export interface Proc { pid: number; ppid: number; name: string; cpu: number; mem: number; priv: number | null; user: string; path: string; cmd: string; started: string; title: string; kind: string } // kind: app / bg / win
const WINDIR_RE = /^[a-z]:\\windows\\/i;
/** 分类：有窗口标题的是“应用”；在 Windows 目录下或属于系统进程名单的是“Windows 进程”；其余是“后台进程”。 */
export function classify(p) {
  if (p.title) return 'app';
  if (WINDIR_RE.test(String(p.path || '')) || PROTECTED_SYSTEM.includes(normName(p.name)) || Number(p.pid) <= 4) return 'win';
  return 'bg';
}
/** systeminformation.processes().list + 窗口标题 → 统一结构（纯函数）。memRss 单位是 KB。 */
export function parseSi(list, titles) {
  const tl = titles || {};
  return arr(list).filter((x) => x && Number.isFinite(Number(x.pid))).map((x) => {
    const p = { pid: Number(x.pid), ppid: Number(x.parentPid) || 0, name: String(x.name || ''), cpu: Math.max(0, Number(x.cpu) || 0), mem: Math.max(0, (Number(x.memRss) || 0) * 1024), priv: null,
      user: String(x.user || ''), path: String(x.path || ''), cmd: String(((x.command || '') + ' ' + (x.params || '')).trim()).slice(0, 2000), started: String(x.started || ''), title: String(tl[String(x.pid)] || '').slice(0, 200), kind: 'bg' };
    if (p.path && !/\.exe$/i.test(p.path) && p.name) p.path = p.path.replace(/[\\/]+$/, '') + '\\' + p.name; // 有的版本 path 只给目录
    p.kind = classify(p);
    return p;
  });
}
/** 按名称分组（同名的多个进程合成一组，CPU / 内存求和）。 */
export function groupProcs(list) {
  const m = new Map();
  for (const p of list || []) {
    const k = normName(p.name) || String(p.pid);
    let g = m.get(k);
    if (!g) { g = { key: k, name: p.name, count: 0, cpu: 0, mem: 0, kind: p.kind, title: '', items: [] }; m.set(k, g); }
    g.count++; g.cpu += p.cpu; g.mem += p.mem; g.items.push(p);
    if (p.title && !g.title) g.title = p.title;
    if (p.kind === 'app') g.kind = 'app'; else if (g.kind !== 'app' && p.kind === 'bg') g.kind = 'bg';
  }
  return [...m.values()];
}
/** 搜索（名称 / PID / 窗口标题 / 路径）+ 类别过滤 + 排序（纯函数）。 */
export function filterSort(list, o: { q?: string; kind?: string; sort?: string; desc?: boolean } = {}) {
  const q = String(o.q || '').trim().toLowerCase();
  let l = (list || []).filter((p) => (!o.kind || o.kind === 'all' || p.kind === o.kind) &&
    (!q || String(p.name).toLowerCase().includes(q) || String(p.pid) === q || String(p.title || '').toLowerCase().includes(q) || String(p.path || '').toLowerCase().includes(q)));
  const k = ['name', 'pid', 'cpu', 'mem', 'count'].includes(o.sort) ? o.sort : 'cpu';
  const dir = o.desc === false ? 1 : -1;
  l = [...l].sort((a, b) => {
    const x = a[k] == null ? 0 : a[k], y = b[k] == null ? 0 : b[k];
    const c = typeof x === 'string' ? String(x).localeCompare(String(y)) : x - y;
    return c !== 0 ? c * dir : a.pid - b.pid;
  });
  return l;
}
/** 未签名 / 签名无效，且位于用户可写目录（AppData、Temp、下载、公共用户目录）的程序“值得确认”。 */
export function worthChecking(path, sigStatus) {
  if (!path || sigStatus === 'Valid') return false;
  return /\\(appdata|temp|downloads|users\\public)\\/i.test(String(path));
}

