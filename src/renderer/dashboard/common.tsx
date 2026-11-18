import { useEffect, useRef, useState } from 'react';

export const inv = <T = any,>(ch: string, arg?: unknown): Promise<T> => window.netpet.invoke<T>(ch, arg);
export const fmt = (b: number | null | undefined) => (b == null ? '—' : b < 1024 ? Math.round(b) + ' B/s' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s');
export const sz = (b: number) => (b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(0) + ' MB' : (b / 1073741824).toFixed(1) + ' GB');
export const NAME: Record<string, string> = { IDLE: '待机', HAPPY: '开心', SLEEP: '睡觉', TIRED: '累了', HOT: '发热', SWEAT: '内存紧张', WARNING: '有提醒', DOWNLOAD: '下载中', UPLOAD: '上传中' };

/** 页面打开时加载一次，可选定时刷新；返回 [数据, 手动刷新] */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], every = 0): [T | undefined, () => void] {
  const [v, setV] = useState<T>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    const run = () => fn().then((x) => on && setV(x)).catch(() => {});
    run();
    const t = every ? setInterval(() => { if (!document.hidden) run(); }, every) : undefined;
    return () => { on = false; if (t) clearInterval(t); };
  }, [...deps, n]);
  return [v, () => setN((x) => x + 1)];
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
  return <canvas ref={ref} style={{ height }} />;
}

export function Off({ msg, go }: { msg: string; go: (t: string) => void }) {
  return <div className="off">{msg} <button className="act" onClick={() => go('pri')}>去隐私设置开启</button></div>;
}
