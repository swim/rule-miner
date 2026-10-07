import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRuleSet, firingReport, hitMatrix, ruleSetMatcher, type MatchEvidence, type RuleSet } from '../src/index.ts';

const set = (rules: Parameters<typeof buildRuleSet>[1], lexicon?: RuleSet['lexicon']) => buildRuleSet('v', rules, { createdAt: '', ...(lexicon ? { lexicon } : {}) });
const spans = (text: string, e: MatchEvidence) => e.hits.map((h) => ({ rule: h.ruleId, scopes: h.scopes.map((s) => ({ scope: text.slice(s.scope.start, s.scope.end), matches: s.matches.map((m) => text.slice(m.span.start, m.span.end)) })) }));

const basic = set([
  { label: 'refund', rules: [{ id: 'r1', pattern: { kind: 'phrase', tokens: ['refund', 'please'] }, except: [{ kind: 'phrase', tokens: ['no', 'refund'] }] }] },
  { label: 'billing', rules: [{ id: 'b1', pattern: { kind: 'all', phrases: [['charged'], ['two', 'times']] } }] },
  { label: 'refund', effect: 'dismiss', rules: [{ id: 'd1', pattern: { kind: 'phrase', tokens: ['thanks'] } }] },
  { label: 'billing', effect: 'dismiss', rules: [{ id: 'd2', pattern: { kind: 'phrase', tokens: ['thanks'] } }] },
]);

test('decisions are exactly evaluate(); evidence maps matches back to original characters', () => {
  const m = ruleSetMatcher(basic);
  const texts = ['Hello there. I want a REFUND, please!', 'I was charged two times; awful', 'thanks a lot', 'thanks. Refund please', 'nothing here', '', '🙂\uD800 refund please'];
  for (const t of texts) {
    const e = m.evaluateWithEvidence(t, { documentId: 'doc-1' });
    assert.deepEqual({ fired: e.fired, dismissed: e.dismissed }, m.evaluate(t), t);
    assert.equal(e.documentId, 'doc-1');
  }
  const t = 'Hello there. I want a REFUND, please!';
  assert.deepEqual(spans(t, m.evaluateWithEvidence(t)), [{ rule: 'refund.r1', scopes: [{ scope: 'I want a REFUND, please', matches: ['REFUND, please'] }] }]);
  const c = 'I was charged, er, two  Times; awful';
  assert.deepEqual(spans(c, m.evaluateWithEvidence(c)), [{ rule: 'billing.b1', scopes: [{ scope: 'I was charged, er, two  Times', matches: ['charged', 'two  Times'] }] }], 'conjunctions list every supporting phrase');
});

test('NFKC before splitting: full-width punctuation splits scopes and spans cover the original code points', () => {
  const m = ruleSetMatcher(basic);
  const t = 'ＲＥＦＵＮＤ　ｐｌｅａｓｅ；next part';
  const e = m.evaluateWithEvidence(t);
  assert.equal(e.provenance, 'exact-token');
  assert.deepEqual(spans(t, e), [{ rule: 'refund.r1', scopes: [{ scope: 'ＲＥＦＵＮＤ　ｐｌｅａｓｅ', matches: ['ＲＥＦＵＮＤ　ｐｌｅａｓｅ'] }] }]);
  const marks = 'café refund please';
  const em = m.evaluateWithEvidence(marks);
  assert.equal(marks.slice(em.hits[0].scopes[0].scope.start, em.hits[0].scopes[0].scope.end), marks, 'the combining mark stays with its base');
});

test('replacements, stemming and classes keep the many-to-one relationship to source tokens', () => {
  const lex = set([{ label: 'cancel', rules: [{ id: 'c', pattern: { kind: 'phrase', tokens: ['want', 'to', 'cancel'] } }] }], { replacements: { wanna: 'want to' }, stem: 'porter-en' });
  const t = 'I WANNA cancelled it';
  const e = ruleSetMatcher(lex).evaluateWithEvidence(t);
  assert.ok(e.fired);
  assert.deepEqual(spans(t, e)[0].scopes[0].matches, ['WANNA cancelled'], 'two canonical tokens from one source token, a stem from an inflected one');
  const cls = set([{ label: 'late', rules: [{ id: 'l', pattern: { kind: 'phrase', tokens: ['<late>', 'order'] } }] }], { classes: { late: ['late', 'delayed'] } });
  const d = 'My DELAYED order';
  assert.deepEqual(spans(d, ruleSetMatcher(cls).evaluateWithEvidence(d))[0].scopes[0].matches, ['DELAYED order']);
});

test('exceptions are attached to the scope they suppress; dismissal evidence covers the whole input', () => {
  const m = ruleSetMatcher(basic);
  const t = 'No refund please, said nobody. Refund please now';
  const e = m.evaluateWithEvidence(t);
  const hit = e.hits[0];
  assert.deepEqual(hit.scopes.map((s) => t.slice(s.scope.start, s.scope.end)), ['Refund please now']);
  assert.equal(hit.suppressed.length, 1);
  assert.equal(t.slice(hit.suppressed[0].scope.start, hit.suppressed[0].scope.end), 'No refund please, said nobody');
  assert.deepEqual(hit.suppressed[0].exceptionMatches.map((x) => t.slice(x.span.start, x.span.end)), ['No refund']);

  const dismissed = m.evaluateWithEvidence('Thanks! all good');
  assert.deepEqual(dismissed.dismissed.sort(), ['billing', 'refund']);
  assert.deepEqual(dismissed.hits.map((h) => [h.ruleId, h.effect]), [['not-refund.d1', 'dismiss'], ['not-billing.d2', 'dismiss']]);
  // Firing beats dismissal across the whole parent input: no dismissal evidence is reported.
  const both = m.evaluateWithEvidence('thanks. Refund please');
  assert.deepEqual([both.fired?.id, both.dismissed, both.hits.map((h) => h.effect)], ['refund.r1', [], ['fire']]);
});

test('context-dependent normalisation: clusters grow to stay exact, and unverifiable mappings are reported unavailable', () => {
  const greek = set([{ label: 'road', rules: [{ id: 'g', pattern: { kind: 'phrase', tokens: ['οδος'] } }] }]);
  const m = ruleSetMatcher(greek);
  const word = 'ΟΔΟΣ ahead';
  const exact = m.evaluateWithEvidence(word);
  assert.equal(exact.provenance, 'exact-token', 'the final sigma joins its word into one cluster');
  assert.equal(word.slice(exact.hits[0].scopes[0].matches[0].span.start, exact.hits[0].scopes[0].matches[0].span.end), 'ΟΔΟΣ');

  const t = 'Σ\u0301Σ οδος';
  const e = m.evaluateWithEvidence(t);
  assert.deepEqual({ fired: e.fired, dismissed: e.dismissed }, m.evaluate(t), 'the decision is unaffected');
  assert.equal(e.provenance, 'unavailable');
  assert.match(e.reason!, /context-dependent/);
  assert.ok(e.hits.length === 1 && e.hits.every((h) => h.precision === 'unavailable' && h.scopes.length === 0));
});

test('repeated matches within one document still count as one document hit', () => {
  const t = 'Refund please. Refund please! refund please';
  const e = ruleSetMatcher(basic).evaluateWithEvidence(t);
  assert.equal(e.hits[0].scopes.length, 3);
  assert.deepEqual(hitMatrix(basic.rules, [t], basic.lexicon)[0], [true]);
  assert.equal(firingReport(basic, [t]).rules[0].fired, 1);
});

test('context windows widen scopes for display only, clamped and never splitting a surrogate pair', () => {
  const m = ruleSetMatcher(basic);
  const t = 'Intro 🙂 text. Refund please. Outro';
  const plain = m.evaluateWithEvidence(t);
  const e = m.evaluateWithEvidence(t, { contextChars: 7 });
  assert.deepEqual({ fired: e.fired, dismissed: e.dismissed }, { fired: plain.fired, dismissed: plain.dismissed });
  const sc = e.hits[0].scopes[0];
  assert.equal(t.slice(sc.scope.start, sc.scope.end), 'Refund please');
  assert.equal(t.slice(sc.context!.start, sc.context!.end), ' text. Refund please. Outro');
  const edgeText = 'ab🙂. refund please';
  const edge = m.evaluateWithEvidence(edgeText, { contextChars: 3 });
  assert.deepEqual(edge.hits[0].scopes[0].scope, { start: 6, end: 19 });
  assert.deepEqual(edge.hits[0].scopes[0].context, { start: 2, end: 19 }, 'moved outward off the middle of the emoji (6 - 3 = 3 would split it)');
  assert.equal(plain.hits[0].scopes[0].context, undefined);
  assert.throws(() => m.evaluateWithEvidence(t, { contextChars: -1 }), /contextChars/);
});
