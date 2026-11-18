@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [NetPet procnet] 正在为当前 Electron 编译原生组件（仅 Windows）...
echo 需要：Node.js、Python、Visual Studio 生成工具（node-gyp）。
call npx --yes node-gyp rebuild --target=37.2.0 --dist-url=https://electronjs.org/headers
if errorlevel 1 (
  echo.
  echo 编译失败。请把上面的红色报错发给我。
  echo 常见原因：没有安装 Visual Studio 生成工具，或网络无法下载 Electron 头文件。
  pause
  exit /b 1
)
echo.
echo 完成：build\Release\procnet.node
echo 随后在 NetPet 根目录运行 build.bat 打包，安装包会带上这个文件。
pause
