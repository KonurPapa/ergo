import { storageManager } from './storageManager';
import { bridgeClient } from './bridgeClient';

export interface DiskWriteResult {
  success: boolean;
  savedAt?: string;
  files?: string[];
  error?: string;
}

export interface DiskReadResult {
  success: boolean;
  files?: Record<string, string | null>;
  error?: string;
}

export interface CreateProjectDiskResult {
  success: boolean;
  folderPath?: string;
  todoPath?: string;
  agentPath?: string;
  error?: string;
}

/**
 * Persist files directly to disk in the local workspace directory or selected folder.
 */
export async function writeFilesToDisk(
  files: Array<{ filePath: string; content: string }>
): Promise<DiskWriteResult> {
  try {
    const res = await storageManager.saveProjectFiles(files);
    if (!res.success) {
      return {
        success: false,
        error: res.error || 'Failed to write files to disk'
      };
    }

    return {
      success: true,
      savedAt: new Date().toISOString(),
      files: files.map((f) => f.filePath)
    };
  } catch (err: any) {
    console.warn('[Ergo FS] Failed to write files to disk:', err);
    return {
      success: false,
      error: err?.message || 'Error writing files to disk'
    };
  }
}

/**
 * Writes files while the page unloads (refresh, close tab). The normal save path is a chain of awaited requests that
 * the unload cuts off; a keepalive request is finished by the browser after the page is gone.
 */
export function writeFilesOnUnload(files: Array<{ filePath: string; content: string }>): void {
  if (files.length === 0) return;
  const body = JSON.stringify({ files });
  // Browsers cap keepalive bodies at 64 KB. A bigger save goes out as a plain request, which a local bridge
  // normally still receives before the page is torn down.
  const keepalive = new Blob([body]).size < 60_000;
  try {
    void fetch(bridgeClient.getApiUrl('/api/files/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive,
    }).catch(() => {});
  } catch {
    /* the page is going away; nothing more to do */
  }
}

/**
 * Read files directly from disk in the workspace directory.
 */
export async function readFilesFromDisk(
  filePaths: string[]
): Promise<Record<string, string | null>> {
  try {
    const res = await fetch(bridgeClient.getApiUrl('/api/files/read'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filePaths }),
    });

    if (!res.ok) {
      return {};
    }

    const data = await res.json();
    return data.files || {};
  } catch (err) {
    console.warn('[Ergo FS] Failed to read files from disk:', err);
    return {};
  }
}

/**
 * Create a new project directory with its initial TODO.md on disk.
 */
export async function createProjectOnDisk(
  folderPath: string,
  todoContent: string
): Promise<CreateProjectDiskResult> {
  try {
    const res = await storageManager.createProjectOnDisk(folderPath, todoContent);
    if (!res.success) {
      return {
        success: false,
        error: res.error || 'Failed to create project on disk'
      };
    }

    return {
      success: true,
      folderPath,
      todoPath: `${folderPath}/TODO.md`
    };
  } catch (err: any) {
    console.warn('[Ergo FS] Failed to create project on disk:', err);
    return {
      success: false,
      error: err?.message || 'Failed to create project directory'
    };
  }
}

