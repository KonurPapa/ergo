import React, { useState, useEffect } from 'react';
import {
  type TaskItem,
  type AgentContextItem,
  type ProjectData,
  type AIProviderConfig,
  type MCPServer,
  type ExecutionStep,
  type McpToolPermissionPrompt,
  type HumanInputPrompt
} from '../types';
import { executeTaskWithAi } from '../lib/ai';
import { Play, X, CheckCircle2, Loader2, Send, Layers, Code, ShieldAlert, ShieldCheck, HelpCircle } from 'lucide-react';

interface ExecutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: TaskItem | null;
  brief: AgentContextItem | undefined;
  project: ProjectData;
  aiConfig: AIProviderConfig;
  mcpServers: MCPServer[];
  onCompleteExecution: (updatedTask: TaskItem, updatedBrief: AgentContextItem) => void;
}

export const ExecutionModal: React.FC<ExecutionModalProps> = ({
  isOpen,
  onClose,
  task,
  brief,
  project,
  aiConfig,
  mcpServers,
  onCompleteExecution
}) => {
  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [resultPayload, setResultPayload] = useState<{ updatedTask: TaskItem; updatedBrief: AgentContextItem } | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{
    prompt: McpToolPermissionPrompt;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [pendingHumanInput, setPendingHumanInput] = useState<{
    prompt: HumanInputPrompt;
    resolve: (answer: string) => void;
  } | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState('');

  useEffect(() => {
    if (isOpen && task && !isRunning && !isFinished) {
      startExecution();
    }
  }, [isOpen, task?.id]);

  if (!isOpen || !task) return null;

  const startExecution = async () => {
    setSteps([]);
    setIsRunning(true);
    setIsFinished(false);
    setResultPayload(null);
    setPendingPermission(null);
    setPendingHumanInput(null);
    setSelectedOption(null);
    setCustomAnswer('');

    try {
      const res = await executeTaskWithAi(
        task,
        brief,
        project,
        aiConfig,
        mcpServers,
        (stepUpdate) => {
          setSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === stepUpdate.id);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = stepUpdate;
              return next;
            }
            return [...prev, stepUpdate];
          });
        },
        (permissionPrompt) => {
          return new Promise<boolean>((resolve) => {
            setPendingPermission({ prompt: permissionPrompt, resolve });
          });
        },
        (humanInputPrompt) => {
          return new Promise<string>((resolve) => {
            setPendingHumanInput({ prompt: humanInputPrompt, resolve });
          });
        }
      );

      setResultPayload(res);
      setIsFinished(true);
    } catch (err) {
      console.error('Execution error:', err);
    } finally {
      setIsRunning(false);
    }
  };

  const handlePermissionChoice = (approved: boolean) => {
    if (pendingPermission) {
      pendingPermission.resolve(approved);
      setPendingPermission(null);
    }
  };

  const handleHumanInputSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (pendingHumanInput) {
      const cleanCustom = customAnswer.trim();
      const finalAnswer = cleanCustom
        ? selectedOption
          ? `${selectedOption} — ${cleanCustom}`
          : cleanCustom
        : selectedOption || 'Confirmed';
      pendingHumanInput.resolve(finalAnswer);
      setPendingHumanInput(null);
      setSelectedOption(null);
      setCustomAnswer('');
    }
  };

  const handleApply = () => {
    if (resultPayload) {
      onCompleteExecution(resultPayload.updatedTask, resultPayload.updatedBrief);
      onClose();
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content" style={{ maxWidth: '900px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Play size={20} color="var(--accent-emerald)" />
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>
              Agent Task Execution Sandbox (Skill: run-todo)
            </h3>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Active Task Banner */}
          <div style={{ background: 'var(--bg-darkest)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-violet)', textTransform: 'uppercase', marginBottom: '0.2rem' }}>
              Executing Item #{task.id}
            </div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-bright)' }}>{task.title}</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
              {brief?.brief?.slice(0, 140) || 'Executing task subtasks & logging build records to AGENT_CONTEXT.md.'}
            </p>
          </div>

          {/* Interactive Human Clarification Prompt Card */}
          {pendingHumanInput && (
            <div className="ai-human-input-card" style={{ marginBottom: '1.25rem' }}>
              <div className="ai-human-input-header">
                <div className="ai-human-input-title">
                  <HelpCircle size={17} color="var(--accent-amber)" />
                  <span>Clarification Needed &bull; Manager AI</span>
                </div>
                <span className="ai-human-input-badge">Mid-Build Input</span>
              </div>

              <p className="ai-human-input-question">{pendingHumanInput.prompt.question}</p>

              {pendingHumanInput.prompt.context && (
                <div className="ai-human-input-context">
                  <strong>Context:</strong> {pendingHumanInput.prompt.context}
                </div>
              )}

              {pendingHumanInput.prompt.options && pendingHumanInput.prompt.options.length > 0 && (
                <div className="ai-human-input-options">
                  <div className="ai-human-input-options-label">Select an option:</div>
                  <div className="ai-human-input-options-list">
                    {pendingHumanInput.prompt.options.map((opt, idx) => {
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

              {(pendingHumanInput.prompt.allowFreeform !== false || !pendingHumanInput.prompt.options || pendingHumanInput.prompt.options.length === 0) && (
                <form onSubmit={handleHumanInputSubmit} className="ai-human-input-form">
                  <textarea
                    className="ai-human-input-textarea"
                    placeholder="Type your response or clarification here..."
                    value={customAnswer}
                    onChange={(e) => setCustomAnswer(e.target.value)}
                    rows={2}
                  />
                  <div className="ai-human-input-actions">
                    <button
                      type="submit"
                      className="btn btn-primary ai-human-input-submit-btn"
                      disabled={!selectedOption && !customAnswer.trim()}
                    >
                      <Send size={13} />
                      <span>Submit Response</span>
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Interactive MCP Permission Prompt Card */}
          {pendingPermission && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                borderRadius: 'var(--radius-md)',
                padding: '1.25rem',
                marginBottom: '1.25rem',
                animation: 'fadeIn 0.2s ease'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: 'var(--accent-rose)', fontWeight: 700, fontSize: '0.95rem', marginBottom: '0.5rem' }}>
                <ShieldAlert size={20} />
                <span>Permission Authorization Required</span>
              </div>
              <p style={{ fontSize: '0.85rem', color: '#fff', marginBottom: '0.75rem' }}>
                The AI agent is requesting to execute a restricted tool: <strong style={{ color: 'var(--accent-cyan)' }}>{pendingPermission.prompt.serverName} / {pendingPermission.prompt.toolName}()</strong>
              </p>
              <div style={{ background: 'var(--bg-darkest)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                {pendingPermission.prompt.summary}
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => handlePermissionChoice(false)}>
                  Skip / Reject
                </button>
                <button className="btn btn-emerald" onClick={() => handlePermissionChoice(true)}>
                  <ShieldCheck size={16} />
                  <span>Approve Tool Call</span>
                </button>
              </div>
            </div>
          )}

          {/* Execution Steps Terminal */}
          <div className="execution-steps">
            {steps.map((step) => (
              <div key={step.id} className={`step-card ${step.status}`}>
                <div className="step-header">
                  <div className="step-title">
                    {step.status === 'running' && <Loader2 size={16} className="animate-spin" color="var(--accent-primary)" />}
                    {step.status === 'success' && <CheckCircle2 size={16} color="var(--accent-emerald)" />}
                    <span>{step.title}</span>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                    {step.time}
                  </span>
                </div>

                <div className="step-detail">{step.detail}</div>

                {/* Overview document preview if available */}
                {step.stage === 'overview' && step.status === 'success' && step.overviewDocument && (
                  <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {step.overviewDocument.brief && (
                      <div style={{ padding: '0.6rem 0.75rem', background: 'rgba(56, 189, 248, 0.06)', border: '1px solid rgba(56, 189, 248, 0.2)', borderRadius: 'var(--radius-sm)', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
                        <div style={{ fontWeight: 700, color: 'var(--accent-cyan)', marginBottom: '0.35rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          🥒 Gherkin Execution Brief (Given-When-Then)
                        </div>
                        <pre style={{ margin: 0, padding: 0, background: 'transparent', color: 'inherit', fontFamily: 'var(--font-mono)', fontSize: '0.74rem', whiteSpace: 'pre-wrap', lineHeight: '1.45' }}>
                          {step.overviewDocument.brief}
                        </pre>
                      </div>
                    )}
                    <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(245, 158, 11, 0.06)', border: '1px solid rgba(245, 158, 11, 0.2)', borderRadius: 'var(--radius-sm)', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
                      <div style={{ fontWeight: 700, color: 'var(--accent-amber)', marginBottom: '0.25rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Output As</div>
                      <span>{step.overviewDocument.output_as}</span>
                    </div>
                  </div>
                )}

                {/* Render Interactive MCP App UI Widget if present */}
                {step.widgetType && renderMcpAppWidget(step.widgetType, step.widgetData)}
              </div>
            ))}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          {isFinished && resultPayload && (
            <button className="btn btn-emerald" onClick={handleApply}>
              <CheckCircle2 size={16} />
              <span>Apply Build Record & Mark DONE</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

function renderMcpAppWidget(type: string, data: any) {
  if (!data) return null;

  if (type === 'vscode_preview') {
    return (
      <div className="widget-box" style={{ borderLeft: '3px solid var(--accent-cyan)' }}>
        <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--accent-cyan)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Code size={16} color="var(--accent-cyan)" />
            <span>VS Code Editor MCP Live Stream ({data.editorFile || 'TODO.md'})</span>
          </div>
          <span style={{ fontSize: '0.72rem', color: 'var(--accent-emerald)', background: 'rgba(16, 185, 129, 0.15)', padding: '0.15rem 0.5rem', borderRadius: '4px' }}>
            {data.connectionStatus || 'Stdio IPC Connected'}
          </span>
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
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
        <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--accent-cyan)', marginBottom: '0.5rem' }}>
          📊 Amplitude MCP Interactive Funnel View
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>1. {data.step1.name}: <strong>{data.step1.users} users</strong></div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>2. {data.step2.name}: <strong>{data.step2.users} users</strong></div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>3. {data.step3.name}: <strong>{data.step3.users} users</strong></div>
          </div>
          <div style={{ background: 'rgba(244, 63, 94, 0.15)', border: '1px solid rgba(244, 63, 94, 0.3)', padding: '0.5rem 0.85rem', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--accent-rose)', textTransform: 'uppercase' }}>Dropoff Rate</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--accent-rose)' }}>{data.dropoffRate}</div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'slack_draft') {
    return (
      <div className="widget-box">
        <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--accent-violet)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Send size={14} />
          <span>Slack MCP Interactive Composer ({data.channel})</span>
        </div>
        <div style={{ background: 'var(--bg-darkest)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', fontSize: '0.85rem' }}>
          {data.message}
        </div>
      </div>
    );
  }

  if (type === 'bluebeam_diff') {
    return (
      <div className="widget-box">
        <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--accent-emerald)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Layers size={14} />
          <span>Bluebeam Revision Layer Diff Widget ({data.sheetNumber})</span>
        </div>
        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          Sheet Title: {data.sheetTitle} | Change score: <strong>{data.changeScore}</strong>
        </div>
        <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--accent-cyan)' }}>
          Affected Conditions: {data.affectedConditions.join(', ')}
        </div>
      </div>
    );
  }

  // Code diff fallback
  return (
    <div className="widget-box">
      <div style={{ fontWeight: 700, fontSize: '0.85rem', color: '#fff', marginBottom: '0.5rem' }}>
        💻 File System MCP Unified Code Diff ({data.filename})
      </div>
      <div className="diff-view">
        {data.diffLines.map((line: string, idx: number) => (
          <div key={idx} className={line.startsWith('+') ? 'diff-line-add' : line.startsWith('-') ? 'diff-line-del' : ''}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
