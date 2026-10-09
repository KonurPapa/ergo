import type { AIProviderId, CliAgentPreset, CliAgentConfig, UserApiKey, TaskItem, AgentContextItem } from '../types';

export const CLI_AGENT_PRESETS: CliAgentPreset[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    defaultArgs: '',
    docsUrl: 'https://docs.anthropic.com/claude/docs/claude-code',
    description: "Anthropic's official agentic coding assistant in the CLI. Run `npm install -g @anthropic-ai/claude-code` to install.",
    badgeColor: '#d97706',
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    command: 'codex',
    defaultArgs: '',
    docsUrl: 'https://github.com/openai/codex',
    description: "OpenAI's command-line coding agent. Run `npm install -g @openai/codex` to install.",
    badgeColor: '#7c3aed',
  },
  {
    id: 'antigravity',
    label: 'Antigravity (agy)',
    command: 'agy',
    defaultArgs: '',
    docsUrl: 'https://antigravity.dev',
    description: "Google Deepmind's Advanced Agentic Coding assistant. Powered by Gemini, invoked via `agy`.",
    badgeColor: '#2563eb',
  },
  {
    id: 'cursor-cli',
    label: 'Cursor CLI',
    command: 'cursor',
    defaultArgs: '',
    docsUrl: 'https://cursor.com',
    description: 'Cursor IDE agent CLI integration.',
    badgeColor: '#06b6d4',
  },
  {
    id: 'grok-cli',
    label: 'Grok CLI',
    command: 'grok',
    defaultArgs: '',
    docsUrl: 'https://x.ai',
    description: 'xAI Grok terminal coding agent.',
    badgeColor: '#e11d48',
  },
  {
    id: 'aider',
    label: 'Aider',
    command: 'aider',
    defaultArgs: '--model gpt-4o',
    docsUrl: 'https://aider.chat',
    description: 'Open-source terminal pair programming AI. Run `pip install aider-chat` to install.',
    badgeColor: '#059669',
  },
];

/**
 * Returns the default CLI preset id for a given AI provider.
 */
export function getDefaultCliPresetForProvider(provider: AIProviderId): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-code';
    case 'openai':
      return 'codex';
    case 'gemini':
      return 'antigravity';
    case 'cursor':
      return 'cursor-cli';
    case 'grok':
      return 'grok-cli';
    case 'ollama':
      return 'aider';
    default:
      return 'claude-code';
  }
}

/**
 * Resolves the effective CLI agent configuration from a UserApiKey or standalone config.
 */
export function getEffectiveCliAgent(key?: UserApiKey | null, fallback?: CliAgentConfig | null): CliAgentConfig | null {
  if (!key) return fallback || null;

  // If power-user configured custom CLI command:
  if (key.cliCustomCommand && key.cliCustomCommand.trim().length > 0) {
    return {
      command: key.cliCustomCommand.trim(),
      extraArgs: key.cliExtraArgs || '',
      presetId: key.cliPresetId || 'custom',
      name: key.name ? `${key.name} CLI` : undefined,
    };
  }

  // Find preset by explicit presetId / agentId, or fall back to provider default
  const targetPresetId = key.cliPresetId || key.cliAgentId || getDefaultCliPresetForProvider(key.provider);
  const preset = CLI_AGENT_PRESETS.find((p) => p.id === targetPresetId);

  if (preset) {
    return {
      id: preset.id,
      presetId: preset.id,
      name: preset.label,
      command: preset.command,
      extraArgs: key.cliExtraArgs !== undefined ? key.cliExtraArgs : preset.defaultArgs,
    };
  }

  // Fallback if preset wasn't found in list
  return {
    command: targetPresetId || 'claude',
    extraArgs: key.cliExtraArgs || '',
  };
}

/**
 * Builds a clear, structured prompt for a CLI coding agent from a task and optional brief.
 */
export function buildTaskCliPrompt(task: TaskItem, brief?: AgentContextItem): string {
  const sections: string[] = [];

  sections.push(`TASK TO COMPLETE: "${task.title}"`);

  if (task.category && task.category.trim()) {
    sections.push(`CATEGORY: ${task.category.trim()}`);
  }

  if (task.summaryNote && task.summaryNote.trim()) {
    sections.push(`SUMMARY NOTE:\n${task.summaryNote.trim()}`);
  }

  const overview = brief?.overview || brief?.brief;
  if (overview && overview.trim()) {
    sections.push(`OBJECTIVES & CONTEXT:\n${overview.trim()}`);
  }

  if (task.subtasks && task.subtasks.length > 0) {
    const subtaskLines = task.subtasks
      .map((s) => `- [${s.isDone ? 'x' : ' '}] ${s.text}`)
      .join('\n');
    sections.push(`CHECKLIST / SUBTASKS:\n${subtaskLines}`);
  }

  // Extract Gherkin criteria if embedded in brief
  const gherkinMatch = overview ? overview.match(/```gherkin([\s\S]*?)```/) : null;
  if (gherkinMatch) {
    sections.push(`ACCEPTANCE CRITERIA (GHERKIN):\n${gherkinMatch[1].trim()}`);
  }

  sections.push(
    `INSTRUCTIONS:\n` +
    `- Inspect the repository workspace to understand existing files and structure.\n` +
    `- Implement all required changes to complete the task and satisfy all acceptance criteria.\n` +
    `- Run tests or build verification if available.\n` +
    `- Provide a summary of all changes made when finished.`
  );

  return sections.join('\n\n');
}

/**
 * Formats command-line arguments for launching a CLI coding agent with a task prompt.
 * Handles specific CLI flags:
 * - agy: uses -i "<prompt>" (runs prompt interactively and keeps session active)
 * - claude: uses positional prompt "<prompt>"
 * - aider: uses --message "<prompt>"
 * - codex / cursor / grok: uses positional prompt
 */
export function buildCliArgsForTask(
  cmd: string,
  extraArgsString: string = '',
  prompt: string
): string[] {
  // Parse extraArgsString into separate tokens, respecting quotes if present
  const tokens: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(extraArgsString.trim())) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }

  const baseCmd = cmd.toLowerCase().trim().replace(/^.*[\\/]/, '');

  if (baseCmd === 'agy') {
    // agy takes -i or --prompt-interactive to run initial prompt interactively and continue the session
    const hasPromptFlag = tokens.some(
      (t) => t === '-i' || t === '--prompt-interactive' || t === '-p' || t === '--print' || t === '--prompt'
    );
    if (hasPromptFlag) {
      return [...tokens, prompt];
    }
    return [...tokens, '-i', prompt];
  }

  if (baseCmd === 'claude') {
    // Claude Code accepts positional prompt: claude [options] [prompt]
    return [...tokens, prompt];
  }

  if (baseCmd === 'aider') {
    const hasMessageFlag = tokens.some((t) => t === '-m' || t === '--message');
    if (hasMessageFlag) {
      return [...tokens, prompt];
    }
    return [...tokens, '--message', prompt];
  }

  if (baseCmd === 'codex' || baseCmd === 'cursor' || baseCmd === 'grok') {
    return [...tokens, prompt];
  }

  // Generic fallback
  return [...tokens, prompt];
}

