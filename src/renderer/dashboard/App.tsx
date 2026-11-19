import { useEffect, useMemo, useState } from 'react';
import { Chart, NAME, Off, fmt, inv, sz, useLoad } from './common';
import { thumbnails } from '../pets3d';
import { PETS } from '../../shared/petlist';
import type { HealthReport, JunkClean, JunkScan, PetStatus, PState, Runtime, Sample, SettingsView, Speed } from '../../shared/types';

const TABS: [string, string][] = [['ov', '概览'], ['net', '网络统计'], ['hl', '系统健康'], ['pt', '宠物'], ['pri', '隐私'], ['clean', '系统清理'], ['set', '设置']];
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
          <span className="chipb">宠物状态：{ps ? (ps.paused ? '已暂停监控' : NAME[ps.state] || ps.state) + (ps.online === false ? '（网络已断开）' : '') : '待机'}</span>
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
  const [procs] = useLoad<any>(() => inv('get-processes'), [], 8000);
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
            <div style={{ marginTop: 8 }}>本月  <span className="d">↓ {sz(sys.month.rx)}</span>  <span className="u">↑ {sz(sys.month.tx)}</span></div></>}
        </div>
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>资源占用排行</h2><button className="act" onClick={() => inv('open-taskmgr')}>打开任务管理器</button></div>
        {!procs ? null : procs.disabled ? <Off msg="“进程资源排行”已关闭。" go={go} /> : <>
          <div className="grid g2"><div><div className="mute">按内存</div>{table(procs.byMem, 'mem')}</div><div><div className="mute">按 CPU</div>{table(procs.byCpu, 'cpu')}</div></div>
          <p className="mute" style={{ marginTop: 8 }}>NetPet 不会自动结束任何程序。需要处理时，请点上面的“打开任务管理器”自己操作。</p></>}
      </div>
    </section>
  );
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
        {!r ? <p className="mute">点“开始体检”检查：Defender、防火墙、更新、启动项、监听端口、网络连接、hosts、系统代理、磁盘、系统资源。</p>
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
        <p className="mute" style={{ margin: '6px 0 10px' }}>默认只开启“网速”和“硬件状态”，其余都需要你主动打开。随时可以回到这里修改。</p>
        <button className="act pri" onClick={async () => { await inv('ack-privacy'); reload(); }}>我已了解</button></div>}
      {FEATS.map((f) => (
        <div className="card feat" key={f.k}><div className="top"><b>{f.t}</b><input type="checkbox" checked={!!cfg.privacy[f.k]} onChange={(e) => set({ privacy: { [f.k]: e.target.checked } })} /></div>
          <dl><dt>监控什么</dt><dd>{f.what}</dd><dt>为什么</dt><dd>{f.why}</dd><dt>数据存放</dt><dd>{f.where}</dd><dt>管理员权限</dt><dd>{f.admin}</dd><dt>如何停止</dt><dd>{f.stop}</dd><dt>如何删除</dt><dd>{f.del}</dd></dl></div>))}
      <div className="card feat"><div className="top"><b>开机自启</b><input type="checkbox" checked={cfg.autostart} onChange={(e) => set({ autostart: e.target.checked })} /></div>
        <dl><dt>做什么</dt><dd>在 Windows 登录项里注册 NetPet，登录后自动启动。{cfg.packaged ? '' : '（当前是开发模式，请用安装版开启）'}</dd><dt>如何停止</dt><dd>关闭这个开关；卸载软件时也会清除。</dd></dl></div>
      <div className="card"><h2>数据管理</h2><p className="mute">所有数据只保存在这台电脑上，NetPet 不会上传任何监控数据。</p>
        <div className="set"><span>数据位置</span><span className="mute">{cfg.dataDir}</span></div>
        <div className="set"><span>数据库状态</span><span className="mute">{!db ? '' : db.ok ? '正常' + (db.recovered ? '（上次发现损坏，已自动重建）' : '') : '不可用：' + db.error}</span></div>
        <div className="row" style={{ marginTop: 12 }}><button className="act" onClick={() => inv('open-data-dir')}>打开数据文件夹</button>
          <button className="act" onClick={async () => { const r = await inv('backup-db'); if (r.ok) alert('已备份到：' + r.path); else if (r.msg) alert('备份失败：' + r.msg); }}>备份数据库</button>
          <button className="act danger" onClick={async () => { if (confirm('确定清空全部历史数据吗？（网速统计、连接记录、硬件历史、健康检查记录、提醒）\n设置不会被删除。此操作不能撤销。')) { await inv('clear-all'); alert('已清空。'); } }}>清空全部历史数据</button></div></div>
      <div className="card"><h2>面板密码锁</h2><div className="set"><span>打开完整窗口时需要输入密码<br /><span className="mute">忘记密码的话，需要删除数据文件夹里的 netpet.db 才能重置（会丢失所有数据）</span></span>
        <span className="row" style={{ margin: 0 }}><input type="password" placeholder="新密码" style={{ width: 120 }} value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="act" onClick={async () => { if (!pw) return alert('请先输入新密码'); await inv('set-password', pw); setPw(''); alert('密码已设置，下次打开完整窗口需要输入。'); }}>设置</button>
          <button className="act" onClick={async () => { await inv('set-password', ''); alert('密码已移除。'); }}>移除</button></span></div></div>
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
    try { const r = await inv<JunkScan[]>('scan-junk'); setScan(r); setSel(r.filter((x) => x.id !== 'recycle-bin' && x.size > 0).map((x) => x.id)); }
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
        {res.map((r) => <div key={r.id}>{r.ok ? `✓ ${r.id}：释放 ${sz(r.freed)}，删除 ${r.deletedFiles} 个文件，跳过 ${r.skippedFiles} 个（正在使用或无权限）` : `✗ ${r.id}：${r.error || '失败'}`}</div>)}
        <div className="mute" style={{ marginTop: 6 }}>合计释放 {sz(res.reduce((a, r) => a + r.freed, 0))}。回收站清理不计入释放大小（清空即完成）。</div></div>}
      <div className="card"><table><thead><tr><th></th><th>类别</th><th>大小</th><th>文件数</th><th>说明</th></tr></thead>
        <tbody>{(scan || []).map((x) => <tr key={x.id}>
          <td><input type="checkbox" checked={sel.includes(x.id)} onChange={(e) => setSel((o) => e.target.checked ? [...o, x.id] : o.filter((y) => y !== x.id))} /></td>
          <td>{x.name}</td><td>{sz(x.size)}</td><td>{x.files}</td>
          <td className="mute">{x.desc}{x.skipped.length ? <><br />{x.skipped.join('；')}</> : null}</td></tr>)}
        {(!scan || !scan.length) && <tr><td colSpan={5} className="mute">{busy ? '正在扫描…' : '暂无数据'}</td></tr>}</tbody></table></div>
    </section>
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
        <div className="set"><span>内存提醒阈值</span><select value={cfg.memAlert} onChange={(e) => set({ memAlert: Number(e.target.value) })}>{[80, 85, 90, 95].map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="set"><span>历史数据保留天数</span><select value={cfg.retentionDays} onChange={(e) => set({ retentionDays: Number(e.target.value) })}>{[7, 30, 90].map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="set"><span>鼠标穿透<br /><span className="mute">开启后宠物不能被点击/拖动，需要从托盘菜单关闭</span></span><input type="checkbox" checked={!!rt.passthrough} onChange={(e) => inv('set-runtime', { passthrough: e.target.checked })} /></div>
      </div>
      <div className="card"><h2>关于</h2><p className="mute">NetPet {cfg.version} · 数据目录：{cfg.dataDir} · 所有监控数据只保存在本机。</p></div>
    </section>
  );
}
