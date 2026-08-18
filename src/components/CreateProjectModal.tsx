import React, { useState, useRef } from 'react';
import {
  FolderPlus,
  X,
  Folder,
  FileText,
  CheckSquare,
  Copy,
  AlertCircle,
  CheckCircle2,
  FolderOpen
} from 'lucide-react';
import { createSlug } from '../lib/demoData';
import { type ProjectData } from '../types';

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProject: (
    name: string,
    customFolder: string,
    description: string,
    initialTodoContent?: string,
    initialAgentContextContent?: string
  ) => void;
  storageDirectory?: string;
  existingProjects?: ProjectData[];
}

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({
  isOpen,
  onClose,
  onCreateProject,
  storageDirectory = '.ergo',
  existingProjects = []
}) => {
  const [name, setName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [description, setDescription] = useState('');
  const [isFolderTouched, setIsFolderTouched] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicatedSource, setDuplicatedSource] = useState<{
    name: string;
    todoContent: string;
    agentContextContent: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const currentSlug = createSlug(isFolderTouched ? folderName : name);
  const normalizedStorage = storageDirectory.startsWith('~/')
    ? storageDirectory.slice(2)
    : storageDirectory.startsWith('/')
      ? storageDirectory.replace(/^\/+/, '')
      : storageDirectory;
  const mountPoint = `${normalizedStorage || '.ergo'}/projects`;
  const mountPrefix = `${mountPoint}/`;

  const displayFolderPath = currentSlug;
  const todoPath = `${displayFolderPath}/TODO.md`;
  const agentPath = `${displayFolderPath}/AGENT_CONTEXT.md`;

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

  // Handle duplication selection from workspace existing projects
  const handleSelectWorkspaceProject = (projectId: string) => {
    if (!projectId) {
      setDuplicatedSource(null);
      setDuplicateError(null);
      return;
    }
    const found = existingProjects.find((p) => p.id === projectId);
    if (!found) return;

    if (!found.todoMarkdown || !found.agentContextMarkdown) {
      setDuplicateError(`Selected project "${found.name}" is missing required markdown content.`);
      setDuplicatedSource(null);
      return;
    }

    setDuplicateError(null);
    setDuplicatedSource({
      name: found.name,
      todoContent: found.todoMarkdown,
      agentContextContent: found.agentContextMarkdown
    });

    if (!name.trim()) {
      setName(`${found.name} (Copy)`);
      if (!isFolderTouched) {
        setFolderName(createSlug(`${found.name}-copy`));
      }
    }
  };

  // Handle files selected via native OS filesystem directory picker
  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    setDuplicateError(null);

    if (!files || files.length === 0) return;

    let todoFile: File | null = null;
    let agentFile: File | null = null;
    let folderBaseName = '';

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const relPath = (f as any).webkitRelativePath || f.name;
      const parts = relPath.split('/');
      if (parts.length > 1 && !folderBaseName) {
        folderBaseName = parts[0];
      }

      if (f.name === 'TODO.md') {
        todoFile = f;
      }
      if (f.name === 'AGENT_CONTEXT.md') {
        agentFile = f;
      }
    }

    if (!todoFile || !agentFile) {
      const missing = [];
      if (!todoFile) missing.push('TODO.md');
      if (!agentFile) missing.push('AGENT_CONTEXT.md');
      setDuplicateError(
        `Selection rejected: Selected folder is missing ${missing.join(' and ')}. Both exact files ('TODO.md' and 'AGENT_CONTEXT.md') must exist to duplicate.`
      );
      setDuplicatedSource(null);
      e.target.value = '';
      return;
    }

    try {
      const [todoText, agentText] = await Promise.all([todoFile.text(), agentFile.text()]);

      const sourceTitle = folderBaseName
        ? folderBaseName.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        : 'Imported Project';

      setDuplicatedSource({
        name: sourceTitle,
        todoContent: todoText,
        agentContextContent: agentText
      });

      if (!name.trim()) {
        setName(`${sourceTitle} (Copy)`);
        if (!isFolderTouched) {
          setFolderName(createSlug(`${sourceTitle}-copy`));
        }
      }
    } catch (err: any) {
      setDuplicateError(`Failed to read files from selected folder: ${err?.message}`);
      setDuplicatedSource(null);
    }

    e.target.value = '';
  };

  // Browse filesystem folder for duplication
  const handleBrowseFilesystemDuplicate = async () => {
    setIsPicking(true);
    setDuplicateError(null);

    try {
      if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
        try {
          const handle = await (window as any).showDirectoryPicker({
            mode: 'read'
          });
          if (handle && handle.name) {
            let todoText = '';
            let agentText = '';

            try {
              const todoHandle = await handle.getFileHandle('TODO.md');
              const todoFile = await todoHandle.getFile();
              todoText = await todoFile.text();
            } catch {
              setDuplicateError(
                `Selection rejected: Selected folder "${handle.name}" is missing TODO.md. Both 'TODO.md' and 'AGENT_CONTEXT.md' must exist to duplicate.`
              );
              setDuplicatedSource(null);
              return;
            }

            try {
              const agentHandle = await handle.getFileHandle('AGENT_CONTEXT.md');
              const agentFile = await agentHandle.getFile();
              agentText = await agentFile.text();
            } catch {
              setDuplicateError(
                `Selection rejected: Selected folder "${handle.name}" is missing AGENT_CONTEXT.md. Both 'TODO.md' and 'AGENT_CONTEXT.md' must exist to duplicate.`
              );
              setDuplicatedSource(null);
              return;
            }

            const formattedName = handle.name
              .replace(/[-_]/g, ' ')
              .replace(/\b\w/g, (c: string) => c.toUpperCase());

            setDuplicatedSource({
              name: formattedName,
              todoContent: todoText,
              agentContextContent: agentText
            });

            if (!name.trim()) {
              setName(`${formattedName} (Copy)`);
              if (!isFolderTouched) {
                setFolderName(createSlug(`${formattedName}-copy`));
              }
            }
            return;
          }
        } catch (err: any) {
          if (err?.name === 'AbortError') {
            return;
          }
          // Fallback to hidden directory file input
          fileInputRef.current?.click();
          return;
        }
      }

      // Universal fallback
      fileInputRef.current?.click();
    } finally {
      setIsPicking(false);
    }
  };

  const handleClearDuplicate = () => {
    setDuplicatedSource(null);
    setDuplicateError(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreateProject(
      name.trim(),
      currentSlug,
      description.trim(),
      duplicatedSource?.todoContent,
      duplicatedSource?.agentContextContent
    );
    setName('');
    setFolderName('');
    setDescription('');
    setIsFolderTouched(false);
    setDuplicatedSource(null);
    setDuplicateError(null);
    onClose();
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content" style={{ maxWidth: '640px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <FolderPlus size={22} color="var(--accent-cyan)" />
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Create New Project</h3>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-bright)' }}>
                  Folder Path
                </label>
                <span style={{ fontSize: '0.72rem', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
                  Mount: {mountPoint}
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: 'var(--bg-darkest)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '6px',
                  padding: '0.4rem 0.75rem',
                  gap: '0.45rem'
                }}
              >
                <Folder size={16} color="var(--accent-amber)" />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {mountPrefix}
                </span>
                <input
                  type="text"
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: 'var(--accent-cyan)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.88rem',
                    minWidth: '80px'
                  }}
                  placeholder="project-folder-slug"
                  value={folderName}
                  onChange={handleFolderChange}
                />
              </div>
            </div>

            {/* Optional Project Duplication Section */}
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '0.85rem'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                  <Copy size={15} color="var(--accent-violet)" />
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>
                    Duplicate from Existing Project (Optional)
                  </span>
                </div>
                {duplicatedSource && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem' }}
                    onClick={handleClearDuplicate}
                  >
                    Clear Selection
                  </button>
                )}
              </div>

              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.65rem', lineHeight: '1.4' }}>
                Select an existing project to copy its exact <code style={{ color: 'var(--accent-cyan)' }}>TODO.md</code> and <code style={{ color: 'var(--accent-violet)' }}>AGENT_CONTEXT.md</code> files into the new project.
              </p>

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {existingProjects.length > 0 && (
                  <select
                    className="input-text"
                    style={{ flex: 1, fontSize: '0.82rem', padding: '0.4rem 0.6rem' }}
                    value=""
                    onChange={(e) => handleSelectWorkspaceProject(e.target.value)}
                  >
                    <option value="" disabled>
                      Select from workspace projects...
                    </option>
                    {existingProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.folderPath})
                      </option>
                    ))}
                  </select>
                )}

                {/* <button
                  type="button"
                  className="btn btn-secondary"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    padding: '0.4rem 0.8rem',
                    fontSize: '0.82rem',
                    whiteSpace: 'nowrap'
                  }}
                  onClick={handleBrowseFilesystemDuplicate}
                  disabled={isPicking}
                  title="Browse local project folder from filesystem to duplicate"
                >
                  <FolderOpen size={15} color="var(--accent-cyan)" />
                  <span>{isPicking ? 'Opening...' : 'Browse...'}</span>
                </button> */}
              </div>

              {/* Hidden Native Directory Input */}
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileInputChange}
                style={{ display: 'none' }}
                {...({ webkitdirectory: '', directory: '', multiple: true } as any)}
              />

              {/* Error Notice if missing TODO.md or AGENT_CONTEXT.md */}
              {duplicateError && (
                <div
                  style={{
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    padding: '0.6rem 0.8rem',
                    borderRadius: '6px',
                    color: '#f87171',
                    fontSize: '0.78rem',
                    marginTop: '0.65rem',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.45rem'
                  }}
                >
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                  <span>{duplicateError}</span>
                </div>
              )}

              {/* Active Duplication Badge */}
              {duplicatedSource && (
                <div
                  style={{
                    background: 'rgba(16, 185, 129, 0.08)',
                    border: '1px solid rgba(16, 185, 129, 0.25)',
                    padding: '0.55rem 0.8rem',
                    borderRadius: '6px',
                    color: '#fff',
                    fontSize: '0.78rem',
                    marginTop: '0.65rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem'
                  }}
                >
                  <CheckCircle2 size={15} color="var(--accent-emerald)" />
                  <div style={{ flex: 1 }}>
                    <span style={{ color: 'var(--accent-emerald)', fontWeight: 600 }}>
                      Duplicating from: {duplicatedSource.name}
                    </span>
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.4rem', fontSize: '0.72rem' }}>
                      (Both TODO.md & AGENT_CONTEXT.md verified)
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Generated Directory & File Linking Preview */}
            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--accent-emerald)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Files to be created
                </span>
                {duplicatedSource && (
                  <span style={{ fontSize: '0.72rem', color: 'var(--accent-violet)', fontWeight: 600 }}>
                    Cloning {duplicatedSource.name}
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontFamily: 'var(--font-mono)', fontSize: '0.82rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-bright)' }}>
                  <Folder size={14} color="var(--accent-amber)" />
                  <span>{displayFolderPath}/</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-cyan)', paddingLeft: '1.2rem' }}>
                  <CheckSquare size={13} color="var(--accent-cyan)" />
                  <span>{todoPath}</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {duplicatedSource ? '(Copied from source)' : '(Human Tasks List)'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-violet)', paddingLeft: '1.2rem' }}>
                  <FileText size={13} color="var(--accent-violet)" />
                  <span>{agentPath}</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {duplicatedSource ? '(Copied from source)' : '(Agent Technical Briefs)'}
                  </span>
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
              <span>Create Project</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};


