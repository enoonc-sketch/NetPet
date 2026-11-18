@echo off
chcp 65001 >nul
cd /d "%~dp0"
set CSC_IDENTITY_AUTO_DISCOVERY=false
echo [1/3] 安装依赖...
call npm install || goto :fail
echo [2/3] 打包安装程序...
call npm run dist || goto :fail
echo [3/3] 完成！安装包在 dist 文件夹里。
start "" dist
pause
exit /b 0
:fail
echo.
echo 打包失败了。请把上面的红色报错截图或复制发给我。
echo 如果是下载超时/网络错误，请改用 build-cn.bat（使用国内镜像）。
pause
exit /b 1
