Option Explicit

Dim shell, fso, scriptDir
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
shell.CurrentDirectory = scriptDir

Const LOCAL_URL  = "http://localhost:3000"
Const PUBLIC_URL = "https://moonwolf.serveousercontent.com"

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
' Comprobar localhost (igual que start.vbs)
' ============================================================
Function LocalWorks()
    Dim http

    LocalWorks = False

    On Error Resume Next

    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", LOCAL_URL & "/api/health", False
    http.Send

    If Err.Number = 0 Then
        If http.Status = 200 Then LocalWorks = True
    End If

    Err.Clear
    On Error GoTo 0
End Function

' ============================================================
' Comprobar Serveo (igual que start.vbs)
' ============================================================
Function PublicWorks()
    Dim http

    PublicWorks = False

    On Error Resume Next

    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", PUBLIC_URL & "/api/health", False
    http.setRequestHeader "serveo-skip-browser-warning", "true"
    http.Send

    If Err.Number = 0 Then
        If http.Status = 200 Then PublicWorks = True
    End If

    Err.Clear
    On Error GoTo 0
End Function

' ============================================================
' 1. Matar Node y el túnel de este panel (si están corriendo)
' ============================================================
KillPanelNode
KillPanelTunnel

' Pequeña espera para que Windows libere el puerto 3000 y la
' sesión SSH quede totalmente cerrada antes de relanzar.
WScript.Sleep 1500

' ============================================================
' 2. Relanzar todo con start.vbs: arranca Node, levanta el túnel,
'    abre el navegador y deja el supervisor corriendo en segundo
'    plano (esto no bloquea — start.vbs corre en su propio proceso).
' ============================================================
shell.Run "wscript.exe """ & scriptDir & "\start.vbs""", 0, False

' ============================================================
' 3. Esperar a que todo responda y avisar con un mensaje
' ============================================================
Dim i, localOk, publicOk

localOk = False
For i = 1 To 30
    WScript.Sleep 500
    If LocalWorks() Then
        localOk = True
        Exit For
    End If
Next

If Not localOk Then
    MsgBox "❌ No se pudo reiniciar el panel: Node no respondió a tiempo." & vbCrLf & _
           "Revisa la consola de start.vbs por si hay un error (por ejemplo, falta PANEL_PASSWORD en el .env).", _
           vbCritical, "MoonWolf Panel"
    WScript.Quit 1
End If

publicOk = False
For i = 1 To 20
    WScript.Sleep 1000
    If PublicWorks() Then
        publicOk = True
        Exit For
    End If
Next

If publicOk Then
    MsgBox "✅ Panel reiniciado correctamente." & vbCrLf & "Node y el túnel están arriba.", vbInformation, "MoonWolf Panel"
Else
    MsgBox "⚠ Node está arriba, pero el túnel público todavía no responde." & vbCrLf & _
           "Puede tardar unos segundos más, o Serveo puede estar teniendo problemas — el supervisor de start.vbs seguirá intentándolo solo.", _
           vbExclamation, "MoonWolf Panel"
End If
