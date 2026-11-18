// 系统健康检查：全部为只读检查。每项给出 状态(ok正常/warn注意/bad异常/unknown无法检测) + 检查依据 + 建议。
// 不凭端口/IP/进程名断定恶意；病毒查杀由 Windows Defender 完成。
const { execFile } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const isWin = process.platform === 'win32';
const arr = (x) => (x == null ? [] : [].concat(x));
const kids = new Set();

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
async function psJson(cmd) { const o = await ps(cmd); if (!o) return null; try { return JSON.parse(o); } catch (_) { return null; } }
const item = (id, title, status, detail, evidence, advice, list) => ({ id, title, status, detail, evidence, advice, list });
const unk = (id, title, why) => item(id, title, 'unknown', '无法检测：' + why, '读取失败，没有拿到可靠数据，所以不下结论。', '可以手动在 Windows 安全中心 / 设置里查看。');

const RISKY_PORTS = { 21: 'FTP', 23: 'Telnet', 135: 'RPC', 139: 'NetBIOS', 445: 'SMB 文件共享', 3389: '远程桌面', 5900: 'VNC', 5985: 'WinRM' };
const NOTABLE_PORTS = { 3333: '常见挖矿端口', 4444: '常见后门/挖矿端口', 5555: '常见挖矿端口', 14444: '常见挖矿端口', 14433: '常见挖矿端口', 45560: '常见挖矿端口', 6667: 'IRC', 1337: '常见木马端口', 31337: '常见木马端口', 12345: '常见木马端口' };
const STARTUP_NOTE = /\\Temp\\|\\Users\\Public\\|-enc\s|-encodedcommand|wscript|cscript|mshta|\.vbs\b|\.js\b/i;
const isLoop = (ip) => !ip || /^(127\.|::1|::$|0\.0\.0\.0$)/.test(ip);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

async function defender() {
  const d = await psJson("Get-MpComputerStatus | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,@{n='sig';e={$_.AntivirusSignatureLastUpdated.ToString('s')}} | ConvertTo-Json -Compress");
  const T = '病毒防护 (Windows Defender)';
  if (!d) return unk('defender', T, '读不到 Defender 状态（可能装了其他杀毒软件，或权限不足）');
  const ev = `Get-MpComputerStatus：AntivirusEnabled=${d.AntivirusEnabled}，RealTimeProtectionEnabled=${d.RealTimeProtectionEnabled}，病毒库更新时间=${d.sig}`;
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
  return off.length ? item('fw', 'Windows 防火墙', 'bad', `这些网络类型的防火墙是关闭的：${off.join('、')}。`, ev, '在 Windows 安全中心 → 防火墙和网络保护 里打开。如果是你自己有意关闭的，可忽略。')
    : item('fw', 'Windows 防火墙', 'ok', '所有网络类型的防火墙都已开启。', ev, '无需处理。');
}
async function update() {
  const h = arr(await psJson("Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1 @{n='d';e={$_.InstalledOn.ToString('s')}},HotFixID | ConvertTo-Json -Compress"))[0];
  if (!h) return unk('upd', 'Windows 更新', '读不到补丁记录');
  const age = Math.floor((Date.now() - new Date(h.d).getTime()) / 864e5);
  const ev = `Get-HotFix 最近一条：${h.HotFixID}，安装于 ${h.d.slice(0, 10)}（该命令不一定列出全部更新，仅供参考）`;
  return age > 60 ? item('upd', 'Windows 更新', 'warn', `最近一次补丁是 ${age} 天前。`, ev, '打开 设置 → Windows 更新，检查是否有待安装的更新。')
    : item('upd', 'Windows 更新', 'ok', `最近一次补丁是 ${age} 天前。`, ev, '无需处理。');
}
async function startup() {
  const s = arr(await psJson('Get-CimInstance Win32_StartupCommand | Select-Object Name,Command | ConvertTo-Json -Compress'));
  const list = s.map((x) => ({ t: `${x.Name}  —  ${x.Command}`, f: STARTUP_NOTE.test(x.Command || '') }));
  const n = list.filter((x) => x.f).length;
  const ev = `Win32_StartupCommand 共 ${list.length} 项（只包含用户可见的启动项）。标 ⚠ 的是路径在 Temp/Public，或用脚本程序启动——这只是提示，不少正常软件也这样启动。`;
  return item('startup', '开机启动项', n ? 'warn' : 'ok', n ? `共 ${list.length} 项，其中 ${n} 项值得看一眼（已标 ⚠）。` : `共 ${list.length} 项，没有发现路径或启动方式特别的项目。`, ev,
    n ? '确认标 ⚠ 的项目是不是你认识的软件；不需要的可以在任务管理器 → 启动应用 里禁用。' : '无需处理。', list.map((x) => (x.f ? '⚠ ' : '') + x.t));
}
async function ports(si) {
  try {
    const all = await si.networkConnections();
    const lis = all.filter((x) => x.state === 'LISTEN' && !isLoop(x.localAddress));
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

async function run(si, ctx) {
  if (!isWin) return { items: [unk('os', '系统健康检查', '目前只支持 Windows')], score: null, at: Date.now() };
  const [d, f, u, s, pt, px, dk] = await Promise.all([defender(), firewall(), update(), startup(), ports(si), proxy(ctx), disk(si)]);
  const items = [d, f, u, s, ...pt, hosts(ctx), px, dk, resources(ctx)];
  let score = 100; for (const i of items) score -= i.status === 'bad' ? 20 : i.status === 'warn' ? 8 : 0;
  return { items, score: Math.max(0, score), at: Date.now() };
}
async function quickScan() { return (await ps('Start-MpScan -ScanType QuickScan; "done"', 15 * 60 * 1000)) === 'done'; }
module.exports = { run, quickScan, killAll, NOTABLE_PORTS };
