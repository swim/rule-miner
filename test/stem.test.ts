import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { porterStem } from '../src/stem.ts';

test('porterStem reproduces the stemmer package (Porter 1980) on 5,019 words from the benchmarks', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/porter-golden.json', import.meta.url), 'utf8')) as Record<string, string>;
  const mismatches = Object.entries(golden).filter(([word, stem]) => porterStem(word) !== stem);
  assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} mismatches`);
  assert.equal(porterStem('refunded'), 'refund');
  assert.equal(porterStem('refunding'), 'refund');
});

test('porterStem leaves non-words and very long tokens alone, in linear time', () => {
  assert.equal(porterStem('abc123'), 'abc123', 'digits: not a plain word');
  assert.equal(porterStem('under_score'), 'under_score');
  const long = 'ab'.repeat(30);
  assert.equal(porterStem(long), long, 'over 40 characters');
  const t = Date.now();
  for (let i = 0; i < 1000; i++) porterStem('baba'.repeat(10));
  assert.ok(Date.now() - t < 1000, 'bounded work per token');
});

import { buildRuleSet, mineRules, RULESET_FORMAT, RULESET_FORMAT_STEMMED, ruleSetMatcher, tokenize, validateRuleSet, type Lexicon } from '../src/index.ts';

test('a stemming lexicon: mining and matching both see stems, so a rule catches unseen inflections', () => {
  const lexicon: Lexicon = { stem: 'porter-en' };
  assert.deepEqual(tokenize('Refunded twice, still refunding', lexicon), ['refund', 'twice', 'still', 'refund']);
  const texts = ['I want my refund', 'refunded yet?', 'where is the refunding', 'my refund is late', 'card arrived', 'new card please', 'change my address', 'card not working'];
  const y = [1, 1, 1, 1, 0, 0, 0, 0] as const;
  const rules = mineRules({ texts, y: [...y] }, { minGroups: 3, lexicon });
  assert.ok(rules.some((r) => r.pattern.kind === 'phrase' && r.pattern.tokens.join(' ') === 'refund'), JSON.stringify(rules.map((r) => r.pattern)));
  const set = buildRuleSet('v1', [{ label: 'refund', rules }], { lexicon, createdAt: '2026-10-05T00:00:00Z' });
  assert.equal(set.format, RULESET_FORMAT_STEMMED);
  const matcher = ruleSetMatcher(validateRuleSet(JSON.parse(JSON.stringify(set))));
  assert.equal(matcher.match('Have the refunds gone through?')?.label, 'refund');
  // Without the lexicon the same text wouldn't match a rule mined on "refund" alone.
  const plain = buildRuleSet('v1', [{ label: 'refund', rules }], { createdAt: '2026-10-05T00:00:00Z' });
  assert.equal(plain.format, RULESET_FORMAT);
  assert.equal(ruleSetMatcher(plain).match('Have the refunds gone through?'), null);
});

test('the stemmed format and the lexicon must agree; classes still match after stemming', () => {
  const lexicon: Lexicon = { stem: 'porter-en', classes: { pay: ['payment', 'paid'] } };
  assert.deepEqual(tokenize('two payments were paid', lexicon), ['two', '<pay>', 'were', '<pay>']);
  const set = buildRuleSet('v1', [{ label: 'x', rules: [{ id: 'r1', pattern: { kind: 'phrase', tokens: ['<pay>'] } }] }], { lexicon, createdAt: '2026-10-05T00:00:00Z' });
  assert.equal(ruleSetMatcher(set).match('Payments missing')?.id, 'x.r1');
  assert.throws(() => validateRuleSet({ ...set, format: RULESET_FORMAT }), /a stemming lexicon needs format liquidau-rule-miner\/3/);
  const { stem: _stem, ...noStem } = lexicon;
  assert.throws(() => validateRuleSet({ ...set, lexicon: noStem }), /needs a stemming lexicon/);
  assert.throws(() => validateRuleSet({ ...set, lexicon: { ...lexicon, stem: 'snowball' } }), /lexicon.stem must be 'porter-en'/);
  // Members of different classes that stem alike are ambiguous.
  assert.throws(() => tokenize('x', { stem: 'porter-en', classes: { a: ['organise'], b: ['organisation'] } }), /share the stem/);
});
