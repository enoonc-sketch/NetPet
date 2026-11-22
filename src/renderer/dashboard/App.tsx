import { useEffect, useMemo, useState } from 'react';
import { Chart, NAME, Off, fmt, inv, sz, useLoad } from './common';
import { thumbnails } from '../pets3d';
import { PETS } from '../../shared/petlist';
import type { StartupItem, HealthReport, JunkClean, JunkScan, PetStatus, PState, Runtime, Sample, SettingsView, Speed } from '../../shared/types';

const TABS: [string, string][] = [['ov', '概览'], ['net', '网络统计'], ['hl', '系统健康'], ['upd', '系统更新'], ['pt', '宠物'], ['pri', '隐私'], ['boot', '启动管理'], ['vpn', 'VPN'], ['clean', '系统清理'], ['set', '设置']];
type Go = (t: string) => void;

export function App() {
  const [tab, setTab] = useState('ov');
  const [cfg, setCfg] = useState<SettingsView | null>(null);
  const [rt, setRt] = useState<Runtime>({ paused: false, dnd: false, passthrough: false });
  const [ps, setPs] = useState<PState | null>(null);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [sp, setSp] = useState<Speed>({ rx: null, tx: null });
  const [sm, setSm] = useState<Sample | null>(null);
  const [h, setH] = useState<{ rx: number[]; tx: number[] }>({ rx: Array(60).fill(0), tx: Array(60).fill(0) });
  const reloadCfg = () => inv<SettingsView>('get-settings').then(setCfg);

  useEffect(() => {
    const api = window.netpet;
    api.on('goto', setTab); api.on('runtime', (r) => setRt((o) => ({ ...o, ...r }))); api.on('pstate', setPs); api.on('sample', setSm);
    api.on('speed', (s) => { setSp(s); setH((o) => ({ rx: [...o.rx.slice(1), s.rx || 0], tx: [...o.tx.slice(1), s.tx || 0] })); });
    api.on('settings', () => { reloadCfg(); });
    inv<boolean>('lock-status').then(setLocked);
    inv('get-pstate').then((p) => p && setPs(p)).catch(() => {});
  }, []);
  useEffect(() => { if (locked === false) { reloadCfg(); inv('get-runtime').then((r) => setRt((o) => ({ ...o, ...r }))); } }, [locked]);

  if (locked === null) return null;
  if (locked) return <Lock onOk={() => setLocked(false)} />;
  const go: Go = setTab;
  return (
    <>
      <header>
        <h1>NetPet</h1>
        <nav>{TABS.map(([k, t]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>)}</nav>
        <div className="hr">
          <span className="chipb">宠物状态：{ps ? (ps.paused ? '已暂停监控' : NAME[ps.state] || ps.state) + (ps.online === false ? '（网络已断开）' : ps.internet === 'fail' ? '（上不了网）' : ps.internet === 'portal' ? '（需网页登录）' : '') : '待机'}</span>
          <button className="act" onClick={() => inv('set-runtime', { paused: !rt.paused })}>{rt.paused ? '恢复监控' : '暂停监控'}</button>
          <button className="act" onClick={() => inv('set-runtime', { dnd: !rt.dnd })}>{rt.dnd ? '关闭勿扰' : '勿扰'}</button>
        </div>
      </header>
      {cfg?.safe && <div className="off" style={{ margin: '12px 22px 0' }}>⚠ 当前处于<b>安全模式</b>（上次启动没有顺利完成，或你用安全模式启动）：已关闭 3D、硬件监控、连接记录、进程排行和健康检查。 <button className="act" onClick={() => inv('exit-safe')}>重启并退出安全模式</button></div>}
      <main>
        {tab === 'ov' && <Overview sp={sp} sm={sm} h={h} go={go} />}
        {tab === 'net' && <Network go={go} />}
        {tab === 'hl' && <Health go={go} />}
        {tab === 'pt' && <Pets cfg={cfg} reload={reloadCfg} />}
        {tab === 'pri' && <Privacy cfg={cfg} reload={reloadCfg} />}
        {tab === 'upd' && <Upd />}
        {tab === 'boot' && <Boot />}
        {tab === 'vpn' && <Vpn />}
        {tab === 'clean' && <Clean />}
        {tab === 'set' && <Settings cfg={cfg} rt={rt} reload={reloadCfg} />}
      </main>
    </>
  );
}

function Lock({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState(''); const [msg, setMsg] = useState('');
  const submit = async () => { if (await inv<boolean>('unlock', pw)) onOk(); else setMsg('密码不对，再试一次'); };
  return (
    <div id="lock" className="on"><h1>NetPet 已上锁</h1>
      <input type="password" autoFocus placeholder="输入密码" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <button className="act pri" onClick={submit}>解锁</button><div className="mute">{msg}</div></div>
  );
}

/* ---------------- 概览 ---------------- */
function Overview({ sp, sm, h, go }: { sp: Speed; sm: Sample | null; h: { rx: number[]; tx: number[] }; go: Go }) {
  const [sys] = useLoad<any>(() => inv('get-system'), [], 10000);
  const [procs] = useLoad<any>(() => inv('get-processes'), [], 15000);
  const g = sys?.gpu?.[0], su = sys?.summary;
  const table = (a: any[], k: 'mem' | 'cpu') => (
    <table><thead><tr><th>程序</th><th>{k === 'mem' ? '内存' : 'CPU'}</th></tr></thead>
      <tbody>{a.map((x) => <tr key={x.pid}><td>{x.name} <span className="mute">{x.pid}</span></td><td>{k === 'mem' ? sz(x.mem) : x.cpu.toFixed(1) + '%'}</td></tr>)}</tbody></table>
  );
  return (
    <section className="on">
      <div className="grid g4">
        <div className="card tile"><div className="l">下载</div><div className="v d">{fmt(sp.rx)}</div></div>
        <div className="card tile"><div className="l">上传</div><div className="v u">{fmt(sp.tx)}</div></div>
        <div className="card tile"><div className="l">CPU</div><div className="v">{sm ? sm.cpu.toFixed(0) + '%' : '—'}</div></div>
        <div className="card tile"><div className="l">内存</div><div className="v">{sm ? sm.pct.toFixed(0) + '%' : '—'}</div><div className="l">{sm ? sz(sm.used) + ' / ' + sz(sm.total) : ''}</div></div>
      </div>
      <div className="card"><h2>最近 60 秒网速</h2><Chart hx={h.rx} ht={h.tx} /></div>
      <div className="grid g2">
        <div className="card"><h2>硬件状态</h2>
          {!sys ? null : !sys.hwOn ? <Off msg="“硬件状态监控”已关闭。" go={go} /> : <>
            {(sys.disks || []).map((d: any) => <div key={d.mount}>{d.mount} <span className="mute">{sz(d.used)} / {sz(d.size)}（剩余 {sz(d.size - d.used)}）</span><div className="bar"><i style={{ width: d.pct + '%' }} /></div></div>)}
            <div className="mute">GPU：{g ? g.name + (g.util != null ? '，占用 ' + g.util + '%' : '（读不到占用率）') : '无法检测'}<br />
              温度：{sys.temp ? sys.temp.toFixed(0) + '℃' : '读不到（硬件或驱动不提供）'}
              {sys.battery ? <><br />电池：{sys.battery.pct}%{sys.battery.charging ? '（充电中）' : ''}</> : null}<br />开机已 {Math.floor(sys.uptime / 3600)} 小时
              {su ? <><br />近 24 小时：CPU 平均 {su.cpu.toFixed(0)}%（峰值 {su.cpuMax.toFixed(0)}%），内存平均 {su.mem.toFixed(0)}%</> : null}</div></>}
        </div>
        <div className="card"><h2>网卡总流量</h2>
          {!sys ? null : !sys.netOn ? <Off msg="“网络速度监控”已关闭。" go={go} /> : <>
            <div>今天  <span className="d">↓ {sz(sys.today.rx)}</span>  <span className="u">↑ {sz(sys.today.tx)}</span></div>
            <div style={{ marginTop: 8 }}>本月  <span className="d">↓ {sz(sys.month.rx)}</span>  <span className="u">↑ {sz(sys.month.tx)}</span></div>
            {sys.quotaGB > 0 ? <><div className="mute" style={{ marginTop: 8 }}>本月额度 {sys.quotaGB} GB，已用 {Math.min(999, ((sys.month.rx + sys.month.tx) / (sys.quotaGB * 1073741824)) * 100).toFixed(0)}%</div><div className="bar"><i style={{ width: Math.min(100, ((sys.month.rx + sys.month.tx) / (sys.quotaGB * 1073741824)) * 100) + '%' }} /></div></> : null}</>}
        </div>
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>资源占用排行</h2><span className="row" style={{ margin: 0 }}><MemTrimBtn /><button className="act" onClick={() => inv('open-taskmgr')}>打开任务管理器</button></span></div>
        {!procs ? null : procs.disabled ? <Off msg="“进程资源排行”已关闭。" go={go} /> : <>
          <div className="grid g2"><div><div className="mute">按内存</div>{table(procs.byMem, 'mem')}</div><div><div className="mute">按 CPU</div>{table(procs.byCpu, 'cpu')}</div></div>
          <p className="mute" style={{ marginTop: 8 }}>NetPet 不会自动结束任何程序。需要处理时，请点上面的“打开任务管理器”自己操作。</p></>}
      </div>
    </section>
  );
}

function MemTrimBtn() {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await inv<any>('trim-mem');
      const gain = Math.max(0, r.before - r.after);
      alert(r.ok ? `已整理 ${r.trimmed} 个程序的运行内存，可用内存增加约 ${sz(gain)}。\n没有关闭任何程序；程序再次用到时会自动取回内存。` : '整理失败：' + (r.error || '未知原因'));
    } catch { alert('整理失败'); }
    setBusy(false);
  };
  return <button className="act" disabled={busy} onClick={go}>{busy ? '整理中…' : '整理运行内存'}</button>;
}

/* ---------------- 网络统计 ---------------- */
function Network({ go }: { go: Go }) {
  const [days, setDays] = useState(1); const [q, setQ] = useState(''); const [qd, setQd] = useState('');
  useEffect(() => { const t = setTimeout(() => setQd(q), 250); return () => clearTimeout(t); }, [q]);
  const [sys] = useLoad<any>(() => inv('get-system'), []);
  const [ad] = useLoad<any>(() => inv('get-adapters'), []);
  const [rec, reload] = useLoad<any>(() => inv('get-records', { days, q: qd }), [days, qd]);
  const rank = (a: any[]) => (a && a.length ? a.map((x) => <div key={x.name}><span>{x.name}</span><b>{x.count}</b></div>) : <span className="mute">暂无记录</span>);
  return (
    <section className="on">
      <div className="card"><h2>A. 网卡总流量（整台电脑）</h2>
        {sys && (sys.netOn ? <div>今天  <span className="d">↓ {sz(sys.today.rx)}</span> <span className="u">↑ {sz(sys.today.tx)}</span>　　本月  <span className="d">↓ {sz(sys.month.rx)}</span> <span className="u">↑ {sz(sys.month.tx)}</span></div> : <Off msg="“网络速度监控”已关闭。" go={go} />)}
        <table style={{ marginTop: 8 }}><thead><tr><th>网卡</th><th>类型</th><th>速率</th><th>IPv4</th><th>状态</th></tr></thead>
          <tbody>{ad && !ad.disabled && ad.list.map((x: any) => <tr key={x.name}><td>{x.name}{x.virtual ? <span className="mute"> (虚拟)</span> : null}</td><td>{x.type}</td><td>{x.speed > 0 ? x.speed + ' Mbps' : '—'}</td><td>{x.ip4 || '—'}</td><td>{x.up ? '已连接' : '未连接'}</td></tr>)}</tbody></table>
        <p className="mute" style={{ marginTop: 8 }}>实时网速优先只统计物理网卡，避免代理/虚拟网卡（TUN、VPN 等）导致重复计算。</p></div>
      <div className="card"><h2>B. 按程序统计的流量</h2><div className="off" style={{ margin: 0 }}>⚠ 暂未实现。要得到准确的“每个程序用了多少流量”，需要使用 Windows 的 ETW 网络事件，这需要原生组件和管理员权限，目前没有做。NetPet 不会把网卡总流量冒充成某个程序的流量。下面的 C 只是“连接记录”，不含流量大小。</div></div>
      <div className="card"><h2>C. 连接记录（元数据：哪个程序连了哪个地址）</h2>
        {rec && !rec.connOn && <Off msg="“网络使用统计”目前是关闭的。" go={go} />}
        <div className="row">
          <input type="text" placeholder="搜索程序 / 主机名 / IP" style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>今天</option><option value={3}>近 3 天</option><option value={7}>近 7 天</option><option value={30}>近 30 天</option></select>
          <button className="act" onClick={async () => { const r = await inv('export-csv', { days, q: qd }); if (r.ok) alert('已导出到：' + r.path); }}>导出 CSV</button>
          <button className="act danger" onClick={async () => { if (confirm('确定清理所有连接记录吗？这个操作不能撤销。')) { await inv('clear-records'); reload(); } }}>清理连接记录</button>
          <span className="mute">{rec && rec.connOn ? `共 ${rec.total} 条${rec.total > 500 ? '（列表显示最近 500 条）' : ''}` : ''}</span>
        </div>
        <div className="grid g2"><div><h2>连接次数最多的程序</h2><div className="rank">{rank(rec?.byProc)}</div></div><div><h2>常连的主机</h2><div className="rank">{rank(rec?.byHost)}</div></div></div>
        <table style={{ marginTop: 12 }}><thead><tr><th>时间</th><th>程序</th><th>主机 / IP</th><th>端口</th><th>提示（仅供参考）</th></tr></thead>
          <tbody>{(rec?.rows || []).map((x: any, i: number) => <tr key={i}><td>{new Date(x.t).toLocaleString()}</td><td>{x.proc}</td><td>{x.host || x.ip}{x.host ? <div className="mute">{x.ip}</div> : null}</td><td>{x.port}</td><td className="tag">{x.note}</td></tr>)}</tbody></table>
        <p className="mute" style={{ marginTop: 10 }}>只记录“新建连接”的元数据，不含网页内容、不含通信内容。主机名需要在“隐私”页开启“解析主机名”才会显示（默认只显示 IP），CDN 的名字看起来可能不像网站名。</p></div>
    </section>
  );
}

/* ---------------- 系统健康 ---------------- */
const L: Record<string, string> = { ok: '正常', warn: '注意', bad: '异常', unknown: '无法检测' };
function Health({ go }: { go: Go }) {
  const [cfg] = useLoad<SettingsView>(() => inv('get-settings'), []);
  const [last] = useLoad<HealthReport | null>(() => inv('last-security'), []);
  const [warns, reloadW] = useLoad<any[]>(() => inv('get-warnings'), []);
  const [rep, setRep] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false); const [scan, setScan] = useState(false);
  const on = !!cfg?.privacy.health, r = rep || last;
  const run = async () => {
    setBusy(true); const x = await inv<HealthReport>('run-security'); setBusy(false);
    if (x.disabled) return alert('系统健康检查未开启，请先到“隐私”页开启。');
    setRep(x); reloadW();
  };
  const sc = r?.score;
  return (
    <section className="on">
      <div className="card"><div className="row"><div><div className="mute">健康评分</div>
        <div className="score" style={{ color: sc == null ? undefined : sc >= 90 ? 'var(--ok)' : sc >= 70 ? 'var(--warn)' : 'var(--bad)' }}>{sc ?? '—'}</div>
        <div className="mute">{r ? '检查时间：' + new Date(r.at).toLocaleString() : ''}</div></div>
        <div style={{ marginLeft: 'auto' }} className="row">
          <button className="act pri" disabled={!on || busy} onClick={run}>{busy ? '体检中…' : r ? '重新体检' : '开始体检'}</button>
          <button className="act" disabled={!on || scan} onClick={async () => { if (!confirm('Defender 快速扫描可能需要几分钟，完成后会有通知。现在开始吗？')) return; setScan(true); await inv('quick-scan'); setScan(false); }}>{scan ? '扫描中…' : '用 Windows Defender 快速扫描'}</button></div></div>
        <p className="mute">NetPet 只做只读检查并给出依据，不是杀毒软件；病毒扫描由 Windows Defender 执行，需要你主动点击才会开始。</p></div>
      {cfg && !on && <div className="card"><Off msg="“系统健康检查”目前是关闭的。" go={go} /></div>}
      <div className="card">
        {!r ? <p className="mute">点“开始体检”检查：Defender、防火墙、更新、启动项、监听端口、网络连接、hosts、系统代理、磁盘空间、硬盘健康（SMART）、电池健康（笔记本）、系统资源。</p>
          : r.items.map((i) => (
            <div key={i.id} className={'sec ' + i.status}><span className="dot" /><div><b>{i.title} · {L[i.status]}</b><p>{i.detail}</p>
              <details><summary>检查依据与建议</summary><div><b style={{ display: 'inline' }}>检查依据：</b>{i.evidence}</div><div><b style={{ display: 'inline' }}>建议：</b>{i.advice}</div>
                {i.list && i.list.length ? <><div style={{ marginTop: 4 }}>明细（{i.list.length} 项）：</div>{i.list.map((l, k) => <div key={k}>{l}</div>)}</> : null}</details></div></div>))}
      </div>
      <div className="card"><h2>历史提醒</h2><table><thead><tr><th>时间</th><th>级别</th><th>内容</th></tr></thead>
        <tbody>{(warns || []).length ? warns!.map((x, i) => <tr key={i}><td>{new Date(x.t).toLocaleString()}</td><td>{x.level === 'bad' ? '异常' : x.level === 'warn' ? '注意' : '提示'}</td><td>{x.title}{x.detail ? ' — ' + x.detail : ''}</td></tr>) : <tr><td colSpan={3} className="mute">暂无</td></tr>}</tbody></table></div>
    </section>
  );
}

/* ---------------- 宠物 ---------------- */
const ANIM: Record<string, string> = { DOWNLOAD: '下载活跃时的动画', UPLOAD: '上传活跃时的动画', TIRED: 'CPU 长时间高负载（累了）', HOT: '温度偏高（出汗）', SWEAT: '内存占用过高（出汗）', WARNING: '系统健康检查异常（警示牌）' };
function Pets({ cfg, reload }: { cfg: SettingsView | null; reload: () => void }) {
  const thumbs = useMemo(() => { if (!cfg) return []; if (cfg.safe) return PETS.map((p) => ({ ...p, url: '' })); try { return thumbnails(112); } catch { return PETS.map((p) => ({ ...p, url: '' })); } }, [!!cfg, cfg?.safe]);
  const [g] = useLoad<any>(() => inv('get-growth'), []);
  const [ach] = useLoad<any[]>(() => inv('get-achievements'), []);
  const pct = g ? Math.min(100, ((g.xp - g.cur) / (g.next - g.cur)) * 100) : 0;
  return (
    <section className="on">
      <div className="card"><h2>选择小宠物（3D，共 {thumbs.length} 只）</h2>
        <div className="pets">{thumbs.map((x) => <button key={x.id} className={'pc' + (cfg?.pet === x.id ? ' on' : '')} onClick={async () => { await inv('set-settings', { pet: x.id }); reload(); }}>
          {x.url ? <img src={x.url} /> : <div className="em">{x.emoji}</div>}<span>{x.name}</span></button>)}</div>
        <p className="mute" style={{ marginTop: 10 }}>也可以右键小宠物或托盘图标 → 切换宠物。</p></div>
      <div className="card"><h2>成长</h2>{g && <><div><b>Lv.{g.level}</b> <span className="mute">经验 {g.xp} / {g.next}</span></div><div className="bar"><i style={{ width: pct + '%' }} /></div>
        <div className="mute">陪伴 {g.daysUsed} 天，累计网卡流量 {sz(g.total)}。每运行 1 分钟、每传输 1 GB 流量都会增加经验。</div></>}</div>
      <div className="card"><h2>动画提醒</h2><p className="mute" style={{ marginBottom: 6 }}>关闭后，宠物不再用对应的动画表达这个状态（不影响监控本身）。</p>
        {cfg && Object.entries(ANIM).map(([k, t]) => <div className="set" key={k}><span>{t}</span><input type="checkbox" checked={!!cfg.anim[k]} onChange={async (e) => { await inv('set-settings', { anim: { [k]: e.target.checked } }); reload(); }} /></div>)}</div>
      <div className="card"><h2>成就</h2>{(ach || []).map((x) => <div key={x.name} className={'ach' + (x.done ? '' : ' lock')}>{x.done ? '🏅' : '🔒'} <b>{x.name}</b> <span className="mute">{x.desc}</span></div>)}</div>
    </section>
  );
}

/* ---------------- 隐私 ---------------- */
const FEATS = [
  { k: 'net', t: '网络速度监控', what: '读取网卡累计收发字节数（系统计数器），换算成每秒速度，并按天累计流量。', why: '显示实时网速、驱动宠物状态、统计今日/本月流量。', where: '本机数据库 netpet.db（network_statistics、adapter_information）', admin: '不需要', stop: '关闭这个开关，立即停止。', del: '下方“清空全部历史数据”。' },
  { k: 'hw', t: '硬件状态监控', what: '读取 CPU、内存、磁盘、GPU、电池、温度（硬件支持时）。', why: '面板显示硬件状态；宠物在 CPU/内存/温度偏高时变“累了/出汗”。', where: '本机数据库（hardware_statistics，每分钟一条：CPU、内存%、温度）', admin: '不需要', stop: '关闭这个开关。', del: '下方“清空全部历史数据”。' },
  { k: 'conn', t: '网络使用统计（连接记录）', what: '记录每次新建的对外网络连接：程序名、对方地址、端口。不记录通信内容、网页内容。', why: '在“网络统计”里查看哪个程序联网最多，可导出 CSV。', where: '本机数据库（connection_records）', admin: '不需要', stop: '关闭这个开关。', del: '“网络统计”页的“清理连接记录”，或下方“清空全部历史数据”。' },
  { k: 'dns', t: '解析主机名（反向 DNS）', what: '把连接记录里的对方 IP 交给系统 DNS 服务器反向查询主机名。注意：这会让你的 DNS 服务器（通常是路由器或运营商）知道这些 IP。', why: '让连接记录显示更容易看懂的主机名。仅在“网络使用统计”开启时有效。', where: '主机名随连接记录保存在本机数据库', admin: '不需要', stop: '关闭这个开关（默认关闭）。', del: '同“网络使用统计”。' },
  { k: 'proc', t: '进程资源排行', what: '列出占用内存/CPU 最多的程序（名称、占用）。只在你打开概览页时读取，不保存。', why: '帮你找出最占资源的程序。NetPet 不会结束任何程序。', where: '不保存', admin: '不需要', stop: '关闭这个开关。', del: '没有数据需要删除。' },
  { k: 'health', t: '系统健康检查', what: '只读检查 Defender、防火墙、更新、启动项、监听端口、hosts、系统代理、磁盘。hosts 和代理只保存“内容指纹”，用来对比是否变化。', why: '发现问题时提醒你，并给出依据和建议。', where: '本机数据库（system_health、warning_records）和设置', admin: '不需要（Defender 快速扫描在部分系统上可能需要）', stop: '关闭这个开关（也不会再自动体检）。', del: '下方“清空全部历史数据”。' },
  { k: '__newProc', t: '新程序首次联网提醒', what: '基于“连接记录”：某个程序第一次连接外网时提醒你。开启后的前 24 小时只“学习”现有程序、不提醒。只在本机比对程序名，不联网。', why: '及时发现你不认识的程序在联网。仅在“网络使用统计（连接记录）”开启时有效。', where: '已见过的程序名列表保存在设置里', admin: '不需要', stop: '关闭这个开关。', del: '关闭后再开启会清空列表、重新学习。' },
  { k: 'probe', t: '真实联网检测', what: '每 30 秒请求一次 Windows 自带联网检测使用的同一个地址 http://www.msftconnecttest.com/connecttest.txt，看能否拿到固定文本“Microsoft Connect Test”。不发送任何本机数据，不带 Cookie。注意：微软服务器（以及你的网络运营商）会看到这次请求，和 Windows 自己做的联网检测一样。', why: '区分“连着路由器但上不了网”和“需要网页登录的 Wi-Fi”。关闭时只根据本机有没有 IP 地址判断是否断网。仅在“网络速度监控”开启时有效。', where: '不保存（状态变化会记一条提醒）', admin: '不需要', stop: '关闭这个开关（默认关闭）。', del: '没有数据需要删除。' },
  { k: 'fullscreenHide', t: '全屏时自动隐藏宠物', what: '调用 Windows 自带的 SHQueryUserNotificationState 判断是否有全屏程序/演示。会启动一个后台 PowerShell 小进程，退出 NetPet 或关闭此项时一定会结束。不读取任何窗口内容。', why: '玩游戏、看全屏视频时不挡画面。', where: '不保存', admin: '不需要', stop: '关闭这个开关。', del: '没有数据需要删除。' }
];
function Privacy({ cfg, reload }: { cfg: SettingsView | null; reload: () => void }) {
  const [db] = useLoad<any>(() => inv('db-status'), []);
  const [pw, setPw] = useState('');
  if (!cfg) return null;
  const set = async (p: unknown) => { await inv('set-settings', p); reload(); };
  return (
    <section className="on">
      {!cfg.onboarded && <div className="card" style={{ background: '#FFF3EA' }}><b>首次使用，请先确认下面每一项监控是否开启。</b>
        <p className="mute" style={{ margin: '6px 0 10px' }}>默认只开启“网速”和“硬件状态”（只读本机，不联网），其余都需要你主动打开。下面的一览表列出了所有会联网或修改系统的功能。</p>
        <button className="act pri" onClick={async () => { await inv('ack-privacy'); reload(); }}>我已了解</button></div>}
      <div className="card"><h2>联网与系统修改一览</h2>
        <p className="mute">NetPet 没有服务器，不收集、不上传你的任何数据。默认设置下完全不联网。</p>
        <table style={{ marginTop: 6 }}><thead><tr><th>会联网的功能</th><th>当前</th><th>连到哪里</th></tr></thead><tbody>
          <tr><td>解析主机名（反向 DNS）</td><td>{cfg.privacy.dns && cfg.privacy.conn ? '已开启' : '关闭'}</td><td className="mute">系统 DNS 服务器，会知道你连过的 IP</td></tr>
          <tr><td>真实联网检测</td><td>{cfg.privacy.probe && cfg.privacy.net ? '已开启' : '关闭'}</td><td className="mute">www.msftconnecttest.com（微软），每 30 秒一次</td></tr>
          <tr><td>系统更新 → 检查可用更新</td><td>点击才运行</td><td className="mute">由 Windows 更新服务联系微软</td></tr>
          <tr><td>检查 NetPet 新版本</td><td>点击才运行</td><td className="mute">api.github.com（GitHub），一次请求</td></tr>
          <tr><td>VPN（sing-box）</td><td>点击才连接</td><td className="mute">你配置文件里的服务器，经过 VPN 的流量会交给它</td></tr>
        </tbody></table>
        <p className="mute" style={{ marginTop: 8 }}>会修改系统、且都需要你主动操作的：开机自启、系统清理（删除不可恢复）、启动管理（可恢复）、VPN 连接期间的系统代理（断开即恢复）。完整说明见安装目录 docs 里的《隐私数据流审查》。</p></div>
      {FEATS.map((f) => (
        <div className="card feat" key={f.k}><div className="top"><b>{f.t}</b><input type="checkbox" checked={f.k === '__newProc' ? !!cfg.newProc?.on : !!cfg.privacy[f.k]} onChange={(e) => set(f.k === '__newProc' ? { newProc: { on: e.target.checked } } : { privacy: { [f.k]: e.target.checked } })} /></div>
          {f.k === '__newProc' && cfg.newProc?.on ? <div className="mute" style={{ marginTop: 4 }}>{Date.now() < cfg.newProc.learnUntil ? `学习中，${new Date(cfg.newProc.learnUntil).toLocaleString()} 之后开始提醒。` : '正在提醒。'}已记录 {cfg.newProc.count} 个程序。{!cfg.privacy.conn ? ' ⚠ 需要先开启“网络使用统计（连接记录）”。' : ''}</div> : null}
          <dl><dt>监控什么</dt><dd>{f.what}</dd><dt>为什么</dt><dd>{f.why}</dd><dt>数据存放</dt><dd>{f.where}</dd><dt>管理员权限</dt><dd>{f.admin}</dd><dt>如何停止</dt><dd>{f.stop}</dd><dt>如何删除</dt><dd>{f.del}</dd></dl></div>))}
      <div className="card feat"><div className="top"><b>开机自启</b><input type="checkbox" checked={cfg.autostart} onChange={(e) => set({ autostart: e.target.checked })} /></div>
        <dl><dt>做什么</dt><dd>在 Windows 登录项里注册 NetPet，登录后自动启动。{cfg.packaged ? '' : '（当前是开发模式，请用安装版开启）'}</dd><dt>如何停止</dt><dd>关闭这个开关；卸载软件时也会清除。</dd></dl></div>
      <div className="card"><h2>数据管理</h2><p className="mute">所有数据只保存在这台电脑上，NetPet 不会上传。统计数据未加密，敏感设置已加密（见下）；sing-box 配置文件只读取、不复制。</p>
        <div className="set"><span>数据位置</span><span className="mute">{cfg.dataDir}</span></div>
        <div className="set"><span>数据库状态</span><span className="mute">{!db ? '' : db.ok ? '正常' + (db.recovered ? '（上次发现损坏，已自动重建）' : '') : '不可用：' + db.error}</span></div>
        <div className="set"><span>敏感设置加密<br /><span className="mute">面板密码、sing-box 路径、VPN 代理备份用 Windows 账户加密（DPAPI）保存，拷到别的电脑或账户无法解开。统计数据本身不加密。</span></span>
          <span className="mute">{!db ? '' : db.encAvailable ? '已加密' : '不可用（以明文保存）'}{db?.encFailed?.length ? `；有 ${db.encFailed.length} 项无法解密已重置` : ''}</span></div>
        <div className="row" style={{ marginTop: 12 }}><button className="act" onClick={() => inv('open-data-dir')}>打开数据文件夹</button>
          <button className="act" onClick={async () => { const r = await inv('backup-db'); if (r.ok) alert('已备份到：' + r.path); else if (r.msg) alert('备份失败：' + r.msg); }}>备份数据库</button>
          <button className="act" onClick={async () => { const r = await inv<any>('export-diag'); if (r.ok) alert('诊断包已保存到：' + r.path + '\n包含日志和系统信息，不含统计数据、连接记录、密码和 VPN 配置。'); else if (r.msg) alert('导出失败：' + r.msg); }}>导出诊断包</button>
          <button className="act danger" onClick={async () => { if (confirm('确定清空全部历史数据吗？（网速统计、连接记录、硬件历史、健康检查记录、提醒）\n设置不会被删除。此操作不能撤销。')) { await inv('clear-all'); alert('已清空。'); } }}>清空全部历史数据</button></div></div>
      <div className="card"><h2>面板密码锁</h2><div className="set"><span>打开完整窗口时需要输入密码<br /><span className="mute">用于防止别人随手查看或误操作。密码哈希已加密保存，但统计数据本身未加密。忘记密码请参考 docs/排障说明.md。</span></span>
        <span className="row" style={{ margin: 0 }}><input type="password" placeholder="新密码" style={{ width: 120 }} value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="act" onClick={async () => { if (!pw) return alert('请先输入新密码'); await inv('set-password', pw); setPw(''); alert('密码已设置，下次打开完整窗口需要输入。'); }}>设置</button>
          <button className="act" onClick={async () => { await inv('set-password', ''); alert('密码已移除。'); }}>移除</button></span></div></div>
    </section>
  );
}

/* ---------------- 系统更新 ---------------- */
function Upd() {
  const [r, setR] = useState<any>(null); const [busy, setBusy] = useState('');
  useEffect(() => { inv('last-updates').then((x) => { if (x) setR(x); else run(false); }).catch(() => {}); }, []);
  const run = async (online: boolean) => { setBusy(online ? 'online' : 'local'); try { setR(await inv('check-updates', { online })); } catch { setR({ ok: false, error: '检查失败', items: [] }); } setBusy(''); };
  const v = !r || !r.ok ? null : (r.items.some((i: any) => /critical|important/i.test(i.severity)) ? 'bad' : (r.items.length || r.pendingReboot || (r.lastPatch && r.lastPatch.days > 60)) ? 'warn' : 'ok');
  const head = !r ? '' : !r.ok ? '无法检测' : v === 'bad' ? '有重要的安全更新' : r.items.length ? `有 ${r.items.length} 个可用更新` : r.pendingReboot ? '更新已安装，等待重启' : r.online ? '系统已是最新' : '本机状态正常（未联网检查）';
  return (
    <section className="on">
      <div className="card"><h2>系统更新</h2>
        <p className="mute">只检查、不下载、不安装、不重启。“检查可用更新”调用 Windows 自带的更新服务，和 设置 → Windows 更新 → 检查更新 走同一个通道，由 Windows 联系微软服务器，可能需要 1～3 分钟；“只看本机状态”不联网。</p>
        <div className="row"><button className="act pri" disabled={!!busy} onClick={() => run(true)}>{busy === 'online' ? '正在检查（可能需要几分钟）…' : '检查可用更新'}</button>
          <button className="act" disabled={!!busy} onClick={() => run(false)}>{busy === 'local' ? '读取中…' : '只看本机状态'}</button>
          <button className="act" onClick={() => inv('open-winupdate')}>打开 Windows 更新</button></div></div>
      {r && <div className="card">
        <div className={'sec ' + (v || 'unknown')}><span className="dot" /><div><b>{head}</b>
          <p>{r.os ? `${r.os}（版本 ${r.build}）` : ''}{r.lastPatch ? ` · 最近补丁 ${r.lastPatch.kb}，${r.lastPatch.date}（${r.lastPatch.days} 天前）` : ''}</p>
          {r.pendingReboot && <p>⚠ 有更新等待重启才能完成（{r.rebootReasons.join('、')}）。请在方便时重启电脑。</p>}
          {r.error && <p className="mute">{r.error}</p>}
          <p className="mute">检查时间：{new Date(r.at).toLocaleString()}{r.online ? '' : '（未联网检查可用更新）'}</p></div></div></div>}
      {r && r.items && r.items.length > 0 && <div className="card"><h2>可用更新</h2><table><thead><tr><th>类别</th><th>名称</th><th>KB</th><th>大小</th><th>需重启</th></tr></thead>
        <tbody>{r.items.map((i: any, k: number) => <tr key={k}><td>{i.category}{i.severity ? <div className="tag">{i.severity}</div> : null}</td><td>{i.title}</td><td>{i.kb || '—'}</td><td>{i.sizeMB ? i.sizeMB + ' MB' : '—'}</td><td>{i.reboot ? '是' : '否'}</td></tr>)}</tbody></table>
        <p className="mute" style={{ marginTop: 8 }}>点上面的“打开 Windows 更新”安装。NetPet 不会替你安装。</p></div>}
    </section>
  );
}

/* ---------------- VPN（sing-box）---------------- */
const VS: Record<string, string> = { stopped: '未连接', checking: '检查配置中…', starting: '启动中…', running: '已连接', error: '出错' };
function Vpn() {
  const [s, setS] = useState<any>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  const load = () => inv('vpn-status').then(setS).catch(() => {});
  useEffect(() => { load(); window.netpet.on('vpn', () => load()); const t = setInterval(load, 3000); return () => clearInterval(t); }, []);
  if (!s) return null;
  const on = s.state === 'running', mid = s.state === 'checking' || s.state === 'starting';
  const pick = async (kind: string) => { const r = await inv<any>('vpn-pick', { kind }); if (r.error) alert(r.error); load(); };
  const go = async () => {
    setBusy(true); setMsg('');
    try { if (on) await inv('vpn-stop'); else { const r = await inv<any>('vpn-start'); if (!r.ok) setMsg('✗ ' + (r.error || '启动失败')); } } catch { setMsg('✗ 操作失败'); }
    setBusy(false); load();
  };
  const up = on ? Math.floor((Date.now() - s.startedAt) / 60000) : 0;
  return (
    <section className="on">
      <div className="card"><h2>VPN（sing-box）</h2>
        <p className="mute">NetPet 只负责启动/停止你自己的 sing-box，并可在连接期间设置系统代理。<b>NetPet 不下载 sing-box、不拉取订阅、不内置任何服务器</b>，流量走向完全由你的配置文件决定。sing-box 可从其官方 GitHub 发布页获取。请遵守当地法律法规。</p>
        {s.safe && <div className="off" style={{ margin: '8px 0' }}>安全模式下不启动 VPN。</div>}
        <div className="row" style={{ alignItems: 'center' }}>
          <div><div className="mute">状态</div><div className="score" style={{ fontSize: 26, color: on ? 'var(--ok)' : s.state === 'error' ? 'var(--bad)' : undefined }}>{VS[s.state] || s.state}</div>
            <div className="mute">{on ? `已连接 ${up} 分钟${s.sysProxyOn ? ` · 系统代理 127.0.0.1:${s.proxyPort}` : s.proxyPort ? ` · 本机代理端口 ${s.proxyPort}（未设系统代理）` : ''}${s.tun ? ' · TUN 模式' : ''}` : s.error || ''}</div></div>
          <button className={'act ' + (on ? 'danger' : 'pri')} style={{ marginLeft: 'auto' }} disabled={busy || mid || s.safe || (!on && (!s.exe || !s.config))} onClick={go}>{busy || mid ? '处理中…' : on ? '断开' : '连接'}</button></div>
        {msg && <div style={{ marginTop: 8 }}>{msg}</div>}</div>
      <div className="card"><h2>配置</h2>
        <div className="set"><span>sing-box 程序<br /><span className="mute" style={{ wordBreak: 'break-all' }}>{s.exe || '未选择'}</span></span><button className="act" disabled={on || mid} onClick={() => pick('exe')}>选择…</button></div>
        <div className="set"><span>配置文件（.json）<br /><span className="mute" style={{ wordBreak: 'break-all' }}>{s.config || '未选择'}</span></span><button className="act" disabled={on || mid} onClick={() => pick('config')}>选择…</button></div>
        <div className="set"><span>连接时设置系统代理<br /><span className="mute">需要配置里有监听本机的 mixed 或 http 入站。断开、sing-box 意外退出或退出 NetPet 时会恢复原来的代理设置。用 TUN 模式时可以关闭。</span></span>
          <input type="checkbox" checked={!!s.sysProxy} disabled={on || mid} onChange={async (e) => { await inv('vpn-set', { sysProxy: e.target.checked }); load(); }} /></div>
        <p className="mute" style={{ marginTop: 8 }}>TUN 模式（配置里有 tun 入站）需要以管理员身份运行 NetPet。连接时会先运行 <code>sing-box check</code> 检查配置。</p></div>
      <div className="card"><h2>sing-box 日志（最近 80 行，只在内存里，不保存）</h2>
        <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>{(s.log || []).join('\n') || '（暂无）'}</pre></div>
    </section>
  );
}

/* ---------------- 启动管理 ---------------- */
function Boot() {
  const [data, setData] = useState<{ ok: boolean; items: StartupItem[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false); const [doing, setDoing] = useState(''); const [msg, setMsg] = useState('');
  const [onlyFlag, setOnlyFlag] = useState(false);
  const load = async () => { setBusy(true); try { setData(await inv('list-startup')); } catch { setData({ ok: false, items: [], error: '读取失败' }); } setBusy(false); };
  useEffect(() => { load(); }, []);
  const toggle = async (x: StartupItem) => {
    if (x.enabled && !confirm(`禁用“${x.name}”后，下次开机它不会自动启动。\n不会删除任何文件，随时可以在这里重新启用。确定吗？`)) return;
    setDoing(x.id); setMsg('');
    try {
      const r = await inv<any>('set-startup', { id: x.id, enabled: !x.enabled });
      if (!r.ok) setMsg('✗ ' + (r.error || '失败')); else setMsg(`✓ 已${x.enabled ? '禁用' : '启用'}：${x.name}（下次开机生效）`);
    } catch { setMsg('✗ 操作失败'); }
    setDoing(''); load();
  };
  const items = (data?.items || []).filter((x) => !onlyFlag || x.flagged);
  const en = (data?.items || []).filter((x) => x.enabled).length;
  return (
    <section className="on">
      <div className="card"><h2>启动管理</h2>
        <p className="mute">管理开机时自动运行的程序。和 Windows 任务管理器“启动应用”的做法一样：<b>禁用只是关掉启用标记，不删除任何文件或注册表项</b>，随时可以重新启用，下次开机生效。只在你打开这一页时读取，不保存、不上传。“所有用户”的启动项需要管理员权限，这里只显示，可以用任务管理器修改。</p>
        <div className="row"><button className="act pri" disabled={busy} onClick={load}>{busy ? '读取中…' : '刷新'}</button>
          <button className="act" onClick={() => inv('open-taskmgr-startup')}>打开任务管理器 · 启动应用</button>
          <label className="mute"><input type="checkbox" checked={onlyFlag} onChange={(e) => setOnlyFlag(e.target.checked)} /> 只看标 ⚠ 的</label>
          <span className="mute">{data?.ok ? `共 ${data.items.length} 项，已启用 ${en} 项` : data?.error || ''}</span></div>
        {msg && <div style={{ marginTop: 8 }}>{msg}</div>}</div>
      <div className="card"><table><thead><tr><th>名称</th><th>来源</th><th>命令</th><th>状态</th><th></th></tr></thead>
        <tbody>{items.map((x) => <tr key={x.id} style={x.enabled ? undefined : { opacity: 0.6 }}>
          <td>{x.flagged ? '⚠ ' : ''}{x.name}</td>
          <td className="mute">{x.srcName}</td>
          <td className="mute" style={{ wordBreak: 'break-all', maxWidth: 380 }}>{x.command}{x.flagged ? <div className="tag">路径在 Temp/Public 或用脚本启动，值得确认（不代表一定有问题）</div> : null}</td>
          <td>{x.enabled ? '已启用' : '已禁用'}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            {x.canToggle ? <button className={'act' + (x.enabled ? ' danger' : '')} disabled={!!doing} onClick={() => toggle(x)}>{doing === x.id ? '处理中…' : x.enabled ? '禁用' : '启用'}</button>
              : <span className="mute">需管理员</span>}
            {' '}<button className="act" onClick={async () => { if (!(await inv('show-startup-file', { id: x.id }))) alert('找不到这个程序文件（路径可能带参数或已被删除）。'); }}>位置</button></td></tr>)}
          {!items.length && <tr><td colSpan={5} className="mute">{busy ? '正在读取…' : onlyFlag ? '没有标 ⚠ 的启动项' : data?.error || '没有启动项'}</td></tr>}</tbody></table></div>
    </section>
  );
}

/* ---------------- 系统清理 ---------------- */
function Clean() {
  const [scan, setScan] = useState<JunkScan[] | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [res, setRes] = useState<JunkClean[] | null>(null);
  const [msg, setMsg] = useState('');
  const doScan = async () => {
    setBusy(true); setRes(null); setMsg('');
    try { const r = await inv<JunkScan[]>('scan-junk'); setScan(r); setSel(r.filter((x) => x.id !== 'recycle-bin' && x.id !== 'netpet-logs' && x.size > 0).map((x) => x.id)); }
    catch { setMsg('扫描失败，请重试。'); }
    setBusy(false);
  };
  useEffect(() => { doScan(); }, []);
  const total = (scan || []).filter((x) => sel.includes(x.id)).reduce((a, x) => a + x.size, 0);
  const clean = async () => {
    if (!sel.length) return alert('请先勾选要清理的类别。');
    const names = (scan || []).filter((x) => sel.includes(x.id)).map((x) => x.name).join('、');
    if (!confirm(`确定清理以下内容吗？\n${names}\n预计释放约 ${sz(total)}。\n${sel.includes('recycle-bin') ? '注意：回收站清空后不可恢复。\n' : ''}正在使用的文件会自动跳过，不会强行删除。`)) return;
    setCleaning(true); setRes(null);
    try { const r = await inv<JunkClean[]>('clean-junk', { ids: sel }); setRes(r); await doScan(); }
    catch { setMsg('清理失败，请重试。'); }
    setCleaning(false);
  };
  return (
    <section className="on">
      <div className="card"><h2>系统垃圾清理</h2>
        <p className="mute">先扫描、再勾选、最后确认才删除。只清理白名单里的临时文件、浏览器缓存、崩溃转储和回收站；<b>绝不碰文档、下载、桌面、图片和程序文件</b>，也不动 Windows Update 下载和 Prefetch。浏览器开着时，被占用的缓存文件会跳过，想清干净请先关浏览器。</p>
        <div className="row"><button className="act pri" disabled={busy || cleaning} onClick={doScan}>{busy ? '扫描中…' : '重新扫描'}</button>
          <button className="act danger" disabled={!sel.length || cleaning} onClick={clean}>{cleaning ? '清理中…' : `清理已选（约 ${sz(total)}）`}</button>
          <span className="mute">{msg}</span></div></div>
      {res && <div className="card"><h2>清理结果</h2>
        {res.map((r) => { const nm = (scan || []).find((x) => x.id === r.id)?.name || r.id; return <div key={r.id}>{r.ok ? `✓ ${nm}：释放 ${sz(r.freed)}，删除 ${r.deletedFiles} 个文件，跳过 ${r.skippedFiles} 个（正在使用或无权限）` : `✗ ${nm}：${r.error || '失败'}`}</div>; })}
        <div className="mute" style={{ marginTop: 6 }}>合计释放 {sz(res.reduce((a, r) => a + r.freed, 0))}。</div></div>}
      <div className="card"><table><thead><tr><th></th><th>类别</th><th>大小</th><th>文件数</th><th>说明</th></tr></thead>
        <tbody>{(scan || []).map((x) => <tr key={x.id}>
          <td><input type="checkbox" checked={sel.includes(x.id)} onChange={(e) => setSel((o) => e.target.checked ? [...o, x.id] : o.filter((y) => y !== x.id))} /></td>
          <td>{x.name}</td><td>{sz(x.size)}</td><td>{x.files}</td>
          <td className="mute">{x.desc}{x.skipped.length ? <><br />{x.skipped.join('；')}</> : null}</td></tr>)}
        {(!scan || !scan.length) && <tr><td colSpan={5} className="mute">{busy ? '正在扫描…' : '暂无数据'}</td></tr>}</tbody></table></div>
    </section>
  );
}

function SelfUpdate() {
  const [r, setR] = useState<any>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { inv('last-self-update').then(setR).catch(() => {}); }, []);
  const go = async () => { setBusy(true); try { setR(await inv('check-self-update')); } catch { setR({ ok: false, error: '检查失败' }); } setBusy(false); };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row"><button className="act" disabled={busy} onClick={go}>{busy ? '检查中…' : '检查新版本'}</button>
        {r && r.ok && r.newer && <button className="act pri" onClick={() => inv('open-release')}>打开发布页下载 {r.latest}</button>}
        <span className="mute">{!r ? '' : !r.ok ? r.error : r.newer ? `有新版本 ${r.latest}${r.published ? `（${r.published} 发布）` : ''}` : `已是最新版本（${r.current}）`}{r ? ` · 检查于 ${new Date(r.at).toLocaleString()}` : ''}</span></div>
      {r && r.ok && r.newer && r.notes ? <details style={{ marginTop: 6 }}><summary>更新内容</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{r.notes}</pre></details> : null}
      <p className="mute" style={{ marginTop: 6 }}>只在你点击时访问 GitHub 一次（api.github.com），不发送任何本机数据；GitHub 会看到你的 IP。NetPet 不会自动检查、下载或安装更新，新版本请在发布页自己下载。</p>
    </div>
  );
}

/* ---------------- 设置 ---------------- */
function Settings({ cfg, rt, reload }: { cfg: SettingsView | null; rt: Runtime; reload: () => void }) {
  const [st, reloadSt] = useLoad<PetStatus>(() => inv('get-pet-status'), []);
  if (!cfg) return null;
  const set = async (p: unknown) => { await inv('set-settings', p); reload(); };
  return (
    <section className="on">
      <div className="card"><h2>小宠物不见了？一键复位</h2>
        <p className="mute">复位只做四件事：位置回主显示器右下角、恢复显示、取消鼠标穿透、恢复置顶。不动宠物种类、隐私开关、监控数据和成长经验。{st ? (st.visible ? '当前状态：宠物正在显示。' : st.userHidden ? '当前状态：宠物被手动隐藏了（可能是不小心点了托盘图标）。' : st.fsHidden ? '当前状态：全屏应用正在运行，“全屏时自动隐藏”把它藏起来了，退出全屏就回来。' : '当前状态：宠物不在屏幕上，可能是位置跑出屏幕或渲染失败。') : ''}</p>
        <div className="row"><button className="act pri" onClick={async () => { await inv('reset-pet'); reloadSt(); }}>一键复位小宠物</button>
          <span className="mute">也可以右键小宠物 / 右键托盘图标 → 一键复位小宠物。</span></div></div>
      <div className="card">
        <div className="set"><span>紧凑模式<br /><span className="mute">把宠物窗口缩小到约 96×100，气泡改为一行小字</span></span><input type="checkbox" checked={cfg.compact} onChange={(e) => set({ compact: e.target.checked })} /></div>
        <div className="set"><span>小宠物始终置顶</span><input type="checkbox" checked={cfg.alwaysOnTop} onChange={(e) => set({ alwaysOnTop: e.target.checked })} /></div>
        <div className="set"><span>每月流量额度（GB，0 = 不提醒）<br /><span className="mute">按自然月统计网卡总流量（上传 + 下载），用到 80% 和 100% 时各提醒一次。适合手机热点、按流量计费的宽带。</span></span>
          <input type="number" min={0} max={100000} style={{ width: 90 }} defaultValue={cfg.quota?.gb || 0} onBlur={(e) => set({ quota: { gb: Number(e.target.value) || 0 } })} /></div>
        <div className="set"><span>久坐提醒<br /><span className="mute">按实际使用电脑的时间计算，离开 5 分钟以上算休息过；勿扰、全屏、暂停监控时不打扰。</span></span>
          <select value={cfg.remind?.sit ?? 0} onChange={(e) => set({ remind: { sit: Number(e.target.value) } })}>{[0, 30, 45, 60, 90, 120].map((v) => <option key={v} value={v}>{v ? `每 ${v} 分钟` : '关闭'}</option>)}</select></div>
        <div className="set"><span>喝水提醒</span>
          <select value={cfg.remind?.water ?? 0} onChange={(e) => set({ remind: { water: Number(e.target.value) } })}>{[0, 30, 45, 60, 90, 120].map((v) => <option key={v} value={v}>{v ? `每 ${v} 分钟` : '关闭'}</option>)}</select></div>
        <div className="set"><span>运行内存高时自动整理<br /><span className="mute">内存占用持续 1 分钟超过下面的阈值时，让后台程序交还暂时不用的内存（不关闭任何程序，跳过系统进程和你正在用的窗口），两次之间至少隔 10 分钟。程序再次用到时会自动取回，可能短暂变慢。默认关闭。</span></span>
          <input type="checkbox" checked={!!cfg.memTrim?.auto} onChange={(e) => set({ memTrim: { auto: e.target.checked } })} /></div>
        <div className="set"><span>自动整理阈值（%）</span><select value={cfg.memTrim?.threshold ?? 90} onChange={(e) => set({ memTrim: { threshold: Number(e.target.value) } })}>{[80, 85, 90, 95].map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="set"><span>内存提醒阈值</span><select value={cfg.memAlert} onChange={(e) => set({ memAlert: Number(e.target.value) })}>{[80, 85, 90, 95].map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="set"><span>历史数据保留天数</span><select value={cfg.retentionDays} onChange={(e) => set({ retentionDays: Number(e.target.value) })}>{[7, 30, 90].map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="set"><span>鼠标穿透<br /><span className="mute">开启后宠物不能被点击/拖动，需要从托盘菜单关闭</span></span><input type="checkbox" checked={!!rt.passthrough} onChange={(e) => inv('set-runtime', { passthrough: e.target.checked })} /></div>
      </div>
      <div className="card"><h2>关于</h2><p className="mute">NetPet {cfg.version} · 数据目录：{cfg.dataDir} · 所有监控数据只保存在本机。</p><SelfUpdate /></div>
    </section>
  );
}
