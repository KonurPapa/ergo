/**
 * Ergo Local Device Bridge Client
 *
 * Facilitates secure, seamless local device access for both:
 * 1. Localhost deployments (direct native port connection)
 * 2. Hosted web deployments (e.g. Appwrite, Vercel) connecting to the user's
 *    local Ergo bridge daemon on localhost:5173 (or custom port).
 *
 * Provides:
 * - Persistent configuration in localStorage
 * - Auto-detection and auto-reconnect with heartbeat
 * - WebSocket PTY terminal URL generator
 * - File change EventSource (SSE) URL generator
 * - Disconnect detection and user reconnect notifications
 */

import type { BridgeInfo } from './bridgeProtocol';
export interface BridgeStatus {
  isConnected: boolean;
  isChecking: boolean;
  bridgeUrl: string;
  url: string;
  storageDir?: string;
  homeDir?: string;
  /** Folder the bridge runs from (where `npm run dev` starts it), remembered from the last connection. */
  appDir?: string;
  error?: string | null;
  diagnosis?: BridgeDiagnosis;
  /** A request to the bridge is being held by the browser until the user answers its "apps on this device" prompt. */
  awaitingPermission?: boolean;
  isMixedContentBlocked?: boolean;
  lastCheckedAt?: string;
  lastHeartbeat?: string;
  /** What the connected bridge reports about itself; null for a bridge older than the version handshake. */
  bridgeInfo?: BridgeInfo | null;
}

/**
 * Why the bridge can't be used. 'permission-prompt': the browser held our requests while its local-access prompt
 * went unanswered. 'permission-denied': the user blocked this site from reaching apps on this device.
 */
export type BridgeDiagnosis = 'ok' | 'unreachable' | 'origin-refused' | 'permission-prompt' | 'permission-denied';

/** The browser's permission for this page to reach localhost; 'unsupported' where there is none to ask for. */
export type LoopbackPermission = PermissionState | 'unsupported';

const STORAGE_KEY_BRIDGE_URL = 'ergo_local_bridge_url';
const STORAGE_KEY_AUTO_CONNECT = 'ergo_bridge_auto_connect';
const STORAGE_KEY_APP_DIR = 'ergo_bridge_app_dir';
export const DEFAULT_BRIDGE_URL = 'http://localhost:5173';
// Vite silently moves to the next free port when 5173 is taken, so the bridge is often on 5174, 5175, ...
const FALLBACK_BRIDGE_PORTS = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 3000];
const PROBE_TIMEOUT_MS = 2500;
// Chrome (142+) and Firefox (149+) make a public site ask before it may reach localhost ("access other apps and
// services on this device") and hold each request until the user answers. A probe that may be waiting on that prompt
// gets minutes rather than PROBE_TIMEOUT_MS, because aborting it early reads as "bridge not running".
const PERMISSION_WAIT_MS = 120_000;
// The bridge answers in milliseconds, but Windows takes a few seconds to refuse a closed localhost port (it retries
// the connection after each refusal), so only a request still pending after this is being held by the prompt.
const HELD_REQUEST_HINT_MS = 6000;
// Chrome 145+ and Firefox call it 'loopback-network'; Chrome 142–144 only know the combined 'local-network-access'.
const LOOPBACK_PERMISSION_NAMES = ['loopback-network', 'local-network-access'];
// Ergo Bridge installers (desktop/electron-builder.yml); "latest/download" always serves the newest release.
const BRIDGE_DOWNLOADS = 'https://github.com/KonurPapa/ergo/releases/latest/download';
const BRIDGE_LATEST_RELEASE_API = 'https://api.github.com/repos/KonurPapa/ergo/releases/latest';
/** Registered by Ergo Bridge when installed: opens it if it isn't running. */
export const BRIDGE_LAUNCH_URL = 'ergo-bridge://start';

/** The Ergo Bridge installer for this computer, or null where there is none (phones, tablets, ChromeOS). */
export function getBridgeDownload(): { platform: string; url: string } | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  // iPads ask for desktop sites with a Mac user agent.
  if (/Android|iPhone|iPad|iPod|CrOS/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return null;
  if (/Windows/.test(ua)) return { platform: 'Windows', url: `${BRIDGE_DOWNLOADS}/Ergo-Bridge-Setup.exe` };
  if (/Macintosh/.test(ua)) return { platform: 'macOS', url: `${BRIDGE_DOWNLOADS}/Ergo-Bridge.dmg` };
  if (/Linux/.test(ua)) return { platform: 'Linux', url: `${BRIDGE_DOWNLOADS}/Ergo-Bridge.AppImage` };
  return null;
}

let publishedAssets: Promise<Set<string> | null> | null = null;

/**
 * Whether the latest GitHub release has the installer at `url`. A published asset link downloads the file straight
 * away (GitHub serves it as an attachment, so the page stays put); one that isn't published yet lands on GitHub's 404
 * page. Resolves null when GitHub doesn't answer (offline, or its 60-requests-an-hour anonymous limit).
 */
export async function isBridgeDownloadPublished(url: string): Promise<boolean | null> {
  publishedAssets ??= fetch(BRIDGE_LATEST_RELEASE_API)
    .then(async (res) => {
      if (res.status === 404) return new Set<string>();
      if (!res.ok) return null;
      const release = await res.json();
      return new Set<string>((release.assets ?? []).map((asset: { name: string }) => asset.name));
    })
    .catch(() => null);
  const assets = await publishedAssets;
  return assets ? assets.has(url.slice(url.lastIndexOf('/') + 1)) : null;
}

/**
 * True when fetch() failed before getting any HTTP response (bridge offline, CORS rejection,
 * mixed-content block). Each browser words this differently.
 */
export function isNetworkError(err: any): boolean {
  if (err?.name !== 'TypeError') return false;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed') || msg.includes('network request failed');
}

/** Safari and every iOS browser (all WebKit) refuse https pages any request to http://localhost. */
function isWebKitOnlyBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua));
}

/** How to lift a blocked localhost permission, in the browser's own words (Chrome, Edge and Brave share theirs). */
function unblockInstructions(): string {
  if (typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent)) {
    return 'click the permissions icon at the left of the address bar, remove the block on "Access this device", then reload this page and choose Allow when Firefox asks.';
  }
  return 'click the icon at the left of the address bar, open Site settings, set "Apps on device" (older versions: "Local network access") to Allow, then reload this page.';
}

class BridgeClient {
  private bridgeUrl: string = DEFAULT_BRIDGE_URL;
  private isConnected: boolean = false;
  private isChecking: boolean = false;
  private storageDir: string = '~/.ergo';
  private homeDir: string = '';
  private appDir: string = '';
  private bridgeInfo: BridgeInfo | null = null;
  private lastError: string | null = null;
  private isMixedContentBlocked: boolean = false;
  private lastDiagnosis: BridgeDiagnosis = 'unreachable';
  private lastPermission: LoopbackPermission = 'unsupported';
  private permissionStatus: Promise<PermissionStatus | null> | null = null;
  /** Requests the browser is holding for its local-access prompt (see trackHeld). */
  private heldRequests = new Set<symbol>();
  private checkInFlight: Promise<{ success: boolean; error?: string; isMixedContentBlocked?: boolean }> | null = null;
  private lastCheckedAt: string = '';
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<(status: BridgeStatus) => void> = new Set();

  constructor() {
    if (typeof window !== 'undefined') {
      const savedUrl = localStorage.getItem(STORAGE_KEY_BRIDGE_URL);
      if (savedUrl) {
        this.bridgeUrl = savedUrl.replace(/\/+$/, '');
      } else {
        // Default to http://localhost:5173 for hosted web apps
        this.bridgeUrl = this.isHostedWeb() ? DEFAULT_BRIDGE_URL : window.location.origin;
      }
      try {
        this.appDir = localStorage.getItem(STORAGE_KEY_APP_DIR) || '';
      } catch {}
    }
  }

  /**
   * Determine if the app is currently running in a hosted web environment
   * (e.g. Appwrite, Vercel, custom domain) rather than locally on localhost / 127.0.0.1.
   */
  public isHostedWeb(): boolean {
    if (typeof window === 'undefined') return false;
    const host = window.location.hostname;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1';
  }

  /**
   * Determine if the hosted web app is running under HTTPS
   */
  public isSecureContext(): boolean {
    if (typeof window === 'undefined') return false;
    return window.location.protocol === 'https:';
  }

  /**
   * Get the current bridge base URL.
   */
  public getBridgeUrl(): string {
    return this.bridgeUrl;
  }

  /**
   * Update and save the bridge base URL (e.g. http://localhost:5173 or custom port).
   */
  public setBridgeUrl(url: string): void {
    const clean = (url || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
    this.bridgeUrl = clean;
    try {
      localStorage.setItem(STORAGE_KEY_BRIDGE_URL, clean);
    } catch {}
    this.notify();
  }

  /**
   * Build a full endpoint URL routing to the local bridge when on hosted web.
   */
  public getApiUrl(endpoint: string): string {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    // If running on localhost directly, relative /api/... is preferred and works natively
    if (!this.isHostedWeb()) {
      return cleanEndpoint;
    }
    // On hosted web, route to configured local bridge daemon (e.g. http://localhost:5173/api/...)
    return `${this.bridgeUrl}${cleanEndpoint}`;
  }

  /**
   * Build a WebSocket URL for PTY terminals.
   */
  public getWsUrl(endpoint = '/api/pty'): string {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    if (!this.isHostedWeb()) {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      return `${protocol}://${window.location.host}${cleanEndpoint}`;
    }
    // Hosted web: convert http(s)://localhost:5173 to ws(s)://localhost:5173
    try {
      const parsed = new URL(this.bridgeUrl);
      const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProtocol}//${parsed.host}${cleanEndpoint}`;
    } catch {
      return `ws://localhost:5173${cleanEndpoint}`;
    }
  }

  /**
   * Human-readable explanation for a request that never reached the bridge.
   * `diagnosis` comes from checkConnection(); without it we can only list the possible causes.
   */
  public describeUnreachable(diagnosis: BridgeDiagnosis = this.lastDiagnosis): string {
    if (!this.isHostedWeb()) {
      return 'Unable to reach the local Ergo server. Make sure `npm run dev` is still running.';
    }
    const origin = window.location.origin;
    const site = window.location.host;
    switch (diagnosis) {
      case 'origin-refused':
        return `A local server answered on this device, but it refuses requests from ${origin}. ` +
          `Update your local Ergo copy (git pull), restart it (npm run dev), then try again. ` +
          `If you host Ergo on another domain, add ${origin} to ERGO_ALLOWED_ORIGINS in .env.local.`;
      case 'permission-denied':
        return `Your browser is blocking ${site} from accessing apps on this device, so it can't reach your local Ergo bridge. ` +
          `To allow it, ${unblockInstructions()}`;
      case 'permission-prompt':
        return `Your browser is asking whether ${site} may "access other apps and services on this device". ` +
          `Click Allow in that prompt next to the address bar: that is how this page reaches the Ergo bridge running on your computer.`;
      case 'ok':
        return 'Your local Ergo bridge is running, but this request to it failed before an answer came back. ' +
          'Check the terminal running npm run dev for errors, then try again.';
      default:
        if (isWebKitOnlyBrowser()) {
          return `Safari (like every browser on iPhone and iPad) blocks websites from reaching apps on your computer, so ${site} can't reach your local Ergo bridge. ` +
            'Use Chrome, Edge or Firefox, or open Ergo directly at http://localhost:5173.';
        }
        // Browsers only ask for local access once something answers, so "nothing answered" means nothing is running.
        return "Ergo Bridge isn't running on this computer, so this page can't reach your files or run AI tools here " +
          `(nothing answered at ${this.bridgeUrl} or the nearby ports Ergo checks). Install Ergo Bridge, or open it if you ` +
          `already have it: Ergo connects as soon as it's running, once you allow ${site} to access apps on this device.`;
    }
  }

  /**
   * The browser's permission for this page to reach apps on this device (Local Network Access), looked up once.
   * Answering the prompt re-checks the bridge right away instead of at the next heartbeat.
   */
  private getPermissionStatus(): Promise<PermissionStatus | null> {
    if (!this.permissionStatus) {
      this.permissionStatus = (async () => {
        if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null;
        for (const name of LOOPBACK_PERMISSION_NAMES) {
          try {
            const status = await navigator.permissions.query({ name } as unknown as PermissionDescriptor);
            status.addEventListener('change', () => {
              // The prompt was answered: held requests are released (or failed), so drop the hint and re-check now.
              this.heldRequests.clear();
              this.notify();
              if (status.state === 'granted') {
                // Access granted some other way (site settings, another tab) leaves the prompt's held requests stuck,
                // so don't wait on the check in flight.
                this.checkInFlight = null;
                this.checkConnection().catch(() => {});
              }
            });
            return status;
          } catch {
            // Not a permission name this browser knows.
          }
        }
        return null;
      })();
    }
    return this.permissionStatus;
  }

  /** 'unsupported' off hosted web and in browsers without Local Network Access. */
  public async getLoopbackPermission(): Promise<LoopbackPermission> {
    if (!this.isHostedWeb()) return 'unsupported';
    const status = await this.getPermissionStatus();
    return status ? status.state : 'unsupported';
  }

  /**
   * Awaits a bridge request the browser may hold until the user answers its local-access prompt, flagging
   * `awaitingPermission` once it has been pending long enough that the prompt must be what it's waiting on.
   */
  private async trackHeld<T>(request: Promise<T>, mayBeHeld: boolean): Promise<T> {
    if (!mayBeHeld) return request;
    const token = Symbol('held-request');
    const timer = setTimeout(() => {
      this.heldRequests.add(token);
      this.notify();
    }, HELD_REQUEST_HINT_MS);
    try {
      return await request;
    } finally {
      clearTimeout(timer);
      if (this.heldRequests.delete(token)) this.notify();
    }
  }

  /**
   * Get current connection status snapshot.
   */
  public getStatus(): BridgeStatus {
    return {
      isConnected: this.isConnected,
      isChecking: this.isChecking,
      bridgeUrl: this.bridgeUrl,
      url: this.bridgeUrl,
      storageDir: this.storageDir,
      homeDir: this.homeDir,
      appDir: this.appDir || undefined,
      error: this.lastError,
      diagnosis: this.lastDiagnosis,
      awaitingPermission: this.heldRequests.size > 0,
      isMixedContentBlocked: this.isMixedContentBlocked,
      lastCheckedAt: this.lastCheckedAt,
      lastHeartbeat: this.lastCheckedAt,
      bridgeInfo: this.isConnected ? this.bridgeInfo : undefined
    };
  }

  /**
   * Subscribe to status changes.
   */
  public subscribe(callback: (status: BridgeStatus) => void): () => void {
    this.listeners.add(callback);
    callback(this.getStatus());
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    const status = this.getStatus();
    this.listeners.forEach((cb) => {
      try {
        cb(status);
      } catch (err) {
        console.warn('[BridgeClient] Error in status listener:', err);
      }
    });
  }

  /**
   * Probe one candidate URL. Resolves with the bridge info if it's a reachable Ergo bridge,
   * otherwise with why not: 'refused' (an HTTP error came back), 'origin-refused' (something is
   * listening but the browser blocked the response, i.e. CORS), 'timeout' or 'unreachable'.
   */
  private async probe(baseUrl: string, relative: boolean, timeoutMs: number): Promise<
    | { ok: true; url: string; data: any }
    | { ok: false; url: string; reason: 'refused' | 'origin-refused' | 'unreachable' | 'timeout'; message: string }
  > {
    const endpoint = relative ? '/api/storage/config' : `${baseUrl}/api/storage/config`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const mayBeHeld = timeoutMs === PERMISSION_WAIT_MS;
    try {
      const res = await this.trackHeld(fetch(endpoint, { method: 'GET', signal: controller.signal }), mayBeHeld);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: true, url: baseUrl, data };
      }
      return { ok: false, url: baseUrl, reason: 'refused', message: `Device bridge at ${baseUrl} returned HTTP ${res.status}` };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return { ok: false, url: baseUrl, reason: 'timeout', message: 'Connection timed out. Make sure Ergo is running locally on your device.' };
      }
      if (!isNetworkError(err)) {
        return { ok: false, url: baseUrl, reason: 'unreachable', message: err?.message || 'Unable to reach local bridge' };
      }
      // A no-cors request resolves (opaque) whenever *something* answers, even if CORS would
      // block reading the reply. That tells "server up but refusing us" apart from "nothing there".
      try {
        await this.trackHeld(fetch(endpoint, { method: 'GET', mode: 'no-cors', signal: controller.signal }), mayBeHeld);
        return { ok: false, url: baseUrl, reason: 'origin-refused', message: `A server at ${baseUrl} refused this site.` };
      } catch (fallbackErr: any) {
        // Held by the prompt until our timer ran out: something is listening there.
        if (fallbackErr?.name === 'AbortError') {
          return { ok: false, url: baseUrl, reason: 'timeout', message: 'Connection timed out. Make sure Ergo is running locally on your device.' };
        }
        return { ok: false, url: baseUrl, reason: 'unreachable', message: `Nothing answered at ${baseUrl}.` };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Probes while the browser's local-access prompt is unanswered. Firefox holds only the newest request waiting on that
   * prompt and fails the rest at once, so the likeliest URL goes alone first; the others then go together rather than
   * in turn, because on Windows every closed port takes seconds to refuse. Stops early on a hit, on a probe the user
   * left waiting (the prompt is the problem, not the port), or once the prompt is answered (the caller re-probes).
   */
  private async probeWhilePrompting(urls: string[]) {
    const [first, ...rest] = urls;
    const head = await this.probe(first, false, PERMISSION_WAIT_MS);
    if (!rest.length || head.ok || ('reason' in head && head.reason === 'timeout') || (await this.getLoopbackPermission()) !== 'prompt') {
      return [head];
    }
    return [head, ...(await Promise.all(rest.map((url) => this.probe(url, false, PERMISSION_WAIT_MS))))];
  }

  /**
   * Check connection to the local bridge. On hosted web every plausible local port is probed in
   * parallel, because Vite moves to 5174+ when 5173 is busy. Pass `exclusive` to test only `targetUrl`.
   */
  public async checkConnection(targetUrl?: string, options: { exclusive?: boolean } = {}): Promise<{ success: boolean; error?: string; isMixedContentBlocked?: boolean }> {
    // Same candidates as an untargeted check, so share it: two checks at once would also fight over the browser's prompt.
    const shared = !targetUrl || (!options.exclusive && targetUrl.replace(/\/+$/, '') === this.bridgeUrl);
    if (this.checkInFlight && shared) return this.checkInFlight;
    const run = this.runCheckConnection(targetUrl, options);
    if (shared) {
      this.checkInFlight = run;
      run.finally(() => {
        if (this.checkInFlight === run) this.checkInFlight = null;
      });
    }
    return run;
  }

  private async runCheckConnection(targetUrl: string | undefined, options: { exclusive?: boolean }): Promise<{ success: boolean; error?: string; isMixedContentBlocked?: boolean }> {
    this.isChecking = true;
    this.notify();

    const hosted = this.isHostedWeb();
    const clean = (u: string) => u.replace(/\/+$/, '');
    const preferred = targetUrl ? clean(targetUrl) : clean(this.bridgeUrl);

    let candidateUrls: string[];
    if (!hosted) {
      candidateUrls = [preferred];
    } else if (targetUrl && options.exclusive) {
      candidateUrls = [preferred];
    } else {
      candidateUrls = Array.from(new Set([
        preferred,
        ...FALLBACK_BRIDGE_PORTS.map((port) => `http://localhost:${port}`),
        'http://127.0.0.1:5173'
      ]));
    }

    // Only a decided permission guarantees a quick answer; otherwise a running bridge may sit behind the prompt.
    const relative = !hosted && !targetUrl;
    const permission = await this.getLoopbackPermission();
    const mayBeHeld = hosted && permission !== 'granted' && permission !== 'denied';
    const probeAll = (timeoutMs: number) => Promise.all(candidateUrls.map((url) => this.probe(url, relative, timeoutMs)));
    let results = permission === 'prompt' && hosted
      ? await this.probeWhilePrompting(candidateUrls)
      : await probeAll(mayBeHeld ? PERMISSION_WAIT_MS : PROBE_TIMEOUT_MS);
    this.lastPermission = await this.getLoopbackPermission();
    // Allowed mid-check: whatever failed before that was blocked or displaced by the prompt, so look again.
    if (permission !== 'granted' && this.lastPermission === 'granted' && !results.some((r) => r.ok)) {
      results = await probeAll(PROBE_TIMEOUT_MS);
    }

    // Prefer the user's configured URL, then the lowest port that answered.
    const hit = results.find((r) => r.ok);
    if (hit && hit.ok) {
      const data = hit.data;
      this.isConnected = true;
      this.isChecking = false;
      this.lastError = null;
      this.lastDiagnosis = 'ok';
      this.isMixedContentBlocked = false;
      this.lastCheckedAt = new Date().toISOString();
      if (data.resolvedPath) this.storageDir = data.resolvedPath;
      this.bridgeInfo = data.bridge && typeof data.bridge.protocol === 'number' ? (data.bridge as BridgeInfo) : null;
      if (data.homeDir) this.homeDir = data.homeDir;
      if (typeof data.appDir === 'string' && data.appDir) {
        this.appDir = data.appDir;
        try {
          localStorage.setItem(STORAGE_KEY_APP_DIR, data.appDir);
        } catch {}
      }
      this.setBridgeUrl(hit.url);
      try {
        localStorage.setItem(STORAGE_KEY_AUTO_CONNECT, 'true');
      } catch {}
      this.notify();
      return { success: true };
    }

    const failures = results.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
    // Other apps often sit on the fallback ports (3000 especially) and answer without CORS headers too, so only the
    // bridge's own address can mean "an outdated Ergo refusing this site"; anything else is just not Ergo.
    const originRefused = failures.find(
      (f) => f.reason === 'origin-refused' && (f.url === preferred || f.url === DEFAULT_BRIDGE_URL || f.url === 'http://127.0.0.1:5173')
    );
    const httpRefused = failures.find((f) => f.reason === 'refused');
    // A blocked permission fails every request instantly, exactly like a closed port, so ask the browser which it was.
    this.lastDiagnosis = this.lastPermission === 'denied'
      ? 'permission-denied'
      : originRefused
        ? 'origin-refused'
        : this.lastPermission === 'prompt' && failures.some((f) => f.reason === 'timeout')
          ? 'permission-prompt'
          : 'unreachable';

    this.isConnected = false;
    this.isChecking = false;
    this.isMixedContentBlocked = hosted && this.isSecureContext() && this.lastDiagnosis === 'unreachable' && isWebKitOnlyBrowser();

    if (httpRefused && this.lastDiagnosis === 'unreachable') {
      this.lastError = httpRefused.message;
    } else if (!hosted) {
      this.lastError = failures[0]?.message || 'Unable to reach local bridge';
    } else {
      this.lastError = this.describeUnreachable(this.lastDiagnosis);
    }

    this.lastCheckedAt = new Date().toISOString();
    this.notify();
    return {
      success: false,
      error: this.lastError || undefined,
      isMixedContentBlocked: this.isMixedContentBlocked
    };
  }

  /**
   * fetch() against the bridge that re-discovers it once if the request never reached a server
   * (e.g. the bridge moved to another port since the URL was saved), then retries.
   */
  public async fetch(endpoint: string, init?: RequestInit): Promise<Response> {
    const permission = await this.getLoopbackPermission();
    try {
      return await this.trackHeld(fetch(this.getApiUrl(endpoint), init), permission === 'prompt');
    } catch (err: any) {
      if (!this.isHostedWeb() || !isNetworkError(err)) throw err;
      const before = this.bridgeUrl;
      const res = await this.checkConnection();
      if (!res.success) throw err;
      // Retry only when the first attempt can't have reached the bridge: it was on another port, or the browser blocked
      // it before the user allowed local access. A request that did reach the bridge (e.g. a POST) must not run twice.
      if (this.bridgeUrl === before && permission !== 'prompt' && permission !== 'denied') throw err;
      return fetch(this.getApiUrl(endpoint), init);
    }
  }

  /**
   * Start recurring background heartbeat check.
   */
  public startHeartbeat(intervalMs = 15000): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    // Initial check
    this.checkConnection().catch(() => {});
    this.heartbeatInterval = setInterval(() => {
      this.checkConnection().catch(() => {});
    }, intervalMs);
  }

  /**
   * Stop background heartbeat check.
   */
  public stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}

export const bridgeClient = new BridgeClient();
