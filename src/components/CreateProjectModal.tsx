import React, { useState } from 'react';
import { FolderPlus, X, Folder, FileText, CheckSquare, Sparkles } from 'lucide-react';
import { createSlug } from '../lib/demoData';

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProject: (name: string, customFolder: string, description: string) => void;
}

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({
  isOpen,
  onClose,
  onCreateProject
}) => {
  const [name, setName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [description, setDescription] = useState('');
  const [isFolderTouched, setIsFolderTouched] = useState(false);

  if (!isOpen) return null;

  const currentSlug = createSlug(isFolderTouched ? folderName : name);
  const targetFolderPath = `projects/${currentSlug}`;
  const todoPath = `${targetFolderPath}/TODO.md`;
  const agentPath = `${targetFolderPath}/AGENT_CONTEXT.md`;

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setName(val);
    if (!isFolderTouched) {
      setFolderName(createSlug(val));
    }
  };

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFolderName(e.target.value);
    setIsFolderTouched(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreateProject(name.trim(), currentSlug, description.trim());
    setName('');
    setFolderName('');
    setDescription('');
    setIsFolderTouched(false);
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '640px' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <FolderPlus size={22} color="var(--accent-cyan)" />
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Create New Linked Project</h3>
          </div>
          <button className="btn btn-secondary" style={{ padding: '0.3rem 0.5rem' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ gap: '1.2rem', display: 'flex', flexDirection: 'column' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-bright)', marginBottom: '0.4rem' }}>
                Project Name
              </label>
              <input
                type="text"
                className="input-text"
                placeholder="e.g. Next.js SaaS Platform, Client Portal, Takeoff Engine..."
                value={name}
                onChange={handleNameChange}
                required
                autoFocus
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-bright)', marginBottom: '0.4rem' }}>
                Main Directory Path (inside main `projects/` folder)
              </label>
              <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-darkest)', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '0.4rem 0.75rem', gap: '0.5rem' }}>
                <Folder size={16} color="var(--accent-amber)" />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--text-muted)' }}>projects/</span>
                <input
                  type="text"
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: 'var(--accent-cyan)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.88rem'
                  }}
                  placeholder="project-folder-slug"
                  value={folderName}
                  onChange={handleFolderChange}
                />
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                This creates an isolated project directory to keep files unique and prevent cross-referencing.
              </p>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-bright)', marginBottom: '0.4rem' }}>
                Description (Optional)
              </label>
              <input
                type="text"
                className="input-text"
                placeholder="Brief summary of project goals..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Generated Directory & File Linking Preview */}
            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
                <Sparkles size={14} color="var(--accent-emerald)" />
                <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--accent-emerald)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Project File & Directory Structure
                </span>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-bright)' }}>
                  <Folder size={14} color="var(--accent-amber)" />
                  <span>{targetFolderPath}/</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-cyan)', paddingLeft: '1.2rem' }}>
                  <CheckSquare size={13} color="var(--accent-cyan)" />
                  <span>{todoPath}</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>(Human Tasks List)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-violet)', paddingLeft: '1.2rem' }}>
                  <FileText size={13} color="var(--accent-violet)" />
                  <span>{agentPath}</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>(Agent Technical Briefs)</span>
                </div>
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              <FolderPlus size={16} />
              <span>Create Project Directory</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
