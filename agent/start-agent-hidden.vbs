' start-agent-hidden.vbs
'
' Same as start-agent.cmd but runs with no console window. Handy for the
' Windows Startup folder: the agent boots in the background on login with
' zero visual clutter. Logs still go to %TEMP%\remote-access-agent.log so
' you can tail them if something's off.
'
' Setup:
'   1. Press Win+R, type   shell:startup   Enter
'   2. Drag a SHORTCUT to this .vbs file into the folder that opens.
'
' To stop the agent: open Task Manager and end the "node.exe" (or
' "powershell.exe") process, or reboot.

Option Explicit

Dim fso, shell, scriptDir, logFile, cmd
Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
logFile   = shell.ExpandEnvironmentStrings("%TEMP%") & "\remote-access-agent.log"

' Run start-agent.cmd with output redirected to the log. WindowStyle 0 = hidden.
cmd = "cmd.exe /c """"" & scriptDir & "\start-agent.cmd"" > """ & logFile & """ 2>&1"""
shell.Run cmd, 0, False
