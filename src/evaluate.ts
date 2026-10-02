/** Validating, evaluating and sanity-checking rules - always through the compiled regexes. */
import { wilson } from '@liquidau/solvers';

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
}

/** Recall and false alarms of any per-example "fired" vector on the labelled examples. */
export function evaluateFired(fired: readonly boolean[], y: ReadonlyArray<0 | 1 | null>): RuleSetEvaluation {
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
  return {
    positives, caught, recall: positives ? caught / positives : NaN, recall_ci95: wilson(caught, positives),
    negatives, false_alarms: falseAlarms, false_alarm_rate: negatives ? falseAlarms / negatives : NaN, false_alarm_ci95: wilson(falseAlarms, negatives),
  };
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
