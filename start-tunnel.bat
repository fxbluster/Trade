@echo off
title TradeOS v2 - Cloudflare Secure Tunnel
echo ========================================================
echo   Starting TradeOS v2 Cloudflare Secure Tunnel...
echo ========================================================
cd /d "%~dp0"
bin\cloudflared.exe tunnel --url http://127.0.0.1:3400
pause
