/**
 * AgentTerminalPane.tsx
 *
 * A resizable panel that docks to the bottom of the AI Workspace right-pane.
 * It hosts one terminal tab per spawned task — multiple tasks can run
 * concurrently, each in their own isolated PTY session.
 *
 * Behaviour:
 *  - The pane slides in from the bottom when `isOpen` becomes true.
 *  - The user can drag the top edge to resize it (clamped 20%–80% of parent).
 *  - Each active/completed session appears as a clickable tab in the header.
 *  - Closing a tab sends a 'kill' over WS and removes the session.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { type TerminalSession, type CliAgentConfig } from '../types';
import { AgentTerminal } from './AgentTerminal';
import { Terminal, X, ChevronDown, Circle, CheckCircle2, XCircle } from 'lucide-react';

export interface SpawnedSession {
  session: TerminalSession;
  /** working directory the agent was launched in */
  cwd: string;
  /** resolved command + args */
  cmd: string;
  args: string[];
}

interface AgentTerminalPaneProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: SpawnedSession[];
  activeTaskId: string | number | null;
  onSelectSession: (taskId: string | number) => void;
  onCloseSession: (taskId: string | number) => void;
  onSessionExit: (taskId: string | number, code: number) => void;
  cliConfig: CliAgentConfig | null;
}

const MIN_HEIGHT_PX = 180;
const DEFAULT_HEIGHT_PERCENT = 40; // % of parent container height

export const AgentTerminalPane: React.FC<AgentTerminalPaneProps> = ({
  isOpen,
  onClose,
  sessions,
  activeTaskId,
  onSelectSession,
  onCloseSession,
  onSessionExit,
}) => {
  const paneRef = useRef<HTMLDivElement>(null);
  const [heightPercent, setHeightPercent] = useState(DEFAULT_HEIGHT_PERCENT);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);

  // ── Drag-to-resize logic ──────────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartYRef.current = e.clientY;
    dragStartHeightRef.current = paneRef.current?.offsetHeight ?? 300;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !paneRef.current) return;
      const parent = paneRef.current.parentElement;
      if (!parent) return;
      const parentH = parent.offsetHeight;
      const delta = dragStartYRef.current - e.clientY; // dragging up = increase height
      const newH = Math.max(MIN_HEIGHT_PX, dragStartHeightRef.current + delta);
      const pct = Math.min(80, Math.max(15, (newH / parentH) * 100));
      setHeightPercent(pct);
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!isOpen) return null;

  const activeSession = sessions.find((s) => s.session.taskId === activeTaskId) ?? sessions[0] ?? null;

  const tabStatusIcon = (s: SpawnedSession) => {
    if (s.session.isActive) {
      return <Circle size={8} fill="var(--accent-emerald)" color="var(--accent-emerald)" style={{ animation: 'pulse 2s infinite' }} />;
    }
    if (s.session.exitCode === 0) {
      return <CheckCircle2 size={11} color="var(--accent-emerald)" />;
    }
    return <XCircle size={11} color="var(--accent-rose)" />;
  };

  return (
    <div
      ref={paneRef}
      style={{
        height: `${heightPercent}%`,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#0d0f14',
        borderTop: '1px solid var(--border-subtle)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* ── Drag handle ──────────────────────────────────────────────────── */}
      <div
        onMouseDown={handleDragStart}
        style={{
          height: '5px',
          cursor: 'ns-resize',
          background: 'transparent',
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(88,166,255,0.25)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      />

      {/* ── Pane header: tabs ─────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          background: 'var(--bg-darkest)',
          borderBottom: '1px solid var(--border-subtle)',
          minHeight: '36px',
          flexShrink: 0,
          overflowX: 'auto',
        }}
      >
        {/* Header icon + label */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0 0.85rem',
            borderRight: '1px solid var(--border-subtle)',
            color: 'var(--accent-cyan)',
            fontSize: '0.78rem',
            fontWeight: 700,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <Terminal size={13} />
          <span>Agent Terminals</span>
        </div>

        {/* Session tabs */}
        <div style={{ display: 'flex', flex: 1, overflowX: 'auto' }}>
          {sessions.map((s) => {
            const isActive = s.session.taskId === activeSession?.session.taskId;
            return (
              <button
                key={s.session.taskId}
                onClick={() => onSelectSession(s.session.taskId)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0 0.85rem',
                  background: isActive ? 'rgba(88,166,255,0.08)' : 'transparent',
                  borderRight: '1px solid var(--border-subtle)',
                  borderBottom: isActive ? '2px solid var(--accent-cyan)' : '2px solid transparent',
                  color: isActive ? '#fff' : 'var(--text-muted)',
                  fontSize: '0.78rem',
                  fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  transition: 'all 0.15s ease',
                }}
              >
                {tabStatusIcon(s)}
                <span style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  #{s.session.taskId} {s.session.taskTitle}
                </span>
                <span
                  onClick={(e) => { e.stopPropagation(); onCloseSession(s.session.taskId); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    marginLeft: '0.15rem',
                    padding: '0.1rem',
                    borderRadius: '3px',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-rose)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-dim)')}
                >
                  <X size={11} />
                </span>
              </button>
            );
          })}
        </div>

        {/* Collapse button */}
        <button
          onClick={onClose}
          title="Collapse terminal pane"
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '0 0.65rem',
            background: 'transparent',
            color: 'var(--text-dim)',
            cursor: 'pointer',
            transition: 'color 0.15s',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-dim)')}
        >
          <ChevronDown size={15} />
        </button>
      </div>

      {/* ── Terminal body ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {sessions.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', fontSize: '0.83rem' }}>
            No active terminal sessions.
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.session.taskId}
              style={{
                position: 'absolute',
                inset: 0,
                display: s.session.taskId === activeSession?.session.taskId ? 'flex' : 'none',
                flexDirection: 'column',
              }}
            >
              {/* Agent + CWD info bar */}
              <div
                style={{
                  padding: '0.25rem 0.75rem',
                  background: 'rgba(13,15,20,0.9)',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  fontSize: '0.72rem',
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                  flexShrink: 0,
                  display: 'flex',
                  gap: '1rem',
                }}
              >
                <span><span style={{ color: 'var(--accent-cyan)' }}>cmd:</span> {s.cmd} {s.args.join(' ')}</span>
                <span><span style={{ color: 'var(--accent-violet)' }}>cwd:</span> {s.cwd}</span>
              </div>

              {/* The actual xterm.js terminal */}
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <AgentTerminal
                  cmd={s.cmd}
                  args={s.args}
                  cwd={s.cwd}
                  onExit={(code) => onSessionExit(s.session.taskId, code)}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
