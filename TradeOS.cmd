@echo off
setlocal enabledelayedexpansion

:: Switch to repository root directory
cd /d "%~dp0"

echo ===================================================
echo   TradeOS v2 - Next-Gen Autonomous Trading Cockpit
echo ===================================================

:: 1. Verify Node.js is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found in PATH.
    echo Please install Node.js v24 or higher: https://nodejs.org/
    pause
    exit /b 1
)

:: 2. Verify Node.js version is v24+
for /f "tokens=1 delims=." %%a in ('node -v 2^>nul') do (
    set "NODE_RAW=%%a"
)
set "NODE_MAJOR=!NODE_RAW:v=!"

if not defined NODE_MAJOR (
    echo [ERROR] Could not detect Node.js version.
    pause
    exit /b 1
)

if !NODE_MAJOR! lss 24 (
    echo [ERROR] TradeOS v2 requires Node.js v24 or higher.
    echo Current version: !NODE_RAW!
    echo Please upgrade Node.js to v24+.
    pause
    exit /b 1
)

echo [OK] Node.js !NODE_RAW! verified.

:: 3. Ensure .env exists
if not exist ".env" (
    if exist ".env.example" (
        copy /y ".env.example" ".env" >nul
        echo [INFO] Created .env from .env.example
    )
)

:: 4. Check if TradeOS v2 server is already running on port 3400
curl -s http://127.0.0.1:3400/api/health | findstr /i "ok" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] TradeOS v2 backend is already active on 127.0.0.1:3400.
    goto :launch_browser
)

:: 5. Launch TradeOS v2 backend in background
echo [INFO] Starting TradeOS v2 server in background...
start "TradeOS v2 Backend" /min cmd /c "npm start > server.log 2>&1"

:: 6. Wait and poll health endpoint (up to 10 seconds)
echo [INFO] Waiting for 127.0.0.1:3400/api/health to become ready...
set "SERVER_READY=0"
for /l %%i in (1,1,10) do (
    ping -n 2 127.0.0.1 >nul
    curl -s http://127.0.0.1:3400/api/health | findstr /i "ok" >nul 2>&1
    if !errorlevel! equ 0 (
        set "SERVER_READY=1"
        goto :server_ready
    )
)

:server_ready
if "!SERVER_READY!" neq "1" (
    echo [ERROR] TradeOS v2 server failed to start within 10 seconds.
    echo Please check server.log for details:
    if exist "server.log" type "server.log"
    pause
    exit /b 1
)

echo [OK] Server listening on http://127.0.0.1:3400

:launch_browser
:: 7. Resolve Microsoft Edge executable or fallback to default browser
set "EDGE_EXE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) else (
    for /f "tokens=*" %%e in ('where msedge 2^>nul') do set "EDGE_EXE=%%e"
)

if defined EDGE_EXE (
    echo [INFO] Launching Cockpit in Microsoft Edge app mode...
    start "" "!EDGE_EXE!" --app=http://127.0.0.1:3400 --window-size=1600,1000
) else (
    echo [INFO] Microsoft Edge not found in standard paths. Launching default browser...
    start http://127.0.0.1:3400
)

echo ===================================================
echo [OK] TradeOS v2 launched successfully!
echo Web UI: http://127.0.0.1:3400
echo ===================================================
exit /b 0
