# Evidence

The evidence comes from a production support chat. Training data was 1 author's 657 seeds,
another model's paraphrases, and 312 independent messages. Every decision was made on a dev set;
the results below come from a **held-out probe and background written by two other model
families, run once**:

| Feature | Held-out result |
|---|---|
| Mining with a background corpus | Mined rules catch 11 of 140 positive messages per head, where hand-written rules catch 1–2 |
| Lexicon (replacements + embedding classes) | Recall: head A 11 → 18 of 140, head B 2 → 5 of 40. External false alarms rose 9 → 27 of 1,837, all from rules certification refused |
| Certification (≤ 0.2% at 95%) | **Held on independent text:** 0.163%, 0.054% and 0.054% for the certified prefixes; the uncertified tail fired on 1.47% |
| Exceptions (unstressed) | Hand-written rules' false alarms 11 → 7 (test) and 6 → 5 (probe), no positives lost |
| Stress test | Rejected 5 exceptions that silenced plausible positive messages ("if my", "past", "my child"). For rules it **doesn't discriminate**: a control run failed hand-written rules intended by domain experts (81–100% hit rate) and deliberately bad words (84–95%) about as often as mined rules (74–88%), and a weak adversary did about as well as a strong one. It shows an innocent use *can be written*, not how often one occurs |
| Author support | Dev: false alarms −2 on the probe and −4 on the background, for one fewer cross-author catch (11 → 10) |
| Governance | Rule-set diff surfaced a new false alarm; firing report pinpointed the noisiest rules |

**What to expect:** learned lexical rules reach high precision and modest recall. Treat them as
**candidates for review**, gate them by **certification** (how often they fire on real-register
text), and keep a statistical classifier for recall.

The stress test is a gate for exceptions, where a contrived counterexample can only cause a safe
rejection. For rules it is reviewer evidence only: an adversary can force an innocent use of
almost any phrase. LLM judges are not labels either. In the same study they agreed with gold
labels near chance on indirectly worded positives, while agreeing on clear-cut texts.

Not included: gapped patterns ("my <0–3 words> wants a refund"). Same-sentence conjunctions
already cover their recall, and certification covers their precision cost.
