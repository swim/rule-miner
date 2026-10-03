/**
 * A statistical guarantee for sign-off: "with 95% confidence, this rule set fires on at most
 * maxRate of ordinary messages".
 *
 * That is a FIRING-RATE statement: unlabelled traffic holds positives too, and every correct catch
 * spends the budget (at 4% prevalence a 2% budget can fail rules whose every firing is right). For a
 * statement about false alarms, use certifyFalseAlarms on labelled negatives.
 *
 * The rules' order is fixed BEFORE looking at the certification texts (mining order), so the
 * prefixes 1..k are tested in sequence - fixed-sequence testing controls the error rate at
 * 1 - confidence across all of them - and the longest prefix whose exact Clopper-Pearson upper
 * bound on the firing rate is <= maxRate is certified. The certification texts must be held out
 * from mining (a separate half of the background), and the guarantee only covers text like them.
 */
import { clopperPearsonUpper } from '@liquidau/solvers';

import { designRate, type BoundMethod, type SampleDesign } from './design.ts';
import { checkBackgroundRecords, type RecordLike } from './provenance.ts';

export interface Certification {
  /** How many leading rules are certified. */
  certified: number;
  rows: Array<{ rules: number; hits: number; n: number; rate_upper: number; passed: boolean }>;
}

/** fired[r][i]: does rule r (in mining order) fire on certification text i. */
export function certifyPrefixes(
  fired: ReadonlyArray<readonly boolean[]>,
  options: {
    maxRate: number;
    confidence?: number;
    /** The certification texts as records, one per column: checked to be unlabelled traffic with backgroundUse 'certify' (P2, P3). */
    records?: readonly RecordLike[];
  },
): Certification {
  const { maxRate, confidence = 0.95, records } = options;
  const n = fired[0]?.length ?? 0;
  if (records) {
    if (records.length !== n) throw new Error(`records has ${records.length} entries for ${n} certification texts`);
    checkBackgroundRecords(records, ['certify']);
  }
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

export interface FalseAlarmCertification {
  /** How many leading rules are certified. */
  certified: number;
  rows: Array<{ rules: number; false_alarms: number; negatives: number; rate: number; rate_upper: number; passed: boolean }>;
  method: 'exact' | 'design-exact' | 'design-linearised';
}

/**
 * "With `confidence`, the first k rules (in mining order) fire on at most maxRate of NEGATIVE
 * messages" - a false-alarm guarantee, unlike certifyPrefixes' firing rate, so correct catches cost
 * nothing. Prefixes are tested in order (fixed sequence) and the longest passing prefix certified.
 *
 * Labels must come from texts held out from mining and validation. Without `design` they must be a
 * simple random sample of the traffic's negatives (exact Clopper-Pearson on the counts); with a
 * stratified sample (e.g. sampled calibration records), pass its design: rates are weighted by 1/π,
 * and the bound is `method` (default 'exact').
 */
export function certifyFalseAlarms(
  fired: ReadonlyArray<readonly boolean[]>,
  options: {
    y: ReadonlyArray<0 | 1 | null>;
    maxRate: number;
    confidence?: number;
    design?: SampleDesign;
    method?: BoundMethod;
    /**
     * With a design (exact): the whole sampling frame, rules × frame units, and each unit's stratum
     * (named as in design.strata). Rules are deterministic, so how often a prefix fires in each
     * population stratum is known without labels; it caps that stratum's possible false alarms
     * exactly - in strata the rules never fire in, to zero.
     */
    frame?: { strata: readonly string[]; fired: ReadonlyArray<readonly boolean[]> };
  },
): FalseAlarmCertification {
  const { y, maxRate, confidence = 0.95, design, method = 'exact', frame } = options;
  if (frame) {
    if (!design) throw new Error('frame needs a design');
    if (frame.fired.length !== fired.length) throw new Error(`frame.fired has ${frame.fired.length} rules, fired has ${fired.length}`);
    for (const row of frame.fired) if (row.length !== frame.strata.length) throw new Error('frame.fired rows must align with frame.strata');
  }
  const frameUnion = frame ? new Array<boolean>(frame.strata.length).fill(false) : null;
  const n = fired[0]?.length ?? y.length;
  if (y.length !== n) throw new Error(`y has ${y.length} entries for ${n} texts`);
  if (!(maxRate > 0 && maxRate < 1)) throw new Error(`maxRate must be strictly between 0 and 1, got ${maxRate}`);
  const negative = y.map((v) => v === 0);
  const labelled = y.map((v) => v === 0 || v === 1);
  if (!negative.some(Boolean)) throw new Error('no labelled negatives to certify false alarms on');
  // With a design, units without a label drop out; the domain is the negatives.
  const sub = <T>(xs: readonly T[]) => xs.filter((_, i) => labelled[i]);
  const union = new Array<boolean>(n).fill(false);
  const rows: FalseAlarmCertification['rows'] = [];
  let certified = 0;
  let open = true;
  fired.forEach((row, r) => {
    if (row.length !== n) throw new Error(`fired[${r}] has ${row.length} entries for ${n} texts`);
    row.forEach((f, i) => { if (f) union[i] = true; });
    if (frame) frame.fired[r].forEach((f, i) => { if (f) frameUnion![i] = true; });
    const fa = union.filter((f, i) => f && negative[i]).length;
    const negs = negative.filter(Boolean).length;
    let rate: number, upper: number;
    if (design) {
      const d = { inclusionProbs: sub(design.inclusionProbs), strata: sub(design.strata), stratumSizes: design.stratumSizes };
      let cap: Record<string, number> | undefined;
      if (frame) {
        cap = {};
        frame.strata.forEach((s, i) => { cap![s] = (cap![s] ?? 0) + (frameUnion![i] ? 1 : 0); });
      }
      const res = designRate(sub(union), sub(negative), d, 'upper', confidence, method, cap);
      rate = res.estimate;
      upper = res.bound;
    } else {
      rate = fa / negs;
      upper = clopperPearsonUpper(fa, negs, confidence);
    }
    const passed = open && upper <= maxRate;
    if (passed) certified = r + 1;
    else open = false;
    rows.push({ rules: r + 1, false_alarms: fa, negatives: negs, rate, rate_upper: upper, passed });
  });
  return { certified, rows, method: design ? (method === 'exact' ? 'design-exact' : 'design-linearised') : 'exact' };
}
