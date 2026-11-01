import React, { useState, useRef } from 'react';
import { CircleCheck, CircleX, FolderOpen, FileText } from 'lucide-react';
import { Button, Dialog, Field, Icon, Input } from './ui';
import { createSlug } from '../lib/demoData';
import { importedLanes, type ImportedLane } from '../lib/markdownImport';
import { type ProjectData } from '../types';

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProject: (
    name: string,
    customFolder: string,
    description: string,
    initialTodoContent?: string,
    /** Swim lanes beyond TODO.md, from a markdown import. */
    extraLanes?: ImportedLane[]
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
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Markdown files to import: the first becomes TODO.md, each other one a swim lane.
  const [imported, setImported] = useState<ImportedLane[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

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

    if (!found.todoMarkdown) {
      setDuplicateError(`“${found.name}” has no TODO.md content to copy.`);
      setDuplicatedSource(null);
      return;
    }

    setDuplicateError(null);
    setImported(null);
    setDuplicatedSource({
      name: found.name,
      todoContent: found.todoMarkdown
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
    }

    if (!todoFile) {
      setDuplicateError(
        "That folder has no TODO.md, so there is nothing to copy. Choose a folder that contains one."
      );
      setDuplicatedSource(null);
      e.target.value = '';
      return;
    }

    try {
      const todoText = await todoFile.text();

      const sourceTitle = folderBaseName
        ? folderBaseName.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        : 'Imported Project';

      setDuplicatedSource({
        name: sourceTitle,
        todoContent: todoText
      });

      if (!name.trim()) {
        setName(`${sourceTitle} (Copy)`);
        if (!isFolderTouched) {
          setFolderName(createSlug(`${sourceTitle}-copy`));
        }
      }
    } catch (err: any) {
      setDuplicateError(`Ergo couldn’t read that folder (${err?.message}).`);
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

            try {
              const todoHandle = await handle.getFileHandle('TODO.md');
              const todoFile = await todoHandle.getFile();
              todoText = await todoFile.text();
            } catch {
              setDuplicateError(
                `“${handle.name}” has no TODO.md, so there is nothing to copy. Choose a folder that contains one.`
              );
              setDuplicatedSource(null);
              return;
            }

            const formattedName = handle.name
              .replace(/[-_]/g, ' ')
              .replace(/\b\w/g, (c: string) => c.toUpperCase());

            setDuplicatedSource({
              name: formattedName,
              todoContent: todoText
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

  const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    try {
      const lanes = importedLanes(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
      setImported(lanes);
      setImportError(null);
      setDuplicatedSource(null);
      setDuplicateError(null);
      if (!name.trim()) {
        setName(lanes[0].title);
        if (!isFolderTouched) setFolderName(createSlug(lanes[0].title));
      }
    } catch (err: any) {
      setImportError(`Ergo couldn’t read those files (${err?.message || err}).`);
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
      imported ? imported[0].markdown : duplicatedSource?.todoContent,
      imported ? imported.slice(1) : undefined
    );
    setImported(null);
    setName('');
    setFolderName('');
    setDescription('');
    setIsFolderTouched(false);
    setDuplicatedSource(null);
    setDuplicateError(null);
    onClose();
  };

  const formId = 'create-project-form';

  return (
    <Dialog
      title="New project"
      description="A project is a folder with its own TODO.md."
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="eg-spacer" />
          <Button variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" type="submit" form={formId} disabled={!name.trim()}>
            Create project
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Field label="Name">
          <Input
            type="text"
            placeholder="Client portal, takeoff engine…"
            value={name}
            onChange={handleNameChange}
            required
            autoFocus
            style={{ height: 'var(--size-control-lg)' }}
          />
        </Field>

        <label className="eg-field">
          <span className="eg-field-label">Folder</span>
          <span className="dlg-prefix-input">
            <span className="dlg-prefix-input-prefix">{mountPrefix}</span>
            <input type="text" placeholder="project-folder" value={folderName} onChange={handleFolderChange} spellCheck={false} />
          </span>
          <span className="eg-field-help">
            Projects live under <span className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>{mountPoint}</span>
          </span>
        </label>

        <div>
          <div className="eg-section-label" style={{ marginTop: 'var(--space-2)' }}>Import from markdown (optional)</div>
          <p style={{ margin: '0 0 var(--space-2)', fontSize: 'calc(12px * var(--type-scale))', lineHeight: 'calc(16px * var(--type-scale))' }}>
            Start from your own <code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>.md</code> files: the first becomes the task list, each other file
            a swim lane. Checklists (<code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>- [ ]</code>,{' '}
            <code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>- [x]</code>) become tasks, done ones checked off.
          </p>
          <div className="eg-hstack">
            <Button icon={FileText} onClick={() => importInputRef.current?.click()}>
              {imported ? 'Choose other files…' : 'Choose markdown files…'}
            </Button>
            {imported && (
              <Button variant="ghost" onClick={() => setImported(null)}>
                Clear
              </Button>
            )}
          </div>
          <input
            type="file"
            ref={importInputRef}
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            multiple
            onChange={handleImportFiles}
            style={{ display: 'none' }}
          />
          {importError && (
            <div className="eg-field-error" style={{ marginTop: 'var(--space-2)' }} role="alert">
              <Icon icon={CircleX} size="sm" />
              {importError}
            </div>
          )}
        </div>

        <div>
          <div className="eg-section-label" style={{ marginTop: 'var(--space-2)' }}>
            Copy an existing project (optional)
            <span className="eg-spacer" />
            {duplicatedSource && (
              <Button variant="ghost" size="sm" onClick={handleClearDuplicate}>
                Clear
              </Button>
            )}
          </div>
          <p style={{ margin: '0 0 var(--space-2)', fontSize: 'calc(12px * var(--type-scale))', lineHeight: 'calc(16px * var(--type-scale))' }}>
            Copies that project’s <code className="eg-mono" style={{ fontSize: 'calc(11px * var(--type-scale))' }}>TODO.md</code> into the new project.
          </p>
          <div className="eg-hstack">
            {existingProjects.length > 0 && (
              <select className="eg-input" style={{ flex: 1 }} value="" onChange={(e) => handleSelectWorkspaceProject(e.target.value)}>
                <option value="" disabled>
                  Choose a project…
                </option>
                {existingProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.folderPath})
                  </option>
                ))}
              </select>
            )}
            <Button icon={FolderOpen} onClick={handleBrowseFilesystemDuplicate} disabled={isPicking} title="Choose a project folder on disk to copy">
              {isPicking ? 'Opening…' : 'Browse…'}
            </Button>
          </div>

          {/* Hidden native directory input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
            {...({ webkitdirectory: '', directory: '', multiple: true } as any)}
          />

          {duplicateError && (
            <div className="eg-field-error" style={{ marginTop: 'var(--space-2)', alignItems: 'flex-start' }} role="alert">
              <Icon icon={CircleX} size="sm" style={{ marginTop: 1 }} />
              {duplicateError}
            </div>
          )}

          {duplicatedSource && (
            <div className="eg-hstack" style={{ marginTop: 'var(--space-2)', fontSize: 'calc(12px * var(--type-scale))' }}>
              <Icon icon={CircleCheck} size="sm" style={{ color: 'var(--success)' }} />
              <span style={{ color: 'var(--ink)' }}>Copying {duplicatedSource.name}</span>
              <span className="eg-subtle">TODO.md found</span>
            </div>
          )}
        </div>

        <div>
          <div className="eg-section-label" style={{ marginTop: 'var(--space-2)' }}>Files to create</div>
          <div className="dlg-tree">
            <div style={{ color: 'var(--ink)' }}>{displayFolderPath}/</div>
            <div style={{ paddingLeft: 18 }}>
              <span style={{ color: 'var(--ink-muted)' }}>{todoPath}</span>
              <span style={{ color: 'var(--ink-subtle)' }}>
                {'  '}
                {imported ? `imported from ${imported[0].title}` : duplicatedSource ? `copied from ${duplicatedSource.name}` : 'your task list'}
              </span>
            </div>
            {imported?.slice(1).map((lane) => (
              <div key={lane.fileName} style={{ paddingLeft: 18 }}>
                <span style={{ color: 'var(--ink-muted)' }}>
                  {displayFolderPath}/{lane.fileName}
                </span>
                <span style={{ color: 'var(--ink-subtle)' }}>{'  '}swim lane: {lane.title}</span>
              </div>
            ))}
          </div>
        </div>
      </form>
    </Dialog>
  );
};
