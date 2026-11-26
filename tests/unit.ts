import assert from 'node:assert'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import * as db from '../src/main/db'; import { PetStateMachine } from '../src/main/petstate';
import { clampPetBounds, defaultPetBounds } from '../src/main/petgeom';
import { isFullscreenState } from '../src/main/fullscreen';
import * as cleaner from '../src/main/cleaner';
import { isLoopListen } from '../src/main/security';
import { hasUsableAddress, RateBudget, sampleSeconds, localMonthKey } from '../src/main/guards';
import * as settingsio from '../src/main/settingsio';
import { HOTKEYS, DEFAULT_HOTKEY, normalizeHotkey } from '../src/shared/hotkey';
import { fillDays, summarize, localDay } from '../src/shared/report';
import { judge, ProbeState } from '../src/main/probe';
import * as startup from '../src/main/startup';
import * as vpn from '../src/main/vpn';
import * as winupdate from '../src/main/winupdate';
import * as secure from '../src/main/secure';
import * as memtrim from '../src/main/memtrim';
import { quotaStep, NewProcWatcher, Reminder, batteryWear } from '../src/main/extras';
import * as selfupdate from '../src/main/selfupdate';
// 1.5.0
import { PETS } from '../src/shared/petlist';
import { normalizeProcHotkey, PROC_HOTKEYS } from '../src/shared/hotkey';
import * as i18n from '../src/shared/i18n';
import { SpeedAlert, sanitizeSpeedAlert, SPEED_ALERT_DEFAULT } from '../src/main/speedalert';
import { FocusTimer, sanitizeFocus, mmss } from '../src/main/focus';
import * as weekly from '../src/main/weekly';
import { idleTaskEligible, WEEK_MS } from '../src/main/sched';
import { bucketize, splitGaps, rangeSpec } from '../src/shared/series';
import * as wardrobe from '../src/shared/wardrobe';
import * as drivers from '../src/main/drivers';
import * as diskopt from '../src/main/diskopt';
import * as power from '../src/main/power';
import * as defender from '../src/main/defender';
import * as procview from '../src/shared/procview';
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
// 1.4.0：峰值按“速度”记，不按“本次累计字节数”记（采样间隔 5 秒时旧版峰值会放大 5 倍）
db.addTraffic(5e6 * 5, 0, 5e6); assert.equal(db.stats().peakRx, 5e6, '峰值用传入的速度');
// 1.4.0：按天流量（含未落盘部分）
const dl = db.daily(7); assert.equal(dl.length, 1, '只有今天有数据'); assert.equal(dl[0].rx, 6e6 + 25e6, '今天 = 已落盘 + 未落盘'); assert.equal(dl[0].day, localDay(Date.now()));
db.flush(); assert.equal(db.daily(7)[0].rx, 31e6, '落盘后数值不变');
db.addConnections([{ t: Date.now(), proc: 'chrome.exe', pid: 1, ip: '1.2.3.4', port: 443, host: 'a.example', proto: 'tcp4', note: '' }, { t: Date.now(), proc: 'x_y%.exe', pid: 2, ip: '5.6.7.8', port: 4444, host: '', proto: 'tcp4', note: '常见挖矿端口' }]);
assert.equal(db.connections(1, '').total, 2); assert.equal(db.connections(1, 'x_y%').total, 1, 'LIKE 转义'); assert.equal(db.connections(1, "a.example").rows.length, 1);
assert(db.toCsv(db.connections(1, '').rows).includes('chrome.exe'));
db.addHardware(Date.now(), 20, 50, null); assert(db.hardwareSummary(24).n === 1);
// 1.5.0：按天计数 / 每周小结 / 内存整理记录 / 硬件历史
db.bump('remind'); db.bump('remind', 2); db.bump('focusMin', 25); db.maxCounter('cpuMax', 40); db.maxCounter('cpuMax', 90); db.maxCounter('cpuMax', 70);
const tdy = localDay(Date.now()); const cnt = db.counters(tdy, tdy);
assert.equal(cnt.remind, 3); assert.equal(cnt.focusMin, 25); assert.equal(cnt.cpuMax, 90, 'Max 结尾的键取最大值'); assert.equal(db.counterTotal('remind'), 3); assert.equal(db.counterDays('remind', 7)[0].n, 3);
assert.equal(db.dailyRange(tdy, tdy)[0].rx, 31e6, '按日期范围取流量');
assert.equal(db.hardwareRows(0).length, 1); assert.equal(db.cpuPeak(0, Date.now() + 1), 20);
db.saveWeekly('2026-11-16', { week: '2026-11-16', a: 1 }); db.saveWeekly('2026-11-16', { week: '2026-11-16', a: 2 }); db.saveWeekly('2026-11-09', { week: '2026-11-09' });
assert.equal(db.weeklyList().length, 2, '同一周覆盖'); assert.equal(db.weeklyList()[0].a, 2, '按周倒序');
for (let i = 0; i < 25; i++) db.addTrimRun({ i }); assert.equal(db.trimRuns().length, 20, '只保留最近 20 次'); assert.equal(db.trimRuns()[0].i, 24);
db.addWarning('warn', 't', 'd'); assert.equal(db.warnings().length, 1);
db.prune(30); const bak = path.join(dir, 'b.db'); db.backup(bak); assert(fs.statSync(bak).size > 0);
db.clearAll(); assert.equal(db.connections(1, '').total, 0); assert.equal(db.stats().total, 0);
assert.equal(db.weeklyList().length, 0); assert.equal(db.trimRuns().length, 0); assert.equal(db.counterTotal('remind'), 0, '清空也清 1.5.0 新表');
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
// ---- 1.4.0：流量额度按本地月份 ----
assert.equal(localMonthKey(new Date(2026, 0, 1, 3, 0).getTime()), '2026-01', '本地 1 月 1 日凌晨就是 1 月（旧版用 UTC，东八区会算成上个月）');
assert.equal(localMonthKey(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12');
console.log('month key ok');
// ---- 1.4.0：全局快捷键白名单 ----
assert.equal(normalizeHotkey('Ctrl+Alt+P'), 'Ctrl+Alt+P'); assert.equal(normalizeHotkey('ctrl+alt+p'), 'Ctrl+Alt+P', '大小写不敏感，返回标准写法');
assert.equal(normalizeHotkey(''), '', '空字符串 = 关闭'); assert.equal(normalizeHotkey('Alt+F4'), null, '列表外的组合键拒绝');
assert.equal(normalizeHotkey(123), null); assert.equal(normalizeHotkey(undefined), null);
assert(HOTKEYS.some((h) => h.id === DEFAULT_HOTKEY), '默认快捷键在列表里'); assert.equal(new Set(HOTKEYS.map((h) => h.id)).size, HOTKEYS.length, '没有重复项');
console.log('hotkey ok');
// ---- 1.4.0：流量日报 / 周报 ----
const NOW = new Date(2026, 10, 26, 15, 0).getTime();
const fd = fillDays([{ day: '2026-11-25', rx: 100, tx: 10 }, { day: '2026-11-26', rx: 50, tx: 5 }, { day: '2026-10-01', rx: 999, tx: 9 }], 7, NOW);
assert.equal(fd.length, 7); assert.equal(fd[0].day, '2026-11-20'); assert.equal(fd[6].day, '2026-11-26', '最后一天是今天');
assert.deepEqual(fd[5], { day: '2026-11-25', rx: 100, tx: 10 }); assert.equal(fd[1].rx + fd[1].tx, 0, '没有数据的日子补 0'); assert(!fd.some((d) => d.day === '2026-10-01'), '范围外的不计入');
const mon = fillDays([], 30, new Date(2026, 2, 5, 12).getTime()); assert.equal(mon[0].day, '2026-02-04', '跨月（2 月 28 天）'); assert.equal(new Set(mon.map((d) => d.day)).size, 30, '30 天各不相同');
assert.equal(fillDays([{ day: '2026-11-26', rx: -5, tx: NaN as any }], 1, NOW)[0].rx, 0, '负数/非法值按 0');
const sm = summarize(fd);
assert.deepEqual(sm.total, { rx: 150, tx: 15 }); assert.equal(sm.peak!.day, '2026-11-25'); assert.equal(sm.peak!.bytes, 110); assert.equal(sm.activeDays, 2);
assert(Math.abs(sm.avg - 165 / 7) < 1e-9, '日均按整段天数');
assert.equal(summarize(fillDays([], 7, NOW)).peak, null, '全为 0 时没有“最多的一天”');
console.log('report ok');
// ---- 1.4.0：设置导出 / 导入 ----
const SS: any = { compact: true, alwaysOnTop: false, pet: 'fox', retentionDays: 90, memAlert: 85, privacy: { net: true, hw: true, conn: false, dns: false, proc: true, health: false, fullscreenHide: false, probe: false, evil: true },
  anim: { DOWNLOAD: false, UPLOAD: true, TIRED: true, HOT: true, SWEAT: true, WARNING: true }, memTrim: { auto: true, threshold: 85, skipFg: true }, quota: { gb: 50, notified: 80, month: '2026-11' },
  remind: { sit: 45, water: 30 }, newProc: { on: true, learnUntil: 1, known: ['secret.exe'] }, hotkey: 'Ctrl+Alt+N',
  lock: { salt: 'aa', hash: 'bb' }, vpn: { exe: 'C:\\x\\sing-box.exe', config: 'C:\\x\\c.json' }, vpnProxyBackup: { ProxyServer: '1.2.3.4' }, bounds: { x: 1, y: 2 }, growth: { xp: 999 }, baselines: { hosts: 'h' } };
const ex = settingsio.buildExport(SS, '1.4.0', 0); const exs = JSON.stringify(ex);
for (const bad of ['salt', 'hash', 'sing-box', 'c.json', '1.2.3.4', 'bounds', '"xp"', 'baselines', 'secret.exe', 'evil', 'notified', 'autostart']) assert(!exs.includes(bad), '导出内容不应包含 ' + bad);
assert.equal(ex.format, settingsio.EXPORT_FORMAT); assert.equal(ex.settings.pet, 'fox'); assert.equal(ex.settings.hotkey, 'Ctrl+Alt+N'); assert.equal(ex.exportedAt, '1970-01-01T00:00:00.000Z');
const im = settingsio.parseImport(exs);
assert(im.ok, im.error); assert.equal(im.patch.pet, 'fox'); assert.equal(im.patch.privacy.proc, true); assert.equal(im.patch.privacy.evil, undefined, '未知隐私键丢弃');
assert.deepEqual(im.patch.quota, { gb: 50 }, '额度只导入 GB，不导入“已提醒档位”'); assert.equal(im.patch.hotkey, 'Ctrl+Alt+N'); assert.deepEqual(im.patch.memTrim, { auto: true, threshold: 85 });
assert.equal(settingsio.parseImport('\ufeff' + exs).ok, true, '带 BOM 的文件也能导入');
const evil = settingsio.parseImport(JSON.stringify({ format: settingsio.EXPORT_FORMAT, settings: { lock: null, vpn: { exe: 'calc.exe' }, autostart: true, bounds: { x: 0 }, hotkey: 'Alt+F4', pet: 'x'.repeat(500), compact: 'yes', privacy: { conn: 'true', dns: true } } }));
assert(evil.ok); assert.deepEqual(Object.keys(evil.patch).sort(), ['privacy'], '敏感键 / 开机自启 / 位置 / 非法快捷键 / 类型不对的值全部丢弃'); assert.deepEqual(evil.patch.privacy, { dns: true });
assert.equal(settingsio.parseImport('{"settings":{"pet":"cat"}}').ok, false, '没有格式标记的文件拒绝');
assert.equal(settingsio.parseImport('not json').ok, false); assert.equal(settingsio.parseImport('').ok, false);
assert.equal(settingsio.parseImport(' '.repeat(settingsio.MAX_IMPORT_BYTES + 1) + '{}').ok, false, '超大文件拒绝');
assert.equal(settingsio.parseImport(JSON.stringify({ format: settingsio.EXPORT_FORMAT, settings: { foo: 1 } })).ok, false, '没有可导入的键时提示');
assert.deepEqual(settingsio.newlyEnabledPrivacy({ net: true, conn: false, dns: false }, { privacy: { net: true, conn: true, dns: false } }), ['conn'], '只列出从关变开的项');
assert.deepEqual(settingsio.newlyEnabledPrivacy({}, {}), []);
console.log('settings io ok');
// ---- 1.4.0：启动项路径展开环境变量（“位置”按钮）----
const ENV = { ProgramFiles: 'C:\\Program Files', windir: 'C:\\Windows' };
assert.equal(startup.expandEnv('%ProgramFiles%\\App\\a.exe', ENV), 'C:\\Program Files\\App\\a.exe');
assert.equal(startup.expandEnv('%WINDIR%\\system32\\x.exe', ENV), 'C:\\Windows\\system32\\x.exe', '变量名大小写不敏感');
assert.equal(startup.expandEnv('%NOPE%\\x.exe', ENV), '%NOPE%\\x.exe', '不认识的变量原样保留');
assert.equal(startup.expandEnv('100% sure', ENV), '100% sure'); assert.equal(startup.expandEnv('', ENV), '');
console.log('expandEnv ok');
// ==== 1.5.0 tests begin
// ---- 1.5.0：中英文界面 ----
{
  const zk = Object.keys(i18n.zh).sort(), ek = Object.keys(i18n.en).sort();
  assert.deepEqual(zk, ek, '中英文字典键一致');
  for (const k of zk) { assert.deepEqual(i18n.placeholders(i18n.zh[k]), i18n.placeholders(i18n.en[k]), '占位符一致：' + k); assert(i18n.en[k].length > 0 && i18n.zh[k].length > 0, '不能为空：' + k); }
  assert.equal(i18n.resolveLang('auto', 'zh-CN'), 'zh'); assert.equal(i18n.resolveLang('auto', 'zh-TW'), 'zh'); assert.equal(i18n.resolveLang('auto', 'en-US'), 'en'); assert.equal(i18n.resolveLang('auto', 'fr'), 'en');
  assert.equal(i18n.resolveLang('auto', ''), 'zh', '读不到系统语言时用中文'); assert.equal(i18n.resolveLang('en', 'zh-CN'), 'en'); assert.equal(i18n.resolveLang('zh', 'en-US'), 'zh'); assert.equal(i18n.resolveLang('xx', 'en-US'), 'en');
  i18n.setLang('en'); assert.equal(i18n.t('tab.ov'), 'Overview'); assert.equal(i18n.t('ui.max', { v: '1 GB' }), 'Max 1 GB');
  assert.equal(i18n.t('no.such.key'), 'no.such.key', '找不到的键原样返回');
  i18n.setLang('zh'); assert.equal(i18n.t('tab.ov'), '概览'); assert.equal(i18n.t('ui.max', {}), '最高 {v}', '缺参数时保留占位符');
  i18n.setLang('xx'); assert.equal(i18n.getLang(), 'zh', '非法语言回到中文');
  for (const p of PETS) assert(i18n.has('pet.' + p.id), '宠物名有翻译：' + p.id);
  for (const c of drivers.CM_CODES) assert(i18n.has('drv.cm.' + c), '错误码有说明：' + c);
  for (const k of ['net', 'hw', 'conn', 'dns', 'proc', 'health', 'fullscreenHide', 'probe', 'newProc']) assert(i18n.has('priv.name.' + k), k);
  for (const p of wardrobe.PALETTES) assert(i18n.has('wr.p.' + p.id)); for (const a of wardrobe.ACCESSORIES) assert(i18n.has('wr.a.' + a.id));
  for (const s of Object.values(defender.STATUS)) assert(i18n.has('def.st.' + s), s); for (const s of [...Object.values(defender.SEVERITY), 'unknown']) assert(i18n.has('def.sev.' + s), s);
  for (const s of ['IDLE', 'HAPPY', 'SLEEP', 'TIRED', 'HOT', 'SWEAT', 'WARNING', 'DOWNLOAD', 'UPLOAD']) assert(i18n.has('st.' + s), s);
  for (const k of ['balanced', 'high', 'ultimate', 'saver']) assert(i18n.has('pow.kind.' + k));
  for (const a of ['speed10', 'speed100', 'gb10', 'gb100', 'week', 'focus5']) assert(i18n.has('ach.' + a) && i18n.has('ach.' + a + '.d'));
  console.log('i18n ok, keys', zk.length);
}
// ---- 1.5.0：网速异常提醒 ----
{
  const KB = 1024, MB = 1048576, cfg = { ...SPEED_ALERT_DEFAULT, on: true, lowKB: 50, lowSec: 60, highMB: 10, highSec: 30, cooldownMin: 10 };
  let sa = new SpeedAlert(), now = 0;
  const run = (n, rx, muted = false, c = cfg) => { const out = []; for (let i = 0; i < n; i++) { now += 1000; out.push(...sa.update(now, rx, c, muted)); } return out; };
  assert.deepEqual(run(120, 20 * KB), [], '没有先下载过，慢速不算卡住');
  run(10, 2 * MB); assert.deepEqual(run(59, 20 * KB), [], '不到 60 秒不提醒');
  assert.deepEqual(run(2, 20 * KB), ['low'], '下载后持续 60 秒低于 50KB/s → 提醒');
  assert.deepEqual(run(120, 20 * KB), [], '同一段只提醒一次');
  run(10, 2 * MB); assert.deepEqual(run(70, 1 * KB), [], '下载结束降到几乎 0 不算卡住');
  run(10, 2 * MB); assert.deepEqual(run(70, 20 * KB), [], '冷却期内不再提醒');
  now += 10 * 60e3; run(10, 2 * MB); assert.deepEqual(run(70, 20 * KB), ['low'], '冷却后再次提醒');
  now += 20 * 60e3; run(10, 2 * MB); assert.deepEqual(run(70, 20 * KB, true), [], '勿扰时不提醒'); assert.deepEqual(run(5, 20 * KB), [], '解除勿扰后不补发');
  sa = new SpeedAlert(); now = 0; run(10, 2 * MB); run(40, 20 * KB); run(1, 100 * KB); assert.deepEqual(run(40, 20 * KB), [], '中间恢复到阈值以上会重新计时');
  sa = new SpeedAlert(); now = 0; assert.deepEqual(run(29, 20 * MB), []); assert.deepEqual(run(2, 20 * MB), ['high'], '持续 30 秒高于 10MB/s');
  assert.deepEqual(run(60, 20 * MB), [], '持续高速只提醒一次'); run(5, 9 * MB); assert.deepEqual(run(40, 20 * MB), [], '回落到 80% 以上不算结束（防抖）');
  run(5, 1 * MB); now += 11 * 60e3; assert.deepEqual(run(31, 20 * MB), ['high'], '回落到 80% 以下且冷却后再次提醒');
  assert.deepEqual(new SpeedAlert().update(1, 5 * MB, { ...cfg, on: false }, false), [], '关闭时不提醒');
  assert.deepEqual(new SpeedAlert().update(1, null, cfg, false), [], '没有数据');
  const sc = sanitizeSpeedAlert(SPEED_ALERT_DEFAULT, { on: true, lowKB: 7, lowSec: 30, highMB: 50, cooldownMin: 'x' });
  assert.equal(sc.on, true); assert.equal(sc.lowKB, 50, '列表外的值忽略'); assert.equal(sc.lowSec, 30); assert.equal(sc.highMB, 50); assert.equal(sc.cooldownMin, 10);
  assert.equal(SPEED_ALERT_DEFAULT.on, false, '默认关闭');
  console.log('speed alert ok');
}
// ---- 1.5.0：番茄钟 ----
{
  const ft = new FocusTimer({ focusMin: 25, breakMin: 5 }); let now = 1000;
  assert.equal(ft.view(now).phase, 'idle'); assert.equal(ft.view(now).remainMs, 25 * 60e3);
  assert(ft.start(now)); assert.equal(ft.start(now), false, '重复开始无效'); assert(ft.focusing());
  now += 10 * 60e3; assert.equal(ft.tick(now), null); assert.equal(ft.view(now).remainMs, 15 * 60e3);
  ft.pause(now); now += 60 * 60e3; assert.equal(ft.tick(now), null, '暂停时不走'); assert.equal(ft.view(now).remainMs, 15 * 60e3); assert(!ft.focusing());
  ft.start(now); now += 15 * 60e3; assert.deepEqual(ft.tick(now), { type: 'focusDone', minutes: 25 }); assert.equal(ft.view(now).phase, 'break'); assert(!ft.focusing(), '休息时不算专注');
  now += 5 * 60e3; assert.deepEqual(ft.tick(now), { type: 'breakDone', minutes: 0 }); assert.equal(ft.view(now).phase, 'idle');
  ft.start(now); ft.skip(now); assert.equal(ft.view(now).phase, 'break', '跳过专注进入休息（不计完成）'); ft.skip(now); assert.equal(ft.view(now).phase, 'idle');
  ft.start(now); ft.reset(); assert.equal(ft.view(now).phase, 'idle'); assert.equal(ft.view(now).running, false);
  ft.start(now); now += 3 * 3600e3; assert.equal(ft.tick(now).type, 'focusDone', '休眠唤醒后按结束时刻结算');
  ft.setCfg({ focusMin: 50, breakMin: 10 }); ft.reset(); assert.equal(ft.view(now).remainMs, 50 * 60e3);
  assert.deepEqual(sanitizeFocus({ focusMin: 25, breakMin: 5 }, { focusMin: 33, breakMin: 10 }), { focusMin: 25, breakMin: 10 });
  assert.equal(mmss(25 * 60e3), '25:00'); assert.equal(mmss(61500), '01:02'); assert.equal(mmss(-5), '00:00');
  const rm = new Reminder(30, 30); let tt = 0; rm.tick(tt, 0, false, true); const got = [];
  for (let i = 0; i < 31; i++) { tt += 60e3; got.push(...rm.tick(tt, 0, false, true)); }
  assert.deepEqual(got, ['water'], '专注中只暂停久坐提醒，喝水照常');
  console.log('focus ok');
}
// ---- 1.5.0：每周小结 ----
{
  const thu = new Date(2026, 10, 26, 15, 0).getTime(); // 周四
  assert.equal(localDay(weekly.weekStart(thu)), '2026-11-23', '本周一');
  const r = weekly.lastWeekRange(thu); assert.equal(r.key, '2026-11-16'); assert.equal(r.fromDay, '2026-11-16'); assert.equal(r.toDay, '2026-11-22');
  assert.equal(weekly.lastWeekRange(new Date(2026, 10, 23, 0, 5).getTime()).key, '2026-11-16', '周一凌晨');
  assert.equal(weekly.lastWeekRange(new Date(2026, 10, 22, 23, 59).getTime()).key, '2026-11-09', '周日还算本周');
  assert.equal(weekly.lastWeekRange(new Date(2027, 0, 1, 9).getTime()).key, '2026-12-21', '跨年');
  assert.equal(weekly.shouldGenerate(thu, '', true), true); assert.equal(weekly.shouldGenerate(thu, '2026-11-16', true), false, '同一周只生成一次'); assert.equal(weekly.shouldGenerate(thu, '', false), false, '关闭时不生成');
  const sum = weekly.buildSummary({ range: r, days: [{ day: '2026-11-15', rx: 999, tx: 0 }, { day: '2026-11-16', rx: 100, tx: 10 }, { day: '2026-11-20', rx: 300, tx: 50 }, { day: '2026-11-23', rx: 5, tx: 5 }],
    health: [{ t: r.start - 1, score: 10 }, { t: r.start + 1000, score: 80 }, { t: r.end - 1000, score: 95 }, { t: r.end, score: 1 }], counters: { remind: 4, focus: 3, focusMin: 75 }, cpuPeak: 97.6 }, 0);
  assert.equal(sum.traffic.total, 460, '只算范围内的天'); assert.equal(sum.traffic.peak.day, '2026-11-20'); assert(Math.abs(sum.traffic.avg - 460 / 7) < 1e-9); assert.equal(sum.traffic.activeDays, 2);
  assert.deepEqual(sum.health, { runs: 2, last: 95, min: 80 }); assert.equal(sum.reminders, 4); assert.deepEqual(sum.focus, { sessions: 3, minutes: 75 }); assert.equal(sum.cpuPeak, 98); assert.equal(sum.empty, false);
  const e = weekly.buildSummary({ range: r, days: [], health: [], counters: {}, cpuPeak: null }); assert.equal(e.empty, true); assert.equal(e.traffic.peak, null);
  console.log('weekly ok');
}
// ---- 1.5.0：空闲时自动任务（磁盘整理 / 定期扫描）----
{
  const b = { now: 100 * 864e5, enabled: true, last: 0, lastTry: 0, intervalMs: WEEK_MS, retryMs: 864e5, idleSec: 900, minIdleSec: 600, onAC: true, fullscreen: false, focus: false };
  assert.equal(idleTaskEligible(b).ok, true);
  for (const [k, v, why] of ([['enabled', false, 'off'], ['onAC', false, 'battery'], ['fullscreen', true, 'fullscreen'], ['focus', true, 'focus'], ['idleSec', 300, 'notIdle'], ['last', b.now - 864e5, 'interval'], ['lastTry', b.now - 3600e3, 'retry'], ['busy', true, 'busy']] as any[]))
    assert.equal(idleTaskEligible({ ...b, [k]: v }).reason, why, k);
  assert.equal(idleTaskEligible({ ...b, last: b.now - 8 * 864e5 }).ok, true, '超过一周可以再次运行');
  console.log('sched ok');
}
// ---- 1.5.0：硬件历史降采样 ----
{
  const H = 3600e3, pts = [{ t: 0, cpu: 10, mem: 50, temp: null }, { t: 60e3, cpu: 30, mem: 52, temp: 60 }, { t: H + 1, cpu: 90, mem: 70, temp: 80 }, { t: 2 * H + 5, cpu: null, mem: null, temp: null }, { t: NaN, cpu: 1, mem: 1, temp: 1 }];
  const b = bucketize(pts, H);
  assert.equal(b.length, 3, '非法时间丢弃'); assert.equal(b[0].cpu, 20); assert.equal(b[0].cpuMax, 30); assert.equal(b[0].mem, 51); assert.equal(b[0].temp, 60, '读不到的温度不参与平均'); assert.equal(b[0].n, 2);
  assert.equal(b[1].tempMax, 80); assert.equal(b[2].cpu, null);
  assert.deepEqual(splitGaps([{ t: 0 }, { t: 1 }, { t: 10 }, { t: 11 }], 3).map((s) => s.length), [2, 2], '间隔大于 gap 断开');
  assert.equal(rangeSpec('7d').bucket, 30 * 60e3); assert.equal(rangeSpec('24h').ms, 864e5); assert.equal(rangeSpec('x').ms, 864e5);
  assert.equal(bucketize(Array.from({ length: 7 * 1440 }, (_, i) => ({ t: i * 60e3, cpu: 50, mem: 50, temp: null })), 30 * 60e3).length, 336, '7 天降采样为 336 个点');
  console.log('series ok');
}
// ---- 1.5.0：宠物换装 ----
{
  const { sanitizeLook, isUnlocked, PALETTES, ACCESSORIES, DEFAULT_LOOK } = wardrobe;
  assert.deepEqual(sanitizeLook(null, 1, []), DEFAULT_LOOK);
  assert.deepEqual(sanitizeLook({ palette: 'mint', acc: 'hat' }, 1, []), { palette: 'mint', acc: 'none' }, 'Lv.1 帽子未解锁');
  assert.deepEqual(sanitizeLook({ palette: 'mint', acc: 'hat' }, 2, []), { palette: 'mint', acc: 'hat' });
  assert.deepEqual(sanitizeLook({ palette: 'gold', acc: 'bow' }, 99, []), DEFAULT_LOOK, '成就类需要成就');
  assert.deepEqual(sanitizeLook({ palette: 'gold', acc: 'bow' }, 1, ['speed10', 'week']), { palette: 'gold', acc: 'bow' });
  assert.deepEqual(sanitizeLook({ palette: '<script>', acc: 123 }, 99, ['week']), DEFAULT_LOOK, '不认识的值回默认');
  assert(isUnlocked(PALETTES[0], 1, []) && isUnlocked(ACCESSORIES[0], 1, []), '默认项总是可用');
  assert.equal(new Set(PALETTES.map((p) => p.id)).size, PALETTES.length); assert.equal(new Set(ACCESSORIES.map((p) => p.id)).size, ACCESSORIES.length);
  for (const a of [...PALETTES, ...ACCESSORIES]) if (a.ach) assert(['speed10', 'speed100', 'gb10', 'gb100', 'week', 'focus5'].includes(a.ach), '解锁条件引用的成就必须存在：' + a.ach);
  console.log('wardrobe ok');
}
// ---- 1.5.0：驱动更新（解析）----
{
  const NOW = new Date(2026, 10, 26).getTime();
  const l = drivers.parseDrivers([{ n: 'Intel(R) Wi-Fi', c: 'NET', p: 'Intel', v: '23.1.0.4', d: '2024-03-01', s: true, id: 'PCI\\X' }, { n: 'Old Printer', c: 'PRINTER', p: 'Acme', v: '1.0', d: '2015-01-01', s: false },
    { n: 'Generic USB Hub', c: 'USB', p: 'Microsoft', v: '10.0', d: '2006-06-21', s: true }, { n: '' }, null, { n: 'NoDate', d: 'bad' }], NOW);
  assert.equal(l.length, 4, '空名字 / null 丢弃');
  const by: any = Object.fromEntries(l.map((x) => [x.name, x]));
  assert.equal(by['Old Printer'].old, true); assert.equal(by['Old Printer'].signed, false); assert.equal(by['Intel(R) Wi-Fi'].old, false);
  assert.equal(by['Generic USB Hub'].old, false, '微软通用驱动的 2006-06-21 是占位日期，不算旧'); assert.equal(by['Generic USB Hub'].inbox, true);
  assert.equal(by['NoDate'].date, ''); assert.equal(by['NoDate'].ageYears, null); assert.equal(by['NoDate'].signed, null);
  assert.equal(drivers.ageFlag('2021-11-25', 'x', NOW), true, '刚过 5 年'); assert.equal(drivers.ageFlag('2021-11-27', 'x', NOW), false, '还差 1 天');
  assert.equal(drivers.ageYears('2099-01-01', NOW), null, '未来日期不可信');
  const pr = drivers.parseProblems([{ n: 'Unknown device', c: '', code: 28, id: 'X' }, { n: 'Disabled', code: 22 }, { n: 'ok', code: 0 }, { n: 'weird', code: 999 }]);
  assert.equal(pr.length, 3); assert.equal(pr[0].known, true); assert.equal(pr[2].known, false);
  assert.equal(drivers.cmSeverity(22), 'info'); assert.equal(drivers.cmSeverity(45), 'info'); assert.equal(drivers.cmSeverity(43), 'bad');
  const w = drivers.parseWuaDrivers({ t: 'Intel - Display - 31.0.101', c: 'Display', m: 'Intel', mdl: 'UHD', v: '2026-09-01T00:00:00', z: 524288000 });
  assert.equal(w.length, 1, '单个对象也能解析'); assert.equal(w[0].date, '2026-09-01'); assert.equal(w[0].sizeMB, 500);
  assert.deepEqual(drivers.parseWuaDrivers(null), []); assert.equal(drivers.parseWuaDrivers([{ t: 'a', v: '/Date(123)/' }])[0].date, '', '非 ISO 日期不显示');
  console.log('drivers ok');
}
// ---- 1.5.0：磁盘整理 ----
{
  assert.equal(diskopt.actionFor('HDD'), 'defrag'); assert.equal(diskopt.actionFor('SSD'), 'retrim'); assert.equal(diskopt.actionFor('SCM'), 'retrim'); assert.equal(diskopt.actionFor(4), 'retrim'); assert.equal(diskopt.actionFor(3), 'defrag');
  for (const x of ['Unspecified', '', null, 0, 'NVMe']) assert.equal(diskopt.actionFor(x), 'skip', '未知介质跳过（绝不猜测）：' + x);
  assert.equal(diskopt.actionFor('ssd '), 'retrim', '大小写 / 空格');
  assert.equal(diskopt.validLetter('C'), true); assert.equal(diskopt.validLetter('c'), true); assert.equal(diskopt.validLetter("C';"), false); assert.equal(diskopt.validLetter(''), false);
  const last = diskopt.lastOptByLetter([{ t: '2026-11-01T10:00:00', m: 'The storage optimizer successfully completed retrim on (C:)' }, { t: '2026-11-20T10:00:00', m: '存储优化器在 (C:) 上成功完成了 碎片整理' }, { t: '2026-10-01T10:00:00', m: '(D:) ok' }, { t: '2026-11-21T00:00:00', m: 'no letter' }]);
  assert.deepEqual(last, { C: '2026-11-20T10:00:00', D: '2026-10-01T10:00:00' }, '取每个盘最近一次，与系统语言无关');
  const pv = diskopt.parseVolumes({ adm: true, vols: [{ l: 'D', size: 2e12, free: 1e12, mt: 'HDD' }, { l: 'C', size: 5e11, free: 1e11, mt: 'SSD', bus: 'NVMe' }, { l: 'E', mt: 'Unspecified' }, { l: '1' }], ev: [{ t: '2026-11-20T10:00:00', m: '(C:)' }], task: { exists: true, state: 'Ready', last: '', next: '', result: 0 } });
  assert.deepEqual(pv.vols.map((v) => v.letter + v.action), ['Cretrim', 'Ddefrag', 'Eskip'], '按盘符排序，非法盘符丢弃'); assert.equal(pv.vols[0].lastOpt, '2026-11-20T10:00:00'); assert.equal(pv.admin, true); assert.equal(pv.task.state, 'Ready');
  assert.deepEqual(diskopt.parseAnalysis({ rv: 0, pct: 12.4, rec: true }), { ok: true, pct: 12, recommended: true, rv: 0 }); assert.equal(diskopt.parseAnalysis({ rv: 5 }).ok, false); assert.equal(diskopt.parseAnalysis(null).ok, false);
  console.log('diskopt ok');
}
// ---- 1.5.0：温度与节能 ----
{
  const LIST = 'Existing Power Schemes (* Active)\n-----------------------------------\nPower Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced) *\nPower Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)\nPower Scheme GUID: a1841308-3d3c-4fd5-b30b-1a2b3c4d5e6f  (Power saver)\n';
  const ZH = '现有电源使用方案 (* 活动)\n电源方案 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (平衡) *\n电源方案 GUID: 11111111-2222-3333-4444-555555555555  (我的方案)\n';
  const pl = power.parsePlans(LIST); assert.equal(pl.length, 3); assert.equal(pl[0].active, true); assert.deepEqual(pl.map((p) => p.kind), ['balanced', 'high', 'saver']);
  const pz = power.parsePlans(ZH); assert.equal(pz[1].name, '我的方案'); assert.equal(pz[1].kind, 'other'); assert.equal(pz[0].active, true);
  assert.equal(power.parseActive('Power Scheme GUID: 8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C  (High performance)'), '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c');
  assert.equal(power.isGuid('381b4222-f694-41f0-9685-ff5bb260df2e'), true); assert.equal(power.isGuid('381b4222-f694-41f0-9685-ff5bb260df2e & calc'), false); assert.equal(power.isGuid('SCHEME_CURRENT'), false); assert.equal(power.isGuid(null), false);
  const Q = 'Power Setting GUID: bc5038f7-23e0-4960-96da-33abaf5935ec  (Maximum processor state)\n  Minimum Possible Setting: 0x00000000\n  Maximum Possible Setting: 0x00000064\n  Possible Settings increment: 0x00000001\n  Possible Settings units: %\nCurrent AC Power Setting Index: 0x00000064\nCurrent DC Power Setting Index: 0x00000063\n';
  assert.deepEqual(power.parseAcDc(Q), { ac: 100, dc: 99 });
  const QZ = '电源设置 GUID: 94d3a615-a899-4ac5-ae2b-e4d8f634367f  (系统散热方式)\n  可能的设置索引: 000\n  可能的设置友好名称: 被动\n  可能的设置索引: 001\n  可能的设置友好名称: 主动\n当前交流电源设置索引: 0x00000001\n当前直流电源设置索引: 0x00000000\n';
  assert.deepEqual(power.parseAcDc(QZ), { ac: 1, dc: 0 }, '与系统语言无关'); assert.deepEqual(power.parseAcDc('错误'), { ac: null, dc: null });
  assert.deepEqual(power.sanitizePower(power.POWER_DEFAULT, { guard: true, threshold: 70, coolMax: 99, saver: 'yes', saverPct: 15 }), { guard: true, threshold: 85, coolMax: 99, saver: false, saverPct: 15 });
  assert.equal(power.POWER_DEFAULT.guard, false); assert.equal(power.POWER_DEFAULT.saver, false);
  const g = new power.ThermalGuard(); let now = 0;
  const TG = (n, temp, en = true, th = 85) => { let r = null; for (let i = 0; i < n; i++) { now += 1000; const x = g.update(now, temp, th, en); if (x) r = x; } return r; };
  assert.equal(TG(59, 90), null, '不到 60 秒不动作'); assert.equal(TG(2, 90), 'apply');
  assert.equal(TG(600, 80), null, '降到阈值以下但没低于阈值 -10℃，保持降温'); assert.equal(TG(299, 70), null); assert.equal(TG(2, 70), 'restore', '低于 75℃ 持续 5 分钟恢复');
  assert.equal(TG(120, 95), null, '恢复后 10 分钟冷却期内不再降温'); now += 10 * 60e3; assert.equal(TG(61, 95), 'apply');
  assert.equal(TG(120, null), null, '短时间读不到温度不动作'); assert.equal(TG(200, null), 'restore', '降温中持续 5 分钟读不到温度 → 恢复');
  const g2 = new power.ThermalGuard(); for (let i = 0; i < 100; i++) assert.equal(g2.update(i * 1000, null, 85, true), null, '读不到温度时永远不会进入降温');
  const g3 = new power.ThermalGuard(); for (let i = 0; i <= 61; i++) g3.update(i * 1000, 99, 85, true); assert.equal(g3.state, 'cooling'); assert.equal(g3.update(62000, 99, 85, false), 'restore', '关闭自动保护时立即恢复');
  const bs = new power.BatterySaverGuard(); assert.equal(bs.update(true, 50, 20, true), null); assert.equal(bs.update(true, 20, 20, true), 'apply'); assert.equal(bs.update(true, 25, 20, true), null, '回差 10%'); assert.equal(bs.update(true, 31, 20, true), 'restore');
  assert.equal(bs.update(true, 10, 20, true), 'apply'); assert.equal(bs.update(false, 10, 20, true), 'restore', '接通电源恢复'); assert.equal(bs.update(true, 10, 20, false), null, '关闭时不动作'); assert.equal(bs.update(true, null, 20, true), null, '读不到电量不动作');
  console.log('power ok');
}
// ---- 1.5.0：病毒查杀（Microsoft Defender）----
{
  assert.equal(defender.avActive(397568), true, '0x061100 开启'); assert.equal(defender.avActive(266240), true, '0x041000 开启'); assert.equal(defender.avActive(393472), false, '0x060100 关闭'); assert.equal(defender.avActive(262144), false); assert.equal(defender.avActive('x'), false);
  const NOW = new Date('2026-11-26T12:00:00').getTime();
  const s1 = defender.parseStatus({ ok: true, cmd: true, am: true, ave: true, rtp: true, mode: 'Normal', sigv: '1.421.0.0', sigt: '2026-11-24T08:00:00', qs: '2026-11-20T10:00:00', fs: '', av: [{ n: 'Windows Defender', st: 397568 }] }, NOW);
  assert.equal(s1.canScan, true); assert.equal(s1.thirdActive, false); assert.equal(s1.sigAgeDays, 2); assert.equal(s1.lastFull, ''); assert.equal(s1.thirdParty.length, 0, 'Defender 自己不算第三方');
  const s2 = defender.parseStatus({ ok: true, am: true, ave: false, rtp: false, mode: 'Passive Mode', av: [{ n: 'Windows Defender', st: 393472 }, { n: '火绒安全软件', st: 266240 }] }, NOW);
  assert.equal(s2.thirdActive, true); assert.equal(s2.passive, true); assert.equal(s2.canScan, false, '第三方杀毒在工作时不发起扫描'); assert.equal(s2.thirdParty[0].name, '火绒安全软件');
  const s3 = defender.parseStatus({ ok: true, ave: true, rtp: true, mode: 'Normal', av: [{ n: 'Old AV', st: 262144 }] }, NOW);
  assert.equal(s3.thirdActive, false); assert.equal(s3.canScan, true, '登记了但已关闭的第三方不影响');
  const s4 = defender.parseStatus(null, NOW); assert.equal(s4.ok, false); assert.equal(s4.canScan, false); assert.equal(s4.sigAgeDays, null); assert.equal(s4.rtp, null);
  const th = defender.parseThreats([{ id: '1', n: 'Trojan:Win32/X', sev: 5, st: 3, t: '2026-11-20T10:00:00', r: ['file:_C:\\Users\\a\\x.exe', 'process:_pid:1'], act: false, ok: true }, { id: '2', n: 'PUA:Y', sev: 1, st: 107, t: '2026-11-25T10:00:00', r: 'file:_C:\\y.exe' }, { id: '3', sev: 9, st: 999 }]);
  assert.equal(th[0].id, '2', '按时间倒序'); assert.equal(th[0].severity, 'low'); assert.equal(th[0].status, 'blockFailed'); assert.deepEqual(th[0].paths, ['C:\\y.exe'], '单个字符串也能解析，去掉 file:_ 前缀');
  assert.equal(th[1].severity, 'severe'); assert.equal(th[1].status, 'quarantined'); assert.equal(th[2].severity, 'unknown'); assert.equal(th[2].status, 'unknown'); assert.equal(th[2].name, '?');
  assert.equal(defender.newDetections(th, new Date('2026-11-25T09:00:00').getTime()).length, 1, '只算扫描开始后的新检测');
  const sm = new defender.ScanMachine(); const g1 = sm.start('quick', 1000); assert(g1 > 0); assert.equal(sm.start('full', 2000), 0, '同一时间只能一个扫描');
  assert.equal(sm.finish(g1 + 1, true, '', 3000), false, '别的代号的结果忽略'); assert(sm.finish(g1, true, '', 5000)); assert.equal(sm.view(9000).state, 'done'); assert.equal(sm.view(9000).elapsedMs, 4000);
  const g2 = sm.start('full', 10000); assert(sm.cancel(11000)); assert.equal(sm.view(12000).state, 'cancelled'); assert.equal(sm.finish(g2, true, '', 20000), false, '停止等待后迟到的结果忽略');
  assert.equal(sm.start('format-c', 1), 0, '不认识的扫描类型拒绝'); assert(sm.start('custom', 30000, 'C:\\x') > 0); assert.equal(sm.view(30000).path, 'C:\\x');
  const sc = defender.scanScript('custom', "C:\\a'b\"; Remove-Item C:\\ -Recurse");
  assert(!sc.includes('Remove-Item'), '路径以 Base64 传入，不拼进命令'); assert(sc.includes('FromBase64String'));
  assert(defender.scanScript('quick').includes('QuickScan')); assert(defender.scanScript('offline').includes('Start-MpWDOScan')); assert(defender.scanScript('update').includes('SignatureUpdate'));
  assert(defender.scanScript('quick').includes('MpCmdRun.exe'), '没有 cmdlet 时退回 MpCmdRun');
  console.log('defender ok');
}
// ---- 1.5.0：任务管理器 ----
{
  const { protectedReason, normName, validPid, validPriority, taskkillArgs, groupProcs, filterSort, classify, worthChecking, parseSi } = procview;
  for (const n of ['csrss.exe', 'CSRSS', 'C:\\Windows\\System32\\csrss.exe', '"C:\\Windows\\System32\\lsass.exe"', 'svchost', 'MsMpEng.exe', 'System', 'winlogon.EXE', 'dwm.exe', 'fontdrvhost', 'smss', 'wininit', 'services', 'Idle']) assert(protectedReason(n, 1234, []), '受保护：' + n);
  assert.equal(protectedReason('MsMpEng.exe', 999, []), 'av'); assert.equal(protectedReason('360Tray.exe', 999, []), 'av');
  assert.equal(protectedReason('chrome.exe', 4321, []), null); assert.equal(protectedReason('chrome.exe', 4321, [4321]), 'self', 'NetPet 自己的进程');
  assert.equal(protectedReason('NetPet.exe', 1234, []), 'self'); assert.equal(protectedReason('anything', 4, []), 'system', 'PID ≤ 4');
  assert.equal(normName('C:/Apps/Foo.EXE'), 'foo');
  for (const v of [1, 1234, 2147483647]) assert.equal(validPid(v), true); for (const v of [0, -1, 1.5, '123', NaN, 2147483648, null]) assert.equal(validPid(v), false, 'PID 校验：' + v);
  assert.equal(validPriority('Normal'), true); for (const p of ['RealTime', 'High', 'Idle', 'normal', '']) assert.equal(validPriority(p), false, '优先级白名单：' + p);
  assert.deepEqual(taskkillArgs(123), ['/PID', '123']); assert.deepEqual(taskkillArgs(123, { force: true, tree: true }), ['/PID', '123', '/T', '/F']); assert.equal(taskkillArgs('123 /F'), null);
  const L = parseSi([{ pid: 10, parentPid: 1, name: 'chrome.exe', cpu: 5, memRss: 1024, path: 'C:\\Program Files\\Google\\chrome.exe' }, { pid: 11, name: 'chrome.exe', cpu: 3, memRss: 2048 }, { pid: 12, name: 'svchost.exe', cpu: 1, memRss: 512, path: 'C:\\Windows\\System32\\svchost.exe' },
    { pid: 13, name: 'tool.exe', cpu: 0, memRss: 100, path: 'C:\\Users\\a\\AppData\\Local\\tool.exe' }, { name: 'nopid' }], { '10': 'Google Chrome' });
  assert.equal(L.length, 4); assert.equal(L[0].kind, 'app'); assert.equal(L[1].kind, 'bg'); assert.equal(L[2].kind, 'win'); assert.equal(L[0].mem, 1024 * 1024, 'memRss 单位 KB');
  const G: any[] = groupProcs(L); const ch = G.find((x) => x.key === 'chrome'); assert.equal(ch.count, 2); assert.equal(ch.cpu, 8); assert.equal(ch.kind, 'app'); assert.equal(ch.title, 'Google Chrome');
  assert.deepEqual(filterSort(L, { sort: 'cpu' }).map((p) => p.pid), [10, 11, 12, 13]); assert.deepEqual(filterSort(L, { sort: 'mem', desc: false }).map((p) => p.pid), [13, 12, 10, 11]);
  assert.deepEqual(filterSort(L, { kind: 'win' }).map((p) => p.pid), [12]); assert.deepEqual(filterSort(L, { q: 'GOOGLE' }).map((p) => p.pid), [10]); assert.deepEqual(filterSort(L, { q: '13' }).map((p) => p.pid), [13]);
  assert.equal(filterSort(L, { sort: 'name', desc: false })[0].name, 'chrome.exe');
  assert.equal(worthChecking('C:\\Users\\a\\AppData\\Local\\tool.exe', 'NotSigned'), true); assert.equal(worthChecking('C:\\Users\\a\\AppData\\Local\\tool.exe', 'Valid'), false); assert.equal(worthChecking('C:\\Program Files\\x.exe', 'NotSigned'), false);
  assert.equal(classify({ pid: 2, name: 'x', path: '', title: '' }), 'win');
  assert.equal(normalizeProcHotkey(''), ''); assert.equal(normalizeProcHotkey('ctrl+alt+m'), 'Ctrl+Alt+M'); assert.equal(normalizeProcHotkey('Ctrl+Alt+P'), null, '不在任务管理器快捷键列表'); assert.equal(normalizeProcHotkey(5), null);
  assert(!PROC_HOTKEYS.some((h) => h.id && HOTKEYS.some((x) => x.id === h.id)), '两个快捷键列表没有重叠');
  console.log('procview ok');
}
// ---- 1.5.0：运行内存整理（定期 / 目标挑选 / 效果提示）----
{
  assert.deepEqual(memtrim.normalizeExclude(['Chrome.exe', 'chrome', ' game.EXE ', '', 'a;rm -rf', 'x'.repeat(70), 5, '微信']), ['chrome', 'game', '微信'], '排除列表：小写 / 去 .exe / 去重 / 非法丢弃');
  assert.equal(memtrim.normalizeExclude(Array.from({ length: 80 }, (_, i) => 'p' + i)).length, 50, '最多 50 个'); assert.deepEqual(memtrim.normalizeExclude('chrome'), []);
  const now = 1e9, b = { now, enabled: true, intervalMin: 60, lastScheduled: 0, lastAnyTrim: 0, idleSec: 600, locked: false, fullscreen: false, focus: false, memPct: 80 };
  assert.equal(memtrim.scheduleEligible(b).ok, true);
  for (const [k, v, why] of ([['enabled', false, 'off'], ['lastScheduled', now - 30 * 60e3, 'interval'], ['lastAnyTrim', now - 5 * 60e3, 'cooldown'], ['idleSec', 60, 'notIdle'], ['fullscreen', true, 'fullscreen'], ['focus', true, 'focus'], ['memPct', 55, 'lowMem'], ['memPct', null, 'lowMem']] as any[]))
    assert.equal(memtrim.scheduleEligible({ ...b, [k]: v }).reason, why, k);
  assert.equal(memtrim.scheduleEligible({ ...b, idleSec: 10, locked: true }).ok, true, '锁屏也算离开');
  assert.equal(memtrim.scheduleEligible({ ...b, lastAnyTrim: now - 11 * 60e3 }).ok, true);
  const MB = 1048576;
  const procs = [{ pid: 100, name: 'chrome', ws: 900 * MB }, { pid: 101, name: 'chrome', ws: 300 * MB }, { pid: 102, name: 'code', ws: 500 * MB }, { pid: 103, name: 'svchost', ws: 800 * MB },
    { pid: 104, name: 'small', ws: 50 * MB }, { pid: 105, name: 'game', ws: 2000 * MB }, { pid: 106, name: 'netpet', ws: 400 * MB }, { pid: 107, name: 'old', ws: 600 * MB }, { pid: 3, name: 'x', ws: 999 * MB }];
  const o = { fgPid: 100, fgName: 'chrome', selfPids: [999], exclude: ['Game.exe'], recent: { 107: now - 10 * 60e3 }, now, minMB: 100, cap: 30, skipFgGroup: true };
  assert.deepEqual(memtrim.selectTargets(procs, o), [102], '前台及同名、系统、自身、排除、30 分钟内整理过、太小的都跳过');
  assert.deepEqual(memtrim.selectTargets(procs, { ...o, skipFgGroup: false, minMB: 30 }), [102, 101, 104], '手动模式只跳过前台那一个进程；大的优先');
  assert.deepEqual(memtrim.selectTargets(procs, { ...o, recent: { 107: now - 31 * 60e3 }, cap: 1 }), [107], '超过 30 分钟可以再整理；cap 限制数量');
  const R3 = (f) => ({ mode: 'scheduled', freed: f * MB });
  assert.equal(memtrim.ineffectiveTip([R3(50), R3(10), R3(99)]), true); assert.equal(memtrim.ineffectiveTip([R3(50), R3(150), R3(10)]), false);
  assert.equal(memtrim.ineffectiveTip([R3(50), R3(10)]), false, '不足 3 次'); assert.equal(memtrim.ineffectiveTip([{ mode: 'manual', freed: 0 }, R3(1), R3(2), R3(3)]), true, '只看定期整理');
  console.log('memtrim 1.5.0 ok');
}
// ---- 1.5.0：设置导出 / 导入的新字段 ----
{
  const S2 = { ...SS, language: 'en', speedAlert: { on: true, lowKB: 100, lowSec: 60, highMB: 0, highSec: 60, cooldownMin: 10 }, focus: { focusMin: 30, breakMin: 5 }, weekly: { on: false, last: '2026-11-16' }, look: { palette: 'mint', acc: 'hat' },
    memTrim: { ...SS.memTrim, exclude: ['game'], sched: 60 }, diskAuto: { on: true }, defSched: { on: true }, power: { guard: true, saver: true }, powerBackup: { scheme: 'x' } };
  const ex2 = JSON.stringify(settingsio.buildExport(S2, '1.5.0', 0));
  for (const bad of ['diskAuto', 'defSched', 'guard', 'powerBackup', '"sched"', '2026-11-16']) assert(!ex2.includes(bad), '会自动修改系统的开关不导出：' + bad);
  const im2 = settingsio.parseImport(ex2); assert(im2.ok, im2.error);
  assert.equal(im2.patch.language, 'en'); assert.equal(im2.patch.speedAlert.lowKB, 100); assert.deepEqual(im2.patch.focus, { focusMin: 30, breakMin: 5 }); assert.deepEqual(im2.patch.weekly, { on: false }); assert.deepEqual(im2.patch.look, { palette: 'mint', acc: 'hat' }); assert.deepEqual(im2.patch.memTrim.exclude, ['game']);
  const ev2 = settingsio.parseImport(JSON.stringify({ format: settingsio.EXPORT_FORMAT, settings: { language: 'fr', diskAuto: { on: true }, power: { guard: true }, defSched: { on: true }, memTrim: { sched: 30 }, look: { palette: 1 } } }));
  assert.equal(ev2.ok, false, '只有不可导入的键时拒绝');
  console.log('settings io 1.5.0 ok');
}
// ==== 1.5.0 tests end
// ---- 系统垃圾清理（白名单 + 安全根 + 符号链接不跟随）----
// 注：单元测试以 CJS 打包，顶层 await 不可用，所以清理测试包在 async 函数里。
async function testCleaner() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'np-clean-'));
  const mk = (rel: string, size: number, mtime?: number) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size)); if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime)); return p; };
  const tmpRoot = path.join(base, 'a', 'b', 'Temp'); const cacheRoot = path.join(base, 'a', 'b', 'Cache'); const logsRoot = path.join(base, 'a', 'b', 'Logs');
  const OLD = Date.now() - 3 * 864e5;
  mk('a/b/Temp/junk.tmp', 1000, OLD); mk('a/b/Temp/sub/old.log', 2000, OLD); mk('a/b/Temp/fresh.tmp', 7000); // fresh：刚生成的临时文件
  mk('a/b/Cache/c1.dat', 3000); // 1.4.0 修复：旧版这行被写进了上一行的注释里，浏览器缓存断言必然失败
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
