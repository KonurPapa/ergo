/**
 * Loads the pipeline skill documents (the byte-stable role prompts): the user's own edited copy on disk when there is
 * one, else Ergo's built-in version (storageManager.loadSkillDoc).
 */
import { storageManager, BUILTIN_SKILL_DOCS } from '../storageManager';
import { stripSkillFrontmatter } from '../llmClient';

export type PipelineSkillName = 'manager-agent' | 'worker-agent' | 'cleaner-agent' | 'verifier-agent' | 'task-brief';

export async function loadPipelineSkill(name: PipelineSkillName): Promise<string> {
  let raw: string | null = null;
  try {
    raw = await storageManager.loadSkillDoc(name);
  } catch {
    raw = null;
  }
  return stripSkillFrontmatter(raw || BUILTIN_SKILL_DOCS[name]).trim();
}

export function bundledPipelineSkill(name: PipelineSkillName): string {
  return BUILTIN_SKILL_DOCS[name];
}
