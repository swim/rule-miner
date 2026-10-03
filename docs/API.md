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
| **Lexicon** (`Lexicon`, `induceClasses`) | Slang replacements ("wanna" → "want to") and word classes (`<delayed>` = {delayed, delaying, delays}). Classes can be proposed from any word embeddings | Rules generalise beyond the exact training wording |
| **Stress test** (`stressTest`, `exceptionStressItems`, `ruleStressItems`) | An adversary writes texts aimed at each item. For exceptions: genuine positives containing the exception's wording; any it silences fails it. For rules: ordinary texts containing the rule's wording, as reviewer evidence. Too few counterexamples is *inconclusive*, never a pass | Exceptions: a fail-safe gate. Rules: examples for reviewers, **not a gate** (see Evidence) |
| **Certification** (`certifyPrefixes`, `certifyFalseAlarms`, `precisionLowerBound`) | Fixed-sequence testing over rule prefixes. `certifyPrefixes`: "with 95% confidence the first *k* rules fire on ≤ *r* of ordinary text", a firing-rate statement in which correct catches count too. `certifyFalseAlarms`: "… fire on ≤ *r* of negatives", on labelled negatives, exact or design-based for a stratified sample. With `frame`, the rules' known firing on the whole sampling frame caps each stratum's false alarms exactly | A statement a reviewer can sign off; the false-alarm version doesn't spend its budget on correct catches |
| **Design weights** (`evaluateFired`, `ruleBounds`, `designRate` with `design`) | On a stratified sample (e.g. sampled calibration or test records), recall and false alarms are weighted by 1/π, with exact or linearised design-based bounds | Unweighted counts of a stratified sample are biased: in a test, more than twice the true false-alarm rate |
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
| Constants | `ENGLISH_STOPWORDS`, `RULESET_FORMAT`, `LEGACY_RULESET_FORMATS` | The default stopword list and the rule-set format names accepted on load |
| Background records | `backgroundTexts`, `BackgroundError` | The texts of checked background records, and the error P2 and P3 violations throw |
