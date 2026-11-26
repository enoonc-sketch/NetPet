import { useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';

export const inv = <T = any,>(ch: string, arg?: unknown): Promise<T> => window.netpet.invoke<T>(ch, arg);
export const fmt = (b: number | null | undefined) => (b == null ? '—' : b < 1024 ? Math.round(b) + ' B/s' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s');
export const sz = (b: number) => (b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(0) + ' MB' : (b / 1073741824).toFixed(1) + ' GB');
/** 宠物状态名（1.5.0 起随界面语言变化；旧代码里的 NAME[x] 仍可用）。 */
export const stateName = (s: string) => t('st.' + s);
export const NAME: Record<string, string> = new Proxy({}, { get: (_o, k) => stateName(String(k)) }) as any;
/** 日期时间显示：跟随界面语言。 */
export const dt = (v: number | string) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toLocaleString(t('locale')) : '—'; };

/** 把主进程/预加载返回的英文错误变成用户看得懂的提示。 */
export function errMsg(e: unknown, fallback = ''): string {
  const s = String((e && (e as any).message) || e || '');
  if (/locked/.test(s)) return t('err.locked');
  if (/too-many-attempts/.test(s)) return t('err.tooMany');
  if (/busy/.test(s)) return t('err.busy');
  if (/untrusted sender|channel not allowed/.test(s)) return t('err.notAllowed');
  if (/timeout|超时/.test(s)) return t('err.timeout');
  return fallback || t('err.generic');
}

/** 页面打开时加载一次，可选定时刷新；返回 [数据, 手动刷新, 错误提示] */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], every = 0): [T | undefined, () => void, string] {
  const [v, setV] = useState<T>();
  const [n, setN] = useState(0);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    const run = () => fn().then((x) => { if (on) { setV(x); setErr(''); } }).catch((e) => { if (on) setErr(errMsg(e, t('err.read'))); });
    run();
    const tm = every ? setInterval(() => { if (!document.hidden) run(); }, every) : undefined;
    return () => { on = false; if (tm) clearInterval(tm); };
  }, [...deps, n]);
  return [v, () => setN((x) => x + 1), err];
}

/** 加载中 / 出错 的统一占位。 */
export function Loading({ text }: { text?: string }) { return <p className="mute" role="status" aria-live="polite">{text || t('ui.loading')}</p>; }
export function ErrorBox({ msg, retry }: { msg: string; retry?: () => void }) {
  return <div className="off" role="alert">⚠ {msg} {retry ? <button className="act" onClick={retry}>{t('ui.retry')}</button> : null}</div>;
}

export function Chart({ hx, ht, height = 150 }: { hx: number[]; ht: number[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!, r = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * r; c.height = h * r;
    const x = c.getContext('2d')!; x.scale(r, r);
    const max = Math.max(1024, ...hx, ...ht) * 1.15;
    const line = (a: number[], col: string) => {
      x.beginPath(); a.forEach((v, i) => { const px = (i / 59) * w, py = h - (v / max) * (h - 6) - 3; i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.strokeStyle = col; x.lineWidth = 2; x.lineJoin = 'round'; x.stroke();
      x.lineTo(w, h); x.lineTo(0, h); x.closePath(); x.globalAlpha = 0.12; x.fillStyle = col; x.fill(); x.globalAlpha = 1;
    };
    line(hx, '#3FBF9B'); line(ht, '#8E76E8');
    x.fillStyle = '#8C7F8A'; x.font = '11px sans-serif'; x.fillText(fmt(max), 4, 12);
  }, [hx, ht]);
  return <canvas ref={ref} style={{ height }} role="img" aria-label={t('ui.chart60')} />;
}

/** 按天的柱状图：下载（绿）和上传（紫）叠在一起。labels 与 rx/tx 一一对应。 */
export function BarChart({ labels, rx, tx, height = 170 }: { labels: string[]; rx: number[]; tx: number[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const r = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * r; c.height = h * r;
    const x = c.getContext('2d'); if (!x) return; x.scale(r, r);
    const ink = getComputedStyle(c).color || '#8C7F8A';
    const n = labels.length, padB = 18, padT = 16, top = Math.max(1024, ...rx.map((v, i) => v + (tx[i] || 0)));
    const bw = n ? Math.max(2, (w / n) * 0.62) : 0, step = n ? w / n : 0;
    for (let i = 0; i < n; i++) {
      const hx = ((rx[i] || 0) / top) * (h - padB - padT), ht = ((tx[i] || 0) / top) * (h - padB - padT);
      const px = i * step + (step - bw) / 2, base = h - padB;
      x.fillStyle = '#3FBF9B'; x.fillRect(px, base - hx, bw, hx);
      x.fillStyle = '#8E76E8'; x.fillRect(px, base - hx - ht, bw, ht);
    }
    x.fillStyle = ink; x.font = '11px sans-serif'; x.textAlign = 'center';
    const every = n > 14 ? Math.ceil(n / 10) : 1;
    for (let i = 0; i < n; i += every) x.fillText(labels[i], i * step + step / 2, h - 4);
    x.textAlign = 'left'; x.fillText(t('ui.max', { v: sz(top) }), 4, 11);
  }, [labels.join(','), rx.join(','), tx.join(',')]);
  const total = rx.reduce((a, v) => a + v, 0) + tx.reduce((a, v) => a + v, 0);
  return <canvas ref={ref} className="bars" style={{ height }} role="img" aria-label={t('ui.barAria', { n: labels.length, total: sz(total) })} />;
}

/** 1.5.0：SVG 折线图（硬件历史曲线、任务管理器性能页）。series 的值都在 0~max 之间；t 为毫秒时间戳；相邻点间隔 > gap 时断开。 */
export function LineChart({ series, t0, t1, max = 100, height = 180, gap, ticks = [], unit = '%', label }:
  { series: { name: string; color: string; pts: { t: number; v: number | null }[] }[]; t0: number; t1: number; max?: number; height?: number; gap?: number; ticks?: { t: number; label: string }[]; unit?: string; label: string }) {
  const W = 1000, H = 200, pl = 34, pb = 20, pt = 8, iw = W - pl - 6, ih = H - pb - pt;
  const X = (tm: number) => pl + ((tm - t0) / Math.max(1, t1 - t0)) * iw, Y = (v: number) => pt + ih - (Math.max(0, Math.min(max, v)) / max) * ih;
  const paths = (pts: { t: number; v: number | null }[]) => {
    const segs: string[] = []; let cur = '', last = -Infinity;
    for (const p of pts) {
      if (p.v == null) { if (cur) segs.push(cur); cur = ''; continue; }
      if (cur && gap && p.t - last > gap) { segs.push(cur); cur = ''; }
      cur += (cur ? ' L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1); last = p.t;
    }
    if (cur) segs.push(cur);
    return segs;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="lchart" style={{ height }} role="img" aria-label={label}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={pl} x2={W - 6} y1={Y(max * f)} y2={Y(max * f)} className="grid" /><text x={2} y={Y(max * f) + 4} className="ax">{Math.round(max * f)}{unit}</text></g>)}
      {ticks.map((k) => <text key={k.t} x={X(k.t)} y={H - 4} className="ax" textAnchor="middle">{k.label}</text>)}
      {series.map((s) => paths(s.pts).map((d, i) => <path key={s.name + i} d={d} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />))}
    </svg>
  );
}
/** 1.5.0：迷你走势图（最近若干个值）。 */
export function Spark({ values, max, color = '#8E76E8', height = 40 }: { values: number[]; max?: number; color?: string; height?: number }) {
  const W = 200, H = 40, m = max || Math.max(1, ...values), n = values.length;
  const d = values.map((v, i) => (i ? 'L' : 'M') + ((i / Math.max(1, n - 1)) * W).toFixed(1) + ' ' + (H - 2 - (Math.max(0, v) / m) * (H - 4)).toFixed(1)).join(' ');
  return <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }} aria-hidden="true">{n > 1 ? <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" /> : null}</svg>;
}

export function Off({ msg, go }: { msg: string; go: (t: string) => void }) {
  return <div className="off">{msg} <button className="act" onClick={() => go('pri')}>{t('ui.goPrivacy')}</button></div>;
}
/** 1.5.0：开关行（复选框 + 标签 + 说明）。 */
export function Toggle({ id, label, desc, checked, onChange, disabled }: { id: string; label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <div className="set"><span id={id}>{label}{desc ? <><br /><span className="mute">{desc}</span></> : null}</span><input type="checkbox" aria-labelledby={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /></div>;
}
