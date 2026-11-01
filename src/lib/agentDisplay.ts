import { CLI_AGENT_PRESETS } from './cliAgents';

/** The agent's product name for status lines ("Claude Code", "Gemini CLI"), from the command a session runs. */
export function agentNameForCmd(cmd: string | undefined | null): string {
  const base = (cmd || '').split(/[\\/]/).pop()?.split(/\s+/)[0]?.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() || '';
  if (!base) return 'Agent';
  if (base === 'gemini') return 'Gemini CLI';
  const preset = CLI_AGENT_PRESETS.find((p) => p.command.toLowerCase() === base);
  if (preset) return preset.label.replace(/^OpenAI /, '').replace(/ \(agy\)$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** "42s", "2m 14s", "1h 3m" — elapsed time for run states and status lines. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "18.2k" — token counts in meta lines. */
export function formatTokens(n: number | undefined | null): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** The last path segment, for compact run states ("Bullet.tsx"). */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
