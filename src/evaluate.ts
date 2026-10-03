/** Validating, evaluating and sanity-checking rules - always through the compiled regexes. */
import { wilson } from '@liquidau/solvers';

import { designRate, type BoundMethod, type SampleDesign } from './design.ts';

import { hitMatrix, type MatchableRule } from './match.ts';
import { phrasesOf, type Pattern } from './pattern.ts';
import { prepare, type Lexicon } from './text.ts';

/** Drops rules that fire on more than maxFalsePositives negatives of a held-out split. */
export function validateRules<R extends MatchableRule>(rules: readonly R[], texts: readonly string[], y: ReadonlyArray<0 | 1 | null>, options: { maxFalsePositives?: number; lexicon?: Lexicon } = {}) {
  const { maxFalsePositives = 0, lexicon } = options;
  const hits = hitMatrix(rules, texts, lexicon);
  const kept: R[] = [];
  const dropped: Array<{ rule: R; false_positives: string[] }> = [];
  rules.forEach((rule, r) => {
    const fps = texts.filter((_, i) => hits[r][i] && y[i] === 0);
    if (fps.length > maxFalsePositives) dropped.push({ rule, false_positives: fps });
    else kept.push(rule);
  });
  return { kept, dropped };
}

export interface RuleSetEvaluation {
  positives: number;
  caught: number;
  recall: number;
  recall_ci95: [number, number];
  negatives: number;
  false_alarms: number;
  false_alarm_rate: number;
  false_alarm_ci95: [number, number];
  /** 'design': recall and false alarms are weighted by 1/π and their intervals design-based (each side at 97.5%). */
  method?: 'counts' | 'design';
}

/**
 * Recall and false alarms of any per-example "fired" vector on the labelled examples. Counts and
 * Wilson intervals by default; with `design` (a stratified sample, e.g. sampled test records),
 * rates weighted by 1/π with design-based intervals - unweighted counts of a stratified sample are biased.
 * The default `method` here is 'linearised' (with an exact floor at the effective size), matching
 * embedding-classifier's evaluation; 'exact' per-stratum bounds suit certification, not reporting.
 */
export function evaluateFired(fired: readonly boolean[], y: ReadonlyArray<0 | 1 | null>, options: { design?: SampleDesign; method?: BoundMethod } = {}): RuleSetEvaluation {
  if (fired.length !== y.length) throw new Error(`fired has ${fired.length} entries for ${y.length} labels`);
  let positives = 0, caught = 0, negatives = 0, falseAlarms = 0;
  y.forEach((v, i) => {
    if (v === 1) {
      positives++;
      if (fired[i]) caught++;
    } else if (v === 0) {
      negatives++;
      if (fired[i]) falseAlarms++;
    }
  });
  const counts: RuleSetEvaluation = {
    positives, caught, recall: positives ? caught / positives : NaN, recall_ci95: wilson(caught, positives),
    negatives, false_alarms: falseAlarms, false_alarm_rate: negatives ? falseAlarms / negatives : NaN, false_alarm_ci95: wilson(falseAlarms, negatives),
    method: 'counts',
  };
  if (!options.design) return counts;
  // Labelled units only; recall over positives, false alarms over negatives.
  const keep = y.map((v) => v === 0 || v === 1);
  const sub = <T>(xs: readonly T[]) => xs.filter((_, i) => keep[i]);
  const d = { inclusionProbs: sub(options.design.inclusionProbs), strata: sub(options.design.strata), stratumSizes: options.design.stratumSizes };
  const f = sub(fired), yy = sub(y);
  const interval = (domain: boolean[]): [number, number, number] => {
    if (!domain.some(Boolean)) return [NaN, 0, 1];
    const lo = designRate(f, domain, d, 'lower', 0.975, options.method ?? 'linearised');
    const hi = designRate(f, domain, d, 'upper', 0.975, options.method ?? 'linearised');
    return [lo.estimate, lo.bound, hi.bound];
  };
  const [recall, rLo, rHi] = interval(yy.map((v) => v === 1));
  const [far, fLo, fHi] = interval(yy.map((v) => v === 0));
  return { ...counts, recall, recall_ci95: [rLo, rHi], false_alarm_rate: far, false_alarm_ci95: [fLo, fHi], method: 'design' };
}

function tokenMatch(pattern: Pattern, sentence: string[]): boolean {
  return phrasesOf(pattern).every((phrase) => {
    for (let i = 0; i + phrase.length <= sentence.length; i++) if (phrase.every((t, j) => sentence[i + j] === t)) return true;
    return false;
  });
}

/**
 * Texts where the compiled regexes and a direct token matcher disagree. Should always be empty;
 * anything here means a regex doesn't mean what the miner measured.
 */
export function checkConsistency(rules: readonly MatchableRule[], texts: readonly string[], lexicon?: Lexicon): Array<{ rule: number; text: string; regex: boolean }> {
  const hits = hitMatrix(rules, texts, lexicon);
  const sentences = texts.map((t) => prepare(t, lexicon));
  const out: Array<{ rule: number; text: string; regex: boolean }> = [];
  rules.forEach((rule, r) => texts.forEach((text, i) => {
    const tokens = sentences[i].some((s) => tokenMatch(rule.pattern, s) && !(rule.except ?? []).some((e) => tokenMatch(e, s)));
    if (hits[r][i] !== tokens) out.push({ rule: r, text, regex: hits[r][i] });
  }));
  return out;
}
