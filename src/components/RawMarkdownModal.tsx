import React, { useState, useEffect } from 'react';
import { Code2, X, Save, FileText, CheckSquare, Download } from 'lucide-react';
import { handleMarkdownAutoWrap } from '../lib/markdownEditorUtils';
import { type SwimLaneDoc } from '../types';

interface RawMarkdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  todoMarkdown: string;
  agentContextMarkdown: string;
  folderPath?: string;
  todoFilePath?: string;
  agentContextFilePath?: string;
  swimLanes?: SwimLaneDoc[];
  onSaveMarkdown: (newTodoMd: string, newAgentContextMd: string, updatedSwimLanes?: SwimLaneDoc[]) => void;
  onExportProject?: () => void;
}

export const RawMarkdownModal: React.FC<RawMarkdownModalProps> = ({
  isOpen,
  onClose,
  todoMarkdown,
  agentContextMarkdown,
  folderPath,
  todoFilePath,
  agentContextFilePath,
  swimLanes,
  onSaveMarkdown,
  onExportProject
}) => {
  const effectiveLanes: SwimLaneDoc[] = React.useMemo(() => {
    if (swimLanes && swimLanes.length > 0) return swimLanes;
    return [{
      id: 'todo',
      title: 'TODO.md',
      filePath: todoFilePath || 'TODO.md',
      markdown: todoMarkdown
    }];
  }, [swimLanes, todoFilePath, todoMarkdown]);

  const [activeTab, setActiveTab] = useState<string>(effectiveLanes[0]?.id || 'todo');
  const [laneValues, setLaneValues] = useState<Record<string, string>>({});
  const [agentVal, setAgentVal] = useState(agentContextMarkdown);

  useEffect(() => {
    const vals: Record<string, string> = {};
    for (const lane of effectiveLanes) {
      vals[lane.id] = lane.markdown;
    }
    setLaneValues(vals);
    setAgentVal(agentContextMarkdown);
    if (!vals[activeTab] && activeTab !== 'agent') {
      setActiveTab(effectiveLanes[0]?.id || 'todo');
    }
  }, [effectiveLanes, agentContextMarkdown]);

  if (!isOpen) return null;

  const handleSave = () => {
    const updatedLanes = effectiveLanes.map((lane) => ({
      ...lane,
      markdown: laneValues[lane.id] !== undefined ? laneValues[lane.id] : lane.markdown
    }));
    const primaryTodoMd = laneValues[effectiveLanes[0]?.id] !== undefined
      ? laneValues[effectiveLanes[0].id]
      : todoMarkdown;

    onSaveMarkdown(primaryTodoMd, agentVal, updatedLanes);
    onClose();
  };

  const handleLaneChange = (laneId: string, val: string) => {
    setLaneValues((prev) => ({ ...prev, [laneId]: val }));
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content" style={{ maxWidth: '1000px', height: '85vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Code2 size={22} color="var(--accent-cyan)" />
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Workspace Raw Markdown Files</h3>
              {folderPath && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  Main Folder: <span style={{ color: 'var(--accent-cyan)' }}>{folderPath}</span>
                </div>
              )}
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Tab Headers for all swim lanes + AGENT_CONTEXT.md */}
        <div style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-darkest)', padding: '0 1rem' }}>
          {effectiveLanes.map((lane) => {
            const fileName = lane.filePath ? lane.filePath.split('/').pop() || lane.title : lane.title;
            const isActive = activeTab === lane.id;
            return (
              <button
                key={lane.id}
                style={{
                  padding: '0.65rem 1.1rem',
                  background: isActive ? 'var(--bg-card)' : 'transparent',
                  color: isActive ? '#fff' : 'var(--text-muted)',
                  border: 'none',
                  borderBottom: isActive ? '2px solid var(--accent-cyan)' : '2px solid transparent',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  whiteSpace: 'nowrap'
                }}
                onClick={() => setActiveTab(lane.id)}
              >
                <CheckSquare size={15} color="var(--accent-cyan)" />
                <span>{fileName}</span>
              </button>
            );
          })}

          <button
            style={{
              padding: '0.65rem 1.1rem',
              background: activeTab === 'agent' ? 'var(--bg-card)' : 'transparent',
              color: activeTab === 'agent' ? '#fff' : 'var(--text-muted)',
              border: 'none',
              borderBottom: activeTab === 'agent' ? '2px solid var(--accent-violet)' : '2px solid transparent',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              whiteSpace: 'nowrap'
            }}
            onClick={() => setActiveTab('agent')}
          >
            <FileText size={15} color="var(--accent-violet)" />
            <span>{agentContextFilePath ? agentContextFilePath.split('/').pop() : 'AGENT_CONTEXT.md'}</span>
          </button>
        </div>

        {/* Modal Textarea Body */}
        <div className="modal-body" style={{ padding: 0, display: 'flex', flex: 1 }}>
          {activeTab === 'agent' ? (
            <textarea
              className="textarea-text"
              style={{ flex: 1, border: 'none', borderRadius: 0, padding: '1.25rem', fontFamily: 'var(--font-mono)', fontSize: '0.88rem', lineHeight: '1.6', background: 'var(--bg-darkest)' }}
              value={agentVal}
              onChange={(e) => setAgentVal(e.target.value)}
              onKeyDown={(e) => handleMarkdownAutoWrap(e, setAgentVal)}
            />
          ) : (
            <textarea
              className="textarea-text"
              style={{ flex: 1, border: 'none', borderRadius: 0, padding: '1.25rem', fontFamily: 'var(--font-mono)', fontSize: '0.88rem', lineHeight: '1.6', background: 'var(--bg-darkest)' }}
              value={laneValues[activeTab] ?? ''}
              onChange={(e) => handleLaneChange(activeTab, e.target.value)}
              onKeyDown={(e) => {
                const setter = (valOrFn: string | ((prev: string) => string)) => {
                  if (typeof valOrFn === 'function') {
                    setLaneValues((prev) => ({ ...prev, [activeTab]: valOrFn(prev[activeTab] ?? '') }));
                  } else {
                    setLaneValues((prev) => ({ ...prev, [activeTab]: valOrFn }));
                  }
                };
                handleMarkdownAutoWrap(e, setter);
              }}
            />
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {onExportProject && (
            <button className="btn btn-primary" onClick={onExportProject}>
              <Download size={16} />
              <span>Download All Files</span>
            </button>
          )}
          <button className="btn btn-emerald" onClick={handleSave}>
            <Save size={16} />
            <span>Save & Synchronize</span>
          </button>
        </div>
      </div>
    </div>
  );
};
