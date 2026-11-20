/**
 * The files a task run changed: from git, between the repo as it was when the run's first agent started
 * and the working tree now. Supports inline diff expansion, the full in-app VisualDiffModal, 1-click per-file
 * discard, and 1-click full run rollback, while keeping external editor links one click away.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  ExternalLink,
  FileDiff,
  FileMinus,
  FilePlus,
  GitCompare,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import {
  bridgeSupportsVisualDiff,
  fetchRunChanges,
  fetchRunDiff,
  openFileRef,
  openRunFileDiff,
  revertRunChanges,
  revertRunFile,
  showAppToast,
  type RunChangedFile,
  type RunChanges,
} from '../lib/ideLinks';
import { askConfirm, Button, Icon, IconButton } from './ui';
import { InlineDiffView, VisualDiffModal } from './VisualDiffModal';

const COLLAPSED_COUNT = 12;

const STATUS_ICON = { added: FilePlus, deleted: FileMinus, modified: FileDiff, changed: FileDiff } as const;
const STATUS_LABEL = { added: 'Added', deleted: 'Deleted', modified: 'Modified', changed: 'Changed' } as const;

function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

const FileRow: React.FC<{
  file: RunChangedFile;
  runId: string;
  root?: string;
  active?: boolean;
  canInAppDiff: boolean;
  expanded: boolean;
  diffText?: string;
  diffLoading?: boolean;
  reverting?: boolean;
  onToggleExpand: () => void;
  onOpenVisualDiff: () => void;
  onDiscard: () => void;
}> = ({
  file,
  runId,
  root,
  active,
  canInAppDiff,
  expanded,
  diffText,
  diffLoading,
  reverting,
  onToggleExpand,
  onOpenVisualDiff,
  onDiscard,
}) => {
  const { dir, name } = splitPath(file.path);
  const deleted = file.status === 'deleted';
  return (
    <li className={`eg-runfiles-item is-${file.status} ${expanded ? 'is-expanded' : ''}`}>
      <div className={`eg-runfiles-row is-${file.status}`}>
        {canInAppDiff && (
          <button
            type="button"
            className="eg-runfiles-chevron"
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse diff for ${file.path}` : `Expand diff for ${file.path}`}
            onClick={onToggleExpand}
          >
            <ChevronRight size={13} strokeWidth={1.75} />
          </button>
        )}
        <button
          type="button"
          className="eg-runfiles-path"
          aria-label={`${file.path}, ${STATUS_LABEL[file.status].toLowerCase()}`}
          title={
            canInAppDiff
              ? `Inspect diff for ${file.path}`
              : deleted
                ? `${file.path} was deleted. Show what it held`
                : `Open ${file.path} in your editor`
          }
          onClick={() => {
            if (canInAppDiff) onToggleExpand();
            else void (deleted ? openRunFileDiff(runId, file.path, { root }) : openFileRef({ path: file.path }, { root }));
          }}
        >
          <Icon icon={STATUS_ICON[file.status]} size="sm" className="eg-runfiles-icon" />
          <span className="eg-runfiles-name">
            {dir && <span className="eg-runfiles-dir">{dir}</span>}
            {name}
          </span>
        </button>
        <span className="eg-runfiles-stat eg-tabular">
          {file.binary ? (
            <span className="eg-subtle">binary</span>
          ) : (
            <>
              <span className="is-add">+{file.additions}</span>
              <span className="is-del">−{file.deletions}</span>
            </>
          )}
        </span>
        {canInAppDiff ? (
          <span className="eg-runfiles-actions">
            <IconButton
              icon={GitCompare}
              size="sm"
              label="Open visual diff"
              title={`Inspect ${file.path} in the diff viewer`}
              onClick={onOpenVisualDiff}
            />
            <IconButton
              icon={Undo2}
              size="sm"
              label="Discard file"
              title={active ? 'Stop the run before discarding files' : `Discard changes to ${file.path}`}
              disabled={Boolean(active) || reverting}
              onClick={onDiscard}
            />
            <IconButton
              icon={ExternalLink}
              size="sm"
              label="Open in editor"
              title={deleted ? `Compare ${file.path} in your editor` : `Open ${file.path} in your editor`}
              onClick={() => void (deleted ? openRunFileDiff(runId, file.path, { root }) : openFileRef({ path: file.path }, { root }))}
            />
          </span>
        ) : (
          <IconButton
            icon={GitCompare}
            size="sm"
            label="Open diff"
            title={`Compare ${file.path} with how it was when the run started, in your editor`}
            onClick={() => void openRunFileDiff(runId, file.path, { root })}
          />
        )}
      </div>
      {canInAppDiff && expanded && (
        <div className="eg-runfiles-inline">
          <InlineDiffView
            diffText={diffText}
            file={file}
            loading={diffLoading}
            maxLines={36}
            onExpandFull={onOpenVisualDiff}
          />
        </div>
      )}
    </li>
  );
};

export const RunChangedFiles: React.FC<{
  runId?: string;
  /** The run is working: the list refreshes when it stops. */
  active?: boolean;
  /** Incremented externally when a checkpoint revert happens elsewhere. */
  refreshKey?: number;
  /** Called after any file or full-run revert completes. */
  onReverted?: () => void;
}> = ({ runId, active, refreshKey, onReverted }) => {
  const [changes, setChanges] = useState<RunChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [inlineDiffs, setInlineDiffs] = useState<Record<string, string>>({});
  const [loadingDiffs, setLoadingDiffs] = useState<Record<string, boolean>>({});
  const [revertingPath, setRevertingPath] = useState<string | null>(null);
  const [revertingAll, setRevertingAll] = useState(false);
  const [modalFile, setModalFile] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const requestRef = useRef(0);
  const canInAppDiff = bridgeSupportsVisualDiff();

  const load = useCallback(async () => {
    if (!runId) return setChanges(null);
    const id = ++requestRef.current;
    setLoading(true);
    const next = await fetchRunChanges(runId);
    if (id !== requestRef.current) return;
    setChanges(next);
    setInlineDiffs({});
    setLoading(false);
  }, [runId]);

  useEffect(() => {
    setShowAll(false);
    setExpandedFiles({});
    void load();
  }, [load, active, refreshKey]);

  const toggleExpand = async (file: RunChangedFile) => {
    const nextOpen = !expandedFiles[file.path];
    setExpandedFiles((prev) => ({ ...prev, [file.path]: nextOpen }));
    if (nextOpen && runId && inlineDiffs[file.path] === undefined && !file.binary) {
      setLoadingDiffs((prev) => ({ ...prev, [file.path]: true }));
      const diffRes = await fetchRunDiff(runId, { file: file.path, root: changes?.root });
      setLoadingDiffs((prev) => ({ ...prev, [file.path]: false }));
      if (diffRes?.diffs[file.path] !== undefined) {
        setInlineDiffs((prev) => ({ ...prev, [file.path]: diffRes.diffs[file.path] }));
      } else {
        setInlineDiffs((prev) => ({ ...prev, [file.path]: '' }));
      }
    }
  };

  const handleDiscardFile = async (file: RunChangedFile) => {
    if (!runId) return;
    const confirmed = await askConfirm({
      title: `Discard changes to ${splitPath(file.path).name}?`,
      text:
        file.status === 'added'
          ? `${file.path} was created during this run and will be removed from disk.`
          : `${file.path} will be restored to how it was before this run.`,
      confirmLabel: 'Discard file',
      danger: true,
    });
    if (!confirmed) return;
    setRevertingPath(file.path);
    const res = await revertRunFile(runId, file.path, { root: changes?.root });
    setRevertingPath(null);
    if (!res.success) {
      showAppToast('error', "Couldn't discard file", res.error || `Failed to revert ${file.path}.`);
      return;
    }
    showAppToast(
      'success',
      file.status === 'added' ? 'File removed' : 'File restored',
      file.status === 'added' ? `Removed ${file.path}.` : `Restored ${file.path} to its pre-run state.`,
    );
    onReverted?.();
    await load();
  };

  const handleUndoAll = async () => {
    if (!runId || !changes?.files.length) return;
    const count = changes.files.length;
    const confirmed = await askConfirm({
      title: 'Undo all run changes?',
      text: `This restores ${count} file${count === 1 ? '' : 's'} to how the workspace was before the run started and deletes any newly added files.`,
      confirmLabel: 'Undo all changes',
      danger: true,
    });
    if (!confirmed) return;
    setRevertingAll(true);
    const res = await revertRunChanges(runId, { root: changes.root });
    setRevertingAll(false);
    if (!res.success) {
      showAppToast('error', "Couldn't undo all changes", res.error || 'Some files could not be restored.');
      return;
    }
    const doneCount = res.reverted.length + res.deleted.length;
    showAppToast('success', 'Changes reverted', `Restored ${doneCount} file${doneCount === 1 ? '' : 's'} to the baseline snapshot.`);
    onReverted?.();
    await load();
  };

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
          <span className="eg-runfiles-total eg-tabular">
            {files.length}
            {changes.truncated ? '+' : ''} · <span className="is-add">+{additions}</span> <span className="is-del">−{deletions}</span>
          </span>
        )}
        <span className="eg-spacer" />
        {canInAppDiff && files.length > 0 && (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={GitCompare}
              onClick={() => {
                setModalFile(files[0].path);
                setModalOpen(true);
              }}
            >
              Review diff
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={Undo2}
              disabled={Boolean(active) || revertingAll}
              title={active ? 'Stop the run before reverting changes' : 'Undo all file changes from this run'}
              onClick={() => void handleUndoAll()}
            >
              {revertingAll ? 'Reverting…' : 'Undo all'}
            </Button>
          </>
        )}
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
              <FileRow
                key={f.path}
                file={f}
                runId={runId}
                root={changes.root}
                active={active}
                canInAppDiff={canInAppDiff}
                expanded={Boolean(expandedFiles[f.path])}
                diffText={inlineDiffs[f.path]}
                diffLoading={Boolean(loadingDiffs[f.path])}
                reverting={revertingPath === f.path}
                onToggleExpand={() => void toggleExpand(f)}
                onOpenVisualDiff={() => {
                  setModalFile(f.path);
                  setModalOpen(true);
                }}
                onDiscard={() => void handleDiscardFile(f)}
              />
            ))}
          </ul>
          {files.length > COLLAPSED_COUNT && (
            <Button size="sm" variant="ghost" className="eg-runfiles-more" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${files.length}`}
            </Button>
          )}
        </>
      )}

      {canInAppDiff && (
        <VisualDiffModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          runId={runId}
          initialFile={modalFile ?? undefined}
          root={changes.root}
          active={active}
          onReverted={() => {
            onReverted?.();
            void load();
          }}
        />
      )}
    </section>
  );
};
