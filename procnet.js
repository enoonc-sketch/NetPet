// procnet.js — ETW 原生组件的 JS 包装层
//
// 职责只有三件：①找到并加载 .node（找不到就如实报不可用，绝不编数据）；
// ②把原生返回的“自会话开始累计值”换算成速率和增量（PID 复用时累计值
// 会变小，视为新进程重计）；③按程序名聚合（PID 会变，程序名是稳定的
// 统计口径）。
// 采样、开关、落库都在 main.js；渲染在 dashboard.html。
const path = require('path');

let native = null, loadError = '';
const candidates = [
  path.join(__dirname, 'native', 'procnet', 'build', 'Release', 'procnet.node'),
  path.join(__dirname, 'build', 'Release', 'procnet.node'),
  path.join(__dirname, 'procnet.node'),
];
if (process.platform === 'win32') {
  for (const f of candidates) {
    try { native = require(f); break; } catch (e) { loadError = String((e && e.message) || e); }
  }
} else {
  loadError = 'windows-only';
}

function isAvailable() { return !!native; }
function loadReason() { return native ? '' : loadError; }
function start() {
  if (!native) return { ok: false, error: loadError || 'native-missing' };
  try { return native.start(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
function stop() {
  if (!native) return { ok: true };
  try { return native.stop(); } catch (_) { return { ok: false }; }
}
function getTotals() {
  if (!native) return [];
  try { return native.getTotals() || []; } catch (_) { return []; }
}
function getStatus() {
  if (!native) return { running: false, mode: 'unavailable', error: loadError || 'native-missing', eventsSeen: 0, parseErrors: 0 };
  try { return native.getStatus() || { running: false }; } catch (e) { return { running: false, error: String((e && e.message) || e) }; }
}

// 把原生累计值换算成速率 + 本次增量。
// prev: Map(pid -> {rx,tx,name})，上次采样；nowMs: 本次采样时间。
// 返回 { rows, deltas, next }：rows 按程序名聚合，含速率；deltas 按程序名
// 的本次增量（供落库）；next 是下次用的 prev。
// 规则：累计值变小（PID 复用 / 会话重启）时，增量按当前累计值全算，
// 不算负数；dt<=0 时速率记 0。
function aggregate(totals, prev, nowMs) {
  prev = prev || new Map();
  const byName = new Map(); // name -> {name, rx, tx, rxRate, txRate, rxTotal, txTotal}
  const next = new Map();
  const dt = prev._t ? Math.max(0, (nowMs - prev._t) / 1000) : 0;
  for (const r of totals || []) {
    const pid = Number(r.pid), name = String(r.name || ('PID ' + pid));
    const rx = Math.max(0, Number(r.rx || 0) + Number(r.udpRx || 0));
    const tx = Math.max(0, Number(r.tx || 0) + Number(r.udpTx || 0));
    const old = prev.get(pid);
    let dRx = rx, dTx = tx;
    if (old && old.name === name) { dRx = rx >= old.rx ? rx - old.rx : rx; dTx = tx >= old.tx ? tx - old.tx : tx; }
    next.set(pid, { rx, tx, name });
    const cur = byName.get(name) || { name, rx: 0, tx: 0, rxRate: 0, txRate: 0, rxTotal: rx, txTotal: tx, dRx: 0, dTx: 0 };
    cur.rx += rx; cur.tx += tx; cur.rxTotal = cur.rx; cur.txTotal = cur.tx;
    cur.dRx += dRx; cur.dTx += dTx;
    cur.rxRate += dt > 0 ? dRx / dt : 0; cur.txRate += dt > 0 ? dTx / dt : 0;
    byName.set(name, cur);
  }
  next._t = nowMs;
  const rows = [...byName.values()].map((x) => ({ name: x.name, rx: x.rx, tx: x.tx, rxRate: x.rxRate, txRate: x.txRate, rxTotal: x.rxTotal, txTotal: x.txTotal }));
  rows.sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx));
  const deltas = [...byName.values()].map((x) => ({ proc: x.name, rx: x.dRx, tx: x.dTx })).filter((x) => x.rx > 0 || x.tx > 0);
  return { rows, deltas, next };
}

module.exports = { isAvailable, loadReason, start, stop, getTotals, getStatus, aggregate };
