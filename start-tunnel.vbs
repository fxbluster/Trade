Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\HP\TradeOS-v2"
WshShell.Run "cmd /c ""bin\cloudflared.exe tunnel --url http://127.0.0.1:3400 > tunnel.log 2>&1""", 0, False
