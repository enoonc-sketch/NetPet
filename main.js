const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification, dialog, powerMonitor, session, shell } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const si = require('systeminformation');
const db = require('./db');
const security = require('./security');
const fullscreen = require('./fullscreen');
const { PetStateMachine } = require('./petstate');
const procnet = require('./procnet');
const PETS = require('./petlist');

app.setPath('userData', path.join(app.getPath('appData'), 'NetPet'));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/* ---------- 设置 ---------- */
const DEFAULTS = {
  privacy: { net: true, hw: true, conn: false, dns: false, proc: false, health: false, fullscreenHide: false, procTraffic: false },
  pet: 'cat', alwaysOnTop: true, bounds: null, retentionDays: 30, memAlert: 90,
  anim: { DOWNLOAD: true, UPLOAD: true, TIRED: true, HOT: true, SWEAT: true, WARNING: true },
  lock: null, onboarded: false, growth: { xp: 0 }, baselines: {}
};
let S = structuredClone(DEFAULTS);
const R = { paused: false, dnd: false, passthrough: false, userHidden: false, fsHidden: false };
const save = (...keys) => { try { db.saveSettings(Object.fromEntries(keys.map((k) => [k, S[k]]))); } catch (_) {} };
function loadSettings() {
  const o = db.loadSettings();
  S = { ...structuredClone(DEFAULTS), ...o, privacy: { ...DEFAULTS.privacy, ...(o.privacy || {}) }, anim: { ...DEFAULTS.anim, ...(o.anim || {}) } };
}

/* ---------- 工具 ---------- */
let pet = null, dash = null, panel = null, tray = null, panelHiddenAt = 0;
const send = (w, ch, d) => { if (w && !w.isDestroyed()) w.webContents.send(ch, d); };
const sendAll = (ch, d) => { send(pet, ch, d); send(dash, ch, d); send(panel, ch, d); };
const notify = (title, body) => { if (R.dnd) return; try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch (_) {} };
const fmt = (b) => (b < 1024 ? `${Math.round(b)} B/s` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB/s` : `${(b / 1048576).toFixed(1)} MB/s`);
const isOurs = (e) => [pet, dash, panel].some((w) => w && !w.isDestroyed() && w.webContents === e.sender);
const clamp = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, Math.round(v))) : d; };
const str = (v, n = 100) => (typeof v === 'string' ? v.slice(0, n) : '');
const handle = (ch, fn) => ipcMain.handle(ch, (e, a) => { if (!isOurs(e)) throw new Error('untrusted sender'); return fn(a, e); });
const on = (ch, fn) => ipcMain.on(ch, (e, a) => { if (isOurs(e)) fn(a, e); });
const webPrefs = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });

/* ---------- 窗口 ---------- */
function createPet() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize, b = S.bounds;
  pet = new BrowserWindow({
    width: 80, height: 80, x: b ? b.x : width - 100, y: b ? b.y : height - 100,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: S.alwaysOnTop, webPreferences: webPrefs()
  });
  if (S.alwaysOnTop) pet.setAlwaysOnTop(true, 'screen-saver');
  pet.loadFile(path.join(__dirname, 'index.html'));
  pet.webContents.on('did-finish-load', () => { send(pet, 'settings', { pet: S.pet }); publish(true); });
}
function createPanel() {
  panel = new BrowserWindow({ width: 280, height: 400, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: webPrefs() });
  panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('blur', () => { if (panel.isVisible()) { panel.hide(); panelHiddenAt = Date.now(); } });
}
function showPanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  const b = pet.getBounds(), wa = screen.getDisplayMatching(b).workArea, [w, h] = [280, 400];
  const x = Math.min(wa.x + wa.width - w, Math.max(wa.x, b.x + b.width / 2 - w / 2));
  const y = b.y - h - 6 >= wa.y ? b.y - h - 6 : Math.min(wa.y + wa.height - h, b.y + b.height + 6);
  panel.setPosition(Math.round(x), Math.round(y)); panel.show(); panel.focus();
}
function togglePanel() {
  if (panel && !panel.isDestroyed() && panel.isVisible()) { panel.hide(); return; }
  if (Date.now() - panelHiddenAt < 300) return; // 点宠物会让面板先失焦隐藏，避免马上又弹出
  showPanel();
}
function openDashboard(tab) {
  if (panel && !panel.isDestroyed()) panel.hide();
  if (dash && !dash.isDestroyed()) { dash.show(); dash.focus(); if (tab) send(dash, 'goto', tab); return; }
  dash = new BrowserWindow({ width: 1040, height: 720, minWidth: 840, minHeight: 580, title: 'NetPet', autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.png'), webPreferences: webPrefs() });
  dash.loadFile(path.join(__dirname, 'dashboard.html'));
  if (tab) dash.webContents.once('did-finish-load', () => send(dash, 'goto', tab));
  dash.on('closed', () => { dash = null; });
}
function syncVisibility() {
  if (!pet) return;
  const show = !R.userHidden && !R.fsHidden;
  show ? pet.show() : pet.hide();
  if (!show && panel && !panel.isDestroyed()) panel.hide();
}

/* ---------- 菜单 / 托盘 ---------- */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '显示宠物', enabled: R.userHidden, click: () => { R.userHidden = false; syncVisibility(); refreshMenu(); } },
    { label: '隐藏宠物', enabled: !R.userHidden, click: () => { R.userHidden = true; syncVisibility(); refreshMenu(); } },
    { label: '打开主面板', click: () => openDashboard() },
    { type: 'separator' },
    { label: '暂停监控', type: 'checkbox', checked: R.paused, click: (i) => setRuntime({ paused: i.checked }) },
    { label: '勿扰模式', type: 'checkbox', checked: R.dnd, click: (i) => setRuntime({ dnd: i.checked }) },
    { label: '鼠标穿透（宠物不可点击）', type: 'checkbox', checked: R.passthrough, click: (i) => setRuntime({ passthrough: i.checked }) },
    { label: '切换宠物', submenu: PETS.map((p) => ({ label: `${p.emoji} ${p.name}`, type: 'radio', checked: S.pet === p.id, click: () => applyPatch({ pet: p.id }) })) },
    { type: 'separator' },
    { label: '设置', click: () => openDashboard('set') },
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => applyPatch({ autostart: i.checked }) },
    { label: '退出软件', click: () => app.quit() }
  ]);
}
const refreshMenu = () => { if (tray) tray.setContextMenu(buildMenu()); };
function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 32, height: 32 }));
    tray.setToolTip('NetPet'); refreshMenu();
    tray.on('click', () => { R.userHidden = !R.userHidden; syncVisibility(); refreshMenu(); });
    tray.on('double-click', () => openDashboard());
  } catch (_) { tray = null; }
}

/* ---------- 运行时开关 / 设置补丁（所有参数都做校验）---------- */
const mutedList = () => (R.dnd ? Object.keys(DEFAULTS.anim) : Object.keys(S.anim).filter((k) => !S.anim[k]));
const fsm = new PetStateMachine();
function setRuntime(p) {
  if (typeof p.paused === 'boolean') { R.paused = p.paused; fsm.reset(Date.now()); }
  if (typeof p.dnd === 'boolean') { R.dnd = p.dnd; fsm.setMuted(mutedList()); }
  if (typeof p.passthrough === 'boolean' && pet) { R.passthrough = p.passthrough; pet.setIgnoreMouseEvents(R.passthrough, { forward: true }); }
  syncProcTraffic();
  sendAll('runtime', { ...R }); publish(true); refreshMenu();
}
function onPrivacyChanged() {
  syncProcTraffic();
  if (!S.privacy.conn) seen.clear();
  if (S.privacy.fullscreenHide) fullscreen.start((hidden) => { R.fsHidden = hidden; syncVisibility(); });
  else { fullscreen.stop(); R.fsHidden = false; syncVisibility(); }
  fsm.reset(Date.now()); publish(true);
}
function applyPatch(p) {
  p = p && typeof p === 'object' ? p : {};
  if (p.privacy && typeof p.privacy === 'object') {
    for (const k of Object.keys(DEFAULTS.privacy)) if (typeof p.privacy[k] === 'boolean') S.privacy[k] = p.privacy[k];
    save('privacy'); onPrivacyChanged();
  }
  if (typeof p.autostart === 'boolean') app.setLoginItemSettings({ openAtLogin: p.autostart });
  if (typeof p.alwaysOnTop === 'boolean') { S.alwaysOnTop = p.alwaysOnTop; if (pet) pet.setAlwaysOnTop(p.alwaysOnTop, 'screen-saver'); save('alwaysOnTop'); }
  if ([80, 85, 90, 95].includes(p.memAlert)) { S.memAlert = p.memAlert; save('memAlert'); }
  if ([7, 30, 90].includes(p.retentionDays)) { S.retentionDays = p.retentionDays; try { db.prune(S.retentionDays); } catch (_) {} save('retentionDays'); }
  if (typeof p.pet === 'string' && PETS.some((x) => x.id === p.pet)) { S.pet = p.pet; sendAll('settings', { pet: S.pet }); save('pet'); }
  if (p.anim && typeof p.anim === 'object') {
    for (const k of Object.keys(DEFAULTS.anim)) if (typeof p.anim[k] === 'boolean') S.anim[k] = p.anim[k];
    fsm.setMuted(mutedList()); save('anim');
  }
  refreshMenu();
}

/* ---------- 实时采样 ---------- */
const VIRT = /loopback|vethernet|vmware|virtualbox|vbox|hyper-v|\btap\b|\btun\b|wintun|wireguard|tailscale|zerotier|clash|sing-?box|meta|bluetooth|pseudo|npcap|docker|wsl/i;
const LABEL = { SLEEP: '空闲中', DOWNLOAD: '↓ 下载中', UPLOAD: '↑ 上传中', TIRED: 'CPU 繁忙', HOT: '温度偏高', SWEAT: '内存紧张', WARNING: '有健康提醒', HAPPY: '', IDLE: '' };
const M = { rx: null, tx: null, online: true, cpu: null, memPct: null, memUsed: 0, memTotal: os.totalmem(), temp: null, healthBad: false, state: 'IDLE' };
let tickN = 0, skip = 0, offN = 0, onN = 0, lastTemp = 0, lastHw = 0, lastMemNotify = 0, minBytes = 0, lastPub = '', timer = null, connTimer = null, quitting = false;

async function readNet() {
  const up = (await si.networkStats('*')).filter((s) => s.operstate === 'up');
  const phys = up.filter((s) => !VIRT.test(s.iface || '')), use = phys.length ? phys : up; // 优先只算物理网卡，避免 TUN/虚拟网卡重复计数
  let rx = 0, tx = 0;
  for (const s of use) { rx += s.rx_sec > 0 ? s.rx_sec : 0; tx += s.tx_sec > 0 ? s.tx_sec : 0; }
  return rx > 5e9 || tx > 5e9 ? { rx: 0, tx: 0 } : { rx, tx }; // 计数器重置/异常值直接丢弃
}
const hasIPv4 = () => Object.values(os.networkInterfaces()).some((l) => (l || []).some((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')));
function netEvent(up) {
  const t = up ? '网络已恢复' : '网络已断开';
  notify(t, up ? '网络连接已恢复。' : '检测不到可用的网络连接。'); try { db.addWarning('info', t, ''); } catch (_) {}
}
function publish(force) {
  const label = R.paused ? '已暂停监控' : (S.privacy.net && !M.online) ? '网络已断开' : LABEL[M.state] || '';
  const p = { state: M.state, label, paused: R.paused, dnd: R.dnd, online: S.privacy.net ? M.online : null };
  const key = JSON.stringify(p);
  if (!force && key === lastPub) return;
  lastPub = key; sendAll('pstate', p);
}
async function tick() {
  tickN++;
  const now = Date.now();
  if (!R.paused) {
    if (S.privacy.net) {
      try {
        const n = await readNet();
        if (skip > 0) { skip--; M.rx = 0; M.tx = 0; } else { M.rx = n.rx; M.tx = n.tx; db.addTraffic(n.rx, n.tx); minBytes += n.rx + n.tx; }
      } catch (_) { M.rx = 0; M.tx = 0; }
      const o = hasIPv4();
      if (o === M.online) { offN = onN = 0; }
      else if (o) { if (++onN >= 2) { M.online = true; onN = 0; netEvent(true); } }
      else if (++offN >= 2) { M.online = false; offN = 0; netEvent(false); }
      if (!M.online) { M.rx = 0; M.tx = 0; }
    } else { M.rx = M.tx = null; }
    if (S.privacy.hw) {
      if (tickN % 3 === 0) {
        try {
          M.cpu = (await si.currentLoad()).currentLoad; M.memTotal = os.totalmem(); M.memUsed = M.memTotal - os.freemem(); M.memPct = (M.memUsed / M.memTotal) * 100;
          if (now - lastTemp > 20000) { lastTemp = now; try { const t = await si.cpuTemperature(); M.temp = t && t.main > 0 ? t.main : null; } catch (_) {} }
          const smp = { cpu: M.cpu, used: M.memUsed, total: M.memTotal, pct: M.memPct, temp: M.temp };
          send(dash, 'sample', smp); send(panel, 'sample', smp);
          if (now - lastHw > 60000) { lastHw = now; try { db.addHardware(now, M.cpu, M.memPct, M.temp); } catch (_) {} }
          if (M.memPct >= S.memAlert && now - lastMemNotify > 10 * 60e3) { lastMemNotify = now; notify('内存使用率偏高', `当前内存占用 ${M.memPct.toFixed(0)}%。可以在面板里查看占用排行。`); }
        } catch (_) {}
      }
    } else { M.cpu = M.memPct = M.temp = null; }
  }
  const input = R.paused ? { rx: null, tx: null, cpu: null, memPct: null, temp: null, memAlert: S.memAlert, warning: false }
    : { rx: M.rx, tx: M.tx, cpu: M.cpu, memPct: M.memPct, temp: M.temp, memAlert: S.memAlert, warning: M.healthBad };
  M.state = fsm.update(now, input);
  publish(false);
  if (S.privacy.net && !R.paused) {
    const sp = { rx: M.rx, tx: M.tx, online: M.online };
    sendAll('speed', sp);
    if (tray) tray.setToolTip(`NetPet\n↓ ${fmt(M.rx)}\n↑ ${fmt(M.tx)}`);
  } else { sendAll('speed', { rx: null, tx: null, online: null }); if (tray) tray.setToolTip(R.paused ? 'NetPet（已暂停监控）' : 'NetPet'); }
  if (tickN % 60 === 0 && !R.paused && (S.privacy.net || S.privacy.hw)) { S.growth.xp += 1 + (minBytes / 1e9) * 5; minBytes = 0; if (tickN % 300 === 0) save('growth'); }
}
const loop = async () => { try { await tick(); } catch (_) {} if (!quitting) timer = setTimeout(loop, 1000); };

/* ---------- 按程序流量（ETW，默认关闭，需管理员权限）----------
   原生组件只在 Windows 上存在；不开开关就不启动 ETW 会话，不提权。
   原生返回“自会话开始累计值”，这里每 2 秒换算速率、按程序名聚合，
   每 30 秒把增量写进本地库。累计值变小（PID 复用/会话重启）时按新进程处理。 */
const PT = { prev: new Map(), rows: [], status: { running: false, mode: 'unavailable' }, lastSave: 0, timer: null };
function syncProcTraffic() {
  if (R.paused || !S.privacy.procTraffic || process.platform !== 'win32') {
    try { procnet.stop(); } catch (_) {}
    PT.status = procnet.getStatus ? procnet.getStatus() : PT.status;
    PT.prev = new Map(); PT.rows = [];
    return;
  }
  if (!procnet.isAvailable()) { PT.status = { running: false, mode: 'unavailable', error: procnet.loadReason() }; return; }
  const r = procnet.start();
  PT.status = { ...procnet.getStatus(), startError: r && r.ok === false ? r.error : '' };
  if (r && r.ok === false) { PT.prev = new Map(); PT.rows = []; }
}
function procTick() {
  if (R.paused || !S.privacy.procTraffic) return;
  const st = procnet.getStatus();
  PT.status = st;
  if (!st.running) return;
  const now = Date.now();
  const { rows, deltas, next } = procnet.aggregate(procnet.getTotals(), PT.prev, now);
  PT.prev = next; PT.rows = rows;
  if (now - PT.lastSave >= 30000 && deltas.length) { PT.lastSave = now; try { db.addProcTraffic(deltas); } catch (_) {} }
  send(dash, 'proc-traffic', { status: st, rows, top: (() => { try { return db.procTrafficTop(10); } catch (_) { return []; } })() });
}

/* ---------- 连接元数据（仅记录：哪个程序连了哪个地址，不含任何通信内容）---------- */
const seen = new Map(), hostCache = new Map();
const isLocal = (ip) => !ip || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|::$|fe80|f[cd][0-9a-f]{2}:)/i.test(ip);
function noteFor(c) {
  const p = Number(c.peerPort);
  if (security.NOTABLE_PORTS[p]) return `使用了${security.NOTABLE_PORTS[p]}（仅供参考，不代表一定有问题）`;
  if (/^(wscript|cscript|mshta|rundll32)/i.test(c.process || '')) return '由脚本/系统工具发起的连接（仅供参考）';
  return '';
}
async function resolveHost(ip) {
  if (!S.privacy.dns) return ''; // 反向解析会把对方 IP 发给 DNS 服务器，所以默认关闭，需用户主动开启
  if (hostCache.has(ip)) return hostCache.get(ip);
  hostCache.set(ip, '');
  try { const n = await Promise.race([dns.reverse(ip), new Promise((_, r) => setTimeout(() => r(new Error('t')), 1500))]); hostCache.set(ip, n[0] || ''); } catch (_) {}
  return hostCache.get(ip);
}
async function connTick() {
  if (R.paused || !S.privacy.conn) return;
  try {
    const now = Date.now(), fresh = [];
    for (const c of await si.networkConnections()) {
      if (c.state !== 'ESTABLISHED' || isLocal(c.peerAddress)) continue;
      const key = `${c.process || c.pid}|${c.peerAddress}|${c.peerPort}`, isNew = !seen.has(key);
      seen.set(key, now); if (isNew) fresh.push(c);
    }
    const rows = await Promise.all(fresh.map(async (c) => ({ t: now, proc: c.process || `PID ${c.pid}`, pid: c.pid, ip: c.peerAddress, port: Number(c.peerPort), host: await resolveHost(c.peerAddress), proto: c.protocol, note: noteFor(c) })));
    db.addConnections(rows);
    for (const [k, t] of seen) if (now - t > 10 * 60e3) seen.delete(k);
  } catch (_) {}
}

/* ---------- 健康检查 ---------- */
async function runHealth() {
  const ctx = {
    memPct: M.memPct, cpu: M.cpu,
    baseline: (k) => S.baselines[k], setBaseline: (k, v) => { S.baselines[k] = v; }
  };
  const rep = await security.run(si, ctx);
  save('baselines');
  try { db.addHealth(rep); for (const i of rep.items) if (i.status === 'bad' || i.status === 'warn') db.addWarning(i.status, i.title, i.detail); } catch (_) {}
  const wasBad = M.healthBad;
  M.healthBad = rep.items.some((i) => i.status === 'bad');
  if (M.healthBad && !wasBad) notify('系统健康检查发现异常项', '打开主面板 → 系统健康 查看依据和建议。');
  fsm.update(Date.now(), { rx: M.rx, tx: M.tx, cpu: M.cpu, memPct: M.memPct, temp: M.temp, memAlert: S.memAlert, warning: M.healthBad });
  return rep;
}

/* ---------- 窗口交互 IPC ---------- */
function setupIpc() {
  on('drag-start', () => { if (pet) pet._o = pet.getPosition(); });
  on('drag-move', (d) => { if (pet && pet._o && d) pet.setPosition(Math.round(pet._o[0] + clamp(d.dx, -5000, 5000, 0)), Math.round(pet._o[1] + clamp(d.dy, -5000, 5000, 0))); });
  on('drag-end', () => { if (pet) { S.bounds = pet.getBounds(); save('bounds'); } });
  on('pet-click', togglePanel);
  on('pet-dblclick', () => openDashboard());
  on('pet-menu', () => buildMenu().popup({ window: pet }));
  on('panel-open-main', () => openDashboard());

  let cache = { disks: [0, []], gpu: [0, []], ifs: [0, []] };
  const cached = async (k, ms, fn) => { if (Date.now() - cache[k][0] > ms) { try { cache[k] = [Date.now(), await fn()]; } catch (_) { cache[k] = [Date.now(), []]; } } return cache[k][1]; };

  handle('get-system', async () => {
    const out = { today: S.privacy.net ? db.today() : null, month: S.privacy.net ? db.month() : null, netOn: S.privacy.net, hwOn: S.privacy.hw, uptime: os.uptime() };
    if (!S.privacy.hw) return out;
    out.disks = (await cached('disks', 10000, () => si.fsSize())).filter((d) => d.size > 0).map((d) => ({ mount: d.mount, size: d.size, used: d.used, pct: d.use }));
    out.gpu = await cached('gpu', 15000, async () => (await si.graphics()).controllers.map((c) => ({ name: c.model, util: c.utilizationGpu ?? null, memUsed: c.memoryUsed ?? null, memTotal: c.memoryTotal ?? c.vram ?? null })));
    out.temp = M.temp;
    try { const b = await si.battery(); out.battery = b && b.hasBattery ? { pct: b.percent, charging: b.isCharging } : null; } catch (_) { out.battery = null; }
    try { out.summary = db.hardwareSummary(24); } catch (_) {}
    return out;
  });
  handle('get-processes', async () => {
    if (!S.privacy.proc) return { disabled: true };
    const l = (await si.processes()).list.filter((x) => x.name).map((x) => ({ pid: x.pid, name: x.name, mem: x.memRss * 1024, cpu: x.cpu }));
    return { byMem: [...l].sort((a, b) => b.mem - a.mem).slice(0, 8), byCpu: [...l].sort((a, b) => b.cpu - a.cpu).slice(0, 8) };
  });
  handle('get-adapters', async () => {
    if (!S.privacy.net) return { disabled: true };
    const l = (await cached('ifs', 20000, () => si.networkInterfaces())).filter((x) => !x.internal).map((x) => ({ name: x.iface, type: x.type, speed: x.speed, ip4: x.ip4, up: x.operstate === 'up', virtual: !!x.virtual || VIRT.test(x.iface || '') }));
    try { db.saveAdapters(l); } catch (_) {}
    return { list: l };
  });
  handle('open-taskmgr', () => { if (process.platform !== 'win32') return false; execFile('taskmgr.exe', [], { windowsHide: false }, () => {}); return true; });

  handle('get-proc-traffic', () => {
    const st = PT.status && PT.status.running !== undefined ? PT.status : procnet.getStatus();
    let top = [];
    try { top = db.procTrafficTop(10); } catch (_) {}
    return { disabled: !S.privacy.procTraffic, available: procnet.isAvailable(), loadReason: procnet.loadReason(), status: st, rows: PT.rows, top };
  });
  handle('get-records', (a) => {
    const days = [1, 3, 7, 30].includes(a && a.days) ? a.days : 1;
    const base = { today: db.today(), month: db.month(), connOn: S.privacy.conn };
    return S.privacy.conn ? { ...base, ...db.connections(days, str(a && a.q)) } : { ...base, rows: [], total: 0, byProc: [], byHost: [] };
  });
  handle('export-csv', async (a) => {
    const days = [1, 3, 7, 30].includes(a && a.days) ? a.days : 1;
    const r = await dialog.showSaveDialog(dash, { defaultPath: 'netpet-connections.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    require('fs').writeFileSync(r.filePath, db.toCsv(db.connections(days, str(a && a.q), 100000).rows));
    return { ok: true, path: r.filePath };
  });
  handle('clear-records', () => { db.clearConnections(); seen.clear(); return true; });
  handle('clear-all', () => { db.clearAll(); seen.clear(); return true; });
  handle('backup-db', async () => {
    const r = await dialog.showSaveDialog(dash, { defaultPath: 'netpet-backup.db', filters: [{ name: 'SQLite', extensions: ['db'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    try { db.backup(r.filePath); return { ok: true, path: r.filePath }; } catch (e) { return { ok: false, msg: String(e.message || e) }; }
  });
  handle('open-data-dir', () => { shell.openPath(app.getPath('userData')); return true; });
  handle('db-status', () => ({ ...db.status(), dataDir: app.getPath('userData') }));

  handle('run-security', async () => (S.privacy.health ? runHealth() : { disabled: true }));
  handle('last-security', () => db.lastHealth());
  handle('get-warnings', () => db.warnings(50));
  handle('quick-scan', async () => {
    if (!S.privacy.health) return false;
    const ok = await security.quickScan();
    notify('Defender 快速扫描', ok ? '扫描完成，结果请在 Windows 安全中心查看。' : '扫描没有成功完成（可能需要管理员权限）。');
    return ok;
  });

  handle('get-settings', () => ({
    privacy: S.privacy, alwaysOnTop: S.alwaysOnTop, retentionDays: S.retentionDays, pet: S.pet, memAlert: S.memAlert, anim: S.anim,
    autostart: app.getLoginItemSettings().openAtLogin, hasLock: !!S.lock, packaged: app.isPackaged, onboarded: S.onboarded, version: app.getVersion(), dataDir: app.getPath('userData')
  }));
  handle('set-settings', (p) => { applyPatch(p); return true; });
  handle('ack-privacy', () => { S.onboarded = true; save('onboarded'); return true; });
  handle('get-runtime', () => ({ ...R, state: M.state }));
  handle('set-runtime', (p) => { setRuntime(p && typeof p === 'object' ? p : {}); return true; });
  handle('get-growth', () => {
    const xp = Math.floor(S.growth.xp), level = Math.floor(Math.sqrt(xp / 30)) + 1, st = db.stats();
    return { xp, level, cur: 30 * (level - 1) ** 2, next: 30 * level ** 2, daysUsed: st.daysUsed, total: st.total };
  });
  handle('get-achievements', () => {
    const s = db.stats(), MB = 1048576, GB = 1073741824;
    return [
      { name: '速度先锋', desc: '下载速度达到 10 MB/s', done: s.peakRx >= 10 * MB }, { name: '破百兆', desc: '下载速度达到 100 MB/s', done: s.peakRx >= 100 * MB },
      { name: '流量小仓鼠', desc: '累计用掉 10 GB 流量', done: s.total >= 10 * GB }, { name: '流量鲸鱼', desc: '累计用掉 100 GB 流量', done: s.total >= 100 * GB },
      { name: '陪伴一周', desc: '小宠物陪你满 7 天', done: s.daysUsed >= 7 }
    ];
  });
  const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
  handle('lock-status', () => !!S.lock);
  handle('unlock', (pw) => !!S.lock && hash(str(pw, 64), S.lock.salt) === S.lock.hash);
  handle('set-password', (pw) => {
    pw = str(pw, 64);
    if (!pw) S.lock = null; else { const salt = crypto.randomBytes(16).toString('hex'); S.lock = { salt, hash: hash(pw, salt) }; }
    save('lock'); return !!S.lock;
  });
}

/* ---------- 生命周期 ---------- */
app.on('web-contents-created', (_e, c) => { c.on('will-navigate', (e) => e.preventDefault()); c.setWindowOpenHandler(() => ({ action: 'deny' })); });
app.whenReady().then(() => {
  if (!gotLock) return;
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  Menu.setApplicationMenu(null);
  const st = db.init(path.join(app.getPath('userData'), 'data'));
  loadSettings(); fsm.setMuted(mutedList());
  if (st.ok) { try { db.prune(S.retentionDays); } catch (_) {} }
  createPet(); createTray(); setupIpc();
  powerMonitor.on('suspend', () => db.flush());
  powerMonitor.on('resume', () => { skip = 3; fsm.reset(Date.now()); });
  if (S.privacy.fullscreenHide) onPrivacyChanged();
  loop(); connTimer = setInterval(connTick, 8000);
  syncProcTraffic(); PT.timer = setInterval(procTick, 2000);
  if (S.privacy.health) setTimeout(() => { runHealth().catch(() => {}); }, 30000);
  if (!st.ok) dialog.showMessageBox({ type: 'warning', title: 'NetPet', message: '本地数据库不可用', detail: `设置和统计将无法保存。\n原因：${st.error}` });
  else if (st.recovered) dialog.showMessageBox({ type: 'warning', title: 'NetPet', message: '数据库文件已损坏，已自动重建', detail: '旧文件已保留（文件名含 .corrupt-），设置已恢复为默认值。' });
  if (!S.onboarded) openDashboard('pri');
  if (process.env.NETPET_TEST) global.__np = { openDashboard, togglePanel, applyPatch, setRuntime, wins: () => ({ pet, dash, panel }), S: () => S, M, runHealth, procStatus: () => PT.status, procRows: () => PT.rows };
});
app.on('second-instance', () => openDashboard());
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  quitting = true; clearTimeout(timer); clearInterval(connTimer);
  save('growth'); try { clearInterval(PT.timer); procnet.stop(); } catch (_) {} fullscreen.stop(); security.killAll(); // 不留下任何后台子进程
  try { si.powerShellRelease(); } catch (_) {}
  db.close();
});
