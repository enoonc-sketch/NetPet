const pet = document.getElementById('pet'), bubble = document.getElementById('bubble');
const SKINS = { peach: ['#FFC9A8', '#FFB48A'], mint: ['#BDEBD7', '#9FDCC2'], lavender: ['#D9CCFA', '#C3B1F3'] };
let monitoring = true, cur = 'sleep';
const fmt = (b) => b < 1024 ? Math.round(b) + ' B/s' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB/s' : (b / 1048576).toFixed(1) + ' MB/s';
const mood = (t) => t < 2048 ? 'sleep' : t < 204800 ? 'idle' : t < 3145728 ? 'happy' : 'rush';
const render = () => { pet.className = 'pet ' + cur; };
window.netpet.on('speed', ({ rx, tx }) => {
  bubble.innerHTML = '<span class="d">↓ ' + fmt(rx) + '</span><br><span class="u">↑ ' + fmt(tx) + '</span>';
  if (monitoring) { cur = mood(rx + tx); render(); }
});
window.netpet.on('status', (s) => {
  if (s && typeof s.monitoring === 'boolean') {
    monitoring = s.monitoring;
    if (!monitoring) { bubble.innerHTML = '<span class="d">已暂停监控</span>'; cur = 'idle'; render(); }
  }
});
window.netpet.on('settings', ({ skin }) => {
  const c = SKINS[skin] || SKINS.peach;
  document.documentElement.style.setProperty('--body', c[0]);
  document.documentElement.style.setProperty('--ear', c[1]);
});
let drag = null;
pet.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false };
  window.netpet.send('drag-start');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) window.netpet.send('drag-move', { dx, dy });
});
window.addEventListener('mouseup', () => { if (drag && !drag.moved) window.netpet.send('pet-click'); drag = null; });
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.netpet.send('pet-menu'); });
