Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Token Speed Tester - WebGUI 启动脚本" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] 首次运行，正在使用 pnpm 安装依赖..." -ForegroundColor Yellow
    pnpm install
}

Write-Host "[INFO] 正在启动 WebGUI 服务 (默认端口: http://localhost:3000)..." -ForegroundColor Green
pnpm web
