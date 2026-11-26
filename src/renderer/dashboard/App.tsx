import { useEffect, useMemo, useState } from 'react';
import { BarChart, Chart, ErrorBox, Loading, NAME, Off, dt, errMsg, fmt, inv, sz, useLoad } from './common';
import { thumbnails } from '../pets3d';
import { PETS } from '../../shared/petlist';
import { HOTKEYS, PROC_HOTKEYS } from '../../shared/hotkey';
import { t, setLang, getLang } from '../../shared/i18n';
import type { StartupItem, HealthReport, JunkClean, JunkScan, PetStatus, PState, Runtime, Sample, SettingsView, Speed } from '../../shared/types';
import { Defender, Disk, Drivers, FocusPage, FocusMini, HwHistoryCard, MemPage, PowerPage, ProcMgr, SpeedAlertCard, Wardrobe, WeekPage } from './pages15';

const TABS = (): [string, string][] => [['ov', t('tab.ov')], ['net', t('tab.net')], ['hl', t('tab.hl')], ['upd', t('tab.upd')], ['drv', t('tab.drv')],
  ['av', t('tab.av')], ['pm', t('tab.pm')], ['mem', t('tab.mem')], ['disk', t('tab.disk')], ['power', t('tab.power')],
  ['focus', t('tab.focus')], ['week', t('tab.week')], ['pt', t('tab.pt')], ['pri', t('tab.pri')], ['boot', t('tab.boot')], ['vpn', 'VPN'], ['clean', t('tab.clean')], ['set', t('tab.set')]];
type Go = (t: string) => void;
const applyDocLang = (l: string) => { document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN'; document.title = 'NetPet'; };

export function App() {
  const [tab, setTab] = useState('ov');
  const [lang, setLangS] = useState(getLang());
  const [cfg, setCfg] = useState<SettingsView | null>(null);
  const [rt, setRt] = useState<Runtime>({ paused: false, dnd: false, passthrough: false });
  const [ps, setPs] = useState<PState | null>(null);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [sp, setSp] = useState<Speed>({ rx: null, tx: null });
  const [sm, setSm] = useState<Sample | null>(null);
  const [h, setH] = useState<{ rx: number[]; tx: number[] }>({ rx: Array(60).fill(0), tx: Array(60).fill(0) });
  const useLang = (l: any) => { if (l === 'zh' || l === 'en') { setLang(l); setLangS(l); applyDocLang(l); } };
  const reloadCfg = () => inv<SettingsView>('get-settings').then((c) => { if (c) useLang(c.lang); setCfg(c); });

  useEffect(() => {
    const api = window.netpet;
    const offs = [
      api.on('goto', setTab), api.on('runtime', (r) => setRt((o) => ({ ...o, ...r }))), api.on('pstate', setPs), api.on('sample', setSm),
      api.on('speed', (s) => { setSp(s); setH((o) => ({ rx: [...o.rx.slice(1), s.rx || 0], tx: [...o.tx.slice(1), s.tx || 0] })); }),
      api.on('settings', (s) => { if (s && s.lang) useLang(s.lang); reloadCfg().catch(() => {}); })
    ];
    inv<string>('get-lang').then(useLang).catch(() => {});
    // 读不到锁状态时按“未上锁”显示界面：真正的拦截在主进程，敏感操作仍会被拒绝
    inv<boolean>('lock-status').then(setLocked).catch(() => setLocked(false));
    inv('get-pstate').then((p) => p && setPs(p)).catch(() => {});
    return () => { for (const f of offs) { try { if (typeof f === 'function') f(); } catch (_) {} } };
  }, []);
  useEffect(() => { if (locked === false) { reloadCfg().catch(() => {}); inv('get-runtime').then((r) => setRt((o) => ({ ...o, ...r }))).catch(() => {}); } }, [locked]);

  if (locked === null) return <Loading text={t('ui.opening')} />;
  if (locked) return <Lock onOk={() => setLocked(false)} />;
  const go: Go = setTab;
  const ack = () => inv('ack-privacy').then(reloadCfg).catch((e) => alert(errMsg(e)));
  const stateText = ps ? (ps.paused ? t('st.pausedLong') : NAME[ps.state] || ps.state) + (ps.online === false ? t('st.offSuffix') : ps.internet === 'fail' ? t('st.noInetSuffix') : ps.internet === 'portal' ? t('st.portalSuffix') : '') : NAME.IDLE;
  return (
    <>
      <header>
        <h1>NetPet</h1>
        <nav role="tablist" aria-label={t('ui.tabs')}>{TABS().map(([k, tt]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{tt}</button>)}</nav>
        <div className="hr">
          <span className="chipb">{t('ui.petState', { s: stateText })}</span>
          <button className="act" aria-pressed={rt.paused} onClick={() => inv('set-runtime', { paused: !rt.paused }).catch((e) => alert(errMsg(e)))}>{rt.paused ? t('ui.resume') : t('tray.pause')}</button>
          <button className="act" aria-pressed={rt.dnd} onClick={() => inv('set-runtime', { dnd: !rt.dnd }).catch((e) => alert(errMsg(e)))}>{rt.dnd ? t('ui.dndOff') : t('ui.dnd')}</button>
        </div>
      </header>
      {cfg?.safe && <div className="off" style={{ margin: '12px 22px 0' }}>⚠ {t('ui.safe')} <button className="act" onClick={() => inv('exit-safe').catch((e) => alert(errMsg(e)))}>{t('ui.exitSafe')}</button></div>}
      <main key={lang}>
        {cfg && !cfg.onboarded && <Welcome cfg={cfg} go={go} onTab={tab} done={ack} />}
        {tab === 'ov' && <Overview sp={sp} sm={sm} h={h} go={go} />}
        {tab === 'net' && <Network go={go} />}
        {tab === 'hl' && <Health go={go} />}
        {tab === 'pt' && <Pets cfg={cfg} reload={reloadCfg} />}
        {tab === 'pri' && <Privacy cfg={cfg} reload={reloadCfg} />}
        {tab === 'upd' && <Upd />}
        {tab === 'drv' && <Drivers />}
        {tab === 'av' && <Defender cfg={cfg} reload={reloadCfg} />}
        {tab === 'pm' && <ProcMgr go={go} />}
        {tab === 'mem' && <MemPage cfg={cfg} reload={reloadCfg} go={go} />}
        {tab === 'disk' && <Disk cfg={cfg} reload={reloadCfg} />}
        {tab === 'power' && <PowerPage cfg={cfg} reload={reloadCfg} go={go} />}
        {tab === 'focus' && <FocusPage cfg={cfg} reload={reloadCfg} />}
        {tab === 'week' && <WeekPage cfg={cfg} reload={reloadCfg} />}
        {tab === 'boot' && <Boot />}
        {tab === 'vpn' && <Vpn />}
        {tab === 'clean' && <Clean />}
        {tab === 'set' && <Settings cfg={cfg} rt={rt} reload={reloadCfg} />}
      </main>
    </>
  );
}

function Lock({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState(''); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (!pw) { setMsg(t('lock.empty')); return; }
    setBusy(true);
    try { if (await inv<boolean>('unlock', pw)) onOk(); else { setMsg(t('lock.wrong')); setPw(''); } }
    catch (e) { setMsg(errMsg(e, t('lock.fail'))); }
    setBusy(false);
  };
  return (
    <div id="lock" className="on" role="dialog" aria-labelledby="lock-title"><h1 id="lock-title">{t('lock.title')}</h1>
      <label htmlFor="lock-pw" className="mute">{t('lock.label')}</label>
      <input id="lock-pw" type="password" autoFocus placeholder={t('lock.ph')} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <button className="act pri" disabled={busy} onClick={submit}>{busy ? t('lock.checking') : t('lock.btn')}</button><div className="mute" role="alert">{msg}</div>
      <div className="mute" style={{ maxWidth: 360, textAlign: 'center' }}>{t('lock.forgot')}</div></div>
  );
}

/* ---------------- 首次使用引导（1.4.0）---------------- */
function Welcome({ cfg, go, onTab, done }: { cfg: SettingsView; go: Go; onTab: string; done: () => void }) {
  return (
    <div className="card hi welcome" role="region" aria-label={t('wel.aria')}>
      <h2>👋 {t('wel.title', { v: cfg.version })}</h2>
      <ol>
        <li><b>{t('wel.1t')}</b>{t('wel.1')}</li>
        <li><b>{t('wel.2t')}</b>{t('wel.2')}{cfg.hotkey ? t('wel.2hk', { hk: cfg.hotkey }) : ''}{t('wel.dot')}</li>
        <li><b>{t('wel.3t')}</b>{t('wel.3')}</li>
        <li><b>{t('wel.4t')}</b>{t('wel.4')}</li>
      </ol>
      <div className="row" style={{ marginTop: 10, marginBottom: 0 }}>
        {onTab !== 'pri' && <button className="act" onClick={() => go('pri')}>{t('wel.seePri')}</button>}
        <button className="act pri" onClick={done}>{t('wel.done')}</button>
      </div>
    </div>
  );
}

/* ---------------- 概览 ---------------- */
function Overview({ sp, sm, h, go }: { sp: Speed; sm: Sample | null; h: { rx: number[]; tx: number[] }; go: Go }) {
  const [sys, reloadSys, sysErr] = useLoad<any>(() => inv('get-system'), [], 10000);
  const [procs, , procErr] = useLoad<any>(() => inv('get-processes'), [], 15000);
  const g = sys?.gpu?.[0], su = sys?.summary;
  const table = (a: any[], k: 'mem' | 'cpu') => (
    <table><thead><tr><th>{t('ov.prog')}</th><th>{k === 'mem' ? t('ov.mem') : 'CPU'}</th></tr></thead>
      <tbody>{a.map((x) => <tr key={x.pid}><td>{x.name} <span className="mute">{x.pid}</span></td><td>{k === 'mem' ? sz(x.mem) : x.cpu.toFixed(1) + '%'}</td></tr>)}</tbody></table>
  );
  return (
    <section className="on">
      <div className="grid g4">
        <div className="card tile"><div className="l">{t('ov.down')}</div><div className="v d">{fmt(sp.rx)}</div></div>
        <div className="card tile"><div className="l">{t('ov.up')}</div><div className="v u">{fmt(sp.tx)}</div></div>
        <div className="card tile"><div className="l">CPU</div><div className="v">{sm ? sm.cpu.toFixed(0) + '%' : '—'}</div></div>
        <div className="card tile"><div className="l">{t('ov.mem')}</div><div className="v">{sm ? sm.pct.toFixed(0) + '%' : '—'}</div><div className="l">{sm ? sz(sm.used) + ' / ' + sz(sm.total) : ''}</div></div>
      </div>
      <div className="card"><h2>{t('ov.last60')}</h2><Chart hx={h.rx} ht={h.tx} /></div>
      <FocusMini />
      <div className="grid g2">
        <div className="card"><h2>{t('ov.hw')}</h2>
          {!sys ? (sysErr ? <ErrorBox msg={sysErr} retry={reloadSys} /> : <Loading />) : !sys.hwOn ? <Off msg={t('off.hw')} go={go} /> : <>
            {(sys.disks || []).map((d: any) => <div key={d.mount}>{d.mount} <span className="mute">{sz(d.used)} / {sz(d.size)}{t('ov.free', { v: sz(d.size - d.used) })}</span><div className="bar"><i style={{ width: d.pct + '%' }} /></div></div>)}
            <div className="mute">GPU：{g ? g.name + (g.util != null ? t('ov.gpuUse', { v: g.util }) : t('ov.gpuNoUse')) : t('ov.na')}<br />
              {t('ov.temp')}：{sys.temp ? sys.temp.toFixed(0) + '℃' : t('ov.tempNa')}
              {sys.battery ? <><br />{t('ov.bat')}：{sys.battery.pct}%{sys.battery.charging ? t('ov.charging') : ''}</> : null}<br />{t('ov.uptime', { h: Math.floor(sys.uptime / 3600) })}
              {su ? <><br />{t('ov.24h', { a: su.cpu.toFixed(0), m: su.cpuMax.toFixed(0), mem: su.mem.toFixed(0) })}</> : null}</div></>}
        </div>
        <div className="card"><h2>{t('ov.traffic')}</h2>
          {!sys ? (sysErr ? null : <Loading />) : !sys.netOn ? <Off msg={t('off.net')} go={go} /> : <>
            <div>{t('ov.today')}  <span className="d">↓ {sz(sys.today.rx)}</span>  <span className="u">↑ {sz(sys.today.tx)}</span></div>
            <div style={{ marginTop: 8 }}>{t('ov.month')}  <span className="d">↓ {sz(sys.month.rx)}</span>  <span className="u">↑ {sz(sys.month.tx)}</span></div>
            {sys.quotaGB > 0 ? <><div className="mute" style={{ marginTop: 8 }}>{t('ov.quota', { gb: sys.quotaGB, pct: Math.min(999, ((sys.month.rx + sys.month.tx) / (sys.quotaGB * 1073741824)) * 100).toFixed(0) })}</div><div className="bar"><i style={{ width: Math.min(100, ((sys.month.rx + sys.month.tx) / (sys.quotaGB * 1073741824)) * 100) + '%' }} /></div></> : null}</>}
        </div>
      </div>
      <HwHistoryCard go={go} />
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{t('ov.rank')}</h2><span className="row" style={{ margin: 0 }}><MemTrimBtn /><button className="act" onClick={() => go('pm')}>{t('ov.openPm')}</button></span></div>
        {!procs ? (procErr ? <ErrorBox msg={procErr} /> : <Loading />) : procs.disabled ? <Off msg={t('off.proc')} go={go} /> : <>
          <div className="grid g2"><div><div className="mute">{t('ov.byMem')}</div>{table(procs.byMem, 'mem')}</div><div><div className="mute">{t('ov.byCpu')}</div>{table(procs.byCpu, 'cpu')}</div></div>
          <p className="mute" style={{ marginTop: 8 }}>{t('ov.noKill')}</p></>}
      </div>
    </section>
  );
}

export function MemTrimBtn() {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await inv<any>('trim-mem');
      alert(r.ok ? t('trim.ok', { n: r.trimmed, gain: sz(Math.max(0, r.freed != null ? r.freed : r.before - r.after)), s: ((r.ms || 0) / 1000).toFixed(1) }) : t('trim.fail', { e: r.error || '?' }));
    } catch (e) { alert(errMsg(e)); }
    setBusy(false);
  };
  return <button className="act" disabled={busy} onClick={go}>{busy ? t('trim.busy') : t('tray.trim')}</button>;
}

/* ---------------- 网络统计 ---------------- */
function Network({ go }: { go: Go }) {
  const [days, setDays] = useState(1); const [q, setQ] = useState(''); const [qd, setQd] = useState('');
  useEffect(() => { const tm = setTimeout(() => setQd(q), 250); return () => clearTimeout(tm); }, [q]);
  const [sys] = useLoad<any>(() => inv('get-system'), []);
  const [ad, , adErr] = useLoad<any>(() => inv('get-adapters'), []);
  const [rec, reload, recErr] = useLoad<any>(() => inv('get-records', { days, q: qd }), [days, qd]);
  const rank = (a: any[]) => (a && a.length ? a.map((x) => <div key={x.name}><span>{x.name}</span><b>{x.count}</b></div>) : <span className="mute">{t('ui.none')}</span>);
  return (
    <section className="on">
      <div className="card"><h2>{t('net.a')}</h2>
        {sys && (sys.netOn ? <div>{t('ov.today')}  <span className="d">↓ {sz(sys.today.rx)}</span> <span className="u">↑ {sz(sys.today.tx)}</span>　　{t('ov.month')}  <span className="d">↓ {sz(sys.month.rx)}</span> <span className="u">↑ {sz(sys.month.tx)}</span></div> : <Off msg={t('off.net')} go={go} />)}
        <table style={{ marginTop: 8 }}><thead><tr><th>{t('net.nic')}</th><th>{t('net.type')}</th><th>{t('net.speed')}</th><th>IPv4</th><th>{t('net.state')}</th></tr></thead>
          <tbody>{ad && !ad.disabled && ad.list.map((x: any) => <tr key={x.name}><td>{x.name}{x.virtual ? <span className="mute">{t('net.virtual')}</span> : null}</td><td>{x.type}</td><td>{x.speed > 0 ? x.speed + ' Mbps' : '—'}</td><td>{x.ip4 || '—'}</td><td>{x.up ? t('net.up') : t('net.down')}</td></tr>)}
            {(!ad || ad.disabled || !ad.list.length) && <tr><td colSpan={5} className="mute">{adErr || (!ad ? t('net.reading') : ad.disabled ? t('net.off') : t('net.noNic'))}</td></tr>}</tbody></table>
        <p className="mute" style={{ marginTop: 8 }}>{t('net.note')}</p></div>
      <TrafficReportCard go={go} />
      <div className="card"><h2>{t('net.b')}</h2><div className="off" style={{ margin: 0 }}>⚠ {t('net.bNote')}</div></div>
      <div className="card"><h2>{t('net.c')}</h2>
        {rec && !rec.connOn && <Off msg={t('off.conn')} go={go} />}
        <div className="row">
          <input type="text" placeholder={t('net.search')} aria-label={t('net.search')} style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label={t('net.range')} value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>{t('ov.today')}</option><option value={3}>{t('net.d3')}</option><option value={7}>{t('net.d7')}</option><option value={30}>{t('net.d30')}</option></select>
          <button className="act" onClick={async () => { try { const r = await inv('export-csv', { days, q: qd }); if (r.ok) alert(t('ui.savedTo', { p: r.path })); else if (r.msg) alert(t('net.csvFail', { m: r.msg })); } catch (e) { alert(errMsg(e)); } }}>{t('net.csv')}</button>
          <button className="act danger" onClick={async () => { if (confirm(t('net.clearQ'))) { try { await inv('clear-records'); reload(); } catch (e) { alert(errMsg(e)); } } }}>{t('net.clear')}</button>
          <span className="mute">{rec && rec.connOn ? t('net.total', { n: rec.total }) + (rec.total > 500 ? t('net.total500') : '') : ''}</span>
        </div>
        <div className="grid g2"><div><h2>{t('net.topProc')}</h2><div className="rank">{rank(rec?.byProc)}</div></div><div><h2>{t('net.topHost')}</h2><div className="rank">{rank(rec?.byHost)}</div></div></div>
        <table style={{ marginTop: 12 }}><thead><tr><th>{t('ui.time')}</th><th>{t('ov.prog')}</th><th>{t('net.host')}</th><th>{t('net.port')}</th><th>{t('net.hint')}</th></tr></thead>
          <tbody>{(rec?.rows || []).map((x: any, i: number) => <tr key={i}><td>{dt(x.t)}</td><td>{x.proc}</td><td>{x.host || x.ip}{x.host ? <div className="mute">{x.ip}</div> : null}</td><td>{x.port}</td><td className="tag">{x.note}</td></tr>)}
            {!(rec?.rows || []).length && <tr><td colSpan={5} className="mute">{recErr || (!rec ? t('ui.loading') : !rec.connOn ? t('net.connOff') : qd ? t('ui.noMatch') : t('net.noConn'))}</td></tr>}</tbody></table>
        <p className="mute" style={{ marginTop: 10 }}>{t('net.cNote')}</p></div>
    </section>
  );
}

/* ---------------- 流量周报 / 月报（1.4.0）---------------- */
function TrafficReportCard({ go }: { go: Go }) {
  const [days, setDays] = useState(7);
  const [rep, reload, err] = useLoad<any>(() => inv('get-traffic-report', { days }), [days], 60000);
  const list: { day: string; rx: number; tx: number }[] = rep && !rep.disabled ? rep.days || [] : [];
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{days === 7 ? t('rep.w') : t('rep.m')}</h2>
        <span className="row" style={{ margin: 0 }} role="group" aria-label={t('rep.range')}>
          <button className={'act' + (days === 7 ? ' pri' : '')} aria-pressed={days === 7} onClick={() => setDays(7)}>{t('rep.7')}</button>
          <button className={'act' + (days === 30 ? ' pri' : '')} aria-pressed={days === 30} onClick={() => setDays(30)}>{t('rep.30')}</button></span></div>
      {err ? <ErrorBox msg={err} retry={reload} /> : !rep ? <Loading /> : rep.disabled ? <Off msg={t('rep.off')} go={go} /> : <>
        <BarChart labels={list.map((d) => d.day.slice(5))} rx={list.map((d) => d.rx)} tx={list.map((d) => d.tx)} />
        <div className="mute" style={{ marginTop: 4 }}><span className="d">■</span> {t('ov.down')}　<span className="u">■</span> {t('ov.up')}　{t('rep.note')}</div>
        <div className="grid g4" style={{ marginTop: 10 }}>
          <div><div className="mute">{t('rep.totalDown')}</div><b className="d">{sz(rep.total.rx)}</b></div>
          <div><div className="mute">{t('rep.totalUp')}</div><b className="u">{sz(rep.total.tx)}</b></div>
          <div><div className="mute">{t('rep.avg')}</div><b>{sz(rep.avg)}</b></div>
          <div><div className="mute">{t('rep.peak')}</div><b>{rep.peak ? `${rep.peak.day.slice(5)}（${sz(rep.peak.bytes)}）` : '—'}</b></div>
        </div>
        {rep.activeDays === 0 ? <p className="mute" style={{ marginTop: 8 }}>{t('rep.empty')}</p> : null}
      </>}
    </div>
  );
}

/* ---------------- 系统健康 ---------------- */
const L = (): Record<string, string> => ({ ok: t('hl.ok'), warn: t('hl.warn'), bad: t('hl.bad'), unknown: t('hl.unknown') });
function Health({ go }: { go: Go }) {
  const [cfg] = useLoad<SettingsView>(() => inv('get-settings'), []);
  const [last] = useLoad<HealthReport | null>(() => inv('last-security'), []);
  const [warns, reloadW] = useLoad<any[]>(() => inv('get-warnings'), []);
  const [rep, setRep] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false); const [scan, setScan] = useState(false);
  const on = !!cfg?.privacy.health, r = rep || last;
  const run = async () => {
    setBusy(true);
    let x: HealthReport | null = null;
    try { x = await inv<HealthReport>('run-security'); } catch (e) { alert(errMsg(e, t('hl.fail'))); }
    setBusy(false);
    if (!x) return;
    if (x.disabled) return alert(t('hl.offAlert'));
    setRep(x); reloadW();
  };
  const sc = r?.score;
  return (
    <section className="on">
      <div className="card"><div className="row"><div><div className="mute">{t('hl.score')}</div>
        <div className="score" style={{ color: sc == null ? undefined : sc >= 90 ? 'var(--ok)' : sc >= 70 ? 'var(--warn)' : 'var(--bad)' }}>{sc ?? '—'}</div>
        <div className="mute">{r ? t('hl.at', { t: dt(r.at) }) : ''}</div></div>
        <div style={{ marginLeft: 'auto' }} className="row">
          <button className="act pri" disabled={!on || busy} onClick={run}>{busy ? t('hl.running') : r ? t('hl.again') : t('hl.start')}</button>
          <button className="act" disabled={!on || scan} onClick={async () => { if (!confirm(t('hl.qsQ'))) return; setScan(true); try { await inv('quick-scan'); } catch (e) { alert(errMsg(e)); } setScan(false); }}>{scan ? t('hl.scanning') : t('hl.qs')}</button>
          <button className="act" onClick={() => go('av')}>{t('hl.goAv')}</button></div></div>
        <p className="mute">{t('hl.note')}</p>
        <p className="mute">{t('hl.lang')}</p></div>
      {cfg && !on && <div className="card"><Off msg={t('off.health')} go={go} /></div>}
      <div className="card">
        {!r ? <p className="mute">{t('hl.intro')}</p>
          : r.items.map((i) => (
            <div key={i.id} className={'sec ' + i.status}><span className="dot" /><div><b>{i.title} · {L()[i.status]}</b><p>{i.detail}</p>
              <details><summary>{t('hl.ev')}</summary><div><b style={{ display: 'inline' }}>{t('hl.evL')}</b>{i.evidence}</div><div><b style={{ display: 'inline' }}>{t('hl.adv')}</b>{i.advice}</div>
                {i.list && i.list.length ? <><div style={{ marginTop: 4 }}>{t('hl.list', { n: i.list.length })}</div>{i.list.map((l, k) => <div key={k}>{l}</div>)}</> : null}</details></div></div>))}
      </div>
      <div className="card"><h2>{t('hl.hist')}</h2><table><thead><tr><th>{t('ui.time')}</th><th>{t('hl.level')}</th><th>{t('hl.content')}</th></tr></thead>
        <tbody>{(warns || []).length ? warns!.map((x, i) => <tr key={i}><td>{dt(x.t)}</td><td>{x.level === 'bad' ? L().bad : x.level === 'warn' ? L().warn : t('hl.info')}</td><td>{x.title}{x.detail ? ' — ' + x.detail : ''}</td></tr>) : <tr><td colSpan={3} className="mute">{t('ui.empty')}</td></tr>}</tbody></table></div>
    </section>
  );
}

/* ---------------- 宠物 ---------------- */
const ANIM = (): Record<string, string> => ({ DOWNLOAD: t('anim.DOWNLOAD'), UPLOAD: t('anim.UPLOAD'), TIRED: t('anim.TIRED'), HOT: t('anim.HOT'), SWEAT: t('anim.SWEAT'), WARNING: t('anim.WARNING') });
function Pets({ cfg, reload }: { cfg: SettingsView | null; reload: () => void }) {
  const thumbs = useMemo(() => { if (!cfg) return []; if (cfg.safe) return PETS.map((p) => ({ ...p, url: '' })); try { return thumbnails(112); } catch { return PETS.map((p) => ({ ...p, url: '' })); } }, [!!cfg, cfg?.safe]);
  const [g] = useLoad<any>(() => inv('get-growth'), []);
  const [ach] = useLoad<any[]>(() => inv('get-achievements'), []);
  const pct = g ? Math.min(100, ((g.xp - g.cur) / (g.next - g.cur)) * 100) : 0;
  return (
    <section className="on">
      <div className="card"><h2>{t('pt.choose', { n: thumbs.length })}</h2>
        <div className="pets">{thumbs.map((x) => <button key={x.id} className={'pc' + (cfg?.pet === x.id ? ' on' : '')} aria-pressed={cfg?.pet === x.id} onClick={async () => { try { await inv('set-settings', { pet: x.id }); reload(); } catch (e) { alert(errMsg(e)); } }}>
          {x.url ? <img src={x.url} alt="" /> : <div className="em" aria-hidden="true">{x.emoji}</div>}<span>{t('pet.' + x.id)}</span></button>)}</div>
        <p className="mute" style={{ marginTop: 10 }}>{t('pt.tip')}</p></div>
      <Wardrobe cfg={cfg} reload={reload} />
      <div className="card"><h2>{t('pt.growth')}</h2>{!g && <Loading />}{g && <><div><b>Lv.{g.level}</b> <span className="mute">{t('pt.xp', { xp: g.xp, next: g.next })}</span></div><div className="bar"><i style={{ width: pct + '%' }} /></div>
        <div className="mute">{t('pt.gNote', { d: g.daysUsed, v: sz(g.total) })}</div></>}</div>
      <div className="card"><h2>{t('pt.anim')}</h2><p className="mute" style={{ marginBottom: 6 }}>{t('pt.animNote')}</p>
        {cfg && Object.entries(ANIM()).map(([k, tt]) => <div className="set" key={k}><span>{tt}</span><input type="checkbox" aria-label={tt} checked={!!cfg.anim[k]} onChange={async (e) => { try { await inv('set-settings', { anim: { [k]: e.target.checked } }); reload(); } catch (err) { alert(errMsg(err)); } }} /></div>)}</div>
      <div className="card"><h2>{t('pt.ach')}</h2>{(ach || []).map((x) => <div key={x.id || x.name} className={'ach' + (x.done ? '' : ' lock')}>{x.done ? '🏅' : '🔒'} <b>{x.name}</b> <span className="mute">{x.desc}</span></div>)}</div>
    </section>
  );
}

/* ---------------- 隐私 ---------------- */
const FEATS = () => [
  { k: 'net', t: t('priv.name.net'), what: t('f.net.what'), why: t('f.net.why'), where: t('f.net.where'), admin: t('f.no'), stop: t('f.stop'), del: t('f.delAll') },
  { k: 'hw', t: t('priv.name.hw'), what: t('f.hw.what'), why: t('f.hw.why'), where: t('f.hw.where'), admin: t('f.no'), stop: t('f.stop2'), del: t('f.delAll') },
  { k: 'conn', t: t('priv.name.conn'), what: t('f.conn.what'), why: t('f.conn.why'), where: t('f.conn.where'), admin: t('f.no'), stop: t('f.stop2'), del: t('f.conn.del') },
  { k: 'dns', t: t('priv.name.dns'), what: t('f.dns.what'), why: t('f.dns.why'), where: t('f.dns.where'), admin: t('f.no'), stop: t('f.stopDef'), del: t('f.dns.del') },
  { k: 'proc', t: t('priv.name.proc'), what: t('f.proc.what'), why: t('f.proc.why'), where: t('f.nosave'), admin: t('f.no'), stop: t('f.stop2'), del: t('f.nodel') },
  { k: 'health', t: t('priv.name.health'), what: t('f.health.what'), why: t('f.health.why'), where: t('f.health.where'), admin: t('f.health.admin'), stop: t('f.health.stop'), del: t('f.delAll') },
  { k: '__newProc', t: t('priv.name.newProc'), what: t('f.np.what'), why: t('f.np.why'), where: t('f.np.where'), admin: t('f.no'), stop: t('f.stop2'), del: t('f.np.del') },
  { k: 'probe', t: t('priv.name.probe'), what: t('f.probe.what'), why: t('f.probe.why'), where: t('f.probe.where'), admin: t('f.no'), stop: t('f.stopDef'), del: t('f.nodel') },
  { k: 'fullscreenHide', t: t('priv.name.fullscreenHide'), what: t('f.fs.what'), why: t('f.fs.why'), where: t('f.nosave'), admin: t('f.no'), stop: t('f.stop2'), del: t('f.nodel') }
];
function Privacy({ cfg, reload }: { cfg: SettingsView | null; reload: () => void }) {
  const [db] = useLoad<any>(() => inv('db-status'), []);
  const [pw, setPw] = useState('');
  if (!cfg) return <Loading />;
  const set = async (p: unknown) => { try { await inv('set-settings', p); } catch (e) { alert(errMsg(e, t('err.save'))); } reload(); };
  const onOff = (v: boolean) => (v ? t('pri.on') : t('pri.off'));
  const click = t('pri.click');
  return (
    <section className="on">
      {!cfg.onboarded && <div className="card"><b>{t('pri.first')}</b>
        <p className="mute" style={{ marginTop: 6 }}>{t('pri.firstNote')}</p></div>}
      <div className="card"><h2>{t('pri.sum')}</h2>
        <p className="mute">{t('pri.sumNote')}</p>
        <table style={{ marginTop: 6 }}><thead><tr><th>{t('pri.netFeat')}</th><th>{t('pri.now')}</th><th>{t('pri.where')}</th></tr></thead><tbody>
          <tr><td>{t('priv.name.dns')}</td><td>{onOff(cfg.privacy.dns && cfg.privacy.conn)}</td><td className="mute">{t('pri.dnsW')}</td></tr>
          <tr><td>{t('priv.name.probe')}</td><td>{onOff(cfg.privacy.probe && cfg.privacy.net)}</td><td className="mute">{t('pri.probeW')}</td></tr>
          <tr><td>{t('pri.upd')}</td><td>{click}</td><td className="mute">{t('pri.wu')}</td></tr>
          <tr><td>{t('pri.drv')}</td><td>{click}</td><td className="mute">{t('pri.wu')}</td></tr>
          <tr><td>{t('pri.sig')}</td><td>{click}</td><td className="mute">{t('pri.sigW')}</td></tr>
          <tr><td>{t('pri.self')}</td><td>{click}</td><td className="mute">{t('pri.selfW')}</td></tr>
          <tr><td>{t('pri.vpn')}</td><td>{t('pri.vpnN')}</td><td className="mute">{t('pri.vpnW')}</td></tr>
        </tbody></table>
        <table style={{ marginTop: 10 }}><thead><tr><th>{t('pri.modFeat')}</th><th>{t('pri.now')}</th><th>{t('pri.what')}</th></tr></thead><tbody>
          <tr><td>{t('tray.autostart')}</td><td>{onOff(cfg.autostart)}</td><td className="mute">{t('pri.asW')}</td></tr>
          <tr><td>{t('tab.clean')}</td><td>{click}</td><td className="mute">{t('pri.cleanW')}</td></tr>
          <tr><td>{t('tab.boot')}</td><td>{click}</td><td className="mute">{t('pri.bootW')}</td></tr>
          <tr><td>{t('tab.pm')}</td><td>{click}</td><td className="mute">{t('pri.pmW')}</td></tr>
          <tr><td>{t('tab.disk')}</td><td>{cfg.diskAuto?.on ? t('pri.autoOn') : click}</td><td className="mute">{t('pri.diskW')}</td></tr>
          <tr><td>{t('tab.power')}</td><td>{cfg.power?.guard || cfg.power?.saver ? t('pri.autoOn') : click}</td><td className="mute">{t('pri.powW')}</td></tr>
          <tr><td>{t('tab.av')}</td><td>{cfg.defSched?.on ? t('pri.autoOn') : click}</td><td className="mute">{t('pri.avW')}</td></tr>
          <tr><td>{t('tab.mem')}</td><td>{cfg.memTrim?.auto || cfg.memTrim?.sched ? t('pri.autoOn') : click}</td><td className="mute">{t('pri.memW')}</td></tr>
          <tr><td>VPN</td><td>{t('pri.vpnN')}</td><td className="mute">{t('pri.vpnP')}</td></tr>
        </tbody></table>
        <p className="mute" style={{ marginTop: 8 }}>{t('pri.doc')}</p></div>
      {FEATS().map((f) => (
        <div className="card feat" key={f.k}><div className="top"><b id={'feat-' + f.k}>{f.t}</b><input type="checkbox" aria-labelledby={'feat-' + f.k} checked={f.k === '__newProc' ? !!cfg.newProc?.on : !!cfg.privacy[f.k]} onChange={(e) => set(f.k === '__newProc' ? { newProc: { on: e.target.checked } } : { privacy: { [f.k]: e.target.checked } })} /></div>
          {f.k === '__newProc' && cfg.newProc?.on ? <div className="mute" style={{ marginTop: 4 }}>{Date.now() < cfg.newProc.learnUntil ? t('pri.learning', { t: dt(cfg.newProc.learnUntil) }) : t('pri.alerting')}{t('pri.count', { n: cfg.newProc.count })}{!cfg.privacy.conn ? ' ⚠ ' + t('pri.needConn') : ''}</div> : null}
          <dl><dt>{t('pri.dt.what')}</dt><dd>{f.what}</dd><dt>{t('pri.dt.why')}</dt><dd>{f.why}</dd><dt>{t('pri.dt.where')}</dt><dd>{f.where}</dd><dt>{t('pri.dt.admin')}</dt><dd>{f.admin}</dd><dt>{t('pri.dt.stop')}</dt><dd>{f.stop}</dd><dt>{t('pri.dt.del')}</dt><dd>{f.del}</dd></dl></div>))}
      <div className="card feat"><div className="top"><b id="feat-autostart">{t('tray.autostart')}</b><input type="checkbox" aria-labelledby="feat-autostart" checked={cfg.autostart} onChange={(e) => set({ autostart: e.target.checked })} /></div>
        <dl><dt>{t('pri.dt.do')}</dt><dd>{t('pri.as')}{cfg.packaged ? '' : t('pri.dev')}</dd><dt>{t('pri.dt.stop')}</dt><dd>{t('pri.asStop')}</dd></dl></div>
      <div className="card"><h2>{t('pri.data')}</h2><p className="mute">{t('pri.dataNote')}</p>
        <div className="set"><span>{t('pri.loc')}</span><span className="mute">{cfg.dataDir}</span></div>
        <div className="set"><span>{t('pri.dbst')}</span><span className="mute">{!db ? '' : db.ok ? t('pri.dbOk') + (db.recovered ? t('pri.dbRec') : '') : t('pri.dbBad', { e: db.error })}</span></div>
        <div className="set"><span>{t('pri.enc')}<br /><span className="mute">{t('pri.encNote')}</span></span>
          <span className="mute">{!db ? '' : db.encAvailable ? t('pri.encOn') : t('pri.encOff')}{db?.encFailed?.length ? t('pri.encFail', { n: db.encFailed.length }) : ''}</span></div>
        <div className="row" style={{ marginTop: 12 }}><button className="act" onClick={() => inv('open-data-dir').catch((e) => alert(errMsg(e)))}>{t('pri.openDir')}</button>
          <button className="act" onClick={async () => { try { const r = await inv('backup-db'); if (r.ok) alert(t('pri.bakOk', { p: r.path })); else if (r.msg) alert(t('pri.bakFail', { m: r.msg })); } catch (e) { alert(errMsg(e)); } }}>{t('pri.bak')}</button>
          <button className="act" onClick={async () => { try { const r = await inv<any>('export-diag'); if (r.ok) alert(t('pri.diagOk', { p: r.path })); else if (r.msg) alert(t('pri.diagFail', { m: r.msg })); } catch (e) { alert(errMsg(e)); } }}>{t('pri.diag')}</button>
          <button className="act danger" onClick={async () => { if (confirm(t('pri.clearQ'))) { try { await inv('clear-all'); alert(t('pri.cleared')); } catch (e) { alert(errMsg(e)); } } }}>{t('pri.clear')}</button></div></div>
      <div className="card"><h2>{t('pri.lock')}</h2><div className="set"><span>{t('pri.lockL')}<br /><span className="mute">{t('pri.lockNote')}</span></span>
        <span className="row" style={{ margin: 0 }}><input type="password" aria-label={t('pri.newPw')} placeholder={t('pri.newPw')} style={{ width: 120 }} value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="act" onClick={async () => { if (!pw) return alert(t('pri.pwEmpty')); if (pw.length < 4 && !confirm(t('pri.pwShort'))) return; try { await inv('set-password', pw); setPw(''); alert(t('pri.pwSet')); reload(); } catch (e) { alert(errMsg(e)); } }}>{t('pri.set')}</button>
          <button className="act" disabled={!cfg.hasLock} onClick={async () => { if (!confirm(t('pri.pwRmQ'))) return; try { await inv('set-password', ''); alert(t('pri.pwRm')); reload(); } catch (e) { alert(errMsg(e)); } }}>{t('pri.rm')}</button></span></div></div>
    </section>
  );
}

/* ---------------- 系统更新 ---------------- */
function Upd() {
  const [r, setR] = useState<any>(null); const [busy, setBusy] = useState('');
  useEffect(() => { inv('last-updates').then((x) => { if (x) setR(x); else run(false); }).catch(() => {}); }, []);
  const run = async (online: boolean) => { setBusy(online ? 'online' : 'local'); try { setR(await inv('check-updates', { online })); } catch (e) { setR({ ok: false, error: errMsg(e), items: [], at: Date.now() }); } setBusy(''); };
  const v = !r || !r.ok ? null : (r.items.some((i: any) => /critical|important/i.test(i.severity)) ? 'bad' : (r.items.length || r.pendingReboot || (r.lastPatch && r.lastPatch.days > 60)) ? 'warn' : 'ok');
  const head = !r ? '' : !r.ok ? t('hl.unknown') : v === 'bad' ? t('upd.bad') : r.items.length ? t('upd.n', { n: r.items.length }) : r.pendingReboot ? t('upd.reboot') : r.online ? t('upd.latest') : t('upd.local');
  return (
    <section className="on">
      <div className="card"><h2>{t('tab.upd')}</h2>
        <p className="mute">{t('upd.note')}</p>
        <div className="row"><button className="act pri" disabled={!!busy} onClick={() => run(true)}>{busy === 'online' ? t('upd.checking') : t('upd.check')}</button>
          <button className="act" disabled={!!busy} onClick={() => run(false)}>{busy === 'local' ? t('ui.loading') : t('upd.localBtn')}</button>
          <button className="act" onClick={() => inv('open-winupdate').catch((e) => alert(errMsg(e)))}>{t('upd.open')}</button></div></div>
      {r && <div className="card">
        <div className={'sec ' + (v || 'unknown')}><span className="dot" /><div><b>{head}</b>
          <p>{r.os ? t('upd.os', { os: r.os, b: r.build }) : ''}{r.lastPatch ? t('upd.lp', { kb: r.lastPatch.kb, d: r.lastPatch.date, n: r.lastPatch.days }) : ''}</p>
          {r.pendingReboot && <p>⚠ {t('upd.pend', { r: r.rebootReasons.join(', ') })}</p>}
          {r.error && <p className="mute">{r.error}</p>}
          <p className="mute">{t('hl.at', { t: dt(r.at) })}{r.online ? '' : t('upd.notOnline')}</p></div></div></div>}
      {r && r.items && r.items.length > 0 && <div className="card"><h2>{t('upd.avail')}</h2><table><thead><tr><th>{t('upd.cat')}</th><th>{t('upd.name')}</th><th>KB</th><th>{t('upd.size')}</th><th>{t('upd.rb')}</th></tr></thead>
        <tbody>{r.items.map((i: any, k: number) => <tr key={k}><td>{i.category}{i.severity ? <div className="tag">{i.severity}</div> : null}</td><td>{i.title}</td><td>{i.kb || '—'}</td><td>{i.sizeMB ? i.sizeMB + ' MB' : '—'}</td><td>{i.reboot ? t('ui.yes') : t('ui.no')}</td></tr>)}</tbody></table>
        <p className="mute" style={{ marginTop: 8 }}>{t('upd.install')}</p></div>}
    </section>
  );
}

/* ---------------- VPN（sing-box）---------------- */
const VS = (): Record<string, string> => ({ stopped: t('vpn.stopped'), checking: t('vpn.checking'), starting: t('vpn.starting'), running: t('vpn.running'), error: t('vpn.error') });
function Vpn() {
  const [s, setS] = useState<any>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  const load = () => inv('vpn-status').then(setS).catch(() => {});
  useEffect(() => {
    load(); const off = window.netpet.on('vpn', () => load()); const tm = setInterval(load, 3000);
    return () => { clearInterval(tm); if (typeof off === 'function') off(); };
  }, []);
  if (!s) return <Loading />;
  const on = s.state === 'running', mid = s.state === 'checking' || s.state === 'starting';
  const pick = async (kind: string) => { try { const r = await inv<any>('vpn-pick', { kind }); if (r.error) alert(r.error); } catch (e) { alert(errMsg(e)); } load(); };
  const go = async () => {
    setBusy(true); setMsg('');
    try { if (on) await inv('vpn-stop'); else { const r = await inv<any>('vpn-start'); if (!r.ok) setMsg('✗ ' + (r.error || t('vpn.startFail'))); } } catch (e) { setMsg('✗ ' + errMsg(e)); }
    setBusy(false); load();
  };
  const up = on ? Math.floor((Date.now() - s.startedAt) / 60000) : 0;
  return (
    <section className="on">
      <div className="card"><h2>{t('tray.vpn')}</h2>
        <p className="mute">{t('vpn.note')}</p>
        {s.safe && <div className="off" style={{ margin: '8px 0' }}>{t('vpn.err.safe')}</div>}
        <div className="row" style={{ alignItems: 'center' }}>
          <div><div className="mute">{t('net.state')}</div><div className="score" style={{ fontSize: 26, color: on ? 'var(--ok)' : s.state === 'error' ? 'var(--bad)' : undefined }}>{VS()[s.state] || s.state}</div>
            <div className="mute">{on ? t('vpn.upFor', { m: up }) + (s.sysProxyOn ? t('vpn.sysProxy', { p: s.proxyPort }) : s.proxyPort ? t('vpn.port', { p: s.proxyPort }) : '') + (s.tun ? t('vpn.tun') : '') : s.error || ''}</div></div>
          <button className={'act ' + (on ? 'danger' : 'pri')} style={{ marginLeft: 'auto' }} disabled={busy || mid || s.safe || (!on && (!s.exe || !s.config))} onClick={go}>{busy || mid ? t('ui.working') : on ? t('vpn.disc') : t('vpn.conn')}</button></div>
        {msg && <div style={{ marginTop: 8 }}>{msg}</div>}</div>
      <div className="card"><h2>{t('vpn.cfg')}</h2>
        <div className="set"><span>{t('vpn.exe')}<br /><span className="mute" style={{ wordBreak: 'break-all' }}>{s.exe || t('vpn.none')}</span></span><button className="act" disabled={on || mid} onClick={() => pick('exe')}>{t('ui.choose')}</button></div>
        <div className="set"><span>{t('vpn.file')}<br /><span className="mute" style={{ wordBreak: 'break-all' }}>{s.config || t('vpn.none')}</span></span><button className="act" disabled={on || mid} onClick={() => pick('config')}>{t('ui.choose')}</button></div>
        <div className="set"><span>{t('vpn.setProxy')}<br /><span className="mute">{t('vpn.setProxyNote')}</span></span>
          <input type="checkbox" checked={!!s.sysProxy} disabled={on || mid} aria-label={t('vpn.setProxy')} onChange={async (e) => { try { await inv('vpn-set', { sysProxy: e.target.checked }); } catch (err) { alert(errMsg(err)); } load(); }} /></div>
        <p className="mute" style={{ marginTop: 8 }}>{t('vpn.tunNote')}</p></div>
      <div className="card"><h2>{t('vpn.log')}</h2>
        <pre style={{ maxHeight: 260, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>{(s.log || []).join('\n') || t('ui.emptyP')}</pre></div>
    </section>
  );
}

/* ---------------- 启动管理 ---------------- */
function Boot() {
  const [data, setData] = useState<{ ok: boolean; items: StartupItem[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false); const [doing, setDoing] = useState(''); const [msg, setMsg] = useState('');
  const [onlyFlag, setOnlyFlag] = useState(false);
  const load = async () => { setBusy(true); try { setData(await inv('list-startup')); } catch (e) { setData({ ok: false, items: [], error: errMsg(e) }); } setBusy(false); };
  useEffect(() => { load(); }, []);
  const toggle = async (x: StartupItem) => {
    if (x.enabled && !confirm(t('boot.disQ', { n: x.name }))) return;
    setDoing(x.id); setMsg('');
    try {
      const r = await inv<any>('set-startup', { id: x.id, enabled: !x.enabled });
      if (!r.ok) setMsg('✗ ' + (r.error || '?')); else setMsg('✓ ' + (x.enabled ? t('boot.disOk', { n: x.name }) : t('boot.enOk', { n: x.name })));
    } catch (e) { setMsg('✗ ' + errMsg(e)); }
    setDoing(''); load();
  };
  const items = (data?.items || []).filter((x) => !onlyFlag || x.flagged);
  const en = (data?.items || []).filter((x) => x.enabled).length;
  return (
    <section className="on">
      <div className="card"><h2>{t('tab.boot')}</h2>
        <p className="mute">{t('boot.note')}</p>
        <div className="row"><button className="act pri" disabled={busy} onClick={load}>{busy ? t('ui.loading') : t('ui.refresh')}</button>
          <button className="act" onClick={() => inv('open-taskmgr-startup').catch((e) => alert(errMsg(e)))}>{t('boot.tm')}</button>
          <label className="mute"><input type="checkbox" checked={onlyFlag} onChange={(e) => setOnlyFlag(e.target.checked)} /> {t('boot.only')}</label>
          <span className="mute">{data?.ok ? t('boot.count', { n: data.items.length, e: en }) : data?.error || ''}</span></div>
        {msg && <div style={{ marginTop: 8 }}>{msg}</div>}</div>
      <div className="card"><table><thead><tr><th>{t('upd.name')}</th><th>{t('boot.src')}</th><th>{t('boot.cmd')}</th><th>{t('net.state')}</th><th></th></tr></thead>
        <tbody>{items.map((x) => <tr key={x.id} style={x.enabled ? undefined : { opacity: 0.6 }}>
          <td>{x.flagged ? '⚠ ' : ''}{x.name}</td>
          <td className="mute">{x.srcName}</td>
          <td className="mute" style={{ wordBreak: 'break-all', maxWidth: 380 }}>{x.command}{x.flagged ? <div className="tag">{t('boot.flag')}</div> : null}</td>
          <td>{x.enabled ? t('boot.en') : t('boot.dis')}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            {x.canToggle ? <button className={'act' + (x.enabled ? ' danger' : '')} disabled={!!doing} onClick={() => toggle(x)}>{doing === x.id ? t('ui.working') : x.enabled ? t('boot.disBtn') : t('boot.enBtn')}</button>
              : <span className="mute">{t('boot.admin')}</span>}
            {' '}<button className="act" aria-label={t('boot.locA', { n: x.name })} onClick={async () => { try { if (!(await inv('show-startup-file', { id: x.id }))) alert(t('boot.noFile')); } catch (e) { alert(errMsg(e)); } }}>{t('boot.loc')}</button></td></tr>)}
          {!items.length && <tr><td colSpan={5} className="mute">{busy ? t('ui.loading') : onlyFlag ? t('boot.noFlag') : data?.error || t('boot.none')}</td></tr>}</tbody></table></div>
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
    catch (e) { setMsg(errMsg(e)); }
    setBusy(false);
  };
  useEffect(() => { doScan(); }, []);
  const total = (scan || []).filter((x) => sel.includes(x.id)).reduce((a, x) => a + x.size, 0);
  const clean = async () => {
    if (!sel.length) return alert(t('cl.pick'));
    const names = (scan || []).filter((x) => sel.includes(x.id)).map((x) => x.name).join(', ');
    if (!confirm(t('cl.q', { names, v: sz(total), rb: sel.includes('recycle-bin') ? t('cl.rb') : '' }))) return;
    setCleaning(true); setRes(null);
    try { const r = await inv<JunkClean[]>('clean-junk', { ids: sel }); setRes(r); await doScan(); }
    catch (e) { setMsg(errMsg(e)); }
    setCleaning(false);
  };
  return (
    <section className="on">
      <div className="card"><h2>{t('cl.title')}</h2>
        <p className="mute">{t('cl.note')}</p>
        <p className="mute">{t('cl.lang')}</p>
        <div className="row"><button className="act pri" disabled={busy || cleaning} onClick={doScan}>{busy ? t('hl.scanning') : t('cl.rescan')}</button>
          <button className="act danger" disabled={!sel.length || cleaning} onClick={clean}>{cleaning ? t('cl.cleaning') : t('cl.go', { v: sz(total) })}</button>
          <span className="mute">{msg}</span></div></div>
      {res && <div className="card"><h2>{t('cl.res')}</h2>
        {res.map((r) => { const nm = (scan || []).find((x) => x.id === r.id)?.name || r.id; return <div key={r.id}>{r.ok ? '✓ ' + t('cl.ok', { n: nm, v: sz(r.freed), d: r.deletedFiles, s: r.skippedFiles }) : `✗ ${nm}：${r.error || '?'}`}</div>; })}
        <div className="mute" style={{ marginTop: 6 }}>{t('cl.sum', { v: sz(res.reduce((a, r) => a + r.freed, 0)) })}</div></div>}
      <div className="card"><table><thead><tr><th></th><th>{t('upd.cat')}</th><th>{t('upd.size')}</th><th>{t('cl.files')}</th><th>{t('cl.desc')}</th></tr></thead>
        <tbody>{(scan || []).map((x) => <tr key={x.id}>
          <td><input type="checkbox" aria-label={t('cl.aria', { n: x.name })} checked={sel.includes(x.id)} onChange={(e) => setSel((o) => e.target.checked ? [...o, x.id] : o.filter((y) => y !== x.id))} /></td>
          <td>{x.name}</td><td>{sz(x.size)}</td><td>{x.files}</td>
          <td className="mute">{x.desc}{x.skipped.length ? <><br />{x.skipped.join('; ')}</> : null}</td></tr>)}
        {(!scan || !scan.length) && <tr><td colSpan={5} className="mute">{busy ? t('hl.scanning') : t('ui.empty')}</td></tr>}</tbody></table></div>
    </section>
  );
}

function SelfUpdate() {
  const [r, setR] = useState<any>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { inv('last-self-update').then(setR).catch(() => {}); }, []);
  const go = async () => { setBusy(true); try { setR(await inv('check-self-update')); } catch (e) { setR({ ok: false, error: errMsg(e), at: Date.now() }); } setBusy(false); };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row"><button className="act" disabled={busy} onClick={go}>{busy ? t('su.checking') : t('su.check')}</button>
        {r && r.ok && r.newer && <button className="act pri" onClick={() => inv('open-release').catch(() => {})}>{t('su.open', { v: r.latest })}</button>}
        <span className="mute">{!r ? '' : !r.ok ? r.error : r.newer ? t('su.newer', { v: r.latest }) + (r.published ? t('su.pub', { d: r.published }) : '') : t('su.latest', { v: r.current })}{r ? t('su.at', { t: dt(r.at) }) : ''}</span></div>
      {r && r.ok && r.newer && r.notes ? <details style={{ marginTop: 6 }}><summary>{t('su.notes')}</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{r.notes}</pre></details> : null}
      <p className="mute" style={{ marginTop: 6 }}>{t('su.note')}</p>
    </div>
  );
}

/* ---------------- 设置 ---------------- */
function Settings({ cfg, rt, reload }: { cfg: SettingsView | null; rt: Runtime; reload: () => void }) {
  const [st, reloadSt] = useLoad<PetStatus>(() => inv('get-pet-status'), []);
  const [ioMsg, setIoMsg] = useState('');
  if (!cfg) return <Loading />;
  const set = async (p: unknown) => { try { await inv('set-settings', p); } catch (e) { alert(errMsg(e, t('err.save'))); } reload(); };
  const exportS = async () => {
    setIoMsg('');
    try { const r = await inv<any>('export-settings'); if (r.ok) setIoMsg('✓ ' + t('ui.savedTo', { p: r.path })); else if (r.msg) setIoMsg('✗ ' + t('pri.diagFail', { m: r.msg })); }
    catch (e) { setIoMsg('✗ ' + errMsg(e)); }
  };
  const importS = async () => {
    setIoMsg('');
    try {
      const r = await inv<any>('import-settings');
      if (r.ok) { setIoMsg('✓ ' + t('set.imported', { n: r.keys.length }) + (r.safe ? t('set.impSafe') : '') + t('wel.dot')); reload(); reloadSt(); }
      else if (r.cancelled) setIoMsg(t('set.impCancel'));
      else if (r.msg) setIoMsg('✗ ' + r.msg);
    } catch (e) { setIoMsg('✗ ' + errMsg(e)); }
  };
  const every = (v: number) => (v ? t('set.every', { v }) : t('hk.off'));
  const hkLabel = (h: { id: string; label: string }) => (h.id ? h.label.replace('（默认）', t('hk.def')) : t('hk.off'));
  return (
    <section className="on">
      <div className="card"><h2>{t('set.lang')}</h2>
        <div className="set"><label htmlFor="set-lang">{t('set.langL')}<br /><span className="mute">{t('set.langNote')}</span></label>
          <select id="set-lang" value={cfg.language || 'auto'} onChange={(e) => set({ language: e.target.value })}><option value="auto">{t('lang.auto')}</option><option value="zh">中文</option><option value="en">English</option></select></div></div>
      <div className="card"><h2>{t('set.resetT')}</h2>
        <p className="mute">{t('set.resetN')}{st ? (st.visible ? t('set.st.vis') : st.userHidden ? t('set.st.hidden') : st.fsHidden ? t('set.st.fs') : t('set.st.gone')) : ''}</p>
        <div className="row"><button className="act pri" onClick={async () => { try { await inv('reset-pet'); } catch (e) { alert(errMsg(e)); } reloadSt(); }}>{t('tray.reset')}</button>
          <span className="mute">{t('set.resetAlt')}</span></div></div>
      <div className="card">
        <div className="set"><span id="set-compact">{t('set.compact')}<br /><span className="mute">{t('set.compactN')}</span></span><input type="checkbox" aria-labelledby="set-compact" checked={cfg.compact} onChange={(e) => set({ compact: e.target.checked })} /></div>
        <div className="set"><span id="set-top">{t('set.top')}</span><input type="checkbox" aria-labelledby="set-top" checked={cfg.alwaysOnTop} onChange={(e) => set({ alwaysOnTop: e.target.checked })} /></div>
        <div className="set"><label htmlFor="set-hk">{t('set.hk')}<br /><span className="mute">{t('set.hkN')}</span></label>
          <span className="row" style={{ margin: 0 }}>{cfg.hotkey && cfg.hotkeyOk === false ? <span className="tag" role="alert">⚠ {t('set.hkBusy')}</span> : null}
            <select id="set-hk" value={cfg.hotkey ?? ''} onChange={(e) => set({ hotkey: e.target.value })}>{HOTKEYS.map((h) => <option key={h.id || 'off'} value={h.id} disabled={!!h.id && h.id === cfg.procHotkey}>{hkLabel(h)}</option>)}</select></span></div>
        <div className="set"><label htmlFor="set-pmhk">{t('set.pmhk')}<br /><span className="mute">{t('set.pmhkN')}</span></label>
          <span className="row" style={{ margin: 0 }}>{cfg.procHotkey && cfg.procHotkeyOk === false ? <span className="tag" role="alert">⚠ {t('set.hkBusy')}</span> : null}
            <select id="set-pmhk" value={cfg.procHotkey ?? ''} onChange={(e) => set({ procHotkey: e.target.value })}>{PROC_HOTKEYS.map((h) => <option key={h.id || 'off'} value={h.id}>{hkLabel(h)}</option>)}</select></span></div>
        <div className="set"><span>{t('set.quota')}<br /><span className="mute">{t('set.quotaN')}</span></span>
          <input type="number" key={'q' + (cfg.quota?.gb || 0)} aria-label={t('set.quota')} min={0} max={100000} style={{ width: 90 }} defaultValue={cfg.quota?.gb || 0} onBlur={(e) => set({ quota: { gb: Number(e.target.value) || 0 } })} /></div>
        <div className="set"><span>{t('set.sit')}<br /><span className="mute">{t('set.sitN')}</span></span>
          <select aria-label={t('set.sit')} value={cfg.remind?.sit ?? 0} onChange={(e) => set({ remind: { sit: Number(e.target.value) } })}>{[0, 30, 45, 60, 90, 120].map((v) => <option key={v} value={v}>{every(v)}</option>)}</select></div>
        <div className="set"><span>{t('set.water')}</span>
          <select aria-label={t('set.water')} value={cfg.remind?.water ?? 0} onChange={(e) => set({ remind: { water: Number(e.target.value) } })}>{[0, 30, 45, 60, 90, 120].map((v) => <option key={v} value={v}>{every(v)}</option>)}</select></div>
        <div className="set"><span>{t('set.memAlert')}</span><select aria-label={t('set.memAlert')} value={cfg.memAlert} onChange={(e) => set({ memAlert: Number(e.target.value) })}>{[80, 85, 90, 95].map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="set"><span>{t('set.ret')}<br /><span className="mute">{t('set.retN')}</span></span><select aria-label={t('set.ret')} value={cfg.retentionDays} onChange={(e) => set({ retentionDays: Number(e.target.value) })}>{[7, 30, 90].map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="set"><span>{t('set.pass')}<br /><span className="mute">{t('set.passN')}</span></span><input type="checkbox" aria-label={t('set.pass')} checked={!!rt.passthrough} onChange={(e) => inv('set-runtime', { passthrough: e.target.checked }).catch((err) => alert(errMsg(err)))} /></div>
        <p className="mute" style={{ marginTop: 8 }}>{t('set.memMoved')}</p>
      </div>
      <SpeedAlertCard cfg={cfg} reload={reload} />
      <div className="card"><h2>{t('set.io')}</h2>
        <p className="mute">{t('set.ioN')}</p>
        <div className="row" style={{ marginTop: 8, marginBottom: 0 }}><button className="act" onClick={exportS}>{t('set.export')}</button><button className="act" onClick={importS}>{t('set.import')}</button>
          <span className="mute" role="status" aria-live="polite">{ioMsg}</span></div></div>
      <div className="card"><h2>{t('set.about')}</h2><p className="mute">{t('set.aboutN', { v: cfg.version, d: cfg.dataDir })}</p><SelfUpdate /></div>
    </section>
  );
}
