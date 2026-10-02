/**
 * Canonical text - what mining and matching both see, so a rule means the same thing in both.
 *
 *   normalize   NFKC, curly apostrophes folded, lower case
 *   segments    sentences (split on . ! ? ; and newlines); rules and exceptions apply within one.
 *               Every "." splits, so "3.5 kg" and "e.g." become several sentences - a deliberate
 *               trade-off for chat text, where abbreviations are rare and run-on sentences common
 *   tokens      runs of Unicode letters/marks/digits/underscore with internal apostrophes ("don't",
 *               "zoë's"); marks are included so scripts that write vowels and diacritics as
 *               combining characters (Devanagari, Arabic, Thai) and "İ".toLowerCase() stay whole
 *   lexicon     optional: replacements first ("wanna" -> "want to"), then class members -> "<class>".
 *               Compiled once per lexicon OBJECT (cached by identity): don't mutate one after use
 */
const TOKEN = /[\p{L}\p{M}\p{N}_]+(?:'[\p{L}\p{M}\p{N}_]+)*/gu;
const SENTENCE = /[.!?;\n]+/u;
export const TOKEN_SHAPE = /^[\p{L}\p{M}\p{N}_]+(?:'[\p{L}\p{M}\p{N}_]+)*$/u;

export interface Lexicon {
  /** Token -> replacement text, applied first, e.g. { wanna: 'want to' }. */
  replacements?: Record<string, string>;
  /** Class name -> member tokens; members become "<name>", e.g. { better: ['better', 'happier'] }. */
  classes?: Record<string, string[]>;
}

export function normalize(text: string): string {
  return text.normalize('NFKC').replace(/[‘’ʼ`]/g, "'").toLowerCase();
}

/** Normalised sentences of a text (raw characters, for running external rules per sentence). */
export function rawSegments(text: string): string[] {
  return normalize(text).split(SENTENCE).map((s) => s.trim()).filter(Boolean);
}

interface CompiledLexicon {
  replace: Map<string, string[]>;
  cls: Map<string, string>;
}
const compiledLexicons = new WeakMap<Lexicon, CompiledLexicon>();

/**
 * Throws if the lexicon is malformed: bad names or tokens, a token in two classes, or a key or
 * member that isn't canonical (tokens are matched after normalize(), so "Want" could never match).
 */
export function validateLexicon(lexicon: Lexicon): Lexicon {
  if (typeof lexicon !== 'object' || lexicon === null || Array.isArray(lexicon)) throw new Error('lexicon must be an object');
  const canonical = (what: string, t: string) => {
    if (!TOKEN_SHAPE.test(t)) throw new Error(`${what} "${t}" is not a single token`);
    if (normalize(t) !== t) throw new Error(`${what} "${t}" is not canonical (expected "${normalize(t)}")`);
  };
  for (const [from, to] of Object.entries(lexicon.replacements ?? {})) {
    canonical('replacement key', from);
    if (!(normalize(to).match(TOKEN) ?? []).length) throw new Error(`replacement for "${from}" is empty`);
  }
  const seen = new Map<string, string>();
  for (const [name, members] of Object.entries(lexicon.classes ?? {})) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`class name "${name}" must be [a-z0-9_]+`);
    for (const m of members) {
      canonical(`class ${name} member`, m);
      if (seen.has(m)) throw new Error(`"${m}" is in both ${seen.get(m)} and ${name}`);
      seen.set(m, name);
    }
  }
  return lexicon;
}

function compiled(lexicon: Lexicon): CompiledLexicon {
  let c = compiledLexicons.get(lexicon);
  if (!c) {
    validateLexicon(lexicon);
    c = {
      replace: new Map(Object.entries(lexicon.replacements ?? {}).map(([k, v]) => [k, normalize(v).match(TOKEN) ?? []])),
      cls: new Map(Object.entries(lexicon.classes ?? {}).flatMap(([name, members]) => members.map((m) => [m, `<${name}>`]))),
    };
    compiledLexicons.set(lexicon, c);
  }
  return c;
}

/** Canonical tokens of one normalised segment. */
export function segmentTokens(segment: string, lexicon?: Lexicon): string[] {
  const tokens = segment.match(TOKEN) ?? [];
  if (!lexicon) return tokens;
  const { replace, cls } = compiled(lexicon);
  return tokens.flatMap((t) => replace.get(t) ?? [t]).map((t) => cls.get(t) ?? t);
}

/** Canonical tokens per sentence. */
export function prepare(text: string, lexicon?: Lexicon): string[][] {
  return rawSegments(text).map((s) => segmentTokens(s, lexicon)).filter((t) => t.length);
}

export function tokenize(text: string, lexicon?: Lexicon): string[] {
  return prepare(text, lexicon).flat();
}
