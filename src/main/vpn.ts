// sing-box VPN：由用户自己提供 sing-box.exe 和配置文件，NetPet 只负责启动 / 停止 / 看状态 / 可选设置系统代理。
// 底线：
//  - NetPet 不下载 sing-box、不拉取订阅、不内置任何服务器；所有流量去哪里完全由用户的配置决定。
//  - 程序和配置路径只能在主进程里通过“选择文件”对话框设置，界面不能直接传路径。
//  - 启动前先跑 `sing-box check`，配置有错直接报错，不会半启动。
//  - 设置系统代理前先备份原值；断开、sing-box 意外退出、NetPet 退出、甚至上次崩溃后再次启动，都会恢复原值。
//  - 所有写入的值以 Base64 JSON 传给 PowerShell，不拼接命令。
import { spawn, execFile, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
export type VpnState = 'stopped' | 'checking' | 'starting' | 'running' | 'error';
export interface ProxyBackup { ProxyEnable: number; ProxyServer: string; ProxyOverride: string; AutoConfigURL: string }
export interface VpnHooks { log: (m: string) => void; onChange: () => void; getBackup: () => ProxyBackup | null; setBackup: (b: ProxyBackup | null) => void }

/* ---------- 纯函数（可单元测试）---------- */
/** 只接受名字像 sing-box 的可执行文件，防止误选成别的程序。 */
export function isSingBoxExe(p: string): boolean { return /^sing-box[\w.\-]*\.exe$/i.test(path.basename(String(p || ''))) || (!isWin && /^sing-box[\w.\-]*$/i.test(path.basename(String(p || '')))); }
/** 在配置里找可用于系统代理的本机入站（mixed / http，监听本机）。 */
export function findProxyInbound(cfg: any): { port: number; type: string } | null {
  const ins: any[] = Array.isArray(cfg && cfg.inbounds) ? cfg.inbounds : [];
  for (const t of ['mixed', 'http']) {
    for (const i of ins) {
      if (!i || i.type !== t) continue;
      const port = Number(i.listen_port);
      const listen = String(i.listen || '127.0.0.1');
      if (Number.isInteger(port) && port > 0 && port < 65536 && /^(127\.0\.0\.1|localhost|::1|0\.0\.0\.0|::)$/.test(listen)) return { port, type: t };
    }
  }
  return null;
}
export function hasTun(cfg: any): boolean { return (Array.isArray(cfg && cfg.inbounds) ? cfg.inbounds : []).some((i: any) => i && i.type === 'tun'); }
/** 保留最近 N 行日志（只在内存里，不写盘）。 */
export class Ring { private a: string[] = []; constructor(private n = 300) {} push(s: string) { for (const l of String(s).split(/\r?\n/)) if (l.trim()) { this.a.push(l.slice(0, 500)); if (this.a.length > this.n) this.a.shift(); } } all() { return [...this.a]; } clear() { this.a = []; } }
export const BYPASS = '<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*';

/* ---------- 系统代理 ---------- */
const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const REFRESH = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("wininet.dll")]public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);}' ; [void][W]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0); [void][W]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)`;
function ps(script: string, timeout = 15000): Promise<string | null> {
  return new Promise((res) => {
    if (!isWin) return res(null);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, encoding: 'utf8' }, (err, out) => res(err ? null : String(out).trim()));
  });
}
export async function readProxy(): Promise<ProxyBackup | null> {
  const o = await ps(`$p=Get-ItemProperty -LiteralPath '${KEY}'; @{ProxyEnable=[int]$p.ProxyEnable;ProxyServer=[string]$p.ProxyServer;ProxyOverride=[string]$p.ProxyOverride;AutoConfigURL=[string]$p.AutoConfigURL} | ConvertTo-Json -Compress`);
  try { const j = JSON.parse(o || ''); return { ProxyEnable: Number(j.ProxyEnable) || 0, ProxyServer: j.ProxyServer || '', ProxyOverride: j.ProxyOverride || '', AutoConfigURL: j.AutoConfigURL || '' }; } catch (_) { return null; }
}
export async function writeProxy(v: ProxyBackup): Promise<boolean> {
  const b64 = Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
  const o = await ps(`$ErrorActionPreference='Stop'; try { $v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json; $k='${KEY}'
  Set-ItemProperty -LiteralPath $k -Name ProxyEnable -Value ([int]$v.ProxyEnable) -Type DWord
  if($v.ProxyServer){ Set-ItemProperty -LiteralPath $k -Name ProxyServer -Value ([string]$v.ProxyServer) } else { Remove-ItemProperty -LiteralPath $k -Name ProxyServer -ErrorAction SilentlyContinue }
  if($v.ProxyOverride){ Set-ItemProperty -LiteralPath $k -Name ProxyOverride -Value ([string]$v.ProxyOverride) } else { Remove-ItemProperty -LiteralPath $k -Name ProxyOverride -ErrorAction SilentlyContinue }
  if($v.AutoConfigURL){ Set-ItemProperty -LiteralPath $k -Name AutoConfigURL -Value ([string]$v.AutoConfigURL) } else { Remove-ItemProperty -LiteralPath $k -Name AutoConfigURL -ErrorAction SilentlyContinue }
  ${REFRESH}; 'done' } catch { 'fail' }`);
  return o === 'done';
}

/* ---------- 进程管理 ---------- */
let child: ChildProcess | null = null, hooks: VpnHooks | null = null, stopping = false;
const ring = new Ring();
const st = { state: 'stopped' as VpnState, error: '', startedAt: 0, proxyPort: 0, sysProxyOn: false, tun: false, pid: 0 };
export function init(h: VpnHooks) { hooks = h; }
export function status() { return { ...st, log: ring.all().slice(-80) }; }
const set = (p: Partial<typeof st>) => { Object.assign(st, p); hooks && hooks.onChange(); };

/** 上次 NetPet 崩溃时系统代理可能还指向已不存在的 sing-box：启动时如果有备份就恢复。 */
export async function recoverProxy() {
  const b = hooks && hooks.getBackup();
  if (!b || child) return;
  const ok = await writeProxy(b);
  hooks!.log(`恢复上次遗留的系统代理设置：${ok ? '成功' : '失败'}`);
  if (ok) hooks!.setBackup(null);
}
async function restoreProxy() {
  if (!st.sysProxyOn) return;
  const b = hooks && hooks.getBackup();
  if (b) { const ok = await writeProxy(b); hooks!.log('恢复系统代理：' + (ok ? '成功' : '失败')); if (ok) hooks!.setBackup(null); }
  st.sysProxyOn = false;
}

export function check(exe: string, cfgPath: string): Promise<{ ok: boolean; msg: string }> {
  return new Promise((res) => {
    execFile(exe, ['check', '-c', cfgPath], { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (err, out, errOut) => {
      const msg = (String(errOut || '') + String(out || '')).trim().slice(0, 1500);
      res(err ? { ok: false, msg: msg || String(err.message) } : { ok: true, msg });
    });
  });
}

export async function start(o: { exe: string; config: string; sysProxy: boolean; workDir: string }): Promise<{ ok: boolean; error?: string }> {
  if (child) return { ok: true };
  const fail = (e: string) => { set({ state: 'error', error: e }); return { ok: false, error: e }; };
  if (!o.exe || !fs.existsSync(o.exe) || !isSingBoxExe(o.exe)) return fail('请先选择 sing-box.exe（文件名需以 sing-box 开头）。');
  if (!o.config || !fs.existsSync(o.config)) return fail('请先选择 sing-box 配置文件（.json）。');
  let cfg: any; try { cfg = JSON.parse(fs.readFileSync(o.config, 'utf8')); } catch (e: any) { return fail('配置文件不是有效的 JSON：' + e.message); }
  const inb = findProxyInbound(cfg), tun = hasTun(cfg);
  if (o.sysProxy && !inb && !tun) return fail('配置里没有监听本机的 mixed/http 入站，无法设置系统代理。请在配置里加一个，或关闭“设置系统代理”。');
  if (!inb && !tun) return fail('配置里既没有 tun 入站，也没有 mixed/http 入站，连上也不会有流量经过它。');
  ring.clear(); set({ state: 'checking', error: '', tun });
  const c = await check(o.exe, o.config);
  if (!c.ok) { ring.push(c.msg); return fail('配置检查没通过：' + c.msg.split('\n')[0]); }
  set({ state: 'starting' });
  try { fs.mkdirSync(o.workDir, { recursive: true }); } catch (_) {}
  stopping = false;
  const me = spawn(o.exe, ['run', '-c', o.config, '-D', o.workDir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = me;
  me.stdout!.on('data', (d) => ring.push(String(d))); me.stderr!.on('data', (d) => ring.push(String(d)));
  me.on('error', (e) => { ring.push('启动失败：' + e.message); });
  me.on('exit', async (code) => {
    if (child === me) child = null;
    await restoreProxy();
    if (stopping) set({ state: 'stopped', pid: 0, proxyPort: 0 });
    else {
      const last = ring.all().slice(-3).join(' ');
      const hint = tun && /access|permission|denied|elevat|administrator/i.test(last) ? '（TUN 模式需要以管理员身份运行 NetPet）' : '';
      set({ state: 'error', error: `sing-box 意外退出（代码 ${code}）${hint}`, pid: 0, proxyPort: 0 });
      hooks && hooks.log('sing-box 意外退出 code=' + code);
    }
  });
  // 等 1.5 秒确认没有立即退出（端口被占用、TUN 权限不足等会马上退出）
  await new Promise((r) => setTimeout(r, 1500));
  if (child !== me) return { ok: false, error: st.error || 'sing-box 启动后立即退出，请看下方日志。' };
  set({ state: 'running', startedAt: Date.now(), pid: me.pid || 0, proxyPort: inb ? inb.port : 0 });
  if (o.sysProxy && inb && isWin) {
    const prev = (hooks && hooks.getBackup()) || (await readProxy());
    if (!prev) { ring.push('读不到当前系统代理设置，为安全起见没有修改系统代理。'); }
    else {
      hooks!.setBackup(prev);
      const ok = await writeProxy({ ProxyEnable: 1, ProxyServer: `127.0.0.1:${inb.port}`, ProxyOverride: BYPASS, AutoConfigURL: '' });
      set({ sysProxyOn: ok });
      if (!ok) { ring.push('设置系统代理失败。'); hooks!.setBackup(null); }
    }
  }
  hooks && hooks.log(`sing-box 已启动 pid=${me.pid}${st.sysProxyOn ? ' 系统代理=127.0.0.1:' + inb!.port : ''}${tun ? ' TUN' : ''}`);
  return { ok: true };
}

export function stop(): Promise<void> {
  return new Promise((resolve) => {
    const me = child;
    if (!me) { restoreProxy().finally(() => { if (st.state !== 'error') set({ state: 'stopped' }); resolve(); }); return; }
    stopping = true;
    const t = setTimeout(() => { if (isWin && me.pid) execFile('taskkill', ['/pid', String(me.pid), '/T', '/F'], () => {}); }, 3000);
    me.once('exit', () => { clearTimeout(t); setTimeout(resolve, 50); });
    try { me.kill(); } catch (_) { clearTimeout(t); resolve(); }
  }).then(() => restoreProxy()).then(() => { set({ state: 'stopped', error: '' }); });
}
export const running = () => !!child;
