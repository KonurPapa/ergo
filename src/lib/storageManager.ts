import {
  type AppSettings,
  type AppSecrets,
  type FolderMetadata,
  type ProjectData,
  type UserApiKey
} from '../types';
import { INITIAL_PROJECTS } from './demoData';
import { callMcpTool } from './mcpClient';

const DB_NAME = 'ergo_storage_db';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const ROOT_HANDLE_KEY = 'root_directory_handle';
const ROOT_HANDLE_NAME_KEY = 'ergo_root_folder_name';

export const DEFAULT_HUMAN_ASSISTANT_SKILL = `---
name: human-assistant
description: Human-side workspace AI copilot. Directly reads, crafts, and writes TODO.md and AGENT_CONTEXT.md files in native markdown format on behalf of the user.
argument-hint: <natural language instruction for task management>
allowed-tools: Read Edit Write Grep Glob Bash AskUserQuestion
---

# human-assistant — Human Workspace AI Copilot

You are the **Human Workspace AI Assistant** in Ergo. You directly edit and write the project's \`TODO.md\` and \`AGENT_CONTEXT.md\` markdown files.

You write directly in markdown format to the files — no JSON wrapping, no intermediaries, no syntax translation.

---

## 🌟 CORE PRINCIPLE: HUMAN-SIDE FIRST

You live and operate in the **Human Side** (\`TODO.md\`).

1. **Always Assume Human Side FIRST**: Everything the user tells you—details, steps, features, requirements, subtasks—is written directly into \`TODO.md\` as tasks and subtasks first.
2. **Do NOT Divert User Content to the Agent Side**: Never put large portions of what the user asked for into \`AGENT_CONTEXT.md\` while leaving \`TODO.md\` bare or generic. The human task list must capture the user's full intent.
3. **Agent Context is Secondary / Derived**: Only after you have completely finished editing and shaping \`TODO.md\` should you build the paired \`Overview\` in \`AGENT_CONTEXT.md\`. The only exception is if the user explicitly instructs you that something is meant for the agent/AI context alone and not for the task list.

---

## 🎯 OPERATIONAL MODES: TASK vs ARCHITECT

The AI assistant operates in two distinct modes:

### 1. Task Mode (Default)
- **ONLY for a Single Task / Subtasks**: Dedicated exclusively to creating or modifying a single task and its subtasks. This is either the task the user has currently selected, or a different task they explicitly call out (such as creating a new task).
- **Strict Isolation (ZERO BLEED-OVER)**: Confine your changes strictly to this single task. There must be **no bleed-over into other tasks** (do not reorder, edit, delete, or alter any other tasks in \`TODO.md\` or \`AGENT_CONTEXT.md\`).
- **Flesh Out Prompt**: The user provides a basic prompt or idea; your job is to flesh it out into a complete, well-formed task with concrete domain-specific subtask steps and a paired \`AGENT_CONTEXT.md\` brief.

### 2. Architect Mode
- **ALWAYS for Numerous Tasks**: Specifically designed for creating or modifying multiple tasks across the workspace.
- **Higher-Level Scope**: NEVER assume it is confined to a single task; always assume that the instructions the user gives are higher-level, broader architectural goals that should span multiple tasks, subtasks, and roadmap milestones.
- **Extrapolate Broadly**: Break down the user's high-level vision into structured categories and tasks with clear domain subtasks.
- **Strict Markdown Hierarchy**: Always maintain correct markdown list formatting (numbered tasks \`1.\`, \`2.\`, 4-space indented subtasks \`    - \`, and category headers \`##\`), and generate paired \`### N. Title\` briefs in \`AGENT_CONTEXT.md\` for all tasks.

---

## Direct Markdown Editing Flow (STRICTLY FOLLOW)

1. Read TODO.md & AGENT_CONTEXT.md  (Inspect current tasks, numbering, categories)
2. Check Mode & Interpret Intent     (Task mode = single task; Architect mode = multi-task roadmap)
3. Write TODO.md                     (Apply changes directly in markdown — Human side FIRST)
4. Sync AGENT_CONTEXT.md             (Update paired ### N. Title sections directly in markdown)
5. Report Summary                    (Concise report with clickable line pointers)

---

## TODO.md Markdown Formatting Rules

Use 4 spaces (not tabs) for subtask indentation. The exact format:

\`\`\`markdown
## Category Name

1. Task title
    - Subtask step one
    - Subtask step two
2. Another task
3. Single atomic task with no subtasks
\`\`\`

Key rules:
- **Numbered lists** (\`1.\`, \`2.\`, etc.) for tasks. Restart numbering at 1 within each category.
- **4-space-indented dash** (\`    - \`) for subtasks under a task.
- **Headings** (\`##\`) for category grouping (optional — omit if no categories exist).
- **Strikethrough** (\`~~Task title~~\`) to mark a task as done.
- **\`**human review**\`** prefix on subtasks that need manual review.
- Preserve any existing header comments (\`<!-- ... -->\`).
- Keep blank lines between categories, not between tasks within the same category.

---

## AGENT_CONTEXT.md Markdown Formatting Rules

Each task gets a mirrored section in \`AGENT_CONTEXT.md\`:

\`\`\`markdown
### 1. Task Title

**Status:** not started

**Overview**

Description of what this task accomplishes, architectural context, and affected files.

**Build & Verification**

(Empty until work begins)

**Completion**

(Empty until work is done)

---
\`\`\`

---

## Deletion Rule (CRITICAL)

You **MUST NEVER** delete tasks or briefs without explicit user permission.

---

## Direct File Output Format

When editing files, output the markdown directly into the target files or format:

\`\`\`markdown:TODO.md
# TODO.md content directly in markdown
\`\`\`

\`\`\`markdown:AGENT_CONTEXT.md
# AGENT_CONTEXT.md content directly in markdown
\`\`\`
`;

export const DEFAULT_ASSISTANT_CONTEXT_ANALYZER_SKILL = `---
name: assistant-context-analyzer
description: AI Step 1: Skims existing headers, categories, and tasks against the user query to extract relevant context, structures to copy, or data references in under 200 words.
argument-hint: <user query and current workspace files>
allowed-tools: Read Grep
---

# assistant-context-analyzer — Step 1: Context & Relevance Analyzer

You are **AI 1** in the Ergo Human AI Assistant 3-stage pipeline.

Your sole responsibility is to analyze the user's query in the context of the existing \`TODO.md\` and \`AGENT_CONTEXT.md\` workspace files and produce a concise briefing for **AI 2 (TODO Builder)**.

1. **Skim Existing Headers & Tasks**: Inspect current categories (\`## ...\`), task titles (\`1. ...\`), subtasks (\`    - ...\`), and briefs (\`### N. Title\`).
2. **Interpret Mode & Scope**:
   - **Task Mode**: ONLY for creating or modifying a single task/subtasks — either the task currently selected, or a different task explicitly called out (e.g. creating a new task). Strict isolation, zero bleed-over.
   - **Architect Mode**: ALWAYS for creating or modifying numerous tasks. Treat user instructions as higher-level goals spanning multiple tasks, subtasks, and roadmap milestones.
3. **Extract Relevant Context**:
   - Relevant existing tasks or category structures that should be mirrored or copied.
   - Relevant data, references, or IDs mentioned in existing tasks or briefs.
   - Category placement recommendations and next available task number.
4. **Output Constraint**: Keep your final analysis **short and sweet — no more than 200 words total**.
`;

export const DEFAULT_ASSISTANT_TODO_BUILDER_SKILL = `---
name: assistant-todo-builder
description: AI Step 2: Takes the user query, the context analysis from AI 1, and the current TODO.md to build or edit the TODO.md task structure with strict markdown formatting.
argument-hint: <user query, AI 1 context, and current TODO.md>
allowed-tools: Read Edit Write
---

# assistant-todo-builder — Step 2: TODO.md Task Builder

You are **AI 2** in the Ergo Human AI Assistant 3-stage pipeline.

Your sole responsibility is to take the user's request, the **Context Analysis from AI 1**, the active mode (**Task** or **Architect**), and the current \`TODO.md\` file, and generate the **complete, updated \`TODO.md\`** in native markdown.

- **Task Mode (Default)**: ONLY for creating or modifying a single task and its subtasks — either the currently selected task, or a specific task explicitly called out (e.g. creating a new task). Confine all modifications strictly to that single task with ZERO bleed-over into other tasks.
- **Architect Mode**: ALWAYS for creating or modifying numerous tasks. Never assume it is confined to a single task, treating instructions as higher-level architectural workflows spanning multiple tasks and roadmap milestones.
- **Strict Formatting**: 4 spaces for subtask indentation (\`    - \`), numbered lists (\`1.\`), category headers (\`##\`), and never truncate output early.
`;

export const DEFAULT_ASSISTANT_CONTEXT_SYNCER_SKILL = `---
name: assistant-context-syncer
description: AI Step 3: Synchronizes AGENT_CONTEXT.md to pair 1-to-1 with TODO.md and drafts/edits rich Overviews for all new or modified tasks.
argument-hint: <updated TODO.md, AI 1 context, and current AGENT_CONTEXT.md>
allowed-tools: Read Edit Write
---

# assistant-context-syncer — Step 3: Context Syncer & Overview Drafter

You are **AI 3** in the Ergo Human AI Assistant 3-stage pipeline.

Your sole responsibility is to take the **updated \`TODO.md\`** produced by AI 2, the **Context Analysis from AI 1**, and the current \`AGENT_CONTEXT.md\`, and generate the **complete, updated \`AGENT_CONTEXT.md\`** in native markdown.

1. Ensure 1-to-1 paired \`### N. Task Title\` sections matching \`TODO.md\` order and numbering.
2. For all created/modified tasks, draft rich \`Overview\`s detailing Done-State, In Context, and Seams.
3. Keep standard section schema with Status, Overview, Build & Verification, and Completion.
`;

/**
 * Open IndexedDB database for persisting FileSystemDirectoryHandle
 */
function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB is not supported in this environment'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Store FileSystemDirectoryHandle in IndexedDB
 */
export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(handle, ROOT_HANDLE_KEY);
      req.onsuccess = () => {
        try {
          localStorage.setItem(ROOT_HANDLE_NAME_KEY, handle.name);
        } catch {}
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[StorageManager] Failed to persist directory handle in IndexedDB:', err);
  }
}

/**
 * Retrieve saved FileSystemDirectoryHandle from IndexedDB
 */
export async function getSavedDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(ROOT_HANDLE_KEY);
      req.onsuccess = () => {
        resolve(req.result || null);
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('[StorageManager] Could not retrieve directory handle from IndexedDB:', err);
    return null;
  }
}

/**
 * Clear saved directory handle from IndexedDB
 */
export async function clearSavedDirectoryHandle(): Promise<void> {
  try {
    localStorage.removeItem(ROOT_HANDLE_NAME_KEY);
    const db = await openHandleDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(ROOT_HANDLE_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch (err) {
    console.warn('[StorageManager] Failed to clear directory handle:', err);
  }
}

/**
 * Verify or query permissions for a FileSystemDirectoryHandle
 */
export async function verifyHandlePermission(
  handle: FileSystemDirectoryHandle,
  requestIfNeeded = false
): Promise<boolean> {
  try {
    const opts: { mode?: 'read' | 'readwrite' } = { mode: 'readwrite' };
    const queryRes = await (handle as any).queryPermission(opts);
    if (queryRes === 'granted') {
      return true;
    }
    if (requestIfNeeded) {
      const reqRes = await (handle as any).requestPermission(opts);
      return reqRes === 'granted';
    }
    return false;
  } catch (err) {
    console.warn('[StorageManager] Permission verification error:', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Native File System Access API (FSA) Helper Utilities
// ─────────────────────────────────────────────────────────────

async function getOrCreateSubdir(
  parent: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle> {
  return await parent.getDirectoryHandle(name, { create: true });
}

async function readFileTextFromDir(
  dir: FileSystemDirectoryHandle,
  filename: string
): Promise<string | null> {
  try {
    const fileHandle = await dir.getFileHandle(filename, { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function writeFileTextToDir(
  dir: FileSystemDirectoryHandle,
  filename: string,
  content: string
): Promise<void> {
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await (fileHandle as any).createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * Ensure config and default project structures exist on disk
 */
export async function initializeFolderStructure(
  rootHandle: FileSystemDirectoryHandle
): Promise<{ settings: AppSettings | null; secrets: AppSecrets | null }> {
  // 1. config folder
  const configDir = await getOrCreateSubdir(rootHandle, 'config');

  // Read or create settings.json
  let settingsContent = await readFileTextFromDir(configDir, 'settings.json');
  let settings: AppSettings | null = null;
  if (settingsContent) {
    try {
      settings = JSON.parse(settingsContent);
    } catch {}
  }
  if (!settings) {
    settings = {
      version: 1,
      activeProjectId: 'default-workspace',
      activeKeyId: null,
      autosaveDelaySec: 5,
      autosaveEnabled: true,
      theme: 'light',
      lastOpenedAt: new Date().toISOString()
    };
    await writeFileTextToDir(configDir, 'settings.json', JSON.stringify(settings, null, 2));
  }

  // Read or create secrets.json
  let secretsContent = await readFileTextFromDir(configDir, 'secrets.json');
  let secrets: AppSecrets | null = null;
  if (secretsContent) {
    try {
      secrets = JSON.parse(secretsContent);
    } catch {}
  }
  if (!secrets) {
    secrets = {
      version: 1,
      updatedAt: new Date().toISOString(),
      userApiKeys: [],
      mcpSecrets: {}
    };
    await writeFileTextToDir(configDir, 'secrets.json', JSON.stringify(secrets, null, 2));
  }

  // 2. projects folder
  const projectsDir = await getOrCreateSubdir(rootHandle, 'projects');
  // Check if projects has any subdirectories
  let hasAnyProject = false;
  try {
    for await (const [_, handle] of (projectsDir as any).entries()) {
      if (handle.kind === 'directory') {
        hasAnyProject = true;
        break;
      }
    }
  } catch {}

  if (!hasAnyProject) {
    const defaultWorkspaceDir = await getOrCreateSubdir(projectsDir, 'default-workspace');
    const defaultProj = INITIAL_PROJECTS[0];
    await writeFileTextToDir(defaultWorkspaceDir, 'TODO.md', defaultProj.todoMarkdown);
    await writeFileTextToDir(defaultWorkspaceDir, 'AGENT_CONTEXT.md', defaultProj.agentContextMarkdown);
  }

  return { settings, secrets };
}

// ─────────────────────────────────────────────────────────────
// StorageManager Class & Singleton
// ─────────────────────────────────────────────────────────────

export class StorageManager {
  private activeHandle: FileSystemDirectoryHandle | null = null;
  private folderMetadata: FolderMetadata = {
    name: localStorage.getItem(ROOT_HANDLE_NAME_KEY) || 'Local Workspace',
    status: 'connected',
    mode: 'server_api'
  };

  /**
   * Check if the browser supports Native File System Access API
   */
  public isFsaSupported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  public getActiveHandle(): FileSystemDirectoryHandle | null {
    return this.activeHandle;
  }

  public getMetadata(): FolderMetadata {
    return this.folderMetadata;
  }

  /**
   * Fetch current storage directory configuration (~/.ergo default)
   */
  public async getStorageConfig(): Promise<{
    defaultPath: string;
    activePath: string;
    resolvedPath: string;
    homeDir: string;
  }> {
    try {
      const res = await fetch('/api/storage/config');
      if (res.ok) {
        return await res.json();
      }
    } catch {}

    const saved = localStorage.getItem('ergo_storage_directory') || '~/.ergo';
    return {
      defaultPath: '~/.ergo',
      activePath: saved,
      resolvedPath: saved,
      homeDir: ''
    };
  }

  /**
   * Update active storage directory (e.g. change from ~/.ergo to custom folder)
   */
  public async setStorageDirectory(newPath: string): Promise<{
    success: boolean;
    activePath?: string;
    resolvedPath?: string;
    error?: string;
  }> {
    try {
      localStorage.setItem('ergo_storage_directory', newPath);
      const res = await fetch('/api/storage/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath })
      });
      if (res.ok) {
        const data = await res.json();
        this.folderMetadata = {
          ...this.folderMetadata,
          name: newPath,
          storageDirectory: data.activePath,
          resolvedPath: data.resolvedPath,
          lastSyncedAt: new Date().toISOString()
        };
        return {
          success: true,
          activePath: data.activePath,
          resolvedPath: data.resolvedPath
        };
      }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to update storage directory' };
    }
    return { success: true, activePath: newPath, resolvedPath: newPath };
  }

  /**
   * Initialize and restore saved handle or use Filesystem MCP universal host
   */
  public async init(): Promise<{
    metadata: FolderMetadata;
    settings: AppSettings | null;
    secrets: AppSecrets | null;
    projects: ProjectData[];
  }> {
    const storageConfig = await this.getStorageConfig();

    if (this.isFsaSupported()) {
      const savedHandle = await getSavedDirectoryHandle();
      if (savedHandle) {
        const hasPerm = await verifyHandlePermission(savedHandle, false);
        if (hasPerm) {
          this.activeHandle = savedHandle;
          this.folderMetadata = {
            name: savedHandle.name,
            storageDirectory: storageConfig.activePath,
            resolvedPath: storageConfig.resolvedPath,
            status: 'connected',
            mode: 'file_system_api',
            lastSyncedAt: new Date().toISOString()
          };

          const { settings, secrets } = await initializeFolderStructure(savedHandle);
          const projects = await this.scanProjects();
          return { metadata: this.folderMetadata, settings, secrets, projects };
        } else {
          // Handle is saved but needs permission click from user
          this.activeHandle = savedHandle;
          this.folderMetadata = {
            name: savedHandle.name,
            storageDirectory: storageConfig.activePath,
            resolvedPath: storageConfig.resolvedPath,
            status: 'needs_permission',
            mode: 'file_system_api'
          };
        }
      }
    }

    // Universal Browser-Agnostic Tier: Filesystem MCP / Local Server API
    const settings = await this.loadSettings();
    const secrets = await this.loadSecrets();
    const projects = await this.scanProjects();

    this.folderMetadata = {
      name: storageConfig.activePath || '~/.ergo',
      storageDirectory: storageConfig.activePath,
      resolvedPath: storageConfig.resolvedPath,
      status: 'connected',
      mode: 'server_api',
      lastSyncedAt: new Date().toISOString()
    };

    return { metadata: this.folderMetadata, settings, secrets, projects };
  }

  /**
   * Prompt user to pick a root directory using native OS dialog
   */
  public async pickRootDirectory(): Promise<{
    success: boolean;
    metadata: FolderMetadata;
    settings: AppSettings | null;
    secrets: AppSecrets | null;
    projects: ProjectData[];
    error?: string;
  }> {
    if (!this.isFsaSupported()) {
      return {
        success: false,
        metadata: this.folderMetadata,
        settings: null,
        secrets: null,
        projects: [],
        error: 'File System Access API is not supported in this browser.'
      };
    }

    try {
      const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({
        id: 'ergo_workspace_root',
        mode: 'readwrite'
      });

      const hasPerm = await verifyHandlePermission(handle, true);
      if (!hasPerm) {
        return {
          success: false,
          metadata: this.folderMetadata,
          settings: null,
          secrets: null,
          projects: [],
          error: 'Read/write permission was not granted for the selected folder.'
        };
      }

      this.activeHandle = handle;
      await saveDirectoryHandle(handle);

      this.folderMetadata = {
        name: handle.name,
        status: 'connected',
        mode: 'file_system_api',
        lastSyncedAt: new Date().toISOString()
      };

      const { settings, secrets } = await initializeFolderStructure(handle);
      const projects = await this.scanProjects();

      return {
        success: true,
        metadata: this.folderMetadata,
        settings,
        secrets,
        projects
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return {
          success: false,
          metadata: this.folderMetadata,
          settings: null,
          secrets: null,
          projects: [],
          error: 'Directory selection was cancelled.'
        };
      }
      return {
        success: false,
        metadata: this.folderMetadata,
        settings: null,
        secrets: null,
        projects: [],
        error: err?.message || 'Failed to select directory.'
      };
    }
  }

  /**
   * Request permission for existing saved handle
   */
  public async requestHandlePermission(): Promise<boolean> {
    if (!this.activeHandle) {
      const saved = await getSavedDirectoryHandle();
      if (saved) this.activeHandle = saved;
    }
    if (!this.activeHandle) return false;

    const granted = await verifyHandlePermission(this.activeHandle, true);
    if (granted) {
      this.folderMetadata = {
        name: this.activeHandle.name,
        status: 'connected',
        mode: 'file_system_api',
        lastSyncedAt: new Date().toISOString()
      };
    }
    return granted;
  }

  /**
   * Disconnect root directory and clear handle
   */
  public async disconnectRootDirectory(): Promise<void> {
    this.activeHandle = null;
    await clearSavedDirectoryHandle();
    this.folderMetadata = {
      name: 'Local Workspace Directory',
      status: 'server_fallback',
      mode: 'server_api'
    };
  }

  /**
   * Load App Settings (config/settings.json)
   */
  public async loadSettings(): Promise<AppSettings | null> {
    // 1. Try Filesystem MCP tool call (Browser-Agnostic Tier)
    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'read_file', { path: 'config/settings.json' });
      if (mcpRes.success && mcpRes.data?.content) {
        return JSON.parse(mcpRes.data.content);
      }
    } catch {}

    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const configDir = await getOrCreateSubdir(this.activeHandle, 'config');
        const text = await readFileTextFromDir(configDir, 'settings.json');
        if (text) return JSON.parse(text);
      } catch (err) {
        console.warn('[StorageManager] Error reading settings from FSA handle:', err);
      }
    }

    // Try Vite Server API
    try {
      const res = await fetch('/api/config/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'settings' })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data) return data.data;
      }
    } catch {}

    // Fallback to localStorage
    const saved = localStorage.getItem('ergo_app_settings');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {}
    }
    return null;
  }

  /**
   * Save App Settings (config/settings.json)
   */
  public async saveSettings(settings: AppSettings): Promise<boolean> {
    try {
      localStorage.setItem('ergo_app_settings', JSON.stringify(settings));
    } catch {}

    let saved = false;

    // 1. Filesystem MCP tool write (Browser-Agnostic)
    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'write_file', {
        path: 'config/settings.json',
        content: JSON.stringify(settings, null, 2)
      });
      if (mcpRes.success) saved = true;
    } catch {}

    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const configDir = await getOrCreateSubdir(this.activeHandle, 'config');
        await writeFileTextToDir(configDir, 'settings.json', JSON.stringify(settings, null, 2));
        saved = true;
      } catch (err) {
        console.warn('[StorageManager] Error writing settings to FSA handle:', err);
      }
    }

    // Also write to server API fallback
    try {
      const res = await fetch('/api/config/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'settings', data: settings })
      });
      if (res.ok) saved = true;
    } catch {}

    return saved;
  }

  /**
   * Load App Secrets (config/secrets.json)
   */
  public async loadSecrets(): Promise<AppSecrets | null> {
    // 1. Try Filesystem MCP tool call (Browser-Agnostic Tier)
    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'read_file', { path: 'config/secrets.json' });
      if (mcpRes.success && mcpRes.data?.content) {
        return JSON.parse(mcpRes.data.content);
      }
    } catch {}

    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const configDir = await getOrCreateSubdir(this.activeHandle, 'config');
        const text = await readFileTextFromDir(configDir, 'secrets.json');
        if (text) return JSON.parse(text);
      } catch (err) {
        console.warn('[StorageManager] Error reading secrets from FSA handle:', err);
      }
    }

    // Try Vite Server API
    try {
      const res = await fetch('/api/config/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'secrets' })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data) return data.data;
      }
    } catch {}

    // Fallback to localStorage legacy keys
    const savedKeys = localStorage.getItem('ergo_user_api_keys');
    if (savedKeys) {
      try {
        const parsedKeys: UserApiKey[] = JSON.parse(savedKeys);
        return {
          version: 1,
          updatedAt: new Date().toISOString(),
          userApiKeys: parsedKeys,
          mcpSecrets: {}
        };
      } catch {}
    }

    return null;
  }

  /**
   * Save App Secrets (config/secrets.json)
   */
  public async saveSecrets(secrets: AppSecrets): Promise<boolean> {
    try {
      localStorage.setItem('ergo_user_api_keys', JSON.stringify(secrets.userApiKeys));
    } catch {}

    let saved = false;

    // 1. Filesystem MCP tool write (Browser-Agnostic)
    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'write_file', {
        path: 'config/secrets.json',
        content: JSON.stringify(secrets, null, 2)
      });
      if (mcpRes.success) saved = true;
    } catch {}

    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const configDir = await getOrCreateSubdir(this.activeHandle, 'config');
        await writeFileTextToDir(configDir, 'secrets.json', JSON.stringify(secrets, null, 2));
        saved = true;
      } catch (err) {
        console.warn('[StorageManager] Error writing secrets to FSA handle:', err);
      }
    }

    // Also write to server API fallback
    try {
      const res = await fetch('/api/config/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'secrets', data: secrets })
      });
      if (res.ok) saved = true;
    } catch {}

    return saved;
  }

  /**
   * Load Skill Document (config/skills/<skillName>/SKILL.md)
   */
  public async loadSkillDoc(skillName = 'human-assistant'): Promise<string | null> {
    try {
      const res = await fetch('/api/skills/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.content && !data.content.includes('Strict JSON Output Schema') && !data.content.includes('createdTasks')) {
          try {
            localStorage.setItem(`ergo_skill_${skillName}`, data.content);
          } catch {}
          return data.content;
        }
      }
    } catch {}

    // Fallback to Filesystem MCP
    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'read_file', {
        path: `config/skills/${skillName}/SKILL.md`
      });
      if (mcpRes.success && mcpRes.data?.content) {
        if (!mcpRes.data.content.includes('Strict JSON Output Schema') && !mcpRes.data.content.includes('createdTasks')) {
          try {
            localStorage.setItem(`ergo_skill_${skillName}`, mcpRes.data.content);
          } catch {}
          return mcpRes.data.content;
        }
      }
    } catch {}

    // Fallback to localStorage only if it doesn't contain outdated JSON schemas
    const cached = localStorage.getItem(`ergo_skill_${skillName}`);
    if (cached) {
      if (cached.includes('Strict JSON Output Schema') || cached.includes('createdTasks')) {
        try {
          localStorage.removeItem(`ergo_skill_${skillName}`);
        } catch {}
      } else {
        return cached;
      }
    }

    let fallbackContent: string | null = null;
    if (skillName === 'human-assistant') {
      fallbackContent = DEFAULT_HUMAN_ASSISTANT_SKILL;
    } else if (skillName === 'assistant-context-analyzer') {
      fallbackContent = DEFAULT_ASSISTANT_CONTEXT_ANALYZER_SKILL;
    } else if (skillName === 'assistant-todo-builder') {
      fallbackContent = DEFAULT_ASSISTANT_TODO_BUILDER_SKILL;
    } else if (skillName === 'assistant-context-syncer') {
      fallbackContent = DEFAULT_ASSISTANT_CONTEXT_SYNCER_SKILL;
    }

    if (fallbackContent) {
      try {
        localStorage.setItem(`ergo_skill_${skillName}`, fallbackContent);
      } catch {}
      // Auto-save to local disk so the user immediately has the file on disk to see and edit
      this.saveSkillDoc(skillName, fallbackContent).catch(() => {});
      return fallbackContent;
    }

    return null;
  }

  /**
   * Save Skill Document (config/skills/<skillName>/SKILL.md)
   */
  public async saveSkillDoc(skillName = 'human-assistant', content: string): Promise<boolean> {
    try {
      localStorage.setItem(`ergo_skill_${skillName}`, content);
    } catch {}

    let saved = false;
    try {
      const res = await fetch('/api/skills/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName, content })
      });
      if (res.ok) saved = true;
    } catch {}

    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'write_file', {
        path: `config/skills/${skillName}/SKILL.md`,
        content
      });
      if (mcpRes.success) saved = true;
    } catch {}

    return saved;
  }

  /**
   * Scan projects/ directory and return loaded ProjectData list
   */
  public async scanProjects(): Promise<ProjectData[]> {
    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const projectsDir = await getOrCreateSubdir(this.activeHandle, 'projects');
        const projectList: ProjectData[] = [];

        for await (const [name, handle] of (projectsDir as any).entries()) {
          if (handle.kind === 'directory') {
            const projectDirHandle = handle as FileSystemDirectoryHandle;
            const todoMd = (await readFileTextFromDir(projectDirHandle, 'TODO.md')) || '';
            const agentMd = (await readFileTextFromDir(projectDirHandle, 'AGENT_CONTEXT.md')) || '';
            const swimLanes: Array<{ id: string; title: string; filePath: string; markdown: string }> = [];

            for await (const [fileName, fileHandle] of (projectDirHandle as any).entries()) {
              if (fileHandle.kind === 'file' && fileName.endsWith('.md') && fileName !== 'AGENT_CONTEXT.md') {
                const content = (await readFileTextFromDir(projectDirHandle, fileName)) || '';
                const title = fileName === 'TODO.md' ? 'Human Workspace' : fileName.replace(/\.md$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
                swimLanes.push({
                  id: `lane-${fileName.replace(/\.md$/i, '').toLowerCase()}`,
                  title,
                  filePath: `projects/${name}/${fileName}`,
                  markdown: content
                });
              }
            }

            if (swimLanes.length === 0 && todoMd) {
              swimLanes.push({
                id: 'lane-default',
                title: 'Human Workspace',
                filePath: `projects/${name}/TODO.md`,
                markdown: todoMd
              });
            }

            projectList.push({
              id: name,
              name: name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
              description: `Project directory: projects/${name}`,
              folderPath: `projects/${name}`,
              todoFilePath: `projects/${name}/TODO.md`,
              agentContextFilePath: `projects/${name}/AGENT_CONTEXT.md`,
              todoMarkdown: todoMd,
              agentContextMarkdown: agentMd,
              swimLanes,
              connectedMcps: ['mcp-filesystem', 'mcp-fetch', 'mcp-git', 'mcp-github', 'mcp-slack']
            });
          }
        }

        if (projectList.length > 0) {
          return projectList;
        }
      } catch (err) {
        console.warn('[StorageManager] Error scanning projects via FSA:', err);
      }
    }

    // Try Vite Server API /api/projects/list
    try {
      const res = await fetch('/api/projects/list');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.projects) && data.projects.length > 0) {
          return data.projects.map((p: any) => ({
            ...p,
            description: p.description || `Project directory: ${p.folderPath}`,
            connectedMcps: ['mcp-filesystem', 'mcp-fetch', 'mcp-git', 'mcp-github', 'mcp-slack']
          }));
        }
      }
    } catch {}

    // Fallback to localStorage or INITIAL_PROJECTS
    const saved = localStorage.getItem('ergo_projects');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
    }

    return INITIAL_PROJECTS;
  }

  /**
   * Save project markdown files directly to disk via MCP or FSA handle
   */
  public async saveProjectFiles(
    files: Array<{ filePath: string; content: string }>
  ): Promise<{ success: boolean; error?: string }> {
    let savedAny = false;

    // 1. Filesystem MCP tool write (Browser-Agnostic)
    try {
      for (const file of files) {
        const mcpRes = await callMcpTool('mcp-filesystem', 'write_file', {
          path: file.filePath,
          content: file.content
        });
        if (mcpRes.success) savedAny = true;
      }
      if (savedAny) return { success: true };
    } catch {}

    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        for (const file of files) {
          const parts = file.filePath.split('/').filter(Boolean);
          if (parts.length === 0) continue;

          let currentDir = this.activeHandle;
          for (let i = 0; i < parts.length - 1; i++) {
            currentDir = await getOrCreateSubdir(currentDir, parts[i]);
          }
          const filename = parts[parts.length - 1];
          await writeFileTextToDir(currentDir, filename, file.content);
        }
        return { success: true };
      } catch (err: any) {
        console.warn('[StorageManager] Error writing project files to FSA:', err);
      }
    }

    // Fallback to server API /api/files/write
    try {
      const res = await fetch('/api/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files })
      });
      if (res.ok) {
        return { success: true };
      }
      const data = await res.json().catch(() => ({}));
      return { success: false, error: data.error || 'Failed to write files to disk' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error writing files' };
    }
  }

  /**
   * Create a new project directory and its initial markdown files
   */
  public async createProjectOnDisk(
    folderPath: string,
    todoContent: string,
    agentContextContent: string
  ): Promise<{ success: boolean; error?: string }> {
    // 1. Filesystem MCP tool write (Browser-Agnostic)
    try {
      await callMcpTool('mcp-filesystem', 'create_directory', { path: folderPath });
      await callMcpTool('mcp-filesystem', 'write_file', {
        path: `${folderPath}/TODO.md`,
        content: todoContent
      });
      await callMcpTool('mcp-filesystem', 'write_file', {
        path: `${folderPath}/AGENT_CONTEXT.md`,
        content: agentContextContent
      });
      return { success: true };
    } catch {}

    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const parts = folderPath.split('/').filter(Boolean);
        let currentDir = this.activeHandle;
        for (const part of parts) {
          currentDir = await getOrCreateSubdir(currentDir, part);
        }
        await writeFileTextToDir(currentDir, 'TODO.md', todoContent);
        await writeFileTextToDir(currentDir, 'AGENT_CONTEXT.md', agentContextContent);
        return { success: true };
      } catch (err: any) {
        console.warn('[StorageManager] Error creating project directory via FSA:', err);
      }
    }

    // Fallback to Server API /api/projects/create
    try {
      const res = await fetch('/api/projects/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, todoContent, agentContextContent })
      });
      if (res.ok) {
        return { success: true };
      }
      const data = await res.json().catch(() => ({}));
      return { success: false, error: data.error || 'Failed to create project on disk' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error creating project' };
    }
  }
}

export const storageManager = new StorageManager();
