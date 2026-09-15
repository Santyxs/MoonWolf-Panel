Dim objShell, objFSO, strPath
Set objShell = CreateObject("WScript.Shell")
Set objFSO   = CreateObject("Scripting.FileSystemObject")
strPath = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
objShell.CurrentDirectory = strPath

' 1. Instalar dependencias (silencioso)
objShell.Run "cmd /c npm install --silent 2>nul", 0, True

' 2. Arrancar Node en background
objShell.Run "cmd /c node server.js > nul 2>&1", 0, False

' 3. Esperar a que Node responda (máx 15 seg)
Dim xmlHttp, ready, attempts ready = False : attempts = 0

Do While Not ready And attempts < 30
    WScript.Sleep 500
    attempts = attempts + 1

    On Error Resume Next
    Set xmlHttp = CreateObject("MSXML2.XMLHTTP")
    xmlHttp.Open "GET", "http://localhost:3000", False
    xmlHttp.Send

    If Err.Number = 0 Then
        If xmlHttp.Status = 200 Then ready = True
    End If

    Err.Clear
    On Error GoTo 0
Loop

' 4. Arrancar túnel Serveo en background
objShell.Run "cmd /c ssh -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -R moonwolf:80:localhost:3000 serveo.net > nul 2>&1", 0, False

' 5. Abrir MoonWolf desde la URL pública
WScript.Sleep 3000
objShell.Run "cmd /c start https://moonwolf.serveousercontent.com", 0, False
