Option Explicit

Dim shell, fso, base, nodePath, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)

nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodePath) Then
  MsgBox "MoonWolf Agent necesita Node.js para esta versión de desarrollo." & vbCrLf & vbCrLf & _
         "La versión final se distribuirá como MoonWolf-Agent.exe.", vbExclamation, "MoonWolf Agent"
  WScript.Quit 1
End If

cmd = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & base & "\agent\index.js" & Chr(34)
shell.Run cmd, 0, False
