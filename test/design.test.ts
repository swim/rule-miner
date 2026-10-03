import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clopperPearsonUpper, seededRandom, stratifiedRatio } from '@liquidau/solvers';

import { buildRuleSet, certifyFalseAlarms, certifyPrefixes, designRate, evaluateFired, ruleBounds } from '../src/index.ts';

test('certifyFalseAlarms: correct catches cost nothing; firing-rate certification spends its budget on them', () => {
  // 1000 labelled messages, 4% positive. Rule A fires only on positives; rule B also on 1% of negatives.
  const y = Array.from({ length: 1000 }, (_, i) => (i < 40 ? 1 : 0) as 0 | 1);
  const ruleA = y.map((v, i) => v === 1 && i % 2 === 0); // 20 correct catches
  const ruleB = y.map((v, i) => (v === 1 && i % 2 === 1) || (v === 0 && i % 100 === 50)); // 20 more + ~10 false alarms
  const firing = certifyPrefixes([ruleA, ruleB], { maxRate: 0.02 });
  assert.equal(firing.certified, 0, 'firing on 2% of traffic, all of it correct, already breaks a 2% firing budget');
  const fa = certifyFalseAlarms([ruleA, ruleB], { y, maxRate: 0.02 });
  assert.equal(fa.certified, 2);
  assert.equal(fa.rows[0].false_alarms, 0);
  assert.equal(fa.rows[0].rate_upper, clopperPearsonUpper(0, 960, 0.95), 'exact on a simple random sample of negatives');
  assert.equal(fa.method, 'exact');
  assert.throws(() => certifyFalseAlarms([ruleA], { y: y.map(() => 1), maxRate: 0.02 }), /no labelled negatives/);
});

/** A population with a known false-alarm and recall rate per stratum, sampled with unequal probabilities. */
function population(seed: number) {
  const rand = seededRandom(seed);
  const strata = ['hi', 'mid', 'low'], N = { hi: 1000, mid: 4000, low: 15000 } as Record<string, number>;
  const pos = { hi: 0.4, mid: 0.05, low: 0.005 } as Record<string, number>, fireNeg = { hi: 0.08, mid: 0.02, low: 0.003 } as Record<string, number>, firePos = { hi: 0.7, mid: 0.4, low: 0.2 } as Record<string, number>;
  const units: Array<{ s: string; y: 0 | 1; fired: boolean }> = [];
  for (const s of strata) for (let i = 0; i < N[s]; i++) { const y = rand() < pos[s] ? 1 : 0; units.push({ s, y, fired: rand() < (y ? firePos[s] : fireNeg[s]) }); }
  const negs = units.filter((u) => !u.y), poss = units.filter((u) => u.y);
  return { units, N, trueFa: negs.filter((u) => u.fired).length / negs.length, trueRecall: poss.filter((u) => u.fired).length / poss.length };
}
function sample(pop: ReturnType<typeof population>, n: Record<string, number>, rand: () => number) {
  const out: Array<{ s: string; y: 0 | 1; fired: boolean; pi: number }> = [];
  for (const s of Object.keys(n)) {
    const members = pop.units.filter((u) => u.s === s);
    for (let k = 0; k < n[s]; k++) { const j = k + Math.floor(rand() * (members.length - k)); [members[k], members[j]] = [members[j], members[k]]; out.push({ ...members[k], pi: n[s] / members.length }); }
  }
  return { units: out, design: { inclusionProbs: out.map((u) => u.pi), strata: out.map((u) => u.s), stratumSizes: pop.N } };
}

test('design-based false-alarm bounds cover the true rate in at least 95% of stratified samples', () => {
  const pop = population(1);
  const rand = seededRandom(2);
  const runs = 300;
  const covered = { exact: 0, linearised: 0 };
  let unweighted = 0, weighted = 0;
  for (let r = 0; r < runs; r++) {
    const { units, design } = sample(pop, { hi: 300, mid: 300, low: 300 }, rand); // high-score strata oversampled
    for (const method of ['exact', 'linearised'] as const) {
      const c = certifyFalseAlarms([units.map((u) => u.fired)], { y: units.map((u) => u.y), maxRate: 0.5, design, method });
      if (c.rows[0].rate_upper >= pop.trueFa) covered[method]++;
    }
    unweighted += certifyFalseAlarms([units.map((u) => u.fired)], { y: units.map((u) => u.y), maxRate: 0.5 }).rows[0].rate / runs;
    weighted += certifyFalseAlarms([units.map((u) => u.fired)], { y: units.map((u) => u.y), maxRate: 0.5, design }).rows[0].rate / runs;
  }
  const slack = 3 * Math.sqrt((0.05 * 0.95) / runs);
  assert.ok(covered.exact / runs >= 0.95 - slack, `exact covered ${covered.exact}/${runs}`);
  assert.ok(covered.linearised / runs >= 0.95 - slack, `linearised covered ${covered.linearised}/${runs}`);
  // Ignoring the design is biased: here high-false-alarm strata are oversampled, so counts overstate it.
  assert.ok(unweighted > 2 * pop.trueFa, `unweighted mean ${unweighted} vs true ${pop.trueFa}`);
  assert.ok(Math.abs(weighted - pop.trueFa) < 0.1 * pop.trueFa, `weighted mean ${weighted} vs true ${pop.trueFa}`);
});

test('evaluateFired and ruleBounds weight a stratified sample by 1/π', () => {
  const pop = population(3);
  const { units, design } = sample(pop, { hi: 400, mid: 400, low: 400 }, seededRandom(4));
  const fired = units.map((u) => u.fired), y = units.map((u) => u.y);
  const ev = evaluateFired(fired, y, { design });
  assert.equal(ev.method, 'design');
  const expected = stratifiedRatio({ ...design, num: units.map((u) => (u.y && u.fired ? 1 : 0)), den: y }).estimate;
  assert.ok(Math.abs(ev.recall - expected) < 1e-12);
  assert.ok(ev.recall_ci95[0] <= ev.recall && ev.recall <= ev.recall_ci95[1]);
  const counts = evaluateFired(fired, y);
  assert.equal(counts.method, 'counts');
  assert.notEqual(counts.recall, ev.recall, 'unweighted counts of a stratified sample differ');
  assert.ok(designRate(fired, y.map((v) => v === 1), design, 'lower', 0.95).bound <= pop.trueRecall + 1e-9);

  // ruleBounds: a rule that fires on texts marked "hit"; its design-based recall lower bound covers the truth.
  const set = buildRuleSet('v1', [{ label: 'risk', rules: [{ id: 'r1', pattern: { kind: 'phrase', tokens: ['hit'] } }] }], { createdAt: '2026-10-03' });
  const texts = units.map((u, i) => (u.fired ? `message ${i} hit` : `message ${i}`));
  const certification = Array.from({ length: 2000 }, (_, i) => `ordinary ${i}`);
  const withDesign = ruleBounds(set, { certification, gold: { texts, y, design }, prevalence: 0.03 });
  const withoutDesign = ruleBounds(set, { certification, gold: { texts, y }, prevalence: 0.03 });
  assert.ok(withDesign.rules[0].recall_lower <= pop.trueRecall, `${withDesign.rules[0].recall_lower} vs true ${pop.trueRecall}`);
  assert.notEqual(withDesign.rules[0].recall_lower, withoutDesign.rules[0].recall_lower);
});

test('certifyFalseAlarms with the frame: known firing caps each stratum exactly, keeping coverage and tightening the bound', () => {
  // A deterministic rule that fires only in the 'hi' stratum; its firing is known for every population unit.
  const rand = seededRandom(5);
  const N = { hi: 600, mid: 4000, low: 15000 } as Record<string, number>;
  const units: Array<{ s: string; y: 0 | 1; fired: boolean }> = [];
  for (const s of Object.keys(N)) for (let i = 0; i < N[s]; i++) { const y = rand() < (s === 'hi' ? 0.5 : 0.01) ? 1 : 0; units.push({ s, y, fired: s === 'hi' && rand() < (y ? 0.8 : 0.1) }); }
  const negs = units.filter((u) => !u.y);
  const trueFa = negs.filter((u) => u.fired).length / negs.length;
  const frame = { strata: units.map((u) => u.s), fired: [units.map((u) => u.fired)] };
  const runs = 200;
  let covered = 0, tighter = 0;
  for (let r = 0; r < runs; r++) {
    const sampled: Array<{ s: string; y: 0 | 1; fired: boolean; pi: number }> = [];
    for (const [s, n] of Object.entries({ hi: 150, mid: 200, low: 300 })) {
      const members = units.filter((u) => u.s === s);
      for (let k = 0; k < n; k++) { const j = k + Math.floor(rand() * (members.length - k)); [members[k], members[j]] = [members[j], members[k]]; sampled.push({ ...members[k], pi: n / members.length }); }
    }
    const design = { inclusionProbs: sampled.map((u) => u.pi), strata: sampled.map((u) => u.s), stratumSizes: N };
    const args = { y: sampled.map((u) => u.y), maxRate: 0.5, design };
    const withFrame = certifyFalseAlarms([sampled.map((u) => u.fired)], { ...args, frame }).rows[0].rate_upper;
    const without = certifyFalseAlarms([sampled.map((u) => u.fired)], args).rows[0].rate_upper;
    if (withFrame >= trueFa) covered++;
    if (withFrame < without) tighter++;
  }
  assert.ok(covered / runs >= 0.95 - 3 * Math.sqrt(0.0475 / runs), `covered ${covered}/${runs}`);
  assert.equal(tighter, runs, 'unseen false alarms in strata the rule never fires in are ruled out exactly');
  assert.throws(() => certifyFalseAlarms([[true]], { y: [0], maxRate: 0.5, frame }), /frame needs a design/);
});
