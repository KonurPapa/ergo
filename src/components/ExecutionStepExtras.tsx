import React, { useState } from 'react';
import { type ExecutionStep, type TokenUsage } from '../types';
import { formatUsage } from '../lib/agentPipeline/contracts';
import { openFileInIdeOrSystem } from '../lib/mcpClient';
import {
  CheckCircle2,
  CircleDot,
  ExternalLink,
  FlaskConical,
  GitFork,
  HelpCircle,
  Loader2,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
  XCircle,
  BookOpen
} from 'lucide-react';

/** Status/stage icon for an execution step (covers the agent-pipeline stages). */
export const StepStatusIcon: React.FC<{ step: ExecutionStep; size?: number }> = ({ step, size = 15 }) => {
  if (step.status === 'running') {
    switch (step.stage) {
      case 'human_input':
        return <HelpCircle size={size} color="var(--accent-amber)" className="pulse-animate" />;
      case 'overview':
        return <Sparkles size={size} color="var(--accent-amber)" className="spin-animate" />;
      case 'decompose':
        return <GitFork size={size} color="var(--accent-cyan)" className="pulse-animate" />;
      case 'subagent':
        return <Users size={size} color="var(--accent-primary)" className="pulse-animate" />;
      case 'verify':
        return <ShieldCheck size={size} color="var(--accent-emerald)" className="pulse-animate" />;
      case 'cleaner':
        return <Sparkles size={size} color="var(--accent-amber)" className="spin-animate" />;
      case 'hardener':
        return <FlaskConical size={size} color="#a78bfa" className="pulse-animate" />;
      case 'retry':
        return <RotateCw size={size} color="var(--accent-rose)" className="spin-animate" />;
      default:
        return <Loader2 size={size} className="spin-animate" color="var(--accent-primary)" />;
    }
  }
  if (step.status === 'success') return <CheckCircle2 size={size} color="var(--accent-emerald)" />;
  if (step.status === 'warning') {
    if (step.stage === 'retry') return <RotateCw size={size} color="var(--accent-rose)" />;
    if (step.stage === 'hardener') return <FlaskConical size={size} color="var(--accent-amber)" />;
    return <ShieldAlert size={size} color="var(--accent-rose)" />;
  }
  if (step.status === 'pending') return <CircleDot size={size} color="var(--text-dim)" />;
  return <XCircle size={size} color="var(--accent-rose)" />;
};

/** Compact mono token-usage badge. */
export const StepUsageBadge: React.FC<{ usage?: TokenUsage }> = ({ usage }) => {
  if (!usage || usage.calls === 0) return null;
  return (
    <span
      title="LLM calls · input tokens (cached) · output tokens"
      style={{
        fontSize: '0.66rem',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-dim)',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '4px',
        padding: '0.05rem 0.4rem',
        whiteSpace: 'nowrap'
      }}
    >
      {formatUsage(usage)}
    </span>
  );
};

/** Small chip identifying which puzzle piece / worker a step belongs to. */
export const PieceChip: React.FC<{ pieceId?: string }> = ({ pieceId }) => {
  if (!pieceId) return null;
  return (
    <span
      style={{
        fontSize: '0.62rem',
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        color: 'var(--accent-primary)',
        background: 'rgba(99, 102, 241, 0.12)',
        border: '1px solid rgba(99, 102, 241, 0.3)',
        borderRadius: '4px',
        padding: '0.02rem 0.35rem'
      }}
    >
      {pieceId}
    </span>
  );
};

/** Collapsible preview of the persisted TASK_CONTEXT.md bible with an Open-in-IDE action. */
export const BiblePreview: React.FC<{ markdown?: string; filePath?: string }> = ({ markdown, filePath }) => {
  const [open, setOpen] = useState(false);
  if (!markdown && !filePath) return null;
  return (
    <div style={{ marginTop: '0.5rem', border: '1px solid rgba(16, 185, 129, 0.25)', background: 'rgba(16, 185, 129, 0.05)', borderRadius: 'var(--radius-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0.6rem' }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: markdown ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--accent-emerald)', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}
        >
          <BookOpen size={13} />
          <span>TASK_CONTEXT.md (execution bible){markdown ? (open ? ' ▾' : ' ▸') : ''}</span>
        </button>
        {filePath && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '0.15rem 0.5rem', fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
            onClick={() => { void openFileInIdeOrSystem(filePath); }}
            title={filePath}
          >
            <ExternalLink size={11} />
            <span>Open in IDE</span>
          </button>
        )}
      </div>
      {open && markdown && (
        <pre style={{ margin: 0, padding: '0.5rem 0.75rem 0.75rem', background: 'transparent', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.72rem', whiteSpace: 'pre-wrap', lineHeight: '1.45', maxHeight: '420px', overflow: 'auto' }}>
          {markdown}
        </pre>
      )}
    </div>
  );
};
