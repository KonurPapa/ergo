import React, { useState, useEffect } from 'react';
import { Code2, X, Save, FileText, CheckSquare, Download } from 'lucide-react';

interface RawMarkdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  todoMarkdown: string;
  agentContextMarkdown: string;
  folderPath?: string;
  todoFilePath?: string;
  agentContextFilePath?: string;
  onSaveMarkdown: (newTodoMd: string, newAgentContextMd: string) => void;
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
  onSaveMarkdown,
  onExportProject
}) => {
  const [activeTab, setActiveTab] = useState<'todo' | 'agent'>('todo');
  const [todoVal, setTodoVal] = useState(todoMarkdown);
  const [agentVal, setAgentVal] = useState(agentContextMarkdown);

  useEffect(() => {
    setTodoVal(todoMarkdown);
    setAgentVal(agentContextMarkdown);
  }, [todoMarkdown, agentContextMarkdown]);

  if (!isOpen) return null;

  const handleSave = () => {
    onSaveMarkdown(todoVal, agentVal);
    onClose();
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
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Preview & Sync Raw Markdown</h3>
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

        {/* Tab Headers */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-darkest)', padding: '0 1rem' }}>
          <button
            style={{
              padding: '0.65rem 1.25rem',
              background: activeTab === 'todo' ? 'var(--bg-card)' : 'transparent',
              color: activeTab === 'todo' ? '#fff' : 'var(--text-muted)',
              border: 'none',
              borderBottom: activeTab === 'todo' ? '2px solid var(--accent-cyan)' : '2px solid transparent',
              fontWeight: 600,
              fontSize: '0.88rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}
            onClick={() => setActiveTab('todo')}
          >
            <CheckSquare size={16} color="var(--accent-cyan)" />
            <span>{todoFilePath || 'TODO.md'} (Your Tasks)</span>
          </button>

          <button
            style={{
              padding: '0.65rem 1.25rem',
              background: activeTab === 'agent' ? 'var(--bg-card)' : 'transparent',
              color: activeTab === 'agent' ? '#fff' : 'var(--text-muted)',
              border: 'none',
              borderBottom: activeTab === 'agent' ? '2px solid var(--accent-violet)' : '2px solid transparent',
              fontWeight: 600,
              fontSize: '0.88rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}
            onClick={() => setActiveTab('agent')}
          >
            <FileText size={16} color="var(--accent-violet)" />
            <span>{agentContextFilePath || 'AGENT_CONTEXT.md'} (AI Canvas)</span>
          </button>
        </div>

        <div className="modal-body" style={{ padding: 0, display: 'flex', flex: 1 }}>
          {activeTab === 'todo' ? (
            <textarea
              className="textarea-text"
              style={{ flex: 1, border: 'none', borderRadius: 0, padding: '1.25rem', fontFamily: 'var(--font-mono)', fontSize: '0.88rem', lineHeight: '1.6', background: 'var(--bg-darkest)' }}
              value={todoVal}
              onChange={(e) => setTodoVal(e.target.value)}
            />
          ) : (
            <textarea
              className="textarea-text"
              style={{ flex: 1, border: 'none', borderRadius: 0, padding: '1.25rem', fontFamily: 'var(--font-mono)', fontSize: '0.88rem', lineHeight: '1.6', background: 'var(--bg-darkest)' }}
              value={agentVal}
              onChange={(e) => setAgentVal(e.target.value)}
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
              <span>Download Files</span>
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
