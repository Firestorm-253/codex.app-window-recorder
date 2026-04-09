# App Window Recorder

This repository is a standalone Codex plugin bundle for App Window Recorder.

If you only want to install and use the plugin, start here:

1. Run `npm install` in `plugins/app-window-recorder`.
2. Open this repository in Codex.
3. Reload plugins or restart Codex.
4. Enable `App Window Recorder` from the Plugins tab.

## Repository Layout

- `.agents/plugins/marketplace.json` registers the plugin for this repository.
- `plugins/app-window-recorder/` contains the actual plugin.

## Installation Requirements

- Windows
- Node.js 18 or newer
- Windows PowerShell
- `ffmpeg` on `PATH`
- `ffprobe` on `PATH`

## Usage

After the plugin is enabled in Codex, use its tools:

- `list_app_windows`
- `record_app_window`

The detailed user documentation lives in:

- `plugins/app-window-recorder/README.md`

## What To Commit

Commit everything in this repository except installed dependencies and generated artifacts.

Already excluded:

- `plugins/app-window-recorder/node_modules/`
- `plugins/app-window-recorder/.npm/`
- `plugins/app-window-recorder/npm-debug.log*`

Not stored in this repo:

- generated captures under `C:\Users\<you>\.codex\tmp\app-window-recorder\`

## First Run Checklist

1. Run `npm install` in `plugins/app-window-recorder`.
2. Confirm `ffmpeg -version` works in a terminal.
3. Open the repo in Codex.
4. Make sure the plugin appears in the Plugins tab.
5. Enable it.
6. Call `list_app_windows` before the first recording so you can confirm your target window is detectable.
