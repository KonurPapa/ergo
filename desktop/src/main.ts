/**
 * Ergo Bridge: keeps Ergo's device bridge running in the background (tray icon, starts at login) so the Ergo web app
 * can reach this computer without anyone opening a terminal. The bridge runs in a utility process (bridge-process.ts)
 * that is restarted whenever it exits.
 */
import { app, Menu, Notification, Tray, nativeImage, shell, utilityProcess, type UtilityProcess } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeUpdateState } from '../../src/lib/bridgeProtocol.ts';

const APP_ID = 'network.appwrite.ergo.bridge';
const ERGO_URL = 'https://ergo.appwrite.network';
/** The Ergo page links to ergo-bridge://start to launch an installed bridge that isn't running. */
const PROTOCOL = 'ergo-bridge';
/** Added to the login item (Windows, Linux) so a start at login stays quiet instead of opening Ergo. */
const AT_LOGIN_ARG = '--at-login';
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** A downloaded update installs at the first of these checks that finds no agent session running. */
const INSTALL_IDLE_POLL_MS = 30_000;
const BUSY_QUERY_TIMEOUT_MS = 5_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

type BridgeState = { kind: 'starting' } | { kind: 'running'; port: number } | { kind: 'stopped'; detail: string };
/** What to do once the bridge is up, which depends on how the app was launched. */
type OnReady = 'nothing' | 'announce' | 'open-ergo';
type Settings = { setUpAt?: string };

let tray: Tray | null = null;
let bridge: UtilityProcess | null = null;
let state: BridgeState = { kind: 'starting' };
let consecutiveFailures = 0;
let quitting = false;
let onReady: OnReady = 'nothing';
let update: BridgeUpdateState = { status: 'idle' };
let installTimer: ReturnType<typeof setInterval> | null = null;
let pendingBusyQuery: ((sessions: number) => void) | null = null;
let log: (text: string) => void = (text) => void process.stdout.write(text);

const isProtocolLaunch = (argv: string[]) => argv.some((arg) => arg.startsWith(`${PROTOCOL}:`));
const openErgo = () => void shell.openExternal(ERGO_URL);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS delivers ergo-bridge:// links as an event, possibly before 'ready'.
  app.on('open-url', (event) => {
    event.preventDefault();
    if (app.isReady()) announce();
    else onReady = 'announce';
  });
  // Launched again while running: from the Ergo page's link there is nothing to do; otherwise take them to Ergo.
  app.on('second-instance', (_event, argv) => (isProtocolLaunch(argv) ? announce() : openErgo()));
  // macOS: opened again from Finder or Launchpad (this also fires during the first launch, while still starting).
  app.on('activate', () => {
    if (state.kind === 'running') openErgo();
  });
  app.on('before-quit', () => {
    quitting = true;
    bridge?.kill();
  });
  void app.whenReady().then(start);
}

function start() {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  app.dock?.hide();
  log = openLog();
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);

  const settings = readSettings();
  if (!settings.setUpAt) {
    // First run, right after installing: start at login from now on, and say where to go next.
    if (app.isPackaged) setStartAtLogin(true);
    writeSettings({ ...settings, setUpAt: new Date().toISOString() });
    onReady = 'announce';
  } else if (onReady === 'nothing' && !process.argv.includes(AT_LOGIN_ARG)) {
    // macOS gives login launches no marker, so opening it there never opens the browser by itself.
    onReady = isProtocolLaunch(process.argv) ? 'announce' : process.platform === 'darwin' ? 'nothing' : 'open-ergo';
  }

  tray = new Tray(trayIcon());
  // Windows only shows a tray icon's menu on right-click unless asked.
  if (process.platform === 'win32') tray.on('click', () => tray?.popUpContextMenu());
  refreshTray();
  setupUpdater();
  startBridge();
  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS).unref();
}

function startBridge() {
  state = { kind: 'starting' };
  refreshTray();
  const child = utilityProcess.fork(path.join(__dirname, 'bridge.cjs'), [], {
    serviceName: 'Ergo Bridge',
    stdio: 'pipe',
    env: {
      ...process.env,
      ERGO_BRIDGE_HOME: path.join(app.getPath('userData'), 'bridge'),
      // Reported to the web app (with the bridge's protocol), which asks an older bridge to update.
      ERGO_BRIDGE_VERSION: app.getVersion(),
      // Built-in skill guides: extraResources when packaged, the repo's own docs/ under `npm start`.
      ERGO_BRIDGE_RESOURCES: app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..'),
    },
  });
  bridge = child;
  child.stdout?.on('data', (chunk) => log(String(chunk)));
  child.stderr?.on('data', (chunk) => log(String(chunk)));
  child.on('message', (message: { type?: string; port?: number; message?: string; sessions?: number }) => {
    if (message.type === 'listening' && message.port) {
      child.postMessage({ type: 'update-state', state: update });
      bridgeReady(message.port);
    }
    // The web app found this bridge out of date (POST /api/bridge/update).
    if (message.type === 'check-update') checkForUpdates();
    if (message.type === 'busy' && pendingBusyQuery) {
      const resolve = pendingBusyQuery;
      pendingBusyQuery = null;
      resolve(message.sessions ?? 0);
    }
    if (message.type === 'fatal') {
      state = { kind: 'stopped', detail: message.message || 'it failed to start' };
      refreshTray();
    }
  });
  child.on('exit', (code) => {
    if (bridge === child) bridge = null;
    if (quitting) return;
    const delay = RESTART_DELAYS_MS[Math.min(consecutiveFailures++, RESTART_DELAYS_MS.length - 1)];
    log(`[Ergo Bridge] Bridge process exited (code ${code}); restarting in ${delay / 1000}s\n`);
    if (state.kind !== 'stopped') state = { kind: 'stopped', detail: `restarting in ${delay / 1000}s` };
    refreshTray();
    setTimeout(() => {
      if (!quitting && !bridge) startBridge();
    }, delay);
  });
}

function bridgeReady(port: number) {
  consecutiveFailures = 0;
  state = { kind: 'running', port };
  refreshTray();
  const next = onReady;
  onReady = 'nothing';
  if (next === 'open-ergo') openErgo();
  if (next === 'announce') announce();
}

function restartBridge() {
  consecutiveFailures = 0;
  // The exit handler starts the new one.
  if (bridge) bridge.kill();
  else startBridge();
}

function announce() {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Ergo Bridge is running',
    body: 'Go back to Ergo in your browser: it connects to this computer automatically.',
  }).show();
}

function refreshTray() {
  if (!tray) return;
  const status = state.kind === 'running'
    ? `running on port ${state.port}`
    : state.kind === 'starting'
      ? 'starting…'
      : `not running (${state.detail})`;
  tray.setToolTip(`Ergo Bridge: ${status}`);
  const updateLabel =
    update.status === 'downloading' ? `Downloading update ${update.version ?? ''} (${update.percent ?? 0}%)`
      : update.status === 'ready' ? `Update ${update.version ?? ''} installs when no task is running`
        : update.status === 'installing' ? 'Installing update…'
          : null;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Ergo Bridge is ${status}`, enabled: false },
    ...(updateLabel ? [{ label: updateLabel, enabled: false }] : []),
    { label: 'Open Ergo', click: openErgo },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: isStartAtLogin(), click: (item) => setStartAtLogin(item.checked) },
    { label: 'Restart bridge', click: restartBridge },
    { label: 'Show logs', click: () => shell.showItemInFolder(logPath()) },
    { type: 'separator' },
    { label: 'Quit Ergo Bridge', click: () => app.quit() },
  ]));
}

function trayIcon() {
  // tray@2x.png next to it is picked up on high-DPI screens.
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  // macOS menu-bar icons are drawn at 18pt or less.
  return process.platform === 'darwin' ? icon.resize({ height: 18 }) : icon;
}

function isStartAtLogin(): boolean {
  if (process.platform === 'linux') return fs.existsSync(linuxAutostartFile());
  return app.getLoginItemSettings({ args: [AT_LOGIN_ARG] }).openAtLogin;
}

function setStartAtLogin(enabled: boolean) {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [AT_LOGIN_ARG] });
    return;
  }
  // Electron has no login items on Linux: use an XDG autostart entry.
  const file = linuxAutostartFile();
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }
  // An AppImage runs from a temporary mount, so start the AppImage file itself.
  const executable = process.env.APPIMAGE || process.execPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Ergo Bridge\nExec="${executable}" ${AT_LOGIN_ARG}\nX-GNOME-Autostart-enabled=true\n`);
}

function linuxAutostartFile() {
  return path.join(app.getPath('appData'), 'autostart', 'ergo-bridge.desktop');
}

/**
 * Updates are automatic: found updates download right away, and a downloaded update installs (quietly, then the app
 * starts again) as soon as no agent session is running, so a running task is never cut off. The web app sees the
 * progress through the bridge (`bridge.update`) and can ask for a check (POST /api/bridge/update).
 */
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.logger = {
    info: (message?: unknown) => log(`[Ergo Bridge] Updater: ${String(message)}\n`),
    warn: (message?: unknown) => log(`[Ergo Bridge] Updater: ${String(message)}\n`),
    error: (message?: unknown) => log(`[Ergo Bridge] Updater error: ${String(message)}\n`),
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => setUpdate({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (progress) => setUpdate({ ...update, status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'up-to-date' }));
  autoUpdater.on('update-downloaded', (info) => {
    setUpdate({ status: 'ready', version: info.version });
    installWhenIdle();
  });
  // Unsigned macOS builds can't update themselves; the error is shown and the next check tries again.
  autoUpdater.on('error', (err: Error) => setUpdate({ status: 'error', message: err.message }));
}

function setUpdate(next: BridgeUpdateState) {
  update = next;
  bridge?.postMessage({ type: 'update-state', state: update });
  refreshTray();
}

function checkForUpdates() {
  if (!app.isPackaged) {
    setUpdate({ status: 'error', message: 'This is a development build of Ergo Bridge: it does not update itself.' });
    return;
  }
  if (update.status === 'ready') return installWhenIdle();
  if (update.status === 'checking' || update.status === 'downloading' || update.status === 'installing') return;
  autoUpdater.checkForUpdates().catch((err: Error) => {
    log(`[Ergo Bridge] Update check failed: ${err.message}\n`);
    setUpdate({ status: 'error', message: err.message });
  });
}

/** Agent sessions running in the bridge (0 when it doesn't answer: a stuck bridge mustn't block its own update). */
function runningSessions(): Promise<number> {
  const child = bridge;
  if (!child) return Promise.resolve(0);
  return new Promise((resolve) => {
    pendingBusyQuery = resolve;
    child.postMessage({ type: 'busy-query' });
    setTimeout(() => {
      if (pendingBusyQuery === resolve) {
        pendingBusyQuery = null;
        resolve(0);
      }
    }, BUSY_QUERY_TIMEOUT_MS);
  });
}

function installWhenIdle() {
  if (installTimer) return;
  const attempt = async () => {
    const sessions = await runningSessions();
    if (sessions > 0) {
      if (update.waitingForSessions !== sessions) setUpdate({ ...update, waitingForSessions: sessions });
      return;
    }
    if (installTimer) clearInterval(installTimer);
    installTimer = null;
    setUpdate({ status: 'installing', version: update.version });
    log(`[Ergo Bridge] Installing update ${update.version ?? ''}\n`);
    // Silent install, then start the new version.
    autoUpdater.quitAndInstall(true, true);
  };
  installTimer = setInterval(() => void attempt(), INSTALL_IDLE_POLL_MS);
  void attempt();
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings: Settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function logPath() {
  return path.join(app.getPath('logs'), 'bridge.log');
}

/** Appends to bridge.log (moved to bridge.log.old once it passes MAX_LOG_BYTES); echoes to stdout under `npm start`. */
function openLog(): (text: string) => void {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`);
  } catch {}
  const stream = fs.createWriteStream(file, { flags: 'a' });
  return (text) => {
    stream.write(text);
    if (!app.isPackaged) process.stdout.write(text);
  };
}
