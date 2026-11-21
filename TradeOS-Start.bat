@echo off
title TradeOS v2 24/7 Background Engine
cd /d "C:\Users\HP\TradeOS-v2"

echo ===================================================
echo   TradeOS v2 - 24/7 Autonomous Background Engine
echo ===================================================
echo.

:: 1. Check if server is already running on port 3400
netstat -ano | findstr :3400 | findstr LISTENING >nul
if %ERRORLEVEL% equ 0 (
    echo [INFO] TradeOS Server is ALREADY running on port 3400.
    echo [INFO] Opening Cockpit HUD in browser...
    start http://127.0.0.1:3400
    exit /b 0
)

echo [1/3] Starting TradeOS Server Supervisor (Auto-restart enabled)...
start "TradeOS-Engine" /min node run-supervisor.js

:: 2. Wait until server is listening on port 3400
echo [2/3] Waiting for TradeOS Engine to initialize...
:wait_loop
timeout /t 1 /nobreak >nul
netstat -ano | findstr :3400 | findstr LISTENING >nul
if %ERRORLEVEL% neq 0 goto wait_loop

echo [OK] TradeOS Server is UP and healthy on http://127.0.0.1:3400!

:: 3. Launch Cloudflare Tunnel in background if not already running
tasklist | findstr /i "cloudflared.exe" >nul
if %ERRORLEVEL% neq 0 (
    echo [INFO] Starting Cloudflare Tunnel...
    start "TradeOS-Tunnel" /min "C:\Users\HP\TradeOS-v2\bin\cloudflared.exe" tunnel --protocol http2 --url http://127.0.0.1:3400
)

:: 4. Open browser
echo [3/3] Opening TradeOS Cockpit in your browser...
start http://127.0.0.1:3400

echo.
echo ===================================================
echo   TradeOS is now running continuously in background!
echo   Auto-Pilot and multi-timeframe engines are LIVE.
echo ===================================================
timeout /t 3 >nul
exit
