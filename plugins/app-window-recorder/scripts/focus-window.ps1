param(
    [Parameter(Mandatory = $true)]
    [long]$Hwnd
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NativeMethods
{
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    public const int SW_RESTORE = 9;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_SHOWWINDOW = 0x0040;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int X,
        int Y,
        int cx,
        int cy,
        uint uFlags
    );
}
"@

$windowHandle = [IntPtr]$Hwnd

if (-not [NativeMethods]::IsWindow($windowHandle)) {
    throw "Window handle '$Hwnd' is not valid."
}

$isMinimized = [NativeMethods]::IsIconic($windowHandle)
if ($isMinimized) {
    [void][NativeMethods]::ShowWindowAsync($windowHandle, [NativeMethods]::SW_RESTORE)
}

$setTopMost = [NativeMethods]::SetWindowPos(
    $windowHandle,
    [NativeMethods]::HWND_TOPMOST,
    0,
    0,
    0,
    0,
    [NativeMethods]::SWP_NOMOVE -bor [NativeMethods]::SWP_NOSIZE -bor [NativeMethods]::SWP_SHOWWINDOW
)

$unsetTopMost = [NativeMethods]::SetWindowPos(
    $windowHandle,
    [NativeMethods]::HWND_NOTOPMOST,
    0,
    0,
    0,
    0,
    [NativeMethods]::SWP_NOMOVE -bor [NativeMethods]::SWP_NOSIZE -bor [NativeMethods]::SWP_SHOWWINDOW
)

$broughtToTop = [NativeMethods]::BringWindowToTop($windowHandle)
$setForeground = [NativeMethods]::SetForegroundWindow($windowHandle)

$payload = [pscustomobject]@{
    hwnd = $Hwnd
    restored = $isMinimized
    set_topmost = $setTopMost
    unset_topmost = $unsetTopMost
    bring_to_top = $broughtToTop
    set_foreground = $setForeground
}

$json = $payload | ConvertTo-Json -Compress
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
