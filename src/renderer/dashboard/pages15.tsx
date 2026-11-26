// 1.5.0 新增页面：番茄钟、每周小结、硬件历史曲线、驱动更新、病毒查杀、任务管理器、运行内存、磁盘整理、温度与节能、宠物换装、网速异常提醒。
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBox, LineChart, Loading, Off, Spark, Toggle, dt, errMsg, fmt, inv, sz, useLoad } from './common';
import { t, has } from '../../shared/i18n';
import { mmss, FOCUS_MIN_CHOICES, BREAK_MIN_CHOICES } from '../../main/focus';
import { LOW_KB_CHOICES, LOW_SEC_CHOICES, HIGH_MB_CHOICES, HIGH_SEC_CHOICES, COOLDOWN_CHOICES } from '../../main/speedalert';
import { PALETTES, ACCESSORIES, isUnlocked } from '../../shared/wardrobe';
import { filterSort, groupProcs } from '../../shared/procview';
import { preview } from '../pets3d';
import type { FocusState, SettingsView } from '../../shared/types';

type Go = (t: string) => void;
type CfgProps = { cfg: SettingsView | null; reload: () => void };
const setS = async (p: unknown, reload?: () => void) => { try { await inv('set-settings', p); } catch (e) { alert(errMsg(e, t('err.save'))); } if (reload) reload(); };
/** 页面可见时才定时执行（窗口最小化 / 切到别的程序时暂停）。 */
function useEvery(fn: () => void, ms: number, deps: unknown[] = []) {
  useEffect(() => { fn(); const tm = setInterval(() => { if (!document.hidden) fn(); }, ms); return () => clearInterval(tm); }, deps);
}
const ago = (iso: string) => (iso ? dt(iso) : '—');

/* ================= 番茄钟 ================= */
function useFocus(): [FocusState | null, number, (a: string) => void] {
  const [f, setF] = useState<FocusState | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    inv<FocusState>('focus-get').then(setF).catch(() => {});
    const off = window.netpet.on('focus', setF);
    const tm = setInterval(() => { if (!document.hidden) setTick((x) => x + 1); }, 1000);
    return () => { clearInterval(tm); if (typeof off === 'function') off(); };
  }, []);
  const remain = f ? (f.running && f.endsAt ? Math.max(0, f.endsAt - Date.now()) : f.remainMs) : 0;
  const ctl = (a: string) => { inv<FocusState>('focus-ctl', { action: a }).then((x) => x && setF(x)).catch((e) => alert(errMsg(e))); };
  return [f, remain, ctl];
}
const phaseName = (p: string) => (p === 'focus' ? t('focus.phase.focus') : p === 'break' ? t('focus.phase.break') : t('focus.phase.idle'));
function FocusButtons({ f, ctl }: { f: FocusState | null; ctl: (a: string) => void }) {
  return (<>
    {f && f.running ? <button className="act" onClick={() => ctl('pause')}>{t('focus.pause')}</button>
      : <button className="act pri" onClick={() => ctl('start')}>{f && f.phase !== 'idle' ? t('focus.resume') : t('focus.start')}</button>}
    <button className="act" disabled={!f || f.phase === 'idle'} onClick={() => ctl('skip')}>{t('focus.skip')}</button>
    <button className="act" disabled={!f || f.phase === 'idle'} onClick={() => ctl('reset')}>{t('focus.reset')}</button>
  </>);
}
export function FocusMini() {
  const [f, remain, ctl] = useFocus();
  return (
    <div className="card"><div className="row" style={{ justifyContent: 'space-between', marginBottom: 0 }}>
      <span><b>🍅 {t('tab.focus')}</b> <span className="mute">{f ? `${phaseName(f.phase)} · ${mmss(remain)}${f.phase !== 'idle' && !f.running ? t('tray.focus.paused') : ''} · ` + t('focus.todayN', { n: f.today.n }) : ''}</span></span>
      <span className="row" style={{ margin: 0 }}><FocusButtons f={f} ctl={ctl} /></span></div></div>
  );
}
export function FocusPage({ cfg, reload }: CfgProps) {
  const [f, remain, ctl] = useFocus();
  const [hist] = useLoad<any>(() => inv('focus-history'), [f && f.today.n]);
  const total = f ? f.totalMs : 1, pct = f && f.phase !== 'idle' ? Math.min(100, ((total - remain) / Math.max(1, total)) * 100) : 0;
  const days = useMemo(() => {
    const m = new Map<string, number>(); for (const d of (hist && hist.min) || []) m.set(d.day, d.n);
    const n = new Map<string, number>(); for (const d of (hist && hist.n) || []) n.set(d.day, d.n);
    const out: { day: string; min: number; n: number }[] = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; out.push({ day: k, min: m.get(k) || 0, n: n.get(k) || 0 }); }
    return out;
  }, [hist]);
  const maxMin = Math.max(25, ...days.map((d) => d.min));
  return (
    <section className="on">
      <div className="card"><h2>🍅 {t('tab.focus')}</h2>
        <div className="row" style={{ alignItems: 'center', gap: 24 }}>
          <div><div className="mute">{f ? phaseName(f.phase) : ''}</div><div className="score" aria-live="off">{mmss(remain)}</div><div className="bar" style={{ width: 240 }}><i style={{ width: pct + '%' }} /></div></div>
          <div className="row" style={{ margin: 0 }}><FocusButtons f={f} ctl={ctl} /></div></div>
        <p className="mute">{t('focus.note', { f: cfg?.focus?.focusMin ?? 25, b: cfg?.focus?.breakMin ?? 5 })}</p></div>
      <div className="card"><h2>{t('focus.cfg')}</h2>
        <div className="set"><span>{t('focus.len')}</span><select aria-label={t('focus.len')} value={cfg?.focus?.focusMin ?? 25} onChange={(e) => setS({ focus: { focusMin: Number(e.target.value) } }, reload)}>{FOCUS_MIN_CHOICES.map((v) => <option key={v} value={v}>{t('focus.min', { v })}</option>)}</select></div>
        <div className="set"><span>{t('focus.brk')}</span><select aria-label={t('focus.brk')} value={cfg?.focus?.breakMin ?? 5} onChange={(e) => setS({ focus: { breakMin: Number(e.target.value) } }, reload)}>{BREAK_MIN_CHOICES.map((v) => <option key={v} value={v}>{t('focus.min', { v })}</option>)}</select></div>
        <p className="mute" style={{ marginTop: 6 }}>{t('focus.cfgNote')}</p></div>
      <div className="card"><h2>{t('focus.hist')}</h2>
        {!hist ? <Loading /> : <>
          <svg viewBox="0 0 700 140" className="lchart" style={{ height: 140 }} role="img" aria-label={t('focus.histAria')}>
            {days.map((d, i) => { const h = (d.min / maxMin) * 100; return <g key={d.day}><rect x={i * 50 + 12} y={110 - h} width={26} height={h} rx={4} fill="#FF8A65" /><text x={i * 50 + 25} y={128} textAnchor="middle" className="ax">{d.day.slice(5)}</text>{d.n ? <text x={i * 50 + 25} y={105 - h} textAnchor="middle" className="ax">{d.n}</text> : null}</g>; })}
          </svg>
          <div className="mute">{t('focus.sum', { n: hist.total || 0, t: f ? f.today.n : 0, m: f ? f.today.min : 0 })}</div></>}</div>
    </section>
  );
}

/* ================= 每周小结 ================= */
export function WeekPage({ cfg, reload }: CfgProps) {
  const [d, reloadD, err] = useLoad<any>(() => inv('weekly-list'), []);
  const [busy, setBusy] = useState(false);
  const list: any[] = (d && d.list) || [];
  const cur = list[0];
  const regen = async () => { setBusy(true); try { await inv('weekly-regen'); reloadD(); } catch (e) { alert(errMsg(e)); } setBusy(false); };
  const Sum = ({ s }: { s: any }) => (
    <div className="grid g4" style={{ marginTop: 8 }}>
      <div><div className="mute">{t('wk.traffic')}</div><b>{sz(s.traffic.total)}</b> <span className="mute">/ {sz(s.traffic.avg)}</span><div className="mute">↓ {sz(s.traffic.rx)} ↑ {sz(s.traffic.tx)}{s.traffic.peak ? ' · ' + t('wk.peak', { d: s.traffic.peak.day.slice(5) }) : ''}</div></div>
      <div><div className="mute">{t('wk.health')}</div><b>{s.health.runs ? t('wk.runs', { n: s.health.runs }) : '—'}</b><div className="mute">{s.health.runs ? t('wk.score', { l: s.health.last, m: s.health.min }) : t('wk.noHealth')}</div></div>
      <div><div className="mute">{t('wk.remind')}</div><b>{t('wk.remN', { n: s.reminders })}</b><div className="mute">{t('wk.focusN', { n: s.focus.sessions, m: s.focus.minutes })}</div></div>
      <div><div className="mute">{t('wk.cpu')}</div><b>{s.cpuPeak == null ? '—' : s.cpuPeak + '%'}</b></div>
    </div>
  );
  return (
    <section className="on">
      <div className="card"><h2>{t('tab.week')}</h2>
        <p className="mute">{t('wk.note')}</p>
        <Toggle id="wk-on" label={t('wk.on')} checked={!!cfg?.weekly?.on} onChange={(v) => setS({ weekly: { on: v } }, reload)} />
        <div className="row" style={{ marginTop: 10, marginBottom: 0 }}><button className="act" disabled={busy} onClick={regen}>{busy ? t('ui.working') : t('wk.regen')}</button>
          <span className="mute">{t('wk.ret')}</span></div></div>
      {err ? <ErrorBox msg={err} retry={reloadD} /> : !d ? <Loading /> : !cur ? <div className="card"><p className="mute">{t('wk.none')}</p></div> : <>
        <div className="card hi"><h2>{t('wk.title', { from: cur.from, to: cur.to })}</h2>{cur.empty ? <p className="mute">{t('wk.empty')}</p> : <Sum s={cur} />}
          <p className="mute" style={{ marginTop: 8 }}>{t('wk.gen', { t: dt(cur.generatedAt) })}</p></div>
        {list.length > 1 && <div className="card"><h2>{t('wk.hist')}</h2><table><thead><tr><th>{t('wk.week')}</th><th>{t('wk.traffic')}</th><th>{t('wk.health')}</th><th>{t('wk.remind')}</th><th>{t('wk.cpu')}</th></tr></thead>
          <tbody>{list.slice(1).map((s) => <tr key={s.week}><td>{s.from} ~ {s.to.slice(5)}</td><td>{sz(s.traffic.total)} / {sz(s.traffic.avg)}</td><td>{s.health.runs ? `${s.health.runs} · ${s.health.last}` : '—'}</td><td>{s.reminders} / 🍅{s.focus.sessions}</td><td>{s.cpuPeak == null ? '—' : s.cpuPeak + '%'}</td></tr>)}</tbody></table></div>}</>}
    </section>
  );
}

/* ================= 硬件历史曲线（概览页） ================= */
export function HwHistoryCard({ go }: { go: Go }) {
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const [d, reload, err] = useLoad<any>(() => inv('get-hw-history', { range }), [range], 60000);
  const pts: any[] = (d && d.points) || [];
  const t1 = Date.now(), t0 = d ? d.since : t1 - 864e5;
  const hasTemp = pts.some((p) => p.temp != null);
  const ticks = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    if (range === '24h') { for (let i = 0; i <= 6; i++) { const tm = t0 + (i * (t1 - t0)) / 6; const x = new Date(tm); out.push({ t: tm, label: `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}` }); } }
    else { for (let i = 0; i <= 7; i++) { const tm = t0 + i * 864e5; const x = new Date(tm); out.push({ t: tm, label: `${x.getMonth() + 1}/${x.getDate()}` }); } }
    return out;
  }, [d, range]);
  const series = [
    { name: 'cpu', color: '#8E76E8', pts: pts.map((p) => ({ t: p.t, v: p.cpu })) },
    { name: 'mem', color: '#3FBF9B', pts: pts.map((p) => ({ t: p.t, v: p.mem })) },
    ...(hasTemp ? [{ name: 'temp', color: '#E5566D', pts: pts.map((p) => ({ t: p.t, v: p.temp })) }] : [])
  ];
  const cpuPeak = pts.reduce((m, p) => (p.cpuMax != null && p.cpuMax > m ? p.cpuMax : m), 0);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{t('hw.title')}</h2>
        <span className="row" style={{ margin: 0 }} role="group" aria-label={t('rep.range')}>
          <button className={'act' + (range === '24h' ? ' pri' : '')} aria-pressed={range === '24h'} onClick={() => setRange('24h')}>{t('hw.24h')}</button>
          <button className={'act' + (range === '7d' ? ' pri' : '')} aria-pressed={range === '7d'} onClick={() => setRange('7d')}>{t('hw.7d')}</button></span></div>
      {err ? <ErrorBox msg={err} retry={reload} /> : !d ? <Loading /> : d.disabled ? <Off msg={t('off.hw')} go={go} /> : !pts.length ? <p className="mute">{t('hw.empty')}</p> : <>
        <LineChart series={series} t0={t0} t1={t1} gap={d.bucket * 3} ticks={ticks} label={t('hw.aria', { temp: hasTemp ? t('hw.ariaT') : '' })} />
        <div className="mute" style={{ marginTop: 4 }}><span style={{ color: '#8E76E8' }}>■</span> CPU %　<span style={{ color: '#3FBF9B' }}>■</span> {t('ov.mem')} %　{hasTemp ? <><span style={{ color: '#E5566D' }}>■</span> {t('hw.temp')}　</> : t('hw.noTemp') + '　'}
          {range === '7d' ? t('hw.ds') : ''}{t('hw.peak', { p: Math.round(cpuPeak), d: d.retentionDays })}</div></>}
    </div>
  );
}

/* ================= 驱动更新 ================= */
const cmText = (c: number) => (has('drv.cm.' + c) ? t('drv.cm.' + c) : t('drv.cm.other', { c }));
export function Drivers() {
  const [loc, setLoc] = useState<any>(null); const [on, setOn] = useState<any>(null);
  const [busy, setBusy] = useState(''); const [q, setQ] = useState(''); const [flt, setFlt] = useState('all');
  const scan = async () => { setBusy('local'); try { setLoc(await inv('drv-scan')); } catch (e) { setLoc({ ok: false, error: errMsg(e), drivers: [], problems: [] }); } setBusy(''); };
  const online = async () => { setBusy('online'); try { setOn(await inv('drv-online')); } catch (e) { setOn({ ok: false, error: errMsg(e), items: [], at: Date.now() }); } setBusy(''); };
  useEffect(() => { scan(); inv('drv-last-online').then((x) => x && setOn(x)).catch(() => {}); }, []);
  const list = ((loc && loc.drivers) || []).filter((d: any) => (flt === 'all' || (flt === 'unsigned' && d.signed === false) || (flt === 'old' && d.old)) &&
    (!q || (d.name + ' ' + d.provider + ' ' + d.cls).toLowerCase().includes(q.toLowerCase())));
  return (
    <section className="on">
      <div className="card"><h2>{t('tab.drv')}</h2>
        <p className="mute">{t('drv.note')}</p>
        <div className="row"><button className="act" disabled={!!busy} onClick={scan}>{busy === 'local' ? t('ui.loading') : t('drv.rescan')}</button>
          <button className="act pri" disabled={!!busy} onClick={online}>{busy === 'online' ? t('upd.checking') : t('drv.online')}</button>
          <button className="act" onClick={() => inv('open-optional-updates').catch((e) => alert(errMsg(e)))}>{t('drv.openOpt')}</button>
          <button className="act" onClick={() => inv('open-devmgmt').catch((e) => alert(errMsg(e)))}>{t('drv.devmgmt')}</button></div></div>
      {on && <div className="card"><h2>{t('drv.avail')}</h2>
        {!on.ok ? <p className="mute">{on.error}</p> : !on.items.length ? <p>✓ {t('drv.noUpd')}</p> :
          <table><thead><tr><th>{t('upd.name')}</th><th>{t('drv.class')}</th><th>{t('drv.mfr')}</th><th>{t('drv.date')}</th><th>{t('upd.size')}</th></tr></thead>
            <tbody>{on.items.map((x: any, i: number) => <tr key={i}><td>{x.title}</td><td>{x.cls || '—'}</td><td>{x.manufacturer}{x.model ? <div className="mute">{x.model}</div> : null}</td><td>{x.date || '—'}</td><td>{x.sizeMB ? x.sizeMB + ' MB' : '—'}</td></tr>)}</tbody></table>}
        <p className="mute" style={{ marginTop: 6 }}>{t('hl.at', { t: dt(on.at) })} · {t('drv.howTo')}</p></div>}
      {!loc ? <div className="card"><Loading text={t('drv.reading')} /></div> : !loc.ok ? <div className="card"><ErrorBox msg={loc.error} retry={scan} /></div> : <>
        <div className="card"><h2>{t('drv.problems')}</h2>
          {!loc.problems.length ? <p>✓ {t('drv.noProb')}</p> : loc.problems.map((p: any, i: number) => (
            <div key={i} className={'sec ' + (p.code === 22 || p.code === 45 ? 'warn' : 'bad')}><span className="dot" /><div><b>{p.name}{p.cls ? <span className="mute"> · {p.cls}</span> : null}</b><p>{t('drv.code', { c: p.code })}{cmText(p.code)}</p><details><summary>{t('drv.id')}</summary><div>{p.id}</div></details></div></div>))}</div>
        <div className="card"><h2>{t('drv.list', { n: loc.drivers.length })}</h2>
          <div className="row"><input type="text" placeholder={t('drv.search')} aria-label={t('drv.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
            <select aria-label={t('drv.filter')} value={flt} onChange={(e) => setFlt(e.target.value)}><option value="all">{t('drv.all')}</option><option value="unsigned">{t('drv.unsigned', { n: loc.unsigned })}</option><option value="old">{t('drv.old', { n: loc.old })}</option></select>
            <span className="mute">{t('drv.flagNote')}</span></div>
          <table><thead><tr><th>{t('drv.dev')}</th><th>{t('drv.class')}</th><th>{t('drv.prov')}</th><th>{t('drv.ver')}</th><th>{t('drv.date2')}</th><th>{t('drv.sig')}</th></tr></thead>
            <tbody>{list.slice(0, 400).map((d: any, i: number) => <tr key={i}><td>{d.name}</td><td className="mute">{d.cls}</td><td>{d.provider}</td><td className="mute">{d.version}</td>
              <td>{d.date || '—'}{d.old ? <div className="tag">{t('drv.oldTag', { y: Math.floor(d.ageYears) })}</div> : d.inbox ? <div className="mute">{t('drv.inbox')}</div> : null}</td>
              <td>{d.signed === false ? <span className="tag">{t('drv.no')}</span> : d.signed ? '✓' : '—'}</td></tr>)}
              {!list.length && <tr><td colSpan={6} className="mute">{t('ui.noMatch')}</td></tr>}</tbody></table>
          {list.length > 400 && <p className="mute">{t('drv.more')}</p>}</div></>}
    </section>
  );
}

/* ================= 病毒查杀（Microsoft Defender） ================= */
export function Defender({ cfg, reload }: CfgProps) {
  const [st, reloadSt, stErr] = useLoad<any>(() => inv('def-status'), []);
  const [th, reloadTh] = useLoad<any>(() => inv('def-threats'), []);
  const [run, setRun] = useState<any>(null); const [msg, setMsg] = useState(''); const [upd, setUpd] = useState(false);
  const prev = useRef('');
  useEvery(() => { inv('def-state').then((r) => { setRun(r); if (prev.current === 'running' && r.state !== 'running') { reloadSt(); reloadTh(); } prev.current = r.state; }).catch(() => {}); }, 2000);
  const running = run && run.state === 'running';
  const start = async (type: string) => {
    setMsg('');
    if (type === 'full' && !confirm(t('def.fullQ'))) return;
    if (type === 'offline' && !confirm(t('def.offQ'))) return;
    try { const r = await inv<any>('def-scan', { type }); if (!r.ok && !r.cancelled) setMsg('✗ ' + r.error); } catch (e) { setMsg('✗ ' + errMsg(e)); }
    inv('def-state').then(setRun).catch(() => {});
  };
  const pick = async (folder: boolean) => { try { const r = await inv<any>('def-pick', { folder }); if (r.ok) inv('def-state').then(setRun).catch(() => {}); } catch (e) { alert(errMsg(e)); } };
  const update = async () => { setUpd(true); setMsg(''); try { const r = await inv<any>('def-update'); setMsg(r.ok ? '✓ ' + t('def.updOk') : '✗ ' + r.error); reloadSt(); } catch (e) { setMsg('✗ ' + errMsg(e)); } setUpd(false); };
  const typeName = (x: string) => ({ quick: t('def.quick'), full: t('def.full'), custom: t('def.custom'), offline: t('def.offline') } as any)[x] || x;
  const can = st && st.canScan && !running;
  const bool = (v: any) => (v == null ? '—' : v ? '✓ ' + t('pri.on') : '✗ ' + t('pri.off'));
  return (
    <section className="on">
      <div className="card"><h2>{t('tab.av')}</h2>
        <p className="mute">{t('def.note')}</p>
        {stErr ? <ErrorBox msg={stErr} retry={reloadSt} /> : !st ? <Loading /> : <>
          {st.error && <div className="off">⚠ {st.error}</div>}
          {st.thirdActive && <div className="off">⚠ {t('def.third', { n: st.thirdParty.filter((x: any) => x.active).map((x: any) => x.name).join(', ') })}</div>}
          <div className="grid g4">
            <div><div className="mute">{t('def.rtp')}</div><b>{bool(st.rtp)}</b></div>
            <div><div className="mute">{t('def.av')}</div><b>{bool(st.avOn)}</b>{st.passive ? <div className="tag">{t('def.passive')}</div> : null}</div>
            <div><div className="mute">{t('def.sig')}</div><b>{st.sigVersion || '—'}</b><div className={st.sigAgeDays > 7 ? 'tag' : 'mute'}>{st.sigAgeDays == null ? '' : t('def.sigAge', { n: st.sigAgeDays })}</div></div>
            <div><div className="mute">{t('def.last')}</div><div className="mute">{t('def.lq', { t: ago(st.lastQuick) })}<br />{t('def.lf', { t: ago(st.lastFull) })}</div></div></div>
          {st.thirdParty.length > 0 && !st.thirdActive && <p className="mute" style={{ marginTop: 6 }}>{t('def.thirdOff', { n: st.thirdParty.map((x: any) => x.name).join(', ') })}</p>}
          {!st.cmdlets && st.ok && <p className="mute">{t('def.mpcmd')}</p>}</>}</div>
      <div className="card"><h2>{t('def.scan')}</h2>
        <div className="row"><button className="act pri" disabled={!can} onClick={() => start('quick')}>{typeName('quick')}</button>
          <button className="act" disabled={!can} onClick={() => start('full')}>{typeName('full')}</button>
          <button className="act" disabled={!can} onClick={() => pick(false)}>{t('def.pickFile')}</button>
          <button className="act" disabled={!can} onClick={() => pick(true)}>{t('def.pickDir')}</button>
          <button className="act" disabled={!can || !(run && run.customPath)} onClick={() => start('custom')}>{typeName('custom')}</button>
          <button className="act danger" disabled={!can} onClick={() => start('offline')}>{typeName('offline')}</button></div>
        {run && run.customPath ? <p className="mute">{t('def.path', { p: run.customPath })}</p> : null}
        {run && run.state !== 'idle' && <div className={'sec ' + (run.state === 'running' ? 'warn' : run.state === 'done' ? 'ok' : 'unknown')}><span className="dot" /><div>
          <b>{typeName(run.type)} · {({ running: t('def.st.running'), done: t('def.st.done'), error: t('def.st.error'), cancelled: t('def.st.cancel') } as any)[run.state]}</b>
          <p>{t('def.elapsed', { m: Math.floor(run.elapsedMs / 60000), s: Math.floor((run.elapsedMs % 60000) / 1000) })}{run.error ? ' · ' + run.error : ''}</p>
          {running && <button className="act" onClick={() => inv('def-stop').then(() => inv('def-state').then(setRun)).catch(() => {})}>{t('def.stop')}</button>}
          {run.state === 'cancelled' && <p className="mute">{t('def.stopNote')}</p>}</div></div>}
        <div className="row" style={{ marginTop: 10 }}><button className="act" disabled={upd || !st || !st.ok} onClick={update}>{upd ? t('def.updating') : t('def.upd')}</button>
          <button className="act" onClick={() => inv('open-def-history').catch((e) => alert(errMsg(e)))}>{t('def.hist')}</button>
          <span className="mute">{msg}</span></div>
        <p className="mute">{t('def.admin')}</p></div>
      <div className="card"><h2>{t('def.threats')}</h2>
        {!th ? <Loading /> : !th.ok ? <p className="mute">{th.error}</p> : !th.items.length ? <p>✓ {t('def.noThreat')}</p> :
          <table><thead><tr><th>{t('ui.time')}</th><th>{t('def.name')}</th><th>{t('def.sev')}</th><th>{t('def.stat')}</th><th>{t('def.where')}</th></tr></thead>
            <tbody>{th.items.map((x: any, i: number) => <tr key={i}><td>{ago(x.time)}</td><td>{x.name}{x.active ? <div className="tag">{t('def.active')}</div> : null}</td><td className={x.severity === 'high' || x.severity === 'severe' ? 'tag' : ''}>{t('def.sev.' + x.severity)}</td><td>{t('def.st.' + x.status)}</td><td className="mute" style={{ wordBreak: 'break-all' }}>{x.paths.slice(0, 3).join('\n') || x.process}</td></tr>)}</tbody></table>}
        <p className="mute" style={{ marginTop: 6 }}>{t('def.thNote')}</p></div>
      <div className="card"><h2>{t('def.sched')}</h2>
        <Toggle id="def-sched" label={t('def.schedL')} desc={t('def.schedD')}
          checked={!!cfg?.defSched?.on} disabled={!!cfg?.safe} onChange={(v) => setS({ defSched: { on: v } }, reload)} />
        {cfg?.defSched?.last ? <p className="mute">{t('def.schedLast', { t: dt(cfg.defSched.last) })}</p> : null}</div>
    </section>
  );
}

/* ================= 任务管理器 ================= */
const KIND = () => ({ all: t('pm.all'), app: t('pm.app'), bg: t('pm.bg'), win: t('pm.win') } as Record<string, string>);
const PRI = () => [['BelowNormal', t('pm.pri.bn')], ['Normal', t('pm.pri.n')], ['AboveNormal', t('pm.pri.an')]];
const killMsg = (r: any, name: string) => {
  switch (r.code) {
    case 'ok': return '✓ ' + t('pm.k.ok', { n: name });
    case 'protected': return '✗ ' + (r.reason === 'self' ? t('pm.k.self') : r.reason === 'av' ? t('pm.k.av') : t('pm.k.sys'));
    case 'denied': return '✗ ' + t('pm.k.denied');
    case 'notFound': return t('pm.k.gone');
    default: return '✗ ' + t('pm.k.fail', { c: r.code });
  }
};
export function ProcMgr({ go }: { go: Go }) {
  const [sub, setSub] = useState('proc');
  return (
    <section className="on">
      <div className="card"><div className="row" style={{ justifyContent: 'space-between', marginBottom: 0 }}><h2 style={{ margin: 0 }}>{t('tab.pm')}</h2>
        <span className="row" style={{ margin: 0 }} role="tablist">{[['proc', t('pm.sub.proc')], ['perf', t('pm.sub.perf')], ['svc', t('pm.sub.svc')]].map(([k, l]) => <button key={k} role="tab" aria-selected={sub === k} className={'act' + (sub === k ? ' pri' : '')} onClick={() => setSub(k)}>{l}</button>)}
          <button className="act" onClick={() => inv('open-taskmgr').catch(() => {})}>{t('pm.wtm')}</button></span></div>
        <p className="mute" style={{ marginTop: 8 }}>{t('pm.note')}</p></div>
      {sub === 'proc' && <ProcList />}
      {sub === 'perf' && <Perf go={go} />}
      {sub === 'svc' && <Services go={go} />}
    </section>
  );
}
function ProcList() {
  const [data, setData] = useState<any>(null); const [err, setErr] = useState('');
  const [q, setQ] = useState(''); const [kind, setKind] = useState('all'); const [sort, setSort] = useState('cpu'); const [desc, setDesc] = useState(true);
  const [group, setGroup] = useState(true); const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selPid, setSelPid] = useState<number | null>(null); const [det, setDet] = useState<any>(null); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  useEvery(() => { inv('pm-list').then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errMsg(e))); }, 2000);
  useEffect(() => { setDet(null); if (selPid != null) inv('pm-detail', { pid: selPid }).then(setDet).catch(() => {}); }, [selPid]);
  const list: any[] = (data && data.list) || [];
  const cores = (data && data.cores) || 1;
  const shown = filterSort(list, { q, kind, sort, desc });
  const groups = group ? filterSort(groupProcs(shown).map((g: any) => ({ ...g, pid: g.items[0].pid })), { sort: sort === 'pid' ? 'count' : sort, desc }) : [];
  const th = (k: string, l: string) => <th><button className="thb" aria-sort={sort === k ? (desc ? 'descending' : 'ascending') : 'none'} onClick={() => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(k !== 'name'); } }}>{l}{sort === k ? (desc ? ' ▼' : ' ▲') : ''}</button></th>;
  const sel = list.find((p) => p.pid === selPid);
  const end = async (tree: boolean) => {
    if (!sel) return;
    if (!confirm(tree ? t('pm.treeQ', { n: sel.name, p: sel.pid }) : t('pm.endQ', { n: sel.name, p: sel.pid }))) return;
    if (tree && !confirm(t('pm.treeQ2'))) return;
    setBusy(true); setMsg('');
    try {
      let r = await inv<any>('pm-kill', { pid: sel.pid, tree });
      if (r.code === 'needForce' && confirm(t('pm.forceQ', { n: sel.name }))) r = await inv<any>('pm-kill', { pid: sel.pid, tree, force: true });
      setMsg(r.code === 'needForce' ? t('pm.k.still') : killMsg(r, sel.name));
    } catch (e) { setMsg('✗ ' + errMsg(e)); }
    setBusy(false);
  };
  const prio = async (cls: string) => { if (!sel) return; setBusy(true); try { const r = await inv<any>('pm-priority', { pid: sel.pid, cls }); setMsg(r.ok ? '✓ ' + t('pm.priOk') : killMsg(r, sel.name)); } catch (e) { setMsg('✗ ' + errMsg(e)); } setBusy(false); };
  const row = (p: any, indent = false) => (
    <tr key={p.pid} className={selPid === p.pid ? 'sel' : ''} onClick={() => setSelPid(p.pid)} style={{ cursor: 'pointer' }}>
      <td style={indent ? { paddingLeft: 24 } : undefined}>{p.prot ? '🔒 ' : ''}{p.name}{p.title ? <div className="mute">{p.title}</div> : null}</td><td className="mute">{p.pid}</td><td>{(p.cpu).toFixed(1)}%</td><td>{sz(p.mem)}</td><td className="mute">{KIND()[p.kind]}</td><td className="mute">{p.user}</td></tr>);
  return (<>
    <div className="card">
      <div className="row"><input type="text" placeholder={t('pm.search')} aria-label={t('pm.search')} style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label={t('drv.filter')} value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND()).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <label className="mute"><input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> {t('pm.group')}</label>
        <span className="mute">{data ? t('pm.count', { n: list.length, c: cores }) : ''}</span></div>
      {err && <ErrorBox msg={err} />}
      {!data ? <Loading /> : <div style={{ maxHeight: 460, overflow: 'auto' }}><table><thead><tr>{th('name', t('pm.name'))}{th('pid', 'PID')}{th('cpu', 'CPU')}{th('mem', t('ov.mem'))}<th>{t('pm.kind')}</th><th>{t('pm.user')}</th></tr></thead>
        <tbody>{group ? groups.map((g: any) => g.count === 1 ? row(g.items[0]) : [
          <tr key={'g' + g.key} onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))} style={{ cursor: 'pointer' }}><td><b>{open[g.key] ? '▾' : '▸'} {g.name}</b> <span className="mute">({g.count})</span>{g.title ? <div className="mute">{g.title}</div> : null}</td><td className="mute">—</td><td>{g.cpu.toFixed(1)}%</td><td>{sz(g.mem)}</td><td className="mute">{KIND()[g.kind]}</td><td></td></tr>,
          ...(open[g.key] ? filterSort(g.items, { sort, desc }).map((p: any) => row(p, true)) : [])]) : shown.map((p) => row(p))}
          {!shown.length && <tr><td colSpan={6} className="mute">{t('ui.noMatch')}</td></tr>}</tbody></table></div>}</div>
    {sel && <div className="card"><h2>{t('pm.detail', { n: sel.name, p: sel.pid })}</h2>
      <div className="feat"><dl>
        <dt>{t('pm.path')}</dt><dd style={{ wordBreak: 'break-all' }}>{sel.path || '—'}</dd>
        <dt>{t('pm.cmd')}</dt><dd style={{ wordBreak: 'break-all' }}>{sel.cmd || '—'}</dd>
        <dt>{t('pm.parent')}</dt><dd>{det ? `${det.parentName || '—'} (${sel.ppid})` : sel.ppid}</dd>
        <dt>{t('pm.started')}</dt><dd>{sel.started || '—'}</dd>
        <dt>{t('pm.sigL')}</dt><dd>{!det ? t('ui.loading') : det.sig.status === 'Valid' ? '✓ ' + (det.sig.signer || t('pm.signed')) : det.sig.status === 'NotSigned' ? t('pm.unsigned') : det.sig.status}{det && det.worth ? <div className="tag">⚠ {t('pm.worth')}</div> : null}</dd>
      </dl></div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="act danger" disabled={busy || !!sel.prot} onClick={() => end(false)}>{t('pm.end')}</button>
        <button className="act danger" disabled={busy || !!sel.prot} onClick={() => end(true)}>{t('pm.endTree')}</button>
        <select aria-label={t('pm.prio')} disabled={busy || !!sel.prot} defaultValue="" onChange={(e) => { if (e.target.value) prio(e.target.value); e.target.value = ''; }}><option value="">{t('pm.prioPick')}</option>{PRI().map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <button className="act" disabled={!sel.path} onClick={async () => { try { if (!(await inv('pm-reveal', { pid: sel.pid }))) alert(t('boot.noFile')); } catch (e) { alert(errMsg(e)); } }}>{t('pm.reveal')}</button>
        {sel.prot ? <span className="tag">🔒 {killMsg({ code: 'protected', reason: sel.prot }, sel.name).replace(/^✗ /, '')}</span> : null}
        <span className="mute">{msg}</span></div></div>}
  </>);
}
function Perf({ go }: { go: Go }) {
  const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; rx: number[]; tx: number[] }>({ cpu: [], mem: [], rx: [], tx: [] });
  const [cur, setCur] = useState<any>(null);
  useEvery(() => { inv<any>('pm-perf').then((p) => { setCur(p); setHist((o) => ({ cpu: [...o.cpu, p.cpu || 0].slice(-60), mem: [...o.mem, (p.mem.used / p.mem.total) * 100].slice(-60), rx: [...o.rx, p.rx || 0].slice(-60), tx: [...o.tx, p.tx || 0].slice(-60) })); }).catch(() => {}); }, 1000);
  if (!cur) return <div className="card"><Loading /></div>;
  return (<>
    <div className="grid g2">
      <div className="card"><h2>CPU {cur.cpu != null ? cur.cpu.toFixed(0) + '%' : '—'}</h2>{!cur.hwOn ? <Off msg={t('off.hw')} go={go} /> : <><Spark values={hist.cpu} max={100} />
        <div className="cores">{(cur.cores || []).map((c: number, i: number) => <div key={i} title={`#${i} ${c.toFixed(0)}%`}><i style={{ height: Math.max(2, c) + '%' }} /></div>)}</div>
        <p className="mute">{t('pm.cores')}</p></>}</div>
      <div className="card"><h2>{t('ov.mem')} {((cur.mem.used / cur.mem.total) * 100).toFixed(0)}%</h2><Spark values={hist.mem} max={100} color="#3FBF9B" /><p className="mute">{sz(cur.mem.used)} / {sz(cur.mem.total)}</p></div>
      <div className="card"><h2>{t('pm.net')}</h2>{!cur.netOn ? <Off msg={t('off.net')} go={go} /> : <><Spark values={hist.rx} color="#3FBF9B" /><Spark values={hist.tx} color="#8E76E8" /><p className="mute">↓ {fmt(cur.rx)}　↑ {fmt(cur.tx)}</p></>}</div>
      <div className="card"><h2>{t('pm.disk')}</h2><p className="mute">{t('pm.diskNote')}</p>
        <div className="row"><button className="act" onClick={() => go('ov')}>{t('pm.toHw')}</button><button className="act" onClick={() => go('disk')}>{t('tab.disk')}</button></div></div>
    </div></>);
}
function Services({ go }: { go: Go }) {
  const [d, reload, err] = useLoad<any>(() => inv('pm-services'), []);
  const [q, setQ] = useState('');
  const items = ((d && d.items) || []).filter((x: any) => !q || (x.name + ' ' + x.display).toLowerCase().includes(q.toLowerCase()));
  return (<>
    <div className="card"><div className="row"><button className="act" onClick={() => go('boot')}>{t('pm.toBoot')}</button><span className="mute">{t('pm.svcNote')}</span></div></div>
    <div className="card"><div className="row"><input type="text" placeholder={t('pm.svcSearch')} aria-label={t('pm.svcSearch')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} /><button className="act" onClick={reload}>{t('ui.refresh')}</button><span className="mute">{d && d.ok ? t('pm.svcCount', { n: d.items.length }) : ''}</span></div>
      {err ? <ErrorBox msg={err} retry={reload} /> : !d ? <Loading /> : !d.ok ? <p className="mute">{d.error}</p> : <div style={{ maxHeight: 460, overflow: 'auto' }}><table><thead><tr><th>{t('pm.svcName')}</th><th>{t('pm.name')}</th><th>{t('net.state')}</th><th>{t('pm.svcStart')}</th></tr></thead>
        <tbody>{items.map((x: any) => <tr key={x.name}><td>{x.display}</td><td className="mute">{x.name}</td><td>{x.status === 'Running' ? '▶ ' + t('pm.svcRun') : x.status === 'Stopped' ? t('pm.svcStop') : x.status}</td><td className="mute">{x.start}</td></tr>)}</tbody></table></div>}</div></>);
}

/* ================= 运行内存 ================= */
const MODE = () => ({ manual: t('mem.m.manual'), threshold: t('mem.m.th'), scheduled: t('mem.m.sch') } as Record<string, string>);
export function MemPage({ cfg, reload, go }: CfgProps & { go: Go }) {
  const [st, reloadSt] = useLoad<any>(() => inv('mem-status'), [], 15000);
  const [runs, reloadRuns] = useLoad<any>(() => inv('mem-runs'), []);
  const [ex, setEx] = useState<string>(''); const [busy, setBusy] = useState(false); const [res, setRes] = useState('');
  useEffect(() => { if (cfg?.memTrim) setEx((cfg.memTrim.exclude || []).join('\n')); }, [cfg?.memTrim?.exclude?.join('|')]);
  const trimNow = async () => {
    setBusy(true); setRes('');
    try { const r = await inv<any>('trim-mem'); setRes(r.ok ? '✓ ' + t('mem.res', { n: r.trimmed, v: (r.freed >= 0 ? '+' : '−') + sz(Math.abs(r.freed || 0)), s: ((r.ms || 0) / 1000).toFixed(1) }) : '✗ ' + (r.error || '?')); reloadRuns(); reloadSt(); }
    catch (e) { setRes('✗ ' + errMsg(e)); }
    setBusy(false);
  };
  const saveEx = () => setS({ memTrim: { exclude: ex.split(/[\n,;，；]+/).map((x) => x.trim()).filter(Boolean) } }, reload);
  const mt = cfg?.memTrim;
  return (
    <section className="on">
      <div className="card"><h2>{t('tab.mem')}</h2>
        {!st ? <Loading /> : st.disabled ? <Off msg={t('off.hw')} go={go} /> : !st.ok ? <p className="mute">{t('mem.na')}</p> :
          <div className="grid g4">
            <div><div className="mute">{t('mem.avail')}</div><b>{sz(st.avail)}</b><div className="mute">/ {sz(st.total)}</div></div>
            <div><div className="mute">{t('mem.commit')}</div><b>{sz(st.commit)}</b><div className="mute">/ {sz(st.limit)}（{st.limit ? Math.round((st.commit / st.limit) * 100) : 0}%）</div></div>
            <div><div className="mute">{t('mem.cache')}</div><b>{sz(st.cache)}</b></div>
            <div><div className="mute">{t('mem.comp')}</div><b>{st.comp == null ? t('pn.na') : sz(st.comp)}</b></div></div>}
        <div className="row" style={{ marginTop: 10 }}><button className="act pri" disabled={busy} onClick={trimNow}>{busy ? t('trim.busy') : t('tray.trim')}</button><span className="mute">{res}</span></div>
        <p className="mute">{t('mem.note')}</p></div>
      {runs && runs.tip && <div className="off">💡 {t('mem.tip')} <button className="act" onClick={() => setS({ memTrim: { sched: 0 } }, reload)}>{t('mem.tipOff')}</button></div>}
      <div className="card"><h2>{t('mem.auto')}</h2>
        <Toggle id="mem-th" label={t('mem.thL')} desc={t('mem.thD')} checked={!!mt?.auto} onChange={(v) => setS({ memTrim: { auto: v } }, reload)} />
        <div className="set"><span>{t('mem.thV')}</span><select aria-label={t('mem.thV')} value={mt?.threshold ?? 90} onChange={(e) => setS({ memTrim: { threshold: Number(e.target.value) } }, reload)}>{[80, 85, 90, 95].map((v) => <option key={v}>{v}</option>)}</select></div>
        <div className="set"><span>{t('mem.sch')}<br /><span className="mute">{t('mem.schD')}</span></span>
          <select aria-label={t('mem.sch')} value={mt?.sched ?? 0} disabled={!!cfg?.safe} onChange={(e) => setS({ memTrim: { sched: Number(e.target.value) } }, reload)}>{[0, 30, 60, 120].map((v) => <option key={v} value={v}>{v ? t('set.every', { v }) : t('hk.off')}</option>)}</select></div>
        <p className="mute">{t('mem.gap')}</p>
        <div className="set" style={{ alignItems: 'flex-start' }}><label htmlFor="mem-ex">{t('mem.ex')}<br /><span className="mute">{t('mem.exD')}</span></label>
          <span><textarea id="mem-ex" rows={4} style={{ width: 220 }} value={ex} onChange={(e) => setEx(e.target.value)} /><br /><button className="act" onClick={saveEx}>{t('mem.exSave')}</button></span></div></div>
      <div className="card"><h2>{t('mem.hist')}</h2>
        {!runs ? <Loading /> : !runs.runs.length ? <p className="mute">{t('ui.empty')}</p> : <table><thead><tr><th>{t('ui.time')}</th><th>{t('mem.mode')}</th><th>{t('mem.procs')}</th><th>{t('mem.freed')}</th><th>{t('mem.dur')}</th></tr></thead>
          <tbody>{runs.runs.map((r: any, i: number) => <tr key={i}><td>{dt(r.at)}</td><td>{MODE()[r.mode] || r.mode}</td><td>{r.trimmed}{r.failed ? <span className="mute"> / ✗{r.failed}</span> : null}</td><td className={r.freed < 100 * 1048576 ? 'mute' : ''}>{(r.freed >= 0 ? '+' : '−') + sz(Math.abs(r.freed || 0))}</td><td>{((r.ms || 0) / 1000).toFixed(1)} s{r.error ? <div className="tag">{r.error}</div> : null}</td></tr>)}</tbody></table>}
        <p className="mute" style={{ marginTop: 6 }}>{t('mem.honest')}</p></div>
      <div className="card"><div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>{t('mem.top')}</h2><span className="row" style={{ margin: 0 }}><button className="act" onClick={() => go('pm')}>{t('ov.openPm')}</button><button className="act" onClick={() => inv('open-taskmgr').catch(() => {})}>{t('pm.wtm')}</button></span></div>
        {!st || !st.ok ? null : !st.top ? <Off msg={t('off.proc')} go={go} /> : <table><thead><tr><th>{t('ov.prog')}</th><th>PID</th><th>{t('mem.ws')}</th><th>{t('mem.priv')}</th></tr></thead>
          <tbody>{st.top.map((x: any) => <tr key={x.pid}><td>{x.name}</td><td className="mute">{x.pid}</td><td>{sz(x.ws)}</td><td>{sz(x.priv)}</td></tr>)}</tbody></table>}
        <p className="mute" style={{ marginTop: 6 }}>{t('ov.noKill')}</p></div>
    </section>
  );
}

/* ================= 磁盘整理 ================= */
const mediaName = (m: string) => (m === 'HDD' ? t('disk.hdd') : m === 'SSD' ? t('disk.ssd') : t('disk.unk'));
export function Disk({ cfg, reload }: CfgProps) {
  const [a, setA] = useState<any>(null); const [busy, setBusy] = useState(false); const [st, setSt] = useState<any>(null); const [frag, setFrag] = useState<Record<string, any>>({}); const [msg, setMsg] = useState('');
  const analyze = async () => { setBusy(true); try { setA(await inv('disk-analyze')); } catch (e) { setA({ ok: false, error: errMsg(e), vols: [] }); } setBusy(false); };
  useEffect(() => { analyze(); }, []);
  const prev = useRef(false);
  useEvery(() => { inv('disk-state').then((s) => { setSt(s); if (prev.current && !s.running) analyze(); prev.current = !!s.running; }).catch(() => {}); }, 2000);
  const opt = async (v: any) => {
    const q = v.action === 'defrag' ? t('disk.defQ', { l: v.letter }) : t('disk.trimQ', { l: v.letter });
    if (!confirm(q)) return;
    setMsg(''); try { const r = await inv<any>('disk-optimize', { letter: v.letter }); if (!r.ok) setMsg('✗ ' + r.error); } catch (e) { setMsg('✗ ' + errMsg(e)); }
    inv('disk-state').then(setSt).catch(() => {});
  };
  const fragOf = async (v: any) => { setFrag((o) => ({ ...o, [v.letter]: { busy: true } })); try { const r = await inv('disk-frag', { letter: v.letter }); setFrag((o) => ({ ...o, [v.letter]: r })); } catch (e) { setFrag((o) => ({ ...o, [v.letter]: { ok: false, error: errMsg(e) } })); } };
  const run = st && st.running, last = st && st.last;
  const actName = (x: string) => (x === 'defrag' ? t('disk.defrag') : x === 'retrim' ? t('disk.retrim') : t('disk.skip'));
  return (
    <section className="on">
      <div className="card"><h2>{t('tab.disk')}</h2>
        <p className="mute">{t('disk.note')}</p>
        <div className="row"><button className="act" disabled={busy} onClick={analyze}>{busy ? t('ui.loading') : t('disk.refresh')}</button>
          <button className="act" onClick={() => inv('open-dfrgui').catch((e) => alert(errMsg(e)))}>{t('disk.dfrgui')}</button><span className="mute">{msg}</span></div>
        {a && a.ok && !a.admin && <div className="off">⚠ {t('disk.noAdmin')}</div>}
        {a && a.onBattery && <div className="off">🔋 {t('disk.err.battery')}</div>}
        {run && <div className="sec warn"><span className="dot" /><div><b>{t('disk.running', { l: run.letter, a: actName(run.action) })}</b><p>{t('def.elapsed', { m: Math.floor((Date.now() - run.startedAt) / 60000), s: Math.floor(((Date.now() - run.startedAt) % 60000) / 1000) })}{run.auto ? ' · ' + t('disk.autoRun') : ''}</p>
          <p className="mute">{t('disk.progress')}</p>
          <button className="act" onClick={() => { if (confirm(t('disk.cancelQ'))) inv('disk-cancel').catch(() => {}); }}>{t('btn.cancel')}</button></div></div>}
        {!run && last && <p className={last.ok ? '' : 'mute'}>{last.ok ? '✓ ' : '✗ '}{t('disk.last', { l: last.letter, a: actName(last.action), r: last.ok ? t('disk.ok') : last.error, t: dt(last.at), m: Math.round(last.ms / 60000) })}</p>}</div>
      <div className="card">{!a ? <Loading /> : !a.ok ? <ErrorBox msg={a.error} retry={analyze} /> : <table><thead><tr><th>{t('disk.vol')}</th><th>{t('disk.size')}</th><th>{t('disk.media')}</th><th>{t('disk.lastOpt')}</th><th>{t('disk.frag')}</th><th></th></tr></thead>
        <tbody>{a.vols.map((v: any) => { const f = frag[v.letter]; return <tr key={v.letter}><td><b>{v.letter}:</b> {v.label}<div className="mute">{v.fs}{v.bus ? ' · ' + v.bus : ''}</div></td><td>{sz(v.size)} / {sz(v.free)}</td><td>{mediaName(v.media)}</td><td>{v.lastOpt ? dt(v.lastOpt) : '—'}</td>
          <td>{v.media !== 'HDD' ? <span className="mute">{v.media === 'SSD' ? t('disk.na.ssd') : '—'}</span> : !f ? <button className="act" disabled={!a.admin} onClick={() => fragOf(v)}>{t('disk.fragBtn')}</button> : f.busy ? t('ui.loading') : f.ok ? `${f.pct}%${f.recommended ? ' · ' + t('disk.rec') : ''}` : <span className="mute">{f.error}</span>}</td>
          <td>{v.action === 'skip' ? <span className="mute" title={t('disk.err.unknownMedia')}>{t('disk.skipW')}</span> : <button className="act" disabled={!!run || !a.admin || a.onBattery || !!a.safe} onClick={() => opt(v)}>{t('disk.now', { a: actName(v.action) })}</button>}</td></tr>; })}</tbody></table>}</div>
      <div className="card"><h2>{t('disk.win')}</h2>
        {!a || !a.ok ? null : !a.task || !a.task.exists ? <p className="mute">{t('disk.noTask')}</p> :
          <p>{t('disk.task', { s: a.task.state === 'Disabled' ? t('disk.tDis') : a.task.state === 'Ready' ? t('disk.tOn') : a.task.state, l: a.task.last ? dt(a.task.last) : '—', n: a.task.next ? dt(a.task.next) : '—' })}</p>}
        <Toggle id="disk-auto" label={t('disk.auto')} desc={t('disk.autoD')} checked={!!cfg?.diskAuto?.on} disabled={!!cfg?.safe} onChange={(v) => setS({ diskAuto: { on: v } }, reload)} />
        {cfg?.diskAuto?.last ? <p className="mute">{t('disk.autoLast', { t: dt(cfg.diskAuto.last) })}</p> : null}</div>
    </section>
  );
}

/* ================= 温度与节能 ================= */
const COOL = [70, 80, 90, 99, 100], TEMPS = [80, 85, 90], SAVER = [10, 15, 20, 30];
export function PowerPage({ cfg, reload, go }: CfgProps & { go: Go }) {
  const [s, setSt] = useState<any>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [pct, setPct] = useState(99);
  const load = () => inv('power-status').then((x) => { setSt(x); }).catch((e) => setSt({ ok: false, error: errMsg(e) }));
  useEvery(load, 10000);
  useEffect(() => { if (cfg?.power) setPct(cfg.power.coolMax); }, [cfg?.power?.coolMax]);
  const act = async (ch: string, arg?: any) => { setBusy(true); setMsg(''); try { const r = await inv<any>(ch, arg); setMsg(r.ok ? '✓ ' + t('pow.ok') : '✗ ' + r.error); } catch (e) { setMsg('✗ ' + errMsg(e)); } setBusy(false); load(); reload(); };
  const pc = cfg?.power;
  const idx = (v: any) => (v == null ? '—' : v + '%');
  return (
    <section className="on">
      <div className="card"><h2>{t('tab.power')}</h2>
        <p className="mute">{t('pow.note')}</p>
        {!s ? <Loading /> : <>
          {s.error && <div className="off">⚠ {s.error}</div>}
          <div className="grid g4">
            <div><div className="mute">{t('pow.temp')}</div><b>{!s.hwOn ? t('pri.off') : s.temp != null ? s.temp.toFixed(0) + '℃' : t('pn.na')}</b></div>
            <div><div className="mute">{t('pow.fan')}</div><b>{t('pn.na')}</b><div className="mute">{t('pow.fanNa')}</div></div>
            <div><div className="mute">{t('pow.src')}</div><b>{s.onBattery ? t('pow.bat') : t('pow.ac')}</b>{s.battery != null ? <div className="mute">{s.battery}%</div> : null}</div>
            <div><div className="mute">{t('pow.max')}</div><b>{s.max ? `${idx(s.max.ac)} / ${idx(s.max.dc)}` : '—'}</b><div className="mute">{t('pow.coolPol', { v: !s.cool || s.cool.ac == null ? '—' : s.cool.ac === 1 ? t('pow.active') : t('pow.passive') })}</div></div></div>
          {!s.hwOn && <Off msg={t('off.hw')} go={go} />}</>}</div>
      <div className="card"><h2>{t('pow.plans')}</h2>
        {s && s.ok ? <div className="row">{s.plans.map((p: any) => <button key={p.guid} className={'act' + (p.active ? ' pri' : '')} aria-pressed={p.active} disabled={busy || p.active || !!s.safe} onClick={() => act('power-set-plan', { guid: p.guid })}>{['balanced', 'high', 'ultimate', 'saver'].includes(p.kind) ? t('pow.kind.' + p.kind) : p.name}</button>)}</div> : <p className="mute">{s && s.error}</p>}
        {s && s.ok && !s.plans.some((p: any) => p.kind === 'saver') ? <p className="mute">{t('pow.noSaver')}</p> : null}</div>
      <div className="card"><h2>{t('pow.coolT')}</h2>
        <p className="mute">{t('pow.coolN')}</p>
        <div className="row"><select aria-label={t('pow.coolT')} value={pct} onChange={(e) => setPct(Number(e.target.value))}>{COOL.map((v) => <option key={v} value={v}>{v}%{v === 99 ? t('pow.noTurbo') : v === 100 ? t('pow.full') : ''}</option>)}</select>
          <button className="act pri" disabled={busy || !s || !s.ok || !!(s && s.safe)} onClick={() => act('power-cool', { pct })}>{t('pow.apply')}</button>
          <button className="act" disabled={busy || !(s && s.backup)} onClick={() => { if (confirm(t('pow.restoreQ'))) act('power-restore'); }}>{t('pow.restore')}</button>
          <span className="mute">{msg}</span></div>
        {s && s.backup ? <p className="mute">{t('pow.bak', { t: dt(s.backup.at) })}{s.auto && (s.auto.cooling || s.auto.saver) ? ' ' + t('pow.autoNow') : ''}</p> : null}
        <p className="mute">{t('pow.manual')}</p></div>
      <div className="card"><h2>{t('pow.auto')}</h2>
        <Toggle id="pow-guard" label={t('pow.guard')} desc={t('pow.guardD')} checked={!!pc?.guard} disabled={!!cfg?.safe} onChange={(v) => setS({ power: { guard: v } }, reload)} />
        {pc?.guard && s && s.hwOn && s.temp == null ? <div className="off">⚠ {t('pow.noTemp')}</div> : null}
        <div className="set"><span>{t('pow.th')}</span><select aria-label={t('pow.th')} value={pc?.threshold ?? 85} onChange={(e) => setS({ power: { threshold: Number(e.target.value) } }, reload)}>{TEMPS.map((v) => <option key={v} value={v}>{v}℃</option>)}</select></div>
        <div className="set"><span>{t('pow.coolV')}</span><select aria-label={t('pow.coolV')} value={pc?.coolMax ?? 99} onChange={(e) => setS({ power: { coolMax: Number(e.target.value) } }, reload)}>{COOL.filter((v) => v < 100).map((v) => <option key={v} value={v}>{v}%</option>)}</select></div>
        <Toggle id="pow-saver" label={t('pow.saver')} desc={t('pow.saverD')} checked={!!pc?.saver} disabled={!!cfg?.safe} onChange={(v) => setS({ power: { saver: v } }, reload)} />
        <div className="set"><span>{t('pow.saverPct')}</span><select aria-label={t('pow.saverPct')} value={pc?.saverPct ?? 20} onChange={(e) => setS({ power: { saverPct: Number(e.target.value) } }, reload)}>{SAVER.map((v) => <option key={v} value={v}>{v}%</option>)}</select></div>
        <p className="mute">{t('pow.restoreNote')}</p></div>
      <div className="card"><h2>{t('pow.vendor')}</h2>
        <p className="mute">{t('pow.vendorN')}</p></div>
    </section>
  );
}

/* ================= 宠物换装 ================= */
export function Wardrobe({ cfg, reload }: CfgProps) {
  const [w, reloadW] = useLoad<any>(() => inv('get-wardrobe'), [cfg?.look?.palette, cfg?.look?.acc]);
  if (!cfg || !w) return <div className="card"><Loading /></div>;
  const look = cfg.look || { palette: 'default', acc: 'none' };
  const pick = (p: any) => setS({ look: p }, () => { reload(); reloadW(); });
  let img = '';
  if (!w.safe) { try { img = preview(cfg.pet, look, 140); } catch (_) { img = ''; } }
  const need = (it: any) => (it.level ? t('wr.lv', { n: it.level }) : it.ach ? t('wr.ach', { a: t('ach.' + it.ach) }) : '');
  const Item = ({ it, kind }: { it: any; kind: 'palette' | 'acc' }) => {
    const ok = isUnlocked(it, w.level, w.ach), on = look[kind] === it.id;
    return <button className={'pc wr' + (on ? ' on' : '')} aria-pressed={on} disabled={!ok} title={ok ? '' : need(it)} onClick={() => pick({ [kind]: it.id })}>
      <div className="em" aria-hidden="true" style={kind === 'palette' && it.body ? { color: it.body } : undefined}>{ok ? it.emoji : '🔒'}</div><span>{t((kind === 'palette' ? 'wr.p.' : 'wr.a.') + it.id)}</span>{!ok ? <span className="mute">{need(it)}</span> : null}</button>;
  };
  return (
    <div className="card"><h2>{t('wr.title')}</h2>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ width: 150, textAlign: 'center' }}>{img ? <img src={img} alt={t('wr.prev')} width={140} height={140} /> : <div className="mute">{w.safe ? t('wr.safe') : ''}</div>}</div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="mute">{t('wr.pal')}</div><div className="pets" style={{ marginBottom: 10 }}>{PALETTES.map((p) => <Item key={p.id} it={p} kind="palette" />)}</div>
          <div className="mute">{t('wr.acc')}</div><div className="pets">{ACCESSORIES.map((a) => <Item key={a.id} it={a} kind="acc" />)}</div></div></div>
      <p className="mute" style={{ marginTop: 8 }}>{t('wr.note', { lv: w.level })}</p></div>
  );
}

/* ================= 网速异常提醒（设置页） ================= */
export function SpeedAlertCard({ cfg, reload }: CfgProps) {
  const a = cfg?.speedAlert; if (!a) return null;
  const sel = (k: string, list: number[], fmtv: (v: number) => string, label: string) => <div className="set"><span>{label}</span><select aria-label={label} value={(a as any)[k]} disabled={!a.on} onChange={(e) => setS({ speedAlert: { [k]: Number(e.target.value) } }, reload)}>{list.map((v) => <option key={v} value={v}>{fmtv(v)}</option>)}</select></div>;
  const sec = (v: number) => (v >= 60 ? t('sa.min', { v: v / 60 }) : t('sa.sec', { v }));
  return (
    <div className="card"><h2>{t('sa.title')}</h2>
      <Toggle id="sa-on" label={t('sa.on')} desc={t('sa.desc')} checked={!!a.on} onChange={(v) => setS({ speedAlert: { on: v } }, reload)} />
      {sel('lowKB', LOW_KB_CHOICES, (v) => v + ' KB/s', t('sa.low'))}
      {sel('lowSec', LOW_SEC_CHOICES, sec, t('sa.lowSec'))}
      {sel('highMB', HIGH_MB_CHOICES, (v) => (v ? v + ' MB/s' : t('hk.off')), t('sa.high'))}
      {sel('highSec', HIGH_SEC_CHOICES, sec, t('sa.highSec'))}
      {sel('cooldownMin', COOLDOWN_CHOICES, (v) => t('sa.min', { v }), t('sa.cool'))}
    </div>
  );
}
