import { useState, useEffect, useMemo, useRef } from 'react';
import { type ProjectData, type TaskItem, type AgentContextItem, type MCPServer, type AIProviderConfig } from './types';
import { DEMO_PROJECTS, INITIAL_MCP_SERVERS } from './lib/demoData';
import { parseTodoMarkdown, serializeTodoMarkdown, parseAgentContextMarkdown, serializeAgentContextMarkdown } from './lib/parser';
import { Navbar } from './components/Navbar';
import { TaskPane } from './components/TaskPane';
import { BriefPane } from './components/BriefPane';
import { DraftTaskModal } from './components/DraftTaskModal';
import { ExecutionModal } from './components/ExecutionModal';
import { McpHubModal } from './components/McpHubModal';
import { RawMarkdownModal } from './components/RawMarkdownModal';

export function App() {
  // Projects State
  const [projects, setProjects] = useState<ProjectData[]>(() => {
    const saved = localStorage.getItem('ergo_projects');
    return saved ? JSON.parse(saved) : DEMO_PROJECTS;
  });

  const [activeProjectId, setActiveProjectId] = useState<string>('ergo-takeoff-demo');
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
  const [aiConfig, setAiConfig] = useState<AIProviderConfig>({
    provider: 'mock',
    model: 'claude-3-7-sonnet'
  });

  // Modal Open States
  const [isDraftModalOpen, setIsDraftModalOpen] = useState(false);
  const [isExecutionModalOpen, setIsExecutionModalOpen] = useState(false);
  const [isMcpHubOpen, setIsMcpHubOpen] = useState(false);
  const [isRawMarkdownOpen, setIsRawMarkdownOpen] = useState(false);
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

  // Toggle Task Done Status
  const handleToggleTaskDone = (taskId: number) => {
    const updatedTasks = tasks.map((t) => {
      if (t.id === taskId) {
        const nextDone = !t.isDone;
        return {
          ...t,
          isDone: nextDone,
          status: (nextDone ? 'done' : 'not_started') as any,
          subtasks: t.subtasks.map((s) => ({ ...s, isDone: nextDone }))
        };
      }
      return t;
    });

    const updatedBriefs = briefs.map((b) => {
      if (b.itemNumber === taskId) {
        const targetTask = updatedTasks.find((t) => t.id === taskId);
        return { ...b, status: targetTask?.isDone ? 'done' : 'not started' };
      }
      return b;
    });

    syncAndSaveProject(updatedTasks, updatedBriefs);
  };

  // Toggle Subtask Done Status
  const handleToggleSubtaskDone = (taskId: number, subtaskId: string) => {
    const updatedTasks = tasks.map((t) => {
      if (t.id === taskId) {
        const nextSubtasks = t.subtasks.map((s) => (s.id === subtaskId ? { ...s, isDone: !s.isDone } : s));
        const allDone = nextSubtasks.every((s) => s.isDone);
        const someDone = nextSubtasks.some((s) => s.isDone);

        let newStatus = t.status;
        if (allDone) newStatus = 'done';
        else if (someDone) newStatus = 'in_progress';
        else newStatus = 'not_started';

        return {
          ...t,
          subtasks: nextSubtasks,
          isDone: allDone,
          status: newStatus as any
        };
      }
      return t;
    });

    syncAndSaveProject(updatedTasks, briefs);
  };

  // Add Manual Blank Task
  const handleAddNewTask = () => {
    const nextId = tasks.length > 0 ? Math.max(...tasks.map((t) => t.id)) + 1 : 1;
    const newTask: TaskItem = {
      id: nextId,
      title: 'New Feature Task',
      category: 'Missing features todos',
      status: 'not_started',
      isDone: false,
      subtasks: [
        { id: `${nextId}-1`, text: 'Define detailed implementation brief', isDone: false },
        { id: `${nextId}-2`, text: 'Verify implementation', isDone: false, isHumanReview: true }
      ],
      isHumanReview: true
    };

    const newBrief: AgentContextItem = {
      itemNumber: nextId,
      title: 'New Feature Task',
      status: 'not started',
      brief: 'Draft brief specification for this task.',
      built: '',
      validation: '',
      followUps: ''
    };

    const nextTasks = [...tasks, newTask];
    const nextBriefs = [...briefs, newBrief];

    setSelectedTaskId(nextId);
    syncAndSaveProject(nextTasks, nextBriefs);
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
        category: nt.category || 'Major TODOs for beta',
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
      brief: `${existingBrief?.brief || ''}\n\n**AI Refinement (${new Date().toLocaleDateString()}):**\nTarget Seams: \`lib/schedules.js\` and \`components/SchedulesTree.jsx\`.\nData Model: Additive property flags. Constraints: Must pass automated unit tests without breaking existing total outputs.`,
      built: existingBrief?.built || '',
      validation: existingBrief?.validation || '',
      followUps: existingBrief?.followUps || ''
    };
    handleSaveBrief(updatedBrief);
  };

  // Save Raw Markdown Editing
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

  // Export Project Files
  const handleExportProject = () => {
    const todoBlob = new Blob([serializeTodoMarkdown(tasks, headerComments)], { type: 'text/markdown' });
    const briefBlob = new Blob([serializeAgentContextMarkdown(briefs)], { type: 'text/markdown' });

    const a1 = document.createElement('a');
    a1.href = URL.createObjectURL(todoBlob);
    a1.download = 'TODO.md';
    a1.click();

    setTimeout(() => {
      const a2 = document.createElement('a');
      a2.href = URL.createObjectURL(briefBlob);
      a2.download = 'AGENT_CONTEXT.md';
      a2.click();
    }, 300);
  };

  // Create New Custom Project
  const handleCreateNewProject = () => {
    const id = `project-${Date.now()}`;
    const name = `New Project ${projects.length + 1}`;
    const newProj: ProjectData = {
      id,
      name,
      description: 'Custom AI co-working project roadmap.',
      connectedMcps: ['mcp-filesystem'],
      todoMarkdown: `<!-- Keep this file scannable. Full briefs, build records and test notes live in AGENT_CONTEXT.md -->\n\n# Project Roadmap:\n\n1. **Initial Task Setup:**\n    - Define core project goals`,
      agentContextMarkdown: `# TODO context — the verbose half of TODO.md\n\n### 1. Initial Task Setup\n\n**Status:** not started\n\n**Brief**\nInitial project setup brief details.`
    };

    setProjects([...projects, newProj]);
    setActiveProjectId(id);
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
        onNewProject={handleCreateNewProject}
        mcpServers={mcpServers}
        onOpenMcpHub={() => setIsMcpHubOpen(true)}
        aiConfig={aiConfig}
        onChangeAiConfig={setAiConfig}
        onOpenRawMarkdownModal={() => setIsRawMarkdownOpen(true)}
      />

      {/* Main Dual-Pane Workspace */}
      <div
        className={`workspace-body ${isDragging ? 'is-dragging' : ''}`}
        ref={workspaceRef}
      >
        {/* Left Pane: Your Tasks */}
        <div style={{ width: `${splitWidth}%`, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <TaskPane
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={(t) => setSelectedTaskId(t.id)}
            onToggleTaskDone={handleToggleTaskDone}
            onToggleSubtaskDone={handleToggleSubtaskDone}
            onExecuteTask={handleExecuteTask}
            onAddNewTask={handleAddNewTask}
            onOpenDraftModal={() => setIsDraftModalOpen(true)}
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

      {/* AI Skill 1: Draft Tasks Modal */}
      <DraftTaskModal
        isOpen={isDraftModalOpen}
        onClose={() => setIsDraftModalOpen(false)}
        project={activeProject}
        aiConfig={aiConfig}
        mcpServers={mcpServers}
        onCommitDraftedTasks={handleCommitDraftedTasks}
      />

      {/* AI Skill 2: Execution Modal */}
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

      {/* MCP Connections Hub Modal */}
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

      {/* Raw Markdown Editor Sync & Preview Download Modal */}
      <RawMarkdownModal
        isOpen={isRawMarkdownOpen}
        onClose={() => setIsRawMarkdownOpen(false)}
        todoMarkdown={serializeTodoMarkdown(tasks, headerComments)}
        agentContextMarkdown={serializeAgentContextMarkdown(briefs)}
        onSaveMarkdown={handleSaveRawMarkdown}
        onExportProject={handleExportProject}
      />
    </div>
  );
}

export default App;
