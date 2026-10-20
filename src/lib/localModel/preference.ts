/**
 * Which engine makes the small background decisions (CLI run shape, autocomplete):
 *   - 'local' — the installed local model (Qwen 2.5 Coder 0.5B), falling back to the tiny cloud model;
 *   - 'cloud' — the tiny cloud model of the active AI profile (onboarding "Skip", or chosen in Settings);
 *   - 'unset' — never chosen (treated like 'cloud').
 *
 * A module-level store so library code (decisions, autocomplete) can read it without prop drilling. App sets it
 * from settings on load and whenever the user changes it.
 */
export type LocalModelMode = 'local' | 'cloud' | 'unset';

let mode: LocalModelMode = 'unset';
const listeners = new Set<(mode: LocalModelMode) => void>();

export function getLocalModelMode(): LocalModelMode {
  return mode;
}

export function setLocalModelMode(next: LocalModelMode): void {
  const normalized: LocalModelMode = next === 'local' || next === 'cloud' ? next : 'unset';
  if (normalized === mode) return;
  mode = normalized;
  for (const listener of listeners) {
    try {
      listener(mode);
    } catch {
      // A listener's failure must not affect the others.
    }
  }
}

/** Subscribe to mode changes; returns the unsubscribe function. */
export function subscribeLocalModelMode(listener: (mode: LocalModelMode) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
