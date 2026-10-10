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
  lastCheckedAt?: string;
  lastHeartbeat?: string;
}

const STORAGE_KEY_BRIDGE_URL = 'ergo_local_bridge_url';
const STORAGE_KEY_AUTO_CONNECT = 'ergo_bridge_auto_connect';
export const DEFAULT_BRIDGE_URL = 'http://localhost:5173';

class BridgeClient {
  private bridgeUrl: string = DEFAULT_BRIDGE_URL;
  private isConnected: boolean = false;
  private isChecking: boolean = false;
  private storageDir: string = '~/.ergo';
  private homeDir: string = '';
  private lastError: string | null = null;
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
   * Check connection to the local bridge.
   */
  public async checkConnection(targetUrl?: string): Promise<{ success: boolean; error?: string }> {
    this.isChecking = true;
    this.notify();

    const candidateUrls = targetUrl
      ? [targetUrl.replace(/\/+$/, '')]
      : this.isHostedWeb()
        ? Array.from(new Set([
            this.bridgeUrl.replace(/\/+$/, ''),
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://localhost:3000',
            'http://127.0.0.1:3000'
          ]))
        : [this.bridgeUrl.replace(/\/+$/, '')];

    let lastErrorMessage: string | null = null;

    for (const testUrl of candidateUrls) {
      const endpoint = !this.isHostedWeb() && !targetUrl
        ? '/api/storage/config'
        : `${testUrl}/api/storage/config`;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);

        const res = await fetch(endpoint, {
          method: 'GET',
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          this.isConnected = true;
          this.isChecking = false;
          this.lastError = null;
          this.lastCheckedAt = new Date().toISOString();
          if (data.resolvedPath) this.storageDir = data.resolvedPath;
          if (data.homeDir) this.homeDir = data.homeDir;
          this.setBridgeUrl(testUrl);
          try {
            localStorage.setItem(STORAGE_KEY_AUTO_CONNECT, 'true');
          } catch {}
          this.notify();
          return { success: true };
        } else {
          lastErrorMessage = `Device bridge at ${testUrl} returned HTTP ${res.status}`;
        }
      } catch (err: any) {
        lastErrorMessage = err.name === 'AbortError'
          ? 'Connection timed out. Make sure Ergo is running locally on your device.'
          : (err.message || 'Unable to reach local bridge');
      }
    }

    this.isConnected = false;
    this.isChecking = false;
    this.lastError = lastErrorMessage || 'Unable to reach local bridge';
    this.lastCheckedAt = new Date().toISOString();
    this.notify();
    return { success: false, error: this.lastError || undefined };
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
