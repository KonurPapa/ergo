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
  type CliAgentSetup,
  type TerminalSession,
  type HumanAiAssistantResult,
  type SpawnedSession,
  type ExecutionStep,
  type McpToolPermissionPrompt,
  type HumanInputPrompt,
  type OllamaFallbackChoice,
  type OllamaFallbackPrompt,
  type SwimLaneDoc,
  type AgentPipelineOptions,
  type TaskStatus,
  type McpSecretEntry,
  type RunningJobInfo,
  type RunningJobsDoc
} from './types';

import {
  createDefaultRunningJobsDoc,
  parseRunningJobsDoc,
  serializeRunningJobsDoc
} from './lib/runningJobsStorage';

import { INITIAL_PROJECTS, createNewProjectData, INITIAL_MCP_SERVERS } from './lib/demoData';
import { GITHUB_MCP_TOOLS } from './lib/githubMcpTools';
import {
  parseTodoMarkdown,
  parseAgentContextMarkdown,
  parseAgentContextWithArchive,
  serializeTodoMarkdown,
  serializeAgentContextMarkdown,
  parseSwimLaneMarkdown,
  cleanAndUnescapeMarkdown
} from './lib/parser';
import { readFilesFromDisk, writeFilesToDisk, createProjectOnDisk } from './lib/fileSystem';
import { storageManager } from './lib/storageManager';
import {
  preWarmEmbeddings,
  migrateAgentContextToMemory,
  archiveTaskToVectorMemory,
  runSessionRetrospective,
  removeChunksByTaskId,
  clearProjectMemory,
  clearAllMemory
} from './lib/memory';
import { useAutosave } from './hooks/useAutosave';
import { SUPPORTED_AI_PROVIDERS } from './lib/aiProviders';
import { getEffectiveCliAgent, buildTaskCliPrompt, buildCliArgsForTask } from './lib/cliAgents';
import { Navbar } from './components/Navbar';
import { TaskPane } from './components/TaskPane';
import { BriefPane } from './components/BriefPane';
import { McpHubModal } from './components/McpHubModal';
import { RawMarkdownModal } from './components/RawMarkdownModal';
import { CreateProjectModal } from './components/CreateProjectModal';
import { AiCredentialsModal } from './components/AiCredentialsModal';
import { SettingsModal } from './components/SettingsModal';
import { FolderPickerModal } from './components/FolderPickerModal';
import { OnboardingModal } from './components/OnboardingModal';
import { ToastContainer, type ToastMessage } from './components/Toast';
import { executeTaskWithAi, syncTaskOverviewWithAi } from './lib/ai';
import { startMcpRoutineUpdateChecker } from './lib/mcpClient';
import { DEFAULT_AGENT_PIPELINE_OPTIONS } from './lib/agentPipeline/contracts';
import { formatOverviewDocToMarkdown } from './lib/agentPipeline/summary';
import {
  type ScheduledJob,
  getScheduledJobs,
  addScheduledJob,
  cancelScheduledJob,
  markJobCompleted
} from './lib/taskScheduler';
import { registerWorkspaceActionBridge } from './lib/workspaceMcp';
import { syncSkillsToWorkspace } from './lib/skillsManager';
import { bridgeClient, type BridgeStatus } from './lib/bridgeClient';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/** Merge persisted (possibly partial / stale) pipeline settings over the defaults, ignoring undefined values. */
function mergeAgentPipelineOptions(
  base: AgentPipelineOptions,
  patch?: Partial<AgentPipelineOptions> | null
): AgentPipelineOptions {
  if (!patch) return base;
  const next: AgentPipelineOptions = { ...base };
  if (typeof patch.maxConcurrentAgents === 'number' && Number.isFinite(patch.maxConcurrentAgents)) next.maxConcurrentAgents = patch.maxConcurrentAgents;
  if (typeof patch.maxQaRetries === 'number' && Number.isFinite(patch.maxQaRetries)) next.maxQaRetries = patch.maxQaRetries;
  if (typeof patch.maxToolRoundsPerAgent === 'number' && Number.isFinite(patch.maxToolRoundsPerAgent)) next.maxToolRoundsPerAgent = patch.maxToolRoundsPerAgent;
  if (typeof patch.enableCleaner === 'boolean') next.enableCleaner = patch.enableCleaner;
  if (typeof patch.enableHardener === 'boolean') next.enableHardener = patch.enableHardener;
  return next;
}


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
  const [selectedTaskId, setSelectedTaskId] = useState<string | number | null>(null);
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJob[]>(() => getScheduledJobs());

  // Autosave Hook (defaults to 5 seconds inactivity timeout, writes directly to workspace files)
  const autosave = useAutosave({
    defaultDelaySec: 5,
  });

  // MCP & AI Settings State (persisted to localStorage so tool permissions are global)
  const [mcpServers, setMcpServers] = useState<MCPServer[]>(() => {
    const saved = localStorage.getItem('ergo_mcp_servers');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return INITIAL_MCP_SERVERS.map((initServer) => {
            const match = parsed.find((s: MCPServer) => s.id === initServer.id);
            if (!match) return initServer;
            const mergedTools = (match.tools && match.tools.length >= initServer.tools.length)
              ? match.tools.map((mt: any) => {
                const initTool = initServer.tools.find((it) => it.name === mt.name);
                return {
                  ...initTool,
                  ...mt,
                  inputSchema: mt.inputSchema || initTool?.inputSchema
                };
              })
              : initServer.tools.map((initTool) => {
                const toolMatch = match.tools?.find((t: any) => t.id === initTool.id || t.name === initTool.name);
                return toolMatch ? { ...initTool, autoApprove: Boolean(toolMatch.autoApprove) } : initTool;
              });

            // Ensure bundled default connections (like Laya, Filesystem, Fetch, Git) default to connected if they were previously saved before being enabled by default
            const resolvedStatus = (initServer.serverType === 'bundled_harness' && initServer.status === 'connected' && match.status === 'disconnected' && !localStorage.getItem('ergo_mcp_user_toggled_' + initServer.id))
              ? 'connected'
              : (match.status || initServer.status);

            return {
              ...initServer,
              ...match,
              status: resolvedStatus,
              tools: mergedTools
            };
          }).concat(parsed.filter((s: MCPServer) => !INITIAL_MCP_SERVERS.some((init) => init.id === s.id)));
        }
      } catch { }
    }
    return INITIAL_MCP_SERVERS;
  });

  // User API Keys State (Loaded from config/secrets.json or fallback)
  const [userApiKeys, setUserApiKeys] = useState<UserApiKey[]>(() => {
    const saved = localStorage.getItem('ergo_user_api_keys');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      } catch { }
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
      } catch { }
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

  const showToast = useCallback((toast: Omit<ToastMessage, 'id'> & { id?: string }) => {
    const id = toast.id || `toast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    setToasts((prev) => {
      const existingIdx = prev.findIndex((t) => t.id === id);
      if (existingIdx !== -1) {
        return prev.map((t, idx) => (idx === existingIdx ? { ...toast, id } : t));
      }
      return [...prev, { ...toast, id }];
    });
  }, []);

  const handleDismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ─── CLI Agent Terminal State ───────────────────────────────────────────────────────
  // CLI agent config (command + flags), persisted to config/secrets.json
  const [cliAgentConfig, setCliAgentConfig] = useState<CliAgentConfig | null>(null);
  const [cliAgents, setCliAgents] = useState<CliAgentSetup[]>([]);
  const [activeCliAgentId, setActiveCliAgentId] = useState<string | null>(null);
  // Live spawned terminal sessions, one per task
  const [terminalSessions, setTerminalSessions] = useState<SpawnedSession[]>([]);
  const [_activeTerminalTaskId, setActiveTerminalTaskId] = useState<string | number | null>(null);


  // Theme State (Default: 'dark' to match Kiro Crew)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('ergo_theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return 'dark';
  });

  // Agent Execution Pipeline tuning (concurrency, QA retries, tool rounds, cleaner/hardener gates)
  const [agentPipelineOptions, setAgentPipelineOptions] = useState<AgentPipelineOptions>(DEFAULT_AGENT_PIPELINE_OPTIONS);

  // Apply theme attribute to root HTML document element
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('ergo_theme', theme);
    } catch { }
  }, [theme]);

  // Track onboarding completion state
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean>(false);

  // Autocomplete Settings state (persisted in config/settings.json and localStorage)
  const [autocompleteSettings, setAutocompleteSettings] = useState<import('./types').AutocompleteSettings>(() => {
    try {
      const saved = localStorage.getItem('ergo_autocomplete_settings');
      if (saved) return JSON.parse(saved);
    } catch { }
    return { enabled: true, keybinding: 'Tab' };
  });

  // Initialize Storage Layer on mount (IndexedDB handle & config loading)
  useEffect(() => {
    async function initStorage() {
      try {
        const res = await storageManager.init();
        setFolderMetadata(res.metadata);

        const loadedKeys = res.secrets && Array.isArray(res.secrets.userApiKeys) ? res.secrets.userApiKeys : [];
        if (loadedKeys.length > 0) {
          setUserApiKeys(loadedKeys);
        }
        if (res.secrets?.cliAgent) {
          setCliAgentConfig(res.secrets.cliAgent);
        }
        if (res.secrets?.cliAgents && Array.isArray(res.secrets.cliAgents)) {
          setCliAgents(res.secrets.cliAgents);
        }
        if (res.secrets?.activeCliAgentId !== undefined) {
          setActiveCliAgentId(res.secrets.activeCliAgentId);
        }

        if (res.projects && res.projects.length > 0) {
          setProjects(res.projects);
        }

        let effectiveActiveKeyId: string | null = null;
        let onboarded = false;

        if (res.settings) {
          if (res.settings.activeProjectId) {
            setActiveProjectId(res.settings.activeProjectId);
          }
          if (res.settings.activeKeyId) {
            setActiveKeyId(res.settings.activeKeyId);
            effectiveActiveKeyId = res.settings.activeKeyId;
          }
          if (typeof res.settings.hasCompletedOnboarding === 'boolean') {
            onboarded = res.settings.hasCompletedOnboarding;
            setHasCompletedOnboarding(res.settings.hasCompletedOnboarding);
          }
          if (typeof res.settings.autosaveDelaySec === 'number') {
            autosave.setDelaySec(res.settings.autosaveDelaySec);
          }
          if (typeof res.settings.autosaveEnabled === 'boolean') {
            autosave.setIsEnabled(res.settings.autosaveEnabled);
          }
          if (res.settings.theme === 'light' || res.settings.theme === 'dark') {
            setTheme(res.settings.theme);
          }
          if (res.settings.agentPipeline) {
            const persisted = res.settings.agentPipeline;
            setAgentPipelineOptions((prev) => mergeAgentPipelineOptions(prev, persisted));
          }
          if (res.settings.autocomplete) {
            setAutocompleteSettings(res.settings.autocomplete);
          }
        }

        // Onboarding Check on Startup:
        // If there is no active key, no API keys in secrets, and onboarding has not yet been completed,
        // display the Welcome & AI Account Onboarding screen
        const hasValidUserOrKey = loadedKeys.length > 0 || (effectiveActiveKeyId !== null && effectiveActiveKeyId !== undefined);
        if (!hasValidUserOrKey && !onboarded) {
          setIsOnboardingOpen(true);
        }
      } catch (err) {
        console.warn('[App] Error initializing storage layer:', err);
      }
    }
    initStorage();

    // Pre-warm the embedding model in the background (non-blocking, 0 API tokens).
    // The WASM model (~25MB) downloads and caches on first use; subsequent loads are instant.
    preWarmEmbeddings();
  }, []);

  // Sync settings (config/settings.json)
  useEffect(() => {
    try {
      localStorage.setItem('ergo_autocomplete_settings', JSON.stringify(autocompleteSettings));
    } catch { }

    if (activeProjectId) {
      storageManager.saveSettings({
        version: 1,
        activeProjectId,
        activeKeyId,
        autosaveDelaySec: autosave.delaySec,
        autosaveEnabled: autosave.isEnabled,
        theme,
        hasCompletedOnboarding,
        agentPipeline: agentPipelineOptions,
        autocomplete: autocompleteSettings,
        lastOpenedAt: new Date().toISOString()
      });
    }
  }, [activeProjectId, activeKeyId, autosave.delaySec, autosave.isEnabled, theme, hasCompletedOnboarding, agentPipelineOptions, autocompleteSettings]);

  // MCP Secrets State (config/secrets.json)
  const [mcpSecrets, setMcpSecrets] = useState<Record<string, McpSecretEntry>>({});

  useEffect(() => {
    storageManager.loadSecrets().then((sec) => {
      if (sec?.mcpSecrets) {
        setMcpSecrets(sec.mcpSecrets);
      }
    }).catch(() => { });
  }, []);

  // Sync GitHub MCP status on startup
  useEffect(() => {
    fetch(bridgeClient.getApiUrl('/api/mcp/github/status'))
      .then((res) => res.json())
      .then((data) => {
        if (data && data.configured) {
          setMcpServers((prev) =>
            prev.map((s) => {
              if (s.id !== 'mcp-github') return s;
              return {
                ...s,
                status: 'connected',
                authUsername: data.username,
                tools: (s.tools && s.tools.length >= 26) ? s.tools : GITHUB_MCP_TOOLS
              };
            })
          );
        }
      })
      .catch(() => { });
  }, []);

  // Sync secrets (config/secrets.json)
  useEffect(() => {
    storageManager.saveSecrets({
      version: 1,
      updatedAt: new Date().toISOString(),
      userApiKeys,
      mcpSecrets,
      cliAgent: cliAgentConfig ?? undefined,
      cliAgents,
      activeCliAgentId,
    });
  }, [userApiKeys, mcpSecrets, cliAgentConfig, cliAgents, activeCliAgentId]);


  // Active AI Provider Config
  const [aiConfig, setAiConfig] = useState<AIProviderConfig>(() => {
    const activeKey = userApiKeys.find((k) => k.id === activeKeyId);
    if (activeKey) {
      const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === activeKey.provider);
      return {
        provider: activeKey.provider,
        model: activeKey.generalModel || activeKey.model || pMeta?.defaultGeneralModel || 'gpt-4o',
        summaryModel: activeKey.summaryModel || pMeta?.defaultSummaryModel || activeKey.generalModel || activeKey.model || 'gpt-4o',
        generalModel: activeKey.generalModel || activeKey.model || pMeta?.defaultGeneralModel || 'gpt-4o',
        workerModel: activeKey.workerModel || undefined,
        authMode: activeKey.authMode || (activeKey.apiKey === 'cli_subscription_active' ? 'cli_subscription' : 'api_key'),
        cliAgentId: activeKey.cliAgentId,
        cliCustomCommand: activeKey.cliCustomCommand,
        cliExecutionMode: activeKey.cliExecutionMode,
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

  // Sync activeKeyId & userApiKeys to aiConfig and cliAgentConfig
  useEffect(() => {
    const activeKey = userApiKeys.find((k) => k.id === activeKeyId);
    if (activeKey) {
      const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === activeKey.provider);
      setAiConfig({
        provider: activeKey.provider,
        model: activeKey.generalModel || activeKey.model || pMeta?.defaultGeneralModel || pMeta?.defaultModel || 'gpt-4o',
        summaryModel: activeKey.summaryModel || pMeta?.defaultSummaryModel || activeKey.generalModel || activeKey.model || 'gpt-4o',
        generalModel: activeKey.generalModel || activeKey.model || pMeta?.defaultGeneralModel || pMeta?.defaultModel || 'gpt-4o',
        workerModel: activeKey.workerModel || undefined,
        cleanerModel: activeKey.cleanerModel || undefined,
        hardenerModel: activeKey.hardenerModel || undefined,
        loggerModel: activeKey.loggerModel || undefined,
        roleConfigs: activeKey.roleConfigs || undefined,
        providerKeys: activeKey.providerKeys || undefined,
        authMode: activeKey.authMode || (activeKey.apiKey === 'cli_subscription_active' ? 'cli_subscription' : 'api_key'),
        cliAgentId: activeKey.cliAgentId,
        cliPresetId: activeKey.cliPresetId,
        cliCustomCommand: activeKey.cliCustomCommand,
        cliExtraArgs: activeKey.cliExtraArgs,
        cliExecutionMode: activeKey.cliExecutionMode,
        apiKey: activeKey.apiKey,
        baseUrl: activeKey.baseUrl,
        isConnected: true
      });

      // Synchronize CLI agent config to the effective agent for this profile
      const effective = getEffectiveCliAgent(activeKey, cliAgentConfig);
      if (effective) {
        setCliAgentConfig(effective);
      }
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

  // Persist MCP servers and tool permissions to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('ergo_mcp_servers', JSON.stringify(mcpServers));
    } catch { }
  }, [mcpServers]);

  // Routine update checker for connected MCP servers (checks every 60s and on window focus)
  const mcpServersRef = useRef(mcpServers);
  useEffect(() => {
    mcpServersRef.current = mcpServers;
  }, [mcpServers]);

  useEffect(() => {
    const cleanup = startMcpRoutineUpdateChecker(
      () => mcpServersRef.current,
      (result) => {
        if (result.hasChanges) {
          setMcpServers(result.updatedServers);
          showToast({
            type: 'info',
            title: 'MCP Tools Updated',
            message: result.summaryMessage || 'New or updated tools were discovered from your connected MCP servers.',
            duration: 5000
          });
        }
      },
      60000
    );
    return cleanup;
  }, [showToast]);

  // Modal Open States
  const [isDraftModalOpen, setIsDraftModalOpen] = useState(false);
  const [isMcpHubOpen, setIsMcpHubOpen] = useState(false);
  const [isRawMarkdownOpen, setIsRawMarkdownOpen] = useState(false);
  const [isCreateProjectModalOpen, setIsCreateProjectModalOpen] = useState(false);
  const [isAiScreenOpen, setIsAiScreenOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [executingTaskId, setExecutingTaskId] = useState<string | number | null>(null);
  const [taskExecutionSteps, setTaskExecutionSteps] = useState<Record<string | number, ExecutionStep[]>>({});
  const [pendingPermissions, setPendingPermissions] = useState<Record<string | number, { prompt: McpToolPermissionPrompt; resolve: (approved: boolean) => void }>>({});
  const [pendingHumanInputs, setPendingHumanInputs] = useState<Record<string | number, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>>({});
  const [pendingOllamaFallbacks, setPendingOllamaFallbacks] = useState<Record<string | number, { prompt: OllamaFallbackPrompt; resolve: (choice: OllamaFallbackChoice) => void }>>({});

  // Synchronous refs to prevent React state closure races when toasts or buttons fire
  const pendingPermissionsRef = useRef<Record<string | number, { prompt: McpToolPermissionPrompt; resolve: (approved: boolean) => void }>>({});
  const pendingHumanInputsRef = useRef<Record<string | number, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>>({});
  const pendingOllamaFallbacksRef = useRef<Record<string | number, { prompt: OllamaFallbackPrompt; resolve: (choice: OllamaFallbackChoice) => void }>>({});

  // AbortController map — one controller per active execution (keyed by taskId)
  const abortControllersRef = useRef<Map<string | number, AbortController>>(new Map());

  // Running Jobs & Queued Tasks State (Persisted in RUNNING_JOBS.json)
  const [queuedTaskIds, setQueuedTaskIds] = useState<(string | number)[]>([]);
  const [runningJobs, setRunningJobs] = useState<RunningJobInfo[]>([]);

  const queuedTaskIdsRef = useRef<(string | number)[]>([]);
  queuedTaskIdsRef.current = queuedTaskIds;

  const runningJobsRef = useRef<RunningJobInfo[]>([]);
  runningJobsRef.current = runningJobs;

  const briefsRef = useRef<AgentContextItem[]>([]);
  briefsRef.current = briefs;

  const taskExecutionStepsRef = useRef<Record<string | number, ExecutionStep[]>>({});
  taskExecutionStepsRef.current = taskExecutionSteps;

  const stepSaveTimerRef = useRef<any>(null);




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

  // Onboarding completion handler: persists active account & settings locally into ~/.ergo
  const handleCompleteOnboarding = async (newKey?: UserApiKey) => {
    setIsOnboardingOpen(false);
    setHasCompletedOnboarding(true);

    let nextActiveKeyId = activeKeyId;
    if (newKey) {
      setUserApiKeys((prev) => {
        const next = [...prev.filter((k) => k.id !== newKey.id), newKey];
        return next;
      });
      setActiveKeyId(newKey.id);
      nextActiveKeyId = newKey.id;
      showToast({
        type: 'success',
        title: 'Account Connected',
        message: `Successfully connected ${newKey.name}. Welcome to Ergo!`,
        duration: 4500
      });
    }

    try {
      await storageManager.saveSettings({
        version: 1,
        activeProjectId: activeProjectId || 'default-workspace',
        activeKeyId: nextActiveKeyId,
        autosaveDelaySec: autosave.delaySec || 5,
        autosaveEnabled: autosave.isEnabled,
        theme,
        hasCompletedOnboarding: true,
        lastOpenedAt: new Date().toISOString()
      });
    } catch (err) {
      console.warn('[App] Failed to persist onboarding completion to .ergo:', err);
    }
  };

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

  // Popout AI Workspace Panel State (default: open)
  const [isAiPanelOpen, setIsAiPanelOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem('ergo_ai_panel_open');
    return saved !== null ? saved === 'true' : true;
  });

  const handleToggleAiPanel = useCallback(() => {
    setIsAiPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('ergo_ai_panel_open', String(next));
      } catch { }
      return next;
    });
  }, []);

  // Local Device Bridge State & Auto-Reconnect
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>(() => bridgeClient.getStatus());
  const [isReconnectingBridge, setIsReconnectingBridge] = useState(false);

  useEffect(() => {
    // Start background heartbeat to detect and keep bridge connection alive
    bridgeClient.startHeartbeat(10000);
    const unsub = bridgeClient.subscribe((status) => {
      setBridgeStatus(status);
    });
    return () => {
      unsub();
      bridgeClient.stopHeartbeat();
    };
  }, []);

  const handleManualReconnectBridge = useCallback(async () => {
    setIsReconnectingBridge(true);
    try {
      const res = await bridgeClient.checkConnection();
      if (res.success) {
        showToast({
          type: 'success',
          title: 'Device Bridge Connected',
          message: `Connected to local environment at ${bridgeClient.getBridgeUrl()}`,
          duration: 3500
        });
        // Rescan projects on reconnect
        const scanned = await storageManager.scanProjects();
        if (scanned.length > 0) {
          setProjects(scanned);
        }
      } else {
        showToast({
          type: 'error',
          title: 'Connection Failed',
          message: res.error || 'Could not reach local Ergo bridge. Ensure npm run dev is running locally.',
          duration: 5000
        });
      }
    } finally {
      setIsReconnectingBridge(false);
    }
  }, [showToast]);

  // Resizable Split Pane State (default: 2/3 for Human lanes, 1/3 for AI workspace)
  const [splitWidth, setSplitWidth] = useState<number>(66.667); // percentage
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

      const currentLanes: SwimLaneDoc[] = activeProject.swimLanes && activeProject.swimLanes.length > 0
        ? activeProject.swimLanes
        : [{
          id: 'lane-default',
          title: 'Human Workspace',
          filePath: activeProject.todoFilePath || `${activeProject.folderPath}/TODO.md`,
          markdown: activeProject.todoMarkdown || ''
        }];

      const agentPath = activeProject.agentContextFilePath || (activeProject.folderPath ? `${activeProject.folderPath}/AGENT_CONTEXT.md` : '');
      const runningJobsPath = activeProject.folderPath ? `${activeProject.folderPath}/RUNNING_JOBS.json` : '';
      const allPathsToRead = [
        ...currentLanes.map((l) => l.filePath),
        ...(agentPath ? [agentPath] : []),
        ...(runningJobsPath ? [runningJobsPath] : [])
      ];

      // Try reading latest live files directly from disk
      const diskFiles = await readFilesFromDisk(allPathsToRead);
      if (!isMounted) return;

      // Migrate legacy AGENT_CONTEXT.md if found on disk, then permanently remove it from disk
      if (agentPath && diskFiles[agentPath] !== null && diskFiles[agentPath] !== undefined) {
        try {
          const { items: legacyItems } = parseAgentContextWithArchive(diskFiles[agentPath]!);
          if (legacyItems.length > 0) {
            void migrateAgentContextToMemory(
              legacyItems.map((b) => ({
                id: String(b.sourceTaskId || b.id || b.itemNumber || '').replace(/^brief_/, ''),
                title: b.title || '',
                overview: b.overview || b.brief || '',
                completion: b.completion || '',
                projectId: activeProjectId,
              }))
            );
          }
          // Remove AGENT_CONTEXT.md from disk so it never exists on disk again
          void storageManager.deleteFile(agentPath);
        } catch (migErr) {
          console.warn('[Ergo] Cleanup of legacy AGENT_CONTEXT.md:', migErr);
        }
      }

      // Parse or initialize RUNNING_JOBS.json
      let runningJobsDoc: RunningJobsDoc | null = null;
      if (runningJobsPath && diskFiles[runningJobsPath] !== null && diskFiles[runningJobsPath] !== undefined) {
        runningJobsDoc = parseRunningJobsDoc(diskFiles[runningJobsPath]!, activeProject.id);
      } else if (activeProject.runningJobsDoc) {
        runningJobsDoc = activeProject.runningJobsDoc;
      }

      if (!runningJobsDoc) {
        runningJobsDoc = createDefaultRunningJobsDoc(activeProject.id);
        if (runningJobsPath) {
          writeFilesToDisk([{ filePath: runningJobsPath, content: serializeRunningJobsDoc(runningJobsDoc) }]);
        }
      }

      const effectiveSwimLanes = currentLanes.map((lane) => {
        if (diskFiles[lane.filePath] !== null && diskFiles[lane.filePath] !== undefined) {
          return { ...lane, markdown: diskFiles[lane.filePath]! };
        }
        return lane;
      });

      let allActiveTasks: TaskItem[] = [];
      let allArchivedTasks: TaskItem[] = [];
      let firstHeaderComments = '';

      for (const lane of effectiveSwimLanes) {
        const parsed = parseSwimLaneMarkdown(lane);
        allActiveTasks = [...allActiveTasks, ...parsed.items];
        allArchivedTasks = [...allArchivedTasks, ...parsed.archivedItems];
        if (!firstHeaderComments && parsed.headerComments) {
          firstHeaderComments = parsed.headerComments;
        }
      }

      // If any legacy archived tasks were found in markdown, archive them to vector storage and clean up markdown!
      if (allArchivedTasks.length > 0) {
        for (const at of allArchivedTasks) {
          void archiveTaskToVectorMemory({
            taskId: at.id,
            taskTitle: at.title,
            category: at.category,
            status: at.status,
            subtasks: at.subtasks,
            projectId: activeProjectId,
          });
        }
        // Write clean swimlanes without archived blocks
        const cleanedLanes = effectiveSwimLanes.map((l) => ({
          ...l,
          markdown: serializeTodoMarkdown(
            allActiveTasks.filter((t) => (t.swimLaneId || 'lane-default') === l.id),
            firstHeaderComments
          ),
        }));
        writeFilesToDisk(cleanedLanes.map((l) => ({ filePath: l.filePath, content: l.markdown })));
      }

      const activeBriefs: AgentContextItem[] =
        runningJobsDoc && Array.isArray(runningJobsDoc.tasks) && runningJobsDoc.tasks.length > 0
          ? runningJobsDoc.tasks
          : parseAgentContextWithArchive(activeProject.agentContextMarkdown || '').items;

      setTasks(allActiveTasks);
      setArchivedTasks([]);
      setHeaderComments(firstHeaderComments);
      setBriefs(activeBriefs);
      setArchivedBriefs([]);
      setRunningJobs(
        (runningJobsDoc.runningJobs || []).map((j) =>
          j.status === 'in_progress' ? { ...j, status: 'cancelled' as const } : j
        )
      );
      setQueuedTaskIds(runningJobsDoc.queuedTaskIds || []);
      if (runningJobsDoc.taskExecutionSteps && Object.keys(runningJobsDoc.taskExecutionSteps).length > 0) {
        setTaskExecutionSteps(runningJobsDoc.taskExecutionSteps);
      }

      // Query active backend PTY sessions to reconnect any running terminal sessions for the active project
      try {
        const ptyRes = await fetch(bridgeClient.getApiUrl('/api/pty/sessions'));
        if (ptyRes.ok) {
          const { sessions } = await ptyRes.json();
          if (Array.isArray(sessions) && sessions.length > 0) {
            // Only reconnect sessions whose taskId matches an active task or brief in this project
            const projectTaskIds = new Set([
              ...allActiveTasks.map((t) => String(t.id)),
              ...activeBriefs.map((b) => String(b.sourceTaskId || b.id || b.itemNumber)),
            ]);

            const activeSessions: SpawnedSession[] = sessions
              .filter((s: any) => projectTaskIds.has(String(s.taskId || s.id)))
              .map((s: any) => ({
                session: {
                  taskId: s.taskId || s.id,
                  taskTitle: s.taskTitle || `Task ${s.taskId || s.id}`,
                  isActive: true,
                  spawnedAt: new Date(s.createdAt || Date.now()).toISOString(),
                },
                cwd: s.cwd || activeProject.folderPath,
                cmd: s.cmd || '',
                args: s.args || [],
              }));

            setTerminalSessions((prev) => {
              const existingTaskIds = new Set(activeSessions.map((as) => String(as.session.taskId)));
              const retained = prev.filter((p) => !existingTaskIds.has(String(p.session.taskId)));
              return [...retained, ...activeSessions];
            });
          }
        }
      } catch (ptyErr) {
        console.warn('[Ergo] Failed to query active PTY sessions on load:', ptyErr);
      }

      if (activeBriefs.length > 0) {
        void migrateAgentContextToMemory(
          activeBriefs.map((b) => ({
            id: String(b.sourceTaskId || b.id || b.itemNumber || '').replace(/^brief_/, ''),
            title: b.title || '',
            overview: b.overview || b.brief || '',
            completion: b.completion || '',
            projectId: activeProjectId,
          }))
        );

        const firstBrief = activeBriefs[0];
        const defaultId = firstBrief.sourceTaskId || firstBrief.id || firstBrief.itemNumber || null;
        setSelectedTaskId((prev) =>
          prev !== null &&
            activeBriefs.some(
              (b) => b.id === prev || b.sourceTaskId === prev || b.itemNumber === prev
            )
            ? prev
            : defaultId
        );
      } else if (allActiveTasks.length > 0) {
        setSelectedTaskId((prev) => (prev !== null && allActiveTasks.some((t) => t.id === prev) ? prev : allActiveTasks[0].id));
      } else {
        setSelectedTaskId(null);
      }

      // Update project state if disk files had more recent changes or swimLanes need sync
      const primaryTodoMd = effectiveSwimLanes[0]?.markdown || activeProject.todoMarkdown;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === activeProjectId
            ? {
              ...p,
              todoMarkdown: primaryTodoMd,
              agentContextMarkdown: '',
              swimLanes: effectiveSwimLanes,
              runningJobsDoc: runningJobsDoc || p.runningJobsDoc,
            }
            : p
        )
      );
    }

    loadActiveProjectContent();

    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Real-time disk file watcher subscription (SSE): updates UI instantly when markdown files change externally
  const activeProjectRef = useRef(activeProject);
  const tasksRef = useRef(tasks);
  useEffect(() => { activeProjectRef.current = activeProject; }, [activeProject]);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  useEffect(() => {
    let eventSource: EventSource | null = null;

    try {
      eventSource = new EventSource(bridgeClient.getApiUrl('/api/files/events'));

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data || data.type === 'connected') return;

          const { projectId, fileType, content, relativePath } = data;
          if (!fileType || typeof content !== 'string') return;

          // If RUNNING_JOBS.json was changed on disk, update the project runningJobsDoc and active briefs
          if (relativePath?.endsWith('RUNNING_JOBS.json')) {
            const parsedJobsDoc = parseRunningJobsDoc(content, projectId);
            setProjects((prevProjects) =>
              prevProjects.map((p) =>
                p.id === projectId || p.folderPath === `projects/${projectId}`
                  ? { ...p, runningJobsDoc: parsedJobsDoc }
                  : p
              )
            );

            const ap = activeProjectRef.current;
            if (ap && (ap.id === projectId || ap.folderPath === `projects/${projectId}`)) {
              if (Array.isArray(parsedJobsDoc.tasks)) setBriefs(parsedJobsDoc.tasks);
              if (Array.isArray(parsedJobsDoc.runningJobs)) setRunningJobs(parsedJobsDoc.runningJobs);
              if (Array.isArray(parsedJobsDoc.queuedTaskIds)) setQueuedTaskIds(parsedJobsDoc.queuedTaskIds);
              if (parsedJobsDoc.taskExecutionSteps) setTaskExecutionSteps(parsedJobsDoc.taskExecutionSteps);
            }
            return;
          }

          // Update projects state array for the changed project
          setProjects((prevProjects) =>
            prevProjects.map((p) => {
              const isMatch =
                p.id === projectId ||
                p.folderPath === `projects/${projectId}` ||
                p.todoFilePath === relativePath ||
                p.agentContextFilePath === relativePath ||
                (p.swimLanes && p.swimLanes.some((l) => l.filePath === relativePath));

              if (!isMatch) return p;

              if (fileType === 'agent' || relativePath?.endsWith('AGENT_CONTEXT.md')) {
                if (relativePath) void storageManager.deleteFile(relativePath);
                return p;
              } else {
                const updatedLanes = (p.swimLanes || []).map((l) =>
                  l.filePath === relativePath ? { ...l, markdown: content } : l
                );
                return {
                  ...p,
                  todoMarkdown: updatedLanes[0]?.markdown || (p.todoFilePath === relativePath ? content : p.todoMarkdown),
                  swimLanes: updatedLanes
                };
              }
            })
          );

          // Use refs to avoid stale closure — reads current activeProject and tasks without triggering reconnect
          const ap = activeProjectRef.current;
          const isActiveProject =
            ap &&
            (ap.id === projectId ||
              ap.folderPath === `projects/${projectId}` ||
              ap.todoFilePath === relativePath ||
              (ap.swimLanes && ap.swimLanes.some((l) => l.filePath === relativePath)));

          if (isActiveProject) {
            if (fileType === 'agent' || relativePath?.endsWith('AGENT_CONTEXT.md')) {
              // Ignore AGENT_CONTEXT.md - context lives in vector memory
              return;
            } else {
              const currentLanes: SwimLaneDoc[] = ap.swimLanes && ap.swimLanes.length > 0
                ? ap.swimLanes
                : [{
                  id: 'lane-default',
                  title: 'Human Workspace',
                  filePath: ap.todoFilePath || `${ap.folderPath}/TODO.md`,
                  markdown: ap.todoMarkdown || ''
                }];

              const updatedLanes = currentLanes.map((l) =>
                l.filePath === relativePath ? { ...l, markdown: content } : l
              );

              let allActiveTasks: TaskItem[] = [];
              let allArchivedTasks: TaskItem[] = [];

              for (const lane of updatedLanes) {
                const parsed = parseSwimLaneMarkdown(lane);
                allActiveTasks = [...allActiveTasks, ...parsed.items];
                allArchivedTasks = [...allArchivedTasks, ...parsed.archivedItems];
              }

              setTasks(allActiveTasks);
              setArchivedTasks(allArchivedTasks);
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
    currentArchivedBriefs = archivedBriefs,
    currentSwimLanes = activeProject?.swimLanes
  ) => {
    setTasks(newTasks);
    setBriefs(newBriefs);
    setArchivedTasks(currentArchivedTasks);
    setArchivedBriefs(currentArchivedBriefs);

    const effectiveLanes: SwimLaneDoc[] = currentSwimLanes && currentSwimLanes.length > 0
      ? currentSwimLanes
      : [{
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`,
        markdown: activeProject?.todoMarkdown || ''
      }];

    const firstLaneId = effectiveLanes[0]?.id || 'lane-default';

    // Re-serialize each swimlane markdown ensuring only active tasks are placed
    const updatedLanes: SwimLaneDoc[] = effectiveLanes.map((lane, idx) => {
      const laneActive = newTasks.filter(
        (t) => (t.swimLaneId || firstLaneId) === lane.id
      );

      // Extract existing header comments for this lane
      let laneHeader = idx === 0 ? headerComments : '';
      if (!laneHeader && lane.markdown) {
        try {
          const parsed = parseSwimLaneMarkdown(lane);
          if (parsed.headerComments) {
            laneHeader = parsed.headerComments;
          }
        } catch { }
      }

      const serialized = serializeTodoMarkdown(laneActive, laneHeader);
      return {
        ...lane,
        markdown: serialized,
      };
    });

    const primaryTodoMd = updatedLanes[0]?.markdown || serializeTodoMarkdown(newTasks, headerComments);

    // Save swimlane markdown files (e.g. TODO.md) and RUNNING_JOBS.json
    const filesToSave = updatedLanes.map((l) => ({ filePath: l.filePath, content: l.markdown }));

    const runningJobsPath = activeProject?.folderPath ? `${activeProject.folderPath}/RUNNING_JOBS.json` : '';
    let currentRunningJobsDoc: RunningJobsDoc | undefined;
    if (runningJobsPath) {
      currentRunningJobsDoc = {
        version: 1,
        projectId: activeProjectId,
        updatedAt: new Date().toISOString(),
        tasks: newBriefs,
        runningJobs: runningJobsRef.current,
        queuedTaskIds: queuedTaskIdsRef.current,
        taskExecutionSteps: taskExecutionStepsRef.current as Record<string, ExecutionStep[]>,
      };
      filesToSave.push({
        filePath: runningJobsPath,
        content: serializeRunningJobsDoc(currentRunningJobsDoc),
      });
    }

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? {
            ...p,
            todoMarkdown: primaryTodoMd,
            swimLanes: updatedLanes,
            runningJobsDoc: currentRunningJobsDoc || p.runningJobsDoc,
          }
          : p
      )
    );

    if (immediateDiskSave) {
      autosave.saveImmediately(filesToSave);
    } else {
      autosave.queueSave(filesToSave);
    }
  };

  // Helper to persist RUNNING_JOBS.json directly when running jobs or queued states update
  const persistRunningJobsDoc = useCallback((
    jobsToPersist: RunningJobInfo[] = runningJobsRef.current,
    queuedToPersist: (string | number)[] = queuedTaskIdsRef.current,
    briefsToPersist: AgentContextItem[] = briefsRef.current,
    stepsToPersist: Record<string | number, ExecutionStep[]> = taskExecutionStepsRef.current
  ) => {
    if (!activeProject?.folderPath) return;
    const runningJobsPath = `${activeProject.folderPath}/RUNNING_JOBS.json`;
    const doc: RunningJobsDoc = {
      version: 1,
      projectId: activeProjectId,
      updatedAt: new Date().toISOString(),
      tasks: briefsToPersist,
      runningJobs: jobsToPersist,
      queuedTaskIds: queuedToPersist,
      taskExecutionSteps: stepsToPersist as Record<string, ExecutionStep[]>,
    };
    writeFilesToDisk([{ filePath: runningJobsPath, content: serializeRunningJobsDoc(doc) }]);
    setProjects((prev) =>
      prev.map((p) => (p.id === activeProjectId ? { ...p, runningJobsDoc: doc } : p))
    );
  }, [activeProject?.folderPath, activeProjectId]);

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
      message: 'Reverted previous AI assistant changes to TODO.md.'
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

    // Attach user-selected MCP tools to created/updated tasks and briefs
    if (result.selectedMcpTools && result.selectedMcpTools.length > 0) {
      const prevIds = new Set(tasks.map((t) => t.id));
      nextTasks = nextTasks.map((t) => {
        if (!prevIds.has(t.id) || !t.mcpRequired || t.mcpRequired.length === 0) {
          return { ...t, mcpRequired: result.selectedMcpTools };
        }
        return t;
      });
      nextBriefs = nextBriefs.map((b) => {
        if (!b.requiredMcps || b.requiredMcps.length === 0) {
          return { ...b, requiredMcps: result.selectedMcpTools, selectedMcpTools: result.selectedMcpTools };
        }
        return b;
      });
    }

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

  // Handler for creating a task in the AI side from a human task card or freeform text selection in a human swim lane
  const handleCreateTaskFromSelection = (
    selectedText: string,
    laneId: string,
    laneTitle: string,
    sourceTask?: TaskItem
  ) => {
    if (!selectedText || !selectedText.trim()) return;

    const cleanText = selectedText.trim();
    // Compute next unique item number for the AI brief
    const nextItemNumber = briefs.length > 0 ? Math.max(...briefs.map((b) => b.itemNumber || 0)) + 1 : 1;

    // Extract a concise, clean task title from the selection or source task
    let taskTitle = sourceTask?.title;
    if (!taskTitle) {
      const firstLine = cleanText.split('\n')[0].replace(/^[-*#\d.]+\s*/, '').replace(/^[~~`*_]+|[~~`*_]+$/g, '').trim();
      taskTitle = firstLine.length > 70 ? firstLine.slice(0, 67) + '...' : firstLine || `AI Task #${nextItemNumber}`;
    }

    const newId = sourceTask ? `brief_${sourceTask.id}` : `brief_freeform_${Date.now()}`;

    // Create the new AgentContextItem on the AI side with user context = cleanText and unique linkages
    const newBrief: AgentContextItem = {
      id: newId,
      sourceTaskId: sourceTask?.id,
      sourceLaneId: laneId,
      sourceLaneTitle: laneTitle,
      sourceContent: sourceTask ? undefined : cleanText,
      itemNumber: nextItemNumber,
      title: taskTitle,
      status: sourceTask?.status || 'not_started',
      overview: cleanText,
      buildAndVerification: '',
      completion: '',
      brief: cleanText,
      built: '',
      validation: '',
      requiredMcps: sourceTask?.mcpRequired,
      selectedMcpTools: sourceTask?.mcpRequired,
    };

    // If a brief already exists for this exact sourceTaskId, update it instead of adding a duplicate
    const existingIndex = sourceTask?.id
      ? briefs.findIndex(
        (b) =>
          (b.sourceTaskId != null && b.sourceTaskId === sourceTask.id) ||
          b.title.trim().toLowerCase() === sourceTask.title.trim().toLowerCase()
      )
      : -1;

    let nextBriefs: AgentContextItem[];
    if (existingIndex >= 0) {
      nextBriefs = [...briefs];
      nextBriefs[existingIndex] = {
        ...nextBriefs[existingIndex],
        ...newBrief,
        id: nextBriefs[existingIndex].id || newBrief.id,
      };
    } else {
      nextBriefs = [...briefs, newBrief];
    }

    const selectId = sourceTask ? sourceTask.id : (newBrief.id || null);
    setSelectedTaskId(selectId);

    // Persist to state and workspace immediately
    syncAndSaveProject(tasks, nextBriefs, true);

    showToast({
      type: 'success',
      title: 'AI Task Added',
      message: `Added "${taskTitle}" to AI Workspace (${laneTitle}).`,
      duration: 3500,
    });
  };

  // Handler for explicitly updating configured MCP tools on a specific task / brief
  const handleUpdateTaskMcpTools = useCallback((taskId: string | number, toolNames: string[]) => {
    const nextTasks = tasks.map((t) => (String(t.id) === String(taskId) ? { ...t, mcpRequired: toolNames } : t));
    const nextBriefs = briefs.map((b) =>
      String(b.sourceTaskId) === String(taskId) || String(b.id) === String(taskId)
        ? { ...b, requiredMcps: toolNames, selectedMcpTools: toolNames }
        : b
    );
    syncAndSaveProject(nextTasks, nextBriefs, true);
    showToast({
      type: 'success',
      title: 'MCP Tools Updated',
      message: toolNames.length === 0
        ? 'Cleared MCP tool constraints for task.'
        : `Assigned ${toolNames.length} MCP tool${toolNames.length === 1 ? '' : 's'} to this task.`,
      duration: 3000
    });
  }, [tasks, briefs, syncAndSaveProject, showToast]);

  // Terminate a running agent execution for a given task ID (in-place agent execution, tool loop, and embedded CLI session)
  const handleTerminateAgent = useCallback(async (taskId: string | number) => {
    // 1. Abort controller (exact match or stringified match)
    let foundController: AbortController | undefined;
    for (const [key, ctrl] of abortControllersRef.current.entries()) {
      if (String(key) === String(taskId)) {
        foundController = ctrl;
        abortControllersRef.current.delete(key);
        break;
      }
    }
    if (foundController) {
      try {
        foundController.abort();
      } catch { }
    }

    // 2. If there is any pending permission request waiting for approval, reject it explicitly so it never resolves true
    for (const [key, pending] of Object.entries(pendingPermissionsRef.current)) {
      if (String(key) === String(taskId)) {
        try {
          pending.resolve(false);
        } catch { }
        delete pendingPermissionsRef.current[key];
      }
    }
    for (const [key, pending] of Object.entries(pendingPermissions)) {
      if (String(key) === String(taskId)) {
        try {
          pending.resolve(false);
        } catch { }
      }
    }

    // 3. If there is any pending Ollama fallback waiting, resolve it to terminate immediately
    for (const [key, pending] of Object.entries(pendingOllamaFallbacksRef.current)) {
      if (String(key) === String(taskId)) {
        try {
          pending.resolve('terminate');
        } catch { }
        delete pendingOllamaFallbacksRef.current[key];
      }
    }

    // 4. If there is any pending human input waiting, reject/cancel it
    for (const [key, pending] of Object.entries(pendingHumanInputsRef.current)) {
      if (String(key) === String(taskId)) {
        try {
          pending.resolve('');
        } catch { }
        delete pendingHumanInputsRef.current[key];
      }
    }

    // 5. Terminate server-side PTY process (CLI agent, node, gemini, etc.)
    try {
      fetch(bridgeClient.getApiUrl('/api/pty/kill'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: String(taskId), sessionId: String(taskId) }),
      }).catch((err) => console.warn('[Ergo] PTY kill fetch failed:', err));
    } catch { }

    // Mark active terminal session for this task as inactive
    setTerminalSessions((prev) =>
      prev.map((s) =>
        String(s.session.taskId) === String(taskId)
          ? { ...s, session: { ...s.session, isActive: false, exitCode: -1 } }
          : s
      )
    );

    // 6. Clear executing task id and remove from queue
    setExecutingTaskId((cur) => (cur !== null && String(cur) === String(taskId) ? null : cur));
    setQueuedTaskIds((prev) => prev.filter((id) => String(id) !== String(taskId)));
    queuedTaskIdsRef.current = queuedTaskIdsRef.current.filter((id) => String(id) !== String(taskId));

    // Update running job status to cancelled
    setRunningJobs((prev) => {
      const updated = prev.map((j) =>
        String(j.taskId) === String(taskId)
          ? { ...j, status: 'cancelled' as const, completedAt: new Date().toISOString() }
          : j
      );
      runningJobsRef.current = updated;
      persistRunningJobsDoc(updated, queuedTaskIdsRef.current, briefsRef.current, taskExecutionStepsRef.current);
      return updated;
    });

    // Cancel running step in execution steps
    setTaskExecutionSteps((prev) => {
      const steps = prev[taskId] || prev[String(taskId)] || [];
      const nextSteps = steps.map((s) =>
        s.status === 'running'
          ? { ...s, status: 'cancelled' as const, detail: 'Task execution terminated by user.' }
          : s
      );
      const nextRecord = { ...prev, [taskId]: nextSteps };
      taskExecutionStepsRef.current = nextRecord;
      return nextRecord;
    });

    // 7. Update task status from in_progress back to partly_done
    setTasks((prevTasks) => {
      const updated = prevTasks.map((t) =>
        String(t.id) === String(taskId)
          ? { ...t, status: 'partly_done' as TaskStatus, isDone: false }
          : t
      );
      const updatedBriefs = briefs.map((b) =>
        (b.sourceTaskId != null && String(b.sourceTaskId) === String(taskId)) ||
          (b.id != null && String(b.id) === String(taskId))
          ? { ...b, status: 'partly_done' as TaskStatus }
          : b
      );
      syncAndSaveProject(updated, updatedBriefs, true);
      setBriefs(updatedBriefs);
      return updated;
    });

    // 8. Clean up pending UI prompts and toasts
    handleDismissToast(`perm-toast-${taskId}`);
    handleDismissToast(`ollama-toast-${taskId}`);
    setPendingOllamaFallbacks((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (String(k) === String(taskId)) delete next[k];
      }
      return next;
    });
    setPendingPermissions((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (String(k) === String(taskId)) delete next[k];
      }
      return next;
    });
    setPendingHumanInputs((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (String(k) === String(taskId)) delete next[k];
      }
      return next;
    });
  }, [briefs, handleDismissToast, pendingPermissions, syncAndSaveProject]);

  const handlePermissionChoice = (taskId: string | number, approved: boolean) => {
    handleDismissToast(`perm-toast-${taskId}`);

    let pending: { prompt: McpToolPermissionPrompt; resolve: (approved: boolean) => void } | undefined;
    for (const [key, val] of Object.entries(pendingPermissionsRef.current)) {
      if (String(key) === String(taskId)) {
        pending = val;
        delete pendingPermissionsRef.current[key];
        break;
      }
    }
    if (!pending) {
      for (const [key, val] of Object.entries(pendingPermissions)) {
        if (String(key) === String(taskId)) {
          pending = val;
          break;
        }
      }
    }

    if (pending) {
      pending.resolve(approved);
    }

    setPendingPermissions((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (String(k) === String(taskId)) delete next[k];
      }
      return next;
    });
  };

  const handleHumanInputChoice = (taskId: string | number, answer: string) => {
    let pending: { prompt: HumanInputPrompt; resolve: (answer: string) => void } | undefined;
    for (const [key, val] of Object.entries(pendingHumanInputsRef.current)) {
      if (String(key) === String(taskId)) {
        pending = val;
        delete pendingHumanInputsRef.current[key];
        break;
      }
    }
    if (!pending) {
      for (const [key, val] of Object.entries(pendingHumanInputs)) {
        if (String(key) === String(taskId)) {
          pending = val;
          break;
        }
      }
    }

    if (pending) {
      pending.resolve(answer);
    }

    setPendingHumanInputs((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (String(k) === String(taskId)) delete next[k];
      }
      return next;
    });
  };

  const handleOllamaFallbackChoice = (taskId: string | number, choice: OllamaFallbackChoice) => {
    handleDismissToast(`ollama-toast-${taskId}`);

    // If terminate, abort agent execution immediately
    if (choice === 'terminate') {
      handleTerminateAgent(taskId);
      return;
    }

    let pending: { prompt: OllamaFallbackPrompt; resolve: (choice: OllamaFallbackChoice) => void } | undefined;
    for (const [key, val] of Object.entries(pendingOllamaFallbacksRef.current)) {
      if (String(key) === String(taskId)) {
        pending = val;
        delete pendingOllamaFallbacksRef.current[key];
        break;
      }
    }
    if (!pending) {
      for (const [key, val] of Object.entries(pendingOllamaFallbacks)) {
        if (String(key) === String(taskId)) {
          pending = val;
          break;
        }
      }
    }

    if (pending) {
      // Find existing cloud key if available
      const cloudKey = userApiKeys.find((k) => k.provider !== 'ollama' && k.provider !== 'none' && k.provider !== 'mock');
      if (cloudKey) {
        handleSelectUserKey(cloudKey.id);
      } else {
        // Open credentials modal so user can configure / connect cloud provider
        setIsAiScreenOpen(true);
      }
      pending.resolve('switch_cloud');
    }

    setPendingOllamaFallbacks((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (String(k) === String(taskId)) delete next[k];
      }
      return next;
    });
  };

  // Trigger In-Place Task Execution
  // If a CLI agent is configured, spawn a terminal session inside the Build & Verification card.
  // Otherwise, run executeTaskWithAi in place and stream logs directly into Build & Verification and Completion.
  const handleExecuteTask = async (task: TaskItem) => {
    setSelectedTaskId(task.id);

    const activeKey = userApiKeys.find((k) => k.id === activeKeyId);
    const effectiveCli = getEffectiveCliAgent(activeKey, cliAgentConfig);

    // If using in-place AI execution (no CLI agent configured), verify active AI configuration
    if (!effectiveCli?.command) {
      const pMeta = activeKey ? SUPPORTED_AI_PROVIDERS.find((p) => p.id === activeKey.provider) : undefined;
      const requiresKey = pMeta ? pMeta.requiresKey !== false : true;
      const isSubscription =
        activeKey?.authMode === 'cli_subscription' ||
        activeKey?.apiKey === 'cli_subscription_active' ||
        activeKey?.provider === 'cli_subscription';
      const hasValidKey = !!(
        activeKey &&
        (isSubscription || !requiresKey || (activeKey.apiKey && activeKey.apiKey.trim().length > 0))
      );

      if (!hasValidKey) {
        showToast({
          type: 'warning',
          title: 'AI API Key Required',
          message: 'No active AI provider or API key selected. Please select or add an AI provider configuration to execute tasks with AI.',
          actionLabel: 'Set Up Key',
          onAction: () => setIsAiScreenOpen(true),
          duration: 6000,
        });
        return;
      }
    }

    if (effectiveCli?.command) {
      setExecutingTaskId(task.id);

      // Remove from queued tasks
      setQueuedTaskIds((prev) => prev.filter((id) => String(id) !== String(task.id)));
      queuedTaskIdsRef.current = queuedTaskIdsRef.current.filter((id) => String(id) !== String(task.id));

      // Resolve working directory: use the project folder path or home
      const cwd = activeProject?.folderPath
        ? (storageManager as any).resolvedStoragePath
          ? `${(storageManager as any).resolvedStoragePath}/${activeProject.folderPath}`
          : activeProject.folderPath
        : '~';

      let currentBrief = briefs.find(
        (b) =>
          (b.sourceTaskId != null && String(b.sourceTaskId) === String(task.id)) ||
          b.title.trim().toLowerCase() === task.title.trim().toLowerCase() ||
          String(b.itemNumber) === String(task.id)
      );

      const existingOverviewText = (currentBrief?.overview || currentBrief?.brief || '').trim();
      const hasValidOverview = Boolean(
        existingOverviewText.length > 30 &&
        !existingOverviewText.startsWith(`Overview for ${task.title}`) &&
        existingOverviewText !== task.title.trim()
      );

      // If task does not yet have an Overview, synthesize it with AI first so Card 2 is populated
      if (!hasValidOverview) {
        const overviewSteps: ExecutionStep[] = [
          {
            id: `step-ctx-${task.id}-${Date.now()}`,
            taskId: task.id,
            time: new Date().toLocaleTimeString(),
            stage: 'context',
            title: 'Context Assembly & Task Spec',
            detail: `Assembled task brief, acceptance criteria, and workspace context for "${task.title}".`,
            status: 'success',
          },
          {
            id: `step-overview-${task.id}-${Date.now()}`,
            taskId: task.id,
            time: new Date().toLocaleTimeString(),
            stage: 'overview',
            agentRole: 'summary',
            title: 'Summary AI: Building Task Overview & Acceptance Criteria',
            detail: `Synthesizing task overview, acceptance criteria, and workspace context for "${task.title}"...`,
            status: 'running',
          },
        ];
        setTaskExecutionSteps((prev) => ({
          ...prev,
          [task.id]: overviewSteps,
        }));

        try {
          const syncedOverview = await syncTaskOverviewWithAi(
            task,
            existingOverviewText,
            activeProject,
            aiConfig,
            mcpServers,
            serializeTodoMarkdown(tasks, headerComments, archivedTasks),
            serializeAgentContextMarkdown(briefs, archivedBriefs)
          );

          const updatedBrief: AgentContextItem = {
            ...currentBrief,
            id: currentBrief?.id || `brief_${task.id}`,
            sourceTaskId: task.id,
            sourceLaneId: task.swimLaneId || currentBrief?.sourceLaneId,
            itemNumber: currentBrief?.itemNumber,
            title: task.title,
            status: 'in_progress',
            overview: syncedOverview,
            buildAndVerification: currentBrief?.buildAndVerification || currentBrief?.built || '',
            completion: currentBrief?.completion || currentBrief?.validation || currentBrief?.humanReview || currentBrief?.followUps || '',
            brief: syncedOverview,
            built: currentBrief?.built || '',
            validation: currentBrief?.validation || '',
            humanReview: currentBrief?.humanReview || '',
            followUps: currentBrief?.followUps || '',
          };

          const existingIdx = briefs.findIndex(
            (b) =>
              (b.id && b.id === updatedBrief.id) ||
              (b.sourceTaskId && updatedBrief.sourceTaskId && b.sourceTaskId === updatedBrief.sourceTaskId) ||
              b.title.trim().toLowerCase() === updatedBrief.title.trim().toLowerCase()
          );
          const nextBriefs = existingIdx !== -1
            ? briefs.map((b, idx) => (idx === existingIdx ? updatedBrief : b))
            : [...briefs, updatedBrief];

          syncAndSaveProject(tasks, nextBriefs, false);
          currentBrief = updatedBrief;
        } catch (err) {
          console.warn('[Ergo CLI Task] Overview generation error, continuing with fallback:', err);
        }
      }

      // Collect API keys to pass to the spawned CLI agent process environment
      const env: Record<string, string> = {};
      if (activeKey?.apiKey && activeKey.apiKey !== 'cli_subscription_active') {
        if (activeKey.provider === 'anthropic' || effectiveCli.command.includes('claude')) {
          env.ANTHROPIC_API_KEY = activeKey.apiKey.trim();
        } else if (activeKey.provider === 'openai' || effectiveCli.command.includes('codex')) {
          env.OPENAI_API_KEY = activeKey.apiKey.trim();
        } else if (activeKey.provider === 'gemini' || effectiveCli.command.includes('agy')) {
          env.GEMINI_API_KEY = activeKey.apiKey.trim();
        } else if (activeKey.provider === 'grok' || effectiveCli.command.includes('grok')) {
          env.XAI_API_KEY = activeKey.apiKey.trim();
        }
      }
      if (activeKey?.providerKeys) {
        if (activeKey.providerKeys.anthropic?.apiKey) env.ANTHROPIC_API_KEY = activeKey.providerKeys.anthropic.apiKey.trim();
        if (activeKey.providerKeys.openai?.apiKey) env.OPENAI_API_KEY = activeKey.providerKeys.openai.apiKey.trim();
        if (activeKey.providerKeys.gemini?.apiKey) env.GEMINI_API_KEY = activeKey.providerKeys.gemini.apiKey.trim();
        if (activeKey.providerKeys.grok?.apiKey) env.XAI_API_KEY = activeKey.providerKeys.grok.apiKey.trim();
      }

      // Check all configured userApiKeys for any provider keys not yet filled
      for (const k of userApiKeys) {
        if (k.apiKey && k.apiKey !== 'cli_subscription_active') {
          if (k.provider === 'anthropic' && !env.ANTHROPIC_API_KEY) {
            env.ANTHROPIC_API_KEY = k.apiKey.trim();
          } else if (k.provider === 'openai' && !env.OPENAI_API_KEY) {
            env.OPENAI_API_KEY = k.apiKey.trim();
          } else if (k.provider === 'gemini' && !env.GEMINI_API_KEY) {
            env.GEMINI_API_KEY = k.apiKey.trim();
          } else if (k.provider === 'grok' && !env.XAI_API_KEY) {
            env.XAI_API_KEY = k.apiKey.trim();
          }
        }
        if (k.providerKeys) {
          if (k.providerKeys.anthropic?.apiKey && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = k.providerKeys.anthropic.apiKey.trim();
          if (k.providerKeys.openai?.apiKey && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = k.providerKeys.openai.apiKey.trim();
          if (k.providerKeys.gemini?.apiKey && !env.GEMINI_API_KEY) env.GEMINI_API_KEY = k.providerKeys.gemini.apiKey.trim();
          if (k.providerKeys.grok?.apiKey && !env.XAI_API_KEY) env.XAI_API_KEY = k.providerKeys.grok.apiKey.trim();
        }
      }

      const hasApiKeyForCli = Boolean(
        (effectiveCli.command.includes('claude') && env.ANTHROPIC_API_KEY) ||
        (effectiveCli.command.includes('codex') && env.OPENAI_API_KEY) ||
        (effectiveCli.command.includes('agy') && env.GEMINI_API_KEY) ||
        (effectiveCli.command.includes('grok') && env.XAI_API_KEY)
      );

      const prompt = buildTaskCliPrompt(task, currentBrief);
      const args = buildCliArgsForTask(effectiveCli.command, effectiveCli.extraArgs, prompt, hasApiKeyForCli);

      // Ensure any lingering background PTY process for this task is cleanly killed
      try {
        fetch(bridgeClient.getApiUrl('/api/pty/kill'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: String(task.id), sessionId: String(task.id) }),
        }).catch(() => { });
      } catch { }

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
        cmd: effectiveCli.command,
        args,
        env,
        forceRestart: true,
      };

      setTerminalSessions((prev) => {
        // Replace any existing session for this task
        const filtered = prev.filter((s) => s.session.taskId !== task.id);
        return [...filtered, spawned];
      });

      setActiveTerminalTaskId(task.id);

      // Register or update CLI job in running jobs
      const newCliJob: RunningJobInfo = {
        id: `job_cli_${task.id}_${Date.now()}`,
        taskId: task.id,
        taskTitle: task.title,
        type: 'cli',
        status: 'in_progress',
        startedAt: new Date().toISOString(),
        sessionId: String(task.id),
        cmd: effectiveCli.command,
        args,
        cwd,
      };

      // Initialize workflow steps for the CLI agent
      const initialCliSteps: ExecutionStep[] = [
        {
          id: `step-ctx-${task.id}-${Date.now()}`,
          taskId: task.id,
          time: new Date().toLocaleTimeString(),
          stage: 'context',
          title: 'Context Assembly & Task Spec',
          detail: `Assembled task brief, acceptance criteria, and workspace context for "${task.title}".`,
          status: 'success',
        },
        {
          id: `step-overview-${task.id}-${Date.now()}`,
          taskId: task.id,
          time: new Date().toLocaleTimeString(),
          stage: 'overview',
          agentRole: 'summary',
          title: 'Task Overview & Acceptance Spec',
          detail: `Synthesized task overview, objectives, and acceptance criteria.`,
          status: 'success',
        },
        {
          id: `step-manager-${task.id}-${Date.now()}`,
          taskId: task.id,
          time: new Date().toLocaleTimeString(),
          stage: 'execution',
          agentRole: 'manager',
          title: `Manager Agent Execution (${effectiveCli.name || effectiveCli.command})`,
          detail: `Running command: \`${effectiveCli.command} ${args.slice(0, 2).join(' ')}...\` in \`${cwd}\`.\nTask prompt dispatched. Watching live manager agent execution...`,
          status: 'running',
        },
      ];

      setTaskExecutionSteps((prev) => {
        const next = { ...prev, [task.id]: initialCliSteps };
        taskExecutionStepsRef.current = next;
        return next;
      });

      setRunningJobs((prev) => {
        const filtered = prev.filter((j) => String(j.taskId) !== String(task.id));
        const updated = [...filtered, newCliJob];
        runningJobsRef.current = updated;
        persistRunningJobsDoc(updated, queuedTaskIdsRef.current, briefsRef.current, taskExecutionStepsRef.current);
        return updated;
      });

      // Update task status to in_progress if not already done
      if (!task.isDone && task.status !== 'done') {
        const nextTasks = tasks.map((t) => (t.id === task.id ? { ...t, status: 'in_progress' as const } : t));
        syncAndSaveProject(nextTasks, briefs, true);
      }
    } else {
      // In-Place AI Task Execution
      setExecutingTaskId(task.id);

      // Remove from queued tasks
      setQueuedTaskIds((prev) => prev.filter((id) => String(id) !== String(task.id)));
      queuedTaskIdsRef.current = queuedTaskIdsRef.current.filter((id) => String(id) !== String(task.id));

      // Register in-place job in running jobs
      const newInPlaceJob: RunningJobInfo = {
        id: `job_ai_${task.id}_${Date.now()}`,
        taskId: task.id,
        taskTitle: task.title,
        type: 'in_place',
        status: 'in_progress',
        startedAt: new Date().toISOString(),
      };

      setRunningJobs((prev) => {
        const filtered = prev.filter((j) => String(j.taskId) !== String(task.id));
        const updated = [...filtered, newInPlaceJob];
        runningJobsRef.current = updated;
        persistRunningJobsDoc(updated, queuedTaskIdsRef.current, briefsRef.current, taskExecutionStepsRef.current);
        return updated;
      });

      const currentTask = tasks.find((t) => String(t.id) === String(task.id)) || task;
      const currentBrief = briefs.find(
        (b) =>
          (b.sourceTaskId != null && String(b.sourceTaskId) === String(task.id)) ||
          b.title.trim().toLowerCase() === task.title.trim().toLowerCase() ||
          String(b.itemNumber) === String(task.id)
      );

      const isResuming = currentTask.status === 'partly_done' ||
        (currentBrief && (currentBrief.status === 'partly_done' || Boolean(currentBrief.buildAndVerification && currentBrief.buildAndVerification.trim().length > 0)));

      setTaskExecutionSteps((prev) => {
        const existing = prev[task.id] || prev[String(task.id)] || [];
        if (isResuming && existing.length > 0) {
          const priorCleaned = existing.map((s) => (s.status === 'running' ? { ...s, status: 'cancelled' as const } : s));
          return {
            ...prev,
            [task.id]: [
              ...priorCleaned,
              {
                id: `step-resume-${Date.now()}`,
                stage: 'context' as const,
                title: 'Resuming Task Execution',
                detail: 'Picking back up with the task where it was left off…',
                status: 'running' as const,
                time: new Date().toLocaleTimeString(),
                taskId: task.id,
              } as ExecutionStep
            ]
          };
        }
        return { ...prev, [task.id]: [] };
      });

      // Set task status to in_progress
      const inProgressTasks = tasks.map((t) => (String(t.id) === String(task.id) ? { ...t, status: 'in_progress' as const } : t));
      setTasks(inProgressTasks);

      let controller: AbortController | null = null;
      try {
        // Create a new AbortController for this execution so the user can terminate it
        controller = new AbortController();
        abortControllersRef.current.set(task.id, controller);

        const res = await executeTaskWithAi(
          currentTask,
          currentBrief,
          activeProject,
          aiConfig,
          mcpServers,
          (stepUpdate) => {
            setTaskExecutionSteps((prev) => {
              const existing = prev[task.id] || prev[String(task.id)] || [];
              const idx = existing.findIndex((s) => s.id === stepUpdate.id);
              let next: ExecutionStep[];
              if (idx !== -1) {
                next = [...existing];
                next[idx] = stepUpdate;
              } else {
                next = [...existing, stepUpdate];
              }
              // If a resume step was running and this new step started, mark the resume step as success
              if (!stepUpdate.id.startsWith('step-resume-')) {
                next = next.map((s) =>
                  s.id.startsWith('step-resume-') && s.status === 'running'
                    ? { ...s, status: 'success' as const }
                    : s
                );
              }
              if (stepUpdate.status === 'error' || stepUpdate.status === 'cancelled') {
                next = next.map((s) =>
                  s.id !== stepUpdate.id && s.status === 'running'
                    ? { ...s, status: stepUpdate.status === 'cancelled' ? 'cancelled' : 'error' }
                    : s
                );
              }
              const nextRecord = { ...prev, [task.id]: next };
              taskExecutionStepsRef.current = nextRecord;

              // Debounce persisting execution steps to RUNNING_JOBS.json
              if (stepSaveTimerRef.current) {
                clearTimeout(stepSaveTimerRef.current);
              }
              stepSaveTimerRef.current = setTimeout(() => {
                persistRunningJobsDoc(undefined, undefined, undefined, nextRecord);
              }, 600);

              return nextRecord;
            });

            // If Summary AI finished with an overview document, populate the live brief immediately
            if (stepUpdate.stage === 'overview' && stepUpdate.status === 'success' && stepUpdate.overviewDocument) {
              const generatedMarkdown = formatOverviewDocToMarkdown(stepUpdate.overviewDocument);
              const gherkinText = stepUpdate.overviewDocument.brief || '';
              if (generatedMarkdown || gherkinText) {
                setBriefs((prevBriefs) =>
                  prevBriefs.map((b) =>
                    (b.sourceTaskId != null && b.sourceTaskId === task.id) ||
                      b.title.trim().toLowerCase() === task.title.trim().toLowerCase() ||
                      b.itemNumber === task.id
                      ? { ...b, overview: generatedMarkdown || b.overview, brief: gherkinText || b.brief }
                      : b
                  )
                );
              }
            }
          },
          (permissionPrompt) => {
            const toastId = `perm-toast-${task.id}`;
            return new Promise<boolean>((resolve) => {
              const wrappedResolve = (approved: boolean) => {
                handleDismissToast(toastId);
                delete pendingPermissionsRef.current[task.id];
                resolve(approved);
              };

              pendingPermissionsRef.current[task.id] = { prompt: permissionPrompt, resolve: wrappedResolve };
              setPendingPermissions((prev) => ({
                ...prev,
                [task.id]: { prompt: permissionPrompt, resolve: wrappedResolve },
              }));

              showToast({
                id: toastId,
                type: 'warning',
                title: 'Permission Required',
                message: `Task "${task.title}": Agent requests permission to execute ${permissionPrompt.serverName} / ${permissionPrompt.toolName}()`,
                duration: 0,
                actions: [
                  {
                    label: 'Skip / Reject',
                    variant: 'secondary',
                    onClick: () => handlePermissionChoice(task.id, false),
                  },
                  {
                    label: 'Approve',
                    variant: 'emerald',
                    onClick: () => handlePermissionChoice(task.id, true),
                  },
                ],
              });
            });
          },
          (humanInputPrompt) => {
            return new Promise<string>((resolve) => {
              const wrappedResolve = (answer: string) => {
                delete pendingHumanInputsRef.current[task.id];
                resolve(answer);
              };
              pendingHumanInputsRef.current[task.id] = { prompt: humanInputPrompt, resolve: wrappedResolve };
              setPendingHumanInputs((prev) => ({
                ...prev,
                [task.id]: { prompt: humanInputPrompt, resolve: wrappedResolve },
              }));
            });
          },
          controller.signal,
          agentPipelineOptions,
          (ollamaFallbackPrompt) => {
            const toastId = `ollama-toast-${task.id}`;
            return new Promise<OllamaFallbackChoice>((resolve) => {
              const wrappedResolve = (choice: OllamaFallbackChoice) => {
                handleDismissToast(toastId);
                delete pendingOllamaFallbacksRef.current[task.id];
                resolve(choice);
              };

              pendingOllamaFallbacksRef.current[task.id] = { prompt: ollamaFallbackPrompt, resolve: wrappedResolve };
              setPendingOllamaFallbacks((prev) => ({
                ...prev,
                [task.id]: { prompt: ollamaFallbackPrompt, resolve: wrappedResolve }
              }));

              showToast({
                id: toastId,
                type: 'error',
                title: 'Local Ollama Connection Failed',
                message: `Task "${task.title}": Ollama connection failed after ${ollamaFallbackPrompt.consecutiveFailures} attempts. You don't seem to be connected locally.`,
                duration: 0,
                actions: [
                  {
                    label: 'Terminate Task',
                    variant: 'danger',
                    onClick: () => handleOllamaFallbackChoice(task.id, 'terminate'),
                  },
                  {
                    label: 'Switch to Cloud Profile',
                    variant: 'emerald',
                    onClick: () => handleOllamaFallbackChoice(task.id, 'switch_cloud'),
                  },
                ],
              });
            });
          }
        );

        // Completed execution: apply results & persist to TODO.md and vector memory
        const nextTasks = tasks.map((t) => (String(t.id) === String(res.updatedTask.id) ? res.updatedTask : t));
        const existingBriefIdx = briefs.findIndex(
          (b) =>
            (b.id && b.id === res.updatedBrief.id) ||
            (b.sourceTaskId && res.updatedBrief.sourceTaskId && String(b.sourceTaskId) === String(res.updatedBrief.sourceTaskId)) ||
            b.title.trim().toLowerCase() === res.updatedBrief.title.trim().toLowerCase()
        );
        let nextBriefs: AgentContextItem[];
        if (existingBriefIdx !== -1) {
          nextBriefs = briefs.map((b, idx) => (idx === existingBriefIdx ? res.updatedBrief : b));
        } else {
          nextBriefs = [...briefs, res.updatedBrief];
        }

        // Update running job to completed
        setRunningJobs((prev) => {
          const updated = prev.map((j) =>
            String(j.taskId) === String(task.id)
              ? { ...j, status: 'completed' as const, completedAt: new Date().toISOString() }
              : j
          );
          runningJobsRef.current = updated;
          return updated;
        });

        syncAndSaveProject(nextTasks, nextBriefs, true);
      } catch (err) {
        console.error('Task execution error:', err);
        const isAborted = (err as any)?.name === 'AbortError' || !!controller?.signal?.aborted;

        // Update running job to cancelled or failed
        setRunningJobs((prev) => {
          const updated = prev.map((j) =>
            String(j.taskId) === String(task.id)
              ? { ...j, status: isAborted ? ('cancelled' as const) : ('failed' as const), completedAt: new Date().toISOString() }
              : j
          );
          runningJobsRef.current = updated;
          return updated;
        });
        if (isAborted) {
          setTasks((prevTasks) => {
            const nextTasks = prevTasks.map((t) =>
              String(t.id) === String(task.id)
                ? { ...t, status: 'partly_done' as TaskStatus, isDone: false }
                : t
            );
            const nextBriefs = briefs.map((b) =>
              (b.sourceTaskId != null && String(b.sourceTaskId) === String(task.id)) ||
                (b.id != null && String(b.id) === String(task.id))
                ? { ...b, status: 'partly_done' as TaskStatus }
                : b
            );
            syncAndSaveProject(nextTasks, nextBriefs, true);
            setBriefs(nextBriefs);
            return nextTasks;
          });
          setTaskExecutionSteps((prev) => {
            const steps = prev[task.id] || [];
            const nextSteps = steps.map((s) =>
              s.status === 'running'
                ? { ...s, status: 'cancelled' as const, detail: 'Task execution terminated by user.' }
                : s
            );
            return { ...prev, [task.id]: nextSteps };
          });
        }
      } finally {
        handleDismissToast(`perm-toast-${task.id}`);
        handleDismissToast(`ollama-toast-${task.id}`);
        abortControllersRef.current.delete(task.id);
        delete pendingPermissionsRef.current[task.id];
        delete pendingHumanInputsRef.current[task.id];
        delete pendingOllamaFallbacksRef.current[task.id];
        setExecutingTaskId((cur) => (cur !== null && String(cur) === String(task.id) ? null : cur));
        setPendingHumanInputs((prev) => {
          const next = { ...prev };
          delete next[task.id];
          return next;
        });
        setPendingOllamaFallbacks((prev) => {
          const next = { ...prev };
          delete next[task.id];
          return next;
        });
        setPendingPermissions((prev) => {
          const next = { ...prev };
          delete next[task.id];
          return next;
        });
      }
    }
  };

  const handleSessionExit = (taskId: string | number, code: number) => {
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
        const existingBrief = briefs.find(
          (b) =>
            (b.sourceTaskId != null && b.sourceTaskId === taskId) ||
            b.title.trim().toLowerCase() === task.title.trim().toLowerCase()
        );
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
            id: `brief_${taskId}`,
            sourceTaskId: taskId,
            title: task.title,
            status: 'done',
            overview: `Task (${task.title})`,
            buildAndVerification: `Executed in CLI agent terminal.`,
            completion: completionText,
          };

        const existingIdx = briefs.findIndex(
          (b) =>
            (b.id && b.id === updatedBrief.id) ||
            (b.sourceTaskId != null && b.sourceTaskId === taskId) ||
            b.title.trim().toLowerCase() === task.title.trim().toLowerCase()
        );
        let nextBriefs: AgentContextItem[];
        if (existingIdx !== -1) {
          nextBriefs = briefs.map((b, idx) => (idx === existingIdx ? updatedBrief : b));
        } else {
          nextBriefs = [...briefs, updatedBrief];
        }

        syncAndSaveProject(nextTasks, nextBriefs, true);

        // Persist concise completion output & learnings directly to local vector memory
        void runSessionRetrospective({
          taskId,
          taskTitle: task.title,
          projectId: activeProjectId,
          overview: updatedBrief.overview || '',
          buildLog: updatedBrief.buildAndVerification || '',
          completion: completionText,
          createdFiles: updatedBrief.createdFiles || [],
          allScenariosPass: true,
        });
      }
    }

    // Update execution steps
    setTaskExecutionSteps((prev) => {
      const existing = prev[taskId] || prev[String(taskId)] || [];
      if (existing.length === 0) return prev;
      const updated = existing.map((s) => {
        if (s.agentRole === 'manager' || s.id.includes('step-manager-') || s.stage === 'execution') {
          return {
            ...s,
            status: code === 0 ? ('success' as const) : ('error' as const),
            detail:
              code === 0
                ? `${s.detail}\n\n✓ Manager agent completed task execution successfully (exit code 0).`
                : `${s.detail}\n\n✗ CLI agent process terminated with exit code ${code}.`,
          };
        }
        return s;
      });

      if (code === 0 && !updated.some((s) => s.stage === 'verify')) {
        updated.push({
          id: `step-verify-${taskId}-${Date.now()}`,
          taskId,
          time: new Date().toLocaleTimeString(),
          stage: 'verify',
          title: 'Verification & Task Completion',
          detail: 'Task execution completed successfully with exit code 0. Status updated to Done.',
          status: 'success',
        });
      }

      taskExecutionStepsRef.current = {
        ...taskExecutionStepsRef.current,
        [taskId]: updated,
      };
      return {
        ...prev,
        [taskId]: updated,
      };
    });

    setExecutingTaskId((prev) => (String(prev) === String(taskId) ? null : prev));

    // Update running job status
    setRunningJobs((prev) => {
      const updated = prev.map((j) =>
        String(j.taskId) === String(taskId)
          ? {
            ...j,
            status: code === 0 ? ('completed' as const) : ('failed' as const),
            completedAt: new Date().toISOString(),
          }
          : j
      );
      runningJobsRef.current = updated;
      persistRunningJobsDoc(updated, undefined, undefined, taskExecutionStepsRef.current);
      return updated;
    });
  };

  const handleKillSession = async (taskId: string | number) => {
    await handleTerminateAgent(taskId);
  };

  // Immediate Save Brief Edits
  const handleSaveBrief = (updatedBrief: AgentContextItem) => {
    const existingIdx = briefs.findIndex(
      (b) =>
        (b.id && b.id === updatedBrief.id) ||
        (b.sourceTaskId && updatedBrief.sourceTaskId && b.sourceTaskId === updatedBrief.sourceTaskId) ||
        b.title.trim().toLowerCase() === updatedBrief.title.trim().toLowerCase()
    );
    let nextBriefs: AgentContextItem[];
    if (existingIdx !== -1) {
      nextBriefs = briefs.map((b, idx) => (idx === existingIdx ? updatedBrief : b));
    } else {
      nextBriefs = [...briefs, updatedBrief];
    }
    syncAndSaveProject(tasks, nextBriefs, true);
  };

  // Helper to ensure an array of tasks have AI execution cards / briefs in AI Workspace
  const ensureBriefsForTasks = (
    taskList: TaskItem[],
    laneId: string,
    laneTitle: string
  ): AgentContextItem[] => {
    let currentBriefsList = [...briefs];
    let maxNumber = currentBriefsList.length > 0 ? Math.max(...currentBriefsList.map((b) => b.itemNumber || 0)) : 0;

    for (const item of taskList) {
      const existingIdx = currentBriefsList.findIndex(
        (b) =>
          (b.sourceTaskId != null && b.sourceTaskId === item.id) ||
          b.title.trim().toLowerCase() === item.title.trim().toLowerCase()
      );

      let contextText = item.title;
      if (item.subtasks && item.subtasks.length > 0) {
        contextText += '\n' + item.subtasks.map((st) => `- ${st.text}`).join('\n');
      }

      if (existingIdx === -1) {
        maxNumber += 1;
        const newBrief: AgentContextItem = {
          id: `brief_${item.id}`,
          sourceTaskId: item.id,
          sourceLaneId: laneId,
          sourceLaneTitle: laneTitle,
          itemNumber: maxNumber,
          title: item.title,
          status: item.status || 'not_started',
          overview: contextText,
          buildAndVerification: '',
          completion: '',
          brief: contextText,
          built: '',
          validation: '',
        };
        currentBriefsList.push(newBrief);
      }
    }

    syncAndSaveProject(tasks, currentBriefsList, true);
    return currentBriefsList;
  };

  // Run tasks sequentially one after another
  const handleRunTasksSequence = async (
    taskList: TaskItem[],
    laneId: string,
    laneTitle: string
  ) => {
    if (!taskList || taskList.length === 0) return;

    // Ensure AI Workspace panel is open so user sees the task execution cards
    setIsAiPanelOpen(true);
    const updatedBriefs = ensureBriefsForTasks(taskList, laneId, laneTitle);

    const allIds = taskList.map((t) => t.id);
    const initialQueued = allIds.slice(1);
    setQueuedTaskIds(initialQueued);
    queuedTaskIdsRef.current = initialQueued;

    // Create or update initial runningJobs entries
    const initialJobs: RunningJobInfo[] = taskList.map((t, idx) => ({
      id: `job_${t.id}_${Date.now()}_${idx}`,
      taskId: t.id,
      taskTitle: t.title,
      type: cliAgentConfig?.command ? 'cli' : 'in_place',
      status: idx === 0 ? 'in_progress' : 'queued',
      startedAt: new Date().toISOString(),
      laneId,
      laneTitle,
    }));

    setRunningJobs((prev) => {
      const existingIds = new Set(initialJobs.map((j) => String(j.taskId)));
      const filtered = prev.filter((j) => !existingIds.has(String(j.taskId)));
      const combined = [...filtered, ...initialJobs];
      runningJobsRef.current = combined;
      persistRunningJobsDoc(combined, initialQueued, updatedBriefs, taskExecutionStepsRef.current);
      return combined;
    });

    showToast({
      type: 'info',
      title: 'Sequential Execution Started',
      message: `Running ${taskList.length} tasks in sequence.`,
      duration: 3500,
    });

    for (let i = 0; i < taskList.length; i++) {
      const task = taskList[i];
      const remainingQueued = allIds.slice(i + 1);
      setQueuedTaskIds(remainingQueued);
      queuedTaskIdsRef.current = remainingQueued;

      // Update this job to in_progress if not already
      setRunningJobs((prev) => {
        const updated = prev.map((j) =>
          String(j.taskId) === String(task.id)
            ? { ...j, status: 'in_progress' as const }
            : remainingQueued.map(String).includes(String(j.taskId))
              ? { ...j, status: 'queued' as const }
              : j
        );
        runningJobsRef.current = updated;
        persistRunningJobsDoc(updated, remainingQueued, briefsRef.current, taskExecutionStepsRef.current);
        return updated;
      });

      // Check if user terminated everything
      try {
        await handleExecuteTask(task);
      } catch (err) {
        console.error(`[Sequence] Error running task ${task.title}:`, err);
      }
    }

    setQueuedTaskIds([]);
    queuedTaskIdsRef.current = [];
    persistRunningJobsDoc(undefined, [], undefined, undefined);
  };

  // Run tasks in parallel / concurrently (agentic mode)
  const handleRunTasksParallel = async (
    taskList: TaskItem[],
    laneId: string,
    laneTitle: string
  ) => {
    if (!taskList || taskList.length === 0) return;

    // Ensure AI Workspace panel is open so user sees all task execution cards
    setIsAiPanelOpen(true);
    const updatedBriefs = ensureBriefsForTasks(taskList, laneId, laneTitle);

    setQueuedTaskIds([]);
    queuedTaskIdsRef.current = [];

    const parallelJobs: RunningJobInfo[] = taskList.map((t, idx) => ({
      id: `job_parallel_${t.id}_${Date.now()}_${idx}`,
      taskId: t.id,
      taskTitle: t.title,
      type: cliAgentConfig?.command ? 'cli' : 'in_place',
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      laneId,
      laneTitle,
    }));

    setRunningJobs((prev) => {
      const existingIds = new Set(parallelJobs.map((j) => String(j.taskId)));
      const filtered = prev.filter((j) => !existingIds.has(String(j.taskId)));
      const combined = [...filtered, ...parallelJobs];
      runningJobsRef.current = combined;
      persistRunningJobsDoc(combined, [], updatedBriefs, taskExecutionStepsRef.current);
      return combined;
    });

    showToast({
      type: 'info',
      title: 'Parallel Execution Started',
      message: `Running ${taskList.length} tasks in parallel agentically.`,
      duration: 3500,
    });

    await Promise.allSettled(
      taskList.map((task) => handleExecuteTask(task))
    );

    persistRunningJobsDoc(undefined, [], undefined, undefined);
  };


  // Archive Task Handler (Moves task and corresponding brief into archive section immediately)
  // Takes the live title string read from the editor node, matching by title is immune to stale indices.
  const handleArchiveTask = (taskTitleOrId: string | number) => {
    if (!taskTitleOrId && taskTitleOrId !== 0) return;
    const rawStr = String(taskTitleOrId).trim();
    const cleanedTitle = cleanAndUnescapeMarkdown(rawStr).toLowerCase();
    const rawLower = rawStr.toLowerCase();

    // Match task by id, cleaned title, or raw title
    const taskToArchive = tasks.find(
      (t) =>
        String(t.id) === rawStr ||
        t.title.trim().toLowerCase() === cleanedTitle ||
        t.title.trim().toLowerCase() === rawLower ||
        cleanAndUnescapeMarkdown(t.title).trim().toLowerCase() === cleanedTitle
    );

    const matchingBrief = briefs.find(
      (b) =>
        (taskToArchive && (b.sourceTaskId === taskToArchive.id || String(b.sourceTaskId) === String(taskToArchive.id))) ||
        String(b.id) === rawStr ||
        String(b.itemNumber) === rawStr ||
        (taskToArchive && b.title.trim().toLowerCase() === taskToArchive.title.trim().toLowerCase()) ||
        (taskToArchive && cleanAndUnescapeMarkdown(b.title).trim().toLowerCase() === cleanAndUnescapeMarkdown(taskToArchive.title).trim().toLowerCase()) ||
        b.title.trim().toLowerCase() === cleanedTitle ||
        b.title.trim().toLowerCase() === rawLower ||
        cleanAndUnescapeMarkdown(b.title).trim().toLowerCase() === cleanedTitle
    );

    if (!taskToArchive && !matchingBrief) return;

    const taskTitle = taskToArchive?.title || matchingBrief?.title || 'Archived Task';
    const taskIdToStore = taskToArchive?.id || matchingBrief?.sourceTaskId || matchingBrief?.id || Date.now();

    // 1. Persist concise summary & notes directly into local vector storage
    void archiveTaskToVectorMemory({
      taskId: taskIdToStore,
      taskTitle,
      category: taskToArchive?.category,
      status: taskToArchive?.status || (taskToArchive?.isDone ? 'done' : 'archived'),
      overview: matchingBrief?.overview || matchingBrief?.brief,
      completion: matchingBrief?.completion || matchingBrief?.validation,
      subtasks: taskToArchive?.subtasks,
      projectId: activeProjectId,
    });

    // 2. Remove task from active human workspace
    const nextActiveTasks = taskToArchive ? tasks.filter((t) => t !== taskToArchive) : tasks;

    // 3. Remove brief from AI workspace
    let nextActiveBriefs = briefs;
    if (matchingBrief) {
      const matchClean = cleanAndUnescapeMarkdown(matchingBrief.title).trim().toLowerCase();
      nextActiveBriefs = briefs.filter(
        (b) => b !== matchingBrief && cleanAndUnescapeMarkdown(b.title).trim().toLowerCase() !== matchClean
      );
    }

    if (
      selectedTaskId === taskToArchive?.id ||
      selectedTaskId === matchingBrief?.id ||
      selectedTaskId === matchingBrief?.sourceTaskId
    ) {
      setSelectedTaskId(
        nextActiveTasks.length > 0
          ? nextActiveTasks[0].id
          : nextActiveBriefs.length > 0
            ? nextActiveBriefs[0].sourceTaskId || nextActiveBriefs[0].id || nextActiveBriefs[0].itemNumber || null
            : null
      );
    }

    // Clean up queued and running job records
    setQueuedTaskIds((prev) => prev.filter((id) => String(id) !== String(taskIdToStore) && String(id) !== rawStr));
    queuedTaskIdsRef.current = queuedTaskIdsRef.current.filter((id) => String(id) !== String(taskIdToStore) && String(id) !== rawStr);

    setRunningJobs((prev) => {
      const updated = prev.filter((j) => String(j.taskId) !== String(taskIdToStore) && String(j.taskId) !== rawStr);
      runningJobsRef.current = updated;
      return updated;
    });

    // 4. Save clean workspace without AGENT_CONTEXT.md or <!-- ARCHIVE --> blocks
    syncAndSaveProject(nextActiveTasks, nextActiveBriefs, true);

    showToast({
      type: 'info',
      title: 'Task Archived to AI Brain',
      message: `"${taskTitle}" was removed from the workspace and safely retained in vector storage.`,
      duration: 3500,
    });
  };

  // Restore a task from Vector DB into the active workspace
  const handleRestoreMemoryAsTask = (chunk: import('./lib/memory').MemoryChunk) => {
    const rawTitle = chunk.metadata.taskTitle || chunk.text.split('\n')[0].replace(/^Task:\s*/i, '').replace(/^Archived Task:\s*/i, '').replace(/[#*`_~]/g, '').trim();
    const title = rawTitle || 'Restored Task';
    const nextId = tasks.length > 0 ? Math.max(...tasks.map((t) => (typeof t.id === 'number' ? t.id : 0))) + 1 : 1;
    const restoredLaneId = activeProject?.swimLanes?.[0]?.id || 'lane-default';

    // Parse subtasks from metadata (direct array or JSON string) or parse checklist from chunk.text
    let restoredSubtasks: Array<{ id: string; text: string; isDone: boolean; isHumanReview?: boolean }> = [];
    if (chunk.metadata.subtasks && Array.isArray(chunk.metadata.subtasks) && chunk.metadata.subtasks.length > 0) {
      restoredSubtasks = chunk.metadata.subtasks.map((st, i) => ({
        id: `${nextId}-${i + 1}`,
        text: st.text,
        isDone: !!st.isDone,
        isHumanReview: !!st.isHumanReview,
      }));
    } else if (chunk.metadata.serializedSubtasks) {
      try {
        const parsed = JSON.parse(chunk.metadata.serializedSubtasks);
        if (Array.isArray(parsed)) {
          restoredSubtasks = parsed.map((st: any, i: number) => ({
            id: `${nextId}-${i + 1}`,
            text: st.text || String(st),
            isDone: !!st.isDone,
            isHumanReview: !!st.isHumanReview,
          }));
        }
      } catch (err) {
        console.warn('[RestoreTask] Failed to parse serializedSubtasks:', err);
      }
    }

    if (restoredSubtasks.length === 0 && chunk.text) {
      // Fallback: extract subtasks from `Checklist:` or bullet lines in chunk.text
      const lines = chunk.text.split('\n');
      let inChecklist = false;
      for (const line of lines) {
        if (/^Checklist:/i.test(line.trim())) {
          inChecklist = true;
          continue;
        }
        if (inChecklist && line.trim().startsWith('##')) {
          break;
        }
        const match = line.match(/^[\s*-]*\[([ xX])\]\s*(.*)$/);
        if (match) {
          const isDone = match[1].toLowerCase() === 'x';
          const subText = match[2].trim();
          if (subText) {
            restoredSubtasks.push({
              id: `${nextId}-${restoredSubtasks.length + 1}`,
              text: subText,
              isDone,
            });
          }
        }
      }
    }

    const restoredTask: TaskItem = {
      id: nextId,
      title,
      category: chunk.metadata.category || 'General',
      listIndex: tasks.length + 1,
      listType: 'ordered',
      status: 'not_started',
      isDone: false,
      subtasks: restoredSubtasks,
      swimLaneId: restoredLaneId,
    };

    const restoredBrief: AgentContextItem = {
      id: `brief_${nextId}`,
      sourceTaskId: nextId,
      sourceLaneId: restoredLaneId,
      title,
      status: 'not_started',
      overview: chunk.text,
      buildAndVerification: '',
      completion: '',
      createdFiles: [],
    };

    const nextTasks = [...tasks, restoredTask];
    const nextBriefs = [...briefs, restoredBrief];
    setSelectedTaskId(nextId);
    syncAndSaveProject(nextTasks, nextBriefs, true);

    showToast({
      type: 'success',
      title: 'Restored to Workspace',
      message: `"${title}" has been restored to your active workspace with ${restoredSubtasks.length} subtask${restoredSubtasks.length === 1 ? '' : 's'}.`,
      duration: 3000,
    });
  };

  // Remove AI Task Handler (Removes unstarted task from AI workspace without touching human workspace)
  const handleRemoveAiTask = (targetId: string | number) => {
    const briefToRemove = briefs.find(
      (b) =>
        b.id === targetId ||
        b.sourceTaskId === targetId ||
        b.itemNumber === targetId ||
        String(b.sourceTaskId) === String(targetId) ||
        String(b.id) === String(targetId) ||
        String(b.itemNumber) === String(targetId)
    );
    if (!briefToRemove) return;

    const nextBriefs = briefs.filter(
      (b) =>
        b !== briefToRemove &&
        b.id !== targetId &&
        b.sourceTaskId !== targetId &&
        b.itemNumber !== targetId &&
        String(b.sourceTaskId) !== String(targetId) &&
        String(b.id) !== String(targetId) &&
        String(b.itemNumber) !== String(targetId)
    );
    if (
      selectedTaskId === targetId ||
      selectedTaskId === briefToRemove.sourceTaskId ||
      selectedTaskId === briefToRemove.id
    ) {
      setSelectedTaskId(
        nextBriefs.length > 0
          ? nextBriefs[0].sourceTaskId || nextBriefs[0].id || nextBriefs[0].itemNumber || null
          : null
      );
    }
    setQueuedTaskIds((prev) => prev.filter((id) => String(id) !== String(targetId) && (!briefToRemove || String(id) !== String(briefToRemove.sourceTaskId))));
    queuedTaskIdsRef.current = queuedTaskIdsRef.current.filter((id) => String(id) !== String(targetId) && (!briefToRemove || String(id) !== String(briefToRemove.sourceTaskId)));

    setRunningJobs((prev) => {
      const updated = prev.filter((j) => String(j.taskId) !== String(targetId) && (!briefToRemove || String(j.taskId) !== String(briefToRemove.sourceTaskId)));
      runningJobsRef.current = updated;
      return updated;
    });

    setBriefs(nextBriefs);
    syncAndSaveProject(tasks, nextBriefs, true);

    showToast({
      type: 'info',
      title: 'Task Removed from AI Workspace',
      message: `Removed "${briefToRemove.title}" from the AI workspace. You can re-add it anytime from the human workspace.`,
      duration: 3500,
    });
  };

  // Purge Task Handler: Permanently removes task and all execution logs from AI Workspace & Vector DB
  const handlePurgeTaskFromAi = async (targetId: string | number) => {
    const briefToRemove = briefs.find(
      (b) =>
        b.id === targetId ||
        b.sourceTaskId === targetId ||
        b.itemNumber === targetId ||
        String(b.sourceTaskId) === String(targetId) ||
        String(b.id) === String(targetId) ||
        String(b.itemNumber) === String(targetId)
    );
    const targetTitle = briefToRemove?.title || String(targetId);

    // 1. Remove brief from AI workspace state
    const nextBriefs = briefs.filter(
      (b) =>
        b !== briefToRemove &&
        b.id !== targetId &&
        b.sourceTaskId !== targetId &&
        b.itemNumber !== targetId &&
        String(b.sourceTaskId) !== String(targetId) &&
        String(b.id) !== String(targetId) &&
        String(b.itemNumber) !== String(targetId)
    );
    if (
      selectedTaskId === targetId ||
      (briefToRemove && (selectedTaskId === briefToRemove.sourceTaskId || selectedTaskId === briefToRemove.id))
    ) {
      setSelectedTaskId(
        nextBriefs.length > 0
          ? nextBriefs[0].sourceTaskId || nextBriefs[0].id || nextBriefs[0].itemNumber || null
          : null
      );
    }

    setQueuedTaskIds((prev) => prev.filter((id) => String(id) !== String(targetId) && (!briefToRemove || String(id) !== String(briefToRemove.sourceTaskId))));
    queuedTaskIdsRef.current = queuedTaskIdsRef.current.filter((id) => String(id) !== String(targetId) && (!briefToRemove || String(id) !== String(briefToRemove.sourceTaskId)));

    setRunningJobs((prev) => {
      const updated = prev.filter((j) => String(j.taskId) !== String(targetId) && (!briefToRemove || String(j.taskId) !== String(briefToRemove.sourceTaskId)));
      runningJobsRef.current = updated;
      return updated;
    });

    setBriefs(nextBriefs);
    syncAndSaveProject(tasks, nextBriefs, true);

    // 2. Clear in-memory execution logs & steps
    const idKeys = [
      targetId,
      String(targetId),
      briefToRemove?.id,
      briefToRemove?.sourceTaskId,
      briefToRemove?.sourceTaskId ? String(briefToRemove.sourceTaskId) : null,
      briefToRemove?.id ? String(briefToRemove.id) : null,
    ].filter(Boolean) as (string | number)[];

    setTaskExecutionSteps((prev) => {
      const next = { ...prev };
      for (const k of idKeys) {
        delete next[k];
      }
      return next;
    });

    setTerminalSessions((prev) =>
      prev.filter((s) => !idKeys.some((k) => String(k) === String(s.session.taskId)))
    );

    // 3. Delete completely from local vector DB
    try {
      const taskIdsToPurge = [
        targetId,
        briefToRemove?.sourceTaskId,
        briefToRemove?.id,
      ].filter(Boolean) as (string | number)[];

      for (const tid of taskIdsToPurge) {
        await removeChunksByTaskId(tid, activeProjectId);
      }
    } catch (err) {
      console.warn('[PurgeTask] Failed to delete chunks from vector memory:', err);
    }

    showToast({
      type: 'info',
      title: 'Task Removed Completely',
      message: `"${targetTitle}" and its execution logs have been permanently deleted from AI Workspace and vector memory.`,
      duration: 3500,
    });
  };

  // Schedule Task Handler
  const handleScheduleTask = (taskId: string | number, scheduledIso: string, cronExpr?: string) => {
    const task = tasks.find((t) => String(t.id) === String(taskId)) || briefs.find((b) => String(b.sourceTaskId || b.id) === String(taskId));
    const title = task?.title || 'Scheduled Task';
    addScheduledJob({
      taskId,
      taskTitle: title,
      scheduledTime: scheduledIso,
      cronExpression: cronExpr,
    });
    setScheduledJobs(getScheduledJobs());

    showToast({
      type: 'info',
      title: 'Task Scheduled',
      message: `Scheduled "${title}" for ${new Date(scheduledIso).toLocaleString()}${cronExpr ? ` (${cronExpr})` : ''}`,
      duration: 4000,
    });
  };

  const handleCancelScheduleTask = (taskId: string | number) => {
    cancelScheduledJob(taskId);
    setScheduledJobs(getScheduledJobs());

    showToast({
      type: 'info',
      title: 'Schedule Removed',
      message: 'Scheduled execution for this task has been cancelled.',
      duration: 3000,
    });
  };

  // Ref to track executing status to prevent duplicate triggers
  const executingTaskIdRef = useRef<string | number | null>(executingTaskId);
  executingTaskIdRef.current = executingTaskId;

  // Background cron scheduler checker: runs periodically and checks if any scheduled job is due
  useEffect(() => {
    const checkScheduledJobs = () => {
      const jobs = getScheduledJobs();
      const now = Date.now();

      for (const job of jobs) {
        if (job.status !== 'pending') continue;

        const scheduledTime = new Date(job.scheduledTime).getTime();

        // If the scheduled time is invalid, mark as cancelled and skip
        if (isNaN(scheduledTime)) {
          markJobCompleted(job.taskId);
          setScheduledJobs(getScheduledJobs());
          continue;
        }

        // If a one-off scheduled job is stale from a previous session (more than 1 hour overdue), mark it completed/cancelled
        // rather than suddenly auto-launching tasks when the user opens or reloads the workspace.
        if (!job.cronExpression && (now - scheduledTime) > 60 * 60 * 1000) {
          console.log(`[TaskScheduler] Skipping stale overdue scheduled job ${job.id} for task "${job.taskTitle}" (due: ${job.scheduledTime})`);
          markJobCompleted(job.taskId);
          setScheduledJobs(getScheduledJobs());
          continue;
        }

        if (scheduledTime <= now) {
          // If task is currently already running, don't retrigger
          if (executingTaskIdRef.current !== null && String(executingTaskIdRef.current) === String(job.taskId)) {
            continue;
          }

          console.log(`[TaskScheduler] Triggering scheduled job ${job.id} for task "${job.taskTitle}"`);

          // Mark job completed or compute next recurrence if cron
          if (job.cronExpression) {
            // Re-schedule next recurrence
            let nextMs = 60 * 60 * 1000; // default 1 hour
            if (job.cronExpression.includes('* * * *')) {
              nextMs = 60 * 60 * 1000; // hourly
            } else if (job.cronExpression.split(' ').length === 5) {
              nextMs = 24 * 60 * 60 * 1000; // daily
            }
            const nextDate = new Date(now + nextMs).toISOString();
            addScheduledJob({
              taskId: job.taskId,
              taskTitle: job.taskTitle,
              scheduledTime: nextDate,
              cronExpression: job.cronExpression,
            });
          } else {
            markJobCompleted(job.taskId);
          }

          setScheduledJobs(getScheduledJobs());

          // Find task item and trigger execution
          const targetTask = tasks.find((t) => String(t.id) === String(job.taskId));
          if (targetTask) {
            showToast({
              type: 'info',
              title: 'Scheduled Task Executing',
              message: `Starting scheduled execution of "${targetTask.title}"…`,
              duration: 5000,
            });
            handleExecuteTask(targetTask);
          } else {
            const matchingBrief = briefs.find(
              (b) => String(b.sourceTaskId) === String(job.taskId) || String(b.id) === String(job.taskId)
            );
            if (matchingBrief) {
              const synthesizedTask: TaskItem = {
                id: matchingBrief.sourceTaskId || matchingBrief.id || job.taskId,
                title: matchingBrief.title,
                category: 'AI Workspace',
                status: 'not_started',
                isDone: false,
                subtasks: [],
              };
              showToast({
                type: 'info',
                title: 'Scheduled Task Executing',
                message: `Starting scheduled execution of "${synthesizedTask.title}"…`,
                duration: 5000,
              });
              handleExecuteTask(synthesizedTask);
            }
          }
        }
      }
    };

    // Run check on mount and then every 10 seconds
    checkScheduledJobs();
    const intervalId = setInterval(checkScheduledJobs, 10000);
    return () => clearInterval(intervalId);
  }, [tasks, briefs]);

  // Register live Ergo Workspace Action Bridge for global AI MCP execution
  useEffect(() => {
    // Initial sync of workspace skills to disk (.agents/skills/<id>/SKILL.md)
    syncSkillsToWorkspace().catch(() => { });

    const unregister = registerWorkspaceActionBridge({
      getState: () => ({
        tasks: tasksRef.current || tasks,
        briefs: briefsRef.current || briefs,
        swimLanes: activeProject?.swimLanes && activeProject.swimLanes.length > 0
          ? activeProject.swimLanes
          : [
            {
              id: 'lane-default',
              title: 'Human Workspace',
              filePath: activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`,
              markdown: activeProject?.todoMarkdown || ''
            }
          ],
        mcpServers
      }),
      saveProject: (newTasks, newBriefs, newLanes) => {
        syncAndSaveProject(newTasks, newBriefs, true, archivedTasks, archivedBriefs, newLanes);
      },
      executeAiTask: (taskId) => {
        const found = (tasksRef.current || tasks).find((t) => String(t.id) === String(taskId));
        if (found) {
          handleExecuteTask(found);
        }
      },
      runTasksSequence: (taskList, laneId, laneTitle) => {
        handleRunTasksSequence(taskList, laneId, laneTitle);
      },
      runTasksParallel: (taskList, laneId, laneTitle) => {
        handleRunTasksParallel(taskList, laneId, laneTitle);
      },
      scheduleTask: (taskId, iso, cron) => {
        handleScheduleTask(taskId, iso, cron);
      },
      cancelScheduledTask: (taskId) => {
        handleCancelScheduleTask(taskId);
      }
    });

    return unregister;
  }, [tasks, briefs, activeProject, mcpServers, archivedTasks, archivedBriefs]);

  // Unarchive Task Handler (Restores task from archive back to active workspace)
  const handleUnarchiveTask = (taskId: string | number) => {
    const taskToUnarchive = archivedTasks.find((t) => t.id === taskId);
    if (!taskToUnarchive) return;

    const normalTitle = taskToUnarchive.title.trim().toLowerCase();
    const nextArchivedTasks = archivedTasks.filter((t) => t.id !== taskToUnarchive.id);

    const restoredLaneId = taskToUnarchive.swimLaneId || (activeProject?.swimLanes?.[0]?.id || 'lane-default');
    const restoredId = `${restoredLaneId}_task_${Date.now()}`;

    const referenceTask = tasks.length > 0 ? tasks[0] : null;
    const restoredTask: TaskItem = {
      ...taskToUnarchive,
      id: restoredId,
      swimLaneId: restoredLaneId,
      category: referenceTask?.category || 'Untitled',
      categoryHeadingPrefix: referenceTask?.categoryHeadingPrefix || '##',
      categoryHasColon: referenceTask?.categoryHasColon || false,
      isArchived: false,
      archivedAtIndex: undefined,
    };

    const nextActiveTasks = [...tasks, restoredTask];

    const cleanTitle = cleanAndUnescapeMarkdown(taskToUnarchive.title).trim().toLowerCase();
    const matchingArchivedBrief = archivedBriefs.find(
      (b) =>
        (taskToUnarchive && (b.sourceTaskId === taskToUnarchive.id || String(b.sourceTaskId) === String(taskToUnarchive.id))) ||
        b.title.trim().toLowerCase() === normalTitle ||
        cleanAndUnescapeMarkdown(b.title).trim().toLowerCase() === cleanTitle
    );
    const nextArchivedBriefs = archivedBriefs.filter((b) => b !== matchingArchivedBrief);

    const nextActiveBriefs = matchingArchivedBrief
      ? [
        ...briefs,
        {
          ...matchingArchivedBrief,
          isArchived: false,
          id: `brief_${restoredId}`,
          sourceTaskId: restoredId,
          sourceLaneId: restoredLaneId,
        },
      ]
      : briefs;

    setSelectedTaskId(restoredId);
    syncAndSaveProject(nextActiveTasks, nextActiveBriefs, true, nextArchivedTasks, nextArchivedBriefs);
  };

  // Permanent Delete Archived Task Handler
  const handleDeleteArchivedTask = (taskId: string | number) => {
    const taskToDelete = archivedTasks.find((t) => t.id === taskId);
    if (!taskToDelete) return;

    void removeChunksByTaskId(taskToDelete.id, activeProjectId);

    const normalTitle = taskToDelete.title.trim().toLowerCase();
    const cleanTitle = cleanAndUnescapeMarkdown(taskToDelete.title).trim().toLowerCase();
    const nextArchivedTasks = archivedTasks.filter((t) => t.id !== taskToDelete.id);
    const nextArchivedBriefs = archivedBriefs.filter(
      (b) =>
        b.sourceTaskId !== taskToDelete.id &&
        String(b.sourceTaskId) !== String(taskToDelete.id) &&
        b.title.trim().toLowerCase() !== normalTitle &&
        cleanAndUnescapeMarkdown(b.title).trim().toLowerCase() !== cleanTitle
    );
    const nextActiveBriefs = briefs.filter(
      (b) =>
        b.sourceTaskId !== taskToDelete.id &&
        String(b.sourceTaskId) !== String(taskToDelete.id) &&
        b.title.trim().toLowerCase() !== normalTitle &&
        cleanAndUnescapeMarkdown(b.title).trim().toLowerCase() !== cleanTitle
    );

    syncAndSaveProject(tasks, nextActiveBriefs, true, nextArchivedTasks, nextArchivedBriefs);
  };

  // Save Archived Brief Edit
  const handleSaveArchivedBrief = (updatedBrief: AgentContextItem) => {
    const nextArchivedBriefs = archivedBriefs.map((b) =>
      (b.id && b.id === updatedBrief.id) ||
        (b.sourceTaskId && updatedBrief.sourceTaskId && b.sourceTaskId === updatedBrief.sourceTaskId) ||
        b.title.trim().toLowerCase() === updatedBrief.title.trim().toLowerCase()
        ? updatedBrief
        : b
    );
    syncAndSaveProject(tasks, briefs, true, archivedTasks, nextArchivedBriefs);
  };

  // Live Typing Handler from BriefPane (Triggers Debounced Autosave to disk)
  const handleLiveBriefChange = (updatedBrief: AgentContextItem) => {
    const existingIdx = briefs.findIndex(
      (b) =>
        (b.id && b.id === updatedBrief.id) ||
        (b.sourceTaskId && updatedBrief.sourceTaskId && b.sourceTaskId === updatedBrief.sourceTaskId) ||
        b.title.trim().toLowerCase() === updatedBrief.title.trim().toLowerCase()
    );
    let nextBriefs: AgentContextItem[];
    if (existingIdx !== -1) {
      nextBriefs = briefs.map((b, idx) => (idx === existingIdx ? updatedBrief : b));
    } else {
      nextBriefs = [...briefs, updatedBrief];
    }
    syncAndSaveProject(tasks, nextBriefs, false);
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
      ...existingBrief,
      id: existingBrief?.id || `brief_${task.id}`,
      sourceTaskId: task.id,
      sourceLaneId: task.swimLaneId || existingBrief?.sourceLaneId,
      itemNumber: existingBrief?.itemNumber,
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

  // Live edit handler from individual SwimLane column editor (Triggers Debounced Autosave to disk)
  const handleSwimLaneMarkdownChange = (laneId: string, newBodyMd: string) => {
    if (!activeProject) return;

    const currentLanes: SwimLaneDoc[] = activeProject.swimLanes && activeProject.swimLanes.length > 0
      ? activeProject.swimLanes
      : [{
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: activeProject.todoFilePath || `${activeProject.folderPath}/TODO.md`,
        markdown: activeProject.todoMarkdown || ''
      }];

    const updatedLanes = currentLanes.map((lane) =>
      lane.id === laneId ? { ...lane, markdown: newBodyMd } : lane
    );

    // Re-parse all tasks across all swim lanes
    let allActiveTasks: TaskItem[] = [];
    let allArchivedTasks: TaskItem[] = [];
    let globalOffset = 0;
    let firstHeaderComments = '';

    for (const lane of updatedLanes) {
      const parsed = parseSwimLaneMarkdown(lane, globalOffset);
      allActiveTasks = [...allActiveTasks, ...parsed.items];
      allArchivedTasks = [...allArchivedTasks, ...parsed.archivedItems];
      if (!firstHeaderComments && parsed.headerComments) {
        firstHeaderComments = parsed.headerComments;
      }
      globalOffset += parsed.items.length;
    }

    setTasks(allActiveTasks);
    setArchivedTasks(allArchivedTasks);
    if (firstHeaderComments) {
      setHeaderComments(firstHeaderComments);
    }

    const primaryTodoMd = updatedLanes[0]?.markdown || newBodyMd;

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? {
            ...p,
            todoMarkdown: primaryTodoMd,
            swimLanes: updatedLanes
          }
          : p
      )
    );

    const filesToSave = [
      ...updatedLanes.map((l) => ({ filePath: l.filePath, content: l.markdown })),
    ];

    autosave.queueSave(filesToSave);

    // Debounced orphaned-media cleanup: after images are removed from the editor,
    // delete any files in the media folder that are no longer referenced.
    if (activeProject?.folderPath) {
      const folderPath = activeProject.folderPath;
      const allMarkdowns = updatedLanes.map((l) => l.markdown);
      clearTimeout((window as any).__ergoMediaCleanupTimer);
      (window as any).__ergoMediaCleanupTimer = setTimeout(() => {
        storageManager.cleanupOrphanedMedia(folderPath, allMarkdowns).catch(() => { });
      }, 1500);
    }
  };

  // Add new SwimLane column (creates additional markdown file)
  const handleAddSwimLane = (afterLaneId?: string) => {
    if (!activeProject) return;

    const currentLanes: SwimLaneDoc[] = activeProject.swimLanes && activeProject.swimLanes.length > 0
      ? activeProject.swimLanes
      : [{
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: activeProject.todoFilePath || `${activeProject.folderPath}/TODO.md`,
        markdown: activeProject.todoMarkdown || ''
      }];

    const nextIndex = currentLanes.length + 1;
    const title = `Swim Lane ${nextIndex}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `lane-${nextIndex}`;
    const fileName = `${slug.toUpperCase().replace(/-/g, '_')}.md`;
    const filePath = `${activeProject.folderPath}/${fileName}`;

    const defaultContent = `<!-- Swimlane Title: ${title} -->\n<!-- Project: ${activeProject.name} | Folder: ${activeProject.folderPath} -->\n\n## ${title} Tasks\n\n1. Initial Task in ${title}\n    - Define task scope and subtasks\n`;

    const newLane: SwimLaneDoc = {
      id: `lane-${Date.now()}`,
      title,
      filePath,
      markdown: defaultContent
    };

    let nextLanes: SwimLaneDoc[];
    if (afterLaneId) {
      const targetIdx = currentLanes.findIndex((l) => l.id === afterLaneId);
      if (targetIdx !== -1) {
        nextLanes = [
          ...currentLanes.slice(0, targetIdx + 1),
          newLane,
          ...currentLanes.slice(targetIdx + 1),
        ];
      } else {
        nextLanes = [...currentLanes, newLane];
      }
    } else {
      nextLanes = [...currentLanes, newLane];
    }

    // Re-parse tasks with new lane
    let allActiveTasks: TaskItem[] = [];
    let allArchivedTasks: TaskItem[] = [];
    let globalOffset = 0;

    for (const lane of nextLanes) {
      const parsed = parseSwimLaneMarkdown(lane, globalOffset);
      allActiveTasks = [...allActiveTasks, ...parsed.items];
      allArchivedTasks = [...allArchivedTasks, ...parsed.archivedItems];
      globalOffset += parsed.items.length;
    }

    setTasks(allActiveTasks);
    setArchivedTasks(allArchivedTasks);

    const primaryTodoMd = nextLanes[0]?.markdown || activeProject.todoMarkdown;

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? {
            ...p,
            todoMarkdown: primaryTodoMd,
            swimLanes: nextLanes
          }
          : p
      )
    );

    autosave.saveImmediately([
      ...nextLanes.map((l) => ({ filePath: l.filePath, content: l.markdown })),
    ]);

    showToast({
      type: 'success',
      title: 'Swim Lane Added',
      message: `Created new swim lane "${title}" (${fileName}) with linked context.`
    });
  };

  // Rename a SwimLane column title and sync with markdown file on disk
  const handleRenameSwimLane = (laneId: string, newTitle: string) => {
    if (!activeProject || !newTitle.trim()) return;

    const trimmedTitle = newTitle.trim();
    const currentLanes: SwimLaneDoc[] = activeProject.swimLanes && activeProject.swimLanes.length > 0
      ? activeProject.swimLanes
      : [{
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: activeProject.todoFilePath || `${activeProject.folderPath}/TODO.md`,
        markdown: activeProject.todoMarkdown || ''
      }];

    const targetLane = currentLanes.find((l) => l.id === laneId);
    if (!targetLane) return;

    const oldFilePath = targetLane.filePath;
    const isPrimaryTodo = oldFilePath.endsWith('/TODO.md') || targetLane.id === 'lane-default' || targetLane.id === 'lane-todo';

    // Calculate new filename for secondary lanes (keep TODO.md as TODO.md so project structure remains standard)
    let newFilePath = oldFilePath;
    if (!isPrimaryTodo) {
      const slug = trimmedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'swim_lane';
      const newFileName = `${slug.toUpperCase()}.md`;
      newFilePath = `${activeProject.folderPath}/${newFileName}`;
    }

    // Embed or update <!-- Swimlane Title: <title> --> in the lane's markdown
    let updatedMd = targetLane.markdown;
    if (updatedMd.includes('<!-- Swimlane Title:')) {
      updatedMd = updatedMd.replace(/<!--\s*Swimlane Title:\s*.*?\s*-->/i, `<!-- Swimlane Title: ${trimmedTitle} -->`);
    } else {
      updatedMd = `<!-- Swimlane Title: ${trimmedTitle} -->\n${updatedMd}`;
    }

    const nextLanes = currentLanes.map((lane) => {
      if (lane.id === laneId) {
        return {
          ...lane,
          title: trimmedTitle,
          filePath: newFilePath,
          markdown: updatedMd
        };
      }
      return lane;
    });

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? { ...p, swimLanes: nextLanes }
          : p
      )
    );

    if (oldFilePath !== newFilePath) {
      // Call rename API to move old file to new file on disk
      fetch(bridgeClient.getApiUrl('/api/files/rename'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPath: oldFilePath,
          newPath: newFilePath,
          content: updatedMd
        })
      }).catch((err) => {
        console.error('[Ergo] Failed to rename swim lane file on disk:', err);
      });
    }

    autosave.saveImmediately(
      nextLanes.map((l) => ({ filePath: l.filePath, content: l.markdown }))
    );

    showToast({
      type: 'info',
      title: 'Swim Lane Renamed',
      message: `Renamed swim lane to "${trimmedTitle}".`
    });
  };

  // Delete a SwimLane column
  const handleDeleteSwimLane = (laneId: string) => {
    if (!activeProject) return;

    const currentLanes: SwimLaneDoc[] = activeProject.swimLanes && activeProject.swimLanes.length > 0
      ? activeProject.swimLanes
      : [{
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: activeProject.todoFilePath || `${activeProject.folderPath}/TODO.md`,
        markdown: activeProject.todoMarkdown || ''
      }];

    if (currentLanes.length <= 1) {
      showToast({
        type: 'warning',
        title: 'Cannot Delete Last Swim Lane',
        message: 'A workspace must contain at least 1 swim lane.'
      });
      return;
    }

    const removedLane = currentLanes.find((l) => l.id === laneId);
    if (removedLane) {
      const removedParsed = parseSwimLaneMarkdown(removedLane, 0);
      for (const t of [...removedParsed.items, ...removedParsed.archivedItems]) {
        void removeChunksByTaskId(t.id, activeProjectId);
      }
    }
    const nextLanes = currentLanes.filter((l) => l.id !== laneId);

    // Re-parse remaining tasks
    let allActiveTasks: TaskItem[] = [];
    let allArchivedTasks: TaskItem[] = [];
    let globalOffset = 0;

    for (const lane of nextLanes) {
      const parsed = parseSwimLaneMarkdown(lane, globalOffset);
      allActiveTasks = [...allActiveTasks, ...parsed.items];
      allArchivedTasks = [...allArchivedTasks, ...parsed.archivedItems];
      globalOffset += parsed.items.length;
    }

    setTasks(allActiveTasks);
    setArchivedTasks(allArchivedTasks);

    const primaryTodoMd = nextLanes[0]?.markdown || activeProject.todoMarkdown;

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? {
            ...p,
            todoMarkdown: primaryTodoMd,
            swimLanes: nextLanes
          }
          : p
      )
    );

    autosave.saveImmediately([
      ...nextLanes.map((l) => ({ filePath: l.filePath, content: l.markdown })),
    ]);

    // Delete the removed swim lane markdown file from disk so it does not recreate on reload
    if (removedLane && removedLane.filePath) {
      fetch(bridgeClient.getApiUrl('/api/files/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: [removedLane.filePath] }),
      }).catch((err) => {
        console.error('[Ergo] Failed to delete swim lane file from disk:', err);
      });
    }

    showToast({
      type: 'info',
      title: 'Swim Lane Removed',
      message: `Removed swim lane "${removedLane?.title || laneId}".`
    });
  };

  // Save Raw Markdown Editing (from Raw Markdown modal - Flushes immediately)
  const handleSaveRawMarkdown = (newTodoMd: string, newAgentContextMd: string, updatedSwimLanes?: SwimLaneDoc[]) => {
    const currentLanes: SwimLaneDoc[] = updatedSwimLanes && updatedSwimLanes.length > 0
      ? updatedSwimLanes
      : (activeProject?.swimLanes && activeProject.swimLanes.length > 0
        ? activeProject.swimLanes
        : [{
          id: 'lane-default',
          title: 'Human Workspace',
          filePath: activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`,
          markdown: newTodoMd
        }]);

    let allActiveTasks: TaskItem[] = [];
    let allArchivedTasks: TaskItem[] = [];
    let globalOffset = 0;
    let firstHeaderComments = '';

    for (const lane of currentLanes) {
      const parsed = parseSwimLaneMarkdown(lane, globalOffset);
      allActiveTasks = [...allActiveTasks, ...parsed.items];
      allArchivedTasks = [...allArchivedTasks, ...parsed.archivedItems];
      if (!firstHeaderComments && parsed.headerComments) {
        firstHeaderComments = parsed.headerComments;
      }
      globalOffset += parsed.items.length;
    }

    const parsedBriefsWithArchive = parseAgentContextWithArchive(newAgentContextMd);

    setTasks(allActiveTasks);
    setArchivedTasks(allArchivedTasks);
    setHeaderComments(firstHeaderComments);
    setBriefs(parsedBriefsWithArchive.items);
    setArchivedBriefs(parsedBriefsWithArchive.archivedItems);

    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId
          ? {
            ...p,
            todoMarkdown: currentLanes[0]?.markdown || newTodoMd,
            agentContextMarkdown: newAgentContextMd,
            swimLanes: currentLanes
          }
          : p
      )
    );

    autosave.saveImmediately(
      currentLanes.map((l) => ({ filePath: l.filePath, content: l.markdown }))
    );
  };

  // Export Project Files uniquely named by folder path
  const handleExportProject = () => {
    if (!activeProject) return;
    const folderSlug = activeProject.folderPath ? activeProject.folderPath.replace(/^projects\//, '') : activeProject.id;
    const currentLanes: SwimLaneDoc[] = activeProject.swimLanes && activeProject.swimLanes.length > 0
      ? activeProject.swimLanes
      : [{
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: `${folderSlug}_TODO.md`,
        markdown: activeProject.todoMarkdown
      }];

    currentLanes.forEach((lane, idx) => {
      setTimeout(() => {
        const rawFileName = lane.filePath.split('/').pop() || `${folderSlug}_TODO.md`;
        const fileName = rawFileName.endsWith('.md') ? rawFileName : `${rawFileName}.md`;
        const blob = new Blob([lane.markdown], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${folderSlug}_${fileName}`;
        a.click();
      }, idx * 250);
    });


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
    const currentLanes: SwimLaneDoc[] = activeProject?.swimLanes && activeProject.swimLanes.length > 0
      ? activeProject.swimLanes
      : [{
        id: 'lane-default',
        title: 'Human Workspace',
        filePath: activeProject?.todoFilePath || `${activeProject?.folderPath}/TODO.md`,
        markdown: activeProject?.todoMarkdown || ''
      }];

    const filesToSave = currentLanes.map((l) => ({ filePath: l.filePath, content: l.markdown }));
    if (activeProject?.folderPath) {
      const doc: RunningJobsDoc = {
        version: 1,
        projectId: activeProjectId,
        updatedAt: new Date().toISOString(),
        tasks: briefsRef.current,
        runningJobs: runningJobsRef.current,
        queuedTaskIds: queuedTaskIdsRef.current,
        taskExecutionSteps: taskExecutionStepsRef.current as Record<string, ExecutionStep[]>,
      };
      filesToSave.push({
        filePath: `${activeProject.folderPath}/RUNNING_JOBS.json`,
        content: serializeRunningJobsDoc(doc),
      });
    }

    autosave.saveImmediately(filesToSave);
  };

  // Clear Vector Memory for Active Project
  const handleClearActiveProjectMemory = async (): Promise<number> => {
    const removed = await clearProjectMemory(activeProjectId);
    showToast({
      type: 'success',
      title: 'Project Memory Cleared',
      message: `Cleared ${removed} vector memory chunk(s) for "${activeProject?.name || activeProjectId}".`
    });
    return removed;
  };

  // Clear All Vector Memory Across All Projects
  const handleClearAllMemory = async (): Promise<number> => {
    const removed = await clearAllMemory();
    showToast({
      type: 'success',
      title: 'Vector Memory Reset',
      message: `Cleared all ${removed} chunk(s) from local vector memory across all projects.`
    });
    return removed;
  };

  const runningTaskIds = useMemo(() => {
    const validTaskIds = new Set<string>([
      ...tasks.map((t) => String(t.id)),
      ...briefs.map((b) => String(b.sourceTaskId || b.id || b.itemNumber)),
    ]);

    const ids: (string | number)[] = [];
    terminalSessions.forEach((s) => {
      if (s.session.isActive && validTaskIds.has(String(s.session.taskId)) && !ids.includes(s.session.taskId)) {
        ids.push(s.session.taskId);
      }
    });
    if (executingTaskId !== null && validTaskIds.has(String(executingTaskId)) && !ids.includes(executingTaskId)) {
      ids.push(executingTaskId);
    }
    runningJobs.forEach((j) => {
      if (j.status === 'in_progress' && validTaskIds.has(String(j.taskId)) && !ids.includes(j.taskId)) {
        ids.push(j.taskId);
      }
    });
    return ids;
  }, [tasks, briefs, terminalSessions, executingTaskId, runningJobs]);

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
        isAiPanelOpen={isAiPanelOpen}
        onToggleAiPanel={handleToggleAiPanel}
        runningAiTaskCount={runningTaskIds.length}
      />

      {/* Disconnected Bridge Notification Banner for Hosted Web Environments */}
      {bridgeClient.isHostedWeb() && !bridgeStatus.isConnected && (
        <div
          style={{
            background: 'linear-gradient(90deg, rgba(234, 179, 8, 0.16) 0%, rgba(245, 158, 11, 0.12) 100%)',
            borderBottom: '1px solid rgba(234, 179, 8, 0.35)',
            padding: '0.45rem 1.25rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            zIndex: 40,
            fontSize: '0.8rem',
            color: 'var(--text-bright)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: '6px',
                background: 'rgba(234, 179, 8, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#eab308'
              }}
            >
              <AlertTriangle size={13} />
            </div>
            <span>
              <strong>Local Device Bridge Disconnected.</strong> Reconnect to access your local <code>~/.ergo</code> folders and run autonomous agents (Claude Code, Antigravity, etc.).
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <button
              type="button"
              onClick={handleManualReconnectBridge}
              disabled={isReconnectingBridge}
              style={{
                background: '#eab308',
                color: '#000000',
                fontWeight: 700,
                fontSize: '0.74rem',
                border: 'none',
                borderRadius: '6px',
                padding: '0.35rem 0.75rem',
                cursor: isReconnectingBridge ? 'wait' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                boxShadow: '0 2px 8px rgba(234, 179, 8, 0.3)'
              }}
            >
              <RefreshCw size={12} className={isReconnectingBridge ? 'spin-animate' : ''} />
              <span>{isReconnectingBridge ? 'Connecting...' : 'Reconnect Device'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Dual-Pane Workspace */}
      <div
        className={`workspace-body ${isDragging ? 'is-dragging' : ''} ${isAiPanelOpen ? 'ai-panel-open' : 'ai-panel-collapsed'}`}
        ref={workspaceRef}
      >
        {/* Left Pane: Obsidian-style Markdown Editor & Task Swim Lanes */}
        <div style={{
          width: isAiPanelOpen ? `${splitWidth}%` : 'calc(100% - 44px)',
          flex: isAiPanelOpen ? undefined : 1,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
          transition: isDragging ? 'none' : 'width 0.22s cubic-bezier(0.16, 1, 0.3, 1), flex 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}>
          <TaskPane
            rawMarkdown={activeProject?.todoMarkdown || ''}
            tasks={tasks}
            archivedTasks={archivedTasks}
            selectedTaskId={selectedTaskId}
            runningTaskIds={runningTaskIds}
            pendingHumanInputs={pendingHumanInputs}
            onSelectTask={(id) => setSelectedTaskId(id)}
            onOpenDraftModal={() => setIsDraftModalOpen(true)}
            onMarkdownChange={(newMd) => handleSwimLaneMarkdownChange(activeProject?.swimLanes?.[0]?.id || 'lane-default', newMd)}
            isAssistantOpen={isDraftModalOpen}
            onCloseAssistant={() => setIsDraftModalOpen(false)}
            project={activeProject}
            agentContextMarkdown=""
            aiConfig={aiConfig}
            mcpServers={mcpServers}
            onApplyAssistantResult={handleApplyAssistantResult}
            onArchiveTask={handleArchiveTask}
            onUnarchiveTask={handleUnarchiveTask}
            onDeleteArchivedTask={handleDeleteArchivedTask}
            onRestoreMemoryAsTask={handleRestoreMemoryAsTask}
            swimLanes={activeProject?.swimLanes}
            onAddSwimLane={handleAddSwimLane}
            onRenameSwimLane={handleRenameSwimLane}
            onDeleteSwimLane={handleDeleteSwimLane}
            onSwimLaneMarkdownChange={handleSwimLaneMarkdownChange}
            onCreateTaskFromSelection={handleCreateTaskFromSelection}
            onRunTasksSequence={handleRunTasksSequence}
            onRunTasksParallel={handleRunTasksParallel}
            onScheduleTask={(id, iso, cron) => {
              setIsAiPanelOpen(true);
              handleScheduleTask(id, iso, cron);
            }}
            autocompleteSettings={autocompleteSettings}
            onUpdateTaskMcpTools={handleUpdateTaskMcpTools}
          />
        </div>

        {/* Resizable Divider Bar (Only active when AI Panel is open) */}
        {isAiPanelOpen && (
          <div
            className={`resize-divider ${isDragging ? 'active' : ''}`}
            onMouseDown={handleMouseDown}
            title="Drag to resize AI Workspace"
          >
            <div className="resize-handle-bar" />
          </div>
        )}

        {/* Right Pane: Popout AI Workspace Panel / Collapsed Vertical Menu Rail */}
        <div
          className={`ai-workspace-pane-wrapper ${isAiPanelOpen ? 'is-open' : 'is-collapsed'}`}
          style={{
            width: isAiPanelOpen ? `${100 - splitWidth}%` : '44px',
            minWidth: isAiPanelOpen ? '320px' : '44px',
            maxWidth: isAiPanelOpen ? '80%' : '44px',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
            transition: isDragging ? 'none' : 'width 0.22s cubic-bezier(0.16, 1, 0.3, 1), min-width 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
          }}
        >
          <BriefPane
            tasks={tasks}
            briefs={briefs}
            projectId={activeProjectId}
            projectName={activeProject?.name}
            archivedTasks={archivedTasks}
            archivedBriefs={archivedBriefs}
            swimLanes={activeProject?.swimLanes}
            selectedTaskId={selectedTaskId}
            runningTaskIds={runningTaskIds}
            queuedTaskIds={queuedTaskIds}
            mcpServers={mcpServers}
            onUpdateTaskMcpTools={handleUpdateTaskMcpTools}
            onSelectTask={(id) => setSelectedTaskId(id)}
            onSaveBrief={handleSaveBrief}
            onLiveBriefChange={handleLiveBriefChange}
            onExecuteTask={handleExecuteTask}
            onTerminateAgent={handleTerminateAgent}
            onUpdateBriefWithAi={handleUpdateBriefWithAi}
            onSyncOverviewWithTask={handleSyncOverviewWithTask}
            onUnarchiveTask={handleUnarchiveTask}
            onDeleteArchivedTask={handleDeleteArchivedTask}
            onRestoreMemoryAsTask={handleRestoreMemoryAsTask}
            onSaveArchivedBrief={handleSaveArchivedBrief}
            autosaveStatus={autosave.status}
            autosaveDelaySec={autosave.delaySec}
            terminalSessions={terminalSessions}
            executingTaskId={executingTaskId}
            taskExecutionSteps={taskExecutionSteps}
            pendingPermissions={pendingPermissions}
            pendingHumanInputs={pendingHumanInputs}
            pendingOllamaFallbacks={pendingOllamaFallbacks}
            onPermissionChoice={handlePermissionChoice}
            onHumanInputChoice={handleHumanInputChoice}
            onOllamaFallbackChoice={handleOllamaFallbackChoice}
            onSessionExit={handleSessionExit}
            onRestartSession={handleExecuteTask}
            onKillSession={handleKillSession}
            onArchiveTask={handleArchiveTask}
            onRemoveAiTask={handleRemoveAiTask}
            onPurgeTaskFromAi={handlePurgeTaskFromAi}
            scheduledJobs={scheduledJobs}
            onScheduleTask={handleScheduleTask}
            onCancelScheduleTask={handleCancelScheduleTask}
            isPanelOpen={isAiPanelOpen}
            onTogglePanel={handleToggleAiPanel}
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
          setMcpServers((prev) => {
            try {
              localStorage.setItem('ergo_mcp_user_toggled_' + serverId, 'true');
            } catch { }
            const next = prev.map((s) => {
              if (s.id !== serverId) return s;
              // Allow mcp-laya and external services to toggle
              if (s.id !== 'mcp-laya' && s.id !== 'mcp-github' && s.serverType === 'bundled_harness') return s;
              return { ...s, status: (s.status === 'connected' ? 'disconnected' : 'connected') as 'connected' | 'disconnected' };
            });
            const target = next.find((s) => s.id === serverId);
            if (target) {
              const isNowConnected = target.status === 'connected';
              if (serverId === 'mcp-laya') {
                showToast({
                  type: isNowConnected ? 'success' : 'info',
                  title: isNowConnected ? 'Laya Local Engine Connected' : 'Laya Local Engine Disconnected',
                  message: isNowConnected
                    ? 'Active: Task triage will run locally on your machine.'
                    : 'Off: Agents will revert to AI-only triage.',
                  duration: 4000
                });
              } else {
                showToast({
                  type: 'info',
                  title: `${target.name} ${isNowConnected ? 'Connected' : 'Disconnected'}`,
                  message: `Connection status updated to ${target.status}.`,
                  duration: 3000
                });
              }
            }
            return next;
          })
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
        onDeleteCustomServer={(serverId) => setMcpServers((prev) => prev.filter((s) => s.id !== serverId))}
        onUpdateServer={(updatedServer) =>
          setMcpServers((prev) => prev.map((s) => (s.id === updatedServer.id ? updatedServer : s)))
        }
      />


      {/* Modal 5: Raw Markdown Sync & Download Preview */}
      <RawMarkdownModal
        isOpen={isRawMarkdownOpen}
        onClose={() => setIsRawMarkdownOpen(false)}
        todoMarkdown={activeProject?.todoMarkdown || serializeTodoMarkdown(tasks, headerComments)}
        folderPath={activeProject?.folderPath}
        todoFilePath={activeProject?.todoFilePath}
        swimLanes={activeProject?.swimLanes}
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
        theme={theme}
        onThemeChange={setTheme}
        agentPipelineOptions={agentPipelineOptions}
        onSetAgentPipelineOptions={setAgentPipelineOptions}
        autocompleteSettings={autocompleteSettings}
        onSetAutocompleteSettings={setAutocompleteSettings}
        onClearProjectMemory={handleClearActiveProjectMemory}
        onClearAllMemory={handleClearAllMemory}
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

      {/* Modal 9: Welcome & AI Account Onboarding Modal */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        onSaveUserKey={handleSaveUserKey}
        onCompleteOnboarding={handleCompleteOnboarding}
      />

      {/* Global Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />
    </div>
  );
}

export default App;
