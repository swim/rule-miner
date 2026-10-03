/**
 * Provenance checks rule-miner applies itself, against a minimal record shape that is structurally
 * compatible with embedding-classifier's ExampleRecord (no dependency between the packages):
 *
 *   P2  background records are unlabelled real traffic with the expected backgroundUse
 *   P3  a group appears in one role only, and background groups in one backgroundUse only
 *
 * Use the veto background for mineRules and the certify background for certifyPrefixes, and check
 * them together so no group serves both.
 */
export type RecordRole = 'train' | 'background' | 'calibration' | 'test' | 'stress';
export type BackgroundUse = 'veto' | 'certify' | 'budget';

export interface RecordLike {
  id: string;
  text: string;
  group: string;
  role: RecordRole;
  backgroundUse?: BackgroundUse;
  source: { kind: string };
  labels?: Record<string, 0 | 1 | null | undefined>;
}

export class BackgroundError extends Error {
  readonly code: 'P2' | 'P3';
  readonly ids: string[];
  constructor(code: 'P2' | 'P3', ids: string[], message: string) {
    super(`${code}: ${message} (${ids.length} record(s): ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', ...' : ''})`);
    this.name = 'BackgroundError';
    this.code = code;
    this.ids = ids;
  }
}

/**
 * Throws a BackgroundError unless every background record is unlabelled traffic whose
 * backgroundUse is one of `uses` (P2), and no group spans roles or background uses (P3). Records
 * of other roles may be passed too, for the P3 check.
 */
export function checkBackgroundRecords(records: readonly RecordLike[], uses: readonly BackgroundUse[]): void {
  const p2 = records.filter((r) => r.role === 'background' && !(
    r.source.kind === 'traffic' && Object.values(r.labels ?? {}).every((v) => v === null || v === undefined) && r.backgroundUse !== undefined && uses.includes(r.backgroundUse)
  ));
  if (p2.length) throw new BackgroundError('P2', p2.map((r) => r.id), `background records must be unlabelled traffic with backgroundUse ${uses.join(' or ')}`);
  const seen = new Map<string, string>();
  const bad = new Set<string>();
  for (const r of records) {
    const key = r.role === 'background' ? `background:${r.backgroundUse}` : r.role;
    const prior = seen.get(r.group);
    if (prior !== undefined && prior !== key) bad.add(r.group);
    seen.set(r.group, prior ?? key);
  }
  if (bad.size) throw new BackgroundError('P3', records.filter((r) => bad.has(r.group)).map((r) => r.id), 'a group must appear in one role (and one backgroundUse) only');
}

/** The texts of background records for one use, after checking them (P2, P3). */
export function backgroundTexts(records: readonly RecordLike[], use: BackgroundUse): string[] {
  checkBackgroundRecords(records, [use]);
  return records.map((r) => r.text);
}
