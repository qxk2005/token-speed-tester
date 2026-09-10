@echo off
chcp 65001 >nul
echo ========================================================
echo   Token Speed Tester - WebGUI 启动脚本
echo ========================================================
echo.

if not exist node_modules (
    echo [INFO] 首次运行，正在使用 pnpm 安装依赖...
    call pnpm install
)

echo [INFO] 正在启动 WebGUI 服务 (默认端口: http://localhost:3000)...
call pnpm web
pause
