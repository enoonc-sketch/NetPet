const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const db = require(require('path').join(__dirname,'..','db.js')); const { PetStateMachine } = require(require('path').join(__dirname,'..','petstate.js'));
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
db.saveSettings({ pet: 'fox', privacy: { net: true } }); assert.equal(db.loadSettings().pet, 'fox');
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

// ---- 按程序流量（ETW 包装层，纯 JS 聚合，可在 Linux 沙箱测）----
const procnet = require(require('path').join(__dirname,'..','procnet.js'));
assert.equal(procnet.isAvailable(), false, '沙箱里没有 Windows 原生组件，应报不可用而不是编数据');
assert.equal(procnet.loadReason(), 'windows-only');
let pPrev = new Map(); pPrev._t = 1000;
let r1 = procnet.aggregate([{ pid: 100, name: 'chrome.exe', rx: 100000, tx: 20000, udpRx: 0, udpTx: 0 }], pPrev, 1000);
assert.equal(r1.rows[0].name, 'chrome.exe'); assert.equal(r1.rows[0].rx, 100000);
let r2 = procnet.aggregate([{ pid: 100, name: 'chrome.exe', rx: 300000, tx: 60000, udpRx: 0, udpTx: 0 }], r1.next, 3000);
assert.equal(Math.round(r2.rows[0].rxRate), 100000, '2 秒内 +200000 字节，速率应为 100000 B/s');
assert.equal(r2.deltas[0].rx, 200000);
// PID 复用：累计值变小，增量按当前值全算，不算负数
let r3 = procnet.aggregate([{ pid: 100, name: 'chrome.exe', rx: 5000, tx: 1000, udpRx: 0, udpTx: 0 }], r2.next, 5000);
assert.equal(r3.deltas[0].rx, 5000);
// 同名多进程聚合
let r4 = procnet.aggregate([
  { pid: 101, name: 'chrome.exe', rx: 1000, tx: 0, udpRx: 0, udpTx: 0 },
  { pid: 102, name: 'chrome.exe', rx: 2000, tx: 0, udpRx: 0, udpTx: 0 },
  { pid: 103, name: 'code.exe', rx: 500, tx: 0, udpRx: 0, udpTx: 0 }], new Map(), 1000);
assert.equal(r4.rows[0].name, 'chrome.exe'); assert.equal(r4.rows[0].rx, 3000);
console.log('procnet aggregate ok (ETW 原生部分仅 Windows 可测)');
// ---- 按程序流量落库 ----
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pt-')); st = db.init(dir2); assert(st.ok, JSON.stringify(st));
db.addProcTraffic([{ proc: 'chrome.exe', rx: 1000, tx: 500 }, { proc: 'code.exe', rx: 2000, tx: 0 }]);
db.addProcTraffic([{ proc: 'chrome.exe', rx: 3000, tx: 500 }]);
let top = db.procTrafficTop(10);
assert.equal(top[0].proc, 'chrome.exe'); assert.equal(top[0].rx, 4000); assert.equal(top[0].tx, 1000);
db.clearProcTraffic(); assert.equal(db.procTrafficTop(10).length, 0);
db.close();
console.log('proc_traffic db ok');
