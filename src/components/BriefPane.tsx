import { resolveHeaderColor } from '../lib/headerColors';
import React, { useState, useEffect, useRef } from 'react';
import {
  type TaskItem,
  type TaskStatus,
  type AgentContextItem,
  type SpawnedSession,
  type ExecutionStep,
  type McpToolPermissionPrompt,
  type HumanInputPrompt,
  type OllamaFallbackPrompt,
  type OllamaFallbackChoice,
  type MCPServer,
  type AgentPipelineOptions,
  type EffortLevel,
  type UserApiKey,
  type PermissionDecision,
  type PermissionLevel
} from '../types';
import { AgentTerminal } from './AgentTerminal';
import { ResizableTerminalContainer } from './ResizableTerminalContainer';
import { CliAgentNotesBridge } from './CliAgentNotesBridge';
import { TaskPromptBox } from './TaskPromptBox';
import { AgentLiveStatus } from './AgentLiveStatus';
import { RunSurveyCard } from './RunSurveyCard';
import type { TaskMessageOptions, TaskMessageResult } from '../lib/taskMessages';
import {
  AgentSessionTabs,
  AgentRoleBadge,
  AgentStatusDot,
  sortAgentSessions,
  pickLiveAgent,
  isAgentWorking,
  agentStatusLabel,
} from './AgentSessionTabs';
import { hasUsableOverview, isOverviewStale, overviewTaskFingerprint } from '../lib/overviewUtils';
import { isTaskBrief } from '../lib/agentPipeline/taskBrief';
import { openFileInIdeOrSystem } from '../lib/mcpClient';
import { promptSummary } from '../lib/cliPromptParser';
import { StepStatusIcon, StepUsageBadge, PieceChip, BiblePreview, RelatedTasksPanel } from './ExecutionStepExtras';
import { BvTokenCounterCard, type TaskBilling } from './BvTokenCounterCard';
import {
  Edit3,
  Save,
  Play,
  CheckCircle2,
  Terminal,
  RotateCcw,
  Square,
  ShieldAlert,
  ShieldCheck,
  Code,
  Cloud,
  Layers,
  Send,
  Loader2,
  X,
  FileText,
  ChevronDown,
  Sparkles,
  Wrench,
  Archive,
  HelpCircle,
  MoreHorizontal,
  Calendar,
  Clock,
  Copy,
  Check,
  CornerUpLeft,
  BookOpen,
  ExternalLink,
  Cpu,
  Settings2,
  Unplug,
  CircleX,
  CircleDot,
  Pencil,
  ListChecks,
  ArrowLeft,
  Activity,
} from 'lucide-react';
import { getPref, setPref, subscribePrefs } from '../lib/userPrefs';
import { Banner, Button, Dialog, EmptyState, Icon, IconButton, MenuButton, RunRow, SegmentedControl, StatusDot, StatusIcon, STATUS_LABEL, Tabs, type DesignTaskStatus, type MenuItem } from './ui';
import { EFFORT_LABELS } from '../lib/agentPipeline/modelRouter';
import { formatTokens } from '../lib/agentDisplay';
import { MOD, SHIFT } from '../lib/shortcuts';

import { RichTextToolbar } from './RichTextToolbar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ScheduleTaskModal } from './ScheduleTaskModal';
import { TaskMcpToolsModal } from './TaskMcpToolsModal';
import { type ScheduledJob } from '../lib/taskScheduler';
import { handleMarkdownAutoWrap } from '../lib/markdownEditorUtils';

interface HumanInputCardProps {
  prompt: HumanInputPrompt;
  onSubmit: (answer: string) => void;
}

const HumanInputCard: React.FC<HumanInputCardProps> = ({ prompt, onSubmit }) => {
  const options = prompt.options && prompt.options.length > 0 ? prompt.options : [];
  // Options always end with "Other": the user can answer in their own words instead of a suggested choice.
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [isOther, setIsOther] = useState(options.length === 0);
  const [customText, setCustomText] = useState('');
  const answer = isOther ? customText.trim() : selectedOption || '';

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (answer) onSubmit(answer);
  };

  return (
    <div className="ai-human-input-card">
      <div className="ai-human-input-header">
        <div className="ai-human-input-title">
          <HelpCircle size={17} color="var(--accent-amber)" />
          <span>Clarification Needed &bull; Manager AI</span>
        </div>
        <span className="ai-human-input-badge">Interactive Prompt</span>
      </div>

      <p className="ai-human-input-question">{prompt.question}</p>

      {prompt.context && (
        <div className="ai-human-input-context">
          <strong>Context:</strong> {prompt.context}
        </div>
      )}

      {options.length > 0 && (
        <div className="ai-human-input-options">
          <div className="ai-human-input-options-label">Select an option:</div>
          <div className="ai-human-input-options-list">
            {options.map((opt, idx) => {
              const isSelected = !isOther && selectedOption === opt;
              return (
                <button
                  key={idx}
                  type="button"
                  className={`ai-input-option-btn ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => {
                    setIsOther(false);
                    setSelectedOption(isSelected ? null : opt);
                  }}
                >
                  <span className="option-number">{idx + 1}</span>
                  <span className="option-text">{opt}</span>
                  {isSelected && <CheckCircle2 size={13} className="option-check-icon" />}
                </button>
              );
            })}
            <button
              type="button"
              className={`ai-input-option-btn ${isOther ? 'is-selected' : ''}`}
              onClick={() => {
                setSelectedOption(null);
                setIsOther(!isOther);
              }}
            >
              <span className="option-number">{options.length + 1}</span>
              <span className="option-text">Other — type your own answer</span>
              {isOther && <CheckCircle2 size={13} className="option-check-icon" />}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="ai-human-input-form">
        {isOther && (
          <textarea
            className="ai-human-input-textarea"
            placeholder="Type your answer…"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            rows={2}
            autoFocus={options.length > 0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        )}
        <div className="ai-human-input-actions">
          {isOther && (
            <span className="ai-human-input-hint">
              Press <strong>Ctrl+Enter</strong> or click Submit
            </span>
          )}
          <button type="submit" className="btn btn-primary ai-human-input-submit-btn" disabled={!answer}>
            <Send size={13} />
            <span>Submit Response</span>
          </button>
        </div>
      </form>
    </div>
  );
};

interface BriefPaneProps {
  /** How the active AI profile pays, so the token card can show cost (see BvTokenCounterCard). */
  taskBilling?: TaskBilling;
  tasks: TaskItem[];
  briefs: AgentContextItem[];
  archivedTasks?: TaskItem[];
  selectedTaskId: string | number | null;
  runningTaskIds?: (string | number)[];
  onSelectTask?: (taskId: string | number) => void;
  onSaveBrief: (updatedBrief: AgentContextItem) => void;
  onLiveBriefChange?: (updatedBrief: AgentContextItem) => void;
  onExecuteTask: (task: TaskItem, opts?: { startOver?: boolean }) => void;
  onUpdateBriefWithAi?: (task: TaskItem) => void;
  onSyncOverviewWithTask?: (task: TaskItem) => Promise<string | void>;
  /** Opens the Archives & Learnings screen. */
  onOpenArchives?: () => void;
  onSaveArchivedBrief?: (brief: AgentContextItem) => void;
  autosaveStatus?: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  autosaveDelaySec?: number;
  terminalSessions?: SpawnedSession[];
  executingTaskId?: string | number | null;
  taskExecutionSteps?: Record<string | number, ExecutionStep[]>;
  pendingPermissions?: Record<string | number, { prompt: McpToolPermissionPrompt; resolve: (decision: PermissionDecision) => void }>;
  pendingHumanInputs?: Record<string | number, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>;
  pendingOllamaFallbacks?: Record<string | number, { prompt: OllamaFallbackPrompt; resolve: (choice: OllamaFallbackChoice) => void }>;
  onPermissionChoice?: (taskId: string | number, approved: PermissionDecision) => void;
  onHumanInputChoice?: (taskId: string | number, answer: string) => void;
  onOllamaFallbackChoice?: (taskId: string | number, choice: OllamaFallbackChoice) => void;
  /** @deprecated Agent exits reach App through the bridge's event stream; views no longer report them. */
  onSessionExit?: (taskId: string | number, code: number) => void;
  /** Relaunch the task's whole CLI run. */
  onRestartSession?: (task: TaskItem) => void;
  /** Stop every agent of the task's run. */
  onKillSession?: (taskId: string | number) => void;
  /** Stop one agent (SpawnedSession.ptySessionId). */
  onKillAgentSession?: (ptySessionId: string) => void;
  /** Task prompt box: steer the running agents, or continue the finished run with a follow-up. */
  onSendTaskMessage?: (task: TaskItem, text: string, opts?: TaskMessageOptions) => Promise<TaskMessageResult>;
  onTerminateAgent?: (taskId: string | number) => void;
  onArchiveTask?: (taskTitle: string) => void;
  onRemoveAiTask?: (targetId: string | number) => void;
  onPurgeTaskFromAi?: (targetId: string | number) => void;
  // Scheduling props
  scheduledJobs?: ScheduledJob[];
  queuedTaskIds?: (string | number)[];
  /** A queued card's button: run the task now instead of waiting its turn in the queue. */
  onRunQueuedTaskNow?: (taskId: string | number) => void;
  onScheduleTask?: (taskId: string | number, scheduledIso: string, cronExpr?: string) => void;
  onCancelScheduleTask?: (taskId: string | number) => void;
  // Popout Panel Controls
  isPanelOpen?: boolean;
  onTogglePanel?: () => void;
  mcpServers?: MCPServer[];
  onUpdateTaskMcpTools?: (taskId: string | number, toolNames: string[]) => void;
  // Execution settings (permission level + effort) shown in the header drop-down
  agentPipelineOptions?: AgentPipelineOptions;
  onSetAgentPipelineOptions?: (next: AgentPipelineOptions) => void;
  /** Drag the pane's left edge to resize it. */
  onResizeStart?: (e: React.MouseEvent) => void;
  isResizing?: boolean;
  /** Queue: run the task after the ones already queued. */
  onQueueTask?: (task: TaskItem) => void;
  isBridgeConnected?: boolean;
  userApiKeys?: UserApiKey[];
  activeKeyId?: string | null;
  /** Settings › Models. */
  onOpenModels?: () => void;
  /** Bumped each time a task is picked in the document: show that task's card. */
  detailRequest?: number;
  /** Bumped to go back to the runs view (e.g. from the status bar's queue item). */
  runsViewRequest?: number;
}

interface AiTaskCardProps {
  taskBilling?: TaskBilling;
  task: TaskItem;
  brief: AgentContextItem | undefined;
  isSelected: boolean;
  isWorking: boolean;
  isQueued?: boolean;
  /** This task's CLI agent sessions, ordered manager → workers → verifier. */
  agentSessions: SpawnedSession[];
  /** Current permission level (for sessions that don't report their own). */
  permissionLevel?: PermissionLevel;
  isExecuting: boolean;
  executionSteps: ExecutionStep[];
  pendingPermission: McpToolPermissionPrompt | null;
  pendingHumanInput: { prompt: HumanInputPrompt; resolve: (answer: string) => void } | null;
  pendingOllamaFallback: { prompt: OllamaFallbackPrompt; resolve: (choice: OllamaFallbackChoice) => void } | null;
  scheduledJob?: ScheduledJob;
  onOpenScheduleModal?: (task: TaskItem) => void;
  onSelect: () => void;
  onSaveBrief: (updatedBrief: AgentContextItem) => void;
  onLiveBriefChange?: (updatedBrief: AgentContextItem) => void;
  onExecuteTask: (task: TaskItem, opts?: { startOver?: boolean }) => void;
  onUpdateBriefWithAi?: (task: TaskItem) => void;
  onSyncOverviewWithTask?: (task: TaskItem) => Promise<string | void>;
  onPermissionChoice?: (approved: PermissionDecision) => void;
  onHumanInputChoice?: (answer: string) => void;
  onOllamaFallbackChoice?: (choice: OllamaFallbackChoice) => void;
  /** @deprecated Unused: agent exits reach App through the bridge's event stream. */
  onSessionExit?: (code: number) => void;
  onRestartSession?: (task: TaskItem) => void;
  onKillSession?: (taskId: string | number) => void;
  onKillAgentSession?: (ptySessionId: string) => void;
  onSendTaskMessage?: (task: TaskItem, text: string, opts?: TaskMessageOptions) => Promise<TaskMessageResult>;
  onTerminateAgent?: (taskId: string | number) => void;
  onArchiveTask?: (taskTitle: string) => void;
  onRemoveAiTask?: (targetId: string | number) => void;
  onPurgeTaskFromAi?: (targetId: string | number) => void;
  onRunQueuedNow?: () => void;
  mcpServers?: MCPServer[];
  onUpdateTaskMcpTools?: (taskId: string | number, toolNames: string[]) => void;
  /** Related Tasks card: whether a related task has a card to open, and opening (selecting) it. */
  canOpenRelatedTask?: (taskId: string) => boolean;
  onOpenRelatedTask?: (taskId: string) => void;
  /** The document the task lives in ("TODO.md"), for the crumb and its Line property. */
  fileName: string;
  /** 0-based place in the run queue, when queued. */
  queuePosition?: number;
  isBridgeConnected?: boolean;
  onQueue?: () => void;
  onClosePane?: () => void;
  /** Back to the runs view (the pane's default). */
  onBackToRuns?: () => void;
  agentPipelineOptions?: AgentPipelineOptions;
  onSetAgentPipelineOptions?: (next: AgentPipelineOptions) => void;
  onOpenModels?: () => void;
}

type CardStatus = 'not_started' | 'queued' | 'working' | 'done';

const NO_AGENT_SESSIONS: SpawnedSession[] = [];

/** A document heading as plain text: no markdown marks or {color=…} tags. */
const cleanHeading = (h: string) => h.replace(/\{color=[^}]*\}/g, '').replace(/[*_`]+/g, '').replace(/:\s*$/, '').trim();

type RunsSort = 'status' | 'category' | 'alpha';
const RUNS_SORT_PREF = 'ai_runs_sort';
const readRunsSort = (): RunsSort => {
  const v = getPref(RUNS_SORT_PREF);
  return v === 'category' || v === 'alpha' ? v : 'status';
};

/** Brief list order: by the document's headings and task numbers, or newest added first. */
type AiSortMode = 'category' | 'added';

/** The human-side task a brief belongs to: its source task id, else the same title. */
function briefTask(brief: AgentContextItem, tasks: TaskItem[]): TaskItem | null {
  return (
    (brief.sourceTaskId ? tasks.find((t) => String(t.id) === String(brief.sourceTaskId)) : null) ||
    tasks.find((t) => t.title.trim().toLowerCase() === brief.title.trim().toLowerCase()) ||
    null
  );
}

interface OrderedBrief {
  brief: AgentContextItem;
  /** Position in `briefs` (stable fallback key and tie-break). */
  index: number;
  task: TaskItem | null;
  /** Category mode: the heading shown above the first card of each category. */
  group?: { name: string; color: string };
}

function orderBriefs(briefs: AgentContextItem[], tasks: TaskItem[], mode: AiSortMode): OrderedBrief[] {
  const rows: OrderedBrief[] = briefs.map((brief, index) => ({ brief, index, task: briefTask(brief, tasks) }));
  if (mode === 'added') {
    // Newest first; briefs from before addedAt existed come after the dated ones, last-listed (= last added) first.
    const at = (r: OrderedBrief) => Date.parse(r.brief.addedAt || '') || 0;
    return rows.sort((a, b) => at(b) - at(a) || b.index - a.index);
  }
  // Categories in the order their headings appear in the human workspace (lanes in order too).
  const taskPos = new Map(tasks.map((t, i) => [t, i] as const));
  const groupKey = (t: TaskItem) => `${t.swimLaneId ?? ''}\u0000${t.category}`;
  const groupPos = new Map<string, number>();
  for (const t of tasks) if (!groupPos.has(groupKey(t))) groupPos.set(groupKey(t), groupPos.size);
  const rank = (r: OrderedBrief) => (r.task ? groupPos.get(groupKey(r.task)) ?? Infinity : Infinity);
  const number = (r: OrderedBrief) => (r.task ? r.task.listIndex ?? taskPos.get(r.task) ?? 0 : r.brief.itemNumber ?? 0);
  const pos = (r: OrderedBrief) => (r.task ? taskPos.get(r.task) ?? 0 : 0);
  rows.sort((a, b) => rank(a) - rank(b) || number(a) - number(b) || pos(a) - pos(b) || a.index - b.index);
  // Headings only help when there is more than one category.
  const keyOf = (r: OrderedBrief) => (r.task ? groupKey(r.task) : '');
  if (new Set(rows.map(keyOf)).size > 1) {
    let last: string | null = null;
    for (const r of rows) {
      if (keyOf(r) === last) continue;
      last = keyOf(r);
      const name = r.task?.category?.trim() || (r.task ? 'Uncategorized' : 'Not linked to a task');
      r.group = { name, color: r.task?.category ? resolveHeaderColor(r.task.category, r.task.categoryColor).hex : 'var(--text-dim)' };
    }
  }
  return rows;
}

/** React key for an agent's views: a relaunch reuses the ptySessionId, so the launch id forces a fresh attach. */
const agentViewKey = (s: SpawnedSession) => `${s.ptySessionId}|${s.spawnId || s.runId || s.session.spawnedAt}`;

type TaskStageKey = 'related' | 'overview' | 'actions' | 'completion';

/** The detail pane's tabs, in run order: Related · Overview · Runs · Notes. A tab stays disabled until the run reaches it. */
const TASK_STAGES: ReadonlyArray<{ key: TaskStageKey; label: string }> = [
  { key: 'related', label: 'Related' },
  { key: 'overview', label: 'Overview' },
  { key: 'actions', label: 'Runs' },
  { key: 'completion', label: 'Notes' },
];

/** What a pipeline tool call wants to do: the exact command, the file + diff, or the tool's arguments. */
const PermissionRequestDetails: React.FC<{ prompt: McpToolPermissionPrompt }> = ({ prompt }) => {
  const [copied, setCopied] = useState(false);
  const args: Record<string, any> = prompt.args && typeof prompt.args === 'object' ? prompt.args : {};
  const command = typeof args.command === 'string' ? args.command : '';
  const cwd = typeof args.cwd === 'string' ? args.cwd : '';
  const path =
    typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '';
  const isCommand = prompt.toolName === 'run_command' || (Boolean(command) && !path);
  const isFileChange =
    !isCommand &&
    Boolean(path) &&
    (/(?:write|edit|create|append|patch|replace|move|delete)/i.test(prompt.toolName) ||
      args.content !== undefined ||
      args.old_string !== undefined);

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => { });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isCommand && command) {
    return (
      <div className="permission-request-details">
        <div className="permission-detail-header">
          <span className="permission-detail-label">Command</span>
          <button type="button" className="command-copy-btn" onClick={() => copy(command)} title="Copy command to clipboard">
            {copied ? <Check size={11} color="var(--accent-emerald)" /> : <Copy size={11} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <pre className="permission-command-pre">$ {command}</pre>
        {cwd && <div className="permission-detail-meta">cwd: <code>{cwd}</code></div>}
      </div>
    );
  }

  if (isFileChange) {
    const diffLines = (prompt.diffPreview || '').split('\n');
    return (
      <div className="permission-request-details">
        <div className="permission-detail-header">
          <span className="permission-detail-label">{prompt.toolName.replace(/_/g, ' ')}</span>
          <button type="button" className="command-copy-btn" onClick={() => copy(path)} title="Copy path to clipboard">
            {copied ? <Check size={11} color="var(--accent-emerald)" /> : <Copy size={11} />}
            <span>{copied ? 'Copied' : 'Copy path'}</span>
          </button>
        </div>
        <div className="permission-detail-path">{path}</div>
        {prompt.diffPreview ? (
          <div className="diff-view permission-diff-preview">
            {diffLines.map((line, idx) => (
              <div key={idx} className={line.startsWith('+') ? 'diff-line-add' : line.startsWith('-') ? 'diff-line-del' : ''}>
                {line || ' '}
              </div>
            ))}
          </div>
        ) : (
          <div className="permission-detail-meta">{prompt.summary}</div>
        )}
      </div>
    );
  }

  return (
    <div className="permission-request-details">
      <div className="permission-detail-summary">{prompt.summary}</div>
      {Object.keys(args).length > 0 && (
        <details className="permission-args-details">
          <summary>Arguments</summary>
          <pre>{JSON.stringify(args, null, 2)}</pre>
        </details>
      )}
    </div>
  );
};

const AiTaskCard: React.FC<AiTaskCardProps> = ({
  taskBilling,
  task,
  brief,
  isSelected: _isSelected,
  isWorking,
  isQueued = false,
  onRunQueuedNow,
  agentSessions,
  permissionLevel,
  isExecuting,
  executionSteps,
  pendingPermission,
  pendingHumanInput,
  pendingOllamaFallback,
  scheduledJob,
  onOpenScheduleModal,
  onSelect: _onSelect,
  onSaveBrief,
  onLiveBriefChange,
  onExecuteTask,
  onUpdateBriefWithAi: _onUpdateBriefWithAi,
  onSyncOverviewWithTask: _onSyncOverviewWithTask,
  onPermissionChoice,
  onHumanInputChoice,
  onOllamaFallbackChoice,
  onSessionExit: _onSessionExit,
  onRestartSession,
  onKillSession,
  onKillAgentSession,
  onSendTaskMessage,
  onTerminateAgent,
  onArchiveTask,
  mcpServers: _mcpServers = [],
  onUpdateTaskMcpTools: _onUpdateTaskMcpTools,
  canOpenRelatedTask,
  onOpenRelatedTask,
  fileName,
  queuePosition,
  isBridgeConnected,
  onQueue,
  onClosePane,
  onBackToRuns,
  agentPipelineOptions,
  onSetAgentPipelineOptions,
  onOpenModels,
}) => {
  // The Queued button asks before running the task out of turn.
  const [confirmRunNow, setConfirmRunNow] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [overviewText, setOverviewText] = useState('');
  const [buildVerificationText, setBuildVerificationText] = useState('');
  const [completionText, setCompletionText] = useState('');
  const [viewModeSection2, setViewModeSection2] = useState<'notes' | 'steps'>('notes');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isMcpModalOpen, setIsMcpModalOpen] = useState(false);

  const activeTaskTools = React.useMemo(() => {
    if (task.mcpRequired && task.mcpRequired.length > 0) return task.mcpRequired;
    if (brief?.selectedMcpTools && brief.selectedMcpTools.length > 0) return brief.selectedMcpTools;
    if (brief?.requiredMcps && brief.requiredMcps.length > 0) return brief.requiredMcps;
    return [];
  }, [task.mcpRequired, brief?.selectedMcpTools, brief?.requiredMcps]);
  const menuRef = useRef<HTMLDivElement>(null);

  // ── CLI agents of this task's run (manager, workers, verifier) ──
  const managerSession = agentSessions.find((s) => s.role === 'manager') ?? null;
  // The manager stands for the run in the task-level status logic (falls back to whichever agent exists).
  const terminalSession = managerSession ?? agentSessions[0] ?? null;
  const agentsWorking = agentSessions.some((s) => isAgentWorking(s.status));
  const agentsWithPrompt = agentSessions.filter((s) => s.pendingPrompt && s.session.isActive);
  const hasPendingAlert = !!(pendingPermission || pendingOllamaFallback || agentsWithPrompt.length > 0);

  const overviewRef = useRef<HTMLTextAreaElement>(null);
  const completionRef = useRef<HTMLTextAreaElement>(null);
  const [activeFocusedRef, setActiveFocusedRef] = useState<React.RefObject<HTMLTextAreaElement | null> | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);

  // Close card options dropdown on outside click or Escape
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  // Determine if this task has already been started (e.g. Overview section written up / structured / in-progress)
  // The most recent successful overview wins: a resumed run appends its own overview step after earlier ones
  // (e.g. an in-app Summary after a CLI run's `step-overview-<task>-<runId>`), and that one is current.
  const summaryStep = React.useMemo(() => {
    for (let i = executionSteps.length - 1; i >= 0; i--) {
      const s = executionSteps[i];
      if (s.stage === 'overview' && s.status === 'success' && s.overviewDocument) return s;
    }
    return undefined;
  }, [executionSteps]);

  const summaryDoc = summaryStep?.overviewDocument || null;

  // What the Summary document shows: the working brief (or, for an overview saved before it, its goals).
  const summaryDocContent = React.useMemo(() => (summaryDoc ? (summaryDoc.raw || summaryDoc.goals || '').trim() : ''), [summaryDoc]);

  // The latest run's TASK_CONTEXT.md bible (the brief as handed to the manager, plus the run's log).
  const bibleFilePath = React.useMemo(() => {
    for (let i = executionSteps.length - 1; i >= 0; i--) if (executionSteps[i].bibleFilePath) return executionSteps[i].bibleFilePath;
    return undefined;
  }, [executionSteps]);

  // An overview exists only once a run's Summary step generated it (or the user wrote one) — shared rule with the
  // run launcher (lib/overviewUtils). A newly added task stays empty: text copied from the task never shows here.
  const isRealOverview = React.useMemo(() => {
    if (summaryDoc) return true;
    return hasUsableOverview(brief ? { ...brief, overview: overviewText } : null);
  }, [summaryDoc, overviewText, brief]);
  // The task was edited after its overview was generated: still shown, but the next run regenerates it.
  const isOverviewOutdated = React.useMemo(() => Boolean(brief) && isOverviewStale(brief, task), [brief, task]);
  // The user's own wording wins over the Summary document of the run it replaced.
  const showOverviewText = brief?.overviewSource === 'user';

  // Structured (Summary-agent style) overview text: what counts as evidence that the task was already started.
  // Kept stricter than isRealOverview so a hand-written overview alone doesn't mark a task as started.
  const hasStructuredOverview = React.useMemo(() => {
    if (summaryDoc) return true;
    const trimmed = overviewText.trim();
    if (!trimmed || !isRealOverview) return false;
    return isTaskBrief(trimmed);
  }, [summaryDoc, overviewText, isRealOverview]);

  // Determine if this task has already been started
  const isTaskStarted = React.useMemo(() => {
    if (isWorking || isExecuting) return true;
    if (task.isDone || task.status === 'done' || task.status === 'in_progress') return true;
    if (brief?.status === 'done' || brief?.status === 'in_progress') return true;
    if (executionSteps && executionSteps.length > 0) return true;
    if (terminalSession?.session) return true;
    if (completionText && completionText.trim().length > 0) return true;
    if (buildVerificationText && buildVerificationText.trim().length > 0) return true;
    if (brief?.built && brief.built.trim().length > 0) return true;
    if (brief?.validation && brief.validation.trim().length > 0) return true;
    if (hasStructuredOverview) return true;
    return false;
  }, [
    isWorking,
    isExecuting,
    task.isDone,
    task.status,
    brief?.status,
    brief?.built,
    brief?.validation,
    executionSteps,
    terminalSession,
    buildVerificationText,
    completionText,
    hasStructuredOverview,
  ]);



  // The stage tab shown below the token card (follows the run; see the stage tabs block below).
  const [activeStage, setActiveStage] = useState<TaskStageKey>('overview');

  // Open Actions (Steps view) when an interactive clarification prompt is waiting
  useEffect(() => {
    if (pendingHumanInput) {
      setActiveStage('actions');
      setViewModeSection2('steps');
    }
  }, [pendingHumanInput]);

  // Open Actions once for every new request that needs the user: a pipeline permission prompt, an Ollama
  // fallback, or a prompt on any CLI agent's screen (keyed by prompt signature, so repaints don't re-expand it).
  const alertKeys = [
    pendingPermission ? `perm:${pendingPermission.id}` : '',
    pendingOllamaFallback ? `ollama:${pendingOllamaFallback.prompt.id}` : '',
    ...agentsWithPrompt.map((s) => `cli:${s.ptySessionId}:${s.pendingPrompt!.signature}`),
  ].filter(Boolean);
  const alertKeysSig = alertKeys.join('\u0000');
  const seenAlertKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let isNew = false;
    for (const key of alertKeys) {
      if (!seenAlertKeysRef.current.has(key)) {
        seenAlertKeysRef.current.add(key);
        isNew = true;
      }
    }
    if (isNew) setActiveStage('actions');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertKeysSig]);

  // Sync state with brief
  useEffect(() => {
    if (brief) {
      // Text that was only copied in from the task (or drafted elsewhere) isn't an overview: start empty.
      const newOverview = hasUsableOverview(brief) ? brief.overview || brief.brief || '' : '';
      const newBuild = brief.buildAndVerification || brief.built || '';
      const newCompletion = brief.completion || brief.validation || brief.humanReview || brief.followUps || '';

      setOverviewText(newOverview);
      setBuildVerificationText(newBuild);
      setCompletionText(newCompletion);
    } else {
      setOverviewText('');
      setBuildVerificationText('');
      setCompletionText('');
    }
  }, [task.id, brief]);

  // Leave edit mode when switching tasks or when the task's status changes
  useEffect(() => {
    setIsEditing(false);
  }, [task.id, task.status, task.isDone]);

  const prevWorkingRef = useRef(isWorking);
  useEffect(() => {
    const wasWorking = prevWorkingRef.current;
    prevWorkingRef.current = isWorking;

    // A run starting opens the Runs tab on it
    if (!wasWorking && isWorking) setActiveStage('actions');
  }, [isWorking]);

  const isContextRunning =
    isExecuting && executionSteps.some((s) => s.stage === 'context' && s.status === 'running');
  const isGatheringContext =
    isExecuting &&
    (isContextRunning ||
      executionSteps.length === 0 ||
      !executionSteps.some((s) => s.stage === 'overview' || s.stage === 'execution' || s.stage === 'built_record' || s.stage === 'done'));
  // The context step that carries the assembled context (the pipeline's model-routing step is a context step too).
  const contextStep = React.useMemo(
    () =>
      [...executionSteps].reverse().find((s) => s.stage === 'context' && s.baselineContext) ||
      executionSteps.find((s) => s.stage === 'context'),
    [executionSteps]
  );

  // ── Card Status Computations (Not started | Working... | Done) ──
  // The Summary agent (pipeline) or the overview synthesis (CLI runs) is writing the overview right now.
  const isOverviewSynthesizing = isExecuting && executionSteps.some((s) => s.stage === 'overview' && s.status === 'running');
  const isOverviewWorking = isExecuting && (isGatheringContext || isOverviewSynthesizing);

  const overviewStatus = React.useMemo<'not_started' | 'working' | 'done'>(() => {
    if (isOverviewWorking) {
      return 'working';
    }
    if (isRealOverview) {
      return 'done';
    }
    return 'not_started';
  }, [isOverviewWorking, isRealOverview]);

  const isRelatedWorking =
    isExecuting && executionSteps.some((s) => s.stage === 'context' && s.status === 'running');

  const relatedTasksStatus = React.useMemo<'not_started' | 'working' | 'done'>(() => {
    if (isRelatedWorking) {
      return 'working';
    }
    if (
      Boolean(contextStep?.baselineContext) ||
      executionSteps.some((s) => s.stage === 'context' && s.status === 'success') ||
      (task.isDone && executionSteps.length > 0)
    ) {
      return 'done';
    }
    return 'not_started';
  }, [isRelatedWorking, contextStep, executionSteps, task.isDone]);

  // Header tag: "2 related · 9 candidates" once matched (legacy context steps: memory hits / guidelines).
  const { relatedSelectedCount } = React.useMemo(() => {
    const bc = contextStep?.baselineContext;
    if (!bc) return { relatedSummaryTag: null, relatedSelectedCount: 0 };
    if (!bc.relatedCandidates) {
      return { relatedSummaryTag: `${bc.memoryHits?.length || 0} hits · ${bc.guidelines?.length || 0} guidelines`, relatedSelectedCount: 0 };
    }
    const total = bc.relatedCandidates.length + (bc.relatedNotes?.length || 0);
    if (total === 0) return { relatedSummaryTag: 'none found', relatedSelectedCount: 0 };
    const known = new Set([...bc.relatedCandidates.map((c) => String(c.taskId)), ...(bc.relatedNotes || []).map((n) => n.id)]);
    const selectedCount = bc.selectedRelatedTaskIds ? bc.selectedRelatedTaskIds.filter((id) => known.has(String(id))).length : null;
    const candidatesLabel = `${total} candidate${total === 1 ? '' : 's'}`;
    return {
      relatedSummaryTag: selectedCount === null ? candidatesLabel : `${selectedCount} related · ${candidatesLabel}`,
      relatedSelectedCount: selectedCount || 0,
    };
  }, [contextStep]);

  const isStepsWorking =
    agentsWorking ||
    (isExecuting &&
      !isGatheringContext &&
      !isOverviewWorking &&
      (isWorking ||
        executionSteps.some(
          (s) =>
            s.stage !== 'context' &&
            s.stage !== 'overview' &&
            s.stage !== 'built_record' &&
            s.stage !== 'done' &&
            s.status === 'running'
        )));

  const stepsActionsStatus = React.useMemo<'not_started' | 'working' | 'done'>(() => {
    if (isStepsWorking) {
      return 'working';
    }
    if (
      (terminalSession && !agentsWorking) ||
      task.isDone ||
      task.status === 'done' ||
      (executionSteps.some(
        (s) =>
          s.stage === 'execution' ||
          s.stage === 'subagent' ||
          s.stage === 'mcp_call' ||
          s.stage === 'built_record' ||
          s.stage === 'done'
      ) &&
        !isExecuting) ||
      (!isExecuting && buildVerificationText.trim().length > 0 && executionSteps.length > 0)
    ) {
      return 'done';
    }
    return 'not_started';
  }, [isStepsWorking, terminalSession, agentsWorking, task.isDone, task.status, executionSteps, isExecuting, buildVerificationText]);

  // The completion log is being written (pipeline Logger, or App finalizing a CLI run via a running built_record step).
  // A stale running step persisted from an interrupted session only counts while the card has no completion text.
  const isCompletionStepRunning = executionSteps.some(
    (s) => (s.stage === 'built_record' || s.stage === 'done') && s.status === 'running'
  );
  const isCompletionWorking =
    isCompletionStepRunning && (isExecuting || agentsWorking || completionText.trim().length === 0);

  const completionStatus = React.useMemo<'not_started' | 'working' | 'done'>(() => {
    if (isCompletionWorking) {
      return 'working';
    }
    if (
      task.isDone ||
      task.status === 'done' ||
      completionText.trim().length > 0 ||
      executionSteps.some((s) => (s.stage === 'built_record' || s.stage === 'done') && s.status === 'success')
    ) {
      return 'done';
    }
    return 'not_started';
  }, [isCompletionWorking, task.isDone, task.status, completionText, executionSteps]);

  // ── Stage tabs: Related Tasks → Overview → Actions → Completion ──
  // A tab unlocks once the run reaches its stage (Overview is always open: it can be written before a run, and holds the
  // "no overview yet" hint). The shown tab follows the run: the first stage working, else the furthest one done. A tab
  // the user picks stays until the run moves to another stage.
  const stageStatus: Record<TaskStageKey, CardStatus> = {
    related: relatedTasksStatus,
    overview: overviewStatus,
    actions: stepsActionsStatus,
    completion: completionStatus,
  };
  const stageReached = (key: TaskStageKey): boolean =>
    key === 'overview' ||
    stageStatus[key] !== 'not_started' ||
    (key === 'actions' && (agentSessions.length > 0 || hasPendingAlert || Boolean(pendingHumanInput))) ||
    (key === 'completion' && isEditing);
  const currentStage: TaskStageKey =
    TASK_STAGES.find((s) => stageStatus[s.key] === 'working')?.key ??
    [...TASK_STAGES].reverse().find((s) => stageStatus[s.key] === 'done')?.key ??
    'overview';
  React.useLayoutEffect(() => {
    setActiveStage(currentStage);
  }, [currentStage, task.id]);
  const shownStage: TaskStageKey = stageReached(activeStage) ? activeStage : currentStage;

  // Determine what to display in Section 2 (Build & Verification / Steps & Actions)
  const showExecutionSteps = viewModeSection2 === 'steps' && !isEditing;

  // Editing the overview makes it the user's (kept and reused by runs); clearing it lets the next run generate one.
  const overviewProvenance = (text: string): Partial<AgentContextItem> => {
    const original = (brief?.overview || brief?.brief || '').trim();
    if (text.trim() === original) return {};
    if (!text.trim()) return { overviewSource: undefined, overviewTaskHash: undefined };
    return { overviewSource: 'user', overviewTaskHash: overviewTaskFingerprint(task) };
  };

  const handleFieldChange = (
    field: 'overview' | 'buildAndVerification' | 'completion',
    value: string
  ) => {
    let newOverview = overviewText;
    let newBuild = buildVerificationText;
    let newCompletion = completionText;

    if (field === 'overview') {
      setOverviewText(value);
      newOverview = value;
    } else if (field === 'buildAndVerification') {
      setBuildVerificationText(value);
      newBuild = value;
    } else if (field === 'completion') {
      setCompletionText(value);
      newCompletion = value;
    }

    if (onLiveBriefChange) {
      onLiveBriefChange({
        ...brief,
        id: brief?.id || `brief_${task.id}`,
        sourceTaskId: task.id,
        sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
        itemNumber: brief?.itemNumber,
        title: task.title,
        status: task.status,
        ...overviewProvenance(newOverview),
        overview: newOverview,
        buildAndVerification: newBuild,
        completion: newCompletion,
        brief: newOverview,
        built: newBuild,
        validation: newCompletion,
        humanReview: newCompletion,
        followUps: newCompletion,
      });
    }
  };

  // Task menu → "Verification" (on by default). A task that has never run gets its brief record here.
  const verificationOn = brief?.verification !== false;
  const toggleVerification = () => {
    onSaveBrief({
      ...(brief || {
        title: task.title,
        status: task.status,
        overview: '',
        buildAndVerification: '',
        completion: '',
      }),
      id: brief?.id || `brief_${task.id}`,
      sourceTaskId: task.id,
      sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
      verification: !verificationOn,
    });
  };

  const handleSave = () => {
    onSaveBrief({
      ...brief,
      id: brief?.id || `brief_${task.id}`,
      sourceTaskId: task.id,
      sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
      itemNumber: brief?.itemNumber,
      title: task.title,
      status: task.status,
      ...overviewProvenance(overviewText),
      overview: overviewText,
      buildAndVerification: buildVerificationText,
      completion: completionText,
      brief: overviewText,
      built: buildVerificationText,
      validation: completionText,
      humanReview: completionText,
      followUps: completionText,
    });
    setIsEditing(false);
  };

  const handleCancel = () => {
    if (brief) {
      const originalOverview = brief.overview || brief.brief || '';
      const originalBuild = brief.buildAndVerification || brief.built || '';
      const originalCompletion = brief.completion || brief.validation || brief.humanReview || brief.followUps || '';

      setOverviewText(originalOverview);
      setBuildVerificationText(originalBuild);
      setCompletionText(originalCompletion);

      if (onLiveBriefChange) {
        onLiveBriefChange({
          ...brief,
          id: brief.id || `brief_${task.id}`,
          sourceTaskId: task.id,
          sourceLaneId: task.swimLaneId || brief.sourceLaneId,
          itemNumber: brief.itemNumber,
          title: task.title,
          status: task.status,
          overview: originalOverview,
          buildAndVerification: originalBuild,
          completion: originalCompletion,
          brief: originalOverview,
          built: originalBuild,
          validation: originalCompletion,
          humanReview: originalCompletion,
          followUps: originalCompletion,
        });
      }
    } else {
      setOverviewText('');
      setBuildVerificationText('');
      setCompletionText('');

      if (onLiveBriefChange) {
        onLiveBriefChange({
          id: `brief_${task.id}`,
          sourceTaskId: task.id,
          sourceLaneId: task.swimLaneId,
          title: task.title,
          status: task.status,
          overview: '',
          buildAndVerification: '',
          completion: '',
          brief: '',
          built: '',
          validation: '',
          humanReview: '',
          followUps: '',
        });
      }
    }
    setIsEditing(false);
  };

  // const renderStatusBadge = () => {
  //   if (isWorking) {
  //     return (
  //       <span className="task-status-pill status-working">
  //         <Loader2 size={12} className="spin-animate" />
  //         <span>Working...</span>
  //       </span>
  //     );
  //   }
  //   if (task.isDone || task.status === 'done') {
  //     return (
  //       <span className="task-status-pill status-done">
  //         <CheckCircle2 size={12} />
  //         <span>Done</span>
  //       </span>
  //     );
  //   }
  //   if (task.status === 'in_progress') {
  //     return (
  //       <span className="task-status-pill status-in-progress">
  //         <Clock size={12} />
  //         <span>In Progress</span>
  //       </span>
  //     );
  //   }
  //   return (
  //     <span className="task-status-pill status-not-started">
  //       <CircleDot size={12} />
  //       {/* <span>Not Started</span> */}
  //     </span>
  //   );
  // };

  const isTaskDone = Boolean(task.isDone || task.status === 'done' || brief?.status === 'done');

  // Has this task been stopped partway through?
  const isStoppedPartway = React.useMemo(() => {
    if (isWorking) return false;
    if (isTaskDone) return false;
    const hasCompletedSuccessfully = executionSteps.some((s) => (s.stage === 'built_record' || s.stage === 'done') && s.status === 'success');
    // Explicitly cancelled step or terminated (a run resumed after a stop and then finished keeps its cancelled steps)
    if (!hasCompletedSuccessfully && executionSteps.some((s) => s.status === 'cancelled' || s.id === 'step-terminated')) return true;
    // The run's manager was stopped or failed
    if (terminalSession && (terminalSession.status === 'cancelled' || terminalSession.status === 'failed')) return true;
    // Terminal session killed with non-zero exit code
    if (terminalSession?.session && !terminalSession.session.isActive && terminalSession.session.exitCode !== 0 && terminalSession.session.exitCode !== undefined && terminalSession.status !== 'done') return true;
    // Task or brief status marked partly_done and not yet fully completed
    if ((task.status === 'partly_done' || brief?.status === 'partly_done') && !hasCompletedSuccessfully) return true;
    // Has partial execution steps without having finished successfully
    if (executionSteps.length > 0 && !hasCompletedSuccessfully) return true;
    return false;
  }, [isWorking, isTaskDone, task.status, brief?.status, executionSteps, terminalSession]);

  // Has this task already been run before (and completed / not stopped partway)?
  const hasRunBefore = React.useMemo(() => {
    if (isWorking || isStoppedPartway) return false;
    if (isTaskDone) return true;
    if (executionSteps.some((s) => (s.stage === 'built_record' || s.stage === 'done') && s.status === 'success')) return true;
    if (terminalSession?.status === 'done') return true;
    if (terminalSession?.session && !terminalSession.session.isActive && terminalSession.session.exitCode === 0) return true;
    if ((brief?.completion && brief.completion.trim().length > 0) || (brief?.validation && brief.validation.trim().length > 0)) return true;
    return false;
  }, [isWorking, isStoppedPartway, isTaskDone, executionSteps, terminalSession, brief?.completion, brief?.validation]);

  // ── Which agent the Notes view shows ──
  // By default the view follows the agent that matters right now (pickLiveAgent), switching after a short debounce
  // and always announcing the switch; picking another agent's tab pins it until the live agent's tab is picked.
  const [followLive, setFollowLive] = useState(true);
  const [pinnedAgentId, setPinnedAgentId] = useState<string | null>(null);
  const [followedAgentId, setFollowedAgentId] = useState<string | null>(null);
  const [switchBanner, setSwitchBanner] = useState<{
    toId: string;
    toLabel: string;
    reason: string;
    fromId: string;
    fromLabel: string;
  } | null>(null);
  const agentSessionsRef = useRef(agentSessions);
  agentSessionsRef.current = agentSessions;
  const agentIdsKey = agentSessions.map((s) => s.ptySessionId).join('|');

  // A new run starts with following switched back on.
  const runId = managerSession?.runId || '';
  const prevRunIdRef = useRef(runId);
  useEffect(() => {
    if (runId && prevRunIdRef.current && runId !== prevRunIdRef.current) {
      setFollowLive(true);
      setPinnedAgentId(null);
      setSwitchBanner(null);
    }
    prevRunIdRef.current = runId;
  }, [runId]);

  const livePick = React.useMemo(() => pickLiveAgent(agentSessions), [agentSessions]);
  const livePickId = livePick?.session.ptySessionId ?? null;
  const livePickReason = livePick?.reason ?? '';

  useEffect(() => {
    if (!followLive) return;
    if (!livePickId) {
      setFollowedAgentId(null);
      return;
    }
    if (livePickId === followedAgentId) return;
    const current = followedAgentId ? agentSessionsRef.current.find((s) => s.ptySessionId === followedAgentId) : undefined;
    if (!current) {
      // First agent of the run (or the one shown is gone): nothing to announce.
      setFollowedAgentId(livePickId);
      return;
    }
    const timer = setTimeout(() => {
      const from = agentSessionsRef.current.find((s) => s.ptySessionId === followedAgentId);
      const to = agentSessionsRef.current.find((s) => s.ptySessionId === livePickId);
      setFollowedAgentId(livePickId);
      if (from && to) {
        setSwitchBanner({ toId: to.ptySessionId, toLabel: to.label, reason: livePickReason, fromId: from.ptySessionId, fromLabel: from.label });
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [followLive, livePickId, livePickReason, followedAgentId, agentIdsKey]);

  const shownAgent: SpawnedSession | null = (() => {
    if (!followLive && pinnedAgentId) {
      const pinned = agentSessions.find((s) => s.ptySessionId === pinnedAgentId);
      if (pinned) return pinned;
    }
    return agentSessions.find((s) => s.ptySessionId === followedAgentId) ?? livePick?.session ?? null;
  })();

  // Picking an agent's tab pins it; picking the agent that is live right now goes back to following.
  const pinAgent = (ptySessionId: string) => {
    setSwitchBanner(null);
    if (ptySessionId === livePickId) {
      setPinnedAgentId(null);
      setFollowedAgentId(livePickId);
      setFollowLive(true);
    } else {
      setPinnedAgentId(ptySessionId);
      setFollowLive(false);
    }
  };

  // "Manager is waiting on …" while it handed work to workers / verifier.
  const managerWaitingOn = React.useMemo(() => {
    if (managerSession?.status !== 'waiting') return null;
    const workers = agentSessions.filter((s) => s.role === 'worker' && isAgentWorking(s.status));
    if (workers.length > 0) {
      return { text: `Manager is waiting on ${workers.length} worker${workers.length === 1 ? '' : 's'}`, agents: workers };
    }
    const verifier = agentSessions.filter((s) => s.role === 'verifier' && isAgentWorking(s.status));
    if (verifier.length > 0) return { text: 'Manager is waiting on verifier', agents: verifier };
    return { text: 'Manager is waiting for its agents to report back', agents: [] as SpawnedSession[] };
  }, [managerSession?.status, agentSessions]);

  // Header chip: which agent is working right now (the shown one when it is working). In-app pipeline runs have no
  // terminals, so their running step's agent role is used instead.
  const nowRunningAgent =
    shownAgent && isAgentWorking(shownAgent.status) ? shownAgent : livePick && isAgentWorking(livePick.session.status) ? livePick.session : null;
  const runningPipelineStep =
    !nowRunningAgent && isExecuting
      ? [...executionSteps].reverse().find((st) => st.status === 'running' && st.agentRole)
      : undefined;

  // ── Task prompt box ── mid-run it steers the agents; after the run it continues it (never a restart).
  const runActive = isWorking || isExecuting || agentsWorking;
  // What the working agent is doing right now, above the prompt box (an in-app pipeline run: its running step).
  const liveStatusFor = (agent: SpawnedSession | null, showBadge: boolean) =>
    !runActive ? null : agent ? (
      <AgentLiveStatus
        key={agent.ptySessionId}
        ptySessionId={agent.ptySessionId}
        status={agent.status}
        role={agent.role}
        pieceId={agent.pieceId}
        label={agent.label}
        showBadge={showBadge && agent.role !== 'manager'}
      />
    ) : runningPipelineStep ? (
      <AgentLiveStatus fallbackText={runningPipelineStep.title} />
    ) : null;
  const hasEverRun = runActive || executionSteps.length > 0 || agentSessions.length > 0 || Boolean(brief?.completion?.trim());
  // In-app pipeline: workers running right now can be addressed directly.
  const pipelineWorkerTargets = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ pieceId: string; label: string }> = [];
    for (const st of executionSteps) {
      if (st.agentRole !== 'worker' || !st.pieceId || st.ptySessionId || st.status !== 'running' || seen.has(st.pieceId)) continue;
      seen.add(st.pieceId);
      out.push({ pieceId: st.pieceId, label: `Worker ${st.pieceId}` });
    }
    return out;
  }, [executionSteps]);
  const sendTaskMessage = onSendTaskMessage
    ? (text: string, opts: TaskMessageOptions) => onSendTaskMessage(task, text, opts)
    : undefined;

  // Prompts on agents the user isn't looking at in the Notes view (or any prompt while in Steps view).
  const offscreenPromptAgents = agentsWithPrompt.filter(
    (s) => showExecutionSteps || s.ptySessionId !== shownAgent?.ptySessionId
  );

  // Steps view: each agent's terminal lives under its own step (step.ptySessionId). Legacy manager steps without
  // an id take the manager's terminal; sessions no step claims are listed under "Agent terminals".
  const { stepTerminals, unclaimedAgents } = React.useMemo(() => {
    const byId = new Map(agentSessions.map((s) => [s.ptySessionId, s] as const));
    const map = new Map<string, SpawnedSession>();
    const claimed = new Set<string>();
    // Latest step wins (a verifier retry reuses the verifier session id).
    for (let i = executionSteps.length - 1; i >= 0; i--) {
      const st = executionSteps[i];
      const agent = st.ptySessionId ? byId.get(st.ptySessionId) : undefined;
      if (agent && !claimed.has(agent.ptySessionId)) {
        map.set(st.id, agent);
        claimed.add(agent.ptySessionId);
      }
    }
    if (managerSession && !claimed.has(managerSession.ptySessionId)) {
      // Only CLI manager steps (`step-manager-*`, written before steps carried a ptySessionId) qualify: in-app
      // pipeline steps also use agentRole 'manager' / stage 'execution' but never belong to a CLI terminal.
      const legacy = [...executionSteps]
        .reverse()
        .find((st) => !st.ptySessionId && st.id.startsWith('step-manager-'));
      if (legacy) {
        map.set(legacy.id, managerSession);
        claimed.add(managerSession.ptySessionId);
      }
    }
    return { stepTerminals: map, unclaimedAgents: agentSessions.filter((s) => !claimed.has(s.ptySessionId) && s.status !== 'waiting') };
  }, [executionSteps, agentSessions, managerSession]);

  /** Terminal for one agent (attach-only: App launched it), headed by who it is. */
  const renderAgentTerminal = (agent: SpawnedSession) => {
    const canStop = agent.session.isActive && (onKillAgentSession || (agent.role === 'manager' && onKillSession));
    return (
      <ResizableTerminalContainer
        key={agentViewKey(agent)}
        defaultHeight={380}
        minHeight={200}
        maxHeight={800}
        maximizedHeight={680}
        storageKey={`ergo_terminal_height_${agent.role}`}
        headerLeft={
          <div className="agent-terminal-header">
            <AgentRoleBadge role={agent.role} pieceId={agent.pieceId} label={agent.label} size="md" />
            <span className="agent-terminal-sep">·</span>
            <span className="agent-terminal-cmd">{agent.cmd}</span>
            <span className="agent-terminal-sep">·</span>
            <span className={`agent-terminal-status status-${agent.status}`}>
              <AgentStatusDot status={agent.status} />
              <span>{agentStatusLabel(agent.status)}</span>
            </span>
            <span className="agent-terminal-cwd" title={agent.cwd}>cwd: {agent.cwd}</span>
          </div>
        }
        headerRight={
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            {agent.role === 'manager' && onRestartSession && (
              <button
                type="button"
                className="terminal-ctrl-btn"
                onClick={() => onRestartSession(task)}
                title="Restart the task run (relaunches the Manager)"
              >
                <RotateCcw size={10} />
                <span>Restart</span>
              </button>
            )}
            {canStop && (
              <button
                type="button"
                className="terminal-ctrl-btn is-danger"
                onClick={() => (onKillAgentSession ? onKillAgentSession(agent.ptySessionId) : onKillSession?.(task.id))}
                title={`Stop ${agent.label}`}
              >
                <Square size={10} />
                <span>Stop</span>
              </button>
            )}
          </div>
        }
      >
        <AgentTerminal attachOnly sessionId={agent.ptySessionId} cmd={agent.cmd} args={agent.args} cwd={agent.cwd} />
      </ResizableTerminalContainer>
    );
  };

  const categoryName =
    task.category?.trim() && task.category !== 'AI Workspace' && task.category !== 'Untitled'
      ? cleanHeading(task.category)
      : '';
  const runCount = agentSessions.length > 0 || executionSteps.length > 0 ? Math.max(1, new Set(agentSessions.map((x) => x.runId)).size) : 0;
  const statusKind: DesignTaskStatus = isWorking
    ? 'progress'
    : isQueued
      ? 'queued'
      : task.isDone
        ? 'done'
        : brief?.lastRunOutcome?.outcome === 'failed' || brief?.lastRunOutcome?.outcome === 'verifier_failed'
          ? 'failed'
          : hasRunBefore
            ? 'review'
            : 'todo';
  const lineLabel = task.sourceLine != null ? `${fileName}:${task.sourceLine + 1}` : null;
  const notes = task.subtasks ?? [];
  const usage = brief?.totalUsage ?? task.totalUsage;
  const tokenTotal = usage ? usage.inputTokens + usage.outputTokens : 0;
  const effortLevel = agentPipelineOptions?.effortLevel ?? 'medium';
  const modelSelection = agentPipelineOptions?.modelSelection ?? 'auto';
  const setPipeline = (patch: Partial<AgentPipelineOptions>) => {
    if (agentPipelineOptions && onSetAgentPipelineOptions) onSetAgentPipelineOptions({ ...agentPipelineOptions, ...patch });
  };
  const canRun = isBridgeConnected !== false;
  const completionNote = (brief?.completion || '').trim();
  const outcome = brief?.lastRunOutcome?.outcome;

  const moreItems: MenuItem[] = [
    ...(isStoppedPartway
      ? [
          { label: 'Resume where it stopped', icon: Play, onSelect: () => onExecuteTask(task) },
          { label: 'Start over', icon: RotateCcw, onSelect: () => onExecuteTask(task, { startOver: true }) },
          { separator: true } as const,
        ]
      : []),
    ...(hasRunBefore && !isStoppedPartway ? [{ label: 'Run again', icon: RotateCcw, onSelect: () => onExecuteTask(task) }, { separator: true } as const] : []),
    {
      label: 'Edit overview',
      icon: Edit3,
      onSelect: () => {
        setIsEditing(true);
        setViewModeSection2('notes');
        setActiveStage('overview');
      },
    },
    {
      label: scheduledJob && scheduledJob.status === 'pending' ? 'Edit schedule' : 'Schedule',
      icon: Calendar,
      hint: scheduledJob && scheduledJob.status === 'pending' ? new Date(scheduledJob.scheduledTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : undefined,
      onSelect: () => onOpenScheduleModal?.(task),
    },
    {
      label: 'Tools for this task',
      icon: Wrench,
      hint: activeTaskTools.length > 0 ? String(activeTaskTools.length) : undefined,
      onSelect: () => setIsMcpModalOpen(true),
    },
    (() => {
      const verifierSession = agentSessions.find((s) => s.role === 'verifier');
      const isVerifierActiveOrDone = Boolean(
        verifierSession && ['running', 'starting', 'done', 'failed'].includes(verifierSession.status),
      );
      return {
        label: 'Verification',
        icon: ShieldCheck,
        checked: verificationOn,
        disabled: runActive && isVerifierActiveOrDone,
        title: runActive && isVerifierActiveOrDone
          ? "Can't change this while the verifier is running or finished"
          : 'A separate verifier agent checks the finished work and sends it back to the manager if it fails.',
        onSelect: () => toggleVerification(),
      };
    })(),
    { separator: true },
    { label: 'Archive', icon: Archive, onSelect: () => onArchiveTask?.(task.title || brief?.title || '') },
  ];

  const modelItems: MenuItem[] = [
    { section: 'Model selection' },
    { label: 'Auto', checked: modelSelection === 'auto', onSelect: () => setPipeline({ modelSelection: 'auto' }) },
    { label: 'Manual', checked: modelSelection === 'manual', onSelect: () => setPipeline({ modelSelection: 'manual' }) },
    { section: 'Effort' },
    ...(Object.keys(EFFORT_LABELS) as EffortLevel[]).map((lvl) => ({
      label: EFFORT_LABELS[lvl],
      checked: effortLevel === lvl,
      onSelect: () => setPipeline({ effortLevel: lvl }),
    })),
    { separator: true },
    { label: 'Models and providers', icon: Settings2, onSelect: () => onOpenModels?.() },
  ];

  return (
    <div ref={cardRef} className={`eg-taskdetail ${isWorking ? 'is-running' : ''}`}>
      <div className="eg-detail-head eg-detail-head-task">
        {onBackToRuns && (
          <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBackToRuns} className="eg-back-btn" title="Back to all runs">
            All runs
          </Button>
        )}
        <span className="eg-detail-crumb">{fileName.replace(/\.md$/i, '')}</span>
        {categoryName && (
          <>
            <span className="eg-crumb-sep">›</span>
            <span className="eg-detail-crumb is-current">{categoryName}</span>
          </>
        )}
        <span className="eg-spacer" />
        <MenuButton align="end" width={240} items={moreItems} trigger={(p) => <IconButton {...p} icon={MoreHorizontal} size="sm" label="More" />} />
        {onClosePane && <IconButton icon={X} size="sm" label={`Close (${MOD}J)`} onClick={onClosePane} />}
      </div>

      <div className="eg-detail-body">
        <h1 className="eg-detail-title">{brief?.title || task.title}</h1>
        {notes.length > 0 ? (
          <div className="eg-detail-desc">
            <ul className="eg-detail-notes">
              {notes.map((n, i) => (
                <li key={i} className={n.isDone ? 'is-done' : undefined}>
                  <MarkdownRenderer content={n.text} />
                </li>
              ))}
            </ul>
            <p className="eg-detail-hint">From {fileName.replace(/\.md$/i, '')}. Edit the lines in the document to change this.</p>
          </div>
        ) : !brief?.sourceTaskId && brief?.sourceContent ? (
          <div className="eg-detail-desc">
            <MarkdownRenderer content={brief.sourceContent} />
          </div>
        ) : null}

        <div className="eg-props">
          <span className="eg-prop-k">Status</span>
          <span className="eg-prop-v">
            <span className="eg-chip">
              <StatusIcon status={statusKind} />
              {STATUS_LABEL[statusKind]}
            </span>
          </span>
          {lineLabel && (
            <>
              <span className="eg-prop-k">Line</span>
              <span className="eg-prop-v eg-mono-sm">{lineLabel}</span>
            </>
          )}
          {isQueued && (
            <>
              <span className="eg-prop-k">Queue</span>
              <span className="eg-prop-v">
                <span className="eg-chip">
                  <StatusIcon status="queued" />
                  Queued {queuePosition != null ? queuePosition + 1 : ''}
                </span>
                {onRunQueuedNow && (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRunNow(true)}>
                    Run now instead
                  </Button>
                )}
              </span>
            </>
          )}
          {scheduledJob && scheduledJob.status === 'pending' && (
            <>
              <span className="eg-prop-k">Scheduled</span>
              <span className="eg-prop-v">
                <button type="button" className="eg-chip eg-chip-btn" onClick={() => onOpenScheduleModal?.(task)}>
                  <Icon icon={Clock} size="sm" />
                  {new Date(scheduledJob.scheduledTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {scheduledJob.cronExpression ? ` · ${scheduledJob.cronExpression}` : ''}
                </button>
              </span>
            </>
          )}
          {relatedSelectedCount > 0 && (
            <>
              <span className="eg-prop-k">Related</span>
              <span className="eg-prop-v">
                <button type="button" className="eg-chip eg-chip-btn" onClick={() => setActiveStage('related')}>
                  {relatedSelectedCount} related task{relatedSelectedCount === 1 ? '' : 's'}
                </button>
              </span>
            </>
          )}
          {activeTaskTools.length > 0 && (
            <>
              <span className="eg-prop-k">Tools</span>
              <span className="eg-prop-v">
                <button type="button" className="eg-chip eg-chip-btn" onClick={() => setIsMcpModalOpen(true)}>
                  {activeTaskTools.length} selected
                </button>
              </span>
            </>
          )}
          {tokenTotal ? (
            <>
              <span className="eg-prop-k">Tokens</span>
              <span className="eg-prop-v eg-tabular">{formatTokens(tokenTotal)}</span>
            </>
          ) : null}
        </div>

        {!canRun && (
          <Banner
            icon={Unplug}
            title="Runs are paused — the bridge isn't reachable"
            text="Tasks and briefs still save to TODO.md. Queued runs start when it's back."
            className="eg-detail-banner"
          />
        )}
        {!runActive && hasRunBefore && !task.isDone && outcome && (
          <Banner
            tone={outcome === 'failed' || outcome === 'verifier_failed' ? 'danger' : 'warning'}
            icon={outcome === 'failed' || outcome === 'verifier_failed' ? CircleX : CircleDot}
            title={
              outcome === 'failed'
                ? 'The last run failed'
                : outcome === 'verifier_failed'
                  ? "The last run didn't pass verification"
                  : outcome === 'stopped'
                    ? 'You stopped the last run'
                    : 'Ready for your review'
            }
            text={
              completionNote
                ? 'The completion note is under Notes.'
                : "The agent didn't write a completion note — check its terminal output under Runs."
            }
            actions={
              <Button size="sm" onClick={() => setActiveStage(completionNote ? 'completion' : 'actions')}>
                {completionNote ? 'Read the note' : 'Open runs'}
              </Button>
            }
            className="eg-detail-banner"
          />
        )}

      {/* ── Brief · Runs · Notes · Related ── */}
      {(
        <div className="ai-task-card-body">
          {/* Rich Text Toolbar when editing */}
          {isEditing && (
            <div className="obsidian-toolbar-row" style={{ marginBottom: '0.75rem' }}>
              <RichTextToolbar
                targetRef={activeFocusedRef || overviewRef}
                compact={true}
              />
            </div>
          )}

          <div className="brief-container" style={{ padding: 0, gap: '0.45rem' }}>
            {/* "How did this task do?" after an Auto run Ergo can't judge well on its own */}
            <RunSurveyCard record={brief?.lastRunOutcome} hidden={runActive} />

            {/* ═══════════════════════════════════════════════════════════
                STAGES: one tab per stage, unlocked as the run reaches it
               ═══════════════════════════════════════════════════════════ */}
            <div className={`stage-tabs-card stage-${shownStage} ${shownStage === 'actions' && hasPendingAlert ? 'has-pending-alert' : ''}`}>
              <div className="eg-detail-tabs">
                <Tabs<TaskStageKey>
                  value={shownStage}
                  onChange={(key) => {
                    if (stageReached(key)) setActiveStage(key);
                  }}
                  items={TASK_STAGES.map(({ key, label }) => {
                    const status = stageStatus[key];
                    const attention = key === 'actions' && hasPendingAlert;
                    return {
                      id: key,
                      label,
                      disabled: !stageReached(key),
                      title: stageReached(key) ? undefined : `${label} opens when a run gets here`,
                      count: key === 'related' && relatedSelectedCount > 0 ? relatedSelectedCount : key === 'actions' && runCount > 0 ? runCount : undefined,
                      marker: attention ? <StatusDot state="warning" label="Waiting for you" /> : status === 'working' ? <StatusDot state="live" label="Working" /> : undefined,
                    };
                  })}
                />
                <span className="eg-detail-tabs-actions">
                  {isEditing ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={handleCancel}>
                        Cancel
                      </Button>
                      <Button size="sm" icon={Save} onClick={handleSave}>
                        Save
                      </Button>
                    </>
                  ) : (shownStage === 'overview' || shownStage === 'completion') ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Pencil}
                      onClick={() => {
                        setIsEditing(true);
                        setViewModeSection2('notes');
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                </span>
              </div>
              {shownStage === 'overview' && (
                <div className="eg-detail-meta">
                  {brief?.overviewSource === 'user' ? 'Overview · edited by you' : brief?.overviewSource === 'generated' ? 'Overview · written by the agent' : 'Overview'}
                </div>
              )}

              {shownStage === 'related' && (
                <div className="ai-sub-card-body stage-panel" role="tabpanel">
                  <RelatedTasksPanel
                    baselineContext={contextStep?.baselineContext}
                    isSearching={isRelatedWorking}
                    isSelecting={isOverviewSynthesizing}
                    canOpenTask={canOpenRelatedTask}
                    onOpenTask={onOpenRelatedTask}
                  />
                </div>
              )}

              {shownStage === 'overview' && (
                <div className="ai-sub-card-body stage-panel" role="tabpanel">
                  {bibleFilePath && (
                    <button
                      type="button"
                      className="bible-deep-link"
                      onClick={() => { void openFileInIdeOrSystem(bibleFilePath); }}
                      title={`Open the run's bible: the brief exactly as handed to the manager, plus the execution log (${bibleFilePath})`}
                    >
                      <BookOpen size={11} />
                      <span>TASK_CONTEXT.md</span>
                      <ExternalLink size={10} />
                    </button>
                  )}
                  {isOverviewOutdated && !isOverviewSynthesizing && (
                    <div className="stage-panel-note">The task changed after this overview was written. The next run writes a new one.</div>
                  )}
                  {isOverviewSynthesizing && isRealOverview && (
                    <div className="stage-panel-note">
                      <Loader2 size={10} className="spin-animate" />
                      <span>Refreshing…</span>
                    </div>
                  )}
                  {isEditing ? (
                    <textarea
                      ref={overviewRef}
                      className="obsidian-card-textarea"
                      placeholder="Write AI execution brief, acceptance criteria, and tool plan in Markdown..."
                      value={overviewText}
                      onChange={(e) => handleFieldChange('overview', e.target.value)}
                      onKeyDown={(e) => handleMarkdownAutoWrap(e, (val) => handleFieldChange('overview', val))}
                      onFocus={() => setActiveFocusedRef(overviewRef)}
                      rows={5}
                    />
                  ) : isOverviewSynthesizing && !isRealOverview ? (
                    <div className="ai-card-hint" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--accent-cyan)' }}>
                      <Loader2 size={12} className="spin-animate" />
                      <span>Summary agent is synthesizing the overview…</span>
                    </div>
                  ) : isGatheringContext && !isRealOverview ? (
                    <div className="ai-card-hint" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--accent-cyan)' }}>
                      <Loader2 size={12} className="spin-animate" />
                      <span>Gathering context — the Summary agent will synthesize the overview next…</span>
                    </div>
                  ) : isRealOverview ? (
                    <div className="brief-markdown-render">
                      {summaryDoc && !showOverviewText ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-main)', lineHeight: '1.45' }}>
                            <MarkdownRenderer content={summaryDocContent || overviewText} />
                          </div>
                        </div>
                      ) : (
                        <MarkdownRenderer content={overviewText} />
                      )}
                    </div>
                  ) : (
                    <EmptyState
                      icon={FileText}
                      title="No overview yet"
                      text="The overview — goals, success criteria and tool plan — is written when the task first runs, and kept for reruns."
                    />
                  )}
                </div>
              )}

              {shownStage === 'actions' && (
                <div className="ai-sub-card-body stage-panel" role="tabpanel" style={{ padding: 0 }}>
                  <BvTokenCounterCard
                    task={task}
                    brief={brief}
                    executionSteps={executionSteps}
                    isExecuting={isExecuting}
                    isTaskStarted={isTaskStarted}
                    defaultBreakdownOpen={false}
                    billing={taskBilling}
                  />
                  {/* High-priority pending action prompts (Permission or Ollama Offline) */}
                  {(pendingPermission || pendingOllamaFallback || offscreenPromptAgents.length > 0) && (
                    <div style={{ padding: '0.65rem 0.65rem 0.25rem 0.65rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {pendingPermission && onPermissionChoice && (
                        <div className="pipeline-permission-card">
                          <div className="pipeline-permission-header">
                            <div className="pipeline-permission-title">
                              <ShieldAlert size={16} />
                              <span>Approve {pendingPermission.toolName}?</span>
                            </div>
                            <span className="pipeline-permission-pill">Awaiting Approval</span>
                          </div>
                          <p className="pipeline-permission-subtitle">
                            The agent wants to use <strong>{pendingPermission.serverName} / {pendingPermission.toolName}</strong>:
                          </p>
                          <PermissionRequestDetails prompt={pendingPermission} />
                          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: '0.65rem' }}>
                            <button
                              className="btn btn-secondary"
                              style={{ padding: '0.3rem 0.75rem', fontSize: '0.76rem', fontWeight: 600 }}
                              onClick={() => onPermissionChoice(false)}
                            >
                              Skip / Reject
                            </button>
                            {pendingPermission.rememberLabel && (
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '0.3rem 0.75rem', fontSize: '0.76rem', fontWeight: 600 }}
                                onClick={() => onPermissionChoice('always')}
                                title={`Approve this and ${pendingPermission.rememberLabel} for the rest of this task`}
                              >
                                Allow {pendingPermission.rememberLabel} for this task
                              </button>
                            )}
                            <button
                              className="btn btn-emerald"
                              style={{ padding: '0.3rem 0.85rem', fontSize: '0.76rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                              onClick={() => onPermissionChoice(true)}
                            >
                              <ShieldCheck size={14} />
                              <span>Approve</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* CLI agents blocked on a prompt the user can't see in the current view */}
                      {offscreenPromptAgents.map((agent) => (
                        <div key={`prompt-${agent.ptySessionId}`} className="agent-prompt-alert-row">
                          <ShieldAlert size={14} className="agent-prompt-alert-icon" />
                          <AgentRoleBadge role={agent.role} pieceId={agent.pieceId} label={agent.label} />
                          <span className="agent-prompt-alert-text" title={agent.pendingPrompt!.rawSnippet}>
                            {agent.pendingPrompt!.kind === 'approval'
                              ? 'needs approval'
                              : agent.pendingPrompt!.kind === 'question'
                                ? 'is asking'
                                : 'reports'}
                            : <code>{promptSummary(agent.pendingPrompt!)}</code>
                          </span>
                          <button
                            type="button"
                            className="agent-prompt-alert-btn"
                            onClick={() => {
                              setViewModeSection2('notes');
                              pinAgent(agent.ptySessionId);
                            }}
                            title={`Show ${agent.label} in the Notes view to answer`}
                          >
                            Review
                          </button>
                        </div>
                      ))}

                      {pendingOllamaFallback && onOllamaFallbackChoice && (
                        <div
                          style={{
                            background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.14) 0%, rgba(20, 22, 28, 0.95) 100%)',
                            border: '1.5px solid rgba(239, 68, 68, 0.55)',
                            borderRadius: 'var(--radius-md)',
                            padding: '0.85rem 1rem',
                            boxShadow: '0 4px 20px rgba(239, 68, 68, 0.18), 0 0 0 1px rgba(239, 68, 68, 0.1)',
                            animation: 'fadeIn 0.2s ease',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.45rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: '#f43f5e', fontWeight: 700, fontSize: '0.84rem' }}>
                              <ShieldAlert size={16} />
                              <span>Local Ollama Connection Failed</span>
                            </div>
                            <span style={{ fontSize: '0.68rem', fontWeight: 600, color: 'var(--accent-rose)', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>
                              Offline
                            </span>
                          </div>
                          <p style={{ fontSize: '0.8rem', color: 'var(--text-main)', marginBottom: '0.5rem', lineHeight: 1.45 }}>
                            Ergo was unable to reach your local Ollama instance at <strong style={{ color: 'var(--accent-cyan)' }}>{pendingOllamaFallback.prompt.url}</strong> after {pendingOllamaFallback.prompt.consecutiveFailures} consecutive attempts. You don't seem to be connected locally.
                          </p>
                          <div style={{ background: 'rgba(0, 0, 0, 0.4)', padding: '0.55rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255, 255, 255, 0.08)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.65rem' }}>
                            {pendingOllamaFallback.prompt.errorMessage || 'NetworkError: Failed to connect to local Ollama daemon'}
                          </div>
                          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                            <button
                              className="btn btn-secondary"
                              style={{ padding: '0.3rem 0.75rem', fontSize: '0.76rem', fontWeight: 600, borderColor: 'rgba(239, 68, 68, 0.4)', color: 'var(--accent-rose)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                              onClick={() => onOllamaFallbackChoice('terminate')}
                            >
                              <Square size={12} />
                              <span>Terminate Task</span>
                            </button>
                            <button
                              className="btn btn-emerald"
                              style={{ padding: '0.3rem 0.85rem', fontSize: '0.76rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                              onClick={() => onOllamaFallbackChoice('switch_cloud')}
                            >
                              <Cloud size={14} />
                              <span>Switch to Cloud Profile</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Internal View Switcher Bar */}
                  <div className="actions-view-switcher-bar">
                    <span className="actions-switcher-label">
                      {showExecutionSteps
                        ? executionSteps.length > 0
                          ? `${executionSteps.length} action${executionSteps.length === 1 ? '' : 's'}`
                          : 'Execution Steps'
                        : shownAgent
                          ? `Notes · ${shownAgent.label}`
                          : 'Notes'}
                    </span>
                    {showExecutionSteps && (
                      <span className="actions-now-running">
                        {nowRunningAgent ? (
                          <span
                            className={`agent-now-running-chip status-${nowRunningAgent.status}`}
                            title={`${nowRunningAgent.label} · ${nowRunningAgent.cmd} · ${agentStatusLabel(nowRunningAgent.status)}`}
                          >
                            <span className="agent-now-running-prefix">
                              {nowRunningAgent.status === 'awaiting_approval'
                                ? 'Needs approval:'
                                : nowRunningAgent.status === 'waiting'
                                  ? 'Waiting:'
                                  : 'Now running:'}
                            </span>
                            <AgentRoleBadge role={nowRunningAgent.role} pieceId={nowRunningAgent.pieceId} label={nowRunningAgent.label} />
                          </span>
                        ) : runningPipelineStep?.agentRole ? (
                          <span className="agent-now-running-chip status-running" title={runningPipelineStep.title}>
                            <span className="agent-now-running-prefix">Now running:</span>
                            <AgentRoleBadge role={runningPipelineStep.agentRole} pieceId={runningPipelineStep.pieceId} />
                          </span>
                        ) : null}
                      </span>
                    )}
                    <div className="steps-notes-chip">
                      <button
                        type="button"
                        className={`steps-notes-segment ${!showExecutionSteps ? 'active' : ''}`}
                        onClick={() => setViewModeSection2('notes')}
                        title="Switch to Notes view"
                      >
                        <FileText size={10} />
                        <span>Notes</span>
                      </button>
                      <button
                        type="button"
                        className={`steps-notes-segment ${showExecutionSteps ? 'active' : ''}`}
                        onClick={() => setViewModeSection2('steps')}
                        title="Switch to Steps view"
                      >
                        <Sparkles size={10} />
                        <span>Steps</span>
                      </button>
                    </div>
                  </div>

                  {showExecutionSteps ? (
                    /* Sub-view 1: In-place Execution Steps & Workflow */
                    <div className="execution-steps-wrapper" style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                      {showExecutionSteps && agentSessions.length > 1 && (
                        <div style={{ padding: '0.2rem 0.2rem 0.4rem 0.2rem' }}>
                          <AgentSessionTabs
                            sessions={agentSessions}
                            selectedId={shownAgent?.ptySessionId ?? null}
                            onSelect={(id) => {
                              setViewModeSection2('notes');
                              pinAgent(id);
                            }}
                          />
                        </div>
                      )}
                      {/* Interactive Mid-Build Human Clarification Card if active */}
                      {pendingHumanInput && onHumanInputChoice && (
                        <HumanInputCard
                          prompt={pendingHumanInput.prompt}
                          onSubmit={onHumanInputChoice}
                        />
                      )}

                      {/* Agent terminals no step claims (e.g. restored sessions, or steps not recorded yet) */}
                      {unclaimedAgents.length > 0 && (
                        <div className="agent-terminals-list">
                          <div className="agent-terminals-list-title">
                            <Terminal size={12} />
                            <span>Agent terminals</span>
                          </div>
                          {unclaimedAgents.map((agent) => renderAgentTerminal(agent))}
                        </div>
                      )}

                      {/* Execution Steps */}
                      <div className="execution-steps">
                        {executionSteps.length === 0 ? (
                          <div className="ai-card-hint" style={{ margin: '0.4rem 0' }}>
                            No execution steps recorded yet. Agent actions and tool logs will appear here when the task runs.
                          </div>
                        ) : (
                          executionSteps.map((step) => (
                            <div key={step.id} className={`step-card ${step.status} stage-${step.stage}`} style={step.stage === 'mcp_call' && step.pieceId ? { marginLeft: '0.65rem' } : undefined}>
                              <div className="step-header">
                                <div className="step-title">
                                  <StepStatusIcon step={step} size={13} />
                                  {step.agentRole ? (
                                    <AgentRoleBadge role={step.agentRole} pieceId={step.pieceId} />
                                  ) : (
                                    <PieceChip pieceId={step.stage === 'mcp_call' ? step.pieceId : undefined} />
                                  )}
                                  <span style={{ fontSize: '0.8rem', color: step.status === 'cancelled' ? 'var(--text-muted)' : undefined }}>{step.title}</span>
                                </div>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                  <StepUsageBadge usage={step.usage} />
                                  <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                                    {step.time}
                                  </span>
                                </span>
                              </div>

                              <div className="step-detail"><MarkdownRenderer content={step.detail} /></div>
                              <BiblePreview markdown={step.bibleMarkdown} filePath={step.bibleMarkdown ? step.bibleFilePath : undefined} />

                              {/* This agent's live terminal, embedded in its own step */}
                              {stepTerminals.has(step.id) && (
                                <div style={{ marginTop: '0.65rem' }}>{renderAgentTerminal(stepTerminals.get(step.id)!)}</div>
                              )}

                              {step.humanInputPrompt && step.status === 'running' && onHumanInputChoice && !pendingHumanInput && (
                                <div style={{ marginTop: '0.4rem' }}>
                                  <HumanInputCard
                                    prompt={step.humanInputPrompt}
                                    onSubmit={onHumanInputChoice}
                                  />
                                </div>
                              )}

                              {step.widgetType && renderMcpAppWidget(step.widgetType, step.widgetData)}
                            </div>
                          ))
                        )}
                      </div>

                      {sendTaskMessage && hasEverRun && (
                        <div style={{ padding: '0.4rem 0.1rem 0.2rem' }}>
                          <TaskPromptBox
                            running={runActive}
                            onSend={sendTaskMessage}
                            status={liveStatusFor(nowRunningAgent, true)}
                            workerTargets={agentSessions.length === 0 ? pipelineWorkerTargets : []}
                            hint={agentSessions.length > 0 && runActive ? 'Goes to the manager (pick an agent in the Notes view to message it directly).' : undefined}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Sub-view 2: Notes View (the run's agents, one at a time, clearly labelled + Notes editor) */
                    <div className="notes-view-container" style={{ display: 'flex', flexDirection: 'column' }}>
                      {agentSessions.length > 0 && (
                        <div className="agent-notes-panel">
                          <AgentSessionTabs
                            sessions={agentSessions}
                            selectedId={shownAgent?.ptySessionId ?? null}
                            onSelect={pinAgent}
                          />

                          {managerWaitingOn && (
                            <div className="agent-waiting-row">
                              <Clock size={11} />
                              <span>{managerWaitingOn.text}</span>
                              {managerWaitingOn.agents.map((agent) => (
                                <button
                                  key={agent.ptySessionId}
                                  type="button"
                                  className="agent-waiting-chip"
                                  onClick={() => pinAgent(agent.ptySessionId)}
                                  title={`Show ${agent.label}`}
                                >
                                  <AgentRoleBadge role={agent.role} pieceId={agent.pieceId} label={agent.label} />
                                  <AgentStatusDot status={agent.status} />
                                </button>
                              ))}
                            </div>
                          )}

                          {switchBanner && shownAgent && switchBanner.toId === shownAgent.ptySessionId && (
                            <div className="agent-switch-banner" role="status">
                              <span className="agent-switch-banner-text">
                                Now showing <AgentRoleBadge role={shownAgent.role} pieceId={shownAgent.pieceId} label={switchBanner.toLabel} /> — {switchBanner.reason}
                              </span>
                              {agentSessions.some((s) => s.ptySessionId === switchBanner.fromId) && (
                                <button
                                  type="button"
                                  className="agent-switch-back-btn"
                                  onClick={() => pinAgent(switchBanner.fromId)}
                                  title={`Go back to ${switchBanner.fromLabel} and stop following automatically`}
                                >
                                  <CornerUpLeft size={11} />
                                  <span>Back to {switchBanner.fromLabel}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                className="agent-switch-dismiss-btn"
                                onClick={() => setSwitchBanner(null)}
                                aria-label="Dismiss"
                                title="Dismiss"
                              >
                                <X size={11} />
                              </button>
                            </div>
                          )}

                          {shownAgent && (
                            <CliAgentNotesBridge
                              key={agentViewKey(shownAgent)}
                              sessionId={shownAgent.ptySessionId}
                              role={shownAgent.role}
                              label={shownAgent.label}
                              pieceId={shownAgent.pieceId}
                              launchPrompt={shownAgent.args[shownAgent.args.length - 1]}
                              permissionLevel={shownAgent.permissionLevel ?? permissionLevel}
                              initialPrompt={shownAgent.pendingPrompt ?? null}
                              onSendMessage={
                                sendTaskMessage
                                  ? (text, opts) => sendTaskMessage(text, { ...opts, ptySessionId: shownAgent.ptySessionId })
                                  : undefined
                              }
                              runActive={runActive}
                              liveStatus={isAgentWorking(shownAgent.status) ? liveStatusFor(shownAgent, false) : null}
                            />
                          )}
                        </div>
                      )}

                      {!shownAgent && sendTaskMessage && hasEverRun && (
                        <div style={{ padding: '0.55rem 0.75rem 0' }}>
                          <TaskPromptBox running={runActive} onSend={sendTaskMessage} workerTargets={pipelineWorkerTargets} status={liveStatusFor(null, false)} />
                        </div>
                      )}

                      {agentSessions.length === 0 && !(sendTaskMessage && hasEverRun) && (
                        <div className="ai-card-hint" style={{ padding: '0.55rem 0.75rem' }}>
                          The task's agents appear here while it runs.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {shownStage === 'completion' && (
                <div className="ai-sub-card-body stage-panel" role="tabpanel">
                  {isCompletionWorking && completionText.trim().length > 0 && (
                    <div className="stage-panel-note">
                      <Loader2 size={10} className="spin-animate" />
                      <span>Updating…</span>
                    </div>
                  )}
                  {isEditing ? (
                    <textarea
                      ref={completionRef}
                      className="obsidian-card-textarea"
                      placeholder="Record outcomes, commits, test results, pull requests, follow-ups..."
                      value={completionText}
                      onChange={(e) => handleFieldChange('completion', e.target.value)}
                      onKeyDown={(e) => handleMarkdownAutoWrap(e, (val) => handleFieldChange('completion', val))}
                      onFocus={() => setActiveFocusedRef(completionRef)}
                      rows={4}
                    />
                  ) : completionText ? (
                    <div className="brief-body" style={{ padding: '0.55rem 0.5rem 0.15rem' }}>
                      <div className="brief-markdown-render">
                        <MarkdownRenderer content={completionText} />
                      </div>
                    </div>
                  ) : isCompletionWorking ? (
                    <div className="ai-card-hint" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--accent-cyan)' }}>
                      <Loader2 size={12} className="spin-animate" />
                      <span>Writing the completion log from the agent's results…</span>
                    </div>
                  ) : (
                    <div className="ai-card-hint">
                      The completion log is written when the agent finishes (or when you stop it).
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      </div>

      <div className="eg-detail-foot">
        <MenuButton
          placement="above"
          width={220}
          items={modelItems}
          trigger={(p) => (
            <Button {...p} variant="ghost" icon={Cpu} iconRight={ChevronDown} title="Model selection and effort for runs">
              {modelSelection === 'auto' ? 'Auto' : 'Manual'}
              <span className="eg-subtle">· {EFFORT_LABELS[effortLevel]}</span>
            </Button>
          )}
        />
        <span className="eg-spacer" />
        {runActive ? (
          <>
            <span className="eg-detail-foot-note eg-hide-sm">Changes land in your working tree.</span>
            {(onTerminateAgent || onKillSession) && (
              <Button
                variant="danger"
                icon={Square}
                kbd={[SHIFT, MOD, '.']}
                onClick={() => (onTerminateAgent ? onTerminateAgent(task.id) : onKillSession?.(task.id))}
              >
                Stop
              </Button>
            )}
          </>
        ) : (
          <>
            {!isQueued && onQueue && (
              <Button icon={Layers} onClick={onQueue} title={canRun ? 'Run after the tasks already queued' : 'Runs when the bridge is back'}>
                {canRun ? 'Queue' : 'Queue for later'}
              </Button>
            )}
            <Button
              variant="primary"
              icon={isStoppedPartway ? Play : hasRunBefore ? RotateCcw : Play}
              kbd={[SHIFT, MOD, '↵']}
              disabled={!canRun}
              title={!canRun ? 'Runs need the bridge' : undefined}
              onClick={() => {
                if (isQueued) {
                  setConfirmRunNow(true);
                  return;
                }
                onExecuteTask(task);
              }}
            >
              {isStoppedPartway ? 'Resume' : hasRunBefore ? 'Run again' : 'Run'}
            </Button>
          </>
        )}
      </div>

      <Dialog
        open={confirmRunNow}
        title="Run it now?"
        description="This task is already queued. Running it now starts it alongside the task that's running, and it leaves the queue."
        onClose={() => setConfirmRunNow(false)}
        width={420}
        footer={
          <>
            <span className="eg-spacer" />
            <Button onClick={() => setConfirmRunNow(false)}>Keep it queued</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmRunNow(false);
                onRunQueuedNow?.();
              }}
            >
              Run in parallel
            </Button>
          </>
        }
      >
        {null}
      </Dialog>

      {isMcpModalOpen && (
        <TaskMcpToolsModal
          isOpen={isMcpModalOpen}
          onClose={() => setIsMcpModalOpen(false)}
          task={task}
          brief={brief}
          mcpServers={_mcpServers}
          selectedTools={activeTaskTools}
          onSaveTools={(tools) => {
            _onUpdateTaskMcpTools?.(task.id, tools);
            setIsMcpModalOpen(false);
          }}
        />
      )}
    </div>
  );
};

export const BriefPane: React.FC<BriefPaneProps> = ({
  taskBilling,
  tasks,
  briefs,
  archivedTasks = [],
  selectedTaskId,
  queuedTaskIds = [],
  onSelectTask,
  onSaveBrief,
  onLiveBriefChange,
  onExecuteTask,
  onUpdateBriefWithAi: _onUpdateBriefWithAi,
  onSyncOverviewWithTask,
  onOpenArchives,
  onSaveArchivedBrief: _onSaveArchivedBrief,
  terminalSessions = [],
  executingTaskId = null,
  taskExecutionSteps = {},
  pendingPermissions = {},
  pendingHumanInputs = {},
  pendingOllamaFallbacks = {},
  onPermissionChoice,
  onHumanInputChoice,
  onOllamaFallbackChoice,
  onSessionExit: _onSessionExit,
  onRestartSession,
  onKillSession,
  onKillAgentSession,
  onSendTaskMessage,
  onTerminateAgent,
  onArchiveTask,
  onRemoveAiTask,
  onPurgeTaskFromAi,
  onRunQueuedTaskNow,
  scheduledJobs = [],
  onScheduleTask,
  onCancelScheduleTask,
  onTogglePanel,
  mcpServers = [],
  onUpdateTaskMcpTools,
  agentPipelineOptions,
  onSetAgentPipelineOptions,
  onResizeStart,
  isResizing,
  onQueueTask,
  isBridgeConnected,
  onOpenModels,
  detailRequest = 0,
  runsViewRequest = 0,
}) => {
  const [schedulingTask, setSchedulingTask] = useState<TaskItem | null>(null);
  // The runs view is the pane's anchor: shown by default, and whenever the user goes back to it. Picking a task in
  // the document opens its card.
  const [showRuns, setShowRuns] = useState(true);
  useEffect(() => {
    if (detailRequest > 0) setShowRuns(false);
  }, [detailRequest]);
  useEffect(() => {
    if (runsViewRequest > 0) setShowRuns(true);
  }, [runsViewRequest]);

  // Each task's agent sessions (String task ids), ordered manager → workers → verifier.
  const sessionsByTask = React.useMemo(() => {
    const map = new Map<string, SpawnedSession[]>();
    for (const s of terminalSessions) {
      const key = String(s.session.taskId);
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    for (const [key, list] of map) map.set(key, sortAgentSessions(list));
    return map;
  }, [terminalSessions]);

  // The runs view's order: by run status (default), by the heading each task sits under, or alphabetically.
  const [runsSort, setRunsSort] = useState<RunsSort>(readRunsSort);
  useEffect(() => subscribePrefs(() => setRunsSort(readRunsSort())), []);
  const chooseRunsSort = (next: RunsSort) => {
    setRunsSort(next);
    setPref(RUNS_SORT_PREF, next);
  };
  // Base order follows the document: its headings, then task order.
  const orderedBriefs = React.useMemo(() => orderBriefs(briefs, tasks, 'category'), [briefs, tasks]);

  // Related Tasks card: candidates carry String task ids; selection needs the task's own id (number or string).
  const taskIdByString = React.useMemo(() => new Map(tasks.map((t) => [String(t.id), t.id] as const)), [tasks]);
  const canOpenRelatedTask = React.useCallback((id: string) => taskIdByString.has(String(id)), [taskIdByString]);
  const openRelatedTask = (id: string) => {
    const original = taskIdByString.get(String(id));
    if (original !== undefined) onSelectTask?.(original);
  };

  // ── The task on the current line (or the brief picked from the list) ──
  const selectedRow = React.useMemo(() => {
    if (selectedTaskId == null) return null;
    const sel = String(selectedTaskId);
    const task = tasks.find((t) => String(t.id) === sel) ?? null;
    const brief =
      briefs.find((b) => b.sourceTaskId != null && String(b.sourceTaskId) === sel) ||
      briefs.find((b) => b.id != null && String(b.id) === sel) ||
      (task ? briefs.find((b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase()) : undefined);
    if (!task && !brief) return null;
    const effectiveTask: TaskItem = task || {
      id: brief!.sourceTaskId || brief!.id || `brief-${brief!.itemNumber}`,
      title: brief!.title,
      category: brief!.sourceLaneTitle || '',
      status: (brief!.status as TaskStatus) || 'not_started',
      isDone: brief!.status === 'done',
      subtasks: [],
      isUnordered: brief!.isUnordered,
      swimLaneId: brief!.sourceLaneId,
    };
    return { task: effectiveTask, brief };
  }, [selectedTaskId, tasks, briefs]);

  const fileName = 'TODO.md';
  const findById = <T,>(map: Record<string | number, T> | undefined, id: string | number): T | undefined =>
    map?.[id] ?? Object.entries(map || {}).find(([k]) => String(k) === String(id))?.[1];

  const renderDetail = (task: TaskItem, brief: AgentContextItem | undefined) => {
    const agentSessions = sessionsByTask.get(String(task.id)) ?? NO_AGENT_SESSIONS;
    const isExecuting = executingTaskId !== null && String(executingTaskId) === String(task.id);
    const isWorking = agentSessions.some((x) => isAgentWorking(x.status)) || isExecuting;
    const queuePos = queuedTaskIds.findIndex((qid) => String(qid) === String(task.id));
    const taskJob = scheduledJobs.find((j) => String(j.taskId) === String(task.id) && j.status === 'pending');
    return (
      <AiTaskCard
        key={String(task.id)}
        taskBilling={taskBilling}
        task={task}
        brief={brief}
        isSelected
        isWorking={isWorking}
        isQueued={queuePos >= 0}
        queuePosition={queuePos >= 0 ? queuePos : undefined}
        onRunQueuedNow={onRunQueuedTaskNow ? () => onRunQueuedTaskNow(task.id) : undefined}
        onQueue={onQueueTask ? () => onQueueTask(task) : undefined}
        isBridgeConnected={isBridgeConnected}
        onClosePane={onTogglePanel}
        onBackToRuns={() => setShowRuns(true)}
        agentPipelineOptions={agentPipelineOptions}
        onSetAgentPipelineOptions={onSetAgentPipelineOptions}
        onOpenModels={onOpenModels}
        fileName={fileName}
        agentSessions={agentSessions}
        permissionLevel={agentPipelineOptions?.permissionLevel}
        isExecuting={isExecuting}
        executionSteps={findById(taskExecutionSteps, task.id) || []}
        pendingPermission={findById(pendingPermissions, task.id)?.prompt ?? null}
        pendingHumanInput={findById(pendingHumanInputs, task.id) ?? null}
        pendingOllamaFallback={findById(pendingOllamaFallbacks, task.id) ?? null}
        scheduledJob={taskJob}
        onOpenScheduleModal={(t) => setSchedulingTask(t)}
        onSelect={() => onSelectTask?.(brief?.sourceTaskId || brief?.id || task.id)}
        onSaveBrief={onSaveBrief}
        onLiveBriefChange={onLiveBriefChange}
        onExecuteTask={onExecuteTask}
        onUpdateBriefWithAi={_onUpdateBriefWithAi}
        onSyncOverviewWithTask={onSyncOverviewWithTask}
        onPermissionChoice={(approved) => onPermissionChoice?.(task.id, approved)}
        onHumanInputChoice={(answer) => onHumanInputChoice?.(task.id, answer)}
        onOllamaFallbackChoice={(choice) => onOllamaFallbackChoice?.(task.id, choice)}
        onRestartSession={onRestartSession}
        onKillSession={onKillSession}
        onKillAgentSession={onKillAgentSession}
        onSendTaskMessage={onSendTaskMessage}
        onTerminateAgent={onTerminateAgent}
        onArchiveTask={onArchiveTask}
        onRemoveAiTask={(targetId) => onRemoveAiTask?.(targetId)}
        onPurgeTaskFromAi={(targetId) => onPurgeTaskFromAi?.(targetId)}
        mcpServers={mcpServers}
        onUpdateTaskMcpTools={onUpdateTaskMcpTools}
        canOpenRelatedTask={canOpenRelatedTask}
        onOpenRelatedTask={onSelectTask ? (id) => openRelatedTask(id) : undefined}
      />
    );
  };

  // The runs view: what's running, waiting on you, queued, finished and not run yet, for every task with a brief.
  const renderOverview = () => {
    const rows = orderedBriefs.map(({ brief, index, task }) => {
      const id = task?.id ?? brief.sourceTaskId ?? brief.id ?? `brief-${brief.itemNumber || index + 1}`;
      const sessions = sessionsByTask.get(String(id)) ?? NO_AGENT_SESSIONS;
      const live = sessions.some((x) => isAgentWorking(x.status)) || (executingTaskId !== null && String(executingTaskId) === String(id));
      const waiting =
        sessions.some((x) => x.session.isActive && x.status === 'awaiting_approval') ||
        Boolean(findById(pendingPermissions, id) || findById(pendingHumanInputs, id));
      const queuePos = queuedTaskIds.findIndex((qid) => String(qid) === String(id));
      const outcome = brief.lastRunOutcome?.outcome;
      const done = Boolean(task?.isDone || brief.status === 'done');
      const ran = Boolean(outcome) || sessions.length > 0 || Boolean(brief.completion?.trim());
      const group: 'waiting' | 'running' | 'queued' | 'review' | 'failed' | 'new' | 'done' = waiting
        ? 'waiting'
        : live
          ? 'running'
          : queuePos >= 0
            ? 'queued'
            : done
              ? 'done'
              : outcome === 'failed' || outcome === 'verifier_failed'
                ? 'failed'
                : ran
                  ? 'review'
                  : 'new';
      const started = sessions.find((x) => x.role === 'manager')?.session.spawnedAt ?? sessions[0]?.session.spawnedAt;
      return { brief, task, id, group, queuePos, outcome, started };
    });
    const GROUPS: Array<{ key: (typeof rows)[number]['group']; label: string; status: DesignTaskStatus }> = [
      { key: 'waiting', label: 'Waiting for you', status: 'review' },
      { key: 'running', label: 'Running', status: 'progress' },
      { key: 'queued', label: 'Up next', status: 'queued' },
      { key: 'review', label: 'Ready for review', status: 'review' },
      { key: 'failed', label: 'Failed', status: 'failed' },
      { key: 'new', label: 'Not run yet', status: 'todo' },
      { key: 'done', label: 'Done', status: 'done' },
    ];
    const GROUP_STATUS = Object.fromEntries(GROUPS.map((g) => [g.key, g.status])) as Record<(typeof rows)[number]['group'], DesignTaskStatus>;
    const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label])) as Record<(typeof rows)[number]['group'], string>;
    type Row = (typeof rows)[number];
    // Run status: one section per state. Category: one per document heading, in document order. A–Z: one list.
    const sections: Array<{ key: string; label: string | null; rows: Row[] }> =
      runsSort === 'alpha'
        ? [{ key: 'alpha', label: null, rows: [...rows].sort((x, y) => x.brief.title.localeCompare(y.brief.title, undefined, { sensitivity: 'base', numeric: true })) }]
        : runsSort === 'category'
          ? (() => {
              const byHeading = new Map<string, Row[]>();
              for (const r of rows) {
                const h = r.task?.category && r.task.category !== 'Untitled' ? cleanHeading(r.task.category) : r.task ? 'No heading' : 'Not in the document';
                const list = byHeading.get(h);
                if (list) list.push(r);
                else byHeading.set(h, [r]);
              }
              return [...byHeading].map(([h, list]) => ({ key: `cat-${h}`, label: h, rows: list }));
            })()
          : GROUPS.map((g) => ({
              key: g.key,
              label: g.label,
              rows: rows.filter((r) => r.group === g.key).sort((x, y) => (g.key === 'queued' ? x.queuePos - y.queuePos : 0)),
            })).filter((sec) => sec.rows.length > 0);
    const counts = { running: rows.filter((r) => r.group === 'running' || r.group === 'waiting').length, queued: rows.filter((r) => r.group === 'queued').length };
    const metaFor = (r: (typeof rows)[number]) =>
      r.group === 'running'
        ? r.started ? `since ${new Date(r.started).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Running'
        : r.group === 'waiting'
          ? 'Needs you'
          : r.group === 'queued'
            ? `#${r.queuePos + 1}`
            : r.brief.lastRunOutcome?.at
              ? new Date(r.brief.lastRunOutcome.at).toLocaleDateString([], { month: 'short', day: 'numeric' })
              : '';
    const open = (r: (typeof rows)[number]) => {
      onSelectTask?.(r.brief.sourceTaskId || r.brief.id || r.id);
      setShowRuns(false);
    };
    return (
      <>
        <div className="eg-detail-head">
          <span className="eg-icon eg-icon-sm eg-subtle" aria-hidden="true"><Activity strokeWidth={1.75} /></span>
          <span className="eg-detail-crumb is-current">Runs</span>
          <span className="eg-detail-crumb eg-tabular">
            {counts.running > 0 ? `${counts.running} running` : 'Nothing running'}
            {counts.queued > 0 ? ` · ${counts.queued} queued` : ''}
          </span>
          <span className="eg-spacer" />
          {onOpenArchives && <IconButton icon={Archive} size="sm" label={`Archived tasks${archivedTasks.length ? ` (${archivedTasks.length})` : ''}`} onClick={onOpenArchives} />}
          {onTogglePanel && <IconButton icon={X} size="sm" label={`Close (${MOD}J)`} onClick={onTogglePanel} />}
        </div>
        <div className="eg-detail-body">
          {selectedRow && (
            <button type="button" className="eg-runs-current" onClick={() => setShowRuns(false)}>
              <span className="eg-subtle">Current line</span>
              <span className="eg-runs-current-title">{selectedRow.brief?.title || selectedRow.task.title}</span>
              <span className="eg-runs-current-go">Open</span>
            </button>
          )}
          {briefs.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="No runs yet"
              text="Click a task in the document to open it here, then press Run. Running and queued tasks show up in this view."
            />
          ) : (
            <>
              <div className="eg-runs-sort">
                <span className="eg-runs-sort-label">Sort by</span>
                <SegmentedControl<RunsSort>
                  label="Sort tasks by"
                  value={runsSort}
                  onChange={chooseRunsSort}
                  options={[
                    { id: 'status', label: 'Run status' },
                    { id: 'category', label: 'Category' },
                    { id: 'alpha', label: 'A–Z' },
                  ]}
                />
              </div>
              {sections.map((sec) => (
                <section key={sec.key} className={`eg-runs-group is-${sec.key}`}>
                  {sec.label && (
                    <div className="eg-section-label">
                      {sec.label}
                      <span className="eg-count">{sec.rows.length}</span>
                    </div>
                  )}
                  <div className="eg-runs">
                    {sec.rows.map((r) => (
                      <RunRow
                        key={String(r.id)}
                        live={r.group === 'running'}
                        status={GROUP_STATUS[r.group]}
                        title={r.brief.title}
                        detail={
                          runsSort === 'category'
                            ? GROUP_LABEL[r.group]
                            : r.task?.category && r.task.category !== 'Untitled'
                              ? cleanHeading(r.task.category)
                              : r.brief.sourceLaneTitle
                        }
                        meta={metaFor(r)}
                        active={selectedRow != null && String(selectedRow.task.id) === String(r.id)}
                        onClick={() => open(r)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </>
    );
  };

  return (
    <aside className={`eg-detail ${isResizing ? 'is-resizing' : ''}`} aria-label="Task detail">
      {onResizeStart && <div className={`eg-detail-resize ${isResizing ? 'is-active' : ''}`} onMouseDown={onResizeStart} title="Drag to resize" />}
      {selectedRow && !showRuns ? renderDetail(selectedRow.task, selectedRow.brief) : renderOverview()}

      {/* ── Schedule Task Modal Window ── */}
      {schedulingTask && (
        <ScheduleTaskModal
          isOpen={true}
          onClose={() => setSchedulingTask(null)}
          task={schedulingTask}
          existingJob={scheduledJobs.find((j) => String(j.taskId) === String(schedulingTask.id) && j.status === 'pending')}
          onSchedule={(tId, iso, cron) => {
            onScheduleTask?.(tId, iso, cron);
            setSchedulingTask(null);
          }}
          onCancelSchedule={(tId) => {
            onCancelScheduleTask?.(tId);
            setSchedulingTask(null);
          }}
        />
      )}
    </aside>
  );
};

function renderMcpAppWidget(type: string, data: any) {
  if (!data) return null;

  if (type === 'vscode_preview') {
    return (
      <div className="widget-box" style={{ borderLeft: '3px solid var(--accent-cyan)' }}>
        <div style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--accent-cyan)', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Code size={15} color="var(--accent-cyan)" />
            <span>VS Code Editor MCP Live Stream ({data.editorFile || 'TODO.md'})</span>
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--accent-emerald)', background: 'color-mix(in srgb, var(--accent-text) 15%, transparent)', padding: '0.1rem 0.45rem', borderRadius: '4px' }}>
            {data.connectionStatus || 'Stdio IPC Connected'}
          </span>
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
          Executed command: <strong style={{ color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{data.commandExecuted}</strong> | Range: {data.selectionRange || 'L1-L30'}
        </div>
        <div className="diff-view">
          {data.diffLines?.map((line: string, idx: number) => (
            <div key={idx} className={line.startsWith('+') ? 'diff-line-add' : line.startsWith('-') ? 'diff-line-del' : ''}>
              {line}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === 'analytics_chart') {
    return (
      <div className="widget-box">
        <div style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--accent-cyan)', marginBottom: '0.4rem' }}>
          📊 Amplitude MCP Interactive Funnel View
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>1. {data.step1?.name}: <strong>{data.step1?.users} users</strong></div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>2. {data.step2?.name}: <strong>{data.step2?.users} users</strong></div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>3. {data.step3?.name}: <strong>{data.step3?.users} users</strong></div>
          </div>
          <div style={{ background: 'rgba(244, 63, 94, 0.15)', border: '1px solid rgba(244, 63, 94, 0.3)', padding: '0.4rem 0.75rem', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--accent-rose)', textTransform: 'uppercase' }}>Dropoff Rate</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--accent-rose)' }}>{data.dropoffRate}</div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'slack_draft') {
    return (
      <div className="widget-box">
        <div style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--accent-violet)', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Send size={13} />
          <span>Slack MCP Interactive Composer ({data.channel})</span>
        </div>
        <div style={{ background: 'var(--bg-darkest)', padding: '0.65rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontSize: '0.82rem' }}>
          {data.message}
        </div>
      </div>
    );
  }

  if (type === 'bluebeam_diff') {
    return (
      <div className="widget-box">
        <div style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--accent-emerald)', marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Layers size={13} />
          <span>Bluebeam Revision Layer Diff Widget ({data.sheetNumber})</span>
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          Sheet Title: {data.sheetTitle} | Change score: <strong>{data.changeScore}</strong>
        </div>
        <div style={{ marginTop: '0.35rem', fontSize: '0.76rem', color: 'var(--accent-cyan)' }}>
          Affected Conditions: {data.affectedConditions?.join(', ')}
        </div>
      </div>
    );
  }

  // Code diff fallback
  return (
    <div className="widget-box">
      <div style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--text-bright)', marginBottom: '0.4rem' }}>
        💻 File System MCP Unified Code Diff ({data.filename})
      </div>
      <div className="diff-view">
        {data.diffLines?.map((line: string, idx: number) => (
          <div key={idx} className={line.startsWith('+') ? 'diff-line-add' : line.startsWith('-') ? 'diff-line-del' : ''}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
