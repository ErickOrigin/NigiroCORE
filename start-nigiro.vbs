Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\NigiroProject\project_NigiroCORE\server"
WshShell.Run "cmd /c node server.js", 0, False
WScript.Sleep 3000
WshShell.Run "http://localhost:3000", 1, False
