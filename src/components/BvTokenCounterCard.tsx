import React, { useState } from 'react';
import {
  type TaskItem,
  type AgentContextItem,
  type ExecutionStep,
  type TokenUsage,
  type AgentRole
} from '../types';
import { emptyUsage, addUsage } from '../lib/agentPipeline/contracts';
import { Zap, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';

export interface TaskTokenSummary {
  totalUsage: TokenUsage;
  totalTokens: number;
  byRole: Record<AgentRole, { usage: TokenUsage; total: number }>;
  hasUsage: boolean;
}

/**
 * Computes an accurate running or final tally of all tokens used during a task,
 * combining real-time execution steps, brief/task metadata, and markdown comments.
 */
export function extractTaskTokenSummary(
  task?: TaskItem,
  brief?: AgentContextItem,
  executionSteps?: ExecutionStep[]
): TaskTokenSummary {
  const roleMap: Record<AgentRole, TokenUsage> = {
    discovery: emptyUsage(),
    summary: emptyUsage(),
    manager: emptyUsage(),
    worker: emptyUsage(),
    cleaner: emptyUsage(),
    hardener: emptyUsage(),
    logger: emptyUsage()
  };

  let totalUsage = emptyUsage();
  let found = false;

  // 1. Process execution steps for live or completed runs
  if (executionSteps && executionSteps.length > 0) {
    // Accumulate individual role usages
    for (const step of executionSteps) {
      if (step.usage && step.agentRole && roleMap[step.agentRole]) {
        addUsage(roleMap[step.agentRole], step.usage);
      }
    }

    // Check latest step with totalUsage snapshot
    for (let i = executionSteps.length - 1; i >= 0; i--) {
      const step = executionSteps[i];
      if (
        step.totalUsage &&
        (step.totalUsage.calls > 0 ||
          step.totalUsage.inputTokens > 0 ||
          step.totalUsage.outputTokens > 0)
      ) {
        totalUsage = { ...step.totalUsage };
        found = true;
        break;
      }
    }

    // If totalUsage was not tagged on a step, sum all step.usage
    if (!found) {
      for (const step of executionSteps) {
        if (step.usage) {
          addUsage(totalUsage, step.usage);
          if (step.usage.calls > 0 || step.usage.inputTokens > 0 || step.usage.outputTokens > 0) {
            found = true;
          }
        }
      }
    }
  }

  // 2. Check brief.totalUsage or task.totalUsage
  if (!found) {
    if (brief?.totalUsage && (brief.totalUsage.calls > 0 || brief.totalUsage.inputTokens > 0)) {
      totalUsage = { ...brief.totalUsage };
      found = true;
    } else if (task?.totalUsage && (task.totalUsage.calls > 0 || task.totalUsage.inputTokens > 0)) {
      totalUsage = { ...task.totalUsage };
      found = true;
    }
  }

  // 3. Check for embedded markdown comment in buildAndVerification or rawContent
  if (!found) {
    const textToScan = [
      brief?.buildAndVerification,
      brief?.built,
      brief?.rawContent,
      task?.summaryNote
    ]
      .filter(Boolean)
      .join('\n');

    const match = textToScan.match(/<!--\s*task_token_usage:\s*(\{.*?\})\s*-->/i);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (typeof parsed.inputTokens === 'number') {
          totalUsage = {
            inputTokens: parsed.inputTokens || 0,
            outputTokens: parsed.outputTokens || 0,
            cachedInputTokens: parsed.cachedInputTokens || 0,
            cacheWriteTokens: parsed.cacheWriteTokens || 0,
            calls: parsed.calls || 0
          };
          found = true;
        }
      } catch {}
    }
  }

  const byRole: Record<AgentRole, { usage: TokenUsage; total: number }> = {
    discovery: { usage: roleMap.discovery, total: roleMap.discovery.inputTokens + roleMap.discovery.outputTokens },
    summary: { usage: roleMap.summary, total: roleMap.summary.inputTokens + roleMap.summary.outputTokens },
    manager: { usage: roleMap.manager, total: roleMap.manager.inputTokens + roleMap.manager.outputTokens },
    worker: { usage: roleMap.worker, total: roleMap.worker.inputTokens + roleMap.worker.outputTokens },
    cleaner: { usage: roleMap.cleaner, total: roleMap.cleaner.inputTokens + roleMap.cleaner.outputTokens },
    hardener: { usage: roleMap.hardener, total: roleMap.hardener.inputTokens + roleMap.hardener.outputTokens },
    logger: { usage: roleMap.logger, total: roleMap.logger.inputTokens + roleMap.logger.outputTokens }
  };

  const totalTokens = totalUsage.inputTokens + totalUsage.outputTokens;
  return {
    totalUsage,
    totalTokens,
    byRole,
    hasUsage: found || totalTokens > 0
  };
}

interface BvTokenCounterCardProps {
  task?: TaskItem;
  brief?: AgentContextItem;
  executionSteps?: ExecutionStep[];
  isExecuting?: boolean;
}

/**
 * Small card anchored to the top of the Build & Verification (BV) section.
 * Displays the complete, accurate running tally of all tokens used during the task
 * across all phases (Discovery, Summary, Manager, Workers, QA, etc.).
 */
export const BvTokenCounterCard: React.FC<BvTokenCounterCardProps> = ({
  task,
  brief,
  executionSteps,
  isExecuting = false
}) => {
  const summary = extractTaskTokenSummary(task, brief, executionSteps);
  const [showBreakdown, setShowBreakdown] = useState(true);

  const { totalTokens, totalUsage, byRole, hasUsage } = summary;
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, calls } = totalUsage;

  // Identify roles that actually consumed tokens
  const activeRoles = (Object.entries(byRole) as [AgentRole, { usage: TokenUsage; total: number }][]).filter(
    ([, data]) => data.total > 0 || data.usage.calls > 0
  );

  const roleConfig: Record<AgentRole, { label: string; color: string; bg: string; border: string }> = {
    discovery: { label: 'Discovery', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.08)', border: 'rgba(56, 189, 248, 0.2)' },
    summary: { label: 'Summary', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.2)' },
    manager: { label: 'Manager', color: '#818cf8', bg: 'rgba(129, 140, 248, 0.08)', border: 'rgba(129, 140, 248, 0.2)' },
    worker: { label: 'Workers', color: '#34d399', bg: 'rgba(52, 211, 153, 0.08)', border: 'rgba(52, 211, 153, 0.2)' },
    cleaner: { label: 'Cleaner', color: '#fb7185', bg: 'rgba(251, 113, 133, 0.08)', border: 'rgba(251, 113, 133, 0.2)' },
    hardener: { label: 'QA Hardener', color: '#c084fc', bg: 'rgba(192, 132, 252, 0.08)', border: 'rgba(192, 132, 252, 0.2)' },
    logger: { label: 'Logger', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.08)', border: 'rgba(148, 163, 184, 0.2)' }
  };

  return (
    <div
      className="bv-token-counter-card"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 15,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        background: 'rgba(26, 28, 31, 0.94)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        borderLeft: '1px solid rgba(255, 255, 255, 0.07)',
        borderRight: '1px solid rgba(255, 255, 255, 0.07)',
        borderTop: '1px solid rgba(255, 255, 255, 0.07)',
        borderRadius: '8px',
        margin: '0.65rem 0.85rem 0.5rem 0.85rem',
        padding: '0.6rem 0.85rem',
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.22)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.45rem',
        transition: 'all 0.15s ease'
      }}
    >
      {/* Top Header Row: Label, Status Pill, and Prominent Total Token Number */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div
            style={{
              width: '22px',
              height: '22px',
              borderRadius: '5px',
              background: isExecuting ? 'rgba(6, 182, 212, 0.15)' : 'rgba(255, 255, 255, 0.05)',
              border: `1px solid ${isExecuting ? 'rgba(6, 182, 212, 0.35)' : 'rgba(255, 255, 255, 0.1)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isExecuting ? 'var(--accent-cyan)' : 'var(--text-muted)'
            }}
          >
            <Zap size={12} color={isExecuting ? '#06b6d4' : '#a1a1aa'} />
          </div>
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)'
            }}
          >
            Task Token Usage
          </span>

          {/* Running vs Done vs Standby status pill */}
          {isExecuting ? (
            <span
              className="task-status-pill"
              style={{
                fontSize: '0.68rem',
                fontWeight: 600,
                padding: '0.08rem 0.45rem',
                borderRadius: '9999px',
                background: 'rgba(6, 182, 212, 0.12)',
                color: '#06b6d4',
                border: '1px solid rgba(6, 182, 212, 0.35)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem'
              }}
            >
              <span className="live-pulse-dot" style={{ width: '6px', height: '6px' }} />
              <span>Tallying Live</span>
            </span>
          ) : hasUsage ? (
            <span
              className="task-status-pill"
              style={{
                fontSize: '0.68rem',
                fontWeight: 600,
                padding: '0.08rem 0.45rem',
                borderRadius: '9999px',
                background: 'rgba(16, 185, 129, 0.12)',
                color: '#10b981',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem'
              }}
            >
              <CheckCircle2 size={10} />
              <span>Final Tally</span>
            </span>
          ) : (
            <span
              className="task-status-pill"
              style={{
                fontSize: '0.68rem',
                fontWeight: 500,
                padding: '0.08rem 0.45rem',
                borderRadius: '9999px',
                background: 'rgba(255, 255, 255, 0.04)',
                color: 'var(--text-muted)',
                border: '1px solid rgba(255, 255, 255, 0.1)'
              }}
            >
              Ready
            </span>
          )}
        </div>

        {/* Complete Token Number */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '1.15rem',
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '-0.02em',
              textShadow: isExecuting ? '0 0 12px rgba(6, 182, 212, 0.3)' : 'none'
            }}
          >
            {totalTokens.toLocaleString()}
          </span>
          <span style={{ fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)' }}>
            tokens
          </span>
        </div>
      </div>

      {/* Middle Metrics Strip: In / Out / Calls breakdown */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.4rem',
          fontSize: '0.72rem',
          color: 'var(--text-muted)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.45rem' }}>
          {/* Input tokens */}
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              padding: '0.1rem 0.42rem',
              borderRadius: '4px',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              whiteSpace: 'nowrap'
            }}
            title="Total input/prompt tokens sent across all LLM calls"
          >
            <span style={{ color: 'var(--text-dim)', marginRight: '0.25rem' }}>In:</span>
            <strong style={{ color: '#fff' }}>{inputTokens.toLocaleString()}</strong>
            {cachedInputTokens > 0 && (
              <span style={{ color: 'var(--accent-emerald)', marginLeft: '0.25rem' }} title="Input tokens read from prompt cache">
                ({cachedInputTokens.toLocaleString()} cached)
              </span>
            )}
            {cacheWriteTokens > 0 && (
              <span style={{ color: '#38bdf8', marginLeft: '0.25rem' }} title="Input tokens written to prompt cache">
                ({cacheWriteTokens.toLocaleString()} written)
              </span>
            )}
          </span>

          {/* Output tokens */}
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              padding: '0.1rem 0.42rem',
              borderRadius: '4px',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              whiteSpace: 'nowrap'
            }}
            title="Total output/generation tokens received across all LLM calls"
          >
            <span style={{ color: 'var(--text-dim)', marginRight: '0.25rem' }}>Out:</span>
            <strong style={{ color: 'var(--accent-cyan)' }}>{outputTokens.toLocaleString()}</strong>
          </span>

          {/* Round-trip calls */}
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              padding: '0.1rem 0.42rem',
              borderRadius: '4px',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              whiteSpace: 'nowrap'
            }}
            title="Total LLM round trips across Discovery, Summary, Manager, Workers, QA, and Logger"
          >
            <span style={{ color: 'var(--text-dim)', marginRight: '0.25rem' }}>Calls:</span>
            <strong style={{ color: '#fff' }}>{calls}</strong>
          </span>
        </div>

        {/* Breakdown Toggle Button (if active roles exist) */}
        {activeRoles.length > 0 && (
          <button
            type="button"
            onClick={() => setShowBreakdown((prev) => !prev)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              background: 'transparent',
              border: 'none',
              padding: '0.1rem 0.3rem',
              color: 'var(--text-dim)',
              fontSize: '0.68rem',
              cursor: 'pointer',
              borderRadius: '4px',
              transition: 'all 0.12s ease'
            }}
            title={showBreakdown ? 'Hide stage breakdown' : 'Show stage breakdown'}
          >
            <span>{showBreakdown ? 'Hide Stages' : 'View Stages'}</span>
            {showBreakdown ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        )}
      </div>

      {/* Bottom Stage Breakdown Row: Discovery, Summary, Manager, Workers, QA, Logger */}
      {showBreakdown && activeRoles.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.35rem',
            paddingTop: '0.35rem',
            borderTop: '1px solid rgba(255, 255, 255, 0.06)'
          }}
        >
          <span
            style={{
              fontSize: '0.64rem',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--text-dim)',
              fontWeight: 600,
              marginRight: '0.15rem'
            }}
          >
            Stages:
          </span>
          {activeRoles.map(([role, data]) => {
            const cfg = roleConfig[role];
            return (
              <span
                key={role}
                title={`${cfg.label}: ${data.total.toLocaleString()} tokens (${data.usage.calls} call${data.usage.calls === 1 ? '' : 's'}${data.usage.cachedInputTokens > 0 ? `, ${data.usage.cachedInputTokens.toLocaleString()} cached` : ''}${data.usage.cacheWriteTokens > 0 ? `, ${data.usage.cacheWriteTokens.toLocaleString()} written` : ''})`}
                style={{
                  fontSize: '0.66rem',
                  fontFamily: 'var(--font-mono)',
                  padding: '0.08rem 0.38rem',
                  borderRadius: '4px',
                  background: cfg.bg,
                  color: cfg.color,
                  border: `1px solid ${cfg.border}`,
                  whiteSpace: 'nowrap'
                }}
              >
                {cfg.label}: {data.total.toLocaleString()}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Compact token badge for the Build & Verification section header right area.
 */
export const BvHeaderTokenBadge: React.FC<BvTokenCounterCardProps> = ({
  task,
  brief,
  executionSteps,
  isExecuting = false
}) => {
  const summary = extractTaskTokenSummary(task, brief, executionSteps);
  if (!summary.hasUsage && !isExecuting) return null;

  return (
    <span
      className="card-item-tag-tokens"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.28rem',
        fontSize: '0.72rem',
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        color: isExecuting ? 'var(--accent-cyan)' : 'rgba(255, 255, 255, 0.85)',
        background: isExecuting ? 'rgba(6, 182, 212, 0.08)' : 'rgba(255, 255, 255, 0.04)',
        border: `1px solid ${isExecuting ? 'rgba(6, 182, 212, 0.28)' : 'rgba(255, 255, 255, 0.1)'}`,
        padding: '0.15rem 0.45rem',
        borderRadius: '4px'
      }}
      title={`Total tokens used: ${summary.totalTokens.toLocaleString()} (${summary.totalUsage.calls} calls)`}
    >
      <Zap size={11} color={isExecuting ? '#06b6d4' : 'var(--accent-violet)'} />
      <span>{summary.totalTokens.toLocaleString()}</span>
      <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontWeight: 400 }}>tokens</span>
    </span>
  );
};
