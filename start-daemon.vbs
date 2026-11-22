Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\HP\TradeOS-v2"
WshShell.Run "node run-supervisor.js", 0, False
