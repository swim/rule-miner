# API

rule-miner mines **high-precision, human-readable rules** from labelled text and compiles them to
**linear-time regex**. It then attacks those rules, certifies them and tracks them over time, so
that a deterministic rule layer (a safety floor, an escalation trigger, a routing shortcut) is
grown from data instead of by hand, and is never trusted further than the evidence allows.

Every feature, the exports behind it, and why it exists:

| | What | Why |
|---|---|---|
| **Mining** (`mineRules`) | Sequential covering over 1–`maxN`-token phrases and same-sentence phrase pairs. Each **group** (a seed and its paraphrases) weighs 1. Stopword-only phrases are refused. Rules are vetoed if they fire on a **background corpus**. Lazy greedy search | Labelled negatives can't show a rule fires on ordinary text; a background corpus in the users' register can |
| **Author support** (`authors`, `minAuthors`) | A rule must be supported by texts originated by several authors | One writer's habits ("to be fair…") aren't a signal |
| **Exceptions** (`mineExceptions`, `withExceptions`) | "Fire unless…" phrases for any existing sentence-level rule, including hand-written regex, learned from its false positives and applied within the sentence it fired in | Repairs the precision of rules you already have |
| **Lexicon** (`Lexicon`, `induceClasses`, `porterStem`) | Slang replacements ("wanna" → "want to"), optional Porter stemming (`stem: 'porter-en'`: "refunded" and "refunds" match a rule mined on "refund"; suits domain or intent routing, rarely worth it for precision-critical binary labels), and word classes (`<delayed>` = {delayed, delaying, delays}). Classes can be proposed from any word embeddings. A stemming rule set has its own format (`RULESET_FORMAT_STEMMED`), so loaders that don't stem refuse it; a ported `regex` needs the same stemmer | Rules generalise beyond the exact training wording |
| **Stress test** (`stressTest`, `exceptionStressItems`, `ruleStressItems`) | An adversary writes texts aimed at each item. For exceptions: genuine positives containing the exception's wording; any it silences fails it. For rules: ordinary texts containing the rule's wording, as reviewer evidence. Too few counterexamples is *inconclusive*, never a pass | Exceptions: a fail-safe gate. Rules: examples for reviewers, **not a gate** (see Evidence) |
| **Certification** (`certifyPrefixes`, `certifyFalseAlarms`, `precisionLowerBound`; every rule's hits must cover exactly the certification texts, or certification throws) | Fixed-sequence testing over rule prefixes. `certifyPrefixes`: "with 95% confidence the first *k* rules fire on ≤ *r* of ordinary text", a firing-rate statement in which correct catches count too. `certifyFalseAlarms`: "… fire on ≤ *r* of negatives", on labelled negatives, exact or design-based for a stratified sample. With `frame`, the rules' known firing on the whole sampling frame caps each stratum's false alarms exactly | A statement a reviewer can sign off; the false-alarm version doesn't spend its budget on correct catches |
| **Design weights** (`evaluateFired`, `ruleBounds`, `designRate` with `design`) | On a stratified sample (e.g. sampled calibration or test records), recall and false alarms are weighted by 1/π, with exact or linearised design-based bounds | Unweighted counts of a stratified sample are biased: in a test, more than twice the true false-alarm rate |
| **Dismissal rules** (`mineDismissals`, `validateDismissals`, `certifyDismissals`, `jointLabels`, `effect: 'dismiss'`) | Rules that decide "not *label*" without the embedding: mined for the negative class (no background veto, no false positives), validated with no positive allowed, and certified on the sampled calibration **positives** ("the first *k* rules match ≤ *r* of true positives, 95%"; linearised with a design, since the exact design bound stays far above small rates at ~60 positives). Thin wrappers over `mineRules`, `validateRules` and `certifyFalseAlarms` with the labels flipped. In a rule set (`buildRuleSet` with `effect: 'dismiss'`) they get their own format, `RULESET_FORMAT_DISMISS`, so an older loader refuses the set instead of treating a dismissal rule as a firing rule. `ruleSetMatcher(...).evaluate(text)` returns the fired rule and the dismissed labels (firing wins); `match` never returns a dismissal rule; weak supervision and `firingReport`'s `fired` count firing rules only. Pass the cleared rows to embedding-classifier's `dismissal` so the head's guarantee counts them as misses. **Joint dismissal** ("none of the labels"): mine, validate and certify on `jointLabels(rows, labels)` (positive if any label is), then store the same rules as dismissal rules for every label. Rare labels rarely have the calibration positives to certify rules of their own, and a rules tier can skip the model only when every label is decided, so joint rules are what make a rules tier settle much traffic | **They pay off on clustered labels:** there they can settle a large share of traffic without the embedding; on diffuse labels few rules certify and a head may lose its guarantee. Check how much of your traffic the certified rules clear (no labels needed) before using them. The saving is per message across heads: the embedding is skipped only when every head is decided by a rule |
| **Weak supervision** (`ruleBounds`, `weakLabels`, `disagreementQueues`, `ruleSetHash`) | Per-rule production precision lower bounds (exact firing-rate and recall bounds, jointly at 95%). Texts a rule fires on become **weak positives** weighted by that bound. Held-out texts are dropped, strong classifier disagreements go to review, near-duplicates count once, and no rule supplies more than `maxRuleShare` of the weight. Rule/classifier disagreements and near-threshold texts become a **labelling queue**. A non-firing text is never a label | Lets the rule floor feed a classifier's training data without the classifier learning to imitate it |
| **Data sourcing** (`hardNegativeItems`, `validateOn`, `checkBackgroundRecords`) | Generation briefs for hard negatives per certified rule. Exceptions can be required to remove a real false positive and no real positive on human-labelled data, which is mandatory when any input is generated. Background records are checked to be unlabelled traffic with one use, veto for `mineRules` and certify for `certifyPrefixes` | Generated data may suggest an exception but never prove it safe; a background used to mine must not also certify |
| **Governance** (`buildRuleSet`, `validateRuleSet`, `ruleSetMatcher`, `firingReport`, `diffRuleSets`, `accepted` / `rejected`) | A versioned artifact whose regexes are re-derived on load; per-rule firing on live or exported traffic; every text whose outcome changes between versions; review decisions fed back into mining | Keeps the rule layer maintainable |

## Other exports

| Area | Exports | What |
|---|---|---|
| Canonical text | `normalize`, `prepare`, `rawSegments`, `segmentTokens`, `tokenize`, `validateLexicon` | NFKC, folded apostrophes, lower case, sentences and tokens, with the lexicon applied; what mining and matching both see |
| Patterns | `canonicalKey`, `describe`, `patternKey`, `regexSources` | A pattern's identity, its human-readable wording, and the linear-time regexes it compiles to |
| Matching | `anyRule`, `canonicalSegments`, `compileRule`, `hitMatrix` | Running rules (with exceptions) over texts: one rule, any rule, or a rules × texts matrix |
| Consistency | `checkConsistency` | Texts where the compiled regexes and a direct token matcher disagree; should always be empty |
| Constants | `ENGLISH_STOPWORDS`, `RULESET_FORMAT`, `RULESET_FORMAT_STEMMED`, `RULESET_FORMAT_DISMISS`, `LEGACY_RULESET_FORMATS` | The default stopword list and the rule-set format names accepted on load (`RULESET_FORMAT_STEMMED` when the lexicon stems, `RULESET_FORMAT_DISMISS` when the set holds dismissal rules, stemming or not) |
| Background records | `backgroundTexts`, `BackgroundError` | The texts of checked background records, and the error P2 and P3 violations throw |

## Runtimes

The package imports no Node built-ins, so rule sets can be matched on serverless, edge and browser
runtimes. `ruleSetHash` uses a pure SHA-256 (`src/sha256.ts`), tested to give the same output as
`node:crypto`, so hashes recorded before the change still match. A test walks the import graph to
keep it that way.

## With @liquidau/router

A router release pairs one rule set with one classifier artifact. The router validates the stored
rule set with `validateRuleSet`, matches the ORIGINAL request text with `ruleSetMatcher(set).evaluate`
(first firing rule in rule-set order; a firing rule clears every dismissal), and identifies the rule
set by `ruleSetHash` of the validated set - so rule order is part of a release, and a legacy format
hashes as its upgraded form. A classifier-only release uses an explicitly empty set:
`buildRuleSet(version, [])`.
