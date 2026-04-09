# App Window Recorder

Windows-only Codex plugin that can:

- list visible top-level app windows
- launch an app and wait for a matching window
- record a target window for a bounded duration
- capture the full client area or the full outer window
- record at 60 FPS by default
- draw the mouse cursor into the video
- extract PNG frames and return absolute artifact paths
- log timestamped mouse and keyboard events to `input-events.json`

Artifacts are written under:

- `C:\Users\Zehnder\.codex\tmp\app-window-recorder\<session-id>\`

Each session can include:

- `capture.mp4`
- `frames\frame-XXXX.png`
- `manifest.json`
- `input-events.json`

The plugin requires:

- Windows
- `ffmpeg`
- `ffprobe`
- Node.js 18+
- Windows PowerShell

Setup:

1. Run `npm install` in the plugin directory.
2. Ensure `ffmpeg` and `ffprobe` are available on `PATH`.
3. Install the plugin through a repo-local or home-local Codex marketplace entry.

Notes:

- `.mcp.json` starts `scripts\start-server.ps1`, which locates `node.exe` dynamically.
- `client_area_only: true` captures the full client area of the target window, not a centered crop.
- Separate top-level OS dialogs, such as a file picker, are not composited into the main app capture.
- Input logging is best-effort and stored as a separate artifact next to the video and frames.
