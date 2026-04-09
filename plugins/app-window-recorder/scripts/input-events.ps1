param(
    [Parameter(Mandatory = $true)]
    [int]$DurationMilliseconds,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies System.Windows.Forms @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class InputEventRecord
{
    public string kind { get; set; }
    public long timestamp_unix_ms { get; set; }
    public long offset_ms_from_recorder_start { get; set; }
    public int? screen_x { get; set; }
    public int? screen_y { get; set; }
    public string button { get; set; }
    public int? wheel_delta { get; set; }
    public string key { get; set; }
    public int? vk_code { get; set; }
    public int? scan_code { get; set; }
    public long foreground_hwnd { get; set; }
    public int foreground_pid { get; set; }
    public bool injected { get; set; }
}

public class InputRecordingResult
{
    public long started_at_unix_ms { get; set; }
    public long finished_at_unix_ms { get; set; }
    public long duration_ms { get; set; }
    public List<InputEventRecord> events { get; set; }
}

public static class InputRecorder
{
    private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;

    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;

    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;

    private const uint LLMHF_INJECTED = 0x00000001;
    private const uint LLKHF_INJECTED = 0x00000010;
    private const long MouseMoveSampleMs = 16;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    private static readonly object SyncRoot = new object();
    private static LowLevelProc MouseProc = MouseHookCallback;
    private static LowLevelProc KeyboardProc = KeyboardHookCallback;
    private static IntPtr MouseHookId = IntPtr.Zero;
    private static IntPtr KeyboardHookId = IntPtr.Zero;
    private static List<InputEventRecord> Events = new List<InputEventRecord>();
    private static long StartedAtUnixMs = 0;
    private static long LastMouseMoveAtUnixMs = long.MinValue;
    private static int LastMouseMoveX = int.MinValue;
    private static int LastMouseMoveY = int.MinValue;

    public static InputRecordingResult Record(int durationMilliseconds)
    {
        Events = new List<InputEventRecord>();
        StartedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        LastMouseMoveAtUnixMs = long.MinValue;
        LastMouseMoveX = int.MinValue;
        LastMouseMoveY = int.MinValue;

        MouseHookId = SetHook(WH_MOUSE_LL, MouseProc);
        KeyboardHookId = SetHook(WH_KEYBOARD_LL, KeyboardProc);

        if (MouseHookId == IntPtr.Zero || KeyboardHookId == IntPtr.Zero)
        {
            CleanupHooks();
            throw new InvalidOperationException("Failed to install low-level input hooks.");
        }

        Timer timer = new Timer();
        timer.Interval = Math.Max(1, durationMilliseconds);
        timer.Tick += (sender, args) =>
        {
            timer.Stop();
            Application.ExitThread();
        };
        timer.Start();

        Application.Run();

        timer.Dispose();
        CleanupHooks();

        long finishedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return new InputRecordingResult
        {
            started_at_unix_ms = StartedAtUnixMs,
            finished_at_unix_ms = finishedAtUnixMs,
            duration_ms = finishedAtUnixMs - StartedAtUnixMs,
            events = Events,
        };
    }

    private static void CleanupHooks()
    {
        if (MouseHookId != IntPtr.Zero)
        {
            UnhookWindowsHookEx(MouseHookId);
            MouseHookId = IntPtr.Zero;
        }

        if (KeyboardHookId != IntPtr.Zero)
        {
            UnhookWindowsHookEx(KeyboardHookId);
            KeyboardHookId = IntPtr.Zero;
        }
    }

    private static IntPtr SetHook(int hookId, LowLevelProc proc)
    {
        using (Process currentProcess = Process.GetCurrentProcess())
        using (ProcessModule currentModule = currentProcess.MainModule)
        {
            return SetWindowsHookEx(hookId, proc, GetModuleHandle(currentModule.ModuleName), 0);
        }
    }

    private static InputEventRecord CreateBaseRecord(string kind)
    {
        long timestampUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        IntPtr foregroundWindow = GetForegroundWindow();
        uint foregroundProcessId = 0;
        if (foregroundWindow != IntPtr.Zero)
        {
            GetWindowThreadProcessId(foregroundWindow, out foregroundProcessId);
        }

        return new InputEventRecord
        {
            kind = kind,
            timestamp_unix_ms = timestampUnixMs,
            offset_ms_from_recorder_start = timestampUnixMs - StartedAtUnixMs,
            foreground_hwnd = foregroundWindow.ToInt64(),
            foreground_pid = (int)foregroundProcessId,
        };
    }

    private static void AppendEvent(InputEventRecord record)
    {
        lock (SyncRoot)
        {
            Events.Add(record);
        }
    }

    private static string GetMouseButton(int message, uint mouseData)
    {
        switch (message)
        {
            case WM_LBUTTONDOWN:
            case WM_LBUTTONUP:
                return "left";
            case WM_RBUTTONDOWN:
            case WM_RBUTTONUP:
                return "right";
            case WM_MBUTTONDOWN:
            case WM_MBUTTONUP:
                return "middle";
            case WM_XBUTTONDOWN:
            case WM_XBUTTONUP:
                return ((mouseData >> 16) & 0xffff) == 1 ? "x1" : "x2";
            default:
                return null;
        }
    }

    private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            try
            {
                int message = wParam.ToInt32();
                MSLLHOOKSTRUCT hookData = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);

                if (message == WM_MOUSEMOVE)
                {
                    long timestampUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    if (
                        hookData.pt.x == LastMouseMoveX &&
                        hookData.pt.y == LastMouseMoveY &&
                        timestampUnixMs - LastMouseMoveAtUnixMs < MouseMoveSampleMs
                    )
                    {
                        return CallNextHookEx(MouseHookId, nCode, wParam, lParam);
                    }

                    LastMouseMoveX = hookData.pt.x;
                    LastMouseMoveY = hookData.pt.y;
                    LastMouseMoveAtUnixMs = timestampUnixMs;
                }

                string kind = null;
                switch (message)
                {
                    case WM_MOUSEMOVE:
                        kind = "mouse_move";
                        break;
                    case WM_LBUTTONDOWN:
                    case WM_RBUTTONDOWN:
                    case WM_MBUTTONDOWN:
                    case WM_XBUTTONDOWN:
                        kind = "mouse_down";
                        break;
                    case WM_LBUTTONUP:
                    case WM_RBUTTONUP:
                    case WM_MBUTTONUP:
                    case WM_XBUTTONUP:
                        kind = "mouse_up";
                        break;
                    case WM_MOUSEWHEEL:
                        kind = "mouse_wheel";
                        break;
                }

                if (kind != null)
                {
                    InputEventRecord record = CreateBaseRecord(kind);
                    record.screen_x = hookData.pt.x;
                    record.screen_y = hookData.pt.y;
                    record.button = GetMouseButton(message, hookData.mouseData);
                    if (message == WM_MOUSEWHEEL)
                    {
                        record.wheel_delta = (short)((hookData.mouseData >> 16) & 0xffff);
                    }
                    record.injected = (hookData.flags & LLMHF_INJECTED) != 0;
                    AppendEvent(record);
                }
            }
            catch
            {
            }
        }

        return CallNextHookEx(MouseHookId, nCode, wParam, lParam);
    }

    private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            try
            {
                int message = wParam.ToInt32();
                if (
                    message == WM_KEYDOWN ||
                    message == WM_KEYUP ||
                    message == WM_SYSKEYDOWN ||
                    message == WM_SYSKEYUP
                )
                {
                    KBDLLHOOKSTRUCT hookData = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
                    InputEventRecord record = CreateBaseRecord(
                        message == WM_KEYDOWN || message == WM_SYSKEYDOWN ? "key_down" : "key_up"
                    );
                    record.key = ((Keys)hookData.vkCode).ToString();
                    record.vk_code = (int)hookData.vkCode;
                    record.scan_code = (int)hookData.scanCode;
                    record.injected = (hookData.flags & LLKHF_INJECTED) != 0;
                    AppendEvent(record);
                }
            }
            catch
            {
            }
        }

        return CallNextHookEx(KeyboardHookId, nCode, wParam, lParam);
    }
}
"@

$outputDirectory = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
    [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}

$result = [InputRecorder]::Record($DurationMilliseconds)
$json = $result | ConvertTo-Json -Depth 6
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($OutputPath, $json, $utf8NoBom)
