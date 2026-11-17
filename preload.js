const { contextBridge, ipcRenderer } = require('electron');
const ON = ['speed', 'status', 'settings', 'goto'];
const SEND = ['drag-start', 'drag-move', 'pet-click', 'pet-menu'];
const INVOKE = ['get-stats', 'get-settings', 'set-settings', 'clear-traffic', 'open-task-manager'];
contextBridge.exposeInMainWorld('netpet', {
  on: (ch, cb) => { if (ON.includes(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  send: (ch, d) => { if (SEND.includes(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch, d) => {
    if (!INVOKE.includes(ch)) return Promise.reject(new Error('unknown channel: ' + String(ch)));
    return ipcRenderer.invoke(ch, d);
  }
});
