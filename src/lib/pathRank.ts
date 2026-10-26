/** Fuzzy path ranking for the `@` file dropdown. Pure: the bridge ranks its file list with it. */

/** Ranks paths for a query: subsequence match, preferring matches in the file name, at word starts, and shorter paths. */
export function rankPaths(paths: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase().replace(/^\.\//, '');
  if (!q) {
    // Nothing typed yet: the top of the tree, folders first.
    const depth = (p: string) => p.replace(/\/$/, '').split('/').length;
    return [...paths]
      .sort((a, b) => depth(a) - depth(b) || Number(!a.endsWith('/')) - Number(!b.endsWith('/')) || a.localeCompare(b))
      .slice(0, limit);
  }
  const scored: Array<{ p: string; score: number }> = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/', lower.length - 2) + 1);
    let score: number;
    if (lower === q || base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (lower.startsWith(q)) score = 2;
    else if (base.includes(q)) score = 3;
    else if (lower.includes(q)) score = 4;
    else {
      let i = 0;
      for (const ch of lower) if (ch === q[i]) i++;
      if (i < q.length) continue;
      score = 6;
    }
    scored.push({ p, score: score * 1000 + p.length });
  }
  return scored.sort((a, b) => a.score - b.score || a.p.localeCompare(b.p)).slice(0, limit).map((s) => s.p);
}
