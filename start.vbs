Dim objShell, objFSO, strPath
Set objShell = CreateObject("WScript.Shell")
Set objFSO   = CreateObject("Scripting.FileSystemObject")

strPath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
objShell.CurrentDirectory = strPath

' ============================================================
' CONFIGURACIÓN
' ============================================================
Const SERVER_URL = "http://localhost:3000"
Const PUBLIC_URL = "https://moonwolf.serveousercontent.com"

' ============================================================
' 1. Instalar dependencias
' ============================================================
objShell.Run "cmd /c npm install --silent 2>nul", 0, True

' ============================================================
' 2. Arrancar Node.js
' ============================================================
objShell.Run "cmd /c node server.js > nul 2>&1", 0, False

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
        If xmlHttp.Status = 200 Then ready = True
    End If

    Err.Clear
    On Error GoTo 0
Loop

If Not ready Then
    MsgBox "MoonWolf Panel no ha podido iniciar server.js.", vbCritical, "MoonWolf Panel"
    WScript.Quit 1
End If

' ============================================================
' FUNCIONES
' ============================================================

Sub StartTunnel()
    ' Mata cualquier SSH anterior que haya quedado colgado
    objShell.Run "cmd /c taskkill /IM ssh.exe /F > nul 2>&1", 0, True

    ' Inicia Serveo oculto
    objShell.Run _
        "cmd /c ssh -o BatchMode=yes -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R moonwolf:80:localhost:3000 serveo.net > nul 2>&1", _
        0, False
End Sub

Function TunnelWorks()
    TunnelWorks = False

    On Error Resume Next

    Set xmlHttp = CreateObject("MSXML2.XMLHTTP")
    xmlHttp.Open "GET", PUBLIC_URL & "/api/files", False
    xmlHttp.setRequestHeader "Cache-Control", "no-cache"
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
' 4. Iniciar túnel
' ============================================================
StartTunnel

' ============================================================
' 5. Esperar a que Serveo esté disponible
' ============================================================
Dim tunnelReady
tunnelReady = False

For attempts = 1 To 30
    WScript.Sleep 1000

    If TunnelWorks() Then
        tunnelReady = True
        Exit For
    End If
Next

' ============================================================
' 6. Abrir MoonWolf
' ============================================================
objShell.Run "cmd /c start " & PUBLIC_URL, 0, False

' ============================================================
' 7. SUPERVISOR DEL TÚNEL
' ============================================================
'
' Comprueba cada 30 segundos:
'
'   Serveo funciona → no hace nada
'   Serveo ha caído → mata SSH y lo vuelve a crear
'
' ============================================================

Do
    WScript.Sleep 30000

    If Not TunnelWorks() Then
        StartTunnel

        For attempts = 1 To 20
            WScript.Sleep 1000

            If TunnelWorks() Then
                Exit For
            End If
        Next
    End If
Loop
