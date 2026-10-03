import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clopperPearsonUpper } from '@liquidau/solvers';

import { buildRuleSet, disagreementQueues, precisionLowerBound, ruleBounds, ruleSetHash, weakLabels, type RuleBounds } from '../src/index.ts';

const phrase = (s: string) => ({ kind: 'phrase' as const, tokens: s.split(' ') });
const set = buildRuleSet('v1', [
  { label: 'risk', rules: [{ id: 'r1', pattern: phrase('want to die'), except: [phrase('years ago')] }, { id: 'r2', pattern: phrase('end it all') }] },
  { label: 'refund', rules: [{ id: 'r1', pattern: phrase('full refund') }] },
], { createdAt: '2026-10-03' });

test('ruleBounds: exact per-rule bounds that hold jointly, with exceptions applied and groups counted once', () => {
  const certification = [...Array.from({ length: 998 }, (_, i) => `ordinary message ${i}`), 'i want to die laughing', 'years ago i would want to die'];
  const gold = {
    texts: ['i want to die', 'i want to die tonight', 'i will end it all', 'nobody cares', 'so tired', 'what a day', 'refund please'],
    y: [1, 1, 1, 1, 1, 0, null] as Array<0 | 1 | null>,
    groups: ['a', 'a', 'b', 'c', 'd', 'e', 'f'],
  };
  const b = ruleBounds(set, { certification, gold, prevalence: 0.005, label: 'risk' });
  assert.equal(b.label, 'risk');
  assert.deepEqual(b.rules.map((r) => r.id), ['risk.r1', 'risk.r2']);
  const conf = 1 - 0.05 / 4;
  const [r1, r2] = b.rules;
  assert.equal(r1.cert_hits, 1, 'the exception stops the second certification hit');
  assert.equal(r1.fire_rate_upper, clopperPearsonUpper(1, 1000, conf));
  assert.equal(r1.gold_positives, 4, 'four positive groups');
  assert.equal(r1.gold_caught, 1, 'group a counts once');
  assert.equal(r1.recall_lower, 1 - clopperPearsonUpper(3, 4, conf));
  assert.equal(r1.precision_lower, precisionLowerBound(0.005, r1.recall_lower, r1.fire_rate_upper));
  assert.equal(r2.cert_hits, 0);
  assert.ok(r2.fire_rate_upper < r1.fire_rate_upper);

  assert.equal(ruleBounds(set, { certification, gold, prevalence: 0.005, label: 'risk', exclude: ['risk.r2'] }).rules.length, 1);
  assert.throws(() => ruleBounds(set, { certification, gold, prevalence: 0.005 }), /2 labels .* pass a label/);
  assert.throws(() => ruleBounds(set, { certification: [], gold, prevalence: 0.005, label: 'risk' }), /certification texts are empty/);
  assert.throws(() => ruleBounds(set, { certification, gold: { ...gold, y: gold.y.map(() => 0) }, prevalence: 0.005, label: 'risk' }), /no positives/);
});

test('ruleSetHash ignores key order and changes with content', () => {
  const reordered = JSON.parse(JSON.stringify({ rules: set.rules, version: set.version, created_at: set.created_at, format: set.format }));
  assert.equal(ruleSetHash(reordered), ruleSetHash(set));
  assert.notEqual(ruleSetHash({ ...set, version: 'v2' }), ruleSetHash(set));
});

const bounds = (b: Record<string, number>, label = 'risk'): RuleBounds => ({
  label, rule_set_version: 'v1', prevalence: 0.005, confidence: 0.95,
  rules: Object.entries(b).map(([id, precision_lower]) => ({ id, cert_hits: 0, cert_n: 1, fire_rate_upper: 0, gold_caught: 0, gold_positives: 1, recall_lower: 0, precision_lower })),
});

test('weakLabels: positives only, held-out texts dropped, disagreements sent to review, duplicates counted once', () => {
  const texts = ['I want to die', 'i want to die.', 'I will end it all', 'nothing to see', 'i want to die and end it all', 'held out: end it all', 'years ago i would want to die', 'i want to die, she said'];
  const scores = [0.5, 0.5, 0.01, 0.9, 0.5, 0.5, 0.5, 0.5];
  const result = weakLabels(set, texts, bounds({ 'risk.r1': 0.3, 'risk.r2': 0.6 }), {
    exclude: ['Held out: END it all'], scores, reviewFloor: 0.05, maxRuleShare: 1,
  });
  assert.equal(result.rule_set_hash, ruleSetHash(set));
  assert.deepEqual(result.review, [2], 'the classifier strongly disagrees with text 2');
  assert.deepEqual(result.labels.map((l) => [l.index, l.rule]), [[0, 'risk.r1'], [1, 'risk.r1'], [4, 'risk.r2'], [7, 'risk.r1']], 'non-firing texts are never labelled; the best bound wins');
  const [a, b] = result.labels;
  assert.equal(a.group, b.group, 'canonically equal texts form one group');
  assert.equal(a.weight + b.weight, 0.3, '...which counts once');
  assert.equal(result.labels[2].weight, 0.6);
  assert.deepEqual({ fired: result.summary.fired, excluded: result.summary.excluded, review: result.summary.review, groups: result.summary.groups }, { fired: 6, excluded: 1, review: 1, groups: 3 });

  const emb = texts.map((_, i) => (i === 7 ? [1, 0.01] : [1, 0]));
  const near = weakLabels(set, texts, bounds({ 'risk.r1': 0.3, 'risk.r2': 0.6 }), { dedupe: { embeddings: emb, cosine: 0.95 }, maxRuleShare: 1 });
  assert.equal(new Set(near.labels.map((l) => l.group)).size, 1, 'everything within cosine 0.95 of the first candidate joins its group');

  assert.throws(() => weakLabels({ ...set, version: 'v2' }, texts, bounds({ 'risk.r1': 0.3 })), /bounds are for rule set v1, not v2/);
  assert.throws(() => weakLabels(set, texts, bounds({ 'risk.r1': 0.3 }), { scores }), /scores and reviewFloor together/);
});

test('weakLabels: no rule supplies more than maxRuleShare of the weak weight', () => {
  const rules = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const many = buildRuleSet('v1', [{ label: 'risk', rules: rules.map((w) => ({ id: w, pattern: phrase(w) })) }]);
  const texts = [...Array.from({ length: 10 }, (_, i) => `alpha ${i}`), 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const b = bounds(Object.fromEntries(rules.map((w) => [`risk.${w}`, 1])));
  const result = weakLabels(many, texts, b);
  // Totals 10,1,1,1,1,1 at 20%: alpha is capped at c = 0.2 (5 + c) = 1.25.
  const alpha = result.summary.by_rule.find((r) => r.id === 'risk.alpha')!;
  assert.equal(alpha.weight_before_cap, 10);
  assert.ok(Math.abs(alpha.weight - 1.25) < 1e-12);
  assert.ok(Math.abs(result.summary.weight - 6.25) < 1e-12);
  assert.ok(alpha.weight / result.summary.weight <= 0.2 + 1e-12);

  assert.throws(() => weakLabels(many, texts.slice(0, 12), b), /needs at least 5 contributing rules but only 3 contribute/);
  assert.ok(Math.abs(weakLabels(many, texts.slice(0, 12), b, { maxRuleShare: 1 / 3 }).summary.weight - 3) < 1e-12, 'k · share = 1: every rule at the smallest total');
  assert.equal(weakLabels(many, texts, bounds({ 'risk.alpha': 0 })).labels.length, 0, 'a zero bound makes a rule ineligible');
});

test('disagreementQueues: three disjoint, deduplicated, prioritised queues', () => {
  const texts = ['i want to die', 'I want to die!', 'i will end it all', 'please help me', 'i feel lost', 'lovely day', 'quite unsure', 'i want a full refund'];
  const scores = [0.01, 0.01, 0.03, 0.95, 0.8, 0.0, 0.3, 0.4];
  const q = disagreementQueues(set, texts, scores, { label: 'risk', reviewFloor: 0.2, threshold: 0.7 });
  assert.deepEqual(q.rule_only.map((i) => [i.index, i.rule, i.duplicates]), [[0, 'risk.r1', 1], [2, 'risk.r2', 0]]);
  assert.deepEqual(q.classifier_only.map((i) => i.index), [3, 4]);
  assert.deepEqual(q.near_threshold.map((i) => [i.index, i.rule]), [[7, null], [6, null]], 'a refund rule is not a risk rule');
  assert.equal(disagreementQueues(set, texts, scores, { label: 'risk', reviewFloor: 0.2, threshold: 0.7, limit: 1 }).classifier_only.length, 1);
  assert.throws(() => disagreementQueues(set, texts, scores, { reviewFloor: 0.2, threshold: 0.7 }), /pass a label/);
  assert.throws(() => disagreementQueues(set, texts, scores, { label: 'risk', reviewFloor: 0.8, threshold: 0.7 }), /must not exceed/);
});
