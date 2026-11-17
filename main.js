// NetPet V0.1 — 宠物窗口 + 聚合网速 + 托盘 + 自启开关
// 不做：结束进程、上网记录、系统体检、Defender 扫描、反向解析。见 NetPet-规范-V1.1-修订版.md
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const si = require('systeminformation');
const store = require('./store');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let pet = null, dash = null, tray = null;
let settings = { alwaysOnTop: true, bounds: null, retentionDays: 7, skin: 'peach', memAlert: 85, monitoring: true, dnd: false };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const loadSettings = () => { try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch (_) {} };
const saveSettings = () => { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (_) {} };
const send = (w, ch, d) => { if (w && !w.isDestroyed()) w.webContents.send(ch, d); };
const notify = (title, body) => {
  if (settings.dnd) return;
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch (_) {}
};
const fmt = (b) => (b < 1024 ? `${Math.round(b)} B/s` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB/s` : `${(b / 1048576).toFixed(1)} MB/s`);

const WEB_PREFS = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false
};

function createPet() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const b = settings.bounds;
  pet = new BrowserWindow({
    width: 170, height: 160, x: b ? b.x : width - 190, y: b ? b.y : height - 180,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, skipTaskbar: true, hasShadow: false,
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: WEB_PREFS
  });
  if (settings.alwaysOnTop) pet.setAlwaysOnTop(true, 'screen-saver');
  pet.loadFile('index.html');
  pet.webContents.on('did-finish-load', () => {
    send(pet, 'settings', { skin: settings.skin });
    send(pet, 'status', { monitoring: settings.monitoring });
  });
  pet.on('moved', () => { settings.bounds = pet.getBounds(); saveSettings(); });
}

function openDashboard(tab) {
  if (dash && !dash.isDestroyed()) { dash.show(); dash.focus(); if (tab) send(dash, 'goto', tab); return; }
  dash = new BrowserWindow({
    width: 900, height: 620, minWidth: 760, minHeight: 520, title: 'NetPet',
    autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: WEB_PREFS
  });
  dash.loadFile('dashboard.html');
  if (tab) dash.webContents.once('did-finish-load', () => send(dash, 'goto', tab));
  dash.on('closed', () => { dash = null; });
}

function togglePet() {
  if (!pet) return;
  pet.isVisible() ? pet.hide() : pet.show();
  if (tray) tray.setContextMenu(buildMenu());
}
function toggleMonitoring() {
  settings.monitoring = !settings.monitoring;
  saveSettings();
  send(pet, 'status', { monitoring: settings.monitoring });
  send(dash, 'status', { monitoring: settings.monitoring });
  if (tray) tray.setContextMenu(buildMenu());
}
function buildMenu() {
  const visible = pet && pet.isVisible();
  return Menu.buildFromTemplate([
    { label: '打开面板', click: () => openDashboard() },
    { label: visible ? '藏起小宠物' : '放出小宠物', click: togglePet },
    { type: 'separator' },
    { label: settings.monitoring ? '暂停监控' : '恢复监控', click: toggleMonitoring },
    { label: '勿扰模式', type: 'checkbox', checked: settings.dnd, click: (i) => { settings.dnd = i.checked; saveSettings(); if (tray) tray.setContextMenu(buildMenu()); } },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: '始终置顶', type: 'checkbox', checked: settings.alwaysOnTop, click: (i) => applySettings({ alwaysOnTop: i.checked }) },
    { type: 'separator' },
    { label: '设置', click: () => openDashboard('set') },
    { label: '退出', click: () => app.quit() }
  ]);
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')));
  tray.setToolTip('NetPet');
  tray.setContextMenu(buildMenu());
  tray.on('click', togglePet);
  tray.on('double-click', () => openDashboard());
}
function applySettings(p) {
  if (typeof p !== 'object' || p === null) return;
  const next = { ...settings };
  if (typeof p.alwaysOnTop === 'boolean') next.alwaysOnTop = p.alwaysOnTop;
  if (typeof p.monitoring === 'boolean') next.monitoring = p.monitoring;
  if (typeof p.dnd === 'boolean') next.dnd = p.dnd;
  if (typeof p.skin === 'string' && ['peach', 'mint', 'lavender'].includes(p.skin)) next.skin = p.skin;
  if (typeof p.memAlert === 'number' && p.memAlert >= 80 && p.memAlert <= 95) next.memAlert = p.memAlert;
  if (typeof p.retentionDays === 'number' && [7, 30, 90].includes(p.retentionDays)) next.retentionDays = p.retentionDays;
  if (typeof p.autostart === 'boolean') app.setLoginItemSettings({ openAtLogin: p.autostart });
  settings = next;
  if ('alwaysOnTop' in p && pet) pet.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  if ('skin' in p) send(pet, 'settings', { skin: settings.skin });
  if ('retentionDays' in p) store.prune(settings.retentionDays);
  if ('monitoring' in p) send(pet, 'status', { monitoring: settings.monitoring });
  saveSettings();
  if (tray) tray.setContextMenu(buildMenu());
}

// 实时采样：仅聚合网速，1 秒一次；暂停时不采样
let wasUp = null;
async function tick() {
  if (!settings.monitoring) return;
  try {
    let rx = 0, tx = 0;
    for (const s of await si.networkStats('*')) {
      if (s.operstate !== 'up') continue;
      rx += Math.max(0, s.rx_sec || 0); tx += Math.max(0, s.tx_sec || 0);
    }
    const up = rx + tx > 0;
    if (wasUp === true && !up) notify('网络断开了', '当前没有上下行流量，可能是断网或空闲。');
    if (wasUp === false && up) notify('网络恢复了', '又检测到上下行流量了。');
    wasUp = up;
    store.addTraffic(rx, tx);
    tray.setToolTip(`NetPet\n↓ ${fmt(rx)}\n↑ ${fmt(tx)}`);
    send(pet, 'speed', { rx, tx }); send(dash, 'speed', { rx, tx });
  } catch (_) {}
}

function setupIpc() {
  ipcMain.on('drag-start', () => { if (pet) pet._o = pet.getPosition(); });
  ipcMain.on('drag-move', (_e, d) => {
    if (pet && pet._o && d && Number.isFinite(d.dx) && Number.isFinite(d.dy)) {
      pet.setPosition(Math.round(pet._o[0] + d.dx), Math.round(pet._o[1] + d.dy));
    }
  });
  ipcMain.on('pet-click', () => openDashboard());
  ipcMain.on('pet-menu', () => buildMenu().popup({ window: pet }));

  ipcMain.handle('get-stats', () => ({ today: store.today(), month: store.month(), stats: store.stats() }));
  ipcMain.handle('get-settings', () => ({
    alwaysOnTop: settings.alwaysOnTop, retentionDays: settings.retentionDays,
    skin: settings.skin, memAlert: settings.memAlert,
    monitoring: settings.monitoring, dnd: settings.dnd,
    autostart: app.getLoginItemSettings().openAtLogin,
    packaged: app.isPackaged, userData: app.getPath('userData')
  }));
  ipcMain.handle('set-settings', (_e, p) => { applySettings(p); return true; });
  ipcMain.handle('clear-traffic', () => { store.clear(); return true; });
  ipcMain.handle('open-task-manager', () => {
    // 合规替代“结束进程”：只打开系统任务管理器，由用户自己操作，NetPet 不动任何进程。
    if (process.platform !== 'win32') return { ok: false, msg: '只在 Windows 上支持。' };
    execFile('taskmgr.exe', { windowsHide: true }, () => {});
    return { ok: true };
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  Menu.setApplicationMenu(null);
  loadSettings();
  store.init(path.join(app.getPath('userData'), 'data'));
  store.prune(settings.retentionDays);
  createPet(); createTray(); setupIpc();
  tick(); setInterval(tick, 1000);
});
app.on('second-instance', () => openDashboard());
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => store.flush());
