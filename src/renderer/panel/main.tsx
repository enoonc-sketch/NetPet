import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PState, Sample, Speed } from '../../shared/types';

const api = window.netpet;
const fmt = (b: number | null) => (b == null ? '—' : b < 1024 ? Math.round(b) + ' B/s' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s');
const sz = (b: number) => (b < 1073741824 ? (b / 1048576).toFixed(0) + ' MB' : (b / 1073741824).toFixed(1) + ' GB');
const NAME: Record<string, string> = { IDLE: '待机', HAPPY: '开心', SLEEP: '睡觉', TIRED: '累了', HOT: '发热', SWEAT: '内存紧张', WARNING: '有提醒', DOWNLOAD: '下载中', UPLOAD: '上传中' };

function App() {
  const [sp, setSp] = useState<Speed>({ rx: null, tx: null, online: null });
  const [sm, setSm] = useState<Sample | null>(null);
  const [ps, setPs] = useState<PState | null>(null);
  const [sys, setSys] = useState<any>(null);
  const [h, setH] = useState<{ rx: number[]; tx: number[] }>({ rx: Array(60).fill(0), tx: Array(60).fill(0) });
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    api.on('speed', (s) => { setSp(s); setH((o) => ({ rx: [...o.rx.slice(1), s.rx || 0], tx: [...o.tx.slice(1), s.tx || 0] })); });
    api.on('sample', setSm); api.on('pstate', setPs);
    api.invoke('get-pstate').then((p) => p && setPs(p)).catch(() => {});
    const load = () => api.invoke('get-system').then(setSys).catch(() => {});
    load(); window.addEventListener('focus', load);
    const t = setInterval(() => { if (!document.hidden) load(); }, 10000);
    return () => { window.removeEventListener('focus', load); clearInterval(t); };
  }, []);
  useEffect(() => {
    const c = cv.current!, r = devicePixelRatio || 1, w = c.clientWidth, ht = c.clientHeight; c.width = w * r; c.height = ht * r;
    const x = c.getContext('2d')!; x.scale(r, r); const max = Math.max(1024, ...h.rx, ...h.tx) * 1.15;
    const line = (a: number[], col: string) => { x.beginPath(); a.forEach((v, i) => { const px = (i / 59) * w, py = ht - (v / max) * (ht - 4) - 2; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.strokeStyle = col; x.lineWidth = 2; x.stroke(); };
    line(h.rx, '#3FBF9B'); line(h.tx, '#8E76E8');
  }, [h]);

  const g = sys && (sys.gpu || [])[0];
  return (
    <div className="card">
      <div className="row"><span className="st">{ps ? (ps.paused ? '已暂停' : NAME[ps.state] || ps.state) : '待机'}</span><span className="mute">{sp.online === false ? '网络已断开' : ps?.internet === 'fail' ? '已连接但上不了网' : ps?.internet === 'portal' ? '需要网页登录' : sp.rx == null ? '网速监控未开启' : ''}</span></div>
      <div className="row" style={{ marginTop: 6 }}><span className="big d">↓ {fmt(sp.rx)}</span><span className="big u">↑ {fmt(sp.tx)}</span></div>
      <canvas ref={cv} />
      <div className="row"><span>CPU</span><span>{sm ? sm.cpu.toFixed(0) + '%' : sys && !sys.hwOn ? '未开启' : '—'}</span></div><div className="bar"><i style={{ width: (sm ? sm.cpu : 0) + '%' }} /></div>
      <div className="row"><span>内存</span><span>{sm ? `${sm.pct.toFixed(0)}%（${sz(sm.used)}）` : sys && !sys.hwOn ? '未开启' : '—'}</span></div><div className="bar"><i style={{ width: (sm ? sm.pct : 0) + '%' }} /></div>
      {(sys?.disks || []).slice(0, 2).map((d: any) => <div key={d.mount}><div className="row"><span>{d.mount}</span><span className="mute">{sz(d.used)} / {sz(d.size)}</span></div><div className="bar"><i style={{ width: d.pct + '%' }} /></div></div>)}
      <div className="mute">
        {sys && !sys.hwOn ? '硬件状态监控已关闭（可在完整窗口 → 隐私 开启）' : sys ? <>GPU：{g ? g.name + (g.util != null ? ' ' + g.util + '%' : '（无法读取占用）') : '无法检测'}<br />温度：{sys.temp ? sys.temp.toFixed(0) + '℃' : '读不到'}{sys.battery ? <><br />电量：{sys.battery.pct}%{sys.battery.charging ? '（充电中）' : ''}</> : null}</> : null}
      </div>
      <div className="row"><button onClick={() => api.send('panel-open-main')}>打开完整窗口</button>
        <button onClick={() => api.invoke('reset-pet').catch(() => {})}>复位小宠物</button></div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
