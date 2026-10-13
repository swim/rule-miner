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
  const count = new Map<string, number>();
  for (const s of design.strata) count.set(s, (count.get(s) ?? 0) + 1);
  for (const [s, k] of count) {
    const N = design.stratumSizes[s];
    if (!(Number.isFinite(N) && N >= k)) throw new Error(`stratum ${s}: stratumSizes gives ${N} for ${k} sampled unit(s)`);
  }
  design.inclusionProbs.forEach((p, i) => {
    const s = design.strata[i], expected = count.get(s)! / design.stratumSizes[s];
    if (!(p > 0 && p <= 1) || Math.abs(p - expected) > 1e-9 * Math.max(1, expected)) throw new Error(`stratum ${s}: inclusionProbs[${i}] = ${p} but n_h / N_h = ${expected} (stratified simple random sampling only)`);
  });
}

/**
 * The design of the labelled units only (`keep`): unlabelled units (e.g. reviewer skips) drop out, and
 * each stratum's inclusion probability becomes n'_h / N_h for its n'_h labelled units. This assumes
 * labels are missing at random within a stratum (a second-phase simple random subsample); a skip that
 * depends on the label would bias every design-based bound.
 */
export function labelledDesign(design: SampleDesign, keep: readonly boolean[]): SampleDesign {
  if (keep.length !== design.strata.length) throw new Error(`keep has ${keep.length} entries for ${design.strata.length} units`);
  const total = new Map<string, number>(), kept = new Map<string, number>();
  design.strata.forEach((s, i) => { total.set(s, (total.get(s) ?? 0) + 1); if (keep[i]) kept.set(s, (kept.get(s) ?? 0) + 1); });
  const idx = keep.flatMap((k, i) => (k ? [i] : []));
  return {
    inclusionProbs: idx.map((i) => design.inclusionProbs[i] * kept.get(design.strata[i])! / total.get(design.strata[i])!),
    strata: idx.map((i) => design.strata[i]),
    stratumSizes: design.stratumSizes,
  };
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
  const effective = kishEffectiveN(den.flatMap((d, i) => (d ? [1 / design.inclusionProbs[i]] : [])));
  if (method === 'exact') {
    // The point estimate only (Horvitz-Thompson ratio): the exact bound needs no variance, so a
    // stratum with a single sampled unit (e.g. after reviewer skips) is fine here.
    let A = 0, B = 0;
    for (let i = 0; i < num.length; i++) { A += num[i] / design.inclusionProbs[i]; B += den[i] / design.inclusionProbs[i]; }
    const estimate = A / B;
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
  const { estimate, se } = stratifiedRatio({ ...design, num, den });
  const z = normalQuantile(confidence);
  // The floor at the Kish size rounds the count conservatively: up for an upper bound, down for a lower one.
  const n = Math.max(1, Math.round(effective)), k = Math.min(n, Math.max(0, side === 'upper' ? Math.ceil(estimate * n - 1e-9) : Math.floor(estimate * n + 1e-9)));
  const bound = side === 'upper'
    ? Math.min(1, Math.max(estimate + z * se, clopperPearsonUpper(k, n, confidence)))
    : Math.max(0, Math.min(estimate - z * se, clopperPearsonLower(k, n, confidence)));
  return { estimate, effective, bound };
}
