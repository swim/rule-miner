/**
 * Mines a small set of high-precision rules for one binary label by sequential covering:
 *
 *   1. candidates   every 1..maxN-token phrase in a sentence of a positive, plus pairs of common
 *                   phrases that must appear in the same sentence
 *   2. filter       at most maxFalsePositives labelled negatives; at most maxBackgroundRate of a
 *                   BACKGROUND corpus (ordinary text in the users' register - a few hundred labelled
 *                   negatives can't show that a rule fires on everyday text); support from minGroups
 *                   groups (paraphrases of one seed are one piece of evidence) written by minAuthors
 *                   authors (one writer's habits aren't a signal); a non-stopword in every phrase;
 *                   not in `rejected`
 *   3. cover        `accepted` rules first, then repeatedly the candidate covering the most
 *                   still-uncovered positive weight (each group weighs 1), until the gain falls
 *                   below minGain or maxRules is reached (lazy greedy - exact, since gains only shrink)
 */
import { compileRule, canonicalSegments } from './match.ts';
import { canonicalKey, patternKey, regexSources, tokenCount, type Pattern } from './pattern.ts';
import { ENGLISH_STOPWORDS } from './stopwords.ts';
import { prepare, type Lexicon } from './text.ts';

export interface MineOptions {
  maxN?: number;
  minGroups?: number;
  /** Distinct authors among a rule's positives (default 1). Pass `authors` = who originated each text's wording. */
  minAuthors?: number;
  maxFalsePositives?: number;
  /** Highest share of background texts a rule may match (default 0). */
  maxBackgroundRate?: number;
  maxRules?: number;
  minGain?: number;
  conjunctions?: boolean;
  /** How many of the best-supported phrases are paired into conjunctions. */
  conjunctionPool?: number;
  /** A phrase made only of these is never a rule part (default ENGLISH_STOPWORDS). */
  stopwords?: ReadonlySet<string>;
  /** Equal gain, false positives and support: 'specific' takes the longer pattern, 'general' the shorter. */
  prefer?: 'specific' | 'general';
  lexicon?: Lexicon;
  /** Reviewed rules to keep: they're placed first and their coverage counts. */
  accepted?: readonly Pattern[];
  /** patternKey()s a reviewer rejected - never proposed again. */
  rejected?: Iterable<string>;
}

export interface MineInput {
  texts: readonly string[];
  /** 1 positive, 0 negative, null ignored. */
  y: ReadonlyArray<0 | 1 | null>;
  /** Group per example (default: each example its own group). */
  groups?: readonly string[];
  /** Who originated each example's wording - for a paraphrase, the seed's author. */
  authors?: readonly string[];
  /** Unlabelled, mostly-negative text from the deployment domain. */
  background?: readonly string[];
}

export interface MinedRule {
  id: string;
  pattern: Pattern;
  /** One regex per phrase, flags 'u', applied to each canonical sentence. */
  regex: string[];
  stats: { positives: number; positive_groups: number; authors: number; false_positives: number; background_hits: number; gain: number };
}

interface Candidate {
  pattern: Pattern;
  key: string;
  pos: number[];
  neg: number;
  groups: number;
  authors: number;
  background: number;
}

function intersect(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return out;
}

/** phrase -> ascending sentence ids, over every sentence of every text. */
function indexPhrases(sentences: string[][], maxN: number, keep?: (phrase: string) => boolean): Map<string, number[]> {
  const index = new Map<string, number[]>();
  sentences.forEach((tokens, s) => {
    const seen = new Set<string>();
    for (let n = 1; n <= maxN; n++) for (let i = 0; i + n <= tokens.length; i++) {
      const p = tokens.slice(i, i + n).join(' ');
      if (seen.has(p) || (keep && !keep(p))) continue;
      seen.add(p);
      let list = index.get(p);
      if (!list) index.set(p, (list = []));
      list.push(s);
    }
  });
  return index;
}

function sentencesOf(texts: readonly string[], lexicon?: Lexicon) {
  const sentences: string[][] = [];
  const owner: number[] = [];
  texts.forEach((t, i) => prepare(t, lexicon).forEach((tokens) => {
    sentences.push(tokens);
    owner.push(i);
  }));
  const owners = (ids: readonly number[]) => [...new Set(ids.map((s) => owner[s]))];
  return { sentences, owners };
}

export function mineRules(input: MineInput, options: MineOptions = {}): MinedRule[] {
  const { maxN = 4, minGroups = 3, minAuthors = 1, maxFalsePositives = 0, maxBackgroundRate = 0, maxRules = 25, minGain = 1 } = options;
  const { conjunctions = true, conjunctionPool = 300, stopwords = ENGLISH_STOPWORDS, prefer = 'specific', lexicon } = options;
  const rejected = new Set(Array.from(options.rejected ?? [], canonicalKey));
  const { texts, y, background = [] } = input;
  if (y.length !== texts.length) throw new Error(`y has ${y.length} entries for ${texts.length} texts`);
  if (input.groups && input.groups.length !== texts.length) throw new Error(`groups has ${input.groups.length} entries for ${texts.length} texts`);
  if (input.authors && input.authors.length !== texts.length) throw new Error(`authors has ${input.authors.length} entries for ${texts.length} texts`);
  if (minAuthors > 1 && !input.authors) throw new Error('minAuthors > 1 requires input.authors (who originated each text)');
  const groups = input.groups ?? texts.map((_, i) => `#${i}`);
  const authors = input.authors ?? texts.map(() => '');
  const maxBackground = Math.floor(maxBackgroundRate * background.length);
  const meaningful = (key: string) => key.split(' ').some((t) => t.startsWith('<') || !stopwords.has(t));

  const labelled = texts.map((t, i) => (y[i] === null ? '' : t));
  const lab = sentencesOf(labelled, lexicon);
  const index = indexPhrases(lab.sentences, maxN);
  const bg = sentencesOf(background, lexicon);
  const bgIndex = indexPhrases(bg.sentences, maxN, (p) => index.has(p));

  const measure = (pattern: Pattern, sentenceIds: number[], bgIds: number[]): Candidate => {
    const examples = lab.owners(sentenceIds);
    const pos = examples.filter((i) => y[i] === 1);
    return {
      pattern, key: patternKey(pattern), pos, neg: examples.length - pos.length,
      groups: new Set(pos.map((i) => groups[i])).size, authors: new Set(pos.map((i) => authors[i])).size,
      background: bg.owners(bgIds).length,
    };
  };
  const supported = (c: Candidate) => c.groups >= minGroups && c.authors >= minAuthors;
  const precise = (c: Candidate) => c.neg <= maxFalsePositives && c.background <= maxBackground;

  const phrases: Candidate[] = [];
  for (const [key, ids] of index) {
    if (!meaningful(key)) continue;
    const c = measure({ kind: 'phrase', tokens: key.split(' ') }, ids, bgIndex.get(key) ?? []);
    if (supported(c)) phrases.push(c);
  }
  const candidates = phrases.filter(precise);

  if (conjunctions) {
    // Pair phrases that are too noisy alone - a pair is only interesting if it fixes the precision.
    const pool = phrases.filter((c) => !precise(c)).sort((a, b) => b.groups - a.groups || (a.key < b.key ? -1 : 1)).slice(0, conjunctionPool);
    for (let a = 0; a < pool.length; a++) for (let b = a + 1; b < pool.length; b++) {
      const [ka, kb] = [pool[a].key, pool[b].key];
      if (` ${ka} `.includes(` ${kb} `) || ` ${kb} `.includes(` ${ka} `)) continue;
      const both = intersect(index.get(ka)!, index.get(kb)!);
      if (!both.length) continue;
      const pattern: Pattern = { kind: 'all', phrases: [ka, kb].sort().map((k) => k.split(' ')) };
      const c = measure(pattern, both, intersect(bgIndex.get(ka) ?? [], bgIndex.get(kb) ?? []));
      if (supported(c) && precise(c)) candidates.push(c);
    }
  }

  // Each group carries total weight 1, shared among its positives.
  const groupSize = new Map<string, number>();
  texts.forEach((_, i) => { if (y[i] === 1) groupSize.set(groups[i], (groupSize.get(groups[i]) ?? 0) + 1); });
  const covered = new Set<number>();
  const gainOf = (c: Candidate) => c.pos.reduce((g, i) => g + (covered.has(i) ? 0 : 1 / groupSize.get(groups[i])!), 0);
  const rules: MinedRule[] = [];
  const emit = (id: string, c: Candidate, gain: number) => rules.push({
    id, pattern: c.pattern, regex: regexSources(c.pattern),
    stats: { positives: c.pos.length, positive_groups: c.groups, authors: c.authors, false_positives: c.neg, background_hits: c.background, gain: Math.round(gain * 1000) / 1000 },
  });

  const segments = labelled.map((t) => canonicalSegments(t, lexicon));
  const bgSegments = background.map((t) => canonicalSegments(t, lexicon));
  (options.accepted ?? []).forEach((pattern, k) => {
    const fires = compileRule({ pattern });
    const examples = segments.flatMap((s, i) => (y[i] !== null && fires(s) ? [i] : []));
    const pos = examples.filter((i) => y[i] === 1);
    const c: Candidate = { pattern, key: patternKey(pattern), pos, neg: examples.length - pos.length, groups: new Set(pos.map((i) => groups[i])).size,
      authors: new Set(pos.map((i) => authors[i])).size, background: bgSegments.filter(fires).length };
    const gain = gainOf(c);
    pos.forEach((i) => covered.add(i));
    emit(`a${k + 1}`, c, gain);
  });
  const taken = new Set(rules.map((r) => patternKey(r.pattern)));

  // Lazy greedy: a max-heap on (cached gain, tie-break); a popped candidate whose recomputed gain
  // still beats the next one is the true best.
  const sign = prefer === 'specific' ? -1 : 1;
  const before = (a: Candidate, ga: number, b: Candidate, gb: number) => {
    if (Math.abs(ga - gb) > 1e-9) return ga > gb;
    if (a.neg !== b.neg) return a.neg < b.neg;
    if (a.groups !== b.groups) return a.groups > b.groups;
    const d = tokenCount(a.pattern) - tokenCount(b.pattern);
    if (d) return sign * d < 0;
    return a.key < b.key;
  };
  const heap: Array<[Candidate, number]> = [];
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i][0], heap[i][1], heap[p][0], heap[p][1])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const down = (i: number) => {
    for (;;) {
      let m = i;
      for (const c of [2 * i + 1, 2 * i + 2]) if (c < heap.length && before(heap[c][0], heap[c][1], heap[m][0], heap[m][1])) m = c;
      if (m === i) return;
      [heap[i], heap[m]] = [heap[m], heap[i]];
      i = m;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      down(0);
    }
    return top;
  };
  for (const c of candidates) {
    if (rejected.has(c.key) || taken.has(c.key)) continue;
    heap.push([c, gainOf(c)]);
    up(heap.length - 1);
  }
  let mined = 0;
  while (mined < maxRules && heap.length) {
    const [c] = pop();
    const gain = gainOf(c);
    if (heap.length && !before(c, gain, heap[0][0], heap[0][1])) {
      heap.push([c, gain]);
      up(heap.length - 1);
      continue;
    }
    if (gain < minGain) break;
    c.pos.forEach((i) => covered.add(i));
    emit(`r${++mined}`, c, gain);
  }
  return rules;
}
