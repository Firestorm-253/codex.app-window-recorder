# App Window Recorder

App Window Recorder is a Windows-only Codex plugin that records a single app window, extracts frames, and returns file paths that Codex can inspect directly.

It supports:

- listing visible top-level app windows
- launching an app and waiting for its window to appear
- attaching to an already-running app by PID, process name, or title match
- recording either the full client area or the full outer window
- extracting timestamped PNG frames
- logging mouse and keyboard events with timestamps to a sidecar JSON file

## Requirements

- Windows
- Node.js 18 or newer
- Windows PowerShell
- `ffmpeg` on `PATH`
- `ffprobe` on `PATH`
- Codex with local plugin support

## Installation

### Option 1: use as a repo-local plugin

1. Put this plugin at `./plugins/app-window-recorder` inside a repo.
2. Add or keep a repo marketplace file at `./.agents/plugins/marketplace.json`.
3. Run `npm install` in `./plugins/app-window-recorder`.
4. Open that repo in Codex.
5. Reload plugins or restart Codex.
6. Enable `App Window Recorder` from the Plugins tab.

### Option 2: use as a home-local plugin

1. Put this plugin at `~/plugins/app-window-recorder`.
2. Add or keep a home marketplace file at `~/.agents/plugins/marketplace.json`.
3. Run `npm install` in `~/plugins/app-window-recorder`.
4. Restart Codex.
5. Enable `App Window Recorder` from the Plugins tab.

## How It Starts

The plugin manifest points to `.mcp.json`, and `.mcp.json` starts `scripts/start-server.ps1`.

That launcher:

- resolves `node.exe` dynamically
- starts `scripts/server.mjs`
- avoids hardcoding one specific machine-local Node path

## Available Tools

### `list_app_windows`

Lists visible top-level windows that the recorder can attach to.

Arguments:

- `process_name` optional
- `window_title_contains` optional

Example:

```json
{
  "process_name": "notepad"
}
```

### `record_app_window`

Records a target window for a fixed duration.

Required argument:

- `duration_seconds`

Launch-mode arguments:

- `launch_command`
- `launch_args`
- `cwd`

Attach-mode arguments:

- `pid`
- `process_name`
- `window_title_contains`

Optional capture arguments:

- `settle_seconds` default `1`
- `capture_fps` default `60`
- `frame_sample_fps` default `2`
- `client_area_only` default `true`
- `preserve_mp4` default `true`

Example: launch Notepad and record for 5 seconds

```json
{
  "duration_seconds": 5,
  "launch_command": "notepad.exe"
}
```

Example: attach to an existing process

```json
{
  "duration_seconds": 5,
  "pid": 12345
}
```

Example: capture the full outer window instead of only the client area

```json
{
  "duration_seconds": 5,
  "process_name": "notepad",
  "client_area_only": false
}
```

## Output Files

Artifacts are written under:

- `C:\Users\<you>\.codex\tmp\app-window-recorder\<session-id>\`

Each session can include:

- `capture.mp4`
- `frames\frame-XXXX.png`
- `manifest.json`
- `input-events.json`

Important manifest fields include:

- `capture_fps`
- `frame_sample_fps`
- `capture_backend`
- `mp4_path`
- `manifest_path`
- `input_events_path`
- `input_event_count`
- `frames`

## Behavior Notes

- Default capture framerate is `60` FPS.
- The mouse cursor is drawn into the video.
- `client_area_only: true` captures the full client area, not a centered crop.
- `client_area_only: false` captures the full outer window region.
- The plugin extracts frames after recording and returns absolute file paths.
- Input events are logged separately from the video as timestamped JSON.

## Current Limitations

- Separate top-level OS dialogs, such as a native file picker, are not composited into the main app capture.
- Input logging is best-effort. Mouse movement is reliable, but some keyboard or click events may depend on Windows hook behavior and app focus timing.
- This plugin is Windows-only.

## Troubleshooting

If the plugin does not appear in Codex:

1. Confirm the marketplace entry points to `./plugins/app-window-recorder`.
2. Confirm `npm install` was run in the plugin directory.
3. Restart Codex or reload plugins.
4. Check that `ffmpeg` and `ffprobe` are available on `PATH`.

If recording fails:

1. Run `list_app_windows` first and confirm the target window is visible.
2. Narrow the selector by PID or exact process name if multiple windows match.
3. Make sure the target window is not minimized.
4. Check the returned error in the MCP tool result for missing `ffmpeg`, ambiguous matches, or missing windows.
