// 1.5.0 温度与节能。只用 Windows 自带的 powercfg，不做风扇直接控制
// （直接控制风扇需要 WinRing0 之类的内核驱动或厂商 EC 访问，不安全、会被杀毒软件拦截、且每台机器都不一样）。
//  - 只读：当前电源方案、方案列表、当前方案的“最大处理器状态”（PROCTHROTTLEMAX）和“系统散热方式”（SYSCOOLPOL）。
//  - 用户操作（每次修改前先备份原值，可“恢复原设置”）：切换电源方案；“降温模式”= 降低最大处理器状态（99% 会关闭睿频，降温最明显）+ 散热方式设为主动。
//  - 自动温度保护（默认关闭）：CPU 温度 ≥ 阈值持续 60 秒 → 临时进入降温模式；低于阈值 10℃ 持续 5 分钟 → 恢复；读不到温度时不工作。
//  - 电池低电量自动切换节能方案（默认关闭）。
// 修改是持久的（退出 NetPet 不会自动恢复），需要时点“恢复原设置”，或在命令行运行 powercfg -restoredefaultschemes。
import { execFile } from 'node:child_process';
import { t } from '../shared/i18n';
const isWin = process.platform === 'win32';

export const SUB_PROCESSOR = '54533251-82be-4824-96c1-47b60b740d00';
export const PROCTHROTTLEMAX = 'bc5038f7-23e0-4960-96da-33abaf5935ec';
export const SYSCOOLPOL = '94d3a615-a899-4ac5-ae2b-e4d8f634367f';
export const KNOWN = { balanced: '381b4222-f694-41f0-9685-ff5bb260df2e', high: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', ultimate: 'e9a42b02-d5df-448d-aa00-03f14749eb61' };
export const COOL_CHOICES = [70, 80, 90, 99, 100];
export const TEMP_CHOICES = [80, 85, 90];
export const SAVER_PCT_CHOICES = [10, 15, 20, 30];
export interface PowerCfg { guard: boolean; threshold: number; coolMax: number; saver: boolean; saverPct: number }
export const POWER_DEFAULT: PowerCfg = { guard: false, threshold: 85, coolMax: 99, saver: false, saverPct: 20 };
export interface Plan { guid: string; name: string; active: boolean; kind: string }
export interface AcDc { ac: number | null; dc: number | null }
export interface PowerBackup { at: number; scheme: string; max: AcDc; cool: AcDc }

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (s) => typeof s === 'string' && GUID_RE.test(s.trim());
/** 方案种类：按微软固定 GUID 判断；“节能”方案 GUID 前缀固定为 a1841308-3d3c-4fd5，名称作为补充。 */
export function planKind(guid, name) {
  const g = String(guid || '').toLowerCase();
  if (g === KNOWN.balanced) return 'balanced';
  if (g === KNOWN.high) return 'high';
  if (g === KNOWN.ultimate) return 'ultimate';
  if (g.startsWith('a1841308-3d3c-4fd5') || /power saver|节能|省电/i.test(String(name || ''))) return 'saver';
  return 'other';
}
/** 解析 powercfg /list（各语言格式相同：GUID + 括号里的名称 + 当前方案后面带 *）。 */
export function parsePlans(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\(([^)]*)\)\s*(\*)?/i);
    if (!m) continue;
    const guid = m[1].toLowerCase();
    if (out.some((p) => p.guid === guid)) continue;
    out.push({ guid, name: m[2].trim(), active: !!m[3], kind: planKind(guid, m[2]) });
  }
  return out;
}
export function parseActive(text) { const m = String(text || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i); return m ? m[1].toLowerCase() : ''; }
/** powercfg /query 的输出里，最后两个 0x 开头的 8 位十六进制数就是“当前交流 / 直流设置索引”（前面的是取值范围）。与系统语言无关。 */
export function parseAcDc(text) {
  const hex = String(text || '').match(/0x[0-9a-f]{8}\b/gi) || [];
  if (hex.length < 2) return { ac: null, dc: null };
  return { ac: parseInt(hex[hex.length - 2], 16), dc: parseInt(hex[hex.length - 1], 16) };
}
export function sanitizePower(cur, p) {
  const o = { ...POWER_DEFAULT, ...(cur || {}) };
  if (!p || typeof p !== 'object') return o;
  if (typeof p.guard === 'boolean') o.guard = p.guard;
  if (TEMP_CHOICES.includes(p.threshold)) o.threshold = p.threshold;
  if (COOL_CHOICES.includes(p.coolMax)) o.coolMax = p.coolMax;
  if (typeof p.saver === 'boolean') o.saver = p.saver;
  if (SAVER_PCT_CHOICES.includes(p.saverPct)) o.saverPct = p.saverPct;
  return o;
}
const okPct = (v) => Number.isInteger(v) && v >= 5 && v <= 100;

/* ---------- 自动温度保护（纯逻辑）---------- */
export class ThermalGuard {
  state; hotSince; coolSince; nullSince; lastRestore; sustainMs; recoverMs; cooldownMs;
  constructor(sustainMs = 60e3, recoverMs = 5 * 60e3, cooldownMs = 10 * 60e3) {
    this.sustainMs = sustainMs; this.recoverMs = recoverMs; this.cooldownMs = cooldownMs;
    this.state = 'normal'; this.hotSince = null; this.coolSince = null; this.nullSince = null; this.lastRestore = -Infinity;
  }
  /** 返回 'apply'（进入降温模式）/ 'restore'（恢复）/ null。enabled=false 时如果正在降温就恢复。 */
  update(now, temp, threshold, enabled) {
    if (!enabled) { this.hotSince = this.coolSince = this.nullSince = null; if (this.state === 'cooling') { this.state = 'normal'; this.lastRestore = now; return 'restore'; } return null; }
    if (temp == null || !Number.isFinite(temp)) {
      this.hotSince = null; this.coolSince = null;
      if (this.state === 'cooling') {
        if (this.nullSince == null) this.nullSince = now;
        if (now - this.nullSince >= this.recoverMs) { this.state = 'normal'; this.nullSince = null; this.lastRestore = now; return 'restore'; }
      }
      return null;
    }
    this.nullSince = null;
    if (this.state === 'normal') {
      if (temp >= threshold) {
        if (this.hotSince == null) this.hotSince = now;
        if (now - this.hotSince >= this.sustainMs && now - this.lastRestore >= this.cooldownMs) { this.state = 'cooling'; this.hotSince = null; return 'apply'; }
      } else this.hotSince = null;
      return null;
    }
    if (temp < threshold - 10) {
      if (this.coolSince == null) this.coolSince = now;
      if (now - this.coolSince >= this.recoverMs) { this.state = 'normal'; this.coolSince = null; this.lastRestore = now; return 'restore'; }
    } else this.coolSince = null;
    return null;
  }
}
/** 低电量自动切换节能方案（纯逻辑，带 10% 回差）。 */
export class BatterySaverGuard {
  on;
  constructor() { this.on = false; }
  update(onBattery, pct, threshold, enabled) {
    if (!this.on) {
      if (enabled && onBattery && pct != null && pct <= threshold) { this.on = true; return 'apply'; }
      return null;
    }
    if (!enabled || !onBattery || (pct != null && pct > threshold + 10)) { this.on = false; return 'restore'; }
    return null;
  }
}

/* ---------- powercfg ---------- */
// 通过 PowerShell 调用并把控制台编码设成 UTF-8，这样中文方案名不会乱码。所有参数都先校验（GUID / 整数），不拼接用户输入。
function ps(script: string, timeout = 20000): Promise<string | null> {
  return new Promise((res) => {
    if (!isWin) return res(null);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, out) => res(err ? null : String(out).trim()));
  });
}
const STATUS_PS = `$l=(powercfg /list) -join "\`n"; $a=(powercfg /getactivescheme) -join "\`n"
$m=(powercfg /query SCHEME_CURRENT ${SUB_PROCESSOR} ${PROCTHROTTLEMAX}) -join "\`n"; $c=(powercfg /query SCHEME_CURRENT ${SUB_PROCESSOR} ${SYSCOOLPOL}) -join "\`n"
ConvertTo-Json -InputObject @{list=$l;active=$a;max=$m;cool=$c} -Compress`;
export interface PowerStatus { ok: boolean; error?: string; plans: Plan[]; active: string; max: AcDc; cool: AcDc }
export async function status(): Promise<PowerStatus> {
  const base = { ok: false, plans: [], active: '', max: { ac: null, dc: null }, cool: { ac: null, dc: null } };
  if (!isWin) return { ...base, error: t('pow.err.win') };
  let j: any = null; try { j = JSON.parse((await ps(STATUS_PS)) || ''); } catch (_) {}
  if (!j) return { ...base, error: t('pow.err.read') };
  const plans = parsePlans(j.list); const active = parseActive(j.active) || (plans.find((p) => p.active) || { guid: '' }).guid;
  return { ok: plans.length > 0, error: plans.length ? undefined : t('pow.err.read'), plans: plans.map((p) => ({ ...p, active: p.guid === active })), active, max: parseAcDc(j.max), cool: parseAcDc(j.cool) };
}
/** 依次执行 powercfg 命令，任何一步退出码非 0 就停止并报错。cmds 里每一项都是已校验的参数数组。 */
async function runCmds(cmds) {
  const lines = cmds.map((a) => `powercfg ${a.join(' ')} | Out-Null; if($LASTEXITCODE -ne 0){ 'fail:' + $LASTEXITCODE; exit }`).join('\n');
  const out = await ps(lines + "\n'done'");
  if (out && /done\s*$/.test(out)) return { ok: true };
  return { ok: false, error: !out ? t('pow.err.run') : t('pow.err.code', { code: out.replace(/^[\s\S]*fail:/, '').trim() }) };
}
export async function setPlan(guid, plans) {
  if (!isGuid(guid) || !(plans || []).some((p) => p.guid === guid.toLowerCase())) return { ok: false, error: t('pow.err.guid') };
  return runCmds([['/setactive', guid.toLowerCase()]]);
}
/** 在指定方案上设置最大处理器状态和散热方式（AC 与 DC 分别设置），然后重新激活当前方案让设置生效。 */
export async function setValues(scheme, max, cool, active) {
  if (!isGuid(scheme) || !isGuid(active)) return { ok: false, error: t('pow.err.guid') };
  const cmds = [];
  for (const [k, v] of [['/setacvalueindex', max.ac], ['/setdcvalueindex', max.dc]]) if (v != null) { if (!okPct(v)) return { ok: false, error: 'bad value' }; cmds.push([k, scheme, SUB_PROCESSOR, PROCTHROTTLEMAX, String(v)]); }
  for (const [k, v] of [['/setacvalueindex', cool.ac], ['/setdcvalueindex', cool.dc]]) if (v != null) { if (v !== 0 && v !== 1) return { ok: false, error: 'bad value' }; cmds.push([k, scheme, SUB_PROCESSOR, SYSCOOLPOL, String(v)]); }
  cmds.push(['/setactive', active]);
  return runCmds(cmds);
}
/** 降温模式：先由调用方备份，再把当前方案的最大处理器状态设为 pct、散热方式设为主动（1）。 */
export async function applyCooling(pct, st: PowerStatus) {
  if (!COOL_CHOICES.includes(pct)) return { ok: false, error: 'bad value' };
  // 有些机器没有“系统散热方式”这个设置（读不到当前值），这时只改最大处理器状态，避免整条命令失败
  const cool = st.cool && st.cool.ac != null ? { ac: 1, dc: st.cool.dc != null ? 1 : null } : { ac: null, dc: null };
  return setValues(st.active, { ac: pct, dc: st.max && st.max.dc != null ? pct : null }, cool, st.active);
}
/** 按备份恢复：先把数值写回备份时的方案，再切回备份时的方案。 */
export async function restore(b: PowerBackup, plans) {
  if (!b || !isGuid(b.scheme)) return { ok: false, error: t('pow.err.nobackup') };
  const okList = (plans || []).some((p) => p.guid === b.scheme);
  if (!okList) return { ok: false, error: t('pow.err.gone') };
  // 只恢复备份时读到的值（读不到的保持不动）；最后切回备份时的方案
  return setValues(b.scheme, b.max || { ac: null, dc: null }, b.cool || { ac: null, dc: null }, b.scheme);
}
