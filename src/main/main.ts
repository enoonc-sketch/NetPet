import { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification, dialog, powerMonitor, session, shell, safeStorage } from 'electron';
import * as secure from './secure';
import * as memtrim from './memtrim';
import { quotaStep, NewProcWatcher, Reminder } from './extras';
import * as selfupdate from './selfupdate';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { promises as dns } from 'node:dns';
import { execFile } from 'node:child_process';
import { collect, stopCollector } from './collect';
import * as netmon from './netmon';
import { initLog, log } from './logger';
import * as db from './db';
import * as security from './security';
import * as fullscreen from './fullscreen';
import * as cleaner from './cleaner';
import * as startup from './startup';
import * as vpn from './vpn';
import * as winupdate from './winupdate';
import { probeOnce, ProbeState } from './probe';
import { clampPetBounds, defaultPetBounds, petSize } from './petgeom';
import { PetStateMachine } from './petstate';
import { hasUsableAddress, RateBudget, sampleSeconds } from './guards';
import { PETS } from '../shared/petlist';

app.setPath('userData', path.join(app.getPath('appData'), 'NetPet'));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/* 启动保护：每次启动先写一个标记，等宠物窗口真正画出来、采样跑起来后再删除。
   如果上次启动没完成（卡死/崩溃），这次自动进入安全模式（关闭硬件加速、3D 和所有可选监控）。 */
const userDir = app.getPath('userData');
const flagPath = path.join(userDir, 'starting.flag');
const safeFile = path.join(userDir, 'safe.mode');
let SAFE = false, startOk = false, petReady = false;
if (gotLock) {
  try { fs.mkdirSync(userDir, { recursive: true }); } catch (_) {}
  initLog(path.join(userDir, 'logs'));
  // 上次没启动成功 → 进入安全模式，并一直保持，直到用户在面板里点“重启并退出安全模式”（避免又回到会卡死的配置）
  const auto = fs.existsSync(flagPath);
  if (auto) { try { fs.writeFileSync(safeFile, '1'); } catch (_) {} }
  SAFE = process.argv.includes('--safe') || auto || fs.existsSync(safeFile);
  try { fs.writeFileSync(flagPath, String(Date.now())); } catch (_) {}
  if (SAFE) app.disableHardwareAcceleration();
  log(`启动 v${app.getVersion()} electron=${process.versions.electron} 安全模式=${SAFE}`);
  process.on('uncaughtException', (e: any) => log('uncaughtException ' + ((e && e.stack) || e)));
  process.on('unhandledRejection', (e: any) => log('unhandledRejection ' + ((e && e.stack) || e)));
}
const maybeClearFlag = () => { if (!startOk && petReady && tickN >= 2) { startOk = true; try { fs.unlinkSync(flagPath); } catch (_) {} log('启动完成'); } };
const startedAt = Date.now();
// 所有系统信息采集都走独立的采集进程（见 collector.ts），主进程不直接调用 systeminformation
const si: any = {
  networkStats: () => collect('networkStats', 6000), networkConnections: () => collect('networkConnections', 15000), networkInterfaces: () => collect('networkInterfaces', 20000),
  currentLoad: () => collect('currentLoad', 6000), cpuTemperature: () => collect('cpuTemperature', 10000), fsSize: () => collect('fsSize', 10000),
  graphics: () => collect('graphics', 20000), battery: () => collect('battery', 8000), processes: () => collect('processes', 15000)
};
let petRecreateTimer: any = null, petRecreateN = 0, quitting = false;
// 按时间窗口计数：5 分钟内最多自动重建 3 次（旧版 pet-ready 会清零计数，加载后才崩溃时会无限重建）
const recreateBudget = new RateBudget(3, 5 * 60e3);
const recreateBudgetLeft = () => recreateBudget.left();
function schedulePetRecreate(reason: string) {
  // 旧版只记日志不重建：3D/WebGL 渲染进程一崩，透明窗口就剩一个空白框，看起来就是宠物“没了”。
  if (quitting || petRecreateTimer) return;
  if (!recreateBudgetLeft()) { log(`宠物渲染进程多次崩溃(${reason})，已停止自动重建，请用托盘菜单“一键复位小宠物”`); notify('小宠物渲染失败', '宠物窗口多次崩溃已停止自动重建，请右键托盘图标 → 一键复位小宠物。'); return; }
  petRecreateTimer = setTimeout(() => {
    petRecreateTimer = null; petRecreateN++; recreateBudget.use();
    log(`重建宠物窗口(${reason})，第 ${petRecreateN} 次`);
    try { if (pet && !pet.isDestroyed()) pet.destroy(); } catch (_) {}
    pet = null; createPet(); syncVisibility();
  }, 1500);
}
function watch(name: string, w: BrowserWindow) {
  w.on('unresponsive', () => log(`${name}窗口无响应`)); w.on('responsive', () => log(`${name}窗口恢复响应`));
  w.webContents.on('render-process-gone', (_e, d) => {
    log(`${name}渲染进程退出 reason=${d.reason} code=${d.exitCode}`);
    if (name === '宠物') schedulePetRecreate(String(d.reason || 'gone'));
  });
}

/* ---------- 设置 ---------- */
const DEFAULTS = {
  compact: false,
  privacy: { net: true, hw: true, conn: false, dns: false, proc: false, health: false, fullscreenHide: false, probe: false },
  pet: 'cat', alwaysOnTop: true, bounds: null, retentionDays: 30, memAlert: 90,
  anim: { DOWNLOAD: true, UPLOAD: true, TIRED: true, HOT: true, SWEAT: true, WARNING: true },
  memTrim: { auto: false, threshold: 90, skipFg: true }, lastTrim: null,
  quota: { gb: 0, notified: 0, month: '' }, lastSelfUpd: null, newProc: { on: false, learnUntil: 0, known: [] as string[] }, remind: { sit: 0, water: 0 },
  lock: null, onboarded: false, growth: { xp: 0 }, baselines: {},
  vpn: { exe: '', config: '', sysProxy: true }, vpnProxyBackup: null, lastUpdateCheck: null
};
let S: any = structuredClone(DEFAULTS);
const R: any = { paused: false, dnd: false, passthrough: false, userHidden: false, fsHidden: false, resetShowUntil: 0 };
const cipher: secure.Cipher = {
  available: () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } },
  encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b)
};
const ENC = { available: false, failed: [] as string[] }; // 给隐私页显示
const save = (...keys: string[]) => { try { db.saveSettings(Object.fromEntries(keys.map((k) => [k, secure.seal(k, S[k], cipher)]))); } catch (_) {} };
function loadSettings() {
  const o: any = db.loadSettings();
  // 解密敏感设置；旧版本留下的明文在加密可用时立即改存为密文
  ENC.available = cipher.available(); ENC.failed = [];
  const migrate: string[] = [];
  for (const k of secure.SENSITIVE_KEYS) {
    if (!(k in o)) continue;
    const r = secure.unseal(k, o[k], cipher);
    if (r.failed) { ENC.failed.push(k); delete o[k]; log(`敏感设置 ${k} 无法解密（数据库可能来自别的电脑或账户），已重置`); }
    else { o[k] = r.value; if (r.plain && ENC.available) migrate.push(k); }
  }
  S = { ...structuredClone(DEFAULTS), ...o, quota: { ...DEFAULTS.quota, ...(o.quota || {}) }, newProc: { ...DEFAULTS.newProc, ...(o.newProc || {}) }, remind: { ...DEFAULTS.remind, ...(o.remind || {}) }, memTrim: { ...DEFAULTS.memTrim, ...(o.memTrim || {}) }, vpn: { ...DEFAULTS.vpn, ...(o.vpn || {}) }, privacy: { ...DEFAULTS.privacy, ...(o.privacy || {}) }, anim: { ...DEFAULTS.anim, ...(o.anim || {}) } };
  if (SAFE) S.memTrim = { ...S.memTrim, auto: false };
  if (migrate.length) { save(...migrate); log('已把旧版明文敏感设置改为加密保存：' + migrate.join(',')); }
  if (ENC.failed.includes('lock')) setTimeout(() => notify('面板密码已失效', '数据库来自别的电脑或 Windows 账户，密码无法解密，已移除。请在 隐私 页重新设置。'), 3000);
  if (SAFE) S.privacy = { ...S.privacy, hw: false, conn: false, dns: false, proc: false, health: false, fullscreenHide: false, probe: false };
}

/* ---------- 工具 ---------- */
let pet: BrowserWindow | null = null, dash: BrowserWindow | null = null, panel: BrowserWindow | null = null, tray: Tray | null = null, panelHiddenAt = 0;
let dragO: number[] | null = null, resetTimer: any = null;
const send = (w: BrowserWindow | null, ch: string, d?: unknown) => { if (w && !w.isDestroyed()) w.webContents.send(ch, d); };
const sendAll = (ch: string, d?: unknown) => { send(pet, ch, d); send(dash, ch, d); send(panel, ch, d); };
const notify = (title: string, body: string) => { if (R.dnd) return; try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch (_) {} };
const fmt = (b: number) => (b < 1024 ? `${Math.round(b)} B/s` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB/s` : `${(b / 1048576).toFixed(1)} MB/s`);
const isOurs = (e: any) => [pet, dash, panel].some((w) => w && !w.isDestroyed() && w.webContents === e.sender);
const clamp = (v: any, a: number, b: number, d: number) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, Math.round(v))) : d; };
const str = (v: any, n = 100) => (typeof v === 'string' ? v.slice(0, n) : '');
// 密码锁在主进程强制：上锁且未解锁时，敏感通道一律拒绝（旧版只在界面上挡，IPC 可直接调用）
let unlocked = false;
const LOCKED_CH = new Set(['get-records', 'export-csv', 'clear-records', 'clear-all', 'backup-db', 'open-data-dir', 'set-password', 'set-settings', 'get-processes',
  'run-security', 'last-security', 'get-warnings', 'quick-scan', 'scan-junk', 'clean-junk', 'list-startup', 'set-startup', 'export-diag', 'trim-mem', 'check-updates', 'last-updates', 'open-winupdate', 'vpn-status', 'vpn-start', 'vpn-stop', 'vpn-pick', 'vpn-set', 'show-startup-file', 'open-taskmgr-startup', 'exit-safe', 'db-status', 'get-adapters']);
const handle = (ch: string, fn: (a?: any, e?: any) => any) => ipcMain.handle(ch, (e: any, a: any) => {
  if (!isOurs(e)) throw new Error('untrusted sender');
  if (LOCKED_CH.has(ch) && S.lock && !unlocked) throw new Error('locked');
  return fn(a, e);
});
const on = (ch: string, fn: (a?: any, e?: any) => any) => ipcMain.on(ch, (e: any, a: any) => { if (isOurs(e)) fn(a, e); });
const webPrefs = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });

/* ---------- 窗口 ---------- */
const allDisplays = () => screen.getAllDisplays().map((d) => ({ workArea: d.workArea }));
function createPet() {
  // 保存的位置先钳制到当前显示器：换屏/改分辨率后落在工作区之外的旧坐标会被拉回右下角，而不是悄悄“消失”。
  const size = petSize(S.compact);
  const b = clampPetBounds(S.bounds, size.w, size.h, allDisplays());
  S.bounds = b;
  pet = new BrowserWindow({
    width: size.w, height: size.h, x: b.x, y: b.y,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: S.alwaysOnTop, webPreferences: webPrefs()
  });
  if (S.alwaysOnTop) pet.setAlwaysOnTop(true, 'screen-saver');
  watch('宠物', pet);
  pet.on('closed', () => { if (!quitting && recreateBudgetLeft()) schedulePetRecreate('closed'); });
  if (R.passthrough) pet.setIgnoreMouseEvents(true, { forward: true }); // 重建后保持鼠标穿透状态与菜单一致
  pet.loadFile(path.join(__dirname, 'pet.html'));
  pet.webContents.on('did-finish-load', () => { send(pet, 'settings', { pet: S.pet, compact: S.compact }); publish(true); });
}
function createPanel() {
  panel = new BrowserWindow({ width: 280, height: 400, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: webPrefs() });
  watch('小面板', panel);
  panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('blur', () => { if (panel.isVisible()) { panel.hide(); panelHiddenAt = Date.now(); } });
}
function showPanel() {
  if (!pet || pet.isDestroyed()) return;
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
function openDashboard(tab?: string) {
  if (panel && !panel.isDestroyed()) panel.hide();
  if (dash && !dash.isDestroyed()) { dash.show(); dash.focus(); if (tab) send(dash, 'goto', tab); return; }
  dash = new BrowserWindow({ width: 1040, height: 720, minWidth: 840, minHeight: 580, title: 'NetPet', autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.png'), webPreferences: webPrefs() });
  watch('主面板', dash);
  dash.loadFile(path.join(__dirname, 'dashboard.html'));
  if (tab) dash.webContents.once('did-finish-load', () => send(dash, 'goto', tab));
  dash.on('closed', () => { dash = null; unlocked = false; }); // 关闭主面板即重新上锁
}
function resizePet() {
  if (!pet) return;
  const { w, h } = petSize(S.compact), b = pet.getBounds();
  const nb = clampPetBounds({ x: b.x + b.width - w, y: b.y + b.height - h }, w, h, allDisplays());
  pet.setResizable(true);
  pet.setBounds(nb);
  pet.setResizable(false);
  S.bounds = pet.getBounds(); save('bounds');
}
function syncVisibility() {
  if (!pet) return;
  // 一键复位后 30 秒内优先显示（即使全屏隐藏刚好在生效），30 秒后全屏规则恢复。
  const show = !R.userHidden && (!R.fsHidden || Date.now() < R.resetShowUntil);
  show ? pet.show() : pet.hide();
  if (!show && panel && !panel.isDestroyed()) panel.hide();
  if (tray) tray.setToolTip(show ? 'NetPet' : 'NetPet（宠物已隐藏，单击托盘图标可恢复）');
}
/** 看门狗：宠物本该显示却不可见/跑出屏幕时，把它拉回来（而不是等用户自己发现）。 */
function ensurePetVisible() {
  if (!pet || pet.isDestroyed() || quitting) return;
  if (R.userHidden || (R.fsHidden && Date.now() >= R.resetShowUntil)) return;
  const size = petSize(S.compact);
  const nb = clampPetBounds(pet.getBounds(), size.w, size.h, allDisplays());
  const b = pet.getBounds();
  if (nb.x !== b.x || nb.y !== b.y) { log(`宠物位置越界，已拉回 (${b.x},${b.y}) → (${nb.x},${nb.y})`); pet.setBounds(nb); S.bounds = nb; save('bounds'); }
  if (!pet.isVisible()) { log('宠物本该显示却不可见，已重新显示'); pet.show(); pet.moveTop(); }
}
/** 一键复位：只复位窗口状态——位置回主屏右下角、恢复显示、取消鼠标穿透、恢复置顶。
    不动宠物种类、隐私开关、监控数据和成长经验。 */
function resetPet() {
  if (!pet || pet.isDestroyed()) createPet();
  const size = petSize(S.compact);
  const b = defaultPetBounds(screen.getPrimaryDisplay().workArea, size.w, size.h);
  R.userHidden = false; R.passthrough = false; R.resetShowUntil = Date.now() + 30000;
  S.bounds = b; save('bounds');
  pet!.setIgnoreMouseEvents(false);
  pet!.setBounds(b);
  if (S.alwaysOnTop) pet!.setAlwaysOnTop(true, 'screen-saver');
  syncVisibility(); pet!.show(); pet!.moveTop(); refreshMenu();
  // 30 秒优先显示期结束后重新应用全屏规则（旧版没有这个定时器，复位后会一直显示）
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { resetTimer = null; if (!quitting) syncVisibility(); }, 30100);
  log(`宠物已一键复位到 (${b.x},${b.y})${R.fsHidden ? '（全屏隐藏开启中，30 秒后如仍在全屏会再次隐藏）' : ''}`);
  return { ...b, fullscreenHidden: R.fsHidden };
}

/* ---------- 菜单 / 托盘 ---------- */
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '一键复位小宠物', click: () => resetPet() },
    { label: '显示宠物', enabled: R.userHidden, click: () => { R.userHidden = false; syncVisibility(); refreshMenu(); } },
    { label: '隐藏宠物', enabled: !R.userHidden, click: () => { R.userHidden = true; syncVisibility(); refreshMenu(); } },
    { label: '打开主面板', click: () => openDashboard() },
    { label: '清理系统垃圾…', click: () => openDashboard('clean') },
    { label: '启动管理…', click: () => openDashboard('boot') },
    { label: '整理运行内存', click: () => { doTrim(false).catch(() => {}); } },
    { label: '检查系统更新…', click: () => openDashboard('upd') },
    { label: vpn.running() ? 'VPN：已连接（点击断开）' : 'VPN（sing-box）…', click: () => { if (vpn.running()) vpn.stop(); else openDashboard('vpn'); } },
    { type: 'separator' },
    { label: '暂停监控', type: 'checkbox', checked: R.paused, click: (i) => setRuntime({ paused: i.checked }) },
    { label: '勿扰模式', type: 'checkbox', checked: R.dnd, click: (i) => setRuntime({ dnd: i.checked }) },
    { label: '鼠标穿透（宠物不可点击）', type: 'checkbox', checked: R.passthrough, click: (i) => setRuntime({ passthrough: i.checked }) },
    { label: '紧凑模式（更小的宠物窗口）', type: 'checkbox', checked: S.compact, click: (i) => applyPatch({ compact: i.checked }) },
    { label: '切换宠物', submenu: PETS.map((p) => ({ label: `${p.emoji} ${p.name}`, type: 'radio', checked: S.pet === p.id, click: () => applyPatch({ pet: p.id }) })) },
    { type: 'separator' },
    { label: '设置', click: () => openDashboard('set') },
    { label: '检查 NetPet 新版本…', click: () => openDashboard('set') },
    { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => applyPatch({ autostart: i.checked }) },
    { label: '退出软件', click: () => app.quit() }
  ]);
}
const refreshMenu = () => { if (tray) tray.setContextMenu(buildMenu()); };
function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 32, height: 32 }));
    tray.setToolTip('NetPet'); refreshMenu();
    // 旧版单击托盘就切换隐藏/显示，误点一次宠物就“没了”，且没有任何提示。
    // 现在：宠物已隐藏时单击恢复显示；正常时单击弹出菜单（不再误隐藏）。
    tray.on('click', () => {
      if (R.userHidden) { R.userHidden = false; syncVisibility(); refreshMenu(); }
      else tray.popUpContextMenu(buildMenu());
    });
    tray.on('double-click', () => openDashboard());
  } catch (_) { tray = null; }
}

/* ---------- 运行时开关 / 设置补丁（所有参数都做校验）---------- */
const mutedList = () => (R.dnd ? Object.keys(DEFAULTS.anim) : Object.keys(S.anim).filter((k) => !S.anim[k]));
const fsm = new PetStateMachine();
const trimTrig = new memtrim.AutoTrigger();
let npw: NewProcWatcher | null = null;
const reminder = new Reminder();
const REMIND = { sit: ['起来活动一下吧', '已经连续用电脑很久了，站起来伸个懒腰、看看远处。'], water: ['该喝水啦', '喝几口水，休息一下眼睛。'] };
let remindLabel = '', remindUntil = 0;
function checkQuota() {
  if (!(S.quota.gb > 0) || !S.privacy.net) return;
  const m = db.month(), key = new Date().toISOString().slice(0, 7);
  if (S.quota.month !== key) { S.quota.month = key; S.quota.notified = 0; save('quota'); }
  const step = quotaStep(m.rx + m.tx, S.quota.gb, S.quota.notified);
  if (!step) return;
  S.quota.notified = step; save('quota');
  const t = step >= 100 ? '本月流量已用完额度' : '本月流量已用 80%';
  notify(t, `本月已用 ${((m.rx + m.tx) / 1073741824).toFixed(1)} GB / 额度 ${S.quota.gb} GB。`); try { db.addWarning(step >= 100 ? 'warn' : 'info', t, ''); } catch (_) {}
  remindLabel = step >= 100 ? '流量超额度了' : '流量快用完了'; remindUntil = Date.now() + 60e3; publish(true);
}
async function doTrim(auto: boolean) {
  const r = await memtrim.trim([process.pid, ...app.getAppMetrics().map((m) => m.pid)]);
  S.lastTrim = { ...r, at: Date.now(), auto }; save('lastTrim');
  const mb = (x: number) => (x / 1048576).toFixed(0);
  log(`运行内存清理${auto ? '（自动）' : ''}：处理 ${r.trimmed} 个程序，可用内存增加约 ${mb(Math.max(0, r.before - r.after))}MB${r.error ? ' 错误=' + r.error : ''}`);
  if (auto && r.ok) notify('已自动整理运行内存', `内存占用 ${((r.after / os.totalmem()) * 100).toFixed(0)}%（整理前 ${((r.before / os.totalmem()) * 100).toFixed(0)}%）。没有关闭任何程序。`);
  return S.lastTrim;
}
function setRuntime(p) {
  if (typeof p.paused === 'boolean') { R.paused = p.paused; fsm.reset(Date.now()); }
  if (typeof p.dnd === 'boolean') { R.dnd = p.dnd; fsm.setMuted(mutedList()); }
  if (typeof p.passthrough === 'boolean' && pet) { R.passthrough = p.passthrough; pet.setIgnoreMouseEvents(R.passthrough, { forward: true }); }
  sendAll('runtime', { ...R }); publish(true); refreshMenu();
}
function onPrivacyChanged() {
  if (!S.privacy.conn) seen.clear();
  if (!S.privacy.probe) probeSt.reset();
  if (S.privacy.fullscreenHide) fullscreen.start((hidden) => { R.fsHidden = hidden; syncVisibility(); });
  else { fullscreen.stop(); R.fsHidden = false; syncVisibility(); }
  fsm.reset(Date.now()); publish(true);
}
function applyPatch(p) {
  p = p && typeof p === 'object' ? p : {};
  if (p.privacy && typeof p.privacy === 'object') {
    for (const k of Object.keys(DEFAULTS.privacy)) if (typeof p.privacy[k] === 'boolean') S.privacy[k] = p.privacy[k];
    // 安全模式下 S.privacy 是被强制关闭的临时值，不能写回数据库，否则会覆盖用户原来的选择
    if (!SAFE) save('privacy'); onPrivacyChanged();
  }
  if (typeof p.compact === 'boolean') { S.compact = p.compact; resizePet(); save('compact'); sendAll('settings', { pet: S.pet, compact: S.compact }); }
  if (typeof p.autostart === 'boolean') app.setLoginItemSettings({ openAtLogin: p.autostart });
  if (typeof p.alwaysOnTop === 'boolean') { S.alwaysOnTop = p.alwaysOnTop; if (pet) pet.setAlwaysOnTop(p.alwaysOnTop, 'screen-saver'); save('alwaysOnTop'); }
  if ([80, 85, 90, 95].includes(p.memAlert)) { S.memAlert = p.memAlert; save('memAlert'); }
  if ([7, 30, 90].includes(p.retentionDays)) { S.retentionDays = p.retentionDays; try { db.prune(S.retentionDays); } catch (_) {} save('retentionDays'); }
  if (typeof p.pet === 'string' && PETS.some((x) => x.id === p.pet)) { S.pet = p.pet; sendAll('settings', { pet: S.pet }); save('pet'); }
  if (p.quota && typeof p.quota === 'object') { const g = Number(p.quota.gb); if (Number.isFinite(g) && g >= 0 && g <= 100000) { S.quota.gb = Math.round(g); S.quota.notified = 0; save('quota'); checkQuota(); } }
  if (p.remind && typeof p.remind === 'object') {
    if ([0, 30, 45, 60, 90, 120].includes(p.remind.sit)) S.remind.sit = p.remind.sit;
    if ([0, 30, 45, 60, 90, 120].includes(p.remind.water)) S.remind.water = p.remind.water;
    reminder.reset(); save('remind');
  }
  if (p.newProc && typeof p.newProc.on === 'boolean') {
    S.newProc.on = p.newProc.on;
    if (p.newProc.on) { S.newProc.learnUntil = Date.now() + 24 * 3600e3; S.newProc.known = []; npw = null; } // 重新开启时重新学习 24 小时
    save('newProc');
  }
  if (p.memTrim && typeof p.memTrim === 'object') {
    if (typeof p.memTrim.auto === 'boolean') { S.memTrim.auto = p.memTrim.auto; trimTrig.reset(); }
    if ([80, 85, 90, 95].includes(p.memTrim.threshold)) S.memTrim.threshold = p.memTrim.threshold;
    save('memTrim');
  }
  if (p.anim && typeof p.anim === 'object') {
    for (const k of Object.keys(DEFAULTS.anim)) if (typeof p.anim[k] === 'boolean') S.anim[k] = p.anim[k];
    fsm.setMuted(mutedList()); save('anim');
  }
  refreshMenu();
}

/* ---------- 实时采样 ---------- */
const VIRT = /loopback|vethernet|vmware|virtualbox|vbox|hyper-v|\btap\b|\btun\b|wintun|wireguard|tailscale|zerotier|clash|sing-?box|sing-?tun|meta|bluetooth|pseudo|npcap|docker|wsl/i;
const LABEL = { SLEEP: '空闲中', DOWNLOAD: '↓ 下载中', UPLOAD: '↑ 上传中', TIRED: 'CPU 繁忙', HOT: '温度偏高', SWEAT: '内存紧张', WARNING: '有健康提醒', HAPPY: '', IDLE: '' };
const M = { rx: null, tx: null, online: true, cpu: null, memPct: null, memUsed: 0, memTotal: os.totalmem(), temp: null, healthBad: false, state: 'IDLE' };
let lastP: any = null;
const probeSt = new ProbeState(); let probing = false;
let lastNetAt = 0, tickN = 0, skip = 0, offN = 0, onN = 0, lastTemp = 0, lastHw = 0, lastMemNotify = 0, minBytes = 0, lastPub = '', timer = null, connTimer = null, watchTimer: any = null, healthTimer: any = null;

async function readNet() {
  if (process.platform === 'win32') {
    const r = netmon.rate();
    if (r) return r;
    if (Date.now() - startedAt < 8000) return { rx: 0, tx: 0 }; // 轻量采集器刚启动，先等一下
  } // 没有数据时才退回通用采集（在独立进程里，不会卡住界面）
  const up = ((await si.networkStats()) as any[]).filter((s: any) => s.operstate === 'up');
  const phys = up.filter((s) => !VIRT.test(s.iface || '')), use = phys.length ? phys : up; // 优先只算物理网卡，避免 TUN/虚拟网卡重复计数
  let rx = 0, tx = 0;
  for (const s of use) { rx += s.rx_sec > 0 ? s.rx_sec : 0; tx += s.tx_sec > 0 ? s.tx_sec : 0; }
  return rx > 5e9 || tx > 5e9 ? { rx: 0, tx: 0 } : { rx, tx }; // 计数器重置/异常值直接丢弃
}
// 有可用的 IPv4（非 169.254 自动地址）或全局 IPv6（非 fe80 链路本地）就算在线，纯 IPv6 网络不再误报断网
const hasIPv4 = () => hasUsableAddress(os.networkInterfaces() as any);
function netEvent(up) {
  const t = up ? '网络已恢复' : '网络已断开';
  notify(t, up ? '网络连接已恢复。' : '检测不到可用的网络连接。'); try { db.addWarning('info', t, ''); } catch (_) {}
}
function inetEvent(r) {
  const t = r === 'ok' ? '已恢复上网' : r === 'portal' ? '这个网络需要网页登录' : '已连接网络，但上不了网';
  const b = r === 'ok' ? '联网检测正常。' : r === 'portal' ? '打开浏览器访问任意网页，按提示登录 Wi-Fi。' : '本机有网络连接，但访问不到互联网。可检查路由器/宽带或代理设置。';
  notify(t, b); try { db.addWarning('info', t, ''); } catch (_) {}
}
function publish(force) {
  const noInet = S.privacy.net && S.privacy.probe && M.online && (probeSt.value === 'fail' || probeSt.value === 'portal');
  const label = Date.now() < remindUntil && !R.paused ? remindLabel : R.paused ? '已暂停监控' : (S.privacy.net && !M.online) ? '网络已断开' : noInet ? (probeSt.value === 'portal' ? '需要网页登录' : '已连接但上不了网') : LABEL[M.state] || '';
  const p = { state: M.state, label, paused: R.paused, dnd: R.dnd, online: S.privacy.net ? M.online : null, internet: S.privacy.net && S.privacy.probe ? probeSt.value : null };
  const key = JSON.stringify(p);
  if (!force && key === lastPub) return;
  lastPub = key; lastP = p; sendAll('pstate', p);
}
async function tick() {
  tickN++;
  const now = Date.now();
  if (!R.paused) {
    if (S.privacy.net) {
      try {
        const n = await readNet();
        // 按真实间隔累计字节（tick 间隔常因采集等待超过 1 秒；最多按 5 秒算，避免休眠唤醒的大跳变）
        const dt = sampleSeconds(now, lastNetAt); lastNetAt = now;
        if (skip > 0) { skip--; M.rx = 0; M.tx = 0; } else { M.rx = n.rx; M.tx = n.tx; db.addTraffic(n.rx * dt, n.tx * dt); minBytes += (n.rx + n.tx) * dt; }
      } catch (_) { M.rx = 0; M.tx = 0; }
      const o = hasIPv4();
      if (o === M.online) { offN = onN = 0; }
      else if (o) { if (++onN >= 2) { M.online = true; onN = 0; netEvent(true); } }
      else if (++offN >= 2) { M.online = false; offN = 0; netEvent(false); }
      if (!M.online) { M.rx = 0; M.tx = 0; probeSt.reset(); }
      // 可选真实联网检测：本机有地址时每 30 秒探测一次（不阻塞 tick）
      else if (S.privacy.probe && !probing && (tickN % 30 === 1 || probeSt.value === null && tickN % 5 === 1)) {
        probing = true;
        probeOnce().then((r) => { const prev = probeSt.value; if (probeSt.push(r)) { if (prev !== null || r !== 'ok') inetEvent(r); publish(true); } }).finally(() => { probing = false; });
      }
    } else { M.rx = M.tx = null; }
    if (S.privacy.hw) {
      if (tickN % 3 === 0) {
        try {
          M.cpu = (await si.currentLoad()).currentLoad; M.memTotal = os.totalmem(); M.memUsed = M.memTotal - os.freemem(); M.memPct = (M.memUsed / M.memTotal) * 100;
          if (now - lastTemp > 20000) { lastTemp = now; try { const t = await si.cpuTemperature(); M.temp = t && t.main > 0 ? t.main : null; } catch (_) {} }
          const smp = { cpu: M.cpu, used: M.memUsed, total: M.memTotal, pct: M.memPct, temp: M.temp };
          send(dash, 'sample', smp); send(panel, 'sample', smp);
          if (now - lastHw > 60000) { lastHw = now; try { db.addHardware(now, M.cpu, M.memPct, M.temp); } catch (_) {} }
          if (S.memTrim.auto && trimTrig.update(now, M.memPct, S.memTrim.threshold)) doTrim(true).catch(() => {});
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
  maybeClearFlag();
  if (tickN % 60 === 0) { try { db.flush(); } catch (_) {} try { checkQuota(); } catch (_) {} }
  if (tickN % 30 === 0 && (S.remind.sit > 0 || S.remind.water > 0)) {
    reminder.sitMin = S.remind.sit; reminder.waterMin = S.remind.water;
    let idle = 0; try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
    for (const k of reminder.tick(now, idle, R.dnd || R.paused || R.fsHidden || R.userHidden)) {
      remindLabel = REMIND[k][0]; remindUntil = now + 20e3; publish(true);
      try { if (Notification.isSupported()) new Notification({ title: REMIND[k][0], body: REMIND[k][1], silent: true }).show(); } catch (_) {}
    }
  }
  if (remindUntil && now >= remindUntil) { remindUntil = 0; publish(true); } // 每分钟落盘，异常退出最多丢 1 分钟流量
  if (tickN % 3600 === 0) { try { db.prune(S.retentionDays); } catch (_) {} } // 常驻时每小时按保留期清理一次
  if (tickN % 60 === 0 && !R.paused && (S.privacy.net || S.privacy.hw)) { S.growth.xp += 1 + (minBytes / 1e9) * 5; minBytes = 0; if (tickN % 300 === 0) save('growth'); }
}
const loop = async () => { const t0 = Date.now(); try { await tick(); } catch (e: any) { log('tick 出错 ' + (e && e.message)); } const d = Date.now() - t0; if (d > 3000) log(`tick 耗时 ${d}ms`); if (!quitting) timer = setTimeout(loop, 1000); };

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
    if (S.newProc.on && rows.length) {
      if (!npw) npw = new NewProcWatcher(S.newProc.known, S.newProc.learnUntil);
      const before = npw.known.size;
      for (const p of npw.see(now, rows.map((r) => r.proc))) {
        const r = rows.find((x) => x.proc === p)!;
        notify('有程序第一次联网', `${p} → ${r.host || r.ip}:${r.port}。如果你不认识这个程序，可以在 网络统计 → 连接记录 里查看。`);
        try { db.addWarning('info', `${p} 第一次联网`, `${r.ip}:${r.port}`); } catch (_) {}
      }
      if (npw.known.size !== before) { S.newProc.known = npw.list(); save('newProc'); }
    }
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
  on('drag-start', () => { if (pet && !pet.isDestroyed()) dragO = pet.getPosition(); });
  on('drag-move', (d) => {
    if (!pet || pet.isDestroyed() || !dragO || !d) return;
    // 拖动时就钳制：宠物永远至少留 40px 在当前屏幕内，拖不出去。
    const size = petSize(S.compact);
    const nb = clampPetBounds({ x: dragO[0] + clamp(d.dx, -5000, 5000, 0), y: dragO[1] + clamp(d.dy, -5000, 5000, 0) }, size.w, size.h, allDisplays());
    pet.setPosition(nb.x, nb.y);
  });
  on('drag-end', () => { dragO = null; if (pet && !pet.isDestroyed()) { const size = petSize(S.compact); S.bounds = clampPetBounds(pet.getBounds(), size.w, size.h, allDisplays()); pet.setBounds(S.bounds); save('bounds'); } });
  on('pet-click', togglePanel);
  on('pet-dblclick', () => openDashboard());
  on('pet-menu', () => { if (pet && !pet.isDestroyed()) buildMenu().popup({ window: pet }); });
  on('panel-open-main', () => openDashboard());
  on('pet-ready', () => { petReady = true; maybeClearFlag(); });

  let cache: any = { disks: [0, []], gpu: [0, []], ifs: [0, []], bat: [0, null], procs: [0, null] };
  const cached = async (k, ms, fn) => { if (Date.now() - cache[k][0] > ms) { try { cache[k] = [Date.now(), await fn()]; } catch (_) { cache[k] = [Date.now(), k === 'bat' ? null : []]; } } return cache[k][1]; };

  handle('get-system', async () => {
    const out: any = { today: S.privacy.net ? db.today() : null, month: S.privacy.net ? db.month() : null, netOn: S.privacy.net, hwOn: S.privacy.hw, uptime: os.uptime(), quotaGB: S.quota.gb };
    if (!S.privacy.hw) return out;
    out.disks = (await cached('disks', 10000, () => si.fsSize())).filter((d) => d.size > 0).map((d) => ({ mount: d.mount, size: d.size, used: d.used, pct: d.use }));
    out.gpu = await cached('gpu', 15000, async () => (await si.graphics()).controllers.map((c) => ({ name: c.model, util: c.utilizationGpu ?? null, memUsed: c.memoryUsed ?? null, memTotal: c.memoryTotal ?? c.vram ?? null })));
    out.temp = M.temp;
    out.battery = await cached('bat', 30000, async () => { const b = await si.battery(); return b && b.hasBattery ? { pct: b.percent, charging: b.isCharging } : null; }) || null;
    try { out.summary = db.hardwareSummary(24); } catch (_) {}
    return out;
  });
  handle('trim-mem', async () => doTrim(false));
  // 检查 NetPet 新版本：只在点击时访问 GitHub，一次请求，不下载
  handle('check-self-update', async () => { const r = await selfupdate.check(app.getVersion()); S.lastSelfUpd = r; save('lastSelfUpd'); log(`检查新版本：${r.ok ? (r.newer ? '有新版本 ' + r.latest : '已是最新') : r.error}`); return r; });
  handle('last-self-update', () => S.lastSelfUpd || null);
  handle('open-release', () => { const u = selfupdate.safeReleaseUrl(S.lastSelfUpd && S.lastSelfUpd.url); shell.openExternal(u); return true; });
  // 一键打包诊断信息：日志 + 版本/系统信息 + 开关状态。不含统计数据、连接记录、密码、VPN 路径和配置。
  handle('export-diag', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const r = await dialog.showSaveDialog(dash, { defaultPath: `netpet-diag-${stamp}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netpet-diag-'));
    try {
      const info = {
        version: app.getVersion(), electron: process.versions.electron, os: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, memGB: +(os.totalmem() / 1073741824).toFixed(1),
        uptimeH: Math.round(os.uptime() / 3600), safe: SAFE, packaged: app.isPackaged, locale: app.getLocale(),
        displays: screen.getAllDisplays().map((d) => ({ bounds: d.bounds, scale: d.scaleFactor })), gpu: app.getGPUFeatureStatus(),
        db: { ...db.status(), path: undefined }, encAvailable: ENC.available, encFailed: ENC.failed,
        settings: { privacy: S.privacy, compact: S.compact, alwaysOnTop: S.alwaysOnTop, retentionDays: S.retentionDays, memAlert: S.memAlert, memTrim: S.memTrim, quotaGB: S.quota.gb, remind: S.remind, newProcOn: S.newProc.on, hasLock: !!S.lock, vpnConfigured: !!(S.vpn.exe && S.vpn.config), pet: S.pet },
        runtime: { ...R }, vpn: { state: vpn.status().state, error: vpn.status().error, tun: vpn.status().tun },
        lastHealth: (() => { try { const h = db.lastHealth(); return h ? h.items.map((i) => ({ id: i.id, status: i.status, detail: i.detail })) : null; } catch (_) { return null; } })(),
        lastTrim: S.lastTrim, lastUpdate: S.lastUpdateCheck ? { at: S.lastUpdateCheck.at, ok: S.lastUpdateCheck.ok, error: S.lastUpdateCheck.error, count: S.lastUpdateCheck.items?.length, pendingReboot: S.lastUpdateCheck.pendingReboot } : null
      };
      fs.writeFileSync(path.join(tmp, 'info.json'), JSON.stringify(info, null, 2));
      const ld = path.join(userDir, 'logs');
      for (const f of fs.existsSync(ld) ? fs.readdirSync(ld) : []) { try { fs.copyFileSync(path.join(ld, f), path.join(tmp, f)); } catch (_) {} }
      fs.writeFileSync(path.join(tmp, 'README.txt'), '这是 NetPet 诊断包：info.json（版本、系统、开关状态）+ 日志。\r\n不包含：流量统计、连接记录、密码、VPN 程序/配置路径和内容。发送前可以自己打开检查。\r\n');
      log('导出诊断包 → ' + r.filePath);
      if (process.platform !== 'win32') { const dst = r.filePath.replace(/\.zip$/i, ''); fs.cpSync(tmp, dst, { recursive: true }); return { ok: true, path: dst }; }
      const src = Buffer.from(path.join(tmp, '*'), 'utf8').toString('base64'), dst = Buffer.from(r.filePath, 'utf8').toString('base64');
      const ok = await new Promise<boolean>((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${src}'));$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${dst}'));try{Compress-Archive -Path $s -DestinationPath $d -Force -ErrorAction Stop;'done'}catch{'fail'}`],
        { windowsHide: true, timeout: 60000, encoding: 'utf8' }, (e, o) => res(!e && String(o).trim() === 'done')));
      return ok ? { ok: true, path: r.filePath } : { ok: false, msg: '压缩失败' };
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
  });
  handle('last-trim', () => S.lastTrim || null);
  handle('get-processes', async () => {
    if (!S.privacy.proc) return { disabled: true };
    const l = (await cached('procs', 10000, async () => (await si.processes()).list)).filter((x) => x.name).map((x) => ({ pid: x.pid, name: x.name, mem: x.memRss * 1024, cpu: x.cpu }));
    return { byMem: [...l].sort((a, b) => b.mem - a.mem).slice(0, 8), byCpu: [...l].sort((a, b) => b.cpu - a.cpu).slice(0, 8) };
  });
  handle('get-adapters', async () => {
    if (!S.privacy.net) return { disabled: true };
    const l = (await cached('ifs', 20000, () => si.networkInterfaces())).filter((x) => !x.internal).map((x) => ({ name: x.iface, type: x.type, speed: x.speed, ip4: x.ip4, up: x.operstate === 'up', virtual: !!x.virtual || VIRT.test(x.iface || '') }));
    try { db.saveAdapters(l); } catch (_) {}
    return { list: l };
  });
  handle('open-taskmgr', () => { if (process.platform !== 'win32') return false; execFile('taskmgr.exe', [], { windowsHide: false }, () => {}); return true; });

  handle('get-records', (a) => {
    const days = [1, 3, 7, 30].includes(a && a.days) ? a.days : 1;
    const base = { today: S.privacy.net ? db.today() : null, month: S.privacy.net ? db.month() : null, connOn: S.privacy.conn };
    return S.privacy.conn ? { ...base, ...db.connections(days, str(a && a.q)) } : { ...base, rows: [], total: 0, byProc: [], byHost: [] };
  });
  handle('export-csv', async (a) => {
    const days = [1, 3, 7, 30].includes(a && a.days) ? a.days : 1;
    const r = await dialog.showSaveDialog(dash, { defaultPath: 'netpet-connections.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, db.toCsv(db.connections(days, str(a && a.q), 100000).rows));
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
  handle('db-status', () => ({ ...db.status(), dataDir: app.getPath('userData'), encAvailable: ENC.available, encFailed: ENC.failed }));

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
    privacy: S.privacy, memTrim: S.memTrim, quota: S.quota, remind: S.remind, newProc: { on: S.newProc.on, learnUntil: S.newProc.learnUntil, count: S.newProc.known.length }, compact: S.compact, alwaysOnTop: S.alwaysOnTop, retentionDays: S.retentionDays, pet: S.pet, memAlert: S.memAlert, anim: S.anim,
    autostart: app.getLoginItemSettings().openAtLogin, safe: SAFE, hasLock: !!S.lock, packaged: app.isPackaged, onboarded: S.onboarded, version: app.getVersion(), dataDir: app.getPath('userData')
  }));
  handle('set-settings', (p) => { applyPatch(p); return true; });
  handle('ack-privacy', () => { S.onboarded = true; save('onboarded'); return true; });
  handle('get-pstate', () => lastP);
  handle('exit-safe', () => { try { fs.unlinkSync(flagPath); } catch (_) {} try { fs.unlinkSync(safeFile); } catch (_) {} app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--safe') }); app.quit(); return true; });
  handle('get-runtime', () => ({ ...R, state: M.state }));
  handle('set-runtime', (p) => { setRuntime(p && typeof p === 'object' ? p : {}); return true; });
  handle('reset-pet', () => resetPet());
  handle('get-pet-status', () => ({
    userHidden: R.userHidden, fsHidden: R.fsHidden, fullscreenHide: !!S.privacy.fullscreenHide,
    bounds: S.bounds, visible: !!(pet && !pet.isDestroyed() && pet.isVisible())
  }));
  // 启动管理：只在用户打开这一页时读取，不保存、不上传；修改只改启用标记，可随时恢复
  handle('list-startup', async () => startup.list());
  handle('set-startup', async (a) => {
    const id = str(a && a.id, 600); if (!id || typeof (a && a.enabled) !== 'boolean') return { ok: false, error: '参数不对' };
    const r = await startup.setEnabled(id, a.enabled);
    log(`启动项${a.enabled ? '启用' : '禁用'}：${id} → ${r.ok ? '成功' : '失败 ' + r.error}`);
    return r;
  });
  handle('show-startup-file', async (a) => {
    const id = str(a && a.id, 600); const cur = await startup.list();
    const it = cur.items.find((x) => x.id === id);
    if (!it || !it.exe || !path.isAbsolute(it.exe) || !fs.existsSync(it.exe)) return false;
    shell.showItemInFolder(it.exe); return true;
  });
  handle('open-taskmgr-startup', () => { if (process.platform !== 'win32') return false; execFile('taskmgr.exe', ['/0', '/startup'], { windowsHide: false }, () => {}); return true; });
  // 系统更新检测：只读；online=false 时只看本机状态，不联网
  handle('check-updates', async (a) => {
    const r = await winupdate.check(!!(a && a.online));
    S.lastUpdateCheck = r; save('lastUpdateCheck');
    if (r.ok && winupdate.verdict(r) === 'bad') notify('有重要的系统安全更新', '打开主面板 → 系统更新 查看，并在 Windows 更新里安装。');
    log(`系统更新检测 online=${!!(a && a.online)} 可用=${r.items.length} 安全=${r.security} 待重启=${r.pendingReboot}${r.error ? ' 错误=' + r.error : ''}`);
    return r;
  });
  handle('last-updates', () => S.lastUpdateCheck || null);
  handle('open-winupdate', () => { if (process.platform !== 'win32') return false; shell.openExternal('ms-settings:windowsupdate'); return true; });
  // sing-box VPN：路径只能通过主进程的文件对话框选择
  handle('vpn-status', () => ({ ...vpn.status(), exe: S.vpn.exe, config: S.vpn.config, sysProxy: S.vpn.sysProxy, safe: SAFE }));
  handle('vpn-pick', async (a) => {
    const kind = a && a.kind === 'config' ? 'config' : 'exe';
    const r = await dialog.showOpenDialog(dash, kind === 'exe'
      ? { title: '选择 sing-box.exe', properties: ['openFile'], filters: [{ name: 'sing-box', extensions: ['exe'] }] }
      : { title: '选择 sing-box 配置文件', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const f = r.filePaths[0];
    if (kind === 'exe' && !vpn.isSingBoxExe(f)) return { ok: false, error: '文件名需以 sing-box 开头（例如 sing-box.exe）。' };
    if (vpn.running()) return { ok: false, error: '请先断开再更换。' };
    S.vpn[kind] = f; save('vpn'); return { ok: true, path: f };
  });
  handle('vpn-set', (a) => { if (a && typeof a.sysProxy === 'boolean' && !vpn.running()) { S.vpn.sysProxy = a.sysProxy; save('vpn'); } return true; });
  handle('vpn-start', async () => {
    if (SAFE) return { ok: false, error: '安全模式下不启动 VPN。' };
    return vpn.start({ exe: S.vpn.exe, config: S.vpn.config, sysProxy: S.vpn.sysProxy, workDir: path.join(userDir, 'sing-box') });
  });
  handle('vpn-stop', async () => { await vpn.stop(); return true; });
  handle('scan-junk', async () => cleaner.scanJunk({ netpetLogsDir: path.join(userDir, 'logs') }));
  handle('clean-junk', async (a) => {
    const ids = Array.isArray(a && a.ids) ? a.ids.filter((x: any) => typeof x === 'string') : [];
    if (!ids.length) return [];
    const res = await cleaner.cleanJunk(ids, { netpetLogsDir: path.join(userDir, 'logs') });
    log(`清理系统垃圾：${res.map((r) => `${r.id} 释放 ${(r.freed / 1048576).toFixed(1)}MB/删 ${r.deletedFiles} 个/跳过 ${r.skippedFiles} 个`).join('；')}`);
    return res;
  });
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
  handle('unlock', (pw) => {
    if (!S.lock) { unlocked = true; return true; }
    const a = Buffer.from(hash(str(pw, 64), S.lock.salt), 'hex'), b = Buffer.from(S.lock.hash, 'hex');
    unlocked = a.length === b.length && crypto.timingSafeEqual(a, b);
    return unlocked;
  });
  handle('set-password', (pw) => {
    pw = str(pw, 64);
    if (!pw) S.lock = null; else { const salt = crypto.randomBytes(16).toString('hex'); S.lock = { salt, hash: hash(pw, salt) }; }
    save('lock'); unlocked = true; return !!S.lock;
  });
}

/* ---------- 生命周期 ---------- */
app.on('web-contents-created', (_e, c) => { c.on('will-navigate', (e) => e.preventDefault()); c.setWindowOpenHandler(() => ({ action: 'deny' })); });
app.whenReady().then(() => {
  if (!gotLock) return;
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  Menu.setApplicationMenu(null);
  log('应用就绪');
  const st = db.init(path.join(app.getPath('userData'), 'data'));
  log('数据库 ' + (st.ok ? '正常' : '不可用 ' + st.error) + (st.recovered ? '（已重建）' : ''));
  loadSettings(); fsm.setMuted(mutedList());
  if (st.ok) { try { db.prune(S.retentionDays); } catch (_) {} }
  vpn.init({
    log, getBackup: () => S.vpnProxyBackup || null, setBackup: (b) => { S.vpnProxyBackup = b; save('vpnProxyBackup'); },
    onChange: () => {
      refreshMenu(); const s = vpn.status(); send(dash, 'vpn', s);
      if (s.state === 'error' && s.error) notify('VPN 已断开', s.error);
      delete S.baselines.proxy; // 代理是 NetPet 自己改的，下次体检重新建立基线，不误报“代理被修改”
    }
  });
  vpn.recoverProxy().catch(() => {});
  createPet(); createTray(); setupIpc();
  // 显示器变化（插拔/改分辨率/改缩放）时，把宠物拉回当前工作区；每 10 秒看门狗再检查一次。
  const onDisplayChanged = () => { log('显示器变化，检查宠物位置'); ensurePetVisible(); };
  screen.on('display-added', onDisplayChanged);
  screen.on('display-removed', onDisplayChanged);
  screen.on('display-metrics-changed', onDisplayChanged);
  watchTimer = setInterval(ensurePetVisible, 10000);
  powerMonitor.on('suspend', () => db.flush());
  powerMonitor.on('shutdown', () => { try { db.flush(); save('growth'); } catch (_) {} });
  powerMonitor.on('resume', () => { skip = 3; fsm.reset(Date.now()); ensurePetVisible(); });
  if (S.privacy.fullscreenHide) onPrivacyChanged();
  if (process.platform === 'win32') netmon.ensure();
  loop(); connTimer = setInterval(connTick, 8000);
  if (S.privacy.health) setTimeout(() => { runHealth().catch(() => {}); }, 30000);
  // 每 6 小时自动复查一次，问题解决后警示牌会自动消失
  healthTimer = setInterval(() => { if (S.privacy.health && !R.paused) runHealth().catch(() => {}); }, 6 * 3600e3);
  if (!st.ok) dialog.showMessageBox({ type: 'warning', title: 'NetPet', message: '本地数据库不可用', detail: `设置和统计将无法保存。\n原因：${st.error}` });
  else if (st.recovered) dialog.showMessageBox({ type: 'warning', title: 'NetPet', message: '数据库文件已损坏，已自动重建', detail: '旧文件已保留（文件名含 .corrupt-），设置已恢复为默认值。' });
  if (!S.onboarded) openDashboard('pri');
  // 安全模式是“粘住”的：启动时明确告诉用户一次，避免功能被静默关闭
  else if (SAFE) { notify('NetPet 正在安全模式下运行', '3D、硬件监控等功能已暂时关闭。打开主面板顶部可一键退出安全模式。'); openDashboard(); }
  if (process.env.NETPET_TEST) (global as any).__np = { openDashboard, togglePanel, applyPatch, setRuntime, resetPet, ensurePetVisible, wins: () => ({ pet, dash, panel }), S: () => S, M, runHealth };
});
app.on('second-instance', () => { openDashboard(); });
app.on('window-all-closed', () => { /* 有此监听即不会在窗口全关时退出，常驻托盘 */ });
let quitDone = false;
app.on('child-process-gone', (_e, d) => log(`子进程退出 type=${d.type} reason=${d.reason}`));
app.on('before-quit', (e) => {
  if (quitDone) return;
  e.preventDefault(); quitDone = true; quitting = true;
  clearTimeout(timer); clearInterval(connTimer); clearInterval(watchTimer); clearInterval(healthTimer); clearTimeout(petRecreateTimer); clearTimeout(resetTimer);
  save('growth'); fullscreen.stop(); netmon.stop(); security.killAll(); // 不留下任何后台子进程
  // 先断开 VPN 并恢复系统代理，再停采集进程
  vpn.stop().catch(() => {}).finally(() => stopCollector().finally(() => { db.close(); log('正常退出'); app.quit(); }));
});
