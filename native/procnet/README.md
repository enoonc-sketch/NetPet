# procnet — 按程序统计流量的原生组件（ETW）

只在 Windows 上编译、只在 Windows 上运行。Linux / macOS 下 JS 层会识别为
不可用，界面显示“仅支持 Windows”，不会报错、不会假装有数据。

## 它做什么、不做什么

- 做：启动一个 ETW 内核日志会话（会话名 `NetPet-ProcNet`，System Logger
  模式，只开 `EVENT_TRACE_FLAG_NETWORK_TCPIP`），收内核 TcpIp/UdpIp 的
  Send/Recv 事件，按 `EventHeader.ProcessId` 归因、按事件里的 `size`
  累加字节数，返回每个 PID 的累计收发字节（TCP + UDP 分开计）。
- 不做：不装驱动、不抓包、不读通信内容、不解密 TLS、不记录目的 IP/端口、
  不上传任何数据。事件里除了 PID 和 size，什么都不用。
- 需要管理员权限：启动内核 ETW 会话需要管理员权限。没有权限时
  `start()` 返回 `needs-admin`，NetPet 不自动提权、不弹窗索权，
  界面如实显示“需要管理员权限，当前无法统计”。

## 编译（Windows 真机）

```
cd native\procnet
build.bat
```

需要 Node.js + Python + Visual Studio 生成工具。成功后产物在
`native\procnet\build\Release\procnet.node`，随后在 NetPet 根目录跑
`build.bat` 打安装包，`package.json` 的 `build.files` 会把它打进去。

也可以手动：

```
npx node-gyp rebuild --target=37.2.0 --dist-url=https://electronjs.org/headers
```

Electron 版本变了要同步改 `--target` 和 `package.json` 里的 Electron 版本。

## 真机验证清单（必须做，沙箱里做不了）

1. 以管理员身份运行 NetPet（右键 → 以管理员身份运行），到隐私页打开
   “按程序统计流量（ETW）”，完整窗口 → 网络统计 → B 区应出现排行。
2. 用浏览器下一个大文件 / 看一段在线视频，同时打开资源监视器 → 网络 →
   “有网络活动的进程”，对比 NetPet 里该程序的下载速率和累计量：
   数量级应对得上（ETW 是每包计数，资源监视器是采样，两者不会完全
   相等，但不该差出一个数量级、也不该长期为 0）。
3. 看 B 区状态行里的 `事件数` 和 `解析失败`：
   - `解析失败` 持续增长，说明 `size` 偏移假设错了——停用该功能，
     把 `procnet.cpp` 里 `ParseSize` 的偏移、事件类型、UserData 长度
     记下来发给我，不要硬凑数字。
   - `事件数` 长期为 0 但网速不为 0，说明会话没收到事件（可能被别的
     ETW 工具占用了内核日志会话，或权限不足），看状态行的错误信息。
4. 非管理员运行一次：B 区应显示“需要管理员权限”，不弹 UAC、不崩溃，
   其他功能正常。
5. 关闭开关、退出 NetPet 后，用 `logman query -ets` 看不到残留的
   `NetPet-ProcNet` 会话；再开一次应能正常启动。
6. 退出后任务管理器里没有残留的 NetPet 进程。

## 已知限制

- 第一版只保证 TCP 计数可信；UDP 的提供方 GUID 未经核实，GUID 对不上
  时 UDP 事件会被忽略（不计入、不错算），界面会注明“UDP 可能未计入”。
- `size` 偏移是按内核事件常规布局假设的（IPv4 偏移 12、IPv6 偏移 36，
  超出 1..65535 丢弃并计数）。这是本组件唯一未经验证的假设，见
  `procnet.cpp` 文件头，校准前不要把数字当成精确账单。
- 短连接、已退出进程的流量会计入该程序名累计，但 PID 复用后累计值
  归零重计是按会话内累计做的，JS 层做了“累计值变小视为新进程”的处理。
- 高速下载时事件量很大，组件只在原生层做加法聚合，每 2 秒才向 JS
  推一次汇总，不会每包都过 IPC。
