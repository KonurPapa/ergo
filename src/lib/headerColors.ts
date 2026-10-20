/**
 * Shared palette + markdown encoding for task group header colors.
 *
 * Encoding (in TODO.md): a trailing token on the heading line, e.g.
 *   ## Backend work {color=teal}
 * Plain text so it survives the rich editor's markdown round-trip (html is disabled there).
 * Reusable for card coloring: any line may carry `{color=<id>}`.
 */
export interface HeaderColor {
  id: string;
  label: string;
  hex: string;
}

export const HEADER_COLORS: HeaderColor[] = [
  { id: 'red', label: 'Red', hex: '#ef4444' },
  { id: 'orange', label: 'Orange', hex: '#f97316' },
  { id: 'amber', label: 'Amber', hex: '#d97706' },
  { id: 'green', label: 'Green', hex: '#22c55e' },
  { id: 'teal', label: 'Teal', hex: '#14b8a6' },
  { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  { id: 'violet', label: 'Violet', hex: '#8b5cf6' },
  { id: 'pink', label: 'Pink', hex: '#ec4899' },
];

export const HEADER_COLOR_TOKEN_RE = /\s*\{color=([a-z]+)\}\s*$/i;

export function getHeaderColor(id?: string | null): HeaderColor | undefined {
  if (!id) return undefined;
  const k = id.toLowerCase();
  return HEADER_COLORS.find((c) => c.id === k);
}

export function randomHeaderColorId(): string {
  return HEADER_COLORS[Math.floor(Math.random() * HEADER_COLORS.length)].id;
}

/** Deterministic fallback for headers with no stored color (older files). */
export function fallbackHeaderColorId(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HEADER_COLORS[h % HEADER_COLORS.length].id;
}

export function resolveHeaderColor(name: string, id?: string | null): HeaderColor {
  return getHeaderColor(id) || getHeaderColor(fallbackHeaderColorId(name))!;
}

/** Splits heading text into name + color id (if a valid token is present). */
export function splitHeaderColor(text: string): { name: string; colorId?: string } {
  const m = text.match(HEADER_COLOR_TOKEN_RE);
  if (!m || !getHeaderColor(m[1])) return { name: text };
  return { name: text.slice(0, m.index).trimEnd(), colorId: m[1].toLowerCase() };
}
