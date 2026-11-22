// 系统健康检查：全部为只读检查。每项给出 状态(ok正常/warn注意/bad异常/unknown无法检测) + 检查依据 + 建议。
// 不凭端口/IP/进程名断定恶意；病毒查杀由 Windows Defender 完成。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { batteryWear } from './extras';
const isWin = process.platform === 'win32';
const arr = (x) => (x == null ? [] : [].concat(x));
const kids = new Set<any>();

function ps(cmd, timeout = 30000) {
  return new Promise((res) => {
    if (!isWin) return res(null);
    const c = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + cmd, 'utf16le').toString('base64')],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, out) => { kids.delete(c); res(err ? null : String(out).trim()); });
    kids.add(c);
  });
}
const killAll = () => { for (const c of kids) { try { c.kill(); } catch (_) {} } kids.clear(); };
async function psJson(cmd: string): Promise<any> { const o: any = await ps(cmd); if (!o) return null; try { return JSON.parse(o); } catch (_) { return null; } }
const item = (id: string, title: string, status: string, detail: string, evidence: string, advice: string, list?: any[]) => ({ id, title, status, detail, evidence, advice, list });
const unk = (id, title, why) => item(id, title, 'unknown', '无法检测：' + why, '读取失败，没有拿到可靠数据，所以不下结论。', '可以手动在 Windows 安全中心 / 设置里查看。');

const RISKY_PORTS: Record<number, string> = { 21: 'FTP', 23: 'Telnet', 135: 'RPC', 139: 'NetBIOS', 445: 'SMB 文件共享', 3389: '远程桌面', 5900: 'VNC', 5985: 'WinRM' };
const NOTABLE_PORTS: Record<number, string> = { 3333: '常见挖矿端口', 4444: '常见后门/挖矿端口', 5555: '常见挖矿端口', 14444: '常见挖矿端口', 14433: '常见挖矿端口', 45560: '常见挖矿端口', 6667: 'IRC', 1337: '常见木马端口', 31337: '常见木马端口', 12345: '常见木马端口' };
const STARTUP_NOTE = /\\Temp\\|\\Users\\Public\\|-enc\s|-encodedcommand|wscript|cscript|mshta|\.vbs\b|\.js\b/i;
const isLoop = (ip) => !ip || /^(127\.|::1|::$|0\.0\.0\.0$)/.test(ip);
// 监听地址：0.0.0.0 / :: 表示“所有网卡”，正是对外开放，不能当回环排除；只排除真正的本机回环。
const isLoopListen = (ip) => /^(127\.|::1$|\[::1\]$)/.test(String(ip || ''));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Windows 安全中心登记的第三方产品（排除 Windows Defender 自身）。kind: AntiVirusProduct / FirewallProduct */
async function thirdParty(kind: string): Promise<string[]> {
  const l = arr(await psJson(`Get-CimInstance -Namespace root/SecurityCenter2 -ClassName ${kind} -ErrorAction SilentlyContinue | Select-Object displayName | ConvertTo-Json -Compress`));
  return l.map((x: any) => String((x && x.displayName) || '')).filter((n) => n && !/windows defender|microsoft defender/i.test(n));
}
async function defender() {
  const d = await psJson("Get-MpComputerStatus | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,AMRunningMode,@{n='sig';e={$_.AntivirusSignatureLastUpdated.ToString('s')}} | ConvertTo-Json -Compress");
  const T = '病毒防护 (Windows Defender)';
  // 装了第三方杀毒时 Defender 会进入被动模式（AntivirusEnabled=false），这是正常的，不能判为异常。
  const other = await thirdParty('AntiVirusProduct');
  if (other.length && (!d || !/normal/i.test(String(d.AMRunningMode || 'Normal')) || !d.AntivirusEnabled))
    return item('defender', '病毒防护', 'ok', `由第三方杀毒软件提供保护：${other.join('、')}。`, `Windows 安全中心(SecurityCenter2) 登记的杀毒软件：${other.join('、')}${d ? `；Defender AMRunningMode=${d.AMRunningMode}` : ''}`, '无需处理。实时保护状态请在该软件里确认。');
  if (!d) return unk('defender', T, '读不到 Defender 状态（可能权限不足）');
  const ev = `Get-MpComputerStatus：AntivirusEnabled=${d.AntivirusEnabled}，RealTimeProtectionEnabled=${d.RealTimeProtectionEnabled}，AMRunningMode=${d.AMRunningMode}，病毒库更新时间=${d.sig}`;
  if (!d.AntivirusEnabled || !d.RealTimeProtectionEnabled) return item('defender', T, 'bad', '实时保护已关闭。', ev, '在 Windows 安全中心 → 病毒和威胁防护 里重新打开实时保护。');
  const age = (Date.now() - new Date(d.sig).getTime()) / 864e5;
  if (age > 7) return item('defender', T, 'warn', `实时保护已开启，但病毒库 ${Math.floor(age)} 天没更新。`, ev, '在 Windows 更新里检查更新，或在安全中心手动更新病毒库。');
  return item('defender', T, 'ok', '实时保护已开启，病毒库是最新的。', ev, '无需处理。');
}
async function firewall() {
  const p = arr(await psJson("Get-NetFirewallProfile | Select-Object Name,@{n='On';e={[string]$_.Enabled}} | ConvertTo-Json -Compress"));
  if (!p.length) return unk('fw', 'Windows 防火墙', '读不到防火墙状态');
  const ev = 'Get-NetFirewallProfile：' + p.map((x) => `${x.Name}=${x.On}`).join('，');
  const off = p.filter((x) => String(x.On).toLowerCase() !== 'true').map((x) => x.Name);
  if (off.length) {
    const other = await thirdParty('FirewallProduct');
    if (other.length) return item('fw', '防火墙', 'ok', `Windows 防火墙部分关闭，由第三方防火墙接管：${other.join('、')}。`, ev + `；SecurityCenter2 登记的防火墙：${other.join('、')}`, '无需处理。');
  }
  return off.length ? item('fw', 'Windows 防火墙', 'bad', `这些网络类型的防火墙是关闭的：${off.join('、')}。`, ev, '在 Windows 安全中心 → 防火墙和网络保护 里打开。如果是你自己有意关闭的，可忽略。')
    : item('fw', 'Windows 防火墙', 'ok', '所有网络类型的防火墙都已开启。', ev, '无需处理。');
}
async function update() {
  const h = arr(await psJson("Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1 @{n='d';e={$_.InstalledOn.ToString('s')}},HotFixID | ConvertTo-Json -Compress"))[0];
  if (!h) return unk('upd', 'Windows 更新', '读不到补丁记录');
  const age = Math.floor((Date.now() - new Date(h.d).getTime()) / 864e5);
  const ev = `Get-HotFix 最近一条：${h.HotFixID}，安装于 ${h.d.slice(0, 10)}（该命令不一定列出全部更新，仅供参考）`;
  return age > 60 ? item('upd', 'Windows 更新', 'warn', `最近一次补丁是 ${age} 天前。`, ev, '打开 主面板 → 系统更新 检查可用更新，或在 设置 → Windows 更新 里安装。')
    : item('upd', 'Windows 更新', 'ok', `最近一次补丁是 ${age} 天前。`, ev, '无需处理。');
}
async function startup() {
  const s = arr(await psJson('Get-CimInstance Win32_StartupCommand | Select-Object Name,Command | ConvertTo-Json -Compress'));
  const list = s.map((x) => ({ t: `${x.Name}  —  ${x.Command}`, f: STARTUP_NOTE.test(x.Command || '') }));
  const n = list.filter((x) => x.f).length;
  const ev = `Win32_StartupCommand 共 ${list.length} 项（只包含用户可见的启动项）。标 ⚠ 的是路径在 Temp/Public，或用脚本程序启动——这只是提示，不少正常软件也这样启动。`;
  return item('startup', '开机启动项', n ? 'warn' : 'ok', n ? `共 ${list.length} 项，其中 ${n} 项值得看一眼（已标 ⚠）。` : `共 ${list.length} 项，没有发现路径或启动方式特别的项目。`, ev,
    n ? '确认标 ⚠ 的项目是不是你认识的软件；不需要的可以在 主面板 → 启动管理 里禁用（可随时恢复）。' : '无需处理。', list.map((x) => (x.f ? '⚠ ' : '') + x.t));
}
async function ports(si) {
  try {
    const all = await si.networkConnections();
    const lis = all.filter((x) => x.state === 'LISTEN' && !isLoopListen(x.localAddress));
    const seen = new Map(); for (const x of lis) seen.set(`${x.process || x.pid}:${x.localPort}`, Number(x.localPort));
    const risky = [...seen].filter(([, p]) => RISKY_PORTS[p]);
    const est = all.filter((x) => x.state === 'ESTABLISHED' && !isLoop(x.peerAddress));
    const notable = est.filter((x) => NOTABLE_PORTS[Number(x.peerPort)]);
    return [
      item('ports', '本机监听端口', risky.length ? 'warn' : 'ok',
        risky.length ? `有 ${risky.length} 个常见的敏感服务端口对外开放：${risky.map(([k, p]) => `${p}(${RISKY_PORTS[p]})`).join('、')}。` : `共 ${seen.size} 个端口对外监听，没有常见敏感服务端口。`,
        '来自系统网络连接表（只读）。端口开放不等于有问题，很多软件都会监听端口。',
        risky.length ? '如果你没有主动开启远程桌面/文件共享等功能，可以在 Windows 功能里关闭，或用防火墙限制来源。' : '无需处理。', [...seen.keys()]),
      item('conns', '当前网络连接', notable.length ? 'warn' : 'ok',
        notable.length ? `有 ${notable.length} 条连接使用了常被挖矿/远控软件使用的端口。` : `当前 ${est.length} 条对外连接，没有使用常见的可疑端口。`,
        `来自系统网络连接表（只读元数据）。仅凭端口无法判断是否恶意，很多正常软件也可能用到这些端口。`,
        notable.length ? '在“网络统计 → 连接记录”里找到对应程序，确认是不是你认识的软件；不确定可以用 Defender 扫描。' : '无需处理。',
        notable.map((x) => `${x.process || 'PID ' + x.pid} → ${x.peerAddress}:${x.peerPort}（${NOTABLE_PORTS[Number(x.peerPort)]}）`))
    ];
  } catch (_) { return [unk('ports', '本机监听端口', '读不到网络连接表'), unk('conns', '当前网络连接', '读不到网络连接表')]; }
}
function hosts(ctx) {
  try {
    const f = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\drivers\\etc\\hosts';
    const rows = fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    const odd = rows.filter((l) => !/^(127\.0\.0\.1|::1|0\.0\.0\.0)\s/.test(l));
    const h = sha(rows.join('\n')), prev = ctx.baseline('hosts');
    ctx.setBaseline('hosts', h);
    const ev = `读取 hosts 文件，有效条目 ${rows.length} 条（指向非本机地址 ${odd.length} 条）；内容指纹 ${h}，上次 ${prev || '（首次检查，已记录为基线）'}`;
    if (prev && prev !== h) return item('hosts', 'Hosts 文件', 'warn', '与上次检查相比，hosts 文件内容发生了变化。', ev, '确认是不是你自己（或某个你信任的软件）改的；不是的话请检查文件内容。', rows);
    if (odd.length) return item('hosts', 'Hosts 文件', 'warn', `有 ${odd.length} 条把域名指向非本机地址的记录。`, ev, '如果是你自己添加的可忽略；否则建议检查。', odd);
    return item('hosts', 'Hosts 文件', 'ok', prev ? '与上次一致，没有异常的域名重定向。' : '没有异常的域名重定向（已记录当前状态作为对比基线）。', ev, '无需处理。');
  } catch (_) { return unk('hosts', 'Hosts 文件', '读不到 hosts 文件'); }
}
async function proxy(ctx) {
  const p = await psJson("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL | ConvertTo-Json -Compress");
  if (!p) return unk('proxy', '系统代理设置', '读不到代理设置');
  const cur = `${p.ProxyEnable}|${p.ProxyServer || ''}|${p.AutoConfigURL || ''}`, prev = ctx.baseline('proxy');
  ctx.setBaseline('proxy', cur);
  const on = p.ProxyEnable === 1 || !!p.AutoConfigURL;
  const ev = `读取 Internet Settings：ProxyEnable=${p.ProxyEnable}，ProxyServer=${p.ProxyServer || '无'}，AutoConfigURL=${p.AutoConfigURL || '无'}；上次 ${prev === undefined ? '（首次检查，已记录为基线）' : prev === cur ? '与现在一致' : '与现在不同'}`;
  if (prev !== undefined && prev !== cur) return item('proxy', '系统代理设置', 'warn', '与上次检查相比，系统代理设置发生了变化。', ev, '如果是你的代理/翻墙软件改的就没问题；不是的话请检查。');
  return item('proxy', '系统代理设置', 'ok', on ? `系统代理已启用（${p.ProxyServer || p.AutoConfigURL}），与上次一致。` : '没有启用系统代理。', ev, '无需处理。');
}
async function disk(si) {
  try {
    const d = (await si.fsSize()).filter((x) => x.size > 0);
    const worst = d.reduce((a, b) => (b.use > (a ? a.use : -1) ? b : a), null);
    const ev = 'systeminformation.fsSize：' + d.map((x) => `${x.mount} 已用 ${x.use.toFixed(0)}%`).join('，');
    if (worst && worst.use >= 95) return item('disk', '磁盘剩余空间', 'bad', `${worst.mount} 只剩不到 5%。`, ev, '尽快清理空间，空间不足会让系统和软件变慢甚至出错。');
    if (worst && worst.use >= 90) return item('disk', '磁盘剩余空间', 'warn', `${worst.mount} 已用 ${worst.use.toFixed(0)}%。`, ev, '建议清理不用的文件。');
    return item('disk', '磁盘剩余空间', 'ok', '各磁盘剩余空间正常。', ev, '无需处理。');
  } catch (_) { return unk('disk', '磁盘剩余空间', '读不到磁盘信息'); }
}
function resources(ctx) {
  if (ctx.memPct == null && ctx.cpu == null) return unk('res', '系统资源', '硬件状态监控未开启或暂无数据');
  const hi = [];
  if (ctx.memPct >= 90) hi.push(`内存 ${ctx.memPct.toFixed(0)}%`);
  if (ctx.cpu >= 90) hi.push(`CPU ${ctx.cpu.toFixed(0)}%`);
  const ev = `最近一次采样：CPU ${ctx.cpu == null ? '—' : ctx.cpu.toFixed(0) + '%'}，内存 ${ctx.memPct == null ? '—' : ctx.memPct.toFixed(0) + '%'}（单次采样，不代表长期情况）`;
  return hi.length ? item('res', '系统资源', 'warn', `当前占用偏高：${hi.join('、')}。`, ev, '在“概览 → 资源占用排行”查看谁占得多，必要时打开任务管理器处理。') : item('res', '系统资源', 'ok', '当前资源占用正常。', ev, '无需处理。');
}

async function diskHealth() {
  const T = '硬盘健康（SMART）';
  const l = arr(await psJson("Get-PhysicalDisk | ForEach-Object { $r = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue; @{n=$_.FriendlyName;m=[string]$_.MediaType;h=[string]$_.HealthStatus;o=($_.OperationalStatus -join ',');w=$r.Wear;t=$r.Temperature;e=$r.ReadErrorsUncorrected} } | ConvertTo-Json -Compress"));
  if (!l.length) return unk('smart', T, '读不到硬盘健康信息（部分 USB/RAID 硬盘不提供）');
  const rows = l.map((d) => `${d.n}（${d.m || '未知类型'}）：${d.h}${d.w != null ? `，寿命已用 ${d.w}%` : ''}${d.t ? `，${d.t}℃` : ''}${d.e ? `，不可纠正读取错误 ${d.e}` : ''}`);
  const ev = 'Get-PhysicalDisk / Get-StorageReliabilityCounter（Windows 自带，读取硬盘 SMART 汇总；寿命和错误计数在部分硬盘或非管理员下读不到）：' + rows.join('；');
  const bad = l.filter((d) => /unhealthy/i.test(d.h) || Number(d.e) > 0), warn = l.filter((d) => /warning/i.test(d.h) || Number(d.w) >= 90);
  if (bad.length) return item('smart', T, 'bad', `${bad.map((d) => d.n).join('、')} 报告异常。`, ev, '请尽快备份重要文件，并考虑更换这块硬盘。', rows);
  if (warn.length) return item('smart', T, 'warn', `${warn.map((d) => d.n).join('、')} 需要留意（健康警告或寿命已用 90% 以上）。`, ev, '建议备份重要文件，留意后续变化。', rows);
  return item('smart', T, 'ok', `共 ${l.length} 块硬盘，健康状态正常。`, ev, '无需处理。', rows);
}
async function batteryHealth() {
  const T = '电池健康';
  const b = await psJson("$d=(Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue | Select-Object -First 1).DesignedCapacity; $f=(Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue | Select-Object -First 1).FullChargedCapacity; $c=(Get-CimInstance -Namespace root/wmi -ClassName BatteryCycleCount -ErrorAction SilentlyContinue | Select-Object -First 1).CycleCount; if($d -or $f){ @{d=[double]$d;f=[double]$f;c=$c} | ConvertTo-Json -Compress }");
  if (!b) return null; // 台式机没有电池：不显示这一项
  const w = batteryWear(Number(b.d), Number(b.f));
  const ev = `root/wmi：设计容量 ${b.d} mWh，当前满充容量 ${b.f} mWh${b.c ? `，循环次数 ${b.c}` : ''}（数值由电池固件提供，不同品牌准确度不同）`;
  if (w == null) return unk('battery', T, '电池没有提供可靠的容量数据');
  if (w >= 40) return item('battery', T, 'warn', `电池损耗约 ${w}%，续航明显缩短。`, ev, '考虑联系厂商更换电池；平时避免长期满电高温使用。');
  return item('battery', T, 'ok', `电池损耗约 ${w}%。`, ev, w >= 20 ? '属于正常老化范围。' : '无需处理。');
}
async function run(si, ctx) {
  if (!isWin) return { items: [unk('os', '系统健康检查', '目前只支持 Windows')], score: null, at: Date.now() };
  const [d, f, u, s, pt, px, dk, sm, bt] = await Promise.all([defender(), firewall(), update(), startup(), ports(si), proxy(ctx), disk(si), diskHealth(), batteryHealth()]);
  const items = [d, f, u, s, ...pt, hosts(ctx), px, dk, sm, ...(bt ? [bt] : []), resources(ctx)];
  let score = 100; for (const i of items) score -= i.status === 'bad' ? 20 : i.status === 'warn' ? 8 : 0;
  return { items, score: Math.max(0, score), at: Date.now() };
}
async function quickScan() { return (await ps('try { Start-MpScan -ScanType QuickScan -ErrorAction Stop; "done" } catch { "fail" }', 15 * 60 * 1000)) === 'done'; }
export { run, quickScan, killAll, NOTABLE_PORTS, isLoopListen };
