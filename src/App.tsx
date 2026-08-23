import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  type ProjectData,
  type TaskItem,
  type AgentContextItem,
  type MCPServer,
  type AIProviderConfig,
  type UserApiKey,
  type FolderMetadata,
  type CliAgentConfig,
  type TerminalSession,
  type HumanAiAssistantResult,
  type SpawnedSession,
  type ExecutionStep,
  type McpToolPermissionPrompt
} from './types';

import { INITIAL_PROJECTS, createNewProjectData, INITIAL_MCP_SERVERS } from './lib/demoData';
import { parseTodoMarkdown, serializeTodoMarkdown, parseAgentContextMarkdown, parseAgentContextWithArchive, serializeAgentContextMarkdown, syncBriefsWithTasks } from './lib/parser';
import { readFilesFromDisk, createProjectOnDisk } from './lib/fileSystem';
import { storageManager } from './lib/storageManager';
import { useAutosave } from './hooks/useAutosave';
import { SUPPORTED_AI_PROVIDERS } from './lib/aiProviders';
import { Navbar } from './components/Navbar';
import { TaskPane } from './components/TaskPane';
import { BriefPane } from './components/BriefPane';
import { McpHubModal } from './components/McpHubModal';
import { RawMarkdownModal } from './components/RawMarkdownModal';
import { CreateProjectModal } from './components/CreateProjectModal';
import { AiCredentialsModal } from './components/AiCredentialsModal';
import { SettingsModal } from './components/SettingsModal';
import { FolderPickerModal } from './components/FolderPickerModal';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { executeTaskWithAi, syncTaskOverviewWithAi } from './lib/ai';


export function App() {
  // Folder & Local Storage State
  const [folderMetadata, setFolderMetadata] = useState<FolderMetadata>(() => storageManager.getMetadata());
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);

  // Projects State - Purges old legacy dummy data and defaults to clean projects main folder structure
  const [projects, setProjects] = useState<ProjectData[]>(() => {
    const saved = localStorage.getItem('ergo_projects');
    if (saved) {
      try {
        const parsed: ProjectData[] = JSON.parse(saved);
        const cleaned = parsed.filter(
          (p) =>
            p.folderPath &&
            p.id !== 'ergo-takeoff-demo' &&
            p.id !== 'q3-marketing-campaign' &&
            p.id !== 'nextjs-saas-refactor'
        );
        if (cleaned.length > 0) return cleaned;
      } catch {
        // Fallthrough to INITIAL_PROJECTS
      }
    }
    return INITIAL_PROJECTS;
  });

  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    return projects[0]?.id || 'default-workspace';
  });

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) || projects[0],
    [projects, activeProjectId]
  );

  // Parsed Tasks & Briefs State
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskItem[]>([]);
  const [briefs, setBriefs] = useState<AgentContextItem[]>([]);
  const [archivedBriefs, setArchivedBriefs] = useState<AgentContextItem[]>([]);
  const [headerComments, setHeaderComments] = useState<string>('');
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);

  // Autosave Hook (defaults to 5 seconds inactivity timeout, writes directly to workspace files)
  const autosave = useAutosave({
    defaultDelaySec: 5,
  });

  // MCP & AI Settings State
  const [mcpServers, setMcpServers] = useState<MCPServer[]>(INITIAL_MCP_SERVERS);

  // User API Keys State (Loaded from config/secrets.json or fallback)
  const [userApiKeys, setUserApiKeys] = useState<UserApiKey[]>(() => {
    const saved = localStorage.getItem('ergo_user_api_keys');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    // Migration check: check for legacy credentialsMap
    const legacyCreds = localStorage.getItem('ergo_ai_credentials');
    if (legacyCreds) {
      try {
        const parsedMap = JSON.parse(legacyCreds);
        const migrated: UserApiKey[] = [];
        Object.keys(parsedMap).forEach((pid) => {
          if (pid !== 'mock' && parsedMap[pid]?.apiKey) {
            const meta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === pid);
            migrated.push({
              id: `key_${pid}_${Date.now()}`,
              name: `${meta?.shortName || pid} Key`,
              provider: pid as any,
              apiKey: parsedMap[pid].apiKey,
              baseUrl: parsedMap[pid].baseUrl,
              model: parsedMap[pid].model || meta?.defaultModel,
              isConnected: true
            });
          }
        });
        if (migrated.length > 0) return migrated;
      } catch {}
    }
    return [];
  });

  const [activeKeyId, setActiveKeyId] = useState<string | null>(() => {
    const saved = localStorage.getItem('ergo_active_key_id');
    return saved || (userApiKeys[0]?.id ?? null);
  });

  const [editingKey, setEditingKey] = useState<UserApiKey | null>(null);

  // Toast Notifications State
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const handleDismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ─── CLI Agent Terminal State ───────────────────────────────────────────────────────
  // CLI agent config (command + flags), persisted to config/secrets.json
  const [cliAgentConfig, setCliAgentConfig] = useState<CliAgentConfig | null>(null);
  // Live spawned terminal sessions, one per task
  const [terminalSessions, setTerminalSessions] = useState<SpawnedSession[]>([]);
  const [_activeTerminalTaskId, setActiveTerminalTaskId] = useState<number | null>(null);


  // Initialize Storage Layer on mount (IndexedDB handle & config loading)
  useEffect(() => {
    async function initStorage() {
      try {
        const res = await storageManager.init();
        setFolderMetadata(res.metadata);

        if (res.secrets && Array.isArray(res.secrets.userApiKeys) && res.secrets.userApiKeys.length > 0) {
          setUserApiKeys(res.secrets.userApiKeys);
        }
        if (res.secrets?.cliAgent) {
          setCliAgentConfig(res.secrets.cliAgent);
        }


        if (res.projects && res.projects.length > 0) {
          setProjects(res.projects);
        }

        if (res.settings) {
          if (res.settings.activeProjectId) {
            setActiveProjectId(res.settings.activeProjectId);
          }
          if (res.settings.activeKeyId) {
            setActiveKeyId(res.settings.activeKeyId);
          }
          if (typeof res.settings.autosaveDelaySec === 'number') {
            autosave.setDelaySec(res.settings.autosaveDelaySec);
          }
          if (typeof res.settings.autosaveEnabled === 'boolean') {
            autosave.setIsEnabled(res.settings.autosaveEnabled);
          }
        }
      } catch (err) {
        console.warn('[App] Error initializing storage layer:', err);
      }
    }
    initStorage();
  }, []);

  // Sync settings (config/settings.json)
  useEffect(() => {
    if (activeProjectId) {
      storageManager.saveSettings({
        version: 1,
        activeProjectId,
        activeKeyId,
        autosaveDelaySec: autosave.delaySec,
        autosaveEnabled: autosave.isEnabled,
        lastOpenedAt: new Date().toISOString()
      });
    }
  }, [activeProjectId, activeKeyId, autosave.delaySec, autosave.isEnabled]);

  // Sync secrets (config/secrets.json)
  useEffect(() => {
    storageManager.saveSecrets({
      version: 1,
      updatedAt: new Date().toISOString(),
      userApiKeys,
      cliAgent: cliAgentConfig ?? undefined,
    });
  }, [userApiKeys, cliAgentConfig]);


  // Active AI Provider Config
  const [aiConfig, setAiConfig] = useState<AIProviderConfig>(() => {
    const activeKey = userApiKeys.find((k) => k.id === activeKeyId);
    if (activeKey) {
      const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === activeKey.provider);
      return {
        provider: activeKey.provider,
        model: activeKey.generalModel || activeKey.model || pMeta?.defaultGeneralModel || 'gpt-4o',
        discoveryModel: activeKey.discoveryModel || pMeta?.defaultDiscoveryModel || 'gpt-4o-mini',
        generalModel: activeKey.generalModel || activeKey.model || pMeta?.defaultGeneralModel || 'gpt-4o',
        apiKey: activeKey.apiKey,
        baseUrl: activeKey.baseUrl,
        isConnected: true
      };
    }
    return {
      provider: 'none',
      model: '',
      isConnected: false
    };
  });

  // Sync activeKeyId & userApiKeys to aiConfig
  useEffect(() => {
    const activeKey = userApiKeys.find((k) => k.id === activeKeyId);
    if (activeKey) {
      const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === activeKey.provider);
      setAiConfig({
        provider: activeKey.provider,
        model: activeKey.generalModel || activeKey.model || pMeta?.defaultGeneralModel || pMeta?.defaultModel || 'gpt-4o',
        discoveryModel: activeKey.discoveryModel || pMeta?.defaultDiscoveryModel || 'gpt-4o-mini',
        generalModel: activeKey.generalModel || activeKey.model || pMeta?.defaultGeneralModel || pMeta?.defaultModel || 'gpt-4o',
        apiKey: activeKey.apiKey,
        baseUrl: activeKey.baseUrl,
        isConnected: true
      });
    } else {
      setAiConfig({
        provider: 'none',
        model: '',
        isConnected: false
      });
    }
  }, [activeKeyId, userApiKeys]);

  // Persist keys to localStorage
  useEffect(() => {
    localStorage.setItem('ergo_user_api_keys', JSON.stringify(userApiKeys));
  }, [userApiKeys]);

  useEffect(() => {
    if (activeKeyId) {
      localStorage.setItem('ergo_active_key_id', activeKeyId);
    } else {
      localStorage.removeItem('ergo_active_key_id');
    }
  }, [activeKeyId]);

  // Modal Open States
  const [isDraftModalOpen, setIsDraftModalOpen] = useState(false);
  const [isMcpHubOpen, setIsMcpHubOpen] = useState(false);
  const [isRawMarkdownOpen, setIsRawMarkdownOpen] = useState(false);
  const [isCreateProjectModalOpen, setIsCreateProjectModalOpen] = useState(false);
  const [isAiScreenOpen, setIsAiScreenOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [executingTaskId, setExecutingTaskId] = useState<number | null>(null);
  const [taskExecutionSteps, setTaskExecutionSteps] = useState<Record<number, ExecutionStep[]>>({});
  const [pendingPermissions, setPendingPermissions] = useState<Record<number, { prompt: McpToolPermissionPrompt; resolve: (approved: boolean) => void }>>({});


  // Folder management handlers
  const handleUpdateStorageDirectory = useCallback(async (newPath: string) => {
    const res = await storageManager.setStorageDirectory(newPath);
    if (res.success) {
      const refreshed = await storageManager.init();
      setFolderMetadata(refreshed.metadata);
      if (refreshed.projects && refreshed.projects.length > 0) {
        setProjects(refreshed.projects);
        setActiveProjectId(refreshed.projects[0].id);
      }
      if (refreshed.secrets && Array.isArray(refreshed.secrets.userApiKeys)) {
        setUserApiKeys(refreshed.secrets.userApiKeys);
      }
      if (refreshed.settings) {
        if (refreshed.settings.activeProjectId) setActiveProjectId(refreshed.settings.activeProjectId);
        if (refreshed.settings.activeKeyId) setActiveKeyId(refreshed.settings.activeKeyId);
      }
    }
  }, []);

  const handleSelectRootFolder = useCallback(async () => {
    const res = await storageManager.pickRootDirectory();
    if (res.success) {
      setFolderMetadata(res.metadata);
      if (res.projects && res.projects.length > 0) {
        setProjects(res.projects);
        setActiveProjectId(res.projects[0].id);
      }
      if (res.secrets && Array.isArray(res.secrets.userApiKeys)) {
        setUserApiKeys(res.secrets.userApiKeys);
      }
      if (res.settings) {
        if (res.settings.activeProjectId) setActiveProjectId(res.settings.activeProjectId);
        if (res.settings.activeKeyId) setActiveKeyId(res.settings.activeKeyId);
      }
    } else if (res.error && res.error !== 'Directory selection was cancelled.') {
      throw new Error(res.error);
    }
  }, []);

  const handleRequestHandlePermission = useCallback(async () => {
    const granted = await storageManager.requestHandlePermission();
    if (granted) {
      setFolderMetadata(storageManager.getMetadata());
      const projects = await storageManager.scanProjects();
      if (projects.length > 0) {
        setProjects(projects);
      }
      const secrets = await storageManager.loadSecrets();
      if (secrets?.userApiKeys) {
        setUserApiKeys(secrets.userApiKeys);
      }
    }
  }, []);

  const handleRescanProjects = useCallback(async () => {
    const scanned = await storageManager.scanProjects();
    if (scanned.length > 0) {
      setProjects(scanned);
    }
  }, []);

  const handleUseServerFallback = useCallback(() => {
    storageManager.disconnectRootDirectory();
    setFolderMetadata(storageManager.getMetadata());
  }, []);

  // Handlers for API Keys
  const handleSaveUserKey = (keyData: Omit<UserApiKey, 'id'> & { id?: string }) => {
    let savedId = keyData.id;
    if (savedId) {
      // Edit existing key
      setUserApiKeys((prev) =>
        prev.map((k) => (k.id === savedId ? { ...k, ...keyData, id: savedId! } : k))
      );
    } else {
      // Add new key
      savedId = `key_${Date.now()}`;
      const newKey: UserApiKey = {
        ...keyData,
        id: savedId,
        createdAt: new Date().toISOString()
      };
      setUserApiKeys((prev) => [...prev, newKey]);
    }
    setActiveKeyId(savedId);
    setEditingKey(null);
  };

  const handleDeleteUserKey = (id: string) => {
    setUserApiKeys((prev) => prev.filter((k) => k.id !== id));
    if (activeKeyId === id) {
      const remaining = userApiKeys.filter((k) => k.id !== id);
      setActiveKeyId(remaining[0]?.id || null);
    }
  };

  const handleSelectUserKey = (keyId: string | null) => {
    setActiveKeyId(keyId);
  };

  const handleOpenAiScreen = () => {
    setEditingKey(null);
    setIsAiScreenOpen(true);
  };

  // Resizable Split Pane State
  const [splitWidth, setSplitWidth] = useState<number>(50); // percentage
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !workspaceRef.current) return;
      const rect = workspaceRef.current.getBoundingClientRect();
      const relativeX = e.clientX - rect.left;
      const newPercent = (relativeX / rect.width) * 100;
      // Clamp between 20% and 80%
      const clamped = Math.min(Math.max(newPercent, 20), 80);
      setSplitWidth(clamped);
    };

    const handleMouseUp = () => {
      if (isDragging) {
        setIsDragging(false);
      }
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Load active project markdown from disk or local state into structured state
  useEffect(() => {
    let isMounted = true;

    async function loadActiveProjectContent() {
      if (!activeProject) return;

      const todoPath = activeProject.todoFilePath || `${activeProject.folderPath}/TODO.md`;
      const agentPath = activeProject.agentContextFilePath || `${activeProject.folderPath}/AGENT_CONTEXT.md`;

      // Try reading latest live files directly from disk
      const diskFiles = await readFilesFromDisk([todoPath, agentPath]);
      if (!isMounted) return;

      let effectiveTodoMd = activeProject.todoMarkdown;
      let effectiveAgentMd = activeProject.agentContextMarkdown;

      if (diskFiles[todoPath] !== null && diskFiles[todoPath] !== undefined) {
        effectiveTodoMd = diskFiles[todoPath]!;
      }
      if (diskFiles[agentPath] !== null && diskFiles[agentPath] !== undefined) {
        effectiveAgentMd = diskFiles[agentPath]!;
      }

      const parsedTodo = parseTodoMarkdown(effectiveTodoMd);
      const parsedBriefsWithArchive = parseAgentContextWithArchive(effectiveAgentMd);
      const alignedBriefs = syncBriefsWithTasks(parsedBriefsWithArchive.items, parsedTodo.items);

      setTasks(parsedTodo.items);
      setArchivedTasks(parsedTodo.archivedItems);
      setHeaderComments(parsedTodo.headerComments);
      setBriefs(alignedBriefs);
      setArchivedBriefs(parsedBriefsWithArchive.archivedItems);

      if (parsedTodo.items.length > 0) {
        setSelectedTaskId((prev) => (prev !== null && parsedTodo.items.some((t) => t.id === prev) ? prev : parsedTodo.items[0].id));
      } else {
        setSelectedTaskId(null);
      }

      // Update project state if disk files had more recent changes
      if (
        effectiveTodoMd !== activeProject.todoMarkdown ||
        effectiveAgentMd !== activeProject.agentContextMarkdown
      ) {
        setProjects((prev) =>
          prev.map((p) =>
            p.id === activeProjectId
              ? { ...p, todoMarkdown: effectiveTodoMd, agentContextMarkdown: effectiveAgentMd }
              : p
          )
        );
      }
    }

    loadActiveProjectContent();

    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Real-time disk file watcher subscription (SSE): updates UI instantly when markdown files change externally
  // Uses refs to read current state inside the handler without recreating the EventSource on every render.
  const activeProjectRef = useRef(activeProject);
  const tasksRef = useRef(tasks);
  useEffect(() => { activeProjectRef.current = activeProject; }, [activeProject]);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  useEffect(() => {
    let eventSource: EventSource | null = null;

    try {
      eventSource = new EventSource('/api/files/events');

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data || data.type === 'connected') return;

          const { projectId, fileType, content, relativePath } = data;
          if (!fileType || typeof content !== 'string') return;

          // Update projects state array for the changed project
          setProjects((prevProjects) =>
            prevProjects.map((p) => {
              const isMatch =
                p.id === projectId ||
                p.folderPath === `projects/${projectId}` ||
                p.todoFilePath === relativePath ||
                p.agentContextFilePath === relativePath;

              if (!isMatch) return p;

              if (fileType === 'todo') {
                return { ...p, todoMarkdown: content };
              } else if (fileType === 'agent') {
                return { ...p, agentContextMarkdown: content };
              }
              return p;
            })
          );

          // Use refs to avoid stale closure — reads current activeProject and tasks without triggering reconnect
          const ap = activeProjectRef.current;
          const isActiveProject =
            ap &&
            (ap.id === projectId ||
              ap.folderPath === `projects/${projectId}` ||
              ap.todoFilePath === relativePath ||
              ap.agentContextFilePath === relativePath);

          if (isActiveProject) {
            if (fileType === 'todo') {
              const parsedTodo = parseTodoMarkdown(content);
              setTasks(parsedTodo.items);
              setHeaderComments(parsedTodo.headerComments);
              setBriefs((prevBriefs) => syncBriefsWithTasks(prevBriefs, parsedTodo.items));
            } else if (fileType === 'agent') {
              const parsedBriefs = parseAgentContextMarkdown(content);
              // Use ref to read current tasks at the moment of event, not at effect creation time
              setBriefs(() => syncBriefsWithTasks(parsedBriefs, tasksRef.current));
            }
          }
        } catch (err) {
          console.warn('[App SSE] Error handling file change event:', err);
        }
      };

      eventSource.onerror = () => {
        // EventSource will automatically retry connecting
      };
    } catch (err) {
      console.warn('[App SSE] Failed to initialize SSE EventSource:', err);
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  // Empty dep array: EventSource is created once and stays alive for the component lifetime.
  // State is read via refs inside the handler, so no reconnects on task/project changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save projects to localStorage on change
  useEffect(() => {
    localStorage.setItem('ergo_projects', JSON.stringify(projects));
  }, [projects]);

  // Helper to persist updated tasks & briefs back into active project's raw markdown and disk
  const syncAndSaveProject = (
    newTasks: TaskItem[],
    newBriefs: AgentContextItem[],
    immediateDiskSave = true,
    currentArchivedTasks = archivedTasks,
    currentArchivedBriefs = archivedBriefs
  ) => {
    setTasks(newTasks);
    setBriefs(newBriefs);
    setArchivedTasks(currentArchivedTasks);
    setArchivedBriefs(currentArchivedBriefs);

    const updatedTodoMd = serializeTodoMarkdown(newTasks, headerComments, currentArchivedTasks);
    const updatedBriefsMd = serializeAgentContextMarkdown(newBriefs, currentArchivedBriefs);

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? { ...p, todoMarkdown: updatedTodoMd, agentContextMarkdown: updatedBriefsMd }
          : p
      )
    );

    const todoPath = activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`;
    const agentPath = activeProject?.agentContextFilePath || `${activeProject?.folderPath}/AGENT_CONTEXT.md`;
    const filesToSave = [
      { filePath: todoPath, content: updatedTodoMd },
      { filePath: agentPath, content: updatedBriefsMd }
    ];

    if (immediateDiskSave) {
      autosave.saveImmediately(filesToSave);
    } else {
      autosave.queueSave(filesToSave);
    }
  };

  // AI Assistant Undo Snapshot State (Supports Ctrl+Z for Human AI Assistant modifications)
  const [aiUndoSnapshot, setAiUndoSnapshot] = useState<{
    tasks: TaskItem[];
    briefs: AgentContextItem[];
  } | null>(null);

  const handleUndoAiChanges = useCallback(() => {
    if (!aiUndoSnapshot) return;
    const { tasks: restoredTasks, briefs: restoredBriefs } = aiUndoSnapshot;
    syncAndSaveProject(restoredTasks, restoredBriefs, true);
    setAiUndoSnapshot(null);
    showToast({
      type: 'info',
      title: 'AI Changes Undone',
      message: 'Reverted previous AI assistant changes to TODO.md and AGENT_CONTEXT.md.'
    });
  }, [aiUndoSnapshot, showToast]);

  // Global key listener for Ctrl+Z AI Undo when outside text inputs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        const activeEl = document.activeElement;
        const isInput =
          activeEl instanceof HTMLInputElement ||
          activeEl instanceof HTMLTextAreaElement ||
          (activeEl && activeEl.getAttribute('contenteditable') === 'true');

        if (!isInput && aiUndoSnapshot) {
          e.preventDefault();
          handleUndoAiChanges();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [aiUndoSnapshot, handleUndoAiChanges]);

  // Apply result from Human AI Workspace Assistant (create, refine, aggregate, organize, delete with permission)
  const handleApplyAssistantResult = (
    result: HumanAiAssistantResult,
    _confirmedDeletions: boolean
  ) => {
    // 1. Snapshot state for instant Ctrl+Z undo
    setAiUndoSnapshot({ tasks: [...tasks], briefs: [...briefs] });

    let nextTasks = [...tasks];
    let nextBriefs = [...briefs];

    // If the assistant returned new markdown, we parse and apply it directly
    if (result.todoMarkdown) {
      const parsedTodo = parseTodoMarkdown(result.todoMarkdown);
      nextTasks = parsedTodo.items;
      if (parsedTodo.headerComments) {
        setHeaderComments(parsedTodo.headerComments);
      }
    }
    
    if (result.agentContextMarkdown) {
      nextBriefs = parseAgentContextMarkdown(result.agentContextMarkdown);
    }

    // 2. Renumber and maintain counterpart parity in AGENT_CONTEXT.md
    nextBriefs = syncBriefsWithTasks(nextBriefs, nextTasks);

    // 3. Persist to state and disk immediately
    syncAndSaveProject(nextTasks, nextBriefs, true);

    // 4. Show feedback toast with Undo button
    showToast({
      type: 'success',
      title: 'AI Changes Applied',
      message: result.summary || 'Workspace tasks and context updated successfully.',
      actionLabel: 'Undo (Ctrl+Z)',
      duration: 8000,
      onAction: () => {
        handleUndoAiChanges();
      }
    });
  };

  // Trigger In-Place Task Execution
  // If a CLI agent is configured, spawn a terminal session inside the Build & Verification card.
  // Otherwise, run executeTaskWithAi in place and stream logs directly into Build & Verification and Completion.
  const handleExecuteTask = async (task: TaskItem) => {
    setSelectedTaskId(task.id);

    // If using in-place AI execution (no CLI agent configured), verify active API key
    if (!cliAgentConfig?.command) {
      const activeKey = userApiKeys.find((k) => k.id === activeKeyId);
      const hasValidKey = !!(activeKey && activeKey.apiKey && activeKey.apiKey.trim().length > 0);

      if (!hasValidKey) {
        showToast({
          type: 'warning',
          title: 'AI API Key Required',
          message: 'No active AI API key selected. Please select or add an API key to execute tasks with AI.',
          actionLabel: 'Set Up Key',
          onAction: () => setIsAiScreenOpen(true),
          duration: 6000,
        });
        return;
      }
    }

    if (cliAgentConfig?.command) {
      // Resolve working directory: use the project folder path or home
      const cwd = activeProject?.folderPath
        ? (storageManager as any).resolvedStoragePath
          ? `${(storageManager as any).resolvedStoragePath}/${activeProject.folderPath}`
          : activeProject.folderPath
        : '~';

      const args = cliAgentConfig.extraArgs
        ? cliAgentConfig.extraArgs.split(/\s+/).filter(Boolean)
        : [];

      // Create or reuse a session for this task
      const session: TerminalSession = {
        taskId: task.id,
        taskTitle: task.title,
        isActive: true,
        spawnedAt: new Date().toISOString(),
      };

      const spawned: SpawnedSession = {
        session,
        cwd,
        cmd: cliAgentConfig.command,
        args,
      };

      setTerminalSessions((prev) => {
        // Replace any existing session for this task
        const filtered = prev.filter((s) => s.session.taskId !== task.id);
        return [...filtered, spawned];
      });

      setActiveTerminalTaskId(task.id);

      // Update task status to in_progress if not already done
      if (!task.isDone && task.status !== 'done') {
        const nextTasks = tasks.map((t) => (t.id === task.id ? { ...t, status: 'in_progress' as const } : t));
        syncAndSaveProject(nextTasks, briefs, true);
      }
    } else {
      // In-Place AI Task Execution
      setExecutingTaskId(task.id);
      setTaskExecutionSteps((prev) => ({ ...prev, [task.id]: [] }));

      const currentTask = tasks.find((t) => t.id === task.id) || task;
      const currentBrief = briefs.find((b) => b.itemNumber === task.id);

      // Set task status to in_progress
      const inProgressTasks = tasks.map((t) => (t.id === task.id ? { ...t, status: 'in_progress' as const } : t));
      setTasks(inProgressTasks);

      try {
        const res = await executeTaskWithAi(
          currentTask,
          currentBrief,
          activeProject,
          aiConfig,
          mcpServers,
          (stepUpdate) => {
            setTaskExecutionSteps((prev) => {
              const existing = prev[task.id] || [];
              const idx = existing.findIndex((s) => s.id === stepUpdate.id);
              let next: ExecutionStep[];
              if (idx !== -1) {
                next = [...existing];
                next[idx] = stepUpdate;
              } else {
                next = [...existing, stepUpdate];
              }
              return { ...prev, [task.id]: next };
            });
          },
          (permissionPrompt) => {
            return new Promise<boolean>((resolve) => {
              setPendingPermissions((prev) => ({
                ...prev,
                [task.id]: { prompt: permissionPrompt, resolve },
              }));
            });
          }
        );

        // Completed execution: apply results & persist to TODO.md and AGENT_CONTEXT.md
        const nextTasks = tasks.map((t) => (t.id === res.updatedTask.id ? res.updatedTask : t));
        const existingBriefIdx = briefs.findIndex((b) => b.itemNumber === res.updatedBrief.itemNumber);
        let nextBriefs: AgentContextItem[];
        if (existingBriefIdx !== -1) {
          nextBriefs = briefs.map((b) => (b.itemNumber === res.updatedBrief.itemNumber ? res.updatedBrief : b));
        } else {
          nextBriefs = [...briefs, res.updatedBrief];
        }
        syncAndSaveProject(nextTasks, nextBriefs, true);
      } catch (err) {
        console.error('Task execution error:', err);
      } finally {
        setExecutingTaskId((cur) => (cur === task.id ? null : cur));
      }
    }
  };

  const handlePermissionChoice = (taskId: number, approved: boolean) => {
    const pending = pendingPermissions[taskId];
    if (pending) {
      pending.resolve(approved);
      setPendingPermissions((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    }
  };

  const handleSessionExit = (taskId: number, code: number) => {
    setTerminalSessions((prev) =>
      prev.map((s) =>
        s.session.taskId === taskId
          ? { ...s, session: { ...s.session, isActive: false, exitCode: code } }
          : s
      )
    );

    // If CLI process completed successfully (exit code 0), mark task as done and update brief
    if (code === 0) {
      setSelectedTaskId(taskId);
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        const updatedTask: TaskItem = {
          ...task,
          status: 'done',
          isDone: true,
          subtasks: task.subtasks.map((s) => ({ ...s, isDone: true })),
        };
        const nextTasks = tasks.map((t) => (t.id === taskId ? updatedTask : t));

        const buildDate = new Date().toISOString().split('T')[0];
        const existingBrief = briefs.find((b) => b.itemNumber === taskId);
        const fallbackCompletion = `**Completion Summary (${buildDate}):**\n- CLI Agent completed task execution successfully (exit code 0).\n- Status: Done / Verified.`;
        const completionText: string = (existingBrief?.completion || existingBrief?.validation) || fallbackCompletion;

        const updatedBrief: AgentContextItem = existingBrief
          ? {
              ...existingBrief,
              overview: existingBrief.overview || '',
              buildAndVerification: existingBrief.buildAndVerification || '',
              status: 'done',
              completion: completionText,
              validation: completionText,
            }
          : {
              itemNumber: taskId,
              title: task.title,
              status: 'done',
              overview: `Task #${taskId} (${task.title})`,
              buildAndVerification: `Executed in CLI agent terminal.`,
              completion: completionText,
            };

        const existingIdx = briefs.findIndex((b) => b.itemNumber === taskId);
        let nextBriefs: AgentContextItem[];
        if (existingIdx !== -1) {
          nextBriefs = briefs.map((b) => (b.itemNumber === taskId ? updatedBrief : b));
        } else {
          nextBriefs = [...briefs, updatedBrief];
        }

        syncAndSaveProject(nextTasks, nextBriefs, true);
      }
    }
  };

  const handleKillSession = (taskId: number) => {
    setTerminalSessions((prev) =>
      prev.map((s) =>
        s.session.taskId === taskId
          ? { ...s, session: { ...s.session, isActive: false, exitCode: -1 } }
          : s
      )
    );
  };

  // Immediate Save Brief Edits
  const handleSaveBrief = (updatedBrief: AgentContextItem) => {
    const existingIdx = briefs.findIndex((b) => b.itemNumber === updatedBrief.itemNumber);
    let nextBriefs: AgentContextItem[];
    if (existingIdx !== -1) {
      nextBriefs = briefs.map((b) => (b.itemNumber === updatedBrief.itemNumber ? updatedBrief : b));
    } else {
      nextBriefs = [...briefs, updatedBrief];
    }
    syncAndSaveProject(tasks, nextBriefs, true);
  };

  // Live Typing Handler from BriefPane (Triggers Debounced Autosave to disk)
  // Archive Task Handler (Moves task and corresponding brief into archive section immediately)
  // Takes the live title string read from the editor node, matching by title is immune to stale indices.
  const handleArchiveTask = (taskTitle: string) => {
    if (!taskTitle) return;
    const normalTitle = taskTitle.trim().toLowerCase();
    const taskToArchive = tasks.find((t) => t.title.trim().toLowerCase() === normalTitle);
    if (!taskToArchive) return;

    const taskIndex = tasks.findIndex((t) => t.title.trim().toLowerCase() === normalTitle);
    const nextActiveTasks = tasks.filter((t) => t.title.trim().toLowerCase() !== normalTitle);

    // Assign a unique ID in the 1000+ range for the archived task
    const nextArchiveId = archivedTasks.length > 0 ? Math.max(...archivedTasks.map((t) => t.id), 1000) + 1 : 1001;
    const archivedTask: TaskItem = {
      ...taskToArchive,
      id: nextArchiveId,
      isArchived: true,
      archivedAtIndex: taskIndex,         // remember original 0-based position
      category: 'Archive',
      categoryHeadingPrefix: '##',
    };
    const nextArchivedTasks = [
      ...archivedTasks.filter((t) => t.title.trim().toLowerCase() !== normalTitle),
      archivedTask,
    ];

    // Move corresponding brief to archivedBriefs
    const matchingBrief = briefs.find(
      (b) => b.title.trim().toLowerCase() === normalTitle || b.itemNumber === taskToArchive.id
    );
    const nextActiveBriefsRaw = briefs.filter(
      (b) => b.title.trim().toLowerCase() !== normalTitle && b.itemNumber !== taskToArchive.id
    );
    const nextActiveBriefs = syncBriefsWithTasks(nextActiveBriefsRaw, nextActiveTasks);

    const nextArchivedBriefs = matchingBrief
      ? [
          ...archivedBriefs.filter((b) => b.title.trim().toLowerCase() !== normalTitle),
          { ...matchingBrief, isArchived: true, itemNumber: nextArchiveId },
        ]
      : archivedBriefs;

    if (selectedTaskId === taskToArchive.id) {
      setSelectedTaskId(nextActiveTasks.length > 0 ? nextActiveTasks[0].id : null);
    }

    syncAndSaveProject(nextActiveTasks, nextActiveBriefs, true, nextArchivedTasks, nextArchivedBriefs);
  };

  // Unarchive Task Handler (Restores task from archive back to active workspace at its original position)
  const handleUnarchiveTask = (taskId: number) => {
    const taskToUnarchive = archivedTasks.find((t) => t.id === taskId);
    if (!taskToUnarchive) return;

    const normalTitle = taskToUnarchive.title.trim().toLowerCase();
    const nextArchivedTasks = archivedTasks.filter((t) => t.id !== taskToUnarchive.id);

    // Restore the task's category to match the surrounding active tasks so it
    // doesn't create a stray "## Archive" section inside the active list.
    const referenceTask = tasks.length > 0 ? tasks[0] : null;
    const restoredTask: TaskItem = {
      ...taskToUnarchive,
      id: tasks.length + 1,     // temporary; syncBriefsWithTasks will align
      category: referenceTask?.category || 'Untitled',
      categoryHeadingPrefix: referenceTask?.categoryHeadingPrefix || '##',
      categoryHasColon: referenceTask?.categoryHasColon || false,
      isArchived: false,
      archivedAtIndex: undefined,
    };

    // Splice back at the original position if we have it, otherwise append
    let nextActiveTasks: TaskItem[];
    const originalIndex = taskToUnarchive.archivedAtIndex;
    if (originalIndex !== undefined && originalIndex >= 0 && originalIndex <= tasks.length) {
      nextActiveTasks = [...tasks.slice(0, originalIndex), restoredTask, ...tasks.slice(originalIndex)];
    } else {
      nextActiveTasks = [...tasks, restoredTask];
    }
    // Re-number IDs to be sequential after splice
    nextActiveTasks = nextActiveTasks.map((t, i) => ({ ...t, id: i + 1 }));

    const matchingArchivedBrief = archivedBriefs.find(
      (b) => b.title.trim().toLowerCase() === normalTitle
    );
    const nextArchivedBriefs = archivedBriefs.filter(
      (b) => b.title.trim().toLowerCase() !== normalTitle
    );

    // Find what the restored task's new ID is after re-numbering
    const restoredId = nextActiveTasks.find((t) => t.title.trim().toLowerCase() === normalTitle)?.id
      ?? nextActiveTasks[nextActiveTasks.length - 1].id;

    const nextActiveBriefsRaw = matchingArchivedBrief
      ? [...briefs, { ...matchingArchivedBrief, isArchived: false, itemNumber: restoredId }]
      : briefs;
    const nextActiveBriefs = syncBriefsWithTasks(nextActiveBriefsRaw, nextActiveTasks);

    setSelectedTaskId(restoredId);
    syncAndSaveProject(nextActiveTasks, nextActiveBriefs, true, nextArchivedTasks, nextArchivedBriefs);
  };

  // Permanent Delete Archived Task Handler
  const handleDeleteArchivedTask = (taskId: number) => {
    const taskToDelete = archivedTasks.find((t) => t.id === taskId);
    if (!taskToDelete) return;

    const normalTitle = taskToDelete.title.trim().toLowerCase();
    const nextArchivedTasks = archivedTasks.filter((t) => t.id !== taskToDelete.id);
    const nextArchivedBriefs = archivedBriefs.filter(
      (b) => b.title.trim().toLowerCase() !== normalTitle
    );

    syncAndSaveProject(tasks, briefs, true, nextArchivedTasks, nextArchivedBriefs);
  };

  // Save Archived Brief Edit
  const handleSaveArchivedBrief = (updatedBrief: AgentContextItem) => {
    const nextArchivedBriefs = archivedBriefs.map((b) =>
      b.title.trim().toLowerCase() === updatedBrief.title.trim().toLowerCase() ? updatedBrief : b
    );
    syncAndSaveProject(tasks, briefs, true, archivedTasks, nextArchivedBriefs);
  };

  // Live Typing Handler from BriefPane (Triggers Debounced Autosave to disk)
  const handleLiveBriefChange = (updatedBrief: AgentContextItem) => {
    const existingIdx = briefs.findIndex((b) => b.itemNumber === updatedBrief.itemNumber);
    let nextBriefs: AgentContextItem[];
    if (existingIdx !== -1) {
      nextBriefs = briefs.map((b) => (b.itemNumber === updatedBrief.itemNumber ? updatedBrief : b));
    } else {
      nextBriefs = [...briefs, updatedBrief];
    }
    setBriefs(nextBriefs);

    const currentTodoMd = serializeTodoMarkdown(tasks, headerComments, archivedTasks);
    const updatedBriefsMd = serializeAgentContextMarkdown(nextBriefs, archivedBriefs);

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? { ...p, todoMarkdown: currentTodoMd, agentContextMarkdown: updatedBriefsMd }
          : p
      )
    );

    const todoPath = activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`;
    const agentPath = activeProject?.agentContextFilePath || `${activeProject?.folderPath}/AGENT_CONTEXT.md`;

    autosave.queueSave([
      { filePath: todoPath, content: currentTodoMd },
      { filePath: agentPath, content: updatedBriefsMd }
    ]);
  };

  // Refine Brief with AI (AI Step 3 Context Syncer & Overview Drafter)
  const handleSyncOverviewWithTask = async (task: TaskItem): Promise<string> => {
    const existingBrief =
      briefs.find((b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase()) ||
      briefs.find((b) => b.itemNumber === task.id);
    const existingOverview = existingBrief?.overview || existingBrief?.brief || '';

    const syncedOverview = await syncTaskOverviewWithAi(
      task,
      existingOverview,
      activeProject,
      aiConfig,
      mcpServers,
      serializeTodoMarkdown(tasks, headerComments, archivedTasks),
      serializeAgentContextMarkdown(briefs, archivedBriefs)
    );

    const updatedBrief: AgentContextItem = {
      itemNumber: task.id,
      title: task.title,
      status: task.status,
      overview: syncedOverview,
      buildAndVerification: existingBrief?.buildAndVerification || existingBrief?.built || '',
      completion: existingBrief?.completion || existingBrief?.validation || existingBrief?.humanReview || existingBrief?.followUps || '',
      brief: syncedOverview,
      built: existingBrief?.built || '',
      validation: existingBrief?.validation || '',
      humanReview: existingBrief?.humanReview || '',
      followUps: existingBrief?.followUps || ''
    };
    handleSaveBrief(updatedBrief);
    return syncedOverview;
  };

  const handleUpdateBriefWithAi = (task: TaskItem) => {
    handleSyncOverviewWithTask(task);
  };

  // Live edit handler from Obsidian-style TaskPane editor (Triggers Debounced Autosave to disk)
  const handleRawTodoEdit = (newBodyMd: string) => {
    const fullTodoMd = headerComments && headerComments.trim() ? `${headerComments.trim()}\n\n${newBodyMd}` : newBodyMd;
    const parsedTodo = parseTodoMarkdown(fullTodoMd);
    setTasks(parsedTodo.items);
    if (parsedTodo.headerComments) {
      setHeaderComments(parsedTodo.headerComments);
    }

    // Sync and renumber briefs matching the updated tasks
    const updatedBriefs = syncBriefsWithTasks(briefs, parsedTodo.items);
    setBriefs(updatedBriefs);
    const combinedTodoMd = serializeTodoMarkdown(parsedTodo.items, parsedTodo.headerComments || headerComments, archivedTasks);
    const updatedBriefsMd = serializeAgentContextMarkdown(updatedBriefs, archivedBriefs);

    // Sync the raw markdown and updated briefs into the project record
    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? { ...p, todoMarkdown: combinedTodoMd, agentContextMarkdown: updatedBriefsMd }
          : p
      )
    );

    const todoPath = activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`;
    const agentPath = activeProject?.agentContextFilePath || `${activeProject?.folderPath}/AGENT_CONTEXT.md`;

    autosave.queueSave([
      { filePath: todoPath, content: combinedTodoMd },
      { filePath: agentPath, content: updatedBriefsMd }
    ]);
  };

  // Save Raw Markdown Editing (from Raw Markdown modal - Flushes immediately)
  const handleSaveRawMarkdown = (newTodoMd: string, newAgentContextMd: string) => {
    const parsedTodo = parseTodoMarkdown(newTodoMd);
    const parsedBriefsWithArchive = parseAgentContextWithArchive(newAgentContextMd);

    setTasks(parsedTodo.items);
    setArchivedTasks(parsedTodo.archivedItems);
    setHeaderComments(parsedTodo.headerComments);
    setBriefs(parsedBriefsWithArchive.items);
    setArchivedBriefs(parsedBriefsWithArchive.archivedItems);

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? { ...p, todoMarkdown: newTodoMd, agentContextMarkdown: newAgentContextMd }
          : p
      )
    );

    const todoPath = activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`;
    const agentPath = activeProject?.agentContextFilePath || `${activeProject?.folderPath}/AGENT_CONTEXT.md`;

    autosave.saveImmediately([
      { filePath: todoPath, content: newTodoMd },
      { filePath: agentPath, content: newAgentContextMd }
    ]);
  };

  // Export Project Files uniquely named by folder path
  const handleExportProject = () => {
    if (!activeProject) return;
    const folderSlug = activeProject.folderPath ? activeProject.folderPath.replace(/^projects\//, '') : activeProject.id;
    const todoBlob = new Blob([serializeTodoMarkdown(tasks, headerComments, archivedTasks)], { type: 'text/markdown' });
    const briefBlob = new Blob([serializeAgentContextMarkdown(briefs, archivedBriefs)], { type: 'text/markdown' });

    const a1 = document.createElement('a');
    a1.href = URL.createObjectURL(todoBlob);
    a1.download = `${folderSlug}_TODO.md`;
    a1.click();

    setTimeout(() => {
      const a2 = document.createElement('a');
      a2.href = URL.createObjectURL(briefBlob);
      a2.download = `${folderSlug}_AGENT_CONTEXT.md`;
      a2.click();
    }, 300);
  };

  // Create New Linked Project in Main Directory Structure & Write to Disk
  const handleConfirmCreateProject = async (
    name: string,
    customFolder: string,
    description: string,
    initialTodoContent?: string,
    initialAgentContextContent?: string
  ) => {
    const newProj = createNewProjectData(
      name,
      customFolder,
      description,
      initialTodoContent,
      initialAgentContextContent
    );
    // Write directory and initial markdown files directly to disk
    await createProjectOnDisk(newProj.folderPath, newProj.todoMarkdown, newProj.agentContextMarkdown);
    setProjects((prev) => [...prev, newProj]);
    setActiveProjectId(newProj.id);
  };

  // Trigger Immediate Disk Save from Navbar / Manual Action
  const handleManualSaveNow = () => {
    const todoPath = activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`;
    const agentPath = activeProject?.agentContextFilePath || `${activeProject?.folderPath}/AGENT_CONTEXT.md`;
    const todoMd = serializeTodoMarkdown(tasks, headerComments);
    const agentMd = serializeAgentContextMarkdown(briefs);

    autosave.saveImmediately([
      { filePath: todoPath, content: todoMd },
      { filePath: agentPath, content: agentMd }
    ]);
  };

  const runningTaskIds = useMemo(() => {
    const ids: number[] = [];
    terminalSessions.forEach((s) => {
      if (s.session.isActive && !ids.includes(s.session.taskId)) {
        ids.push(s.session.taskId);
      }
    });
    if (executingTaskId !== null && !ids.includes(executingTaskId)) {
      ids.push(executingTaskId);
    }
    return ids;
  }, [terminalSessions, executingTaskId]);

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <Navbar
        projects={projects}
        activeProject={activeProject}
        onSelectProject={(p) => setActiveProjectId(p.id)}
        onNewProject={() => setIsCreateProjectModalOpen(true)}
        folderMetadata={folderMetadata}
        onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
        mcpServers={mcpServers}
        onOpenMcpHub={() => setIsMcpHubOpen(true)}
        userApiKeys={userApiKeys}
        activeKeyId={activeKeyId}
        aiConfig={aiConfig}
        onSelectUserKey={handleSelectUserKey}
        onOpenAiScreen={handleOpenAiScreen}
        onOpenRawMarkdownModal={() => setIsRawMarkdownOpen(true)}
        onOpenSettingsModal={() => setIsSettingsModalOpen(true)}
        onSaveImmediately={handleManualSaveNow}
        autosaveStatus={autosave.status}
        autosaveDelaySec={autosave.delaySec}
        isAutosaveEnabled={autosave.isEnabled}
      />

      {/* Main Dual-Pane Workspace */}
      <div
        className={`workspace-body ${isDragging ? 'is-dragging' : ''}`}
        ref={workspaceRef}
      >
        {/* Left Pane: Obsidian-style Markdown Editor */}
        <div style={{ width: `${splitWidth}%`, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <TaskPane
            rawMarkdown={activeProject?.todoMarkdown || ''}
            tasks={tasks}
            archivedTasks={archivedTasks}
            selectedTaskId={selectedTaskId}
            runningTaskIds={runningTaskIds}
            onSelectTask={(id) => setSelectedTaskId(id)}
            onOpenDraftModal={() => setIsDraftModalOpen(true)}
            onMarkdownChange={handleRawTodoEdit}
            isAssistantOpen={isDraftModalOpen}
            onCloseAssistant={() => setIsDraftModalOpen(false)}
            project={activeProject}
            agentContextMarkdown={activeProject?.agentContextMarkdown || serializeAgentContextMarkdown(briefs, archivedBriefs)}
            aiConfig={aiConfig}
            mcpServers={mcpServers}
            onApplyAssistantResult={handleApplyAssistantResult}
            onArchiveTask={handleArchiveTask}
            onUnarchiveTask={handleUnarchiveTask}
            onDeleteArchivedTask={handleDeleteArchivedTask}
          />
        </div>

        {/* Resizable Divider Bar */}
        <div
          className={`resize-divider ${isDragging ? 'active' : ''}`}
          onMouseDown={handleMouseDown}
          title="Drag to resize pane width"
        >
          <div className="resize-handle-bar" />
        </div>

        {/* Right Pane: AI Workspace */}
        <div style={{ width: `${100 - splitWidth}%`, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <BriefPane
            tasks={tasks}
            briefs={briefs}
            archivedTasks={archivedTasks}
            archivedBriefs={archivedBriefs}
            selectedTaskId={selectedTaskId}
            runningTaskIds={runningTaskIds}
            onSelectTask={(id) => setSelectedTaskId(id)}
            onSaveBrief={handleSaveBrief}
            onLiveBriefChange={handleLiveBriefChange}
            onExecuteTask={handleExecuteTask}
            onUpdateBriefWithAi={handleUpdateBriefWithAi}
            onSyncOverviewWithTask={handleSyncOverviewWithTask}
            onUnarchiveTask={handleUnarchiveTask}
            onDeleteArchivedTask={handleDeleteArchivedTask}
            onSaveArchivedBrief={handleSaveArchivedBrief}
            autosaveStatus={autosave.status}
            autosaveDelaySec={autosave.delaySec}
            terminalSessions={terminalSessions}
            executingTaskId={executingTaskId}
            taskExecutionSteps={taskExecutionSteps}
            pendingPermissions={pendingPermissions}
            onPermissionChoice={handlePermissionChoice}
            onSessionExit={handleSessionExit}
            onRestartSession={handleExecuteTask}
            onKillSession={handleKillSession}
          />
        </div>

      </div>

      {/* Modal 1: Create New Project Directory */}
      <CreateProjectModal
        isOpen={isCreateProjectModalOpen}
        onClose={() => setIsCreateProjectModalOpen(false)}
        onCreateProject={handleConfirmCreateProject}
        storageDirectory={folderMetadata.storageDirectory || '.ergo'}
        existingProjects={projects}
      />

      {/* Modal 4: MCP Connections Hub */}
      <McpHubModal
        isOpen={isMcpHubOpen}
        onClose={() => setIsMcpHubOpen(false)}
        mcpServers={mcpServers}
        onToggleConnectServer={(serverId) =>
          setMcpServers((prev) =>
            prev.map((s) => {
              if (s.id !== serverId) return s;
              if (s.serverType === 'bundled_harness' || s.transport === 'Local Stdio') return s;
              return { ...s, status: s.status === 'connected' ? 'disconnected' : 'connected' };
            })
          )
        }
        onToggleToolAutoApprove={(serverId, toolId) =>
          setMcpServers((prev) =>
            prev.map((s) =>
              s.id === serverId
                ? {
                    ...s,
                    tools: s.tools.map((t) => (t.id === toolId ? { ...t, autoApprove: !t.autoApprove } : t))
                  }
                : s
            )
          )
        }
        onAddCustomServer={(newServer) => setMcpServers([...mcpServers, newServer])}
        cliAgentConfig={cliAgentConfig}
        onSaveCliAgent={(config) => setCliAgentConfig(config)}
      />


      {/* Modal 5: Raw Markdown Sync & Download Preview */}
      <RawMarkdownModal
        isOpen={isRawMarkdownOpen}
        onClose={() => setIsRawMarkdownOpen(false)}
        todoMarkdown={activeProject?.todoMarkdown || serializeTodoMarkdown(tasks, headerComments)}
        agentContextMarkdown={activeProject?.agentContextMarkdown || serializeAgentContextMarkdown(briefs)}
        folderPath={activeProject?.folderPath}
        todoFilePath={activeProject?.todoFilePath}
        agentContextFilePath={activeProject?.agentContextFilePath}
        onSaveMarkdown={handleSaveRawMarkdown}
        onExportProject={handleExportProject}
      />

      {/* Modal 6: AI Engine Screen & Key Setup Manager */}
      <AiCredentialsModal
        isOpen={isAiScreenOpen}
        onClose={() => setIsAiScreenOpen(false)}
        userApiKeys={userApiKeys}
        activeKeyId={activeKeyId}
        onSaveUserKey={handleSaveUserKey}
        onDeleteUserKey={handleDeleteUserKey}
        onSelectActiveKey={handleSelectUserKey}
        editingKey={editingKey}
      />

      {/* Modal 7: Workspace & Auto-Save Settings */}
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        activeProject={activeProject}
        folderMetadata={folderMetadata}
        onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
        onRescanProjects={handleRescanProjects}
        onUpdateStorageDirectory={handleUpdateStorageDirectory}
        autosaveStatus={autosave.status}
        autosaveDelaySec={autosave.delaySec}
        isAutosaveEnabled={autosave.isEnabled}
        lastSavedAt={autosave.lastSavedAt}
        onSetAutosaveDelay={autosave.setDelaySec}
        onToggleAutosave={autosave.setIsEnabled}
        onSaveImmediately={handleManualSaveNow}
      />

      {/* Modal 8: Local Root Directory Picker */}
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        onClose={() => setIsFolderPickerOpen(false)}
        folderMetadata={folderMetadata}
        onSelectFolder={handleSelectRootFolder}
        onRequestPermission={handleRequestHandlePermission}
        onUseServerFallback={handleUseServerFallback}
      />

      {/* Global Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />
    </div>
  );
}

export default App;
