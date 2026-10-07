import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRuleSet, LEGACY_RULESET_FORMATS, ruleSetHash, ruleSetMatcher, validateRuleSet } from '../src/index.ts';

test('an explicitly empty rule set is valid: a classifier-only router release', () => {
  const empty = buildRuleSet('none', [], { createdAt: '2026-10-07T00:00:00Z' });
  assert.deepEqual(validateRuleSet(JSON.parse(JSON.stringify(empty))).rules, []);
  assert.deepEqual(ruleSetMatcher(empty).evaluate('anything at all'), { fired: null, dismissed: [] });
  assert.match(ruleSetHash(empty), /^[0-9a-f]{64}$/);
});

test('ruleSetHash identifies semantics, not bytes: key order and whitespace are ignored, rule order is not', () => {
  const set = buildRuleSet('v1', [
    { label: 'refund', rules: [{ id: 'a', pattern: { kind: 'phrase', tokens: ['refund'] } }, { id: 'b', pattern: { kind: 'phrase', tokens: ['money', 'back'] } }] },
  ], { createdAt: '2026-10-07T00:00:00Z' });
  const reordered = JSON.parse(JSON.stringify({ rules: set.rules, created_at: set.created_at, version: set.version, format: set.format }, null, 4));
  assert.equal(ruleSetHash(validateRuleSet(reordered)), ruleSetHash(set));
  const swapped = { ...set, rules: [set.rules[1], set.rules[0]] };
  assert.notEqual(ruleSetHash(swapped), ruleSetHash(set), 'the first firing rule wins, so order is part of the semantics');
});

test('a legacy format is hashed after validation upgrades it (the router hashes the validated set)', () => {
  const set = buildRuleSet('v1', [{ label: 'x', rules: [{ id: 'a', pattern: { kind: 'phrase', tokens: ['x'] } }] }], { createdAt: '' });
  const legacy = { ...set, format: LEGACY_RULESET_FORMATS[0] };
  assert.equal(ruleSetHash(validateRuleSet(legacy)), ruleSetHash(set));
});
