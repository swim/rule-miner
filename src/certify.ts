/**
 * A statistical guarantee for sign-off: "with 95% confidence, this rule set fires on at most
 * maxRate of ordinary messages".
 *
 * The rules' order is fixed BEFORE looking at the certification texts (mining order), so the
 * prefixes 1..k are tested in sequence - fixed-sequence testing controls the error rate at
 * 1 - confidence across all of them - and the longest prefix whose exact Clopper-Pearson upper
 * bound on the firing rate is <= maxRate is certified. The certification texts must be held out
 * from mining (a separate half of the background), and the guarantee only covers text like them.
 */
import { clopperPearsonUpper } from '@liquidau/solvers';

export interface Certification {
  /** How many leading rules are certified. */
  certified: number;
  rows: Array<{ rules: number; hits: number; n: number; rate_upper: number; passed: boolean }>;
}

/** fired[r][i]: does rule r (in mining order) fire on certification text i. */
export function certifyPrefixes(fired: ReadonlyArray<readonly boolean[]>, options: { maxRate: number; confidence?: number }): Certification {
  const { maxRate, confidence = 0.95 } = options;
  const n = fired[0]?.length ?? 0;
  const union = new Array<boolean>(n).fill(false);
  const rows: Certification['rows'] = [];
  let certified = 0;
  let open = true;
  fired.forEach((row, r) => {
    row.forEach((f, i) => { if (f) union[i] = true; });
    const hits = union.filter(Boolean).length;
    const upper = clopperPearsonUpper(hits, n, confidence);
    const passed = open && upper <= maxRate;
    if (passed) certified = r + 1;
    else open = false; // fixed sequence: stop at the first failure
    rows.push({ rules: r + 1, hits, n, rate_upper: upper, passed });
  });
  return { certified, rows };
}

/**
 * A conservative precision estimate in production from the label's prevalence, a lower bound on
 * recall and an upper bound on the firing rate on ordinary (negative) text.
 */
export function precisionLowerBound(prevalence: number, recallLower: number, fireRateUpper: number): number {
  const tp = prevalence * recallLower;
  const fp = (1 - prevalence) * fireRateUpper;
  return tp + fp === 0 ? 1 : tp / (tp + fp);
}
