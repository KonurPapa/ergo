import React from 'react';
import { ShieldCheck, Gauge, AlertTriangle, Cpu } from 'lucide-react';
import { type AgentPipelineOptions, type EffortLevel, type ModelSelectionMode, type PermissionLevel } from '../types';
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

/** Effort in Auto: the quality-vs-cost balance of the picked models, plus reasoning depth. */
const EFFORT_DETAIL_AUTO: Record<EffortLevel, string> = {
  low: 'Cheapest models that can handle each stage, minimal reasoning.',
  medium: "Balanced: models matched to the task's difficulty, standard reasoning.",
  high: 'A step above what the task needs, deeper reasoning.',
  xhigh: 'Well above what the task needs, extended reasoning.',
  max: 'The strongest available model for every core stage, maximum reasoning. Highest cost.'
};

/** Effort in Manual: reasoning depth only (the models are the AI profile's). */
const EFFORT_DETAIL_MANUAL: Record<EffortLevel, string> = {
  low: 'Minimal reasoning. Fastest and cheapest.',
  medium: 'Standard reasoning.',
  high: 'Deeper reasoning for planning and implementation.',
  xhigh: 'Extended reasoning.',
  max: 'Maximum reasoning at every core stage. Highest cost.'
};

const MODEL_SELECTION_COPY: Record<ModelSelectionMode, { label: string; detail: string }> = {
  auto: {
    label: 'Auto',
    detail: "Picks each stage's model for the task from your provider's models, live prices and model strengths. Effort sets the quality/cost balance."
  },
  manual: {
    label: 'Manual',
    detail: 'Uses the models set per stage in your AI profile. Effort sets reasoning depth.'
  }
};

interface ExecutionSettingsBarProps {
  options: AgentPipelineOptions;
  onChange: (next: AgentPipelineOptions) => void;
}

/**
 * Drop-down strip under the AI Workspace header (mirrors the human side's formatting bar) with the
 * permission-level and effort sliders and the Auto / Manual model selection. Values persist in settings.json. Permission changes apply immediately to
 * running agents (App pushes them to the in-app pipeline and to every CLI session); effort applies from the next run.
 */
export const ExecutionSettingsBar: React.FC<ExecutionSettingsBarProps> = ({ options, onChange }) => {
  const permissionIdx = Math.max(0, PERMISSION_LEVELS.indexOf(options.permissionLevel));
  const effortIdx = Math.max(0, EFFORT_LEVELS.indexOf(options.effortLevel));
  const permission = PERMISSION_COPY[PERMISSION_LEVELS[permissionIdx]];
  const modelSelection: ModelSelectionMode = options.modelSelection === 'manual' ? 'manual' : 'auto';

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
        <p className="exec-setting-detail">
          {(modelSelection === 'auto' ? EFFORT_DETAIL_AUTO : EFFORT_DETAIL_MANUAL)[options.effortLevel]}
        </p>
      </div>

      <div className="exec-setting">
        <div className="exec-setting-head">
          <Cpu size={13} className="exec-setting-icon" />
          <span id="exec-models-label" className="exec-setting-label">Models</span>
          <span className="exec-setting-value">{MODEL_SELECTION_COPY[modelSelection].label}</span>
        </div>
        <div className="exec-segmented" role="radiogroup" aria-labelledby="exec-models-label">
          {(['auto', 'manual'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={modelSelection === m}
              className={`exec-segment${modelSelection === m ? ' is-active' : ''}`}
              onClick={() => onChange({ ...options, modelSelection: m })}
            >
              {MODEL_SELECTION_COPY[m].label}
            </button>
          ))}
        </div>
        <p className="exec-setting-detail">{MODEL_SELECTION_COPY[modelSelection].detail}</p>
      </div>

      <p className="exec-settings-footnote">
        Permission changes apply immediately to running agents. CLI agents that can't switch mode live are flagged so you can restart them; in Full access Ergo approves their prompts for them. Effort and Models apply from the next run.
      </p>
    </div>
  );
};
