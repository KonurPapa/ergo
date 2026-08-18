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
} from './types';

import { INITIAL_PROJECTS, createNewProjectData, INITIAL_MCP_SERVERS } from './lib/demoData';
import { parseTodoMarkdown, serializeTodoMarkdown, parseAgentContextMarkdown, serializeAgentContextMarkdown, syncBriefsWithTasks } from './lib/parser';
import { readFilesFromDisk, createProjectOnDisk } from './lib/fileSystem';
import { storageManager } from './lib/storageManager';
import { useAutosave } from './hooks/useAutosave';
import { SUPPORTED_AI_PROVIDERS } from './lib/aiProviders';
import { Navbar } from './components/Navbar';
import { TaskPane } from './components/TaskPane';
import { BriefPane } from './components/BriefPane';
import { DraftTaskModal } from './components/DraftTaskModal';
import { ExecutionModal } from './components/ExecutionModal';
import { McpHubModal } from './components/McpHubModal';
import { RawMarkdownModal } from './components/RawMarkdownModal';
import { CreateProjectModal } from './components/CreateProjectModal';
import { AiCredentialsModal } from './components/AiCredentialsModal';
import { SettingsModal } from './components/SettingsModal';
import { FolderPickerModal } from './components/FolderPickerModal';
import { AgentTerminalPane, type SpawnedSession } from './components/AgentTerminalPane';


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
  const [briefs, setBriefs] = useState<AgentContextItem[]>([]);
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

  // ─── CLI Agent Terminal State ───────────────────────────────────────────────────────
  // CLI agent config (command + flags), persisted to config/secrets.json
  const [cliAgentConfig, setCliAgentConfig] = useState<CliAgentConfig | null>(null);
  // Live spawned terminal sessions, one per task
  const [terminalSessions, setTerminalSessions] = useState<SpawnedSession[]>([]);
  // Which task's terminal is currently focused in the pane
  const [activeTerminalTaskId, setActiveTerminalTaskId] = useState<number | null>(null);
  // Whether the terminal pane is visible at all
  const [isTerminalPaneOpen, setIsTerminalPaneOpen] = useState(false);


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
    const activeKey = userApiKeys.find((k) => k.id === activeKeyId) || userApiKeys[0];
    if (activeKey) {
      return {
        provider: activeKey.provider,
        model: activeKey.model || 'gpt-4o',
        apiKey: activeKey.apiKey,
        baseUrl: activeKey.baseUrl,
        isConnected: true
      };
    }
    return {
      provider: 'mock',
      model: 'ergo-native-v1',
      isConnected: true
    };
  });

  // Sync activeKeyId & userApiKeys to aiConfig
  useEffect(() => {
    const activeKey = userApiKeys.find((k) => k.id === activeKeyId);
    if (activeKey) {
      const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === activeKey.provider);
      setAiConfig({
        provider: activeKey.provider,
        model: activeKey.model || pMeta?.defaultModel || 'gpt-4o',
        apiKey: activeKey.apiKey,
        baseUrl: activeKey.baseUrl,
        isConnected: true
      });
    } else {
      setAiConfig({
        provider: 'mock',
        model: 'ergo-native-v1',
        isConnected: true
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
  const [isExecutionModalOpen, setIsExecutionModalOpen] = useState(false);
  const [isMcpHubOpen, setIsMcpHubOpen] = useState(false);
  const [isRawMarkdownOpen, setIsRawMarkdownOpen] = useState(false);
  const [isCreateProjectModalOpen, setIsCreateProjectModalOpen] = useState(false);
  const [isAiScreenOpen, setIsAiScreenOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [executingTask, setExecutingTask] = useState<TaskItem | null>(null);


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

  const handleSelectUserKey = (keyId: string) => {
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
      const parsedBriefs = parseAgentContextMarkdown(effectiveAgentMd);

      setTasks(parsedTodo.items);
      setHeaderComments(parsedTodo.headerComments);
      setBriefs(parsedBriefs);

      if (parsedTodo.items.length > 0) {
        setSelectedTaskId(parsedTodo.items[0].id);
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

  // Save projects to localStorage on change
  useEffect(() => {
    localStorage.setItem('ergo_projects', JSON.stringify(projects));
  }, [projects]);

  // Helper to persist updated tasks & briefs back into active project's raw markdown and disk
  const syncAndSaveProject = (
    newTasks: TaskItem[],
    newBriefs: AgentContextItem[],
    immediateDiskSave = true
  ) => {
    setTasks(newTasks);
    setBriefs(newBriefs);

    const updatedTodoMd = serializeTodoMarkdown(newTasks, headerComments);
    const updatedBriefsMd = serializeAgentContextMarkdown(newBriefs);

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

  // Commit Drafted Tasks from AI (Skill: new-todo)
  const handleCommitDraftedTasks = (newTasks: Partial<TaskItem>[], newBriefs: Partial<AgentContextItem>[]) => {
    let currentId = tasks.length > 0 ? Math.max(...tasks.map((t) => t.id)) : 0;
    const createdTasks: TaskItem[] = [];
    const createdBriefs: AgentContextItem[] = [];

    newTasks.forEach((nt, idx) => {
      currentId += 1;
      const fullTask: TaskItem = {
        id: currentId,
        title: nt.title || `Task ${currentId}`,
        category: nt.category || 'Core Tasks',
        status: 'not_started',
        isDone: false,
        subtasks: nt.subtasks || [],
        isHumanReview: nt.isHumanReview,
        mcpRequired: nt.mcpRequired
      };
      createdTasks.push(fullTask);

      const nb = newBriefs[idx];
      const reviewText = nb?.humanReview || nb?.followUps || '';
      createdBriefs.push({
        itemNumber: currentId,
        title: fullTask.title,
        status: 'not started',
        brief: nb?.brief || `Brief for ${fullTask.title}`,
        built: nb?.built || '',
        validation: nb?.validation || '',
        humanReview: reviewText,
        followUps: reviewText
      });
    });

    const nextTasks = [...tasks, ...createdTasks];
    const nextBriefs = [...briefs, ...createdBriefs];

    if (createdTasks.length > 0) {
      setSelectedTaskId(createdTasks[0].id);
    }
    syncAndSaveProject(nextTasks, nextBriefs, true);
  };

  // Trigger Task Execution
  // If a CLI agent is configured, spawn a terminal session for this task.
  // Otherwise, fall back to the built-in ExecutionModal.
  const handleExecuteTask = (task: TaskItem) => {
    if (cliAgentConfig?.command) {
      // Resolve working directory: use the first MCP root or fall back to storage dir
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
      setIsTerminalPaneOpen(true);
    } else {
      // No CLI agent configured — use built-in execution modal
      setExecutingTask(task);
      setIsExecutionModalOpen(true);
    }
  };


  // Complete Execution & Apply Build Record
  const handleCompleteExecution = (updatedTask: TaskItem, updatedBrief: AgentContextItem) => {
    const nextTasks = tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t));
    const nextBriefs = briefs.map((b) => (b.itemNumber === updatedBrief.itemNumber ? updatedBrief : b));
    syncAndSaveProject(nextTasks, nextBriefs, true);
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
  const handleLiveBriefChange = (updatedBrief: AgentContextItem) => {
    const existingIdx = briefs.findIndex((b) => b.itemNumber === updatedBrief.itemNumber);
    let nextBriefs: AgentContextItem[];
    if (existingIdx !== -1) {
      nextBriefs = briefs.map((b) => (b.itemNumber === updatedBrief.itemNumber ? updatedBrief : b));
    } else {
      nextBriefs = [...briefs, updatedBrief];
    }
    setBriefs(nextBriefs);

    const currentTodoMd = serializeTodoMarkdown(tasks, headerComments);
    const updatedBriefsMd = serializeAgentContextMarkdown(nextBriefs);

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

  // Refine Brief with AI
  const handleUpdateBriefWithAi = (task: TaskItem) => {
    const existingBrief = briefs.find((b) => b.itemNumber === task.id);
    const existingReview = existingBrief?.humanReview || existingBrief?.followUps || '';
    const updatedBrief: AgentContextItem = {
      itemNumber: task.id,
      title: task.title,
      status: task.status,
      brief: `${existingBrief?.brief || ''}\n\n**AI Refinement (${new Date().toLocaleDateString()}):**\nTarget Folder: \`${activeProject.folderPath}\`.\nData Model: Additive property flags. Constraints: Must pass automated verification without cross-project leakage.`,
      built: existingBrief?.built || '',
      validation: existingBrief?.validation || '',
      humanReview: existingReview,
      followUps: existingReview
    };
    handleSaveBrief(updatedBrief);
  };

  // Live edit handler from Obsidian-style TaskPane editor (Triggers Debounced Autosave to disk)
  const handleRawTodoEdit = (newTodoMd: string) => {
    const parsedTodo = parseTodoMarkdown(newTodoMd);
    setTasks(parsedTodo.items);
    setHeaderComments(parsedTodo.headerComments);

    // Sync and renumber briefs matching the updated tasks
    const updatedBriefs = syncBriefsWithTasks(briefs, parsedTodo.items);
    setBriefs(updatedBriefs);
    const updatedBriefsMd = serializeAgentContextMarkdown(updatedBriefs);

    // Sync the raw markdown and updated briefs into the project record
    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? { ...p, todoMarkdown: newTodoMd, agentContextMarkdown: updatedBriefsMd }
          : p
      )
    );

    const todoPath = activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`;
    const agentPath = activeProject?.agentContextFilePath || `${activeProject?.folderPath}/AGENT_CONTEXT.md`;

    autosave.queueSave([
      { filePath: todoPath, content: newTodoMd },
      { filePath: agentPath, content: updatedBriefsMd }
    ]);
  };

  // Save Raw Markdown Editing (from Raw Markdown modal - Flushes immediately)
  const handleSaveRawMarkdown = (newTodoMd: string, newAgentContextMd: string) => {
    const parsedTodo = parseTodoMarkdown(newTodoMd);
    const parsedBriefs = parseAgentContextMarkdown(newAgentContextMd);

    setTasks(parsedTodo.items);
    setHeaderComments(parsedTodo.headerComments);
    setBriefs(parsedBriefs);

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
    const todoBlob = new Blob([serializeTodoMarkdown(tasks, headerComments)], { type: 'text/markdown' });
    const briefBlob = new Blob([serializeAgentContextMarkdown(briefs)], { type: 'text/markdown' });

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

  const activeTask = tasks.find((t) => t.id === selectedTaskId) || tasks[0] || null;
  const activeBrief = briefs.find((b) => b.itemNumber === activeTask?.id);

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
            selectedTaskId={selectedTaskId}
            onSelectTask={(id) => setSelectedTaskId(id)}
            onOpenDraftModal={() => setIsDraftModalOpen(true)}
            onMarkdownChange={handleRawTodoEdit}
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

        {/* Right Pane: AI Canvas — vertical split: BriefPane top + AgentTerminalPane bottom */}
        <div style={{ width: `${100 - splitWidth}%`, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          {/* BriefPane takes remaining space above the terminal pane */}
          <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
            <BriefPane
              activeTask={activeTask}
              activeBrief={activeBrief}
              onSaveBrief={handleSaveBrief}
              onLiveBriefChange={handleLiveBriefChange}
              onExecuteTask={handleExecuteTask}
              onUpdateBriefWithAi={handleUpdateBriefWithAi}
              autosaveStatus={autosave.status}
              autosaveDelaySec={autosave.delaySec}
              terminalSessionForTask={
                activeTask
                  ? terminalSessions.find((s) => s.session.taskId === activeTask.id) ?? null
                  : null
              }
              onToggleTerminal={() => {
                if (activeTask) {
                  setActiveTerminalTaskId(activeTask.id);
                  setIsTerminalPaneOpen((open) => !open);
                }
              }}
            />
          </div>

          {/* Agent Terminal Pane — docks to the bottom, resizable */}
          <AgentTerminalPane
            isOpen={isTerminalPaneOpen}
            onClose={() => setIsTerminalPaneOpen(false)}
            sessions={terminalSessions}
            activeTaskId={activeTerminalTaskId}
            onSelectSession={(taskId) => setActiveTerminalTaskId(taskId)}
            onCloseSession={(taskId) => {
              setTerminalSessions((prev) => prev.filter((s) => s.session.taskId !== taskId));
              setActiveTerminalTaskId((cur) => {
                if (cur === taskId) {
                  const remaining = terminalSessions.filter((s) => s.session.taskId !== taskId);
                  return remaining.length > 0 ? remaining[remaining.length - 1].session.taskId : null;
                }
                return cur;
              });
              if (terminalSessions.length <= 1) setIsTerminalPaneOpen(false);
            }}
            onSessionExit={(taskId, code) => {
              setTerminalSessions((prev) =>
                prev.map((s) =>
                  s.session.taskId === taskId
                    ? { ...s, session: { ...s.session, isActive: false, exitCode: code } }
                    : s
                )
              );
            }}
            cliConfig={cliAgentConfig}
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

      {/* Modal 2: Draft Tasks with AI */}
      <DraftTaskModal
        isOpen={isDraftModalOpen}
        onClose={() => setIsDraftModalOpen(false)}
        project={activeProject}
        aiConfig={aiConfig}
        mcpServers={mcpServers}
        onCommitDraftedTasks={handleCommitDraftedTasks}
      />

      {/* Modal 3: Task Execution Runner */}
      <ExecutionModal
        isOpen={isExecutionModalOpen}
        onClose={() => setIsExecutionModalOpen(false)}
        task={executingTask}
        brief={briefs.find((b) => b.itemNumber === executingTask?.id)}
        project={activeProject}
        aiConfig={aiConfig}
        mcpServers={mcpServers}
        onCompleteExecution={handleCompleteExecution}
      />

      {/* Modal 4: MCP Connections Hub */}
      <McpHubModal
        isOpen={isMcpHubOpen}
        onClose={() => setIsMcpHubOpen(false)}
        mcpServers={mcpServers}
        onToggleConnectServer={(serverId) =>
          setMcpServers((prev) =>
            prev.map((s) => (s.id === serverId ? { ...s, status: s.status === 'connected' ? 'disconnected' : 'connected' } : s))
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
        todoMarkdown={serializeTodoMarkdown(tasks, headerComments)}
        agentContextMarkdown={serializeAgentContextMarkdown(briefs)}
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
    </div>
  );
}

export default App;
