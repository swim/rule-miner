/**
 * Source provenance for rule matches: which original characters a decision rests on, without changing
 * any decision. The decision always comes from the ordinary matcher (evaluate); evidence only explains it.
 *
 * Canonical text is NFKC-normalised, apostrophe-folded and lower-cased BEFORE sentence splitting, so the
 * original punctuation can't be re-split directly (full-width "。" is not a separator, but NFKC turns
 * "；" into ";", which is). Instead the text is cut into normalisation clusters: runs of code points that
 * normalise independently of their neighbours (usually one character; a base with its combining marks,
 * a Hangul syllable's jamo). Each cluster maps a range of the normalised string back to the source code
 * points that produced it, conservatively. The mapping is VERIFIED - the clusters' concatenation must equal
 * the whole normalised text, and the scopes rebuilt from it must equal canonicalSegments - and when either
 * check fails (e.g. context-sensitive lower-casing such as a final sigma) provenance is reported
 * 'unavailable' rather than approximated. Offsets are never found by searching for canonical tokens in the
 * source: replacements, stemming and classes change lengths and merge tokens.
 *
 * Spans are UTF-16 code-unit offsets into the ORIGINAL string (text-preprocessing's SourceSpan). A token
 * expanded by a replacement maps every canonical part to the one source token; several canonical
 * matches may therefore share a source span.
 */
import type { SourceSpan } from '@liquidau/text-preprocessing';

import { canonicalSegments } from './match.ts';
import { regexSources, type Pattern } from './pattern.ts';
import type { RuleSet, RuleSetRule } from './ruleset.ts';
import { canonicalTokenParts, normalize, sentencePattern, tokenPattern, type Lexicon } from './text.ts';

export interface EvidenceMatch {
  /** Index of the phrase within the pattern (conjunctions have several). */
  phrase: number;
  /** The source text the matched canonical tokens came from. */
  span: SourceSpan;
}

export interface ScopeEvidence {
  /** The legacy rule scope (canonical sentence) in the source. */
  scope: SourceSpan;
  matches: EvidenceMatch[];
  /** With `contextChars`: the scope widened by up to that many UTF-16 units each side (display only; never part of the decision). */
  context?: SourceSpan;
}

/** A scope where the rule's pattern matched but an exception suppressed it. */
export interface SuppressedScope extends ScopeEvidence {
  exception: number;
  exceptionMatches: EvidenceMatch[];
}

export interface RuleEvidenceHit {
  ruleId: string;
  label: string;
  effect: 'fire' | 'dismiss';
  /** 'exact-token': matches map to their source tokens. 'scope' is reserved for scope-only mapping. 'unavailable': no reliable mapping. */
  precision: 'exact-token' | 'scope' | 'unavailable';
  scopes: ScopeEvidence[];
  suppressed: SuppressedScope[];
}

export interface MatchEvidence {
  /** Exactly ruleSetMatcher(set).evaluate(text). */
  fired: { id: string; label: string } | null;
  dismissed: string[];
  documentId?: string;
  provenance: 'exact-token' | 'unavailable';
  /** Why provenance is unavailable. */
  reason?: string;
  /** The fired rule, then the dismissal rules behind each dismissed label, in rule-set order. */
  hits: RuleEvidenceHit[];
}

interface Cluster { start: number; end: number; norm: string }

const ASCII = /^[\x00-\x7f]*$/;
const MAX_CLUSTER = 256;

/** Normalisation clusters of `text`, or null when the mapping can't be verified. */
function clusters(text: string): Cluster[] | null {
  const out: Cluster[] = [];
  let cur: Cluster | null = null;
  let at = 0;
  for (const cp of text) {
    const start = at;
    at += cp.length;
    if (cur) {
      const raw = text.slice(cur.start, cur.end);
      // ASCII never interacts across characters under NFKC, apostrophe folding or lower-casing.
      const independent = (ASCII.test(raw) && ASCII.test(cp)) || normalize(raw + cp) === normalize(raw) + normalize(cp);
      if (!independent) {
        cur.end = at;
        if (cur.end - cur.start > MAX_CLUSTER) return null;
        cur.norm = normalize(text.slice(cur.start, cur.end));
        continue;
      }
      out.push(cur);
    }
    cur = { start, end: at, norm: normalize(cp) };
  }
  if (cur) out.push(cur);
  return out;
}

interface CanonicalToken { text: string; norm: [number, number] }
interface Scope { canonical: string; norm: [number, number]; tokens: CanonicalToken[] }

interface Mapping { scopes: Scope[]; toSource: (from: number, to: number) => SourceSpan }

function buildMapping(text: string, lexicon: Lexicon | undefined): Mapping | string {
  const cs = clusters(text);
  if (!cs) return 'a normalisation cluster is too long to map';
  const normalized = normalize(text);
  if (cs.map((c) => c.norm).join('') !== normalized) return 'normalisation is context-dependent for this text';
  const owner = new Int32Array(normalized.length);
  let pos = 0;
  cs.forEach((c, k) => { for (let i = 0; i < c.norm.length; i++) owner[pos + i] = k; pos += c.norm.length; });
  const toSource = (from: number, to: number): SourceSpan => ({ start: cs[owner[from]].start, end: cs[owner[to - 1]].end });

  const scopes: Scope[] = [];
  const pieces: Array<[number, number]> = [];
  let last = 0;
  for (const m of normalized.matchAll(sentencePattern())) { pieces.push([last, m.index]); last = m.index + m[0].length; }
  pieces.push([last, normalized.length]);
  for (const [a0, b0] of pieces) {
    const piece = normalized.slice(a0, b0);
    const a = a0 + (piece.length - piece.trimStart().length), b = b0 - (piece.length - piece.trimEnd().length);
    if (b <= a) continue;
    const tokens: CanonicalToken[] = [];
    for (const m of normalized.slice(a, b).matchAll(tokenPattern())) {
      const s = a + m.index;
      for (const part of canonicalTokenParts(m[0], lexicon)) tokens.push({ text: part, norm: [s, s + m[0].length] });
    }
    if (tokens.length) scopes.push({ canonical: tokens.map((t) => t.text).join(' '), norm: [a, b], tokens });
  }
  const expected = canonicalSegments(text, lexicon);
  if (JSON.stringify(scopes.map((s) => s.canonical)) !== JSON.stringify(expected)) return 'rebuilt scopes differ from the canonical segments';
  return { scopes, toSource };
}

/** Where each phrase of `pattern` matches in a scope (first occurrence), or null if any phrase doesn't. */
function phraseMatches(pattern: Pattern, scope: Scope, map: Mapping): EvidenceMatch[] | null {
  const out: EvidenceMatch[] = [];
  const sources = regexSources(pattern);
  const lengths = pattern.kind === 'phrase' ? [pattern.tokens.length] : pattern.phrases.map((p) => p.length);
  for (let k = 0; k < sources.length; k++) {
    const m = new RegExp(sources[k], 'u').exec(scope.canonical);
    if (!m) return null;
    const startChar = m.index + (m[0].startsWith(' ') ? 1 : 0);
    const first = startChar === 0 ? 0 : scope.canonical.slice(0, startChar).split(' ').length - 1;
    const toks = scope.tokens.slice(first, first + lengths[k]);
    out.push({ phrase: k, span: map.toSource(Math.min(...toks.map((t) => t.norm[0])), Math.max(...toks.map((t) => t.norm[1]))) });
  }
  return out;
}

const HIGH = (c: number) => c >= 0xd800 && c <= 0xdbff, LOW = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** `span` widened by `n` code units each side, clamped to the text and moved outward off a surrogate pair's middle. */
function widen(text: string, span: SourceSpan, n: number): SourceSpan {
  let start = Math.max(0, span.start - n), end = Math.min(text.length, span.end + n);
  if (start > 0 && HIGH(text.charCodeAt(start - 1)) && LOW(text.charCodeAt(start))) start--;
  if (end < text.length && end > 0 && HIGH(text.charCodeAt(end - 1)) && LOW(text.charCodeAt(end))) end++;
  return { start, end };
}

function ruleHit(rule: RuleSetRule, map: Mapping): RuleEvidenceHit {
  const scopes: ScopeEvidence[] = [], suppressed: SuppressedScope[] = [];
  for (const scope of map.scopes) {
    const matches = phraseMatches(rule.pattern, scope, map);
    if (!matches) continue;
    const span = map.toSource(scope.norm[0], scope.norm[1]);
    const exception = (rule.except ?? []).findIndex((e) => phraseMatches(e, scope, map) !== null);
    if (exception < 0) scopes.push({ scope: span, matches });
    else suppressed.push({ scope: span, matches, exception, exceptionMatches: phraseMatches(rule.except![exception], scope, map)! });
  }
  return { ruleId: rule.id, label: rule.label, effect: rule.effect === 'dismiss' ? 'dismiss' : 'fire', precision: 'exact-token', scopes, suppressed };
}

/**
 * Evidence for a decision already made by the matcher (`decision` = evaluate(text)). The rules listed
 * are the fired rule and, when nothing fired, every dismissal rule that matched a dismissed label. A
 * document counts once however many scopes match; evidence never feeds mining or certification.
 */
export function matchEvidence(set: RuleSet, text: string, decision: { fired: { id: string; label: string } | null; dismissed: string[] }, options: { documentId?: string; contextChars?: number } = {}): MatchEvidence {
  if (options.contextChars !== undefined && !(Number.isInteger(options.contextChars) && options.contextChars >= 0 && options.contextChars <= 10_000)) throw new Error('contextChars must be an integer in [0, 10000]');
  const base = { fired: decision.fired, dismissed: [...decision.dismissed], ...(options.documentId !== undefined ? { documentId: options.documentId } : {}) };
  const involved = set.rules.filter((r) => (decision.fired ? r.id === decision.fired.id : r.effect === 'dismiss' && decision.dismissed.includes(r.label)));
  const unavailable = (reason: string): MatchEvidence => ({
    ...base, provenance: 'unavailable', reason,
    hits: involved.map((r) => ({ ruleId: r.id, label: r.label, effect: r.effect === 'dismiss' ? 'dismiss' : 'fire', precision: 'unavailable', scopes: [], suppressed: [] })),
  });
  const map = buildMapping(text, set.lexicon);
  if (typeof map === 'string') return unavailable(map);
  const hits = involved.map((r) => ruleHit(r, map)).filter((h) => h.effect === 'fire' || h.scopes.length > 0);
  if (options.contextChars !== undefined) {
    for (const h of hits) for (const sc of [...h.scopes, ...h.suppressed]) sc.context = widen(text, sc.scope, options.contextChars);
  }
  // Parity: the fired rule must fire somewhere by this independent reconstruction too.
  if (decision.fired && !hits[0]?.scopes.length) return unavailable('the evidence reconstruction disagrees with the matcher');
  for (const label of decision.dismissed) if (!hits.some((h) => h.label === label && h.scopes.length)) return unavailable('the evidence reconstruction disagrees with the matcher');
  return { ...base, provenance: 'exact-token', hits };
}
