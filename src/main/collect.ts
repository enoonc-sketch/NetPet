// 主进程这边：把采集请求发给采集进程，带超时；超时就连同它的子进程一起结束并重启；连续超时的项目暂停 5 分钟。
import { utilityProcess, UtilityProcess } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { log } from './logger';

let cp: UtilityProcess | null = null;
let seq = 0;
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
const fails: Record<string, number> = {};
const blockedUntil: Record<string, number> = {};

function killTree(pid?: number) {
  if (!pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  else { try { process.kill(pid); } catch (_) {} }
}
function start() {
  const me = utilityProcess.fork(path.join(__dirname, 'collector.js'), [], { serviceName: 'NetPet 采集进程' });
  cp = me;
  me.on('message', (m: any) => {
    const p = pending.get(m.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error)) : p.res(m.data);
  });
  me.on('exit', () => {
    if (cp === me) cp = null;
    for (const [id, p] of pending) { clearTimeout(p.timer); p.rej(new Error('采集进程已退出')); pending.delete(id); }
  });
  log('采集进程已启动 pid=' + me.pid);
}
export function collect<T = any>(fn: string, timeout = 8000): Promise<T> {
  if ((blockedUntil[fn] || 0) > Date.now()) return Promise.reject(new Error('暂时跳过 ' + fn));
  if (!cp) start();
  const me = cp!;
  return new Promise<T>((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id); fails[fn] = (fails[fn] || 0) + 1;
      log(`采集超时：${fn}（${timeout}ms），第 ${fails[fn]} 次，重启采集进程`);
      if (fails[fn] >= 3) { blockedUntil[fn] = Date.now() + 5 * 60e3; fails[fn] = 0; log(`${fn} 连续超时，5 分钟内暂停该项采集`); }
      if (cp === me) { cp = null; killTree(me.pid); try { me.kill(); } catch (_) {} }
      rej(new Error('timeout'));
    }, timeout);
    pending.set(id, { res: (v) => { fails[fn] = 0; res(v); }, rej, timer });
    me.postMessage({ id, fn });
  });
}
export function stopCollector(): Promise<void> {
  return new Promise((resolve) => {
    const me = cp; if (!me) return resolve();
    cp = null;
    const done = () => { killTree(me.pid); try { me.kill(); } catch (_) {} resolve(); };
    const t = setTimeout(done, 1200);
    me.once('exit', () => { clearTimeout(t); resolve(); });
    try { me.postMessage({ id: 0, fn: 'release' }); } catch (_) { clearTimeout(t); done(); }
  });
}
