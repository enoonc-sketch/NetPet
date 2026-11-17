// V0.1 本地存储：只存聚合流量（今日/本月/峰值），不存连接记录、不存逐程序数据。
// 全部只在本机，不联网。
const fs = require('fs');
const path = require('path');
let dir = '';
let traffic = { days: {}, peakRx: 0, first: Date.now() };
let dirty = false;

const day = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function init(d) {
  dir = d;
  fs.mkdirSync(dir, { recursive: true });
  try { traffic = { ...traffic, ...JSON.parse(fs.readFileSync(path.join(dir, 'traffic.json'), 'utf8')) }; } catch (_) {}
  setInterval(flush, 30000);
}
function flush() {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(path.join(dir, 'traffic.json'), JSON.stringify(traffic)); } catch (_) {}
}
function addTraffic(rx, tx) {
  const k = day();
  const d = traffic.days[k] || (traffic.days[k] = { rx: 0, tx: 0 });
  d.rx += rx; d.tx += tx;
  if (rx > traffic.peakRx) traffic.peakRx = rx;
  dirty = true;
}
function prune(keepDays) {
  const limit = day(Date.now() - keepDays * 864e5);
  for (const k of Object.keys(traffic.days)) {
    if (k < limit) delete traffic.days[k];
  }
  dirty = true; flush();
}
function clear() {
  traffic.days = {}; traffic.peakRx = 0; dirty = true; flush();
}
function today() { return traffic.days[day()] || { rx: 0, tx: 0 }; }
function month() {
  const p = day().slice(0, 7);
  let rx = 0, tx = 0;
  for (const [k, v] of Object.entries(traffic.days)) if (k.startsWith(p)) { rx += v.rx; tx += v.tx; }
  return { rx, tx };
}
function stats() {
  let total = 0;
  for (const v of Object.values(traffic.days)) total += v.rx + v.tx;
  return { total, peakRx: traffic.peakRx, daysUsed: Object.keys(traffic.days).length };
}
module.exports = { init, flush, addTraffic, prune, clear, today, month, stats };
