import React, { useState, useEffect, useMemo, useRef } from 'react';
import { stripAnchors } from '../lib/taskAnchors';
import {
  type ProjectData,
  type AIProviderConfig,
  type MCPServer,
  type MCPTool,
  type HumanAiIntent,
  type HumanAiAssistantResult
} from '../types';
import { runHumanAiAssistant } from '../lib/ai';
import { handleMarkdownAutoWrap } from '../lib/markdownEditorUtils';
import { MarkdownRenderer } from './MarkdownRenderer';
import { storageManager, DEFAULT_HUMAN_ASSISTANT_SKILL } from '../lib/storageManager';
import { SUPPORTED_AI_PROVIDERS } from '../lib/aiProviders';
import { guessRelevantToolsWithDetails, checkAllMcpUpdates } from '../lib/mcpClient';
import { MOD, ENTER, isMod } from '../lib/shortcuts';
import { TaskMcpToolsModal } from './TaskMcpToolsModal';
import { Check, Copy, Loader2, Plus, RefreshCw, RotateCcw, Wrench } from 'lucide-react';
import { Banner, Button, Checkbox, Dialog, Icon, SegmentedControl } from './ui';

interface HumanAiAssistantModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: ProjectData;
  todoMarkdown: string;
  aiConfig: AIProviderConfig;
  mcpServers: MCPServer[];
  onApplyAssistantResult: (
    result: HumanAiAssistantResult,
    confirmedDeletions: boolean
  ) => void;
  /** Kept for the old slide-up drawer: the dialog floats, so it always reports 0. */
  onHeightChange?: (height: number) => void;
}

const INTENTS: Array<{ id: HumanAiIntent; label: string; title: string; placeholder: string }> = [
  {
    id: 'task',
    label: 'One task',
    title: 'Create or change a single task and its subtasks',
    placeholder: 'Describe a task to add or change — the selected task, or one you name.'
  },
  {
    id: 'architect',
    label: 'Several tasks',
    title: 'Plan many tasks from a high-level roadmap',
    placeholder: 'Describe a larger piece of work. Ergo breaks it into several tasks.'
  }
];

// ── Draft review: the assistant returns a whole new TODO.md; the checklist lines it adds become proposals. ──

const CHECK_LINE = /^(\s*)([-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$/;
const HEADING_LINE = /^#{1,6}\s+(.*)$/;

interface DraftItem {
  /** Index of the line in the proposed markdown. */
  line: number;
  indent: number;
  /** Everything before the title: indent, marker and checkbox. */
  prefix: string;
  title: string;
  /** One line of context: where the task goes. */
  where: string;
}

interface Draft {
  lines: string[];
  isNew: boolean[];
  items: DraftItem[];
  /** Lines of the current TODO.md the proposal no longer has. */
  removed: number;
}

function buildDraft(current: string, proposed: string): Draft {
  const counts = new Map<string, number>();
  for (const l of current.split('\n')) {
    const k = l.trim();
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const lines = proposed.split('\n');
  const isNew: boolean[] = [];
  const items: DraftItem[] = [];
  const parents: Array<{ indent: number; title: string }> = [];
  let heading: string | null = null;
  lines.forEach((l, i) => {
    const k = l.trim();
    const left = counts.get(k) ?? 0;
    if (k && left > 0) {
      counts.set(k, left - 1);
      isNew[i] = false;
    } else {
      isNew[i] = !!k;
    }
    const h = HEADING_LINE.exec(k);
    if (h) {
      heading = h[1];
      parents.length = 0;
    }
    const m = CHECK_LINE.exec(l);
    if (!m) return;
    const indent = m[1].length;
    while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
    const parent = parents[parents.length - 1];
    if (isNew[i]) {
      items.push({
        line: i,
        indent,
        prefix: l.slice(0, l.length - m[4].length),
        title: m[4],
        where: parent ? `Subtask of “${parent.title}”` : heading ? `Under ${heading}` : 'At the top of TODO.md'
      });
    }
    parents.push({ indent, title: m[4] });
  });
  let removed = 0;
  counts.forEach((n) => (removed += n));
  return { lines, isNew, items, removed };
}

/** Lines left out: each unchecked task plus the new lines nested under it. */
function droppedLines(draft: Draft, rejected: Set<number>): Set<number> {
  const drop = new Set<number>();
  for (const it of draft.items) {
    if (!rejected.has(it.line)) continue;
    drop.add(it.line);
    for (let j = it.line + 1; j < draft.lines.length; j++) {
      const l = draft.lines[j];
      if (!l.trim() || (l.match(/^\s*/)?.[0].length ?? 0) <= it.indent || !draft.isNew[j]) break;
      drop.add(j);
    }
  }
  return drop;
}

/** The proposed markdown with unchecked tasks (and the new lines nested under them) left out and edits applied. */
function draftToMarkdown(draft: Draft, rejected: Set<number>, edits: Map<number, string>): string {
  const drop = droppedLines(draft, rejected);
  const byLine = new Map(draft.items.map((it) => [it.line, it]));
  return draft.lines
    .map((l, i) => {
      const it = byLine.get(i);
      const edit = edits.get(i);
      return it && edit !== undefined ? it.prefix + edit : l;
    })
    .filter((_, i) => !drop.has(i))
    .join('\n');
}

export const HumanAiAssistantModal: React.FC<HumanAiAssistantModalProps> = ({
  isOpen,
  onClose,
  project,
  todoMarkdown,
  aiConfig,
  mcpServers,
  onApplyAssistantResult,
  onHeightChange
}) => {
  const [intent, setIntent] = useState<HumanAiIntent>('task');
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [assistantResult, setAssistantResult] = useState<HumanAiAssistantResult | null>(null);
  /** The prompt the shown draft came from: ⌘↵ adds the draft while the prompt is unchanged, else drafts again. */
  const [draftedPrompt, setDraftedPrompt] = useState<string | null>(null);
  /** Markdown the shown draft was compared against (TODO.md at drafting time). */
  const [baseMarkdown, setBaseMarkdown] = useState('');
  const [rejected, setRejected] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Map<number, string>>(new Map());
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  // Prompt history in sessionStorage (terminal-like Up/Down arrow recall)
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const saved = sessionStorage.getItem('ergo_assistant_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [draftPrompt, setDraftPrompt] = useState<string>('');

  // Skill doc content state
  const [skillDocContent, setSkillDocContent] = useState<string>(DEFAULT_HUMAN_ASSISTANT_SKILL);

  // Deletion confirmation permission state
  const [confirmDeletions, setConfirmDeletions] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const activeTaskModelName = useMemo(() => {
    const pMeta = SUPPORTED_AI_PROVIDERS.find((p) => p.id === aiConfig.provider);
    const rawModel = aiConfig.generalModel || aiConfig.model || pMeta?.defaultGeneralModel || 'Task Model';
    const foundModel = pMeta?.models.find((m) => m.id === rawModel);
    return foundModel?.name || rawModel;
  }, [aiConfig]);

  // Load Skill Doc & reset history index on open
  useEffect(() => {
    if (isOpen) {
      setHistoryIndex(-1);
      setDraftPrompt('');
      storageManager.loadSkillDoc('human-assistant').then((content) => setSkillDocContent(content || DEFAULT_HUMAN_ASSISTANT_SKILL));
      setConfirmDeletions(false);
    }
  }, [isOpen]);

  // The dialog floats over the pane, so the pane never makes room for it.
  useEffect(() => {
    onHeightChange?.(0);
  }, [isOpen, onHeightChange]);

  // Flatten available tools from connected MCP servers configured in global MCP page
  const connectedServers = useMemo(() => {
    return mcpServers.filter((m) => m.status === 'connected');
  }, [mcpServers]);

  const allAvailableTools = useMemo(() => {
    const list: MCPTool[] = [];
    connectedServers.forEach((server) => {
      server.tools.forEach((t) => {
        list.push({ ...t, serverId: server.id });
      });
    });
    return list;
  }, [connectedServers]);

  const [selectedToolNames, setSelectedToolNames] = useState<Set<string>>(new Set());
  const [hasUserCustomizedTools, setHasUserCustomizedTools] = useState(false);
  const [isToolsModalOpen, setIsToolsModalOpen] = useState(false);
  const [isSyncingTools, setIsSyncingTools] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  // Auto-guess relevant tools when prompt changes if user hasn't explicitly customized
  const relevanceAnalysis = useMemo(() => {
    return guessRelevantToolsWithDetails(prompt, allAvailableTools);
  }, [prompt, allAvailableTools]);

  useEffect(() => {
    if (!hasUserCustomizedTools && allAvailableTools.length > 0) {
      const suggested = new Set<string>();
      relevanceAnalysis.selectedToolIds.forEach((id) => {
        const tool = allAvailableTools.find((t) => t.id === id);
        if (tool) suggested.add(tool.name);
      });
      setSelectedToolNames(suggested);
    }
  }, [prompt, relevanceAnalysis, hasUserCustomizedTools, allAvailableTools]);

  const draft = useMemo(
    () => (assistantResult?.todoMarkdown && !assistantResult.aggregatedReport ? buildDraft(baseMarkdown, assistantResult.todoMarkdown) : null),
    [assistantResult, baseMarkdown]
  );

  const handleToggleTool = (toolName: string) => {
    setHasUserCustomizedTools(true);
    setSelectedToolNames((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  };

  const handleQuickSyncTools = async () => {
    setIsSyncingTools(true);
    setSyncFeedback('Checking tools…');
    try {
      const res = await checkAllMcpUpdates(mcpServers);
      if (res.hasChanges) {
        setSyncFeedback(res.summaryMessage || 'Tools updated.');
      } else {
        setSyncFeedback('Tools are up to date.');
      }
    } catch {
      setSyncFeedback('Tool check finished.');
    } finally {
      setIsSyncingTools(false);
      setTimeout(() => setSyncFeedback(null), 3000);
    }
  };

  if (!isOpen) return null;

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isLoading) return;

    // Push to sessionStorage history (terminal-like)
    setHistory((prev) => {
      const filtered = prev.filter((p) => p !== trimmed);
      const nextHistory = [...filtered, trimmed];
      try {
        sessionStorage.setItem('ergo_assistant_history', JSON.stringify(nextHistory));
      } catch { }
      return nextHistory;
    });
    setHistoryIndex(-1);
    setDraftPrompt('');

    setIsLoading(true);
    setAssistantResult(null);
    setConfirmDeletions(false);
    setFailure(null);
    setRejected(new Set());
    setEdits(new Map());
    setEditingLine(null);

    try {
      // The assistant sees the list without its hidden task anchors; Ergo puts them back by title when it's applied.
      const plainMarkdown = stripAnchors(todoMarkdown);
      const res = await runHumanAiAssistant(
        trimmed,
        intent,
        plainMarkdown,
        project,
        aiConfig,
        connectedServers,
        skillDocContent || null
      );
      setBaseMarkdown(plainMarkdown);
      setDraftedPrompt(trimmed);
      setAssistantResult(res);
    } catch (err) {
      console.error('Failed to run Human AI Assistant:', err);
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDismiss = () => {
    setAssistantResult(null);
    setDraftedPrompt(null);
    setFailure(null);
    onClose();
  };

  const dropped = draft ? droppedLines(draft, rejected) : new Set<number>();
  const checkedCount = draft ? draft.items.filter((it) => !dropped.has(it.line)).length : 0;
  const needsDeletionOk = !!assistantResult?.requiresDeletionApproval && !confirmDeletions;
  const canApply = !!assistantResult && !needsDeletionOk && !(draft && draft.items.length > 0 && checkedCount === 0);

  const handleApply = () => {
    if (!assistantResult || !canApply) return;
    // A title still being edited counts too.
    const finalEdits = new Map(edits);
    if (editingLine !== null && editText.trim()) finalEdits.set(editingLine, editText.trim());
    const todo = draft ? draftToMarkdown(draft, rejected, finalEdits) : assistantResult.todoMarkdown;
    onApplyAssistantResult(
      {
        ...assistantResult,
        todoMarkdown: todo,
        selectedMcpTools: Array.from(selectedToolNames)
      },
      confirmDeletions
    );
    setAssistantResult(null);
    setDraftedPrompt(null);
    setPrompt('');
    onClose();
  };

  const handleCopyReport = () => {
    if (assistantResult?.aggregatedReport) {
      navigator.clipboard.writeText(assistantResult.aggregatedReport);
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 2000);
    }
  };

  const toggleItem = (line: number) =>
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });

  const startEdit = (it: DraftItem) => {
    setEditingLine(it.line);
    setEditText(edits.get(it.line) ?? it.title);
  };

  const commitEdit = () => {
    if (editingLine === null) return;
    const text = editText.trim();
    const original = draft?.items.find((it) => it.line === editingLine)?.title;
    setEdits((prev) => {
      const next = new Map(prev);
      if (!text || text === original) next.delete(editingLine);
      else next.set(editingLine, text);
      return next;
    });
    setEditingLine(null);
  };

  const currentIntent = INTENTS.find((t) => t.id === intent) || INTENTS[0];
  const hasDraft = !!assistantResult;
  const promptChanged = hasDraft && prompt.trim() !== draftedPrompt;

  const addLabel = draft
    ? draft.items.length > 0
      ? `Add ${checkedCount} ${checkedCount === 1 ? 'task' : 'tasks'}`
      : 'Apply changes'
    : 'Apply changes';

  const primary = hasDraft ? (
    <Button variant="primary" size="lg" disabled={!canApply} onClick={handleApply} kbd={promptChanged ? undefined : [MOD, ENTER]}>
      {addLabel}
    </Button>
  ) : (
    <Button variant="primary" size="lg" disabled={isLoading || !prompt.trim()} onClick={handleGenerate} kbd={isLoading ? undefined : [MOD, ENTER]}>
      {isLoading && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
      {isLoading ? `Drafting with ${activeTaskModelName}…` : 'Draft'}
    </Button>
  );

  const suggestedChips = allAvailableTools
    .filter((t) => selectedToolNames.has(t.name) || relevanceAnalysis.selectedToolIds.includes(t.id))
    .slice(0, 12);

  return (
    <>
      <Dialog
        title="Draft tasks"
        description="Ergo proposes checklist items for TODO.md. Nothing is added or run until you approve."
        onClose={isToolsModalOpen ? undefined : handleDismiss}
        width={640}
        className="dlg-draft"
        footer={
          <>
            <span className="eg-subtle" style={{ fontSize: 'calc(12px * var(--type-scale))' }}>
              {hasDraft ? 'Added as checklist lines in TODO.md.' : `${MOD}${ENTER} drafts · ↑ recalls earlier prompts`}
            </span>
            <span className="eg-spacer" />
            <Button variant="ghost" size="lg" onClick={handleDismiss}>
              {hasDraft ? 'Discard' : 'Cancel'}
            </Button>
            {primary}
          </>
        }
      >
        <div
          onKeyDown={(e) => {
            // ⌘↵ outside the prompt adds the draft.
            if (e.key === 'Enter' && isMod(e) && e.target !== promptRef.current && hasDraft) {
              e.preventDefault();
              handleApply();
            }
          }}
        >
          <div className="eg-composer">
            <textarea
              ref={promptRef}
              className="eg-composer-input dlg-composer-text"
              rows={3}
              autoFocus
              aria-label="What should Ergo draft?"
              placeholder={currentIntent.placeholder}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (historyIndex === -1) {
                  setDraftPrompt(e.target.value);
                }
              }}
              onKeyDown={(e) => {
                // ⌘↵ drafts; with a draft showing and the prompt unchanged it adds the draft.
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (hasDraft && !promptChanged) handleApply();
                  else handleGenerate();
                  return;
                }

                // Terminal-like Up arrow history recall
                if (e.key === 'ArrowUp') {
                  const target = e.currentTarget;
                  const isAtStart = target.selectionStart === 0 || !prompt.includes('\n');
                  if (isAtStart && history.length > 0) {
                    e.preventDefault();
                    if (historyIndex === -1) {
                      setDraftPrompt(prompt);
                      const newIdx = history.length - 1;
                      setHistoryIndex(newIdx);
                      setPrompt(history[newIdx]);
                    } else if (historyIndex > 0) {
                      const newIdx = historyIndex - 1;
                      setHistoryIndex(newIdx);
                      setPrompt(history[newIdx]);
                    }
                    return;
                  }
                }

                // Terminal-like Down arrow history recall
                if (e.key === 'ArrowDown') {
                  const target = e.currentTarget;
                  const isAtEnd = target.selectionEnd === prompt.length || !prompt.includes('\n');
                  if (isAtEnd && historyIndex !== -1) {
                    e.preventDefault();
                    if (historyIndex < history.length - 1) {
                      const newIdx = historyIndex + 1;
                      setHistoryIndex(newIdx);
                      setPrompt(history[newIdx]);
                    } else {
                      setHistoryIndex(-1);
                      setPrompt(draftPrompt);
                    }
                    return;
                  }
                }

                handleMarkdownAutoWrap(e, setPrompt);
              }}
            />
            <div className="eg-composer-foot">
              <SegmentedControl<HumanAiIntent>
                label="Draft size"
                value={intent}
                onChange={setIntent}
                options={INTENTS.map((t) => ({ id: t.id, label: t.label, title: t.title }))}
              />
              <span className="eg-spacer" />
              {hasDraft && (
                <Button variant="ghost" size="sm" icon={isLoading ? undefined : RotateCcw} disabled={isLoading || !prompt.trim()} onClick={handleGenerate}>
                  {isLoading && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />}
                  Regenerate
                </Button>
              )}
            </div>
          </div>

          {/* Tools the new tasks may use */}
          {connectedServers.length > 0 && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <div className="eg-hstack" style={{ fontSize: 'calc(12px * var(--type-scale))', color: 'var(--ink-subtle)', flexWrap: 'wrap' }}>
                <Icon icon={Wrench} size="sm" />
                <span style={{ color: 'var(--ink-muted)', fontWeight: 500 }}>Tools for new tasks</span>
                <span>{selectedToolNames.size} on</span>
                {!hasUserCustomizedTools && relevanceAnalysis.selectedToolIds.length > 0 && <span>· suggested from your prompt</span>}
                {syncFeedback && <span>· {syncFeedback}</span>}
                <span className="eg-spacer" />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={RefreshCw}
                  onClick={handleQuickSyncTools}
                  disabled={isSyncingTools}
                  title="Check connected MCP servers for new tools"
                  className={isSyncingTools ? 'dlg-spin-icon' : undefined}
                >
                  Check for new tools
                </Button>
                <Button variant="ghost" size="sm" icon={Plus} onClick={() => setIsToolsModalOpen(true)}>
                  All tools ({allAvailableTools.length})
                </Button>
              </div>
              {suggestedChips.length > 0 && (
                <div className="dlg-chips">
                  {suggestedChips.map((tool) => {
                    const isChecked = selectedToolNames.has(tool.name);
                    const isSuggested = relevanceAnalysis.selectedToolIds.includes(tool.id);
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        className="dlg-chip"
                        aria-pressed={isChecked}
                        title={isSuggested ? 'Suggested from your prompt' : undefined}
                        onClick={() => handleToggleTool(tool.name)}
                      >
                        <Icon icon={isChecked ? Check : Plus} size="sm" />
                        {tool.name}
                      </button>
                    );
                  })}
                  {allAvailableTools.length > 12 && (
                    <Button variant="ghost" size="sm" onClick={() => setIsToolsModalOpen(true)}>
                      {allAvailableTools.length - 12} more
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {failure && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Banner
                tone="warning"
                title="Ergo couldn’t draft tasks this time"
                text={`${failure} Your prompt is still here — try again, or check the model in Settings.`}
              />
            </div>
          )}

          {/* Proposed tasks */}
          {draft && (
            <>
              <div className="eg-section-label" style={{ marginTop: 'var(--space-5, 20px)' }}>
                {draft.items.length > 0
                  ? `${draft.items.length} proposed ${draft.items.length === 1 ? 'task' : 'tasks'}`
                  : 'Proposed changes'}
                <span className="eg-spacer" />
                <span>{activeTaskModelName}</span>
              </div>
              {assistantResult?.summary && (
                <p style={{ margin: '0 0 var(--space-2)', fontSize: 'calc(12px * var(--type-scale))', lineHeight: 'calc(16px * var(--type-scale))' }}>{assistantResult.summary}</p>
              )}
              {draft.items.length > 0 ? (
                <div className="eg-draft">
                  {draft.items.map((it) => {
                    const off = dropped.has(it.line);
                    /** Left out because a parent task is unchecked. */
                    const offByParent = off && !rejected.has(it.line);
                    const editing = editingLine === it.line;
                    const title = edits.get(it.line) ?? it.title;
                    return (
                      <div key={it.line} className={`eg-draft-item ${off ? 'is-rejected' : ''} ${editing ? 'is-editing' : ''}`}>
                        <Checkbox checked={!off} disabled={offByParent} onChange={() => toggleItem(it.line)} aria-label={`Include “${title}”`} />
                        <div style={{ minWidth: 0 }}>
                          {editing ? (
                            <input
                              className="dlg-draft-edit"
                              value={editText}
                              autoFocus
                              aria-label="Task title"
                              onChange={(e) => setEditText(e.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isMod(e)) {
                                  e.preventDefault();
                                  commitEdit();
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setEditingLine(null);
                                }
                              }}
                            />
                          ) : (
                            <div
                              className="eg-draft-title dlg-draft-title"
                              role="button"
                              tabIndex={0}
                              title="Click to edit"
                              onClick={() => startEdit(it)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isMod(e)) {
                                  e.preventDefault();
                                  startEdit(it);
                                }
                              }}
                            >
                              {title}
                            </div>
                          )}
                          <div className="eg-draft-why">{offByParent ? 'Left out with its parent task' : off ? 'Left out' : it.where}</div>
                        </div>
                        <span />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="dlg-code-well">
                  <pre>{assistantResult?.todoMarkdown}</pre>
                </div>
              )}
              {draft.removed > 0 && !assistantResult?.requiresDeletionApproval && (
                <p className="eg-subtle" style={{ margin: 'var(--space-2) 0 0', fontSize: 'calc(12px * var(--type-scale))' }}>
                  The draft also changes or removes {draft.removed} existing {draft.removed === 1 ? 'line' : 'lines'}.
                </p>
              )}
            </>
          )}

          {/* Report-only results */}
          {assistantResult?.aggregatedReport && (
            <>
              <div className="eg-section-label" style={{ marginTop: 'var(--space-5, 20px)' }}>
                Summary
                <span className="eg-spacer" />
                <Button variant="ghost" size="sm" icon={copiedReport ? Check : Copy} onClick={handleCopyReport}>
                  {copiedReport ? 'Copied' : 'Copy markdown'}
                </Button>
              </div>
              <div className="eg-md dlg-report">
                <MarkdownRenderer content={assistantResult.aggregatedReport} />
              </div>
            </>
          )}

          {assistantResult && !assistantResult.todoMarkdown && !assistantResult.aggregatedReport && assistantResult.summary && (
            <p style={{ margin: 'var(--space-4) 0 0' }}>{assistantResult.summary}</p>
          )}

          {/* Deletions need an explicit yes */}
          {assistantResult?.requiresDeletionApproval && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Banner
                tone="warning"
                title="This draft removes tasks from TODO.md"
                text={assistantResult.deletionReason ? `Reason given: ${assistantResult.deletionReason}` : 'Check that you want them gone before adding the draft.'}
                actions={
                  <label className="eg-hstack" style={{ cursor: 'pointer', color: 'var(--ink)' }}>
                    <Checkbox checked={confirmDeletions} onChange={(e) => setConfirmDeletions(e.target.checked)} />
                    <span>Remove those tasks too</span>
                  </label>
                }
              />
            </div>
          )}
        </div>
      </Dialog>

      {isToolsModalOpen && (
        <TaskMcpToolsModal
          isOpen={isToolsModalOpen}
          onClose={() => setIsToolsModalOpen(false)}
          task={{
            id: 'draft',
            title: prompt.slice(0, 50) || 'New draft task',
            category: 'Tasks',
            status: 'not_started',
            isDone: false,
            subtasks: [],
            mcpRequired: Array.from(selectedToolNames)
          }}
          mcpServers={mcpServers}
          onSaveTools={(tools) => {
            setHasUserCustomizedTools(true);
            setSelectedToolNames(new Set(tools));
          }}
        />
      )}
    </>
  );
};
