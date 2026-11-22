import assert from 'node:assert'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import * as db from '../src/main/db'; import { PetStateMachine } from '../src/main/petstate';
import { clampPetBounds, defaultPetBounds } from '../src/main/petgeom';
import { isFullscreenState } from '../src/main/fullscreen';
import * as cleaner from '../src/main/cleaner';
import { isLoopListen } from '../src/main/security';
import { hasUsableAddress, RateBudget, sampleSeconds } from '../src/main/guards';
import { judge, ProbeState } from '../src/main/probe';
import * as startup from '../src/main/startup';
import * as vpn from '../src/main/vpn';
import * as winupdate from '../src/main/winupdate';
import * as secure from '../src/main/secure';
import * as memtrim from '../src/main/memtrim';
import { quotaStep, NewProcWatcher, Reminder, batteryWear } from '../src/main/extras';
import * as selfupdate from '../src/main/selfupdate';
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
// CSV 公式注入
const csv = db.toCsv([{ t: 0, proc: '=cmd|calc', pid: 1, ip: '+1.2.3.4', port: 1, host: '@evil', proto: '-x', note: 'ok=1' }]);
for (const bad of ['"=cmd', '"+1.2', '"@evil', '"-x']) assert(!csv.includes(bad), 'CSV 未转义：' + bad);
assert(csv.includes(`"'=cmd|calc"`) && csv.includes('"ok=1"'), '公式前缀加 \' ，普通内容不动');
db.close(); console.log('db ok (含 备份/清空/损坏恢复/CSV 防注入)');
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
// ---- 监听端口过滤：0.0.0.0 / :: 是对外开放，不能当回环 ----
assert.equal(isLoopListen('0.0.0.0'), false, '0.0.0.0 = 所有网卡，必须检查');
assert.equal(isLoopListen('::'), false, ':: = 所有网卡，必须检查');
assert.equal(isLoopListen('192.168.1.5'), false);
assert.equal(isLoopListen('127.0.0.1'), true); assert.equal(isLoopListen('::1'), true);
console.log('ports ok');
// ---- 在线判断（支持纯 IPv6）----
const A = (address: string, family: any = 'IPv4', internal = false) => ({ address, family, internal });
assert.equal(hasUsableAddress({ eth: [A('192.168.1.2')] }), true);
assert.equal(hasUsableAddress({ eth: [A('169.254.3.4'), A('fe80::1', 'IPv6')] }), false, '只有自动/链路本地地址 = 断网');
assert.equal(hasUsableAddress({ eth: [A('169.254.3.4'), A('2408:8000::1', 'IPv6')] }), true, '纯 IPv6 网络算在线');
assert.equal(hasUsableAddress({ lo: [A('127.0.0.1', 'IPv4', true), A('::1', 'IPv6', true)] }), false, '回环不算');
assert.equal(hasUsableAddress({ eth: [A('10.0.0.2', 4)] }), true, 'Node 18 的数字 family 也兼容');
assert.equal(hasUsableAddress({}), false);
console.log('online ok');
// ---- 宠物重建次数：5 分钟窗口内最多 3 次 ----
const rb = new RateBudget(3, 5 * 60e3); let n0 = 0;
for (let k = 0; k < 10; k++) { const now = k * 1500; if (rb.left(now)) { rb.use(now); n0++; } }
assert.equal(n0, 3, '连续崩溃最多重建 3 次（不会因为 pet-ready 清零而无限重建）');
assert.equal(rb.left(5 * 60e3 + 1), true, '5 分钟后额度恢复');
console.log('recreate budget ok');
// ---- 流量按真实间隔累计 ----
assert.equal(sampleSeconds(1000, 0), 1, '首次按 1 秒');
assert.equal(sampleSeconds(3500, 1000), 2.5, '间隔 2.5 秒就按 2.5 秒算（旧版固定 1 秒导致偏少）');
assert.equal(sampleSeconds(60000, 1000), 5, '休眠唤醒等大间隔最多按 5 秒');
assert.equal(sampleSeconds(500, 1000), 0, '时钟回拨不产生负流量');
console.log('traffic interval ok');
// ---- 真实联网检测 ----
assert.equal(judge(200, 'Microsoft Connect Test'), 'ok'); assert.equal(judge(200, 'Microsoft Connect Test\r\n'), 'ok', '允许结尾换行');
assert.equal(judge(200, '<html>登录</html>'), 'portal', '内容被替换 = 网页登录'); assert.equal(judge(302, ''), 'portal', '被重定向 = 网页登录');
assert.equal(judge(null, ''), 'fail', '连不上 = 上不了网');
const pst = new ProbeState();
assert.equal(pst.push('ok'), true, '首次直接给结论'); assert.equal(pst.value, 'ok');
assert.equal(pst.push('fail'), false, '单次失败不翻转'); assert.equal(pst.push('ok'), false); assert.equal(pst.value, 'ok', '偶发失败被防抖');
pst.push('fail'); assert.equal(pst.push('fail'), true, '连续 2 次失败才翻转'); assert.equal(pst.value, 'fail');
pst.reset(); assert.equal(pst.value, null);
console.log('probe ok');
// ---- 启动管理 ----
assert.equal(startup.parseApproved(null), true, '没有标记 = 启用');
assert.equal(startup.parseApproved([2, 0, 0, 0]), true); assert.equal(startup.parseApproved([6, 0]), true);
assert.equal(startup.parseApproved([3, 0, 0, 0, 1, 2]), false, '0x03 = 禁用'); assert.equal(startup.parseApproved([7]), false);
assert.deepEqual(startup.buildApproved(true), [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const dis = startup.buildApproved(false, 0); assert.equal(dis.length, 12); assert.equal(dis[0], 3);
let ft = 0n; for (let i = 11; i >= 4; i--) ft = (ft << 8n) | BigInt(dis[i]);
assert.equal(ft, 116444736000000000n, '禁用标记带 FILETIME（1970-01-01 = 116444736000000000）');
assert.equal(startup.parseApproved(startup.buildApproved(false)), false, '写入后读回是禁用');
assert.equal(startup.extractExe('"C:\\Program Files\\App\\app.exe" --min'), 'C:\\Program Files\\App\\app.exe');
assert.equal(startup.extractExe('C:\\Tools\\my app.exe /silent'), 'C:\\Tools\\my app.exe', '无引号但路径含空格');
assert.equal(startup.extractExe('rundll32 shell32.dll,Foo'), 'rundll32');
assert.equal(startup.extractExe(''), '');
const its = startup.toItems([
  { src: 'hklm-run', name: 'Zed', cmd: 'C:\\z.exe', ap: null },
  { src: 'hkcu-run', name: 'Bad', cmd: 'wscript C:\\Users\\Public\\x.vbs', ap: Buffer.from([3, 0, 0, 0]).toString('base64') },
  { src: 'evil-src', name: 'X', cmd: 'x', ap: null }, { src: 'hkcu-run', name: '', cmd: 'x' }
]);
assert.equal(its.length, 2, '未知来源 / 空名称被丢弃');
assert.equal(its[0].name, 'Bad', '当前用户的排在前面'); assert.equal(its[0].enabled, false); assert.equal(its[0].flagged, true); assert.equal(its[0].canToggle, true);
assert.equal(its[1].canToggle, false, '所有用户的启动项不允许修改'); assert.equal(its[1].id, 'hklm-run|Zed');
console.log('startup ok');
// ---- sing-box VPN ----
assert.equal(vpn.isSingBoxExe('C:\\tools\\sing-box.exe'.replace(/\\/g, '/')), true);
assert.equal(vpn.isSingBoxExe('/x/sing-box-1.10.exe'), true);
assert.equal(vpn.isSingBoxExe('/x/calc.exe'), false, '不是 sing-box 的程序拒绝');
assert.deepEqual(vpn.findProxyInbound({ inbounds: [{ type: 'tun' }, { type: 'http', listen: '127.0.0.1', listen_port: 8080 }, { type: 'mixed', listen: '127.0.0.1', listen_port: 2080 }] }), { port: 2080, type: 'mixed' }, 'mixed 优先');
assert.deepEqual(vpn.findProxyInbound({ inbounds: [{ type: 'http', listen_port: 8080 }] }), { port: 8080, type: 'http' }, '未写 listen 默认本机');
assert.equal(vpn.findProxyInbound({ inbounds: [{ type: 'mixed', listen: '192.168.1.2', listen_port: 2080 }] }), null, '只接受本机监听');
assert.equal(vpn.findProxyInbound({ inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: 70000 }] }), null, '端口非法');
assert.equal(vpn.findProxyInbound({}), null);
assert.equal(vpn.hasTun({ inbounds: [{ type: 'tun' }] }), true); assert.equal(vpn.hasTun({ inbounds: [] }), false);
const rg = new vpn.Ring(3); rg.push('a\nb\n\nc'); rg.push('d'); assert.deepEqual(rg.all(), ['b', 'c', 'd'], '日志只留最近 N 行');
assert(vpn.BYPASS.includes('<local>') && vpn.BYPASS.includes('192.168.*'), '局域网不走代理');
console.log('vpn ok');
// ---- 系统更新检测 ----
const ui = winupdate.parseItems([
  { t: 'Intel 驱动', kb: '', s: '', z: 0, r: false, c: 'Drivers' },
  { t: '2026-11 累积更新', kb: '5050001', s: 'Critical', z: 600 * 1048576, r: true, c: 'Security Updates' },
  { t: '病毒库', kb: 'KB2267602', s: '', z: 0, r: false, c: 'Definition Updates' }, { t: '' }, null
]);
assert.equal(ui.length, 3, '空标题/空项丢弃');
assert.equal(ui[0].category, '安全更新', '安全更新排在前面'); assert.equal(ui[0].kb, 'KB5050001'); assert.equal(ui[0].sizeMB, 600); assert.equal(ui[0].reboot, true);
assert.equal(ui.find((x) => x.title === '病毒库')!.kb, 'KB2267602', 'KB 前缀不重复');
assert.equal(ui.find((x) => x.title === 'Intel 驱动')!.category, '驱动');
assert.equal(winupdate.parseItems({ t: '单个', c: '' }).length, 1, 'PowerShell 单项不是数组也能解析');
assert.equal(winupdate.parseItems(null).length, 0);
assert.equal(winupdate.verdict({ items: ui, pendingReboot: false, lastPatch: null }), 'bad', '有 Critical = 异常');
assert.equal(winupdate.verdict({ items: [], pendingReboot: true, lastPatch: null }), 'warn', '待重启 = 注意');
assert.equal(winupdate.verdict({ items: [], pendingReboot: false, lastPatch: { kb: '', date: '', days: 90 } }), 'warn', '90 天没补丁 = 注意');
assert.equal(winupdate.verdict({ items: [], pendingReboot: false, lastPatch: { kb: '', date: '', days: 3 } }), 'ok');
console.log('winupdate ok');
// ---- 敏感设置加密（用假 Cipher 模拟 safeStorage）----
const fake = (on = true): secure.Cipher => ({ available: () => on, encrypt: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)), decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString() });
const lock = { salt: 'ab', hash: 'cd' };
const sealed = secure.seal('lock', lock, fake());
assert(secure.isEnc(sealed) && !JSON.stringify(sealed).includes('cd'), '敏感键写入为密文');
assert.deepEqual(secure.unseal('lock', sealed, fake()), { value: lock, failed: false, plain: false }, '能解回原值');
assert.equal(secure.seal('pet', 'fox', fake()), 'fox', '非敏感键不加密');
assert.equal(secure.seal('lock', null, fake()), null, '空值不加密');
assert.deepEqual(secure.seal('vpn', { exe: 'x' }, fake(false)), { exe: 'x' }, '加密不可用时退回明文');
assert.equal(secure.unseal('vpn', { exe: 'x' }, fake()).plain, true, '旧版明文被识别出来，用于迁移');
const other: secure.Cipher = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: () => { throw new Error('bad'); } };
assert.deepEqual(secure.unseal('lock', sealed, other), { value: null, failed: true, plain: false }, '换了电脑/账户解不开 → 重置，不崩溃');
assert.equal(secure.unseal('lock', sealed, fake(false)).failed, true);
// 与数据库联动：密文能存进 settings 表并原样读回
const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'np-enc-')); db.init(d2);
db.saveSettings({ lock: sealed }); assert.deepEqual(secure.unseal('lock', (db.loadSettings() as any).lock, fake()).value, lock); db.close();
console.log('secure ok');
// ---- 运行内存整理 ----
const at = new memtrim.AutoTrigger(60e3, 10 * 60e3); let fired = 0;
for (let s = 0; s < 59; s++) if (at.update(s * 1000, 95, 90)) fired++;
assert.equal(fired, 0, '超阈值不足 60 秒不触发');
assert.equal(at.update(60e3, 95, 90), true, '持续 60 秒触发');
for (let s = 61; s < 600; s++) if (at.update(s * 1000, 95, 90)) fired++;
assert.equal(fired, 0, '10 分钟冷却内不再触发');
assert.equal(at.update(60e3 + 600e3, 95, 90), true, '冷却后仍超阈值再次触发');
const at2 = new memtrim.AutoTrigger(60e3, 0); at2.update(0, 95, 90); at2.update(30e3, 70, 90);
assert.equal(at2.update(61e3, 95, 90), false, '中途回落会重新计时（不因短暂峰值触发）');
assert.equal(at2.update(0, null, 90), false, '没有数据不触发');
assert.equal(memtrim.shouldSkip('csrss.exe', 600, []), true, '系统关键进程跳过'); assert.equal(memtrim.shouldSkip('svchost', 900, []), true);
assert.equal(memtrim.shouldSkip('chrome.exe', 1234, []), false); assert.equal(memtrim.shouldSkip('chrome.exe', 1234, [1234]), true, 'NetPet 自身进程跳过');
assert.equal(memtrim.shouldSkip('x', 4, []), true, 'PID ≤ 4 跳过');
console.log('memtrim ok');
// ---- 流量额度 ----
const G = 1073741824;
assert.equal(quotaStep(5 * G, 0, 0), 0, '额度 0 = 不提醒');
assert.equal(quotaStep(7 * G, 10, 0), 0); assert.equal(quotaStep(8 * G, 10, 0), 80, '80% 提醒');
assert.equal(quotaStep(9 * G, 10, 80), 0, '同一档只提醒一次'); assert.equal(quotaStep(10 * G, 10, 80), 100, '100% 再提醒');
assert.equal(quotaStep(12 * G, 10, 0), 100, '一下子超额直接提醒 100%'); assert.equal(quotaStep(20 * G, 10, 100), 0);
console.log('quota ok');
// ---- 新程序首次联网 ----
const w = new NewProcWatcher([], 1000);
assert.deepEqual(w.see(500, ['chrome.exe', 'QQ.exe']), [], '学习期内不提醒');
assert.deepEqual(w.see(2000, ['Chrome.EXE', 'new.exe', 'new.exe', 'PID 123']), ['new.exe'], '学习期后只提醒真正的新程序（不分大小写、去重、忽略 PID）');
assert.deepEqual(w.see(3000, ['new.exe']), [], '提醒过的不再提醒');
const w2 = new NewProcWatcher(w.list(), 0); assert.deepEqual(w2.see(0, ['qq.exe', 'x.exe']), ['x.exe'], '已知列表可持久化恢复');
const w3 = new NewProcWatcher([], 0, 3); w3.see(0, ['a', 'b', 'c', 'd']); assert.equal(w3.list().length, 3, '列表有上限');
console.log('newproc ok');
// ---- 久坐 / 喝水提醒 ----
const rm = new Reminder(60, 30); let got: string[] = [];
for (let s = 0; s <= 3600; s += 30) got.push(...rm.tick(s * 1000, 0, false));
assert.deepEqual(got, ['water', 'sit', 'water'], '60 分钟内：喝水 2 次、久坐 1 次');
const rm2 = new Reminder(60, 0); got = [];
for (let s = 0; s <= 3600; s += 30) got.push(...rm2.tick(s * 1000, s === 1800 ? 400 : 0, false));
assert.deepEqual(got, [], '中途离开 5 分钟以上，久坐计时清零');
const rm3 = new Reminder(30, 0); got = [];
for (let s = 0; s <= 1800; s += 30) got.push(...rm3.tick(s * 1000, 0, true));
assert.deepEqual(got, [], '勿扰/全屏时不提醒'); assert.deepEqual(rm3.tick(1830e3, 0, false), [], '静音期间到点的提醒不补发');
const rm4 = new Reminder(30, 0); rm4.tick(0, 0, false); assert.deepEqual(rm4.tick(10 * 3600e3, 0, false), [], '休眠唤醒的大间隔最多算 2 分钟');
console.log('reminder ok');
// ---- 电池损耗 ----
assert.equal(batteryWear(50000, 40000), 20); assert.equal(batteryWear(50000, 50000), 0);
assert.equal(batteryWear(50000, 52000), 0, '略高于设计容量按 0%'); assert.equal(batteryWear(50000, 90000), null, '数据明显异常不下结论');
assert.equal(batteryWear(0, 40000), null); assert.equal(batteryWear(50000, 0), null);
console.log('battery ok');
// ---- 检查新版本 ----
const cv = selfupdate.cmpVer;
assert.equal(cv('v1.3.4', '1.3.3'), 1); assert.equal(cv('1.3.3', '1.3.3'), 0); assert.equal(cv('1.3.10', '1.3.9'), 1, '按数字比较不是按字符串');
assert.equal(cv('1.4', '1.3.9'), 1, '缺第三位按 0'); assert.equal(cv('1.3.3', '1.3.3-beta.1'), 1, '正式版高于同号预发布');
assert.equal(cv('2.0.0-beta.2', '2.0.0-beta.1'), 1); assert.equal(cv('garbage', '1.0.0'), 0, '无法解析不判定为新版本');
assert.equal(selfupdate.safeReleaseUrl('https://github.com/enoonc-sketch/NetPet/releases/tag/v1.3.4'), 'https://github.com/enoonc-sketch/NetPet/releases/tag/v1.3.4');
assert.equal(selfupdate.safeReleaseUrl('https://evil.example/x'), selfupdate.RELEASES, '别的网站一律换成本仓库发布页');
assert.equal(selfupdate.safeReleaseUrl('https://github.com/someone/else/releases'), selfupdate.RELEASES, '别的仓库也不行');
assert.equal(selfupdate.safeReleaseUrl('http://github.com/enoonc-sketch/NetPet/releases'), selfupdate.RELEASES, '必须 https');
assert.equal(selfupdate.safeReleaseUrl('javascript:alert(1)'), selfupdate.RELEASES);
const i1 = selfupdate.interpret('1.3.3', 200, { tag_name: 'v1.3.4', html_url: 'https://github.com/enoonc-sketch/NetPet/releases/tag/v1.3.4', body: '修复', published_at: '2026-12-01T00:00:00Z' });
assert.equal(i1.ok && i1.newer, true); assert.equal(i1.latest, '1.3.4'); assert.equal(i1.published, '2026-12-01');
assert.equal(selfupdate.interpret('1.3.3', 200, { tag_name: 'v1.3.3' }).newer, false, '同版本 = 已是最新');
assert.equal(selfupdate.interpret('1.3.3', 200, { tag_name: 'v9.9.9', prerelease: true }).newer, false, '预发布版不提示');
assert.equal(selfupdate.interpret('1.3.3', 404, null).ok, false); assert.match(selfupdate.interpret('1.3.3', 403, {}).error!, /限制/);
assert.equal(selfupdate.interpret('1.3.3', 200, { tag_name: 'latest' }).ok, false, '无法识别的标签不误报');
console.log('selfupdate ok');
// ---- 系统垃圾清理（白名单 + 安全根 + 符号链接不跟随）----
// 注：单元测试以 CJS 打包，顶层 await 不可用，所以清理测试包在 async 函数里。
async function testCleaner() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'np-clean-'));
  const mk = (rel: string, size: number, mtime?: number) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size)); if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime)); return p; };
  const tmpRoot = path.join(base, 'a', 'b', 'Temp'); const cacheRoot = path.join(base, 'a', 'b', 'Cache'); const logsRoot = path.join(base, 'a', 'b', 'Logs');
  const OLD = Date.now() - 3 * 864e5;
  mk('a/b/Temp/junk.tmp', 1000, OLD); mk('a/b/Temp/sub/old.log', 2000, OLD);
  mk('a/b/Temp/fresh.tmp', 7000); // fresh：刚生成的临时文件
  mk('a/b/Cache/c1.dat', 3000);
  const outside = mk('outside.txt', 4000);
  try { fs.symlinkSync(outside, path.join(tmpRoot, 'link.txt')); } catch (_) {}
  mk('a/b/Logs/old.log', 500, Date.now() - 40 * 864e5); mk('a/b/Logs/new.log', 600, Date.now());
  const o = { rootsOverride: { 'user-temp': [tmpRoot], 'browser-cache': [cacheRoot], 'netpet-logs': [logsRoot], 'win-temp': [tmpRoot], 'crash-logs': [tmpRoot] } as any, netpetLogsDir: logsRoot };
  const scans = await cleaner.scanJunk(o);
  const byId = Object.fromEntries(scans.map((s) => [s.id, s]));
  assert.equal(byId['user-temp'].files, 2, '符号链接和 24 小时内的新文件都不计入'); assert.equal(byId['user-temp'].size, 3000);
  assert.equal(byId['browser-cache'].size, 3000);
  assert.equal(byId['netpet-logs'].files, 1, 'NetPet 日志只算 30 天前的');
  const cleaned = await cleaner.cleanJunk(['user-temp', 'netpet-logs', 'recycle-bin'], o);
  const cById = Object.fromEntries(cleaned.map((c) => [c.id, c]));
  assert.equal(cById['user-temp'].deletedFiles, 2); assert.equal(cById['user-temp'].freed, 3000);
  assert(fs.existsSync(tmpRoot), '清理后根目录本身必须保留');
  assert(fs.existsSync(path.join(tmpRoot, 'fresh.tmp')), '24 小时内的临时文件必须保留');
  assert(fs.existsSync(outside), '符号链接目标绝不能被删');
  assert(!fs.existsSync(path.join(logsRoot, 'old.log')), '30 天前的旧日志应删'); assert(fs.existsSync(path.join(logsRoot, 'new.log')), '新日志应保留');
  assert.equal(cById['recycle-bin'].ok, false, '非 Windows 上回收站清理应明确拒绝而不是假装成功');
  const shallow = await cleaner.cleanJunk(['user-temp'], { rootsOverride: { 'user-temp': ['/tmp'] } as any });
  assert.equal(shallow[0].ok, false, '太浅的根目录（如 /tmp）必须拒绝');
  assert.equal((await cleaner.cleanJunk(['not-a-category'], o)).length, 0, '未知类别直接忽略');
  // 新增：根目录去重 + 安全根
  mk('a/b/Temp/again.tmp', 100, OLD);
  const dup = await cleaner.scanJunk({ rootsOverride: { 'user-temp': [tmpRoot, tmpRoot + path.sep] } as any });
  assert.equal(dup.find((s) => s.id === 'user-temp')!.size, 100, '同一目录写两次也只算一遍大小（旧版 %TEMP% 重复计数）');
  assert.equal(cleaner.uniqRoots([tmpRoot, tmpRoot + path.sep, '', tmpRoot]).length, 1, '同一目录只算一次');
  if (process.platform === 'win32') assert.equal(cleaner.uniqRoots(['C:\\A\\B\\Temp', 'c:\\a\\b\\temp']).length, 1, 'Windows 下大小写不敏感');
  assert.equal(cleaner.isSafeRoot('Temp'), false, '相对路径（环境变量为空拼出来的）必须拒绝');
  assert.equal(cleaner.isSafeRoot(''), false);
  assert.equal(cleaner.isSafeRoot(path.resolve('/')), false, '盘符根/系统根必须拒绝');
  if (process.platform === 'win32') {
    assert.equal(cleaner.isSafeRoot('C:\\Users\\someone'), false, '任意用户主目录必须拒绝');
    assert.equal(cleaner.isSafeRoot('C:\\Users\\someone\\AppData'), true);
  } else assert.equal(cleaner.isSafeRoot('/Users/someone'), false, '任意用户主目录必须拒绝');
  assert.equal(cleaner.isSafeRoot(tmpRoot), true);
  // 白名单里不再包含 Windows\Logs
  assert(!cleaner.CATEGORIES.find((c) => c.id === 'crash-logs')!.desc.includes('Windows 日志'), 'crash-logs 不再包含系统日志');
  console.log('cleaner ok');
}
testCleaner().then(() => console.log('all tests ok')).catch((e) => { console.error(e); process.exit(1); });
