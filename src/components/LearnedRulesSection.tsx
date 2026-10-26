/**
 * Learned rules — the Workspace Settings section where the user sees and steers what Ergo learned from their feedback
 * (memory/insights.ts): edit, delete, add their own, choose whether a rule applies to every task. The last change can
 * be undone. Every run of the project gets these rules.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BookOpenCheck, Check, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react';
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

const smallBtn: React.CSSProperties = { fontSize: '0.75rem', padding: '0.2rem 0.45rem', display: 'flex', alignItems: 'center', gap: '0.3rem' };

export const LearnedRulesSection: React.FC<{ projectId: string; projectName: string }> = ({ projectId, projectName }) => {
  const supported = insightsSupported();
  const [rules, setRules] = useState<ProjectInsight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newRule, setNewRule] = useState('');
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

  const addRule = () => {
    const text = newRule.trim();
    if (!text) return;
    setNewRule('');
    void apply([{ op: 'add', text, scope: 'topical' }], 'Rule added.');
  };

  return (
    <div
      style={{
        background: 'rgba(16, 185, 129, 0.025)',
        border: '1px solid rgba(16, 185, 129, 0.2)',
        borderRadius: '8px',
        padding: '1rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
        <BookOpenCheck size={16} color="var(--accent-emerald)" />
        <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-bright)' }}>Learned Rules</span>
        {rules && (
          <span style={{ fontSize: '0.68rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {rules.length} for "{projectName}"
          </span>
        )}
      </div>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem', lineHeight: '1.4' }}>
        When you correct a run, Ergo saves what should apply to future tasks in this project as a rule, and every run gets
        these rules. "Every task" rules (package manager, checks to run, git habits) always apply; topical ones guide related
        work. Clearing the project's memory keeps them.
      </p>

      {!supported ? (
        <p style={{ fontSize: '0.8rem', color: 'var(--accent-amber)' }}>Update the Ergo bridge to use learned rules.</p>
      ) : (
        <>
          {error && <p style={{ fontSize: '0.78rem', color: 'var(--accent-rose)', marginBottom: '0.5rem' }}>{error}</p>}
          {rules === null && !error && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Loading…</p>}
          {rules && rules.length === 0 && (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: '0.6rem' }}>
              Nothing learned yet. Rules appear here after you send a run feedback such as "we use pnpm, never npm".
            </p>
          )}
          {rules && rules.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '0 0 0.6rem', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  style={{ border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '0.45rem 0.55rem', background: 'rgba(255,255,255,0.02)' }}
                >
                  {editingId === rule.id ? (
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      <input
                        className="input-text"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(rule);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        style={{ flex: 1, fontSize: '0.8rem' }}
                        maxLength={400}
                      />
                      <button type="button" className="btn btn-secondary" style={smallBtn} onClick={() => saveEdit(rule)} title="Save">
                        <Check size={12} />
                      </button>
                      <button type="button" className="btn btn-secondary" style={smallBtn} onClick={() => setEditingId(null)} title="Cancel">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-bright)', lineHeight: 1.4 }}>{rule.text}</div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ ...smallBtn, color: rule.scope === 'always' ? 'var(--accent-emerald)' : 'var(--text-muted)' }}
                      disabled={busy}
                      title={rule.scope === 'always' ? 'Applies to every task. Click to apply only to related work.' : 'Applies to related work. Click to apply to every task.'}
                      onClick={() =>
                        void apply([{ op: 'update', id: rule.id, scope: rule.scope === 'always' ? 'topical' : 'always' }], 'Scope changed.')
                      }
                    >
                      {rule.scope === 'always' ? 'Every task' : 'Topical'}
                    </button>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {rule.origin === 'user' ? 'Yours' : 'Learned'}
                      {rule.confirms > 1 ? ` · said ${rule.confirms}×` : ''}
                      {rule.taskTitle ? ` · from "${rule.taskTitle}"` : ''}
                    </span>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={smallBtn}
                      disabled={busy}
                      title="Edit"
                      onClick={() => {
                        setEditingId(rule.id);
                        setDraft(rule.text);
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ ...smallBtn, color: 'var(--accent-rose)' }}
                      disabled={busy}
                      title="Delete"
                      onClick={() => void apply([{ op: 'delete', id: rule.id }], 'Rule deleted.')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {lastChange && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              <span>{lastChange.label}</span>
              <button type="button" className="btn btn-secondary" style={smallBtn} disabled={busy} onClick={() => void undo()}>
                <Undo2 size={12} />
                <span>Undo</span>
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              className="input-text"
              placeholder="Add a rule, e.g. Run npm test before saying a task is done."
              value={newRule}
              onChange={(e) => setNewRule(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addRule();
              }}
              style={{ flex: 1, fontSize: '0.8rem' }}
              maxLength={400}
            />
            <button type="button" className="btn btn-secondary" style={smallBtn} disabled={busy || !newRule.trim()} onClick={addRule}>
              <Plus size={12} />
              <span>Add</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};
