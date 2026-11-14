/**
 * Which editor opens files and diffs from Ergo, and the command line each one takes. Shared by the web app (the
 * Settings › Editor choices) and the bridge (which runs the commands), so it imports nothing.
 *
 * Line syntax per editor:
 *   VS Code / Cursor / Windsurf  code -g file:line:col      diff: code --diff left right
 *   JetBrains (idea, webstorm…)  idea --line N --column C file  diff: idea diff left right
 *   Zed                          zed file:line:col          diff: none (opens the file)
 */

export const IDE_IDS = ['auto', 'vscode', 'cursor', 'windsurf', 'jetbrains', 'zed', 'system'] as const;
export type IdeId = (typeof IDE_IDS)[number];

export const DEFAULT_IDE: IdeId = 'auto';

/** The user's choice, in their preferences (userPrefs). */
export const IDE_PREF_KEY = 'ergo_ide';

export const IDE_OPTIONS: ReadonlyArray<{ id: IdeId; label: string; detail: string }> = [
  { id: 'auto', label: 'Auto-detect', detail: 'The first editor found on this computer: VS Code, Cursor, Windsurf, Zed, then JetBrains.' },
  { id: 'vscode', label: 'VS Code', detail: 'Opens files at the line and diffs side by side.' },
  { id: 'cursor', label: 'Cursor', detail: 'Opens files at the line and diffs side by side.' },
  { id: 'windsurf', label: 'Windsurf', detail: 'Opens files at the line and diffs side by side.' },
  { id: 'jetbrains', label: 'JetBrains', detail: 'IntelliJ IDEA, WebStorm, PyCharm and the other JetBrains IDEs (their command-line launcher).' },
  { id: 'zed', label: 'Zed', detail: 'Opens files at the line. Diffs open the changed file.' },
  { id: 'system', label: 'System default', detail: "The app your computer opens the file type with. Lines and diffs aren't supported." },
];

/** The order Auto-detect tries editors in. */
export const AUTO_IDE_ORDER: ReadonlyArray<Exclude<IdeId, 'auto' | 'system'>> = ['vscode', 'cursor', 'windsurf', 'zed', 'jetbrains'];

export function isIdeId(value: unknown): value is IdeId {
  return typeof value === 'string' && (IDE_IDS as readonly string[]).includes(value);
}

export function ideLabel(id: IdeId): string {
  return IDE_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** How an editor's command line is shaped. Sublime, gedit and kate are Auto-detect's last resorts. */
export type IdeFamily = 'vscode' | 'jetbrains' | 'zed' | 'sublime' | 'gedit' | 'kate' | 'plain';

export function ideFamily(id: string): IdeFamily {
  switch (id) {
    case 'vscode':
    case 'cursor':
    case 'windsurf':
      return 'vscode';
    case 'jetbrains':
      return 'jetbrains';
    case 'zed':
      return 'zed';
    case 'sublime':
      return 'sublime';
    case 'gedit':
      return 'gedit';
    case 'kate':
      return 'kate';
    default:
      return 'plain';
  }
}

const JETBRAINS_LAUNCHERS = ['idea', 'webstorm', 'pycharm', 'phpstorm', 'goland', 'rider', 'clion', 'rustrover', 'rubymine', 'datagrip'];

/**
 * Where an editor's command-line launcher may be: command names (looked up on PATH) and absolute paths where the
 * installers put them when they aren't on PATH (macOS app bundles, Windows per-user installs, JetBrains Toolbox).
 */
export function ideCommandCandidates(
  id: string,
  env: { platform: string; home: string; localAppData?: string; programFiles?: string },
): { names: string[]; paths: string[] } {
  const { platform, home } = env;
  const win = platform === 'win32';
  const mac = platform === 'darwin';
  const local = env.localAppData || `${home}\\AppData\\Local`;
  const programFiles = env.programFiles || 'C:\\Program Files';
  const toolboxScripts = mac
    ? `${home}/Library/Application Support/JetBrains/Toolbox/scripts`
    : win
      ? `${local}\\JetBrains\\Toolbox\\scripts`
      : `${home}/.local/share/JetBrains/Toolbox/scripts`;
  const sep = win ? '\\' : '/';
  switch (id) {
    case 'vscode':
      return {
        names: win ? ['code.cmd', 'code'] : ['code'],
        paths: mac
          ? ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', `${home}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`]
          : win
            ? [`${local}\\Programs\\Microsoft VS Code\\bin\\code.cmd`, `${programFiles}\\Microsoft VS Code\\bin\\code.cmd`]
            : ['/snap/bin/code', '/usr/share/code/bin/code'],
      };
    case 'cursor':
      return {
        names: win ? ['cursor.cmd', 'cursor'] : ['cursor'],
        paths: mac
          ? ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', `${home}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`]
          : win
            ? [`${local}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd`]
            : ['/usr/share/cursor/bin/cursor', '/opt/Cursor/resources/app/bin/cursor'],
      };
    case 'windsurf':
      return {
        names: win ? ['windsurf.cmd', 'windsurf'] : ['windsurf'],
        paths: mac
          ? ['/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf', `${home}/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf`]
          : win
            ? [`${local}\\Programs\\Windsurf\\bin\\windsurf.cmd`]
            : ['/usr/share/windsurf/bin/windsurf'],
      };
    case 'zed':
      return {
        names: win ? ['zed.exe', 'zed'] : ['zed', 'zeditor'],
        paths: mac
          ? ['/Applications/Zed.app/Contents/MacOS/cli', `${home}/Applications/Zed.app/Contents/MacOS/cli`]
          : win
            ? [`${local}\\Programs\\Zed\\bin\\zed.exe`]
            : [`${home}/.local/bin/zed`],
      };
    case 'jetbrains':
      return {
        names: win ? JETBRAINS_LAUNCHERS.flatMap((n) => [`${n}.cmd`, `${n}64.exe`, n]) : JETBRAINS_LAUNCHERS,
        paths: JETBRAINS_LAUNCHERS.map((n) => `${toolboxScripts}${sep}${n}${win ? '.cmd' : ''}`),
      };
    case 'sublime':
      return { names: ['subl'], paths: mac ? ['/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'] : [] };
    case 'gedit':
      return { names: platform === 'linux' ? ['gedit', 'gnome-text-editor'] : [], paths: [] };
    case 'kate':
      return { names: platform === 'linux' ? ['kate'] : [], paths: [] };
    default:
      return { names: [], paths: [] };
  }
}

const positive = (n: unknown): number | null => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : null);

/** Arguments that open `file` (absolute) at `line`/`column` (1-based; ignored when unset or invalid). */
export function ideOpenArgs(family: IdeFamily, file: string, line?: number | null, column?: number | null): string[] {
  const l = positive(line);
  const c = l ? positive(column) : null;
  const withPos = l ? `${file}:${l}${c ? `:${c}` : ''}` : file;
  switch (family) {
    case 'vscode':
      return l ? ['-g', withPos] : [file];
    case 'jetbrains':
      return l ? ['--line', String(l), ...(c ? ['--column', String(c)] : []), file] : [file];
    case 'zed':
    case 'sublime':
      return [withPos];
    case 'gedit':
      return l ? [`+${l}${c ? `:${c}` : ''}`, file] : [file];
    case 'kate':
      return l ? ['-l', String(l), ...(c ? ['-c', String(c)] : []), file] : [file];
    default:
      return [file];
  }
}

/** Arguments that show a side-by-side diff of two files, or null when the editor has no diff on its command line. */
export function ideDiffArgs(family: IdeFamily, left: string, right: string): string[] | null {
  switch (family) {
    case 'vscode':
      return ['--diff', left, right];
    case 'jetbrains':
      return ['diff', left, right];
    default:
      return null;
  }
}

/**
 * The editor's URL handler for a file at a line (`vscode://file/C:/a/b.ts:42:7`), opened through the system when its
 * command-line launcher isn't installed. Null for editors without one.
 */
export function ideFileUrl(id: string, absPath: string, line?: number | null, column?: number | null): string | null {
  const scheme = id === 'vscode' ? 'vscode' : id === 'cursor' ? 'cursor' : id === 'windsurf' ? 'windsurf' : null;
  if (!scheme) return null;
  let p = absPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  const l = positive(line);
  const c = l ? positive(column) : null;
  return `${scheme}://file${encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')}${l ? `:${l}` : ''}${c ? `:${c}` : ''}`;
}

/** File types an editor can't show: they always open with the system's app. */
export const SYSTEM_ONLY_EXT_RE = /\.(pdf|png|jpe?g|gif|webp|bmp|ico|tiff?|heic|mp[34]|mov|avi|mkv|webm|wav|flac|ogg|zip|tar|gz|tgz|7z|rar|docx?|xlsx?|pptx?|odt|ods|odp|dmg|exe|msi|deb|rpm|appimage)$/i;

/**
 * True when a Windows `.cmd`/`.bat` launcher can be run through cmd.exe with these arguments without any of them being
 * read as cmd syntax (quotes, &, |, <, >, ^, %, ! or line breaks). Anything else is refused rather than escaped.
 */
export function safeForCmdShim(args: string[]): boolean {
  return args.every((a) => !/["&|<>^%!\r\n]/.test(a));
}
