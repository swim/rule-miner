import assert from 'node:assert/strict';
import { test } from 'node:test';

import { anyRule, BackgroundError, certifyPrefixes, checkBackgroundRecords, hardNegativeItems, mineExceptions, mineRules, patternKey, type RecordLike } from '../src/index.ts';

const phrase = (s: string) => ({ kind: 'phrase' as const, tokens: s.split(' ') });

test('hardNegativeItems: briefs per rule spread across registers, with a firing check', () => {
  const rules = [{ id: 'r1', pattern: phrase('close it all') }, { id: 'r2', pattern: phrase('give up') }];
  const briefs = hardNegativeItems(rules, { perRule: 5, registers: ['chat', 'email'] });
  assert.deepEqual(briefs.map((b) => [b.ruleId, b.register, b.count]), [['r1', 'chat', 3], ['r1', 'email', 2], ['r2', 'chat', 3], ['r2', 'email', 2]]);
  assert.match(briefs[0].instruction, /innocent/);
  assert.equal(briefs[0].fires('this sale will close it all out for the season'), true);
  assert.equal(briefs[0].fires('nothing to see here'), false, 'texts the rule does not fire on should be discarded');
  assert.equal(hardNegativeItems(rules).reduce((s, b) => s + b.count, 0), 40, '20 per rule by default');
});

test('mineExceptions validateOn: keeps exceptions only if they remove a real false positive and no real positive', () => {
  const base = (s: string) => /\bwant to cancel\b/.test(s);
  const rows: Array<[string, 0 | 1, string]> = [
    ['i want to cancel', 1, 'p1'], ['honestly i want to cancel tonight', 1, 'p2'], ['i really want to cancel now', 1, 'p3'],
    ['years ago i used to want to cancel', 0, 'n1'], ['back when i was 15 i used to want to cancel', 0, 'n2'],
    ['what if my son says he wants to cancel', 0, 'n3'], ['my game character will want to cancel lol', 0, 'n4'], ['in the game i want to cancel lol', 0, 'n5'],
  ];
  const input = { texts: rows.map((r) => r[0]), y: rows.map((r) => r[1]), groups: rows.map((r) => r[2]) };
  const plain = mineExceptions(input, base, { minGroups: 2 });
  assert.deepEqual(plain.exceptions.map((e) => patternKey(e.pattern)).sort(), ['i used to', 'to cancel lol']);

  // Real data: "i used to" removes a real false positive; "to cancel lol" would silence a real positive.
  const validateOn = { texts: ['i used to want to cancel as a teen', 'i want to cancel lol nobody would even notice', 'i want to cancel'], y: [0, 1, 1] as Array<0 | 1> };
  const checked = mineExceptions(input, base, { minGroups: 2, validateOn });
  assert.deepEqual(checked.exceptions.map((e) => patternKey(e.pattern)), ['i used to']);
  assert.match(checked.rejected!.find((r) => patternKey(r.pattern) === 'to cancel lol')!.reason, /silences 1 real positive/);
  assert.ok(checked.after.negatives > plain.after.negatives, 'after-counts reflect only the kept exceptions');

  const generated = { ...input, sources: input.texts.map((_, i) => ({ kind: i === 6 ? 'generated' : 'traffic' })) };
  assert.throws(() => mineExceptions(generated, base, { minGroups: 2 }), /pass validateOn/);
  assert.doesNotThrow(() => mineExceptions(generated, base, { minGroups: 2, validateOn }));
});

test('background records: P2 and P3 checked by mineRules and certifyPrefixes', () => {
  const bg = (id: string, use: 'veto' | 'certify', extra: Partial<RecordLike> = {}): RecordLike => ({ id, text: `ordinary text ${id}`, group: id, role: 'background', backgroundUse: use, source: { kind: 'traffic' }, labels: {}, ...extra });
  const veto = [bg('v1', 'veto'), bg('v2', 'veto')];
  const certify = [bg('c1', 'certify'), bg('c2', 'certify')];
  assert.doesNotThrow(() => checkBackgroundRecords([...veto, ...certify], ['veto', 'certify']));
  const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return e instanceof BackgroundError ? e.code : String(e); } };
  assert.equal(code(() => checkBackgroundRecords([...veto, bg('c3', 'certify', { group: 'v1' })], ['veto', 'certify'])), 'P3', 'one group in two uses');
  assert.equal(code(() => checkBackgroundRecords([bg('x', 'veto', { labels: { h: 0 } })], ['veto'])), 'P2');
  assert.equal(code(() => checkBackgroundRecords([bg('x', 'veto', { source: { kind: 'generated' } })], ['veto'])), 'P2');
  assert.equal(code(() => checkBackgroundRecords([bg('x', 'certify')], ['veto'])), 'P2', 'wrong use');

  const texts = ['i want to cancel', 'i want to cancel tonight', 'i really want to cancel', 'nice weather', 'great game'];
  const y = [1, 1, 1, 0, 0] as Array<0 | 1>;
  const withTexts = mineRules({ texts, y, background: veto.map((r) => r.text) }, { minGroups: 2 });
  assert.deepEqual(mineRules({ texts, y, backgroundRecords: veto }, { minGroups: 2 }), withTexts, 'records give the same rules as their texts');
  assert.equal(code(() => mineRules({ texts, y, backgroundRecords: certify }, { minGroups: 2 })), 'P2', 'a certify background cannot veto');
  assert.throws(() => mineRules({ texts, y, background: [], backgroundRecords: veto }), /not both/);

  const fired = [anyRule(withTexts, certify.map((r) => r.text))];
  assert.doesNotThrow(() => certifyPrefixes(fired, { maxRate: 0.5, records: certify }));
  assert.equal(code(() => certifyPrefixes(fired, { maxRate: 0.5, records: veto })), 'P2');
  assert.throws(() => certifyPrefixes(fired, { maxRate: 0.5, records: certify.slice(0, 1) }), /1 entries for 2/);
});
