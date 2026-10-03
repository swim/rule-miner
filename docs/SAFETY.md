# Safety properties

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
    trigger's words ("log in" can't except a log-in rule).
- **Stress results are never optimistic.** An adversary or judge that produced fewer than
  `minGenerated` counterexamples yields `inconclusive`, never `passed`.
