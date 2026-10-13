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

export interface BridgeStatus {
  isConnected: boolean;
  isChecking: boolean;
  bridgeUrl: string;
  url: string;
  storageDir?: string;
  homeDir?: string;
  error?: string | null;
  isMixedContentBlocked?: boolean;
  lastCheckedAt?: string;
  lastHeartbeat?: string;
}

export type BridgeDiagnosis = 'ok' | 'unreachable' | 'origin-refused';

const STORAGE_KEY_BRIDGE_URL = 'ergo_local_bridge_url';
const STORAGE_KEY_AUTO_CONNECT = 'ergo_bridge_auto_connect';
export const DEFAULT_BRIDGE_URL = 'http://localhost:5173';
// Vite silently moves to the next free port when 5173 is taken, so the bridge is often on 5174, 5175, ...
const FALLBACK_BRIDGE_PORTS = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 3000];
const PROBE_TIMEOUT_MS = 2500;

/**
 * True when fetch() failed before getting any HTTP response (bridge offline, CORS rejection,
 * mixed-content block). Each browser words this differently.
 */
export function isNetworkError(err: any): boolean {
  if (err?.name !== 'TypeError') return false;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed') || msg.includes('network request failed');
}

class BridgeClient {
  private bridgeUrl: string = DEFAULT_BRIDGE_URL;
  private isConnected: boolean = false;
  private isChecking: boolean = false;
  private storageDir: string = '~/.ergo';
  private homeDir: string = '';
  private lastError: string | null = null;
  private isMixedContentBlocked: boolean = false;
  private lastDiagnosis: BridgeDiagnosis = 'unreachable';
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
    if (diagnosis === 'origin-refused') {
      return `A local server answered on this device, but it refuses requests from ${origin}. ` +
        `Update your local Ergo copy (git pull), restart it (npm run dev), then try again. ` +
        `If you host Ergo on another domain, add ${origin} to ERGO_ALLOWED_ORIGINS in .env.local.`;
    }
    return `Unable to reach your local Ergo bridge (tried ${this.bridgeUrl} and nearby ports). ` +
      `Make sure Ergo is running on this device (npm run dev) and that your browser allows ${origin} to connect to localhost — ` +
      `accept the "access other devices / local network" prompt in Chrome or Edge, or turn off Brave Shields for this site. Safari does not support this.`;
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
      error: this.lastError,
      isMixedContentBlocked: this.isMixedContentBlocked,
      lastCheckedAt: this.lastCheckedAt,
      lastHeartbeat: this.lastCheckedAt
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
   * listening but the browser blocked the response, i.e. CORS), or 'unreachable'.
   */
  private async probe(baseUrl: string, relative: boolean): Promise<
    | { ok: true; url: string; data: any }
    | { ok: false; url: string; reason: 'refused' | 'origin-refused' | 'unreachable'; message: string }
  > {
    const endpoint = relative ? '/api/storage/config' : `${baseUrl}/api/storage/config`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, { method: 'GET', signal: controller.signal });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: true, url: baseUrl, data };
      }
      return { ok: false, url: baseUrl, reason: 'refused', message: `Device bridge at ${baseUrl} returned HTTP ${res.status}` };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return { ok: false, url: baseUrl, reason: 'unreachable', message: 'Connection timed out. Make sure Ergo is running locally on your device.' };
      }
      if (!isNetworkError(err)) {
        return { ok: false, url: baseUrl, reason: 'unreachable', message: err?.message || 'Unable to reach local bridge' };
      }
      // A no-cors request resolves (opaque) whenever *something* answers, even if CORS would
      // block reading the reply. That tells "server up but refusing us" apart from "nothing there".
      try {
        await fetch(endpoint, { method: 'GET', mode: 'no-cors', signal: controller.signal });
        return { ok: false, url: baseUrl, reason: 'origin-refused', message: `A server at ${baseUrl} refused this site.` };
      } catch {
        return { ok: false, url: baseUrl, reason: 'unreachable', message: `Nothing answered at ${baseUrl}.` };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check connection to the local bridge. On hosted web every plausible local port is probed in
   * parallel, because Vite moves to 5174+ when 5173 is busy. Pass `exclusive` to test only `targetUrl`.
   */
  public async checkConnection(targetUrl?: string, options: { exclusive?: boolean } = {}): Promise<{ success: boolean; error?: string; isMixedContentBlocked?: boolean }> {
    if (this.checkInFlight && !targetUrl) return this.checkInFlight;
    const run = this.runCheckConnection(targetUrl, options);
    if (!targetUrl) {
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

    const results = await Promise.all(
      candidateUrls.map((url) => this.probe(url, !hosted && !targetUrl))
    );

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
      if (data.homeDir) this.homeDir = data.homeDir;
      this.setBridgeUrl(hit.url);
      try {
        localStorage.setItem(STORAGE_KEY_AUTO_CONNECT, 'true');
      } catch {}
      this.notify();
      return { success: true };
    }

    const failures = results.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
    const originRefused = failures.find((f) => f.reason === 'origin-refused');
    const httpRefused = failures.find((f) => f.reason === 'refused');
    this.lastDiagnosis = originRefused ? 'origin-refused' : 'unreachable';

    this.isConnected = false;
    this.isChecking = false;
    this.isMixedContentBlocked = hosted && this.isSecureContext() && !originRefused;

    if (httpRefused && !originRefused) {
      this.lastError = httpRefused.message;
    } else if (!hosted) {
      this.lastError = failures[0]?.message || 'Unable to reach local bridge';
    } else {
      this.lastError = this.describeUnreachable(this.lastDiagnosis);
      if (this.isMixedContentBlocked && !this.lastError.includes('Safari')) {
        this.lastError += ' If you use Safari, open Ergo locally at http://localhost:5173 instead.';
      }
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
    try {
      return await fetch(this.getApiUrl(endpoint), init);
    } catch (err: any) {
      if (!this.isHostedWeb() || !isNetworkError(err)) throw err;
      const before = this.bridgeUrl;
      const res = await this.checkConnection();
      if (!res.success) throw err;
      if (this.bridgeUrl === before) throw err;
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
