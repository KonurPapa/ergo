/**
 * Rules and skills the user sets for every task, or for the tasks of one swim lane.
 *
 * - Every task: <storage>/config/rules.json `{ version: 1, rules, skillIds }`.
 * - One lane: the project's projects/<id>/project.json, under `lanes[<lane file name>]` (the same shape; the file also
 *   holds the project's own Allowed Folders, which are left as they are). Keyed by file, not lane id: a lane's id is
 *   rebuilt from its file name on load, and renaming a lane renames its file (renameLaneScope moves the entry).
 *
 * A run gets the rules with the project's learned rules (PROJECT RULES), and the skills as if the task had invoked them
 * with /name. Like everything the user sets, they live on the user's machine; the app keeps the loaded copy in memory.
 */
import type { WorkspaceSkill } from '../types';
import type { ProjectInsight } from './memory/types';
import { readFilesFromDisk, writeFilesToDisk } from './fileSystem';

export interface ScopedRule {
  id: string;
  text: string;
}

export interface ScopeConfig {
  rules: ScopedRule[];
  /** Workspace skill ids applied to every task of the scope. */
  skillIds: string[];
}

const GLOBAL_FILE = 'config/rules.json';
const EMPTY: ScopeConfig = { rules: [], skillIds: [] };

let globalScope: ScopeConfig = EMPTY;
let laneScopes: Record<string, ScopeConfig> = {};
let projectFile: string | null = null;
/** Lane id → its file name (the key in project.json), from the open project's lanes. */
let laneFiles: Record<string, string> = {};
const listeners = new Set<() => void>();

const fileKey = (filePath: string) => filePath.split('/').pop() || filePath;
const laneKey = (laneId: string) => laneFiles[laneId] || laneId;

/** The open project's lanes (their ids and files). */
export function setScopedLanes(lanes: Array<{ id: string; filePath: string }>): void {
  laneFiles = Object.fromEntries(lanes.map((l) => [l.id, fileKey(l.filePath)]));
}

function asScope(raw: unknown): ScopeConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ScopeConfig>;
  return {
    rules: (Array.isArray(r.rules) ? r.rules : []).filter((x) => x && typeof x.text === 'string' && x.text.trim()),
    skillIds: (Array.isArray(r.skillIds) ? r.skillIds : []).filter((x) => typeof x === 'string'),
  };
}

function parse(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function notify() {
  listeners.forEach((cb) => cb());
}

export function subscribeScopedRules(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reads the rules for every task and the open project's lane rules (`projectFolder`: e.g. "projects/my-app"). */
export async function loadScopedRules(projectFolder?: string): Promise<void> {
  projectFile = projectFolder ? `${projectFolder}/project.json` : null;
  const files = await readFilesFromDisk(projectFile ? [GLOBAL_FILE, projectFile] : [GLOBAL_FILE]).catch(() => ({} as Record<string, string | null>));
  globalScope = asScope(parse(files[GLOBAL_FILE]));
  const lanes = projectFile ? parse(files[projectFile]).lanes : undefined;
  laneScopes = {};
  if (lanes && typeof lanes === 'object') {
    for (const [id, cfg] of Object.entries(lanes as Record<string, unknown>)) laneScopes[id] = asScope(cfg);
  }
  notify();
}

export function getGlobalScope(): ScopeConfig {
  return globalScope;
}

export function getLaneScope(laneId: string | undefined): ScopeConfig {
  return (laneId && laneScopes[laneKey(laneId)]) || EMPTY;
}

export async function saveGlobalScope(next: ScopeConfig): Promise<void> {
  globalScope = next;
  notify();
  await writeFilesToDisk([{ filePath: GLOBAL_FILE, content: JSON.stringify({ version: 1, ...next }, null, 2) }]);
}

export async function saveLaneScope(laneId: string, next: ScopeConfig): Promise<void> {
  laneScopes = { ...laneScopes, [laneKey(laneId)]: next };
  await writeLaneScopes();
}

/** A lane's file was renamed: its rules and skills move with it. */
export async function renameLaneScope(oldFilePath: string, newFilePath: string): Promise<void> {
  const from = fileKey(oldFilePath);
  const to = fileKey(newFilePath);
  if (from === to || !laneScopes[from]) return;
  const { [from]: moved, ...rest } = laneScopes;
  laneScopes = { ...rest, [to]: moved };
  for (const [id, file] of Object.entries(laneFiles)) if (file === from) laneFiles[id] = to;
  await writeLaneScopes();
}

async function writeLaneScopes(): Promise<void> {
  if (!projectFile) return;
  notify();
  // Read first: the file also holds the project's own Allowed Folders.
  const file = projectFile;
  const current = parse((await readFilesFromDisk([file]).catch(() => ({} as Record<string, string | null>)))[file]);
  await writeFilesToDisk([{ filePath: file, content: JSON.stringify({ ...current, version: 1, lanes: laneScopes }, null, 2) }]);
}

/** The user's rules for a task of `laneId`: every task's, then the lane's. */
export function scopedRulesFor(laneId: string | undefined): string[] {
  return [...globalScope.rules, ...getLaneScope(laneId).rules].map((r) => r.text.trim()).filter(Boolean);
}

/** The project's learned rules plus the user's rules for the task's lane, as one list for the run. */
export function withScopedRules(insights: ProjectInsight[] | undefined, laneId: string | undefined): ProjectInsight[] {
  const now = Date.now();
  const own = scopedRulesFor(laneId).map((text, i): ProjectInsight => ({
    id: `user-rule-${i + 1}`,
    text,
    scope: 'always',
    confirms: 0,
    origin: 'user',
    createdAt: now,
    updatedAt: now,
  }));
  return [...own, ...(insights || [])];
}

/** The enabled skills set for every task and for `laneId`'s tasks. */
export function scopedSkillsFor(laneId: string | undefined, skills: WorkspaceSkill[]): WorkspaceSkill[] {
  const ids = new Set([...globalScope.skillIds, ...getLaneScope(laneId).skillIds]);
  return skills.filter((s) => s.enabled && ids.has(s.id));
}
