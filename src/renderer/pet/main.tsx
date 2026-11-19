import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Pet3D } from '../pets3d';
import { PETS } from '../../shared/petlist';
import type { PState, Speed } from '../../shared/types';

const api = window.netpet;
const fmt = (b: number | null) => (b == null ? '—' : b < 1024 ? Math.round(b) + ' B/s' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s');
const short = (b: number | null) => (b == null ? '—' : b < 1024 ? Math.round(b) + 'B' : b < 1048576 ? (b / 1024).toFixed(0) + 'K' : (b / 1048576).toFixed(1) + 'M');
// 状态由主进程的“宠物状态机”决定（带防抖和优先级），这里只负责表现
const MAP: Record<string, [string, string?]> = {
  SLEEP: ['sleep'], IDLE: ['idle'], HAPPY: ['happy'], DOWNLOAD: ['happy'], UPLOAD: ['happy'], TIRED: ['tired'], HOT: ['idle', 'hot'], SWEAT: ['idle', 'hot'], WARNING: ['idle', 'risk']
};

function App() {
  const [sp, setSp] = useState<Speed>({ rx: null, tx: null });
  const [ps, setPs] = useState<PState>({ state: 'IDLE', label: '', paused: false, dnd: false, online: null });
  const [petId, setPetId] = useState('cat');
  const [compact, setCompact] = useState(false);
  const [has3d, setHas3d] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const p3d = useRef<Pet3D | null>(null);
  const drag = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);
  const clickT = useRef<number | null>(null);
  const dims = compact ? { w: 80, h: 72 } : { w: 150, h: 130 };

  useEffect(() => {
    api.on('speed', setSp); api.on('pstate', setPs);
    api.on('settings', (s) => { if (s.pet) setPetId(s.pet); if (typeof s.compact === 'boolean') setCompact(s.compact); });
    api.invoke('get-pstate').then((p) => p && setPs(p)).catch(() => {});
    // 先问主进程是不是安全模式；安全模式下不创建 3D。3D 不可用时自动退回 emoji 宠物
    api.invoke('get-settings').then((s) => {
      setPetId(s.pet); setCompact(!!s.compact);
      if (!s.safe) { try { p3d.current = new Pet3D(canvas.current!, s.pet, s.compact ? { w: 80, h: 72 } : { w: 150, h: 130 }); setHas3d(true); } catch { p3d.current = null; setHas3d(false); } }
      requestAnimationFrame(() => api.send('pet-ready'));
    }).catch(() => api.send('pet-ready'));
    const move = (e: MouseEvent) => {
      const d = drag.current; if (!d) return;
      const dx = e.screenX - d.sx, dy = e.screenY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) api.send('drag-move', { dx, dy });
    };
    // 拖动 / 单击(展开小面板) / 双击(打开完整窗口)
    const up = () => {
      const d = drag.current;
      if (d) {
        if (d.moved) api.send('drag-end');
        else if (clickT.current) { clearTimeout(clickT.current); clickT.current = null; api.send('pet-dblclick'); }
        else clickT.current = window.setTimeout(() => { clickT.current = null; api.send('pet-click'); }, 260);
      }
      drag.current = null;
    };
    // WebGL 上下文丢失（显卡驱动/显存问题）时，旧版只剩一个透明空窗口，看起来像宠物消失了；
    // 现在立刻退回 emoji 宠物，主进程的渲染进程崩溃重建是第二道防线。
    const cv = canvas.current!;
    const onLost = (e: Event) => { e.preventDefault(); try { p3d.current?.dispose(); } catch (_) {} p3d.current = null; setHas3d(false); };
    cv.addEventListener('webglcontextlost', onLost);
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); cv.removeEventListener('webglcontextlost', onLost); p3d.current?.dispose(); };
  }, []);

  const [mood, flag] = ps.paused ? (['sleep'] as [string]) : MAP[ps.state] || MAP.IDLE;
  useEffect(() => { p3d.current?.setPet(petId); }, [petId, has3d]);
  useEffect(() => { p3d.current?.resize(dims.w, dims.h); }, [compact, has3d]);
  useEffect(() => { p3d.current?.setState(mood, flag === 'hot', flag === 'risk'); }, [mood, flag, has3d]);

  const onDown = (e: React.MouseEvent) => { if (e.button !== 0) return; drag.current = { sx: e.screenX, sy: e.screenY, moved: false }; api.send('drag-start'); };
  const cls = (mood === 'tired' ? 'idle' : mood) + (flag === 'hot' ? ' hot' : '') + (flag === 'risk' ? ' risk' : '');
  const emoji = (PETS.find((p) => p.id === petId) || PETS[0]).emoji;
  return (
    <div className={'stage' + (compact ? ' compact' : '')} onMouseDown={onDown} onContextMenu={(e) => { e.preventDefault(); api.send('pet-menu'); }} title={ps.label}>
      <div className="bubble">
        {compact ? <><b className="d">↓{short(sp.rx)}</b> <b className="u">↑{short(sp.tx)}</b></>
          : <><span className="d">↓ {fmt(sp.rx)}</span><br /><span className="u">↑ {fmt(sp.tx)}</span>{ps.label ? <div className="chip">{ps.label}</div> : null}</>}
      </div>
      <canvas ref={canvas} className={'c3d' + (has3d ? '' : ' off')} />
      {!has3d && <div className={'emoji ' + cls}>{emoji}</div>}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
