Option Explicit

Dim shell, fso, basePath, nodePath, serverPath, command, showBrowser, ready, attempt, http
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
basePath = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = fso.BuildPath(basePath, "runtime\node.exe")
serverPath = fso.BuildPath(basePath, "app\server.js")
shell.CurrentDirectory = basePath
showBrowser = True
If WScript.Arguments.Count > 0 Then
    If LCase(WScript.Arguments(0)) = "background" Then showBrowser = False
End If

shell.Environment("Process")("DINGTALK_REMINDER_PRODUCTION") = "1"
ready = False
On Error Resume Next
Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
http.Open "GET", "http://127.0.0.1:4173/api/status", False
http.Send
If Err.Number = 0 And http.Status = 200 And InStr(http.ResponseText, "databaseReady") > 0 Then ready = True
Err.Clear
On Error GoTo 0

If Not ready Then
    command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & serverPath & Chr(34)
    shell.Run command, 0, False
    For attempt = 1 To 24
        WScript.Sleep 250
        On Error Resume Next
        Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
        http.Open "GET", "http://127.0.0.1:4173/api/status", False
        http.Send
        If Err.Number = 0 And http.Status = 200 And InStr(http.ResponseText, "databaseReady") > 0 Then ready = True
        Err.Clear
        On Error GoTo 0
        If ready Then Exit For
    Next
End If

If ready Then
    If showBrowser Then shell.Run "http://127.0.0.1:4173/", 1, False
Else
    MsgBox "Wen's Ding could not start. Port 4173 may be occupied.", 16, "Wen's Ding"
End If
