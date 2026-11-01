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
import { Wrench, RefreshCw, Search, Shield, Info, Folder, Code, Cloud, Zap, Cpu } from 'lucide-react';
import { Button, Checkbox, Dialog, EmptyState, Icon, Input, SegmentedControl } from './ui';

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
  const size = 14;
  switch (server.iconName) {
    case 'Folder': return <Folder size={size} strokeWidth={1.75} />;
    case 'Code': return <Code size={size} strokeWidth={1.75} />;
    case 'Cloud': return <Cloud size={size} strokeWidth={1.75} />;
    case 'Zap': return <Zap size={size} strokeWidth={1.75} />;
    default: return <Cpu size={size} strokeWidth={1.75} />;
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
    setSyncStatusMessage('Asking connected MCP servers for their tools…');
    try {
      const res = await checkAllMcpUpdates(mcpServers);
      if (onUpdateMcpServers) {
        onUpdateMcpServers(res.updatedServers);
      }
      if (res.hasChanges) {
        setSyncStatusMessage(res.summaryMessage || 'Found tool updates.');
      } else {
        setSyncStatusMessage('All tools are up to date.');
      }
    } catch {
      setSyncStatusMessage('Tool check finished.');
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

  const suggestedCount = relevanceAnalysis.selectedToolIds.length;

  return (
    <Dialog
      title="Tools for this task"
      description={
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 520 }}>
          {task?.id ? `#${task.id} · ` : ''}
          {effectiveTitle}
        </span>
      }
      onClose={onClose}
      width={720}
      className="dlg-mcp-tools"
      headerActions={
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          onClick={handleSyncAllTools}
          disabled={isSyncing}
          className={isSyncing ? 'dlg-spin-icon' : undefined}
          title="Ask every connected MCP server for its current tool list"
        >
          {isSyncing ? 'Checking…' : 'Check for new tools'}
        </Button>
      }
      footer={
        <>
          <span className="eg-subtle" style={{ fontSize: 'calc(12px * var(--type-scale))' }}>
            {selectedTools.size} {selectedTools.size === 1 ? 'tool' : 'tools'} on
            {selectedTools.size === 0 && ' — the agent runs with read-only basics'}
          </span>
          <span className="eg-spacer" />
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={handleSave}>
            Save tools
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {syncStatusMessage && (
          <div className="eg-hstack" role="status" style={{ fontSize: 'calc(12px * var(--type-scale))', color: 'var(--ink-subtle)' }}>
            <Icon icon={Info} size="sm" />
            {syncStatusMessage}
          </div>
        )}

        <div className="eg-hstack" style={{ flexWrap: 'wrap', fontSize: 'calc(12px * var(--type-scale))', color: 'var(--ink-muted)' }}>
          <span>
            {suggestedCount} {suggestedCount === 1 ? 'tool fits' : 'tools fit'} this task’s brief.
          </span>
          <span className="eg-spacer" />
          <Button size="sm" onClick={handleApplySuggested} disabled={suggestedCount === 0}>
            Use suggested ({suggestedCount})
          </Button>
          <Button variant="ghost" size="sm" onClick={handleSelectAll}>
            All
          </Button>
          <Button variant="ghost" size="sm" onClick={handleClearAll}>
            None
          </Button>
        </div>

        <div className="eg-hstack" style={{ flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Input icon={Search} placeholder="Search tools by name or purpose" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </div>
          <select className="eg-input" style={{ width: 'auto' }} value={selectedServerFilter} onChange={(e) => setSelectedServerFilter(e.target.value)} aria-label="Server">
            <option value="all">All servers ({connectedServers.length})</option>
            {connectedServers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.tools.length})
              </option>
            ))}
          </select>
          <SegmentedControl<'all' | 'suggested'>
            label="Show"
            value={showSuggestedOnly ? 'suggested' : 'all'}
            onChange={(v) => setShowSuggestedOnly(v === 'suggested')}
            options={[
              { id: 'all', label: 'All' },
              { id: 'suggested', label: 'Suggested' }
            ]}
          />
        </div>

        {connectedServers.length === 0 ? (
          <EmptyState icon={Wrench} title="No MCP servers connected" text="Connect a server in Settings › Integrations to give tasks more tools." />
        ) : Object.keys(toolsByServer).length === 0 ? (
          <EmptyState icon={Search} title="No tools match" text="Try another search or server." />
        ) : (
          Object.values(toolsByServer).map(({ server, tools }) => (
            <section key={server.id}>
              <div className="eg-section-label" style={{ margin: 'var(--space-2) 0 var(--space-1)' }}>
                <span className="eg-icon eg-icon-sm" aria-hidden="true">{renderServerMiniIcon(server)}</span>
                <span style={{ color: 'var(--ink-muted)' }}>{server.name}</span>
                <span className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>{server.transport}</span>
                <span className="eg-spacer" />
                <span style={{ fontWeight: 400 }}>
                  {tools.filter((t) => selectedTools.has(t.name)).length} of {tools.length} on
                </span>
              </div>
              <div className="dlg-rows">
                {tools.map((tool) => {
                  const isSelected = selectedTools.has(tool.name);
                  const isSuggested = relevanceAnalysis.selectedToolIds.includes(tool.id);
                  const suggestReason = relevanceAnalysis.reasons[tool.id];
                  return (
                    <label key={tool.id} className="dlg-row">
                      <Checkbox checked={isSelected} onChange={() => handleToggleTool(tool.name)} style={{ marginTop: 3 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="eg-hstack" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                          <span className="eg-mono" style={{ color: 'var(--ink)' }}>{tool.name}</span>
                          {isSuggested && <span className="eg-subtle" style={{ fontSize: 'calc(12px * var(--type-scale))' }}>Suggested</span>}
                          {!tool.autoApprove && (
                            <span className="eg-hstack eg-subtle" style={{ fontSize: 'calc(12px * var(--type-scale))', gap: 4 }} title="Ergo asks you before each use">
                              <Icon icon={Shield} size="sm" />
                              Asks first
                            </span>
                          )}
                        </span>
                        {tool.description && <span className="dlg-row-text">{tool.description}</span>}
                        {suggestReason && <span className="dlg-row-text">{suggestReason}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </Dialog>
  );
};
