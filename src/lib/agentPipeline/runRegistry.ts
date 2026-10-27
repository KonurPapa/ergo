/**
 * The latest in-app pipeline run of each task, kept in memory so a post-run follow-up (continuation.ts) continues
 * it with the same bible (byte-identical cached prefix), run dir, tools and routed models. After an app restart the
 * continuation rebuilds what it needs from the saved overview and the run's TASK_CONTEXT.md instead.
 */
import type { AIProviderConfig, BibleSections, OverviewDocument, ProjectData, TaskKind } from '../../types';
import type { BibleStore } from './bible';
import type { RoutingResult } from './modelRouter';

export interface PipelineRunRecord {
  runId: string;
  runDir: string;
  bible: BibleStore;
  /**
   * The bible's stable sections exactly as the run's agents saw them (the run updates status / subtasks in place when
   * it ends): a follow-up renders its shared prefix from these, so the provider's prompt cache still matches.
   */
  stableSections: BibleSections;
  /** MCP selection the run's tool list was built from (the same list keeps the tools block byte-stable). */
  requiredMcps: string[];
  taskKind: TaskKind;
  requiresVerifier?: boolean;
  verifierReason?: string;
  overviewDoc: OverviewDocument;
  /** The routed config the run's agents used last (step-ups included). */
  getAiConfig: () => AIProviderConfig;
  getRouting: () => RoutingResult | undefined;
}

const runs = new Map<string, PipelineRunRecord>();

export function pipelineRunKey(project: Pick<ProjectData, 'id' | 'name'>, taskId: string | number): string {
  return `${project.id || project.name || 'project'}\u0000${String(taskId)}`;
}

export function rememberPipelineRun(key: string, record: PipelineRunRecord): void {
  runs.set(key, record);
}

export function recallPipelineRun(key: string): PipelineRunRecord | undefined {
  return runs.get(key);
}
