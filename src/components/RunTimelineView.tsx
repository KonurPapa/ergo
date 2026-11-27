/**
 * Merged vertical checkpoint timeline for the Runs tab.
 *
 * Replaces the separate Notes & Steps tabs with one scrollable history timeline where every
 * major step/action is connected along a vertical rail, offers a 1-click checkpoint revert
 * button, and expands via a chevron arrow to reveal either the coding diff log (with inline
 * unified diffs + full VisualDiffModal) or the non-coding changelog.
 *
 * Stays scrolled to the current checkpoint while live/updating; scrolling back pauses
 * auto-follow and surfaces a calm "Jump to current" control.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ChevronRight,
  Eye,
  FileDiff,
  FileMinus,
  FilePlus,
  GitCompare,
  History,
  Info,
  RotateCcw,
  Terminal as TerminalIcon,
  Undo2,
} from 'lucide-react';
import type { ExecutionStep, HumanInputPrompt, SpawnedSession } from '../types';
import type { ActivityFeedItem } from '../lib/cliActivityFeed';
import {
  fetchRunChanges,
  fetchRunCheckpoints,
  fetchRunDiff,
  getBridgeVisualDiffCapability,
  isMajorCheckpointStep,
  revertRunChanges,
  revertRunFile,
  showAppToast,
  subscribeBridgeVisualDiffCapability,
  subscribeRunCheckpoints,
  waitForPendingCheckpoints,
  type BridgeVisualDiffCapability,
  type RunChangedFile,
  type RunCheckpointRecord,
  type RunCheckpointsResponse,
  type RunChanges,
} from '../lib/ideLinks';
import { MarkdownRenderer } from './MarkdownRenderer';
import { BiblePreview, StepUsageBadge } from './ExecutionStepExtras';
import { AgentRoleBadge } from './AgentSessionTabs';
import { FileLinkText } from './FileLink';
import { InlineDiffView, VisualDiffModal } from './VisualDiffModal';
import { isPreviewableFile } from '../lib/preview';
import { askConfirm, Badge, Button, EmptyState, Icon, IconButton, StatusDot } from './ui';

const STATUS_ICON = { added: FilePlus, deleted: FileMinus, modified: FileDiff, changed: FileDiff } as const;

const MAJOR_CLI_ACTIVITY_RE =
  /^(?:Edit|MultiEdit|Write|WriteFile|Update|Create|Replace|Bash|Shell|Command|Sub-agent|NotebookEdit|Applied patch|Edited|Wrote|Created|Deleted|Updated|Ran)\b/i;

function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

function formatIsoClock(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface TimelineNode {
  id: string;
  kind: 'baseline' | 'step' | 'activity';
  title: string;
  time: string;
  status: 'running' | 'success' | 'warning' | 'error' | 'cancelled' | 'pending';
  isMajor: boolean;
  /** Associated ExecutionStep when kind === 'step'. */
  step?: ExecutionStep;
  /** Associated recorded checkpoint from bridge checkpoints.json. */
  checkpoint?: RunCheckpointRecord;
  /** Git tree hash that reverting to this checkpoint restores. */
  revertTree?: string;
  /** Git tree range for this checkpoint's diff log. */
  diffFromTree?: string;
  diffToTree?: string;
  /** Files changed at this checkpoint (for coding tasks). */
  files: RunChangedFile[];
  /** Non-coding changelog / detail markdown. */
  changelog?: string;
  /** Nested live CLI activity items (when a step owns a CLI agent session). */
  activityItems?: ActivityFeedItem[];
}

export interface RunTimelineViewProps {
  runId?: string;
  steps: ExecutionStep[];
  runActive: boolean;
  /** Live CLI activity items streamed from the active CliAgentNotesBridge. */
  cliActivity?: ActivityFeedItem[];
  /** Currently focused CLI agent session, if any. */
  shownAgent?: SpawnedSession | null;
  /** Active human clarification prompt (pipeline). */
  pendingHumanInput?: { prompt: HumanInputPrompt } | null;
  onHumanInputChoice?: (answer: string) => void;
  /** Renderer for inline HumanInputCard from BriefPane. */
  renderHumanInput?: (prompt: HumanInputPrompt, onSubmit: (answer: string) => void) => React.ReactNode;
  /** Optional MCP widget renderer from BriefPane. */
  renderMcpWidget?: (widgetType: NonNullable<ExecutionStep['widgetType']>, widgetData: any) => React.ReactNode;
  /** Externally triggered refresh counter (e.g. when RunChangedFiles reverts something). */
  refreshKey?: number;
  /** Notifies parent (BriefPane / RunChangedFiles) after a checkpoint revert completes. */
  onReverted?: () => void;
  /** Switches to the Terminal view for power-users. */
  onOpenTerminal?: () => void;
  /** Whether any CLI terminal exists for this run. */
  hasTerminal?: boolean;
  /** Opens a changed HTML file in the Preview tab; no Preview buttons without it. */
  onPreview?: (path: string) => void;
}

export const RunTimelineView: React.FC<RunTimelineViewProps> = ({
  runId,
  steps,
  runActive,
  cliActivity = [],
  shownAgent,
  pendingHumanInput,
  onHumanInputChoice,
  renderHumanInput,
  renderMcpWidget,
  refreshKey = 0,
  onReverted,
  onOpenTerminal,
  hasTerminal,
  onPreview,
}) => {
  const [checkpoints, setCheckpoints] = useState<RunCheckpointRecord[]>([]);
  const [hasGitBaseline, setHasGitBaseline] = useState(false);
  const [gitStateLoaded, setGitStateLoaded] = useState(false);
  const [checkpointReason, setCheckpointReason] = useState<RunCheckpointsResponse['reason']>(undefined);
  const [baseTree, setBaseTree] = useState<string | undefined>(undefined);
  const [runRoot, setRunRoot] = useState<string | undefined>(undefined);
  const [runChanges, setRunChanges] = useState<RunChanges | null>(null);
  const [bridgeCap, setBridgeCap] = useState<BridgeVisualDiffCapability>(() => getBridgeVisualDiffCapability());
  const loadSeqRef = useRef(0);

  // Expanded state for checkpoint changelog arrows
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  // Expanded inline file diffs inside a checkpoint drawer: key = `${nodeId}:${filePath}`
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [diffCache, setDiffCache] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState<Record<string, boolean>>({});

  // Which checkpoint the user explicitly reverted to (null = latest/current step)
  const [revertedToId, setRevertedToId] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);

  // Visual diff modal state
  const [diffModal, setDiffModal] = useState<{
    open: boolean;
    title?: string;
    file?: string;
    fromTree?: string;
    toTree?: string;
    revertTargetTree?: string;
  }>({ open: false });

  // Scroll & auto-follow current checkpoint state
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentNodeRef = useRef<HTMLDivElement>(null);
  const [followCurrent, setFollowCurrent] = useState(true);
  const programmaticScrollRef = useRef(false);

  // React when the bridge connects or completes its protocol handshake.
  useEffect(() => subscribeBridgeVisualDiffCapability(setBridgeCap), []);

  const canVisualDiff = bridgeCap.supported;
  const hintRoot = shownAgent?.cwd;

  // Load checkpoints + current git diff summary for this run.
  const loadGitState = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (!runId || !canVisualDiff) {
      setCheckpoints([]);
      setHasGitBaseline(false);
      setGitStateLoaded(false);
      setCheckpointReason(undefined);
      setBaseTree(undefined);
      setRunChanges(null);
      return;
    }
    await waitForPendingCheckpoints(runId);
    if (seq !== loadSeqRef.current) return;
    const [cpRes, chRes] = await Promise.all([
      fetchRunCheckpoints(runId, { root: hintRoot }),
      fetchRunChanges(runId, { root: hintRoot }),
    ]);
    if (seq !== loadSeqRef.current) return;
    if (cpRes) {
      setCheckpoints(cpRes.checkpoints);
      setHasGitBaseline(cpRes.baseline);
      setCheckpointReason(cpRes.reason);
      setBaseTree(cpRes.baseTree);
      setRunRoot(cpRes.root ?? chRes?.root ?? hintRoot);
    } else {
      setCheckpoints([]);
      setHasGitBaseline(Boolean(chRes?.baseline));
      setCheckpointReason(undefined);
      setBaseTree(chRes?.baseTree);
      setRunRoot(chRes?.root ?? hintRoot);
    }
    setGitStateLoaded(true);
    setRunChanges(chRes);
    setDiffCache({});
  }, [runId, canVisualDiff, hintRoot]);

  // Refresh git checkpoints when run changes, stops/starts, or new steps finish.
  const completedStepCount = useMemo(
    () => steps.filter((s) => s.status === 'success' || s.status === 'warning' || s.status === 'error').length,
    [steps],
  );

  useEffect(() => {
    void loadGitState();
  }, [loadGitState, runActive, completedStepCount, refreshKey]);

  // Re-fetch immediately whenever an async checkpoint write finishes for this run (avoids write/read races).
  useEffect(() => {
    if (!runId || !canVisualDiff) return;
    return subscribeRunCheckpoints(runId, () => {
      void loadGitState();
    });
  }, [runId, canVisualDiff, loadGitState]);

  // Reset reverted marker when switching to another run.
  useEffect(() => {
    setRevertedToId(null);
    setExpandedNodes({});
    setExpandedFiles({});
    setFollowCurrent(true);
  }, [runId]);

  // Build unified vertical timeline nodes (baseline -> major steps + live CLI activity).
  const nodes = useMemo<TimelineNode[]>(() => {
    const out: TimelineNode[] = [];
    const cpByStepId = new Map<string, RunCheckpointRecord>();
    let baselineCp: RunCheckpointRecord | undefined;

    for (const cp of checkpoints) {
      if (cp.isBaseline) baselineCp = cp;
      if (cp.stepId) cpByStepId.set(cp.stepId, cp);
    }

    // 1. Initial baseline checkpoint node (always first when git baseline exists).
    if (hasGitBaseline && (baseTree || baselineCp?.tree)) {
      const tree = baselineCp?.tree ?? baseTree;
      out.push({
        id: 'cp-base',
        kind: 'baseline',
        title: 'Before run',
        time: formatIsoClock(baselineCp?.at || runChanges?.startedAt),
        status: 'success',
        isMajor: true,
        checkpoint: baselineCp,
        revertTree: tree,
        files: [],
        changelog: 'Initial workspace snapshot before this run started. Revert here to undo all file changes from this run.',
      });
    }

    // Track which CLI step owns the active agent's activity stream so live actions attach cleanly.
    let cliOwnerStepId: string | null = null;
    if (shownAgent) {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].ptySessionId === shownAgent.ptySessionId) {
          cliOwnerStepId = steps[i].id;
          break;
        }
      }
      if (!cliOwnerStepId) {
        const mgr = [...steps].reverse().find((s) => s.agentRole === 'manager' || s.stage === 'execution');
        if (mgr) cliOwnerStepId = mgr.id;
      }
    }

    let lastKnownTree: string | undefined = baselineCp?.tree ?? baseTree;

    // 2. Execution steps along the vertical spine.
    steps.forEach((step, idx) => {
      const cp = cpByStepId.get(step.id);
      const isLast = idx === steps.length - 1;
      const major = isMajorCheckpointStep(step) || Boolean(cp);
      const stepTree = cp?.tree ?? step.checkpointTree;

      // For the last step of a git run that has no individual per-step checkpoint yet (e.g. legacy run
      // or active CLI run), attach the run's live changed files so the user can inspect diffs right on it!
      let files: RunChangedFile[] = cp?.files ?? [];
      let diffFromTree = cp?.prevTree;
      let diffToTree = cp?.tree;

      if (files.length === 0 && isLast && runChanges?.files && runChanges.files.length > 0) {
        files = runChanges.files;
        diffFromTree = baseTree;
        diffToTree = undefined; // live working tree
      } else if (stepTree && !diffFromTree && lastKnownTree && stepTree !== lastKnownTree) {
        diffFromTree = lastKnownTree;
        diffToTree = stepTree;
      }

      if (stepTree) lastKnownTree = stepTree;

      // For revert target: prefer this step's recorded tree; if none (e.g. a non-mutating or pre-checkpoint step),
      // fall back to lastKnownTree when git baseline exists so the checkpoint button still works predictably.
      const revertTree = stepTree ?? (hasGitBaseline ? lastKnownTree : undefined);

      out.push({
        id: step.id,
        kind: 'step',
        title: step.title,
        time: step.time,
        status: step.status,
        isMajor: major,
        step,
        checkpoint: cp,
        revertTree,
        diffFromTree,
        diffToTree,
        files,
        changelog: cp?.changelog || step.detail,
        activityItems: step.id === cliOwnerStepId && cliActivity.length > 0 ? cliActivity : undefined,
      });
    });

    // 3. If a CLI agent is streaming activity before any execution steps exist (or for major live actions
    //    not yet attached to a step), surface major CLI actions directly on the timeline.
    if (!cliOwnerStepId && cliActivity.length > 0) {
      const majorActs = cliActivity.filter((a) => a.type === 'user' || a.type === 'approval' || MAJOR_CLI_ACTIVITY_RE.test(a.text));
      const feedToShow = majorActs.length > 0 ? majorActs : cliActivity.slice(-10);
      for (const act of feedToShow) {
        out.push({
          id: `cli-${act.id}`,
          kind: 'activity',
          title: act.detail ? `${act.text} ${act.detail}` : act.text,
          time: act.timestamp,
          status: 'success',
          isMajor: MAJOR_CLI_ACTIVITY_RE.test(act.text),
          revertTree: hasGitBaseline ? baseTree : undefined,
          files: [],
          changelog: act.detail ? `${act.text}\n\n\`${act.detail}\`` : act.text,
        });
      }
    }

    return out;
  }, [checkpoints, hasGitBaseline, baseTree, runChanges, steps, shownAgent, cliActivity]);

  // Identify the current checkpoint index:
  //  - If the user reverted to a specific checkpoint, that node is current.
  //  - Else if a step is currently running, that running step is current.
  //  - Else the latest node in the timeline is current.
  const currentIndex = useMemo(() => {
    if (nodes.length === 0) return -1;
    if (revertedToId) {
      const idx = nodes.findIndex((n) => n.id === revertedToId);
      if (idx >= 0) return idx;
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].status === 'running') return i;
    }
    return nodes.length - 1;
  }, [nodes, revertedToId]);

  const currentNodeId = currentIndex >= 0 ? nodes[currentIndex].id : null;

  // Keep the timeline scrolled with the current checkpoint when auto-follow is active.
  const scrollToCurrent = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = scrollRef.current;
    const target = currentNodeRef.current;
    if (!container || !target) return;
    programmaticScrollRef.current = true;
    const targetTop = target.offsetTop;
    const targetBottom = targetTop + target.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (targetBottom > viewBottom - 12 || targetTop < viewTop + 12) {
      const nextTop = Math.max(0, targetBottom - container.clientHeight + 24);
      container.scrollTo({ top: nextTop, behavior });
    }
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 280);
  }, []);

  useEffect(() => {
    if (!followCurrent || !currentNodeId) return;
    const raf = requestAnimationFrame(() => scrollToCurrent(nodes.length <= 2 ? 'auto' : 'smooth'));
    return () => cancelAnimationFrame(raf);
  }, [followCurrent, currentNodeId, nodes.length, cliActivity.length, scrollToCurrent]);

  const handleTimelineScroll = () => {
    if (programmaticScrollRef.current) return;
    const container = scrollRef.current;
    const target = currentNodeRef.current;
    if (!container || !target) return;
    const targetTop = target.offsetTop;
    const targetBottom = targetTop + target.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    const isVisible = targetBottom >= viewTop + 8 && targetTop <= viewBottom - 8;
    setFollowCurrent(isVisible);
  };

  const toggleNodeDrawer = (nodeId: string) => {
    setExpandedNodes((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  };

  const toggleFileInlineDiff = async (node: TimelineNode, file: RunChangedFile) => {
    const key = `${node.id}:${file.path}`;
    const nextOpen = !expandedFiles[key];
    setExpandedFiles((prev) => ({ ...prev, [key]: nextOpen }));
    if (nextOpen && runId && diffCache[key] === undefined && !file.binary) {
      setDiffLoading((prev) => ({ ...prev, [key]: true }));
      const res = await fetchRunDiff(runId, {
        file: file.path,
        fromTree: node.diffFromTree,
        toTree: node.diffToTree,
        root: runRoot,
      });
      setDiffLoading((prev) => ({ ...prev, [key]: false }));
      setDiffCache((prev) => ({ ...prev, [key]: res?.diffs[file.path] ?? '' }));
    }
  };

  const handleRevertToCheckpoint = async (node: TimelineNode) => {
    if (runActive) {
      showAppToast('warning', 'Run is still active', 'Stop the run before reverting to a checkpoint.');
      return;
    }

    // Coding / git checkpoint revert
    if (runId && hasGitBaseline && node.revertTree) {
      const isBase = node.kind === 'baseline';
      const confirmed = await askConfirm({
        title: isBase ? 'Revert all changes to before this run?' : `Revert workspace to "${node.title}"?`,
        text: isBase
          ? 'All modified files will be restored to their pre-run snapshot and newly created files will be removed.'
          : 'Workspace files will be restored to the exact state captured at this checkpoint. Later file edits in this run will be undone.',
        confirmLabel: isBase ? 'Undo all changes' : 'Revert to checkpoint',
        danger: true,
      });
      if (!confirmed) return;

      setRevertingId(node.id);
      const res = await revertRunChanges(runId, {
        tree: node.revertTree,
        checkpointId: node.checkpoint?.id,
        root: runRoot,
      });
      setRevertingId(null);

      if (!res.success) {
        showAppToast('error', "Couldn't revert to checkpoint", res.error || 'Some files could not be restored.');
        return;
      }

      const count = res.reverted.length + res.deleted.length;
      setRevertedToId(node.id);
      setFollowCurrent(true);
      showAppToast(
        'success',
        'Reverted to checkpoint',
        count > 0
          ? `Restored ${count} file${count === 1 ? '' : 's'} to "${node.title}".`
          : `Workspace already matched "${node.title}".`,
      );
      onReverted?.();
      await loadGitState();
      return;
    }

    // Non-coding checkpoint (no git repository / no filesystem diff to roll back)
    showAppToast(
      'info',
      'No workspace files to revert',
      `"${node.title}" did not modify git-tracked files. Expand its arrow to review the changelog.`,
    );
  };

  const handleDiscardSingleFile = async (node: TimelineNode, file: RunChangedFile) => {
    if (!runId || runActive) return;
    const confirmed = await askConfirm({
      title: `Discard changes to ${splitPath(file.path).name}?`,
      text:
        file.status === 'added'
          ? `${file.path} will be deleted from disk.`
          : `${file.path} will be restored to before this change.`,
      confirmLabel: 'Discard file',
      danger: true,
    });
    if (!confirmed) return;

    const res = await revertRunFile(runId, file.path, {
      tree: node.diffFromTree || baseTree,
      root: runRoot,
    });
    if (!res.success) {
      showAppToast('error', "Couldn't discard file", res.error || `Failed to revert ${file.path}.`);
      return;
    }
    showAppToast('success', file.status === 'added' ? 'File removed' : 'File restored', `Reverted ${file.path}.`);
    onReverted?.();
    await loadGitState();
  };

  const totalRunFiles = runChanges?.files.length ?? 0;

  // Explain calmly why checkpoint revert / diff controls aren't shown instead of silently omitting them.
  const unavailableReason = useMemo(() => {
    if (nodes.length === 0) return null;
    if (bridgeCap.connected && !bridgeCap.supported) {
      return 'Checkpoint diffs and 1-click revert need an updated Ergo Bridge (protocol 10). Restart or update your local bridge to enable them.';
    }
    if (runId && canVisualDiff && gitStateLoaded && !hasGitBaseline && !runActive) {
      if (checkpointReason === 'not-git') {
        return "This workspace folder isn't a git repository, so file diffs and checkpoint reverts aren't available. Point this project to a git folder under Settings › Folders to enable 1-click revert.";
      }
      if (checkpointReason === 'snapshot-failed') {
        return "Couldn't capture a git snapshot before this run, so checkpoint reverts aren't available.";
      }
      return 'No git snapshot was recorded for this run (it ran outside a git repository or before checkpoint tracking was enabled).';
    }
    return null;
  }, [nodes.length, bridgeCap.connected, bridgeCap.supported, runId, canVisualDiff, gitStateLoaded, hasGitBaseline, runActive, checkpointReason]);

  return (
    <div className="eg-tl-root">
      {/* Interactive Mid-Build Human Clarification Card (in-app pipeline) */}
      {pendingHumanInput && onHumanInputChoice && renderHumanInput && (
        <div className="eg-tl-prompt-slot">
          {renderHumanInput(pendingHumanInput.prompt, onHumanInputChoice)}
        </div>
      )}

      {/* Calm explanation when git checkpointing / revert is unavailable for this run */}
      {unavailableReason && (
        <div className="eg-tl-notice" role="status">
          <Icon icon={Info} size="sm" className="eg-tl-notice-icon" />
          <span>{unavailableReason}</span>
        </div>
      )}

      {/* Quick diff summary bar when files changed in this run */}
      {runId && canVisualDiff && hasGitBaseline && totalRunFiles > 0 && (
        <div className="eg-tl-diffbar">
          <span className="eg-tl-diffbar-meta eg-tabular">
            <Icon icon={FileDiff} size="sm" />
            <span>
              {totalRunFiles} file{totalRunFiles === 1 ? '' : 's'} changed
            </span>
            <span className="is-add">+{runChanges!.files.reduce((n, f) => n + f.additions, 0)}</span>
            <span className="is-del">−{runChanges!.files.reduce((n, f) => n + f.deletions, 0)}</span>
          </span>
          <span className="eg-spacer" />
          <Button
            size="sm"
            variant="secondary"
            icon={GitCompare}
            onClick={() =>
              setDiffModal({
                open: true,
                title: 'Review run changes',
                fromTree: baseTree,
                revertTargetTree: baseTree,
              })
            }
          >
            Review diff
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Undo2}
            disabled={runActive || revertingId === 'cp-base'}
            title={runActive ? 'Stop the run before reverting changes' : 'Undo all file changes from this run'}
            onClick={() => {
              const baseNode = nodes.find((n) => n.kind === 'baseline');
              if (baseNode) void handleRevertToCheckpoint(baseNode);
            }}
          >
            Undo all
          </Button>
        </div>
      )}

      {/* Vertical scrollable history timeline */}
      {nodes.length === 0 ? (
        <EmptyState
          icon={History}
          title="No checkpoints yet"
          text="Major actions and checkpoints appear along this timeline as the task runs."
          actions={
            hasTerminal && onOpenTerminal ? (
              <Button size="sm" variant="secondary" icon={TerminalIcon} onClick={onOpenTerminal}>
                Open terminal
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="eg-tl-well">
          <div className="eg-tl-scroll" ref={scrollRef} onScroll={handleTimelineScroll}>
            <ol className="eg-tl-list" aria-label="Run checkpoint timeline">
              {nodes.map((node, idx) => {
                const isCurrent = idx === currentIndex;
                const isAfterReverted = revertedToId !== null && currentIndex >= 0 && idx > currentIndex;
                const isExpanded = Boolean(expandedNodes[node.id]);
                const hasDiffLog = node.files.length > 0;
                const hasChangelog = Boolean(
                  hasDiffLog ||
                    (node.changelog && node.changelog.trim()) ||
                    node.step?.bibleMarkdown ||
                    (node.activityItems && node.activityItems.length > 0) ||
                    node.step?.widgetType,
                );
                const additions = node.files.reduce((n, f) => n + f.additions, 0);
                const deletions = node.files.reduce((n, f) => n + f.deletions, 0);
                const isReverting = revertingId === node.id;
                const canRevert = node.isMajor && Boolean(node.revertTree) && !isCurrent;

                return (
                  <li
                    key={node.id}
                    className={`eg-tl-item is-${node.status} ${isCurrent ? 'is-current' : ''} ${
                      isAfterReverted ? 'is-future' : ''
                    } ${node.isMajor ? 'is-major' : 'is-minor'} ${isExpanded ? 'is-expanded' : ''}`}
                  >
                    <div ref={isCurrent ? currentNodeRef : undefined} className="eg-tl-anchor">
                      {/* Vertical connecting spine + marker dot */}
                      <div className="eg-tl-rail" aria-hidden="true">
                        <span className="eg-tl-dot-wrap">
                          {node.status === 'running' ? (
                            <StatusDot state="live" />
                          ) : (
                            <span className="eg-tl-dot" />
                          )}
                        </span>
                        {idx < nodes.length - 1 && <span className="eg-tl-line" />}
                      </div>

                      {/* Node body */}
                      <div className="eg-tl-body">
                        <div className="eg-tl-row">
                          <button
                            type="button"
                            className="eg-tl-toggle"
                            aria-expanded={isExpanded}
                            disabled={!hasChangelog}
                            title={
                              hasChangelog
                                ? isExpanded
                                  ? 'Hide changelog'
                                  : hasDiffLog
                                    ? 'Show diff log'
                                    : 'Show changelog'
                                : 'No details recorded'
                            }
                            onClick={() => hasChangelog && toggleNodeDrawer(node.id)}
                          >
                            <ChevronRight size={13} strokeWidth={1.75} className="eg-tl-chevron" />
                            <span className="eg-tl-title">{node.title}</span>
                          </button>

                          {node.step?.agentRole && (
                            <AgentRoleBadge role={node.step.agentRole} pieceId={node.step.pieceId} />
                          )}

                          {hasDiffLog && (
                            <button
                              type="button"
                              className="eg-tl-diffchip eg-tabular"
                              title="Show diff log for this checkpoint"
                              onClick={() => toggleNodeDrawer(node.id)}
                            >
                              <span>
                                {node.files.length} file{node.files.length === 1 ? '' : 's'}
                              </span>
                              <span className="is-add">+{additions}</span>
                              <span className="is-del">−{deletions}</span>
                            </button>
                          )}

                          <span className="eg-spacer" />

                          {node.step?.usage && <StepUsageBadge usage={node.step.usage} />}

                          {node.time && <span className="eg-tl-time eg-tabular">{node.time}</span>}

                          {/* Checkpoint revert button on every major step */}
                          {node.isMajor && (
                            isCurrent && revertedToId === node.id ? (
                              <Badge tone="accent">Current</Badge>
                            ) : isCurrent && node.status === 'running' ? (
                              <Badge tone="accent">Live</Badge>
                            ) : canRevert ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={RotateCcw}
                                className="eg-tl-revert-btn"
                                disabled={runActive || isReverting}
                                title={
                                  runActive
                                    ? 'Stop the run before reverting to a checkpoint'
                                    : node.kind === 'baseline'
                                      ? 'Revert all workspace files to before this run'
                                      : `Revert workspace to "${node.title}"`
                                }
                                onClick={() => void handleRevertToCheckpoint(node)}
                              >
                                {isReverting ? 'Reverting…' : 'Revert'}
                              </Button>
                            ) : node.kind === 'baseline' && isCurrent ? (
                              <Badge tone="accent">Baseline</Badge>
                            ) : isCurrent && hasGitBaseline && Boolean(node.revertTree) ? (
                              <Badge tone="neutral">Current</Badge>
                            ) : null
                          )}
                        </div>

                        {/* Expandable changelog / diff log drawer */}
                        {isExpanded && hasChangelog && (
                          <div className="eg-tl-drawer">
                            {hasDiffLog && (
                              <div className="eg-tl-difflog">
                                <div className="eg-tl-drawer-head">
                                  <span className="eg-tl-drawer-label">Diff log</span>
                                  <span className="eg-tl-drawer-stat eg-tabular">
                                    {node.files.length} file{node.files.length === 1 ? '' : 's'} ·{' '}
                                    <span className="is-add">+{additions}</span>{' '}
                                    <span className="is-del">−{deletions}</span>
                                  </span>
                                  <span className="eg-spacer" />
                                  {canRevert && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      icon={RotateCcw}
                                      disabled={runActive || isReverting}
                                      title={
                                        runActive
                                          ? 'Stop the run before reverting to a checkpoint'
                                          : node.kind === 'baseline'
                                            ? 'Revert all workspace files to before this run'
                                            : `Revert workspace to "${node.title}"`
                                      }
                                      onClick={() => void handleRevertToCheckpoint(node)}
                                    >
                                      {isReverting ? 'Reverting…' : 'Revert here'}
                                    </Button>
                                  )}
                                  {runId && canVisualDiff && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      icon={GitCompare}
                                      onClick={() =>
                                        setDiffModal({
                                          open: true,
                                          title: node.title,
                                          file: node.files[0]?.path,
                                          fromTree: node.diffFromTree,
                                          toTree: node.diffToTree,
                                          revertTargetTree: node.diffFromTree || baseTree,
                                        })
                                      }
                                    >
                                      Full diff
                                    </Button>
                                  )}
                                </div>
                                <ul className="eg-tl-difflist">
                                  {node.files.map((f) => {
                                    const fKey = `${node.id}:${f.path}`;
                                    const fOpen = Boolean(expandedFiles[fKey]);
                                    const { dir, name } = splitPath(f.path);
                                    return (
                                      <li key={f.path} className={`eg-tl-diffitem is-${f.status} ${fOpen ? 'is-expanded' : ''}`}>
                                        <div className="eg-tl-diffrow">
                                          <button
                                            type="button"
                                            className="eg-tl-diffpath"
                                            aria-expanded={fOpen}
                                            onClick={() => void toggleFileInlineDiff(node, f)}
                                          >
                                            <ChevronRight size={12} strokeWidth={1.75} className="eg-tl-chevron" />
                                            <Icon icon={STATUS_ICON[f.status]} size="sm" className="eg-runfiles-icon" />
                                            <span className="eg-runfiles-name">
                                              {dir && <span className="eg-runfiles-dir">{dir}</span>}
                                              {name}
                                            </span>
                                          </button>
                                          <span className="eg-runfiles-stat eg-tabular">
                                            {f.binary ? (
                                              <span className="eg-subtle">binary</span>
                                            ) : (
                                              <>
                                                <span className="is-add">+{f.additions}</span>
                                                <span className="is-del">−{f.deletions}</span>
                                              </>
                                            )}
                                          </span>
                                          {onPreview && f.status !== 'deleted' && isPreviewableFile(f.path) && (
                                            <IconButton
                                              icon={Eye}
                                              size="sm"
                                              label="Preview"
                                              title={`Preview ${f.path} in Ergo`}
                                              onClick={() => onPreview(f.path)}
                                            />
                                          )}
                                          {!runActive && runId && canVisualDiff && (
                                            <IconButton
                                              icon={Undo2}
                                              size="sm"
                                              label="Discard file"
                                              title={`Discard changes to ${f.path}`}
                                              onClick={() => void handleDiscardSingleFile(node, f)}
                                            />
                                          )}
                                        </div>
                                        {fOpen && (
                                          <div className="eg-tl-diffinline">
                                            <InlineDiffView
                                              diffText={diffCache[fKey]}
                                              file={f}
                                              loading={Boolean(diffLoading[fKey])}
                                              maxLines={32}
                                              onExpandFull={() =>
                                                setDiffModal({
                                                  open: true,
                                                  title: node.title,
                                                  file: f.path,
                                                  fromTree: node.diffFromTree,
                                                  toTree: node.diffToTree,
                                                  revertTargetTree: node.diffFromTree || baseTree,
                                                })
                                              }
                                            />
                                          </div>
                                        )}
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            )}

                            {/* Non-coding changelog / step summary */}
                            {node.changelog && node.changelog.trim() && (
                              <div className="eg-tl-changelog">
                                {!hasDiffLog && (
                                  <div className="eg-tl-drawer-head">
                                    <span className="eg-tl-drawer-label">Changelog</span>
                                    {canRevert && (
                                      <>
                                        <span className="eg-spacer" />
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          icon={RotateCcw}
                                          disabled={runActive || isReverting}
                                          title={
                                            runActive
                                              ? 'Stop the run before reverting to a checkpoint'
                                              : node.kind === 'baseline'
                                                ? 'Revert all workspace files to before this run'
                                                : `Revert workspace to "${node.title}"`
                                          }
                                          onClick={() => void handleRevertToCheckpoint(node)}
                                        >
                                          {isReverting ? 'Reverting…' : 'Revert here'}
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                )}
                                <div className="eg-tl-changelog-body">
                                  <MarkdownRenderer content={node.changelog} />
                                </div>
                              </div>
                            )}

                            {node.step?.bibleMarkdown && (
                              <BiblePreview
                                markdown={node.step.bibleMarkdown}
                                filePath={node.step.bibleFilePath}
                              />
                            )}

                            {/* Live CLI activity entries nested under this step */}
                            {node.activityItems && node.activityItems.length > 0 && (
                              <div className="eg-tl-subactivity">
                                <div className="eg-tl-drawer-head">
                                  <span className="eg-tl-drawer-label">Agent actions</span>
                                  <span className="eg-tl-drawer-stat eg-tabular">{node.activityItems.length}</span>
                                </div>
                                <ul className="eg-tl-actlist">
                                  {node.activityItems.map((act) => (
                                    <li key={act.id} className={`eg-tl-actrow is-${act.type}`}>
                                      <span className="eg-tl-acttext">
                                        <FileLinkText text={act.text} />
                                        {act.detail && act.detail !== act.text && (
                                          <code className="eg-tl-actcode">
                                            <FileLinkText text={act.detail} inCode />
                                          </code>
                                        )}
                                      </span>
                                      <span className="eg-tl-acttime eg-tabular">{act.timestamp}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {node.step?.humanInputPrompt &&
                              node.step.status === 'running' &&
                              onHumanInputChoice &&
                              renderHumanInput &&
                              !pendingHumanInput && (
                                <div style={{ marginTop: 'var(--space-2)' }}>
                                  {renderHumanInput(node.step.humanInputPrompt, onHumanInputChoice)}
                                </div>
                              )}

                            {node.step?.widgetType && renderMcpWidget && renderMcpWidget(node.step.widgetType, node.step.widgetData)}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          {!followCurrent && currentNodeId && (
            <button
              type="button"
              className="eg-tl-jump"
              onClick={() => {
                setFollowCurrent(true);
                scrollToCurrent('smooth');
              }}
            >
              <Icon icon={ArrowDown} size="sm" />
              <span>Jump to current</span>
            </button>
          )}
        </div>
      )}

      {runId && canVisualDiff && (
        <VisualDiffModal
          open={diffModal.open}
          onClose={() => setDiffModal((m) => ({ ...m, open: false }))}
          runId={runId}
          title={diffModal.title}
          initialFile={diffModal.file}
          fromTree={diffModal.fromTree}
          toTree={diffModal.toTree}
          revertTargetTree={diffModal.revertTargetTree}
          root={runRoot}
          active={runActive}
          onReverted={() => {
            onReverted?.();
            void loadGitState();
          }}
        />
      )}
    </div>
  );
};
