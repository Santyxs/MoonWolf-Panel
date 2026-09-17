Option Explicit

Dim shell, fso, scriptDir
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
shell.CurrentDirectory = scriptDir

' ============================================================
' Matar el Node de este panel (identificado por "server.js" en
' su línea de comandos, mismo criterio que NodeRunning() en
' start.vbs — no toca otros procesos node.exe que tengas abiertos)
' ============================================================
Sub KillPanelNode()
    Dim svc, processes, p

    On Error Resume Next

    Set svc = GetObject("winmgmts:\\.\root\cimv2")
    Set processes = svc.ExecQuery("SELECT Name, CommandLine FROM Win32_Process WHERE Name='node.exe'")

    For Each p In processes
        If InStr(1, p.CommandLine, "server.js", vbTextCompare) > 0 Then
            p.Terminate()
        End If
    Next

    Err.Clear
    On Error GoTo 0
End Sub

' ============================================================
' Matar el túnel SSH de Serveo de este panel (mismo criterio que
' usa el supervisor de start.vbs — no toca otros túneles SSH que
' tengas abiertos para otra cosa)
' ============================================================
Sub KillPanelTunnel()
    Dim svc, processes, p

    On Error Resume Next

    Set svc = GetObject("winmgmts:\\.\root\cimv2")
    Set processes = svc.ExecQuery("SELECT Name, CommandLine FROM Win32_Process WHERE Name='ssh.exe'")

    For Each p In processes
        If InStr(1, p.CommandLine, "serveo.net", vbTextCompare) > 0 _
        And InStr(1, p.CommandLine, "moonwolf:80:localhost:3000", vbTextCompare) > 0 Then
            p.Terminate()
        End If
    Next

    Err.Clear
    On Error GoTo 0
End Sub

' ============================================================
' 1. Matar Node y el túnel de este panel (si están corriendo)
' ============================================================
KillPanelNode
KillPanelTunnel

' Pequeña espera para que Windows libere el puerto 3000 y la
' sesión SSH quede totalmente cerrada antes de relanzar.
WScript.Sleep 1500

' ============================================================
' 2. Relanzar todo con start.vbs: arranca Node, espera a que
'    responda /api/health, levanta el túnel, espera a que
'    responda también en público, abre el navegador y deja el
'    supervisor corriendo en segundo plano.
' ============================================================
shell.Run "wscript.exe """ & scriptDir & "\start.vbs""", 0, False
