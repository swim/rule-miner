/**
 * Design-based bounds for rates estimated on a stratified probability sample (e.g. the sampled,
 * human-labelled calibration or test records embedding-classifier's designSample produces): every
 * unit counts with weight 1/π, so rates describe the traffic the sample was drawn from.
 *
 *   exact       per stratum, Clopper-Pearson bounds on the population counts of "hits" and "misses"
 *               within the domain, Bonferroni over 2·H, combined as a ratio; census strata use their
 *               counts. Valid, conservative with many strata.
 *   linearised  R̂ ± z·se (solvers' stratifiedRatio), widened by the exact interval at the Kish
 *               effective size of the domain so it can't collapse at 0 or 1. Approximate.
 */
import { clopperPearsonLower, clopperPearsonUpper, kishEffectiveN, normalQuantile, stratifiedRatio } from '@liquidau/solvers';

/** A stratified sample's design, aligned with the examples (as solvers' estimators take it). */
export interface SampleDesign {
  inclusionProbs: readonly number[];
  strata: readonly string[];
  stratumSizes: Readonly<Record<string, number>>;
}

export type BoundMethod = 'exact' | 'linearised';

function checkDesign(design: SampleDesign, n: number): void {
  if (design.inclusionProbs.length !== n || design.strata.length !== n) throw new Error(`design has ${design.inclusionProbs.length} inclusion probabilities and ${design.strata.length} strata for ${n} examples`);
}

/**
 * Estimate and one-sided bound of the rate of `hit` among units in `domain` (e.g. fired among
 * negatives), at the given confidence.
 *
 * `cap` (exact, side 'upper' only): per stratum, a known ceiling on the population count of hits -
 * e.g. how many frame units a deterministic rule fires on at all, which needs no labels. A stratum
 * where the rule fires nowhere then contributes no possible hits, instead of N_h·CP_upper(0, n_h).
 */
export function designRate(hit: readonly boolean[], domain: readonly boolean[], design: SampleDesign, side: 'upper' | 'lower', confidence: number, method: BoundMethod = 'exact', cap?: Readonly<Record<string, number>>): { estimate: number; bound: number; effective: number } {
  checkDesign(design, hit.length);
  if (domain.length !== hit.length) throw new Error('hit and domain must be the same length');
  if (!domain.some(Boolean)) throw new Error('no sampled unit is in the domain');
  const num = hit.map((h, i) => (h && domain[i] ? 1 : 0)), den = domain.map(Number);
  const { estimate, se } = stratifiedRatio({ ...design, num, den });
  const effective = kishEffectiveN(den.flatMap((d, i) => (d ? [1 / design.inclusionProbs[i]] : [])));
  if (method === 'exact') {
    const byStratum = new Map<string, number[]>();
    design.strata.forEach((s, i) => (byStratum.get(s) ?? byStratum.set(s, []).get(s)!).push(i));
    const conf = 1 - (1 - confidence) / (2 * byStratum.size);
    // Bound the population count of the side we're bounding up, and of its complement down.
    let up = 0, down = 0;
    for (const [s, idx] of byStratum) {
      const N = design.stratumSizes[s], n = idx.length;
      const a = idx.filter((i) => num[i]).length, b = idx.filter((i) => den[i] && !num[i]).length;
      const [target, other] = side === 'upper' ? [a, b] : [b, a];
      if (n === N) { up += target; down += other; continue; }
      const ceiling = side === 'upper' && cap?.[s] !== undefined ? cap[s] : Infinity;
      up += Math.min(ceiling, N * clopperPearsonUpper(target, n, conf));
      down += N * clopperPearsonLower(other, n, conf);
    }
    const share = up + down === 0 ? 1 : up / (up + down);
    return { estimate, effective, bound: side === 'upper' ? share : 1 - share };
  }
  const z = normalQuantile(confidence);
  const n = Math.max(1, Math.round(effective)), k = Math.min(n, Math.max(0, Math.round(estimate * n)));
  const bound = side === 'upper'
    ? Math.min(1, Math.max(estimate + z * se, clopperPearsonUpper(k, n, confidence)))
    : Math.max(0, Math.min(estimate - z * se, clopperPearsonLower(k, n, confidence)));
  return { estimate, effective, bound };
}
