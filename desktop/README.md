# Ergo Bridge (desktop app)

Ergo Bridge runs Ergo's local device bridge in the background so the hosted web app (`https://ergo.appwrite.network`) can reach a user's computer without them opening a terminal. It is a tray-only Electron app:

- It runs the same bridge `npm run dev` does: the plugins in `../bridge/plugins.ts`, started by `../bridge/standalone.ts` on the first free port of 5173–5180 or 3000.
- The bridge runs in an Electron utility process (`src/bridge-process.ts`), from a writable folder in the app's user-data directory. If that process exits, the tray app (`src/main.ts`) restarts it.
- On first run it turns on **Start at login** and shows a notification pointing back to Ergo. Starts at login are quiet. Opening it by hand on Windows or Linux opens Ergo in the browser.
- The web app's onboarding links to the installers, and to `ergo-bridge://start` to open an installed bridge that isn't running.
- It checks GitHub Releases for updates every six hours (electron-updater). Updates install the next time the app quits.

## Run it locally

```bash
cd desktop
npm install
npm start
```

Quit any `npm run dev` first if you want the app on port 5173; otherwise it picks the next free port. If you start it from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first (VS Code exports it, and it makes Electron run as plain Node).

## Release

1. Bump `version` in `package.json` and commit.
2. Run the **Ergo Bridge release** workflow (`.github/workflows/ergo-bridge.yml`) from the repository's Actions tab.

It builds the installers on Windows, macOS and Linux runners and publishes them to the GitHub release `v<version>`. File names don't change between versions (`Ergo-Bridge-Setup.exe`, `Ergo-Bridge.dmg`, `Ergo-Bridge.AppImage`), so the web app's `releases/latest/download/...` links always serve the newest release. **The download buttons in the web app return 404 until the first release is published.**

To build locally: `npm run dist -- --linux --publish never` (Windows installers need Windows or Wine; macOS builds need a Mac).

## Platform notes

- **Code signing**: builds are unsigned. Windows shows "Windows protected your PC" on first run (More info → Run anyway). macOS blocks unsigned apps until the user allows them under System Settings → Privacy & Security. Notarizing for macOS needs an Apple Developer account. Without signing, macOS builds can't update themselves.
- **macOS**: Apple Silicon only. onnxruntime-node ships no Intel macOS binary, so the memory store's embeddings couldn't run on Intel Macs anyway.
- **Linux**: an AppImage. Its launcher adds `--no-sandbox` by itself where unprivileged user namespaces are blocked (Ubuntu 24.04 and later). With AppImageLauncher installed, running it first shows AppImageLauncher's "integrate or run once" dialog.
- **Size**: each installer ships only its own platform's native binaries (see the `files` rules in `electron-builder.yml`). The Linux AppImage is about 150 MB, most of it Electron itself.
- **CLI agents**: Claude Code installs through its native installer, which needs no Node.js. Codex and Grok still install with npm, so they need Node.js, and the Antigravity and Cursor installers need `bash`, which Windows lacks.
