import React, { useEffect, useState } from 'react';
import { StatusDot } from './ui';
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

function planLine(plan: PlanUsage): string | null {
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

  const ROLE_LABEL: Record<AgentRole, string> = {
    summary: 'Summary',
    manager: 'Manager',
    worker: 'Workers',
    cleaner: 'Cleaner',
    verifier: 'Verifier',
    logger: 'Logger',
    autocomplete: 'Small model',
  };

  // Not run yet: one quiet line.
  if (!isTaskStarted && !hasUsage && !isExecuting) {
    return (
      <section className="bv-token-counter-card eg-usage is-unstarted">
        <div className="eg-usage-head">
          <span className="eg-usage-label">Usage</span>
          <span className="eg-usage-sub">Counted once the task runs</span>
        </div>
      </section>
    );
  }

  const costText = typeof totalUsage.costUsd === 'number'
    ? `${totalUsage.costPartial || totalUsage.estimated ? '≈ ' : ''}${formatUsd(totalUsage.costUsd)}`
    : null;
  const tokenText = `${totalUsage.estimated ? '≈ ' : ''}${compactTokens(totalTokens)} ${totalUsage.estimated ? 'tokens (est.)' : 'tokens'}`;
  // What the user cares about: API key → cost first; subscription → tokens (plan usage), with the API value after.
  const costFirst = !isSubscription && costText;
  const planText = isSubscription && plan ? planLine(plan) : null;

  return (
    <section className={`bv-token-counter-card eg-usage ${isExecuting ? 'is-live' : ''}`}>
      <div className="eg-usage-head">
        <span className="eg-usage-label">{costFirst ? 'Cost' : 'Usage'}</span>
        {isExecuting && (
          <span className="eg-usage-live">
            <StatusDot state="live" />
            Counting
          </span>
        )}
        <span className="eg-spacer" />
        {costFirst ? (
          <>
            <span className="eg-usage-total" title="Cost at your provider's API prices, prompt-cache discounts included.">{costText}</span>
            <span className="eg-usage-sub" title={tokenTitle}>{tokenText}</span>
          </>
        ) : (
          <>
            <span className="eg-usage-total" title={tokenTitle}>{tokenText}</span>
            {costText && (
              <span className="eg-usage-sub" title="What these calls would cost at API prices. Your subscription covers them; they count toward its usage limits.">
                {costText} API value
              </span>
            )}
          </>
        )}
        {activeRoles.length > 0 && (
          <button
            type="button"
            className="eg-btn eg-btn-ghost eg-btn-sm eg-usage-toggle"
            onClick={() => setShowBreakdown((prev) => !prev)}
            aria-expanded={showBreakdown}
          >
            Details
            {showBreakdown ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
          </button>
        )}
      </div>
      {planText && (
        <div className="eg-usage-plan" title={plan?.fetchedAt ? `As of ${new Date(plan.fetchedAt).toLocaleString()}` : undefined}>
          {planText}
        </div>
      )}

      {showBreakdown && activeRoles.length > 0 && (
        <div className="eg-props eg-usage-props">
          <span className="eg-prop-k">Output</span>
          <span className="eg-prop-v eg-tabular" title="Output tokens received across all calls">{outputTokens.toLocaleString()}</span>
          {cachedInputTokens > 0 && (
            <>
              <span className="eg-prop-k">Cache reads</span>
              <span className="eg-prop-v eg-tabular" title="Input tokens read from the prompt cache (billed at about 10% of the input price)">
                {cachedInputTokens.toLocaleString()}
              </span>
            </>
          )}
          {cacheWriteTokens > 0 && (
            <>
              <span className="eg-prop-k">Cache writes</span>
              <span className="eg-prop-v eg-tabular" title="Input tokens written to the prompt cache">{cacheWriteTokens.toLocaleString()}</span>
            </>
          )}
          <span className="eg-prop-k">Calls</span>
          <span className="eg-prop-v eg-tabular" title="Model round trips across every stage">{calls}</span>
          {activeRoles.map(([role, data]) => (
            <React.Fragment key={role}>
              <span className="eg-prop-k">{ROLE_LABEL[role]}</span>
              <span
                className="eg-prop-v eg-tabular"
                title={`${data.total.toLocaleString()} new tokens (${data.usage.calls} call${data.usage.calls === 1 ? '' : 's'}${data.usage.cachedInputTokens > 0 ? `, ${data.usage.cachedInputTokens.toLocaleString()} cached` : ''}${data.usage.cacheWriteTokens > 0 ? `, ${data.usage.cacheWriteTokens.toLocaleString()} written` : ''})`}
              >
                {compactTokens(data.total)}
                {!isSubscription && typeof data.usage.costUsd === 'number' && (
                  <span className="eg-usage-sub">
                    {data.usage.costPartial ? '≈ ' : ''}
                    {formatUsd(data.usage.costUsd)}
                  </span>
                )}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
    </section>
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
        color: isExecuting ? 'var(--accent-text)' : 'var(--ink-muted)',
        background: isExecuting ? 'var(--accent-subtle)' : 'var(--surface-2)',
        border: 0,
        padding: '0.15rem 0.45rem',
        borderRadius: '4px'
      }}
      title={`Total tokens used: ${summary.totalUsage.estimated ? '≈ ' : ''}${summary.totalTokens.toLocaleString()} (${summary.totalUsage.calls} calls)${summary.totalUsage.estimated ? ' — estimated' : ''}`}
    >
      <Zap size={11} strokeWidth={1.75} color={isExecuting ? 'var(--accent-text)' : 'var(--ink-subtle)'} />
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
