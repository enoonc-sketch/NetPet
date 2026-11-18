const { contextBridge, ipcRenderer } = require('electron');
const ON = ['speed', 'sample', 'pstate', 'settings', 'goto', 'runtime', 'proc-traffic'];
const SEND = ['drag-start', 'drag-move', 'drag-end', 'pet-click', 'pet-dblclick', 'pet-menu', 'panel-open-main'];
const INVOKE = ['get-system', 'get-processes', 'get-adapters', 'get-records', 'export-csv', 'clear-records', 'clear-all', 'run-security', 'last-security', 'get-warnings', 'quick-scan',
  'get-settings', 'set-settings', 'get-achievements', 'get-growth', 'lock-status', 'unlock', 'set-password', 'set-runtime', 'get-runtime', 'open-taskmgr', 'open-data-dir', 'backup-db', 'ack-privacy', 'db-status', 'get-proc-traffic'];
contextBridge.exposeInMainWorld('netpet', {
  on: (ch, cb) => { if (ON.includes(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  send: (ch, d) => { if (SEND.includes(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch, d) => (INVOKE.includes(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('channel not allowed')))
});
