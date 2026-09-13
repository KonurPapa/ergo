import React, { useState, useEffect, useRef } from 'react';
import {
  type TaskItem,
  type TaskStatus,
  type AgentContextItem,
  type SpawnedSession,
  type ExecutionStep,
  type McpToolPermissionPrompt,
  type HumanInputPrompt
} from '../types';
import { AgentTerminal } from './AgentTerminal';
import { StepStatusIcon, StepUsageBadge, PieceChip, BiblePreview, BaselineContextPreview } from './ExecutionStepExtras';
import { BvTokenCounterCard } from './BvTokenCounterCard';
import {
  FileCode,
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
  Layers,
  Send,
  Loader2,
  X,
  FileText,
  ChevronDown,
  ListTodo,
  Sparkles,
  ClipboardList,
  Wrench,
  Flag,
  Archive,
  HelpCircle,
  MoreHorizontal,
  Trash2,
  Database,
  PanelRightClose,
  PanelRightOpen
} from 'lucide-react';

import { RichTextToolbar } from './RichTextToolbar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ArchivedTasksModal } from './ArchivedTasksModal';
import { handleMarkdownAutoWrap } from '../lib/markdownEditorUtils';

interface HumanInputCardProps {
  prompt: HumanInputPrompt;
  onSubmit: (answer: string) => void;
}

const HumanInputCard: React.FC<HumanInputCardProps> = ({ prompt, onSubmit }) => {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customText, setCustomText] = useState('');

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanCustom = customText.trim();
    const finalAnswer = cleanCustom
      ? selectedOption
        ? `${selectedOption} — ${cleanCustom}`
        : cleanCustom
      : selectedOption || 'Confirmed';

    if (finalAnswer) {
      onSubmit(finalAnswer);
    }
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

      {prompt.options && prompt.options.length > 0 && (
        <div className="ai-human-input-options">
          <div className="ai-human-input-options-label">Select an option:</div>
          <div className="ai-human-input-options-list">
            {prompt.options.map((opt, idx) => {
              const isSelected = selectedOption === opt;
              return (
                <button
                  key={idx}
                  type="button"
                  className={`ai-input-option-btn ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => setSelectedOption(isSelected ? null : opt)}
                >
                  <span className="option-number">{idx + 1}</span>
                  <span className="option-text">{opt}</span>
                  {isSelected && <CheckCircle2 size={13} className="option-check-icon" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(prompt.allowFreeform !== false || !prompt.options || prompt.options.length === 0) && (
        <form onSubmit={handleSubmit} className="ai-human-input-form">
          <textarea
            className="ai-human-input-textarea"
            placeholder={
              prompt.options && prompt.options.length > 0
                ? 'Or type specific clarification / custom response...'
                : 'Type your answer / clarification here...'
            }
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <div className="ai-human-input-actions">
            <span className="ai-human-input-hint">
              Press <strong>Ctrl+Enter</strong> or click Submit
            </span>
            <button
              type="submit"
              className="btn btn-primary ai-human-input-submit-btn"
              disabled={!selectedOption && !customText.trim()}
            >
              <Send size={13} />
              <span>Submit Response</span>
            </button>
          </div>
        </form>
      )}

      {prompt.allowFreeform === false && prompt.options && prompt.options.length > 0 && (
        <div className="ai-human-input-actions" style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-primary ai-human-input-submit-btn"
            disabled={!selectedOption}
            onClick={() => handleSubmit()}
          >
            <Send size={13} />
            <span>Confirm Selection</span>
          </button>
        </div>
      )}
    </div>
  );
};

interface BriefPaneProps {
  tasks: TaskItem[];
  briefs: AgentContextItem[];
  archivedTasks?: TaskItem[];
  archivedBriefs?: AgentContextItem[];
  swimLanes?: import('../types').SwimLaneDoc[];
  selectedTaskId: string | number | null;
  runningTaskIds?: (string | number)[];
  onSelectTask?: (taskId: string | number) => void;
  onSaveBrief: (updatedBrief: AgentContextItem) => void;
  onLiveBriefChange?: (updatedBrief: AgentContextItem) => void;
  onExecuteTask: (task: TaskItem) => void;
  onUpdateBriefWithAi?: (task: TaskItem) => void;
  onSyncOverviewWithTask?: (task: TaskItem) => Promise<string | void>;
  onUnarchiveTask?: (taskId: string | number) => void;
  onDeleteArchivedTask?: (taskId: string | number) => void;
  onSaveArchivedBrief?: (brief: AgentContextItem) => void;
  autosaveStatus?: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  autosaveDelaySec?: number;
  terminalSessions?: SpawnedSession[];
  executingTaskId?: string | number | null;
  taskExecutionSteps?: Record<string | number, ExecutionStep[]>;
  pendingPermissions?: Record<string | number, { prompt: McpToolPermissionPrompt; resolve: (approved: boolean) => void }>;
  pendingHumanInputs?: Record<string | number, { prompt: HumanInputPrompt; resolve: (answer: string) => void }>;
  onPermissionChoice?: (taskId: string | number, approved: boolean) => void;
  onHumanInputChoice?: (taskId: string | number, answer: string) => void;
  onSessionExit?: (taskId: string | number, code: number) => void;
  onRestartSession?: (task: TaskItem) => void;
  onKillSession?: (taskId: string | number) => void;
  onTerminateAgent?: (taskId: string | number) => void;
  onArchiveTask?: (taskTitle: string) => void;
  onRemoveAiTask?: (targetId: string | number) => void;
  // Popout Panel Controls
  isPanelOpen?: boolean;
  onTogglePanel?: () => void;
}

interface AiTaskCardProps {
  task: TaskItem;
  brief: AgentContextItem | undefined;
  isSelected: boolean;
  isWorking: boolean;
  terminalSession: SpawnedSession | null;
  isExecuting: boolean;
  executionSteps: ExecutionStep[];
  pendingPermission: McpToolPermissionPrompt | null;
  pendingHumanInput: { prompt: HumanInputPrompt; resolve: (answer: string) => void } | null;
  onSelect: () => void;
  onSaveBrief: (updatedBrief: AgentContextItem) => void;
  onLiveBriefChange?: (updatedBrief: AgentContextItem) => void;
  onExecuteTask: (task: TaskItem) => void;
  onUpdateBriefWithAi?: (task: TaskItem) => void;
  onSyncOverviewWithTask?: (task: TaskItem) => Promise<string | void>;
  onPermissionChoice?: (approved: boolean) => void;
  onHumanInputChoice?: (answer: string) => void;
  onSessionExit?: (code: number) => void;
  onRestartSession?: (task: TaskItem) => void;
  onKillSession?: (taskId: string | number) => void;
  onTerminateAgent?: (taskId: string | number) => void;
  onArchiveTask?: (taskTitle: string) => void;
  onRemoveAiTask?: (targetId: string | number) => void;
}

type CardStatus = 'not_started' | 'working' | 'done';

const CardStatusChip: React.FC<{ status: CardStatus }> = ({ status }) => {
  if (status === 'working') {
    return (
      <span className="card-status-chip is-working">
        <Loader2 size={11} className="spin-animate" />
        <span>Working...</span>
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="card-status-chip is-done">
        <CheckCircle2 size={11} />
        <span>Done</span>
      </span>
    );
  }
  return (
    <span className="card-status-chip is-not-started">
      <span className="status-dot-grey" />
      <span>Not started</span>
    </span>
  );
};

const AiTaskCard: React.FC<AiTaskCardProps> = ({
  task,
  brief,
  isSelected,
  isWorking,
  terminalSession,
  isExecuting,
  executionSteps,
  pendingPermission,
  pendingHumanInput,
  onSelect,
  onSaveBrief,
  onLiveBriefChange,
  onExecuteTask,
  onUpdateBriefWithAi: _onUpdateBriefWithAi,
  onSyncOverviewWithTask: _onSyncOverviewWithTask,
  onPermissionChoice,
  onHumanInputChoice,
  onSessionExit,
  onRestartSession,
  onKillSession,
  onTerminateAgent,
  onArchiveTask,
  onRemoveAiTask,
}) => {
  const [isTaskCollapsed, setIsTaskCollapsed] = useState(!isSelected);
  const [isEditing, setIsEditing] = useState(false);
  const [overviewText, setOverviewText] = useState('');
  const [buildVerificationText, setBuildVerificationText] = useState('');
  const [completionText, setCompletionText] = useState('');
  const [viewModeSection2, setViewModeSection2] = useState<'notes' | 'terminal' | 'steps'>('notes');
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isGherkinOpen, setIsGherkinOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const overviewRef = useRef<HTMLTextAreaElement>(null);
  const buildVerificationRef = useRef<HTMLTextAreaElement>(null);
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
  const summaryStep = React.useMemo(() => {
    return executionSteps.find(
      (s) => s.stage === 'overview' && s.status === 'success' && s.overviewDocument
    );
  }, [executionSteps]);

  const summaryDoc = summaryStep?.overviewDocument || null;

  const gherkinBrief = React.useMemo(() => {
    if (summaryDoc?.brief && summaryDoc.brief.trim().length > 0) return summaryDoc.brief.trim();
    if (brief?.brief && brief.brief.includes('Feature:')) return brief.brief.trim();
    const match = overviewText.match(/## Acceptance Brief \(Gherkin\)\s*```gherkin([\s\S]*?)```/);
    if (match) return match[1].trim();
    if (brief?.brief && brief.brief.trim().length > 0 && brief.brief.trim() !== overviewText.trim()) return brief.brief.trim();
    return '';
  }, [summaryDoc?.brief, brief?.brief, overviewText]);

  const overviewDisplayContent = React.useMemo(() => {
    return overviewText.replace(/## Acceptance Brief \(Gherkin\)\s*```gherkin[\s\S]*?```\s*/g, '').trim();
  }, [overviewText]);

  // Determine if there is actually a valid overview from the Summary agent (not generic human task list)
  const isRealOverview = React.useMemo(() => {
    if (summaryDoc) return true;
    if (!overviewText || !overviewText.trim()) return false;
    const trimmed = overviewText.trim();
    if (trimmed === task.title.trim()) return false;
    if (trimmed === `Task #${task.id}: ${task.title}`.trim()) return false;
    if (trimmed.startsWith(`Overview for ${task.title}`)) return false;
    if (trimmed === `Overview for ${task.title}`.trim()) return false;
    if (
      trimmed.includes('Scenario:') ||
      trimmed.includes('Given ') ||
      trimmed.includes('## Acceptance Brief') ||
      trimmed.includes('## Brief') ||
      trimmed.includes('## Goals') ||
      trimmed.includes('## Output') ||
      trimmed.includes('Feature:')
    ) {
      return true;
    }
    if (trimmed.length <= task.title.length + 15) return false;
    return false;
  }, [summaryDoc, overviewText, task.title, task.id]);

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
    if (isRealOverview) return true;
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
    isRealOverview,
  ]);



  // Auto-expand and scroll into view when selected, collapse when another task is selected
  useEffect(() => {
    setIsTaskCollapsed(!isSelected);
    if (isSelected && cardRef.current) {
      const timer = setTimeout(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [isSelected]);

  // Default collapsed states for inner short cards:
  // vectorMemory: collapsed by default
  // steps: collapsed by default
  const [collapsedCards, setCollapsedCards] = useState<{
    overview: boolean;
    vectorMemory: boolean;
    steps: boolean;
    completion: boolean;
  }>({
    overview: false,
    vectorMemory: true,
    steps: true,
    completion: false,
  });

  const toggleCard = (card: 'overview' | 'vectorMemory' | 'steps' | 'completion') => {
    setCollapsedCards((prev) => ({
      ...prev,
      [card]: !prev[card],
    }));
  };

  // Automatically expand steps if an interactive clarification or permission prompt is waiting
  useEffect(() => {
    if (pendingHumanInput || pendingPermission) {
      setCollapsedCards((prev) => ({ ...prev, steps: false }));
      setViewModeSection2('steps');
    }
  }, [pendingHumanInput, pendingPermission]);

  // Sync state with brief
  useEffect(() => {
    if (brief) {
      const newOverview = brief.overview || brief.brief || '';
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

  // Reset edit and card states when switching tasks or when task status/done state changes
  useEffect(() => {
    setIsEditing(false);
    setViewModeSection2('notes');
    setCollapsedCards({
      overview: false,
      vectorMemory: true,
      steps: true,
      completion: false,
    });
  }, [task.id, task.status, task.isDone]);

  const prevWorkingRef = useRef(isWorking);
  useEffect(() => {
    const wasWorking = prevWorkingRef.current;
    prevWorkingRef.current = isWorking;

    if (wasWorking && !isWorking) {
      // Build phase finished -> keep completion log visible
      setCollapsedCards((prev) => ({
        ...prev,
        completion: false,
      }));
    } else if (!wasWorking && isWorking) {
      // Started working -> expand task card
      setIsTaskCollapsed(false);
    }
  }, [isWorking]);

  const isContextRunning =
    isExecuting && executionSteps.some((s) => s.stage === 'context' && s.status === 'running');
  const isGatheringContext =
    isExecuting &&
    (isContextRunning ||
      executionSteps.length === 0 ||
      !executionSteps.some((s) => s.stage === 'overview' || s.stage === 'execution' || s.stage === 'built_record' || s.stage === 'done'));
  const contextStep = executionSteps.find((s) => s.stage === 'context');

  // ── Card Status Computations (Not started | Working... | Done) ──
  const isOverviewWorking =
    isExecuting &&
    (isGatheringContext || executionSteps.some((s) => s.stage === 'overview' && s.status === 'running'));

  const overviewStatus = React.useMemo<'not_started' | 'working' | 'done'>(() => {
    if (isOverviewWorking) {
      return 'working';
    }
    if (
      isRealOverview ||
      Boolean(summaryDoc) ||
      executionSteps.some((s) => s.stage === 'overview' && s.status === 'success') ||
      (overviewText.trim().length > 0 && !isExecuting)
    ) {
      return 'done';
    }
    return 'not_started';
  }, [isOverviewWorking, isRealOverview, summaryDoc, executionSteps, overviewText, isExecuting]);

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

  const isStepsWorking =
    Boolean(terminalSession?.session.isActive) ||
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
      (terminalSession?.session && !terminalSession.session.isActive) ||
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
  }, [isStepsWorking, terminalSession, task.isDone, task.status, executionSteps, isExecuting, buildVerificationText]);

  const isCompletionWorking =
    isExecuting && executionSteps.some((s) => (s.stage === 'built_record' || s.stage === 'done') && s.status === 'running');

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

  // Determine what to display in Section 2 (Build & Verification / Steps & Actions)
  const showTerminal = viewModeSection2 === 'terminal' && !isEditing;
  const showExecutionSteps = viewModeSection2 === 'steps' && !isEditing;

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

  const handleSave = () => {
    onSaveBrief({
      ...brief,
      id: brief?.id || `brief_${task.id}`,
      sourceTaskId: task.id,
      sourceLaneId: task.swimLaneId || brief?.sourceLaneId,
      itemNumber: brief?.itemNumber,
      title: task.title,
      status: task.status,
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

  return (
    <div
      ref={cardRef}
      className={`ai-task-card ${isSelected ? 'is-selected' : ''} ${isWorking ? 'is-running' : ''} ${task.isDone ? 'is-done' : ''} ${isMenuOpen ? 'has-open-menu' : ''}`}
      onClick={() => {
        onSelect();
        if (isTaskCollapsed) {
          setIsTaskCollapsed(false);
        }
      }}
    >
      {/* ── Task Card Header ── */}
      <div className="ai-task-card-header">
        <div className="ai-task-header-left">
          <button
            type="button"
            className={`card-collapse-btn ${isTaskCollapsed ? 'is-collapsed' : ''}`}
            title={isTaskCollapsed ? 'Expand task' : 'Collapse task'}
            aria-label={isTaskCollapsed ? 'Expand task' : 'Collapse task'}
            onClick={(e) => {
              e.stopPropagation();
              setIsTaskCollapsed((prev) => !prev);
            }}
          >
            <ChevronDown size={14} className="collapse-chevron" />
          </button>
          {brief?.isUnordered || task.isUnordered ? (
            <span className="ai-task-num-badge ai-task-num-badge-unordered" title={task.category && task.category.trim() ? task.category.trim() : 'Task'}>
              {task.category && task.category.trim() ? task.category.trim() : 'Task'}
            </span>
          ) : (
            <span
              className="ai-task-num-badge"
              title={task.category && task.category.trim() && task.category !== 'AI Workspace' ? `${task.category.trim()} #${task.listIndex ?? task.id}` : `#${brief?.itemNumber ?? task.id}`}
            >
              {task.category && task.category.trim() && task.category !== 'AI Workspace' ? `${task.category.trim()} #${task.listIndex ?? task.id}` : `#${brief?.itemNumber ?? task.id}`}
            </span>
          )}
          <span className="ai-task-title-text" title={brief?.title || task.title}>
            {brief?.title || task.title}
          </span>
          {/* {renderStatusBadge()} */}
        </div>

        <div className="ai-task-header-actions" onClick={(e) => e.stopPropagation()}>
          {isEditing ? (
            <>
              <button
                type="button"
                className="ai-card-btn"
                onClick={handleCancel}
                title="Cancel edits"
              >
                <X size={12} />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                className="ai-card-btn is-primary"
                onClick={handleSave}
                title="Save changes"
              >
                <Save size={12} />
                <span>Save</span>
              </button>
            </>
          ) : (
            <>
              {!isTaskDone && (
                <button
                  type="button"
                  className={`execute-task-btn ${isWorking ? 'is-working' : ''}`}
                  onClick={() => {
                    setIsTaskCollapsed(false);
                    onExecuteTask(task);
                  }}
                  title={isWorking ? 'Agent is working on this task...' : 'Start the AI on this task'}
                  disabled={isWorking}
                >
                  {isWorking ? (
                    <>
                      <Loader2 size={12} className="spin-animate" />
                      <span>Working...</span>
                    </>
                  ) : (
                    <>
                      <Play size={12} />
                      <span>Run Task</span>
                    </>
                  )}
                </button>
              )}
            </>
          )}

          {/* Task Options Dropdown Menu */}
          <div style={{ position: 'relative' }} ref={menuRef}>
            <button
              type="button"
              className={`swimlane-menu-btn ${isMenuOpen ? 'active' : ''}`}
              style={{ width: '26px', height: '26px' }}
              onClick={(e) => {
                e.stopPropagation();
                setIsMenuOpen((prev) => !prev);
              }}
              title="Task options"
              aria-label="Task options"
            >
              <MoreHorizontal size={13} />
            </button>

            {isMenuOpen && (
              <div className="swimlane-dropdown-menu" style={{ right: 0, minWidth: '185px' }} onClick={(e) => e.stopPropagation()}>
                {isTaskDone && (
                  <>
                    <button
                      type="button"
                      className="swimlane-dropdown-item"
                      onClick={() => {
                        setIsMenuOpen(false);
                        setIsTaskCollapsed(false);
                        onExecuteTask(task);
                      }}
                    >
                      <RotateCcw size={13} style={{ color: 'var(--accent-cyan)' }} />
                      <span>Rerun Task</span>
                    </button>

                    <div className="swimlane-dropdown-divider" />
                  </>
                )}

                <button
                  type="button"
                  className="swimlane-dropdown-item"
                  onClick={() => {
                    setIsMenuOpen(false);
                    setIsEditing(true);
                    setViewModeSection2('notes');
                    setIsTaskCollapsed(false);
                    setCollapsedCards((prev) => ({ ...prev, overview: false }));
                  }}
                >
                  <Edit3 size={13} />
                  <span>Edit Task</span>
                </button>

                <div className="swimlane-dropdown-divider" />

                {isTaskStarted ? (
                  <button
                    type="button"
                    className="swimlane-dropdown-item"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onArchiveTask?.(task.title || brief?.title || '');
                    }}
                  >
                    <Archive size={13} style={{ color: '#f59e0b' }} />
                    <span>Archive Task</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="swimlane-dropdown-item is-danger"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onRemoveAiTask?.(brief?.id || brief?.sourceTaskId || brief?.itemNumber || task.id);
                    }}
                  >
                    <Trash2 size={13} />
                    <span>Remove from AI Workspace</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Task Card Content (Collapsible) ── */}
      {!isTaskCollapsed && (
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
            {/* ═══════════════════════════════════════════════════════════
                CARD 1: TOKEN USAGE (stages breakout collapsed by default)
               ═══════════════════════════════════════════════════════════ */}
            <BvTokenCounterCard
              task={task}
              brief={brief}
              executionSteps={executionSteps}
              isExecuting={isExecuting}
              isTaskStarted={isTaskStarted}
              defaultBreakdownOpen={false}
            />

            {/* ═══════════════════════════════════════════════════════════
                CARD 2: OVERVIEW (populated from Summary agent)
               ═══════════════════════════════════════════════════════════ */}
            <div className={`ai-sub-card card-overview ${collapsedCards.overview ? 'is-collapsed' : ''}`}>
              <div
                className="ai-sub-card-header"
                onClick={() => toggleCard('overview')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedCards.overview ? 'is-collapsed' : ''}`}
                    title={collapsedCards.overview ? 'Expand Overview' : 'Collapse Overview'}
                    aria-label={collapsedCards.overview ? 'Expand Overview' : 'Collapse Overview'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCard('overview');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <ClipboardList size={14} color="#3b82f6" />
                    <span>Overview</span>
                  </span>
                  {/* {isRealOverview && !isGatheringContext && (
                    <span className="section-subtitle-tag">
                      Goals & Execution Plan
                    </span>
                  )} */}
                  {isGatheringContext && (
                    <span className="section-subtitle-tag">
                      Analyzing...
                    </span>
                  )}
                </div>

                <div
                  className="header-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  <CardStatusChip status={overviewStatus} />
                </div>
              </div>

              {!collapsedCards.overview && (
                <div className="ai-sub-card-body">
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
                  ) : isGatheringContext ? (
                    <div className="ai-card-hint" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--accent-cyan)' }}>
                      <Loader2 size={12} className="spin-animate" />
                      <span>Summary agent is synthesizing the execution brief and tool plan…</span>
                    </div>
                  ) : isRealOverview ? (
                    <div className="brief-markdown-render">
                      {summaryDoc ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                          {/* <div className="goals-brief-title">Goals & Success Criteria</div> */}
                          <div style={{ fontSize: '0.78rem', whiteSpace: 'pre-wrap', color: 'var(--text-main)', lineHeight: '1.45' }}>
                            {summaryDoc.goals}
                          </div>
                          {/* {summaryDoc.goals && (
                            <div className="goals-brief-box">
                              <div className="goals-brief-title">Goals & Success Criteria</div>
                              <div style={{ fontSize: '0.78rem', whiteSpace: 'pre-wrap', color: 'var(--text-main)', lineHeight: '1.45' }}>
                                {summaryDoc.goals}
                              </div>
                            </div>
                          )} */}
                          {summaryDoc.output_as && (
                            <div className="output-brief-box">
                              <div className="output-brief-title">Completion Goal</div>
                              <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                                {summaryDoc.output_as}
                              </span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <MarkdownRenderer content={overviewDisplayContent || overviewText} />
                      )}
                    </div>
                  ) : (
                    <div className="ai-card-hint">
                      Overview will populate with goals, success criteria, and tool plan once the Summary agent has finished. Click <strong>'Run Task'</strong> to begin.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ═══════════════════════════════════════════════════════════
                CARD 3: VECTOR MEMORY / RELATED TASKS (collapsed by default)
               ═══════════════════════════════════════════════════════════ */}
            <div className={`ai-sub-card card-related-tasks ${collapsedCards.vectorMemory ? 'is-collapsed' : ''}`}>
              <div
                className="ai-sub-card-header"
                onClick={() => toggleCard('vectorMemory')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedCards.vectorMemory ? 'is-collapsed' : ''}`}
                    title={collapsedCards.vectorMemory ? 'Expand Related Tasks' : 'Collapse Related Tasks'}
                    aria-label={collapsedCards.vectorMemory ? 'Expand Related Tasks' : 'Collapse Related Tasks'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCard('vectorMemory');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <Database size={14} color="#eab308" />
                    <span>Related Tasks</span>
                  </span>
                  {contextStep?.baselineContext && (
                    <span className="section-subtitle-tag">
                      {contextStep.baselineContext.memoryHits?.length || 0} hits · {contextStep.baselineContext.guidelines?.length || 0} guidelines
                    </span>
                  )}
                </div>

                <div className="header-right" onClick={(e) => e.stopPropagation()}>
                  <CardStatusChip status={relatedTasksStatus} />
                </div>
              </div>

              {!collapsedCards.vectorMemory && (
                <div className="ai-sub-card-body">
                  {contextStep?.baselineContext ? (
                    <BaselineContextPreview baselineContext={contextStep.baselineContext} defaultOpen={true} plain={true} />
                  ) : (
                    <div className="ai-card-hint">
                      Vector Memory will retrieve project knowledge and guidelines for baseline context when started.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ═══════════════════════════════════════════════════════════
                CARD 4: ACTIONS (collapsed by default)
               ═══════════════════════════════════════════════════════════ */}
            <div className={`ai-sub-card card-steps-actions ${collapsedCards.steps ? 'is-collapsed' : ''}`}>
              <div
                className="ai-sub-card-header"
                onClick={() => toggleCard('steps')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedCards.steps ? 'is-collapsed' : ''}`}
                    title={collapsedCards.steps ? 'Expand Actions' : 'Collapse Actions'}
                    aria-label={collapsedCards.steps ? 'Expand Actions' : 'Collapse Actions'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCard('steps');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <Wrench size={14} color="#a855f7" />
                    <span>Actions</span>
                  </span>
                </div>

                <div
                  className="header-right"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Terminal Session Controls */}
                  {terminalSession && (
                    <>
                      {onRestartSession && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem' }}
                          onClick={() => {
                            setCollapsedCards((prev) => ({ ...prev, steps: false }));
                            onRestartSession(task);
                          }}
                          title="Restart CLI agent in terminal"
                        >
                          <RotateCcw size={10} />
                        </button>
                      )}

                      {terminalSession.session.isActive && onKillSession && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ padding: '0.15rem 0.4rem', fontSize: '0.7rem', color: 'var(--accent-rose)' }}
                          onClick={() => onKillSession(task.id)}
                          title="Stop CLI agent process"
                        >
                          <Square size={10} />
                        </button>
                      )}
                    </>
                  )}

                  {/* Terminate active running agent */}
                  {isExecuting && onTerminateAgent && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{
                        padding: '0.15rem 0.45rem',
                        fontSize: '0.7rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        color: 'var(--accent-rose)',
                        borderColor: 'var(--accent-rose)',
                      }}
                      onClick={() => onTerminateAgent(task.id)}
                      title="Stop the running agent immediately"
                    >
                      <Square size={10} />
                      <span>Stop</span>
                    </button>
                  )}

                  {/* Single Status Chip */}
                  <CardStatusChip status={stepsActionsStatus} />
                </div>
              </div>

              {!collapsedCards.steps && (
                <div className="ai-sub-card-body" style={{ padding: 0 }}>
                  {/* Internal View Switcher Bar */}
                  <div className="actions-view-switcher-bar">
                    <span className="actions-switcher-label">
                      {showTerminal
                        ? `Terminal (${terminalSession?.cmd})`
                        : showExecutionSteps
                          ? executionSteps.length > 0
                            ? `${executionSteps.length} action${executionSteps.length === 1 ? '' : 's'}`
                            : 'Execution Steps'
                          : 'Notes'}
                    </span>
                    <div className="steps-notes-chip">
                      <button
                        type="button"
                        className={`steps-notes-segment ${!showExecutionSteps && !showTerminal ? 'active' : ''}`}
                        onClick={() => setViewModeSection2('notes')}
                        title="Switch to Notes view"
                      >
                        <FileText size={10} />
                        <span>Notes</span>
                      </button>
                      <button
                        type="button"
                        className={`steps-notes-segment ${showExecutionSteps || showTerminal ? 'active' : ''}`}
                        onClick={() => setViewModeSection2(terminalSession ? 'terminal' : 'steps')}
                        title={terminalSession ? 'Switch to Terminal view' : 'Switch to Steps view'}
                      >
                        {terminalSession ? <Terminal size={10} /> : <Sparkles size={10} />}
                        <span>{terminalSession ? 'Terminal' : 'Steps'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Sub-view 1: Embedded Terminal */}
                  {showTerminal && terminalSession ? (
                    <div className="embedded-terminal-wrapper">
                      <div className="embedded-terminal-topbar">
                        <span>
                          <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>cmd:</span>{' '}
                          {terminalSession.cmd} {terminalSession.args.join(' ')}
                        </span>
                        <span>
                          <span style={{ color: 'var(--accent-violet)', fontWeight: 600 }}>cwd:</span>{' '}
                          {terminalSession.cwd}
                        </span>
                      </div>
                      <div className="embedded-terminal-body">
                        <AgentTerminal
                          cmd={terminalSession.cmd}
                          args={terminalSession.args}
                          cwd={terminalSession.cwd}
                          onExit={(code) => onSessionExit?.(code)}
                        />
                      </div>
                    </div>
                  ) : showExecutionSteps ? (
                    /* Sub-view 2: In-place Execution Steps & Logs */
                    <div className="execution-steps-wrapper" style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                      {/* Interactive Mid-Build Human Clarification Card if active */}
                      {pendingHumanInput && onHumanInputChoice && (
                        <HumanInputCard
                          prompt={pendingHumanInput.prompt}
                          onSubmit={onHumanInputChoice}
                        />
                      )}

                      {/* Interactive MCP Permission Prompt Card if active */}
                      {pendingPermission && onPermissionChoice && (
                        <div
                          style={{
                            background: 'rgba(239, 68, 68, 0.08)',
                            border: '1px solid rgba(239, 68, 68, 0.35)',
                            borderRadius: 'var(--radius-md)',
                            padding: '0.75rem',
                            animation: 'fadeIn 0.2s ease',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-rose)', fontWeight: 700, fontSize: '0.82rem', marginBottom: '0.35rem' }}>
                            <ShieldAlert size={15} />
                            <span>Permission Authorization Required</span>
                          </div>
                          <p style={{ fontSize: '0.78rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>
                            Request to execute: <strong style={{ color: 'var(--accent-cyan)' }}>{pendingPermission.serverName} / {pendingPermission.toolName}()</strong>
                          </p>
                          <div style={{ background: 'var(--bg-darkest)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: '0.6rem' }}>
                            {pendingPermission.summary}
                          </div>
                          <div style={{ display: 'flex', gap: '0.45rem', justifyContent: 'flex-end' }}>
                            <button className="btn btn-secondary" style={{ padding: '0.2rem 0.55rem', fontSize: '0.74rem' }} onClick={() => onPermissionChoice(false)}>
                              Skip / Reject
                            </button>
                            <button className="btn btn-emerald" style={{ padding: '0.2rem 0.55rem', fontSize: '0.74rem' }} onClick={() => onPermissionChoice(true)}>
                              <ShieldCheck size={13} />
                              <span>Approve</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Top Card: Acceptance Brief (Gherkin Scenarios) - Collapsed by default */}
                      {gherkinBrief && (
                        <div className={`ai-step-gherkin-card ${isGherkinOpen ? 'is-open' : 'is-collapsed'}`}>
                          <div
                            className="ai-step-gherkin-header"
                            onClick={() => setIsGherkinOpen((v) => !v)}
                            title={isGherkinOpen ? 'Collapse Acceptance Brief' : 'Expand Acceptance Brief'}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                              <button
                                type="button"
                                className={`card-collapse-btn ${!isGherkinOpen ? 'is-collapsed' : ''}`}
                                aria-label={isGherkinOpen ? 'Collapse Acceptance Brief' : 'Expand Acceptance Brief'}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setIsGherkinOpen((v) => !v);
                                }}
                              >
                                <ChevronDown size={11} className="collapse-chevron" />
                              </button>
                              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-bright)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                <span>🥒</span>
                                <span>Acceptance Brief (Gherkin Scenarios)</span>
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                              <span className="card-item-tag-completed" style={{ fontSize: '0.65rem' }}>
                                Gherkin Spec
                              </span>
                            </div>
                          </div>

                          {isGherkinOpen && (
                            <div className="ai-step-gherkin-body">
                              <pre className="gherkin-brief-pre">
                                {gherkinBrief}
                              </pre>
                            </div>
                          )}
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
                                  <PieceChip pieceId={step.stage === 'mcp_call' ? step.pieceId : undefined} />
                                  <span style={{ fontSize: '0.8rem', color: step.status === 'cancelled' ? 'var(--text-muted)' : undefined }}>{step.title}</span>
                                </div>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                  <StepUsageBadge usage={step.usage} />
                                  <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                                    {step.time}
                                  </span>
                                </span>
                              </div>

                              <div className="step-detail">{step.detail}</div>
                              <BiblePreview markdown={step.bibleMarkdown} filePath={step.bibleMarkdown ? step.bibleFilePath : undefined} />

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
                    </div>
                  ) : isEditing ? (
                    <div style={{ padding: '0.55rem 0.75rem' }}>
                      <textarea
                        ref={buildVerificationRef}
                        className="obsidian-card-textarea"
                        placeholder="Record mid-task progress, steps taken on the journey, architectural choices, and why..."
                        value={buildVerificationText}
                        onChange={(e) => handleFieldChange('buildAndVerification', e.target.value)}
                        onKeyDown={(e) => handleMarkdownAutoWrap(e, (val) => handleFieldChange('buildAndVerification', val))}
                        onFocus={() => setActiveFocusedRef(buildVerificationRef)}
                        rows={4}
                      />
                    </div>
                  ) : (
                    <div className="brief-body" style={{ padding: '0.55rem 0.75rem' }}>
                      {buildVerificationText ? (
                        <div className="brief-markdown-render">
                          <MarkdownRenderer content={buildVerificationText} />
                        </div>
                      ) : (
                        <div className="ai-card-hint">
                          Mid-task build & verification steps will appear here as the agent works.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ═══════════════════════════════════════════════════════════
                CARD 5: COMPLETION LOG
               ═══════════════════════════════════════════════════════════ */}
            <div className={`ai-sub-card card-completion ${collapsedCards.completion ? 'is-collapsed' : ''}`}>
              <div
                className="ai-sub-card-header"
                onClick={() => toggleCard('completion')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedCards.completion ? 'is-collapsed' : ''}`}
                    title={collapsedCards.completion ? 'Expand Completion Log' : 'Collapse Completion Log'}
                    aria-label={collapsedCards.completion ? 'Expand Completion Log' : 'Collapse Completion Log'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCard('completion');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <Flag size={14} color="#14b8a6" />
                    <span>Completion</span>
                  </span>
                  {/* <span className="section-subtitle-tag">What Got Done</span> */}
                </div>

                <div className="header-right" onClick={(e) => e.stopPropagation()}>
                  <CardStatusChip status={completionStatus} />
                </div>
              </div>

              {!collapsedCards.completion && (
                <div className="ai-sub-card-body">
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
                    <div className="brief-body" style={{ padding: '0.55rem 0.75rem' }}>
                      <div className="brief-markdown-render">
                        <MarkdownRenderer content={completionText} />
                      </div>
                    </div>
                  ) : (
                    <div className="ai-card-hint">
                      The completion log will be written when the Logger agent finishes execution.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const BriefPane: React.FC<BriefPaneProps> = ({
  tasks,
  briefs,
  archivedTasks = [],
  archivedBriefs = [],
  swimLanes = [],
  selectedTaskId,
  runningTaskIds = [],
  onSelectTask,
  onSaveBrief,
  onLiveBriefChange,
  onExecuteTask,
  onUpdateBriefWithAi: _onUpdateBriefWithAi,
  onSyncOverviewWithTask,
  onUnarchiveTask,
  onDeleteArchivedTask,
  onSaveArchivedBrief: _onSaveArchivedBrief,
  terminalSessions = [],
  executingTaskId = null,
  taskExecutionSteps = {},
  pendingPermissions = {},
  pendingHumanInputs = {},
  onPermissionChoice,
  onHumanInputChoice,
  onSessionExit,
  onRestartSession,
  onKillSession,
  onTerminateAgent,
  onArchiveTask,
  onRemoveAiTask,
  isPanelOpen = true,
  onTogglePanel,
}) => {
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // Close workspace header dropdown on outside click or Escape
  useEffect(() => {
    if (!isHeaderMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setIsHeaderMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsHeaderMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isHeaderMenuOpen]);

  const activeTaskRunningCount = runningTaskIds.length;
  const doneCount = briefs.filter((b) => b.status === 'done').length;

  // ── Collapsed Vertical Menu Rail View ──
  if (isPanelOpen === false) {
    return (
      <div
        className="ai-workspace-vertical-rail"
        onClick={onTogglePanel}
        title="Expand AI Workspace Panel"
      >
        {/* Top Expand Button */}
        <button
          type="button"
          className="ai-rail-expand-btn"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePanel?.();
          }}
          title="Expand AI Workspace Panel"
          aria-label="Expand AI Workspace Panel"
        >
          <PanelRightOpen size={16} />
        </button>

        {/* Vertical Middle Section: Icon, Rotated Label, Counts */}
        <div className="ai-rail-middle-section">
          <div className="ai-rail-icon-wrapper">
            <FileCode size={16} style={{ color: 'var(--accent-violet)' }} />
            {activeTaskRunningCount > 0 && (
              <span className="live-pulse-dot ai-rail-pulse" title={`${activeTaskRunningCount} running task${activeTaskRunningCount > 1 ? 's' : ''}`} />
            )}
          </div>

          <div className="ai-rail-text-label">
            <span>AI WORKSPACE</span>
          </div>

          <div className="ai-rail-count-badge" title={`${doneCount} of ${briefs.length} tasks completed`}>
            <span>{doneCount}/{briefs.length}</span>
          </div>

          {activeTaskRunningCount > 0 && (
            <div className="ai-rail-running-badge" title={`${activeTaskRunningCount} task${activeTaskRunningCount > 1 ? 's' : ''} currently running`}>
              <Loader2 size={11} className="spin-animate" />
              <span>{activeTaskRunningCount}</span>
            </div>
          )}
        </div>

        {/* Bottom Rail Actions */}
        <div className="ai-rail-bottom-section" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="ai-rail-action-btn"
            onClick={() => setIsArchiveModalOpen(true)}
            title="View Archived Tasks"
            aria-label="View Archived Tasks"
          >
            <Archive size={14} color="#f59e0b" />
            {archivedTasks.length > 0 && (
              <span className="ai-rail-mini-badge">{archivedTasks.length}</span>
            )}
          </button>
        </div>

        {/* Archived Tasks Modal Window */}
        <ArchivedTasksModal
          isOpen={isArchiveModalOpen}
          onClose={() => setIsArchiveModalOpen(false)}
          archivedTasks={archivedTasks}
          swimLanes={swimLanes}
          briefs={briefs}
          archivedBriefs={archivedBriefs}
          onUnarchiveTask={onUnarchiveTask}
          onDeleteArchivedTask={onDeleteArchivedTask}
        />
      </div>
    );
  }

  return (
    <div className="pane pane-right obsidian-pane ai-workspace-popout-panel">
      <div className="ai-workspace-column">
        {/* ── Pane Header ── */}
        <div className="ai-workspace-column-header">
          <div className="ai-workspace-title-container">
            <FileCode size={15} style={{ color: 'var(--accent-violet)', flexShrink: 0 }} />
            <span className="ai-workspace-title-text">AI Workspace</span>
            <span className="swimlane-done-badge">{doneCount}/{briefs.length} done</span>
          </div>

          <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
            {activeTaskRunningCount > 0 && (
              <span className="running-indicator-badge">
                <span className="live-pulse-dot" />
                <span>{activeTaskRunningCount} running</span>
              </span>
            )}

            {/* AI Workspace Header Actions Menu */}
            <div style={{ position: 'relative' }} ref={headerMenuRef}>
              <button
                type="button"
                className={`swimlane-menu-btn ${isHeaderMenuOpen ? 'active' : ''}`}
                onClick={() => setIsHeaderMenuOpen((prev) => !prev)}
                title="Workspace actions"
                aria-label="Workspace actions"
              >
                <MoreHorizontal size={15} />
              </button>

              {isHeaderMenuOpen && (
                <div className="swimlane-dropdown-menu" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="swimlane-dropdown-item"
                    onClick={() => {
                      setIsHeaderMenuOpen(false);
                      setIsArchiveModalOpen(true);
                    }}
                  >
                    <Archive size={13} style={{ color: '#f59e0b' }} />
                    <span>Archived Tasks</span>
                    {archivedTasks.length > 0 && (
                      <span className="dropdown-item-badge" style={{ marginLeft: 'auto', fontSize: '0.7rem', padding: '0.05rem 0.35rem', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.35)', color: '#f59e0b', fontWeight: 600 }}>
                        {archivedTasks.length}
                      </span>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Collapse AI Workspace Panel Button */}
            {onTogglePanel && (
              <button
                type="button"
                className="swimlane-menu-btn ai-panel-collapse-btn"
                onClick={onTogglePanel}
                title="Collapse AI Workspace panel"
                aria-label="Collapse AI Workspace panel"
              >
                <PanelRightClose size={14} />
              </button>
            )}
          </div>
        </div>

        {/* ── Scrollable Multi-Task List ── */}
        <div className="brief-scrollable-workspace">
          {briefs.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '300px' }}>
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                <ListTodo size={48} color="var(--accent-violet)" style={{ opacity: 0.45, marginBottom: '1rem' }} />
                <h3 style={{ color: 'var(--text-bright)', fontSize: '1.15rem' }}>No AI tasks in workspace</h3>
                <p style={{ fontSize: '0.85rem', marginTop: '0.5rem', maxWidth: '420px', lineHeight: '1.6' }}>
                  AI implementation briefs and execution plans will appear here.
                </p>
              </div>
            </div>
          ) : (
            <div className="ai-tasks-list-container">
              {briefs.map((brief, index) => {
                const matchingTask =
                  (brief.sourceTaskId ? tasks.find((t) => t.id === brief.sourceTaskId) : null) ||
                  tasks.find((t) => t.title.trim().toLowerCase() === brief.title.trim().toLowerCase());

                const effectiveTask: TaskItem = matchingTask || {
                  id: brief.sourceTaskId || brief.id || `brief-${brief.itemNumber || index + 1}`,
                  title: brief.title,
                  category: brief.sourceLaneTitle || 'AI Workspace',
                  status: (brief.status as TaskStatus) || 'not_started',
                  isDone: brief.status === 'done',
                  subtasks: [],
                  isUnordered: brief.isUnordered,
                  swimLaneId: brief.sourceLaneId,
                };

                const terminalSession = terminalSessions.find((s) => s.session.taskId === effectiveTask.id) ?? null;
                const isTerminalRunning = !!terminalSession?.session.isActive;
                const isExecuting = executingTaskId === effectiveTask.id;
                const isWorking = isTerminalRunning || isExecuting;
                const isSelected =
                  selectedTaskId != null &&
                  (selectedTaskId === effectiveTask.id ||
                    (matchingTask != null && selectedTaskId === matchingTask.id) ||
                    (brief.sourceTaskId != null && selectedTaskId === brief.sourceTaskId) ||
                    (brief.id != null && selectedTaskId === brief.id));

                return (
                  <AiTaskCard
                    key={brief.id || brief.sourceTaskId || brief.itemNumber || `brief-${index}`}
                    task={effectiveTask}
                    brief={brief}
                    isSelected={isSelected}
                    isWorking={isWorking}
                    terminalSession={terminalSession}
                    isExecuting={isExecuting}
                    executionSteps={taskExecutionSteps[effectiveTask.id] || []}
                    pendingPermission={pendingPermissions[effectiveTask.id]?.prompt ?? null}
                    pendingHumanInput={pendingHumanInputs[effectiveTask.id] ?? null}
                    onSelect={() => onSelectTask?.(brief.sourceTaskId || brief.id || effectiveTask.id)}
                    onSaveBrief={onSaveBrief}
                    onLiveBriefChange={onLiveBriefChange}
                    onExecuteTask={onExecuteTask}
                    onUpdateBriefWithAi={_onUpdateBriefWithAi}
                    onSyncOverviewWithTask={onSyncOverviewWithTask}
                    onPermissionChoice={(approved) => onPermissionChoice?.(effectiveTask.id, approved)}
                    onHumanInputChoice={(answer) => onHumanInputChoice?.(effectiveTask.id, answer)}
                    onSessionExit={(code) => onSessionExit?.(effectiveTask.id, code)}
                    onRestartSession={onRestartSession}
                    onKillSession={onKillSession}
                    onTerminateAgent={onTerminateAgent}
                    onArchiveTask={onArchiveTask}
                    onRemoveAiTask={(targetId) => onRemoveAiTask?.(targetId)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Archived Tasks Modal Window ── */}
      <ArchivedTasksModal
        isOpen={isArchiveModalOpen}
        onClose={() => setIsArchiveModalOpen(false)}
        archivedTasks={archivedTasks}
        swimLanes={swimLanes}
        briefs={briefs}
        archivedBriefs={archivedBriefs}
        onUnarchiveTask={onUnarchiveTask}
        onDeleteArchivedTask={onDeleteArchivedTask}
      />
    </div>
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
          <span style={{ fontSize: '0.7rem', color: 'var(--accent-emerald)', background: 'rgba(16, 185, 129, 0.15)', padding: '0.1rem 0.45rem', borderRadius: '4px' }}>
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
