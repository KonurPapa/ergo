import {
  type AppSettings,
  type AppSecrets,
  type FolderMetadata,
  type ProjectData,
  type UserApiKey
} from '../types';
import { INITIAL_PROJECTS } from './demoData';
import { callMcpTool } from './mcpClient';
import { bridgeClient } from './bridgeClient';
import humanAssistantSkillRaw from '../../docs/skills/human-assistant/SKILL.md?raw';
import contextAnalyzerSkillRaw from '../../docs/skills/assistant-context-analyzer/SKILL.md?raw';
import todoBuilderSkillRaw from '../../docs/skills/assistant-todo-builder/SKILL.md?raw';
import taskBriefSkillRaw from '../../docs/skills/task-brief/SKILL.md?raw';
import managerAgentSkillRaw from '../../docs/skills/manager-agent/SKILL.md?raw';
import workerAgentSkillRaw from '../../docs/skills/worker-agent/SKILL.md?raw';
import cleanerAgentSkillRaw from '../../docs/skills/cleaner-agent/SKILL.md?raw';
import hardenerAgentSkillRaw from '../../docs/skills/hardener-agent/SKILL.md?raw';

const DB_NAME = 'ergo_storage_db';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const ROOT_HANDLE_KEY = 'root_directory_handle';
const ROOT_HANDLE_NAME_KEY = 'ergo_root_folder_name';

/**
 * Ergo's built-in skills (docs/skills), shipped with the app so every user has the current version. A user who edits
 * their copy on disk (<storage root>/config/skills/<name>/SKILL.md) gets their own version instead: the bridge reports
 * whether a disk copy differs from the default it seeded (`edited`).
 */
export const BUILTIN_SKILL_DOCS: Readonly<Record<string, string>> = {
  'human-assistant': humanAssistantSkillRaw,
  'assistant-context-analyzer': contextAnalyzerSkillRaw,
  'assistant-todo-builder': todoBuilderSkillRaw,
  'task-brief': taskBriefSkillRaw,
  'manager-agent': managerAgentSkillRaw,
  'worker-agent': workerAgentSkillRaw,
  'cleaner-agent': cleanerAgentSkillRaw,
  'hardener-agent': hardenerAgentSkillRaw,
};

export const DEFAULT_HUMAN_ASSISTANT_SKILL = humanAssistantSkillRaw;

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
    const initialJobs = {
      version: 1,
      projectId: 'default-workspace',
      updatedAt: new Date().toISOString(),
      tasks: [],
      runningJobs: [],
      queuedTaskIds: [],
      taskExecutionSteps: {}
    };
    await writeFileTextToDir(defaultWorkspaceDir, 'RUNNING_JOBS.json', JSON.stringify(initialJobs, null, 2));
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

  private apiFetch(endpoint: string, init?: RequestInit): Promise<Response> {
    return fetch(bridgeClient.getApiUrl(endpoint), init);
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
      const res = await this.apiFetch('/api/storage/config');
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
      const res = await this.apiFetch('/api/storage/config', {
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
      const res = await this.apiFetch('/api/config/read', {
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
      const res = await this.apiFetch('/api/config/write', {
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
      const res = await this.apiFetch('/api/config/read', {
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

    // Preserve existing mcpSecrets / modelData if not passed
    let payload: AppSecrets = { ...secrets };
    if (!payload.mcpSecrets || payload.modelData === undefined) {
      try {
        const existing = await this.loadSecrets();
        if (!payload.mcpSecrets && existing?.mcpSecrets) {
          payload.mcpSecrets = existing.mcpSecrets;
        }
        if (payload.modelData === undefined && existing?.modelData) {
          payload.modelData = existing.modelData;
        }
      } catch {}
    }

    let saved = false;

    // 1. Filesystem MCP tool write (Browser-Agnostic)
    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'write_file', {
        path: 'config/secrets.json',
        content: JSON.stringify(payload, null, 2)
      });
      if (mcpRes.success) saved = true;
    } catch {}

    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const configDir = await getOrCreateSubdir(this.activeHandle, 'config');
        await writeFileTextToDir(configDir, 'secrets.json', JSON.stringify(payload, null, 2));
        saved = true;
      } catch (err) {
        console.warn('[StorageManager] Error writing secrets to FSA handle:', err);
      }
    }

    // Also write to server API fallback
    try {
      const res = await this.apiFetch('/api/config/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'secrets', data: payload })
      });
      if (res.ok) saved = true;
    } catch {}

    return saved;
  }

  /**
   * Load Auto mode's model calibration table (config/model-calibration.json). Null when there is none yet.
   */
  public async loadModelCalibration(): Promise<unknown | null> {
    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'read_file', { path: 'config/model-calibration.json' });
      if (mcpRes.success && mcpRes.data?.content) return JSON.parse(mcpRes.data.content);
    } catch {}
    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const configDir = await getOrCreateSubdir(this.activeHandle, 'config');
        const text = await readFileTextFromDir(configDir, 'model-calibration.json');
        if (text) return JSON.parse(text);
      } catch {}
    }
    try {
      const res = await this.apiFetch('/api/config/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'model-calibration' })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data) return data.data;
      }
    } catch {}
    return null;
  }

  /**
   * Save Auto mode's model calibration table (config/model-calibration.json, next to the agent skills).
   */
  public async saveModelCalibration(data: unknown): Promise<boolean> {
    const content = JSON.stringify(data, null, 2);
    try {
      const mcpRes = await callMcpTool('mcp-filesystem', 'write_file', { path: 'config/model-calibration.json', content });
      if (mcpRes.success) return true;
    } catch {}
    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const configDir = await getOrCreateSubdir(this.activeHandle, 'config');
        await writeFileTextToDir(configDir, 'model-calibration.json', content);
        return true;
      } catch {}
    }
    try {
      const res = await this.apiFetch('/api/config/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'model-calibration', data })
      });
      if (res.ok) return true;
    } catch {}
    return false;
  }

  /**
   * A skill's text: the user's own copy when they edited it on disk (config/skills/<skillName>/SKILL.md), else Ergo's
   * built-in version. A skill Ergo doesn't ship comes from disk only. Null when there is neither.
   */
  public async loadSkillDoc(skillName = 'human-assistant'): Promise<string | null> {
    const builtin = BUILTIN_SKILL_DOCS[skillName] ?? null;
    try {
      const res = await this.apiFetch('/api/skills/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName })
      });
      if (res.ok) {
        const data = await res.json();
        const content = typeof data.content === 'string' && data.content.trim() ? data.content : null;
        // `edited` comes from the bridge (true only for a copy the user changed); older bridges don't report it.
        if (content && (data.edited === true || !builtin)) return content;
      }
    } catch {}
    return builtin;
  }

  /** Writes the user's own version of a skill to disk (config/skills/<skillName>/SKILL.md). */
  public async saveSkillDoc(skillName: string, content: string): Promise<boolean> {
    try {
      const res = await this.apiFetch('/api/skills/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillName, content })
      });
      return res.ok;
    } catch {
      return false;
    }
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
            const swimLanes: Array<{ id: string; title: string; filePath: string; markdown: string }> = [];

            for await (const [fileName, fileHandle] of (projectDirHandle as any).entries()) {
              if (fileHandle.kind === 'file' && fileName.endsWith('.md')) {
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

            const jobsRaw = (await readFileTextFromDir(projectDirHandle, 'RUNNING_JOBS.json')) || '';
            let runningJobsDoc: any = null;
            if (jobsRaw) {
              try { runningJobsDoc = JSON.parse(jobsRaw); } catch {}
            }

            projectList.push({
              id: name,
              name: name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
              description: `Project directory: projects/${name}`,
              folderPath: `projects/${name}`,
              todoFilePath: `projects/${name}/TODO.md`,
              todoMarkdown: todoMd,
              runningJobsDoc,
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
      const res = await this.apiFetch('/api/projects/list');
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
    let allSaved = true;

    // 1. Filesystem MCP tool write (Browser-Agnostic)
    try {
      for (const file of files) {
        const mcpRes = await callMcpTool('mcp-filesystem', 'write_file', {
          path: file.filePath,
          content: file.content
        });
        if (!mcpRes.success) {
          allSaved = false;
          break;
        }
      }
      if (allSaved && files.length > 0) return { success: true };
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
      const res = await this.apiFetch('/api/files/write', {
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
    todoContent: string
  ): Promise<{ success: boolean; error?: string }> {
    const initialJobs = JSON.stringify({
      version: 1,
      projectId: folderPath.split('/').pop() || 'project',
      updatedAt: new Date().toISOString(),
      tasks: [],
      runningJobs: [],
      queuedTaskIds: [],
      taskExecutionSteps: {}
    }, null, 2);

    // 1. Filesystem MCP tool write (Browser-Agnostic)
    try {
      await callMcpTool('mcp-filesystem', 'create_directory', { path: folderPath });
      await callMcpTool('mcp-filesystem', 'write_file', {
        path: `${folderPath}/TODO.md`,
        content: todoContent
      });
      await callMcpTool('mcp-filesystem', 'write_file', {
        path: `${folderPath}/RUNNING_JOBS.json`,
        content: initialJobs
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
        await writeFileTextToDir(currentDir, 'RUNNING_JOBS.json', initialJobs);
        return { success: true };
      } catch (err: any) {
        console.warn('[StorageManager] Error creating project directory via FSA:', err);
      }
    }

    // Fallback to Server API /api/projects/create
    try {
      const res = await this.apiFetch('/api/projects/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, todoContent })
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
  /**
   * Save a binary media file (e.g. image) to projects/<projectId>/media/<filename>
   * Returns the relative file path on success, or null on failure.
   *
   * NOTE: MCP write_file does NOT support binary encoding - it writes the literal
   * base64 string as text, producing a corrupt file. Use server API or FSA only.
   */
  public async saveMediaFile(projectFolderPath: string, file: File): Promise<string | null> {
    // Generate a unique timestamped filename to avoid collisions
    const ext = file.name.includes('.')
      ? '.' + file.name.split('.').pop()!.toLowerCase()
      : this.mimeToExt(file.type);
    const safeName = `img_${Date.now()}${ext}`;
    const relPath = `${projectFolderPath}/media/${safeName}`;

    // Read file as base64 data URI
    const base64Content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    // 1. Server API first — correctly decodes base64 to binary Buffer before writing
    try {
      const res = await this.apiFetch('/api/files/write-binary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: relPath, base64Content }),
      });
      if (res.ok) return relPath;
    } catch (err: any) {
      console.warn('[StorageManager] Binary server API write failed:', err);
    }

    // 2. FSA (File System Access API) — writes raw binary directly from File object
    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const parts = relPath.split('/').filter(Boolean);
        let currentDir: FileSystemDirectoryHandle = this.activeHandle;
        for (let i = 0; i < parts.length - 1; i++) {
          currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true });
        }
        const filename = parts[parts.length - 1];
        const fileHandle = await currentDir.getFileHandle(filename, { create: true });
        const writable = await (fileHandle as any).createWritable();
        await writable.write(file);
        await writable.close();
        return relPath;
      } catch (err) {
        console.warn('[StorageManager] FSA binary write failed:', err);
      }
    }

    return null;
  }

  /**
   * Delete a file from disk.
   */
  public async deleteFile(relPath: string): Promise<boolean> {
    let deleted = false;
    // Server API
    try {
      const res = await this.apiFetch('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: [relPath] }),
      });
      if (res.ok) deleted = true;
    } catch {}

    // FSA fallback
    if (this.activeHandle && this.folderMetadata.status === 'connected') {
      try {
        const parts = relPath.split('/').filter(Boolean);
        let currentDir: FileSystemDirectoryHandle = this.activeHandle;
        for (let i = 0; i < parts.length - 1; i++) {
          currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false });
        }
        const filename = parts[parts.length - 1];
        await (currentDir as any).removeEntry(filename);
        deleted = true;
      } catch {}
    }
    return deleted;
  }

  /**
   * Delete a single media file from disk.
   */
  public async deleteMediaFile(relPath: string): Promise<void> {
    await this.deleteFile(relPath);
  }

  /**
   * Scan all provided markdown strings for /api/media/ references, list the project
   * media folder, and delete any files that are no longer referenced.
   */
  public async cleanupOrphanedMedia(projectFolderPath: string, markdownContents: string[]): Promise<void> {
    const mediaFolderRelPath = `${projectFolderPath}/media`;

    // Collect all referenced relative media paths from markdown
    const referencedPaths = new Set<string>();
    const mediaRefRegex = /\/api\/media\/(projects\/[^\s)"'\]]+)/g;
    for (const md of markdownContents) {
      let match: RegExpExecArray | null;
      const re = new RegExp(mediaRefRegex.source, 'g');
      while ((match = re.exec(md)) !== null) {
        referencedPaths.add(match[1]);
      }
    }

    // List files currently in the media folder
    let mediaFiles: string[] = [];
    try {
      const res = await this.apiFetch('/api/media/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: mediaFolderRelPath }),
      });
      if (res.ok) {
        const data = await res.json();
        mediaFiles = data.files || [];
      }
    } catch {}

    // Delete orphans
    const orphans = mediaFiles.filter((f) => !referencedPaths.has(f));
    for (const orphan of orphans) {
      await this.deleteMediaFile(orphan);
    }
  }

  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'image/bmp': '.bmp',
      'image/avif': '.avif',
    };
    return map[mime] || '.png';
  }
}

export const storageManager = new StorageManager();
