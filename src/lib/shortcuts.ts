/** Keyboard shortcut labels and matching. ⌘ on Mac, Ctrl elsewhere; shortcuts that work while typing carry a modifier. */

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl';
export const SHIFT = '⇧';
export const ALT = IS_MAC ? '⌥' : 'Alt';
export const ENTER = '↵';

/** ⌘ on Mac, Ctrl elsewhere. */
export const isMod = (e: KeyboardEvent | React.KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);

/** e.g. matches(e, 'k', { mod: true }) for ⌘K; keys compare case-insensitively. */
export function matches(
  e: KeyboardEvent | React.KeyboardEvent,
  key: string,
  opts: { mod?: boolean; shift?: boolean; alt?: boolean } = {},
): boolean {
  if (e.key.toLowerCase() !== key.toLowerCase()) return false;
  if (!!opts.mod !== isMod(e)) return false;
  if (!!opts.shift !== e.shiftKey) return false;
  if (!!opts.alt !== e.altKey) return false;
  return true;
}
