import { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, Notification, dialog, powerMonitor, session, shell, safeStorage, globalShortcut } from 'electron';
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
import { hasUsableAddress, RateBudget, sampleSeconds, localMonthKey } from './guards';
import * as settingsio from './settingsio';
import { PETS } from '../shared/petlist';
import { DEFAULT_HOTKEY, normalizeHotkey } from '../shared/hotkey';
import { fillDays, summarize } from '../shared/report';
// 1.5.0
import { t, setLang, getLang, resolveLang, LANG_SETTINGS } from '../shared/i18n';
import { SpeedAlert, sanitizeSpeedAlert, SPEED_ALERT_DEFAULT } from './speedalert';
import { FocusTimer, sanitizeFocus, FOCUS_DEFAULT } from './focus';
import * as weekly from './weekly';
import { idleTaskEligible, WEEK_MS } from './sched';
import { bucketize, rangeSpec } from '../shared/series';
import { sanitizeLook, DEFAULT_LOOK } from '../shared/wardrobe';
import * as drivers from './drivers';
import * as diskopt from './diskopt';
import * as power from './power';
import * as defender from './defender';
import * as procmgr from './procmgr';
import { normalizeProcHotkey } from '../shared/hotkey';

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
  if (!recreateBudgetLeft()) { log(`宠物渲染进程多次崩溃(${reason})，已停止自动重建，请用托盘菜单“一键复位小宠物”`); notify(t('n.petFail.t'), t('n.petFail.b')); return; }
  petRecreateTimer = setTimeout(() => {
    petRecreateTimer = null; petRecreateN++; recreateBudget.use();
    log(`重建宠物窗口(${reason})，第 ${petRecreateN} 次`);
    // 先把 pet 置空再销毁旧窗口：旧版销毁时触发的 closed 事件会被当成“又被关闭了一次”，
    // 一次崩溃连环重建 3 次，把 5 分钟的重建额度用光，下一次真正崩溃时就不再恢复。
    const old = pet; pet = null;
    try { if (old && !old.isDestroyed()) old.destroy(); } catch (_) {}
    createPet(); syncVisibility();
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
  memTrim: { auto: false, threshold: 90, skipFg: true, sched: 0, exclude: [] as string[] }, lastTrim: null, // 1.5.0：sched = 定期整理间隔（分钟，0 = 关闭）、exclude = 排除列表
  quota: { gb: 0, notified: 0, month: '' }, lastSelfUpd: null, newProc: { on: false, learnUntil: 0, known: [] as string[] }, remind: { sit: 0, water: 0 },
  lock: null, onboarded: false, growth: { xp: 0 }, baselines: {},
  vpn: { exe: '', config: '', sysProxy: true }, vpnProxyBackup: null, lastUpdateCheck: null,
  hotkey: DEFAULT_HOTKEY, // 1.4.0：显示/隐藏宠物的全局快捷键，'' = 关闭
  // ---- 1.5.0 ----
  language: 'auto', // auto = 跟随系统（app.getLocale()）
  speedAlert: { ...SPEED_ALERT_DEFAULT }, look: { ...DEFAULT_LOOK }, focus: { ...FOCUS_DEFAULT }, weekly: { on: true, last: '' },
  diskAuto: { on: false, last: 0, lastTry: 0 }, defSched: { on: false, last: 0, lastTry: 0 }, lastDefUpdate: null, lastDrvOnline: null,
  power: { ...power.POWER_DEFAULT }, powerBackup: null, powerAuto: { cooling: false, saver: false }, procHotkey: ''
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
  S = { ...structuredClone(DEFAULTS), ...o, quota: { ...DEFAULTS.quota, ...(o.quota || {}) }, newProc: { ...DEFAULTS.newProc, ...(o.newProc || {}) }, remind: { ...DEFAULTS.remind, ...(o.remind || {}) }, memTrim: { ...DEFAULTS.memTrim, ...(o.memTrim || {}) }, vpn: { ...DEFAULTS.vpn, ...(o.vpn || {}) }, privacy: { ...DEFAULTS.privacy, ...(o.privacy || {}) }, anim: { ...DEFAULTS.anim, ...(o.anim || {}) },
    speedAlert: sanitizeSpeedAlert(o.speedAlert, {}), look: { ...DEFAULTS.look, ...(o.look || {}) }, focus: sanitizeFocus(o.focus, {}), weekly: { ...DEFAULTS.weekly, ...(o.weekly || {}) },
    diskAuto: { ...DEFAULTS.diskAuto, ...(o.diskAuto || {}) }, defSched: { ...DEFAULTS.defSched, ...(o.defSched || {}) }, power: power.sanitizePower(o.power, {}), powerAuto: { ...DEFAULTS.powerAuto, ...(o.powerAuto || {}) } };
  S.memTrim.exclude = memtrim.normalizeExclude(S.memTrim.exclude); if (![0, ...memtrim.SCHED_CHOICES].includes(S.memTrim.sched)) S.memTrim.sched = 0;
  if (!LANG_SETTINGS.includes(S.language)) S.language = 'auto';
  if (normalizeProcHotkey(S.procHotkey) === null) S.procHotkey = '';
  if (SAFE) S.memTrim = { ...S.memTrim, auto: false, sched: 0 };
  if (SAFE) { S.diskAuto = { ...S.diskAuto, on: false }; S.defSched = { ...S.defSched, on: false }; S.power = { ...S.power, guard: false, saver: false }; } // 安全模式下自动修改系统的功能一律不运行（不写回数据库）
  if (normalizeHotkey(S.hotkey) === null) S.hotkey = DEFAULT_HOTKEY;
  if (migrate.length) { save(...migrate); log('已把旧版明文敏感设置改为加密保存：' + migrate.join(',')); }
  if (ENC.failed.includes('lock')) setTimeout(() => notify(t('n.lockLost.t'), t('n.lockLost.b')), 3000);
  if (SAFE) S.privacy = { ...S.privacy, hw: false, conn: false, dns: false, proc: false, health: false, fullscreenHide: false, probe: false };
}

/* ---------- 工具 ---------- */
let pet: BrowserWindow | null = null, dash: BrowserWindow | null = null, panel: BrowserWindow | null = null, tray: Tray | null = null, panelHiddenAt = 0;
let dragO: number[] | null = null, resetTimer: any = null;
const send = (w: BrowserWindow | null, ch: string, d?: unknown) => { if (w && !w.isDestroyed()) w.webContents.send(ch, d); };
const sendAll = (ch: string, d?: unknown) => { send(pet, ch, d); send(dash, ch, d); send(panel, ch, d); };
const notify = (title: string, body: string, o: { silent?: boolean; onClick?: () => void } = {}) => {
  if (R.dnd) return;
  try { if (Notification.isSupported()) { const n = new Notification({ title, body, silent: !!o.silent }); if (o.onClick) n.on('click', o.onClick); n.show(); } } catch (_) {}
};
/** 1.5.0：提醒类消息（网速异常、番茄钟、每周小结等）在勿扰 / 全屏 / 暂停监控时都不打扰。 */
const reminderMuted = () => R.dnd || R.paused || R.fsHidden;
const fmt = (b: number) => (b < 1024 ? `${Math.round(b)} B/s` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB/s` : `${(b / 1048576).toFixed(1)} MB/s`);
const isOurs = (e: any) => [pet, dash, panel].some((w) => w && !w.isDestroyed() && w.webContents === e.sender);
const clamp = (v: any, a: number, b: number, d: number) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, Math.round(v))) : d; };
const str = (v: any, n = 100) => (typeof v === 'string' ? v.slice(0, n) : '');
// 密码锁在主进程强制：上锁且未解锁时，敏感通道一律拒绝（旧版只在界面上挡，IPC 可直接调用）
let unlocked = false;
const LOCKED_CH = new Set(['get-records', 'export-csv', 'clear-records', 'clear-all', 'backup-db', 'open-data-dir', 'set-password', 'set-settings', 'get-processes',
  'run-security', 'last-security', 'get-warnings', 'quick-scan', 'scan-junk', 'clean-junk', 'list-startup', 'set-startup', 'export-diag', 'trim-mem', 'check-updates', 'last-updates', 'open-winupdate', 'vpn-status', 'vpn-start', 'vpn-stop', 'vpn-pick', 'vpn-set', 'show-startup-file', 'open-taskmgr-startup', 'exit-safe', 'db-status', 'get-adapters',
  'export-settings', 'import-settings', 'get-traffic-report',
  // 1.5.0
  'focus-history', 'get-hw-history', 'weekly-list', 'weekly-regen', 'drv-scan', 'drv-online', 'drv-last-online', 'open-optional-updates', 'open-devmgmt',
  'disk-analyze', 'disk-frag', 'disk-optimize', 'disk-cancel', 'disk-state', 'open-dfrgui', 'power-status', 'power-set-plan', 'power-cool', 'power-restore',
  'def-status', 'def-threats', 'def-scan', 'def-pick', 'def-stop', 'def-state', 'def-update', 'open-def-history',
  'pm-list', 'pm-detail', 'pm-kill', 'pm-priority', 'pm-services', 'pm-perf', 'pm-reveal', 'mem-status', 'mem-runs']);
const handle = (ch: string, fn: (a?: any, e?: any) => any) => ipcMain.handle(ch, (e: any, a: any) => {
  if (!isOurs(e)) throw new Error('untrusted sender');
  if (LOCKED_CH.has(ch) && S.lock && !unlocked) throw new Error('locked');
  return fn(a, e);
});
const on = (ch: string, fn: (a?: any, e?: any) => any) => ipcMain.on(ch, (e: any, a: any) => { if (isOurs(e)) fn(a, e); });
const webPrefs = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false });
// 便携版运行时 process.execPath 是解压到临时目录的副本；开机自启必须登记便携版 exe 本身（旧版登记的临时路径重启后就不存在了）。
const loginOpts = () => (process.env.PORTABLE_EXECUTABLE_FILE ? { path: process.env.PORTABLE_EXECUTABLE_FILE } : {});
const autostartOn = () => { try { return app.getLoginItemSettings(loginOpts()).openAtLogin; } catch (_) { return false; } };

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
  const me = pet;
  // 只处理“当前这只”宠物窗口的关闭；被重建流程主动销毁的旧窗口不再触发二次重建
  me.on('closed', () => { if (pet !== me) return; pet = null; if (!quitting && recreateBudgetLeft()) schedulePetRecreate('closed'); });
  if (R.passthrough) pet.setIgnoreMouseEvents(true, { forward: true }); // 重建后保持鼠标穿透状态与菜单一致
  pet.loadFile(path.join(__dirname, 'pet.html'));
  pet.webContents.on('did-finish-load', () => { send(pet, 'settings', { pet: S.pet, compact: S.compact }); publish(true); });
}
function createPanel() {
  panel = new BrowserWindow({ width: 280, height: 440, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: webPrefs() });
  watch('小面板', panel);
  panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('blur', () => { if (panel.isVisible()) { panel.hide(); panelHiddenAt = Date.now(); } });
}
function showPanel() {
  if (!pet || pet.isDestroyed()) return;
  if (!panel || panel.isDestroyed()) createPanel();
  const b = pet.getBounds(), wa = screen.getDisplayMatching(b).workArea, [w, h] = [280, 440]; // 1.5.0：加了番茄钟一行，面板加高 40
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
  if (!pet || pet.isDestroyed()) return;
  const { w, h } = petSize(S.compact), b = pet.getBounds();
  const nb = clampPetBounds({ x: b.x + b.width - w, y: b.y + b.height - h }, w, h, allDisplays());
  pet.setResizable(true);
  pet.setBounds(nb);
  pet.setResizable(false);
  S.bounds = pet.getBounds(); save('bounds');
}
function syncVisibility() {
  if (!pet || pet.isDestroyed()) return;
  // 一键复位后 30 秒内优先显示（即使全屏隐藏刚好在生效），30 秒后全屏规则恢复。
  const show = !R.userHidden && (!R.fsHidden || Date.now() < R.resetShowUntil);
  show ? pet.show() : pet.hide();
  if (!show && panel && !panel.isDestroyed()) panel.hide();
  if (tray) tray.setToolTip(show ? 'NetPet' : t('tray.hiddenTip'));
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
  if (!pet || pet.isDestroyed()) {
    if (petRecreateTimer) { clearTimeout(petRecreateTimer); petRecreateTimer = null; } // 这里直接新建，等待中的自动重建不再需要
    createPet();
  }
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

/* ---------- 全局快捷键：显示 / 隐藏宠物（1.4.0）---------- */
let hotkeyCur = '', hotkeyOk = true;
/** 宠物正显示 → 隐藏；没显示（手动隐藏或全屏隐藏）→ 显示。全屏隐藏时按快捷键先显示 30 秒，之后全屏规则恢复（与一键复位一致）。 */
function togglePetVisible() {
  const visible = !!(pet && !pet.isDestroyed() && pet.isVisible());
  if (visible) R.userHidden = true;
  else {
    R.userHidden = false;
    if (R.fsHidden) {
      R.resetShowUntil = Date.now() + 30000;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { resetTimer = null; if (!quitting) syncVisibility(); }, 30100);
    }
  }
  syncVisibility(); refreshMenu();
  if (!R.userHidden && pet && !pet.isDestroyed()) { ensurePetVisible(); pet.moveTop(); }
}
function applyHotkey() {
  try { if (hotkeyCur) globalShortcut.unregister(hotkeyCur); } catch (_) {}
  hotkeyCur = ''; hotkeyOk = true;
  const k = normalizeHotkey(S.hotkey);
  if (!k) return; // 已关闭
  try { hotkeyOk = globalShortcut.register(k, () => togglePetVisible()); } catch (_) { hotkeyOk = false; }
  if (hotkeyOk) hotkeyCur = k; else log(`全局快捷键 ${k} 注册失败（可能已被其他程序占用）`);
}
const hkHint = () => (hotkeyCur ? `（${hotkeyCur}）` : '');
/* 1.5.0：打开“任务管理器”页的全局快捷键（默认关闭，只能从固定列表选，且不能与宠物快捷键相同） */
let procHkCur = '', procHkOk = true;
function applyProcHotkey() {
  try { if (procHkCur) globalShortcut.unregister(procHkCur); } catch (_) {}
  procHkCur = ''; procHkOk = true;
  const k = normalizeProcHotkey(S.procHotkey);
  if (!k || k === hotkeyCur) return;
  try { procHkOk = globalShortcut.register(k, () => openDashboard('pm')); } catch (_) { procHkOk = false; }
  if (procHkOk) procHkCur = k; else log(`任务管理器快捷键 ${k} 注册失败（可能已被其他程序占用）`);
}
const pmHint = () => (procHkCur ? `（${procHkCur}）` : '');

/* ---------- 菜单 / 托盘 ---------- */
function buildMenu() {
  const fv = focusT.view(Date.now());
  const fLabel = fv.phase === 'idle' ? t('tray.focus.idle') : t('tray.focus.state', { phase: fv.phase === 'focus' ? t('focus.phase.focus') : t('focus.phase.break'), min: Math.ceil(fv.remainMs / 60000), paused: fv.running ? '' : t('tray.focus.paused') });
  const plans = (powerCache && powerCache.ok ? powerCache.plans : []);
  return Menu.buildFromTemplate([
    { label: t('tray.reset'), click: () => resetPet() },
    { label: t('tray.show') + hkHint(), enabled: R.userHidden, click: () => { R.userHidden = false; syncVisibility(); refreshMenu(); } },
    { label: t('tray.hide') + hkHint(), enabled: !R.userHidden, click: () => { R.userHidden = true; syncVisibility(); refreshMenu(); } },
    { label: t('tray.open'), click: () => openDashboard() },
    { label: t('tray.focus'), submenu: [
      { label: fLabel, enabled: false },
      { label: fv.phase !== 'idle' && !fv.running ? t('focus.resume') : t('focus.start'), enabled: !fv.running, click: () => focusCtl('start') },
      { label: t('focus.pause'), enabled: fv.running, click: () => focusCtl('pause') },
      { label: t('focus.skip'), enabled: fv.phase !== 'idle', click: () => focusCtl('skip') },
      { label: t('focus.reset'), enabled: fv.phase !== 'idle', click: () => focusCtl('reset') },
      { label: t('tray.focus.page'), click: () => openDashboard('focus') }] },
    { type: 'separator' },
    { label: t('tray.clean'), click: () => openDashboard('clean') },
    { label: t('tray.boot'), click: () => openDashboard('boot') },
    { label: t('tray.trim'), click: () => { doTrim('manual').catch(() => {}); } },
    { label: t('tray.pm') + pmHint(), click: () => openDashboard('pm') },
    { label: t('tray.upd'), click: () => openDashboard('upd') },
    { label: t('tray.drv'), click: () => openDashboard('drv') },
    { label: t('tray.av'), click: () => openDashboard('av') },
    { label: t('tray.disk'), click: () => openDashboard('disk') },
    { label: t('tray.power'), submenu: [
      ...(plans.length ? plans.map((pl) => ({ label: planName(pl), type: 'radio' as const, checked: pl.active, click: () => { powerDo('plan', pl.guid).catch(() => {}); } }))
        : [{ label: t('tray.power.none'), enabled: false }]),
      { type: 'separator' as const },
      { label: t('tray.power.cool', { pct: S.power.coolMax }), click: () => { powerDo('cool', S.power.coolMax).catch(() => {}); } },
      { label: t('pow.restore'), enabled: !!S.powerBackup, click: () => { powerDo('restore').catch(() => {}); } },
      { label: t('tray.power.page'), click: () => openDashboard('power') }] },
    { label: vpn.running() ? t('tray.vpnOn') : t('tray.vpn'), click: () => { if (vpn.running()) vpn.stop(); else openDashboard('vpn'); } },
    { type: 'separator' },
    { label: t('tray.pause'), type: 'checkbox', checked: R.paused, click: (i) => setRuntime({ paused: i.checked }) },
    { label: t('tray.dnd'), type: 'checkbox', checked: R.dnd, click: (i) => setRuntime({ dnd: i.checked }) },
    { label: t('tray.pass'), type: 'checkbox', checked: R.passthrough, click: (i) => setRuntime({ passthrough: i.checked }) },
    { label: t('tray.compact'), type: 'checkbox', checked: S.compact, click: (i) => applyPatch({ compact: i.checked }) },
    { label: t('tray.pets'), submenu: PETS.map((p) => ({ label: `${p.emoji} ${t('pet.' + p.id)}`, type: 'radio', checked: S.pet === p.id, click: () => applyPatch({ pet: p.id }) })) },
    { label: t('tray.lang'), submenu: [['auto', t('lang.auto')], ['zh', '中文'], ['en', 'English']].map(([k, l]) => ({ label: l, type: 'radio', checked: S.language === k, click: () => applyPatch({ language: k }) })) },
    { type: 'separator' },
    { label: t('tray.settings'), click: () => openDashboard('set') },
    { label: t('tray.selfupd'), click: () => openDashboard('set') },
    { label: t('tray.autostart'), type: 'checkbox', checked: autostartOn(), click: (i) => applyPatch({ autostart: i.checked }) },
    { label: t('tray.quit'), click: () => app.quit() }
  ] as any);
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
const speedAlert = new SpeedAlert();             // 1.5.0
const focusT = new FocusTimer(FOCUS_DEFAULT);    // 1.5.0
const thermal = new power.ThermalGuard();        // 1.5.0
const saverGuard = new power.BatterySaverGuard(); // 1.5.0
let powerCache: power.PowerStatus | null = null;
const REMIND = () => ({ sit: [t('rm.sit.t'), t('rm.sit.b')], water: [t('rm.water.t'), t('rm.water.b')] });
let remindLabel = '', remindUntil = 0;
function checkQuota() {
  if (!(S.quota.gb > 0) || !S.privacy.net) return;
  const m = db.month(), key = localMonthKey();
  if (S.quota.month !== key) { S.quota.month = key; S.quota.notified = 0; save('quota'); }
  const step = quotaStep(m.rx + m.tx, S.quota.gb, S.quota.notified);
  if (!step) return;
  S.quota.notified = step; save('quota');
  const tt = step >= 100 ? t('n.quota100') : t('n.quota80');
  notify(tt, t('n.quota.b', { used: ((m.rx + m.tx) / 1073741824).toFixed(1), gb: S.quota.gb })); try { db.addWarning(step >= 100 ? 'warn' : 'info', tt, ''); } catch (_) {}
  remindLabel = step >= 100 ? t('b.quota100') : t('b.quota80'); remindUntil = Date.now() + 60e3; publish(true);
}
let lastTrimAt = 0, lastSchedTrim = 0; // 1.5.0：所有整理共用“上次整理时间”（自动整理之间至少隔 10 分钟）
async function doTrim(mode: memtrim.TrimMode) {
  const auto = mode !== 'manual';
  lastTrimAt = Date.now(); if (mode === 'scheduled') lastSchedTrim = lastTrimAt;
  const r = await memtrim.trim([process.pid, ...app.getAppMetrics().map((m) => m.pid)], { mode, exclude: S.memTrim.exclude });
  S.lastTrim = { ...r, at: Date.now(), auto }; save('lastTrim');
  const mb = (x: number) => (x / 1048576).toFixed(0);
  log(`运行内存清理（${mode}）：候选 ${r.candidates || 0} 个，处理 ${r.trimmed} 个程序，可用内存变化约 ${mb(r.freed || 0)}MB，用时 ${r.ms || 0}ms${r.error ? ' 错误=' + r.error : ''}`);
  try { if (r.ok || r.error) db.addTrimRun({ at: r.at, mode, ok: r.ok, trimmed: r.trimmed, failed: r.failed, candidates: r.candidates || 0, freed: r.freed || 0, wsFreed: r.wsFreed, availBefore: r.availBefore, availAfter: r.availAfter, ms: r.ms || 0, error: r.error || '' }); } catch (_) {}
  // 定期整理默认静默（只写日志）；超阈值自动整理沿用旧行为发通知（勿扰时不发）
  if (mode === 'threshold' && r.ok && r.trimmed > 0) notify(t('n.trim.t'), t('n.trim.b', { after: ((r.after / os.totalmem()) * 100).toFixed(0), before: ((r.before / os.totalmem()) * 100).toFixed(0) }));
  return S.lastTrim;
}
function setRuntime(p) {
  if (typeof p.paused === 'boolean') { R.paused = p.paused; fsm.reset(Date.now()); }
  if (typeof p.dnd === 'boolean') { R.dnd = p.dnd; fsm.setMuted(mutedList()); }
  if (typeof p.passthrough === 'boolean') { R.passthrough = p.passthrough; if (pet && !pet.isDestroyed()) pet.setIgnoreMouseEvents(R.passthrough, { forward: true }); } // 窗口重建中也记住状态，createPet 会重新应用
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
  if (typeof p.autostart === 'boolean') { try { app.setLoginItemSettings({ openAtLogin: p.autostart, ...loginOpts() }); } catch (e: any) { log('设置开机自启失败 ' + ((e && e.message) || e)); } }
  if (typeof p.alwaysOnTop === 'boolean') { S.alwaysOnTop = p.alwaysOnTop; if (pet && !pet.isDestroyed()) pet.setAlwaysOnTop(p.alwaysOnTop, 'screen-saver'); save('alwaysOnTop'); }
  if (p.hotkey !== undefined) { const k = normalizeHotkey(p.hotkey); if (k !== null && (!k || k !== S.procHotkey)) { S.hotkey = k; save('hotkey'); applyHotkey(); applyProcHotkey(); } }
  if (p.procHotkey !== undefined) { const k = normalizeProcHotkey(p.procHotkey); if (k !== null && (!k || k !== S.hotkey)) { S.procHotkey = k; save('procHotkey'); applyProcHotkey(); } }
  // ---- 1.5.0 ----
  if (typeof p.language === 'string' && LANG_SETTINGS.includes(p.language)) { S.language = p.language; save('language'); applyLang(); }
  if (p.speedAlert && typeof p.speedAlert === 'object') { S.speedAlert = sanitizeSpeedAlert(S.speedAlert, p.speedAlert); speedAlert.reset(); save('speedAlert'); }
  if (p.look && typeof p.look === 'object') { S.look = sanitizeLook({ ...S.look, ...p.look }, growthLevel(), achDone()); save('look'); sendAll('settings', { look: S.look }); }
  if (p.focus && typeof p.focus === 'object') { S.focus = sanitizeFocus(S.focus, p.focus); focusT.setCfg(S.focus); save('focus'); sendFocus(); }
  if (p.weekly && typeof p.weekly.on === 'boolean') { S.weekly.on = p.weekly.on; save('weekly'); }
  if (p.diskAuto && typeof p.diskAuto.on === 'boolean' && !SAFE) { S.diskAuto.on = p.diskAuto.on; save('diskAuto'); }
  if (p.defSched && typeof p.defSched.on === 'boolean' && !SAFE) { S.defSched.on = p.defSched.on; save('defSched'); }
  if (p.power && typeof p.power === 'object' && !SAFE) { S.power = power.sanitizePower(S.power, p.power); save('power'); }
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
    if ([0, ...memtrim.SCHED_CHOICES].includes(p.memTrim.sched) && !(SAFE && p.memTrim.sched)) S.memTrim.sched = p.memTrim.sched;
    if (Array.isArray(p.memTrim.exclude)) S.memTrim.exclude = memtrim.normalizeExclude(p.memTrim.exclude);
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
const LABEL = () => ({ SLEEP: t('b.SLEEP'), DOWNLOAD: t('b.DOWNLOAD'), UPLOAD: t('b.UPLOAD'), TIRED: t('b.TIRED'), HOT: t('b.HOT'), SWEAT: t('b.SWEAT'), WARNING: t('b.WARNING'), HAPPY: '', IDLE: '' });
const M: any = { rx: null, tx: null, online: true, cpu: null, memPct: null, memUsed: 0, memTotal: os.totalmem(), temp: null, healthBad: false, state: 'IDLE', cores: [] as number[] };
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
  const tt = up ? t('n.netUp') : t('n.netDown');
  notify(tt, up ? t('n.netUp.b') : t('n.netDown.b')); try { db.addWarning('info', tt, ''); } catch (_) {}
}
function inetEvent(r) {
  const tt = r === 'ok' ? t('n.inetOk') : r === 'portal' ? t('n.inetPortal') : t('n.inetFail');
  const b = r === 'ok' ? t('n.inetOk.b') : r === 'portal' ? t('n.inetPortal.b') : t('n.inetFail.b');
  notify(tt, b); try { db.addWarning('info', tt, ''); } catch (_) {}
}
function publish(force) {
  const noInet = S.privacy.net && S.privacy.probe && M.online && (probeSt.value === 'fail' || probeSt.value === 'portal');
  const fv = focusT.view(Date.now());
  const focusLabel = fv.phase === 'focus' ? t('b.focus', { min: Math.ceil(fv.remainMs / 60000) }) + (fv.running ? '' : t('tray.focus.paused')) : fv.phase === 'break' ? t('b.break', { min: Math.ceil(fv.remainMs / 60000) }) : '';
  const label = Date.now() < remindUntil && !R.paused ? remindLabel : R.paused ? t('b.paused') : (S.privacy.net && !M.online) ? t('b.offline') : noInet ? (probeSt.value === 'portal' ? t('b.portal') : t('b.noInet')) : focusLabel || LABEL()[M.state] || '';
  const p = { state: M.state, label, paused: R.paused, dnd: R.dnd, online: S.privacy.net ? M.online : null, internet: S.privacy.net && S.privacy.probe ? probeSt.value : null, focus: fv.phase === 'idle' ? null : fv.phase };
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
        if (skip > 0) { skip--; M.rx = 0; M.tx = 0; } else { M.rx = n.rx; M.tx = n.tx; db.addTraffic(n.rx * dt, n.tx * dt, n.rx); minBytes += (n.rx + n.tx) * dt; }
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
      // 1.5.0 网速异常提醒（默认关闭；勿扰 / 全屏 / 暂停时只计时不提醒）
      for (const k of speedAlert.update(now, M.online ? M.rx : null, S.speedAlert, reminderMuted())) onSpeedAlert(k);
    } else { M.rx = M.tx = null; speedAlert.reset(); }
    if (S.privacy.hw) {
      if (tickN % 3 === 0) {
        try {
          const cl = await si.currentLoad(); M.cpu = cl.currentLoad; M.cores = Array.isArray(cl.cpus) ? cl.cpus.map((c) => Number(c.load) || 0) : []; M.memTotal = os.totalmem(); M.memUsed = M.memTotal - os.freemem(); M.memPct = (M.memUsed / M.memTotal) * 100;
          if (now - lastTemp > 20000) { lastTemp = now; try { const t = await si.cpuTemperature(); M.temp = t && t.main > 0 ? t.main : null; } catch (_) {} }
          const smp = { cpu: M.cpu, used: M.memUsed, total: M.memTotal, pct: M.memPct, temp: M.temp };
          send(dash, 'sample', smp); send(panel, 'sample', smp);
          if (now - lastHw > 60000) { lastHw = now; try { db.addHardware(now, M.cpu, M.memPct, M.temp); db.maxCounter('cpuMax', M.cpu); } catch (_) {} }
          if (S.memTrim.auto && trimTrig.update(now, M.memPct, S.memTrim.threshold) && now - lastTrimAt >= memtrim.MIN_GAP_MS && !memtrim.isBusy()) doTrim('threshold').catch(() => {});
          if (M.memPct >= S.memAlert && now - lastMemNotify > 10 * 60e3) { lastMemNotify = now; notify(t('n.mem.t'), t('n.mem.b', { pct: M.memPct.toFixed(0) })); }
        } catch (_) {}
      }
    } else { M.cpu = M.memPct = M.temp = null; M.cores = []; }
  } else speedAlert.reset();
  // 1.5.0 番茄钟（与“暂停监控”无关，照常计时）
  const fe = focusT.tick(now);
  if (fe) onFocusEvent(fe);
  else if (focusT.phase !== 'idle' && tickN % 15 === 0) publish(false); // 剩余分钟数变化时刷新气泡
  // 1.5.0 自动温度保护（默认关闭；读不到温度时不工作）
  if (tickN % 3 === 0) thermalTick(now);
  const input = R.paused ? { rx: null, tx: null, cpu: null, memPct: null, temp: null, memAlert: S.memAlert, warning: false }
    : { rx: M.rx, tx: M.tx, cpu: M.cpu, memPct: M.memPct, temp: M.temp, memAlert: S.memAlert, warning: M.healthBad };
  M.state = fsm.update(now, input);
  publish(false);
  if (S.privacy.net && !R.paused) {
    const sp = { rx: M.rx, tx: M.tx, online: M.online };
    sendAll('speed', sp);
    // 旧版每秒覆盖托盘提示，syncVisibility 写的“宠物已隐藏”提示一闪就没了
    if (tray) tray.setToolTip(`NetPet\n↓ ${fmt(M.rx)}\n↑ ${fmt(M.tx)}${R.userHidden ? '\n' + t('tray.hiddenTip2') : ''}`);
  } else { sendAll('speed', { rx: null, tx: null, online: null }); if (tray) tray.setToolTip(R.paused ? t('tray.pausedTip') : 'NetPet'); }
  maybeClearFlag();
  if (tickN % 60 === 0) { try { db.flush(); } catch (_) {} try { checkQuota(); } catch (_) {} }
  if (tickN % 30 === 0 && (S.remind.sit > 0 || S.remind.water > 0)) {
    reminder.sitMin = S.remind.sit; reminder.waterMin = S.remind.water;
    let idle = 0; try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
    // 1.5.0：番茄钟专注期间不弹久坐提醒（喝水提醒照常）
    for (const k of reminder.tick(now, idle, R.dnd || R.paused || R.fsHidden || R.userHidden, focusT.focusing())) {
      const RM = REMIND();
      remindLabel = RM[k][0]; remindUntil = now + 20e3; publish(true);
      try { db.bump('remind'); } catch (_) {}
      try { if (Notification.isSupported()) new Notification({ title: RM[k][0], body: RM[k][1], silent: true }).show(); } catch (_) {}
    }
  }
  if (remindUntil && now >= remindUntil) { remindUntil = 0; publish(true); } // 每分钟落盘，异常退出最多丢 1 分钟流量
  if (tickN % 3600 === 0) { try { db.prune(S.retentionDays); } catch (_) {} } // 常驻时每小时按保留期清理一次
  if (tickN % 60 === 0 && !R.paused && (S.privacy.net || S.privacy.hw)) { S.growth.xp += 1 + (minBytes / 1e9) * 5; minBytes = 0; if (tickN % 300 === 0) save('growth'); }
  // 1.5.0：每周小结 / 定期内存整理（每分钟看一次）；磁盘自动整理 / 定期病毒扫描 / 低电量节能（每 5 分钟看一次）
  if (tickN % 60 === 30) { try { maybeWeekly(false); } catch (e: any) { log('每周小结出错 ' + (e && e.message)); } maybeSchedTrim(now); }
  if (tickN % 300 === 120) { maybeDiskAuto(now).catch(() => {}); maybeDefSched(now); batteryTick().catch(() => {}); }
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
let connBusy = false;
async function connTick() {
  // 连接表读取最长可等 15 秒，而定时器每 8 秒一次：旧版会并发多次读取、重复写入同一批连接
  if (R.paused || !S.privacy.conn || connBusy) return;
  connBusy = true;
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
        notify(t('n.newProc.t'), t('n.newProc.b', { p, host: r.host || r.ip, port: r.port }));
        try { db.addWarning('info', t('w.newProc', { p }), `${r.ip}:${r.port}`); } catch (_) {}
      }
      if (npw.known.size !== before) { S.newProc.known = npw.list(); save('newProc'); }
    }
    for (const [k, t] of seen) if (now - t > 10 * 60e3) seen.delete(k);
  } catch (_) {} finally { connBusy = false; }
}

/* ---------- 健康检查 ---------- */
// 同一时间只跑一次体检：手动“开始体检”和 6 小时定时复查撞在一起时，旧版会同时起两组（约 18 个）PowerShell
let healthRun: Promise<any> | null = null;
function runHealth(): Promise<any> {
  if (!healthRun) healthRun = runHealthInner().finally(() => { healthRun = null; });
  return healthRun;
}
async function runHealthInner() {
  const ctx = {
    memPct: M.memPct, cpu: M.cpu,
    baseline: (k) => S.baselines[k], setBaseline: (k, v) => { S.baselines[k] = v; }
  };
  const rep = await security.run(si, ctx);
  save('baselines');
  try { db.addHealth(rep); for (const i of rep.items) if (i.status === 'bad' || i.status === 'warn') db.addWarning(i.status, i.title, i.detail); } catch (_) {}
  const wasBad = M.healthBad;
  M.healthBad = rep.items.some((i) => i.status === 'bad');
  if (M.healthBad && !wasBad) notify(t('n.health.t'), t('n.health.b'));
  fsm.update(Date.now(), { rx: M.rx, tx: M.tx, cpu: M.cpu, memPct: M.memPct, temp: M.temp, memAlert: S.memAlert, warning: M.healthBad });
  return rep;
}

/* ---------- 1.5.0：语言 / 成长 / 网速提醒 / 番茄钟 / 每周小结 / 自动任务 ---------- */
function applyLang() {
  setLang(resolveLang(S.language, (() => { try { return app.getLocale(); } catch (_) { return ''; } })()));
  sendAll('settings', { lang: getLang() }); refreshMenu(); publish(true);
}
const growthLevel = () => Math.floor(Math.sqrt(Math.floor(S.growth.xp) / 30)) + 1;
function achList() {
  const s = db.stats(), MB = 1048576, GB = 1073741824;
  let focusN = 0; try { focusN = db.counterTotal('focus'); } catch (_) {}
  return [
    { id: 'speed10', name: t('ach.speed10'), desc: t('ach.speed10.d'), done: s.peakRx >= 10 * MB }, { id: 'speed100', name: t('ach.speed100'), desc: t('ach.speed100.d'), done: s.peakRx >= 100 * MB },
    { id: 'gb10', name: t('ach.gb10'), desc: t('ach.gb10.d'), done: s.total >= 10 * GB }, { id: 'gb100', name: t('ach.gb100'), desc: t('ach.gb100.d'), done: s.total >= 100 * GB },
    { id: 'week', name: t('ach.week'), desc: t('ach.week.d'), done: s.daysUsed >= 7 }, { id: 'focus5', name: t('ach.focus5'), desc: t('ach.focus5.d'), done: focusN >= 5 }
  ];
}
const achDone = () => { try { return achList().filter((a) => a.done).map((a) => a.id); } catch (_) { return []; } };
function onSpeedAlert(k: string) {
  const fmtMB = (n: number) => n + ' MB/s';
  const tt = k === 'low' ? t('n.slow.t') : t('n.fast.t');
  const b = k === 'low' ? t('n.slow.b', { sec: S.speedAlert.lowSec, kb: S.speedAlert.lowKB })
    : t('n.fast.b', { sec: S.speedAlert.highSec, mb: fmtMB(S.speedAlert.highMB) });
  remindLabel = k === 'low' ? t('b.slow') : t('b.fast'); remindUntil = Date.now() + 30e3; publish(true);
  notify(tt, b, { silent: true });
  try { db.bump('remind'); db.addWarning('info', tt, ''); } catch (_) {}
  log(`网速异常提醒：${k}`);
}
const focusToday = () => { try { const d = new Date(), k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; const c = db.counters(k, k); return { n: c.focus || 0, min: c.focusMin || 0 }; } catch (_) { return { n: 0, min: 0 }; } };
const focusView = () => ({ ...focusT.view(Date.now()), cfg: S.focus, today: focusToday() });
const sendFocus = () => { sendAll('focus', focusView()); refreshMenu(); publish(true); };
function focusCtl(a: string) {
  const now = Date.now();
  if (a === 'start') focusT.start(now); else if (a === 'pause') focusT.pause(now); else if (a === 'reset') focusT.reset(); else if (a === 'skip') focusT.skip(now); else return false;
  sendFocus(); return true;
}
function onFocusEvent(e: { type: string; minutes: number }) {
  if (e.type === 'focusDone') {
    try { db.bump('focus'); db.bump('focusMin', e.minutes); } catch (_) {}
    remindLabel = t('b.focusDone'); remindUntil = Date.now() + 20e3;
    if (!reminderMuted()) notify(t('n.focusDone.t'), t('n.focusDone.b', { min: e.minutes, rest: S.focus.breakMin }), { onClick: () => openDashboard('focus') });
    log(`番茄钟完成 ${e.minutes} 分钟`);
  } else {
    remindLabel = t('b.breakDone'); remindUntil = Date.now() + 15e3;
    if (!reminderMuted()) notify(t('n.breakDone.t'), t('n.breakDone.b'));
  }
  sendFocus();
}
/** 每周小结：新的一周里第一次检测到用户在用电脑时生成上周的小结（force = 手动重新生成，不发通知）。 */
function maybeWeekly(force: boolean) {
  if (!force) {
    if (!weekly.shouldGenerate(Date.now(), S.weekly.last, S.weekly.on)) return null;
    let idle = 0; try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
    if (idle > 120) return null; // 等用户回来再生成
  }
  const r = weekly.lastWeekRange(Date.now());
  try { db.flush(); } catch (_) {}
  const c = db.counters(r.fromDay, r.toDay);
  const sum = weekly.buildSummary({ range: r, days: db.dailyRange(r.fromDay, r.toDay), health: db.healthRange(r.start, r.end), counters: c, cpuPeak: c.cpuMax != null ? c.cpuMax : db.cpuPeak(r.start, r.end) });
  db.saveWeekly(r.key, sum); S.weekly.last = r.key; save('weekly');
  log(`已生成每周小结 ${r.key}${force ? '（手动）' : ''}${sum.empty ? '（几乎没有数据，不发通知）' : ''}`);
  if (!force && !sum.empty && !reminderMuted()) notify(t('n.week.t'), t('n.week.b', { from: sum.from.slice(5), to: sum.to.slice(5), gb: (sum.traffic.total / 1073741824).toFixed(1), focus: sum.focus.sessions }), { onClick: () => openDashboard('week') });
  return sum;
}
function maybeSchedTrim(now: number) {
  if (!S.memTrim.sched || memtrim.isBusy() || !S.privacy.hw) return;
  let idle = 0; try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
  const r = memtrim.scheduleEligible({ now, enabled: S.memTrim.sched > 0, intervalMin: S.memTrim.sched, lastScheduled: lastSchedTrim, lastAnyTrim: lastTrimAt, idleSec: idle, locked: !!R.screenLocked, fullscreen: !!R.fsHidden, focus: focusT.focusing(), memPct: M.memPct });
  if (r.ok) doTrim('scheduled').catch(() => {});
}
const onBattery = () => { try { return powerMonitor.isOnBatteryPower(); } catch (_) { return false; } };
let lastDisk: any = null;
async function maybeDiskAuto(now: number) {
  if (!S.diskAuto.on || SAFE || diskopt.state().running) return;
  let idle = 0; try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
  const e = idleTaskEligible({ now, enabled: true, last: S.diskAuto.last, lastTry: S.diskAuto.lastTry, intervalMs: WEEK_MS, retryMs: 24 * 3600e3, idleSec: idle, minIdleSec: 600, onAC: !onBattery(), fullscreen: !!R.fsHidden, focus: focusT.focusing() });
  if (!e.ok) return;
  S.diskAuto.lastTry = now; save('diskAuto');
  const a = lastDisk = await diskopt.analyze();
  if (!a.ok || !a.admin) { log('磁盘自动整理跳过：' + (a.ok ? '没有管理员权限' : a.error)); return; }
  const res: string[] = []; let anyOk = false;
  for (const v of a.vols.filter((x) => x.action !== 'skip')) {
    if (onBattery() || R.fsHidden || focusT.focusing()) break; // 中途拔电 / 进入全屏 / 开始专注就停
    const r: any = await diskopt.optimize(v.letter, v.media, { admin: a.admin, onBattery: onBattery(), auto: true });
    anyOk = anyOk || r.ok; res.push(`${v.letter}: ${r.ok ? 'OK' : r.error}`);
  }
  if (anyOk) { S.diskAuto.last = Date.now(); save('diskAuto'); }
  log('磁盘自动整理：' + res.join('；'));
  if (res.length) notify(t('n.disk.t'), res.join('\n'), { silent: true });
}
function maybeDefSched(now: number) {
  if (!S.defSched.on || SAFE || defender.machine.state === 'running') return;
  let idle = 0; try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
  const e = idleTaskEligible({ now, enabled: true, last: S.defSched.last, lastTry: S.defSched.lastTry, intervalMs: WEEK_MS, retryMs: 24 * 3600e3, idleSec: idle, minIdleSec: 600, onAC: !onBattery(), fullscreen: !!R.fsHidden, focus: focusT.focusing() });
  if (!e.ok) return;
  S.defSched.lastTry = now; save('defSched');
  defender.readStatus().then((st) => {
    if (!st.canScan) { log('定期快速扫描跳过：' + (st.thirdActive ? '第三方杀毒软件在工作' : st.error || 'Defender 不可用')); return; }
    const r = defender.startScan('quick', '', (ok, err, startedAt) => { if (ok) { S.defSched.last = Date.now(); save('defSched'); } onScanDone('quick', ok, err, startedAt, true); });
    if (!r.ok) log('定期快速扫描没有开始：' + r.error);
  }).catch(() => {});
}
async function onScanDone(type: string, ok: boolean, err: string, startedAt: number, auto = false) {
  log(`Defender ${type} 扫描${auto ? '（定期）' : ''}：${ok ? '完成' : '失败 ' + err}`);
  let found: defender.Threat[] = [];
  try { const th = await defender.readThreats(); if (th.ok) found = defender.newDetections(th.items, startedAt); } catch (_) {}
  if (found.length) {
    notify(t('n.threat.t', { n: found.length }), t('n.threat.b', { names: found.slice(0, 3).map((x) => x.name).join('、') }), { onClick: () => openDashboard('av') });
    try { db.addWarning('bad', t('n.threat.t', { n: found.length }), found.map((x) => x.name).join(', ').slice(0, 300)); } catch (_) {}
  } else if (!auto || !ok) notify(t('n.scan.t', { res: ok ? t('def.res.ok') : t('def.res.fail') }), ok ? '' : err, { silent: true });
  sendAll('runtime', { ...R });
}
/* 温度与节能 */
const planName = (pl: power.Plan) => (['balanced', 'high', 'ultimate', 'saver'].includes(pl.kind) ? t('pow.kind.' + pl.kind) : pl.name || pl.guid);
async function powerRefresh() { try { powerCache = await power.status(); } catch (_) {} refreshMenu(); return powerCache; }
let powerBusy = false;
async function powerDo(kind: 'plan' | 'cool' | 'restore', arg?: any, auto?: 'cooling' | 'saver'): Promise<any> {
  if (SAFE) return { ok: false, error: t('pow.err.safe') };
  if (powerBusy) return { ok: false, error: t('pow.err.busy') };
  powerBusy = true;
  try {
    const st = await power.status();
    if (!st.ok) return { ok: false, error: st.error };
    let r: any;
    if (kind === 'restore') {
      r = await power.restore(S.powerBackup, st.plans);
      if (r.ok) { S.powerBackup = null; S.powerAuto = { cooling: false, saver: false }; save('powerBackup', 'powerAuto'); }
    } else {
      // 第一次修改前备份原值（之后的修改不覆盖备份，“恢复原设置”总是回到 NetPet 第一次修改之前）
      if (!S.powerBackup) { S.powerBackup = { at: Date.now(), scheme: st.active, max: st.max, cool: st.cool }; save('powerBackup'); }
      r = kind === 'plan' ? await power.setPlan(String(arg || ''), st.plans) : await power.applyCooling(Number(arg), st);
      if (r.ok && auto) { S.powerAuto[auto] = true; save('powerAuto'); }
    }
    log(`电源设置 ${kind}${auto ? '（自动:' + auto + '）' : ''} ${arg ?? ''} → ${r.ok ? '成功' : '失败 ' + r.error}`);
    return r;
  } finally { powerBusy = false; powerRefresh().catch(() => {}); }
}
function thermalTick(now: number) {
  const a = thermal.update(now, S.privacy.hw && !R.paused ? M.temp : null, S.power.threshold, !!S.power.guard && !SAFE);
  if (a === 'apply') {
    powerDo('cool', S.power.coolMax, 'cooling').then((r) => { if (r.ok) notify(t('n.cool.t'), t('n.cool.b', { th: S.power.threshold, pct: S.power.coolMax }), { silent: true }); });
  } else if (a === 'restore' && S.powerAuto.cooling) {
    powerDo('restore').then((r) => { if (r.ok) notify(t('n.coolEnd.t'), '', { silent: true }); });
  }
}
let batCache: [number, any] = [0, null];
async function batteryTick() {
  if (!S.power.saver || SAFE) { if (saverGuard.on) { saverGuard.update(false, null, 0, false); if (S.powerAuto.saver) await powerDo('restore'); } return; }
  if (Date.now() - batCache[0] > 60e3) { try { const b = await si.battery(); batCache = [Date.now(), b && b.hasBattery ? b.percent : null]; } catch (_) { batCache = [Date.now(), null]; } }
  const a = saverGuard.update(onBattery(), batCache[1], S.power.saverPct, true);
  if (a === 'apply') {
    const st = powerCache && powerCache.ok ? powerCache : await powerRefresh();
    const saver = st && st.ok ? st.plans.find((x) => x.kind === 'saver') : null;
    if (!saver) { log('低电量节能：这台电脑没有“节能”电源方案，跳过'); return; }
    if (saver.active) return;
    const r = await powerDo('plan', saver.guid, 'saver');
    if (r.ok) notify(t('n.saver.t'), t('n.saver.b', { pct: batCache[1] }), { silent: true });
  } else if (a === 'restore' && S.powerAuto.saver) await powerDo('restore');
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

  let cache: any = { disks: [0, []], gpu: [0, []], ifs: [0, []], bat: [0, null], procs: [0, null], pm: [0, []] };
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
  handle('trim-mem', async () => doTrim('manual'));
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
        settings: { privacy: S.privacy, compact: S.compact, alwaysOnTop: S.alwaysOnTop, retentionDays: S.retentionDays, memAlert: S.memAlert, memTrim: { ...S.memTrim, exclude: S.memTrim.exclude.length }, quotaGB: S.quota.gb, remind: S.remind, newProcOn: S.newProc.on, hasLock: !!S.lock, vpnConfigured: !!(S.vpn.exe && S.vpn.config), pet: S.pet,
          language: S.language, lang: getLang(), speedAlertOn: S.speedAlert.on, focus: S.focus, weeklyOn: S.weekly.on, diskAutoOn: S.diskAuto.on, defSchedOn: S.defSched.on, power: S.power, hasPowerBackup: !!S.powerBackup, powerAuto: S.powerAuto, look: S.look, procHotkey: S.procHotkey },
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
      const src = Buffer.from(tmp, 'utf8').toString('base64'), dst = Buffer.from(r.filePath, 'utf8').toString('base64');
      const ok = await new Promise<boolean>((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${src}'));$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${dst}'));try{$f=@(Get-ChildItem -LiteralPath $s -File | ForEach-Object { $_.FullName });Compress-Archive -LiteralPath $f -DestinationPath $d -Force -ErrorAction Stop;'done'}catch{'fail'}`],
        { windowsHide: true, timeout: 60000, encoding: 'utf8' }, (e, o) => res(!e && String(o).trim() === 'done')));
      return ok ? { ok: true, path: r.filePath } : { ok: false, msg: t('err.zip') };
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
    try { fs.writeFileSync(r.filePath, db.toCsv(db.connections(days, str(a && a.q), 100000).rows)); } catch (e: any) { return { ok: false, msg: String((e && e.message) || e) }; } // 文件被 Excel 占用等
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
  // 1.5.0：健康页的“快速扫描”也走病毒查杀模块，与“病毒查杀”页共用同一个扫描（同一时间只有一个）
  handle('quick-scan', async () => {
    if (!S.privacy.health) return false;
    return new Promise<boolean>((res) => {
      const r = defender.startScan('quick', '', (ok, err, startedAt) => { onScanDone('quick', ok, err, startedAt); res(ok); });
      if (!r.ok) { notify(t('n.qs.t'), r.error || ''); res(false); }
    });
  });

  handle('get-settings', () => ({
    privacy: S.privacy, memTrim: S.memTrim, quota: S.quota, remind: S.remind, newProc: { on: S.newProc.on, learnUntil: S.newProc.learnUntil, count: S.newProc.known.length }, compact: S.compact, alwaysOnTop: S.alwaysOnTop, retentionDays: S.retentionDays, pet: S.pet, memAlert: S.memAlert, anim: S.anim,
    hotkey: S.hotkey, hotkeyOk, autostart: autostartOn(),
    language: S.language, lang: getLang(), speedAlert: S.speedAlert, look: S.look, focus: S.focus, weekly: { on: S.weekly.on, last: S.weekly.last }, diskAuto: S.diskAuto, defSched: S.defSched,
    power: S.power, powerBackup: S.powerBackup ? { at: S.powerBackup.at } : null, powerAuto: S.powerAuto, procHotkey: S.procHotkey, procHotkeyOk: procHkOk, safe: SAFE, hasLock: !!S.lock, packaged: app.isPackaged, onboarded: S.onboarded, version: app.getVersion(), dataDir: app.getPath('userData')
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
    const id = str(a && a.id, 600); if (!id || typeof (a && a.enabled) !== 'boolean') return { ok: false, error: t('err.args') };
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
    if (r.ok && winupdate.verdict(r) === 'bad') notify(t('n.upd.t'), t('n.upd.b'));
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
      ? { title: t('dlg.pickSb'), properties: ['openFile'], filters: [{ name: 'sing-box', extensions: ['exe'] }] }
      : { title: t('dlg.pickCfg'), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const f = r.filePaths[0];
    if (kind === 'exe' && !vpn.isSingBoxExe(f)) return { ok: false, error: t('vpn.err.name') };
    if (vpn.running()) return { ok: false, error: t('vpn.err.running') };
    S.vpn[kind] = f; save('vpn'); return { ok: true, path: f };
  });
  handle('vpn-set', (a) => { if (a && typeof a.sysProxy === 'boolean' && !vpn.running()) { S.vpn.sysProxy = a.sysProxy; save('vpn'); } return true; });
  handle('vpn-start', async () => {
    if (SAFE) return { ok: false, error: t('vpn.err.safe') };
    return vpn.start({ exe: S.vpn.exe, config: S.vpn.config, sysProxy: S.vpn.sysProxy, workDir: path.join(userDir, 'sing-box') });
  });
  handle('vpn-stop', async () => { await vpn.stop(); return true; });
  handle('scan-junk', async () => cleaner.scanJunk({ netpetLogsDir: path.join(userDir, 'logs') }));
  let junkBusy = false; // 同一时间只允许一次清理
  handle('clean-junk', async (a) => {
    const ids = Array.isArray(a && a.ids) ? a.ids.filter((x: any) => typeof x === 'string').slice(0, 20) : [];
    if (!ids.length) return [];
    if (junkBusy) throw new Error('busy');
    junkBusy = true;
    try {
      const res = await cleaner.cleanJunk(ids, { netpetLogsDir: path.join(userDir, 'logs') });
      log(`清理系统垃圾：${res.map((r) => `${r.id} 释放 ${(r.freed / 1048576).toFixed(1)}MB/删 ${r.deletedFiles} 个/跳过 ${r.skippedFiles} 个`).join('；')}`);
      return res;
    } finally { junkBusy = false; }
  });
  // 1.4.0：流量日报 / 周报（只读本机数据库，不联网）
  handle('get-traffic-report', (a) => {
    if (!S.privacy.net) return { disabled: true };
    const n = a && a.days === 30 ? 30 : 7;
    return summarize(fillDays(db.daily(n), n));
  });
  // 1.4.0：设置导出 / 导入（JSON）。不含面板密码、VPN 路径和代理备份；导入只认白名单键，并再经过 applyPatch 逐项校验。
  handle('export-settings', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(dash, { defaultPath: `netpet-settings-${stamp}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false };
    try { fs.writeFileSync(r.filePath, JSON.stringify(settingsio.buildExport(S, app.getVersion()), null, 2), 'utf8'); }
    catch (e: any) { return { ok: false, msg: String((e && e.message) || e) }; }
    log('导出设置 → ' + r.filePath);
    return { ok: true, path: r.filePath };
  });
  handle('import-settings', async () => {
    const r = await dialog.showOpenDialog(dash, { title: t('dlg.pickSettings'), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    let text = '';
    try {
      if (fs.statSync(r.filePaths[0]).size > settingsio.MAX_IMPORT_BYTES) return { ok: false, msg: t('imp.big') };
      text = fs.readFileSync(r.filePaths[0], 'utf8');
    } catch (e: any) { return { ok: false, msg: t('imp.read', { msg: (e && e.message) || e }) }; }
    const res = settingsio.parseImport(text);
    if (!res.ok) return { ok: false, msg: res.error };
    // 会新开启的监控项先让用户确认，避免一个设置文件悄悄打开连接记录、联网检测等功能
    const turnOn = settingsio.newlyEnabledPrivacy(S.privacy, res.patch);
    if (turnOn.length) {
      const c = await dialog.showMessageBox(dash, { type: 'question', buttons: [t('imp.go'), t('btn.cancel')], defaultId: 1, cancelId: 1, title: 'NetPet', message: t('imp.q'),
        detail: turnOn.map((k) => '· ' + t('priv.name.' + k)).join('\n') + '\n\n' + t('imp.q2') });
      if (c.response !== 0) return { ok: false, cancelled: true };
    }
    applyPatch(res.patch);
    log('导入设置：' + res.keys!.join(','));
    return { ok: true, keys: res.keys, safe: SAFE };
  });
  handle('get-growth', () => {
    const xp = Math.floor(S.growth.xp), level = growthLevel(), st = db.stats();
    return { xp, level, cur: 30 * (level - 1) ** 2, next: 30 * level ** 2, daysUsed: st.daysUsed, total: st.total };
  });
  handle('get-achievements', () => achList());
  /* ---------------- 1.5.0 新增 IPC ---------------- */
  handle('get-lang', () => getLang());
  // 番茄钟（小面板、宠物也要用，不受面板密码锁限制；只能开始 / 暂停 / 重置 / 跳过）
  handle('focus-get', () => focusView());
  handle('focus-ctl', (a) => { const act = str(a && a.action, 10); return focusCtl(act) ? focusView() : null; });
  handle('focus-history', () => ({ n: db.counterDays('focus', 14), min: db.counterDays('focusMin', 14), total: db.counterTotal('focus') }));
  // 硬件历史曲线（复用 hardware_statistics 表，保留期跟随“历史数据保留天数”）
  handle('get-hw-history', (a) => {
    if (!S.privacy.hw) return { disabled: true };
    const range = a && a.range === '7d' ? '7d' : '24h', sp = rangeSpec(range), since = Date.now() - sp.ms;
    const rows = db.hardwareRows(since);
    return { range, since, bucket: sp.bucket, points: bucketize(rows, rows.length > 1500 && range === '24h' ? 120e3 : sp.bucket), retentionDays: S.retentionDays };
  });
  handle('weekly-list', () => ({ on: S.weekly.on, list: db.weeklyList(60) }));
  handle('weekly-regen', () => maybeWeekly(true));
  // 驱动更新
  handle('drv-scan', async () => drivers.scanLocal());
  handle('drv-online', async () => { const r = await drivers.checkOnline(); S.lastDrvOnline = r; save('lastDrvOnline'); log(`驱动在线检查：${r.ok ? '可用 ' + r.items.length + ' 个' : r.error}`); return r; });
  handle('drv-last-online', () => S.lastDrvOnline || null);
  handle('open-optional-updates', () => { if (process.platform !== 'win32') return false; shell.openExternal('ms-settings:windowsupdate-optionalupdates'); return true; });
  handle('open-devmgmt', () => { if (process.platform !== 'win32') return false; execFile('mmc.exe', ['devmgmt.msc'], { windowsHide: false }, () => {}); return true; });
  // 磁盘整理
  handle('disk-analyze', async () => { lastDisk = await diskopt.analyze(); return { ...lastDisk, onBattery: onBattery(), auto: S.diskAuto, safe: SAFE }; });
  handle('disk-frag', async (a) => { const L = str(a && a.letter, 1); if (!lastDisk || !lastDisk.admin) return { ok: false, error: t('disk.err.admin') }; return diskopt.fragmentation(L); });
  handle('disk-optimize', (a) => {
    if (SAFE) return { ok: false, error: t('disk.err.safe') };
    const L = str(a && a.letter, 1).toUpperCase(), v = lastDisk && lastDisk.vols ? lastDisk.vols.find((x) => x.letter === L) : null;
    if (!v) return { ok: false, error: t('disk.err.letter') };
    if (diskopt.state().running) return { ok: false, error: t('disk.err.busy') };
    if (v.action === 'skip') return { ok: false, error: t('disk.err.unknownMedia') };
    if (!lastDisk.admin) return { ok: false, error: t('disk.err.admin') };
    if (onBattery()) return { ok: false, error: t('disk.err.battery') };
    log(`磁盘优化开始：${L}: ${v.action}`);
    diskopt.optimize(L, v.media, { admin: lastDisk.admin, onBattery: onBattery() }).then((r: any) => {
      log(`磁盘优化 ${L}: → ${r.ok ? '完成' : '失败 ' + r.error}`);
      notify(r.ok ? t('n.diskDone', { l: L }) : t('n.diskFail', { l: L }), r.ok ? '' : r.error, { silent: true });
    });
    return { ok: true, started: true };
  });
  handle('disk-cancel', () => diskopt.cancel());
  handle('disk-state', () => diskopt.state());
  handle('open-dfrgui', () => { if (process.platform !== 'win32') return false; execFile('dfrgui.exe', [], { windowsHide: false }, () => {}); return true; });
  // 温度与节能
  handle('power-status', async () => {
    const st = await powerRefresh();
    let fan: any = null; // systeminformation 在 Windows 上一般读不到风扇转速
    return { ...(st || { ok: false }), temp: S.privacy.hw ? M.temp : null, hwOn: S.privacy.hw, fan, onBattery: onBattery(), battery: batCache[1], cfg: S.power, backup: S.powerBackup, auto: S.powerAuto, guard: thermal.state, safe: SAFE };
  });
  handle('power-set-plan', async (a) => powerDo('plan', str(a && a.guid, 40)));
  handle('power-cool', async (a) => { const v = Number(a && a.pct); if (!power.COOL_CHOICES.includes(v)) return { ok: false, error: 'bad value' }; return powerDo('cool', v); });
  handle('power-restore', async () => powerDo('restore'));
  // 病毒查杀（Microsoft Defender）
  let defPath = '', lastDef: any = null;
  handle('def-status', async () => { lastDef = await defender.readStatus(); return { ...lastDef, sched: S.defSched, lastUpdate: S.lastDefUpdate, safe: SAFE }; });
  handle('def-threats', async () => defender.readThreats());
  handle('def-pick', async (a) => {
    const folder = !!(a && a.folder);
    const r = await dialog.showOpenDialog(dash, { title: folder ? t('dlg.pickFolder') : t('dlg.pickFile'), properties: [folder ? 'openDirectory' : 'openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    defPath = r.filePaths[0]; return { ok: true, path: defPath };
  });
  handle('def-scan', async (a) => {
    const type = str(a && a.type, 10);
    if (!defender.SCAN_TYPES.includes(type)) return { ok: false, error: t('err.args') };
    lastDef = await defender.readStatus();
    if (!lastDef.canScan) return { ok: false, error: lastDef.thirdActive ? t('def.err.third') : lastDef.error || t('def.err.unavail') };
    if (type === 'offline') {
      const c = await dialog.showMessageBox(dash, { type: 'warning', buttons: [t('def.off.go'), t('btn.cancel')], defaultId: 1, cancelId: 1, title: 'NetPet',
        message: t('def.off.q'), detail: t('def.off.d') });
      if (c.response !== 0) return { ok: false, cancelled: true };
    }
    const r = defender.startScan(type, type === 'custom' ? defPath : '', (ok, err, startedAt) => onScanDone(type, ok, err, startedAt));
    log(`Defender ${type} 扫描${r.ok ? '开始' : '没有开始 ' + r.error}`);
    return r;
  });
  handle('def-stop', () => defender.stopWaiting());
  handle('def-state', () => ({ ...defender.machine.view(Date.now()), updating: defender.isUpdating(), customPath: defPath }));
  handle('def-update', async () => { const r = await defender.updateSignatures(); S.lastDefUpdate = { at: Date.now(), ok: r.ok, error: r.error }; save('lastDefUpdate'); log('更新病毒库：' + (r.ok ? '成功' : r.error)); return r; });
  handle('open-def-history', () => { if (process.platform !== 'win32') return false; shell.openExternal('windowsdefender://threathistory'); return true; });
  // 任务管理器（唯一可以结束进程的功能；每次都由用户点击并确认）
  const selfPids = () => [process.pid, ...app.getAppMetrics().map((m) => m.pid)];
  let pmList: any[] = [];
  const pmRefresh = async () => { pmList = procmgr.parseSi(await cached('pm', 1800, async () => (await si.processes()).list), await procmgr.windowTitles()); return pmList; };
  handle('pm-list', async () => { const l = await pmRefresh(); const self = selfPids(); return { list: l.map((p) => ({ ...p, prot: procmgr.protectedReason(p.name, p.pid, self) })), at: Date.now(), cores: os.cpus().length }; });
  handle('pm-detail', async (a) => {
    const pid = Number(a && a.pid); if (!procmgr.validPid(pid)) return null;
    const p = pmList.find((x) => x.pid === pid); if (!p) return null;
    const sig = await procmgr.signature(p.path), parent = pmList.find((x) => x.pid === p.ppid);
    return { ...p, parentName: parent ? parent.name : '', sig, worth: procmgr.worthChecking(p.path, sig.status), prot: procmgr.protectedReason(p.name, p.pid, selfPids()) };
  });
  handle('pm-kill', async (a) => {
    const pid = Number(a && a.pid); if (!procmgr.validPid(pid)) return { ok: false, code: 'badPid' };
    if (!pmList.some((x) => x.pid === pid)) await pmRefresh();
    const p = pmList.find((x) => x.pid === pid); if (!p) return { ok: false, code: 'notFound' };
    const prot = procmgr.protectedReason(p.name, pid, selfPids());
    if (prot) { log(`任务管理器：拒绝结束受保护进程 ${p.name} (${pid}) 原因=${prot}`); return { ok: false, code: 'protected', reason: prot }; }
    const o = { force: !!(a && a.force), tree: !!(a && a.tree) };
    const r = await procmgr.kill(pid, o);
    log(`任务管理器：结束进程 ${p.name} (${pid}) force=${o.force} tree=${o.tree} → ${r.code}`);
    cache.pm = [0, []];
    return r;
  });
  handle('pm-priority', async (a) => {
    const pid = Number(a && a.pid), cls = str(a && a.cls, 20);
    const p = pmList.find((x) => x.pid === pid);
    if (!p || procmgr.protectedReason(p.name, pid, selfPids())) return { ok: false, code: 'protected' };
    const r = await procmgr.setPriority(pid, cls);
    log(`任务管理器：设置优先级 ${p.name} (${pid}) → ${cls}：${r.code}`);
    return r;
  });
  handle('pm-reveal', (a) => {
    const pid = Number(a && a.pid), p = pmList.find((x) => x.pid === pid);
    if (!p || !p.path || !path.isAbsolute(p.path) || !fs.existsSync(p.path)) return false;
    shell.showItemInFolder(p.path); return true;
  });
  handle('pm-services', async () => procmgr.services());
  handle('pm-perf', () => ({ cpu: M.cpu, cores: M.cores, mem: { used: os.totalmem() - os.freemem(), total: os.totalmem() }, rx: M.rx, tx: M.tx, hwOn: S.privacy.hw, netOn: S.privacy.net }));
  // 运行内存：只读状态 + 整理记录
  handle('mem-status', async () => {
    if (!S.privacy.hw) return { disabled: true };
    const st: any = await memtrim.memStatus();
    if (!S.privacy.proc && st) st.top = null; // “进程资源排行”关闭时不列出程序
    return { ...st, procOn: S.privacy.proc, total: os.totalmem() };
  });
  handle('mem-runs', () => { const runs = db.trimRuns(20); return { runs, tip: memtrim.ineffectiveTip(runs), lastAt: lastTrimAt }; });
  handle('get-wardrobe', () => ({ level: growthLevel(), ach: achDone(), look: S.look, safe: SAFE }));
  const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
  handle('lock-status', () => !!S.lock);
  // 1 分钟内最多输错 5 次，之后暂时拒绝（防止通过 IPC 快速穷举短密码）
  const unlockFails = new RateBudget(5, 60e3);
  handle('unlock', (pw) => {
    if (!S.lock) { unlocked = true; return true; }
    if (!unlockFails.left()) throw new Error('too-many-attempts');
    const a = Buffer.from(hash(str(pw, 64), S.lock.salt), 'hex'), b = Buffer.from(S.lock.hash, 'hex');
    unlocked = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!unlocked) { unlockFails.use(); log('面板密码输入错误'); }
    return unlocked;
  });
  handle('set-password', (pw) => {
    pw = str(pw, 64);
    if (!pw) S.lock = null; else { const salt = crypto.randomBytes(16).toString('hex'); S.lock = { salt, hash: hash(pw, salt) }; }
    save('lock'); unlocked = true; return !!S.lock;
  });
}

/* ---------- 生命周期 ---------- */
app.on('web-contents-created', (_e, c) => {
  c.on('will-navigate', (e) => e.preventDefault());
  c.on('will-attach-webview', (e) => e.preventDefault()); // 不允许任何页面嵌入 <webview>
  c.setWindowOpenHandler(() => ({ action: 'deny' }));
});
app.whenReady().then(() => {
  if (!gotLock) return;
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false); // 同步的权限查询也一律拒绝
  Menu.setApplicationMenu(null);
  log('应用就绪');
  const st = db.init(path.join(app.getPath('userData'), 'data'));
  log('数据库 ' + (st.ok ? '正常' : '不可用 ' + st.error) + (st.recovered ? '（已重建）' : ''));
  loadSettings(); fsm.setMuted(mutedList());
  setLang(resolveLang(S.language, app.getLocale())); focusT.setCfg(S.focus);
  if (st.ok) { try { db.prune(S.retentionDays); } catch (_) {} }
  vpn.init({
    log, getBackup: () => S.vpnProxyBackup || null, setBackup: (b) => { S.vpnProxyBackup = b; save('vpnProxyBackup'); },
    onChange: () => {
      refreshMenu(); const s = vpn.status(); send(dash, 'vpn', s);
      if (s.state === 'error' && s.error) notify(t('n.vpnDown'), s.error);
      delete S.baselines.proxy; // 代理是 NetPet 自己改的，下次体检重新建立基线，不误报“代理被修改”
    }
  });
  vpn.recoverProxy().catch(() => {});
  createPet(); createTray(); setupIpc(); applyHotkey(); applyProcHotkey(); refreshMenu();
  if (process.platform === 'win32') setTimeout(() => { powerRefresh().catch(() => {}); }, 15000); // 托盘“温度与节能”子菜单用
  setTimeout(() => { try { maybeWeekly(false); } catch (e: any) { log('每周小结出错 ' + (e && e.message)); } }, 20000);
  // 显示器变化（插拔/改分辨率/改缩放）时，把宠物拉回当前工作区；每 10 秒看门狗再检查一次。
  const onDisplayChanged = () => { log('显示器变化，检查宠物位置'); ensurePetVisible(); };
  screen.on('display-added', onDisplayChanged);
  screen.on('display-removed', onDisplayChanged);
  screen.on('display-metrics-changed', onDisplayChanged);
  watchTimer = setInterval(ensurePetVisible, 10000);
  powerMonitor.on('suspend', () => { try { db.flush(); save('growth'); } catch (_) {} });
  powerMonitor.on('shutdown', () => { try { db.flush(); save('growth'); } catch (_) {} });
  powerMonitor.on('resume', () => { skip = 3; fsm.reset(Date.now()); ensurePetVisible(); speedAlert.reset(); });
  powerMonitor.on('lock-screen', () => { R.screenLocked = true; });
  powerMonitor.on('unlock-screen', () => { R.screenLocked = false; });
  if (S.privacy.fullscreenHide) onPrivacyChanged();
  if (process.platform === 'win32') netmon.ensure();
  loop(); connTimer = setInterval(connTick, 8000);
  if (S.privacy.health) setTimeout(() => { runHealth().catch(() => {}); }, 30000);
  // 每 6 小时自动复查一次，问题解决后警示牌会自动消失
  healthTimer = setInterval(() => { if (S.privacy.health && !R.paused) runHealth().catch(() => {}); }, 6 * 3600e3);
  if (!st.ok) dialog.showMessageBox({ type: 'warning', title: 'NetPet', message: t('dlg.dbBad'), detail: t('dlg.dbBad.d', { err: st.error }) });
  else if (st.recovered) dialog.showMessageBox({ type: 'warning', title: 'NetPet', message: t('dlg.dbRec'), detail: t('dlg.dbRec.d') });
  if (!S.onboarded) openDashboard('pri');
  // 安全模式是“粘住”的：启动时明确告诉用户一次，避免功能被静默关闭
  else if (SAFE) { notify(t('n.safe.t'), t('n.safe.b')); openDashboard(); }
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
  save('growth'); fullscreen.stop(); netmon.stop(); security.killAll(); drivers.killAll(); diskopt.cancel(); defender.stopWaiting(); // 不留下任何后台子进程（Defender 自己的扫描不受影响）
  try { globalShortcut.unregisterAll(); } catch (_) {}
  // 先断开 VPN 并恢复系统代理，再停采集进程
  vpn.stop().catch(() => {}).finally(() => stopCollector().finally(() => { db.close(); log('正常退出'); app.quit(); }));
});
