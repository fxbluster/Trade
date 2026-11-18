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

:: 3. Launch TradeOS v2 backend in background
echo [INFO] Starting TradeOS v2 server in background...
start "TradeOS v2 Backend" /min cmd /c "npm start"

:: 4. Wait 2 seconds for server health endpoint
echo [INFO] Waiting 2 seconds for 127.0.0.1:3400/api/health...
timeout /t 2 /nobreak >nul

:: Optional verification ping
curl -s http://127.0.0.1:3400/api/health >nul 2>&1

:: 5. Launch Microsoft Edge in App Mode
echo [INFO] Launching Cockpit in Microsoft Edge app mode...
start msedge --app=http://127.0.0.1:3400 --window-size=1600,1000

echo [OK] TradeOS v2 launched successfully.
exit /b 0
