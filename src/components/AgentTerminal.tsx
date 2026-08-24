import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface AgentTerminalProps {
  cmd: string;
  args?: string[];
  cwd: string;
  onExit?: (code: number) => void;
  /** Called once the WS + PTY are ready */
  onReady?: () => void;
  /** Called on a spawn/connection error */
  onError?: (message: string) => void;
}

export const AgentTerminal: React.FC<AgentTerminalProps> = ({
  cmd,
  args = [],
  cwd,
  onExit,
  onReady,
  onError,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const send = useCallback((obj: object) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify(obj));
      } catch (err) {
        console.warn('[Ergo Terminal] Send error:', err);
      }
    }
  }, []);

  const argsKey = args.join(' ');

  useEffect(() => {
    if (!containerRef.current) return;

    let isDisposed = false;

    // Detect active theme from document attribute
    const isLightTheme = document.documentElement.getAttribute('data-theme') === 'light';

    // ── Create xterm terminal ─────────────────────────────────────────────
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Menlo', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      theme: isLightTheme
        ? {
            background:          '#f8fafc',
            foreground:          '#1e293b',
            cursor:              '#6366f1',
            cursorAccent:        '#ffffff',
            selectionBackground: 'rgba(99, 102, 241, 0.25)',
            black:               '#f1f5f9',
            red:                 '#e11d48',
            green:               '#059669',
            yellow:              '#d97706',
            blue:                '#2563eb',
            magenta:             '#7c3aed',
            cyan:                '#0891b2',
            white:               '#1e293b',
            brightBlack:         '#94a3b8',
            brightRed:           '#f43f5e',
            brightGreen:         '#10b981',
            brightYellow:        '#f59e0b',
            brightBlue:          '#3b82f6',
            brightMagenta:       '#8b5cf6',
            brightCyan:          '#06b6d4',
            brightWhite:         '#0f172a',
          }
        : {
            background:          '#0d0f14',
            foreground:          '#c9d1d9',
            cursor:              '#58a6ff',
            cursorAccent:        '#0d0f14',
            selectionBackground: 'rgba(88, 166, 255, 0.25)',
            black:               '#0d0f14',
            red:                 '#f85149',
            green:               '#56d364',
            yellow:              '#e3b341',
            blue:                '#58a6ff',
            magenta:             '#bc8cff',
            cyan:                '#39c5cf',
            white:               '#c9d1d9',
            brightBlack:         '#4d5566',
            brightRed:           '#ff7b72',
            brightGreen:         '#3fb950',
            brightYellow:        '#d29922',
            brightBlue:          '#79c0ff',
            brightMagenta:       '#d2a8ff',
            brightCyan:          '#56d4dd',
            brightWhite:         '#ffffff',
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
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/pty`;
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
      try {
        ws.send(JSON.stringify({ type: 'spawn', cmd, args: argsKey ? argsKey.split(' ') : [], cwd, cols, rows }));
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

      if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'ready') {
        onReady?.();
      } else if (msg.type === 'exit') {
        term.writeln(`\r\n\x1b[2m─── Process exited with code ${msg.code} ───\x1b[0m`);
        onExit?.(msg.code);
      } else if (msg.type === 'error') {
        term.writeln(`\r\n\x1b[31m[Ergo PTY error] ${msg.message}\x1b[0m`);
        onError?.(msg.message);
      }
    });

    ws.addEventListener('error', () => {
      if (isDisposed) return;
      term.writeln(`\r\n\x1b[31m[Ergo] Could not connect to PTY backend. Is the dev server running?\x1b[0m`);
      onError?.('WebSocket connection failed');
    });

    // ── Forward keystrokes to PTY ─────────────────────────────────────────
    term.onData((data) => {
      if (isDisposed) return;
      send({ type: 'input', data });
    });

    // ── Resize: notify PTY when the container changes size ───────────────
    const handleResize = () => {
      if (isDisposed || !fitRef.current || !termRef.current || !containerRef.current) return;
      if (containerRef.current.clientWidth > 0 && containerRef.current.clientHeight > 0) {
        try {
          fitRef.current.fit();
          const cols = termRef.current.cols > 0 ? termRef.current.cols : 120;
          const rows = termRef.current.rows > 0 ? termRef.current.rows : 40;
          send({ type: 'resize', cols, rows });
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
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'kill' }));
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
  }, [cmd, argsKey, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: '#0d0f14',
        borderRadius: '0 0 var(--radius-md) var(--radius-md)',
        overflow: 'hidden',
      }}
    />
  );
};

