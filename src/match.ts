/** Running patterns (with optional exceptions) - what validation, evaluation and production all use. */
import { regexSources, type Pattern } from './pattern.ts';
import { prepare, rawSegments, segmentTokens, type Lexicon } from './text.ts';

export interface MatchableRule {
  pattern: Pattern;
  /** The rule does not fire in a sentence that matches any of these. */
  except?: readonly Pattern[];
}

/** Canonical sentences of a text: tokens joined by single spaces. */
export function canonicalSegments(text: string, lexicon?: Lexicon): string[] {
  return prepare(text, lexicon).map((t) => t.join(' '));
}

type SentenceTest = (sentence: string) => boolean;

function compilePattern(pattern: Pattern): SentenceTest {
  const regexes = regexSources(pattern).map((s) => new RegExp(s, 'u'));
  return (s) => regexes.every((r) => r.test(s));
}

/** Fires when some sentence matches the pattern and none of its exceptions. */
export function compileRule(rule: MatchableRule): (segments: readonly string[]) => boolean {
  const matches = compilePattern(rule.pattern);
  const exceptions = (rule.except ?? []).map(compilePattern);
  return (segments) => segments.some((s) => matches(s) && !exceptions.some((e) => e(s)));
}

/** hits[r][i]: does rule r fire on text i. */
export function hitMatrix(rules: readonly MatchableRule[], texts: readonly string[], lexicon?: Lexicon): boolean[][] {
  const segments = texts.map((t) => canonicalSegments(t, lexicon));
  return rules.map((rule) => {
    const fires = compileRule(rule);
    return segments.map(fires);
  });
}

export function anyRule(rules: readonly MatchableRule[], texts: readonly string[], lexicon?: Lexicon): boolean[] {
  const hits = hitMatrix(rules, texts, lexicon);
  return texts.map((_, i) => hits.some((row) => row[i]));
}

/**
 * Applies exceptions to ANY sentence-level rule - e.g. existing hand-written regexes: fires when
 * some sentence fires `base` and matches none of the exceptions.
 *
 * `base` receives each sentence NORMALISED (NFKC, apostrophes folded, lower case) but not
 * tokenised: write case-sensitive regexes in lower case (or use the i flag), and note that
 * lexicon replacements are not applied to what it sees.
 */
export function withExceptions(base: (sentence: string) => boolean | string, exceptions: readonly Pattern[], lexicon?: Lexicon): (text: string) => boolean {
  const tests = exceptions.map(compilePattern);
  return (text) => rawSegments(text).some((raw) => {
    if (!base(raw)) return false;
    const canonical = segmentTokens(raw, lexicon).join(' ');
    return !tests.some((t) => t(canonical));
  });
}
