/**
 * Rule patterns over canonical tokens (plain tokens or "<class>"), and their regexes.
 *
 *   phrase  consecutive tokens within one sentence: "better off without me"
 *   all     every phrase in the same sentence, any order: "giving" & "things away"
 *
 * A regex runs against one canonical sentence (tokens joined by single spaces) and is a literal
 * between space/edge boundaries - linear time by construction.
 */
import type { Lexicon } from './text.ts';

export type Pattern = { kind: 'phrase'; tokens: string[] } | { kind: 'all'; phrases: string[][] };

export function phrasesOf(pattern: Pattern): string[][] {
  return pattern.kind === 'phrase' ? [pattern.tokens] : pattern.phrases;
}

/** Canonical identity of a pattern: conjunction phrases are sorted, so phrase order never matters. */
export function patternKey(pattern: Pattern): string {
  return canonicalKey(phrasesOf(pattern).map((p) => p.join(' ')).join(' & '));
}

/** The same canonical form for a key written by hand, e.g. a reviewer's "refund & broken". */
export function canonicalKey(key: string): string {
  return key.split(' & ').sort().join(' & ');
}

export function tokenCount(pattern: Pattern): number {
  return phrasesOf(pattern).reduce((n, p) => n + p.length, 0);
}

// Only syntax characters: under the 'u' flag an identity escape of anything else (e.g. "\-") is a SyntaxError.
const escape = (token: string) => token.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** One regex per phrase; a pattern matches a sentence when all of them do. */
export function regexSources(pattern: Pattern): string[] {
  return phrasesOf(pattern).map((p) => `(?:^| )${p.map(escape).join(' ')}(?= |$)`);
}

/** For reviewers: classes spelled out, e.g. "{better|happier} without me". */
export function describe(pattern: Pattern, lexicon?: Lexicon): string {
  const word = (t: string) => {
    const members = /^<(.+)>$/.exec(t) && lexicon?.classes?.[t.slice(1, -1)];
    return members ? `{${members.join('|')}}` : t;
  };
  return phrasesOf(pattern).map((p) => p.map(word).join(' ')).join(' & ');
}
