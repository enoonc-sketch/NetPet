import { contextBridge, ipcRenderer } from 'electron';
// 白名单：渲染页只能用下面列出的通道；主进程还会再校验来源窗口、密码锁和参数。
const ON = ['speed', 'sample', 'pstate', 'settings', 'goto', 'runtime', 'vpn', 'focus'];
const SEND = ['drag-start', 'drag-move', 'drag-end', 'pet-click', 'pet-dblclick', 'pet-menu', 'panel-open-main', 'pet-ready'];
const INVOKE = ['get-system', 'get-processes', 'get-adapters', 'get-records', 'export-csv', 'clear-records', 'clear-all', 'run-security', 'last-security', 'get-warnings', 'quick-scan',
  'get-settings', 'set-settings', 'get-achievements', 'get-growth', 'lock-status', 'unlock', 'set-password', 'set-runtime', 'get-runtime', 'get-pstate', 'exit-safe', 'open-taskmgr', 'open-data-dir', 'backup-db', 'ack-privacy', 'db-status',
  'reset-pet', 'get-pet-status', 'scan-junk', 'clean-junk', 'list-startup', 'set-startup', 'show-startup-file', 'open-taskmgr-startup', 'vpn-status', 'vpn-start', 'vpn-stop', 'vpn-pick', 'vpn-set', 'check-updates', 'last-updates', 'open-winupdate', 'trim-mem', 'last-trim', 'export-diag', 'check-self-update', 'last-self-update', 'open-release',
  'get-traffic-report', 'export-settings', 'import-settings',
  // 1.5.0
  'get-lang', 'focus-get', 'focus-ctl', 'focus-history', 'get-hw-history', 'weekly-list', 'weekly-regen', 'get-wardrobe',
  'drv-scan', 'drv-online', 'drv-last-online', 'open-optional-updates', 'open-devmgmt',
  'disk-analyze', 'disk-frag', 'disk-optimize', 'disk-cancel', 'disk-state', 'open-dfrgui',
  'power-status', 'power-set-plan', 'power-cool', 'power-restore',
  'def-status', 'def-threats', 'def-scan', 'def-pick', 'def-stop', 'def-state', 'def-update', 'open-def-history',
  'pm-list', 'pm-detail', 'pm-kill', 'pm-priority', 'pm-services', 'pm-perf', 'pm-reveal', 'mem-status', 'mem-runs'];
contextBridge.exposeInMainWorld('netpet', {
  // 1.4.0：返回取消订阅函数。旧版没有办法移除监听，页面组件每挂载一次就多一个监听（VPN 页反复进出会越积越多）。
  on: (ch: string, cb: (d: any) => void) => {
    if (!ON.includes(ch) || typeof cb !== 'function') return () => {};
    const h = (_e: any, d: any) => cb(d);
    ipcRenderer.on(ch, h);
    return () => { ipcRenderer.removeListener(ch, h); };
  },
  send: (ch: string, d?: unknown) => { if (SEND.includes(ch)) ipcRenderer.send(ch, d); },
  invoke: (ch: string, d?: unknown) => (INVOKE.includes(ch) ? ipcRenderer.invoke(ch, d) : Promise.reject(new Error('channel not allowed')))
});
