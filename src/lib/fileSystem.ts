import { storageManager } from './storageManager';

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
 * Read files directly from disk in the workspace directory.
 */
export async function readFilesFromDisk(
  filePaths: string[]
): Promise<Record<string, string | null>> {
  try {
    const res = await fetch('/api/files/read', {
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
 * Create a new project directory with its initial TODO.md and AGENT_CONTEXT.md on disk.
 */
export async function createProjectOnDisk(
  folderPath: string,
  todoContent: string,
  agentContextContent: string
): Promise<CreateProjectDiskResult> {
  try {
    const res = await storageManager.createProjectOnDisk(folderPath, todoContent, agentContextContent);
    if (!res.success) {
      return {
        success: false,
        error: res.error || 'Failed to create project on disk'
      };
    }

    return {
      success: true,
      folderPath,
      todoPath: `${folderPath}/TODO.md`,
      agentPath: `${folderPath}/AGENT_CONTEXT.md`
    };
  } catch (err: any) {
    console.warn('[Ergo FS] Failed to create project on disk:', err);
    return {
      success: false,
      error: err?.message || 'Failed to create project directory'
    };
  }
}

