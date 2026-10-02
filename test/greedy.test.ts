import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ENGLISH_STOPWORDS, anyRule, checkConsistency, mineRules, patternKey, prepare } from '../src/index.ts';

/**
 * The lazy-greedy heap in mineRules must pick exactly what a plain greedy picks. This compares
 * them on random corpora (phrases only - the reference enumerates every phrase and measures it
 * through the public matcher), and checks gain monotonicity and regex/token consistency with
 * conjunctions on.
 */
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const vocab = ['refund', 'broken', 'want', 'my', 'money', 'back', 'the', 'app', 'great', 'late', 'order', 'cancel', 'help', 'angry', 'now'];

interface Opts { maxN?: number; minGroups: number; maxFalsePositives?: number; minGain?: number; maxRules?: number; prefer?: 'specific' | 'general' }
interface C { key: string; tokens: string[]; pos: number[]; neg: number; groups: number }

function naiveGreedy(input: { texts: string[]; y: (0 | 1)[]; groups: string[] }, opts: Opts): string[] {
  const { maxN = 4, minGroups, maxFalsePositives = 0, minGain = 1, maxRules = 25, prefer = 'specific' } = opts;
  const { texts, y, groups } = input;
  const cands = new Map<string, string[]>();
  texts.forEach((t) => prepare(t).forEach((toks) => {
    for (let n = 1; n <= maxN; n++) for (let i = 0; i + n <= toks.length; i++) {
      const p = toks.slice(i, i + n);
      if (!p.some((w) => !ENGLISH_STOPWORDS.has(w))) continue;
      cands.set(p.join(' '), p);
    }
  }));
  const list: C[] = [];
  for (const [key, tokens] of cands) {
    const hits = anyRule([{ pattern: { kind: 'phrase', tokens } }], texts);
    const pos = texts.map((_, i) => i).filter((i) => hits[i] && y[i] === 1);
    const neg = texts.filter((_, i) => hits[i] && y[i] === 0).length;
    const g = new Set(pos.map((i) => groups[i])).size;
    if (g >= minGroups && neg <= maxFalsePositives) list.push({ key, tokens, pos, neg, groups: g });
  }
  const groupSize = new Map<string, number>();
  texts.forEach((_, i) => { if (y[i] === 1) groupSize.set(groups[i], (groupSize.get(groups[i]) ?? 0) + 1); });
  const covered = new Set<number>();
  const gainOf = (c: C) => c.pos.reduce((s, i) => s + (covered.has(i) ? 0 : 1 / groupSize.get(groups[i])!), 0);
  const sign = prefer === 'specific' ? -1 : 1;
  const before = (a: C, ga: number, b: C, gb: number) => {
    if (Math.abs(ga - gb) > 1e-9) return ga > gb;
    if (a.neg !== b.neg) return a.neg < b.neg;
    if (a.groups !== b.groups) return a.groups > b.groups;
    const d = a.tokens.length - b.tokens.length;
    if (d) return sign * d < 0;
    return a.key < b.key;
  };
  const out: string[] = [];
  const remaining = new Set(list);
  while (out.length < maxRules && remaining.size) {
    let best: C | null = null;
    let bestGain = 0;
    for (const c of remaining) {
      const g = gainOf(c);
      if (!best || before(c, g, best, bestGain)) { best = c; bestGain = g; }
    }
    if (!best || bestGain < minGain) break;
    remaining.delete(best);
    best.pos.forEach((i) => covered.add(i));
    out.push(best.key);
  }
  return out;
}

test('mining: the lazy-greedy heap agrees with a plain greedy on random corpora', () => {
  const optionSets: Opts[] = [{ minGroups: 1, minGain: 0.01, maxRules: 50 }, { minGroups: 2, minGain: 0.5, prefer: 'general' }, { minGroups: 1, maxFalsePositives: 1, minGain: 0.01, maxRules: 50 }];
  for (let r = 0; r < 120; r++) {
    const n = 8 + Math.floor(rnd() * 20);
    const texts: string[] = [], y: (0 | 1)[] = [], groups: string[] = [];
    for (let i = 0; i < n; i++) {
      const len = 2 + Math.floor(rnd() * 5);
      texts.push(Array.from({ length: len }, () => pick(vocab)).join(' ') + (rnd() < 0.3 ? `. ${pick(vocab)} ${pick(vocab)}` : ''));
      y.push(rnd() < 0.5 ? 1 : 0);
      groups.push(`g${Math.floor(rnd() * 6)}`);
    }
    const input = { texts, y, groups };
    for (const opts of optionSets) {
      const lazy = mineRules(input, { ...opts, conjunctions: false }).map((x) => patternKey(x.pattern));
      assert.deepEqual(lazy, naiveGreedy(input, opts), `run ${r} ${JSON.stringify(opts)}`);
      const withConjunctions = mineRules(input, { ...opts, conjunctions: true });
      assert.deepEqual(checkConsistency(withConjunctions, texts), []);
      const gains = withConjunctions.map((x) => x.stats.gain);
      for (let k = 1; k < gains.length; k++) assert.ok(gains[k] <= gains[k - 1] + 1e-9, `gains non-increasing: ${gains}`);
    }
  }
});
