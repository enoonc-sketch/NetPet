import assert from 'node:assert'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import * as db from '../src/main/db'; import { PetStateMachine } from '../src/main/petstate';
import { clampPetBounds, defaultPetBounds } from '../src/main/petgeom';
import { isFullscreenState } from '../src/main/fullscreen';
import * as cleaner from '../src/main/cleaner';
// ---- 状态机 ----
let m = new PetStateMachine(), t = 0; const base = { rx: 0, tx: 0, cpu: 10, memPct: 40, temp: null, memAlert: 90, warning: false };
const step = (n, o) => { let s; for (let k = 0; k < n; k++) { t += 1000; s = m.update(t, { ...base, ...o }); } return s; };
assert.equal(step(30, {}), 'IDLE'); assert.equal(step(35, {}), 'SLEEP', '空闲 60s 后睡觉');
assert.equal(step(1, { rx: 5e6 }), 'SLEEP', '短暂活动不唤醒'); assert.equal(step(4, { rx: 5e6 }), 'DOWNLOAD');
assert.equal(step(2, { rx: 0 }), 'DOWNLOAD', '短暂回落不抖动'); step(10, { rx: 0, tx: 0 }); assert.notEqual(m.current, 'DOWNLOAD');
m = new PetStateMachine(); t = 0;
step(12, { memPct: 95 }); assert.equal(m.current, 'SWEAT'); step(4, { memPct: 95, cpu: 95 }); step(31, { memPct: 95, cpu: 95 }); assert.equal(m.current, 'SWEAT', '优先级：SWEAT > TIRED');
assert.equal(step(1, { warning: true }), 'WARNING', 'WARNING 立即生效');
m.setMuted(['WARNING']); assert.notEqual(step(1, { warning: true }), 'WARNING', '用户可关闭提醒');
m = new PetStateMachine(); t = 0; assert.equal(step(70, { rx: null, tx: null, cpu: null, memPct: null }), 'IDLE', '监控关闭时不推断');
// 抖动测试：速度在阈值附近来回，状态切换次数应很少
m = new PetStateMachine(); t = 0; let sw = 0, prev = m.current;
for (let k = 0; k < 600; k++) { t += 1000; const s = m.update(t, { ...base, rx: k % 2 ? 150e3 : 260e3, tx: 0 }); if (s !== prev) { sw++; prev = s; } }
assert(sw <= 2, '抖动切换次数=' + sw);
console.log('petstate ok, flaps', sw);
// ---- 数据库 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-')); let st = db.init(dir); assert(st.ok, JSON.stringify(st));
db.saveSettings({ pet: 'fox', privacy: { net: true } }); assert.equal((db.loadSettings() as any).pet, 'fox');
db.addTraffic(2e6, 1e5); db.addTraffic(3e6, 2e5); db.flush(); db.addTraffic(1e6, 0);
assert.equal(db.today().rx, 6e6); assert.equal(db.month().tx, 3e5); assert.equal(db.stats().peakRx, 3e6);
db.addConnections([{ t: Date.now(), proc: 'chrome.exe', pid: 1, ip: '1.2.3.4', port: 443, host: 'a.example', proto: 'tcp4', note: '' }, { t: Date.now(), proc: 'x_y%.exe', pid: 2, ip: '5.6.7.8', port: 4444, host: '', proto: 'tcp4', note: '常见挖矿端口' }]);
assert.equal(db.connections(1, '').total, 2); assert.equal(db.connections(1, 'x_y%').total, 1, 'LIKE 转义'); assert.equal(db.connections(1, "a.example").rows.length, 1);
assert(db.toCsv(db.connections(1, '').rows).includes('chrome.exe'));
db.addHardware(Date.now(), 20, 50, null); assert(db.hardwareSummary(24).n === 1);
db.addWarning('warn', 't', 'd'); assert.equal(db.warnings().length, 1);
db.prune(30); const bak = path.join(dir, 'b.db'); db.backup(bak); assert(fs.statSync(bak).size > 0);
db.clearAll(); assert.equal(db.connections(1, '').total, 0); assert.equal(db.stats().total, 0);
db.close();
// 损坏恢复
fs.writeFileSync(path.join(dir, 'netpet.db'), 'this is not a database'); st = db.init(dir);
assert(st.ok && st.recovered, '损坏后应自动恢复: ' + JSON.stringify(st)); assert(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')), '旧库应被保留为 .corrupt');
db.close(); console.log('db ok (含 备份/清空/损坏恢复)');
// ---- 宠物位置钳制（防消失）----
const WA = { x: 0, y: 0, width: 1920, height: 1080 };
assert.deepEqual(defaultPetBounds(WA, 170, 190), { x: 1730, y: 870, width: 170, height: 190 });
assert.deepEqual(clampPetBounds({ x: 100, y: 100 }, 170, 190, [{ workArea: WA }]), { x: 100, y: 100, width: 170, height: 190 }, '屏内不动');
assert.deepEqual(clampPetBounds({ x: 5000, y: 3000 }, 170, 190, [{ workArea: WA }]), { x: 1730, y: 870, width: 170, height: 190 }, '屏外拉回右下角');
assert.deepEqual(clampPetBounds(null, 170, 190, [{ workArea: WA }]), { x: 1730, y: 870, width: 170, height: 190 }, '无保存位置回默认');
assert.deepEqual(clampPetBounds({ x: 1870, y: 100 }, 170, 190, [{ workArea: WA }]), { x: 1870, y: 100, width: 170, height: 190 }, '露 50px 时留在原地');
assert.deepEqual(clampPetBounds({ x: 1900, y: 100 }, 170, 190, [{ workArea: WA }]), { x: 1730, y: 870, width: 170, height: 190 }, '只露 20px（不足 40px）时回默认位置');
assert.equal(clampPetBounds({ x: 2000, y: 100 }, 170, 190, [{ workArea: WA }, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }]).x, 2000, '副屏上的位置不拉回主屏');
console.log('petgeom ok');
// ---- 全屏状态取值（微软 QUERY_USER_NOTIFICATION_STATE，1 起编号）----
assert.equal(isFullscreenState(2), true, 'BUSY=全屏/演示'); assert.equal(isFullscreenState(3), true, 'D3D 全屏'); assert.equal(isFullscreenState(4), true, '演示模式');
assert.equal(isFullscreenState(5), false, 'ACCEPTS_NOTIFICATIONS=正常桌面，绝不能隐藏'); assert.equal(isFullscreenState(1), false); assert.equal(isFullscreenState(6), false); assert.equal(isFullscreenState(0), false);
console.log('fullscreen ok');
// ---- 系统垃圾清理（白名单 + 安全根 + 符号链接不跟随）----
// 注：单元测试以 CJS 打包，顶层 await 不可用，所以清理测试包在 async 函数里。
async function testCleaner() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'np-clean-'));
  const mk = (rel: string, size: number, mtime?: number) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size)); if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime)); return p; };
  const tmpRoot = path.join(base, 'a', 'b', 'Temp'); const cacheRoot = path.join(base, 'a', 'b', 'Cache'); const logsRoot = path.join(base, 'a', 'b', 'Logs');
  mk('a/b/Temp/junk.tmp', 1000); mk('a/b/Temp/sub/old.log', 2000); mk('a/b/Cache/c1.dat', 3000);
  const outside = mk('outside.txt', 4000);
  try { fs.symlinkSync(outside, path.join(tmpRoot, 'link.txt')); } catch (_) {}
  mk('a/b/Logs/old.log', 500, Date.now() - 40 * 864e5); mk('a/b/Logs/new.log', 600, Date.now());
  const o = { rootsOverride: { 'user-temp': [tmpRoot], 'browser-cache': [cacheRoot], 'netpet-logs': [logsRoot], 'win-temp': [tmpRoot], 'crash-logs': [tmpRoot] } as any, netpetLogsDir: logsRoot };
  const scans = await cleaner.scanJunk(o);
  const byId = Object.fromEntries(scans.map((s) => [s.id, s]));
  assert.equal(byId['user-temp'].files, 2, '符号链接不计入'); assert.equal(byId['user-temp'].size, 3000);
  assert.equal(byId['browser-cache'].size, 3000);
  assert.equal(byId['netpet-logs'].files, 1, 'NetPet 日志只算 30 天前的');
  const cleaned = await cleaner.cleanJunk(['user-temp', 'netpet-logs', 'recycle-bin'], o);
  const cById = Object.fromEntries(cleaned.map((c) => [c.id, c]));
  assert.equal(cById['user-temp'].deletedFiles, 2); assert.equal(cById['user-temp'].freed, 3000);
  assert(fs.existsSync(tmpRoot), '清理后根目录本身必须保留');
  assert(fs.existsSync(outside), '符号链接目标绝不能被删');
  assert(!fs.existsSync(path.join(logsRoot, 'old.log')), '30 天前的旧日志应删'); assert(fs.existsSync(path.join(logsRoot, 'new.log')), '新日志应保留');
  assert.equal(cById['recycle-bin'].ok, false, '非 Windows 上回收站清理应明确拒绝而不是假装成功');
  const shallow = await cleaner.cleanJunk(['user-temp'], { rootsOverride: { 'user-temp': ['/tmp'] } as any });
  assert.equal(shallow[0].ok, false, '太浅的根目录（如 /tmp）必须拒绝');
  assert.equal((await cleaner.cleanJunk(['not-a-category'], o)).length, 0, '未知类别直接忽略');
  console.log('cleaner ok');
}
testCleaner().then(() => console.log('all 1.3.2 tests ok')).catch((e) => { console.error(e); process.exit(1); });
