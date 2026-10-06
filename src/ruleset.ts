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
/**
 * The format of a rule set whose lexicon stems (`lexicon.stem`). A separate version so a loader that
 * doesn't stem refuses it, instead of silently matching unstemmed text against stemmed patterns.
 */
export const RULESET_FORMAT_STEMMED = 'liquidau-rule-miner/3';
/**
 * The format of a rule set holding dismissal rules (`effect: 'dismiss'`), stemming or not. A separate
 * version so an older loader refuses it: treating a dismissal rule as a firing rule would fire on
 * exactly the messages it should clear.
 */
export const RULESET_FORMAT_DISMISS = 'liquidau-rule-miner/4';
/** Earlier names of the same format, still accepted on load (the package was @calibrated/rule-miner before @liquidau). */
export const LEGACY_RULESET_FORMATS: readonly string[] = ['calibrated-rule-miner/2', 'liquid-rule-miner/2', 'miws-rule-miner/2'];

export interface RuleSetRule {
  id: string;
  /** What the rule means when it fires, e.g. a label or template id. */
  label: string;
  pattern: Pattern;
  regex: string[];
  except?: Pattern[];
  /**
   * 'dismiss': when the rule matches, the message is NOT `label` (decided without the embedding; see
   * mineDismissals and certifyDismissals). Absent: the rule fires `label`.
   */
  effect?: 'dismiss';
  /** Free-form provenance: mining stats, reviewer, date. */
  meta?: Record<string, unknown>;
}

export interface RuleSet {
  format: typeof RULESET_FORMAT | typeof RULESET_FORMAT_STEMMED | typeof RULESET_FORMAT_DISMISS;
  version: string;
  created_at: string;
  lexicon?: Lexicon;
  rules: RuleSetRule[];
}

export function buildRuleSet(
  version: string,
  labelled: ReadonlyArray<{ label: string; effect?: 'dismiss'; rules: ReadonlyArray<{ id: string; pattern: Pattern; except?: Pattern[]; stats?: unknown }> }>,
  options: { lexicon?: Lexicon; createdAt?: string } = {},
): RuleSet {
  const rules: RuleSetRule[] = labelled.flatMap(({ label, effect, rules }) => rules.map((r) => ({
    id: `${effect === 'dismiss' ? 'not-' : ''}${label}.${r.id}`, label, pattern: r.pattern, regex: regexSources(r.pattern),
    ...(r.except?.length ? { except: r.except } : {}), ...(effect === 'dismiss' ? { effect } : {}), ...(r.stats ? { meta: { stats: r.stats } } : {}),
  })));
  const format = rules.some((r) => r.effect === 'dismiss') ? RULESET_FORMAT_DISMISS : options.lexicon?.stem ? RULESET_FORMAT_STEMMED : RULESET_FORMAT;
  return validateRuleSet({ format, version, created_at: options.createdAt ?? new Date().toISOString(), ...(options.lexicon ? { lexicon: options.lexicon } : {}), rules });
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
  if (!set || (set.format !== RULESET_FORMAT && set.format !== RULESET_FORMAT_STEMMED && set.format !== RULESET_FORMAT_DISMISS) || typeof set.version !== 'string' || !Array.isArray(set.rules)) throw new Error('not a rule set');
  if (set.lexicon !== undefined) validateLexicon(set.lexicon);
  // Format /4 (dismissal rules) is read only by loaders that know both dismissal and stemming.
  const stems = !!set.lexicon?.stem;
  for (const r of set.rules) if (r?.effect !== undefined && r.effect !== 'dismiss') throw new Error(`rule ${r.id} has an unknown effect ${r.effect}`);
  const dismisses = set.rules.some((r) => r?.effect === 'dismiss');
  if (dismisses !== (set.format === RULESET_FORMAT_DISMISS)) throw new Error(dismisses ? `dismissal rules need format ${RULESET_FORMAT_DISMISS}` : `format ${RULESET_FORMAT_DISMISS} needs a dismissal rule`);
  if (!dismisses && stems !== (set.format === RULESET_FORMAT_STEMMED)) throw new Error(stems ? `a stemming lexicon needs format ${RULESET_FORMAT_STEMMED}` : `format ${RULESET_FORMAT_STEMMED} needs a stemming lexicon`);
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
  /** The first matching FIRING rule (in rule-set order), or null. Dismissal rules never match here. */
  match(text: string): { id: string; label: string } | null;
  /**
   * The first firing rule, and the labels dismissed: a label is dismissed when one of its dismissal
   * rules matches and no rule fired. Firing wins, so a message both match is never cleared.
   */
  evaluate(text: string): { fired: { id: string; label: string } | null; dismissed: string[] };
}

export function ruleSetMatcher(set: RuleSet): RuleSetMatcher {
  const compiled = set.rules.map((r) => ({ id: r.id, label: r.label, dismiss: r.effect === 'dismiss', fires: compileRule(r) }));
  const firing = compiled.filter((r) => !r.dismiss), dismissing = compiled.filter((r) => r.dismiss);
  const first = (segments: string[]) => { const hit = firing.find((r) => r.fires(segments)); return hit ? { id: hit.id, label: hit.label } : null; };
  return {
    version: set.version,
    match(text) {
      return first(canonicalSegments(text, set.lexicon));
    },
    evaluate(text) {
      const segments = canonicalSegments(text, set.lexicon);
      const fired = first(segments);
      if (fired) return { fired, dismissed: [] };
      return { fired: null, dismissed: [...new Set(dismissing.filter((r) => r.fires(segments)).map((r) => r.label))] };
    },
  };
}

/** How often each rule fires on a batch of texts (e.g. exported shadow traffic) - for monitoring drift. */
export function firingReport(set: RuleSet, texts: readonly string[]) {
  const hits = hitMatrix(set.rules, texts, set.lexicon);
  const share = (dismiss: boolean) => texts.filter((_, i) => hits.some((row, k) => (set.rules[k].effect === 'dismiss') === dismiss && row[i])).length;
  const anyHit = share(false);
  const dismissed = set.rules.some((r) => r.effect === 'dismiss') ? share(true) : 0;
  return {
    texts: texts.length,
    /** Texts a firing rule matched (dismissal rules are counted separately). */
    fired: anyHit,
    rate: texts.length ? anyHit / texts.length : 0,
    /** Texts a dismissal rule matched (before firing rules take precedence). */
    dismissed,
    rules: set.rules.map((r, k) => ({ id: r.id, label: r.label, ...(r.effect ? { effect: r.effect } : {}), pattern: patternKey(r.pattern), fired: hits[k].filter(Boolean).length })),
  };
}

const ruleKey = (r: RuleSetRule) => `${r.effect ?? 'fire'}|${r.label}|${patternKey(r.pattern)}|${(r.except ?? []).map(patternKey).sort().join(',')}`;

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
