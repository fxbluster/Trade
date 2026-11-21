@echo off
title Stop TradeOS v2
cd /d "C:\Users\HP\TradeOS-v2"

echo Stopping TradeOS processes...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3400 ^| findstr LISTENING') do (
    echo Terminating PID %%a listening on 3400...
    taskkill /F /PID %%a >nul 2>&1
)

taskkill /F /FI "WINDOWTITLE eq TradeOS-Engine*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq TradeOS-Tunnel*" >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1

echo TradeOS has been stopped cleanly.
timeout /t 2 >nul
exit
