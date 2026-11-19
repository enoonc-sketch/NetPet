import { contextBridge, ipcRenderer } from 'electron';
const ON = ['speed', 'sample', 'pstate', 'settings', 'goto', 'runtime'];
const SEND = ['drag-start', 'drag-move', 'drag-end', 'pet-click', 'pet-dblclick', 'pet-menu', 'panel-open-main', 'pet-ready'];
const INVOKE = ['get-system', 'get-processes', 'get-adapters', 'get-records', 'export-csv', 'clear-records', 'clear-all', 'run-security', 'last-security', 'get-warnings', 'quick-scan',
  'get-settings', 'set-settings', 'get-achievements', 'get-growth', 'lock-status', 'unlock', 'set-password', 'set-runtime', 'get-runtime', 'get-pstate', 'exit-safe', 'open-taskmgr', 'open-data-dir', 'backup-db', 'ack-privacy', 'db-status',
  'reset-pet', 'get-pet-status', 'scan-junk', 'clean-junk'];
contextBridge.exposeInMainWorld('netpet', {
  on: (ch: string, cb: (d: any) => void) => { if (ON.includes(ch)) ipcRenderer.on(ch, (_e: any, d: any) => cb(d)); },
  send: (ch: string, d?: unknown) => { if (SEND.includes(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch: string, d?: unknown) => (INVOKE.includes(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('channel not allowed')))
});
