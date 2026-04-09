# App Window Recorder Repo Bundle

This folder is a standalone repo-local Codex plugin bundle for the App Window Recorder plugin.

Repo layout:

- `.agents/plugins/marketplace.json` registers the plugin for Codex when this repo is opened.
- `plugins/app-window-recorder/` contains the full plugin source and package manifests.

What to commit:

- everything in this folder, including `package-lock.json`

What is intentionally excluded:

- `plugins/app-window-recorder/node_modules/`
- generated capture artifacts under `C:\Users\Zehnder\.codex\tmp\app-window-recorder\`
- the separately installed home-local plugin copy under `C:\Users\Zehnder\plugins\app-window-recorder\`

To use this as its own git repo:

1. Initialize git in this folder or copy this folder into a new repository.
2. Run `npm install` in `plugins/app-window-recorder`.
3. Open the repo in Codex and reload plugins.
4. Install or enable `App Window Recorder` from the Plugins tab.
