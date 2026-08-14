import { useState, useEffect, useMemo, useRef } from 'react';
import { type ProjectData, type TaskItem, type AgentContextItem, type MCPServer, type AIProviderConfig, type AIProviderId, type AICredentialsMap, type ProviderCredentials } from './types';
import { INITIAL_PROJECTS, createNewProjectData, INITIAL_MCP_SERVERS } from './lib/demoData';
import { parseTodoMarkdown, serializeTodoMarkdown, parseAgentContextMarkdown, serializeAgentContextMarkdown } from './lib/parser';
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

export function App() {
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
      } catch (e) {
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

  // MCP & AI Settings State
  const [mcpServers, setMcpServers] = useState<MCPServer[]>(INITIAL_MCP_SERVERS);

  const [credentialsMap, setCredentialsMap] = useState<AICredentialsMap>(() => {
    const saved = localStorage.getItem('ergo_ai_credentials');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return {
      openai: {},
      anthropic: {},
      gemini: {},
      ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.2' },
      mock: { model: 'ergo-native-v1', isConnected: true }
    };
  });

  const [aiConfig, setAiConfig] = useState<AIProviderConfig>(() => {
    const saved = localStorage.getItem('ergo_active_ai_config');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {}
    }
    return {
      provider: 'mock',
      model: 'ergo-native-v1',
      isConnected: true
    };
  });

  // Modal Open States
  const [isDraftModalOpen, setIsDraftModalOpen] = useState(false);
  const [isExecutionModalOpen, setIsExecutionModalOpen] = useState(false);
  const [isMcpHubOpen, setIsMcpHubOpen] = useState(false);
  const [isRawMarkdownOpen, setIsRawMarkdownOpen] = useState(false);
  const [isCreateProjectModalOpen, setIsCreateProjectModalOpen] = useState(false);
  const [isCredentialsModalOpen, setIsCredentialsModalOpen] = useState(false);
  const [credentialsModalProviderId, setCredentialsModalProviderId] = useState<AIProviderId | null>(null);
  const [executingTask, setExecutingTask] = useState<TaskItem | null>(null);


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

  // Load active project markdown into structured state
  useEffect(() => {
    if (activeProject) {
      const parsedTodo = parseTodoMarkdown(activeProject.todoMarkdown);
      const parsedBriefs = parseAgentContextMarkdown(activeProject.agentContextMarkdown);
      setTasks(parsedTodo.items);
      setHeaderComments(parsedTodo.headerComments);
      setBriefs(parsedBriefs);

      if (parsedTodo.items.length > 0) {
        setSelectedTaskId(parsedTodo.items[0].id);
      } else {
        setSelectedTaskId(null);
      }
    }
  }, [activeProjectId]);

  // Save projects to localStorage on change
  useEffect(() => {
    localStorage.setItem('ergo_projects', JSON.stringify(projects));
  }, [projects]);

  // Helper to persist updated tasks & briefs back into active project's raw markdown
  const syncAndSaveProject = (newTasks: TaskItem[], newBriefs: AgentContextItem[]) => {
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
      createdBriefs.push({
        itemNumber: currentId,
        title: fullTask.title,
        status: 'not started',
        brief: nb?.brief || `Brief for ${fullTask.title}`,
        built: nb?.built || '',
        validation: nb?.validation || '',
        followUps: nb?.followUps || ''
      });
    });

    const nextTasks = [...tasks, ...createdTasks];
    const nextBriefs = [...briefs, ...createdBriefs];

    if (createdTasks.length > 0) {
      setSelectedTaskId(createdTasks[0].id);
    }
    syncAndSaveProject(nextTasks, nextBriefs);
  };

  // Trigger Task Execution (Skill: run-todo)
  const handleExecuteTask = (task: TaskItem) => {
    setExecutingTask(task);
    setIsExecutionModalOpen(true);
  };

  // Complete Execution & Apply Build Record
  const handleCompleteExecution = (updatedTask: TaskItem, updatedBrief: AgentContextItem) => {
    const nextTasks = tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t));
    const nextBriefs = briefs.map((b) => (b.itemNumber === updatedBrief.itemNumber ? updatedBrief : b));
    syncAndSaveProject(nextTasks, nextBriefs);
  };

  // Save Brief Edits
  const handleSaveBrief = (updatedBrief: AgentContextItem) => {
    const nextBriefs = briefs.map((b) => (b.itemNumber === updatedBrief.itemNumber ? updatedBrief : b));
    syncAndSaveProject(tasks, nextBriefs);
  };

  // Refine Brief with AI
  const handleUpdateBriefWithAi = (task: TaskItem) => {
    const existingBrief = briefs.find((b) => b.itemNumber === task.id);
    const updatedBrief: AgentContextItem = {
      itemNumber: task.id,
      title: task.title,
      status: task.status,
      brief: `${existingBrief?.brief || ''}\n\n**AI Refinement (${new Date().toLocaleDateString()}):**\nTarget Folder: \`${activeProject.folderPath}\`.\nData Model: Additive property flags. Constraints: Must pass automated verification without cross-project leakage.`,
      built: existingBrief?.built || '',
      validation: existingBrief?.validation || '',
      followUps: existingBrief?.followUps || ''
    };
    handleSaveBrief(updatedBrief);
  };

  // Live edit handler from Obsidian-style TaskPane editor
  const handleRawTodoEdit = (newTodoMd: string) => {
    const parsedTodo = parseTodoMarkdown(newTodoMd);
    setTasks(parsedTodo.items);
    setHeaderComments(parsedTodo.headerComments);
    // Sync the raw markdown into the project record
    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeProjectId ? { ...p, todoMarkdown: newTodoMd } : p
      )
    );
  };

  // Save Raw Markdown Editing (from Raw Markdown modal)
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

  // Create New Linked Project in Main Directory Structure
  const handleConfirmCreateProject = (name: string, customFolder: string, description: string) => {
    const newProj = createNewProjectData(name, customFolder, description);
    setProjects((prev) => [...prev, newProj]);
    setActiveProjectId(newProj.id);
  };

  // Persist Credentials & Active Config to localStorage
  useEffect(() => {
    localStorage.setItem('ergo_ai_credentials', JSON.stringify(credentialsMap));
  }, [credentialsMap]);

  useEffect(() => {
    localStorage.setItem('ergo_active_ai_config', JSON.stringify(aiConfig));
  }, [aiConfig]);

  const handleOpenCredentialsModal = (providerId: AIProviderId) => {
    setCredentialsModalProviderId(providerId);
    setIsCredentialsModalOpen(true);
  };

  const handleSaveCredentials = (providerId: AIProviderId, creds: ProviderCredentials) => {
    const updatedMap = {
      ...credentialsMap,
      [providerId]: creds
    };
    setCredentialsMap(updatedMap);

    // Automatically set saved provider as active AI
    const providerMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === providerId);
    const newConfig: AIProviderConfig = {
      provider: providerId,
      model: creds.model || providerMeta?.defaultModel || 'gpt-4o',
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      isConnected: true
    };
    setAiConfig(newConfig);
  };

  const handleClearCredentials = (providerId: AIProviderId) => {
    const updatedMap = {
      ...credentialsMap,
      [providerId]: { isConnected: false }
    };
    setCredentialsMap(updatedMap);

    if (aiConfig.provider === providerId) {
      setAiConfig({
        provider: 'mock',
        model: 'ergo-native-v1',
        isConnected: true
      });
    }
  };

  const handleSelectAiProvider = (providerId: AIProviderId) => {
    const creds = credentialsMap[providerId];
    const isConnected = (providerId as string) === 'mock' || !!creds?.isConnected;

    if (!isConnected && (providerId as string) !== 'mock') {
      handleOpenCredentialsModal(providerId);
    } else {
      const providerMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === providerId);
      setAiConfig({
        provider: providerId,
        model: creds?.model || providerMeta?.defaultModel || 'gpt-4o',
        apiKey: creds?.apiKey,
        baseUrl: creds?.baseUrl,
        isConnected: true
      });
    }
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
        mcpServers={mcpServers}
        onOpenMcpHub={() => setIsMcpHubOpen(true)}
        aiConfig={aiConfig}
        credentialsMap={credentialsMap}
        onSelectAiProvider={handleSelectAiProvider}
        onOpenCredentialsModal={handleOpenCredentialsModal}
        onOpenRawMarkdownModal={() => setIsRawMarkdownOpen(true)}
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

        {/* Right Pane: AI Canvas */}
        <div style={{ width: `${100 - splitWidth}%`, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <BriefPane
            activeTask={activeTask}
            activeBrief={activeBrief}
            onSaveBrief={handleSaveBrief}
            onExecuteTask={handleExecuteTask}
            onUpdateBriefWithAi={handleUpdateBriefWithAi}
          />
        </div>
      </div>

      {/* Modal 1: Create New Project Directory */}
      <CreateProjectModal
        isOpen={isCreateProjectModalOpen}
        onClose={() => setIsCreateProjectModalOpen(false)}
        onCreateProject={handleConfirmCreateProject}
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

      {/* Modal 6: AI Engine Sign In & Credentials Manager */}
      <AiCredentialsModal
        isOpen={isCredentialsModalOpen}
        onClose={() => setIsCredentialsModalOpen(false)}
        providerId={credentialsModalProviderId}
        currentCredentials={credentialsModalProviderId ? credentialsMap[credentialsModalProviderId] : undefined}
        onSaveCredentials={handleSaveCredentials}
        onClearCredentials={handleClearCredentials}
      />
    </div>
  );
}

export default App;
