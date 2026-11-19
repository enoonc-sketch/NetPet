# NetPet 1.3.2

Windows 桌面智能宠物：用 3D 小宠物显示网速和电脑状态。**本地运行、本地存储，不上传任何数据。**

## 界面截图

![概览](https://github.com/enoonc-sketch/NetPet/releases/download/v1.3.1/netpet-1.3.1-overview.png)
![网络统计](https://github.com/enoonc-sketch/NetPet/releases/download/v1.3.1/netpet-1.3.1-network.png)
![系统健康](https://github.com/enoonc-sketch/NetPet/releases/download/v1.3.1/netpet-1.3.1-health.png)
![宠物](https://github.com/enoonc-sketch/NetPet/releases/download/v1.3.1/netpet-1.3.1-pets.png)
![隐私](https://github.com/enoonc-sketch/NetPet/releases/download/v1.3.1/netpet-1.3.1-privacy.png)
![设置](https://github.com/enoonc-sketch/NetPet/releases/download/v1.3.1/netpet-1.3.1-settings.png)

（截图为 v1.3.1 的界面；1.3.2 新增的“系统清理”页和“一键复位”尚未截图。）

## 运行 / 打包
```
双击 build.bat        （一键安装依赖并打包；网络慢用 build-cn.bat）
npm install && npm start   （开发运行）
npm test                    （状态机与数据库单元测试）
npm run typecheck           （TypeScript 类型检查）
```
详细文档见 `docs/`：使用说明、技术架构、测试报告（含尚未在 Windows 实测的部分）。

## v1.3.2 新增
- **宠物防消失**：位置钳制到当前显示器（拖动/启动/显示器变化/每 10 秒看门狗）、渲染进程崩溃自动重建、WebGL 丢失退回 emoji、托盘单击不再误隐藏、全屏检测防抖 + 子进程自愈。
- **一键复位小宠物**：托盘菜单 / 右键菜单 / 主面板设置页 / 小面板，位置回主屏右下角并恢复显示，不动宠物种类和数据。
- **系统垃圾清理**：主面板 → 系统清理，白名单扫描 + 勾选确认后删除（临时文件、浏览器缓存、崩溃转储、回收站等），不碰文档/下载/桌面。

## 3D 小宠物（v1.1）
共 18 只：猫咪、小狗、兔兔、小熊、熊猫、狐狸、小老虎、小猪、仓鼠、小鸡、小鸭、企鹅、青蛙、小恐龙、独角兽、史莱姆、小幽灵、机器人。
切换方式：右键小宠物/托盘图标 → 切换宠物；或 面板 → 设置 → 选择小宠物。
所有造型都是代码用基础几何体搭出来的，不需要模型文件，也不联网。如果显卡不支持 WebGL，会自动退回 2D 小猫。

### 改造型 / 加新宠物（可选）
1. `src/shared/petlist.ts` 加一行；`src/renderer/pets3d.ts` 的 `SPEC` 里加一份造型参数
2. 运行 `npm run build`（3D 宠物代码会一起打包）
