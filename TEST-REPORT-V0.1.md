# NetPet V0.1 测试报告（2026-11-17，本地 Linux 校验）

## 通过的检查

1. **语法**：`node --check` 全部通过 — main.js、preload.js、store.js、pet.js、dashboard.js（5/5）
2. **禁查 grep，零命中**：`process.kill`、`dns.reverse`、`ExecutionPolicy`、`Start-MpScan`、`BAD_PORTS`、`suspicious`、`unsafe-inline`、`get-processes`、`kill-process`、`get-records`、`run-security`、`quick-scan`、`security.js` — 在 `*.js / *.html / *.json` 中 0 命中
3. **无外部请求**：`http://`、`https://`、`fetch(`、`telemetry`、`WebSocket` — 在 `*.js / *.html` 中 0 命中
4. **CSP**：两页均为 `default-src 'self'; style-src 'self'; script-src 'self'`，无 `unsafe-inline`
5. **版本**：`package.json` version 0.1.0；`win.icon` 为 `assets/icon.ico`（已从 64×64 icon.png 生成，多尺寸）
6. **store 冒烟测试**（`node -e`，`/tmp/netpet-v01-test2`）：
   - `addTraffic(1024,512)` + `addTraffic(2048,0)` 后 `today = {rx:3072, tx:512}`，`month` 相同，`stats = {total:3584, peakRx:2048, daysUsed:1}`
   - `flush()` 后 `traffic.json` 存在；`clear()` 后 `today = {rx:0, tx:0}`
7. **Electron 加固**：两窗口 `webPreferences` 显式写 `contextIsolation:true, nodeIntegration:false`；`preload` 的 `invoke` 只有 5 个白名单通道（`get-stats / get-settings / set-settings / clear-traffic / open-task-manager`），`set-settings` 校验类型与取值范围

## V0.1 检查清单（对照规范 §11）

- [x] 宠物窗口（170×160 含气泡，透明 `backgroundColor '#00000000'`、无边框）
- [x] 实时网速（`networkStats('*')` 合计，1 秒一次，负值钳制为 0）
- [x] 拖动（拖动 >4px 移动，<4px 视为点击打开面板）
- [x] 透明背景
- [x] 系统托盘（显示/隐藏、打开面板、暂停/恢复监控、勿扰模式、开机自启、始终置顶、设置、退出）
- [x] 开机自启（默认关，用户勾选才 `setLoginItemSettings`）
- [x] 暂停监控、勿扰模式（托盘 + 设置页双入口）
- [x] 隐私页写明监控内容、存储位置、停止/删除方法

## 未验证、须在真机 Windows 上做的事

- `npm install` + `npm start` 真机启动、宠物显示、拖动、托盘菜单、断网/恢复通知
- `npm run dist` 打 NSIS 安装包、安装、开机自启、卸载（本机为 Linux，未跑安装器；也未跑 Electron 本体）
- 透明窗口在真机上无黑色背景、无多余滚动区
- `taskmgr.exe` 按钮真机打开

## 明确不做的（V0.1 范围外）

结束进程、上网记录、反向解析、系统体检、Defender 扫描、安全评分、GPU/温度面板。见 `NetPet-规范-V1.1-修订版.md`。
