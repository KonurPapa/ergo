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

            projectList.push({
              id: name,
              name: name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
              description: `Project directory: projects/${name}`,
              folderPath: `projects/${name}`,
              todoFilePath: `projects/${name}/TODO.md`,
              agentContextFilePath: `projects/${name}/AGENT_CONTEXT.md`,
              todoMarkdown: todoMd,
              agentContextMarkdown: agentMd,
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
