import React, { useEffect, useState } from 'react';
import { bridgeClient } from '../lib/bridgeClient';
import {
  type TaskItem,
  type AgentContextItem,
  type ExecutionStep,
  type TokenUsage,
  type AgentRole
} from '../types';
import { emptyUsage, addUsage } from '../lib/agentPipeline/contracts';
import { Zap, ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Tokens a run actually put into the conversation: fresh input, cache writes and output. `inputTokens` also counts every
 * prompt-cache READ, and an agent re-reads its whole context on each call, so summed over a run that figure is the
 * context size times the number of calls (a 16-call, 68k-token run adds up to ~930k) and says little about the work done.
 */
export function newTokensOf(u: TokenUsage): number {
  return Math.max(0, u.inputTokens - (u.cachedInputTokens || 0)) + u.outputTokens;
}

/** "1M", "2.1M", "30k", "980". Truncates thousands and millions cleanly. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) {
    const val = (n / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${val}M`;
  }
  if (n >= 1000) {
    const val = n >= 10_000
      ? `${Math.round(n / 1000)}`
      : (n / 1000).toFixed(1).replace(/\.0$/, '');
    return `${val}k`;
  }
  return String(n);
}

export interface TaskTokenSummary {
  totalUsage: TokenUsage;
  /** New tokens (see newTokensOf), not counting prompt-cache re-reads. */
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
    summary: emptyUsage(),
    manager: emptyUsage(),
    worker: emptyUsage(),
    cleaner: emptyUsage(),
    verifier: emptyUsage(),
    logger: emptyUsage(),
    autocomplete: emptyUsage()
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
            calls: parsed.calls || 0,
            ...(parsed.estimated ? { estimated: true } : {}),
            ...(typeof parsed.costUsd === 'number' ? { costUsd: parsed.costUsd } : {}),
            ...(parsed.costPartial ? { costPartial: true } : {})
          };
          found = true;
        }
      } catch { }
    }
  }

  const byRole = Object.fromEntries(
    (Object.keys(roleMap) as AgentRole[]).map((role) => [role, { usage: roleMap[role], total: newTokensOf(roleMap[role]) }])
  ) as Record<AgentRole, { usage: TokenUsage; total: number }>;

  const totalTokens = newTokensOf(totalUsage);
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
  isTaskStarted?: boolean;
  defaultBreakdownOpen?: boolean;
  /** How the active AI profile pays: an API key (real cost), a subscription CLI (API-equivalent value), or local. */
  billing?: TaskBilling;
}

export interface TaskBilling {
  kind: 'api' | 'subscription' | 'local';
  /** Subscription CLI binary (claude, codex, agy) — Claude Code exposes its plan usage. */
  cli?: string;
  /** "Claude Code", "Codex"… for the plan line. */
  label?: string;
}

/** "$0.048", "$1.23", "<$0.001". */
export function formatUsd(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.001) return '<$0.001';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

interface PlanUsage {
  available: boolean;
  fetchedAt?: string | null;
  session?: { percent: number; resetsAt: string | null } | null;
  weekly?: { percent: number; resetsAt: string | null } | null;
}

/** The subscription plan's usage limits as the CLI last saw them (refreshed every minute while shown). */
function usePlanUsage(cli: string | undefined, enabled: boolean): PlanUsage | null {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  useEffect(() => {
    if (!enabled || !cli) return;
    let alive = true;
    const load = () =>
      fetch(bridgeClient.getApiUrl(`/api/cli/plan-usage?cli=${encodeURIComponent(cli)}`))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && setUsage(d && d.available ? d : null))
        .catch(() => { });
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [cli, enabled]);
  return usage;
}

function planLine(plan: PlanUsage, /*label: string*/): string | null {
  const weekly = plan.weekly;
  if (!weekly) return null;
  const resets = weekly.resetsAt ? new Date(weekly.resetsAt) : null;
  if (resets && resets.getTime() < Date.now()) {
    // return `${label} plan: weekly limit reset ${resets.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} — updates on the CLI's next check`;
    return `Weekly limit reset ${resets.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} — updates on next AI call`;
  }
  const when = resets ? ` · resets ${resets.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  // return `${label} plan: ${Math.round(weekly.percent)}% of weekly limit used${when}`;
  return `${Math.round(weekly.percent)}% of weekly limit used${when}`;
}

/**
 * Compact token usage card displaying the running tally of all tokens used
 * across all phases (Discovery, Summary, Manager, Workers, verifier, etc.).
 * Styled according to ShadCN design guidelines.
 */
export const BvTokenCounterCard: React.FC<BvTokenCounterCardProps> = ({
  task,
  brief,
  executionSteps,
  isExecuting = false,
  isTaskStarted = false,
  defaultBreakdownOpen = false,
  billing
}) => {
  const summary = extractTaskTokenSummary(task, brief, executionSteps);
  const [showBreakdown, setShowBreakdown] = useState(defaultBreakdownOpen);
  const isSubscription = billing?.kind === 'subscription';
  const plan = usePlanUsage(billing?.cli, isSubscription && billing?.cli === 'claude');

  const { totalTokens, totalUsage, byRole, hasUsage } = summary;
  const { /*inputTokens,*/ outputTokens, cachedInputTokens, cacheWriteTokens, calls } = totalUsage;
  const exactTokenCountStr = `${totalUsage.estimated ? '≈ ' : ''}${totalTokens.toLocaleString()}`;
  const tokenTitle = totalUsage.estimated
    ? `Estimated from text length: ${exactTokenCountStr} tokens — this CLI doesn't report exact token counts`
    : `${exactTokenCountStr} new tokens: fresh input + cache writes + output. Each call also re-reads the agent's whole context from the prompt cache (${cachedInputTokens.toLocaleString()} tokens here, billed at ~10% of the input price), which is why "In" below is far larger.`;

  // Identify roles that actually consumed tokens
  const activeRoles = (Object.entries(byRole) as [AgentRole, { usage: TokenUsage; total: number }][]).filter(
    ([, data]) => data.total > 0 || data.usage.calls > 0
  );

  const roleConfig: Record<AgentRole, { label: string; color: string; bg: string; border: string }> = {
    summary: { label: 'Summary', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.2)' },
    manager: { label: 'Manager', color: '#818cf8', bg: 'rgba(129, 140, 248, 0.08)', border: 'rgba(129, 140, 248, 0.2)' },
    worker: { label: 'Workers', color: '#34d399', bg: 'rgba(52, 211, 153, 0.08)', border: 'rgba(52, 211, 153, 0.2)' },
    cleaner: { label: 'Cleaner', color: '#fb7185', bg: 'rgba(251, 113, 133, 0.08)', border: 'rgba(251, 113, 133, 0.2)' },
    verifier: { label: 'Verifier', color: '#c084fc', bg: 'rgba(192, 132, 252, 0.08)', border: 'rgba(192, 132, 252, 0.2)' },
    logger: { label: 'Logger', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.08)', border: 'rgba(148, 163, 184, 0.2)' },
    autocomplete: { label: 'Small model', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.08)', border: 'rgba(56, 189, 248, 0.2)' }
  };

  // If task is not started and has no usage yet, display blank card with hint
  if (!isTaskStarted && !hasUsage && !isExecuting) {
    return (
      <div
        className="bv-token-counter-card is-unstarted"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '6px',
          padding: '0.45rem 0.65rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.35rem',
          transition: 'all 0.15s ease'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <div
              style={{
                width: '20px',
                height: '20px',
                borderRadius: '4px',
                background: 'var(--btn-secondary-bg)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)'
              }}
            >
              <Zap size={11} color="var(--text-muted)" />
            </div>
            <span
              style={{
                fontSize: '0.72rem',
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: 'var(--text-main)'
              }}
            >
              Token Usage
            </span>
            <span
              className="task-status-pill"
              style={{
                fontSize: '0.66rem',
                fontWeight: 500,
                padding: '0.06rem 0.4rem',
                borderRadius: '9999px',
                background: 'var(--btn-secondary-bg)',
                color: 'var(--text-muted)',
                border: '1px solid var(--border-subtle)'
              }}
            >
              0 tokens
            </span>
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            Not started
          </span>
        </div>
        <div
          className="ai-card-hint"
          style={{
            fontSize: '0.72rem',
            color: 'var(--text-muted)',
            fontStyle: 'italic',
            padding: '0.2rem 0.1rem 0.1rem'
          }}
        >
          Start the task to track token consumption across AI phases (Summary, Manager, Workers, Verifier, and Logger).
        </div>
      </div>
    );
  }

  return (
    <div
      className="bv-token-counter-card"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '6px',
        padding: '0.45rem 0.65rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
        transition: 'all 0.15s ease'
      }}
    >
      {/* Top Header Row: Label, Status Pill, and Prominent Total Token Number */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.15rem' }}>
              <div
                style={{
                  width: '22px',
                  height: '22px',
                  borderRadius: '5px',
                  background: isExecuting ? 'rgba(6, 182, 212, 0.15)' : 'var(--btn-secondary-bg)',
                  border: `1px solid ${isExecuting ? 'rgba(6, 182, 212, 0.35)' : 'var(--border-subtle)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: isExecuting ? 'var(--accent-cyan)' : 'var(--text-muted)'
                }}
              >
                <Zap size={12} color={isExecuting ? '#06b6d4' : 'var(--text-muted)'} />
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
                {typeof totalUsage.costUsd === 'number' && !isSubscription ? 'Task Cost' : 'Task Usage'}
              </span>
            </span>

            {isSubscription && plan && planLine(plan, /*billing?.label || ''*/) && (
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} title={plan.fetchedAt ? `As of ${new Date(plan.fetchedAt).toLocaleString()}` : undefined}>
                {planLine(plan, /*billing?.label || ''*/)}
              </div>
            )}
          </span>

          {/* Running vs Done vs Standby status pill */}
          {isExecuting && (
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
              <span>Calculating...</span>
            </span>
          )}
        </div>

        {/* Primary figure: what the user cares about. API key → cost; subscription → tokens (plan usage), cost as "API value". */}
        {(() => {
          const costText = typeof totalUsage.costUsd === 'number'
            ? `${totalUsage.costPartial || totalUsage.estimated ? '≈ ' : ''}${formatUsd(totalUsage.costUsd)}`
            : null;
          const tokenText = `${totalUsage.estimated ? '≈ ' : ''}${compactTokens(totalTokens)}`;
          const bigStyle: React.CSSProperties = {
            fontFamily: 'var(--font-mono)',
            fontSize: '1.15rem',
            fontWeight: 700,
            color: 'var(--text-bright)',
            letterSpacing: '-0.02em',
            textShadow: isExecuting ? '0 0 12px rgba(6, 182, 212, 0.3)' : 'none'
          };
          const smallStyle: React.CSSProperties = { fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' };
          if (isSubscription || !costText) {
            return (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.15 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}>
                  <span style={bigStyle} title={tokenTitle}>{tokenText}</span>
                  <span style={{ fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)' }} title={tokenTitle}>
                    {totalUsage.estimated ? 'tokens (est.)' : 'tokens'}
                  </span>
                </div>
                {costText && (
                  <span
                    style={smallStyle}
                    title="What these calls would cost at API prices. Your subscription covers them; they count toward its usage limits."
                  >
                    {costText} API value
                  </span>
                )}
              </div>
            );
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.15 }}>
              <span style={bigStyle} title="Cost at your provider's API prices, prompt-cache discounts included.">{costText}</span>
              <span style={smallStyle} title={tokenTitle}>{tokenText} tokens</span>
            </div>
          );
        })()}
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
            title={showBreakdown ? 'Hide token breakdown' : 'Show token breakdown'}
          >
            <span>{showBreakdown ? 'Hide Details' : 'Show Details'}</span>
            {showBreakdown ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        )}
      </div>

      {/* Bottom Stage Breakdown Row: Summary, Manager, Workers, verifier, Logger */}
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
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.45rem' }}>
            {/* Input tokens */}
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.72rem',
                padding: '0.1rem 0.42rem',
                borderRadius: '4px',
                background: 'var(--btn-secondary-bg)',
                border: '1px solid var(--border-subtle)',
                whiteSpace: 'nowrap'
              }}
              title="Total input/prompt tokens sent across all LLM calls"
            >
              <span style={{ color: 'var(--text-dim)', marginRight: '0.25rem' }}>Input:</span>
              {/* <strong style={{ color: 'var(--text-bright)' }}>{inputTokens.toLocaleString()}</strong> */}
              {cacheWriteTokens > 0 && (
                <span style={{ color: '#38bdf8', marginLeft: '0.25rem' }} title="Input tokens written to prompt cache">
                  {cacheWriteTokens.toLocaleString()}
                </span>
              )}
              {cachedInputTokens > 0 && (
                <span style={{ color: 'var(--accent-emerald)', marginLeft: '0.5rem' }} title="Input tokens read from prompt cache">
                  ({cachedInputTokens.toLocaleString()} cached)
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
                background: 'var(--btn-secondary-bg)',
                border: '1px solid var(--border-subtle)',
                whiteSpace: 'nowrap'
              }}
              title="Total output/generation tokens received across all LLM calls"
            >
              <span style={{ color: 'var(--text-dim)', marginRight: '0.25rem' }}>Output:</span>
              <strong style={{ color: 'var(--accent-cyan)' }}>{outputTokens.toLocaleString()}</strong>
            </span>

            {/* Round-trip calls */}
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.72rem',
                padding: '0.1rem 0.42rem',
                borderRadius: '4px',
                background: 'var(--btn-secondary-bg)',
                border: '1px solid var(--border-subtle)',
                whiteSpace: 'nowrap'
              }}
              title="Total LLM round trips across Summary, Manager, Workers, Verifier, and Logger"
            >
              <span style={{ color: 'var(--text-dim)', marginRight: '0.25rem' }}>Calls:</span>
              <strong style={{ color: 'var(--text-bright)' }}>{calls}</strong>
            </span>
          </div>
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
                title={`${cfg.label}: ${data.total.toLocaleString()} new tokens (${data.usage.calls} call${data.usage.calls === 1 ? '' : 's'}${data.usage.cachedInputTokens > 0 ? `, ${data.usage.cachedInputTokens.toLocaleString()} cached` : ''}${data.usage.cacheWriteTokens > 0 ? `, ${data.usage.cacheWriteTokens.toLocaleString()} written` : ''})`}
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
                {cfg.label}: {isSubscription || typeof data.usage.costUsd !== 'number'
                  ? compactTokens(data.total)
                  : `${data.usage.costPartial ? '≈ ' : ''}${formatUsd(data.usage.costUsd)} · ${compactTokens(data.total)}`}
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
        color: isExecuting ? 'var(--accent-cyan)' : 'var(--text-main)',
        background: isExecuting ? 'rgba(6, 182, 212, 0.08)' : 'var(--btn-secondary-bg)',
        border: `1px solid ${isExecuting ? 'rgba(6, 182, 212, 0.28)' : 'var(--border-subtle)'}`,
        padding: '0.15rem 0.45rem',
        borderRadius: '4px'
      }}
      title={`Total tokens used: ${summary.totalUsage.estimated ? '≈ ' : ''}${summary.totalTokens.toLocaleString()} (${summary.totalUsage.calls} calls)${summary.totalUsage.estimated ? ' — estimated' : ''}`}
    >
      <Zap size={11} color={isExecuting ? '#06b6d4' : 'var(--accent-violet)'} />
      {typeof summary.totalUsage.costUsd === 'number' ? (
        <>
          <span>{summary.totalUsage.costPartial || summary.totalUsage.estimated ? '≈ ' : ''}{formatUsd(summary.totalUsage.costUsd)}</span>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontWeight: 400 }}>{compactTokens(summary.totalTokens)} tokens</span>
        </>
      ) : (
        <>
          <span>{summary.totalUsage.estimated ? '≈ ' : ''}{compactTokens(summary.totalTokens)}</span>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontWeight: 400 }}>tokens</span>
        </>
      )}
    </span>
  );
};
