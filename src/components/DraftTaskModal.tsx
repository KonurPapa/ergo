import React, { useState } from 'react';
import { type ProjectData, type AIProviderConfig, type MCPServer, type TaskItem, type AgentContextItem } from '../types';
import { draftTasksWithAi } from '../lib/ai';
import { Sparkles, X, Check, Loader2, Cpu } from 'lucide-react';

interface DraftTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: ProjectData;
  aiConfig: AIProviderConfig;
  mcpServers: MCPServer[];
  onCommitDraftedTasks: (newTasks: Partial<TaskItem>[], newBriefs: Partial<AgentContextItem>[]) => void;
}

export const DraftTaskModal: React.FC<DraftTaskModalProps> = ({
  isOpen,
  onClose,
  project,
  aiConfig,
  mcpServers,
  onCommitDraftedTasks
}) => {
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [draftResult, setDraftResult] = useState<{ newTasks: Partial<TaskItem>[]; newBriefs: Partial<AgentContextItem>[] } | null>(null);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsLoading(true);
    try {
      const res = await draftTasksWithAi(prompt, project, aiConfig, mcpServers);
      setDraftResult(res);
    } catch (err) {
      console.error('Failed to draft tasks:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCommit = () => {
    if (draftResult) {
      onCommitDraftedTasks(draftResult.newTasks, draftResult.newBriefs);
      setDraftResult(null);
      setPrompt('');
      onClose();
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Sparkles size={20} color="var(--accent-primary)" />
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Draft Tasks with AI (Skill: new-todo)</h3>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
            Enter your high-level goal, feature request, or raw specification. The AI will generate scannable task entries for <strong style={{ color: '#fff' }}>TODO.md</strong> and verbose done-state briefs for <strong style={{ color: '#fff' }}>AGENT_CONTEXT.md</strong>.
          </p>

          <div className="input-group">
            <label className="input-label">Project Goal or Feature Request</label>
            <textarea
              className="textarea-text"
              rows={4}
              placeholder="e.g., Implement automated scale detection from high-DPI PDF title blocks, and add layered PDF export for revision diffs..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              <Cpu size={14} color="var(--accent-cyan)" />
              <span>Target MCP Tools: Standard + Connected MCPs</span>
            </div>
            <button className="btn btn-primary" onClick={handleGenerate} disabled={isLoading || !prompt.trim()}>
              {isLoading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Drafting Roadmap & Briefs...</span>
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  <span>Generate Dual-Layer Draft</span>
                </>
              )}
            </button>
          </div>

          {/* Generated Preview */}
          {draftResult && (
            <div style={{ background: 'var(--bg-darkest)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-md)', padding: '1.25rem', marginTop: '1.25rem' }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-cyan)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Check size={16} />
                <span>Generated Tasks & Context Briefs Preview</span>
              </h4>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                {draftResult.newTasks.map((t, idx) => (
                  <div key={idx} style={{ background: 'var(--bg-card)', padding: '0.85rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff' }}>
                      Task: {t.title}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                      Category: {t.category} | Subtasks: {t.subtasks?.length || 0}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: '0.4rem', fontFamily: 'var(--font-mono)' }}>
                      Brief summary: {draftResult.newBriefs[idx]?.brief?.slice(0, 100)}...
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {draftResult && (
            <button className="btn btn-emerald" onClick={handleCommit}>
              <Check size={16} />
              <span>Approve & Add to Roadmap</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
