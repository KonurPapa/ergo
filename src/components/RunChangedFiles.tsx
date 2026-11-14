/**
 * The files a task run changed, under its Notes: from git, between the repo as it was when the run's first agent started
 * and the working tree now (so commits the agent made count, and so do edits left uncommitted). Each file opens in the
 * editor; the compare button opens its change as a diff there.
 *
 * Hidden when there's nothing to compare with: the run's folder isn't a git repo, the run started before the bridge
 * recorded starting points (protocol 9), or the bridge is older.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileDiff, FileMinus, FilePlus, GitCompare, RefreshCw } from 'lucide-react';
import { fetchRunChanges, openFileRef, openRunFileDiff, type RunChangedFile, type RunChanges } from '../lib/ideLinks';
import { Button, Icon, IconButton } from './ui';

const COLLAPSED_COUNT = 12;

const STATUS_ICON = { added: FilePlus, deleted: FileMinus, modified: FileDiff, changed: FileDiff } as const;
const STATUS_LABEL = { added: 'Added', deleted: 'Deleted', modified: 'Modified', changed: 'Changed' } as const;

function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

const FileRow: React.FC<{ file: RunChangedFile; runId: string; root?: string }> = ({ file, runId, root }) => {
  const { dir, name } = splitPath(file.path);
  const deleted = file.status === 'deleted';
  return (
    <li className={`eg-runfiles-row is-${file.status}`}>
      <button
        type="button"
        className="eg-runfiles-path"
        aria-label={`${file.path}, ${STATUS_LABEL[file.status].toLowerCase()}`}
        title={deleted ? `${file.path} was deleted. Show what it held` : `Open ${file.path} in your editor`}
        onClick={() => void (deleted ? openRunFileDiff(runId, file.path, { root }) : openFileRef({ path: file.path }, { root }))}
      >
        <Icon icon={STATUS_ICON[file.status]} size="sm" className="eg-runfiles-icon" />
        <span className="eg-runfiles-name">
          {dir && <span className="eg-runfiles-dir">{dir}</span>}
          {name}
        </span>
      </button>
      <span className="eg-runfiles-stat">
        {file.binary ? (
          <span className="eg-subtle">binary</span>
        ) : (
          <>
            <span className="is-add">+{file.additions}</span>
            <span className="is-del">−{file.deletions}</span>
          </>
        )}
      </span>
      <IconButton
        icon={GitCompare}
        size="sm"
        label="Open diff"
        title={`Compare ${file.path} with how it was when the run started, in your editor`}
        onClick={() => void openRunFileDiff(runId, file.path, { root })}
      />
    </li>
  );
};

export const RunChangedFiles: React.FC<{
  runId?: string;
  /** The run is working: the list refreshes when it stops. */
  active?: boolean;
}> = ({ runId, active }) => {
  const [changes, setChanges] = useState<RunChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!runId) return setChanges(null);
    const id = ++requestRef.current;
    setLoading(true);
    const next = await fetchRunChanges(runId);
    if (id !== requestRef.current) return;
    setChanges(next);
    setLoading(false);
  }, [runId]);

  // On open, for another run, and again when the run stops working.
  useEffect(() => {
    setShowAll(false);
    void load();
  }, [load, active]);

  if (!runId || !changes?.baseline) return null;

  const files = changes.files;
  const shown = showAll ? files : files.slice(0, COLLAPSED_COUNT);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <section className="eg-runfiles" aria-label="Changed files">
      <div className="eg-runfiles-head">
        <span className="eg-runfiles-title">Changed files</span>
        {files.length > 0 && (
          <span className="eg-runfiles-total">
            {files.length}
            {changes.truncated ? '+' : ''} · <span className="is-add">+{additions}</span> <span className="is-del">−{deletions}</span>
          </span>
        )}
        <span className="eg-spacer" />
        <IconButton
          icon={RefreshCw}
          size="sm"
          label="Refresh"
          title="Check the files again"
          className={loading ? 'is-loading' : undefined}
          onClick={() => void load()}
        />
      </div>
      {changes.error ? (
        <div className="eg-runfiles-empty">{changes.error}</div>
      ) : files.length === 0 ? (
        <div className="eg-runfiles-empty">{active ? 'No files changed yet.' : 'No files in this folder changed since the run started.'}</div>
      ) : (
        <>
          <ul className="eg-runfiles-list">
            {shown.map((f) => (
              <FileRow key={f.path} file={f} runId={runId} root={changes.root} />
            ))}
          </ul>
          {files.length > COLLAPSED_COUNT && (
            <Button size="sm" variant="ghost" className="eg-runfiles-more" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${files.length}`}
            </Button>
          )}
        </>
      )}
    </section>
  );
};
