import React, { useState, useEffect, useMemo } from 'react';
import {
  type ProjectData,
  type AIProviderConfig,
  type MCPServer,
  type HumanAiIntent,
  type HumanAiAssistantResult
} from '../types';
import { runHumanAiAssistant } from '../lib/ai';
import { handleMarkdownAutoWrap } from '../lib/markdownEditorUtils';
import { MarkdownRenderer } from './MarkdownRenderer';
import { storageManager, DEFAULT_HUMAN_ASSISTANT_SKILL } from '../lib/storageManager';
import { SUPPORTED_AI_PROVIDERS } from '../lib/aiProviders';
import {
  Sparkles,
  X,
  Check,
  Loader2,
  FileCode,
  AlertTriangle,
  Copy,
  CheckCheck,
  Save,
  BookOpen,
  Layers,
  CheckSquare
} from 'lucide-react';

interface HumanAiAssistantModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: ProjectData;
  todoMarkdown: string;
  agentContextMarkdown: string;
  aiConfig: AIProviderConfig;
  mcpServers: MCPServer[];
  onApplyAssistantResult: (
    result: HumanAiAssistantResult,
    confirmedDeletions: boolean
  ) => void;
  onHeightChange?: (height: number) => void;
}

const INTENT_TABS: Array<{ id: HumanAiIntent; label: string; badge?: string; icon: any; placeholder: string; desc: string }> = [
  {
    id: 'task',
    label: 'Task',
    badge: 'Single-Task',
    icon: CheckSquare,
    desc: 'e.g., Set up user authentication with OAuth and session tokens...',
    placeholder: 'Create or modify a single task/subtasks — either the currently selected task, or a specific task you call out.'
  },
  {
    id: 'architect',
    label: 'Architect',
    badge: 'Multi-Task',
    icon: Layers,
    desc: 'e.g., Architect a complete billing system with Stripe integration, webhook routing, tiered plans, and invoice generation...',
    placeholder: 'Create or modify numerous tasks. Treats all instructions as more general, high-level roadmaps.'
  }
];

export const HumanAiAssistantModal: React.FC<HumanAiAssistantModalProps> = ({
  isOpen,
  onClose,
  project,
  todoMarkdown,
  agentContextMarkdown,
  aiConfig,
  mcpServers,
  onApplyAssistantResult,
  onHeightChange
}) => {
  const [intent, setIntent] = useState<HumanAiIntent>('task');
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [assistantResult, setAssistantResult] = useState<HumanAiAssistantResult | null>(null);

  // Skill doc customization state
  const [showSkillDoc, setShowSkillDoc] = useState(false);
  const [skillDocContent, setSkillDocContent] = useState<string>(DEFAULT_HUMAN_ASSISTANT_SKILL);
  const [isSavingSkill, setIsSavingSkill] = useState(false);
  const [skillSaveSuccess, setSkillSaveSuccess] = useState(false);

  // Deletion confirmation permission state
  const [confirmDeletions, setConfirmDeletions] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  // Model Name Resolvers

  const activeTaskModelName = useMemo(() => {
    const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === aiConfig.provider);
    const rawModel = aiConfig.generalModel || aiConfig.model || pMeta?.defaultGeneralModel || 'Task Model';
    const foundModel = pMeta?.models.find((m) => m.id === rawModel);
    return foundModel?.name || rawModel;
  }, [aiConfig]);

  // Load Skill Doc on open
  useEffect(() => {
    if (isOpen) {
      storageManager.loadSkillDoc('human-assistant').then((content) => {
        if (content && !content.includes('Strict JSON Output Schema') && !content.includes('createdTasks')) {
          setSkillDocContent(content);
        } else {
          setSkillDocContent(DEFAULT_HUMAN_ASSISTANT_SKILL);
          storageManager.saveSkillDoc('human-assistant', DEFAULT_HUMAN_ASSISTANT_SKILL);
        }
      });
      setConfirmDeletions(false);
    }
  }, [isOpen]);

  // Flatten available tools from connected MCP servers configured in global MCP page
  const connectedServers = useMemo(() => {
    return mcpServers.filter((m) => m.status === 'connected');
  }, [mcpServers]);

  // Resizing state - default depth reduced by 30% (285 -> 200)
  const [drawerHeight, setDrawerHeight] = useState<number>(220);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (onHeightChange) {
      onHeightChange(isOpen ? drawerHeight : 0);
    }
  }, [isOpen, drawerHeight, onHeightChange]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Calculate new height from bottom of window / task pane
      // The drawer sits at the bottom of the container
      const newHeight = window.innerHeight - e.clientY - 53; // 53px is task footer height
      const minHeight = 120;
      const maxHeight = window.innerHeight * 0.9;
      setDrawerHeight(Math.max(minHeight, Math.min(newHeight, maxHeight)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  if (!isOpen) return null;

  const handleSaveSkill = async () => {
    setIsSavingSkill(true);
    await storageManager.saveSkillDoc('human-assistant', skillDocContent);
    setIsSavingSkill(false);
    setSkillSaveSuccess(true);
    setTimeout(() => setSkillSaveSuccess(false), 2000);
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsLoading(true);
    setAssistantResult(null);
    setConfirmDeletions(false);

    try {
      const res = await runHumanAiAssistant(
        prompt,
        intent,
        todoMarkdown,
        agentContextMarkdown,
        project,
        aiConfig,
        connectedServers,
        skillDocContent || null
      );

      setAssistantResult(res);
    } catch (err) {
      console.error('Failed to run Human AI Assistant:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleApply = () => {
    if (assistantResult) {
      onApplyAssistantResult(assistantResult, confirmDeletions);
      setAssistantResult(null);
      setPrompt('');
      onClose();
    }
  };

  const handleCopyReport = () => {
    if (assistantResult?.aggregatedReport) {
      navigator.clipboard.writeText(assistantResult.aggregatedReport);
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 2000);
    }
  };

  const currentTab = INTENT_TABS.find((t) => t.id === intent) || INTENT_TABS[0];

  return (
    <div className={`human-assistant-drawer-container ${isOpen ? 'is-open' : ''}`}>
      {/* Slide-up drawer panel */}
      <div
        className="human-assistant-drawer-panel"
        style={{ height: `${drawerHeight}px`, maxHeight: '90%' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Resize Handle on Top Edge */}
        <div
          className={`human-assistant-resize-handle ${isDragging ? 'is-dragging' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          title="Drag up or down to resize"
        />

        {/* Drawer Header / Bar */}
        <div className="human-assistant-drawer-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flex: 1, minWidth: 0 }}>
            <div
              style={{
                width: '26px',
                height: '26px',
                borderRadius: '6px',
                background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-violet))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <Sparkles size={15} color="#fff" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: '#fff' }}>Task Assistant</h3>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              className="btn btn-primary"
              onClick={handleGenerate}
              disabled={isLoading || !prompt.trim()}
              style={{ padding: '0.25rem 0.65rem', fontSize: '0.75rem', gap: '0.35rem' }}
              title="Run AI Assistant (Ctrl+Enter)"
            >
              {isLoading ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  <span>Processing ({activeTaskModelName})...</span>
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  <span>Run Assistant</span>
                </>
              )}
            </button>
            <button
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.45rem', fontSize: '0.75rem' }}
              onClick={onClose}
              title="Close Assistant"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Drawer Body */}
        <div className="human-assistant-drawer-body">
          {/* Collapsible Skill Doc Viewer / Editor */}
          {showSkillDoc && (
            <div
              style={{
                background: 'var(--bg-darkest)',
                border: '1px solid var(--accent-primary)',
                borderRadius: 'var(--radius-md)',
                padding: '0.85rem',
                marginBottom: '1rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.45rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <FileCode size={15} color="var(--accent-primary)" />
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#fff' }}>
                    Skill Instructions (<code style={{ color: 'var(--accent-cyan)' }}>.ergo/config/skills/human-assistant/SKILL.md</code>)
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem', gap: '0.3rem' }}
                  onClick={handleSaveSkill}
                  disabled={isSavingSkill}
                >
                  {skillSaveSuccess ? <CheckCheck size={12} color="var(--accent-emerald)" /> : <Save size={12} />}
                  <span>{skillSaveSuccess ? 'Saved!' : isSavingSkill ? 'Saving...' : 'Save Skill Doc'}</span>
                </button>
              </div>
              <textarea
                className="textarea-text"
                rows={5}
                style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono)' }}
                value={skillDocContent}
                onChange={(e) => setSkillDocContent(e.target.value)}
                placeholder="Skill instructions..."
              />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
                💡 Any edits saved here immediately dictate how the Discovery AI behaves and parses your workspace requests.
              </div>
            </div>
          )}

          {/* Mode Selection Tabs (Task vs Architect) */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.65rem' }}>
            {INTENT_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = intent === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setIntent(tab.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    padding: '0.35rem 0.75rem',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                    background: isActive ? 'rgba(99, 102, 241, 0.18)' : 'var(--bg-card)',
                    color: isActive ? '#fff' : 'var(--text-muted)',
                    fontWeight: isActive ? 600 : 500,
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Icon size={14} color={isActive ? 'var(--accent-cyan)' : 'currentColor'} />
                  <span>{tab.label}</span>
                  {tab.badge && (
                    <span
                      style={{
                        fontSize: '0.65rem',
                        fontWeight: 600,
                        padding: '0.1rem 0.35rem',
                        borderRadius: '4px',
                        background: isActive ? 'rgba(99, 102, 241, 0.3)' : 'rgba(255, 255, 255, 0.05)',
                        color: isActive ? '#c7d2fe' : 'var(--text-dim)'
                      }}
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.65rem' }}>
            {currentTab.desc}
          </div> */}

          {/* Prompt Textarea */}
          <div className="input-group" style={{ marginBottom: '0.75rem' }}>
            <textarea
              className="textarea-text"
              rows={3}
              placeholder={currentTab.placeholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleGenerate();
                } else {
                  handleMarkdownAutoWrap(e, setPrompt);
                }
              }}
            />
          </div>



          {/* Results Preview */}
          {assistantResult && (
            <div style={{ background: 'var(--bg-darkest)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-md)', padding: '1rem', marginTop: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.65rem' }}>
                <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--accent-cyan)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
                  <Check size={15} />
                  <span>Assistant Plan & Preview</span>
                </h4>
                {assistantResult.summary && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {assistantResult.summary}
                  </span>
                )}
              </div>

              {/* 1. Aggregated Report Section */}
              {assistantResult.aggregatedReport && (
                <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '0.85rem', marginBottom: '0.85rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.45rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.35rem' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff' }}>📊 Summary Report</span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ padding: '0.2rem 0.45rem', fontSize: '0.7rem', gap: '0.25rem' }}
                      onClick={handleCopyReport}
                    >
                      {copiedReport ? <CheckCheck size={11} color="var(--accent-emerald)" /> : <Copy size={11} />}
                      <span>{copiedReport ? 'Copied!' : 'Copy Markdown'}</span>
                    </button>
                  </div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-normal)', maxHeight: '200px', overflowY: 'auto' }}>
                    <MarkdownRenderer content={assistantResult.aggregatedReport} />
                  </div>
                </div>
              )}

              {/* 2. Markdown Changes Preview */}
              {!assistantResult.aggregatedReport && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginBottom: '0.85rem' }}>

                  {assistantResult.todoMarkdown && (
                    <div style={{ background: 'var(--bg-card)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: 'var(--radius-sm)', padding: '0.65rem' }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-emerald)', marginBottom: '0.4rem' }}>
                        Proposed TODO.md Changes
                      </div>
                      <pre style={{ margin: 0, padding: '0.45rem', background: 'var(--bg-darkest)', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--text-normal)', maxHeight: '180px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                        {assistantResult.todoMarkdown}
                      </pre>
                    </div>
                  )}

                  {assistantResult.agentContextMarkdown && (
                    <div style={{ background: 'var(--bg-card)', border: '1px solid rgba(6, 182, 212, 0.3)', borderRadius: 'var(--radius-sm)', padding: '0.65rem' }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-cyan)', marginBottom: '0.4rem' }}>
                        Proposed AGENT_CONTEXT.md Changes
                      </div>
                      <pre style={{ margin: 0, padding: '0.45rem', background: 'var(--bg-darkest)', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--text-normal)', maxHeight: '180px', overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                        {assistantResult.agentContextMarkdown}
                      </pre>
                    </div>
                  )}

                </div>
              )}

              {/* 3. Mandatory Deletion Confirmation Prompt */}
              {assistantResult.requiresDeletionApproval && (
                <div
                  style={{
                    background: 'rgba(239, 68, 68, 0.08)',
                    border: '1px solid rgba(239, 68, 68, 0.4)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.8rem 0.85rem',
                    marginBottom: '0.85rem'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: '#f87171', fontWeight: 700, fontSize: '0.82rem', marginBottom: '0.35rem' }}>
                    <AlertTriangle size={16} />
                    <span>Permission Required for Deletions</span>
                  </div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                    The AI has proposed deleting tasks. Please confirm before applying.
                    {assistantResult.deletionReason && (
                      <div style={{ marginTop: '0.4rem', fontSize: '0.76rem', color: 'var(--text-normal)', background: 'rgba(0,0,0,0.2)', padding: '0.4rem', borderRadius: '4px' }}>
                        <strong>Reason:</strong> {assistantResult.deletionReason}
                      </div>
                    )}
                  </div>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.45rem',
                      cursor: 'pointer',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      color: confirmDeletions ? '#f87171' : 'var(--text-normal)',
                      background: 'rgba(239, 68, 68, 0.1)',
                      padding: '0.35rem 0.55rem',
                      borderRadius: 'var(--radius-sm)',
                      width: 'fit-content'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={confirmDeletions}
                      onChange={(e) => setConfirmDeletions(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span>I confirm and authorize the deletion of these tasks.</span>
                  </label>
                  {!confirmDeletions && (
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
                      ℹ️ Check this box to proceed with deletions.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Drawer Action Bar / Footer */}
        <div className="human-assistant-drawer-footer">
          {/* <button className="btn btn-secondary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }} onClick={onClose}>
            Close
          </button> */}
          {assistantResult && (
            <button
              className="btn btn-emerald"
              style={{ padding: '0.35rem 0.85rem', fontSize: '0.8rem' }}
              disabled={assistantResult.requiresDeletionApproval && !confirmDeletions}
              onClick={handleApply}
            >
              <Check size={15} />
              <span>
                {assistantResult.requiresDeletionApproval
                  ? confirmDeletions
                    ? 'Approve & Apply All Changes'
                    : 'Must Approve Deletions First'
                  : 'Apply Changes'}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
