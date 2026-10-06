import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { seededRandom } from '@liquidau/solvers';

import { sha256Hex } from '../src/sha256.ts';

const nodeSha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('sha256Hex matches node:crypto: known vectors, padding boundaries, unicode, long input', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // Lengths around the 55/56/64-byte padding boundaries, and several blocks.
  for (let n = 0; n <= 200; n++) assert.equal(sha256Hex('a'.repeat(n)), nodeSha('a'.repeat(n)), `length ${n}`);
  // Multi-byte UTF-8: accents, CJK, emoji (surrogate pairs), and a lone surrogate (encoded as U+FFFD by both).
  for (const s of ['café', '退款', 'refund 💸 now', 'x\ud800y', '\u0000\u007f\u0080߿ࠀ￿']) assert.equal(sha256Hex(s), nodeSha(s), s);
  const rand = seededRandom(5);
  for (let i = 0; i < 300; i++) {
    const s = Array.from({ length: Math.floor(rand() * 300) }, () => String.fromCodePoint(Math.floor(rand() ** 3 * 0x2ffff))).join('');
    assert.equal(sha256Hex(s), nodeSha(s));
  }
  const big = 'rule '.repeat(200_000); // 1 MB
  assert.equal(sha256Hex(big), nodeSha(big));
});

/** Every module reachable from the package root through relative imports, with their import specifiers. */
function importGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*'([^']+)'|import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1] ?? m[2]);
    seen.set(file, specs);
    for (const s of specs) if (s.startsWith('.')) visit(resolve(dirname(file), s));
  };
  visit(entry);
  return seen;
}

test('the package root imports no Node built-ins, so it runs on edge and browser runtimes', () => {
  const graph = importGraph(join(import.meta.dirname, '..', 'src', 'index.ts'));
  assert.ok(graph.size > 5, 'the walker found the source modules');
  const builtins = new Set(builtinModules);
  for (const [file, specs] of graph) {
    for (const s of specs) assert.ok(!s.startsWith('node:') && !builtins.has(s.split('/')[0]), `${file} imports ${s}`);
  }
});
