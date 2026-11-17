' start-nigiro-debug.vbs - start NigiroCore with visible console (Ctrl+C to stop)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\NigiroProject\project_NigiroCORE\server"
WshShell.Run "cmd /k node server.js", 1, False
