Option Explicit
Dim shell, fs, root, runtime, command
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
root = fs.GetParentFolderName(WScript.ScriptFullName)
runtime = root & "\.venv\Scripts\pythonw.exe"
If Not fs.FileExists(runtime) Then
  runtime = root & "\.venv\Scripts\python.exe"
End If
If Not fs.FileExists(runtime) Then
  runtime = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\pythonw.exe"
End If
If Not fs.FileExists(runtime) Then
  runtime = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
End If
If Not fs.FileExists(runtime) Then
  MsgBox "Python runtime not found. See README.md.", 16, "PaperNest"
  WScript.Quit 1
End If
command = Chr(34) & runtime & Chr(34) & " " & Chr(34) & root & "\launch.pyw" & Chr(34)
shell.CurrentDirectory = root
shell.Run command, 0, False
