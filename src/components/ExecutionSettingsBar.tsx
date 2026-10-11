import React from 'react';
import { ShieldCheck, Gauge, AlertTriangle } from 'lucide-react';
import { type AgentPipelineOptions, type EffortLevel, type PermissionLevel } from '../types';
import { EFFORT_LABELS, EFFORT_LEVELS } from '../lib/agentPipeline/modelRouter';

const PERMISSION_LEVELS: PermissionLevel[] = ['plan', 'ask', 'acceptEdits', 'bypass'];

const PERMISSION_COPY: Record<PermissionLevel, { label: string; detail: string }> = {
  plan: { label: 'Plan', detail: "Read-only. The agent can look around but won't edit files or run commands." },
  ask: { label: 'Ask', detail: 'Asks before every file edit, command, and external tool.' },
  acceptEdits: {
    label: 'Accept edits',
    detail: 'Edits workspace files and runs read-only commands (ls, cat, git status…) freely. Asks before other commands and external tools.'
  },
  bypass: { label: 'Full access', detail: 'Never asks. Edits, commands, and tools all run without approval.' }
};

const EFFORT_DETAIL: Record<EffortLevel, string> = {
  low: 'Fastest and cheapest: light models at every stage, minimal reasoning (e.g. Sonnet as the Claude manager).',
  medium: 'Balanced: mid-tier manager and workers, light models for bookkeeping stages.',
  high: 'Stronger models for planning and implementation, deeper reasoning (e.g. Opus as the Claude manager).',
  xhigh: 'Frontier manager with strong workers and extended reasoning (e.g. Fable as the Claude manager).',
  max: 'Most capable models at maximum reasoning for every core stage. Highest cost.'
};

interface ExecutionSettingsBarProps {
  options: AgentPipelineOptions;
  onChange: (next: AgentPipelineOptions) => void;
}

/**
 * Drop-down strip under the AI Workspace header (mirrors the human side's formatting bar) with the
 * permission-level and effort sliders. Values persist in settings.json and apply from the next run.
 */
export const ExecutionSettingsBar: React.FC<ExecutionSettingsBarProps> = ({ options, onChange }) => {
  const permissionIdx = Math.max(0, PERMISSION_LEVELS.indexOf(options.permissionLevel));
  const effortIdx = Math.max(0, EFFORT_LEVELS.indexOf(options.effortLevel));
  const permission = PERMISSION_COPY[PERMISSION_LEVELS[permissionIdx]];

  return (
    <div className="exec-settings-bar" role="group" aria-label="Execution settings">
      <div className="exec-setting">
        <div className="exec-setting-head">
          <ShieldCheck size={13} className="exec-setting-icon" />
          <label htmlFor="exec-permission-slider" className="exec-setting-label">Permissions</label>
          <span className={`exec-setting-value ${options.permissionLevel === 'bypass' ? 'is-warning' : ''}`}>{permission.label}</span>
        </div>
        <input
          id="exec-permission-slider"
          type="range"
          className="exec-slider"
          min={0}
          max={PERMISSION_LEVELS.length - 1}
          step={1}
          value={permissionIdx}
          aria-valuetext={permission.label}
          onChange={(e) => onChange({ ...options, permissionLevel: PERMISSION_LEVELS[Number(e.target.value)] })}
        />
        <div className="exec-slider-ticks" aria-hidden="true">
          {PERMISSION_LEVELS.map((lvl, idx) => (
            <span key={lvl} className={idx === permissionIdx ? 'is-active' : ''}>{PERMISSION_COPY[lvl].label}</span>
          ))}
        </div>
        <p className="exec-setting-detail">
          {options.permissionLevel === 'bypass' && <AlertTriangle size={11} className="exec-warning-icon" />}
          {permission.detail}
        </p>
      </div>

      <div className="exec-setting">
        <div className="exec-setting-head">
          <Gauge size={13} className="exec-setting-icon" />
          <label htmlFor="exec-effort-slider" className="exec-setting-label">Effort</label>
          <span className="exec-setting-value">{EFFORT_LABELS[options.effortLevel]}</span>
        </div>
        <input
          id="exec-effort-slider"
          type="range"
          className="exec-slider"
          min={0}
          max={EFFORT_LEVELS.length - 1}
          step={1}
          value={effortIdx}
          aria-valuetext={EFFORT_LABELS[options.effortLevel]}
          onChange={(e) => onChange({ ...options, effortLevel: EFFORT_LEVELS[Number(e.target.value)] })}
        />
        <div className="exec-slider-ticks" aria-hidden="true">
          {EFFORT_LEVELS.map((lvl, idx) => (
            <span key={lvl} className={idx === effortIdx ? 'is-active' : ''}>{EFFORT_LABELS[lvl]}</span>
          ))}
        </div>
        <p className="exec-setting-detail">{EFFORT_DETAIL[options.effortLevel]}</p>
        <label className="exec-setting-toggle">
          <input
            type="checkbox"
            checked={options.autoModelRouting}
            onChange={(e) => onChange({ ...options, autoModelRouting: e.target.checked })}
          />
          <span>Pick a model per stage from effort (Laya decides when connected; models pinned in AI settings always win)</span>
        </label>
      </div>

      <p className="exec-settings-footnote">Applies to the next task run.</p>
    </div>
  );
};
