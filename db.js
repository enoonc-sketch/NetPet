// 本地 SQLite 数据层（Node 内置 node:sqlite，无需编译原生模块）。所有数据只存本机。
const fs = require('fs');
const path = require('path');
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {}

let db = null, dbPath = '', dir = '';
let pend = { day: '', rx: 0, tx: 0, peak: 0 };
const st = { ok: false, recovered: false, error: '' };
const q = {};
const day = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS network_statistics(day TEXT PRIMARY KEY, rx REAL NOT NULL DEFAULT 0, tx REAL NOT NULL DEFAULT 0, peak_rx REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS adapter_information(name TEXT PRIMARY KEY, type TEXT, speed REAL, ip4 TEXT, is_virtual INTEGER, is_up INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS connection_records(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, proc TEXT, pid INTEGER, ip TEXT, port INTEGER, host TEXT, proto TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_conn_t ON connection_records(t);
CREATE TABLE IF NOT EXISTS hardware_statistics(t INTEGER NOT NULL, cpu REAL, mem_pct REAL, temp REAL);
CREATE INDEX IF NOT EXISTS idx_hw_t ON hardware_statistics(t);
CREATE TABLE IF NOT EXISTS system_health(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, score INTEGER, report TEXT);
CREATE TABLE IF NOT EXISTS warning_records(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, level TEXT, title TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS proc_traffic(proc TEXT PRIMARY KEY, rx REAL NOT NULL DEFAULT 0, tx REAL NOT NULL DEFAULT 0, last_seen INTEGER);
`;

function openDb() {
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  const r = db.prepare('PRAGMA quick_check').get();
  if (Object.values(r)[0] !== 'ok') throw new Error('数据库完整性检查未通过');
  db.exec(SCHEMA);
  q.upTraffic = db.prepare('INSERT INTO network_statistics(day,rx,tx,peak_rx) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET rx=rx+excluded.rx, tx=tx+excluded.tx, peak_rx=max(peak_rx,excluded.peak_rx)');
  q.insConn = db.prepare('INSERT INTO connection_records(t,proc,pid,ip,port,host,proto,note) VALUES(?,?,?,?,?,?,?,?)');
  q.setSet = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
}
function init(d) {
  dir = d; fs.mkdirSync(dir, { recursive: true }); dbPath = path.join(dir, 'netpet.db');
  if (!DatabaseSync) { st.error = '当前运行环境不支持 SQLite'; return st; }
  try { openDb(); st.ok = true; }
  catch (e) {
    st.error = String(e.message || e);
    try { db && db.close(); } catch (_) {}
    db = null;
    const stamp = Date.now();
    for (const ext of ['', '-wal', '-shm']) { try { fs.renameSync(dbPath + ext, `${dbPath}.corrupt-${stamp}${ext}`); } catch (_) {} }
    try { openDb(); st.ok = true; st.recovered = true; } catch (e2) { st.error += ' / ' + e2.message; db = null; }
  }
  return st;
}
const status = () => ({ ...st, path: dbPath });
const tx = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } };

/* 设置 */
function loadSettings() {
  const o = {}; if (!db) return o;
  for (const r of db.prepare('SELECT key,value FROM settings').all()) { try { o[r.key] = JSON.parse(r.value); } catch (_) {} }
  return o;
}
function saveSettings(obj) { if (!db) return; tx(() => { for (const [k, v] of Object.entries(obj)) q.setSet.run(k, JSON.stringify(v ?? null)); }); }

/* 流量（网卡总流量）*/
function addTraffic(rx, txb) {
  const k = day();
  if (pend.day && pend.day !== k) flush();
  pend.day = k; pend.rx += rx; pend.tx += txb; if (rx > pend.peak) pend.peak = rx;
}
function flush() {
  if (!db || !pend.day || (!pend.rx && !pend.tx)) { pend = { day: pend.day, rx: 0, tx: 0, peak: 0 }; return; }
  try { q.upTraffic.run(pend.day, pend.rx, pend.tx, pend.peak); } catch (_) {}
  pend = { day: '', rx: 0, tx: 0, peak: 0 };
}
function today() {
  const k = day(); let r = { rx: 0, tx: 0 };
  if (db) { const x = db.prepare('SELECT rx,tx FROM network_statistics WHERE day=?').get(k); if (x) r = { rx: x.rx, tx: x.tx }; }
  if (pend.day === k) { r.rx += pend.rx; r.tx += pend.tx; }
  return r;
}
function month() {
  const p = day().slice(0, 7); let r = { rx: 0, tx: 0 };
  if (db) { const x = db.prepare("SELECT COALESCE(SUM(rx),0) rx, COALESCE(SUM(tx),0) tx FROM network_statistics WHERE day LIKE ?").get(p + '%'); r = { rx: x.rx, tx: x.tx }; }
  if (pend.day && pend.day.startsWith(p)) { r.rx += pend.rx; r.tx += pend.tx; }
  return r;
}
function stats() {
  if (!db) return { total: 0, peakRx: 0, daysUsed: 0 };
  const x = db.prepare('SELECT COALESCE(SUM(rx+tx),0) total, COALESCE(MAX(peak_rx),0) peak, COUNT(*) n FROM network_statistics').get();
  return { total: x.total + pend.rx + pend.tx, peakRx: Math.max(x.peak, pend.peak), daysUsed: x.n };
}

/* 连接元数据 */
function addConnections(rows) {
  if (!db || !rows.length) return;
  tx(() => { for (const r of rows) q.insConn.run(r.t, r.proc, r.pid, r.ip, r.port, r.host || '', r.proto || '', r.note || ''); });
}
const like = (s) => '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
function connections(days, text, limit = 500) {
  if (!db) return { rows: [], total: 0, byProc: [], byHost: [] };
  const since = Date.now() - days * 864e5, s = (text || '').trim();
  const where = s ? 'WHERE t>=? AND (proc LIKE ? ESCAPE \'\\\' OR host LIKE ? ESCAPE \'\\\' OR ip LIKE ? ESCAPE \'\\\')' : 'WHERE t>=?';
  const args = s ? [since, like(s), like(s), like(s)] : [since];
  const rows = db.prepare(`SELECT t,proc,pid,ip,port,host,proto,note FROM connection_records ${where} ORDER BY t DESC LIMIT ${Number(limit) | 0}`).all(...args);
  const total = db.prepare(`SELECT COUNT(*) n FROM connection_records ${where}`).get(...args).n;
  const byProc = db.prepare(`SELECT proc name, COUNT(*) count FROM connection_records ${where} GROUP BY proc ORDER BY count DESC LIMIT 8`).all(...args);
  const byHost = db.prepare(`SELECT COALESCE(NULLIF(host,''),ip) name, COUNT(*) count FROM connection_records ${where} GROUP BY name ORDER BY count DESC LIMIT 8`).all(...args);
  return { rows, total, byProc, byHost };
}
function toCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['时间', '程序', 'PID', '远端IP', '端口', '主机名(反查)', '协议', '提示(仅供参考)'];
  return '\ufeff' + [head.map(esc).join(','), ...rows.map((r) => [new Date(r.t).toLocaleString(), r.proc, r.pid, r.ip, r.port, r.host, r.proto, r.note].map(esc).join(','))].join('\r\n');
}

/* 按程序流量（ETW，累计值按程序名存）*/
function addProcTraffic(rows) {
  if (!db || !rows.length) return;
  const up = db.prepare('INSERT INTO proc_traffic(proc,rx,tx,last_seen) VALUES(?,?,?,?) ON CONFLICT(proc) DO UPDATE SET rx=rx+excluded.rx, tx=tx+excluded.tx, last_seen=excluded.last_seen');
  tx(() => { for (const r of rows) up.run(String(r.proc).slice(0, 100), Number(r.rx) || 0, Number(r.tx) || 0, Date.now()); });
}
function procTrafficTop(limit = 10) {
  if (!db) return [];
  return db.prepare('SELECT proc,rx,tx,last_seen FROM proc_traffic ORDER BY rx+tx DESC LIMIT ?').all(Number(limit) || 10);
}
function clearProcTraffic() { if (db) db.exec('DELETE FROM proc_traffic'); }

/* 硬件历史 / 健康 / 提醒 / 网卡 */
function addHardware(t, cpu, mem, temp) { if (db) db.prepare('INSERT INTO hardware_statistics(t,cpu,mem_pct,temp) VALUES(?,?,?,?)').run(t, cpu, mem, temp ?? null); }
function hardwareSummary(hours = 24) {
  if (!db) return null;
  const x = db.prepare('SELECT COUNT(*) n, AVG(cpu) cpu, MAX(cpu) cpuMax, AVG(mem_pct) mem, MAX(mem_pct) memMax FROM hardware_statistics WHERE t>=?').get(Date.now() - hours * 3600e3);
  return x.n ? x : null;
}
function addHealth(report) { if (db) db.prepare('INSERT INTO system_health(t,score,report) VALUES(?,?,?)').run(report.at, report.score, JSON.stringify(report)); }
function lastHealth() { if (!db) return null; const r = db.prepare('SELECT report FROM system_health ORDER BY id DESC LIMIT 1').get(); try { return r ? JSON.parse(r.report) : null; } catch (_) { return null; } }
function addWarning(level, title, detail) { if (db) db.prepare('INSERT INTO warning_records(t,level,title,detail) VALUES(?,?,?,?)').run(Date.now(), level, title, detail || ''); }
function warnings(limit = 50) { return db ? db.prepare('SELECT t,level,title,detail FROM warning_records ORDER BY id DESC LIMIT ?').all(limit) : []; }
function saveAdapters(list) {
  if (!db) return;
  const up = db.prepare('INSERT INTO adapter_information(name,type,speed,ip4,is_virtual,is_up,last_seen) VALUES(?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET type=excluded.type,speed=excluded.speed,ip4=excluded.ip4,is_virtual=excluded.is_virtual,is_up=excluded.is_up,last_seen=excluded.last_seen');
  tx(() => { for (const a of list) up.run(a.name, a.type, a.speed, a.ip4, a.virtual ? 1 : 0, a.up ? 1 : 0, Date.now()); });
}

/* 保留期限 / 清空 / 备份 */
function prune(days) {
  if (!db) return;
  const t = Date.now() - days * 864e5;
  for (const tb of ['connection_records', 'hardware_statistics', 'system_health', 'warning_records']) db.prepare(`DELETE FROM ${tb} WHERE t<?`).run(t);
  db.prepare('DELETE FROM proc_traffic WHERE last_seen<?').run(t);
  db.prepare('DELETE FROM network_statistics WHERE day<?').run(day(Date.now() - 400 * 864e5));
}
function clearConnections() { if (db) db.exec('DELETE FROM connection_records'); }
function clearAll() {
  if (!db) return;
  pend = { day: '', rx: 0, tx: 0, peak: 0 };
  for (const tb of ['connection_records', 'hardware_statistics', 'system_health', 'warning_records', 'network_statistics', 'adapter_information', 'proc_traffic']) db.exec(`DELETE FROM ${tb}`);
  try { db.exec('VACUUM'); } catch (_) {}
}
function backup(file) {
  if (!db) throw new Error('数据库不可用');
  flush(); try { fs.unlinkSync(file); } catch (_) {}
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}
function close() { flush(); try { db && db.close(); } catch (_) {} db = null; }
module.exports = { init, status, loadSettings, saveSettings, addTraffic, flush, today, month, stats, addConnections, connections, toCsv, addProcTraffic, procTrafficTop, clearProcTraffic, addHardware, hardwareSummary, addHealth, lastHealth, addWarning, warnings, saveAdapters, prune, clearConnections, clearAll, backup, close };
