import React, { useState, useEffect, useRef } from 'react';
import { type TaskItem, type AgentContextItem } from '../types';
import type { SpawnedSession } from './AgentTerminalPane';
import {
  FileCode,
  Edit3,
  Save,
  Sparkles,
  Play,
  CheckCircle2,
  Clock,
  CircleDot,
  CheckCheck,
  Terminal,
} from 'lucide-react';

import { RichTextToolbar } from './RichTextToolbar';
import { MarkdownRenderer } from './MarkdownRenderer';

interface BriefPaneProps {
  activeTask: TaskItem | null;
  activeBrief: AgentContextItem | undefined;
  onSaveBrief: (updatedBrief: AgentContextItem) => void;
  onLiveBriefChange?: (updatedBrief: AgentContextItem) => void;
  onExecuteTask: (task: TaskItem) => void;
  onUpdateBriefWithAi: (task: TaskItem) => void;
  autosaveStatus?: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  autosaveDelaySec?: number;
  /** Non-null when a terminal session exists for the currently active task */
  terminalSessionForTask?: SpawnedSession | null;
  /** Toggle the terminal pane for this task */
  onToggleTerminal?: () => void;
}


export const BriefPane: React.FC<BriefPaneProps> = ({
  activeTask,
  activeBrief,
  onSaveBrief,
  onLiveBriefChange,
  onExecuteTask,
  onUpdateBriefWithAi,
  terminalSessionForTask,
  onToggleTerminal,
}) => {

  const [isEditing, setIsEditing] = useState(false);
  const [humanReviewText, setHumanReviewText] = useState('');
  const [briefText, setBriefText] = useState('');
  const [builtText, setBuiltText] = useState('');
  const [validationText, setValidationText] = useState('');

  const humanReviewRef = useRef<HTMLTextAreaElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const builtRef = useRef<HTMLTextAreaElement>(null);
  const validationRef = useRef<HTMLTextAreaElement>(null);

  const [activeFocusedRef, setActiveFocusedRef] = useState<React.RefObject<HTMLTextAreaElement | null> | null>(null);

  // Sync the form fields with the active brief whenever activeTask or activeBrief changes
  useEffect(() => {
    if (activeBrief) {
      const reviewVal = activeBrief.humanReview || activeBrief.followUps || '';
      setHumanReviewText(reviewVal);
      setBriefText(activeBrief.brief || '');
      setBuiltText(activeBrief.built || '');
      setValidationText(activeBrief.validation || '');
    } else {
      setHumanReviewText('');
      setBriefText('');
      setBuiltText('');
      setValidationText('');
    }
    setIsEditing(false);
  }, [activeTask?.id, activeBrief]);

  if (!activeTask) {
    return (
      <div className="pane pane-right obsidian-pane">
        <div className="pane-header obsidian-header">
          <div className="pane-title">
            <FileCode size={17} color="var(--accent-violet)" />
            <span>AI Workspace</span>
          </div>
        </div>
        <div className="pane-content obsidian-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
            <FileCode size={48} color="var(--accent-violet)" style={{ opacity: 0.5, marginBottom: '1rem' }} />
            <h3 style={{ color: '#fff', fontSize: '1.15rem' }}>Select a task item to inspect</h3>
            <p style={{ fontSize: '0.85rem', marginTop: '0.5rem', maxWidth: '420px', lineHeight: '1.6' }}>
              Click any task card in TODO.md to view its technical brief, built record, validation notes, and human review items.
            </p>
          </div>
        </div>
        {/* <div className="task-pane-footer brief-pane-footer">
          <button
            type="button"
            className="refine-ai-btn"
            disabled
          >
            <Sparkles size={16} />
            <span>Refine AI</span>
          </button>
          <button
            type="button"
            className="execute-task-btn"
            disabled
          >
            <Play size={20} />
            <span>Execute Task</span>
          </button>
        </div> */}
      </div>
    );
  }

  const isExecuted = activeTask.isDone || activeTask.status === 'done';

  const handleFieldChange = (
    field: 'humanReview' | 'brief' | 'built' | 'validation',
    value: string
  ) => {
    if (!activeTask) return;
    let newReview = humanReviewText;
    let newBrief = briefText;
    let newBuilt = builtText;
    let newValidation = validationText;

    if (field === 'humanReview') {
      setHumanReviewText(value);
      newReview = value;
    } else if (field === 'brief') {
      setBriefText(value);
      newBrief = value;
    } else if (field === 'built') {
      setBuiltText(value);
      newBuilt = value;
    } else if (field === 'validation') {
      setValidationText(value);
      newValidation = value;
    }

    if (onLiveBriefChange) {
      onLiveBriefChange({
        itemNumber: activeTask.id,
        title: activeTask.title,
        status: activeTask.status,
        humanReview: newReview,
        followUps: newReview,
        brief: newBrief,
        built: newBuilt,
        validation: newValidation,
      });
    }
  };

  const handleSave = () => {
    if (!activeTask) return;
    onSaveBrief({
      itemNumber: activeTask.id,
      title: activeTask.title,
      status: activeTask.status,
      humanReview: humanReviewText,
      followUps: humanReviewText,
      brief: briefText,
      built: builtText,
      validation: validationText
    });
    setIsEditing(false);
  };

  const renderStatusBadge = () => {
    if (activeTask.isDone || activeTask.status === 'done') {
      return (
        <span className="task-status-pill status-done">
          <CheckCircle2 size={12} />
          <span>Done</span>
        </span>
      );
    }
    if (activeTask.status === 'in_progress') {
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
    <div className="pane pane-right obsidian-pane">
      {/* ── Pane Header ── */}
      <div className="pane-header obsidian-header">
        <div className="pane-title">
          <FileCode size={17} color="var(--accent-violet)" />
          <span>AI Workspace</span>
          <span className="pane-subtitle">
            Item #{activeTask.id}
          </span>
          {renderStatusBadge()}
        </div>

        <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
          {isEditing ? (
            <button
              className="btn btn-primary"
              style={{ padding: '0.3rem 0.65rem', fontSize: '0.8rem' }}
              onClick={handleSave}
            >
              <Save size={13} />
              <span>Save</span>
            </button>
          ) : (
            <button
              className="btn btn-secondary"
              style={{ padding: '0.3rem 0.65rem', fontSize: '0.8rem' }}
              onClick={() => setIsEditing(true)}
            >
              <Edit3 size={13} />
              <span>Edit</span>
            </button>
          )}
        </div>
      </div>

      {/* ── Rich Text Formatting Toolbar in Edit Mode ── */}
      {isEditing && (
        <div className="obsidian-toolbar-row">
          <RichTextToolbar
            targetRef={activeFocusedRef || briefRef}
            compact={true}
          />
        </div>
      )}

      {/* ── Pane Body ── */}
      <div className="pane-content obsidian-body">
        <div className="brief-container">

          {/* ═══════════════════════════════════════════════════════════
              SECTION 1: HUMAN REVIEW (Renamed from Follow-ups & Moved to Top)
              Only visible AFTER task execution
             ═══════════════════════════════════════════════════════════ */}
          {isExecuted && (
            <div className="brief-card card-human-review">
              <div className="brief-section-header">
                <div className="header-left">
                  <span className="section-title-text">
                    <span className="section-emoji">👤</span> Human Review
                  </span>
                  <span className="section-subtitle-tag">AI Follow-up & Action Items</span>
                </div>

                <div className="header-right">
                  <span className="human-review-badge">
                    <CheckCheck size={12} />
                    <span>Post-Execution</span>
                  </span>
                </div>
              </div>

              <div className="brief-body-wrapper">
                {isEditing ? (
                  <textarea
                    ref={humanReviewRef}
                    className="obsidian-card-textarea"
                    placeholder="Add follow-up checks, human verification steps, and sign-off notes in Markdown..."
                    value={humanReviewText}
                    onChange={(e) => handleFieldChange('humanReview', e.target.value)}
                    onFocus={() => setActiveFocusedRef(humanReviewRef)}
                    rows={4}
                  />
                ) : (
                  <div className="brief-body">
                    {humanReviewText ? (
                      <div className="brief-markdown-render">
                        <MarkdownRenderer content={humanReviewText} />
                      </div>
                    ) : (
                      <div className="brief-empty-markdown">
                        <p>
                          <em>All automated verification completed. Please review changes and verify expected behavior in your environment.</em>
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════
              SECTION 2: BRIEF (Done-State, Target Seams, Constraints)
             ═══════════════════════════════════════════════════════════ */}
          <div className="brief-card">
            <div className="brief-section-header">
              <div className="header-left">
                <span className="section-title-text">
                  <span className="section-emoji">📋</span> Overview
                </span>
                <span className="section-subtitle-tag">Done-State, Target Seams, Constraints</span>
              </div>

              <div className="header-right">
                {briefText ? (
                  <span className="card-item-count">{briefText.split('\n').filter(Boolean).length} lines</span>
                ) : (
                  <span className="card-item-tag-empty">Empty</span>
                )}
              </div>
            </div>

            <div className="brief-body-wrapper">
              {isEditing ? (
                <textarea
                  ref={briefRef}
                  className="obsidian-card-textarea"
                  placeholder="Write detailed brief, done-state goals, code seams, and quality constraints in Markdown..."
                  value={briefText}
                  onChange={(e) => handleFieldChange('brief', e.target.value)}
                  onFocus={() => setActiveFocusedRef(briefRef)}
                  rows={6}
                />
              ) : (
                <div className="brief-body">
                  {briefText ? (
                    <div className="brief-markdown-render">
                      <MarkdownRenderer content={briefText} />
                    </div>
                  ) : (
                    <div className="brief-empty-markdown">
                      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        No detailed brief defined yet. Click <strong>'Refine AI'</strong> to draft one.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ═══════════════════════════════════════════════════════════
              SECTION 3: BUILT (Implementation Log & Decisions Made)
             ═══════════════════════════════════════════════════════════ */}
          <div className="brief-card">
            <div className="brief-section-header">
              <div className="header-left">
                <span className="section-title-text">
                  <span className="section-emoji">🛠️</span> Build & Verification
                </span>
                <span className="section-subtitle-tag">Implementation Log & Decisions Made</span>
              </div>

              <div className="header-right">
                {terminalSessionForTask ? (
                  // Show 'View Terminal' button when a session exists for this task
                  <button
                    className="btn btn-secondary"
                    style={{
                      padding: '0.2rem 0.55rem',
                      fontSize: '0.75rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      border: terminalSessionForTask.session.isActive
                        ? '1px solid rgba(16,185,129,0.4)'
                        : '1px solid var(--border-subtle)',
                    }}
                    onClick={onToggleTerminal}
                    title="Toggle agent terminal for this task"
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: terminalSessionForTask.session.isActive
                          ? 'var(--accent-emerald)'
                          : 'var(--text-dim)',
                        display: 'inline-block',
                        flexShrink: 0,
                      }}
                    />
                    <Terminal size={11} />
                    <span>
                      {terminalSessionForTask.session.isActive ? 'Running' : 'View Terminal'}
                    </span>
                  </button>
                ) : builtText ? (
                  <span className="card-item-count">{builtText.split('\n').filter(Boolean).length} lines</span>
                ) : (
                  <span className="card-item-tag-empty">Not executed</span>
                )}
              </div>

            </div>

            <div className="brief-body-wrapper">
              {isEditing ? (
                <textarea
                  ref={builtRef}
                  className="obsidian-card-textarea"
                  placeholder="Log architectural decisions, changed files, and implementation details in Markdown..."
                  value={builtText}
                  onChange={(e) => handleFieldChange('built', e.target.value)}
                  onFocus={() => setActiveFocusedRef(builtRef)}
                  rows={5}
                />
              ) : (
                <div className="brief-body">
                  {builtText ? (
                    <div className="brief-markdown-render">
                      <MarkdownRenderer content={builtText} />
                    </div>
                  ) : (
                    <div className="brief-empty-markdown">
                      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        Not executed yet. Click <strong>'Execute Task'</strong> to perform execution and populate build records.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ═══════════════════════════════════════════════════════════
              SECTION 4: VERIFICATION (Automated & Manual Test Output)
             ═══════════════════════════════════════════════════════════ */}
          <div className="brief-card">
            <div className="brief-section-header">
              <div className="header-left">
                <span className="section-title-text">
                  <span className="section-emoji">🧪</span> Completion
                </span>
                <span className="section-subtitle-tag">Automated & Manual Test Output</span>
              </div>

              <div className="header-right">
                {validationText ? (
                  <span className="card-item-count">{validationText.split('\n').filter(Boolean).length} lines</span>
                ) : (
                  <span className="card-item-tag-empty">Pending checks</span>
                )}
              </div>
            </div>

            <div className="brief-body-wrapper">
              {isEditing ? (
                <textarea
                  ref={validationRef}
                  className="obsidian-card-textarea"
                  placeholder="Document test runs, verification steps, and browser checks in Markdown..."
                  value={validationText}
                  onChange={(e) => handleFieldChange('validation', e.target.value)}
                  onFocus={() => setActiveFocusedRef(validationRef)}
                  rows={4}
                />
              ) : (
                <div className="brief-body">
                  {validationText ? (
                    <div className="brief-markdown-render">
                      <MarkdownRenderer content={validationText} />
                    </div>
                  ) : (
                    <div className="brief-empty-markdown">
                      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        Verification notes will record passing unit checks upon task execution.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ── Fixed Footer at Bottom of Screen ── */}
      <div className="task-pane-footer brief-pane-footer">
        <button
          type="button"
          className="refine-ai-btn"
          onClick={() => onUpdateBriefWithAi(activeTask)}
          title="Refine technical brief using AI context"
        >
          <Sparkles size={16} />
          <span>Refine</span>
        </button>
        <button
          type="button"
          className="execute-task-btn"
          onClick={() => onExecuteTask(activeTask)}
          title="Execute task in sandbox and generate build records"
        >
          <Play size={20} />
          <span>Execute Task</span>
        </button>
      </div>
    </div>
  );
};
