/**
 * Rules as a source of training data for a statistical classifier - never as its negatives.
 *
 *   ruleBounds          per rule, a production precision lower bound from its certification
 *                       firing rate and its recall on held-out gold positives
 *   weakLabels          texts a certified rule fires on become WEAK POSITIVES for its label,
 *                       weighted by that bound: held-out texts dropped, strong classifier
 *                       disagreements sent to review, near-duplicates counted once, and no rule
 *                       allowed more than maxRuleShare of the weak weight (limits imitation of one phrase)
 *   disagreementQueues  where rules and classifier disagree, or the classifier is unsure: texts
 *                       worth a human label (gold, though not a random sample - train split only)
 *
 * "Did not fire" is never a label: rules miss most positives, so a non-firing text is not a negative.
 */
import { createHash } from 'node:crypto';

import { clopperPearsonUpper } from '@liquidau/solvers';

import { precisionLowerBound } from './certify.ts';
import { canonicalSegments, hitMatrix } from './match.ts';
import type { RuleSet, RuleSetRule } from './ruleset.ts';

export interface RuleBound {
  id: string;
  /** Certification texts the rule fires on (exceptions applied). */
  cert_hits: number;
  cert_n: number;
  /** Exact upper bound on the rule's firing rate on ordinary text. */
  fire_rate_upper: number;
  /** Gold positives (or groups) the rule catches. */
  gold_caught: number;
  gold_positives: number;
  /** Exact lower bound on the rule's recall. */
  recall_lower: number;
  /** precisionLowerBound(prevalence, recall_lower, fire_rate_upper). */
  precision_lower: number;
}

export interface RuleBounds {
  label: string;
  rule_set_version: string;
  prevalence: number;
  /** Every bound in `rules` holds simultaneously with this confidence (Bonferroni over 2 per rule). */
  confidence: number;
  rules: RuleBound[];
}

export interface RuleBoundsInput {
  /** Held-out ordinary text, as passed to certifyPrefixes - never the mining background. */
  certification: readonly string[];
  /** Held-out labelled data (e.g. the calibration split) - never the texts the rules were mined on. */
  gold: { texts: readonly string[]; y: ReadonlyArray<0 | 1 | null>; groups?: readonly string[] };
  /** Production prevalence of the label. */
  prevalence: number;
  /** Which label's rules (default: the rule set's only label). */
  label?: string;
  confidence?: number;
  /** Rule ids that are not eligible (e.g. rejected in review). */
  exclude?: Iterable<string>;
}

function rulesFor(set: RuleSet, label: string | undefined, exclude?: Iterable<string>): { label: string; rules: RuleSetRule[] } {
  const labels = [...new Set(set.rules.map((r) => r.label))];
  if (label === undefined) {
    if (labels.length !== 1) throw new Error(`the rule set has ${labels.length} labels (${labels.join(', ')}) - pass a label`);
    label = labels[0];
  }
  const excluded = new Set(exclude ?? []);
  return { label, rules: set.rules.filter((r) => r.label === label && !excluded.has(r.id)) };
}

const clopperPearsonLower = (k: number, n: number, confidence: number) => 1 - clopperPearsonUpper(n - k, n, confidence);

/**
 * Per-rule precision lower bounds. Unlike certifyPrefixes (one bound on a fixed-order prefix), these
 * are bounds on every rule at once, so each is taken at confidence 1 - (1 - confidence) / (2 · rules):
 * all firing-rate and recall bounds then hold together with `confidence`.
 *
 * Recall comes from gold positives, so the bound only carries over to production as far as gold
 * positives resemble production ones. With `groups`, a positive group counts once (it is caught in
 * proportion to its caught members), since paraphrases of one seed aren't independent trials.
 */
export function ruleBounds(set: RuleSet, input: RuleBoundsInput): RuleBounds {
  const { certification, gold, prevalence, confidence = 0.95 } = input;
  if (!(prevalence > 0 && prevalence < 1)) throw new Error(`prevalence must be strictly between 0 and 1, got ${prevalence}`);
  if (!(confidence > 0 && confidence < 1)) throw new Error(`confidence must be strictly between 0 and 1, got ${confidence}`);
  if (certification.length === 0) throw new Error('certification texts are empty');
  if (gold.y.length !== gold.texts.length) throw new Error(`gold.y has ${gold.y.length} entries for ${gold.texts.length} texts`);
  if (gold.groups && gold.groups.length !== gold.texts.length) throw new Error(`gold.groups has ${gold.groups.length} entries for ${gold.texts.length} texts`);
  const { label, rules } = rulesFor(set, input.label, input.exclude);
  const positives = gold.texts.flatMap((_, i) => (gold.y[i] === 1 ? [i] : []));
  if (positives.length === 0) throw new Error('gold has no positives');
  const perStatement = 1 - (1 - confidence) / (2 * Math.max(rules.length, 1));

  const certHits = hitMatrix(rules, certification, set.lexicon);
  const goldHits = hitMatrix(rules, positives.map((i) => gold.texts[i]), set.lexicon);
  const groupOf = (j: number) => (gold.groups ? gold.groups[positives[j]] : `#${j}`);
  const groupSize = new Map<string, number>();
  positives.forEach((_, j) => groupSize.set(groupOf(j), (groupSize.get(groupOf(j)) ?? 0) + 1));

  return {
    label, rule_set_version: set.version, prevalence, confidence,
    rules: rules.map((rule, r) => {
      const hits = certHits[r].filter(Boolean).length;
      // Each group contributes the share of its members caught; rounding down keeps the count conservative.
      const caught = Math.floor(goldHits[r].reduce((sum, f, j) => sum + (f ? 1 / groupSize.get(groupOf(j))! : 0), 0) + 1e-9);
      const fireUpper = clopperPearsonUpper(hits, certification.length, perStatement);
      const recallLower = clopperPearsonLower(caught, groupSize.size, perStatement);
      return {
        id: rule.id, cert_hits: hits, cert_n: certification.length, fire_rate_upper: fireUpper,
        gold_caught: caught, gold_positives: groupSize.size, recall_lower: recallLower,
        precision_lower: precisionLowerBound(prevalence, recallLower, fireUpper),
      };
    }),
  };
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** SHA-256 of the rule set's content (key order ignored) - for auditing which rules labelled a model's data. */
export function ruleSetHash(set: RuleSet): string {
  return createHash('sha256').update(stableJson(set)).digest('hex');
}

/**
 * The largest per-rule totals min(T_r, c) such that no rule exceeds `share` of their sum: c solves
 * c = share · (Σ_{T_r < c} T_r + c · #{T_r >= c}). Throws when only an all-zero allocation would do,
 * i.e. fewer than 1 / share rules contribute.
 */
function capShares(totals: readonly number[], share: number): number {
  const t = totals.filter((v) => v > 0).sort((a, b) => a - b);
  const sum = t.reduce((a, b) => a + b, 0);
  if (t.length === 0 || t[t.length - 1] <= share * sum + 1e-12) return Infinity;
  if (t.length * share < 1 - 1e-12) {
    throw new Error(`maxRuleShare ${share} needs at least ${Math.ceil(1 / share - 1e-12)} contributing rules but only ${t.length} contribute - raise maxRuleShare to at least ${(1 / t.length).toFixed(3)}`);
  }
  // j smallest totals stay uncapped, the other k - j are capped at c.
  let prefix = sum;
  for (let j = t.length - 1; j >= 0; j--) {
    prefix -= t[j];
    const capped = t.length - j;
    const denom = 1 - share * capped;
    if (Math.abs(denom) < 1e-12) return t[j]; // share · k = 1: every rule equal, at the smallest
    const c = (share * prefix) / denom;
    if (c > 0 && c <= t[j] && (j === 0 || t[j - 1] <= c)) return c;
  }
  throw new Error('maxRuleShare: no feasible cap'); // unreachable when k · share >= 1
}

export interface WeakLabel {
  /** Index into the texts passed to weakLabels. */
  index: number;
  /** The firing rule with the highest precision bound. */
  rule: string;
  /** That rule's precision lower bound. */
  bound: number;
  /** Near-duplicate group (the index of its first member). */
  group: number;
  /** bound / group size, then scaled by the rule's share cap. */
  weight: number;
}

export interface WeakLabelOptions {
  /** Held-out texts (calibration, test, certification, threshold background): a candidate matching one canonically is dropped. */
  exclude?: readonly string[];
  /** The current gold-trained head's probability per text; candidates below reviewFloor go to `review`, not to labels. */
  scores?: readonly number[];
  reviewFloor?: number;
  /** Near-duplicates beyond canonical text: embeddings per text, grouped at cosine >= threshold. */
  dedupe?: { embeddings: ReadonlyArray<ArrayLike<number>>; cosine: number };
  /** Highest share of the total weak weight one rule may supply (default 0.2). */
  maxRuleShare?: number;
}

export interface WeakLabelResult {
  label: string;
  rule_set_version: string;
  rule_set_hash: string;
  labels: WeakLabel[];
  /** Candidates the classifier strongly disagreed with (score < reviewFloor) - for a human, see disagreementQueues. */
  review: number[];
  summary: {
    fired: number;
    excluded: number;
    review: number;
    groups: number;
    weight_before_cap: number;
    weight: number;
    by_rule: Array<{ id: string; labels: number; weight_before_cap: number; weight: number }>;
  };
}

function unit(v: ArrayLike<number>): number[] {
  let sq = 0;
  for (let j = 0; j < v.length; j++) sq += v[j] * v[j];
  const norm = Math.sqrt(sq);
  return Array.from(v, (x) => (norm ? x / norm : 0));
}

/**
 * Weak positives for one label from unlabelled text. Eligible rules are the ones in `bounds` (compute
 * them for the certified rule set) with a positive bound. Train split only: calibration, test,
 * certification and threshold-budget data must stay human-labelled - pass them as `exclude`.
 *
 * A weak label's weight is a lower bound on the precision of the rule that produced it, averaged
 * over that rule's firings - a stated worst-case noise level for the population, not a per-text
 * probability.
 */
export function weakLabels(set: RuleSet, texts: readonly string[], bounds: RuleBounds, options: WeakLabelOptions = {}): WeakLabelResult {
  const { exclude = [], scores, reviewFloor, dedupe, maxRuleShare = 0.2 } = options;
  if (bounds.rule_set_version !== set.version) throw new Error(`bounds are for rule set ${bounds.rule_set_version}, not ${set.version}`);
  if (!(maxRuleShare > 0 && maxRuleShare <= 1)) throw new Error(`maxRuleShare must be in (0, 1], got ${maxRuleShare}`);
  if ((scores === undefined) !== (reviewFloor === undefined)) throw new Error('pass scores and reviewFloor together');
  if (scores && scores.length !== texts.length) throw new Error(`scores has ${scores.length} entries for ${texts.length} texts`);
  if (dedupe && dedupe.embeddings.length !== texts.length) throw new Error(`dedupe.embeddings has ${dedupe.embeddings.length} entries for ${texts.length} texts`);

  const bound = new Map(bounds.rules.filter((b) => b.precision_lower > 0).map((b) => [b.id, b.precision_lower]));
  const rules = set.rules.filter((r) => r.label === bounds.label && bound.has(r.id));
  const hits = hitMatrix(rules, texts, set.lexicon);
  const key = (t: string) => canonicalSegments(t, set.lexicon).join('\n');
  const heldOut = new Set(exclude.map(key));

  let fired = 0, excluded = 0;
  const review: number[] = [];
  const candidates: Array<{ index: number; rule: string; bound: number; key: string }> = [];
  texts.forEach((text, i) => {
    let best: string | null = null;
    for (let r = 0; r < rules.length; r++) {
      if (hits[r][i] && (best === null || bound.get(rules[r].id)! > bound.get(best)!)) best = rules[r].id;
    }
    if (best === null) return;
    fired++;
    const k = key(text);
    if (heldOut.has(k)) excluded++;
    else if (scores && scores[i] < reviewFloor!) review.push(i);
    else candidates.push({ index: i, rule: best, bound: bound.get(best)!, key: k });
  });

  // Near-duplicates count once: canonical text first, then (optionally) leader clustering by cosine.
  const groupOf = new Map<string, number>();
  const leaders: Array<{ index: number; v: number[] }> = [];
  const group = candidates.map((c) => {
    const known = groupOf.get(c.key);
    if (known !== undefined) return known;
    let g = c.index;
    if (dedupe) {
      const v = unit(dedupe.embeddings[c.index]);
      const near = leaders.find((l) => l.v.reduce((s, x, j) => s + x * v[j], 0) >= dedupe.cosine);
      if (near) g = near.index;
      else leaders.push({ index: c.index, v });
    }
    groupOf.set(c.key, g);
    return g;
  });
  const size = new Map<number, number>();
  group.forEach((g) => size.set(g, (size.get(g) ?? 0) + 1));
  const labels: WeakLabel[] = candidates.map((c, j) => ({ index: c.index, rule: c.rule, bound: c.bound, group: group[j], weight: c.bound / size.get(group[j])! }));

  const ids = [...new Set(labels.map((l) => l.rule))];
  const before = new Map(ids.map((id) => [id, labels.filter((l) => l.rule === id).reduce((s, l) => s + l.weight, 0)]));
  const cap = capShares([...before.values()], maxRuleShare);
  for (const l of labels) {
    const total = before.get(l.rule)!;
    if (total > cap) l.weight *= cap / total;
  }
  const sum = (ls: readonly WeakLabel[]) => ls.reduce((s, l) => s + l.weight, 0);
  return {
    label: bounds.label, rule_set_version: set.version, rule_set_hash: ruleSetHash(set), labels, review,
    summary: {
      fired, excluded, review: review.length, groups: size.size,
      weight_before_cap: [...before.values()].reduce((a, b) => a + b, 0), weight: sum(labels),
      by_rule: ids.map((id) => ({ id, labels: labels.filter((l) => l.rule === id).length, weight_before_cap: before.get(id)!, weight: sum(labels.filter((l) => l.rule === id)) })),
    },
  };
}

export interface QueueItem {
  index: number;
  score: number;
  /** The first matching rule of the label, or null. */
  rule: string | null;
  /** Other texts in the batch with the same canonical text (not queued separately). */
  duplicates: number;
}

export interface DisagreementQueues {
  /** A rule fires but the classifier is below its review floor: a rule false alarm or a classifier blind spot. Strongest disagreement first. */
  rule_only: QueueItem[];
  /** The classifier is at or above its threshold and no rule fires: new phrasing for mining, or a classifier false alarm. Highest score first. */
  classifier_only: QueueItem[];
  /** In the review band [reviewFloor, threshold) and in neither queue above: threshold placement. Closest to the threshold first. */
  near_threshold: QueueItem[];
}

/**
 * Texts worth a human label, for one label's head. Each text appears in at most one queue and each
 * canonical text once. Labels from these queues are gold but not a random sample: use them for
 * training only, and keep a separate random sample for calibration and test.
 */
export function disagreementQueues(
  set: RuleSet,
  texts: readonly string[],
  scores: readonly number[],
  options: { reviewFloor: number; threshold: number; label?: string; limit?: number },
): DisagreementQueues {
  const { reviewFloor, threshold, limit = Infinity } = options;
  if (scores.length !== texts.length) throw new Error(`scores has ${scores.length} entries for ${texts.length} texts`);
  if (!(reviewFloor <= threshold)) throw new Error(`reviewFloor ${reviewFloor} must not exceed threshold ${threshold}`);
  const { rules } = rulesFor(set, options.label);
  const hits = hitMatrix(rules, texts, set.lexicon);
  const firstRule = (i: number) => rules.find((_, r) => hits[r][i])?.id ?? null;

  const seen = new Map<string, QueueItem>();
  const queues: DisagreementQueues = { rule_only: [], classifier_only: [], near_threshold: [] };
  texts.forEach((text, i) => {
    const score = scores[i];
    if (!Number.isFinite(score)) throw new Error(`scores[${i}] is not finite (${score})`);
    const rule = firstRule(i);
    const queue = rule !== null && score < reviewFloor ? 'rule_only' : rule === null && score >= threshold ? 'classifier_only' : score >= reviewFloor && score < threshold ? 'near_threshold' : null;
    if (!queue) return;
    const k = `${queue}\u0000${canonicalSegments(text, set.lexicon).join('\n')}`;
    const prior = seen.get(k);
    if (prior) {
      prior.duplicates++;
      return;
    }
    const item = { index: i, score, rule, duplicates: 0 };
    seen.set(k, item);
    queues[queue].push(item);
  });
  queues.rule_only.sort((a, b) => a.score - b.score || a.index - b.index);
  queues.classifier_only.sort((a, b) => b.score - a.score || a.index - b.index);
  queues.near_threshold.sort((a, b) => b.score - a.score || a.index - b.index);
  for (const q of Object.keys(queues) as Array<keyof DisagreementQueues>) queues[q] = queues[q].slice(0, limit);
  return queues;
}
