import React, { useState, useEffect, useMemo } from 'react';
import {
  type TaskItem,
  type AgentContextItem,
  type MCPServer,
  type MCPTool
} from '../types';
import {
  guessRelevantToolsWithDetails,
  checkAllMcpUpdates
} from '../lib/mcpClient';
import {
  Wrench,
  X,
  Check,
  Sparkles,
  RefreshCw,
  Search,
  Shield,
  Info,
  Folder,
  Code,
  Cloud,
  Zap,
  Cpu
} from 'lucide-react';

interface TaskMcpToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
  task?: TaskItem | null;
  taskTitle?: string;
  taskDescription?: string;
  selectedTools?: string[];
  brief?: AgentContextItem;
  mcpServers: MCPServer[];
  onSaveTools?: (selectedToolNamesOrIds: string[]) => void;
  onSave?: (selectedToolNamesOrIds: string[]) => void;
  onUpdateMcpServers?: (servers: MCPServer[]) => void;
}

function renderServerMiniIcon(server: MCPServer) {
  if (server.iconUrl) {
    return (
      <img
        src={server.iconUrl}
        alt={server.name}
        style={{ width: 14, height: 14, objectFit: 'contain' }}
      />
    );
  }
  const size = 13;
  switch (server.iconName) {
    case 'Folder': return <Folder size={size} />;
    case 'Code': return <Code size={size} />;
    case 'Cloud': return <Cloud size={size} />;
    case 'Zap': return <Zap size={size} />;
    default: return <Cpu size={size} />;
  }
}

export const TaskMcpToolsModal: React.FC<TaskMcpToolsModalProps> = ({
  isOpen,
  onClose,
  task,
  taskTitle,
  taskDescription,
  selectedTools: selectedToolsProp,
  brief,
  mcpServers,
  onSaveTools,
  onSave,
  onUpdateMcpServers
}) => {
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedServerFilter, setSelectedServerFilter] = useState<string>('all');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatusMessage, setSyncStatusMessage] = useState<string | null>(null);
  const [showSuggestedOnly, setShowSuggestedOnly] = useState(false);

  const effectiveTitle = task?.title || taskTitle || 'Task';
  const effectiveDescription = (task?.subtasks?.map((s) => s.text).join(' ') || taskDescription || '');

  // Connected servers
  const connectedServers = useMemo(() => {
    return mcpServers.filter((s) => s.status === 'connected');
  }, [mcpServers]);

  // Flatten all available tools
  const allAvailableTools = useMemo(() => {
    const list: MCPTool[] = [];
    connectedServers.forEach((server) => {
      server.tools.forEach((t) => {
        list.push({ ...t, serverId: server.id });
      });
    });
    return list;
  }, [connectedServers]);

  // Intelligent analysis of tool relevance based on task and brief text
  const relevanceAnalysis = useMemo(() => {
    const taskText = `${effectiveTitle} ${effectiveDescription}`;
    const briefText = brief?.overview || brief?.brief || '';
    return guessRelevantToolsWithDetails(taskText, allAvailableTools, briefText);
  }, [effectiveTitle, effectiveDescription, brief, allAvailableTools]);

  // Initialize selected tools when modal opens
  useEffect(() => {
    if (isOpen) {
      const existing = new Set<string>();
      const fromTask = task?.mcpRequired || selectedToolsProp || [];
      const fromBrief = brief?.requiredMcps || brief?.selectedMcpTools || [];
      const combined = [...fromTask, ...fromBrief];

      if (combined.length > 0) {
        combined.forEach((item) => {
          const lower = item.toLowerCase();
          // Check if it matches a tool name or ID
          const match = allAvailableTools.find(
            (t) => t.name.toLowerCase() === lower || t.id.toLowerCase() === lower
          );
          if (match) {
            existing.add(match.name);
          } else {
            // Check if it matches a server name/ID
            const serverMatch = connectedServers.find(
              (s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower
            );
            if (serverMatch) {
              serverMatch.tools.forEach((t) => existing.add(t.name));
            } else {
              existing.add(item);
            }
          }
        });
      } else {
        // If no tools explicitly assigned yet, pre-select AI suggested tools
        relevanceAnalysis.selectedToolIds.forEach((id) => {
          const t = allAvailableTools.find((tool) => tool.id === id);
          if (t) existing.add(t.name);
        });
      }

      setSelectedTools(existing);
      setSearchQuery('');
      setSyncStatusMessage(null);
    }
  }, [isOpen, task, selectedToolsProp, brief, allAvailableTools, connectedServers, relevanceAnalysis]);

  if (!isOpen) return null;

  const handleToggleTool = (toolName: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) {
        next.delete(toolName);
      } else {
        next.add(toolName);
      }
      return next;
    });
  };

  const handleApplySuggested = () => {
    const next = new Set<string>();
    relevanceAnalysis.selectedToolIds.forEach((id) => {
      const tool = allAvailableTools.find((t) => t.id === id);
      if (tool) next.add(tool.name);
    });
    setSelectedTools(next);
  };

  const handleSelectAll = () => {
    const next = new Set<string>();
    allAvailableTools.forEach((t) => next.add(t.name));
    setSelectedTools(next);
  };

  const handleClearAll = () => {
    setSelectedTools(new Set());
  };

  const handleSave = () => {
    const list = Array.from(selectedTools);
    if (onSaveTools) onSaveTools(list);
    if (onSave) onSave(list);
    onClose();
  };

  // Sync / Refresh tools from MCP servers
  const handleSyncAllTools = async () => {
    setIsSyncing(true);
    setSyncStatusMessage('Querying tools/list across connected MCPs…');
    try {
      const res = await checkAllMcpUpdates(mcpServers);
      if (onUpdateMcpServers) {
        onUpdateMcpServers(res.updatedServers);
      }
      if (res.hasChanges) {
        setSyncStatusMessage(res.summaryMessage || 'Discovered tool updates!');
      } else {
        setSyncStatusMessage('All tools are up-to-date.');
      }
    } catch {
      setSyncStatusMessage('Tool sync completed.');
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatusMessage(null), 3500);
    }
  };

  // Filter tools
  const filteredTools = allAvailableTools.filter((tool) => {
    if (selectedServerFilter !== 'all' && tool.serverId !== selectedServerFilter) {
      return false;
    }
    if (showSuggestedOnly) {
      const isSuggested = relevanceAnalysis.selectedToolIds.includes(tool.id);
      if (!isSuggested) return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = tool.name.toLowerCase().includes(q);
      const matchDesc = tool.description.toLowerCase().includes(q);
      if (!matchName && !matchDesc) return false;
    }
    return true;
  });

  // Group filtered tools by server
  const toolsByServer: Record<string, { server: MCPServer; tools: MCPTool[] }> = {};
  filteredTools.forEach((tool) => {
    const s = connectedServers.find((srv) => srv.id === tool.serverId);
    if (!s) return;
    if (!toolsByServer[s.id]) {
      toolsByServer[s.id] = { server: s, tools: [] };
    }
    toolsByServer[s.id].tools.push(tool);
  });

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.72)',
        backdropFilter: 'blur(4px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem'
      }}
    >
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '720px',
          maxHeight: '88vh',
          backgroundColor: 'var(--card-bg, #181b22)',
          border: '1px solid var(--border-subtle, #27272a)',
          borderRadius: '10px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.45)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '0.85rem 1.15rem',
            borderBottom: '1px solid var(--border-subtle, #27272a)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-pane, #1a1d25)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(37, 99, 235, 0.16)',
                border: '1px solid rgba(37, 99, 235, 0.35)',
                color: 'var(--accent-primary, #2563eb)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <Wrench size={16} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <h3
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    color: 'var(--text-bright, #fafafa)',
                    fontFamily: "'Space Grotesk', sans-serif",
                    margin: 0
                  }}
                >
                  Configure MCP Tools
                </h3>
                <span
                  style={{
                    fontSize: '0.68rem',
                    padding: '0.1rem 0.45rem',
                    borderRadius: '12px',
                    background: 'rgba(0, 212, 146, 0.14)',
                    color: 'var(--accent, #00d492)',
                    fontWeight: 600,
                    border: '1px solid rgba(0, 212, 146, 0.25)'
                  }}
                >
                  {selectedTools.size} Active
                </span>
              </div>
              <p
                style={{
                  fontSize: '0.74rem',
                  color: 'var(--text-muted, #71717a)',
                  margin: '0.15rem 0 0 0',
                  maxWidth: '520px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {task?.id ? `Task #${task.id}: ` : ''}{effectiveTitle}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <button
              type="button"
              onClick={handleSyncAllTools}
              disabled={isSyncing}
              title="Query tools/list on all connected MCPs to discover new or updated tools"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                fontSize: '0.72rem',
                padding: '0.3rem 0.55rem',
                borderRadius: '6px',
                background: 'var(--card-hover, #262a35)',
                border: '1px solid var(--border-subtle, #27272a)',
                color: 'var(--text-main, #e4e4e7)',
                cursor: isSyncing ? 'not-allowed' : 'pointer',
                opacity: isSyncing ? 0.6 : 1
              }}
            >
              <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
              <span>{isSyncing ? 'Syncing…' : 'Sync tools/list'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted, #71717a)',
                cursor: 'pointer',
                padding: '0.25rem',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center'
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Sync notification banner */}
        {syncStatusMessage && (
          <div
            style={{
              padding: '0.4rem 1rem',
              background: 'rgba(6, 182, 212, 0.12)',
              borderBottom: '1px solid rgba(6, 182, 212, 0.25)',
              fontSize: '0.73rem',
              color: 'var(--accent-cyan, #06b6d4)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem'
            }}
          >
            <Info size={13} />
            <span>{syncStatusMessage}</span>
          </div>
        )}

        {/* Suggestion banner & Ambiguity guidance */}
        <div
          style={{
            padding: '0.65rem 1.15rem',
            background: 'rgba(0, 0, 0, 0.2)',
            borderBottom: '1px solid var(--border-subtle, #27272a)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: '240px' }}>
            <Sparkles size={14} color="var(--accent, #00d492)" />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-main, #e4e4e7)' }}>
              AI suggested{' '}
              <strong style={{ color: 'var(--accent, #00d492)' }}>
                {relevanceAnalysis.selectedToolIds.length} tools
              </strong>{' '}
              specifically for this task based on the brief.
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
            <button
              type="button"
              onClick={handleApplySuggested}
              style={{
                fontSize: '0.72rem',
                padding: '0.28rem 0.6rem',
                borderRadius: '6px',
                background: 'rgba(0, 212, 146, 0.14)',
                border: '1px solid rgba(0, 212, 146, 0.35)',
                color: 'var(--accent, #00d492)',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem'
              }}
            >
              <Check size={12} />
              <span>Select Suggested ({relevanceAnalysis.selectedToolIds.length})</span>
            </button>
            <button
              type="button"
              onClick={handleSelectAll}
              style={{
                fontSize: '0.72rem',
                padding: '0.28rem 0.55rem',
                borderRadius: '6px',
                background: 'var(--card-hover, #262a35)',
                border: '1px solid var(--border-subtle, #27272a)',
                color: 'var(--text-muted, #71717a)',
                cursor: 'pointer'
              }}
            >
              All
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              style={{
                fontSize: '0.72rem',
                padding: '0.28rem 0.55rem',
                borderRadius: '6px',
                background: 'var(--card-hover, #262a35)',
                border: '1px solid var(--border-subtle, #27272a)',
                color: 'var(--text-muted, #71717a)',
                cursor: 'pointer'
              }}
            >
              Clear
            </button>
          </div>
        </div>

        {/* Toolbar: Search, Server filter tabs, Suggested toggle */}
        <div
          style={{
            padding: '0.65rem 1.15rem',
            borderBottom: '1px solid var(--border-subtle, #27272a)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.65rem',
            background: 'var(--bg-pane, #1a1d25)'
          }}
        >
          {/* Search Input */}
          <div
            style={{
              flex: 1,
              position: 'relative',
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <Search
              size={13}
              style={{
                position: 'absolute',
                left: '0.65rem',
                color: 'var(--text-muted, #71717a)',
                pointerEvents: 'none'
              }}
            />
            <input
              type="text"
              placeholder="Search tools by name or purpose…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '0.35rem 0.65rem 0.35rem 2rem',
                fontSize: '0.76rem',
                background: 'var(--card-bg, #181b22)',
                border: '1px solid var(--border-subtle, #27272a)',
                borderRadius: '6px',
                color: 'var(--text-bright, #fafafa)',
                outline: 'none'
              }}
            />
          </div>

          {/* Server filter select */}
          <select
            value={selectedServerFilter}
            onChange={(e) => setSelectedServerFilter(e.target.value)}
            style={{
              padding: '0.35rem 0.6rem',
              fontSize: '0.74rem',
              background: 'var(--card-bg, #181b22)',
              border: '1px solid var(--border-subtle, #27272a)',
              borderRadius: '6px',
              color: 'var(--text-main, #e4e4e7)',
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            <option value="all">All Servers ({connectedServers.length})</option>
            {connectedServers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.tools.length})
              </option>
            ))}
          </select>

          {/* Filter suggested */}
          <button
            type="button"
            onClick={() => setShowSuggestedOnly(!showSuggestedOnly)}
            style={{
              padding: '0.35rem 0.6rem',
              fontSize: '0.73rem',
              borderRadius: '6px',
              background: showSuggestedOnly ? 'rgba(0, 212, 146, 0.18)' : 'var(--card-bg, #181b22)',
              border: `1px solid ${showSuggestedOnly ? 'rgba(0, 212, 146, 0.4)' : 'var(--border-subtle, #27272a)'}`,
              color: showSuggestedOnly ? 'var(--accent, #00d492)' : 'var(--text-muted, #71717a)',
              cursor: 'pointer',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              whiteSpace: 'nowrap'
            }}
          >
            <Sparkles size={12} />
            <span>Suggested Only</span>
          </button>
        </div>

        {/* Tools List Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0.85rem 1.15rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem'
          }}
        >
          {connectedServers.length === 0 ? (
            <div
              style={{
                padding: '2.5rem 1rem',
                textAlign: 'center',
                color: 'var(--text-muted, #71717a)',
                fontSize: '0.8rem'
              }}
            >
              No MCP servers are currently connected. Connect MCP servers in the Connections hub to enable tools for your tasks.
            </div>
          ) : Object.keys(toolsByServer).length === 0 ? (
            <div
              style={{
                padding: '2rem 1rem',
                textAlign: 'center',
                color: 'var(--text-muted, #71717a)',
                fontSize: '0.8rem'
              }}
            >
              No tools match your current search/filter.
            </div>
          ) : (
            Object.values(toolsByServer).map(({ server, tools }) => (
              <div
                key={server.id}
                style={{
                  background: 'var(--bg-pane, #1a1d25)',
                  border: '1px solid var(--border-subtle, #27272a)',
                  borderRadius: '8px',
                  overflow: 'hidden'
                }}
              >
                {/* Server Section Header */}
                <div
                  style={{
                    padding: '0.5rem 0.85rem',
                    background: 'rgba(0, 0, 0, 0.15)',
                    borderBottom: '1px solid var(--border-subtle, #27272a)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    <span style={{ color: 'var(--accent-primary, #2563eb)' }}>
                      {renderServerMiniIcon(server)}
                    </span>
                    <span
                      style={{
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        color: 'var(--text-bright, #fafafa)',
                        fontFamily: "'Space Grotesk', sans-serif"
                      }}
                    >
                      {server.name}
                    </span>
                    <span
                      style={{
                        fontSize: '0.66rem',
                        color: 'var(--text-muted, #71717a)',
                        fontFamily: "'JetBrains Mono', monospace"
                      }}
                    >
                      [{server.transport}]
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span
                      style={{
                        fontSize: '0.67rem',
                        color: 'var(--text-muted, #71717a)'
                      }}
                    >
                      {tools.filter((t) => selectedTools.has(t.name)).length}/{tools.length} selected
                    </span>
                  </div>
                </div>

                {/* Tools in Server */}
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {tools.map((tool) => {
                    const isSelected = selectedTools.has(tool.name);
                    const isSuggested = relevanceAnalysis.selectedToolIds.includes(tool.id);
                    const suggestReason = relevanceAnalysis.reasons[tool.id];

                    return (
                      <div
                        key={tool.id}
                        onClick={() => handleToggleTool(tool.name)}
                        style={{
                          padding: '0.55rem 0.85rem',
                          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.65rem',
                          background: isSelected ? 'rgba(37, 99, 235, 0.07)' : 'transparent',
                          cursor: 'pointer',
                          transition: 'background 0.12s ease'
                        }}
                      >
                        {/* Custom Checkbox */}
                        <div
                          style={{
                            width: '16px',
                            height: '16px',
                            borderRadius: '4px',
                            border: `1px solid ${isSelected ? 'var(--accent-primary, #2563eb)' : 'var(--border-strong, #3f3f46)'}`,
                            background: isSelected ? 'var(--accent-primary, #2563eb)' : 'transparent',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#fff',
                            marginTop: '2px',
                            flexShrink: 0
                          }}
                        >
                          {isSelected && <Check size={11} strokeWidth={3} />}
                        </div>

                        {/* Tool Details */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                            <span
                              style={{
                                fontSize: '0.78rem',
                                fontWeight: 600,
                                color: isSelected ? 'var(--text-bright, #fafafa)' : 'var(--text-main, #e4e4e7)',
                                fontFamily: "'JetBrains Mono', monospace"
                              }}
                            >
                              {tool.name}
                            </span>

                            {isSuggested && (
                              <span
                                style={{
                                  fontSize: '0.64rem',
                                  padding: '0.08rem 0.38rem',
                                  borderRadius: '8px',
                                  background: 'rgba(0, 212, 146, 0.15)',
                                  color: 'var(--accent, #00d492)',
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.2rem'
                                }}
                              >
                                <Sparkles size={9} />
                                Suggested
                              </span>
                            )}

                            {tool.autoApprove ? (
                              <span
                                style={{
                                  fontSize: '0.62rem',
                                  padding: '0.05rem 0.32rem',
                                  borderRadius: '4px',
                                  background: 'rgba(255, 255, 255, 0.05)',
                                  color: 'var(--text-muted, #71717a)'
                                }}
                              >
                                Auto-Approve
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontSize: '0.62rem',
                                  padding: '0.05rem 0.32rem',
                                  borderRadius: '4px',
                                  background: 'rgba(234, 179, 8, 0.12)',
                                  color: 'var(--warning, #eab308)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.2rem'
                                }}
                              >
                                <Shield size={9} />
                                Confirm Required
                              </span>
                            )}
                          </div>

                          <p
                            style={{
                              fontSize: '0.72rem',
                              color: 'var(--text-muted, #71717a)',
                              margin: '0.2rem 0 0 0',
                              lineHeight: 1.35
                            }}
                          >
                            {tool.description}
                          </p>

                          {suggestReason && (
                            <p
                              style={{
                                fontSize: '0.67rem',
                                color: 'var(--accent, #00d492)',
                                margin: '0.2rem 0 0 0',
                                opacity: 0.9,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.25rem'
                              }}
                            >
                              <span>↳ {suggestReason}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '0.75rem 1.15rem',
            borderTop: '1px solid var(--border-subtle, #27272a)',
            background: 'var(--bg-pane, #1a1d25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted, #71717a)' }}>
            Selected: <strong style={{ color: 'var(--text-bright, #fafafa)' }}>{selectedTools.size}</strong> tools
            {selectedTools.size === 0 && ' (Agent will run in read-only baseline mode)'}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                height: '28px',
                padding: '0 0.75rem',
                borderRadius: '6px',
                background: 'var(--card-bg, #181b22)',
                border: '1px solid var(--border-subtle, #27272a)',
                color: 'var(--text-main, #e4e4e7)',
                fontSize: '0.76rem',
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              style={{
                height: '28px',
                padding: '0 0.85rem',
                borderRadius: '6px',
                background: 'var(--accent-primary, #2563eb)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#fff',
                fontSize: '0.76rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem'
              }}
            >
              <Check size={13} />
              <span>Save & Apply Tools</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
