import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, ScrollText } from 'lucide-react';
import type { WorkspaceSkill } from '../types';
import {
  getGlobalScope,
  getLaneScope,
  saveGlobalScope,
  saveLaneScope,
  subscribeScopedRules,
  type ScopeConfig,
} from '../lib/scopedRules';
import { getWorkspaceSkills, subscribeWorkspaceSkills } from '../lib/skillsManager';

interface ScopedRulesModalProps {
  laneId: string;
  laneTitle: string;
  onClose: () => void;
}

/**
 * Rules and skills for the tasks of one swim lane, or for every task. Every run of a task in scope gets the rules (with
 * the project's learned rules) and applies the skills, as if the task had invoked them with /name.
 */
export const ScopedRulesModal: React.FC<ScopedRulesModalProps> = ({ laneId, laneTitle, onClose }) => {
  const [scope, setScope] = useState<'lane' | 'global'>('lane');
  const [, setVersion] = useState(0);
  const [skills, setSkills] = useState<WorkspaceSkill[]>(() => getWorkspaceSkills());
  const [draft, setDraft] = useState('');
  useEffect(() => subscribeScopedRules(() => setVersion((v) => v + 1)), []);
  useEffect(() => subscribeWorkspaceSkills(setSkills), []);

  const config = scope === 'lane' ? getLaneScope(laneId) : getGlobalScope();
  const save = (next: ScopeConfig) => void (scope === 'lane' ? saveLaneScope(laneId, next) : saveGlobalScope(next));
  const addRule = () => {
    const text = draft.trim();
    if (!text) return;
    save({ ...config, rules: [...config.rules, { id: `rule-${Date.now()}`, text }] });
    setDraft('');
  };
  const toggleSkill = (id: string) =>
    save({ ...config, skillIds: config.skillIds.includes(id) ? config.skillIds.filter((s) => s !== id) : [...config.skillIds, id] });
  const enabledSkills = skills.filter((s) => s.enabled);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content scoped-rules-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
            <ScrollText size={17} color="var(--accent-violet)" />
            <h3 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 650, color: 'var(--text-bright)' }}>Skills &amp; rules</h3>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body scoped-rules-body">
          <div className="scoped-rules-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={scope === 'lane'} className={scope === 'lane' ? 'is-active' : ''} onClick={() => setScope('lane')}>
              This lane: {laneTitle}
            </button>
            <button type="button" role="tab" aria-selected={scope === 'global'} className={scope === 'global' ? 'is-active' : ''} onClick={() => setScope('global')}>
              Every task
            </button>
          </div>
          <p className="scoped-rules-hint">
            {scope === 'lane'
              ? `Every run of a task in "${laneTitle}" follows these rules and applies these skills, on top of the ones for every task.`
              : 'Every run of every task, in every project, follows these rules and applies these skills.'}
          </p>

          <h4>Rules</h4>
          <div className="scoped-rules-list">
            {config.rules.length === 0 && <div className="scoped-rules-empty">No rules yet.</div>}
            {config.rules.map((rule) => (
              <div key={rule.id} className="scoped-rules-row">
                <span>{rule.text}</span>
                <button
                  type="button"
                  className="btn-icon"
                  title="Delete rule"
                  aria-label="Delete rule"
                  onClick={() => save({ ...config, rules: config.rules.filter((r) => r.id !== rule.id) })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <form
            className="scoped-rules-add"
            onSubmit={(e) => {
              e.preventDefault();
              addRule();
            }}
          >
            <input
              className="input-text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={scope === 'lane' ? 'e.g. Tasks here are for the iOS app; test on the simulator' : 'e.g. Never commit or push; leave that to me'}
            />
            <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
              <Plus size={13} />
              <span>Add rule</span>
            </button>
          </form>

          <h4>Skills</h4>
          <div className="scoped-rules-list">
            {enabledSkills.length === 0 && <div className="scoped-rules-empty">No skills are turned on (Connections → Tools &amp; Skills).</div>}
            {enabledSkills.map((skill) => (
              <label key={skill.id} className="scoped-rules-skill">
                <input type="checkbox" checked={config.skillIds.includes(skill.id)} onChange={() => toggleSkill(skill.id)} />
                <span>
                  <strong>{skill.name}</strong>
                  {skill.description && <small>{skill.description}</small>}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
