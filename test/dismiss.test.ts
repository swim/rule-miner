import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRuleSet, certifyDismissals, certifyFalseAlarms, certifyPrefixes, firingReport, hitMatrix, jointLabels, mineDismissals, ruleBounds, ruleSetMatcher, validateDismissals, validateRuleSet,
  RULESET_FORMAT, RULESET_FORMAT_DISMISS,
} from '../src/index.ts';

const phrase = (s: string) => ({ kind: 'phrase' as const, tokens: s.split(' ') });

// Card-loss messages are positives; balance and statement questions are ordinary negatives.
const positives = ['my card was stolen', 'i lost my card yesterday', 'someone stole my card', 'card stolen at the station', 'lost card please block it', 'my wallet and card were stolen'];
const negatives = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? `what is my balance today ${i}` : i % 3 === 1 ? `how do i download my statement ${i}` : `what is my balance in euros ${i}`));

test('mineDismissals finds negative-class rules; validateDismissals drops one that matches a positive', () => {
  const texts = [...positives, ...negatives];
  const y = [...positives.map(() => 1 as const), ...negatives.map(() => 0 as const)];
  const rules = mineDismissals({ texts, y }, { minGroups: 5 });
  assert.ok(rules.length > 0, 'some dismissal rule is mined');
  for (const r of rules) assert.equal(hitMatrix([r], positives)[0].filter(Boolean).length, 0, `${r.id} matches no positive`);
  const balance = { id: 'b', pattern: phrase('balance') }, my = { id: 'm', pattern: phrase('my') };
  const kept = validateDismissals([balance, my], ['my balance please', 'my card was stolen'], [0, 1]);
  assert.deepEqual(kept.kept.map((r) => r.id), ['b'], '"my" also matches a positive and is dropped');
});

test('certifyDismissals is certifyFalseAlarms on the positives (labels flipped), linearised with a design', () => {
  const fired = [[true, false, false, true, false, false]];
  const y = [0, 1, 1, 0, 1, 1] as Array<0 | 1>;
  const flipped = y.map((v) => (1 - v) as 0 | 1);
  assert.deepEqual(certifyDismissals(fired, { y, maxRate: 0.5 }), certifyFalseAlarms(fired, { y: flipped, maxRate: 0.5 }));
  const design = { inclusionProbs: y.map(() => 0.5), strata: y.map(() => 's'), stratumSizes: { s: 12 } };
  assert.equal(certifyDismissals(fired, { y, maxRate: 0.5, design }).method, 'design-linearised');
  assert.throws(() => certifyDismissals(fired, { y: y.map(() => 0 as const), maxRate: 0.5 }), /no labelled positives/);
});

test('a rule set with dismissal rules has its own format; older formats and unknown effects are refused', () => {
  const set = buildRuleSet('v1', [
    { label: 'urgent', rules: [{ id: 'r1', pattern: phrase('stolen') }] },
    { label: 'urgent', effect: 'dismiss', rules: [{ id: 'd1', pattern: phrase('balance') }] },
  ], { createdAt: '2026-10-05' });
  assert.equal(set.format, RULESET_FORMAT_DISMISS);
  assert.deepEqual(set.rules.map((r) => [r.id, r.effect]), [['urgent.r1', undefined], ['not-urgent.d1', 'dismiss']]);
  assert.throws(() => validateRuleSet({ ...set, format: RULESET_FORMAT }), /dismissal rules need format/);
  assert.throws(() => validateRuleSet({ ...set, rules: set.rules.slice(0, 1) }), /needs a dismissal rule/);
  assert.throws(() => validateRuleSet({ ...set, rules: [{ ...set.rules[1], effect: 'allow' }] }), /unknown effect/);
  const plain = buildRuleSet('v1', [{ label: 'urgent', rules: [{ id: 'r1', pattern: phrase('stolen') }] }]);
  assert.equal(plain.format, RULESET_FORMAT, 'sets without dismissal rules keep today\'s format');
});

test('matching: firing beats dismissal, match() never returns a dismissal rule, reports count them apart', () => {
  const set = buildRuleSet('v1', [
    { label: 'urgent', rules: [{ id: 'r1', pattern: phrase('stolen') }] },
    { label: 'urgent', effect: 'dismiss', rules: [{ id: 'd1', pattern: phrase('balance') }] },
    { label: 'refund', effect: 'dismiss', rules: [{ id: 'd1', pattern: phrase('balance') }] },
  ]);
  const m = ruleSetMatcher(set);
  assert.equal(m.match('what is my balance'), null);
  assert.deepEqual(m.evaluate('what is my balance'), { fired: null, dismissed: ['urgent', 'refund'] });
  assert.deepEqual(m.evaluate('my card was stolen, what is my balance'), { fired: { id: 'urgent.r1', label: 'urgent' }, dismissed: [] });
  assert.deepEqual(m.evaluate('hello'), { fired: null, dismissed: [] });
  const report = firingReport(set, ['what is my balance', 'card stolen', 'hello']);
  assert.equal(report.fired, 1);
  assert.equal(report.dismissed, 1);
  // Rule bounds and weak labels see only firing rules.
  const b = ruleBounds(set, { certification: Array.from({ length: 50 }, (_, i) => `hello ${i}`), gold: { texts: ['card stolen', 'my balance'], y: [1, 0] }, prevalence: 0.05, label: 'urgent' });
  assert.deepEqual(b.rules.map((r) => r.id), ['urgent.r1']);
});

test('jointLabels: positive if any label is, negative only if all are, else unknown; joint rules dismiss every label', () => {
  const rows = [{ a: 1, b: 0 }, { a: 0, b: 0 }, { a: 0, b: null }, { a: null, b: 1 }, { a: 0 }] as const;
  assert.deepEqual(jointLabels(rows, ['a', 'b']), [1, 0, null, 1, null]);
  assert.throws(() => jointLabels(rows, []), /at least one label/);
  const joint = [{ id: 'j1', pattern: phrase('balance') }];
  const set = buildRuleSet('v1', ['urgent', 'refund'].map((label) => ({ label, effect: 'dismiss' as const, rules: joint })));
  assert.deepEqual(ruleSetMatcher(set).evaluate('what is my balance'), { fired: null, dismissed: ['urgent', 'refund'] });
});


test('certifyPrefixes refuses hit rows that do not cover every certification text', () => {
  const full = Array.from({ length: 100 }, () => false);
  assert.throws(() => certifyPrefixes([full, [false, false]], { maxRate: 0.05 }), /fired\[1\] has 2 entries for 100/);
  assert.throws(() => certifyPrefixes([full, [...full, true]], { maxRate: 0.05 }), /fired\[1\] has 101 entries/);
  assert.throws(() => certifyPrefixes([full], { maxRate: 0 }), /maxRate/);
  assert.equal(certifyPrefixes([full, full], { maxRate: 0.05 }).certified, 2);
});
