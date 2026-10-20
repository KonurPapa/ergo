/**
 * Shared rules for a task's Overview, so the run launcher (which decides whether to generate one), the Summary
 * step (which may reuse one) and the Overview card (which decides whether to show one) never disagree.
 *
 * An overview only counts once a run's Summary step generated it (or the user wrote it in the Overview card).
 * New tasks start empty; text copied from the task or drafted elsewhere is never shown as the Overview. A
 * generated overview is kept and reused by reruns — no new Summary call — until the task's text changes.
 */
import type { AgentContextItem, OverviewDocument } from '../types';

interface OverviewTaskRef {
  id: string | number;
  title: string;
  subtasks?: Array<{ text: string }>;
}

type OverviewBriefRef = Pick<AgentContextItem, 'overview' | 'brief' | 'overviewSource' | 'overviewTaskHash' | 'overviewDocument'>;

/** Markers only the pipeline's Summary agent writes (Gherkin brief, "## Goals" sections). */
const SUMMARY_MARKERS_RE = /```gherkin|^\s*(?:Feature|Scenario):|^#{1,3}\s*(?:Goals|Acceptance Brief|Output)\b/im;

function overviewTextOf(brief: OverviewBriefRef | undefined | null): string {
  return (brief?.overview || brief?.brief || '').trim();
}

/** Stable fingerprint of what the task asks for (title + subtask texts; ticking a subtask off doesn't change it). */
export function overviewTaskFingerprint(task: OverviewTaskRef): string {
  const text = [task.title, ...(task.subtasks || []).map((s) => s.text)]
    .map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase())
    .join('\n');
  // djb2 — only needs to notice edits, not resist collisions.
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `v1:${(hash >>> 0).toString(36)}:${text.length}`;
}

/** True when the brief holds an overview a run generated or the user wrote (the Overview card shows it). */
export function hasUsableOverview(brief: OverviewBriefRef | undefined | null): boolean {
  const text = overviewTextOf(brief);
  if (!text) return false;
  if (brief?.overviewSource) return true;
  // Saved before overviews were stamped: only text with the Summary agent's own structure counts.
  return SUMMARY_MARKERS_RE.test(text);
}

/** A generated overview whose task was edited afterwards: shown, but regenerated on the next run. */
export function isOverviewStale(brief: OverviewBriefRef | undefined | null, task: OverviewTaskRef): boolean {
  return (
    hasUsableOverview(brief) &&
    brief?.overviewSource === 'generated' &&
    Boolean(brief.overviewTaskHash) &&
    brief.overviewTaskHash !== overviewTaskFingerprint(task)
  );
}

/** A run may reuse the saved overview instead of generating a new one. */
export function isOverviewReusable(brief: OverviewBriefRef | undefined | null, task: OverviewTaskRef): boolean {
  return hasUsableOverview(brief) && !isOverviewStale(brief, task);
}

/** The structured overview for a reusable brief: the saved Summary document, else one built from the text. */
export function overviewDocumentFor(brief: OverviewBriefRef): OverviewDocument {
  const text = overviewTextOf(brief);
  if (brief.overviewDocument && brief.overviewSource !== 'user') return { ...brief.overviewDocument };
  const gherkin = text.match(/```gherkin([\s\S]*?)```/)?.[1]?.trim() || '';
  return {
    brief: gherkin,
    goals: text,
    output_as: '',
    raw: text,
    // A user rewrite keeps the tool and related-task selections (and the task rating) of the overview it replaced.
    ...(brief.overviewDocument?.requiredMcps ? { requiredMcps: brief.overviewDocument.requiredMcps } : {}),
    ...(brief.overviewDocument?.relatedTaskIds ? { relatedTaskIds: brief.overviewDocument.relatedTaskIds } : {}),
    ...(brief.overviewDocument?.relatedTaskTitles ? { relatedTaskTitles: brief.overviewDocument.relatedTaskTitles } : {}),
    // The rating is of the task, not the overview text: a rewrite keeps it.
    ...(brief.overviewDocument?.taskRating ? { taskRating: brief.overviewDocument.taskRating } : {}),
  };
}

/** Brief fields recording a newly generated (or user-written) overview. */
export function stampOverview(
  task: OverviewTaskRef,
  source: 'generated' | 'user',
  markdown: string,
  document?: OverviewDocument
): Pick<AgentContextItem, 'overview' | 'brief' | 'overviewSource' | 'overviewTaskHash' | 'overviewDocument'> {
  return {
    overview: markdown,
    brief: markdown,
    overviewSource: source,
    overviewTaskHash: overviewTaskFingerprint(task),
    overviewDocument: document,
  };
}
