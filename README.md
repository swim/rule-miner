# @liquidau/rule-miner

Learns short phrase rules from labelled text, checks how often they fire on ordinary text, and
compiles them to linear-time regex.

```
labelled text + ordinary background text
        │
        ▼
mineRules ──► validateRules ──► certify* ──► buildRuleSet ──► ruleSetMatcher
   ▲                                                                │
   │                                                                ▼
accepted / rejected ◄────────── human review ◄──────── firingReport, diffRuleSets

certify*:       certifyFalseAlarms (≤ r of labelled negatives, 95%), or
                certifyPrefixes (fires on ≤ r of unlabelled traffic, 95%)
mineExceptions: "fire unless…" for any existing rule, including hand-written regex
weakLabels:     rule hits as weighted training data for @liquidau/embedding-classifier
```

Uses [`@liquidau/solvers`](https://www.npmjs.com/package/@liquidau/solvers) for exact bounds; pair it
with [`@liquidau/embedding-classifier`](https://www.npmjs.com/package/@liquidau/embedding-classifier) for recall.

## Install

```bash
npm install @liquidau/rule-miner
```

## Example

```ts
import { buildRuleSet, certifyPrefixes, hitMatrix, mineRules, ruleSetMatcher } from '@liquidau/rule-miner';

// Labelled examples (1 = refund request) and ordinary traffic to veto rules that fire on it.
const texts = ['I want a full refund', 'please give me a full refund now', 'can I get a full refund?', 'where is my parcel', 'thanks for the help', 'how do I change my address'];
const y: (0 | 1)[] = [1, 1, 1, 0, 0, 0];
const background = ['what time do you open', 'my parcel is late again', 'thanks, all sorted'];

const rules = mineRules({ texts, y, background }, { minGroups: 3 });
// Certify on held-out ordinary traffic. Use thousands of texts and a rate like 0.002 in practice.
const heldOut = ['is the shop open on sunday', 'I love this store', 'how much is delivery', 'can I pay by card'];
const cert = certifyPrefixes(hitMatrix(rules, heldOut), { maxRate: 0.6 });
const set = buildRuleSet('2026-10-03', [{ label: 'refund', rules: rules.slice(0, cert.certified) }]);
console.log(ruleSetMatcher(set).match('I demand a full refund')); // { id: 'refund.r1', label: 'refund' }
```

## What's in it

| Area | Exports |
|---|---|
| Mining | `mineRules`, `validateRules` |
| Exceptions | `mineExceptions`, `withExceptions` |
| Word variants | `Lexicon` (replacements, optional Porter stemming, classes), `induceClasses`, `porterStem` |
| Stress test | `stressTest`, `ruleStressItems`, `exceptionStressItems` |
| Certification | `certifyFalseAlarms`, `certifyPrefixes`, `precisionLowerBound` |
| Weak labels | `ruleBounds`, `weakLabels`, `disagreementQueues` |
| Rule sets | `buildRuleSet`, `validateRuleSet`, `ruleSetMatcher`, `diffRuleSets`, `firingReport` |
| Hard negatives, background | `hardNegativeItems`, `checkBackgroundRecords` |

## Guarantees and limits

- Regexes are re-derived from patterns on load, so matching runs in linear time.
- Certification is an exact 95% bound on false alarms (labelled negatives) or firing rate (traffic).
- The stress test gates exceptions only, never rules.
- Expect high precision, low recall (held out: 11 of 140 positives per head); pair with a classifier.
- Runs on Node 20+ and on edge and browser runtimes (no Node built-ins); tests need Node 22.18+.

## More

- [docs/API.md](docs/API.md): every feature and export, and why each exists.
- [docs/SAFETY.md](docs/SAFETY.md): linear time, canonical text, and the three exception guards.
- [docs/EVIDENCE.md](docs/EVIDENCE.md): held-out results from a production support chat.

## Develop

```bash
npm install
npm test        # Node 22.18+ (runs the .ts sources directly)
npm run build   # dist/ (ESM + .d.ts)
```

## License

MIT. See [LICENSE](LICENSE).

## Third-party code

`src/stem.ts` is adapted from [stemmer](https://github.com/words/stemmer) 2.0.1 by Titus Wormer (MIT); its notice is kept in the file.
