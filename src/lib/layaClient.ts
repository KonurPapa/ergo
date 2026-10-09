/**
 * Laya Local Decision Engine Client & Tool Integration
 *
 * Implements local zero-cost ($0), ultra-low latency (30–75ms) System-1 decisions
 * for Ergo's agent execution pipeline. Connects through the 'mcp-laya' MCP server
 * using standard local stdio/RPC or local HTTP bridge.
 *
 * Key constraints handled:
 * - Option Limit Guard: Laya's non-autoregressive decision head handles <= 15-20 options
 *   efficiently due to the head_max_len token budget. Larger option sets (e.g. dozens of MCP tools)
 *   are automatically chunked into batches with tournament aggregation.
 * - Graceful Fallback: If mcp-laya is not connected, disabled, or throws an error,
 *   the pipeline seamlessly falls back to existing generative LLM synthesis and heuristics.
 */

import { type MCPServer, type TaskKind, type TaskItem } from '../types';
import { callMcpTool } from './mcpClient';
import { isExplicitCodeTask, requiresCliOrProcessTools } from './agentPipeline/summary';

export interface LayaChoiceResult {
  choice: string;
  confidence: number;
}

export interface LayaMultiChoiceResult {
  choices: string[];
  confidence: number;
}

export interface LayaScoreResult {
  score: number;
  confidence: number;
}

export interface LayaTriageResult {
  taskKind: TaskKind;
  isStraightforward: boolean;
  requiredMcps: string[];
  requiresHardener: boolean;
  hardenerReason?: string;
  confidence: number;
  usedLaya: boolean;
}

const MAX_OPTIONS_PER_BATCH = 15;

/**
 * Checks whether the Laya MCP server is currently connected and active.
 */
export function isLayaMcpConnected(connectedMcps: MCPServer[]): boolean {
  return connectedMcps.some(
    (m) => (m.id === 'mcp-laya' || m.name.toLowerCase().includes('laya')) && m.status === 'connected'
  );
}

/**
 * Executes a single Laya choice query with <= 20 options.
 */
async function callLayaChoiceRaw(
  prompt: string,
  options: string[]
): Promise<LayaChoiceResult | null> {
  if (options.length === 0) return null;
  if (options.length === 1) return { choice: options[0], confidence: 1.0 };

  try {
    const res = await callMcpTool('mcp-laya', 'laya_choice', {
      prompt,
      options: options.slice(0, MAX_OPTIONS_PER_BATCH)
    });

    if (res.success && res.data) {
      const choice = String(res.data.choice || options[0]);
      const confidence = typeof res.data.confidence === 'number' ? res.data.confidence : 0.85;
      return { choice, confidence };
    }
  } catch (err) {
    console.warn('[LayaClient] Error executing laya_choice:', err);
  }
  return null;
}

/**
 * Executes a Laya boolean decision (Yes / No).
 */
export async function callLayaBoolean(
  prompt: string,
  defaultVal = false
): Promise<{ value: boolean; confidence: number }> {
  try {
    const res = await callMcpTool('mcp-laya', 'laya_noul', { prompt });
    if (res.success && res.data && typeof res.data.value === 'boolean') {
      return {
        value: res.data.value,
        confidence: typeof res.data.confidence === 'number' ? res.data.confidence : 0.85
      };
    }
    // Fallback to choice(['yes', 'no'])
    const choiceRes = await callLayaChoiceRaw(prompt, ['yes', 'no']);
    if (choiceRes) {
      return {
        value: choiceRes.choice.toLowerCase() === 'yes',
        confidence: choiceRes.confidence
      };
    }
  } catch (err) {
    console.warn('[LayaClient] Error executing callLayaBoolean:', err);
  }
  return { value: defaultVal, confidence: 0 };
}

/**
 * Pick the best option from a list of arbitrary length, automatically chunking
 * into batches of <= 15 items to respect Laya's head_max_len budget.
 */
export async function pickOptionWithLaya(
  prompt: string,
  options: string[]
): Promise<LayaChoiceResult | null> {
  if (options.length === 0) return null;
  if (options.length <= MAX_OPTIONS_PER_BATCH) {
    return callLayaChoiceRaw(prompt, options);
  }

  // Multi-batch tournament chunking
  let pool = [...options];
  let roundConfidence = 0.8;

  while (pool.length > 1) {
    const nextRound: string[] = [];
    for (let i = 0; i < pool.length; i += MAX_OPTIONS_PER_BATCH) {
      const chunk = pool.slice(i, i + MAX_OPTIONS_PER_BATCH);
      if (chunk.length === 1) {
        nextRound.push(chunk[0]);
        continue;
      }
      const roundRes = await callLayaChoiceRaw(prompt, chunk);
      if (roundRes) {
        nextRound.push(roundRes.choice);
        roundConfidence = Math.min(roundConfidence, roundRes.confidence);
      } else {
        nextRound.push(chunk[0]);
      }
    }
    if (nextRound.length === pool.length) {
      // Avoid infinite loop if no reduction occurred
      return { choice: nextRound[0], confidence: roundConfidence };
    }
    pool = nextRound;
  }

  return { choice: pool[0], confidence: roundConfidence };
}

/**
 * Filter an array of items (like candidate MCP servers) using Laya's zero-cost decisions,
 * testing candidates in batches of <= 15.
 */
export async function filterRelevantItemsWithLaya(
  taskContext: string,
  candidateItems: Array<{ id: string; label: string; description: string }>
): Promise<string[]> {
  if (candidateItems.length === 0) return [];

  const selected: string[] = [];
  const batches: Array<typeof candidateItems> = [];

  for (let i = 0; i < candidateItems.length; i += MAX_OPTIONS_PER_BATCH) {
    batches.push(candidateItems.slice(i, i + MAX_OPTIONS_PER_BATCH));
  }

  for (const batch of batches) {
    try {
      const res = await callMcpTool('mcp-laya', 'laya_filter', {
        context: taskContext,
        items: batch.map((b) => ({ id: b.id, description: `${b.label}: ${b.description}` }))
      });

      if (res.success && Array.isArray(res.data?.selectedIds)) {
        selected.push(...res.data.selectedIds);
      } else {
        // Fallback: evaluate individually with fast boolean check if batch filter isn't supported
        for (const item of batch) {
          const check = await callLayaBoolean(
            `Given this task:\n${taskContext.slice(0, 400)}\n\nIs the following tool/connection strictly required to achieve the task?\nTool: ${item.label} (${item.description})`,
            false
          );
          if (check.value && check.confidence >= 0.6) {
            selected.push(item.id);
          }
        }
      }
    } catch (err) {
      console.warn('[LayaClient] Error in filterRelevantItemsWithLaya batch:', err);
    }
  }

  return selected;
}

/**
 * High-level Summary AI helper: Performs fast, zero-token classification of
 * taskKind, isStraightforward, requiredMcps, and requiresHardener.
 */
export async function performSummaryTriageWithLaya(params: {
  task: TaskItem;
  baselineMarkdown: string;
  connectedMcps: MCPServer[];
}): Promise<LayaTriageResult | null> {
  const { task, baselineMarkdown, connectedMcps } = params;

  if (!isLayaMcpConnected(connectedMcps)) {
    return null;
  }

  try {
    const taskText = `Title: ${task.title}\nCategory: ${task.category}\nSubtasks:\n${task.subtasks.map((s) => `- ${s.text}`).join('\n')}\n\nContext excerpt:\n${baselineMarkdown.slice(0, 1000)}`;

    // 1. TaskKind Decision (enforce coding if task description contains verbs like write/script/scaffold/compile or code extensions)
    let taskKind: TaskKind = 'coding';
    let kindConfidence = 0.95;
    if (isExplicitCodeTask(taskText)) {
      taskKind = 'coding';
      kindConfidence = 0.95;
    } else {
      const taskKindOptions: TaskKind[] = ['coding', 'writing', 'research', 'ops', 'data', 'other'];
      const kindRes = await callLayaChoiceRaw(
        `Classify the primary discipline of this software/user task into exactly one category:\n\n${taskText}`,
        taskKindOptions
      );
      taskKind = (kindRes?.choice && taskKindOptions.includes(kindRes.choice as TaskKind))
        ? (kindRes.choice as TaskKind)
        : 'coding';
      kindConfidence = kindRes?.confidence ?? 0.85;
    }

    // 2. Straightforward / Single-deliverable decision
    const straightforwardRes = await callLayaBoolean(
      `Is this task a straightforward, single standalone deliverable (e.g. single HTML game/page, one script, simple document, isolated bugfix) that can be executed directly in 1 piece without dividing across multiple sub-agents?\n\n${taskText}`,
      task.subtasks.length <= 2
    );
    const isStraightforward = straightforwardRes.value;

    // 3. Filter connected MCP servers (chunked via filterRelevantItemsWithLaya)
    const activeServers = connectedMcps
      .filter((m) => m.status === 'connected')
      .map((m) => ({
        id: m.id,
        label: m.name,
        description: m.description || m.tools.map((t) => t.name).join(', ')
      }));

    let requiredMcps = await filterRelevantItemsWithLaya(taskText, activeServers);
    // Filesystem is always required as the baseline storage harness
    if (!requiredMcps.includes('mcp-filesystem') && activeServers.some((s) => s.id === 'mcp-filesystem')) {
      requiredMcps.push('mcp-filesystem');
    }
    // Dynamic Tool Provisioning: if headless CLI, shell, script execution, or domain runners (e.g. Godot) are required,
    // ensure shell/process-execution tool and relevant domain MCP servers are provisioned alongside mcp-filesystem.
    if (requiresCliOrProcessTools(taskText)) {
      for (const s of activeServers) {
        const idLower = s.id.toLowerCase();
        const labelLower = s.label.toLowerCase();
        const descLower = (s.description || '').toLowerCase();
        const isGodotTask = taskText.toLowerCase().includes('godot');
        const isGodotServer = idLower.includes('godot') || labelLower.includes('godot');
        const isShellOrProcessServer =
          idLower.includes('shell') || idLower.includes('bash') || idLower.includes('terminal') || idLower.includes('command') ||
          descLower.includes('run_command') || descLower.includes('shell command');

        if ((isGodotTask && isGodotServer) || isShellOrProcessServer) {
          if (!requiredMcps.includes(s.id)) {
            requiredMcps.push(s.id);
          }
        }
      }
    }
    // Filter out mcp-laya from the execution tools passed to workers (Laya is an internal decision engine)
    requiredMcps = requiredMcps.filter((id) => id !== 'mcp-laya');

    // 4. Hardener necessity decision
    let requiresHardener = false;
    let hardenerReason = 'Task classified as straightforward/small; Hardener QA skipped to conserve tokens.';

    if (!isStraightforward && taskKind === 'coding') {
      const hardenerRes = await callLayaBoolean(
        `Does this task involve multi-file system architecture or high-risk modifications that require an independent automated QA smoke/eval agent (Hardener)?\n\n${taskText}`,
        task.subtasks.length >= 4
      );
      requiresHardener = hardenerRes.value;
      hardenerReason = requiresHardener
        ? 'Laya decision engine classified as complex coding requiring independent QA validation.'
        : 'Laya decision engine determined deliverable can be self-verified without heavy Hardener pass.';
    }

    return {
      taskKind,
      isStraightforward,
      requiredMcps,
      requiresHardener,
      hardenerReason,
      confidence: kindConfidence,
      usedLaya: true
    };
  } catch (err) {
    console.warn('[LayaClient] performSummaryTriageWithLaya failed, falling back to LLM/regex:', err);
    return null;
  }
}
