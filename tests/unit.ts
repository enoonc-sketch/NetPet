import assert from 'node:assert'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import * as db from '../src/main/db'; import { PetStateMachine } from '../src/main/petstate';
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
