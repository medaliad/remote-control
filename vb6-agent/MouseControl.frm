VERSION 5.00
Object = "{248DD890-BB45-11CF-9ABC-0080C7E7B78D}#1.0#0"; "MSWINSCK.OCX"
Begin VB.Form Form1
   Caption         =   "Remote Access - Mouse Control Agent"
   ClientHeight    =   3600
   ClientLeft      =   60
   ClientTop       =   345
   ClientWidth     =   6720
   LinkTopic       =   "Form1"
   ScaleHeight     =   3600
   ScaleWidth      =   6720
   StartUpPosition =   3
   Begin MSWinsockLib.Winsock sockListener
      Left            =   120
      Top             =   120
      _ExtentX        =   741
      _ExtentY        =   741
      _Version        =   393216
      Protocol        =   0
      LocalPort       =   8765
   End
   Begin MSWinsockLib.Winsock sockClient
      Left            =   720
      Top             =   120
      _ExtentX        =   741
      _ExtentY        =   741
      _Version        =   393216
      Protocol        =   0
   End
   Begin VB.CommandButton cmdStop
      Caption         =   "Stop listening"
      Height          =   375
      Left            =   5280
      TabIndex        =   2
      Top             =   120
      Width           =   1335
   End
   Begin VB.TextBox txtLog
      Height          =   2775
      Left            =   120
      MultiLine       =   -1
      ScrollBars      =   2
      TabIndex        =   1
      Top             =   720
      Width           =   6495
   End
   Begin VB.Label lblStatus
      Caption         =   "Waiting for agent connection on 127.0.0.1:8765 ..."
      Height          =   375
      Left            =   1440
      TabIndex        =   0
      Top             =   180
      Width           =   3735
   End
End
Attribute VB_Name = "Form1"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = False

Option Explicit

Private recvBuffer As String

Private Sub Form_Load()
    sockListener.LocalPort = 8765
    sockListener.Listen
    LogLine "Listening on 127.0.0.1:8765"
End Sub

Private Sub Form_Unload(Cancel As Integer)
    On Error Resume Next
    sockClient.Close
    sockListener.Close
End Sub

Private Sub cmdStop_Click()
    On Error Resume Next
    sockClient.Close
    sockListener.Close
    lblStatus.Caption = "Stopped."
    LogLine "Listener stopped."
End Sub

Private Sub sockListener_ConnectionRequest(ByVal requestID As Long)
    If sockClient.State <> sckClosed Then sockClient.Close
    sockClient.Accept requestID
    recvBuffer = ""
    lblStatus.Caption = "Agent connected from " & sockClient.RemoteHostIP
    LogLine "Agent connected: " & sockClient.RemoteHostIP & ":" & sockClient.RemotePort
End Sub

Private Sub sockClient_Close()
    On Error Resume Next
    sockClient.Close
    lblStatus.Caption = "Agent disconnected -- waiting again ..."
    LogLine "Agent disconnected."
End Sub

Private Sub sockClient_DataArrival(ByVal bytesTotal As Long)
    Dim chunk As String
    sockClient.GetData chunk, vbString
    recvBuffer = recvBuffer & chunk

    Dim nlPos As Long
    Do
        nlPos = InStr(recvBuffer, vbLf)
        If nlPos = 0 Then Exit Do
        Dim line As String
        line = Left$(recvBuffer, nlPos - 1)
        recvBuffer = Mid$(recvBuffer, nlPos + 1)
        If Right$(line, 1) = vbCr Then line = Left$(line, Len(line) - 1)
        If Len(line) > 0 Then HandleCommand line
    Loop
End Sub

Private Sub HandleCommand(ByVal cmdLine As String)
    On Error GoTo failed

    Dim parts() As String
    parts = Split(cmdLine, " ")

    Dim verb As String
    verb = UCase$(parts(0))

    Select Case verb
        Case "MOVE"
            If UBound(parts) < 2 Then Err.Raise 5, , "MOVE needs x y"
            MoveMouseNormalized CDbl(parts(1)), CDbl(parts(2))
        Case "DOWN"
            PressButton ParseButton(parts)
        Case "UP"
            ReleaseButton ParseButton(parts)
        Case "CLICK"
            ClickButton ParseButton(parts)
        Case "SCROLL"
            If UBound(parts) < 1 Then Err.Raise 5, , "SCROLL needs delta"

            ScrollWheel -CLng(CDbl(parts(1)))
        Case "PING"
            Reply "PONG"
            Exit Sub
        Case Else
            Err.Raise 5, , "unknown verb " & verb
    End Select

    Reply "OK"
    LogLine "<- " & cmdLine
    Exit Sub

failed:
    Reply "ERR " & Err.Description
    LogLine "!! " & cmdLine & "  (" & Err.Description & ")"
End Sub

Private Function ParseButton(parts() As String) As Integer
    If UBound(parts) >= 1 Then
        ParseButton = CInt(parts(1))
    Else
        ParseButton = 0
    End If
End Function

Private Sub Reply(ByVal s As String)
    On Error Resume Next
    If sockClient.State = sckConnected Then sockClient.SendData s & vbLf
End Sub

Private Sub LogLine(ByVal s As String)
    Dim stamp As String
    stamp = Format$(Now, "hh:nn:ss")
    txtLog.Text = stamp & "  " & s & vbCrLf & txtLog.Text
    If Len(txtLog.Text) > 16000 Then txtLog.Text = Left$(txtLog.Text, 16000)
End Sub
