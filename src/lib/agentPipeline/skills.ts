/**
 * Loads the pipeline skill documents (the byte-stable role prompts).
 * The user's on-disk copy (~/.ergo/config/skills/<name>/SKILL.md, editable) wins; the bundled
 * docs/skills/<name>/SKILL.md is the default. Legacy JSON-era copies are rejected by marker.
 */
import { storageManager } from '../storageManager';
import { stripSkillFrontmatter } from '../llmClient';
import discoveryRaw from '../../../docs/skills/discovery-agent/SKILL.md?raw';
import summaryRaw from '../../../docs/skills/summary-agent/SKILL.md?raw';
import managerRaw from '../../../docs/skills/manager-agent/SKILL.md?raw';
import workerRaw from '../../../docs/skills/worker-agent/SKILL.md?raw';
import cleanerRaw from '../../../docs/skills/cleaner-agent/SKILL.md?raw';
import hardenerRaw from '../../../docs/skills/hardener-agent/SKILL.md?raw';

export type PipelineSkillName = 'discovery-agent' | 'summary-agent' | 'manager-agent' | 'worker-agent' | 'cleaner-agent' | 'hardener-agent';

const BUNDLED: Record<PipelineSkillName, string> = {
  'discovery-agent': discoveryRaw,
  'summary-agent': summaryRaw,
  'manager-agent': managerRaw,
  'worker-agent': workerRaw,
  'cleaner-agent': cleanerRaw,
  'hardener-agent': hardenerRaw
};

/** A heading that only exists in the current generation of each skill doc; stale copies are ignored. */
const FRESHNESS_MARKER: Record<PipelineSkillName, string> = {
  'discovery-agent': 'Early-Exit Subtask Inspection',
  'summary-agent': 'requiresHardener',
  'manager-agent': 'Simple / Standalone Deliverables',
  'worker-agent': 'Target Deliverables Only',
  'cleaner-agent': 'Completion Protocol',
  'hardener-agent': 'headless browser'
};

export async function loadPipelineSkill(name: PipelineSkillName): Promise<string> {
  let raw: string | null = null;
  try {
    raw = await storageManager.loadSkillDoc(name);
  } catch {
    raw = null;
  }
  if (!raw || !raw.includes(FRESHNESS_MARKER[name])) raw = BUNDLED[name];
  return stripSkillFrontmatter(raw).trim();
}

export function bundledPipelineSkill(name: PipelineSkillName): string {
  return BUNDLED[name];
}
