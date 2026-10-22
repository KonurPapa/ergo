import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * PATH for the CLI tools the bridge runs. An app started at login or from the Dock doesn't get the terminal's PATH
 * (macOS hands it launchd's /usr/bin:/bin:…), and a running process never sees folders that installers add later,
 * such as ~/.local/bin, where Claude Code's own installer puts `claude`.
 */
export function withUserToolPaths(current: string): string {
  const home = os.homedir();
  const extra = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin'), process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '']
    : [path.join(home, '.local', 'bin'), ...loginShellPath(), '/opt/homebrew/bin', '/usr/local/bin'];
  return [...new Set([...current.split(path.delimiter), ...extra].filter(Boolean))].join(path.delimiter);
}

/** The PATH an interactive login shell sets up (nvm, Homebrew, ~/.npm-global …); empty if the shell won't say. */
function loginShellPath(): string[] {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__ERGO_PATH__%s__ERGO_PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.match(/__ERGO_PATH__(.*)__ERGO_PATH__/)?.[1].split(':') ?? [];
  } catch {
    return [];
  }
}
