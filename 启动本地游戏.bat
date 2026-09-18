@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=8086"
set "ENTRY=start-screen-noST.html"

echo.
echo  ==========================================================
echo   瀚海归义录 - 本地启动
echo  ==========================================================
echo.
echo   游戏地址: http://127.0.0.1:%PORT%/%ENTRY%
echo   请保持本窗口开启，关闭窗口或按 Ctrl+C 即停止本地服务。
echo   如端口被占用，请修改本文件顶部 PORT 后重试。
echo.

start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/%ENTRY%'"

where python >nul 2>nul
if not errorlevel 1 (
    python -m http.server %PORT% --bind 127.0.0.1
    goto :done
)

where py >nul 2>nul
if not errorlevel 1 (
    py -3 -m http.server %PORT% --bind 127.0.0.1
    goto :done
)

echo.
echo  [错误] 未找到 Python。请安装 Python 3 后重试。
echo.

:done
pause
