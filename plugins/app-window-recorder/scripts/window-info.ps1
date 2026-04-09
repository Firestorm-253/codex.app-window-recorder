$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeMethods
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
}
"@

$processCache = @{}
$windows = New-Object System.Collections.Generic.List[object]

$callback = [NativeMethods+EnumWindowsProc]{
    param(
        [IntPtr]$hWnd,
        [IntPtr]$lParam
    )

    if (-not [NativeMethods]::IsWindowVisible($hWnd)) {
        return $true
    }

    $titleLength = [NativeMethods]::GetWindowTextLengthW($hWnd)
    if ($titleLength -le 0) {
        return $true
    }

    $titleBuilder = New-Object System.Text.StringBuilder ($titleLength + 1)
    [void][NativeMethods]::GetWindowTextW($hWnd, $titleBuilder, $titleBuilder.Capacity)
    $title = $titleBuilder.ToString()
    $title = -join ($title.ToCharArray() | Where-Object {
        $codePoint = [int][char]$_
        $codePoint -ge 32 -and $codePoint -ne 127
    })

    if ([string]::IsNullOrWhiteSpace($title)) {
        return $true
    }

    [uint32]$processId = 0
    [void][NativeMethods]::GetWindowThreadProcessId($hWnd, [ref]$processId)
    if ($processId -eq 0) {
        return $true
    }

    if (-not $processCache.ContainsKey($processId)) {
        try {
            $processCache[$processId] = Get-Process -Id $processId -ErrorAction Stop
        } catch {
            $processCache[$processId] = $null
        }
    }

    $process = $processCache[$processId]
    if ($null -eq $process) {
        return $true
    }

    $windowRect = New-Object NativeMethods+RECT
    if (-not [NativeMethods]::GetWindowRect($hWnd, [ref]$windowRect)) {
        return $true
    }

    $clientRectLocal = New-Object NativeMethods+RECT
    $clientRect = $null

    if ([NativeMethods]::GetClientRect($hWnd, [ref]$clientRectLocal)) {
        $clientTopLeft = New-Object NativeMethods+POINT
        $clientTopLeft.X = $clientRectLocal.Left
        $clientTopLeft.Y = $clientRectLocal.Top

        $clientBottomRight = New-Object NativeMethods+POINT
        $clientBottomRight.X = $clientRectLocal.Right
        $clientBottomRight.Y = $clientRectLocal.Bottom

        if (
            [NativeMethods]::ClientToScreen($hWnd, [ref]$clientTopLeft) -and
            [NativeMethods]::ClientToScreen($hWnd, [ref]$clientBottomRight)
        ) {
            $clientRect = [pscustomobject]@{
                left = $clientTopLeft.X
                top = $clientTopLeft.Y
                right = $clientBottomRight.X
                bottom = $clientBottomRight.Y
                width = $clientBottomRight.X - $clientTopLeft.X
                height = $clientBottomRight.Y - $clientTopLeft.Y
            }
        }
    }

    $windows.Add([pscustomobject]@{
        hwnd = [int64]$hWnd.ToInt64()
        pid = [int]$processId
        process_name = $process.ProcessName
        title = $title
        window_rect = [pscustomobject]@{
            left = $windowRect.Left
            top = $windowRect.Top
            right = $windowRect.Right
            bottom = $windowRect.Bottom
            width = $windowRect.Right - $windowRect.Left
            height = $windowRect.Bottom - $windowRect.Top
        }
        client_rect = $clientRect
    }) | Out-Null

    return $true
}

[void][NativeMethods]::EnumWindows($callback, [IntPtr]::Zero)

$json = $windows |
    Sort-Object process_name, title, hwnd |
    ConvertTo-Json -Depth 6 -Compress

[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
