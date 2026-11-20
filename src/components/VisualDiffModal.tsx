/**
 * In-app visual diff viewer (Phase 1): unified & side-by-side color-coded diffs with
 * 1-click per-file discard and full run rollback. Conforms to Ergo's /public/design/ tokens.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Columns2,
  ExternalLink,
  FileDiff,
  FileMinus,
  FilePlus,
  Loader2,
  Maximize2,
  Rows2,
  Undo2,
} from 'lucide-react';
import {
  fetchRunDiff,
  openFileRef,
  openRunFileDiff,
  revertRunChanges,
  revertRunFile,
  showAppToast,
  type RunChangedFile,
  type RunDiffPayload,
} from '../lib/ideLinks';
import { buildSplitRows, parseUnifiedDiff, summarizeFileChange } from '../lib/diffParser';
import { askConfirm, Badge, Button, Dialog, EmptyState, Icon, IconButton, SegmentedControl } from './ui';

type DiffViewMode = 'unified' | 'split';

const STATUS_ICON = { added: FilePlus, deleted: FileMinus, modified: FileDiff, changed: FileDiff } as const;

function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/**
 * Compact inline unified diff well — used inside expanded Timeline checkpoints and RunChangedFiles rows.
 */
export const InlineDiffView: React.FC<{
  diffText?: string;
  file?: RunChangedFile;
  maxLines?: number;
  loading?: boolean;
  onExpandFull?: () => void;
}> = ({ diffText, file, maxLines = 48, loading, onExpandFull }) => {
  const parsed = useMemo(() => parseUnifiedDiff(diffText || ''), [diffText]);

  if (loading) {
    return (
      <div className="eg-diff-inline-state">
        <Loader2 size={13} className="spin-animate" />
        <span>Loading diff…</span>
      </div>
    );
  }

  if (file?.binary || parsed.isBinary) {
    return <div className="eg-diff-inline-state">Binary file — line diff is not available.</div>;
  }

  if (parsed.hunks.length === 0) {
    return <div className="eg-diff-inline-state">No line changes to display.</div>;
  }

  const allLines: Array<{ type: 'hunk'; header: string } | { type: 'line'; kind: string; oldLine?: number; newLine?: number; text: string }> = [];
  for (const h of parsed.hunks) {
    allLines.push({ type: 'hunk', header: h.header });
    for (const l of h.lines) {
      allLines.push({ type: 'line', kind: l.kind, oldLine: l.oldLine, newLine: l.newLine, text: l.text });
    }
  }
  const clipped = allLines.length > maxLines;
  const shown = clipped ? allLines.slice(0, maxLines) : allLines;

  return (
    <div className="eg-diff-well is-inline">
      <div className="eg-diff-scroll">
        <table className="eg-diff-table" role="presentation">
          <tbody>
            {shown.map((row, idx) =>
              row.type === 'hunk' ? (
                <tr key={`h-${idx}`} className="eg-diff-row is-hunk">
                  <td className="eg-diff-ln" colSpan={2} />
                  <td className="eg-diff-sign" />
                  <td className="eg-diff-code">{row.header}</td>
                </tr>
              ) : (
                <tr key={`l-${idx}`} className={`eg-diff-row is-${row.kind}`}>
                  <td className="eg-diff-ln">{row.oldLine ?? ''}</td>
                  <td className="eg-diff-ln">{row.newLine ?? ''}</td>
                  <td className="eg-diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</td>
                  <td className="eg-diff-code">{row.text || ' '}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {(clipped || parsed.isTruncated) && onExpandFull && (
        <div className="eg-diff-inline-foot">
          <span>
            {clipped ? `Showing first ${maxLines} of ${allLines.length} lines` : 'Diff truncated for size'}
          </span>
          <Button size="sm" variant="ghost" icon={Maximize2} onClick={onExpandFull}>
            Open full diff
          </Button>
        </div>
      )}
    </div>
  );
};

export interface VisualDiffModalProps {
  open: boolean;
  onClose: () => void;
  runId: string;
  /** Optional file to select initially. */
  initialFile?: string;
  /** Optional title override (e.g. checkpoint label). */
  title?: string;
  /** Optional tree range when viewing a specific checkpoint's diff. */
  fromTree?: string;
  toTree?: string;
  /** Tree hash to restore when discarding a file or reverting all (defaults to run base). */
  revertTargetTree?: string;
  /** Working folder root. */
  root?: string;
  /** True while the run is actively writing files (disables destructive revert actions). */
  active?: boolean;
  /** Called whenever a file or the whole run is reverted so parent views can refresh. */
  onReverted?: () => void;
}

export const VisualDiffModal: React.FC<VisualDiffModalProps> = ({
  open,
  onClose,
  runId,
  initialFile,
  title,
  fromTree,
  toTree,
  revertTargetTree,
  root,
  active,
  onReverted,
}) => {
  const [payload, setPayload] = useState<RunDiffPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile ?? null);
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified');
  const [revertingFile, setRevertingFile] = useState<string | null>(null);
  const [revertingAll, setRevertingAll] = useState(false);
  const [loadedSingleDiffs, setLoadedSingleDiffs] = useState<Record<string, string>>({});

  const loadDiff = useCallback(async () => {
    if (!open || !runId) return;
    setLoading(true);
    const next = await fetchRunDiff(runId, { fromTree, toTree, root });
    setPayload(next);
    setLoadedSingleDiffs({});
    setLoading(false);
    if (next?.files.length) {
      setSelectedFile((cur) => {
        if (initialFile && next.files.some((f) => f.path === initialFile)) return initialFile;
        if (cur && next.files.some((f) => f.path === cur)) return cur;
        return next.files[0].path;
      });
    } else {
      setSelectedFile(null);
    }
  }, [open, runId, fromTree, toTree, root, initialFile]);

  useEffect(() => {
    if (open) void loadDiff();
  }, [open, loadDiff]);

  useEffect(() => {
    if (open && initialFile) setSelectedFile(initialFile);
  }, [open, initialFile]);

  // Lazy-fetch individual file diff if the bulk payload truncated total diff size.
  useEffect(() => {
    if (!open || !runId || !selectedFile || !payload) return;
    if (payload.diffs[selectedFile] !== undefined || loadedSingleDiffs[selectedFile] !== undefined) return;
    let cancelled = false;
    void fetchRunDiff(runId, { file: selectedFile, fromTree, toTree, root }).then((single) => {
      if (cancelled || !single?.diffs[selectedFile]) return;
      setLoadedSingleDiffs((prev) => ({ ...prev, [selectedFile]: single.diffs[selectedFile] }));
    });
    return () => {
      cancelled = true;
    };
  }, [open, runId, selectedFile, payload, loadedSingleDiffs, fromTree, toTree, root]);

  const files = payload?.files ?? [];
  const activeFile = useMemo(() => files.find((f) => f.path === selectedFile) ?? files[0] ?? null, [files, selectedFile]);
  const activeDiffText = activeFile ? (payload?.diffs[activeFile.path] ?? loadedSingleDiffs[activeFile.path] ?? '') : '';
  const parsed = useMemo(() => parseUnifiedDiff(activeDiffText), [activeDiffText]);
  const splitRows = useMemo(() => (viewMode === 'split' ? buildSplitRows(parsed) : []), [viewMode, parsed]);
  const summaryLine = useMemo(() => (activeFile ? summarizeFileChange(activeFile, activeDiffText) : ''), [activeFile, activeDiffText]);

  const totalAdditions = useMemo(() => files.reduce((n, f) => n + f.additions, 0), [files]);
  const totalDeletions = useMemo(() => files.reduce((n, f) => n + f.deletions, 0), [files]);

  const handleDiscardFile = async (file: RunChangedFile) => {
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

    setRevertingFile(file.path);
    const res = await revertRunFile(runId, file.path, { tree: revertTargetTree, root: payload?.root ?? root });
    setRevertingFile(null);
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
    await loadDiff();
  };

  const handleRevertAll = async () => {
    const confirmed = await askConfirm({
      title: 'Undo all run changes?',
      text: `This restores ${files.length} file${files.length === 1 ? '' : 's'} to how the workspace was before the run started and deletes any newly added files.`,
      confirmLabel: 'Undo all changes',
      danger: true,
    });
    if (!confirmed) return;

    setRevertingAll(true);
    const res = await revertRunChanges(runId, { tree: revertTargetTree, root: payload?.root ?? root });
    setRevertingAll(false);
    if (!res.success) {
      showAppToast('error', "Couldn't undo all changes", res.error || 'Some files could not be restored.');
      return;
    }
    const count = res.reverted.length + res.deleted.length;
    showAppToast('success', 'Changes reverted', `Restored ${count} file${count === 1 ? '' : 's'} to the baseline snapshot.`);
    onReverted?.();
    onClose();
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={1060}
      className="eg-diff-dialog"
      title={title || 'Review changes'}
      description={
        files.length > 0 ? (
          <span className="eg-diff-desc-meta eg-tabular">
            {files.length} file{files.length === 1 ? '' : 's'} changed
            {' · '}
            <span className="is-add">+{totalAdditions}</span> <span className="is-del">−{totalDeletions}</span>
          </span>
        ) : undefined
      }
      headerActions={
        <SegmentedControl<DiffViewMode>
          label="Diff layout"
          value={viewMode}
          onChange={setViewMode}
          options={[
            { id: 'unified', label: 'Unified', icon: Rows2 },
            { id: 'split', label: 'Split', icon: Columns2 },
          ]}
        />
      }
      footer={
        <>
          {files.length > 0 && (
            <Button
              variant="danger"
              icon={Undo2}
              disabled={Boolean(active) || revertingAll || loading}
              title={active ? 'Stop the run before reverting changes' : 'Restore all changed files back to before the run'}
              onClick={() => void handleRevertAll()}
            >
              {revertingAll ? 'Reverting…' : 'Undo all changes'}
            </Button>
          )}
          <span className="eg-spacer" />
          <Button variant="primary" icon={Check} onClick={onClose}>
            Accept &amp; keep
          </Button>
        </>
      }
    >
      {loading && !payload ? (
        <div className="eg-diff-loading">
          <Loader2 size={16} className="spin-animate" />
          <span>Loading workspace diff…</span>
        </div>
      ) : payload?.error ? (
        <EmptyState icon={FileDiff} title="Could not load diff" text={payload.error} />
      ) : files.length === 0 ? (
        <EmptyState
          icon={FileDiff}
          title="No file changes"
          text="The working folder currently matches the recorded snapshot."
        />
      ) : (
        <div className={`eg-diff-layout ${files.length === 1 ? 'is-single' : ''}`}>
          {files.length > 1 && (
            <aside className="eg-diff-sidebar" aria-label="Changed files">
              <ul className="eg-diff-filelist">
                {files.map((f) => {
                  const { dir, name } = splitPath(f.path);
                  const isSelected = activeFile?.path === f.path;
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        className={`eg-diff-fileitem is-${f.status} ${isSelected ? 'is-active' : ''}`}
                        onClick={() => setSelectedFile(f.path)}
                        title={f.path}
                      >
                        <Icon icon={STATUS_ICON[f.status]} size="sm" className="eg-diff-fileicon" />
                        <span className="eg-diff-filename">
                          <span className="eg-diff-filebase">{name}</span>
                          {dir && <span className="eg-diff-filedir">{dir}</span>}
                        </span>
                        <span className="eg-diff-filestat eg-tabular">
                          {f.binary ? (
                            'bin'
                          ) : (
                            <>
                              {f.additions > 0 && <span className="is-add">+{f.additions}</span>}
                              {f.deletions > 0 && <span className="is-del">−{f.deletions}</span>}
                            </>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>
          )}

          <div className="eg-diff-main">
            {activeFile && (
              <>
                <div className="eg-diff-filehead">
                  <div className="eg-diff-filehead-top">
                    <Icon icon={STATUS_ICON[activeFile.status]} size="sm" className={`eg-diff-fileicon is-${activeFile.status}`} />
                    <span className="eg-diff-filepath" title={activeFile.path}>
                      {activeFile.path}
                    </span>
                    <Badge
                      tone={
                        activeFile.status === 'added'
                          ? 'success'
                          : activeFile.status === 'deleted'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {activeFile.status}
                    </Badge>
                    <span className="eg-spacer" />
                    <IconButton
                      icon={ExternalLink}
                      size="sm"
                      label="Open in editor"
                      title={
                        activeFile.status === 'deleted'
                          ? 'Compare in your external editor'
                          : `Open ${activeFile.path} in your external editor`
                      }
                      onClick={() =>
                        void (activeFile.status === 'deleted'
                          ? openRunFileDiff(runId, activeFile.path, { root: payload?.root ?? root })
                          : openFileRef({ path: activeFile.path }, { root: payload?.root ?? root }))
                      }
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Undo2}
                      disabled={Boolean(active) || revertingFile === activeFile.path}
                      title={active ? 'Stop the run before discarding files' : `Discard changes to ${activeFile.path}`}
                      onClick={() => void handleDiscardFile(activeFile)}
                    >
                      {revertingFile === activeFile.path ? 'Discarding…' : 'Discard file'}
                    </Button>
                  </div>
                  <p className="eg-diff-summary">{summaryLine}</p>
                </div>

                <div className="eg-diff-well">
                  {activeFile.binary || parsed.isBinary ? (
                    <div className="eg-diff-inline-state">Binary file — line-by-line diff is not available.</div>
                  ) : parsed.hunks.length === 0 ? (
                    <div className="eg-diff-inline-state">No textual differences in this file.</div>
                  ) : viewMode === 'unified' ? (
                    <div className="eg-diff-scroll">
                      <table className="eg-diff-table" role="presentation">
                        <tbody>
                          {parsed.hunks.map((hunk, hIdx) => (
                            <React.Fragment key={hIdx}>
                              <tr className="eg-diff-row is-hunk">
                                <td className="eg-diff-ln" colSpan={2} />
                                <td className="eg-diff-sign" />
                                <td className="eg-diff-code">{hunk.header}</td>
                              </tr>
                              {hunk.lines.map((line, lIdx) => (
                                <tr key={`${hIdx}-${lIdx}`} className={`eg-diff-row is-${line.kind}`}>
                                  <td className="eg-diff-ln">{line.oldLine ?? ''}</td>
                                  <td className="eg-diff-ln">{line.newLine ?? ''}</td>
                                  <td className="eg-diff-sign">
                                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                                  </td>
                                  <td className="eg-diff-code">{line.text || ' '}</td>
                                </tr>
                              ))}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="eg-diff-scroll">
                      <table className="eg-diff-table is-split" role="presentation">
                        <tbody>
                          {splitRows.map((row, rIdx) =>
                            row.isHunk ? (
                              <tr key={`sh-${rIdx}`} className="eg-diff-row is-hunk">
                                <td className="eg-diff-code" colSpan={6}>
                                  {row.hunkHeader}
                                </td>
                              </tr>
                            ) : (
                              <tr key={`sr-${rIdx}`} className="eg-diff-split-row">
                                <td className={`eg-diff-ln is-${row.left?.kind ?? 'empty'}`}>{row.left?.lineNumber ?? ''}</td>
                                <td className={`eg-diff-sign is-${row.left?.kind ?? 'empty'}`}>
                                  {row.left?.kind === 'del' ? '−' : ' '}
                                </td>
                                <td className={`eg-diff-code is-split-left is-${row.left?.kind ?? 'empty'}`}>
                                  {row.left?.text || ' '}
                                </td>
                                <td className={`eg-diff-ln is-${row.right?.kind ?? 'empty'}`}>{row.right?.lineNumber ?? ''}</td>
                                <td className={`eg-diff-sign is-${row.right?.kind ?? 'empty'}`}>
                                  {row.right?.kind === 'add' ? '+' : ' '}
                                </td>
                                <td className={`eg-diff-code is-${row.right?.kind ?? 'empty'}`}>
                                  {row.right?.text || ' '}
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
};
