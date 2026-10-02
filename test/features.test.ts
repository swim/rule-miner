import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRuleSet,
  certifyPrefixes,
  diffRuleSets,
  firingReport,
  induceClasses,
  mineExceptions,
  patternKey,
  precisionLowerBound,
  exceptionStressItems,
  ruleStressItems,
  stressTest,
  withExceptions,
} from '../src/index.ts';

test('exceptions: learned from the rule\'s false positives, scoped to the sentence it fired in', () => {
  const base = (s: string) => /\bwant to die\b/.test(s);
  const rows: Array<[string, 0 | 1, string]> = [
    ['i want to die', 1, 'p1'], ['honestly i want to die tonight', 1, 'p2'],
    ['years ago i used to want to die', 0, 'n1'], ['back when i was 15 i would want to die', 0, 'n2'],
    ['years ago I felt I want to die. Tonight I want to die again', 1, 'p3'],
    ['what if my son says he wants to die', 0, 'n3'],
  ];
  const input = { texts: rows.map((r) => r[0]), y: rows.map((r) => r[1]), groups: rows.map((r) => r[2]), background: ['in the past people used to want to die of boredom here'] };
  const result = mineExceptions(input, base, { minGroups: 2 });
  assert.deepEqual(result.exceptions.map((e) => patternKey(e.pattern)), ['to want to'], 'the longest (narrowest) exception wins a tie');
  assert.deepEqual(result.before, { positives: 3, negatives: 2, background: 1 });
  assert.deepEqual(result.after, { positives: 3, negatives: 1, background: 0 });
  const fires = withExceptions(base, result.exceptions.map((e) => e.pattern));
  assert.equal(fires('years ago i used to want to die'), false);
  assert.equal(fires('I used to want to die. Now i want to die again'), true, 'another sentence still fires');
  // An exception may not cover most of the rule's firing sentences: here the rule fires mostly on
  // background text about "suicidal ideation" - as an exception it would lose no training positive,
  // yet silence "my son has suicidal ideation".
  const topical = {
    texts: ['my son is suicidal', 'my daughter is suicidal right now', 'my kid seems suicidal'], y: [1, 1, 1] as (0 | 1)[], groups: ['a', 'b', 'c'],
    background: Array.from({ length: 6 }, (_, i) => `suicidal ideation in adolescents, chapter ${i}`),
  };
  const suicidal = (s: string) => /\bsuicidal\b/.test(s);
  assert.ok(mineExceptions(topical, suicidal, { minGroups: 2, maxShare: 1 }).exceptions.some((e) => patternKey(e.pattern).includes('ideation')), 'unguarded, the topic becomes an exception');
  assert.deepEqual(mineExceptions(topical, suicidal, { minGroups: 2 }).exceptions.filter((e) => patternKey(e.pattern).includes('ideation')), [], 'guarded (default 0.5), it cannot');
  // When the base reports what it matched, exceptions can't reuse the trigger's words.
  const selfHarm = {
    texts: ['my son is cutting himself', 'my daughter keeps cutting herself', 'my kid is cutting again tonight', 'my son had self harm issues years ago', 'my girl self-harmed back in year 8'],
    y: [1, 1, 1, 0, 0] as (0 | 1)[], groups: ['a', 'b', 'c', 'd', 'e'],
  };
  const trigger = (s: string) => /\bself.?harm\w*|\bcutting\b/.exec(s)?.[0] ?? false;
  const boolOnly = (s: string) => !!trigger(s);
  assert.ok(mineExceptions(selfHarm, boolOnly, { minGroups: 2 }).exceptions.some((e) => patternKey(e.pattern).includes('self')), 'a boolean base can\'t see the trigger');
  assert.ok(!mineExceptions(selfHarm, trigger, { minGroups: 2 }).exceptions.some((e) => patternKey(e.pattern).includes('self') || patternKey(e.pattern).includes('harm')), 'a reported match is guarded');
  // No positive evidence, no exceptions: with nothing to lose, every exception looks free.
  const noEvidence = mineExceptions({ ...input, y: input.y.map((v) => (v === 1 ? 0 : v)) as (0 | 1)[] }, base, { minGroups: 2 });
  assert.deepEqual(noEvidence.exceptions, []);
  assert.match(noEvidence.skipped!, /0 positive group/);
  // An exception that would cost a positive group is refused.
  assert.deepEqual(mineExceptions(input, base, { minGroups: 1, maxLostGroups: 0 }).exceptions.every((e) => e.stats.lost_groups === 0), true);
});

test('certification: exact bounds, fixed-sequence stop at the first failure', () => {
  const n = 3000;
  const row = (hits: number) => Array.from({ length: n }, (_, i) => i < hits);
  const c = certifyPrefixes([row(0), row(0), row(4), row(0)], { maxRate: 0.002 });
  assert.equal(c.rows[0].rate_upper.toFixed(6), (1 - 0.05 ** (1 / n)).toFixed(6)); // 0.000998
  assert.equal(c.certified, 2);
  assert.equal(c.rows[3].passed, false, 'nothing after the first failure is certified');
  assert.equal(c.rows[2].hits, 4);
  assert.ok(Math.abs(precisionLowerBound(0.01, 0.5, 0.001) - 0.005 / (0.005 + 0.00099)) < 1e-12);
});

test('stress test: rules fail on ordinary texts they fire on, exceptions on positives they silence', async () => {
  const rules = [
    { id: 'r1', pattern: { kind: 'phrase' as const, tokens: ["i'm", 'planning', 'to'] } },
    { id: 'r2', pattern: { kind: 'phrase' as const, tokens: ['the', 'rope'] } },
  ];
  const results = await stressTest(ruleStressItems(rules), async (item) =>
    item.description === "i'm planning to" ? ["I'm planning to bake a cake", 'We are planning a trip'] : ['skipping with a rope at school']);
  assert.deepEqual(results.map((r) => [r.id, r.hits.length, r.status]), [['r1', 1, 'failed'], ['r2', 0, 'inconclusive']], 'one counterexample is not evidence');
  const enough = await stressTest(ruleStressItems(rules), async () => Array.from({ length: 10 }, (_, i) => `ordinary message ${i}`));
  assert.deepEqual(enough.map((r) => r.status), ['passed', 'passed']);
  const silent = await stressTest(ruleStressItems(rules), async () => []);
  assert.deepEqual(silent.map((r) => r.passed), [false, false], 'an adversary that produced nothing passes nothing');
  assert.equal(results[0].generated, 2);
  const flaky = await stressTest(ruleStressItems(rules), async (item) => { if (item.id === 'r1') throw new Error('adversary down'); return Array.from({ length: 10 }, () => 'ordinary'); }, { concurrency: 1 });
  assert.deepEqual(flaky.map((r) => [r.status, r.error]), [['inconclusive', 'adversary down'], ['passed', undefined]], 'one failing item does not lose the others');

  const base = (s: string) => /\bself.?harm/.test(s);
  const items = exceptionStressItems('other.self_harm', base, [{ kind: 'phrase', tokens: ['self', 'harm'] }, { kind: 'phrase', tokens: ['years', 'ago'] }]);
  const positives = ['my daughter has started to self harm', 'she self-harmed last night and again today'];
  const verdicts = await stressTest(items, async () => positives, { minGenerated: 2 });
  assert.deepEqual(verdicts.map((v) => [v.description, v.passed]), [['self harm', false], ['years ago', true]]);
});

test('class induction: mutual neighbours above a threshold, size-capped, named by first member', () => {
  const v = (x: number, y: number) => [x, y];
  const classes = induceClasses(['better', 'happier', 'easier', 'sad', 'table'], [v(1, 0.1), v(1, 0.15), v(1, 0.2), v(0.1, 1), v(-1, 0)], { minSimilarity: 0.95, maxClassSize: 3 });
  assert.deepEqual(classes, { better: ['better', 'happier', 'easier'] });
  assert.deepEqual(induceClasses(['a', 'b', 'c'], [v(1, 0), v(1, 0.01), v(1, 0.05)], { minSimilarity: 0.9, maxClassSize: 2 }), { a: ['a', 'b'] }, 'cap stops chaining');
  const collide = induceClasses(['co-op', 'coop', 'co_op', 'cooperative'], [v(1, 0), v(1, 0.01), v(0, 1), v(0, 1.01)], { minSimilarity: 0.9 });
  assert.deepEqual(collide, { co_op: ['co-op', 'coop'], co_op_2: ['co_op', 'cooperative'] }, 'a name collision does not drop a class');
});

test('governance: firing report and rule-set diff', () => {
  const rule = (id: string, tokens: string[]) => ({ id, pattern: { kind: 'phrase' as const, tokens } });
  const a = buildRuleSet('a', [{ label: 'x', rules: [rule('r1', ['full', 'refund']), rule('r2', ['chargeback'])] }]);
  const b = buildRuleSet('b', [{ label: 'x', rules: [rule('r1', ['full', 'refund']), rule('r2', ['ombudsman'])] }]);
  const texts = ['full refund now', 'chargeback!', 'calling the ombudsman', 'hello'];
  const report = firingReport(a, texts);
  assert.deepEqual([report.fired, report.rules.map((r) => r.fired)], [2, [1, 1]]);
  const diff = diffRuleSets(a, b, texts);
  assert.deepEqual(diff.added, ['x.r2']);
  assert.deepEqual(diff.removed, ['x.r2']);
  assert.deepEqual(diff.changed, [{ text: 'chargeback!', before: 'x', after: null }, { text: 'calling the ombudsman', before: null, after: 'x' }]);
});
