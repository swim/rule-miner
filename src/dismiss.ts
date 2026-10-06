/**
 * Dismissal rules: rules that decide "not <label>" without the embedding - negative labelling
 * functions. Mined for the NEGATIVE class, validated with no true positive allowed, and certified on
 * the sampled calibration POSITIVES: "the first k rules match at most maxRate of true positives, with
 * 95% confidence". Store them in a rule set with `effect: 'dismiss'` (buildRuleSet), and give the
 * classifier the dismissed rows (embedding-classifier's HeadInput.dismissal), so a positive a rule
 * dismissed counts as a miss in the head's recall guarantee: the statement covers the whole system.
 *
 * These are thin wrappers over mineRules, validateRules and certifyFalseAlarms with the labels
 * flipped - no new statistics. They pay off on clustered labels (many look-alike negatives); on
 * diffuse labels few rules certify and the head may lose its guarantee.
 *
 * JOINT dismissal ("none of the labels"): mine, validate and certify on jointLabels(), then store the
 * same rules as dismissal rules for every label (buildRuleSet, one group per label). A rules tier in
 * front of the model can only skip it when every label is decided, and a rare label rarely has the
 * calibration positives to certify its own rules; the joint labels pool every label's positives.
 * Each label's guarantee still counts the positives they clear.
 */
import { certifyFalseAlarms, type FalseAlarmCertification } from './certify.ts';
import type { BoundMethod, SampleDesign } from './design.ts';
import { validateRules } from './evaluate.ts';
import type { MatchableRule } from './match.ts';
import { mineRules, type MinedRule, type MineInput, type MineOptions } from './mine.ts';
import type { Lexicon } from './text.ts';

const flip = (y: ReadonlyArray<0 | 1 | null>) => y.map((v) => (v === null ? null : ((1 - v) as 0 | 1)));

/**
 * Mines rules for the negative class of `input.y`. No background veto (a dismissal rule should fire
 * often), no false positives in mining by default, at least 5 groups per rule, up to 60 rules.
 */
export function mineDismissals(input: Omit<MineInput, 'background' | 'backgroundRecords'>, options: MineOptions = {}): MinedRule[] {
  return mineRules({ ...input, y: flip(input.y) }, { minGroups: 5, maxFalsePositives: 0, maxRules: 60, ...options, maxBackgroundRate: undefined });
}

/** Keeps the dismissal rules that match no positive (by default) in held-out labelled texts. */
export function validateDismissals<R extends MatchableRule>(rules: readonly R[], texts: readonly string[], y: ReadonlyArray<0 | 1 | null>, options: { maxPositives?: number; lexicon?: Lexicon } = {}) {
  return validateRules(rules, texts, flip(y), { maxFalsePositives: options.maxPositives ?? 0, lexicon: options.lexicon });
}

/**
 * Certifies the longest prefix of dismissal rules whose matches cover at most `maxRate` of the
 * POSITIVES in a labelled sample (`fired`: rules × texts, e.g. hitMatrix). With a design, the bound
 * defaults to 'linearised' - the exact design method sums per-stratum bounds and stays far above
 * small rates at typical calibration sizes (~60 positives). `y` is the head's own labels (1 = positive).
 */
export function certifyDismissals(
  fired: ReadonlyArray<readonly boolean[]>,
  options: { y: ReadonlyArray<0 | 1 | null>; maxRate: number; confidence?: number; design?: SampleDesign; method?: BoundMethod },
): FalseAlarmCertification {
  const { y, design, method = design ? 'linearised' : 'exact', ...rest } = options;
  if (!y.includes(1)) throw new Error('no labelled positives to certify dismissal rules on');
  return certifyFalseAlarms(fired, { ...rest, y: flip(y), method, ...(design ? { design } : {}) });
}

/**
 * Joint labels for "none of the labels" dismissal: 1 when any of `labels` is positive, 0 when all are
 * negative, null when some are unlabelled and none positive (unknown).
 */
export function jointLabels(rows: ReadonlyArray<Readonly<Record<string, 0 | 1 | null | undefined>>>, labels: readonly string[]): Array<0 | 1 | null> {
  if (!labels.length) throw new Error('jointLabels needs at least one label');
  return rows.map((r) => {
    const ys = labels.map((l) => r[l]);
    return ys.some((v) => v === 1) ? 1 : ys.every((v) => v === 0) ? 0 : null;
  });
}

