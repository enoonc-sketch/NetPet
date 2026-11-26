// 设置导出 / 导入（1.4.0）：纯逻辑，不依赖 Electron，可单元测试。
// 底线：
//  - 只导出“偏好类”设置；绝不导出面板密码、sing-box 路径、VPN 代理备份（加密项），也不导出窗口位置、体检基线、成长经验、历史结果。
//  - 导入时只认白名单里的键，并且仍然经过主进程 applyPatch 的逐项校验；不认识的键、类型不对的值一律丢弃。
//  - 不导入“开机自启”（会修改系统，必须由用户在本机手动开启）。
import { normalizeHotkey } from '../shared/hotkey';
// 1.5.0：新增导出 / 导入 语言、网速异常提醒、番茄钟、每周小结开关、宠物外观、内存整理排除列表。
// 会自动修改系统的开关（磁盘自动整理、自动温度保护、低电量节能、定期病毒扫描、定期内存整理）与“开机自启”一样不导出、不导入。

export const EXPORT_FORMAT = 'netpet-settings';
export const MAX_IMPORT_BYTES = 256 * 1024;
const PRIVACY_KEYS = ['net', 'hw', 'conn', 'dns', 'proc', 'health', 'fullscreenHide', 'probe'];
const ANIM_KEYS = ['DOWNLOAD', 'UPLOAD', 'TIRED', 'HOT', 'SWEAT', 'WARNING'];
/** 隐私开关的中文名（导入前确认框里列出“将被新开启”的监控项）。 */
export const PRIVACY_NAMES: Record<string, string> = { net: '网络速度监控', hw: '硬件状态监控', conn: '网络使用统计（连接记录）', dns: '解析主机名（会联网）', proc: '进程资源排行', health: '系统健康检查', fullscreenHide: '全屏时自动隐藏宠物', probe: '真实联网检测（会联网）' };

const bools = (o: any, keys: string[]) => {
  const r: Record<string, boolean> = {};
  if (o && typeof o === 'object') for (const k of keys) if (typeof o[k] === 'boolean') r[k] = o[k];
  return r;
};

/** 从当前设置 S 生成导出对象。 */
export function buildExport(S: any, version: string, now = Date.now()) {
  return {
    format: EXPORT_FORMAT, formatVersion: 1, app: 'NetPet', appVersion: String(version || ''), exportedAt: new Date(now).toISOString(),
    note: '不含面板密码、VPN 路径与代理备份、窗口位置、统计数据。',
    settings: {
      compact: !!S.compact, alwaysOnTop: !!S.alwaysOnTop, pet: String(S.pet || ''), retentionDays: S.retentionDays, memAlert: S.memAlert,
      privacy: bools(S.privacy, PRIVACY_KEYS), anim: bools(S.anim, ANIM_KEYS),
      memTrim: { auto: !!(S.memTrim && S.memTrim.auto), threshold: S.memTrim && S.memTrim.threshold },
      quota: { gb: (S.quota && S.quota.gb) || 0 }, remind: { sit: (S.remind && S.remind.sit) || 0, water: (S.remind && S.remind.water) || 0 },
      newProc: { on: !!(S.newProc && S.newProc.on) }, hotkey: typeof S.hotkey === 'string' ? S.hotkey : '',
      language: typeof S.language === 'string' ? S.language : 'auto',
      speedAlert: S.speedAlert && typeof S.speedAlert === 'object' ? { on: !!S.speedAlert.on, lowKB: S.speedAlert.lowKB, lowSec: S.speedAlert.lowSec, highMB: S.speedAlert.highMB, highSec: S.speedAlert.highSec, cooldownMin: S.speedAlert.cooldownMin } : undefined,
      focus: S.focus && typeof S.focus === 'object' ? { focusMin: S.focus.focusMin, breakMin: S.focus.breakMin } : undefined,
      weekly: { on: !(S.weekly && S.weekly.on === false) },
      look: S.look && typeof S.look === 'object' ? { palette: String(S.look.palette || ''), acc: String(S.look.acc || '') } : undefined,
      memTrimExclude: S.memTrim && Array.isArray(S.memTrim.exclude) ? S.memTrim.exclude.slice(0, 50) : []
    }
  };
}

/** 解析导入文件内容，返回可交给 applyPatch 的补丁（只含白名单键）。 */
export function parseImport(text: string): { ok: boolean; patch?: any; keys?: string[]; error?: string } {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '文件是空的。' };
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: '文件太大，不像是 NetPet 的设置文件。' };
  let j: any;
  try { j = JSON.parse(text.replace(/^\ufeff/, '')); } catch (_) { return { ok: false, error: '不是有效的 JSON 文件。' }; }
  if (!j || typeof j !== 'object' || j.format !== EXPORT_FORMAT || !j.settings || typeof j.settings !== 'object') return { ok: false, error: '这不是 NetPet 导出的设置文件。' };
  const s = j.settings, p: any = {};
  if (typeof s.compact === 'boolean') p.compact = s.compact;
  if (typeof s.alwaysOnTop === 'boolean') p.alwaysOnTop = s.alwaysOnTop;
  if (typeof s.pet === 'string' && s.pet.length <= 40) p.pet = s.pet;
  if (typeof s.retentionDays === 'number') p.retentionDays = s.retentionDays;
  if (typeof s.memAlert === 'number') p.memAlert = s.memAlert;
  const pv = bools(s.privacy, PRIVACY_KEYS); if (Object.keys(pv).length) p.privacy = pv;
  const an = bools(s.anim, ANIM_KEYS); if (Object.keys(an).length) p.anim = an;
  if (s.memTrim && typeof s.memTrim === 'object') {
    const m: any = {}; if (typeof s.memTrim.auto === 'boolean') m.auto = s.memTrim.auto; if (typeof s.memTrim.threshold === 'number') m.threshold = s.memTrim.threshold;
    if (Object.keys(m).length) p.memTrim = m;
  }
  if (s.quota && typeof s.quota.gb === 'number') p.quota = { gb: s.quota.gb };
  if (s.remind && typeof s.remind === 'object') {
    const r: any = {}; if (typeof s.remind.sit === 'number') r.sit = s.remind.sit; if (typeof s.remind.water === 'number') r.water = s.remind.water;
    if (Object.keys(r).length) p.remind = r;
  }
  if (s.newProc && typeof s.newProc.on === 'boolean') p.newProc = { on: s.newProc.on };
  const hk = normalizeHotkey(s.hotkey); if (hk !== null) p.hotkey = hk;
  // 1.5.0（数值 / 选项仍由主进程 applyPatch 按白名单校验）
  if (s.language === 'auto' || s.language === 'zh' || s.language === 'en') p.language = s.language;
  if (s.speedAlert && typeof s.speedAlert === 'object') {
    const a: any = {}; for (const k of ['on']) if (typeof s.speedAlert[k] === 'boolean') a[k] = s.speedAlert[k];
    for (const k of ['lowKB', 'lowSec', 'highMB', 'highSec', 'cooldownMin']) if (typeof s.speedAlert[k] === 'number') a[k] = s.speedAlert[k];
    if (Object.keys(a).length) p.speedAlert = a;
  }
  if (s.focus && typeof s.focus === 'object') { const f: any = {}; for (const k of ['focusMin', 'breakMin']) if (typeof s.focus[k] === 'number') f[k] = s.focus[k]; if (Object.keys(f).length) p.focus = f; }
  if (s.weekly && typeof s.weekly.on === 'boolean') p.weekly = { on: s.weekly.on };
  if (s.look && typeof s.look === 'object' && typeof s.look.palette === 'string' && typeof s.look.acc === 'string' && s.look.palette.length <= 40 && s.look.acc.length <= 40) p.look = { palette: s.look.palette, acc: s.look.acc };
  if (Array.isArray(s.memTrimExclude) && s.memTrimExclude.length) { const ex = s.memTrimExclude.filter((x: any) => typeof x === 'string' && x.length <= 64).slice(0, 50); p.memTrim = { ...(p.memTrim || {}), exclude: ex }; }
  const keys = Object.keys(p);
  if (!keys.length) return { ok: false, error: '文件里没有可导入的设置。' };
  return { ok: true, patch: p, keys };
}

/** 导入后会从“关”变成“开”的隐私开关（主进程据此先弹窗确认，避免悄悄打开监控或联网功能）。 */
export function newlyEnabledPrivacy(cur: Record<string, boolean>, patch: any): string[] {
  const pv = (patch && patch.privacy) || {};
  return PRIVACY_KEYS.filter((k) => pv[k] === true && !(cur && cur[k]));
}
