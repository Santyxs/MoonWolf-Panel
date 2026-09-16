Option Explicit

Dim shell, fso, scriptDir
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
shell.CurrentDirectory = scriptDir

Const LOCAL_URL = "http://localhost:3000"
Const PUBLIC_URL = "https://moonwolf.serveousercontent.com"

' ============================================================
' Iniciar proceso oculto
' ============================================================
Sub StartHidden(command)
    shell.Run "cmd /c " & command, 0, False
End Sub

' ============================================================
' Comprobar si Node.js está ejecutándose
' ============================================================
Function NodeRunning()
    Dim svc, processes, p

    NodeRunning = False

    On Error Resume Next

    Set svc = GetObject("winmgmts:\\.\root\cimv2")
    Set processes = svc.ExecQuery("SELECT Name, CommandLine FROM Win32_Process WHERE Name='node.exe'")

    For Each p In processes
        If InStr(1, p.CommandLine, "server.js", vbTextCompare) > 0 Then
            NodeRunning = True
            Exit For
        End If
    Next

    Err.Clear
    On Error GoTo 0
End Function

' ============================================================
' Comprobar si nuestro SSH de Serveo está ejecutándose
' ============================================================
Function TunnelProcessRunning()
    Dim svc, processes, p

    TunnelProcessRunning = False

    On Error Resume Next

    Set svc = GetObject("winmgmts:\\.\root\cimv2")
    Set processes = svc.ExecQuery("SELECT Name, CommandLine FROM Win32_Process WHERE Name='ssh.exe'")

    For Each p In processes
        If InStr(1, p.CommandLine, "serveo.net", vbTextCompare) > 0 _
        And InStr(1, p.CommandLine, "moonwolf:80:localhost:3000", vbTextCompare) > 0 Then
            TunnelProcessRunning = True
            Exit For
        End If
    Next

    Err.Clear
    On Error GoTo 0
End Function

' ============================================================
' Iniciar Node
' ============================================================
Sub StartNode()
    If Not NodeRunning() Then
        StartHidden "node server.js >nul 2>&1"
    End If
End Sub

' ============================================================
' Iniciar túnel Serveo
' ============================================================
Sub StartTunnel()
    If Not TunnelProcessRunning() Then
        StartHidden "ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R moonwolf:80:localhost:3000 serveo.net >nul 2>&1"
    End If
End Sub

' ============================================================
' Comprobar localhost
' ============================================================
Function LocalWorks()
    Dim http

    LocalWorks = False

    On Error Resume Next

    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", LOCAL_URL & "/api/files", False
    http.Send

    If Err.Number = 0 Then
        If http.Status = 200 Then LocalWorks = True
    End If

    Err.Clear
    On Error GoTo 0
End Function

' ============================================================
' Comprobar Serveo
' ============================================================
Function PublicWorks()
    Dim http

    PublicWorks = False

    On Error Resume Next

    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", PUBLIC_URL & "/api/files", False
    http.setRequestHeader "serveo-skip-browser-warning", "true"
    http.Send

    If Err.Number = 0 Then
        If http.Status = 200 Then PublicWorks = True
    End If

    Err.Clear
    On Error GoTo 0
End Function

' ============================================================
' 1. Dependencias
' ============================================================
If Not fso.FolderExists(scriptDir & "\node_modules") Then
    shell.Run "cmd /c npm install --silent >nul 2>&1", 0, True
End If

' ============================================================
' 2. Arrancar Node
' ============================================================
StartNode

' ============================================================
' 3. Esperar a Node
' ============================================================
Dim i
For i = 1 To 30
    WScript.Sleep 500
    If LocalWorks() Then Exit For
Next

If Not LocalWorks() Then
    MsgBox "MoonWolf Panel no pudo iniciar server.js.", vbCritical, "MoonWolf Panel"
    WScript.Quit 1
End If

' ============================================================
' 4. Arrancar Serveo
' ============================================================
StartTunnel

' ============================================================
' 5. Esperar al túnel
' ============================================================
For i = 1 To 20
    WScript.Sleep 1000

    If PublicWorks() Then
        Exit For
    End If

    ' Si SSH murió durante el arranque, volver a lanzarlo
    If Not TunnelProcessRunning() Then
        StartTunnel
    End If
Next

' ============================================================
' 6. Abrir MoonWolf
' ============================================================
shell.Run PUBLIC_URL, 1, False

' ============================================================
' 7. Supervisor permanente
' ============================================================
Do
    WScript.Sleep 30000

    ' Si Node se cae, volver a iniciarlo
    If Not NodeRunning() Then
        StartNode

        For i = 1 To 20
            WScript.Sleep 500
            If LocalWorks() Then Exit For
        Next
    End If

    ' Si el SSH se cae, volver a iniciarlo
    If Not TunnelProcessRunning() Then
        StartTunnel

    ' Si SSH existe pero el túnel no responde, esperar/reiniciar
    ElseIf Not PublicWorks() Then

        ' No matamos todos los ssh.exe del equipo:
        ' solo intentamos localizar nuestro túnel.
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

        WScript.Sleep 1000
        StartTunnel
    End If

Loop
