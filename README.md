# @liquidau/rule-miner

Mines **high-precision, human-readable rules** from labelled text and compiles them to
**linear-time regex**. It then attacks those rules, certifies them and tracks them over time, so
that a deterministic rule layer (a safety floor, an escalation trigger, a routing shortcut) is
grown from data instead of by hand, and is never trusted further than the evidence allows.

```
labelled text ─► mine ─► validate ─► stress-test ─► certify ─► rule set ─► review ─► runtime ─► monitor / diff
                 │                    (adversarial    (exact 95%            (accepted /           (firing report,
                 │                     counterexamples) bound on firing)     rejected feed back)   rule-set diff)
                 └─ exceptions for existing rules (sentence-scoped, guarded)
```

## Features

| | What | Why |
|---|---|---|
| **Mining** (`mineRules`) | Sequential covering over 1–`maxN`-token phrases and same-sentence phrase pairs. Each **group** (a seed and its paraphrases) weighs 1. Stopword-only phrases are refused. Rules are vetoed if they fire on a **background corpus**. Lazy greedy search | Labelled negatives can't show a rule fires on ordinary text; a background corpus in the users' register can |
| **Author support** (`authors`, `minAuthors`) | A rule must be supported by texts originated by several authors | One writer's habits ("worried because…") aren't a signal |
| **Exceptions** (`mineExceptions`, `withExceptions`) | "Fire unless…" phrases for any existing sentence-level rule, including hand-written regex, learned from its false positives and applied within the sentence it fired in | Repairs the precision of rules you already have |
| **Lexicon** (`Lexicon`, `induceClasses`) | Slang replacements ("wanna" → "want to") and word classes (`<worried>` = {worried, worrying, worries}). Classes can be proposed from any word embeddings | Rules generalise beyond the exact training wording |
| **Stress test** (`stressTest`, `exceptionStressItems`, `ruleStressItems`) | An adversary writes texts aimed at each item. For exceptions: genuine positives containing the exception's wording; any it silences fails it. For rules: ordinary texts containing the rule's wording, as reviewer evidence. Too few counterexamples is *inconclusive*, never a pass | Exceptions: a fail-safe gate. Rules: examples for reviewers, **not a gate** (see Evidence) |
| **Certification** (`certifyPrefixes`, `precisionLowerBound`) | Fixed-sequence testing with exact Clopper–Pearson bounds: "with 95% confidence the first *k* rules fire on ≤ *r* of ordinary text" | A statement a reviewer can sign off |
| **Governance** (`buildRuleSet`, `validateRuleSet`, `ruleSetMatcher`, `firingReport`, `diffRuleSets`, `accepted` / `rejected`) | A versioned artifact whose regexes are re-derived on load; per-rule firing on live or exported traffic; every text whose outcome changes between versions; review decisions fed back into mining | Keeps the rule layer maintainable |

## Safety properties

- **Linear time:** each rule is a set of space-bounded literals matched per sentence of
  canonical text. `validateRuleSet` re-derives every regex from its pattern, so a hand-edited or
  catastrophic regex can't load.
- **Canonical text:** NFKC, folded apostrophes, lower case, sentences, Unicode-aware tokens, and
  the lexicon. Mining and matching use the same function, and `checkConsistency` verifies that the
  regexes and a direct token matcher agree.
- **Exception guards.** Each one was added after it caught a real failure:
  - **Evidence.** No exceptions are mined for a rule that catches fewer than
    `minPositiveGroups` positive groups, since with nothing to lose every exception looks free.
  - **Share.** An exception may not appear in more than `maxShare` of the rule's firing
    sentences; otherwise it is a deletion, not an exception.
  - **Trigger.** When `base` returns the text it matched, an exception may not reuse the
    trigger's words ("self harm" can't except a self-harm rule).
- **Stress results are never optimistic.** An adversary or judge that produced fewer than
  `minGenerated` counterexamples yields `inconclusive`, never `passed`.

## Evidence

The evidence comes from a mental-health support chat. Training data was 1 author's 657 seeds,
another model's paraphrases, and 312 independent messages. Every decision was made on a dev set;
the results below come from a **held-out probe and background written by two other model
families, run once**:

| Feature | Held-out result |
|---|---|
| Mining with a background corpus | Mined rules catch 11 of 140 crisis messages per head, where hand-written rules catch 1–2 |
| Lexicon (replacements + embedding classes) | Recall: other-risk 11 → 18 of 140, medical 2 → 5 of 40. External false alarms rose 9 → 27 of 1,837, all from rules certification refused |
| Certification (≤ 0.2% at 95%) | **Held on independent text:** 0.163%, 0.054% and 0.054% for the certified prefixes; the uncertified tail fired on 1.47% |
| Exceptions (unstressed) | Hand-written rules' false alarms 11 → 7 (test) and 6 → 5 (probe), no positives lost |
| Stress test | Rejected 5 exceptions that silenced plausible crisis messages ("if my", "past", "my child"). For rules it **doesn't discriminate**: a control run failed clinically intended hand-written rules (81–100% hit rate) and deliberately bad words (84–95%) about as often as mined rules (74–88%), and a weak adversary did about as well as a strong one. It shows an innocent use *can be written*, not how often one occurs |
| Author support | Dev: false alarms −2 on the probe and −4 on the background, for one fewer cross-author catch (11 → 10) |
| Governance | Rule-set diff surfaced a new false alarm; firing report pinpointed the noisiest rules |

**What to expect:** learned lexical rules reach high precision and modest recall. Treat them as
**candidates for review**, gate them by **certification** (how often they fire on real-register
text), and keep a statistical classifier for recall.

The stress test is a gate for exceptions, where a contrived counterexample can only cause a safe
rejection. For rules it is reviewer evidence only: an adversary can force an innocent use of
almost any phrase. LLM judges are not labels either. In the same study they agreed with gold
labels near chance on implicit risk, while agreeing on clear-cut texts.

Not included: gapped patterns ("my <0–3 words> wants to die"). Same-sentence conjunctions
already cover their recall, and certification covers their precision cost.

## Example

```ts
import { mineRules, validateRules, ruleStressItems, stressTest, certifyPrefixes, anyRule, buildRuleSet, ruleSetMatcher } from '@liquidau/rule-miner';

const lexicon = { replacements: { wanna: 'want to' }, classes: { worried: ['worried', 'worrying', 'worries'] } };
const mined = mineRules({ texts, y, groups, authors, background: backgroundMining }, { minGroups: 3, minAuthors: 2, lexicon });
const { kept } = validateRules(mined, calibration.texts, calibration.y, { lexicon });
const stress = await stressTest(ruleStressItems(kept, lexicon), (item) => myAdversary(item.description)); // evidence for reviewers
const cert = certifyPrefixes(kept.map((r) => anyRule([r], backgroundHeldOut, lexicon)), { maxRate: 0.002 });
const set = buildRuleSet('2026-10-01', [{ label: 'escalate', rules: kept.slice(0, cert.certified) }], { lexicon });
// ... human review (accepted / rejected feed the next mineRules call) ...
ruleSetMatcher(set).match('I demand a full refund'); // { id, label } | null
```

## Develop

```bash
npm install
npm test
npm run typecheck
npm run build
```

The compiled package (`dist/`) runs on Node 20+. The test suite runs the `.ts` sources directly,
which needs Node's built-in type stripping: **Node 22.18+ or 23.6+**. `@liquidau/solvers` is a
private sibling package, so install from a workspace (or `npm link ../solvers`) rather than the
registry.
