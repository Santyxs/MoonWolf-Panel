Dim objShell, objFSO, strPath
Set objShell = CreateObject("WScript.Shell")
Set objFSO   = CreateObject("Scripting.FileSystemObject")

strPath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
objShell.CurrentDirectory = strPath

Const SERVER_URL = "http://localhost:3000"
Const PUBLIC_URL = "https://moonwolf.serveousercontent.com"

Dim nodeProcess
Dim tunnelProcess

' ============================================================
' 1. Instalar dependencias solo si no existen
' ============================================================
If Not objFSO.FolderExists(strPath & "\node_modules") Then
    objShell.Run "cmd /c npm install --silent", 0, True
End If

' ============================================================
' 2. Arrancar Node.js
' ============================================================
Set nodeProcess = objShell.Exec("node server.js")

' ============================================================
' 3. Esperar a que Node responda
' ============================================================
Dim xmlHttp, ready, attempts

ready = False
attempts = 0

Do While Not ready And attempts < 30
    WScript.Sleep 500
    attempts = attempts + 1

    On Error Resume Next

    Set xmlHttp = CreateObject("MSXML2.XMLHTTP")
    xmlHttp.Open "GET", SERVER_URL, False
    xmlHttp.Send

    If Err.Number = 0 Then
        If xmlHttp.Status = 200 Then
            ready = True
        End If
    End If

    Err.Clear
    On Error GoTo 0

    If Not nodeProcess Is Nothing Then
        If nodeProcess.Status <> 0 Then
            MsgBox "server.js se ha cerrado durante el arranque.", vbCritical, "MoonWolf Panel"
            WScript.Quit 1
        End If
    End If
Loop

If Not ready Then
    MsgBox "MoonWolf Panel no pudo iniciar correctamente.", vbCritical, "MoonWolf Panel"
    WScript.Quit 1
End If

' ============================================================
' 4. Función para iniciar Serveo
' ============================================================
Sub StartTunnel()

    On Error Resume Next

    If Not tunnelProcess Is Nothing Then
        If tunnelProcess.Status = 0 Then
            tunnelProcess.Terminate
        End If
    End If

    Set tunnelProcess = objShell.Exec( _
        "ssh -o ServerAliveInterval=30 " & _
        "-o ServerAliveCountMax=3 " & _
        "-o ExitOnForwardFailure=yes " & _
        "-o StrictHostKeyChecking=yes " & _
        "-R moonwolf:80:localhost:3000 serveo.net" _
    )

    Err.Clear
    On Error GoTo 0

End Sub

' ============================================================
' 5. Comprobar si Serveo responde
' ============================================================
Function TunnelWorks()

    TunnelWorks = False

    On Error Resume Next

    Set xmlHttp = CreateObject("MSXML2.XMLHTTP")
    xmlHttp.Open "GET", PUBLIC_URL & "/api/files", False
    xmlHttp.setRequestHeader "Cache-Control", "no-cache"
    xmlHttp.setRequestHeader "serveo-skip-browser-warning", "true"
    xmlHttp.Send

    If Err.Number = 0 Then
        If xmlHttp.Status = 200 Then
            TunnelWorks = True
        End If
    End If

    Err.Clear
    On Error GoTo 0

End Function

' ============================================================
' 6. Iniciar túnel
' ============================================================
StartTunnel

' ============================================================
' 7. Esperar hasta 15 segundos a que esté disponible
' ============================================================
Dim tunnelReady

tunnelReady = False

For attempts = 1 To 15

    WScript.Sleep 1000

    If TunnelWorks() Then
        tunnelReady = True
        Exit For
    End If

    If Not tunnelProcess Is Nothing Then
        If tunnelProcess.Status <> 0 Then
            Exit For
        End If
    End If

Next

' ============================================================
' 8. Abrir el panel
' ============================================================
objShell.Run "https://moonwolf.serveousercontent.com", 1, False

' ============================================================
' 9. SUPERVISOR
' ============================================================
Do

    WScript.Sleep 30000

    ' Si SSH ha muerto, reconectar
    If tunnelProcess Is Nothing Then

        StartTunnel

    ElseIf tunnelProcess.Status <> 0 Then

        StartTunnel

    ElseIf Not TunnelWorks() Then

        StartTunnel

    End If

Loop
