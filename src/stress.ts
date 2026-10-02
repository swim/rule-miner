/**
 * Counterexample stress test. An adversary (typically an LLM, plus a judge confirming each text's
 * true label) writes texts aimed at one item, and the item fails if it gets more than maxHits of
 * them wrong:
 *
 *   rules       ordinary texts containing the rule's wording - "i'm planning to" fires on
 *               "I'm planning to bake a cake". EVIDENCE FOR REVIEWERS, NOT A GATE: an adversary
 *               can force an innocent use of almost any phrase, so good rules fail as often as
 *               bad ones - gate rules by how often they fire on real text (certifyPrefixes)
 *   exceptions  positive texts containing the exception's wording - "self harm" as an exception
 *               would silence "my daughter has started to self harm"
 *
 * Only texts the item actually gets wrong count, so an adversary that rewords the phrase away
 * can't fail an item - and fewer than minGenerated counterexamples is INCONCLUSIVE, never a pass:
 * an adversary or judge that failed to produce anything is not evidence of safety. The same holds
 * when the adversary throws: that item is inconclusive (with `error`) and the others still complete.
 * ruleStressItems / exceptionStressItems build the items.
 */
import { canonicalSegments, compileRule, withExceptions, type MatchableRule } from './match.ts';
import { describe, type Pattern } from './pattern.ts';
import type { Lexicon } from './text.ts';

export interface StressItem {
  id: string;
  /** Human-readable wording to aim at, e.g. "{better|happier} without me". */
  description: string;
  /** True when the item gets this counterexample wrong. */
  fails: (text: string) => boolean;
}

export interface StressResult {
  id: string;
  description: string;
  generated: number;
  hits: string[];
  status: 'passed' | 'failed' | 'inconclusive';
  /** status === 'passed'. */
  passed: boolean;
  /** The adversary threw for this item (status is then 'inconclusive'). */
  error?: string;
}

/** Rules fail on ordinary texts they fire on. */
export function ruleStressItems(rules: ReadonlyArray<MatchableRule & { id: string }>, lexicon?: Lexicon): StressItem[] {
  return rules.map((rule) => {
    const fires = compileRule(rule);
    return { id: rule.id, description: describe(rule.pattern, lexicon), fails: (t) => fires(canonicalSegments(t, lexicon)) };
  });
}

/** Exceptions fail on positive texts the base rule fires on but the exception suppresses. */
export function exceptionStressItems(id: string, base: (sentence: string) => boolean | string, exceptions: readonly Pattern[], lexicon?: Lexicon): StressItem[] {
  const rule = withExceptions(base, [], lexicon);
  return exceptions.map((e, k) => {
    const suppressed = withExceptions(base, [e], lexicon);
    return { id: `${id}#${k + 1}`, description: describe(e, lexicon), fails: (t) => rule(t) && !suppressed(t) };
  });
}

export async function stressTest<I extends StressItem>(
  items: readonly I[],
  counterexamples: (item: I) => Promise<string[]>,
  options: { maxHits?: number; minGenerated?: number; concurrency?: number } = {},
): Promise<StressResult[]> {
  const { maxHits = 0, minGenerated = 10, concurrency = 4 } = options;
  const results = new Array<StressResult>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      const item = items[k];
      let texts: string[];
      try {
        texts = await counterexamples(item);
      } catch (e) {
        results[k] = { id: item.id, description: item.description, generated: 0, hits: [], status: 'inconclusive', passed: false, error: e instanceof Error ? e.message : String(e) };
        continue;
      }
      const hits = texts.filter(item.fails);
      const status = hits.length > maxHits ? 'failed' : texts.length < minGenerated ? 'inconclusive' : 'passed';
      results[k] = { id: item.id, description: item.description, generated: texts.length, hits, status, passed: status === 'passed' };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}
