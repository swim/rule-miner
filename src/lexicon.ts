/**
 * Proposes word classes from word embeddings, e.g. {better, happier, easier} - for a reviewer to
 * edit and approve before mining with them. Mutual nearest neighbours above minSimilarity, merged
 * without chaining past maxClassSize. Embeddings put antonyms and co-hyponyms close together
 * ("better"/"worse", "son"/"daughter"), so review isn't optional.
 */
export function induceClasses(
  words: readonly string[],
  vectors: ReadonlyArray<ArrayLike<number>>,
  options: { minSimilarity?: number; neighbours?: number; maxClassSize?: number } = {},
): Record<string, string[]> {
  const { minSimilarity = 0.8, neighbours = 3, maxClassSize = 6 } = options;
  const unit = vectors.map((v) => {
    const norm = Math.hypot(...Array.from(v));
    return Array.from(v, (x) => (norm ? x / norm : 0));
  });
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const top = unit.map((u, i) => unit
    .map((v, j) => [j, i === j ? -Infinity : dot(u, v)] as const)
    .filter(([, s]) => s >= minSimilarity)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, neighbours)
    .map(([j]) => j));

  const parent = words.map((_, i) => i);
  const size = words.map(() => 1);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // Strongest mutual pairs first, so a size cap keeps the tightest classes.
  const edges = top.flatMap((ns, i) => ns.filter((j) => j > i && top[j].includes(i)).map((j) => [i, j, dot(unit[i], unit[j])] as const))
    .sort((a, b) => b[2] - a[2] || a[0] - b[0] || a[1] - b[1]);
  for (const [i, j] of edges) {
    const [a, b] = [find(i), find(j)];
    if (a === b || size[a] + size[b] > maxClassSize) continue;
    parent[b] = a;
    size[a] += size[b];
  }
  const classes = new Map<number, string[]>();
  words.forEach((w, i) => {
    const r = find(i);
    if (!classes.has(r)) classes.set(r, []);
    classes.get(r)!.push(w);
  });
  // Named after the first member in input order (pass words most-frequent first); a name that
  // another class already took gets a numeric suffix rather than silently replacing it.
  const names = new Set<string>();
  return Object.fromEntries([...classes.values()].filter((m) => m.length > 1).map((m) => {
    const base = m[0].replace(/[^a-z0-9_]/g, '_');
    let name = base;
    for (let k = 2; names.has(name); k++) name = `${base}_${k}`;
    names.add(name);
    return [name, m] as const;
  }));
}
