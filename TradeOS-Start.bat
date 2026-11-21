@echo off
title TradeOS v2 24/7 Autonomous Engine
cd /d "C:\Users\HP\TradeOS-v2"

echo ===================================================
echo   TradeOS v2 - 24/7 Autonomous Background Engine
echo ===================================================
echo.

:: 1. Check if server is already running and healthy on port 3400
curl -s --max-time 2 http://127.0.0.1:3400/api/health | findstr /i "ok" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] TradeOS Server is already active and healthy on port 3400.
    goto :open_cockpit
)

:: If port 3400 is listening but deadlocked/unhealthy, kill it
netstat -ano | findstr :3400 | findstr LISTENING >nul
if %ERRORLEVEL% equ 0 (
    echo [WARN] Port 3400 is hung. Cleaning up stale process...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3400 ^| findstr LISTENING') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 1 /nobreak >nul
)

echo [1/3] Starting TradeOS Server Supervisor (Continuous Background Engine)...
start "TradeOS-Engine" /min node run-supervisor.js

:: 2. Wait until server responds healthy
echo [2/3] Initializing market connections and indicators...
set /a retries=0
:wait_loop
timeout /t 1 /nobreak >nul
curl -s --max-time 2 http://127.0.0.1:3400/api/health | findstr /i "ok" >nul 2>&1
if %ERRORLEVEL% equ 0 goto :server_ready
set /a retries+=1
if %retries% geq 20 (
    echo [ERROR] Server took too long to start. Check server-daemon.log
    pause
    exit /b 1
)
goto :wait_loop

:server_ready
echo [OK] TradeOS Server is UP and healthy on http://127.0.0.1:3400!

:: 3. Launch Cloudflare Tunnel in background if not already running
tasklist | findstr /i "cloudflared.exe" >nul
if %ERRORLEVEL% neq 0 (
    echo [INFO] Starting Cloudflare Public Tunnel...
    start "TradeOS-Tunnel" /min cmd /c ""C:\Users\HP\TradeOS-v2\bin\cloudflared.exe" tunnel --url http://127.0.0.1:3400 > tunnel.log 2>&1"
)

:open_cockpit
:: 4. Open browser to local cockpit
echo [3/3] Opening TradeOS Cockpit in browser...
start http://127.0.0.1:3400

echo.
echo ===================================================
echo   TradeOS is now running continuously in background!
echo   Local Cockpit: http://127.0.0.1:3400
echo ===================================================
timeout /t 3 >nul
exit /b 0
