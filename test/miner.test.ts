import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anyRule,
  buildRuleSet,
  canonicalSegments,
  checkConsistency,
  evaluateFired,
  mineRules,
  normalize,
  patternKey,
  regexSources,
  ruleSetMatcher,
  tokenize,
  validateRules,
  validateRuleSet,
  type MinedRule,
} from '../src/index.ts';

const keys = (rules: MinedRule[]) => rules.map((r) => patternKey(r.pattern));

test('canonical text: Unicode, curly apostrophes, sentences, lexicon', () => {
  assert.equal(normalize('Zoë Can’t SLEEP'), "zoë can't sleep");
  assert.deepEqual(tokenize('Zoë can’t sleep, ever!!'), ['zoë', "can't", 'sleep', 'ever']);
  assert.deepEqual(tokenize('ｆｕｌｌ width'), ['full', 'width'], 'NFKC folds compatibility characters');
  assert.deepEqual(canonicalSegments('I want a REFUND. Now!'), ['i want a refund', 'now']);
  const lexicon = { replacements: { wanna: 'want to' }, classes: { want: ['want', 'need'] } };
  assert.deepEqual(canonicalSegments('I wanna refund; I NEED it', lexicon), ['i <want> to refund', 'i <want> it']);
  assert.throws(() => canonicalSegments('x', { classes: { a: ['x'], b: ['x'] } }), /both a and b/);
});

/** Tickets: positives are "angry customer wants refund"; each seed has paraphrases (one group). */
function corpus() {
  const rows: Array<[string, 0 | 1, string]> = [];
  const pos = (g: string, ...texts: string[]) => texts.forEach((t) => rows.push([t, 1, g]));
  const neg = (g: string, ...texts: string[]) => texts.forEach((t) => rows.push([t, 0, g]));
  pos('p1', 'I demand a full refund today', 'Give me a full refund now', 'full refund please, this is a joke');
  pos('p2', 'This is unacceptable, full refund', 'full refund or I go to the ombudsman');
  pos('p3', 'I want a full refund for this rubbish');
  pos('p4', 'chargeback incoming, worst service ever');
  pos('p5', 'filing a chargeback with my bank');
  pos('p6', 'I will do a chargeback if not fixed');
  pos('p7', 'the zebra stripes are wrong', 'zebra stripes wrong again', 'zebra stripes!!'); // one seed's quirk
  neg('n1', 'how do I update my address');
  neg('n2', 'what is your refund policy for gifts');
  neg('n3', 'can I get a receipt please');
  neg('n4', 'the app is great, thanks');
  neg('n5', 'is a partial refund possible for late delivery');
  return { texts: rows.map((r) => r[0]), y: rows.map((r) => r[1]), groups: rows.map((r) => r[2]) };
}

test('mining: group support, precision, stopwords, covering and tie-breaks', () => {
  const rules = mineRules(corpus(), { minGroups: 3, conjunctions: false });
  assert.deepEqual(keys(rules), ['full refund', 'chargeback']);
  assert.ok(!keys(rules).some((k) => k.includes('zebra')), 'one seed and its paraphrases are not enough support');
  assert.equal(rules[0].stats.gain, 3, 'each group contributes weight 1 however many paraphrases it has');
  assert.deepEqual(keys(mineRules(corpus(), { minGroups: 3, conjunctions: false, prefer: 'general' })), ['chargeback', 'full']);
  assert.deepEqual(mineRules(corpus(), { minGroups: 2 }), mineRules(corpus(), { minGroups: 2 }), 'deterministic');
});

test('mining: the background corpus vetoes rules that fire on ordinary text', () => {
  const background = ['my friend did a chargeback once, it was easy', 'what a nice day'];
  assert.deepEqual(keys(mineRules({ ...corpus(), background }, { minGroups: 3, conjunctions: false })), ['full refund']);
  assert.deepEqual(keys(mineRules({ ...corpus(), background }, { minGroups: 3, conjunctions: false, maxBackgroundRate: 0.5 })), ['full refund', 'chargeback']);
});

test('mining: author support - one writer\'s habit is not a rule', () => {
  const c = corpus();
  const authors = c.groups.map((g) => (g === 'p4' || g === 'p5' || g === 'p6' ? 'alice' : 'bob'));
  assert.deepEqual(keys(mineRules({ ...c, authors }, { minGroups: 3, conjunctions: false })), ['full refund', 'chargeback']);
  assert.deepEqual(keys(mineRules({ ...c, authors }, { minGroups: 3, conjunctions: false, minAuthors: 2 })), [], 'each rule is supported by one author only');
  const mixed = c.groups.map((g) => (g === 'p1' || g === 'p4' ? 'alice' : 'bob'));
  assert.deepEqual(keys(mineRules({ ...c, authors: mixed }, { minGroups: 3, conjunctions: false, minAuthors: 2 })), ['full refund', 'chargeback']);
});

test('mining: conjunctions must co-occur in one sentence and rescue words too noisy alone', () => {
  const rows: Array<[string, 0 | 1, string]> = [
    ['package arrived broken, refund me', 1, 'a'], ['broken on arrival, need a refund', 1, 'b'], ['it is broken and i want a refund', 1, 'c'],
    ['refund policy?', 0, 'd'], ['my old phone is broken, which model should I buy', 0, 'e'],
  ];
  const input = { texts: rows.map((r) => r[0]), y: rows.map((r) => r[1]), groups: rows.map((r) => r[2]) };
  const rules = mineRules(input, { minGroups: 3 });
  assert.deepEqual(keys(rules), ['broken & refund']);
  assert.equal(anyRule(rules, ['It is broken. Refund policy?'])[0], false, 'parts in different sentences');
  assert.deepEqual(checkConsistency(rules, input.texts), []);
});

test('mining: reviewed rules - accepted kept first and counted, rejected never proposed', () => {
  const accepted = [{ kind: 'phrase' as const, tokens: ['chargeback'] }];
  const rules = mineRules(corpus(), { minGroups: 3, conjunctions: false, accepted, rejected: ['full refund'] });
  assert.equal(rules[0].id, 'a1');
  assert.ok(!keys(rules).includes('full refund'));
  assert.ok(!keys(rules).some((k, i) => i > 0 && k === 'chargeback'), 'an accepted rule is not mined again');
});

test('mining: a lexicon generalises rules across synonyms and slang', () => {
  const rows: Array<[string, 0 | 1, string]> = [
    ['i want my money back', 1, 'a'], ['i need my money back', 1, 'b'], ['wanna get my money back', 1, 'c'], ['how do refunds work', 0, 'd'],
  ];
  const input = { texts: rows.map((r) => r[0]), y: rows.map((r) => r[1]), groups: rows.map((r) => r[2]) };
  assert.deepEqual(keys(mineRules(input, { minGroups: 3, conjunctions: false })), ['my money back']);
  const lexicon = { replacements: { wanna: 'want to' }, classes: { want: ['want', 'need'] } };
  const rules = mineRules(input, { minGroups: 3, conjunctions: false, lexicon, maxN: 2 });
  assert.deepEqual(keys(rules), ['money back']);
  const general = mineRules({ ...input, texts: ['i want it', 'i need it', 'wanna have it', 'what is it'] }, { minGroups: 3, conjunctions: false, lexicon, stopwords: new Set() });
  assert.ok(keys(general).includes('i <want>') || keys(general).includes('<want>'), keys(general).join(','));
});

test('validation drops rules that fire on held-out negatives; evaluation counts through the regexes', () => {
  const rules = mineRules(corpus(), { minGroups: 3, conjunctions: false });
  const heldOut = ['full refund is what I want', 'do you offer a full refund on sale items?', 'chargeback filed'];
  const { kept, dropped } = validateRules(rules, heldOut, [1, 0, 1]);
  assert.deepEqual(keys(kept), ['chargeback']);
  assert.equal(dropped[0].false_positives.length, 1);
  const e = evaluateFired(anyRule(kept, heldOut), [1, 0, 1]);
  assert.deepEqual([e.caught, e.positives, e.false_alarms, e.negatives], [1, 2, 0, 1]);
  assert.deepEqual(checkConsistency(rules, corpus().texts), []);
});

test('rule sets: round trip with lexicon and exceptions; tampering rejected', () => {
  const lexicon = { classes: { refund: ['refund', 'reimbursement'] } };
  const rules = mineRules(corpus(), { minGroups: 3, conjunctions: false, lexicon });
  const set = validateRuleSet(JSON.parse(JSON.stringify(buildRuleSet('v1', [{ label: 'escalate', rules: rules.map((r, i) => (i === 0 ? { ...r, except: [{ kind: 'phrase', tokens: ['joke'] }] } : r)) }], { lexicon }))));
  const matcher = ruleSetMatcher(set);
  assert.deepEqual(matcher.match('A FULL REIMBURSEMENT, now'), { id: 'escalate.r1', label: 'escalate' });
  assert.equal(matcher.match('full refund, what a joke'), null, 'exception in the same sentence');
  assert.ok(matcher.match('what a joke. full refund now'), 'exception in another sentence does not suppress');
  const tampered = structuredClone(set);
  tampered.rules[0].regex = ['(a+)+$'];
  assert.throws(() => validateRuleSet(tampered), /regex does not match/);
  const legacy = validateRuleSet({ ...JSON.parse(JSON.stringify(set)), format: 'calibrated-rule-miner/2' });
  assert.equal(legacy.format, 'liquidau-rule-miner/2', 'a rule set saved under the old package name still loads, upgraded');
  for (const format of ['liquid-rule-miner/2', 'miws-rule-miner/2']) assert.equal(validateRuleSet({ ...JSON.parse(JSON.stringify(set)), format }).format, 'liquidau-rule-miner/2');
  assert.deepEqual(ruleSetMatcher(legacy).match('A FULL REIMBURSEMENT, now'), { id: 'escalate.r1', label: 'escalate' });
  assert.throws(() => validateRuleSet({ ...set, format: 'other-rule-miner/2' }), /not a rule set/);
  const unknownClass = structuredClone(set);
  unknownClass.rules[0].pattern = { kind: 'phrase', tokens: ['<nope>'] };
  assert.throws(() => validateRuleSet(unknownClass), /invalid pattern/);
});

test('compiled rules run in linear time on adversarial input', () => {
  const rules = mineRules(corpus(), { minGroups: 2 });
  const evil = 'full '.repeat(50000) + 'x' + '!'.repeat(20000);
  const started = performance.now();
  anyRule(rules, [evil]);
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
});

test('canonical text: combining marks stay inside tokens (Devanagari, Arabic, Thai, Turkish İ)', () => {
  assert.deepEqual(tokenize('मैं हिंदी बोलता हूँ'), ['मैं', 'हिंदी', 'बोलता', 'हूँ']);
  assert.deepEqual(tokenize('مَرْحَبًا'), ['مَرْحَبًا']);
  assert.deepEqual(tokenize('สวัสดี'), ['สวัสดี']);
  assert.deepEqual(tokenize('İstanbul'), ['i̇stanbul']);
  const rules = mineRules({ texts: ['मुझे हिंदी चाहिए', 'हिंदी में बोलो', 'हिंदी सीखना है', 'नमस्ते दोस्त'], y: [1, 1, 1, 0], groups: ['a', 'b', 'c', 'd'] }, { minGroups: 3, conjunctions: false });
  assert.deepEqual(keys(rules), ['हिंदी']);
  assert.deepEqual(checkConsistency(rules, ['हिंदी में बोलो']), []);
});

test('lexicon: keys and members must be canonical tokens, or they could never match', () => {
  assert.throws(() => canonicalSegments('x', { classes: { want: ['Want'] } }), /not canonical/);
  assert.throws(() => canonicalSegments('x', { replacements: { Wanna: 'want to' } }), /not canonical/);
  assert.throws(() => validateRuleSet({ format: 'liquidau-rule-miner/2', version: 'v', rules: [], lexicon: 'nope' }), /must be an object/);
});

test('mining: input validation - mismatched lengths and minAuthors without authors throw', () => {
  const c = corpus();
  assert.throws(() => mineRules({ ...c, y: c.y.slice(1) }, { minGroups: 3 }), /y has/);
  assert.throws(() => mineRules({ ...c, groups: c.groups.slice(1) }, { minGroups: 3 }), /groups has/);
  assert.throws(() => mineRules({ ...c, authors: ['a'] }, { minGroups: 3 }), /authors has/);
  assert.throws(() => mineRules(c, { minGroups: 3, minAuthors: 2 }), /requires input.authors/);
});

test('patterns: conjunction keys are order-independent, so reviews in either order apply', () => {
  assert.equal(patternKey({ kind: 'all', phrases: [['refund'], ['broken']] }), 'broken & refund');
  const rows: Array<[string, 0 | 1, string]> = [
    ['package arrived broken, refund me', 1, 'a'], ['broken on arrival, need a refund', 1, 'b'], ['it is broken and i want a refund', 1, 'c'],
    ['refund policy?', 0, 'd'], ['my old phone is broken, which model should I buy', 0, 'e'],
  ];
  const input = { texts: rows.map((r) => r[0]), y: rows.map((r) => r[1]), groups: rows.map((r) => r[2]) };
  assert.deepEqual(keys(mineRules(input, { minGroups: 3, rejected: ['refund & broken'] })), []);
  const accepted = [{ kind: 'all' as const, phrases: [['refund'], ['broken']] }];
  assert.deepEqual(mineRules(input, { minGroups: 3, minGain: 0, accepted }).map((r) => r.id), ['a1'], 'not mined a second time in the other order');
});

test('rule sets: structural validation - duplicate conjunction phrases, self-excepting rules', () => {
  const rule = (pattern: unknown, except?: unknown) => ({ label: 'x', rules: [{ id: 'r1', pattern: pattern as never, except: except as never }] });
  assert.throws(() => buildRuleSet('v', [rule({ kind: 'all', phrases: [['a'], ['a']] })]), /invalid pattern/);
  assert.throws(() => buildRuleSet('v', [rule({ kind: 'phrase', tokens: ['refund'] }, [{ kind: 'phrase', tokens: ['refund'] }])]), /would never let it fire/);
  const raw = buildRuleSet('v', [rule({ kind: 'phrase', tokens: ['a'] })]);
  assert.throws(() => validateRuleSet({ ...raw, rules: [{ ...raw.rules[0], except: { kind: 'phrase', tokens: ['b'] } }] }), /invalid exception/);
});

test('patterns: every escaped token compiles under the u flag', () => {
  for (const token of ['a-b', 'a/b', 'a.b', 'x$y', '(a)']) {
    for (const source of regexSources({ kind: 'phrase', tokens: [token] })) assert.doesNotThrow(() => new RegExp(source, 'u'), token);
  }
});
