Attribute VB_Name = "MouseModule"
'---------------------------------------------------------------------------
' MouseModule.bas
'
' Win32 API wrappers for moving the cursor and synthesizing mouse button /
' wheel events. All of these live in user32.dll and have been present since
' Windows 95, so they work on any modern Windows box that still runs VB6.
'
' Coordinates coming in from the browser are NORMALIZED (0.0 - 1.0) against
' the <video> element the remote user is looking at. We scale them up to the
' *primary* screen's virtual pixel size here -- that matches what Windows'
' mouse functions expect in absolute-coordinate mode.
'---------------------------------------------------------------------------
Option Explicit

' --- Win32 declarations ----------------------------------------------------

Public Declare Function SetCursorPos Lib "user32" _
    (ByVal X As Long, ByVal Y As Long) As Long

Public Declare Sub mouse_event Lib "user32" _
    (ByVal dwFlags As Long, _
     ByVal dx As Long, _
     ByVal dy As Long, _
     ByVal dwData As Long, _
     ByVal dwExtraInfo As Long)

Public Declare Function GetSystemMetrics Lib "user32" _
    (ByVal nIndex As Long) As Long

Private Const SM_CXSCREEN As Long = 0
Private Const SM_CYSCREEN As Long = 1

' mouse_event flag bits
Public Const MOUSEEVENTF_MOVE        As Long = &H1
Public Const MOUSEEVENTF_LEFTDOWN    As Long = &H2
Public Const MOUSEEVENTF_LEFTUP      As Long = &H4
Public Const MOUSEEVENTF_RIGHTDOWN   As Long = &H8
Public Const MOUSEEVENTF_RIGHTUP     As Long = &H10
Public Const MOUSEEVENTF_MIDDLEDOWN  As Long = &H20
Public Const MOUSEEVENTF_MIDDLEUP    As Long = &H40
Public Const MOUSEEVENTF_WHEEL       As Long = &H800
Public Const MOUSEEVENTF_ABSOLUTE    As Long = &H8000

'---------------------------------------------------------------------------
' MoveMouseNormalized
'   nx, ny are floats in [0, 1]. We clamp and scale to actual screen pixels.
'---------------------------------------------------------------------------
Public Sub MoveMouseNormalized(ByVal nx As Double, ByVal ny As Double)
    If nx < 0 Then nx = 0
    If nx > 1 Then nx = 1
    If ny < 0 Then ny = 0
    If ny > 1 Then ny = 1

    Dim sw As Long, sh As Long
    sw = GetSystemMetrics(SM_CXSCREEN)
    sh = GetSystemMetrics(SM_CYSCREEN)

    SetCursorPos CLng(nx * (sw - 1)), CLng(ny * (sh - 1))
End Sub

'---------------------------------------------------------------------------
' PressButton / ReleaseButton
'   button values match the browser's MouseEvent.button:
'     0 = left, 1 = middle, 2 = right
'---------------------------------------------------------------------------
Public Sub PressButton(ByVal button As Integer)
    Select Case button
        Case 1: mouse_event MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, 0
        Case 2: mouse_event MOUSEEVENTF_RIGHTDOWN,  0, 0, 0, 0
        Case Else: mouse_event MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0
    End Select
End Sub

Public Sub ReleaseButton(ByVal button As Integer)
    Select Case button
        Case 1: mouse_event MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0
        Case 2: mouse_event MOUSEEVENTF_RIGHTUP,  0, 0, 0, 0
        Case Else: mouse_event MOUSEEVENTF_LEFTUP, 0, 0, 0, 0
    End Select
End Sub

'---------------------------------------------------------------------------
' ClickButton
'   Synthetic down+up pair. Lower-latency than waiting for the browser to
'   round-trip a separate "up" event.
'---------------------------------------------------------------------------
Public Sub ClickButton(ByVal button As Integer)
    PressButton button
    ReleaseButton button
End Sub

'---------------------------------------------------------------------------
' ScrollWheel
'   `delta` uses the Windows convention: positive scrolls AWAY from the user,
'   negative toward. Browsers report the opposite sign in WheelEvent.deltaY,
'   so the agent flips it before calling us.
'---------------------------------------------------------------------------
Public Sub ScrollWheel(ByVal delta As Long)
    mouse_event MOUSEEVENTF_WHEEL, 0, 0, delta, 0
End Sub
