/**
 * Learned rules — Settings › Rules (and the old Archives modal's Learnings tab) where the user sees and steers what Ergo learned from their feedback
 * (memory/insights.ts): edit, delete, choose whether a rule applies to every task. The last change can
 * be undone. Every run of the project gets these rules.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Check, Pencil, ScrollText, Trash2, Undo2, X } from 'lucide-react';
import { Banner, Button, EmptyState, IconButton, Input, SegmentedControl } from './ui';
import {
  applyInsightOps,
  insightsSupported,
  listInsights,
  onInsightsChanged,
  undoInsightChanges,
  type InsightChange,
  type InsightOp,
  type ProjectInsight,
} from '../lib/memory/insights';

export const LearnedRulesSection: React.FC<{ projectId: string }> = ({ projectId }) => {
  const supported = insightsSupported();
  const [rules, setRules] = useState<ProjectInsight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [lastChange, setLastChange] = useState<{ label: string; changes: InsightChange[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported || !projectId) return;
    let alive = true;
    listInsights(projectId)
      .then((list) => alive && setRules(list))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    const off = onInsightsChanged((pid, list) => {
      if (pid === projectId) setRules(list);
    });
    return () => {
      alive = false;
      off();
    };
  }, [projectId, supported]);

  const apply = useCallback(
    async (ops: InsightOp[], label: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await applyInsightOps(projectId, ops, { origin: 'user' });
        setRules(res.insights);
        setLastChange(res.changes.length > 0 ? { label, changes: res.changes } : null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [projectId]
  );

  const undo = async () => {
    if (!lastChange) return;
    setBusy(true);
    try {
      const res = await undoInsightChanges(projectId, lastChange.changes);
      setRules(res.insights);
      setLastChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = (rule: ProjectInsight) => {
    const text = draft.trim();
    setEditingId(null);
    if (text && text !== rule.text) void apply([{ op: 'update', id: rule.id, text }], 'Rule edited.');
  };

  return (
    <div className="eg-settings-rules">
      <p className="eg-settings-groupdesc">
        When you correct the agent, Ergo saves what should apply to future tasks here, and every run follows
        these rules. "Every task" rules always apply; topical ones guide related work.
      </p>

      {!supported ? (
        <Banner tone="warning" title="Rules need a newer bridge" text="Update Ergo Bridge to see and edit learned rules." />
      ) : (
        <>
          {error && <Banner tone="danger" title="Couldn't load rules" text={error} />}
          {rules === null && !error && <p className="eg-srow-help">Loading…</p>}
          {rules && rules.length === 0 && (
            <EmptyState icon={ScrollText} title="No rules yet" text="Rules appear here when you correct the agent, or when you add your own." />
          )}
          {rules && rules.length > 0 && (
            <div className="eg-srows">
              {rules.map((rule) => (
                <div key={rule.id} className="eg-srow eg-settings-top">
                  <div className="eg-srow-text">
                    {editingId === rule.id ? (
                      <div className="eg-settings-actions">
                        <Input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit(rule);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          aria-label="Rule"
                          style={{ flex: 1 }}
                          maxLength={400}
                        />
                        <IconButton icon={Check} label="Save rule" size="sm" onClick={() => saveEdit(rule)} />
                        <IconButton icon={X} label="Cancel" size="sm" onClick={() => setEditingId(null)} />
                      </div>
                    ) : (
                      <div className="eg-srow-title">{rule.text}</div>
                    )}
                    <div className="eg-srow-help">
                      {rule.origin === 'user' ? 'Added by you' : 'Learned from a correction'}
                      {rule.confirms > 1 ? ` · said ${rule.confirms} times` : ''}
                      {rule.taskTitle ? ` · from "${rule.taskTitle}"` : ''}
                    </div>
                  </div>
                  <div className="eg-settings-actions">
                    <SegmentedControl
                      label="Applies to"
                      disabled={busy}
                      options={[
                        { id: 'always', label: 'Every task' },
                        { id: 'topical', label: 'Related work' },
                      ]}
                      value={rule.scope === 'always' ? 'always' : 'topical'}
                      onChange={(v) => {
                        if ((v === 'always') !== (rule.scope === 'always')) void apply([{ op: 'update', id: rule.id, scope: v }], 'Scope changed.');
                      }}
                    />
                    <IconButton
                      icon={Pencil}
                      label="Edit rule"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(rule.id);
                        setDraft(rule.text);
                      }}
                    />
                    <IconButton icon={Trash2} label="Delete rule" size="sm" disabled={busy} onClick={() => void apply([{ op: 'delete', id: rule.id }], 'Rule deleted.')} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {lastChange && (
            <div className="eg-settings-actions eg-settings-undo">
              <span className="eg-srow-help">{lastChange.label}</span>
              <Button size="sm" variant="ghost" icon={Undo2} disabled={busy} onClick={() => void undo()}>
                Undo
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
