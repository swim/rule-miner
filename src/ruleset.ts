/**
 * The runtime artifact: a versioned rule set (rules, their exceptions and the lexicon) that
 * production loads and matches, plus the governance views around it.
 *
 * Every rule carries its regexes for portability, and validateRuleSet() re-derives them from the
 * pattern - so a rule set only ever contains regexes this package produces (space-bounded
 * literals, linear time). A hand-edited or corrupted regex is rejected at load time.
 */
import { canonicalSegments, compileRule, hitMatrix } from './match.ts';
import { patternKey, regexSources, type Pattern } from './pattern.ts';
import { TOKEN_SHAPE, validateLexicon, type Lexicon } from './text.ts';

export const RULESET_FORMAT = 'liquidau-rule-miner/2';
/** Earlier names of the same format, still accepted on load (the package was @calibrated/rule-miner before @liquidau). */
export const LEGACY_RULESET_FORMATS: readonly string[] = ['calibrated-rule-miner/2', 'liquid-rule-miner/2', 'miws-rule-miner/2'];

export interface RuleSetRule {
  id: string;
  /** What the rule means when it fires, e.g. a label or template id. */
  label: string;
  pattern: Pattern;
  regex: string[];
  except?: Pattern[];
  /** Free-form provenance: mining stats, reviewer, date. */
  meta?: Record<string, unknown>;
}

export interface RuleSet {
  format: typeof RULESET_FORMAT;
  version: string;
  created_at: string;
  lexicon?: Lexicon;
  rules: RuleSetRule[];
}

export function buildRuleSet(
  version: string,
  labelled: ReadonlyArray<{ label: string; rules: ReadonlyArray<{ id: string; pattern: Pattern; except?: Pattern[]; stats?: unknown }> }>,
  options: { lexicon?: Lexicon; createdAt?: string } = {},
): RuleSet {
  const rules: RuleSetRule[] = labelled.flatMap(({ label, rules }) => rules.map((r) => ({
    id: `${label}.${r.id}`, label, pattern: r.pattern, regex: regexSources(r.pattern),
    ...(r.except?.length ? { except: r.except } : {}), ...(r.stats ? { meta: { stats: r.stats } } : {}),
  })));
  return validateRuleSet({ format: RULESET_FORMAT, version, created_at: options.createdAt ?? new Date().toISOString(), ...(options.lexicon ? { lexicon: options.lexicon } : {}), rules });
}

function validPattern(p: unknown, lexicon?: Lexicon): p is Pattern {
  const token = (t: unknown) => typeof t === 'string' && (TOKEN_SHAPE.test(t) || (/^<[a-z0-9_]+>$/.test(t) && !!lexicon?.classes?.[t.slice(1, -1)]));
  const phrase = (ts: unknown) => Array.isArray(ts) && ts.length > 0 && ts.every(token);
  const q = p as Pattern;
  if (!q || typeof q !== 'object') return false;
  if (q.kind === 'phrase') return phrase(q.tokens);
  if (q.kind !== 'all' || !Array.isArray(q.phrases) || q.phrases.length < 2 || !q.phrases.every(phrase)) return false;
  return new Set(q.phrases.map((ts) => ts.join(' '))).size === q.phrases.length; // distinct phrases
}

/** Throws unless `raw` is a valid rule set. A legacy-format set is returned with `format` upgraded. */
export function validateRuleSet(raw: unknown): RuleSet {
  let set = raw as RuleSet;
  if (set && typeof set === 'object' && LEGACY_RULESET_FORMATS.includes(set.format)) set = { ...set, format: RULESET_FORMAT };
  if (!set || set.format !== RULESET_FORMAT || typeof set.version !== 'string' || !Array.isArray(set.rules)) throw new Error('not a rule set');
  if (set.lexicon !== undefined) validateLexicon(set.lexicon);
  const ids = new Set<string>();
  for (const rule of set.rules) {
    if (typeof rule.id !== 'string' || ids.has(rule.id)) throw new Error(`missing or duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    if (typeof rule.label !== 'string') throw new Error(`rule ${rule.id} has no label`);
    if (!validPattern(rule.pattern, set.lexicon)) throw new Error(`rule ${rule.id} has an invalid pattern`);
    if (JSON.stringify(rule.regex) !== JSON.stringify(regexSources(rule.pattern))) throw new Error(`rule ${rule.id}: regex does not match its pattern`);
    if (rule.except !== undefined && !(Array.isArray(rule.except) && rule.except.every((e) => validPattern(e, set.lexicon)))) throw new Error(`rule ${rule.id} has an invalid exception`);
    if (rule.except?.some((e) => patternKey(e) === patternKey(rule.pattern))) throw new Error(`rule ${rule.id}: an exception equal to the pattern would never let it fire`);
  }
  return set;
}

export interface RuleSetMatcher {
  version: string;
  /** The first matching rule (in rule-set order), or null. */
  match(text: string): { id: string; label: string } | null;
}

export function ruleSetMatcher(set: RuleSet): RuleSetMatcher {
  const compiled = set.rules.map((r) => ({ id: r.id, label: r.label, fires: compileRule(r) }));
  return {
    version: set.version,
    match(text) {
      const segments = canonicalSegments(text, set.lexicon);
      const hit = compiled.find((r) => r.fires(segments));
      return hit ? { id: hit.id, label: hit.label } : null;
    },
  };
}

/** How often each rule fires on a batch of texts (e.g. exported shadow traffic) - for monitoring drift. */
export function firingReport(set: RuleSet, texts: readonly string[]) {
  const hits = hitMatrix(set.rules, texts, set.lexicon);
  const anyHit = texts.filter((_, i) => hits.some((row) => row[i])).length;
  return {
    texts: texts.length,
    fired: anyHit,
    rate: texts.length ? anyHit / texts.length : 0,
    rules: set.rules.map((r, k) => ({ id: r.id, label: r.label, pattern: patternKey(r.pattern), fired: hits[k].filter(Boolean).length })),
  };
}

const ruleKey = (r: RuleSetRule) => `${r.label}|${patternKey(r.pattern)}|${(r.except ?? []).map(patternKey).sort().join(',')}`;

/** What changes between two rule sets: rules added/removed, and every text whose outcome differs. */
export function diffRuleSets(before: RuleSet, after: RuleSet, texts: readonly string[]) {
  const [a, b] = [new Set(before.rules.map(ruleKey)), new Set(after.rules.map(ruleKey))];
  const [ma, mb] = [ruleSetMatcher(before), ruleSetMatcher(after)];
  return {
    added: after.rules.filter((r) => !a.has(ruleKey(r))).map((r) => r.id),
    removed: before.rules.filter((r) => !b.has(ruleKey(r))).map((r) => r.id),
    changed: texts.flatMap((text) => {
      const [x, y] = [ma.match(text), mb.match(text)];
      return x?.label === y?.label ? [] : [{ text, before: x?.label ?? null, after: y?.label ?? null }];
    }),
  };
}
