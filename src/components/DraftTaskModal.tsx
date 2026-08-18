import React, { useState, useEffect, useMemo } from 'react';
import {
  type ProjectData,
  type AIProviderConfig,
  type MCPServer,
  type TaskItem,
  type AgentContextItem,
  type MCPTool
} from '../types';
import { draftTasksWithAi } from '../lib/ai';
import { guessRelevantTools } from '../lib/mcpClient';
import { Sparkles, X, Check, Loader2, Cpu, RefreshCw, ChevronDown, ChevronUp, CheckSquare, Square } from 'lucide-react';

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
  const [showToolsList, setShowToolsList] = useState(false);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [isRefreshingTools, setIsRefreshingTools] = useState(false);

  // Flatten available tools from connected MCP servers
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

  // Automatically guess relevant tools whenever user types in prompt
  useEffect(() => {
    if (prompt.trim().length > 3) {
      const guessed = guessRelevantTools(prompt, allAvailableTools);
      setSelectedToolIds(guessed);
    } else {
      // Default to read_file and fetch_markdown if empty
      const defaults = allAvailableTools
        .filter((t) => t.name === 'read_file' || t.name === 'fetch_markdown')
        .map((t) => t.id);
      setSelectedToolIds(defaults);
    }
  }, [prompt, allAvailableTools]);

  if (!isOpen) return null;

  const handleToggleTool = (toolId: string) => {
    setSelectedToolIds((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId]
    );
  };

  const handleRefreshTools = async () => {
    setIsRefreshingTools(true);
    await new Promise((r) => setTimeout(r, 600));
    setIsRefreshingTools(false);
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsLoading(true);
    try {
      const res = await draftTasksWithAi(prompt, project, aiConfig, connectedServers);
      // Attach selected MCP tools to drafted tasks
      const enrichedTasks = res.newTasks.map((t) => ({
        ...t,
        mcpRequired: selectedToolIds.map((id) => {
          const tool = allAvailableTools.find((t) => t.id === id);
          return tool ? `${tool.name}` : id;
        })
      }));
      setDraftResult({
        newTasks: enrichedTasks,
        newBriefs: res.newBriefs
      });
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
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content" style={{ maxWidth: '820px' }} onClick={(e) => e.stopPropagation()}>
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
            Enter your high-level goal, feature request, or raw specification. The AI will inspect connected MCP harnesses (<strong style={{ color: '#fff' }}>tools/list</strong>), suggest relevant tools, and generate scannable task entries for <strong style={{ color: '#fff' }}>TODO.md</strong> with verbose briefs for <strong style={{ color: '#fff' }}>AGENT_CONTEXT.md</strong>.
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

          {/* MCP Tools Selection & Discovery Section */}
          <div style={{ background: 'var(--bg-darkest)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem', marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button
                type="button"
                onClick={() => setShowToolsList(!showToolsList)}
                style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, fontSize: '0.85rem', padding: 0 }}
              >
                <Cpu size={16} color="var(--accent-cyan)" />
                <span>Connected MCP Tools ({selectedToolIds.length} active / {allAvailableTools.length} available)</span>
                {showToolsList ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', gap: '0.3rem' }}
                onClick={handleRefreshTools}
                title="Query tools/list from connected MCP servers"
              >
                <RefreshCw size={12} className={isRefreshingTools ? 'animate-spin' : ''} />
                <span>Sync tools/list</span>
              </button>
            </div>

            {showToolsList && (
              <div style={{ marginTop: '0.85rem', paddingTop: '0.85rem', borderTop: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginBottom: '0.6rem' }}>
                  The AI automatically guesses the most relevant tools based on your prompt. Check or uncheck tools below to customize:
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '0.5rem', maxHeight: '180px', overflowY: 'auto' }}>
                  {allAvailableTools.map((tool) => {
                    const isSelected = selectedToolIds.includes(tool.id);
                    const server = connectedServers.find((s) => s.id === tool.serverId);
                    return (
                      <div
                        key={tool.id}
                        onClick={() => handleToggleTool(tool.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.5rem',
                          padding: '0.4rem 0.6rem',
                          background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-card)',
                          border: `1px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                          borderRadius: 'var(--radius-sm)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <div style={{ marginTop: '2px', color: isSelected ? 'var(--accent-primary)' : 'var(--text-dim)' }}>
                          {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: isSelected ? '#fff' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {tool.name}
                          </div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {server?.name || 'MCP'} • {tool.description}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: '1rem' }}>
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
                    {t.mcpRequired && t.mcpRequired.length > 0 && (
                      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                        {t.mcpRequired.map((mcp, mIdx) => (
                          <span key={mIdx} style={{ fontSize: '0.72rem', background: 'rgba(59, 130, 246, 0.15)', color: 'var(--accent-cyan)', padding: '0.1rem 0.4rem', borderRadius: '3px', fontFamily: 'var(--font-mono)' }}>
                            {mcp}
                          </span>
                        ))}
                      </div>
                    )}
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
