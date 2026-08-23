import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  type TaskItem,
  type AgentContextItem,
  type SpawnedSession,
  type ExecutionStep,
  type McpToolPermissionPrompt,
} from '../types';
import { AgentTerminal } from './AgentTerminal';
import {
  FileCode,
  Edit3,
  Save,
  Play,
  CheckCircle2,
  Clock,
  CircleDot,
  Terminal,
  RotateCcw,
  Square,
  ShieldAlert,
  ShieldCheck,
  Code,
  Layers,
  Send,
  Loader2,
  XCircle,
  X,
  FileText,
  ChevronDown,
  ListTodo,
  Sparkles,
  ClipboardList,
  Wrench,
  Flag,
  Archive,
  Trash2,
  AlertTriangle,
  AlertCircle,
} from 'lucide-react';

import { RichTextToolbar } from './RichTextToolbar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { handleMarkdownAutoWrap } from '../lib/markdownEditorUtils';

interface BriefPaneProps {
  tasks: TaskItem[];
  briefs: AgentContextItem[];
  archivedTasks?: TaskItem[];
  archivedBriefs?: AgentContextItem[];
  selectedTaskId: number | null;
  runningTaskIds?: number[];
  onSelectTask?: (taskId: number) => void;
  onSaveBrief: (updatedBrief: AgentContextItem) => void;
  onLiveBriefChange?: (updatedBrief: AgentContextItem) => void;
  onExecuteTask: (task: TaskItem) => void;
  onUpdateBriefWithAi?: (task: TaskItem) => void;
  onSyncOverviewWithTask?: (task: TaskItem) => Promise<string | void>;
  onUnarchiveTask?: (taskId: number) => void;
  onDeleteArchivedTask?: (taskId: number) => void;
  onSaveArchivedBrief?: (brief: AgentContextItem) => void;
  autosaveStatus?: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  autosaveDelaySec?: number;
  terminalSessions?: SpawnedSession[];
  executingTaskId?: number | null;
  taskExecutionSteps?: Record<number, ExecutionStep[]>;
  pendingPermissions?: Record<number, { prompt: McpToolPermissionPrompt; resolve: (approved: boolean) => void }>;
  onPermissionChoice?: (taskId: number, approved: boolean) => void;
  onSessionExit?: (taskId: number, code: number) => void;
  onRestartSession?: (task: TaskItem) => void;
  onKillSession?: (taskId: number) => void;
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
  onSelect: () => void;
  onSaveBrief: (updatedBrief: AgentContextItem) => void;
  onLiveBriefChange?: (updatedBrief: AgentContextItem) => void;
  onExecuteTask: (task: TaskItem) => void;
  onUpdateBriefWithAi?: (task: TaskItem) => void;
  onSyncOverviewWithTask?: (task: TaskItem) => Promise<string | void>;
  onPermissionChoice?: (approved: boolean) => void;
  onSessionExit?: (code: number) => void;
  onRestartSession?: (task: TaskItem) => void;
  onKillSession?: (taskId: number) => void;
}

const AiTaskCard: React.FC<AiTaskCardProps> = ({
  task,
  brief,
  isSelected,
  isWorking,
  terminalSession,
  isExecuting,
  executionSteps,
  pendingPermission,
  onSelect,
  onSaveBrief,
  onLiveBriefChange,
  onExecuteTask,
  onUpdateBriefWithAi,
  onSyncOverviewWithTask,
  onPermissionChoice,
  onSessionExit,
  onRestartSession,
  onKillSession,
}) => {
  const [isTaskCollapsed, setIsTaskCollapsed] = useState(!isSelected);
  const [isEditing, setIsEditing] = useState(false);
  const [isSyncingOverview, setIsSyncingOverview] = useState(false);
  const [overviewText, setOverviewText] = useState('');
  const [buildVerificationText, setBuildVerificationText] = useState('');
  const [completionText, setCompletionText] = useState('');
  const [viewModeSection2, setViewModeSection2] = useState<'auto' | 'notes' | 'terminal' | 'steps'>('auto');

  const overviewRef = useRef<HTMLTextAreaElement>(null);
  const buildVerificationRef = useRef<HTMLTextAreaElement>(null);
  const completionRef = useRef<HTMLTextAreaElement>(null);
  const [activeFocusedRef, setActiveFocusedRef] = useState<React.RefObject<HTMLTextAreaElement | null> | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);

  // Auto-expand and scroll into view when selected
  useEffect(() => {
    setIsTaskCollapsed(!isSelected);
    if (isSelected && cardRef.current) {
      const timer = setTimeout(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [isSelected]);

  // Stage-based default collapsed states for inner 3 cards
  const getStageCollapsedState = useCallback(() => {
    const isDone =
      task.isDone ||
      task.status === 'done' ||
      (!!terminalSession && !terminalSession.session.isActive && terminalSession.session.exitCode === 0);

    if (isWorking) {
      return { overview: true, build: false, completion: true };
    }
    if (isDone) {
      return { overview: true, build: true, completion: false };
    }
    return { overview: false, build: true, completion: true };
  }, [task.isDone, task.status, terminalSession, isWorking]);

  const [collapsedSections, setCollapsedSections] = useState<{
    overview: boolean;
    build: boolean;
    completion: boolean;
  }>(getStageCollapsedState);

  const toggleSection = (section: 'overview' | 'build' | 'completion') => {
    setCollapsedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

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

  // Reset edit and section states when switching tasks or when task status/done state changes
  useEffect(() => {
    setIsEditing(false);
    setViewModeSection2('auto');
    setCollapsedSections(getStageCollapsedState());
  }, [task.id, task.status, task.isDone, getStageCollapsedState]);

  const prevWorkingRef = useRef(isWorking);
  useEffect(() => {
    const wasWorking = prevWorkingRef.current;
    prevWorkingRef.current = isWorking;

    if (wasWorking && !isWorking) {
      // Build phase finished -> collapse Build & Verification, expand Completion
      setCollapsedSections({
        overview: true,
        build: true,
        completion: false,
      });
    } else if (!wasWorking && isWorking) {
      // Started working -> expand task card, collapse Overview, expand Build & Verification
      setIsTaskCollapsed(false);
      setCollapsedSections({
        overview: true,
        build: false,
        completion: true,
      });
    }
  }, [isWorking]);

  // Determine what to display in Section 2 (Build & Verification)
  const showTerminal =
    (viewModeSection2 === 'terminal' || (viewModeSection2 === 'auto' && !!terminalSession)) &&
    !isEditing;

  const showExecutionSteps =
    !showTerminal &&
    (viewModeSection2 === 'steps' || (viewModeSection2 === 'auto' && (isExecuting || executionSteps.length > 0))) &&
    !isEditing;

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
        itemNumber: task.id,
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
      itemNumber: task.id,
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
          itemNumber: task.id,
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
          itemNumber: task.id,
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

  const handleSyncWithTask = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSyncingOverview) return;
    setIsSyncingOverview(true);
    try {
      if (onSyncOverviewWithTask) {
        const result = await onSyncOverviewWithTask(task);
        if (result && typeof result === 'string') {
          setOverviewText(result);
        }
      } else if (onUpdateBriefWithAi) {
        onUpdateBriefWithAi(task);
      }
      setCollapsedSections((prev) => ({ ...prev, overview: false }));
    } catch (err) {
      console.error('Failed to sync overview with task:', err);
    } finally {
      setIsSyncingOverview(false);
    }
  };

  const renderStatusBadge = () => {
    if (isWorking) {
      return (
        <span className="task-status-pill status-working">
          <Loader2 size={12} className="spin-animate" />
          <span>Working...</span>
        </span>
      );
    }
    if (task.isDone || task.status === 'done') {
      return (
        <span className="task-status-pill status-done">
          <CheckCircle2 size={12} />
          <span>Done</span>
        </span>
      );
    }
    if (task.status === 'in_progress') {
      return (
        <span className="task-status-pill status-in-progress">
          <Clock size={12} />
          <span>In Progress</span>
        </span>
      );
    }
    return (
      <span className="task-status-pill status-not-started">
        <CircleDot size={12} />
        <span>Not Started</span>
      </span>
    );
  };

  return (
    <div
      ref={cardRef}
      className={`ai-task-card ${isSelected ? 'is-selected' : ''} ${isWorking ? 'is-running' : ''} ${task.isDone ? 'is-done' : ''}`}
      onClick={onSelect}
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
          {task.isUnordered ? (
            <span className="ai-task-num-badge ai-task-num-badge-unordered" title={task.category && task.category.trim() ? task.category.trim() : 'Task'}>
              {task.category && task.category.trim() ? task.category.trim() : 'Task'}
            </span>
          ) : (
            <span className="ai-task-num-badge" title={`${task.category && task.category.trim() ? task.category.trim() : 'Untitled'} #${task.listIndex ?? task.id}`}>
              {task.category && task.category.trim() ? task.category.trim() : 'Untitled'} #{task.listIndex ?? task.id}
            </span>
          )}
          <span className="ai-task-title-text" title={task.title}>
            {task.title}
          </span>
          {renderStatusBadge()}
        </div>

        <div className="ai-task-header-actions" onClick={(e) => e.stopPropagation()}>
          {isEditing ? (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0.25rem 0.55rem', fontSize: '0.76rem' }}
                onClick={handleCancel}
                title="Cancel edits"
              >
                <X size={12} />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: '0.25rem 0.55rem', fontSize: '0.76rem' }}
                onClick={handleSave}
                title="Save changes"
              >
                <Save size={12} />
                <span>Save</span>
              </button>
            </>
          ) : (
            <>
              {isSelected && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.76rem' }}
                  onClick={() => {
                    setIsEditing(true);
                    setViewModeSection2('notes');
                    setIsTaskCollapsed(false);
                  }}
                  title="Edit task notes"
                >
                  <Edit3 size={12} />
                  <span>Edit</span>
                </button>
              )}

              {(isSelected || isWorking) && (
                <button
                  type="button"
                  className={`execute-task-btn ${isWorking ? 'is-working' : ''}`}
                  style={{ padding: '0.25rem 0.65rem', fontSize: '0.76rem', height: 'auto', minHeight: '1.75rem', maxWidth: 'none' }}
                  onClick={() => {
                    setIsTaskCollapsed(false);
                    setCollapsedSections({
                      overview: true,
                      build: false,
                      completion: true,
                    });
                    onExecuteTask(task);
                  }}
                  title={isWorking ? 'Agent is working on this task...' : 'Start the AI on this task'}
                  disabled={isWorking}
                >
                  {isWorking ? (
                    <>
                      <Loader2 size={13} className="spin-animate" />
                      <span>Working...</span>
                    </>
                  ) : (
                    <>
                      <Play size={13} />
                      <span>Run Task</span>
                    </>
                  )}
                </button>
              )}
            </>
          )}
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

          <div className="brief-container" style={{ padding: 0 }}>
            {/* ═══════════════════════════════════════════════════════════
                SECTION 1: OVERVIEW
               ═══════════════════════════════════════════════════════════ */}
            <div className={`brief-card ${collapsedSections.overview ? 'is-collapsed' : ''}`}>
              <div
                className="brief-section-header clickable-header"
                onClick={() => toggleSection('overview')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedSections.overview ? 'is-collapsed' : ''}`}
                    title={collapsedSections.overview ? 'Expand section' : 'Collapse section'}
                    aria-label={collapsedSections.overview ? 'Expand section' : 'Collapse section'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSection('overview');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <span className="section-icon">
                      <ClipboardList size={18} color="var(--accent-violet)" />
                    </span>
                    <span>Overview</span>
                  </span>
                  <span className="section-subtitle-tag">Frontend Notes & Task in Context</span>
                </div>

                <div
                  className="header-right"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="btn btn-secondary sync-with-task-btn"
                    style={{
                      padding: '0.2rem 0.55rem',
                      fontSize: '0.72rem',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                    }}
                    onClick={handleSyncWithTask}
                    disabled={isSyncingOverview}
                    title="Sync Overview with task"
                  >
                    {isSyncingOverview ? (
                      <>
                        <Loader2 size={11} className="spin-animate" />
                        <span>Syncing...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={11} color="var(--accent-violet)" />
                        <span>Sync Task</span>
                      </>
                    )}
                  </button>
                  {overviewText ? (
                    <span className="card-item-count">{overviewText.split('\n').filter(Boolean).length} lines</span>
                  ) : (
                    <span className="card-item-tag-empty">Empty</span>
                  )}
                </div>
              </div>

              <div className="brief-body-wrapper">
                {isEditing ? (
                  <textarea
                    ref={overviewRef}
                    className="obsidian-card-textarea"
                    placeholder="Write verbose task overview, frontend notes, done-state goals, seams, and constraints in context of other tasks in Markdown..."
                    value={overviewText}
                    onChange={(e) => handleFieldChange('overview', e.target.value)}
                    onKeyDown={(e) => handleMarkdownAutoWrap(e, (val) => handleFieldChange('overview', val))}
                    onFocus={() => setActiveFocusedRef(overviewRef)}
                    rows={4}
                  />
                ) : (
                  <div className="brief-body">
                    {overviewText ? (
                      <div className="brief-markdown-render">
                        <MarkdownRenderer content={overviewText} />
                      </div>
                    ) : (
                      <div className="brief-empty-markdown">
                        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                          No verbose overview defined yet.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════
                SECTION 2: BUILD & VERIFICATION
               ═══════════════════════════════════════════════════════════ */}
            <div className={`brief-card ${collapsedSections.build ? 'is-collapsed' : ''}`}>
              <div
                className="brief-section-header clickable-header"
                onClick={() => toggleSection('build')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedSections.build ? 'is-collapsed' : ''}`}
                    title={collapsedSections.build ? 'Expand section' : 'Collapse section'}
                    aria-label={collapsedSections.build ? 'Expand section' : 'Collapse section'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSection('build');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <span className="section-icon">
                      <Wrench size={18} color="var(--accent-violet)" />
                    </span>
                    <span>Build & Verification</span>
                  </span>
                  <span className="section-subtitle-tag">
                    {showTerminal
                      ? `CLI Agent Terminal (${terminalSession?.cmd})`
                      : showExecutionSteps
                        ? 'Live Execution Steps & MCP Stream'
                        : 'Mid-Task Steps, Journey & Rationale'}
                  </span>
                </div>

                <div
                  className="header-right"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Case 1: Terminal Session Active or Existed */}
                  {terminalSession ? (
                    <>
                      {terminalSession.session.isActive ? (
                        <span className="card-item-tag-working">
                          <span className="live-pulse-dot" />
                          <span>Running</span>
                        </span>
                      ) : terminalSession.session.exitCode === 0 ? (
                        <span className="card-item-tag-completed">
                          <CheckCircle2 size={11} color="var(--accent-emerald)" />
                          <span>Exited (0)</span>
                        </span>
                      ) : (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            fontSize: '0.72rem',
                            fontWeight: 700,
                            color: 'var(--accent-rose)',
                            background: 'rgba(244, 63, 94, 0.12)',
                            border: '1px solid rgba(244, 63, 94, 0.3)',
                            padding: '0.15rem 0.5rem',
                            borderRadius: '9999px',
                          }}
                        >
                          <XCircle size={11} />
                          <span>Exited ({terminalSession.session.exitCode ?? 1})</span>
                        </span>
                      )}

                      {/* Restart Button */}
                      {onRestartSession && (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.45rem', fontSize: '0.72rem' }}
                          onClick={() => {
                            setCollapsedSections({
                              overview: true,
                              build: false,
                              completion: true,
                            });
                            onRestartSession(task);
                          }}
                          title="Restart CLI agent in terminal"
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}

                      {/* Kill Button if running */}
                      {terminalSession.session.isActive && onKillSession && (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.45rem', fontSize: '0.72rem', color: 'var(--accent-rose)' }}
                          onClick={() => onKillSession(task.id)}
                          title="Stop CLI agent process"
                        >
                          <Square size={11} />
                        </button>
                      )}

                      {/* Toggle View Mode between Terminal and Notes */}
                      {!isEditing && (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                          onClick={() => setViewModeSection2(showTerminal ? 'notes' : 'terminal')}
                          title={showTerminal ? 'Switch to Markdown notes' : 'Switch to live Terminal'}
                        >
                          {showTerminal ? <FileText size={11} /> : <Terminal size={11} />}
                          <span>{showTerminal ? 'Notes' : 'Terminal'}</span>
                        </button>
                      )}
                    </>
                  ) : isExecuting ? (
                    /* Case 2: Live AI Execution Running */
                    <>
                      <span className="card-item-tag-working">
                        <Loader2 size={11} className="spin-animate" />
                        <span>Working...</span>
                      </span>
                      {!isEditing && (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                          onClick={() => setViewModeSection2(showExecutionSteps ? 'notes' : 'steps')}
                        >
                          {showExecutionSteps ? <FileText size={11} /> : <Sparkles size={11} />}
                          <span>{showExecutionSteps ? 'Notes' : 'Live Logs'}</span>
                        </button>
                      )}
                    </>
                  ) : executionSteps.length > 0 ? (
                    /* Case 3: Completed Execution Steps */
                    <>
                      <span className="card-item-tag-completed">
                        <CheckCircle2 size={11} color="var(--accent-emerald)" />
                        <span>{executionSteps.length} steps</span>
                      </span>
                      {!isEditing && (
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                          onClick={() => setViewModeSection2(showExecutionSteps ? 'notes' : 'steps')}
                        >
                          {showExecutionSteps ? <FileText size={11} /> : <Sparkles size={11} />}
                          <span>{showExecutionSteps ? 'Notes' : 'Steps'}</span>
                        </button>
                      )}
                    </>
                  ) : buildVerificationText ? (
                    <span className="card-item-count">{buildVerificationText.split('\n').filter(Boolean).length} lines</span>
                  ) : (
                    <span className="card-item-tag-empty">Not in progress</span>
                  )}
                </div>
              </div>

              <div className="brief-body-wrapper">
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
                  <div style={{ padding: '1rem', background: '#0a0c10', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    {/* Interactive MCP Permission Prompt Card if active */}
                    {pendingPermission && onPermissionChoice && (
                      <div
                        style={{
                          background: 'rgba(239, 68, 68, 0.08)',
                          border: '1px solid rgba(239, 68, 68, 0.35)',
                          borderRadius: 'var(--radius-md)',
                          padding: '1rem',
                          animation: 'fadeIn 0.2s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-rose)', fontWeight: 700, fontSize: '0.88rem', marginBottom: '0.4rem' }}>
                          <ShieldAlert size={17} />
                          <span>Permission Authorization Required</span>
                        </div>
                        <p style={{ fontSize: '0.82rem', color: '#fff', marginBottom: '0.6rem' }}>
                          The AI agent is requesting to execute: <strong style={{ color: 'var(--accent-cyan)' }}>{pendingPermission.serverName} / {pendingPermission.toolName}()</strong>
                        </p>
                        <div style={{ background: 'var(--bg-darkest)', padding: '0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                          {pendingPermission.summary}
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                          <button className="btn btn-secondary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }} onClick={() => onPermissionChoice(false)}>
                            Skip / Reject
                          </button>
                          <button className="btn btn-emerald" style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }} onClick={() => onPermissionChoice(true)}>
                            <ShieldCheck size={14} />
                            <span>Approve Tool Call</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Execution Steps */}
                    <div className="execution-steps">
                      {executionSteps.map((step) => (
                        <div key={step.id} className={`step-card ${step.status}`}>
                          <div className="step-header">
                            <div className="step-title">
                              {step.status === 'running' && <Loader2 size={15} className="spin-animate" color="var(--accent-primary)" />}
                              {step.status === 'success' && <CheckCircle2 size={15} color="var(--accent-emerald)" />}
                              {step.status === 'warning' && <ShieldAlert size={15} color="var(--accent-rose)" />}
                              {step.status === 'pending' && <CircleDot size={15} color="var(--text-dim)" />}
                              <span style={{ fontSize: '0.88rem' }}>{step.title}</span>
                            </div>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                              {step.time}
                            </span>
                          </div>

                          <div className="step-detail" style={{ fontSize: '0.82rem' }}>{step.detail}</div>

                          {step.widgetType && renderMcpAppWidget(step.widgetType, step.widgetData)}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : isEditing ? (
                  /* Sub-view 3: Textarea Editor Mode */
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
                ) : (
                  /* Sub-view 4: Rendered Markdown or Empty State */
                  <div className="brief-body">
                    {buildVerificationText ? (
                      <div className="brief-markdown-render">
                        <MarkdownRenderer content={buildVerificationText} />
                      </div>
                    ) : (
                      <div className="brief-empty-markdown">
                        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                          Mid-task build & verification steps will appear here as the agent works. Click <strong>'Run Task'</strong> to begin.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════
                SECTION 3: COMPLETION
               ═══════════════════════════════════════════════════════════ */}
            <div className={`brief-card ${collapsedSections.completion ? 'is-collapsed' : ''}`}>
              <div
                className="brief-section-header clickable-header"
                onClick={() => toggleSection('completion')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedSections.completion ? 'is-collapsed' : ''}`}
                    title={collapsedSections.completion ? 'Expand section' : 'Collapse section'}
                    aria-label={collapsedSections.completion ? 'Expand section' : 'Collapse section'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSection('completion');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <span className="section-icon">
                      <Flag size={18} color="var(--accent-violet)" />
                    </span>
                    <span>Completion</span>
                  </span>
                  <span className="section-subtitle-tag">What Was Built & Current Status</span>
                </div>

                <div className="header-right">
                  {isWorking && !completionText ? (
                    <span className="card-item-tag-working">
                      <Loader2 size={11} className="spin-animate" />
                      <span>In progress</span>
                    </span>
                  ) : completionText ? (
                    <span className="card-item-count">{completionText.split('\n').filter(Boolean).length} lines</span>
                  ) : (
                    <span className="card-item-tag-empty">Pending completion</span>
                  )}
                </div>
              </div>

              <div className="brief-body-wrapper">
                {isEditing ? (
                  <textarea
                    ref={completionRef}
                    className="obsidian-card-textarea"
                    placeholder="Summarize what was built, where the task stands currently, verification results, and next steps..."
                    value={completionText}
                    onChange={(e) => handleFieldChange('completion', e.target.value)}
                    onKeyDown={(e) => handleMarkdownAutoWrap(e, (val) => handleFieldChange('completion', val))}
                    onFocus={() => setActiveFocusedRef(completionRef)}
                    rows={4}
                  />
                ) : isWorking && !completionText ? (
                  <div className="brief-body" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '1.25rem', color: 'var(--text-muted)', fontSize: '0.84rem' }}>
                    <Loader2 size={16} className="spin-animate" color="var(--accent-violet)" />
                    <span>Task execution in progress. Completion summary and verification records will appear here upon finish.</span>
                  </div>
                ) : (
                  <div className="brief-body">
                    {completionText ? (
                      <div className="brief-markdown-render">
                        <MarkdownRenderer content={completionText} />
                      </div>
                    ) : (
                      <div className="brief-empty-markdown">
                        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                          Completion summary and final verification will be recorded once the agent finishes execution.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface ArchivedAiTaskCardProps {
  task: TaskItem;
  brief?: AgentContextItem;
  onUnarchive: () => void;
  onDelete: () => void;
}

const ArchivedAiTaskCard: React.FC<ArchivedAiTaskCardProps> = ({
  task,
  brief,
  onUnarchive,
  onDelete,
}) => {
  const [isTaskCollapsed, setIsTaskCollapsed] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState({
    overview: false,
    build: false,
    completion: false,
  });

  const toggleSection = (section: 'overview' | 'build' | 'completion') => {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const overviewText = brief?.overview || brief?.brief || '';
  const buildText = brief?.buildAndVerification || brief?.built || '';
  const completionText = brief?.completion || brief?.validation || brief?.humanReview || brief?.followUps || '';

  return (
    <div className={`ai-task-card archived-ai-card ${isTaskCollapsed ? 'is-collapsed' : ''}`}>
      {/* ── Task Card Header ── */}
      <div
        className="ai-task-card-header"
        onClick={() => setIsTaskCollapsed((prev) => !prev)}
        style={{ cursor: 'pointer' }}
      >
        <div className="ai-task-header-left">
          <button
            type="button"
            className={`card-collapse-btn ${isTaskCollapsed ? 'is-collapsed' : ''}`}
            title={isTaskCollapsed ? 'Expand task context' : 'Collapse task context'}
            aria-label={isTaskCollapsed ? 'Expand task context' : 'Collapse task context'}
            onClick={(e) => {
              e.stopPropagation();
              setIsTaskCollapsed((prev) => !prev);
            }}
          >
            <ChevronDown size={14} className="collapse-chevron" />
          </button>
          <span
            className="ai-task-num-badge"
            style={{
              color: 'var(--accent-amber, #f59e0b)',
              background: 'rgba(245, 158, 11, 0.12)',
              borderColor: 'rgba(245, 158, 11, 0.28)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
            }}
            title="Archived Task"
          >
            <Archive size={11} />
            <span>Archived</span>
          </span>
          <span className="ai-task-title-text" title={task.title}>
            {task.title}
          </span>
          <span
            className="ai-task-status-badge is-done"
            style={{
              color: '#f59e0b',
              background: 'rgba(245, 158, 11, 0.12)',
              borderColor: 'rgba(245, 158, 11, 0.28)',
            }}
          >
            Archived
          </span>
        </div>

        <div
          className="ai-task-header-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="archived-task-actions">
            <button
              type="button"
              className="archived-action-btn unarchive-btn"
              title="Unarchive task"
              onClick={onUnarchive}
            >
              <RotateCcw size={12} />
              <span>Unarchive</span>
            </button>
            <button
              type="button"
              className="archived-action-btn delete-btn"
              title="Delete task permanently"
              onClick={onDelete}
            >
              <Trash2 size={12} />
              <span>Delete</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Task Card Body ── */}
      {!isTaskCollapsed && (
        <div className="ai-task-card-body">
          <div className="brief-container" style={{ padding: 0 }}>
            {/* SECTION 1: OVERVIEW */}
            <div className={`brief-card ${collapsedSections.overview ? 'is-collapsed' : ''}`}>
              <div
                className="brief-section-header clickable-header"
                onClick={() => toggleSection('overview')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedSections.overview ? 'is-collapsed' : ''}`}
                    title={collapsedSections.overview ? 'Expand section' : 'Collapse section'}
                    aria-label={collapsedSections.overview ? 'Expand section' : 'Collapse section'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSection('overview');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <span className="section-icon">
                      <ClipboardList size={18} color="var(--accent-violet)" />
                    </span>
                    <span>Overview</span>
                  </span>
                  <span className="section-subtitle-tag">Frontend Notes & Task in Context</span>
                </div>
              </div>
              <div className="brief-body-wrapper">
                <div className="brief-body" style={{ padding: '0.85rem 1rem' }}>
                  {overviewText ? (
                    <div className="brief-markdown-render">
                      <MarkdownRenderer content={overviewText} />
                    </div>
                  ) : (
                    <div className="empty-state" style={{ padding: '0.75rem 0', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.82rem' }}>
                      No overview notes recorded.
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* SECTION 2: BUILD & VERIFICATION */}
            <div className={`brief-card ${collapsedSections.build ? 'is-collapsed' : ''}`}>
              <div
                className="brief-section-header clickable-header"
                onClick={() => toggleSection('build')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedSections.build ? 'is-collapsed' : ''}`}
                    title={collapsedSections.build ? 'Expand section' : 'Collapse section'}
                    aria-label={collapsedSections.build ? 'Expand section' : 'Collapse section'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSection('build');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <span className="section-icon">
                      <Wrench size={18} color="var(--accent-cyan)" />
                    </span>
                    <span>Build & Verification</span>
                  </span>
                  <span className="section-subtitle-tag">Backend / Core Build Notes</span>
                </div>
              </div>
              <div className="brief-body-wrapper">
                <div className="brief-body" style={{ padding: '0.85rem 1rem' }}>
                  {buildText ? (
                    <div className="brief-markdown-render">
                      <MarkdownRenderer content={buildText} />
                    </div>
                  ) : (
                    <div className="empty-state" style={{ padding: '0.75rem 0', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.82rem' }}>
                      No build notes recorded.
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* SECTION 3: COMPLETION */}
            <div className={`brief-card ${collapsedSections.completion ? 'is-collapsed' : ''}`}>
              <div
                className="brief-section-header clickable-header"
                onClick={() => toggleSection('completion')}
              >
                <div className="header-left">
                  <button
                    type="button"
                    className={`card-collapse-btn ${collapsedSections.completion ? 'is-collapsed' : ''}`}
                    title={collapsedSections.completion ? 'Expand section' : 'Collapse section'}
                    aria-label={collapsedSections.completion ? 'Expand section' : 'Collapse section'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSection('completion');
                    }}
                  >
                    <ChevronDown size={12} className="collapse-chevron" />
                  </button>
                  <span className="section-title-text">
                    <span className="section-icon">
                      <Flag size={18} color="var(--accent-emerald)" />
                    </span>
                    <span>Completion</span>
                  </span>
                  <span className="section-subtitle-tag">What Was Built & Final Status</span>
                </div>
              </div>
              <div className="brief-body-wrapper">
                <div className="brief-body" style={{ padding: '0.85rem 1rem' }}>
                  {completionText ? (
                    <div className="brief-markdown-render">
                      <MarkdownRenderer content={completionText} />
                    </div>
                  ) : (
                    <div className="empty-state" style={{ padding: '0.75rem 0', color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.82rem' }}>
                      No completion notes recorded.
                    </div>
                  )}
                </div>
              </div>
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
  onPermissionChoice,
  onSessionExit,
  onRestartSession,
  onKillSession,
}) => {
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [taskToDelete, setTaskToDelete] = useState<TaskItem | null>(null);

  const activeTaskRunningCount = runningTaskIds.length;
  const doneCount = tasks.filter((t) => t.isDone || t.status === 'done').length;

  return (
    <div className="pane pane-right obsidian-pane">
      {/* ── Pane Header ── */}
      <div className="pane-header obsidian-header">
        <div className="pane-title">
          <FileCode size={17} color="var(--accent-violet)" />
          <span>AI Workspace</span>
          <span className="pane-subtitle">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} ({doneCount} done)
          </span>
          {activeTaskRunningCount > 0 && (
            <span className="task-status-pill status-working">
              <Loader2 size={12} className="spin-animate" />
              <span>{activeTaskRunningCount} running</span>
            </span>
          )}
        </div>
      </div>

      {/* ── Scrollable Multi-Task List ── */}
      <div className="pane-content obsidian-body brief-scrollable-workspace">
        {tasks.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: '300px' }}>
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
              <ListTodo size={48} color="var(--accent-violet)" style={{ opacity: 0.45, marginBottom: '1rem' }} />
              <h3 style={{ color: '#fff', fontSize: '1.15rem' }}>No tasks in workspace</h3>
              <p style={{ fontSize: '0.85rem', marginTop: '0.5rem', maxWidth: '420px', lineHeight: '1.6' }}>
                Add tasks in the Human Workspace using <strong>New Task</strong> or <strong>AI Assistant</strong>.
              </p>
            </div>
          </div>
        ) : (
          <div className="ai-tasks-list-container">
            {tasks.map((task, index) => {
              const taskBrief =
                briefs.find((b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase()) ||
                briefs.find((b) => b.itemNumber === task.id) ||
                briefs[index] ||
                undefined;
              const terminalSession = terminalSessions.find((s) => s.session.taskId === task.id) ?? null;
              const isTerminalRunning = !!terminalSession?.session.isActive;
              const isExecuting = executingTaskId === task.id;
              const isWorking = isTerminalRunning || isExecuting;
              const isSelected = selectedTaskId === task.id;

              return (
                <AiTaskCard
                  key={task.id}
                  task={task}
                  brief={taskBrief}
                  isSelected={isSelected}
                  isWorking={isWorking}
                  terminalSession={terminalSession}
                  isExecuting={isExecuting}
                  executionSteps={taskExecutionSteps[task.id] || []}
                  pendingPermission={pendingPermissions[task.id]?.prompt ?? null}
                  onSelect={() => onSelectTask?.(task.id)}
                  onSaveBrief={onSaveBrief}
                  onLiveBriefChange={onLiveBriefChange}
                  onExecuteTask={onExecuteTask}
                  onUpdateBriefWithAi={_onUpdateBriefWithAi}
                  onSyncOverviewWithTask={onSyncOverviewWithTask}
                  onPermissionChoice={(approved) => onPermissionChoice?.(task.id, approved)}
                  onSessionExit={(code) => onSessionExit?.(task.id, code)}
                  onRestartSession={onRestartSession}
                  onKillSession={onKillSession}
                />
              );
            })}
          </div>
        )}

        {/* ── Collapsible Archive Panel at bottom of scrollable workspace ── */}
        <div className="archive-collapsible-panel ai-archive-panel">
          <button
            type="button"
            className={`archive-panel-header ${isArchiveOpen ? 'open' : ''}`}
            onClick={() => setIsArchiveOpen((prev) => !prev)}
            title={isArchiveOpen ? 'Collapse archive panel' : 'Expand archive panel'}
          >
            <div className="archive-panel-header-left">
              <Archive size={15} className="archive-icon" />
              <span className="archive-panel-title">Archive Contexts</span>
              <span className="archive-count-badge">
                {archivedTasks.length} {archivedTasks.length === 1 ? 'task' : 'tasks'}
              </span>
            </div>
            <ChevronDown size={15} className={`archive-chevron ${isArchiveOpen ? 'open' : ''}`} />
          </button>

          {isArchiveOpen && (
            <div className="archive-panel-content">
              {archivedTasks.length === 0 ? (
                <div className="archive-empty-state">
                  <span>No archived task contexts</span>
                </div>
              ) : (
                <div className="ai-tasks-list-container archived-ai-tasks">
                  {archivedTasks.map((task, index) => {
                    const taskBrief =
                      archivedBriefs.find((b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase()) ||
                      archivedBriefs[index] ||
                      briefs.find((b) => b.title.trim().toLowerCase() === task.title.trim().toLowerCase()) ||
                      undefined;

                    return (
                      <ArchivedAiTaskCard
                        key={task.id}
                        task={task}
                        brief={taskBrief}
                        onUnarchive={() => onUnarchiveTask?.(task.id)}
                        onDelete={() => setTaskToDelete(task)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Task Permanent Deletion Context Warning Modal ── */}
      {taskToDelete && (
        <div className="modal-overlay" onClick={() => setTaskToDelete(null)}>
          <div className="modal-card archive-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-rose)' }}>
                <AlertTriangle size={18} />
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Delete Task Permanently?</h3>
              </div>
              <button type="button" className="btn-icon" onClick={() => setTaskToDelete(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: '1rem 1.25rem', fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
              <p style={{ margin: 0, marginBottom: '0.75rem' }}>
                Are you sure you want to permanently delete <strong>"{taskToDelete.title}"</strong>?
              </p>
              <div className="archive-delete-warning-box">
                <AlertCircle size={15} style={{ flexShrink: 0, color: 'var(--accent-rose)' }} />
                <span>If you proceed with deleting this task, the AI will lose context for it.</span>
              </div>
            </div>
            <div className="modal-footer" style={{ padding: '0.75rem 1.25rem', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setTaskToDelete(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                style={{ background: 'var(--accent-rose)', color: '#fff' }}
                onClick={() => {
                  onDeleteArchivedTask?.(taskToDelete.id);
                  setTaskToDelete(null);
                }}
              >
                Delete Task
              </button>
            </div>
          </div>
        </div>
      )}
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
          Executed command: <strong style={{ color: '#fff', fontFamily: 'var(--font-mono)' }}>{data.commandExecuted}</strong> | Range: {data.selectionRange || 'L1-L30'}
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
      <div style={{ fontWeight: 700, fontSize: '0.82rem', color: '#fff', marginBottom: '0.4rem' }}>
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
