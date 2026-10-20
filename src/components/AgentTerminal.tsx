import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bridgeClient } from '../lib/bridgeClient';
import '@xterm/xterm/css/xterm.css';

// spawnIds this page has already sent a launch for. Re-mounts of the same launch (card re-opened, view
// toggled) attach to the existing PTY instead of asking the server to start the agent again.
const launchedSpawnIds = new Set<string>();

/** True if this mount may launch the process; false if it should only attach to what already ran. */
export function claimPtyLaunch(spawnId: string | undefined, attachOnly: boolean | undefined): boolean {
  if (attachOnly) return false;
  if (!spawnId) return true;
  if (launchedSpawnIds.has(spawnId)) return false;
  launchedSpawnIds.add(spawnId);
  return true;
}

export interface AgentTerminalProps {
  cmd: string;
  args?: string[];
  cwd: string;
  taskId?: string | number;
  sessionId?: string;
  env?: Record<string, string>;
  forceRestart?: boolean;
  spawnId?: string;
  /**
   * Attach to an existing PTY session by `sessionId` (`{type:'attach'}`) and never start a process. Task-run agents
   * are launched by App over REST, so their terminal views always attach. Without it the legacy `spawn` message is
   * sent (login / onboarding terminals).
   */
  attachOnly?: boolean;
  onExit?: (code: number) => void;
  /** Called once the WS + PTY are ready */
  onReady?: () => void;
  /** Called on a spawn/connection error */
  onError?: (message: string) => void;
  /** If true, sends a kill signal to the PTY on unmount (default: false to keep background sessions alive across view toggles) */
  killOnUnmount?: boolean;
}

export const AgentTerminal: React.FC<AgentTerminalProps> = ({
  cmd,
  args = [],
  cwd,
  taskId,
  sessionId,
  env,
  forceRestart,
  spawnId,
  attachOnly,
  onExit,
  onReady,
  onError,
  killOnUnmount = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Callbacks live in refs so a re-render with new inline handlers never reconnects (and replays) the terminal,
  // and an exit always reaches the latest handler instead of the one captured at mount.
  const onExitRef = useRef(onExit);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onExitRef.current = onExit;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  const send = useCallback((obj: object) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify(obj));
      } catch (err) {
        console.warn('[Ergo Terminal] Send error:', err);
      }
    }
  }, []);

  const argsKey = JSON.stringify(args);
  // What the connection depends on: attach-only views follow just the session; legacy spawns restart when the
  // command line changes.
  const connectionKey = attachOnly
    ? `attach:${sessionId || (taskId !== undefined ? String(taskId) : '')}`
    : `spawn:${JSON.stringify([cmd, argsKey, cwd, taskId ?? null, sessionId ?? null])}`;

  useEffect(() => {
    if (!containerRef.current) return;

    let isDisposed = false;

    // Detect active theme from document attribute
    const isLightTheme = document.documentElement.getAttribute('data-theme') === 'light';

    // ── Create xterm terminal ─────────────────────────────────────────────
    const term = new Terminal({
      fontFamily: "'Intel One Mono', 'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Menlo', monospace",
      fontSize: 16,
      lineHeight: 1.4,
      theme: isLightTheme
        ? {
            background:          '#f8fafc',
            foreground:          '#18181b',
            cursor:              '#059669',
            cursorAccent:        '#ffffff',
            selectionBackground: 'rgba(0, 212, 146, 0.2)',
            black:               '#f1f5f9',
            red:                 '#ef4444',
            green:               '#059669',
            yellow:              '#d97706',
            blue:                '#2563eb',
            magenta:             '#8b5cf6',
            cyan:                '#0891b2',
            white:               '#18181b',
            brightBlack:         '#94a3b8',
            brightRed:           '#f43f5e',
            brightGreen:         '#10b981',
            brightYellow:        '#f59e0b',
            brightBlue:          '#3b82f6',
            brightMagenta:       '#a78bfa',
            brightCyan:          '#06b6d4',
            brightWhite:         '#09090b',
          }
        : {
            background:          '#12141a',
            foreground:          '#e4e4e7',
            cursor:              '#00d492',
            cursorAccent:        '#12141a',
            selectionBackground: 'rgba(0, 212, 146, 0.25)',
            black:               '#12141a',
            red:                 '#ef4444',
            green:               '#00d492',
            yellow:              '#eab308',
            blue:                '#2563eb',
            magenta:             '#a78bfa',
            cyan:                '#06b6d4',
            white:               '#e4e4e7',
            brightBlack:         '#52525b',
            brightRed:           '#f87171',
            brightGreen:         '#34d399',
            brightYellow:        '#fde047',
            brightBlue:          '#60a5fa',
            brightMagenta:       '#c4b5fd',
            brightCyan:          '#67e8f9',
            brightWhite:         '#fafafa',
          },
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    const safeFit = () => {
      if (containerRef.current && containerRef.current.clientWidth > 0 && containerRef.current.clientHeight > 0) {
        try {
          fitAddon.fit();
        } catch {}
      }
    };

    safeFit();
    termRef.current = term;
    fitRef.current = fitAddon;

    // ── Open WebSocket to Vite PTY plugin ────────────────────────────────
    const wsUrl = bridgeClient.getWsUrl('/api/pty');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      if (isDisposed) {
        try {
          ws.close();
        } catch {}
        return;
      }
      safeFit();
      const cols = term.cols > 0 ? term.cols : 120;
      const rows = term.rows > 0 ? term.rows : 40;
      if (attachOnly) {
        try {
          ws.send(JSON.stringify({
            type: 'attach',
            sessionId: sessionId || (taskId !== undefined ? String(taskId) : undefined),
            cols,
            rows,
          }));
        } catch (err) {
          console.error('[Ergo Terminal] Attach send error:', err);
        }
        return;
      }
      const mayLaunch = claimPtyLaunch(spawnId, attachOnly);
      try {
        ws.send(JSON.stringify({
          type: 'spawn',
          taskId,
          sessionId: sessionId || (taskId ? String(taskId) : undefined),
          cmd,
          args: Array.isArray(args) ? args : [],
          cwd,
          env,
          cols,
          rows,
          forceRestart: mayLaunch && forceRestart,
          spawnId,
          attachOnly: !mayLaunch,
        }));
      } catch (err) {
        console.error('[Ergo Terminal] Spawn send error:', err);
      }
    });

    ws.addEventListener('message', (ev) => {
      if (isDisposed) return;
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'replay') {
        // A replay is the session's whole output so far: start from a clean screen so re-attaching never doubles it.
        term.reset();
        term.write(msg.data);
      } else if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'ready') {
        onReadyRef.current?.();
      } else if (msg.type === 'exit') {
        term.writeln(`\r\n\x1b[2m─── Process exited with code ${msg.code} ───\x1b[0m`);
        onExitRef.current?.(msg.code);
      } else if (msg.type === 'error') {
        term.writeln(`\r\n\x1b[31m[Ergo PTY error] ${msg.message}\x1b[0m`);
        onErrorRef.current?.(msg.message);
      }
      // 'prompt' / 'auto-approved' notices are for the Notes view; the raw terminal already shows the prompt itself.
    });

    ws.addEventListener('error', () => {
      if (isDisposed) return;
      term.writeln(`\r\n\x1b[31m[Ergo] Could not connect to PTY backend. Is the dev server running?\x1b[0m`);
      onErrorRef.current?.('WebSocket connection failed');
    });

    // ── Forward keystrokes to PTY ─────────────────────────────────────────
    term.onData((data) => {
      if (isDisposed) return;
      send({ type: 'input', taskId, sessionId: sessionId || taskId, data });
    });

    // ── Resize: notify PTY when the container changes size ───────────────
    const handleResize = () => {
      if (isDisposed || !fitRef.current || !termRef.current || !containerRef.current) return;
      if (containerRef.current.clientWidth > 0 && containerRef.current.clientHeight > 0) {
        try {
          fitRef.current.fit();
          const cols = termRef.current.cols > 0 ? termRef.current.cols : 120;
          const rows = termRef.current.rows > 0 ? termRef.current.rows : 40;
          send({ type: 'resize', taskId, sessionId: sessionId || taskId, cols, rows });
        } catch {}
      }
    };

    const ro = new ResizeObserver(handleResize);
    ro.observe(containerRef.current);
    resizeObserverRef.current = ro;

    // ── Cleanup ───────────────────────────────────────────────────────────
    return () => {
      isDisposed = true;
      ro.disconnect();
      if (killOnUnmount && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'kill', taskId, sessionId: sessionId || taskId }));
        } catch {}
      }
      try {
        ws.close();
      } catch {}
      try {
        term.dispose();
      } catch {}
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [connectionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLightTheme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';

  return (
    <div
      ref={containerRef}
      className="agent-terminal-screen"
      style={{
        width: '100%',
        height: '100%',
        background: isLightTheme ? '#f8fafc' : '#0d0f14',
        overflow: 'hidden',
      }}
    />
  );
};

