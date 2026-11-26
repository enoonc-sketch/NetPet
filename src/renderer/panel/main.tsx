import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FocusState, PState, Sample, Speed } from '../../shared/types';
import { t, setLang } from '../../shared/i18n';
import { mmss } from '../../main/focus';

const api = window.netpet;
const fmt = (b: number | null) => (b == null ? '—' : b < 1024 ? Math.round(b) + ' B/s' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s');
const sz = (b: number) => (b < 1073741824 ? (b / 1048576).toFixed(0) + ' MB' : (b / 1073741824).toFixed(1) + ' GB');

function App() {
  const [sp, setSp] = useState<Speed>({ rx: null, tx: null, online: null });
  const [sm, setSm] = useState<Sample | null>(null);
  const [ps, setPs] = useState<PState | null>(null);
  const [sys, setSys] = useState<any>(null);
  const [fc, setFc] = useState<FocusState | null>(null); // 1.5.0 番茄钟
  const [, setTick] = useState(0);
  const [h, setH] = useState<{ rx: number[]; tx: number[] }>({ rx: Array(60).fill(0), tx: Array(60).fill(0) });
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    api.on('speed', (s) => { setSp(s); setH((o) => ({ rx: [...o.rx.slice(1), s.rx || 0], tx: [...o.tx.slice(1), s.tx || 0] })); });
    api.on('sample', setSm); api.on('pstate', setPs); api.on('focus', setFc);
    api.on('settings', (s) => { if (s && s.lang) { setLang(s.lang); setTick((x) => x + 1); } });
    api.invoke('get-lang').then((l) => { setLang(l); setTick((x) => x + 1); }).catch(() => {});
    api.invoke('get-pstate').then((p) => p && setPs(p)).catch(() => {});
    api.invoke('focus-get').then(setFc).catch(() => {});
    const load = () => api.invoke('get-system').then(setSys).catch(() => {});
    load(); window.addEventListener('focus', load);
    const tm = setInterval(() => { if (!document.hidden) load(); }, 10000);
    const sec = setInterval(() => { if (!document.hidden) setTick((x) => x + 1); }, 1000);
    return () => { window.removeEventListener('focus', load); clearInterval(tm); clearInterval(sec); };
  }, []);
  useEffect(() => {
    const c = cv.current!, r = devicePixelRatio || 1, w = c.clientWidth, ht = c.clientHeight; c.width = w * r; c.height = ht * r;
    const x = c.getContext('2d')!; x.scale(r, r); const max = Math.max(1024, ...h.rx, ...h.tx) * 1.15;
    const line = (a: number[], col: string) => { x.beginPath(); a.forEach((v, i) => { const px = (i / 59) * w, py = ht - (v / max) * (ht - 4) - 2; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.strokeStyle = col; x.lineWidth = 2; x.stroke(); };
    line(h.rx, '#3FBF9B'); line(h.tx, '#8E76E8');
  }, [h]);

  const g = sys && (sys.gpu || [])[0];
  const fRemain = fc ? (fc.running && fc.endsAt ? Math.max(0, fc.endsAt - Date.now()) : fc.remainMs) : 0;
  const ctl = (a: string) => api.invoke('focus-ctl', { action: a }).then((x) => x && setFc(x)).catch(() => {});
  return (
    <div className="card">
      <div className="row"><span className="st">{ps ? (ps.paused ? t('pn.paused') : t('st.' + ps.state)) : t('st.IDLE')}</span><span className="mute">{sp.online === false ? t('b.offline') : ps?.internet === 'fail' ? t('b.noInet') : ps?.internet === 'portal' ? t('b.portal') : sp.rx == null ? t('pn.netOff') : ''}</span></div>
      <div className="row" style={{ marginTop: 6 }}><span className="big d">↓ {fmt(sp.rx)}</span><span className="big u">↑ {fmt(sp.tx)}</span></div>
      <canvas ref={cv} />
      <div className="row"><span>CPU</span><span>{sm ? sm.cpu.toFixed(0) + '%' : sys && !sys.hwOn ? t('pn.off') : '—'}</span></div><div className="bar"><i style={{ width: (sm ? sm.cpu : 0) + '%' }} /></div>
      <div className="row"><span>{t('ov.mem')}</span><span>{sm ? `${sm.pct.toFixed(0)}%（${sz(sm.used)}）` : sys && !sys.hwOn ? t('pn.off') : '—'}</span></div><div className="bar"><i style={{ width: (sm ? sm.pct : 0) + '%' }} /></div>
      {(sys?.disks || []).slice(0, 2).map((d: any) => <div key={d.mount}><div className="row"><span>{d.mount}</span><span className="mute">{sz(d.used)} / {sz(d.size)}</span></div><div className="bar"><i style={{ width: d.pct + '%' }} /></div></div>)}
      <div className="mute">
        {sys && !sys.hwOn ? t('pn.hwOff') : sys ? <>GPU：{g ? g.name + (g.util != null ? ' ' + g.util + '%' : t('ov.gpuNoUse')) : t('ov.na')}<br />{t('ov.temp')}：{sys.temp ? sys.temp.toFixed(0) + '℃' : t('pn.na')}{sys.battery ? <><br />{t('ov.bat')}：{sys.battery.pct}%{sys.battery.charging ? t('ov.charging') : ''}</> : null}</> : null}
      </div>
      <div className="row focus"><span>🍅 {fc && fc.phase !== 'idle' ? `${fc.phase === 'focus' ? t('focus.phase.focus') : t('focus.phase.break')} ${mmss(fRemain)}` : t('pn.focus')}</span>
        <span className="fbtn">{fc && fc.running ? <button className="sm" onClick={() => ctl('pause')}>{t('focus.pause')}</button> : <button className="sm" onClick={() => ctl('start')}>{fc && fc.phase !== 'idle' ? t('focus.resume') : t('pn.start')}</button>}
          <button className="sm" disabled={!fc || fc.phase === 'idle'} onClick={() => ctl('reset')}>{t('focus.reset')}</button></span></div>
      <div className="row"><button onClick={() => api.send('panel-open-main')}>{t('pn.open')}</button>
        <button onClick={() => api.invoke('reset-pet').catch(() => {})}>{t('pn.reset')}</button></div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
