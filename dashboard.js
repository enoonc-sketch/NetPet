const $ = (s) => document.querySelector(s), api = window.netpet.invoke;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (b) => b < 1024 ? Math.round(b) + ' B/s' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s';
const sz = (b) => b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(0) + ' MB' : (b / 1073741824).toFixed(1) + ' GB';
let tab = 'ov', hx = Array(60).fill(0), ht = Array(60).fill(0);
function go(t) {
  tab = t;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === t));
  if (t === 'ov') loadOv();
  if (t === 'set') loadSet();
}
$('#nav').onclick = (e) => { if (e.target.dataset.t) go(e.target.dataset.t); };
window.netpet.on('goto', go);
function draw() {
  const c = $('#chart'), r = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  c.width = w * r; c.height = h * r;
  const x = c.getContext('2d'); x.scale(r, r);
  const max = Math.max(1024, ...hx, ...ht) * 1.15;
  const line = (a, col) => {
    x.beginPath(); a.forEach((v, i) => { const px = i / 59 * w, py = h - v / max * (h - 6) - 3; i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.strokeStyle = col; x.lineWidth = 2; x.lineJoin = 'round'; x.stroke();
    x.lineTo(w, h); x.lineTo(0, h); x.closePath(); x.globalAlpha = .12; x.fillStyle = col; x.fill(); x.globalAlpha = 1;
  };
  line(hx, '#3FBF9B'); line(ht, '#8E76E8');
  x.fillStyle = '#8C7F8A'; x.font = '11px sans-serif'; x.fillText(fmt(max), 4, 12);
}
window.netpet.on('speed', ({ rx, tx }) => {
  hx.push(rx); hx.shift(); ht.push(tx); ht.shift();
  $('#vrx').textContent = fmt(rx); $('#vtx').textContent = fmt(tx);
  if (tab === 'ov') draw();
});
async function loadOv() {
  const s = await api('get-stats');
  $('#traffic').innerHTML = '<div>今天  <span class="d">↓ ' + sz(s.today.rx) + '</span>  <span class="u">↑ ' + sz(s.today.tx) + '</span></div><div style="margin-top:8px">本月  <span class="d">↓ ' + sz(s.month.rx) + '</span>  <span class="u">↑ ' + sz(s.month.tx) + '</span></div>';
}
$('#taskmgr').onclick = async () => {
  const r = await api('open-task-manager');
  if (!r.ok) alert(r.msg || '打开失败');
};
const SK = { peach: '#FFC9A8', mint: '#BDEBD7', lavender: '#D9CCFA' };
async function loadSet() {
  const s = await api('get-settings');
  $('#s-mon').checked = s.monitoring; $('#s-dnd').checked = s.dnd;
  $('#s-auto').checked = s.autostart; $('#s-top').checked = s.alwaysOnTop;
  $('#s-keep').value = s.retentionDays;
  $('#pkgnote').textContent = s.packaged ? '' : '当前是开发模式，请用打包后的安装版开启自启';
  $('#datadir').textContent = s.userData || '';
  $('#skins').innerHTML = Object.entries(SK).map(([k, c]) => '<button data-k="' + k + '" class="' + (k === s.skin ? 'on' : '') + '" style="background:' + c + '"></button>').join('');
}
$('#s-mon').onchange = (e) => api('set-settings', { monitoring: e.target.checked });
$('#s-dnd').onchange = (e) => api('set-settings', { dnd: e.target.checked });
$('#s-auto').onchange = (e) => api('set-settings', { autostart: e.target.checked });
$('#s-top').onchange = (e) => api('set-settings', { alwaysOnTop: e.target.checked });
$('#s-keep').onchange = (e) => api('set-settings', { retentionDays: Number(e.target.value) });
$('#skins').onclick = async (e) => { if (e.target.dataset.k) { await api('set-settings', { skin: e.target.dataset.k }); loadSet(); } };
$('#s-clear').onclick = async () => {
  if (!confirm('确定清空流量统计吗？这个操作不能撤销。')) return;
  await api('clear-traffic'); loadOv();
};
window.netpet.on('status', () => { if (tab === 'set') loadSet(); });
loadOv();
addEventListener('resize', () => { if (tab === 'ov') draw(); });
