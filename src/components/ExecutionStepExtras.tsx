import React, { useState } from 'react';
import { type ExecutionStep, type TokenUsage, type AssembledBaselineContext } from '../types';
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
  BookOpen,
  Database,
  Info,
  FileText
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

/**
 * Interactive, collapsible card displaying context data assembled from the local Vector DB
 * and project guidelines (Step 1) at zero token cost.
 */
export const BaselineContextPreview: React.FC<{
  baselineContext?: AssembledBaselineContext;
  defaultOpen?: boolean;
  plain?: boolean;
}> = ({ baselineContext, defaultOpen = true, plain = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const cleared = false;

  if (!baselineContext) return null;

  const hits = baselineContext.memoryHits || [];
  const guidelines = baselineContext.guidelines || [];
  const thresholdPct = `${(baselineContext.threshold * 100).toFixed(0)}%`;

  const bodyContent = (
    <div style={{ padding: plain ? '0' : '0.65rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
      {/* Advisory Guardrail Note */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.45rem',
          padding: '0.45rem 0.6rem',
          background: 'rgba(56, 189, 248, 0.04)',
          border: '1px solid rgba(56, 189, 248, 0.18)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '0.72rem',
          color: 'var(--text-muted)',
          lineHeight: '1.45'
        }}
      >
        <Info size={13} color="var(--accent-cyan)" style={{ marginTop: '0.1rem', flexShrink: 0 }} />
        <span>
          <strong style={{ color: 'var(--accent-cyan)' }}>Reference Only:</strong> Retrieved tasks or past runs are only used for additional context.
        </span>
      </div>

      {/* Memory Hits List */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
          <div
            style={{
              fontSize: '0.68rem',
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontWeight: 600
            }}
          >
            Retrieved Memory Hits ({cleared ? 0 : hits.length}):
          </div>
          {/* {!cleared && hits.length > 0 && (
            <button
              type="button"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
                fontSize: '0.65rem',
                color: 'var(--accent-amber)',
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.25)',
                borderRadius: '3px',
                padding: '0.12rem 0.4rem',
                cursor: isClearing ? 'wait' : 'pointer'
              }}
              disabled={isClearing}
              onClick={async (e) => {
                e.stopPropagation();
                const projId = baselineContext.projectId || hits[0]?.projectId;
                if (window.confirm(`Clear all vector memory chunks for project "${projId || 'active'}"?`)) {
                  setIsClearing(true);
                  try {
                    if (projId) {
                      await clearProjectMemory(projId);
                    }
                    setCleared(true);
                  } catch (err) {
                    console.error('[ExecutionStepExtras] Failed to clear project memory:', err);
                  } finally {
                    setIsClearing(false);
                  }
                }
              }}
              title="Clear all vector memory chunks for this project"
            >
              <Trash2 size={10} />
              <span>{isClearing ? 'Clearing…' : 'Clear Project Memory'}</span>
            </button>
          )} */}
        </div>

        {cleared ? (
          <div
            style={{
              fontSize: '0.73rem',
              color: 'var(--accent-emerald)',
              fontStyle: 'italic',
              padding: '0.5rem 0.65rem',
              background: 'rgba(16, 185, 129, 0.05)',
              borderRadius: '4px',
              border: '1px dashed rgba(16, 185, 129, 0.3)'
            }}
          >
            Project vector memory cleared. Stale memory chunks have been removed from the local store.
          </div>
        ) : hits.length === 0 ? (
          <div
            style={{
              fontSize: '0.73rem',
              color: 'var(--text-dim)',
              fontStyle: 'italic',
              padding: '0.5rem 0.65rem',
              background: 'var(--bg-pane)',
              borderRadius: '4px',
              border: '1px dashed var(--border-subtle)'
            }}
          >
            No prior memories met the {thresholdPct} similarity cutoff. The Summary AI received a clean baseline guided purely by your task title and subtasks.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
            {hits.map((hit, idx) => {
              const simPct = (hit.similarity * 100).toFixed(0);
              const isHighMatch = hit.similarity >= 0.7;
              const isMediumMatch = hit.similarity >= 0.5;

              const badgeColor = isHighMatch
                ? 'var(--accent-emerald)'
                : isMediumMatch
                  ? 'var(--accent-cyan)'
                  : 'var(--accent-amber)';

              const badgeBg = isHighMatch
                ? 'rgba(16, 185, 129, 0.12)'
                : isMediumMatch
                  ? 'rgba(6, 182, 212, 0.12)'
                  : 'rgba(245, 158, 11, 0.12)';

              const badgeBorder = isHighMatch
                ? 'rgba(16, 185, 129, 0.3)'
                : isMediumMatch
                  ? 'rgba(6, 182, 212, 0.3)'
                  : 'rgba(245, 158, 11, 0.3)';

              return (
                <div
                  key={hit.id || idx}
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.45rem 0.6rem',
                    fontSize: '0.72rem'
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      marginBottom: '0.3rem',
                      flexWrap: 'wrap'
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.67rem',
                        fontWeight: 700,
                        color: badgeColor,
                        background: badgeBg,
                        border: `1px solid ${badgeBorder}`,
                        borderRadius: '4px',
                        padding: '0.01rem 0.35rem'
                      }}
                    >
                      {simPct}% match
                    </span>
                    <span
                      style={{
                        fontSize: '0.65rem',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-dim)',
                        background: 'var(--btn-secondary-bg)',
                        padding: '0.01rem 0.35rem',
                        borderRadius: '3px'
                      }}
                    >
                      [{hit.namespace}]
                    </span>
                    {hit.taskTitle && (
                      <span style={{ color: 'var(--text-bright)', fontWeight: 600 }}>
                        {hit.taskTitle}
                      </span>
                    )}
                    {hit.source && !hit.taskTitle && (
                      <span style={{ color: 'var(--text-muted)' }}>
                        ({hit.source})
                      </span>
                    )}
                    {hit.tags && hit.tags.length > 0 && (
                      <span style={{ color: 'var(--text-dim)', fontSize: '0.65rem' }}>
                        {hit.tags.map((t) => `#${t}`).join(' ')}
                      </span>
                    )}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: '0.2rem 0',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.71rem',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      lineHeight: '1.45',
                      maxHeight: '180px',
                      overflow: 'auto'
                    }}
                  >
                    {hit.text}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Guideline Excerpts (if any) */}
      {guidelines.length > 0 && (
        <div>
          <div
            style={{
              fontSize: '0.68rem',
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontWeight: 600,
              marginBottom: '0.35rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem'
            }}
          >
            <FileText size={12} color="var(--accent-primary)" />
            <span>Project Guideline Excerpts ({guidelines.length}):</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {guidelines.map((g, idx) => (
              <div
                key={idx}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.45rem 0.6rem'
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.68rem',
                    fontWeight: 600,
                    color: 'var(--accent-primary)',
                    marginBottom: '0.25rem'
                  }}
                >
                  {g.path}
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: 0,
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.7rem',
                    whiteSpace: 'pre-wrap',
                    lineHeight: '1.4',
                    maxHeight: '140px',
                    overflow: 'auto'
                  }}
                >
                  {g.excerpt}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (plain) {
    return bodyContent;
  }

  return (
    <div
      style={{
        marginTop: '0.55rem',
        border: '1px solid rgba(6, 182, 212, 0.25)',
        background: 'rgba(6, 182, 212, 0.035)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.45rem 0.65rem',
          background: 'rgba(6, 182, 212, 0.06)',
          borderBottom: open ? '1px solid rgba(6, 182, 212, 0.15)' : 'none',
          cursor: 'pointer',
          userSelect: 'none'
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
          <Database size={13} color="var(--accent-cyan)" />
          <span
            style={{
              color: 'var(--accent-cyan)',
              fontWeight: 700,
              fontSize: '0.74rem',
              textTransform: 'uppercase',
              letterSpacing: '0.04em'
            }}
          >
            Vector Memory & Baseline Context
          </span>
          <span
            style={{
              fontSize: '0.65rem',
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              color: 'var(--accent-emerald)',
              background: 'rgba(16, 185, 129, 0.12)',
              border: '1px solid rgba(16, 185, 129, 0.28)',
              borderRadius: '4px',
              padding: '0.02rem 0.4rem'
            }}
          >
            0 tokens
          </span>
          {baselineContext.projectId && (
            <span
              style={{
                fontSize: '0.65rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--accent-cyan)',
                background: 'rgba(6, 182, 212, 0.1)',
                border: '1px solid rgba(6, 182, 212, 0.25)',
                borderRadius: '4px',
                padding: '0.02rem 0.35rem'
              }}
              title={`Memory strictly isolated to project: ${baselineContext.projectId}`}
            >
              proj: {baselineContext.projectId}
            </span>
          )}
          <span
            style={{
              fontSize: '0.68rem',
              color: !cleared && hits.length > 0 ? 'var(--text-bright)' : 'var(--text-dim)',
              background: 'var(--btn-secondary-bg)',
              borderRadius: '4px',
              padding: '0.02rem 0.35rem'
            }}
          >
            {cleared ? 0 : hits.length} memory hit{(!cleared && hits.length === 1) ? '' : 's'} (cutoff &ge; {thresholdPct})
          </span>
          {guidelines.length > 0 && (
            <span
              style={{
                fontSize: '0.68rem',
                color: 'var(--text-dim)',
                background: 'var(--btn-secondary-bg)',
                borderRadius: '4px',
                padding: '0.02rem 0.35rem'
              }}
            >
              {guidelines.length} guideline doc{guidelines.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <span style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)', fontWeight: 600 }}>
          {open ? '▾' : '▸'}
        </span>
      </div>

      {open && bodyContent}
    </div>
  );
};
