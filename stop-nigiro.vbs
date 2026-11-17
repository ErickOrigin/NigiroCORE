' stop-nigiro.vbs - stop NigiroCore server silently
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
For Each p In wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'")
    If InStr(p.CommandLine, "server.js") > 0 Then
        p.Terminate
    End If
Next
