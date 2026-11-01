/**
 * Settings as a full page (design: SettingsScreen). A left nav in three groups (Project · Agents · App) and one page
 * at a time, replacing the old Workspace settings, AI profiles, Connections and Archives modals. Most pages render
 * those components in their `embedded` mode, so every feature keeps its existing behavior; Models, Permissions and
 * Shortcuts are composed here.
 */
import React, { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  Cpu,
  Folder,
  Keyboard,
  Library,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  ScrollText,
  Settings,
  Shield,
  Slash,
  Sun,
  Trash2,
} from 'lucide-react';
import type { AgentPipelineOptions, AgentRole, AIProviderId, EffortLevel, UserApiKey } from '../types';
import { SETTINGS_PAGES, type SettingsGroupId, type SettingsPage } from '../lib/settingsPages';
import { SUPPORTED_AI_PROVIDERS, getDefaultModelForRole } from '../lib/aiProviders';
import { CLI_AGENT_PRESETS } from '../lib/cliAgents';
import { EFFORT_LABELS } from '../lib/agentPipeline/modelRouter';
import { ALT, ENTER, MOD, SHIFT } from '../lib/shortcuts';
import { SettingsModal, type SettingsModalProps } from './SettingsModal';
import { AiCredentialsModal, type AiCredentialsModalProps } from './AiCredentialsModal';
import { McpHubModal, type McpHubModalProps } from './McpHubModal';
import { ArchivedTasksModal, type ArchivedTasksModalProps } from './ArchivedTasksModal';
import { EFFORT_DETAIL_AUTO, EFFORT_DETAIL_MANUAL, MODEL_SELECTION_COPY, PERMISSION_COPY, PERMISSION_LEVELS } from './ExecutionSettingsBar';
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Kbd,
  MenuButton,
  SegmentedControl,
  SettingsGroup,
  SettingsRow,
  StatusDot,
  type MenuItem,
} from './ui';

export type { SettingsPage } from '../lib/settingsPages';

export interface SettingsScreenProps {
  page: SettingsPage;
  onNavigate: (page: SettingsPage) => void;
  /** "Back to tasks". */
  onClose: () => void;
  projectName: string;
  /** Workspace settings (General, Memory, Models › runs, Bridge, Appearance). Also carries the pipeline options. */
  settings: Omit<SettingsModalProps, 'isOpen' | 'onClose' | 'embedded' | 'section'>;
  /** AI profiles (Models). The add/edit form opens as a dialog from the Models page. */
  credentials: Omit<AiCredentialsModalProps, 'isOpen' | 'onClose' | 'editingKey' | 'formOnly'>;
  /** Allowed folders, skills and integrations (Folders, Skills, Integrations). */
  mcp: Omit<McpHubModalProps, 'isOpen' | 'onClose' | 'embedded' | 'section'>;
  /** Archived tasks, learned rules and agent notes (Archive, Rules, Memory). */
  archive: Omit<ArchivedTasksModalProps, 'isOpen' | 'onClose' | 'embedded' | 'page' | 'initialTab'>;
}

const PAGE_ICONS: Record<SettingsPage, LucideIcon> = {
  general: Settings,
  folders: Folder,
  rules: ScrollText,
  memory: Library,
  archive: Archive,
  models: Cpu,
  permissions: Shield,
  skills: Slash,
  integrations: Puzzle,
  bridge: Plug,
  appearance: Sun,
  shortcuts: Keyboard,
};

const PAGE_DESCRIPTIONS: Record<SettingsPage, string> = {
  general: "The project's files, how the editor behaves, and where Ergo keeps its data.",
  folders: 'Folders agents may read and write. Each one is indexed so agents can search its code.',
  rules: 'Instructions the agent follows on every run of this project.',
  memory: 'What the agent knows about this project and searches before it works.',
  archive: 'Tasks and runs you archived. Restore them any time.',
  models: 'Which agent runs your tasks, and how Ergo picks a model for each stage.',
  permissions: 'How much agents may do before they ask you.',
  skills: 'Reusable workflows the agent can follow.',
  integrations: "Services agents can use through MCP, and Ergo's built-in tools.",
  bridge: 'The small app that connects Ergo to this computer.',
  appearance: 'How Ergo looks.',
  shortcuts: `Keyboard shortcuts. Ergo uses ${MOD} as the main modifier on this computer.`,
};

const GROUP_LABELS: Record<SettingsGroupId, string> = { project: 'Project', agents: 'Agents', app: 'App' };
const GROUP_ORDER: SettingsGroupId[] = ['project', 'agents', 'app'];

/* ───────────── Models ───────────── */

/** The design's four stages, each covering the pipeline roles it stands for. */
const STAGES: Array<{ name: string; detail: string; roles: AgentRole[] }> = [
  { name: 'Manager', detail: 'Orchestrates the work and checks results', roles: ['manager', 'verifier'] },
  { name: 'Worker', detail: 'Agents that edit code and run commands', roles: ['worker'] },
  { name: 'Summarize', detail: 'Working briefs, completion notes and logs', roles: ['summary', 'logger'] },
  { name: 'Background', detail: 'Autocomplete and cleanup', roles: ['autocomplete', 'cleaner'] },
];

/** The legacy per-role field each role also writes, so older readers of the profile see the same model. */
const LEGACY_FIELD: Record<AgentRole, keyof UserApiKey> = {
  summary: 'summaryModel',
  manager: 'generalModel',
  worker: 'workerModel',
  cleaner: 'cleanerModel',
  verifier: 'verifierModel',
  logger: 'loggerModel',
  autocomplete: 'autocompleteModel',
};

const EFFORT_STOPS: EffortLevel[] = ['low', 'medium', 'high', 'max'];

const isSubscription = (k: UserApiKey) => k.authMode === 'cli_subscription' || k.apiKey === 'cli_subscription_active';

function profileAgentName(k: UserApiKey): string {
  if (isSubscription(k)) {
    const preset = CLI_AGENT_PRESETS.find((p) => p.id === (k.cliPresetId || k.cliAgentId));
    if (preset?.label) return preset.label;
  }
  return SUPPORTED_AI_PROVIDERS.find((p) => p.id === k.provider)?.name || k.provider;
}

function profileSummary(k: UserApiKey): string {
  if (k.provider === 'ollama') return `Local model · ${k.baseUrl || 'localhost:11434'}`;
  return `${profileAgentName(k)} · ${isSubscription(k) ? 'Subscription' : 'API key'}`;
}

function roleModel(k: UserApiKey, role: AgentRole): { provider: AIProviderId; model: string } {
  const cfg = k.roleConfigs?.[role];
  const provider = cfg?.provider || k.provider;
  const legacy = k[LEGACY_FIELD[role]] as string | undefined;
  const fallback = role === 'manager' || role === 'worker' || role === 'verifier' ? k.generalModel || k.model : undefined;
  return { provider, model: cfg?.model || legacy || fallback || getDefaultModelForRole(provider, role) };
}

function modelName(provider: AIProviderId, id: string): string {
  return SUPPORTED_AI_PROVIDERS.find((p) => p.id === provider)?.models.find((m) => m.id === id)?.name || id;
}

const ModelsPage: React.FC<{
  settings: SettingsScreenProps['settings'];
  credentials: SettingsScreenProps['credentials'];
}> = ({ settings, credentials }) => {
  const { userApiKeys, activeKeyId, onSelectActiveKey, onSaveUserKey, onDeleteUserKey } = credentials;
  const options = settings.agentPipelineOptions;
  const setOptions = (next: Partial<AgentPipelineOptions>) => settings.onSetAgentPipelineOptions({ ...options, ...next });
  const mode = options.modelSelection === 'manual' ? 'manual' : 'auto';
  const activeKey = userApiKeys.find((k) => k.id === activeKeyId) || null;
  const [editor, setEditor] = useState<{ open: boolean; key: UserApiKey | null }>({ open: false, key: null });
  const [pendingDelete, setPendingDelete] = useState<UserApiKey | null>(null);

  const openEditor = (key: UserApiKey | null) => setEditor({ open: true, key });

  const providerItems: MenuItem[] = [
    ...userApiKeys.map((k) => ({
      label: k.name,
      hint: profileSummary(k),
      checked: k.id === activeKeyId,
      onSelect: () => onSelectActiveKey(k.id),
    })),
    ...(userApiKeys.length > 0 ? [{ separator: true } as const] : []),
    { label: 'Add profile', icon: Plus, onSelect: () => openEditor(null) },
  ];

  const setStageModel = (roles: AgentRole[], provider: AIProviderId, model: string) => {
    if (!activeKey) return;
    const roleConfigs = { ...(activeKey.roleConfigs || {}) };
    const legacy: Partial<UserApiKey> = {};
    for (const role of roles) {
      roleConfigs[role] = { ...(roleConfigs[role] || {}), provider, model };
      (legacy as Record<string, string>)[LEGACY_FIELD[role] as string] = model;
    }
    onSaveUserKey({ ...activeKey, ...legacy, roleConfigs });
  };

  const effortHelp = options.effortLevel === 'xhigh'
    ? `Set to ${EFFORT_LABELS.xhigh}. Pick a stop to change it. Applies from the next run.`
    : `${(mode === 'auto' ? EFFORT_DETAIL_AUTO : EFFORT_DETAIL_MANUAL)[options.effortLevel]} Applies from the next run.`;

  return (
    <>
      <SettingsGroup title="Agent">
        <SettingsRow
          title="Provider"
          help={
            activeKey
              ? isSubscription(activeKey)
                ? "Runs through the bridge using the CLI's own login."
                : activeKey.provider === 'ollama'
                  ? 'Runs on a local model through Ollama.'
                  : 'Uses your API key with the provider directly.'
              : 'No AI profile yet. Add one to run tasks.'
          }
        >
          <MenuButton
            align="end"
            width={300}
            items={providerItems}
            trigger={(t) => (
              <button type="button" className="eg-select" {...t}>
                {activeKey ? (
                  <>
                    <StatusDot state={activeKey.isConnected === false ? 'idle' : 'success'} />
                    {profileSummary(activeKey)}
                  </>
                ) : (
                  'Choose a profile'
                )}
                <Icon icon={ChevronDown} size="sm" />
              </button>
            )}
          />
        </SettingsRow>
        <SettingsRow title="Selection" help={MODEL_SELECTION_COPY[mode].detail}>
          <SegmentedControl
            label="Model selection"
            options={[
              { id: 'auto', label: 'Auto' },
              { id: 'manual', label: 'Manual' },
            ]}
            value={mode}
            onChange={(m) => setOptions({ modelSelection: m })}
          />
        </SettingsRow>
        <SettingsRow title="Effort" help={effortHelp}>
          <SegmentedControl
            label="Effort"
            options={EFFORT_STOPS.map((e) => ({ id: e, label: EFFORT_LABELS[e] }))}
            value={options.effortLevel}
            onChange={(e) => setOptions({ effortLevel: e })}
          />
        </SettingsRow>
      </SettingsGroup>

      <section className={`eg-sgroup ${mode === 'auto' ? 'is-auto-stages' : ''}`}>
        <h3 className="eg-sgroup-title">
          Stages <span className="eg-settings-note">· {mode === 'manual' ? 'Manual' : 'Auto picks these per task'}</span>
        </h3>
        {!activeKey ? (
          <p className="eg-settings-groupdesc">Add a profile below to choose a model for each stage.</p>
        ) : (
        <>
          <div className="eg-settings-stages">
            {STAGES.map((stage) => {
              const current = stage.roles.map((r) => roleModel(activeKey, r));
              const provider = current[0].provider;
              const distinct = Array.from(new Set(current.map((c) => modelName(c.provider, c.model))));
              const models = SUPPORTED_AI_PROVIDERS.find((p) => p.id === provider)?.models || [];
              const label = distinct.join(' · ');
              return (
                <div key={stage.name} className="eg-stage">
                  <span className="eg-stage-name">{stage.name}</span>
                  <span className="eg-settings-stagedetail">{stage.detail}</span>
                  {mode === 'auto' ? (
                    <span className="eg-select is-disabled" title="Switch Selection to Manual to choose this stage's model">
                      {label}
                    </span>
                  ) : models.length > 0 ? (
                    <MenuButton
                      align="end"
                      width={260}
                      items={models.map((m) => ({
                        label: m.name,
                        checked: current.every((c) => c.model === m.id),
                        onSelect: () => setStageModel(stage.roles, provider, m.id),
                      }))}
                      trigger={(t) => (
                        <button type="button" className="eg-select" {...t}>
                          {label}
                          <Icon icon={ChevronDown} size="sm" />
                        </button>
                      )}
                    />
                  ) : (
                    <span className="eg-settings-note" title="Edit the profile to change this model">
                      {label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="eg-settings-groupdesc eg-settings-after">
            {mode === 'auto'
              ? 'In Auto, Ergo picks each stage’s model per task. Switch Selection to Manual to set them yourself.'
              : 'Each stage covers several agents; edit the profile to set one agent’s model or provider on its own.'}
          </p>
        </>
        )}
      </section>

      <section className="eg-sgroup">
        <div className="eg-settings-grouphead">
          <h3 className="eg-sgroup-title">Profiles</h3>
          <Button size="sm" icon={Plus} onClick={() => openEditor(null)}>
            Add profile
          </Button>
        </div>
        {userApiKeys.length === 0 ? (
          <EmptyState icon={Cpu} title="No AI profile yet" text="Connect Claude Code, Codex, Gemini or a local model to run tasks." />
        ) : (
          <div className="eg-srows">
            {userApiKeys.map((k) => {
              const isActive = k.id === activeKeyId;
              return (
                <div key={k.id} className="eg-srow">
                  <div className="eg-srow-text">
                    <div className="eg-srow-title">
                      {k.name}
                      {isActive && <span className="eg-settings-note"> · In use</span>}
                    </div>
                    <div className="eg-srow-help">{profileSummary(k)}</div>
                  </div>
                  <div className="eg-settings-actions">
                    <IconButton icon={Pencil} label={`Edit ${k.name}`} size="sm" onClick={() => openEditor(k)} />
                    <IconButton icon={Trash2} label={`Delete ${k.name}`} size="sm" onClick={() => setPendingDelete(k)} />
                    {!isActive && (
                      <Button size="sm" onClick={() => onSelectActiveKey(k.id)}>
                        Use
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <SettingsModal {...settings} isOpen={false} onClose={() => {}} embedded section="models" />

      <AiCredentialsModal
        {...credentials}
        isOpen={editor.open}
        formOnly
        editingKey={editor.key}
        onClose={() => setEditor({ open: false, key: null })}
      />

      {pendingDelete && (
        <Dialog
          title="Delete this profile?"
          description={`"${pendingDelete.name}" and its stored keys are removed from config/secrets.json. This can't be undone.`}
          onClose={() => setPendingDelete(null)}
          width={440}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon={Trash2}
                onClick={() => {
                  onDeleteUserKey(pendingDelete.id);
                  setPendingDelete(null);
                }}
              >
                Delete profile
              </Button>
            </>
          }
        >
          <p className="eg-settings-dialogtext">Runs that use it stop working until you choose another profile.</p>
        </Dialog>
      )}
    </>
  );
};

/* ───────────── Permissions ───────────── */

const PermissionsPage: React.FC<{ settings: SettingsScreenProps['settings'] }> = ({ settings }) => {
  const options = settings.agentPipelineOptions;
  const level = PERMISSION_LEVELS.includes(options.permissionLevel) ? options.permissionLevel : 'ask';
  return (
    <>
      <SettingsGroup title="Default">
        <SettingsRow title="Permission mode" help={PERMISSION_COPY[level].detail}>
          <MenuButton
            align="end"
            width={320}
            items={PERMISSION_LEVELS.map((l) => ({
              label: PERMISSION_COPY[l].label,
              checked: l === level,
              onSelect: () => settings.onSetAgentPipelineOptions({ ...options, permissionLevel: l }),
            }))}
            trigger={(t) => (
              <button type="button" className="eg-select" {...t}>
                {PERMISSION_COPY[level].label}
                <Icon icon={ChevronDown} size="sm" />
              </button>
            )}
          />
        </SettingsRow>
      </SettingsGroup>
      {level === 'bypass' && (
        <Banner
          className="eg-settings-banner"
          tone="warning"
          title="Agents never ask in Full access"
          text="Edits, commands and tools all run without your approval, and Ergo approves CLI agents' prompts for them."
        />
      )}
      <section className="eg-sgroup">
        <h3 className="eg-sgroup-title">What each mode allows</h3>
        <div className="eg-srows">
          {PERMISSION_LEVELS.map((l) => (
            <div key={l} className="eg-srow">
              <div className="eg-srow-text">
                <div className="eg-srow-title">{PERMISSION_COPY[l].label}</div>
                <div className="eg-srow-help">{PERMISSION_COPY[l].detail}</div>
              </div>
              {l === level ? (
                <span className="eg-settings-inline eg-settings-note">
                  <Icon icon={Check} size="sm" />
                  Current
                </span>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => settings.onSetAgentPipelineOptions({ ...options, permissionLevel: l })}>
                  Use
                </Button>
              )}
            </div>
          ))}
        </div>
        <p className="eg-settings-groupdesc eg-settings-after">
          Changes apply right away, including to running agents. CLI agents that can't switch mode while running are flagged so you can restart them.
          Integration tools have their own approval setting under Integrations.
        </p>
      </section>
    </>
  );
};

/* ───────────── Shortcuts ───────────── */

/** `available` is true only where a handler exists today (the editor's list keymap). */
const SHORTCUTS: Array<{ label: string; keys: string[]; available: boolean }> = [
  { label: 'Command palette', keys: [MOD, 'K'], available: true },
  { label: 'Draft tasks', keys: [SHIFT, MOD, 'D'], available: true },
  { label: 'Run the current task', keys: [SHIFT, MOD, ENTER], available: true },
  { label: 'Stop the run', keys: [SHIFT, MOD, '.'], available: true },
  { label: 'Show or hide the detail pane', keys: [MOD, 'J'], available: true },
  { label: 'Settings', keys: [MOD, ','], available: true },
  { label: 'Show or hide the formatting toolbar', keys: [SHIFT, MOD, 'T'], available: true },
  { label: 'Move line up', keys: [ALT, '↑'], available: false },
  { label: 'Move line down', keys: [ALT, '↓'], available: false },
  { label: 'Indent', keys: ['Tab'], available: true },
  { label: 'Outdent', keys: [SHIFT, 'Tab'], available: true },
];

const ShortcutsPage: React.FC = () => (
  <SettingsGroup title="Keyboard">
    {SHORTCUTS.map((s) => (
      <SettingsRow key={s.label} title={s.label} help={s.available ? undefined : <span className="eg-settings-note">Not available yet</span>}>
        <Kbd keys={s.keys} />
      </SettingsRow>
    ))}
  </SettingsGroup>
);

/* ───────────── Screen ───────────── */

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ page, onNavigate, onClose, projectName, settings, credentials, mcp, archive }) => {
  const meta = SETTINGS_PAGES.find((p) => p.id === page) ?? SETTINGS_PAGES[0];
  const embeddedSettings = (section: NonNullable<SettingsModalProps['section']>) => (
    <SettingsModal {...settings} isOpen={false} onClose={() => {}} embedded section={section} />
  );
  const embeddedMcp = (section: NonNullable<McpHubModalProps['section']>) => (
    <McpHubModal {...mcp} isOpen={false} onClose={() => {}} embedded section={section} />
  );
  const embeddedArchive = (p: NonNullable<ArchivedTasksModalProps['page']>) => (
    <ArchivedTasksModal {...archive} isOpen={false} onClose={() => {}} embedded page={p} />
  );

  let body: React.ReactNode = null;
  switch (meta.id) {
    case 'general':
      body = embeddedSettings('general');
      break;
    case 'folders':
      body = embeddedMcp('roots');
      break;
    case 'rules':
      body = embeddedArchive('rules');
      break;
    case 'memory':
      body = (
        <>
          {embeddedArchive('memory')}
          {embeddedSettings('memory')}
        </>
      );
      break;
    case 'archive':
      body = embeddedArchive('archive');
      break;
    case 'models':
      body = <ModelsPage settings={settings} credentials={credentials} />;
      break;
    case 'permissions':
      body = <PermissionsPage settings={settings} />;
      break;
    case 'skills':
      body = embeddedMcp('skills');
      break;
    case 'integrations':
      body = embeddedMcp('integrations');
      break;
    case 'bridge':
      body = embeddedSettings('bridge');
      break;
    case 'appearance':
      body = embeddedSettings('appearance');
      break;
    case 'shortcuts':
      body = <ShortcutsPage />;
      break;
  }

  return (
    <main className="eg-settings">
      <nav className="eg-snav" aria-label="Settings">
        <Button variant="ghost" size="sm" icon={ChevronLeft} className="eg-settings-back" onClick={onClose}>
          Back to tasks
        </Button>
        {GROUP_ORDER.map((group) => (
          <React.Fragment key={group}>
            <div className="eg-snav-label">{group === 'project' ? `${GROUP_LABELS.project} · ${projectName}` : GROUP_LABELS[group]}</div>
            {SETTINGS_PAGES.filter((p) => p.group === group).map((p) => (
              <button
                key={p.id}
                type="button"
                className="eg-snav-item"
                aria-current={p.id === meta.id ? 'page' : undefined}
                onClick={() => onNavigate(p.id)}
              >
                <Icon icon={PAGE_ICONS[p.id]} />
                {p.label}
              </button>
            ))}
          </React.Fragment>
        ))}
      </nav>
      <section className="eg-scontent">
        <div className="eg-scontent-inner">
          {/* Below 960px the side nav hides (ergo.css); this row takes its place. */}
          <div className="eg-settings-compactnav">
            <Button variant="ghost" size="sm" icon={ChevronLeft} onClick={onClose}>
              Back to tasks
            </Button>
            <MenuButton
              align="end"
              width={220}
              items={GROUP_ORDER.flatMap((group): MenuItem[] => [
                { section: group === 'project' ? `${GROUP_LABELS.project} · ${projectName}` : GROUP_LABELS[group] },
                ...SETTINGS_PAGES.filter((p) => p.group === group).map((p) => ({
                  label: p.label,
                  icon: PAGE_ICONS[p.id],
                  checked: p.id === meta.id,
                  onSelect: () => onNavigate(p.id),
                })),
              ])}
              trigger={(t) => (
                <button type="button" className="eg-select" {...t}>
                  {meta.label}
                  <Icon icon={ChevronDown} size="sm" />
                </button>
              )}
            />
          </div>
          <h1 className="eg-spage-title">{meta.label}</h1>
          <p className="eg-spage-desc">{PAGE_DESCRIPTIONS[meta.id]}</p>
          {/* Keyed by page so each page starts fresh (search fields, open forms). */}
          <React.Fragment key={meta.id}>{body}</React.Fragment>
        </div>
      </section>
    </main>
  );
};
