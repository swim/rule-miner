/**
 * Mines EXCEPTIONS for an existing rule - any sentence-level rule, including hand-written regex:
 * phrases that, when present in the sentence the rule fired on, mean it shouldn't have
 * ("years ago", "what if", "a client"). Learned from the rule's false positives (labelled
 * negatives and background texts it fires on), never at the cost of more than maxLostGroups of
 * the positive groups it catches.
 *
 * An example is fixed when every sentence the rule fired in contains a chosen exception - so
 * "I tried years ago. I'm going to do it tonight." keeps firing on its second sentence.
 *
 * An exception must be CONTEXT ("if my", "used to"), not content: one present in more than
 * maxShare of all the sentences the rule fires in would mostly switch the rule off - with few
 * labelled positives, "0 positives lost" can't show that's safe. For the same reason no exceptions
 * are mined for a rule that catches fewer than minPositiveGroups positive groups: with no
 * positives to lose, every exception looks free. Even then, wording no training positive happens
 * to use can't be checked here - stress-test exceptions with positive counterexamples too.
 *
 * When `base` returns the text it matched, an exception may not reuse the trigger's words: the
 * rule fired BECAUSE of "self-harm", so an exception "self harm" could only tell spellings of the
 * trigger apart - always spurious, and it would silence "she has started to self harm".
 */
import type { Pattern } from './pattern.ts';
import { ENGLISH_STOPWORDS } from './stopwords.ts';
import { normalize, rawSegments, segmentTokens, type Lexicon } from './text.ts';

export interface ExceptionOptions {
  maxN?: number;
  /** Distinct negative groups an exception must fix (background texts count as their own groups). */
  minGroups?: number;
  /** Positive groups the exceptions may stop the rule catching, in total (default 0). */
  maxLostGroups?: number;
  maxExceptions?: number;
  minGain?: number;
  /** Highest share of the rule's firing sentences (labelled + background) an exception may appear in (default 0.5). */
  maxShare?: number;
  /** Positive groups the rule must catch before any exception is mined (default 3). */
  minPositiveGroups?: number;
  /** Stopword-only exceptions need at least two tokens ("what if"), single ones are too broad. */
  stopwords?: ReadonlySet<string>;
  lexicon?: Lexicon;
}

export interface MinedException {
  pattern: Pattern;
  stats: { fixed: number; fixed_groups: number; lost_groups: number };
}

export interface ExceptionResult {
  exceptions: MinedException[];
  /** The rule's firing on the labelled data and background, before and after its exceptions. */
  before: { positives: number; negatives: number; background: number };
  after: { positives: number; negatives: number; background: number };
  /** Why no exceptions were mined, when that wasn't for lack of a good candidate. */
  skipped?: string;
}

interface Fired {
  phrases: Set<string>;
  /** Non-stopword tokens of the text the rule matched, when `base` reports it. */
  trigger: Set<string>;
}

interface Unit {
  /** The sentences the rule fired in. */
  fired: Fired[];
  group: string;
  kind: 'pos' | 'neg' | 'bg';
}

function phraseSet(tokens: string[], maxN: number): Set<string> {
  const out = new Set<string>();
  for (let n = 1; n <= maxN; n++) for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
}

export function mineExceptions(
  input: { texts: readonly string[]; y: ReadonlyArray<0 | 1 | null>; groups?: readonly string[]; background?: readonly string[] },
  /** Fires on a sentence: true, or (better) the matched text, which enables the trigger guard. */
  base: (sentence: string) => boolean | string,
  options: ExceptionOptions = {},
): ExceptionResult {
  const { maxN = 3, minGroups = 2, maxLostGroups = 0, maxExceptions = 10, minGain = 1, maxShare = 0.5, minPositiveGroups = 3, stopwords = ENGLISH_STOPWORDS, lexicon } = options;
  if (input.y.length !== input.texts.length) throw new Error(`y has ${input.y.length} entries for ${input.texts.length} texts`);
  if (input.groups && input.groups.length !== input.texts.length) throw new Error(`groups has ${input.groups.length} entries for ${input.texts.length} texts`);
  const groups = input.groups ?? input.texts.map((_, i) => `#${i}`);
  const unitOf = (text: string, group: string, kind: Unit['kind']): Unit | null => {
    const fired = rawSegments(text).flatMap((s) => {
      const hit = base(s);
      if (!hit) return [];
      const trigger = typeof hit === 'string' ? segmentTokens(normalize(hit), lexicon).filter((t) => !stopwords.has(t)) : [];
      return [{ phrases: phraseSet(segmentTokens(s, lexicon), maxN), trigger: new Set(trigger) }];
    });
    return fired.length ? { fired, group, kind } : null;
  };
  const units = [
    ...input.texts.map((t, i) => (input.y[i] === null ? null : unitOf(t, groups[i], input.y[i] === 1 ? 'pos' : 'neg'))),
    ...(input.background ?? []).map((t, b) => unitOf(t, `bg#${b}`, 'bg')),
  ].filter((u): u is Unit => u !== null);

  const chosen: string[] = [];
  const suppressed = (u: Unit, extra?: string) => u.fired.every((s) => chosen.some((e) => s.phrases.has(e)) || (extra !== undefined && s.phrases.has(extra)));
  const count = () => ({
    positives: units.filter((u) => u.kind === 'pos' && !suppressed(u)).length,
    negatives: units.filter((u) => u.kind === 'neg' && !suppressed(u)).length,
    background: units.filter((u) => u.kind === 'bg' && !suppressed(u)).length,
  });
  const before = count();
  const posGroups = (pred: (u: Unit) => boolean) => new Set(units.filter((u) => u.kind === 'pos' && pred(u)).map((u) => u.group)).size;
  /** Positive groups with any example the rule would no longer catch - conservative on purpose. */
  const lostGroups = (extra?: string) => posGroups((u) => suppressed(u, extra));
  const meaningful = (key: string) => key.includes(' ') || !stopwords.has(key);
  const evidence = posGroups(() => true);
  if (evidence < minPositiveGroups) {
    return { exceptions: [], before, after: before, skipped: `the rule catches ${evidence} positive group(s); ${minPositiveGroups} needed to show an exception costs nothing` };
  }

  const firedSentences = units.flatMap((u) => u.fired);
  const share = (key: string) => firedSentences.filter((s) => s.phrases.has(key)).length / firedSentences.length;
  const reusesTrigger = (key: string) => firedSentences.some((s) => s.phrases.has(key) && key.split(' ').some((t) => s.trigger.has(t)));
  const candidates = new Set<string>();
  for (const u of units) if (u.kind !== 'pos') for (const s of u.fired) for (const p of s.phrases) if (meaningful(p)) candidates.add(p);
  for (const key of candidates) if (share(key) > maxShare || reusesTrigger(key)) candidates.delete(key);

  const exceptions: MinedException[] = [];
  while (exceptions.length < maxExceptions) {
    let best: { key: string; gain: number; fixed: Unit[]; lost: number } | null = null;
    for (const key of [...candidates].sort()) {
      const fixed = units.filter((u) => u.kind !== 'pos' && !suppressed(u) && suppressed(u, key));
      if (new Set(fixed.map((u) => u.group)).size < minGroups) continue;
      const lost = lostGroups(key);
      if (lost > maxLostGroups) continue;
      // Each negative group weighs 1 in total, like positives when mining rules.
      const gain = new Set(fixed.map((u) => u.group)).size;
      if (!best || gain > best.gain || (gain === best.gain && key.split(' ').length > best.key.split(' ').length)) best = { key, gain, fixed, lost };
    }
    if (!best || best.gain < minGain) break;
    chosen.push(best.key);
    candidates.delete(best.key);
    exceptions.push({
      pattern: { kind: 'phrase', tokens: best.key.split(' ') },
      stats: { fixed: best.fixed.length, fixed_groups: best.gain, lost_groups: best.lost },
    });
  }
  return { exceptions, before, after: count() };
}
